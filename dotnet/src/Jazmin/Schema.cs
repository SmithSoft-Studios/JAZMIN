using System.Text.Json.Nodes;

namespace Jazmin;

/// <summary>Column data types (spec section 5).</summary>
public enum JazminType
{
    Bool,
    Int,
    Float,
    Decimal,
    String,
    DateTime,
    Binary,
    Json,
}

/// <summary>Index kinds (spec section 8).</summary>
public enum JazminIndexKind
{
    /// <summary>Distinct values in order: equality, in, range and prefix filters.</summary>
    Sorted,

    /// <summary>3-character grams of string values: contains / icontains filters.</summary>
    Trigram,
}

/// <summary>Section compression codecs. Values are the on-disk codec ids.</summary>
public enum JazminCodec : byte
{
    None = 0,
    Deflate = 1,
    Brotli = 2,
}

/// <summary>
/// What reading or writing favours where memory and speed pull apart: how many threads work at once and how far
/// a scan decodes ahead. The file written is the same whichever is chosen, and an explicit
/// MaxDegreeOfParallelism still wins.
/// </summary>
public enum JazminPriority
{
    /// <summary>The default: a few threads, within a memory budget.</summary>
    Balanced,

    /// <summary>The least memory: everything on the calling thread, nothing decoded ahead. Slower.</summary>
    Memory,

    /// <summary>The fastest: more threads, and full reads of wide tables decode ahead too. Uses more memory.</summary>
    Speed,
}

/// <summary>A column definition: name, type, nullability, documentation and indexes.</summary>
public sealed class JazminColumn
{
    public JazminColumn(string name, JazminType type)
    {
        if (string.IsNullOrEmpty(name)) throw new JazminValidationException("Every column needs a non-empty name");
        Name = name;
        Type = type;
    }

    public string Name { get; }

    public JazminType Type { get; }

    public bool Nullable { get; init; } = true;

    public string? Description { get; init; }

    /// <summary>Free-form extra details (format hints, units, max length...).</summary>
    public JsonObject? Attributes { get; init; }

    public IReadOnlyList<JazminIndexKind> Indexes { get; init; } = Array.Empty<JazminIndexKind>();

    public override string ToString() => $"{Name}: {TypeNames.ToName(Type)}{(Nullable ? "?" : "")}";
}

internal static class TypeNames
{
    public static string ToName(JazminType type) => type switch
    {
        JazminType.Bool => "bool",
        JazminType.Int => "int",
        JazminType.Float => "float",
        JazminType.Decimal => "decimal",
        JazminType.String => "string",
        JazminType.DateTime => "datetime",
        JazminType.Binary => "binary",
        JazminType.Json => "json",
        _ => throw new JazminValidationException($"Unknown type {type}"),
    };

    public static JazminType Parse(string name) => name switch
    {
        "bool" => JazminType.Bool,
        "int" => JazminType.Int,
        "float" => JazminType.Float,
        "decimal" => JazminType.Decimal,
        "string" => JazminType.String,
        "datetime" => JazminType.DateTime,
        "binary" => JazminType.Binary,
        "json" => JazminType.Json,
        _ => throw new JazminFormatException($"Unknown column type '{name}'"),
    };

    public static string IndexName(JazminIndexKind kind) => kind == JazminIndexKind.Sorted ? "sorted" : "trigram";

    public static JazminIndexKind? ParseIndex(string name) => name switch
    {
        "sorted" => JazminIndexKind.Sorted,
        "trigram" => JazminIndexKind.Trigram,
        _ => null,
    };

    /// <summary>Types with an order (range filters, sorted indexes, statistics); decimals compare by value.</summary>
    public static bool IsOrdered(JazminType t) =>
        t is JazminType.Bool or JazminType.Int or JazminType.Float or JazminType.String or JazminType.DateTime or JazminType.Decimal;

    public static bool IsEquatable(JazminType t) => IsOrdered(t);

    public static bool Supports(JazminIndexKind kind, JazminType type) =>
        kind == JazminIndexKind.Sorted ? IsOrdered(type) : type == JazminType.String;

    public static void Validate(IReadOnlyList<JazminColumn> columns)
    {
        if (columns.Count == 0) throw new JazminValidationException("At least one column is required");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in columns)
        {
            if (!seen.Add(c.Name)) throw new JazminValidationException($"Duplicate column '{c.Name}'");
            foreach (var kind in c.Indexes)
            {
                if (!Supports(kind, c.Type))
                    throw new JazminValidationException($"Column '{c.Name}': a {IndexName(kind)} index is not supported on {ToName(c.Type)}");
            }
        }
    }
}
