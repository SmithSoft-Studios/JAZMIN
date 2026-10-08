using System.Collections.Concurrent;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;

namespace Jazmin.Query;

/// <summary>
/// The parts of a LINQ query that run in memory (what follows the reader's part, as LINQ to Objects, and the parts of a
/// predicate the reader cannot check), compiled once per shape. A query's values - the rows read, the closures of
/// captured variables, sub-queries and lookups - are taken out as parameters, so the same query with other values runs
/// the code compiled the first time: a lookup in a loop compiles once, not on every call. Queryable operators become
/// Enumerable ones, as EnumerableQuery makes them. A query this does not take apart runs as before.
/// </summary>
internal static class CompiledQueries
{
    private const int MaxShapes = 1024; // then the cache starts again: room for any program's queries, bounded for generated ones
    private static readonly ConcurrentDictionary<string, Delegate> Cache = new(StringComparer.Ordinal);
    private static readonly Delegate NotCompiled = () => { }; // a shape run as before
    private static readonly ConcurrentDictionary<MethodInfo, MethodInfo?> EnumerableOf = new();
    private static long _compilations;

    /// <summary>Tests: how many times code was compiled (once per new shape).</summary>
    internal static long Compilations => Interlocked.Read(ref _compilations);

    /// <summary>The result of a query's in-memory part (<paramref name="query"/>, over constants), or false when it cannot be compiled.</summary>
    public static bool TryExecute<TResult>(Expression query, out TResult result)
    {
        if (Get<Func<object?[], TResult>>(query, typeof(TResult), out var values) is { } run)
        {
            result = run(values);
            return true;
        }
        result = default!;
        return false;
    }

    /// <summary>The rows of a query's in-memory part, or null when it cannot be compiled.</summary>
    public static IEnumerable<T>? Sequence<T>(Expression query) =>
        Get<Func<object?[], IEnumerable<T>>>(query, typeof(IEnumerable<T>), out var values) is { } run ? run(values) : null;

    /// <summary>A predicate as a delegate: compiled once per shape, with this call's values.</summary>
    public static Func<T, bool> Predicate<T>(Expression<Func<T, bool>> predicate) =>
        Get<Func<object?[], T, bool>>(predicate, typeof(bool), out var values) is { } check ? row => check(values, row) : predicate.Compile();

    private static TDelegate? Get<TDelegate>(Expression query, Type result, out object?[] values) where TDelegate : Delegate
    {
        var shape = new Shape();
        shape.Visit(query);
        values = [.. shape.Values];
        if (!shape.Supported) return null;
        var key = $"{typeof(TDelegate).TypeHandle.Value}|{shape.Key}";
        if (Cache.TryGetValue(key, out var cached)) return cached as TDelegate; // null for a shape that is not compiled
        TDelegate? compiled;
        try
        {
            compiled = Compile<TDelegate>(query, result);
        }
        catch (Exception e) when (e is InvalidOperationException or ArgumentException or NotSupportedException)
        {
            compiled = null; // not taken apart: runs as before
        }
        if (Cache.Count >= MaxShapes) Cache.Clear();
        Cache[key] = compiled ?? NotCompiled; // remembered either way: a shape is tried once
        return compiled;
    }

    private static TDelegate? Compile<TDelegate>(Expression query, Type result) where TDelegate : Delegate
    {
        Interlocked.Increment(ref _compilations);
        var values = Expression.Parameter(typeof(object[]), "values");
        var rewriter = new Rewriter(values);
        if (query is LambdaExpression predicate) // Func<object[], T, bool>
        {
            var body = rewriter.Visit(predicate.Body);
            return rewriter.Failed ? null : Expression.Lambda<TDelegate>(body, [values, .. predicate.Parameters]).Compile();
        }
        var rewritten = rewriter.Visit(query);
        if (rewriter.Failed || !result.IsAssignableFrom(rewritten.Type)) return null;
        return Expression.Lambda<TDelegate>(Expression.Convert(rewritten, result), values).Compile();
    }

