using System.Linq.Expressions;
using System.Reflection;

namespace Jazmin.Query;

/// <summary>
/// C# 14 (.NET 10's default) compiles <c>array.Contains(x.Id)</c> in a lambda as
/// <c>MemoryExtensions.Contains(ReadOnlySpan&lt;T&gt;.op_Implicit(array), x.Id)</c>. A span can't be held as a value, so
/// such a call is put back as <c>Enumerable.Contains(array, x.Id)</c>, which older C# compiles and the query
/// translator turns into an <c>in</c> filter. Trees without such a call come back as they were (the same object).
/// </summary>
internal sealed class SpanContains : ExpressionVisitor
{
    private static readonly SpanContains Instance = new();

    private static readonly MethodInfo EnumerableContains = typeof(Enumerable).GetMethods()
        .Single(m => m.Name == nameof(Enumerable.Contains) && m.GetParameters().Length == 2);

    private static readonly MethodInfo EnumerableContainsWithComparer = typeof(Enumerable).GetMethods()
        .Single(m => m.Name == nameof(Enumerable.Contains) && m.GetParameters().Length == 3);

    public static T Rewrite<T>(T expression) where T : Expression => (T)Instance.Visit(expression);

    protected override Expression VisitMethodCall(MethodCallExpression node)
    {
        if (node.Method.DeclaringType == typeof(MemoryExtensions) && node.Method.Name == nameof(MemoryExtensions.Contains)
            && node.Method.IsGenericMethod && node.Arguments.Count is 2 or 3
            && node.Arguments[0] is MethodCallExpression { Method: { Name: "op_Implicit", DeclaringType: { IsGenericType: true } span } } toSpan
            && (span.GetGenericTypeDefinition() == typeof(ReadOnlySpan<>) || span.GetGenericTypeDefinition() == typeof(Span<>))
            && toSpan.Arguments is [{ Type.IsArray: true } array])
        {
            var item = node.Method.GetGenericArguments()[0];
            var source = Visit(array);
            if (source.Type != item.MakeArrayType()) source = Expression.Convert(source, typeof(IEnumerable<>).MakeGenericType(item));
            return node.Arguments.Count == 2
                ? Expression.Call(EnumerableContains.MakeGenericMethod(item), source, Visit(node.Arguments[1]))
                : Expression.Call(EnumerableContainsWithComparer.MakeGenericMethod(item), source, Visit(node.Arguments[1]), Visit(node.Arguments[2]));
        }
        return base.VisitMethodCall(node);
    }
}
