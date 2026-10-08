using System.Collections;
using System.Linq.Expressions;
using System.Reflection;
using Jazmin.Serialization;

namespace Jazmin.Query;

/// <summary>What a reader's queryables ask of their provider.</summary>
internal interface IJazminQueryProvider : IQueryProvider
{
    IEnumerable<T> Enumerate<T>(Expression expression);

    /// <summary>Finds the members of this provider's rows that a query reads (for a query that uses this one as a source).</summary>
    QueryUsage NewUsage();

    /// <summary>
    /// This provider's query used as a source of another query: when it gives rows, it reads the columns of
    /// <paramref name="columns"/> (what the other query reads of them; null: every column) and those its own conditions need.
    /// </summary>
    IQueryable SubQuery(Expression expression, HashSet<string>? columns);

    /// <summary>The root of this provider's queries: all rows.</summary>
    Expression RootExpression { get; }

    /// <summary>The rows of its table.</summary>
    long RowCount { get; }

    /// <summary>Whether its table is small enough, for the reader's priority, to be read once and held for a query's sub-queries.</summary>
    bool CanHold { get; }
}

/// <summary>A LINQ query over a reader's rows (see <see cref="JazminReader.AsQueryable{T}"/>).</summary>
internal sealed class JazminQueryable<T> : IOrderedQueryable<T>
{
    private readonly IJazminQueryProvider _provider;

    /// <summary>A query; without an expression, the root: all rows.</summary>
    public JazminQueryable(IJazminQueryProvider provider, Expression? expression = null)
    {
        _provider = provider;
        Expression = expression ?? Expression.Constant(this);
    }

    public Type ElementType => typeof(T);

    public Expression Expression { get; }

    public IQueryProvider Provider => _provider;

    public IEnumerator<T> GetEnumerator() => _provider.Enumerate<T>(Expression).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

/// <summary>
/// Runs LINQ queries over one reader's rows as <typeparamref name="TRow"/>. The leading operators the reader can do are
/// pushed down: Where conditions become its filter (inexact parts are checked on each object, as
/// <see cref="JazminReader.Query{T}"/> does), Skip/Take its offset and limit, OrderBy/ThenBy along the file's sortedBy
/// columns are dropped (rows are already in that order), and Count/LongCount/Any are answered without building objects.
/// When the objects never leave the query, only the columns of the members it reads are read, wherever it reads them
/// (see <see cref="ColumnsUsed"/>). The remaining operators run in memory, as LINQ to Objects runs them.
/// </summary>
internal sealed class JazminQueryProvider<TRow> : IJazminQueryProvider
{
    private static readonly MethodInfo WhereMethod =
        new Func<IQueryable<object>, Expression<Func<object, bool>>, IQueryable<object>>(Queryable.Where).Method.GetGenericMethodDefinition();

    private static readonly MethodInfo EnumerateMethod = typeof(JazminQueryProvider<TRow>).GetMethod(nameof(ExecuteSequence), BindingFlags.NonPublic | BindingFlags.Instance)!;

    private static readonly MethodInfo ExecuteMethod = typeof(JazminQueryProvider<TRow>).GetMethod(nameof(Execute), 1, [typeof(Expression)])!;

    private readonly JazminReader _reader;
    private readonly TypeMap _map;
    private readonly JazminSerializerSettings? _settings;
    private readonly ConstantExpression _root;

    public JazminQueryProvider(JazminReader reader, TypeMap map, JazminSerializerSettings? settings)
    {
        _reader = reader;
        _map = map;
        _settings = settings;
        Root = new JazminQueryable<TRow>(this);
        _root = (ConstantExpression)Root.Expression;
    }

    public JazminQueryable<TRow> Root { get; }

    public IQueryable CreateQuery(Expression expression) =>
        (IQueryable)Activator.CreateInstance(typeof(JazminQueryable<>).MakeGenericType(ElementType(expression.Type)), this, expression)!;

    public IQueryable<TElement> CreateQuery<TElement>(Expression expression) => new JazminQueryable<TElement>(this, expression);

    public object? Execute(Expression expression)
    {
        try
        {
            return typeof(IQueryable).IsAssignableFrom(expression.Type)
                ? EnumerateMethod.MakeGenericMethod(ElementType(expression.Type)).Invoke(this, [expression])
                : ExecuteMethod.MakeGenericMethod(expression.Type).Invoke(this, [expression]);
        }
        catch (TargetInvocationException e) when (e.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(e.InnerException);
            throw;
        }
    }