    /// <summary>
    /// A query's shape (everything but its values, as text: node kinds, types, methods, members, parameters by position)
    /// and its values (constants, in the order they appear). Unsupported node kinds leave it <see cref="Supported"/> false.
    /// </summary>
    private sealed class Shape : ExpressionVisitor
    {
        private readonly StringBuilder _key = new();
        private readonly Dictionary<ParameterExpression, int> _parameters = new(ReferenceEqualityComparer.Instance);

        public List<object?> Values { get; } = [];
        public bool Supported { get; private set; } = true;
        public string Key => _key.ToString();

        private void Type(Type t) => _key.Append(t.TypeHandle.Value).Append(',');

        private void Member(MemberInfo m) => _key.Append(m.Module.ModuleHandle.GetHashCode()).Append(':').Append(m.MetadataToken).Append(',')
            .Append(m.DeclaringType?.TypeHandle.Value).Append(m is MethodInfo { IsGenericMethod: true } g ? string.Join(";", g.GetGenericArguments().Select(a => a.TypeHandle.Value)) : "").Append(',');

        public override Expression? Visit(Expression? node)
        {
            if (node is null)
            {
                _key.Append("~,");
                return null;
            }
            if (!Supported) return node;
            switch (node.NodeType)
            {
                case ExpressionType.Block or ExpressionType.Loop or ExpressionType.Goto or ExpressionType.Label or ExpressionType.Try or ExpressionType.Switch
                    or ExpressionType.Assign or ExpressionType.Extension or ExpressionType.RuntimeVariables or ExpressionType.Dynamic or ExpressionType.DebugInfo:
                    Supported = false; // not in queries
                    return node;
            }
            _key.Append((int)node.NodeType).Append('(');
            Type(node.Type);
            var result = base.Visit(node);
            _key.Append(')');
            return result;
        }

        protected override Expression VisitConstant(ConstantExpression node)
        {
            _key.Append('#').Append(Values.Count).Append(',');
            Values.Add(node.Value);
            return node;
        }

        protected override Expression VisitParameter(ParameterExpression node)
        {
            if (!_parameters.TryGetValue(node, out var n)) _parameters[node] = n = _parameters.Count;
            _key.Append('p').Append(n).Append(',');
            return node;
        }

        protected override Expression VisitLambda<T>(Expression<T> node)
        {
            foreach (var p in node.Parameters) VisitParameter(p);
            Visit(node.Body);
            return node;
        }

        protected override Expression VisitMember(MemberExpression node)
        {
            Member(node.Member);
            return base.VisitMember(node);
        }

        protected override Expression VisitMethodCall(MethodCallExpression node)
        {
            Member(node.Method);
            return base.VisitMethodCall(node);
        }

        protected override Expression VisitNew(NewExpression node)
        {
            if (node.Constructor is { } c) Member(c);
            foreach (var m in node.Members ?? []) Member(m);
            return base.VisitNew(node);
        }

        protected override Expression VisitBinary(BinaryExpression node)
        {
            if (node.Method is { } m) Member(m);
            _key.Append(node.IsLiftedToNull ? 'L' : 'l');
            return base.VisitBinary(node);
        }

        protected override Expression VisitUnary(UnaryExpression node)
        {
            if (node.Method is { } m) Member(m);
            return base.VisitUnary(node);
        }

        protected override Expression VisitTypeBinary(TypeBinaryExpression node)
        {
            Type(node.TypeOperand);
            return base.VisitTypeBinary(node);
        }

        protected override Expression VisitIndex(IndexExpression node)
        {
            if (node.Indexer is { } p) Member(p);
            return base.VisitIndex(node);
        }

        protected override MemberBinding VisitMemberBinding(MemberBinding node)
        {
            _key.Append('b').Append((int)node.BindingType).Append(',');
            Member(node.Member);
            return base.VisitMemberBinding(node);
        }

        protected override ElementInit VisitElementInit(ElementInit node)
        {
            Member(node.AddMethod);
            return base.VisitElementInit(node);
        }
    }

    /// <summary>
    /// The query as code to compile: its constants read from the values array (in the order <see cref="Shape"/> takes them),
    /// and Queryable operators replaced by the Enumerable ones of the same name and kind of arguments.
    /// </summary>
    private sealed class Rewriter(ParameterExpression values) : ExpressionVisitor
    {
        private int _next;

