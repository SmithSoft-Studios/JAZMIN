using System.Collections;
using System.Linq.Expressions;
using System.Reflection;
using Jazmin.Serialization;

namespace Jazmin.Query;

/// <summary>What a reader's queryables ask of their provider.</summary>
internal interface IJazminQueryProvider : IQueryProvider
{
    IEnumerable<T> Enumerate<T>(Expression expression);
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
/// When the objects never leave the query (a Select, or Count, Sum, Min, Max... with a selector), only the columns they
/// use are read. The remaining operators run in memory, as LINQ to Objects runs them.
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

    private IEnumerable<T> ExecuteSequence<T>(Expression expression)
    {
        var plan = Plan(expression);
        return plan.Tail is null ? (IEnumerable<T>)plan.Rows : new EnumerableQuery<T>(plan.Tail);
    }

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

    private QueryPlan Plan(Expression expression)
    {
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
        var columns = ColumnsUsed(checks, tail);
        var rows = _reader.TypedRows(_map, _settings, filter, check, offset, limit, columns?.ToList());
        if (tail.Count == 0) return new QueryPlan(rows, null, null);
        Expression rest = Expression.Constant(rows.AsQueryable(), typeof(IQueryable<TRow>));
        foreach (var call in tail) rest = Expression.Call(call.Method, [rest, .. call.Arguments.Skip(1)]);
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
    /// The columns the objects need, or null for all: the members the remaining conditions and the operators after the
    /// pushed-down part read, when the objects never leave the query (they end in a Select, or in Count, Any, All, Sum,
    /// Average, Min or Max). Objects the caller receives, or passes whole to anything, need every column.
    /// </summary>
    private HashSet<string>? ColumnsUsed(List<LambdaExpression> checks, List<MethodCallExpression> tail)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        var all = false;
        void Collect(LambdaExpression lambda)
        {
            if (lambda.Parameters.Count == 0 || lambda.Parameters[0].Type != typeof(TRow)) return;
            var finder = new MemberFinder(lambda.Parameters[0], _map, _reader, used);
            finder.Visit(lambda.Body);
            all |= finder.Whole;
        }
        foreach (var check in checks) Collect(check);
        foreach (var call in tail)
        {
            var lambdas = call.Arguments.Skip(1).Select(Lambda).OfType<LambdaExpression>().ToList();
            var name = call.Method.Name;
            if (name is "Where" or "OrderBy" or "OrderByDescending" or "ThenBy" or "ThenByDescending" or "Skip" or "Take" or "SkipWhile" or "TakeWhile" or "Reverse")
            {
                lambdas.ForEach(Collect);
                continue;
            }
            var ends = name is "Select" or "Count" or "LongCount" or "Any" or "All" or "Sum" or "Average"
                || (name is "Min" or "Max" && lambdas.Count == 1);
            if (!ends) return null;
            lambdas.ForEach(Collect);
            return all ? null : used;
        }
        return null; // the caller receives the objects
    }

    /// <summary>The columns of the members a lambda reads from its parameter; <see cref="Whole"/> when it uses the object otherwise.</summary>
    private sealed class MemberFinder(ParameterExpression parameter, TypeMap map, JazminReader reader, HashSet<string> used) : ExpressionVisitor
    {
        public bool Whole { get; private set; }

        protected override Expression VisitMember(MemberExpression node)
        {
            if (node.Expression != parameter) return base.VisitMember(node);
            if (map.ColumnRead(node.Member) is not { } name) Whole = true;
            else if (reader.VisibleColumnName(name) is { } column) used.Add(column); // not in the file: the member keeps its default
            return node;
        }

        protected override Expression VisitParameter(ParameterExpression node)
        {
            if (node == parameter) Whole = true;
            return node;
        }
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
