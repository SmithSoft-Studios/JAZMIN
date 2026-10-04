using System.Buffers.Binary;
using System.Globalization;
using System.Linq.Expressions;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Jazmin.Format;
using Jazmin.Query;
using Jazmin.Serialization;

namespace Jazmin;

public sealed class JazminReadOptions
{
    /// <summary>Master key (also the owner key of an access-controlled file).</summary>
    public JazminKey? Key { get; set; }

    /// <summary>Access key for an access-controlled file: opens only the granted partitions and column groups.</summary>
    public JazminAccessKey? AccessKey { get; set; }

    public string? Password { get; set; }

    /// <summary>Online access keys: the "jzu1-..." token from the file owner's key service.</summary>
    public string? UnlockToken { get; set; }

    /// <summary>Clock for expiry checks (default: the system clock).</summary>
    public DateTimeOffset? Now { get; set; }

    /// <summary>Expiring keys: where last-seen records are kept (default: <see cref="JazminDirectoryAccessStateStore.DefaultDirectory"/>).</summary>
    public IJazminAccessStateStore? AccessState { get; set; }

    /// <summary>Expiring keys: detect a clock set back since the last access (default true).</summary>
    public bool CheckClockRollback { get; set; } = true;

    /// <summary>
    /// Chunks decoded ahead on worker threads during scans (default: up to 4). The file is still read in order on
    /// the calling thread; 1 decodes everything on the calling thread. To bound memory, read-ahead is also limited to
    /// about 128 decoded columns in flight, so full reads of very wide files stay sequential.
    /// </summary>
    public int MaxDegreeOfParallelism { get; set; } = Math.Min(Environment.ProcessorCount, 4);

    /// <summary>The table to read, by name (default: the first). See <see cref="JazminReader.Tables"/>.</summary>
    public string? Table { get; set; }
}

public sealed class JazminQueryOptions
{
    /// <summary>Columns to return (default: all visible).</summary>
    public IReadOnlyList<string>? Select { get; set; }

    public long Offset { get; set; }

    public long? Limit { get; set; }
}

/// <summary>How a filter executes: via indexes (candidate rows) or a chunk scan (chunks skipped by statistics).</summary>
public sealed record JazminPlan(string Strategy, long CandidateRows, int Chunks, int ChunksSkipped)
{
    /// <summary>What the query read, from <see cref="JazminReader.Explain(JazminFilter?, bool, JazminQueryOptions?)"/> with analyze; else null.</summary>
    public JazminQueryCost? Cost { get; init; }
}

/// <summary>
/// What a query read: the rows it returned, the bytes of the sections it read (chunks, index pages, statistics and
/// directories), the chunks it read and decoded, the index sections it read, the column streams it decoded (one per
/// column per chunk) and the time it took.
/// </summary>
public sealed record JazminQueryCost(long Rows, long BytesRead, int ChunksRead, int IndexPagesRead, long ColumnsDecoded, TimeSpan Elapsed);

/// <summary>
/// Random-access reader. Opening reads the trailer and header (and, for access-controlled files, the key slots,
/// signature and the key's own chunk directories); chunks, statistics and indexes are read on demand, one decoded
/// chunk cached at a time. Not thread-safe.
/// With an access key only the granted partitions and column groups are visible: hidden rows are not returned, and
/// hidden columns are not part of <see cref="Columns"/> - their names are not readable with that key.
/// </summary>
public sealed class JazminReader : IDisposable, IIndexProvider
{
    /// <summary>Secrets from this reader's key slot (access-controlled files).</summary>
    private sealed class AccessState
    {
        public required bool IsOwner { get; init; }

        /// <summary>Owner only: every secret is derived from the owner secret.</summary>
        public required FileSecrets? Secrets { get; init; }

        public required Dictionary<string, byte[]> Partitions { get; init; }
        public required Dictionary<string, string> PartitionNames { get; init; }
        public required Dictionary<string, byte[]> ColumnSecrets { get; init; }
        public required byte[] HeaderSecret { get; init; }
        public required byte[] KeySecret { get; init; }
        public required (long Offset, int Length, byte[] Section) KeySlots { get; init; }
        public DateTimeOffset? Expires { get; init; }
        public bool Online { get; init; }
        public JsonObject? Directory { get; set; }
        public string? DirectoryText { get; set; }

        /// <summary>File-group id -> secret, for the embedded-file groups this key sees (spec 6.8).</summary>
        public Dictionary<string, byte[]> FileSecrets { get; init; } = new(StringComparer.Ordinal);
    }

    /// <summary>A column group: its columns (by position) and whether this key can open it.</summary>
    private sealed record GroupInfo(string Name, int[] Cols, bool Visible);

    /// <summary>A partition: its directory segments, how many are loaded, and its loaded chunks.</summary>
    private sealed class PartitionInfo(string id)
    {
        public string Id { get; } = id;
        public List<SectionRef> Segments { get; } = new();
        public int Loaded { get; set; }
        public bool Visible { get; set; }
        public List<int> Ordinals { get; } = new();
    }

    /// <summary>One loaded directory segment: its chunks and its statistics blocks (loaded per column on demand).</summary>
    private sealed class SegmentInfo
    {
        public required string Partition { get; init; }
        public required string Suffix { get; init; }
        public required List<StatsBlock> Statistics { get; init; }
        public List<int> Ordinals { get; } = new();
        public HashSet<int> StatsLoaded { get; } = new();
    }

    /// <summary>One column's statistics by chunk ordinal, once a query needs them (spec 6.4).</summary>
    private sealed class ColumnStatsByChunk(int chunks)
    {
        public long[] Nulls { get; } = new long[chunks];
        public object?[] Min { get; } = new object?[chunks];
        public object?[] Max { get; } = new object?[chunks];
        public bool[] Has { get; } = new bool[chunks];
        public ColumnStats View { get; } = new(); // reused: read before asking for another chunk of this column
    }

    /// <summary>What <see cref="JazminFile.Append"/> needs to continue this file.</summary>
    internal sealed record AppendStateInfo(
        HeaderDef Header, TableDef Table, byte[] FileId, byte[] Salt, ushort Flags, KeySchedule? Keys, FileSecrets? OwnerSecrets,
        JsonObject? Directory, string? DirectoryText, SectionRef? DirectoryRef, (long Offset, int Length, byte[] Section)? KeySlots,
        List<IndexRef> Indexes, Dictionary<string, int> SegmentCounts, long[] Deleted, long ValidEnd, object?[]? LastRow, FileState? Files = null,
        int TableIndex = 0, List<(int Table, List<IndexRef> Indexes)>? OwnerCatalog = null);

    /// <summary>The open stream, shared by the readers of a file's tables (<see cref="OpenTable"/>): reads take turns, the last reader closes it.</summary>
    private sealed class SharedStream
    {
        public int Readers = 1;
    }

    private readonly Stream _stream;
    private readonly bool _leaveOpen;
    private readonly StringPool _strings = new();
    private readonly int _readAhead;
    private readonly SharedStream _io;
    private readonly HeaderDef _header;
    private readonly TableDef _table;
    private readonly int _tableIndex; // the table read: its number in the file
    private readonly JsonObject _metadata;
    private readonly byte[] _fileId;
    private readonly byte[] _salt;
    private readonly KeySchedule? _keys;
    private readonly AccessState? _access;
    private readonly JazminColumn[] _allColumns; // by position; hidden columns are unnamed placeholders
    private readonly JazminType[] _types;
    private readonly GroupInfo[] _groups;
    private readonly int[] _groupOf; // position -> column group index (-1: hidden)
    private readonly int[] _visibleCols;
    private readonly IReadOnlyList<JazminColumn> _visibleColumns;
    private readonly Dictionary<string, PartitionInfo> _partitions = new(StringComparer.Ordinal); // looked up so far
    private readonly Dictionary<string, List<SectionRef>> _deltaSegments = new(StringComparer.Ordinal); // added by appends
    private byte[]? _partitionTable; // the partition table's bytes until every partition is listed
    private bool _allListed;
    private int _tableLookups; // partition-table scans so far: repeated lookups decode it once instead
    private readonly List<SegmentInfo> _segments = new();
    // Chunks by ordinal, in arrays (no object per chunk): filled as their partitions' directories load.
    private readonly long[] _rowStart;
    private readonly int[] _rowCount;
    private readonly bool[] _loaded;
    private readonly string?[] _chunkPartition;
    private readonly long[] _partOffset; // ordinal * groups + group
    private readonly int[] _partLength;
    private byte[]? _partDigests; // access-controlled files: 32 bytes per part
    private readonly ColumnStatsByChunk?[] _colStats;
    private readonly HashSet<int> _statCols = new(); // loaded for every loaded segment
    private int _statOrdinal;
    private readonly Func<int, ColumnStats?> _statLookup;
    private readonly Dictionary<string, object?> _indexes = new(StringComparer.Ordinal);
    private int[] _visibleChunks = [];
    private bool _allLoaded;
    private List<IndexRef>? _indexRefs;
    private bool? _sortStatsComplete;
    private ushort _flags;
    private long[] _deleted = Array.Empty<long>(); // sorted row ids removed by appends
    private long? _deletedVisible;
    private long _validEnd;
    private int _cachedOrdinal = -1;
    private object?[][]? _cachedRows;
    private CostCounter? _cost; // while Explain(analyze: true) runs a query: what it reads

    /// <summary>Counts what a query reads (see <see cref="JazminQueryCost"/>). Updated on the thread that iterates.</summary>
    private sealed class CostCounter
    {
        public long BytesRead;
        public int ChunksRead;
        public int IndexPagesRead;
        public long ColumnsDecoded;
    }

