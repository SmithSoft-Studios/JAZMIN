using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jazmin.Format;

/// <summary>
/// Value conversion between three forms:
///  - public:   what callers see (bool, long, double, string, DateTime UTC, byte[], JsonNode; decimal as exact string)
///  - internal: what is encoded (datetime as epoch milliseconds, json as JSON text, decimal as canonical text)
///  - key:      comparable form (bool, long, double, string; datetime as long ms; decimal as <see cref="DecimalKey"/>)
/// </summary>
internal static class Values
{
    private static JazminValidationException Fail(string column, string message) => new($"Column '{column}': {message}");

    /// <summary>Validates a caller-supplied value and converts it to its internal form.</summary>
    public static object? Normalize(JazminType type, object? value, string column, JsonSerializerOptions? jsonOptions = null)
    {
        if (value is null) return null;
        switch (type)
        {
            case JazminType.Bool:
                return value is bool ? value : throw Fail(column, $"expected a boolean, got {value.GetType().Name}"); // already boxed: no new allocation
            case JazminType.Int:
                return value switch
                {
                    long => value,
                    int i => (long)i,
                    short s => (long)s,
                    sbyte sb => (long)sb,
                    byte by => (long)by,
                    ushort us => (long)us,
                    uint ui => (long)ui,
                    ulong ul when ul <= long.MaxValue => (long)ul,
                    _ => throw Fail(column, $"expected an integer, got {value.GetType().Name}"),
                };
            case JazminType.Float:
                return value switch
                {
                    double => value,
                    float f => (double)f,
                    _ => throw Fail(column, $"expected a floating point number, got {value.GetType().Name}"),
                };
            case JazminType.Decimal:
            {
                var text = value switch
                {
                    decimal m => m.ToString(CultureInfo.InvariantCulture),
                    long or int => Convert.ToString(value, CultureInfo.InvariantCulture),
                    string s => s,
                    _ => throw Fail(column, $"expected a decimal, got {value.GetType().Name}"),
                };
                return Decimals.Canonical(text!, column);
            }
            case JazminType.String:
                return value as string ?? throw Fail(column, $"expected a string, got {value.GetType().Name}");
            case JazminType.DateTime:
                return ToEpochMs(value) ?? throw Fail(column, $"expected a DateTime, DateTimeOffset or ISO-8601 string, got '{value}'");
            case JazminType.Binary:
                return value switch
                {
                    byte[] bytes => bytes,
                    ReadOnlyMemory<byte> rom => rom.ToArray(),
                    _ => throw Fail(column, $"expected byte[], got {value.GetType().Name}"),
                };
            case JazminType.Json:
                return value switch
                {
                    JsonNode node => node.ToJsonString(),
                    JsonElement element => element.ValueKind == JsonValueKind.Null ? null : element.GetRawText(),
                    _ => JsonSerializer.Serialize(value, value.GetType(), jsonOptions),
                };
            default:
                throw Fail(column, $"unknown type {type}");
        }
    }

