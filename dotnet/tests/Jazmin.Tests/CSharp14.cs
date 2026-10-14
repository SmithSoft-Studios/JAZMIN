using System.Linq.Expressions;

namespace Jazmin.Tests;

/// <summary>
/// Expression trees as C# 14 (.NET 10's default) compiles them, for tests built with an older language version:
/// <c>array.Contains(x.Id)</c> becomes <c>MemoryExtensions.Contains(ReadOnlySpan&lt;T&gt;.op_Implicit(array), x.Id)</c>.
/// </summary>
internal static class CSharp14
{
    public enum Array
    {
        /// <summary>A captured variable: <c>ids.Contains(...)</c>.</summary>
        Captured,

        /// <summary>Written in the lambda: <c>new[] { 3, 42 }.Contains(...)</c>.</summary>
        Literal,
    }

    private sealed class Closure<T>(T value)
    {
        public T Value = value;
    }

    /// <summary><c>values.Contains(value(x))</c>, bound as C# 14 binds it.</summary>
    public static Expression<Func<TRow, bool>> Contains<TRow, T>(T[] values, Expression<Func<TRow, T>> value, Array array = Array.Captured)
    {
        Expression source = array == Array.Captured
            ? Expression.Field(Expression.Constant(new Closure<T[]>(values)), nameof(Closure<T[]>.Value))
            : Expression.NewArrayInit(typeof(T), values.Select(v => Expression.Constant(v, typeof(T))));
        var toSpan = typeof(ReadOnlySpan<T>).GetMethod("op_Implicit", [typeof(T[])])!;
        var contains = typeof(MemoryExtensions).GetMethods()
            .Single(m => m.Name == nameof(MemoryExtensions.Contains) && m.IsGenericMethodDefinition && m.GetParameters().Length == 2
                && m.GetParameters()[0].ParameterType.IsGenericType && m.GetParameters()[0].ParameterType.GetGenericTypeDefinition() == typeof(ReadOnlySpan<>))
            .MakeGenericMethod(typeof(T));
        var body = Expression.Call(contains, Expression.Call(toSpan, source), value.Body);
        return Expression.Lambda<Func<TRow, bool>>(body, value.Parameters);
    }
}