    /// <summary>Opens the file, or (<paramref name="from"/>, set by <see cref="OpenTable"/>) shares that reader's open file, keys and checks.</summary>
    private JazminReader(Stream stream, JazminReadOptions? options, bool leaveOpen, JazminReader? from = null)
    {
        if (!stream.CanSeek || !stream.CanRead) throw new JazminValidationException("The stream must be readable and seekable");
        _stream = stream;
        _leaveOpen = leaveOpen;
        options ??= new JazminReadOptions();
        _readAhead = Math.Max(1, options.MaxDegreeOfParallelism);
        if (from is null)
        {
            _io = new SharedStream();
        }
        else
        {
            _io = from._io;
            lock (_io) _io.Readers++;
        }
        try
        {
            if (from is null)
            {
                (_header, _fileId, _salt, _keys, _access) = Open(options);
                foreach (var feature in _header.ReaderFeatures)
                {
                    if (!FormatConstants.SupportedReaderFeatures.Contains(feature))
                        throw new JazminFormatException($"This file needs the '{feature}' feature, which this JAZMIN reader does not support");
                }
                _metadata = _header.Metadata.Length == 0 ? new JsonObject() : Values.ParseJson(_header.Metadata, "Metadata") as JsonObject ?? throw new JazminFormatException("Metadata is not a JSON object");
                if (_keys is not null) _keys.Keyring = _header.Keyring ?? new Dictionary<string, byte[]>();
            }
            else
            {
                (_header, _fileId, _salt, _keys, _access, _metadata) = (from._header, from._fileId, from._salt, from._keys, from._access, from._metadata);
                (_flags, _validEnd, Recovered, KdfIterations) = (from._flags, from._validEnd, from.Recovered, from.KdfIterations);
            }
            // One table at a time (spec 6.2): the caller chooses it by name; the first by default.
            _tableIndex = options.Table is null ? 0 : _header.Tables.FindIndex(t => t.Name == options.Table);
            if (_tableIndex < 0)
                throw new JazminValidationException($"This file has no table '{options.Table}' (tables: {string.Join(", ", _header.Tables.Select(t => $"'{t.Name}'"))})");
            _table = _header.Tables.Count > 0 ? _header.Tables[_tableIndex] : throw new JazminFormatException("Catalog: the file lists no tables");
            (_allColumns, _groups, _groupOf) = OpenColumns();
            var n = _table.ChunkCount;
            // Each chunk is stored as sections of at least an envelope: a damaged count cannot size these arrays.
            if (n < 0 || (long)n * FormatConstants.EnvelopeSize > _stream.Length) throw new JazminFormatException("Catalog: the chunk count is larger than the file can hold");
            _rowStart = new long[n];
            _rowCount = new int[n];
            _loaded = new bool[n];
            _chunkPartition = new string?[n];
            _partOffset = new long[n * _groups.Length];
            _partLength = new int[n * _groups.Length];
            _colStats = new ColumnStatsByChunk?[_allColumns.Length];
            _statLookup = col => StatAt(col, _statOrdinal);
            _types = _allColumns.Select(c => c.Type).ToArray();
            _visibleCols = Enumerable.Range(0, _allColumns.Length).Where(i => _groupOf[i] >= 0).ToArray();
            _visibleColumns = _visibleCols.Select(i => _allColumns[i]).ToList();
            OpenPartitions();
            if (_table.Deletes is { } deletes)
            {
                var sectionId = $"{_tableIndex}/deletes/{_table.DeletedCount}";
                _deleted = RowSet.DecodeSection(ReadSection(deletes, sectionId, CatalogKey(sectionId, _access?.HeaderSecret)), "Deleted rows");
            }
            if (from is null && _access is { Expires: { } expires })
            {
                var store = options.CheckClockRollback
                    ? options.AccessState ?? new JazminDirectoryAccessStateStore(JazminDirectoryAccessStateStore.DefaultDirectory)
                    : null;
                ExpiryCheck.Enforce(expires, DateTimeOffset.FromUnixTimeMilliseconds(_header.Modified != 0 ? _header.Modified : _header.Created),
                    options.Now ?? DateTimeOffset.UtcNow, _fileId, Convert.ToHexString(OwnerSigning.SlotId(_access.KeySecret)).ToLowerInvariant(),
                    _access.KeySecret, store);
            }
        }
        catch
        {
            Release();
            throw;
        }
    }

    /// <summary>Names of the file's tables, in order (spec 6.2).</summary>
    public IReadOnlyList<string> Tables => _header.Tables.Select(t => t.Name).ToList();

    /// <summary>Name of the table this reader reads.</summary>
    public string TableName => _table.Name;

    /// <summary>
    /// Another table of this file, read without opening the file again: the new reader shares this one's open file, keys
    /// and checks (signature, key slot, expiry), so it opens in a fraction of the time. Dispose it too; the file is closed
    /// with the last of them.
    /// </summary>
    public JazminReader OpenTable(string name)
    {
        lock (_io)
            if (_io.Readers == 0) throw new ObjectDisposedException(nameof(JazminReader));
        return new JazminReader(_stream, new JazminReadOptions { Table = name, MaxDegreeOfParallelism = _readAhead }, _leaveOpen, this);
    }

    /// <summary>Lets go of the shared stream: the last reader closes it (unless leaveOpen).</summary>
    private void Release()
    {
        lock (_io)
        {
            if (_io.Readers == 0) return;
            if (--_io.Readers == 0 && !_leaveOpen) _stream.Dispose();
        }
    }

