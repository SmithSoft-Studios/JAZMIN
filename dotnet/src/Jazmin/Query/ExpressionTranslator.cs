using System.Collections;
using System.Linq.Expressions;
using System.Reflection;
using Jazmin.Format;

namespace Jazmin.Query;

/// <summary>Result of translating a LINQ predicate.</summary>
/// <param name="Filter">An index-aware filter that matches a superset of the predicate (null = no narrowing).</param>
/// <param name="Exact">True when <paramref name="Filter"/> matches exactly the same rows as the predicate,
/// so the predicate does not need to be compiled and re-checked.</param>
internal sealed record Translation(JazminFilter? Filter, bool Exact);

/// <summary>
/// Translates a LINQ predicate into a <see cref="JazminFilter"/> so indexes and chunk
/// statistics can be used. The filter is always a SUPERSET of the predicate: anything that
/// cannot be translated with identical C# semantics is dropped (AND) or disables translation
/// (OR / NOT), and the result is then marked inexact so the caller re-checks every row.
/// </summary>
internal static class ExpressionTranslator
{
    public static Translation Translate<T>(Expression<Func<T, bool>> predicate, Func<MemberInfo, JazminColumn?> columnFor) =>
        Translate((LambdaExpression)predicate, columnFor);

    /// <summary>
    /// A predicate of one parameter returning bool, whose type is known only at run time (IQueryable).
    /// <paramref name="fieldName"/> names the field a member of a nested column's object is stored in (null: none).
    /// </summary>
    public static Translation Translate(LambdaExpression predicate, Func<MemberInfo, JazminColumn?> columnFor, Func<Type, MemberInfo, string?>? fieldName = null)
    {
        var visitor = new Visitor(predicate.Parameters[0], [predicate.Parameters[0]], columnFor, fieldName ?? ((_, _) => null), null);
        var filter = visitor.Visit(predicate.Body);
        return new Translation(filter, filter is not null && visitor.Exact);
    }

    /// <summary>
    /// Column types whose C# comparisons match the stored order. Decimals are left to the compiled predicate:
    /// stored decimals can be more precise than C# decimal.
    /// </summary>
    private static bool Translatable(JazminType type) => TypeNames.IsOrdered(type) && type != JazminType.Decimal;

    private sealed record ColumnRef(JazminColumn Column, Type MemberType)
    {
        public Type Underlying => Nullable.GetUnderlyingType(MemberType) ?? MemberType;

        /// <summary>The name conditions use: the column's (or field's), or <see cref="JazminFilter.Itself"/> for an item.</summary>
        public string Name { get; init; } = Column.Name;

        /// <summary>The objects it is a field of (nested columns), outermost first: its conditions are wrapped in `match`.</summary>
        public JazminColumn[] Owners { get; init; } = [];
    }

    /// <summary>A condition on a field of nested objects, wrapped in `match` for each object it is in (spec 9.2).</summary>
    private static JazminFilter Wrap(ColumnRef reference, JazminFilter filter)
    {
        for (var i = reference.Owners.Length - 1; i >= 0; i--) filter = JazminFilter.Match(reference.Owners[i].Name, filter);
        return filter;
    }