    public TResult Execute<TResult>(Expression expression)
    {
        var plan = Plan(Normalize(expression));
        if (plan.Answer is { } answer) return (TResult)answer();
        return plan.Rows.AsQueryable().Provider.Execute<TResult>(plan.Tail!);
    }

    public IEnumerable<T> Enumerate<T>(Expression expression) => ExecuteSequence<T>(expression);

    private IEnumerable<T> ExecuteSequence<T>(Expression expression) => Sequence<T>(expression, null);

    private IEnumerable<T> Sequence<T>(Expression expression, HashSet<string>? columns)
    {
        var plan = Plan(expression, columns);
        return plan.Tail is null ? (IEnumerable<T>)plan.Rows : new EnumerableQuery<T>(plan.Tail);
    }

    public QueryUsage NewUsage() => new(typeof(TRow), _map, _reader, _settings);

    public Expression RootExpression => _root;

    public long RowCount => _reader.RowCount;

    // Rows held for sub-queries read once (Decorrelator): fewer with priority memory, more with speed.
    public bool CanHold => _reader.RowCount <= _reader.Priority switch
    {
        JazminPriority.Memory => 100_000,
        JazminPriority.Speed => 10_000_000,
        _ => 1_000_000,
    };

    /// <summary>Queries planned (tests check that a sub-query is not run per row).</summary>
    internal int Plans { get; private set; }

    private static readonly MethodInfo SubQueryMethod = typeof(JazminQueryProvider<TRow>).GetMethod(nameof(SubQueryOf), BindingFlags.NonPublic | BindingFlags.Instance)!;

    public IQueryable SubQuery(Expression expression, HashSet<string>? columns) =>
        (IQueryable)SubQueryMethod.MakeGenericMethod(ElementType(expression.Type)).Invoke(this, [expression, columns])!;

    private IQueryable<T> SubQueryOf<T>(Expression expression, HashSet<string>? columns) => Sequence<T>(expression, columns).AsQueryable();

    /// <summary>The element type of a queryable or sequence type.</summary>
    private static Type ElementType(Type type)
    {
        var sequence = type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IEnumerable<>)
            ? type
            : type.GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        return sequence?.GetGenericArguments()[0] ?? throw new ArgumentException($"{type.Name} is not a sequence");
    }

    /// <summary>
    /// The pushed-down rows, the operators left to run on them in memory (null: none), and for Count/LongCount/Any the
    /// reader answers, the answer.
    /// </summary>
    private sealed record QueryPlan(IEnumerable<TRow> Rows, Expression? Tail, Func<object>? Answer);

    /// <summary>
    /// Count(x => ...), First(x => ...) and the other terminal operators with a condition are Where(x => ...) followed by
    /// the operator without one, so the condition is pushed down like any other.
    /// </summary>
    private static Expression Normalize(Expression expression)
    {
        if (expression is not MethodCallExpression { Method: { DeclaringType: var type, IsGenericMethod: true } method } call
            || type != typeof(Queryable)
            || method.Name is not ("Count" or "LongCount" or "Any" or "First" or "FirstOrDefault" or "Single" or "SingleOrDefault" or "Last" or "LastOrDefault"))
            return expression;
        var definition = method.GetGenericMethodDefinition();
        var parameters = definition.GetParameters();
        if (parameters.Length < 2 || parameters[1].ParameterType.ToString() != "System.Linq.Expressions.Expression`1[System.Func`2[TSource,System.Boolean]]")
            return expression;
        var rest = parameters.Where((_, k) => k != 1).Select(p => p.ParameterType.ToString()).ToArray();
        var without = typeof(Queryable).GetMethods().Single(m => m.Name == definition.Name && m.IsGenericMethodDefinition
            && m.GetParameters().Select(p => p.ParameterType.ToString()).SequenceEqual(rest));
        var source = call.Arguments[0];
        var element = method.GetGenericArguments()[0];
        var filtered = Expression.Call(WhereMethod.MakeGenericMethod(element), source, call.Arguments[1]);
        return Expression.Call(without.MakeGenericMethod(element), [filtered, .. call.Arguments.Skip(2)]);
    }

