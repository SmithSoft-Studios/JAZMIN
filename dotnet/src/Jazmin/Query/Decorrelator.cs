using System.Collections.Concurrent;
using System.Linq.Expressions;
using System.Reflection;

namespace Jazmin.Query;

/// <summary>
/// Rewrites the sub-queries of reader queryables inside a query's lambdas, which LINQ runs once per outer row ("N+1"),
/// so that their rows are read once:
/// <list type="bullet">
/// <item>a sub-query whose condition pairs one of its members with a value of the outer row (<c>o.CustomerId == c.Id</c>)
/// becomes a lookup by that member (a hash join);</item>
/// <item>any other sub-query runs as LINQ to Objects over its rows, read once.</item>
/// </list>
/// The switch is adaptive: the first rows still run their own queries (which use indexes), and the rows are read once
/// only when that costs less, so a query for one customer does not read a whole table. Tables larger than the
/// reader's priority allows to hold keep their queries per row. Results are those of LINQ to Objects either way.
/// </summary>
internal sealed class Decorrelator(Func<IJazminQueryProvider, HashSet<string>?> columnsOf) : ExpressionVisitor
{
    private static readonly HashSet<Type> KeyTypes =
    [
        typeof(int), typeof(long), typeof(short), typeof(byte), typeof(uint), typeof(ulong), typeof(ushort), typeof(sbyte), typeof(char), typeof(bool),
        typeof(string), typeof(decimal), typeof(Guid), typeof(DateTime), typeof(DateTimeOffset), typeof(TimeSpan), typeof(DateOnly), typeof(TimeOnly),
    ];

    private static readonly HashSet<string> WithPredicate = ["First", "FirstOrDefault", "Single", "SingleOrDefault", "Last", "LastOrDefault", "Any", "Count", "LongCount"];

    private static readonly ConcurrentDictionary<MethodInfo, MethodInfo?> EnumerableMethods = new();

    private static readonly MethodInfo AsQueryableMethod =
        new Func<IEnumerable<object>, IQueryable<object>>(Queryable.AsQueryable).Method.GetGenericMethodDefinition();

    private readonly List<ParameterExpression> _outer = []; // the parameters of the lambdas being visited

    // A sub-query inside another one is met twice (the other's lookup and as written): one rewrite, so one lookup.
    private readonly Dictionary<MethodCallExpression, Expression?> _done = new(ReferenceEqualityComparer.Instance);

    protected override Expression VisitLambda<T>(Expression<T> node)
    {
        _outer.AddRange(node.Parameters);
        try
        {
            return base.VisitLambda(node);
        }
        finally
        {
            _outer.RemoveRange(_outer.Count - node.Parameters.Count, node.Parameters.Count);
        }
    }

    protected override Expression VisitMethodCall(MethodCallExpression node)
    {
        if (_outer.Count > 0 && node.Method.DeclaringType == typeof(Queryable))
        {
            if (!_done.TryGetValue(node, out var rewritten)) _done[node] = rewritten = Rewrite(node);
            if (rewritten is not null) return rewritten;
        }
        return base.VisitMethodCall(node);
    }

