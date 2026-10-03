namespace Jazmin.Serialization;

/// <summary>Sets the column name (and optionally description) for a property. Counterpart of [JsonProperty].</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class JazminPropertyAttribute(string? name = null) : Attribute
{
    public string? Name { get; } = name;

    public string? Description { get; set; }

    /// <summary>Overrides the inferred column type.</summary>
    public JazminType Type { get; set; } = (JazminType)(-1);

    internal JazminType? TypeOverride => (int)Type >= 0 ? Type : null;
}

/// <summary>Excludes a property from serialization. Counterpart of [JsonIgnore].</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class JazminIgnoreAttribute : Attribute;

/// <summary>Builds one or more indexes on the property's column.</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class JazminIndexAttribute(params JazminIndexKind[] kinds) : Attribute
{
    public JazminIndexKind[] Kinds { get; } = kinds.Length == 0 ? new[] { JazminIndexKind.Sorted } : kinds;
}

/// <summary>Mirrors Newtonsoft's Formatting for JSON output.</summary>
public enum Formatting
{
    None,
    Indented,
}

/// <summary>Mirrors Newtonsoft's NullValueHandling for JSON output.</summary>
public enum NullValueHandling
{
    Include,
    Ignore,
}

/// <summary>
/// Mirrors Newtonsoft's DefaultValueHandling. A default value is the property's [DefaultValue], or the type's default
/// (0, false, null...).
/// </summary>
[Flags]
public enum DefaultValueHandling
{
    /// <summary>Every value is stored as it is.</summary>
    Include = 0,

    /// <summary>Default values are stored as null (smaller files; omitted from JSON output with NullValueHandling.Ignore).</summary>
    Ignore = 1,

    /// <summary>When reading, a null or missing value gets the property's default value.</summary>
    Populate = 2,

    /// <summary>Ignore when writing and Populate when reading: objects round-trip unchanged.</summary>
    IgnoreAndPopulate = Ignore | Populate,
}

/// <summary>
/// Mirrors Newtonsoft's PreserveReferencesHandling: an object that appears more than once is stored once, and later
/// appearances refer to it ($id / $ref), so reading gives back the same instance.
/// </summary>
public enum PreserveReferencesHandling
{
    None = 0,

    /// <summary>For the serialized objects (rows) and for objects inside json columns.</summary>
    Objects = 1,
}