    /// <summary>
    /// A query of a reader's provider used directly as an argument of an operator (Join's inner rows, Concat, Zip...): the
    /// provider, or null for anything else.
    /// </summary>
    private static IJazminQueryProvider? SubQueryProvider(Expression argument)
    {
        var e = argument;
        while (e is MethodCallExpression call && call.Method.DeclaringType == typeof(Queryable)) e = call.Arguments[0];
        return e is ConstantExpression { Value: IQueryable { Provider: IJazminQueryProvider provider } root } && root.Expression == e ? provider : null;
    }

    /// <param name="expression">The query, from this provider's root.</param>
    /// <param name="hint">Used as a source of another query: what that query reads of the rows this one gives.</param>
    private QueryPlan Plan(Expression expression, HashSet<string>? hint = null)
    {
        Plans++;
        var calls = new List<MethodCallExpression>();
        var e = expression;
        while (e is MethodCallExpression call && call.Method.DeclaringType == typeof(Queryable))
        {
            calls.Add(call);
            e = call.Arguments[0];
        }
        if (e != _root) throw new NotSupportedException("This query does not start from JazminReader.AsQueryable");
        calls.Reverse();

        // Push down the leading operators the reader can do.
        JazminFilter? filter = null;
        var checks = new List<LambdaExpression>();
        long offset = 0;
        long? limit = null;
        var pushed = new bool[calls.Count];
        var projected = false; // a Select has run (in memory): only Skip/Take, which commute with it, still push down
        // Rows that refer to objects earlier rows define: every row is read, in order, and the whole query runs in memory.
        var pushable = !_map.PreservesReferences;
        for (var i = 0; pushable && i < calls.Count; i++)
        {
            var call = calls[i];
            var name = call.Method.Name;
            if (name == "Where" && !projected && offset == 0 && limit is null && Lambda(call.Arguments[1]) is { Parameters.Count: 1 } predicate)
            {
                var translation = _reader.Translate(predicate, _map);
                if (translation.Filter is { } part) filter = filter is null ? part : JazminFilter.And(filter, part);
                if (!translation.Exact) checks.Add(predicate);
                pushed[i] = true;
            }
            else if (name is "Skip" or "Take" && call.Arguments.Count == 2 && call.Arguments[1].Type == typeof(int) && checks.Count == 0)
            {
                var n = Math.Max(0, (int)Evaluate(call.Arguments[1])!);
                if (name == "Skip")
                {
                    offset += n;
                    if (limit is { } l) limit = Math.Max(0, l - n);
                }
                else limit = Math.Min(limit ?? long.MaxValue, n);
                pushed[i] = true;
            }
            else if (name == "OrderBy" && !projected && SortedAsStored(calls, i) is var run and > 0)
            {
                for (var k = i; k < i + run; k++) pushed[k] = true;
                i += run - 1;
            }
            else if (name == "Select" && !projected && Lambda(call.Arguments[1]) is { Parameters.Count: 1 }) projected = true;
            else break;
        }
        var tail = calls.Where((_, k) => !pushed[k]).ToList();

        // Count/LongCount/Any straight after the pushed-down part, with nothing left to check: the reader answers.
        if (pushable && checks.Count == 0 && tail.Count is 1 or 2 && tail[^1] is { Arguments.Count: 1, Method.Name: "Count" or "LongCount" or "Any" } last
            && (tail.Count == 1 || tail[0].Method.Name == "Select"))
        {
            var (where, skip, take) = (filter, offset, limit);
            Func<object> answer = last.Method.Name == "Any"
                ? () => take != 0 && _reader.Find(where, new JazminQueryOptions { Offset = skip, Limit = 1, Select = [] }).Any()
                : () =>
                {
                    var n = Math.Min(Math.Max(0, _reader.Count(where) - skip), take ?? long.MaxValue);
                    return last.Method.Name == "Count" ? checked((int)n) : (object)n;
                };
            return new QueryPlan([], null, answer);
        }

        var compiled = checks.Select(c => (Func<TRow, bool>)c.Compile()).ToArray();
        Func<TRow, bool>? check = compiled.Length switch
        {
            0 => null,
            1 => compiled[0],
            _ => row => Array.TrueForAll(compiled, c => c(row)),
        };
        var operators = tail.Count == 0 ? null : tail.Aggregate((Expression)Expression.Parameter(typeof(IQueryable<TRow>), "rows"),
            (source, call) => Expression.Call(call.Method, [source, .. call.Arguments.Skip(1)]));
        var (columns, trimmed) = ColumnsUsed(checks, operators, hint);
        var rows = _reader.TypedRows(_map, _settings, filter, check, offset, limit, columns?.ToList(), trimmed);
        if (tail.Count == 0) return new QueryPlan(rows, null, null);
        Expression rest = Expression.Constant(rows.AsQueryable(), typeof(IQueryable<TRow>));
        var decorrelator = new Decorrelator(provider => SubQueryColumns(provider, operators!)); // sub-queries inside lambdas: read once
        foreach (var call in tail)
        {
            var parameters = call.Method.GetParameters();
            var arguments = call.Arguments.Select((argument, i) => i == 0 ? rest
                : SubQueryProvider(argument) is { } provider ? Expression.Constant(provider.SubQuery(argument, SubQueryColumns(provider, operators!)), parameters[i].ParameterType)
                : decorrelator.Visit(argument));
            rest = Expression.Call(call.Method, arguments);
        }
        return new QueryPlan(rows, rest, null);
    }

