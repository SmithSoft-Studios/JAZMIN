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

    /// <summary>A list of items of one type (<see cref="JazminColumn.Item"/>), stored as columns (spec 5.4).</summary>
    List,

    /// <summary>An object with named fields (<see cref="JazminColumn.Fields"/>), stored as columns (spec 5.4).</summary>
    Object,
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

    /// <summary>A list's items: their type, nullability and (for objects and lists) structure. Its name is not used.</summary>
    public JazminColumn? Item { get; init; }

    /// <summary>An object's fields, in order.</summary>
    public IReadOnlyList<JazminColumn>? Fields { get; init; }

    /// <summary>A list column of these items, stored as columns (spec 5.4).</summary>
    public static JazminColumn ListOf(string name, JazminColumn item) => new(name, JazminType.List) { Item = item };

    /// <summary>An object column with these fields, stored as columns (spec 5.4).</summary>
    public static JazminColumn ObjectOf(string name, params JazminColumn[] fields) => new(name, JazminType.Object) { Fields = fields };

    /// <summary>The same column with other indexes (or the same ones).</summary>
    internal JazminColumn With(IReadOnlyList<JazminIndexKind>? indexes = null) => new(Name, Type)
    {
        Nullable = Nullable,
        Description = Description,
        Attributes = Attributes,
        Indexes = indexes ?? Indexes,
        Item = Item,
        Fields = Fields,
    };

    public override string ToString() => $"{Name}: {TypeNames.Describe(this)}{(Nullable ? "?" : "")}";
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
        JazminType.List => "list",
        JazminType.Object => "object",
        _ => throw new JazminValidationException($"Unknown type {type}"),
    };

    /// <summary>A column's type with its structure: list&lt;object{name: string, ...}&gt;.</summary>
    public static string Describe(JazminColumn c) => c.Type switch
    {
        JazminType.List => $"list<{(c.Item is null ? "?" : Describe(c.Item) + (c.Item.Nullable ? "?" : ""))}>",
        JazminType.Object => $"object{{{string.Join(", ", (c.Fields ?? []).Select(f => $"{f.Name}: {Describe(f)}{(f.Nullable ? "?" : "")}"))}}}",
        _ => ToName(c.Type),
    };

    /// <summary>Lists and objects, stored as columns (spec 5.4).</summary>
    public static bool IsNested(JazminType t) => t is JazminType.List or JazminType.Object;

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
        "list" => JazminType.List,
        "object" => JazminType.Object,
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
            ValidateStructure(c, c.Name);
        }
    }

    /// <summary>A list has an item, an object at least one field (unique names); nothing else has either.</summary>
    private static void ValidateStructure(JazminColumn c, string path, int depth = 0)
    {
        if (depth > Format.FormatConstants.MaxNestingDepth)
            throw new JazminValidationException($"Column '{path}': nested more than {Format.FormatConstants.MaxNestingDepth} levels deep");
        switch (c.Type)
        {
            case JazminType.List:
                if (c.Item is null) throw new JazminValidationException($"Column '{path}': a list needs an Item");
                if (c.Fields is not null) throw new JazminValidationException($"Column '{path}': a list has an Item, not Fields");
                if (c.Item.Indexes.Count > 0) throw new JazminValidationException($"Column '{path}': items cannot be indexed");
                ValidateStructure(c.Item, path + "[]", depth + 1);
                break;
            case JazminType.Object:
                if (c.Fields is null || c.Fields.Count == 0) throw new JazminValidationException($"Column '{path}': an object needs at least one field");
                if (c.Item is not null) throw new JazminValidationException($"Column '{path}': an object has Fields, not an Item");
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var f in c.Fields)
                {
                    if (!names.Add(f.Name)) throw new JazminValidationException($"Column '{path}': duplicate field '{f.Name}'");
                    if (f.Indexes.Count > 0) throw new JazminValidationException($"Column '{path}.{f.Name}': fields cannot be indexed");
                    ValidateStructure(f, $"{path}.{f.Name}", depth + 1);
                }
                break;
            default:
                if (c.Item is not null || c.Fields is not null)
                    throw new JazminValidationException($"Column '{path}': only lists have an Item and only objects have Fields");
                break;
        }
    }
}
