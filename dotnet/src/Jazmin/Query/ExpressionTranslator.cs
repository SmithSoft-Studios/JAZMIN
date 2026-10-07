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

    /// <summary>A predicate of one parameter returning bool, whose type is known only at run time (IQueryable).</summary>
    public static Translation Translate(LambdaExpression predicate, Func<MemberInfo, JazminColumn?> columnFor)
    {
        var visitor = new Visitor(predicate.Parameters[0], columnFor);
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
    }

    private sealed class Visitor(ParameterExpression parameter, Func<MemberInfo, JazminColumn?> columnFor)
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
                    var inner = u.Operand is BinaryExpression { NodeType: not (ExpressionType.AndAlso or ExpressionType.OrElse) }
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

        private static JazminFilter? Make(ColumnRef reference, string op, object? value)
        {
            var name = reference.Column.Name;
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
                return (call.Method.Name, call.Arguments.Count) switch
                {
                    ("Contains", 1) => JazminFilter.Contains(c.Column.Name, s),
                    ("Contains", 2) when ordinal => JazminFilter.Contains(c.Column.Name, s),
                    ("StartsWith", 2) when ordinal => JazminFilter.StartsWith(c.Column.Name, s),
                    _ => null,
                };
            }
            // list.Contains(x.Country) or Enumerable.Contains(list, x.Country)
            if (call.Method.Name == "Contains")
            {
                var (source, item) = call.Object is not null && call.Arguments.Count == 1
                    ? (call.Object, call.Arguments[0])
                    : call.Arguments.Count == 2 ? (call.Arguments[0], call.Arguments[1]) : (null, null);
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
                var filter = JazminFilter.In(col.Column.Name, items.Where(i => i is not null).ToArray());
                return items.Contains(null) ? JazminFilter.Or(filter, JazminFilter.IsNull(col.Column.Name)) : filter;
            }
            return null;
        }

        /// <summary>The column when the expression is a direct property of the lambda parameter.</summary>
        private ColumnRef? Column(Expression e)
        {
            while (e is UnaryExpression { NodeType: ExpressionType.Convert or ExpressionType.ConvertChecked } u) e = u.Operand;
            if (e is not MemberExpression m || m.Expression != parameter) return null;
            var column = columnFor(m.Member);
            return column is null ? null : new ColumnRef(column, m.Type);
        }

        /// <summary>Evaluates expressions that do not depend on the parameter (constants, captured variables).</summary>
        private bool TryConstant(Expression e, out object? value)
        {
            value = null;
            var finder = new ParameterFinder(parameter);
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

    private sealed class ParameterFinder(ParameterExpression parameter) : ExpressionVisitor
    {
        public bool Found { get; private set; }

        protected override Expression VisitParameter(ParameterExpression node)
        {
            if (node == parameter) Found = true;
            return node;
        }
    }
}