    /// <summary>
    /// How many calls from <paramref name="at"/> (an OrderBy and the ThenBys after it) put rows in the order they are
    /// stored, so can be dropped: each key a property read as stored, of a non-nullable sortedBy column, in that order,
    /// and compared as stored (numbers, dates, bools; strings with StringComparer.Ordinal). 0 when any is not.
    /// </summary>
    private int SortedAsStored(List<MethodCallExpression> calls, int at)
    {
        if (_reader.SortedBy is not { } sortedBy) return 0;
        var run = 1;
        while (at + run < calls.Count && calls[at + run].Method.Name is "ThenBy" or "ThenByDescending") run++;
        if (run > sortedBy.Count) return 0;
        for (var k = 0; k < run; k++)
        {
            var call = calls[at + k];
            if (call.Method.Name is "ThenByDescending" || Lambda(call.Arguments[1]) is not { Parameters.Count: 1 } key) return 0;
            if (key.Body is not MemberExpression { Member: var member } m || m.Expression != key.Parameters[0]) return 0;
            if (_reader.FileColumn(_map, member) is not { Nullable: false } column || column.Name != sortedBy[k]) return 0;
            var ordinal = call.Arguments.Count == 3 && Evaluate(call.Arguments[2]) == (object)StringComparer.Ordinal;
            var asStored = column.Type switch
            {
                JazminType.Int or JazminType.DateTime or JazminType.Bool => call.Arguments.Count == 2,
                JazminType.String => ordinal && key.Body.Type == typeof(string),
                _ => false,
            };
            if (!asStored) return 0;
        }
        return run;
    }

    /// <summary>
    /// The columns the objects need, or null for all: the members of the rows that the remaining conditions and the
    /// operators after the pushed-down part (<paramref name="tail"/>, over a placeholder source) read, at any depth:
    /// through SelectMany, GroupBy, Join, nested queries, anonymous types and groups. Rows the caller receives, or that
    /// may be read in ways the query does not show, need every column (see <see cref="QueryUsage"/>). With them, the
    /// nested columns of which the query reads only some fields, trimmed to those (null: none).
    /// </summary>
    private (HashSet<string>? Columns, IReadOnlyDictionary<string, JazminColumn>? Trimmed) ColumnsUsed(List<LambdaExpression> checks, Expression? tail, HashSet<string>? hint)
    {
        if (tail is null && hint is null) return (null, null); // the caller receives the objects
        var finder = NewUsage();
        foreach (var check in checks) finder.Visit(check.Body); // conditions checked on each object
        if (tail is not null)
        {
            if (finder.CarriesRows(tail.Type))
            {
                if (hint is null) return (null, null);
                finder.Allow(tail); // the rows go to the query this one is a source of, which says what it reads of them
            }
            finder.Visit(tail);
        }
        if (finder.Whole) return (null, null);
        if (hint is not null)
        {
            finder.Used.UnionWith(hint);
            return (finder.Used, null); // the other query reads the rows' nested values: they are read whole
        }
        return (finder.Used, finder.Trimmed());
    }

    /// <summary>What a query reads of the rows of a sub-query of <paramref name="provider"/> it uses as a source (null: every column).</summary>
    private static HashSet<string>? SubQueryColumns(IJazminQueryProvider provider, Expression operators)
    {
        var finder = provider.NewUsage();
        if (finder.CarriesRows(operators.Type)) return null;
        finder.Visit(operators);
        return finder.Whole ? null : finder.Used;
    }

