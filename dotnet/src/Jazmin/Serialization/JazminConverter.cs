using System.Text.Json;

namespace Jazmin.Serialization;

/// <summary>
/// Converts values of a type to and from what a column stores (counterpart of Newtonsoft's JsonConverter). Register it
/// in <see cref="JazminSerializerSettings.Converters"/>, or put <see cref="JazminConverterAttribute"/> on a property or type.
/// </summary>
/// <remarks>
/// Stored forms by column type: bool (Bool), long (Int), double (Float), decimal or its text (Decimal), string (String),
/// DateTime UTC or DateTimeOffset (DateTime), byte[] (Binary), JsonNode (Json). Reading gives the same forms back, with
/// decimals as text. Filters and LINQ predicates on a converted property are evaluated in memory, after reading.
/// </remarks>
public abstract class JazminConverter
{
    /// <summary>Whether this converter handles values of <paramref name="type"/> (never a Nullable&lt;T&gt;: T is asked).</summary>
    public abstract bool CanConvert(Type type);

    /// <summary>The column type the values are stored as.</summary>
    public abstract JazminType ColumnType { get; }

    /// <summary>The stored form of a non-null value.</summary>
    public abstract object? ToStored(object value);

    /// <summary>The value of <paramref name="type"/> for a non-null stored value.</summary>
    public abstract object? FromStored(object stored, Type type);
}

/// <summary>A converter for values of <typeparamref name="T"/>.</summary>
public abstract class JazminConverter<T> : JazminConverter
{
    public sealed override bool CanConvert(Type type) => type == typeof(T);

    public sealed override object? ToStored(object value) => Write((T)value);

    public sealed override object? FromStored(object stored, Type type) => Read(stored);

    /// <summary>The stored form of <paramref name="value"/> (see <see cref="JazminConverter"/> for the forms).</summary>
    public abstract object? Write(T value);

    /// <summary>The value for a stored form.</summary>
    public abstract T Read(object stored);
}

/// <summary>Uses a converter for a property, or for every property of a type. Counterpart of Newtonsoft's [JsonConverter].</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Class | AttributeTargets.Struct)]
public sealed class JazminConverterAttribute(Type converterType) : Attribute
{
    public Type ConverterType { get; } = converterType;

    internal JazminConverter Create() =>
        Activator.CreateInstance(ConverterType) as JazminConverter
        ?? throw new JazminValidationException($"{ConverterType.Name} is not a JazminConverter with a public parameterless constructor");
}

/// <summary>
/// How property names become column names (counterpart of Newtonsoft's NamingStrategy). Names given with
/// [JazminProperty] or [JsonPropertyName] are kept as written.
/// </summary>
public abstract class JazminNamingStrategy
{
    /// <summary>Property names as they are.</summary>
    public static JazminNamingStrategy Default { get; } = new PolicyStrategy(null);

    /// <summary>camelCase: <c>FirstName</c> becomes <c>firstName</c>, <c>URLValue</c> becomes <c>urlValue</c>.</summary>
    public static JazminNamingStrategy CamelCase { get; } = new PolicyStrategy(JsonNamingPolicy.CamelCase);

    /// <summary>snake_case: <c>FirstName</c> becomes <c>first_name</c>.</summary>
    public static JazminNamingStrategy SnakeCase { get; } = new PolicyStrategy(JsonNamingPolicy.SnakeCaseLower);

    /// <summary>kebab-case: <c>FirstName</c> becomes <c>first-name</c>.</summary>
    public static JazminNamingStrategy KebabCase { get; } = new PolicyStrategy(JsonNamingPolicy.KebabCaseLower);

    /// <summary>The column name for a property name.</summary>
    public abstract string GetColumnName(string propertyName);

    private sealed class PolicyStrategy(JsonNamingPolicy? policy) : JazminNamingStrategy
    {
        public override string GetColumnName(string propertyName) => policy?.ConvertName(propertyName) ?? propertyName;
    }
}