        public bool Failed { get; private set; }

        protected override Expression VisitConstant(ConstantExpression node) =>
            Expression.Convert(Expression.ArrayIndex(values, Expression.Constant(_next++)), node.Type);

        protected override Expression VisitLambda<T>(Expression<T> node) => Expression.Lambda(node.Type, Visit(node.Body), node.Parameters);

        protected override Expression VisitMethodCall(MethodCallExpression node)
        {
            var target = node.Object is null ? null : Visit(node.Object);
            var arguments = node.Arguments.Select(a => Visit(a)!).ToArray();
            if (node.Method.DeclaringType != typeof(Queryable)) return node.Update(target, arguments);
            if (EnumerableOf.GetOrAdd(node.Method, Enumerable) is not { } method)
            {
                Failed = true;
                return node;
            }
            var parameters = method.GetParameters();
            for (var i = 0; i < arguments.Length; i++)
            {
                var argument = arguments[i] is UnaryExpression { NodeType: ExpressionType.Quote, Operand: var lambda } ? lambda : arguments[i];
                if (!parameters[i].ParameterType.IsAssignableFrom(argument.Type))
                {
                    Failed = true;
                    return node;
                }
                arguments[i] = argument;
            }
            return Expression.Call(method, arguments);
        }

        protected override Expression VisitUnary(UnaryExpression node) =>
            node.NodeType == ExpressionType.Quote ? Expression.Quote(Visit(node.Operand)) : base.VisitUnary(node);
    }

    /// <summary>The Enumerable operator for a Queryable one: same name and generic arguments, Func for Expression&lt;Func&gt;, IEnumerable for IQueryable.</summary>
    private static MethodInfo? Enumerable(MethodInfo queryable)
    {
        if (!queryable.IsGenericMethod) // Sum, Average... of a number type
        {
            var plain = queryable.GetParameters().Select(p => Plain(p.ParameterType)).ToArray();
            return typeof(Enumerable).GetMethod(queryable.Name, BindingFlags.Public | BindingFlags.Static, plain);
        }
        var definition = queryable.GetGenericMethodDefinition();
        var wanted = definition.GetParameters().Select(p => Plain(p.ParameterType)).ToArray();
        var match = typeof(Enumerable).GetMethods(BindingFlags.Public | BindingFlags.Static).FirstOrDefault(m =>
            m.Name == definition.Name && m.IsGenericMethodDefinition && m.GetGenericArguments().Length == definition.GetGenericArguments().Length
            && m.GetParameters().Select(p => Describe(p.ParameterType)).SequenceEqual(wanted.Select(Describe)));
        return match?.MakeGenericMethod(queryable.GetGenericArguments());
    }

    /// <summary>A Queryable parameter type as the Enumerable one: Expression&lt;X&gt; is X, IQueryable is IEnumerable.</summary>
    private static Type Plain(Type t)
    {
        if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(Expression<>)) return t.GetGenericArguments()[0];
        if (t == typeof(IQueryable)) return typeof(System.Collections.IEnumerable);
        if (t.IsGenericType)
        {
            var d = t.GetGenericTypeDefinition();
            if (d == typeof(IQueryable<>)) return typeof(IEnumerable<>).MakeGenericType(t.GetGenericArguments());
            if (d == typeof(IOrderedQueryable<>)) return typeof(IOrderedEnumerable<>).MakeGenericType(t.GetGenericArguments());
        }
        return t;
    }

    /// <summary>A parameter type as text, with generic method parameters by position (their names may differ).</summary>
    private static string Describe(Type t) =>
        t.IsGenericMethodParameter ? $"!!{t.GenericParameterPosition}"
        : t.IsGenericType ? $"{t.GetGenericTypeDefinition().FullName}[{string.Join(",", t.GetGenericArguments().Select(Describe))}]"
        : t.IsArray ? $"{Describe(t.GetElementType()!)}[]"
        : t.IsByRef ? $"{Describe(t.GetElementType()!)}&"
        : t.FullName ?? t.Name;
}