    private static LambdaExpression? Lambda(Expression e) => e switch
    {
        UnaryExpression { NodeType: ExpressionType.Quote, Operand: LambdaExpression lambda } => lambda,
        LambdaExpression lambda => lambda,
        _ => null,
    };

    private static object? Evaluate(Expression e) =>
        e is ConstantExpression c ? c.Value : Expression.Lambda<Func<object?>>(Expression.Convert(e, typeof(object))).Compile(preferInterpretation: true)();
}

/// <summary>
/// Collects the columns of the row members a query reads. A row (or anything holding rows: sequences, groups,
/// anonymous objects) may only flow where every read of it shows in the query: into a member read, into LINQ
/// operators that pass elements on (as their source, or as what a Select, SelectMany, Join or GroupBy result makes),
/// and into new objects and arrays. Anywhere else (a method call, a cast, an equality or a sort on the rows
/// themselves, a comparer, a computed property, the query's result) it is <see cref="Whole"/>: every column.
/// </summary>
internal sealed class QueryUsage : ExpressionVisitor
{
    private static readonly HashSet<string> ByElementEquality =
        ["Distinct", "Union", "Intersect", "Except", "SequenceEqual", "Contains", "ToHashSet", "Order", "OrderDescending", "Cast", "OfType"];

    private readonly Type _row;
    private readonly TypeMap _map;
    private readonly JazminReader _reader;
    private readonly JazminSerializerSettings? _settings;

    // Places a parent allows rows to flow into, each for one visit: one parameter object stands for all its uses.
    private readonly Dictionary<Expression, int> _allowed = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<Type, bool> _carriesRows = [];
    private readonly Dictionary<Type, Type[]> _nestedIn = [];

    // Nested columns (spec 5.4): their lists and objects, and the .NET types of the objects (a type may be at several).
    private readonly Dictionary<string, NestedPart> _roots = new(StringComparer.Ordinal);
    private readonly Dictionary<Type, List<NestedPart>> _byType = [];

    public QueryUsage(Type row, TypeMap map, JazminReader reader, JazminSerializerSettings? settings = null)
    {
        (_row, _map, _reader, _settings) = (row, map, reader, settings);
        foreach (var property in row.GetProperties())
            if (reader.FileColumn(map, property) is { } column && TypeNames.IsNested(column.Type))
                _roots[column.Name] = Register(property.PropertyType, column);
    }

    /// <summary>A list or object of a nested column: which of its fields a query reads, or all of them.</summary>
    private sealed class NestedPart(JazminColumn column)
    {
        public JazminColumn Column { get; } = column;
        public bool All { get; set; }
        public HashSet<string> Read { get; } = new(StringComparer.Ordinal); // objects: fields read
        public Dictionary<string, NestedPart> Parts { get; } = new(StringComparer.Ordinal); // fields that are lists or objects; a list's item ("")
    }

    /// <summary>A nested column's parts, for values of <paramref name="type"/>: objects by their .NET type.</summary>
    private NestedPart Register(Type type, JazminColumn column)
    {
        var part = new NestedPart(column);
        var t = Nullable.GetUnderlyingType(type) ?? type;
        if (column.Type == JazminType.List)
        {
            if (ListElement(t) is { } element && TypeNames.IsNested(column.Item!.Type)) part.Parts[""] = Register(element, column.Item);
            else if (TypeNames.IsNested(column.Item!.Type)) part.All = true; // items of a type not followed: read whole
            return part;
        }
        if (Format.Nested.MapOf(t, _settings) is not { } map)
        {
            part.All = true;
            return part;
        }
        (_byType.TryGetValue(t, out var parts) ? parts : _byType[t] = []).Add(part);
        foreach (var field in column.Fields!)
            if (TypeNames.IsNested(field.Type) && map.MemberProperty(field.Name) is { } property) part.Parts[field.Name] = Register(property.PropertyType, field);
        return part;
    }

    private static Type? ListElement(Type t)
    {
        if (t.IsArray) return t.GetArrayRank() == 1 ? t.GetElementType() : null;
        if (!t.IsGenericType || t.GetGenericArguments().Length != 1) return null;
        var element = t.GetGenericArguments()[0];
        return t.IsAssignableFrom(typeof(List<>).MakeGenericType(element)) ? element : null;
    }

    public HashSet<string> Used { get; } = new(StringComparer.Ordinal);

    public bool Whole { get; private set; }

