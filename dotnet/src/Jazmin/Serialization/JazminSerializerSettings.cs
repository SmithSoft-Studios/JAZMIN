using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Jazmin.Serialization;

/// <summary>Settings for <see cref="JazminConvert"/> and <see cref="JazminSerializer"/> (counterpart of JsonSerializerSettings).</summary>
public sealed class JazminSerializerSettings
{
    public JazminKey? Key { get; set; }

    public string? Password { get; set; }

    public JazminCodec Codec { get; set; } = JazminCodec.Deflate;

    public int? CompressionLevel { get; set; }

    public int ChunkRows { get; set; } = 4096;

    public int KdfIterations { get; set; } = 600_000;

    public JsonObject? Metadata { get; set; }

    /// <summary>Extra indexes by column name (in addition to [JazminIndex] attributes).</summary>
    public Dictionary<string, JazminIndexKind[]>? Indexes { get; set; }

    /// <summary>JSON output formatting.</summary>
    public Formatting Formatting { get; set; } = Formatting.None;

    /// <summary>Whether null values are written to JSON output.</summary>
    public NullValueHandling NullValueHandling { get; set; } = NullValueHandling.Include;

    /// <summary>Options for nested values stored in json columns.</summary>
    public JsonSerializerOptions? JsonOptions { get; set; }

    /// <summary>
    /// How property names become column names, for example <see cref="JazminNamingStrategy.CamelCase"/> (counterpart of
    /// Newtonsoft's NamingStrategy). Names given with [JazminProperty] or [JsonPropertyName] are kept.
    /// </summary>
    public JazminNamingStrategy? NamingStrategy { get; set; }

    /// <summary>Converters for property types (counterpart of JsonSerializerSettings.Converters).</summary>
    public IList<JazminConverter> Converters { get; set; } = new List<JazminConverter>();

    /// <summary>Whether default values are stored, and whether missing values are filled in when reading.</summary>
    public DefaultValueHandling DefaultValueHandling { get; set; } = DefaultValueHandling.Include;

    /// <summary>Whether an object that appears more than once is stored once and referred to ($id / $ref).</summary>
    public PreserveReferencesHandling PreserveReferencesHandling { get; set; } = PreserveReferencesHandling.None;

    /// <summary>
    /// True when these settings change how types map to columns. Such maps are cached per settings instance, so reuse
    /// the instance (as with Newtonsoft's settings), and do not change it after first use.
    /// </summary>
    internal bool ShapesContract =>
        (NamingStrategy is not null && !ReferenceEquals(NamingStrategy, JazminNamingStrategy.Default)) || Converters.Count > 0
        || DefaultValueHandling != DefaultValueHandling.Include || PreserveReferencesHandling != PreserveReferencesHandling.None;

    private JsonSerializerOptions? _effectiveJsonOptions;

    /// <summary>Options for json columns: <see cref="JsonOptions"/>, preserving references when asked to.</summary>
    internal JsonSerializerOptions? EffectiveJsonOptions
    {
        get
        {
            if (PreserveReferencesHandling == PreserveReferencesHandling.None || JsonOptions?.ReferenceHandler is not null) return JsonOptions;
            return _effectiveJsonOptions ??= new JsonSerializerOptions(JsonOptions ?? JsonSerializerOptions.Default) { ReferenceHandler = ReferenceHandler.Preserve };
        }
    }

    internal JazminWriteOptions ToWriteOptions() => new()
    {
        Key = Key,
        Password = Password,
        Codec = Codec,
        CompressionLevel = CompressionLevel,
        ChunkRows = ChunkRows,
        KdfIterations = KdfIterations,
        Metadata = Metadata,
        JsonOptions = EffectiveJsonOptions,
    };

    internal JazminReadOptions ToReadOptions() => new() { Key = Key, Password = Password };

    internal IReadOnlyList<JazminColumn> ApplyIndexes(IReadOnlyList<JazminColumn> columns)
    {
        if (Indexes is null || Indexes.Count == 0) return columns;
        foreach (var name in Indexes.Keys)
            if (columns.All(c => c.Name != name)) throw new JazminValidationException($"Cannot index unknown column '{name}'");
        return columns.Select(c => Indexes.TryGetValue(c.Name, out var kinds)
            ? new JazminColumn(c.Name, c.Type)
            {
                Nullable = c.Nullable,
                Description = c.Description,
                Attributes = c.Attributes,
                Indexes = c.Indexes.Concat(kinds).Distinct().ToArray(),
            }
            : c).ToList();
    }
}