    public static long? ToEpochMs(object value) => value switch
    {
        DateTime dt => new DateTimeOffset(dt.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(dt, DateTimeKind.Utc) : dt.ToUniversalTime()).ToUnixTimeMilliseconds(),
        DateTimeOffset dto => dto.ToUnixTimeMilliseconds(),
        DateOnly d => new DateTimeOffset(d.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero).ToUnixTimeMilliseconds(),
        long ms => ms,
        int ms => ms,
        string s when DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed) => parsed.ToUnixTimeMilliseconds(),
        _ => null,
    };

    private static readonly JsonDocumentOptions UniqueNames = new() { AllowDuplicateProperties = false };

    /// <summary>Parses JSON text read from a file: damaged text is a <see cref="JazminFormatException"/>.</summary>
    /// <remarks>
    /// uniqueNames is true for the JSON the reader itself uses (metadata, directories, settings, attributes): a name repeated
    /// in an object is then a format error, not an <see cref="ArgumentException"/> when the object is first used. Values of
    /// json columns are not checked: the check reads the whole text at once, and json values would be about 1.5 times slower
    /// to read.
    /// </remarks>
    public static JsonNode? ParseJson(string text, string what, bool uniqueNames = false)
    {
        try
        {
            return uniqueNames ? JsonNode.Parse(text, documentOptions: UniqueNames) : JsonNode.Parse(text);
        }
        catch (JsonException e)
        {
            throw new JazminFormatException($"{what} is not valid JSON", e);
        }
    }

    public static DateTime FromEpochMs(long ms)
    {
        try
        {
            return DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime;
        }
        catch (ArgumentOutOfRangeException)
        {
            throw new JazminFormatException($"Date {ms} ms is outside the range .NET DateTime supports (years 1-9999)");
        }
    }

    /// <summary>Writes a non-null internal value (also accepts key form, which is identical for encodable types).</summary>
    public static void Encode(ByteWriter writer, JazminType type, object value)
    {
        switch (type)
        {
            case JazminType.Bool: writer.Byte((bool)value ? (byte)1 : (byte)0); break;
            case JazminType.Int: writer.VarInt((long)value); break;
            case JazminType.Float: writer.Float64((double)value); break;
            case JazminType.Decimal: Decimals.Write(writer, value); break; // scale + integer (spec 5.1)
            case JazminType.String:
            case JazminType.Json: writer.String((string)value); break;
            case JazminType.DateTime: writer.VarInt((long)value); break;
            case JazminType.Binary: writer.Blob((byte[])value); break;
            default: throw new JazminValidationException($"Unknown type {type}");
        }
    }

    // Shared boxes for booleans and small integers: decoding them then allocates nothing. Boxed values
    // are immutable, so sharing them is safe.
    internal static readonly object BoxedTrue = true;
    internal static readonly object BoxedFalse = false;
    private const long SmallIntMin = -128;
    private const long SmallIntMax = 1023;
    private static readonly object[] SmallInts = BuildSmallInts();

    private static object[] BuildSmallInts()
    {
        var boxes = new object[SmallIntMax - SmallIntMin + 1];
        for (var i = 0; i < boxes.Length; i++) boxes[i] = SmallIntMin + i;
        return boxes;
    }

    internal static object BoxInt(long value) => value is >= SmallIntMin and <= SmallIntMax ? SmallInts[value - SmallIntMin] : value;

    /// <summary>Reads a non-null value in public form. <paramref name="strings"/> reuses repeated short strings.</summary>
    public static object Decode(ByteReader reader, JazminType type, StringPool? strings = null) => type switch
    {
        JazminType.Bool => reader.Byte() != 0 ? BoxedTrue : BoxedFalse,
        JazminType.Int => BoxInt(reader.VarInt()),
        JazminType.Float => reader.Float64(),
        JazminType.Decimal => Decimals.ReadText(reader),
        JazminType.String => strings?.Read(reader) ?? reader.String(),
        JazminType.DateTime => FromEpochMs(reader.VarInt()),
        JazminType.Binary => reader.Blob(),
        JazminType.Json => ParseJson(reader.String(), "A json value") ?? throw new JazminFormatException("json value is null"),
        _ => throw new JazminFormatException($"Unknown type {type}"),
    };

    /// <summary>Reads a non-null value in key form (used by indexes).</summary>
    public static object DecodeKey(ByteReader reader, JazminType type) => type switch
    {
        JazminType.DateTime => reader.VarInt(),
        JazminType.Decimal => Decimals.ReadKey(reader),
        _ => ToKey(type, Decode(reader, type)),
    };

    /// <summary>Comparable form of a public or internal value.</summary>
    public static object ToKey(JazminType type, object value) => value switch
    {
        string s when type == JazminType.Decimal => Decimals.Key(s),
        DateTime dt => new DateTimeOffset(dt.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(dt, DateTimeKind.Utc) : dt.ToUniversalTime()).ToUnixTimeMilliseconds(),
        double d when d == 0 => 0.0, // fold -0 into 0
        _ => value,
    };

    public static bool IsNaN(object key) => key is double d && double.IsNaN(d);

    /// <summary>Total order for keys of one type; null when either side is NaN.</summary>
    public static int? Compare(object a, object b) => (a, b) switch
    {
        (double x, double y) => double.IsNaN(x) || double.IsNaN(y) ? null : x.CompareTo(y),
        (long x, long y) => x.CompareTo(y),
        (string x, string y) => Math.Sign(string.CompareOrdinal(x, y)),
        (bool x, bool y) => x.CompareTo(y),
        (DecimalKey x, DecimalKey y) => x.CompareTo(y),
        _ => throw new JazminValidationException($"Cannot compare {a.GetType().Name} with {b.GetType().Name}"),
    };
}

/// <summary>
/// Reuses string instances for short values that repeat (codes, statuses, categories), which cuts
/// allocations and the memory held by large result lists. Longer strings are decoded as usual.
/// Not thread-safe: one pool per reader.
/// </summary>
internal sealed class StringPool
{
    private const int MaxBytes = 16;
    private const int Slots = 1024; // power of two
    private readonly byte[]?[] _bytes = new byte[Slots][];
    private readonly string?[] _strings = new string[Slots];

    public string Read(ByteReader reader)
    {
        var span = reader.Bytes(reader.Length());
        if (span.Length > MaxBytes) return System.Text.Encoding.UTF8.GetString(span);
        var hash = 2166136261u; // FNV-1a
        foreach (var b in span) hash = (hash ^ b) * 16777619u;
        var slot = (int)(hash & (Slots - 1));
        if (_bytes[slot] is { } known && span.SequenceEqual(known)) return _strings[slot]!;
        var value = System.Text.Encoding.UTF8.GetString(span);
        _bytes[slot] = span.ToArray();
        _strings[slot] = value;
        return value;
    }
}