    /// <summary>Whether values of this type can hold rows, or objects of nested columns: what must be followed.</summary>
    public bool Carries(Type type) => CarriesRows(type) || NestedIn(type).Length > 0;

    /// <summary>Whether values of this type can hold rows: the row type, or a type built from it.</summary>
    public bool CarriesRows(Type type)
    {
        if (type == _row) return true;
        if (_carriesRows.TryGetValue(type, out var known)) return known;
        _carriesRows[type] = false; // a type that refers to itself
        var carries = type.HasElementType && CarriesRows(type.GetElementType()!)
            || type.IsGenericType && type.GetGenericArguments().Any(CarriesRows)
            || IsAnonymous(type) && type.GetProperties().Any(p => CarriesRows(p.PropertyType));
        return _carriesRows[type] = carries;
    }

    /// <summary>The .NET types of nested columns' objects that values of this type can hold.</summary>
    private Type[] NestedIn(Type type)
    {
        if (_byType.Count == 0) return [];
        if (_nestedIn.TryGetValue(type, out var known)) return known;
        _nestedIn[type] = []; // a type that refers to itself
        var found = new HashSet<Type>();
        var t = Nullable.GetUnderlyingType(type) ?? type;
        if (_byType.ContainsKey(t)) found.Add(t);
        if (type.HasElementType) found.UnionWith(NestedIn(type.GetElementType()!));
        if (type.IsGenericType) foreach (var argument in type.GetGenericArguments()) found.UnionWith(NestedIn(argument));
        if (IsAnonymous(type)) foreach (var p in type.GetProperties()) found.UnionWith(NestedIn(p.PropertyType));
        return _nestedIn[type] = [.. found];
    }