    /// <remarks>
    /// The file is opened so that appends (which only add bytes after the version this reader uses)
    /// and updates (which replace the file by renaming) can proceed while it is open.
    /// </remarks>
    public static JazminReader Open(string path, JazminReadOptions? options = null) =>
        new(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.RandomAccess), options, false);

    public static JazminReader Open(byte[] data, JazminReadOptions? options = null) =>
        new(new MemoryStream(data, writable: false), options, false);

    public static JazminReader Open(Stream stream, JazminReadOptions? options = null, bool leaveOpen = false) =>
        new(stream, options, leaveOpen);

    /// <summary>Open for async code: the file is opened and its header read on a thread-pool thread.</summary>
    public static Task<JazminReader> OpenAsync(string path, JazminReadOptions? options = null, CancellationToken cancellationToken = default) =>
        Task.Run(() => Open(path, options), cancellationToken);

    /// <summary>Open for async code: the header is read on a thread-pool thread.</summary>
    public static Task<JazminReader> OpenAsync(Stream stream, JazminReadOptions? options = null, bool leaveOpen = false, CancellationToken cancellationToken = default) =>
        Task.Run(() => Open(stream, options, leaveOpen), cancellationToken);

    /// <summary>Columns visible to this reader (all columns unless an access key limits them).</summary>
    public IReadOnlyList<JazminColumn> Columns => _visibleColumns;

    // ---- opening (spec 4, 6, 7.6.6) --------------------------------------------------------------

    private byte[] Read(long position, int length)
    {
        if (position < 0 || length < 0 || position + length > _stream.Length) throw new JazminFormatException("Unexpected end of file");
        var buffer = new byte[length];
        lock (_io)
        {
            _stream.Position = position;
            _stream.ReadExactly(buffer);
        }
        return buffer;
    }

    private sealed record Trailer(SectionRef Header, SectionRef KeySlots, SectionRef Signature);

    private (HeaderDef, byte[], byte[], KeySchedule?, AccessState?) Open(JazminReadOptions options)
    {
        var size = _stream.Length;
        if (size < FormatConstants.PreambleSize + FormatConstants.TrailerSize) throw new JazminFormatException("File is too small to be JAZMIN");
        var preamble = Read(0, FormatConstants.PreambleSize);
        if (preamble.AsSpan(0, 4).SequenceEqual(FormatConstants.DraftMagic))
            throw new JazminFormatException("This file uses a pre-release JAZMIN draft format. Write it again from its source data.");
        if (!preamble.AsSpan(0, 4).SequenceEqual(FormatConstants.Magic)) throw new JazminFormatException("Not a JAZMIN file (bad magic)");
        var flags = BinaryPrimitives.ReadUInt16LittleEndian(preamble.AsSpan(FormatConstants.FlagsOffset));
        if ((flags & ~FormatConstants.KnownFlags) != 0) throw new JazminFormatException($"Unsupported file features (flags 0x{flags:x})");
        _flags = flags;
        var fileId = preamble[8..24];
        var salt = preamble[24..56];
        var iterations = BinaryPrimitives.ReadUInt32LittleEndian(preamble.AsSpan(56));
        KdfIterations = iterations == 0 ? null : (int)Math.Min(iterations, int.MaxValue);

        var trailer = LocateTrailer(size, flags);
        var headerSection = Read(trailer.Header.Offset, trailer.Header.Length);

        if ((flags & FormatConstants.FlagAccess) != 0)
        {
            var (access, headerKey) = OpenAccess(options, fileId, salt, headerSection, trailer);
            return (Catalog.DecodeHeader(SectionCodec.Decode(headerSection, headerKey, fileId, FormatConstants.HeaderSectionId)), fileId, salt, null, access);
        }

        if (options.AccessKey is not null) throw new JazminKeyException("This file is not access-controlled - use its master key");
        KeySchedule? keys = null;
        if ((flags & FormatConstants.FlagEncrypted) != 0)
        {
            if (options.Key is null && options.Password is null) throw new JazminKeyException("This file is encrypted - supply a key or password");
            if (options.Password is not null && (flags & FormatConstants.FlagPassword) == 0)
                throw new JazminKeyException("This file was encrypted with a key, not a password");
            if (options.Password is not null && iterations is < FormatConstants.MinKdfIterations or > FormatConstants.MaxKdfIterations)
                throw new JazminFormatException($"The file asks for {iterations} password iterations; readers accept {FormatConstants.MinKdfIterations} to {FormatConstants.MaxKdfIterations}");
            var master = options.Password is not null ? Crypto.DeriveFromPassword(options.Password, salt, (int)iterations) : options.Key!.ToBytes();
            keys = new KeySchedule(master, salt);
        }
        else if (options.Key is not null || options.Password is not null)
        {
            throw new JazminKeyException("A key was supplied but the file is not encrypted");
        }
        return (Catalog.DecodeHeader(SectionCodec.Decode(headerSection, keys?.HeaderKey, fileId, FormatConstants.HeaderSectionId)), fileId, salt, keys, null);
    }

    /// <summary>Verifies the owner signature, unseals this key's slot (found by binary search) and returns the header key.</summary>
    private (AccessState, byte[] HeaderKey) OpenAccess(JazminReadOptions options, byte[] fileId, byte[] salt, byte[] headerSection, Trailer trailer)
    {
        if (options.Password is not null || (options.Key is null && options.AccessKey is null))
            throw new JazminKeyException("This file is access-controlled - supply an owner key or access key");
        if (trailer.KeySlots.Length == 0 || trailer.Signature.Length == 0) throw new JazminFormatException("Key-slot or signature section is missing");
        var slotsSection = Read(trailer.KeySlots.Offset, trailer.KeySlots.Length);
        var signature = SectionCodec.Decode(PlainSection(Read(trailer.Signature.Offset, trailer.Signature.Length), "signature"), null, fileId, "signature");
        AccessCrypto.VerifyOwner(signature, fileId, slotsSection, headerSection, options.AccessKey is null ? options.Key : null, options.AccessKey);
        var secret = options.AccessKey is not null ? options.AccessKey.Secret : options.Key!.Bytes;
        // The signed page list gives each page's digest: read and check only the page that can hold this key's slot.
        var list = SectionCodec.DecodeSegment(PlainSection(slotsSection, "keyslots"), null, fileId, "keyslots");
        var (index, offset, length, digest) = AccessCrypto.FindKeySlotPage(list, OwnerSigning.SlotId(secret))
            ?? throw new JazminKeyException("This key has not been granted access to this file");
        var pageSection = Read(offset, length);
        if (!AccessCrypto.Digest(pageSection).AsSpan().SequenceEqual(digest))
            throw new JazminFormatException("Key-slot page does not match the owner's signature");
        var keySlots = AccessCrypto.ParseKeySlots(SectionCodec.DecodeSegment(PlainSection(pageSection, $"keyslots/{index}"), null, fileId, $"keyslots/{index}"));
        var share = options.UnlockToken is null ? null : UnlockTokens.Parse(options.UnlockToken);
        var bundle = AccessCrypto.UnsealSlot(keySlots, secret, salt, fileId, share)
            ?? throw new JazminKeyException("This key has not been granted access to this file");

        static Dictionary<string, byte[]> Secrets(JsonNode? node) =>
            (node?.AsObject() ?? new JsonObject()).ToDictionary(p => p.Key, p => Convert.FromBase64String((string)p.Value!), StringComparer.Ordinal);

        var headerSecret = Convert.FromBase64String((string)bundle["header"]!);
        var isOwner = bundle["owner"] is not null;
        var state = new AccessState
        {
            IsOwner = isOwner,
            Secrets = isOwner ? new FileSecrets(salt, headerSecret, Convert.FromBase64String((string)bundle["owner"]!)) : null,
            Partitions = Secrets(bundle["partitions"]),
            PartitionNames = (bundle["partitionNames"]?.AsObject() ?? new JsonObject()).ToDictionary(p => p.Key, p => (string)p.Value!, StringComparer.Ordinal),
            ColumnSecrets = Secrets(bundle["columns"]),
            HeaderSecret = headerSecret,
            KeySecret = secret.ToArray(),
            KeySlots = (trailer.KeySlots.Offset, trailer.KeySlots.Length, slotsSection),
            Expires = bundle["expires"] is { } expires ? DateTimeOffset.Parse((string)expires!, CultureInfo.InvariantCulture) : null,
            Online = (bool?)bundle["online"] ?? false,
            FileSecrets = Secrets(bundle["files"]),
        };
        return (state, AccessCrypto.HeaderKey(headerSecret, salt));
    }

    /// <summary>
    /// Finds the trailer of the latest complete version: normally the last 44 bytes. In an appended file, an append
    /// interrupted before its trailer was written leaves extra bytes at the end; the previous version is then found by
    /// scanning back for a valid trailer whose last section ends exactly where the trailer begins (spec 4.2).
    /// </summary>
    private Trailer LocateTrailer(long size, ushort flags)
    {
        static Trailer Parse(byte[] t) => new(
            new SectionRef((long)BinaryPrimitives.ReadUInt64LittleEndian(t), (int)BinaryPrimitives.ReadUInt32LittleEndian(t.AsSpan(8))),
            new SectionRef((long)BinaryPrimitives.ReadUInt64LittleEndian(t.AsSpan(12)), (int)BinaryPrimitives.ReadUInt32LittleEndian(t.AsSpan(20))),
            new SectionRef((long)BinaryPrimitives.ReadUInt64LittleEndian(t.AsSpan(24)), (int)BinaryPrimitives.ReadUInt32LittleEndian(t.AsSpan(32))));
        static bool Valid(byte[] t, long at)
        {
            if (!t.AsSpan(40, 4).SequenceEqual(FormatConstants.Magic) || Crc32.Compute(t.AsSpan(0, 36)) != BinaryPrimitives.ReadUInt32LittleEndian(t.AsSpan(36))) return false;
            var p = Parse(t);
            bool Inside(SectionRef r) => r.Offset >= FormatConstants.PreambleSize && r.Length >= 0 && r.Offset + r.Length <= at;
            if (!Inside(p.Header) || (p.KeySlots.Length > 0 && !Inside(p.KeySlots)) || (p.Signature.Length > 0 && !Inside(p.Signature))) return false;
            return Math.Max(p.Header.Offset + p.Header.Length, p.Signature.Length > 0 ? p.Signature.Offset + p.Signature.Length : 0) == at;
        }

        var last = Read(size - FormatConstants.TrailerSize, FormatConstants.TrailerSize);
        if (Valid(last, size - FormatConstants.TrailerSize) || (flags & FormatConstants.FlagAppended) == 0)
        {
            if (!last.AsSpan(40, 4).SequenceEqual(FormatConstants.Magic)) throw new JazminFormatException("Missing trailer - file is truncated or incomplete");
            if (Crc32.Compute(last.AsSpan(0, 36)) != BinaryPrimitives.ReadUInt32LittleEndian(last.AsSpan(36)))
                throw new JazminFormatException("Trailer failed its CRC-32 check");
            if (!Valid(last, size - FormatConstants.TrailerSize)) throw new JazminFormatException("Trailer points outside the file");
            _validEnd = size;
            return Parse(last);
        }

        const int block = 1 << 20;
        for (var end = size; end > FormatConstants.PreambleSize + FormatConstants.TrailerSize; end -= block - FormatConstants.TrailerSize)
        {
            var start = Math.Max(FormatConstants.PreambleSize, end - block);
            var bytes = Read(start, (int)(end - start));
            for (var i = bytes.AsSpan().LastIndexOf(FormatConstants.Magic); i >= 0; i = i > 0 ? bytes.AsSpan(0, i).LastIndexOf(FormatConstants.Magic) : -1)
            {
                var at = start + i - 40; // trailer start
                if (at < FormatConstants.PreambleSize || at + FormatConstants.TrailerSize > size) continue;
                var candidate = Read(at, FormatConstants.TrailerSize);
                if (!Valid(candidate, at)) continue;
                _validEnd = at + FormatConstants.TrailerSize;
                Recovered = true;
                return Parse(candidate);
            }
            if (start == FormatConstants.PreambleSize) break;
        }
        throw new JazminFormatException("Missing trailer - file is truncated or incomplete");
    }

    private byte[]? PartitionSecret(string id) =>
        _access!.IsOwner ? _access.Secrets!.PartitionSecret(id) : _access.Partitions.GetValueOrDefault(id);

    private byte[]? ColumnSecret(string name) =>
        _access!.IsOwner ? _access.Secrets!.ColumnSecret(name) : _access.ColumnSecrets.GetValueOrDefault(name);

    /// <summary>Key of a catalog section: keyring <paramref name="group"/> (key/password files) or derived from <paramref name="secret"/>.</summary>
    private byte[]? CatalogKey(string sectionId, byte[]? secret, string group = FormatConstants.KeyringData) =>
        _access is not null ? AccessCrypto.SectionKey(secret!, _salt, sectionId) : _keys?.SectionKey(group, sectionId);

    private static string IdText(byte[] id) => id.Length > 0 ? Base64Url.Encode(id) : FormatConstants.WholeTable;

    /// <summary>Column groups and definitions; restricted groups only when this key may open them (spec 7.6.5).</summary>
    private (JazminColumn[], GroupInfo[], int[]) OpenColumns()
    {
        var count = _table.ColumnCount;
        // Every column is in exactly one group; a damaged count fails here instead of sizing the arrays below.
        var counted = _table.ColumnGroups.Sum(g => g.Definitions is null ? (long)g.Columns.Count : g.ColumnCount);
        if (counted != count || count < 0 || count > _stream.Length) throw new JazminFormatException("Catalog: the column count does not match the column groups");
        var columns = new JazminColumn?[count];
        var groupOf = Enumerable.Repeat(-1, count).ToArray();
        var groups = new GroupInfo[_table.ColumnGroups.Count];
        for (var gi = 0; gi < groups.Length; gi++)
        {
            var g = _table.ColumnGroups[gi];
            var defs = g.Columns;
            var visible = true;
            if (g.Definitions is not null)
            {
                var secret = _access is null ? null : ColumnSecret(g.Name);
                visible = secret is not null;
                if (secret is not null)
                {
                    var sectionId = $"{_tableIndex}/columns/{g.Name}";
                    defs = Catalog.DecodeColumnDefinitions(ReadSection(g.Definitions, sectionId, AccessCrypto.SectionKey(secret, _salt, sectionId)));
                }
            }
            else if (_access is { IsOwner: false })
            {
                visible = _access.ColumnSecrets.ContainsKey(g.Name);
            }
            foreach (var c in visible ? defs : new List<ColumnDef>())
            {
                if (c.Position < 0 || c.Position >= count || columns[c.Position] is not null) throw new JazminFormatException("Column positions are inconsistent");
                columns[c.Position] = new JazminColumn(c.Name, c.Type)
                {
                    Nullable = !c.Required,
                    Description = c.Description,
                    Attributes = c.Attributes is null ? null : Values.ParseJson(c.Attributes, "Column attributes") as JsonObject,
                };
                groupOf[c.Position] = gi;
            }
            groups[gi] = new GroupInfo(g.Name, visible ? defs.Select(c => c.Position).Order().ToArray() : [], visible);
        }
        // Hidden columns keep their position with a placeholder no filter or selection can name.
        var all = columns.Select((c, i) => c ?? new JazminColumn($"\0{i}", JazminType.Binary)).ToArray();
        return (all, groups, groupOf);
    }

    /// <summary>
    /// Partitions (spec 6.3) are listed as they are needed: a key holder looks up only its own in the partition table,
    /// and the owner lists them all only for queries that do not pin the partition column. Appends' deltas are small
    /// and read now.
    /// </summary>
    private void OpenPartitions()
    {
        if (_table.PartitionTable is { } partitionTable)
        {
            var sectionId = $"{_tableIndex}/partitions";
            _partitionTable = ReadSection(partitionTable, sectionId, CatalogKey(sectionId, _access?.HeaderSecret));
        }
        for (var i = 0; i < _header.Deltas.Count; i++)
        {
            var sectionId = $"delta/{i}";
            foreach (var (table, partitions) in Catalog.DecodeDelta(ReadSection(_header.Deltas[i], sectionId, CatalogKey(sectionId, _access?.HeaderSecret))))
            {
                if (table != _tableIndex) continue;
                foreach (var p in partitions)
                {
                    var id = IdText(p.Id);
                    if (!_deltaSegments.TryGetValue(id, out var list)) _deltaSegments[id] = list = new List<SectionRef>();
                    list.AddRange(p.Segments);
                }
            }
        }
        if (_access is not { IsOwner: true }) EnsureAllChunks(); // one partition, or only this key's own
    }

    private PartitionInfo NewPartition(string id, IEnumerable<SectionRef> segments)
    {
        var p = new PartitionInfo(id)
        {
            Visible = _access is null or { IsOwner: true } || (_access.Partitions.ContainsKey(id) && _groups.Any(g => g.Visible)),
        };
        p.Segments.AddRange(segments);
        if (_deltaSegments.TryGetValue(id, out var added)) p.Segments.AddRange(added);
        return p;
    }

    /// <summary>Lists these partitions (id texts), looking them up in the partition table without decoding the others.</summary>
    private void LookupPartitions(IReadOnlyCollection<string> ids)
    {
        var missing = _allListed ? [] : ids.Where(id => !_partitions.ContainsKey(id)).Distinct().ToList();
        if (missing.Count == 0) return;
        // One lookup (open, read a section) scans the table; a reader that keeps looking up partitions decodes it once.
        if (_partitionTable is not null && ++_tableLookups > 2)
        {
            ListAllPartitions();
            return;
        }
        var listed = _partitionTable is not null
            ? Catalog.FindPartitions(_partitionTable, missing.Where(id => id != FormatConstants.WholeTable).Select(Base64Url.Decode).ToList())
            : _table.Partitions;
        var found = listed.ToDictionary(p => IdText(p.Id), p => p.Segments, StringComparer.Ordinal);
        foreach (var id in missing)
            if (found.ContainsKey(id) || _deltaSegments.ContainsKey(id)) _partitions[id] = NewPartition(id, found.GetValueOrDefault(id) ?? []);
    }

    /// <summary>Lists every partition (owner queries that do not pin the partition column).</summary>
    private void ListAllPartitions()
    {
        if (_allListed) return;
        foreach (var p in _partitionTable is not null ? Catalog.DecodePartitionTable(_partitionTable) : _table.Partitions)
        {
            var id = IdText(p.Id);
            if (!_partitions.ContainsKey(id)) _partitions[id] = NewPartition(id, p.Segments);
        }
        foreach (var id in _deltaSegments.Keys)
            if (!_partitions.ContainsKey(id)) _partitions[id] = NewPartition(id, []);
        _allListed = true;
        _partitionTable = null; // decoded: no longer needed
    }

    /// <summary>Loads the chunk directories of these partitions (id texts).</summary>
    private void EnsurePartitions(IReadOnlyCollection<string> ids)
    {
        LookupPartitions(ids);
        var g = _groups.Length;
        var added = new List<SegmentInfo>();
        foreach (var id in ids)
        {
            if (!_partitions.TryGetValue(id, out var p) || !p.Visible || p.Loaded == p.Segments.Count) continue;
            var secret = _access is null ? null : PartitionSecret(id);
            for (var s = p.Loaded; s < p.Segments.Count; s++)
            {
                var suffix = s > 0 ? $"/{s}" : ""; // segment s > 0 was written by an append
                var sectionId = $"{_tableIndex}/dir/{id}{suffix}";
                var d = Catalog.DecodeChunkDirectoryLists(ReadSection(p.Segments[s], sectionId, CatalogKey(sectionId, secret)), g);
                for (var i = 0; i < d.Ordinals.Length; i++)
                {
                    var o = d.Ordinals[i];
                    if (o >= _loaded.Length || _loaded[o]) throw new JazminFormatException("Chunk ordinals are inconsistent");
                    _loaded[o] = true;
                    _rowStart[o] = d.RowStarts[i];
                    _rowCount[o] = d.RowCounts[i];
                    _chunkPartition[o] = id;
                    Array.Copy(d.Offsets, i * g, _partOffset, o * g, g);
                    Array.Copy(d.Lengths, i * g, _partLength, o * g, g);
                    if (d.Digests is not null)
                    {
                        _partDigests ??= new byte[_loaded.Length * g * 32];
                        Array.Copy(d.Digests, i * g * 32, _partDigests, o * g * 32, g * 32);
                    }
                    if (_access is not null) p.Ordinals.Add(o);
                }
                var segment = new SegmentInfo { Partition = id, Suffix = suffix, Statistics = d.Statistics };
                segment.Ordinals.AddRange(d.Ordinals);
                _segments.Add(segment);
                added.Add(segment);
            }
            p.Loaded = p.Segments.Count;
        }
        if (added.Count == 0) return;
        _visibleChunks = Enumerable.Range(0, _loaded.Length).Where(o => _loaded[o]).ToArray();
        _sortStatsComplete = null;
        if (_statCols.Count > 0) LoadStats(_statCols, added);
    }

    /// <summary>Loads every partition this reader may see (a key holder: its own).</summary>
    private void EnsureAllChunks()
    {
        if (_allLoaded) return;
        if (_access is { IsOwner: false }) LookupPartitions(_access.Partitions.Keys.ToList());
        else ListAllPartitions();
        EnsurePartitions(_partitions.Keys.ToList());
        _allLoaded = true;
    }

    /// <summary>A chunk part's reference.</summary>
    private SectionRef Part(int ordinal, int group)
    {
        var k = ordinal * _groups.Length + group;
        return new SectionRef(_partOffset[k], _partLength[k], _partDigests?[(k * 32)..((k + 1) * 32)]);
    }

    /// <summary>A column's statistics in a chunk, or null when not loaded or not kept.</summary>
    private ColumnStats? StatAt(int col, int ordinal)
    {
        if (_colStats[col] is not { } s || !s.Has[ordinal]) return null;
        var view = s.View;
        view.Nulls = s.Nulls[ordinal];
        view.Min = s.Min[ordinal];
        view.Max = s.Max[ordinal];
        return view;
    }

    private bool MayMatch(BoundFilter plan, int ordinal)
    {
        _statOrdinal = ordinal;
        return FilterEngine.MayMatch(plan, _statLookup, _rowCount[ordinal]);
    }

    /// <summary>Loads the statistics of these columns for every loaded segment (spec 6.4), one array set per column.</summary>
    private void EnsureStats(IEnumerable<int> columns)
    {
        var missing = columns.Where(c => c >= 0 && !_statCols.Contains(c)).ToHashSet();
        if (missing.Count == 0) return; // segments loaded later get these columns' statistics as they load
        _statCols.UnionWith(missing);
        LoadStats(missing, _segments);
    }

    private void LoadStats(IReadOnlySet<int> wanted, IEnumerable<SegmentInfo> segments)
    {
        foreach (var segment in segments)
        {
            for (var b = 0; b < segment.Statistics.Count; b++)
            {
                var block = segment.Statistics[b];
                if (segment.StatsLoaded.Contains(b) || !block.Columns.Any(wanted.Contains)) continue;
                segment.StatsLoaded.Add(b);
                if (block.Columns.Length == 0 || block.Columns.Any(c => c < 0 || c >= _allColumns.Length)) throw new JazminFormatException("Statistics block lists unknown columns");
                var group = _groupOf[block.Columns[0]];
                if (group < 0) continue; // a column group this key cannot see
                var sectionId = $"{_tableIndex}/stats/{segment.Partition}/{b}{segment.Suffix}";
                var key = _access is not null
                    ? AccessCrypto.PartKey(PartitionSecret(segment.Partition)!, ColumnSecret(_groups[group].Name)!, _salt, sectionId)
                    : _keys?.SectionKey(FormatConstants.KeyringData, sectionId);
                var entries = Catalog.DecodeStatistics(ReadSection(block.Section, sectionId, key));
                if (entries.Count != block.Columns.Length) throw new JazminFormatException("Statistics block does not match its columns");
                for (var k = 0; k < entries.Count; k++)
                {
                    var (col, e, n) = (block.Columns[k], entries[k], segment.Ordinals.Count);
                    if (e.NullCounts.Length != n || e.Min.Length != n || e.Max.Length != n) throw new JazminFormatException("Statistics do not match the chunk directory");
                    var type = _types[col];
                    var stats = _colStats[col] ??= new ColumnStatsByChunk(_loaded.Length);
                    for (var i = 0; i < n; i++)
                    {
                        var o = segment.Ordinals[i];
                        stats.Has[o] = true;
                        stats.Nulls[o] = e.NullCounts[i];
                        stats.Min[o] = Bounds.Decode(type, e.Min[i]);
                        stats.Max[o] = Bounds.Decode(type, e.Max[i]);
                    }
                }
            }
        }
    }

    /// <summary>Owner only: partition names and grants, loaded on first use (clients never read it).</summary>
    private JsonObject OwnerDirectory()
    {
        if (_access!.Directory is null)
        {
            var at = _header.Access?.OwnerDirectory ?? throw new JazminFormatException("Owner directory is missing");
            var text = Encoding.UTF8.GetString(ReadSection(at, "owner", AccessCrypto.OwnerDirectoryKey(_access.Secrets!.Owner, _salt)));
            _access.DirectoryText = text;
            _access.Directory = Values.ParseJson(text, "The owner directory") as JsonObject ?? throw new JazminFormatException("The owner directory is not a JSON object");
        }
        return _access.Directory;
    }

    /// <summary>The key-slot and signature sections are stored unencrypted and uncompressed (spec 7.6.4); anything else is refused.</summary>
    private static byte[] PlainSection(byte[] section, string sectionId) =>
        section.Length >= FormatConstants.EnvelopeSize && section[0] == (byte)JazminCodec.None && section[1] == 0
            ? section
            : throw new JazminFormatException($"Section '{sectionId}' must be stored as is");

    /// <summary>
    /// Reads and decodes a section by reference, checking its digest (spec 7.6.5). Access-controlled files list every
    /// section with its digest: one without is refused.
    /// </summary>
    private byte[] ReadSection(SectionRef at, string sectionId, byte[]? key)
    {
        var section = Read(at.Offset, at.Length);
        if (_cost is not null) _cost.BytesRead += at.Length;
        if (at.Digest is null)
        {
            if (_access is not null) throw new JazminFormatException($"Section '{sectionId}' has no digest");
        }
        else if (!SHA256.HashData(section).AsSpan().SequenceEqual(at.Digest))
            throw new JazminFormatException($"Section '{sectionId}' does not match the owner's signature");
        return SectionCodec.Decode(section, key, _fileId, sectionId);
    }

    // ---- embedded files (spec 6.8) ---------------------------------------------------------------

    private (Dictionary<string, FileEntry> Entries, Dictionary<int, StoredContent> Contents)? _fileIndex;

    /// <summary>Loads the file directories this key can open, merged by path (once).</summary>
    private (Dictionary<string, FileEntry> Entries, Dictionary<int, StoredContent> Contents) FileIndex()
    {
        if (_fileIndex is { } cached) return cached;
        var entries = new Dictionary<string, FileEntry>(StringComparer.Ordinal);
        var contents = new Dictionary<int, StoredContent>();
        if (_header.Files is { } member)
        {
            var suffix = member.Segment > 0 ? $"/{member.Segment}" : "";
            var ownerNames = _access is { IsOwner: true }
                ? (OwnerDirectory()["fileGroups"]?.AsArray() ?? new JsonArray()).Select(n => (string)n!)
                    .ToDictionary(n => _access.Secrets!.PartitionId(n), n => n, StringComparer.Ordinal)
                : null;
            foreach (var (group, section) in member.Directories)
            {
                string sectionId;
                byte[]? key;
                if (_access is null)
                {
                    sectionId = $"files/dir{suffix}";
                    key = _keys?.SectionKey(FormatConstants.KeyringFiles, sectionId);
                }
                else
                {
                    var secret = _access.IsOwner ? _access.Secrets!.FileGroupSecret(group) : _access.FileSecrets.GetValueOrDefault(group);
                    if (secret is null) continue; // a group this key does not see
                    sectionId = $"files/dir/{group}{suffix}";
                    key = Crypto.Hkdf(secret, _salt, $"JAZMIN/1/{sectionId}");
                }
                var json = StoredContent.CheckDirectory(Encoding.UTF8.GetString(ReadSection(section, sectionId, key)));
                foreach (var c in json["contents"]!.AsArray())
                {
                    var content = StoredContent.FromJson(c!);
                    contents[content.Id] = content;
                }
                foreach (var f in json["files"]!.AsArray())
                {
                    var path = (string)f!["path"]!;
                    List<string>? groups = f["groups"] is JsonArray g ? g.Select(x => (string)x!).ToList()
                        : ownerNames is not null && ownerNames.TryGetValue(group, out var name) ? [name] : null;
                    if (!entries.TryGetValue(path, out var known)) entries[path] = new FileEntry(path, (string)f["type"]!, (int)f["content"]!, groups);
                    else if (known.Groups is not null && groups is not null)
                        entries[path] = known with { Groups = known.Groups.Union(groups).Order(StringComparer.Ordinal).ToList() };
                }
            }
            foreach (var (path, e) in entries.ToList())
            {
                if (!contents.ContainsKey(e.Content)) throw new JazminFormatException($"Embedded file '{path}' refers to missing content");
                if (e.Groups?.Contains(EmbeddedFiles.Everyone) == true) entries[path] = e with { Groups = [EmbeddedFiles.Everyone] };
            }
        }
        _fileIndex = (entries, contents);
        return _fileIndex.Value;
    }

    /// <summary>Embedded files this key can see (groups are known to the owner and in single-key files).</summary>
    public IReadOnlyList<JazminEmbeddedFile> Files
    {
        get
        {
            var (entries, contents) = FileIndex();
            return entries.Values.Select(e => new JazminEmbeddedFile(e.Path, e.Type, contents[e.Content].Size, contents[e.Content].Sha256, e.Groups?.ToList())).ToList();
        }
    }

    private JsonObject? PackageJson => _header.Files is { Package.Length: > 0 } files ? Values.ParseJson(files.Package, "Package settings") as JsonObject : null;

    /// <summary>Settings for viewers that render the embedded files, or null.</summary>
    public JazminPackage? Package => EmbeddedFiles.PackageFrom(PackageJson);

    private StoredContent FileContent(string path)
    {
        var (entries, contents) = FileIndex();
        if (!entries.TryGetValue(path, out var entry)) throw new JazminValidationException($"No file '{path}' is visible with this key");
        return contents[entry.Content];
    }

    internal byte[] FileBlock(StoredContent content, int b)
    {
        var block = content.Blocks[b];
        var sectionId = $"file/{content.Id}/{b}";
        if (content.Key is null && (_keys is not null || _access is not null)) throw new JazminFormatException($"Embedded content {content.Id} has no key in an encrypted file");
        var key = content.Key is null ? null : Crypto.Hkdf(content.Key, _salt, $"JAZMIN/1/{sectionId}");
        var bytes = ReadSection(new SectionRef(block.Offset, block.Length, block.Digest is null ? null : Convert.FromBase64String(block.Digest)), sectionId, key);
        if (bytes.Length != Math.Min(content.BlockSize, content.Size - (long)b * content.BlockSize))
            throw new JazminFormatException($"Section '{sectionId}' has the wrong length for its embedded file");
        return bytes;
    }

    /// <summary>Reads a whole embedded file (checked against its SHA-256).</summary>
    public byte[] ReadFile(string path)
    {
        var content = FileContent(path);
        if (content.Size > Array.MaxLength) throw new JazminValidationException($"File '{path}' is too large to read into one array - use OpenFile");
        var bytes = new byte[content.Size];
        for (var b = 0; b < content.Blocks.Count; b++) FileBlock(content, b).CopyTo(bytes, (long)b * content.BlockSize);
        if (Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != content.Sha256)
            throw new JazminFormatException($"File '{path}' does not match its SHA-256");
        return bytes;
    }

    /// <summary>Reads bytes [start, end) of an embedded file, decoding only the blocks involved.</summary>
    public byte[] ReadFileRange(string path, long start, long? end = null)
    {
        var content = FileContent(path);
        var stop = Math.Min(end ?? content.Size, content.Size);
        if (start < 0 || start > stop) throw new JazminValidationException("Invalid file range");
        var result = new byte[stop - start];
        for (var b = (int)(start / content.BlockSize); (long)b * content.BlockSize < stop; b++)
        {
            var block = FileBlock(content, b);
            var blockStart = (long)b * content.BlockSize;
            var from = (int)Math.Max(0, start - blockStart);
            var to = (int)Math.Min(block.Length, stop - blockStart);
            block.AsSpan(from, to - from).CopyTo(result.AsSpan((int)(blockStart + from - start)));
        }
        return result;
    }

    /// <summary>
    /// Opens an embedded file as a read-only, seekable stream that decodes one block at a time. Each block is
    /// verified as it is read (authenticated encryption or signed digest); <see cref="ReadFile"/> also checks the SHA-256.
    /// </summary>
    public Stream OpenFile(string path) => new EmbeddedFileStream(this, FileContent(path));

    /// <summary>Internal: what update/append need to carry the files over (owner / single key only).</summary>
    internal FileState? FileState()
    {
        if (_header.Files is not { } member) return null;
        var (entries, contents) = FileIndex();
        return new FileState(entries.Values.Select(e => e with { Groups = e.Groups ?? [EmbeddedFiles.Everyone] }).ToList(), contents.Values.ToList(),
            member.NextContent, PackageJson);
    }

    // ---- file properties -------------------------------------------------------------------------

    /// <summary>A copy of the user metadata.</summary>
    public JsonObject Metadata => (JsonObject)_metadata.DeepClone();

    /// <summary>Rows visible to this reader (excluding deleted rows, and rows an access key may not see).</summary>
    public long RowCount =>
        (_access is null or { IsOwner: true } ? _table.RowCount : _visibleChunks.Sum(i => (long)_rowCount[i])) - DeletedRowCount;

    /// <summary>Live rows in the file that this key may not see.</summary>
    public long HiddenRowCount => _table.RowCount - _deleted.Length - RowCount;

    /// <summary>Rows deleted by appends and not yet removed by compaction (only those visible to this key).</summary>
    public long DeletedRowCount => _access is null or { IsOwner: true }
        ? _deleted.Length
        : _deletedVisible ??= _deleted.LongCount(id => ChunkOrdinalFor(id) >= 0);

    /// <summary>Number of appends since the file was last written in full (compaction resets it to 0).</summary>
    public int AppendCount => _header.AppendCount;

    /// <summary>True when the end of the file held an interrupted append, and the previous version was used.</summary>
    public bool Recovered { get; private set; }

    public int ChunkCount => _table.ChunkCount;

    public bool IsEncrypted => _keys is not null || _access is not null;

    /// <summary>PBKDF2 iterations of a password-protected file, otherwise null.</summary>
    public int? KdfIterations { get; private set; }

    /// <summary>Columns the writer declared the rows to be ordered by (null if none).</summary>
    public IReadOnlyList<string>? SortedBy => _table.SortedBy.Count > 0 ? _table.SortedBy : null;

    /// <summary>Index refs this reader may use: the table's, or (access-controlled files, owner only) the owner catalog's.</summary>
    private List<IndexRef> IndexList()
    {
        if (_indexRefs is not null) return _indexRefs;
        if (_access is null) _indexRefs = _table.Indexes;
        else if (!_access.IsOwner) _indexRefs = new List<IndexRef>(); // indexes reveal every partition's values
        else
        {
            _indexRefs = OwnerCatalog().FirstOrDefault(t => t.Table == _tableIndex).Indexes ?? new List<IndexRef>();
        }
        return _indexRefs;
    }

    /// <summary>Owner only: the indexes of every table (spec 7.6.5).</summary>
    private List<(int Table, List<IndexRef> Indexes)> OwnerCatalog()
    {
        const string sectionId = "owner/catalog";
        var at = _header.Access?.OwnerCatalog ?? throw new JazminFormatException("Owner catalog is missing");
        return Catalog.DecodeOwnerCatalog(ReadSection(at, sectionId, AccessCrypto.SectionKey(_access!.Secrets!.Owner, _salt, sectionId)));
    }

    /// <summary>Indexes this reader may use (none for access keys: indexes reveal every partition's values).</summary>
    public IReadOnlyList<(string Column, JazminIndexKind Kind)> Indexes =>
        IndexList().Select(i => (i.Column, Kind: TypeNames.ParseIndex(i.Kind)))
            .Where(i => i.Kind is not null)
            .Select(i => (i.Column, i.Kind!.Value)).Distinct().ToList(); // appended files have one segment per append

    /// <summary>Access-control details, or null for ordinary files. Grants are listed for the owner only.</summary>
    public JazminAccessInfo? Access
    {
        get
        {
            if (_access is null) return null;
            var partitionBy = _table.PartitionBy.Length > 0 ? _table.PartitionBy : null;
            var columnGroups = _groups.Select(g => g.Name).ToList();
            if (!_access.IsOwner)
                return new JazminAccessInfo(false, partitionBy, columnGroups, _access.PartitionNames.Values.ToList(), _groups.Where(g => g.Visible).Select(g => g.Name).ToList(), null)
                {
                    Online = _access.Online,
                    Expires = _access.Expires,
                };
            var directory = OwnerDirectory();
            return new JazminAccessInfo(true, partitionBy, columnGroups,
                directory["partitions"]!.AsArray().Select(n => (string)n!).ToList(),
                columnGroups,
                directory["grants"]!.AsArray().Select(g => new JazminGrantInfo(
                    JazminAccessKey.Parse((string)g!["key"]!).Id, ListOrAll(g["rows"]), ListOrAll(g["columns"]), (string?)g["label"])
                {
                    Mode = (string?)g["mode"] == "online" ? JazminGrantMode.Online : JazminGrantMode.Offline,
                    Expires = g["expires"] is { } e ? DateTimeOffset.Parse((string)e!, CultureInfo.InvariantCulture) : null,
                }).ToList());
        }
    }

    /// <summary>Owner only: grants including access keys, used by <see cref="JazminFile.Update"/> to re-issue them.</summary>
    internal JsonArray? OwnerGrants => _access is { IsOwner: true } ? OwnerDirectory()["grants"]!.AsArray() : null;

    /// <summary>Owner only: the partition column and the restricted column groups with their column names (for rewrites).</summary>
    internal (string? PartitionBy, List<(string Name, List<string> Columns)> ColumnGroups) AccessLayout =>
        (_table.PartitionBy.Length > 0 ? _table.PartitionBy : null,
            _groups.Select(g => (g.Name, g.Cols.Select(i => _allColumns[i].Name).ToList())).ToList());

    internal static IReadOnlyList<string>? ListOrAll(JsonNode? node) =>
        node is JsonArray array ? array.Select(n => (string)n!).ToList() : null; // "*" (or missing) means all

    // ---- chunks ----------------------------------------------------------------------------------

    [ThreadStatic]
    private static StringPool? _workerStrings; // string pools are per thread when chunks decode in parallel

    /// <summary>Reads a section's bytes into a rented buffer.</summary>
    private (byte[] Buffer, int Length) ReadRawPooled(SectionRef at)
    {
        if (at.Offset < 0 || at.Length < 0 || at.Offset + at.Length > _stream.Length) throw new JazminFormatException("Unexpected end of file");
        var section = System.Buffers.ArrayPool<byte>.Shared.Rent(Math.Max(at.Length, 1));
        try
        {
            lock (_io)
            {
                _stream.Position = at.Offset;
                _stream.ReadExactly(section, 0, at.Length);
            }
            return (section, at.Length);
        }
        catch
        {
            System.Buffers.ArrayPool<byte>.Shared.Return(section);
            throw;
        }
    }

    /// <summary>
    /// Decodes the columns of these chunks (files that are not access-controlled: one part per chunk), up to
    /// <see cref="JazminReadOptions.MaxDegreeOfParallelism"/> ahead on worker threads: the file is read in order here,
    /// while decryption, decompression and decoding run in parallel.
    /// </summary>
    private IEnumerable<(int Ordinal, DecodedColumn?[] Columns)> DecodeAhead(IEnumerable<int> ordinals, JazminType[] types, bool[]? wanted)
    {
        var (fileId, keys, group) = (_fileId, _keys, _groups[0].Name);
        DecodedColumn?[] Decode(int ordinal, byte[] section, int length, StringPool? strings)
        {
            var sectionId = FormatConstants.ChunkSectionId(_tableIndex, ordinal, group);
            try
            {
                var (raw, rawLength) = SectionCodec.DecodePooled(section, length, keys?.SectionKey(FormatConstants.KeyringData, sectionId), fileId, sectionId);
                try
                {
                    return Columnar.DecodeTyped(raw, rawLength, types, _rowCount[ordinal], ordinal, wanted, strings ?? (_workerStrings ??= new StringPool()));
                }
                finally
                {
                    System.Buffers.ArrayPool<byte>.Shared.Return(raw); // decoded columns hold copies, not views
                }
            }
            finally
            {
                System.Buffers.ArrayPool<byte>.Shared.Return(section);
            }
        }

        // Memory first: about 128 decoded columns in flight. Narrow queries read far ahead; full reads of wide
        // files (where read-ahead gains little) stay sequential.
        var decodedColumns = wanted is null ? types.Length : wanted.Count(w => w);
        var ahead = Math.Clamp(128 / Math.Max(1, decodedColumns), 1, _readAhead);
        (byte[] Section, int Length) ReadChunk(int ordinal)
        {
            var at = Part(ordinal, 0);
            var read = ReadRawPooled(at);
            if (_cost is not null)
            {
                _cost.BytesRead += at.Length;
                _cost.ChunksRead++;
                _cost.ColumnsDecoded += decodedColumns;
            }
            return read;
        }
        if (ahead <= 1)
        {
            foreach (var ordinal in ordinals)
            {
                var (section, length) = ReadChunk(ordinal);
                yield return (ordinal, Decode(ordinal, section, length, _strings));
            }
            yield break;
        }

        var queue = new Queue<(int Ordinal, Task<DecodedColumn?[]> Work)>();
        using var next = ordinals.GetEnumerator();
        try
        {
            while (true)
            {
                while (queue.Count < ahead && next.MoveNext())
                {
                    var ordinal = next.Current;
                    var (section, length) = ReadChunk(ordinal);
                    queue.Enqueue((ordinal, Task.Run(() => Decode(ordinal, section, length, null))));
                }
                if (queue.Count == 0) yield break;
                var (done, work) = queue.Dequeue();
                yield return (done, work.GetAwaiter().GetResult());
            }
        }
        finally
        {
            foreach (var (_, work) in queue)
            {
                try
                {
                    work.Wait(); // stopped early: let workers finish (they return their buffers)
                }
                catch (AggregateException)
                {
                    // the scan was abandoned
                }
            }
        }
    }

    private object?[][] ChunkRows(int ordinal)
    {
        if (_cachedOrdinal == ordinal) return _cachedRows!;
        var width = _allColumns.Length;
        var rowCount = _rowCount[ordinal];
        object?[][]? rows = null; // made after a part is decoded: Columnar checks the directory's row count against the part's size
        object?[][] NewRows()
        {
            var made = new object?[rowCount][];
            for (var r = 0; r < made.Length; r++) made[r] = new object?[width];
            return made;
        }
        var partitionSecret = _access is null ? null : PartitionSecret(_chunkPartition[ordinal]!) ?? throw new JazminKeyException($"Chunk {ordinal} is not visible with this key");
        for (var g = 0; g < _groups.Length; g++)
        {
            var group = _groups[g];
            if (!group.Visible) continue; // column group not granted: its columns stay hidden
            var sectionId = FormatConstants.ChunkSectionId(_tableIndex, ordinal, group.Name);
            var key = _access is not null
                ? AccessCrypto.PartKey(partitionSecret!, ColumnSecret(group.Name)!, _salt, sectionId)
                : _keys?.SectionKey(FormatConstants.KeyringData, sectionId);
            var decoded = Columnar.Decode(ReadSection(Part(ordinal, g), sectionId, key), group.Cols.Select(c => _types[c]).ToArray(), rowCount, ordinal, strings: _strings);
            if (_cost is not null) _cost.ColumnsDecoded += group.Cols.Length;
            rows ??= NewRows();
            for (var j = 0; j < group.Cols.Length; j++)
            {
                var values = decoded[j]!;
                var col = group.Cols[j];
                for (var r = 0; r < rowCount; r++) rows[r][col] = values[r];
            }
        }
        rows ??= NewRows();
        // Deleted rows become null and are skipped by every read path.
        var start = _rowStart[ordinal];
        var first = Array.BinarySearch(_deleted, start);
        for (var i = first >= 0 ? first : ~first; i < _deleted.Length && _deleted[i] < start + rows.Length; i++)
            rows[_deleted[i] - start] = null!;
        _cachedOrdinal = ordinal;
        _cachedRows = rows;
        if (_cost is not null) _cost.ChunksRead++;
        return rows;
    }

    /// <summary>
    /// Fast path for reading every row into objects: decodes only the columns the type maps (with read-ahead) and
    /// builds each instance from the typed column arrays. Only for files without access control; null otherwise.
    /// </summary>
    internal IEnumerable<object>? DirectColumnRows(Func<IReadOnlyList<JazminColumn>, (Func<DecodedColumn?[], int, object> Read, bool[] Wanted)?> readerFor)
    {
        if (_access is not null) return null;
        return readerFor(_allColumns) is { } reader ? DirectColumnRowsIterator(reader.Read, reader.Wanted) : null;
    }

    private IEnumerable<object> DirectColumnRowsIterator(Func<DecodedColumn?[], int, object> read, bool[] wanted)
    {
        EnsureAllChunks();
        var deleted = 0;
        foreach (var (ordinal, columns) in DecodeAhead(_visibleChunks, _types, wanted))
        {
            for (var r = 0; r < _rowCount[ordinal]; r++)
            {
                var rowId = _rowStart[ordinal] + r;
                while (deleted < _deleted.Length && _deleted[deleted] < rowId) deleted++;
                if (deleted < _deleted.Length && _deleted[deleted] == rowId) continue; // removed by an append
                yield return read(columns, r);
            }
        }
    }

    // ---- indexes ---------------------------------------------------------------------------------

    private object? LoadIndex(string column, string kind)
    {
        var cacheKey = $"{column}/{kind}";
        if (_indexes.TryGetValue(cacheKey, out var cached)) return cached;
        object? index = null;
        // On the leading SortedBy column, chunk statistics already locate matches exactly, so loading the (large)
        // index would only cost time.
        var leadingSort = kind == "sorted" && _table.SortedBy.Count > 0 && _table.SortedBy[0] == column;
        var infos = leadingSort ? new List<IndexRef>() : IndexList().Where(i => i.Column == column && i.Kind == kind).ToList();
        if (infos.Count > 0)
        {
            var type = _allColumns.First(c => c.Name == column).Type;
            byte[] Read(string sectionId, SectionRef at)
            {
                if (_cost is not null) _cost.IndexPagesRead++;
                return ReadSection(at, sectionId, CatalogKey(sectionId, _access?.Secrets?.Owner, FormatConstants.KeyringIndex));
            }
            // One segment for the original rows plus one per append.
            if (kind == "sorted")
            {
                var parts = infos.Select(info =>
                {
                    var baseId = FormatConstants.IndexSectionId(_tableIndex, column, kind, info.Segment);
                    // Only the directory is read now; pages are read (and a few kept) as lookups need them.
                    return (ISortedIndex)new PagedSortedIndex(Catalog.DecodeIndexDirectory(Read(baseId, info.Section)), type, (part, page) => Read($"{baseId}/{part}", page));
                }).ToList();
                index = parts.Count == 1 ? parts[0] : new CompositeSortedIndex(parts);
            }
            else
            {
                var parts = infos.Select(info => (ITrigramIndex)TrigramIndex.Decode(Read(FormatConstants.IndexSectionId(_tableIndex, column, kind, info.Segment), info.Section))).ToList();
                index = parts.Count == 1 ? parts[0] : new CompositeTrigramIndex(parts);
            }
        }
        _indexes[cacheKey] = index;
        return index;
    }

    ISortedIndex? IIndexProvider.Sorted(string column) => LoadIndex(column, "sorted") as ISortedIndex;

    ITrigramIndex? IIndexProvider.Trigram(string column) => LoadIndex(column, "trigram") as ITrigramIndex;

    // ---- queries ---------------------------------------------------------------------------------

    /// <summary>Ordinal of the loaded, visible chunk holding a row id, or -1.</summary>
    private int ChunkOrdinalFor(long rowId)
    {
        var list = _visibleChunks;
        if (list.Length == 0) return -1;
        int lo = 0, hi = list.Length - 1;
        while (lo < hi)
        {
            var mid = (lo + hi + 1) >>> 1;
            if (_rowStart[list[mid]] <= rowId) lo = mid;
            else hi = mid - 1;
        }
        var o = list[lo];
        return rowId >= _rowStart[o] && rowId < _rowStart[o] + _rowCount[o] ? o : -1;
    }

    private int VisibleIndex(string name, string where)
    {
        var i = Array.FindIndex(_allColumns, c => c.Name == name);
        if (i < 0 || _groupOf[i] < 0) throw new JazminValidationException($"Unknown column '{name}' in {where}");
        return i;
    }

    private int[] Selection(IReadOnlyList<string>? select) =>
        select is null ? _visibleCols : select.Select(name => VisibleIndex(name, "select")).ToArray();

    private int PartitionCol() => _table.PartitionBy.Length == 0 ? -1 : Array.FindIndex(_allColumns, c => c.Name == _table.PartitionBy);

    private static void CollectColumns(BoundFilter? node, HashSet<int> into)
    {
        switch (node)
        {
            case BoundFilter.Leaf leaf: into.Add(leaf.Col); break;
            case BoundFilter.Not not: CollectColumns(not.Item, into); break;
            case BoundFilter.And and: foreach (var item in and.Items) CollectColumns(item, into); break;
            case BoundFilter.Or or: foreach (var item in or.Items) CollectColumns(item, into); break;
        }
    }

    private BoundFilter? Plan(JazminFilter? filter)
    {
        var plan = BoundFilter.Bind(filter, _allColumns);
        if (plan is null)
        {
            EnsureAllChunks();
            return null;
        }
        // In access-controlled files a filter that pins the partition column selects whole partitions: the owner loads
        // only those, and the partition column's statistics are not needed.
        var partitionCol = _access is null ? -1 : PartitionCol();
        var names = partitionCol >= 0 ? PartitionLookup(plan, partitionCol) : null;
        if (names is not null && _access is { IsOwner: true } && !_allLoaded) EnsurePartitions(names.Select(n => _access.Secrets!.PartitionId(n)).ToList());
        else EnsureAllChunks();
        var used = new HashSet<int>();
        CollectColumns(plan, used);
        if (_table.SortedBy.Count > 0) used.Add(Array.FindIndex(_allColumns, c => c.Name == _table.SortedBy[0]));
        if (names is not null) used.Remove(partitionCol);
        EnsureStats(used);
        return plan;
    }

    /// <summary>Partition names a filter pins the partition column to (top-level AND of eq / in / isNull), else null.</summary>
    private static List<string>? PartitionLookup(BoundFilter plan, int col)
    {
        if (col < 0) return null;
        var leaves = plan is BoundFilter.And and ? and.Items : [plan];
        foreach (var leaf in leaves.OfType<BoundFilter.Leaf>().Where(l => l.Col == col))
        {
            switch (leaf.Op)
            {
                case "eq": return [AccessCrypto.PartitionName(leaf.Value)];
                case "in": return ((object?[])leaf.Value!).Select(AccessCrypto.PartitionName).ToList();
                case "isNull" when (bool)leaf.Value!: return [""];
            }
        }
        return null;
    }

    /// <summary>Access-controlled files: chunks of the partitions a filter pins, found by id (no statistics scan).</summary>
    private IReadOnlyList<int>? ChunksForPartitions(BoundFilter plan)
    {
        var names = PartitionLookup(plan, PartitionCol());
        if (names is null) return null;
        var ids = _access!.IsOwner
            ? names.Select(n => _access.Secrets!.PartitionId(n))
            : _access.PartitionNames.Where(p => names.Contains(p.Value)).Select(p => p.Key);
        return ids.Distinct()
            .SelectMany(id => _partitions.TryGetValue(id, out var p) ? p.Ordinals : Enumerable.Empty<int>())
            .Where(o => _loaded[o]).Order().ToArray();
    }

    /// <summary>
    /// Chunks a scan must consider. A filter that pins the partition column selects whole partitions; in a file sorted by
    /// SortedBy, chunk min/max values of the leading sort column are non-decreasing, so a filter bounding that column is
    /// answered by binary search.
    /// </summary>
    private IReadOnlyList<int> ScanChunks(BoundFilter? plan)
    {
        if (plan is null) return _visibleChunks;
        if (_access is not null && ChunksForPartitions(plan) is { } byPartition) return byPartition;
        if (_table.SortedBy.Count == 0) return _visibleChunks;
        var col = Array.FindIndex(_allColumns, c => c.Name == _table.SortedBy[0]);
        var bounds = SortBounds(plan, col);
        if (bounds is null) return _visibleChunks;
        _sortStatsComplete ??= _visibleChunks.All(i => StatAt(col, i) is { Min: not null, Max: not null, Nulls: 0 });
        if (_sortStatsComplete != true) return _visibleChunks;

        ColumnStats Stat(int i) => StatAt(col, _visibleChunks[i])!;
        int FirstWhere(Func<ColumnStats, bool> test)
        {
            int lo = 0, hi = _visibleChunks.Length;
            while (lo < hi)
            {
                var mid = (lo + hi) >>> 1;
                if (test(Stat(mid))) hi = mid;
                else lo = mid + 1;
            }
            return lo;
        }
        var (low, lowInclusive, high, highInclusive) = bounds.Value;
        var from = low is null ? 0 : FirstWhere(s => lowInclusive ? Values.Compare(s.Max!, low) >= 0 : Values.Compare(s.Max!, low) > 0);
        var to = high is null ? _visibleChunks.Length : FirstWhere(s => highInclusive ? Values.Compare(s.Min!, high) > 0 : Values.Compare(s.Min!, high) >= 0);
        return to <= from ? Array.Empty<int>() : _visibleChunks[from..to];
    }

    /// <summary>Bounds on one column implied by the top-level AND conditions of a filter, or null.</summary>
    private static (object? Low, bool LowInclusive, object? High, bool HighInclusive)? SortBounds(BoundFilter plan, int col)
    {
        var leaves = plan is BoundFilter.And and ? and.Items : [plan];
        (object? Low, bool LowInclusive, object? High, bool HighInclusive)? bounds = null;
        void Tighten(object? low, bool lowInclusive, object? high, bool highInclusive)
        {
            var b = bounds ?? (null, false, null, false);
            if (low is not null && (b.Low is null || Values.Compare(low, b.Low) > 0)) (b.Low, b.LowInclusive) = (low, lowInclusive);
            if (high is not null && (b.High is null || Values.Compare(high, b.High) < 0)) (b.High, b.HighInclusive) = (high, highInclusive);
            bounds = b;
        }
        foreach (var leaf in leaves.OfType<BoundFilter.Leaf>().Where(l => l.Col == col && l.Value is not null && !Values.IsNaN(l.Value)))
        {
            switch (leaf.Op)
            {
                case "eq": Tighten(leaf.Value, true, leaf.Value, true); break;
                case "gt": Tighten(leaf.Value, false, null, false); break;
                case "gte": Tighten(leaf.Value, true, null, false); break;
                case "lt": Tighten(null, false, leaf.Value, false); break;
                case "lte": Tighten(null, false, leaf.Value, true); break;
            }
        }
        return bounds;
    }

    /// <summary>Reads one row by its zero-based row id.</summary>
    public JazminRow Get(long rowId)
    {
        if (rowId < 0 || rowId >= _table.RowCount) throw new JazminValidationException($"Row {rowId} is out of range");
        EnsureAllChunks();
        var ordinal = ChunkOrdinalFor(rowId);
        if (ordinal < 0 || _visibleCols.Length == 0) throw new JazminKeyException($"Row {rowId} is not visible with this key");
        var values = ChunkRows(ordinal)[rowId - _rowStart[ordinal]]
            ?? throw new JazminValidationException($"Row {rowId} was deleted");
        return new JazminRow(rowId, _allColumns, _visibleCols, values);
    }

    /// <summary>Streams all visible rows.</summary>
    public IEnumerable<JazminRow> Rows(JazminQueryOptions? options = null) => Find((JazminFilter?)null, options);

    /// <summary>
    /// Find for async code: rows are read and decoded on a thread-pool thread, a batch at a time, while you await,
    /// so a request thread is never blocked by a long scan. Same rows, same order as Find.
    /// </summary>
    public IAsyncEnumerable<JazminRow> FindAsync(JazminFilter? filter, JazminQueryOptions? options = null, CancellationToken cancellationToken = default) =>
        AsyncRows.Of(Find(filter, options), cancellationToken); // Find validates the filter now, not on the first await

    /// <summary>FindAsync with a filter in JSON ("where") form.</summary>
    public IAsyncEnumerable<JazminRow> FindAsync(string whereJson, JazminQueryOptions? options = null, CancellationToken cancellationToken = default) =>
        FindAsync(JazminFilter.Parse(whereJson), options, cancellationToken);

    /// <summary>Rows for async code (see FindAsync).</summary>
    public IAsyncEnumerable<JazminRow> RowsAsync(JazminQueryOptions? options = null, CancellationToken cancellationToken = default) =>
        FindAsync((JazminFilter?)null, options, cancellationToken);

    /// <summary>Streams rows matching a filter given in JSON ("where") form.</summary>
    public IEnumerable<JazminRow> Find(string whereJson, JazminQueryOptions? options = null) => Find(JazminFilter.Parse(whereJson), options);

    /// <summary>
    /// Streams visible rows matching a filter, in row order. Uses indexes to read only candidate
    /// chunks; otherwise scans, skipping chunks whose statistics prove they cannot match.
    /// </summary>
    public IEnumerable<JazminRow> Find(JazminFilter? filter, JazminQueryOptions? options = null)
    {
        // Validate eagerly so errors surface at the call, not on first enumeration.
        var plan = Plan(filter);
        var selection = Selection(options?.Select);
        return FindIterator(plan, selection, options?.Offset ?? 0, options?.Limit ?? long.MaxValue);
    }

    private IEnumerable<JazminRow> FindIterator(BoundFilter? plan, int[] selection, long offset, long limit)
    {
        long skipped = 0, yielded = 0;
        var rowIds = plan is null ? null : FilterEngine.Candidates(plan, this);
        if (rowIds is null && _access is null)
        {
            // No index narrows the rows: decode only the filter's and the selected columns of each chunk.
            foreach (var row in ScanColumns(plan, selection, offset, limit)) yield return row;
            yield break;
        }

        bool Accept(object?[]? row)
        {
            if (row is null) return false; // deleted
            if (plan is not null && !FilterEngine.Evaluate(plan, row)) return false;
            if (skipped < offset)
            {
                skipped++;
                return false;
            }
            return true;
        }

        if (rowIds is not null)
        {
            EnsureAllChunks(); // index results span every partition
            foreach (var rowId in rowIds)
            {
                if (yielded >= limit) yield break;
                var ordinal = ChunkOrdinalFor(rowId);
                if (ordinal < 0) continue;
                var row = ChunkRows(ordinal)[rowId - _rowStart[ordinal]];
                if (!Accept(row)) continue;
                yielded++;
                yield return new JazminRow(rowId, _allColumns, selection, row);
            }
            yield break;
        }

        foreach (var ordinal in ScanChunks(plan))
        {
            if (plan is not null && !MayMatch(plan, ordinal)) continue;
            var rows = ChunkRows(ordinal);
            for (var r = 0; r < rows.Length; r++)
            {
                if (yielded >= limit) yield break;
                if (!Accept(rows[r])) continue;
                yielded++;
                yield return new JazminRow(_rowStart[ordinal] + r, _allColumns, selection, rows[r]);
            }
        }
    }

    /// <summary>Scan with a filter (one column group): only the columns the filter and the selection use are decoded.</summary>
    private IEnumerable<JazminRow> ScanColumns(BoundFilter? plan, int[] selection, long offset, long limit)
    {
        var used = new HashSet<int>(selection);
        CollectColumns(plan, used);
        var all = used.Count == _allColumns.Length;
        var wanted = Enumerable.Range(0, _types.Length).Select(used.Contains).ToArray();
        var planColumns = new HashSet<int>();
        CollectColumns(plan, planColumns);
        var scratch = new object?[_types.Length];
        long skipped = 0, yielded = 0;
        var deleted = 0;
        var ordinals = ScanChunks(plan).Where(o => plan is null || MayMatch(plan, o));
        foreach (var (ordinal, columns) in DecodeAhead(ordinals, _types, all ? null : wanted))
        {
            for (var r = 0; r < _rowCount[ordinal]; r++)
            {
                if (yielded >= limit) yield break;
                var rowId = _rowStart[ordinal] + r;
                while (deleted < _deleted.Length && _deleted[deleted] < rowId) deleted++;
                if (deleted < _deleted.Length && _deleted[deleted] == rowId) continue; // removed by an append
                if (plan is not null)
                {
                    foreach (var c in planColumns) scratch[c] = columns[c]!.Get(r);
                    if (!FilterEngine.Evaluate(plan, scratch)) continue;
                }
                if (skipped < offset)
                {
                    skipped++;
                    continue;
                }
                yielded++;
                yield return new JazminRow(rowId, _allColumns, selection, columns, r); // points into the chunk: no copy per row
            }
        }
    }

    public long Count(JazminFilter? filter = null) => filter is null ? RowCount : Find(filter).LongCount();

    /// <summary>Describes how a filter executes: "index" (with the candidate row count) or "scan" (with chunks skipped).</summary>
    public JazminPlan Explain(JazminFilter? filter)
    {
        var plan = Plan(filter);
        var ids = plan is null ? null : FilterEngine.Candidates(plan, this);
        if (ids is not null) return new JazminPlan("index", ids.Length, ChunkCount, 0);
        var scanned = ScanChunks(plan);
        var matching = plan is null ? scanned.Count : scanned.Count(i => MayMatch(plan, i));
        return new JazminPlan("scan", RowCount, _visibleChunks.Length, _visibleChunks.Length - matching);
    }

    /// <summary>
    /// <see cref="Explain(JazminFilter?)"/>; with <paramref name="analyze"/> it also runs the query (with any
    /// <paramref name="options"/>) and reports what it read in <see cref="JazminPlan.Cost"/>. Indexes and the last chunk
    /// this reader already holds are not read again, so analyze a query on a freshly opened reader to see its full cost.
    /// </summary>
    public JazminPlan Explain(JazminFilter? filter, bool analyze, JazminQueryOptions? options = null)
    {
        if (!analyze) return Explain(filter);
        var cost = new CostCounter();
        long rows = 0;
        var watch = System.Diagnostics.Stopwatch.StartNew();
        _cost = cost;
        try
        {
            foreach (var _ in Find(filter, options)) rows++;
        }
        finally
        {
            _cost = null;
        }
        watch.Stop();
        return Explain(filter) with { Cost = new JazminQueryCost(rows, cost.BytesRead, cost.ChunksRead, cost.IndexPagesRead, cost.ColumnsDecoded, watch.Elapsed) };
    }

    /// <summary>Streams all visible rows mapped to <typeparamref name="T"/>.</summary>
    public IEnumerable<T> Rows<T>(JazminSerializerSettings? settings = null) => Query<T>(null, settings);

    /// <summary>Typed rows for async code: objects are built on a thread-pool thread, a batch at a time, while you await.</summary>
    public IAsyncEnumerable<T> RowsAsync<T>(JazminSerializerSettings? settings = null, CancellationToken cancellationToken = default) =>
        QueryAsync<T>(null, settings, cancellationToken);

    /// <summary>Query for async code (see Query).</summary>
    public IAsyncEnumerable<T> QueryAsync<T>(Expression<Func<T, bool>>? predicate, JazminSerializerSettings? settings = null, CancellationToken cancellationToken = default) =>
        AsyncRows.Of(Query(predicate, settings), cancellationToken);

    /// <summary>
    /// LINQ query: the predicate is translated to an index-aware filter where possible
    /// (==, !=, &lt;, &gt;, &amp;&amp;, ||, !, Contains, StartsWith(Ordinal), list.Contains), then applied exactly.
    /// </summary>
    public IEnumerable<T> Query<T>(Expression<Func<T, bool>>? predicate, JazminSerializerSettings? settings = null)
    {
        var map = TypeMap.For(typeof(T), settings);
        var translation = predicate is null ? null : ExpressionTranslator.Translate(predicate, member => FileColumn(map.ColumnFor(member)));
        // An exact translation already selects precisely the predicate's rows: skip compiling it.
        var check = predicate is null || translation!.Exact ? null : predicate.Compile();
        var rows = Find(translation?.Filter);
        return Iterate();

        IEnumerable<T> Iterate()
        {
            var references = new ReferenceResolver();
            foreach (var row in rows)
            {
                var item = (T)map.FromRow(row, settings, references);
                if (check is null || check(item)) yield return item;
            }
        }
    }

    /// <summary>
    /// The file's own visible column for a mapped property: exact name first, then case-insensitive
    /// (matching how rows are materialized). Null when there is no such visible column or its type
    /// differs from the property's: that part of a LINQ predicate is then evaluated in memory only.
    /// </summary>
    private JazminColumn? FileColumn(JazminColumn? mapped)
    {
        if (mapped is null) return null;
        var column = _visibleColumns.FirstOrDefault(c => c.Name == mapped.Name)
            ?? _visibleColumns.FirstOrDefault(c => string.Equals(c.Name, mapped.Name, StringComparison.OrdinalIgnoreCase));
        return column?.Type == mapped.Type ? column : null;
    }

    /// <summary>Internal: (rowId, row) for visible, non-deleted rows matching a filter (used by Append).</summary>
    internal IEnumerable<JazminRow> RowsWithIds(JazminFilter? filter) => Find(filter);

    /// <summary>Internal: what <see cref="JazminFile.Append"/> needs to continue this file (owner / single key only).</summary>
    internal AppendStateInfo AppendState()
    {
        EnsureAllChunks();
        object?[]? lastRow = null;
        if (_visibleChunks.Length > 0)
        {
            var saved = _deleted;
            _deleted = Array.Empty<long>(); // the physically last row, even if deleted, bounds the sort order
            _cachedOrdinal = -1;
            try
            {
                var rows = ChunkRows(_visibleChunks[^1]);
                lastRow = rows.Length > 0 ? rows[^1] : null;
            }
            finally
            {
                _deleted = saved;
                _cachedOrdinal = -1;
            }
        }
        var isOwner = _access is { IsOwner: true };
        return new AppendStateInfo(_header, _table, _fileId, _salt, _flags, _keys, _access?.Secrets,
            isOwner ? OwnerDirectory() : null, isOwner ? _access!.DirectoryText : null, isOwner ? _header.Access?.OwnerDirectory : null,
            isOwner ? _access!.KeySlots : null, IndexList(), _partitions.Values.ToDictionary(p => p.Id, p => p.Segments.Count, StringComparer.Ordinal),
            _deleted, _validEnd, lastRow, FileState(), _tableIndex, isOwner ? OwnerCatalog() : null);
    }

    public void Dispose()
    {
        _cachedRows = null;
        _indexes.Clear();
        Release();
    }
}