    /// <summary>A sub-query (Queryable calls on a reader's root, inside a lambda) read once, or null to leave it.</summary>
    private Expression? Rewrite(MethodCallExpression node)
    {
        var written = new List<MethodCallExpression>();
        Expression e = node;
        while (e is MethodCallExpression call && call.Method.DeclaringType == typeof(Queryable))
        {
            written.Add(call);
            e = call.Arguments[0];
        }
        written.Reverse();
        // The source: a reader's queryable, given as a constant or captured in a closure; all rows, or a query on them.
        if (!TryValue(e, out var value) || value is not IQueryable { Provider: IJazminQueryProvider provider } source0) return null;
        var calls = new List<MethodCallExpression>();
        var inner = source0.Expression;
        while (inner is MethodCallExpression call && call.Method.DeclaringType == typeof(Queryable))
        {
            calls.Add(call);
            inner = call.Arguments[0];
        }
        if (inner is not ConstantExpression { Value: IQueryable root } || root.Expression != inner) return null;
        calls.Reverse();
        calls.AddRange(written);
        if (calls.Count == 0) return null;
        if (!provider.CanHold) return null; // too large to hold: queried per row, as written
        var element = root.ElementType;
        // The columns the query reads of these rows; a captured query's own operators are not in it: every column then.
        var columns = calls.Count > written.Count ? null : columnsOf(provider);

        // A condition given to First, Count, Any...: the same as a Where before them.
        LambdaExpression? where = null;
        var first = calls[0];
        var start = 0;
        if (first.Method.Name == "Where" && first.Arguments.Count == 2 && Unquote(first.Arguments[1]) is { Parameters.Count: 1 } w)
            (where, start) = (w, 1);
        else if (WithPredicate.Contains(first.Method.Name) && first.Arguments.Count == 2 && Unquote(first.Arguments[1]) is { Parameters.Count: 1 } p && p.ReturnType == typeof(bool))
            where = p; // the call itself is made again below, without its condition

        Expression source;
        LambdaExpression? residual = null;
        if (where is not null && Correlation(where) is var (key, probe, rest) && key is not null)
        {
            var holder = Activator.CreateInstance(typeof(LookupHolder<,>).MakeGenericType(key.Type, element), provider,
                Expression.Lambda(key, where.Parameters).Compile(), columns)!;
            source = Expression.Call(Expression.Constant(holder), holder.GetType().GetMethod(nameof(LookupHolder<int, int>.Rows))!, Visit(probe!));
            residual = rest;
        }
        else
        {
            var holder = Activator.CreateInstance(typeof(RowsHolder<>).MakeGenericType(element), provider, columns)!;
            source = Expression.Call(Expression.Constant(holder), holder.GetType().GetMethod(nameof(RowsHolder<int>.Rows))!);
            residual = where;
        }
        if (residual is not null) source = Expression.Call(Enumerable(Where(element))!, source, Visit(residual));
        for (var i = start; i < calls.Count; i++)
        {
            var call = calls[i];
            var withoutCondition = i == 0 && where is not null; // First(x => ...) and the like: the condition was applied above
            var method = withoutCondition ? WithoutPredicate(call.Method) : call.Method;
            if (method is null || Enumerable(method) is not { } target) return null;
            var arguments = new List<Expression> { source };
            for (var k = withoutCondition ? 2 : 1; k < call.Arguments.Count; k++)
                arguments.Add(Unquote(call.Arguments[k]) is { } lambda ? Visit(lambda) : Visit(call.Arguments[k]));
            source = Expression.Call(target, arguments);
        }
        var read = Fit(source, node.Type);
        if (read is null) return null;
        // Adaptive: the first rows run the query as written (per row, with indexes); then its rows are read once.
        var asWritten = written.Aggregate(e, (from, call) => call.Update(null, [from, .. call.Arguments.Skip(1).Select(a => Visit(a))]));
        return Expression.Condition(Expression.Call(Expression.Constant(new Gate(provider)), typeof(Gate).GetMethod(nameof(Gate.Hold))!), read, asWritten, node.Type);
    }

    /// <summary>The value of a constant, or of fields read from one (a variable a lambda captured): no code is run.</summary>
    private static bool TryValue(Expression e, out object? value)
    {
        switch (e)
        {
            case ConstantExpression c:
                value = c.Value;
                return true;
            case MemberExpression { Member: FieldInfo field } m when m.Expression is null || TryValue(m.Expression, out _):
                TryValue(m.Expression ?? Expression.Constant(null), out var target);
                value = field.GetValue(target);
                return true;
            default:
                value = null;
                return false;
        }
    }

    /// <summary>
    /// The condition's pairing of one of the sub-query's members (key: uses only its parameter) with a value of the outer
    /// rows (probe: does not use it), compared as LINQ compares them, and the rest of the condition (null if none).
    /// </summary>
    private (Expression? Key, Expression? Probe, LambdaExpression? Others) Correlation(LambdaExpression where)
    {
        var x = where.Parameters[0];
        var conjuncts = new List<Expression>();
        void Split(Expression b)
        {
            if (b is BinaryExpression { NodeType: ExpressionType.AndAlso } and) { Split(and.Left); Split(and.Right); }
            else conjuncts.Add(b);
        }
        Split(where.Body);
        for (var i = 0; i < conjuncts.Count; i++)
        {
            if (conjuncts[i] is not BinaryExpression { NodeType: ExpressionType.Equal } eq) continue;
            var type = Nullable.GetUnderlyingType(eq.Left.Type) ?? eq.Left.Type;
            if (eq.Left.Type != eq.Right.Type || !(KeyTypes.Contains(type) || type.IsEnum)) continue;
            if (eq.Method is not null && eq.Method.DeclaringType != type) continue; // an operator of its own: may not be equality
            foreach (var (key, probe) in new[] { (eq.Left, eq.Right), (eq.Right, eq.Left) })
            {
                var (keyUses, probeUses) = (Uses(key), Uses(probe));
                if (!keyUses.Contains(x) || keyUses.Overlaps(_outer) || probeUses.Contains(x) || !probeUses.Overlaps(_outer)) continue;
                var rest = conjuncts.Where((_, k) => k != i).Aggregate((Expression?)null, (all, c) => all is null ? c : Expression.AndAlso(all, c));
                return (key, probe, rest is null ? null : Expression.Lambda(rest, x));
            }
        }
        return (null, null, null);
    }