    private static bool IsAnonymous(Type type) =>
        type.IsDefined(typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute), false) && type.Name.Contains("AnonymousType", StringComparison.Ordinal);

    public override Expression? Visit(Expression? node)
    {
        if (node is null || Whole) return node;
        if (node is not LambdaExpression && node.NodeType != ExpressionType.Quote && Carries(node.Type) && !Consume(node))
        {
            if (CarriesRows(node.Type))
            {
                Whole = true; // rows reach a place where their reads do not show
                return node;
            }
            foreach (var type in NestedIn(node.Type))
                foreach (var part in _byType[type]) part.All = true; // so do nested objects: all their fields are read
        }
        return base.Visit(node);
    }

    /// <summary>
    /// The nested columns the query reads, trimmed to the fields it reads (the others marked <see cref="JazminColumn.Unread"/>);
    /// null when it reads every field of every one.
    /// </summary>
    public IReadOnlyDictionary<string, JazminColumn>? Trimmed()
    {
        Dictionary<string, JazminColumn>? trimmed = null;
        foreach (var (name, part) in _roots)
            if (Used.Contains(name) && Trim(part) is var column && !ReferenceEquals(column, part.Column)) (trimmed ??= new(StringComparer.Ordinal))[name] = column;
        return trimmed;
    }

    /// <summary>A part's definition with the fields not read marked so (the same definition when all are read).</summary>
    private static JazminColumn Trim(NestedPart part)
    {
        var c = part.Column;
        if (part.All) return c;
        if (c.Type == JazminType.List)
        {
            if (!part.Parts.TryGetValue("", out var item) || Trim(item) is var trimmedItem && ReferenceEquals(trimmedItem, c.Item)) return c;
            return new JazminColumn(c.Name, c.Type) { Nullable = c.Nullable, Item = trimmedItem };
        }
        var fields = c.Fields!.Select(f => !part.Read.Contains(f.Name) ? new JazminColumn(f.Name, f.Type) { Nullable = f.Nullable, Item = f.Item, Fields = f.Fields, Unread = true }
            : part.Parts.TryGetValue(f.Name, out var inner) ? Trim(inner) : f).ToArray();
        return fields.Select((f, i) => ReferenceEquals(f, c.Fields![i])).All(same => same) ? c
            : new JazminColumn(c.Name, c.Type) { Nullable = c.Nullable, Fields = fields };
    }

    public void Allow(Expression node) => _allowed[node] = _allowed.GetValueOrDefault(node) + 1;

    private bool Consume(Expression node)
    {
        if (!_allowed.TryGetValue(node, out var n)) return false;
        if (n == 1) _allowed.Remove(node);
        else _allowed[node] = n - 1;
        return true;
    }

    protected override Expression VisitLambda<T>(Expression<T> node)
    {
        Visit(node.Body); // the parameters are declarations: their uses are checked where they appear
        return node;
    }

    protected override Expression VisitMember(MemberExpression node)
    {
        if (node.Expression is { } target && Carries(target.Type))
        {
            Allow(target);
            if (target.Type == _row)
            {
                if (_map.ColumnRead(node.Member) is not { } name) Whole = true; // a computed property may read anything
                else if (_reader.VisibleColumnName(name) is { } column) Used.Add(column); // not in the file: keeps its default
            }
            else if (_byType.TryGetValue(Nullable.GetUnderlyingType(target.Type) ?? target.Type, out var parts))
            {
                // A field of a nested column's object, wherever objects of this type are.
                var field = Format.Nested.MapOf(Nullable.GetUnderlyingType(target.Type) ?? target.Type, _settings)?.ColumnRead(node.Member);
                foreach (var part in parts)
                {
                    if (field is null) part.All = true; // a computed property may read any field
                    else part.Read.Add(field);
                }
            }
        }
        return base.VisitMember(node);
    }

    protected override Expression VisitMethodCall(MethodCallExpression node)
    {
        var type = node.Method.DeclaringType;
        if (type != typeof(Queryable) && type != typeof(Enumerable))
        {
            if (node.Method.Name == "get_Item" && node.Object is { } list) Allow(list); // rows[i]: the row is checked where it goes
            return base.VisitMethodCall(node);
        }
        var name = node.Method.Name;
        var args = node.Arguments;
        if (!ByElementEquality.Contains(name) && !(name is "Min" or "Max" && args.Count == 1)) Allow(args[0]);
        for (var i = 1; i < args.Count; i++)
        {
            if (QueryLambda(args[i]) is { } lambda)
            {
                if (Projects(name, i)) Allow(lambda.Body); // a key or comparison of whole rows stays unallowed
            }
            else if (name is "Join" or "GroupJoin" or "Concat" or "Zip" && i == 1) Allow(args[i]); // a second source
            else if (name is "Append" or "Prepend") Allow(args[i]); // one more element
        }
        return base.VisitMethodCall(node);
    }

    /// <summary>Whether the lambda at argument <paramref name="i"/> makes the operator's results (not keys it compares).</summary>
    private static bool Projects(string name, int i) => name switch
    {
        "Select" or "SelectMany" or "Aggregate" => true,
        "Join" or "GroupJoin" => i == 4,
        "GroupBy" => i >= 2,
        "Zip" => i == 2,
        _ => false,
    };

    protected override Expression VisitBinary(BinaryExpression node)
    {
        // A nested object compared with null: only whether it is there is read, none of its fields.
        if (node.NodeType is ExpressionType.Equal or ExpressionType.NotEqual)
        {
            if (IsNull(node.Right) && !CarriesRows(node.Left.Type) && NestedIn(node.Left.Type).Length > 0) Allow(node.Left);
            else if (IsNull(node.Left) && !CarriesRows(node.Right.Type) && NestedIn(node.Right.Type).Length > 0) Allow(node.Right);
        }
        return base.VisitBinary(node);
    }

    private static bool IsNull(Expression e) => e is ConstantExpression { Value: null } || e is UnaryExpression { NodeType: ExpressionType.Convert, Operand: ConstantExpression { Value: null } };

    protected override Expression VisitNew(NewExpression node)
    {
        foreach (var arg in node.Arguments) Allow(arg); // stored in a new object, checked where it goes
        return base.VisitNew(node);
    }

    protected override MemberAssignment VisitMemberAssignment(MemberAssignment node)
    {
        Allow(node.Expression);
        return base.VisitMemberAssignment(node);
    }

    protected override Expression VisitNewArray(NewArrayExpression node)
    {
        if (node.NodeType == ExpressionType.NewArrayInit) foreach (var item in node.Expressions) Allow(item);
        return base.VisitNewArray(node);
    }

    protected override Expression VisitConditional(ConditionalExpression node)
    {
        if (Carries(node.Type)) // allowed itself, or it would not be visited
        {
            Allow(node.IfTrue);
            Allow(node.IfFalse);
        }
        return base.VisitConditional(node);
    }

    private static LambdaExpression? QueryLambda(Expression e) => e switch
    {
        UnaryExpression { NodeType: ExpressionType.Quote, Operand: LambdaExpression lambda } => lambda,
        LambdaExpression lambda => lambda,
        _ => null,
    };
}