    /// <param name="parameter">What columns are members of: the row, or (in Any / All) a list's item.</param>
    /// <param name="parameters">Every lambda parameter in scope: what depends on one is not a constant.</param>
    /// <param name="columnFor">The column (or, for an item, the field) a member of <paramref name="parameter"/> is stored in.</param>
    /// <param name="fieldName">The field a member of a nested column's object is stored in.</param>
    /// <param name="self">For the items of a list of plain values: the item itself.</param>
    private sealed class Visitor(ParameterExpression parameter, ParameterExpression[] parameters, Func<MemberInfo, JazminColumn?> columnFor,
        Func<Type, MemberInfo, string?> fieldName, ColumnRef? self)
    {
        /// <summary>Cleared whenever any part of the predicate is dropped or approximated.</summary>
        public bool Exact { get; private set; } = true;

        private JazminFilter? Inexact()
        {
            Exact = false;
            return null;
        }

        public JazminFilter? Visit(Expression e)
        {
            switch (e)
            {
                case BinaryExpression { NodeType: ExpressionType.AndAlso } b:
                {
                    // l != null beside other conditions: rows, and list items that are objects, are checked only when not null.
                    if (IsPresent(b.Left)) return Visit(b.Right);
                    if (IsPresent(b.Right)) return Visit(b.Left);
                    var left = Visit(b.Left);
                    var right = Visit(b.Right);
                    return left is null ? right : right is null ? left : JazminFilter.And(left, right);
                }
                case BinaryExpression { NodeType: ExpressionType.OrElse } b:
                {
                    var left = Visit(b.Left);
                    var right = Visit(b.Right);
                    return left is null || right is null ? Inexact() : JazminFilter.Or(left, right);
                }
                case UnaryExpression { NodeType: ExpressionType.Not } u:
                {
                    // NOT is only safe over an exact translation: negating a superset gives a subset.
                    var wasExact = Exact;
                    Exact = true;
                    var inner = u.Operand is BinaryExpression { NodeType: not (ExpressionType.AndAlso or ExpressionType.OrElse) } or MethodCallExpression
                        ? Visit(u.Operand)
                        : null;
                    var innerExact = Exact && inner is not null;
                    Exact = wasExact;
                    return innerExact ? JazminFilter.Not(inner!) : Inexact();
                }
                case BinaryExpression b:
                    return Comparison(b) ?? Inexact();
                case MethodCallExpression call:
                    return Method(call) ?? Inexact();
                case MemberExpression m when Column(m) is { Column.Type: JazminType.Bool } c && m.Type == typeof(bool):
                    return JazminFilter.Eq(c.Column.Name, true); // x => x.IsActive
                default:
                    return Inexact();
            }
        }

        private JazminFilter? Comparison(BinaryExpression b)
        {
            var op = b.NodeType switch
            {
                ExpressionType.Equal => "eq",
                ExpressionType.NotEqual => "ne",
                ExpressionType.GreaterThan => "gt",
                ExpressionType.GreaterThanOrEqual => "gte",
                ExpressionType.LessThan => "lt",
                ExpressionType.LessThanOrEqual => "lte",
                _ => null,
            };
            if (op is null) return null;
            if (Column(b.Left) is { } left && TryConstant(b.Right, out var right)) return Make(left, op, right);
            if (Column(b.Right) is { } r && TryConstant(b.Left, out var l)) return Make(r, Flip(op), l);
            return null;
        }

        private static JazminFilter? Make(ColumnRef reference, string op, object? value) =>
            MakeHere(reference, op, value) is { } filter ? Wrap(reference, filter) : null;

        private static JazminFilter? MakeHere(ColumnRef reference, string op, object? value)
        {
            var name = reference.Name;
            if (value is null)
            {
                return op switch
                {
                    "eq" => JazminFilter.IsNull(name),
                    "ne" => JazminFilter.IsNull(name, false),
                    _ => null,
                };
            }
            if (!Translatable(reference.Column.Type)) return null; // decimal/json/binary: C# equality differs from stored form
            // Enums are stored as names: equality matches C#, but ordering would be alphabetical, not numeric.
            if (reference.Underlying.IsEnum && op is not ("eq" or "ne")) return null;
            value = Normalize(reference, value);
            if (value is null) return null;
            return op switch
            {
                "eq" => JazminFilter.Eq(name, value),
                // C#: null != x is true, but JAZMIN 'ne' excludes nulls, so include them explicitly.
                "ne" => JazminFilter.Or(JazminFilter.Ne(name, value), JazminFilter.IsNull(name)),
                "gt" => JazminFilter.Gt(name, value),
                "gte" => JazminFilter.Gte(name, value),
                "lt" => JazminFilter.Lt(name, value),
                _ => JazminFilter.Lte(name, value),
            };
        }

        /// <summary>Converts a C# constant to the column's representation, or null if that cannot be done exactly.</summary>
        private static object? Normalize(ColumnRef reference, object value)
        {
            var memberType = reference.Underlying;
            if (memberType.IsEnum) return Enum.ToObject(memberType, value).ToString(); // enum constants compile to integers
            if (memberType == typeof(char)) return value is char c ? c.ToString() : ((char)Convert.ToInt32(value)).ToString();
            if (value is Guid g) return g.ToString();
            if (value is DateTime dt)
            {
                // C# compares ticks and ignores Kind; only translate when that equals the stored UTC milliseconds.
                if (dt.Kind == DateTimeKind.Local || dt.Ticks % TimeSpan.TicksPerMillisecond != 0) return null;
            }
            if (value is DateTimeOffset dto && dto.Ticks % TimeSpan.TicksPerMillisecond != 0) return null;
            return value;
        }

        private static string Flip(string op) => op switch { "gt" => "lt", "gte" => "lte", "lt" => "gt", "lte" => "gte", _ => op };

        private JazminFilter? Method(MethodCallExpression call)
        {
            // x.Name.Contains("a") is ordinal in .NET. StartsWith(string) is culture-sensitive, so only the
            // StartsWith(string, StringComparison.Ordinal) overload is translated.
            if (call.Object is not null && call.Object.Type == typeof(string)
                && Column(call.Object) is { Column.Type: JazminType.String } c
                && call.Arguments.Count >= 1 && call.Arguments[0].Type == typeof(string)
                && TryConstant(call.Arguments[0], out var text) && text is string s)
            {
                var ordinal = call.Arguments.Count == 2 && TryConstant(call.Arguments[1], out var cmp) && cmp is StringComparison.Ordinal;
                JazminFilter? found = (call.Method.Name, call.Arguments.Count) switch
                {
                    ("Contains", 1) => JazminFilter.Contains(c.Name, s),
                    ("Contains", 2) when ordinal => JazminFilter.Contains(c.Name, s),
                    ("StartsWith", 2) when ordinal => JazminFilter.StartsWith(c.Name, s),
                    _ => null,
                };
                return found is null ? null : Wrap(c, found);
            }
            // x.Lines.Any(l => ...) / All(...): a filter of the items (spec 9.2), translated with the item as the parameter.
            if (call.Method.DeclaringType == typeof(Enumerable) && call.Method.Name is "Any" or "All" && call.Arguments.Count == 2
                && Column(call.Arguments[0]) is { Column.Type: JazminType.List } listColumn && Lambda(call.Arguments[1]) is { Parameters.Count: 1 } each)
            {
                var item = listColumn.Column.Item!;
                var itemRef = new ColumnRef(item, each.Parameters[0].Type);
                var inner = new Visitor(each.Parameters[0], [.. parameters, each.Parameters[0]],
                    item.Type == JazminType.Object ? member => Field(itemRef, member) : _ => null, fieldName,
                    item.Type == JazminType.Object ? null : itemRef with { Name = JazminFilter.Itself });
                var items = inner.Visit(each.Body);
                if (items is null) return null; // nothing to narrow the items by
                if (!inner.Exact) Exact = false; // more items match: still a superset of the rows, for any and all alike
                return Wrap(listColumn, call.Method.Name == "Any" ? JazminFilter.Any(listColumn.Name, items) : JazminFilter.All(listColumn.Name, items));
            }
            // list.Contains(x.Country) or Enumerable.Contains(list, x.Country)
            if (call.Method.Name == "Contains")
            {
                var (source, item) = call.Object is not null && call.Arguments.Count == 1
                    ? (call.Object, call.Arguments[0])
                    : call.Arguments.Count == 2 ? (call.Arguments[0], call.Arguments[1]) : (null, null);
                // x.Tags.Contains("vip"): a list column of plain values with that item.
                if (source is not null && Column(source) is { Column.Type: JazminType.List } tags && tags.Column.Item!.Type != JazminType.Object
                    && TryConstant(item!, out var wanted))
                {
                    var itself = new ColumnRef(tags.Column.Item, item!.Type) { Name = JazminFilter.Itself };
                    return MakeHere(itself, "eq", wanted) is { } eq ? Wrap(tags, JazminFilter.Any(tags.Name, eq)) : null;
                }
                if (source is null || Column(item!) is not { } col || !TryConstant(source, out var list)) return null;
                if (list is string || list is not IEnumerable values || !Translatable(col.Column.Type)) return null;
                var items = new List<object?>();
                foreach (var v in values)
                {
                    if (v is null)
                    {
                        items.Add(null);
                        continue;
                    }
                    var normalized = Normalize(col, v);
                    if (normalized is null) return null;
                    items.Add(normalized);
                }
                var filter = JazminFilter.In(col.Name, items.Where(i => i is not null).ToArray());
                return Wrap(col, items.Contains(null) ? JazminFilter.Or(filter, JazminFilter.IsNull(col.Name)) : filter);
            }
            return null;
        }

        /// <summary>
        /// The column when the expression is a property of the lambda parameter; a field of a nested column's object when
        /// it is a property of one (<c>x.Head.City</c>); the item itself for a list of plain values.
        /// </summary>
        private ColumnRef? Column(Expression e)
        {
            while (e is UnaryExpression { NodeType: ExpressionType.Convert or ExpressionType.ConvertChecked } u) e = u.Operand;
            if (e == parameter) return self;
            if (e is not MemberExpression { Expression: { } target } m) return null;
            if (target == parameter)
            {
                var column = columnFor(m.Member);
                return column is null ? null : new ColumnRef(column, m.Type);
            }
            return Column(target) is { Column.Type: JazminType.Object } owner && Field(owner, m.Member) is { } field
                ? new ColumnRef(field, m.Type) { Owners = [.. owner.Owners, owner.Column] }
                : null;
        }

        /// <summary>The field of a nested column's object a member is stored in (as the serializer names it).</summary>
        private JazminColumn? Field(ColumnRef owner, MemberInfo member) =>
            owner.Column.Fields is { } fields && fieldName(owner.Underlying, member) is { } name
                ? fields.FirstOrDefault(f => f.Name == name) ?? fields.FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase))
                : null;

        /// <summary><c>p != null</c> for the parameter when it is a row or an object item (never null where filters check it).</summary>
        private bool IsPresent(Expression e) =>
            self is null && e is BinaryExpression { NodeType: ExpressionType.NotEqual } b
            && (Stripped(b.Left) == parameter && Stripped(b.Right) is ConstantExpression { Value: null }
                || Stripped(b.Right) == parameter && Stripped(b.Left) is ConstantExpression { Value: null });

        private static Expression Stripped(Expression e)
        {
            while (e is UnaryExpression { NodeType: ExpressionType.Convert or ExpressionType.ConvertChecked } u) e = u.Operand;
            return e;
        }

        private static LambdaExpression? Lambda(Expression e) => e switch
        {
            UnaryExpression { NodeType: ExpressionType.Quote, Operand: LambdaExpression lambda } => lambda,
            LambdaExpression lambda => lambda,
            _ => null,
        };

        /// <summary>Evaluates expressions that do not depend on the parameter (constants, captured variables).</summary>
        private bool TryConstant(Expression e, out object? value)
        {
            value = null;
            var finder = new ParameterFinder(parameters);
            finder.Visit(e);
            if (finder.Found) return false;
            value = Evaluate(e);
            return true;
        }

        /// <summary>
        /// Constants and captured variables are read by reflection (cheap); anything else falls back
        /// to compiling a small lambda.
        /// </summary>
        private static object? Evaluate(Expression e)
        {
            switch (e)
            {
                case ConstantExpression c:
                    return c.Value;
                case MemberExpression { Expression: null or ConstantExpression or MemberExpression } m
                    when m.Member is FieldInfo or PropertyInfo:
                {
                    var target = m.Expression is null ? null : Evaluate(m.Expression);
                    return m.Member is FieldInfo f ? f.GetValue(target) : ((PropertyInfo)m.Member).GetValue(target);
                }
                default:
                    return Expression.Lambda(e).Compile().DynamicInvoke();
            }
        }
    }

    private sealed class ParameterFinder(ParameterExpression[] parameters) : ExpressionVisitor
    {
        public bool Found { get; private set; }

        protected override Expression VisitParameter(ParameterExpression node)
        {
            if (Array.IndexOf(parameters, node) >= 0) Found = true;
            return node;
        }
    }
}