    private static HashSet<ParameterExpression> Uses(Expression e)
    {
        var finder = new ParameterFinder();
        finder.Visit(e);
        return finder.Found;
    }

    private sealed class ParameterFinder : ExpressionVisitor
    {
        public HashSet<ParameterExpression> Found { get; } = [];

        protected override Expression VisitParameter(ParameterExpression node)
        {
            Found.Add(node);
            return node;
        }
    }

    /// <summary>The query's result type from LINQ to Objects' (a sequence where a queryable was: as a queryable over it).</summary>
    private static Expression? Fit(Expression read, Type type)
    {
        if (type.IsAssignableFrom(read.Type)) return read;
        var queryable = type.IsGenericType && type.GetGenericTypeDefinition() is var d && (d == typeof(IQueryable<>) || d == typeof(IOrderedQueryable<>));
        if (!queryable) return null;
        return Expression.Convert(Expression.Call(AsQueryableMethod.MakeGenericMethod(type.GetGenericArguments()[0]), read), type);
    }

    private static LambdaExpression? Unquote(Expression e) => e switch
    {
        UnaryExpression { NodeType: ExpressionType.Quote, Operand: LambdaExpression lambda } => lambda,
        LambdaExpression lambda => lambda,
        _ => null,
    };

    private static MethodInfo Where(Type element) =>
        new Func<IQueryable<object>, Expression<Func<object, bool>>, IQueryable<object>>(Queryable.Where).Method.GetGenericMethodDefinition().MakeGenericMethod(element);

    /// <summary>The same operator without its condition (First(x => ...) -> First()), or null.</summary>
    private static MethodInfo? WithoutPredicate(MethodInfo method)
    {
        var definition = typeof(Queryable).GetMethods().FirstOrDefault(m => m.Name == method.Name && m.IsGenericMethodDefinition
            && m.GetGenericArguments().Length == 1 && m.GetParameters().Length == 1);
        return definition?.MakeGenericMethod(method.GetGenericArguments());
    }

    /// <summary>LINQ to Objects' operator for a Queryable one (delegates instead of expressions), or null.</summary>
    private static MethodInfo? Enumerable(MethodInfo queryable) => EnumerableMethods.GetOrAdd(queryable, static q =>
    {
        var wanted = q.GetParameters().Select(p => ToEnumerable(p.ParameterType)).ToArray();
        foreach (var candidate in typeof(Enumerable).GetMethods())
        {
            if (candidate.Name != q.Name || !candidate.IsGenericMethodDefinition || candidate.GetGenericArguments().Length != q.GetGenericArguments().Length) continue;
            if (candidate.GetParameters().Length != wanted.Length) continue;
            MethodInfo closed;
            try
            {
                closed = candidate.MakeGenericMethod(q.GetGenericArguments());
            }
            catch (ArgumentException)
            {
                continue;
            }
            if (closed.GetParameters().Select(p => p.ParameterType).SequenceEqual(wanted)) return closed;
        }
        return null;
    });

    private static Type ToEnumerable(Type type)
    {
        if (!type.IsGenericType) return type;
        var definition = type.GetGenericTypeDefinition();
        var args = type.GetGenericArguments();
        if (definition == typeof(IQueryable<>)) return typeof(IEnumerable<>).MakeGenericType(args);
        if (definition == typeof(IOrderedQueryable<>)) return typeof(IOrderedEnumerable<>).MakeGenericType(args);
        if (definition == typeof(Expression<>)) return args[0];
        return type;
    }

    /// <summary>
    /// When a sub-query's rows are read once: after enough per-row queries that reading them once costs less (a query
    /// per row costs about as much as reading 20,000 rows).
    /// </summary>
    private sealed class Gate(IJazminQueryProvider provider)
    {
        private readonly long _after = Math.Max(4, provider.RowCount / 20_000);
        private long _calls;

        public bool Hold() => ++_calls > _after;
    }
}

/// <summary>A sub-query's rows read once and kept by key (built at first use).</summary>
internal sealed class LookupHolder<TKey, T>(IJazminQueryProvider provider, Func<T, TKey> key, HashSet<string>? columns)
{
    private ILookup<TKey, T>? _lookup;

    public IEnumerable<T> Rows(TKey value) => (_lookup ??= ((IEnumerable<T>)provider.SubQuery(provider.RootExpression, columns)).ToLookup(key))[value];
}

/// <summary>A sub-query's rows read once (at first use).</summary>
internal sealed class RowsHolder<T>(IJazminQueryProvider provider, HashSet<string>? columns)
{
    private List<T>? _rows;

    public List<T> Rows() => _rows ??= [.. (IEnumerable<T>)provider.SubQuery(provider.RootExpression, columns)];
}
