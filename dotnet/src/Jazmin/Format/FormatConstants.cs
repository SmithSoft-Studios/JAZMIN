namespace Jazmin.Format;

/// <summary>Fixed values from the JAZMIN specification (docs/rfc/draft-jazmin-format-03.md).</summary>
internal static class FormatConstants
{
    /// <summary>Format 1.0; later additions are reader/writer features listed in the header, not new magic.</summary>
    public static ReadOnlySpan<byte> Magic => "JZM1"u8;

    /// <summary>Pre-release drafts, refused with a clear message.</summary>
    public static ReadOnlySpan<byte> DraftMagic => "JZMN"u8;

    public const int PreambleSize = 64;
    public const int TrailerSize = 44;
    public const int EnvelopeSize = 16;
    public const int FileIdSize = 16;
    public const int SaltSize = 32;
    public const int FlagsOffset = 4;

    public const ushort FlagEncrypted = 0x0001;
    public const ushort FlagPassword = 0x0002;
    public const ushort FlagAccess = 0x0004; // access-controlled: key slots + owner signature (spec 7.6)
    public const ushort FlagAppended = 0x0008; // has been appended to: directory segments, deletes, trailer recovery
    public const ushort KnownFlags = 0x000f;

    /// <summary>Reader features this library supports (none are defined in format 1.0).</summary>
    public static readonly IReadOnlySet<string> SupportedReaderFeatures = new HashSet<string>();

    public const string DefaultColumnGroup = "*";
    public const string WholeTable = "*"; // partition of a table without partitionBy
    public const int InlinePartitions = 64; // partitions listed in the header before a partition table is used
    public const byte PostingsEncoding = 0; // first byte of index, page, postings and deleted-rows sections
    public const int SignatureSize = 64;
    public const int PublicKeySize = 65;
    public const byte SectionEncrypted = 0x01;

    public const string KeyringData = "data";
    public const string KeyringIndex = "index";
    public const string KeyringFiles = "files";
    public const string HeaderSectionId = "header";

    public const int DefaultChunkRows = 4096;
    public const int DefaultChunkBytes = 1024 * 1024;
    public const int DefaultKdfIterations = 600_000;
    public const int MinKdfIterations = 1000;
    public const int MaxKdfIterations = 10_000_000; // a file asking for more is refused: each open would take minutes
    public const int DefaultIndexPageBytes = 64 * 1024; // target raw size of a sorted-index page (spec 8.1)

    public static string ChunkSectionId(int table, int ordinal, string group) => $"{table}/chunk/{ordinal}/{group}";
    public static string IndexSectionId(int table, string column, string kind, int segment) => $"{table}/index/{column}/{kind}" + (segment > 0 ? $"/{segment}" : "");
}
