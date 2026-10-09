using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Format;

namespace Jazmin;

public sealed class JazminWriteOptions
{
    /// <summary>The serializer's settings, when it writes: how .NET objects in nested columns map to their fields.</summary>
    internal Serialization.JazminSerializerSettings? Serializer { get; init; }

    public JazminCodec Codec { get; set; } = JazminCodec.Deflate;

    /// <summary>Deflate: 0-9, Brotli: 0-11. Null uses a balanced default.</summary>
    public int? CompressionLevel { get; set; }

    public int ChunkRows { get; set; } = FormatConstants.DefaultChunkRows;

    public int ChunkBytes { get; set; } = FormatConstants.DefaultChunkBytes;

    /// <summary>Appends: nested columns whose definitions gained fields (their restricted groups' definitions are written again).</summary>
    internal IReadOnlySet<string>? Grown { get; init; }

    /// <summary>Encrypt with this master key (the owner key for access-controlled files).</summary>
    public JazminKey? Key { get; set; }

    /// <summary>Encrypt with a key derived from this password (PBKDF2-SHA256).</summary>
    public string? Password { get; set; }

    public int KdfIterations { get; set; } = FormatConstants.DefaultKdfIterations;

    public JsonObject? Metadata { get; set; }

    /// <summary>Rows must arrive in this column order; recorded so updates can merge in place.</summary>
    public IReadOnlyList<string>? SortedBy { get; set; }

    /// <summary>Makes the file access-controlled: access keys see only their granted partitions and column groups.</summary>
    public JazminAccessOptions? Access { get; set; }

    /// <summary>Options used to serialise values of json columns.</summary>
    public JsonSerializerOptions? JsonOptions { get; set; }

    /// <summary>Clock used for grant expiry and file dates (default: the system clock).</summary>
    public DateTimeOffset? Now { get; set; }

    /// <summary>Files to embed. Identical content is stored once.</summary>
    public IReadOnlyList<JazminFileInput>? Files { get; set; }

    /// <summary>Settings for viewers that render the embedded files.</summary>
    public JazminPackage? Package { get; set; }

    /// <summary>
    /// Memory or speed first (default <see cref="JazminPriority.Balanced"/>): sets the default of
    /// <see cref="MaxDegreeOfParallelism"/>. The file is the same either way.
    /// </summary>
    public JazminPriority Priority { get; set; }

    /// <summary>
    /// Sorted indexes with keys and first row ids as differences from the previous entry's (reader feature
    /// 'index-deltas', spec 8.1): much smaller for whole numbers and dates. Readers before 1.2 refuse such files, naming
    /// the feature. Default false until 2.0. An append keeps the file's choice.
    /// </summary>
    public bool CompactIndexes { get; set; }

    /// <summary>
    /// Chunks encoded, compressed and encrypted at the same time on worker threads. 1 does everything on the calling
    /// thread. The file is the same either way. Default by <see cref="Priority"/>: Balanced and Speed one per
    /// processor, at most 16 (more threads did not write faster); Memory 1.
    /// </summary>
    public int MaxDegreeOfParallelism
    {
        get => _maxDegreeOfParallelism ?? (Priority == JazminPriority.Memory ? 1 : Math.Min(Environment.ProcessorCount, 16));
        set => _maxDegreeOfParallelism = value;
    }

    private int? _maxDegreeOfParallelism;

    /// <summary>Target raw size of a sorted-index page (spec 8.1); tests and fixtures lower it to get many pages.</summary>
    internal int IndexPageBytes { get; set; } = FormatConstants.DefaultIndexPageBytes;

    /// <summary>Target raw size of a key-slot page (spec 7.6.4); tests and fixtures lower it to get many pages.</summary>
    internal int KeySlotPageBytes { get; set; } = AccessCrypto.KeySlotPageBytes;

    /// <summary>False writes no owner chunk map, as writers before it did (tests of older files).</summary>
    internal bool ChunkMap { get; set; } = true;

    /// <summary>
    /// Several tables, written one after another (<see cref="JazminWriter.StartTable"/>), instead of the columns,
    /// <see cref="SortedBy"/> and <see cref="JazminAccessOptions.PartitionBy"/> / ColumnGroups. Keys and grants stay file-wide.
    /// </summary>
    public IReadOnlyList<JazminTable>? Tables { get; set; }
}

/// <summary>One table of a file with several (<see cref="JazminWriteOptions.Tables"/>; docs/design/several-tables.md).</summary>
public sealed class JazminTable(string name, IEnumerable<JazminColumn> columns)
{
    /// <summary>Unique and non-empty.</summary>
    public string Name { get; } = name;

    public IReadOnlyList<JazminColumn> Columns { get; } = columns.ToArray();

    public IReadOnlyList<string>? SortedBy { get; init; }

    /// <summary>Access-controlled files: the partition column. Partition names are shared by every table of the file.</summary>
    public string? PartitionBy { get; init; }

    /// <summary>Access-controlled files: this table's restricted column groups. Group names are shared too.</summary>
    public Dictionary<string, string[]> ColumnGroups { get; init; } = new();

    /// <summary>Default: the writer's. Small chunks (for example 256 rows) suit tables looked up by key.</summary>
    public int? ChunkRows { get; init; }

    public int? ChunkBytes { get; init; }
}

/// <summary>
/// Streams rows into a JAZMIN file. Memory use is one chunk of rows plus the row-id
/// lists of indexed columns. Call <see cref="Finish"/> (or Dispose) to write the catalog and header.
/// </summary>
public sealed class JazminWriter : IDisposable, IAsyncDisposable
{
    /// <summary>A column group: stored and locked together (one group, "*", in files that are not access-controlled).</summary>
    private sealed record Part(string Name, int[] Cols)
    {
        public ColumnBuffer[] Columns { get; set; } = []; // the current chunk's typed columns
        public int Bytes { get; set; } // estimated encoded size of the current chunk

        /// <summary>
        /// Column buffers encoded by a worker and reset, ready for another chunk. A queue, not a ConcurrentBag: each bag
        /// holds a ThreadLocal that is never disposed, so every writer (one bag per partition) left work for the finalizer.
        /// </summary>
        public System.Collections.Concurrent.ConcurrentQueue<ColumnBuffer[]> Free { get; } = new();
    }

    /// <summary>A chunk this writer wrote (spec 6.3): its parts are filled in when they are written.</summary>
    private sealed class WrittenChunk
    {
        public required int Ordinal { get; init; }
        public required long RowStart { get; init; }
        public required int RowCount { get; init; }
        public required string Partition { get; init; } // partition id (base64url), or "*"
        public required SectionRef[] Parts { get; init; }
        public required ColumnStats[] Stats { get; init; }
    }

    /// <summary>A chunk handed to a worker: its sections (pooled buffers) arrive in order and are written by the calling thread.</summary>
    private sealed record PendingChunk(WrittenChunk Entry, Task<(byte[] Buffer, int Length, byte[]? Digest)[]> Work);

    /// <summary>A table to write, checked (spec 6.2). Partition columns and column groups belong to access-controlled files.</summary>
    private sealed record TableSpec(string Name, JazminColumn[] Columns, IReadOnlyList<string>? SortedBy, int[]? SortCols, int ChunkRows,
        int ChunkBytes, string? PartitionBy, int PartitionCol, List<(string Name, int[] Cols)> ColumnGroups);

    [ThreadStatic]
    private static ByteWriter? _payloadWriter; // per-thread payload buffer, reused
    [ThreadStatic]
    private static ByteWriter? _scratchWriter;

    private readonly Queue<PendingChunk> _pending = new();

    private readonly Stream _output;
    private readonly bool _leaveOpen;
    private JazminColumn[] _columns = []; // the current table's (see BeginTable)
    private Dictionary<string, int> _ordinals = new();
    private readonly JazminWriteOptions _options;
    private readonly byte[] _fileId;
    private readonly byte[] _salt;
    private readonly JazminReader.AppendStateInfo? _continue; // append mode: the file being continued
    private readonly bool _indexDeltas; // sorted index pages with keys and first row ids as differences ('index-deltas')
    private bool _usesIndexDeltas; // a page was written that way: the header names the feature
    private readonly KeySchedule? _keys; // key or password files
    private readonly AccessConfig? _access; // access mode: the grants
    private readonly FileSecrets? _secrets; // access mode
    private readonly TableSpec[] _tables; // the tables to write
    private readonly List<string> _allGroupNames; // column groups of every table (grants of all columns get them all)
    private readonly Dictionary<int, (TableDef Table, List<IndexRef> Indexes, OwnerTable? Map)> _written = new(); // by table number, once written
    private readonly List<SectionRef> _deltas; // append deltas (spec 11.2)
    private TableSpec _current = null!; // the table rows go to
    private int _tableIndex; // its number in the file
    private Part[] _parts = [];
    private int _firstOrdinal;
    private readonly Dictionary<string, FileEntry> _fileEntries = new(StringComparer.Ordinal); // embedded files by path
    private readonly Dictionary<string, StoredContent> _contents = new(StringComparer.Ordinal); // by SHA-256: stored once
    private int _nextContent;
    private JsonObject? _packageJson;
    private bool _packageSet;
    private List<string> _fileGroupNames = new();
    private readonly List<WrittenChunk> _chunks = new();
    private readonly List<(int Col, string Column, string Kind, IIndexBuilder Builder)> _indexBuilders = new();
    private object?[] _normalized = []; // reused per row
    private (NestedColumn Stager, NestedStage Stage)[]? _stagers; // nested columns: values are checked before any buffer takes them
    private int[]? _sortCols;
    private object?[]? _lastSortKey;
    private object?[]? _sortKeyScratch;
    private string? _chunkPartition;
    private int _chunkRows;
    private long _position;
    private bool _finished;
    private bool _faulted;

    public JazminWriter(Stream output, IEnumerable<JazminColumn> columns, JazminWriteOptions? options = null, bool leaveOpen = false)
        : this(output, columns ?? throw new ArgumentNullException(nameof(columns)), options, leaveOpen, null)
    {
    }

    /// <summary>A file with several tables: <see cref="JazminWriteOptions.Tables"/> lists them; rows go to the first until <see cref="StartTable"/>.</summary>
    public JazminWriter(Stream output, JazminWriteOptions options, bool leaveOpen = false)
        : this(output, null, options ?? throw new ArgumentNullException(nameof(options)), leaveOpen, null)
    {
    }

    private JazminWriter(Stream output, IEnumerable<JazminColumn>? columns, JazminWriteOptions? options, bool leaveOpen,
        JazminReader.AppendStateInfo? cont)
    {
        _output = output ?? throw new ArgumentNullException(nameof(output));
        _continue = cont;
        _leaveOpen = leaveOpen;
        _options = options ?? new JazminWriteOptions();
        // An append keeps the file's index encoding: its readers already support it (or the file would not use it).
        _indexDeltas = cont is not null ? cont.Header.ReaderFeatures.Contains(FormatConstants.IndexDeltas) : _options.CompactIndexes;
        if (_options.Key is not null && _options.Password is not null) throw new JazminValidationException("Supply either Key or Password, not both");
        if (_options.Password is not null && _options.KdfIterations is < FormatConstants.MinKdfIterations or > FormatConstants.MaxKdfIterations)
            throw new JazminValidationException($"KdfIterations must be from {FormatConstants.MinKdfIterations} to {FormatConstants.MaxKdfIterations}");

        var access = _options.Access;
        if (_options.Tables is { } tables)
        {
            if (tables.Count == 0) throw new JazminValidationException("Tables must list at least one table");
            if (columns is not null || _options.SortedBy is not null || access?.PartitionBy is not null || access?.ColumnGroups.Count > 0)
                throw new JazminValidationException("With Tables, give the columns, SortedBy, PartitionBy and ColumnGroups in each table");
            _tables = tables.Select(t => Spec(t.Name, t.Columns, t.SortedBy, t.PartitionBy, t.ColumnGroups, t.ChunkRows, t.ChunkBytes, named: true)).ToArray();
            var twice = _tables.GroupBy(t => t.Name, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1);
            if (twice is not null) throw new JazminValidationException($"Table '{twice.Key}' is declared twice");
        }
        else
        {
            if (columns is null) throw new JazminValidationException("Give the columns, or the Tables option");
            _tables = [Spec(cont?.Table.Name ?? "", columns, _options.SortedBy, access?.PartitionBy, access?.ColumnGroups, null, null, named: false)];
        }
        // Column groups a grant may name: those of every table (when appending, of the file's other tables too).
        _allGroupNames = _tables.SelectMany(t => t.ColumnGroups.Select(g => g.Name))
            .Concat((cont?.Header.Tables ?? []).SelectMany(t => t.ColumnGroups.Select(g => g.Name))).Distinct().ToList();

        var encrypted = _options.Key is not null || _options.Password is not null;
        _fileId = cont?.FileId ?? RandomNumberGenerator.GetBytes(FormatConstants.FileIdSize);
        _salt = cont?.Salt ?? (encrypted ? RandomNumberGenerator.GetBytes(FormatConstants.SaltSize) : new byte[FormatConstants.SaltSize]);
        if (_options.Access is not null)
        {
            if (_options.Key is null) throw new JazminValidationException("An access-controlled file needs the owner's master key as Key");
            _access = AccessConfig.NormalizeGrants(_options.Access.Grants, _allGroupNames.ToHashSet(StringComparer.Ordinal), Now);
            var ownerFingerprint = OwnerSigning.Fingerprint(OwnerSigning.Derive(_options.Key.Bytes).PublicKey);
            foreach (var grant in _access.Grants)
                if (!grant.Key.OwnerFingerprint.SequenceEqual(ownerFingerprint))
                    throw new JazminValidationException($"Access key {grant.Key.Id} was issued by a different owner key");
            // Same file, same secrets when appending: new sections must be readable with those already in use.
            _secrets = cont is not null ? new FileSecrets(_salt, cont.OwnerSecrets!.Header, cont.OwnerSecrets.Owner) : new FileSecrets(_salt);
            _secrets.RecordPartitions((cont?.Directory?["partitions"]?.AsArray() ?? []).Select(name => (string)name!));
        }
        else
        {
            if (cont is not null)
            {
                _keys = cont.Keys;
            }
            else if (encrypted)
            {
                var master = _options.Password is not null
                    ? Crypto.DeriveFromPassword(_options.Password, _salt, _options.KdfIterations)
                    : _options.Key!.ToBytes();
                _keys = new KeySchedule(master, _salt)
                {
                    // The 'files' group is added only when files are stored.
                    Keyring = new Dictionary<string, byte[]>
                    {
                        [FormatConstants.KeyringData] = RandomNumberGenerator.GetBytes(32),
                        [FormatConstants.KeyringIndex] = RandomNumberGenerator.GetBytes(32),
                    },
                };
            }
        }
        _deltas = new List<SectionRef>(cont?.Header.Deltas ?? []);
        BeginTable(_tables[0], cont?.TableIndex ?? 0);
        if (cont is null)
        {
            Write(Preamble());
        }
        else
        {
            _output.SetLength(cont.ValidEnd); // cut off anything left by an interrupted earlier append
            WriteFlags((ushort)(cont.Flags | FormatConstants.FlagAppended)); // set before anything else is written (spec 11.2)
            _output.Position = _position = cont.ValidEnd;
        }
        if (cont?.Files is { } carried)
        {
            // Files already in the file stay; their stored contents are reused by reference.
            foreach (var e in carried.Entries) _fileEntries[e.Path] = e;
            foreach (var c in carried.Contents) _contents[c.Sha256] = c;
            _nextContent = carried.NextId;
            _packageJson = carried.Package;
        }
        if (_options.Package is not null) _packageSet = true;
        foreach (var file in _options.Files ?? []) AddFile(file);
    }

    /// <summary>Embeds a file (spec 6.8). Identical content is stored once; adding a path twice is an error.</summary>
    public void AddFile(JazminFileInput file) => AddSource(FileSource.From(file));

    /// <summary>Embeds a file from bytes.</summary>
    public void AddFile(string path, byte[] content, string? type = null, IReadOnlyList<string>? groups = null) =>
        AddFile(new JazminFileInput(path, content) { Type = type, Groups = groups });

    internal void AddSource(FileSource source)
    {
        if (_finished) throw new InvalidOperationException("Writer is already finished");
        DrainPending(all: true); // file blocks are written directly, after the chunks before them
        if (_fileEntries.ContainsKey(source.Path)) throw new JazminValidationException($"File '{source.Path}' is added twice");
        if (!_contents.TryGetValue(source.Sha256, out var stored))
        {
            var id = _nextContent++;
            var key = _keys is not null || _access is not null ? RandomNumberGenerator.GetBytes(32) : null; // one random key per stored content
            var blocks = new List<(long Offset, int Length, string? Digest)>();
            for (long offset = 0, b = 0; offset < source.Size; offset += EmbeddedFiles.BlockSize, b++)
            {
                var raw = source.Read(offset, (int)Math.Min(EmbeddedFiles.BlockSize, source.Size - offset));
                var sectionId = $"file/{id}/{b}";
                var section = Section(raw, sectionId, key is null ? null : Crypto.Hkdf(key, _salt, $"JAZMIN/1/{sectionId}"));
                blocks.Add((_position, section.Length, _access is not null ? AccessCrypto.DigestText(section) : null));
                Write(section);
            }
            stored = new StoredContent { Id = id, Size = source.Size, Sha256 = source.Sha256, Key = key, Blocks = blocks };
            _contents[source.Sha256] = stored;
        }
        _fileEntries[source.Path] = new FileEntry(source.Path, source.Type, stored.Id, source.Groups, source.Actions);
    }

    /// <summary>Writes the file directories (one per file group in access-controlled files); returns the header member.</summary>
    private FilesInfo WriteFileDirectories(int segment)
    {
        var entries = _fileEntries.Values.OrderBy(e => e.Path, StringComparer.Ordinal).ToList();
        var byId = _contents.Values.ToDictionary(c => c.Id);
        JsonObject Directory(IEnumerable<FileEntry> list, bool withGroups)
        {
            var files = list.ToList();
            return new JsonObject
            {
                ["files"] = new JsonArray(files.Select(e =>
                {
                    var entry = new JsonObject { ["path"] = e.Path, ["type"] = e.Type, ["content"] = e.Content };
                    if (withGroups) entry["groups"] = new JsonArray((e.Groups ?? [EmbeddedFiles.Everyone]).Select(g => (JsonNode?)g).ToArray());
                    if (e.Actions is not null) entry["actions"] = e.Actions.DeepClone();
                    return (JsonNode?)entry;
                }).ToArray()),
                ["contents"] = new JsonArray(files.Select(e => e.Content).Distinct().Order().Select(id => (JsonNode?)byId[id].ToJson()).ToArray()),
            };
        }
        var package = _packageSet ? EmbeddedFiles.PackageJson(_options.Package, _fileEntries.Keys) : _packageJson;
        if (!_packageSet && package?["entry"] is { } entry && !_fileEntries.ContainsKey((string)entry!))
            throw new JazminValidationException($"package.entry '{entry}' is not one of the stored files");
        var suffix = segment > 0 ? $"/{segment}" : "";
        var directories = new List<(string, SectionRef)>();
        void WriteDirectory(string group, string sectionId, JsonObject json, byte[]? key) =>
            directories.Add((group, WriteSection(Encoding.UTF8.GetBytes(json.ToJsonString()), sectionId, key)));
        if (_access is null)
        {
            if (_keys is not null && !_keys.Keyring.ContainsKey(FormatConstants.KeyringFiles)) _keys.Keyring[FormatConstants.KeyringFiles] = RandomNumberGenerator.GetBytes(32);
            var sectionId = $"files/dir{suffix}";
            WriteDirectory(EmbeddedFiles.Everyone, sectionId, Directory(entries, true), _keys?.SectionKey(FormatConstants.KeyringFiles, sectionId));
        }
        else
        {
            _fileGroupNames = entries.SelectMany(e => e.Groups ?? [EmbeddedFiles.Everyone]).Distinct().Order(StringComparer.Ordinal).ToList();
            foreach (var name in _fileGroupNames)
            {
                var id = _secrets!.PartitionId(name); // same opaque HMAC id as partitions
                var sectionId = $"files/dir/{id}{suffix}";
                WriteDirectory(id, sectionId, Directory(entries.Where(e => (e.Groups ?? [EmbeddedFiles.Everyone]).Contains(name)), false),
                    Crypto.Hkdf(_secrets.FileGroupSecret(id), _salt, $"JAZMIN/1/{sectionId}"));
            }
        }
        // nextContent: content ids are never reused, so block section ids stay unique across appends.
        return new FilesInfo { Directories = directories, NextContent = _nextContent, Package = package?.ToJsonString() ?? "", Segment = segment };
    }

    /// <summary>Continues an existing file at its end (used by <see cref="JazminFile.Append"/>).</summary>
    internal static JazminWriter Continue(string path, IEnumerable<JazminColumn> columns, JazminWriteOptions options, JazminReader.AppendStateInfo state) =>
        new(new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete, 1 << 16), columns, options, false, state);

    private void WriteFlags(ushort flags)
    {
        var bytes = new byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(bytes, flags);
        _output.Position = FormatConstants.FlagsOffset;
        _output.Write(bytes);
    }

    /// <summary>Flushes to disk, so a trailer is never persisted before the data it points to.</summary>
    private void SyncToDisk()
    {
        if (_output is FileStream file) file.Flush(flushToDisk: true);
        else _output.Flush();
    }

    /// <summary>Creates (overwrites) a file.</summary>
    public static JazminWriter Create(string path, IEnumerable<JazminColumn> columns, JazminWriteOptions? options = null) =>
        new(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16), columns, options);

    /// <summary>Creates (overwrites) a file with several tables (<see cref="JazminWriteOptions.Tables"/>).</summary>
    public static JazminWriter Create(string path, JazminWriteOptions options) =>
        new(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16), options);

    /// <summary>Columns of the table rows go to.</summary>
    public IReadOnlyList<JazminColumn> Columns => _columns;

    /// <summary>Rows written to the current table.</summary>
    public long RowCount { get; private set; }

    /// <summary>Name of the table rows go to.</summary>
    public string TableName => _current.Name;

    /// <summary>
    /// Starts another table declared in <see cref="JazminWriteOptions.Tables"/>: rows written from now on go to it. Tables
    /// can be written in any order, each once; the file lists them in the order they were declared, and a table never
    /// started is written empty.
    /// </summary>
    public void StartTable(string name)
    {
        if (_finished) throw new JazminValidationException("Writer is already finished");
        var index = _continue is null ? Array.FindIndex(_tables, t => t.Name == name) : -1;
        if (index < 0) throw new JazminValidationException($"StartTable: no table '{name}' was declared in Tables");
        if (index == _tableIndex || _written.ContainsKey(index)) throw new JazminValidationException($"Table '{name}' has already been written");
        EndTable();
        BeginTable(_tables[index], index);
    }

    /// <summary>A table's definition, checked (spec 6.2).</summary>
    private TableSpec Spec(string name, IEnumerable<JazminColumn> columnList, IReadOnlyList<string>? sortedBy, string? partitionBy,
        Dictionary<string, string[]>? columnGroups, int? chunkRows, int? chunkBytes, bool named)
    {
        if (named && string.IsNullOrEmpty(name)) throw new JazminValidationException("Each table needs a name");
        var columns = columnList.ToArray();
        TypeNames.Validate(columns);
        var rows = chunkRows ?? _options.ChunkRows;
        if (rows < 1) throw new JazminValidationException("ChunkRows must be positive");
        int[]? sortCols = null;
        if (sortedBy is not null)
        {
            if (sortedBy.Count == 0) throw new JazminValidationException("SortedBy must name at least one column");
            sortCols = sortedBy.Select(n => Array.FindIndex(columns, c => c.Name == n) is var i and >= 0
                ? i : throw new JazminValidationException($"SortedBy: unknown column '{n}'")).ToArray();
            foreach (var i in sortCols)
                if (TypeNames.IsNested(columns[i].Type)) throw new JazminValidationException($"SortedBy: a {TypeNames.ToName(columns[i].Type)} column cannot be sorted");
        }
        if (_options.Access is null)
        {
            if (partitionBy is not null || columnGroups is { Count: > 0 })
                throw new JazminValidationException("PartitionBy and ColumnGroups need an access-controlled file (the Access option)");
            return new TableSpec(name, columns, sortedBy, sortCols, rows, chunkBytes ?? _options.ChunkBytes, null, -1,
                [(FormatConstants.DefaultColumnGroup, Enumerable.Range(0, columns.Length).ToArray())]);
        }
        var layout = AccessConfig.NormalizeTable(partitionBy, columnGroups ?? new(), columns);
        foreach (var i in sortCols ?? [])
        {
            if (layout.ColumnGroups[0].Name != FormatConstants.DefaultColumnGroup || !layout.ColumnGroups[0].Cols.Contains(i))
                throw new JazminValidationException($"The SortedBy column '{columns[i].Name}' must stay in the default column group");
        }
        return new TableSpec(name, columns, sortedBy, sortCols, rows, chunkBytes ?? _options.ChunkBytes, layout.PartitionBy, layout.PartitionCol, layout.ColumnGroups);
    }

    /// <summary>Makes <paramref name="table"/> (table <paramref name="index"/> of the file) the table rows go to.</summary>
    private void BeginTable(TableSpec table, int index)
    {
        _current = table;
        _tableIndex = index;
        _columns = table.Columns;
        _ordinals = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < _columns.Length; i++) _ordinals[_columns[i].Name] = i;
        _normalized = new object?[_columns.Length];
        _stagers = _columns.Any(c => TypeNames.IsNested(c.Type))
            ? [.. _columns.Select(c => TypeNames.IsNested(c.Type) ? ((NestedColumn)Nested.Buffer(c, _options.Serializer), new NestedStage()) : default)]
            : null;
        _sortCols = table.SortCols;
        _lastSortKey = null;
        _sortKeyScratch = null;
        _directDates = null;
        _parts = table.ColumnGroups.Select(g => new Part(g.Name, g.Cols)).ToArray();
        _chunks.Clear();
        _chunkPartition = null;
        _indexBuilders.Clear();
        for (var i = 0; i < _columns.Length; i++)
        {
            foreach (var kind in _columns[i].Indexes.Distinct())
            {
                // Readers find the leading SortedBy column's values from chunk statistics and have never used its
                // sorted index (spec 6.7): it is not written.
                if (kind == JazminIndexKind.Sorted && table.SortCols is [var leading, ..] && leading == i) continue;
                IIndexBuilder builder = kind == JazminIndexKind.Sorted ? new SortedIndexBuilder(_columns[i].Type) : new TrigramIndexBuilder();
                _indexBuilders.Add((i, _columns[i].Name, TypeNames.IndexName(kind), builder));
            }
        }
        var cont = _continue;
        RowCount = cont?.Table.RowCount ?? 0;
        _firstOrdinal = cont?.Table.ChunkCount ?? 0;
        if (cont is not null && _sortCols is not null && cont.LastRow is not null)
        {
            _lastSortKey = _sortCols.Select(i =>
            {
                var v = Values.Normalize(_columns[i].Type, cont.LastRow[i], _columns[i].Name);
                return v is null ? null : Values.ToKey(_columns[i].Type, v);
            }).ToArray();
        }
        ResetChunk();
    }

    /// <summary>Writes the current table's last chunk, indexes, statistics and directories, and keeps its catalog entry.</summary>
    private void EndTable()
    {
        FlushChunk();
        DrainPending(all: true);
        var cont = _continue;
        var segment = cont is null ? 0 : cont.Header.AppendCount + 1;
        var indexes = new List<IndexRef>(cont?.Indexes ?? []);
        // A new file always lists its indexes, even without rows, so appends and updates keep them.
        if (cont is null || _chunks.Count > 0) indexes.AddRange(WriteIndexes(segment));
        var written = WriteDirectories();
        var table = new TableDef
        {
            Name = _current.Name,
            ColumnCount = _columns.Length,
            ColumnGroups = ColumnGroupDefs(),
            SortedBy = _current.SortedBy?.ToList() ?? new List<string>(),
            PartitionBy = _current.PartitionBy ?? "",
            RowCount = RowCount,
            DeletedCount = cont?.Deleted.Length ?? 0,
            ChunkCount = _firstOrdinal + _chunks.Count,
            Indexes = _access is null ? indexes : new List<IndexRef>(),
            Deletes = cont?.Table.Deletes,
        };
        PlacePartitions(table, written, _deltas);
        if (cont is not null && cont.Deleted.Length > 0 && cont.Deleted.Length != cont.Table.DeletedCount)
        {
            var sectionId = $"{_tableIndex}/deletes/{cont.Deleted.Length}"; // the count only grows, so the id is unique
            table.Deletes = WriteSection(RowSet.EncodeSection(cont.Deleted), sectionId, Key(sectionId, _secrets?.Header));
        }
        _written[_tableIndex] = (table, indexes, _access is null ? null : WriteChunkMap(segment));
    }

    /// <summary>
    /// The table's chunk map (spec 7.6.5): every chunk's row count and partition, by ordinal, so the owner finds a row's
    /// partition without reading every partition's chunk directory. A full write writes it whole (section
    /// <c>&lt;t&gt;/chunkmap</c>); an append writes the chunks appended since (<c>&lt;t&gt;/chunkmap/&lt;segment&gt;</c>:
    /// the earlier appends' and its own) and keeps the whole one. A file without one gets none until its next full write.
    /// Returns the owner catalog's entry for the table, less its indexes.
    /// </summary>
    private OwnerTable WriteChunkMap(int segment)
    {
        var none = new OwnerTable(_tableIndex, new List<IndexRef>());
        if (!_options.ChunkMap) return none;
        // This writer's chunks.
        var written = ChunkMap.Empty();
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var chunk in _chunks)
        {
            if (!index.TryGetValue(chunk.Partition, out var at))
            {
                at = written.Partitions.Count;
                index[chunk.Partition] = at;
                written.Partitions.Add(chunk.Partition);
            }
            written.RowCounts.Add(chunk.RowCount);
            written.PartitionOf.Add(at);
        }
        byte[] OwnerKey(string sectionId) => AccessCrypto.SectionKey(_secrets!.Owner, _salt, sectionId);
        var cont = _continue;
        if (cont is null)
        {
            var sectionId = $"{_tableIndex}/chunkmap";
            return none with { ChunkMap = WriteSection(Catalog.EncodeChunkMap(written), sectionId, OwnerKey(sectionId)) };
        }
        if (cont.ChunkMap is not { } state || state.Chunks != _firstOrdinal) return none; // the file has none, or it does not cover every chunk
        var appended = state.Appended is null ? written : Catalog.JoinChunkMaps(state.Appended, written)!;
        var appendedId = $"{_tableIndex}/chunkmap/{segment}";
        return none with { ChunkMap = state.Base, ChunkMapAppended = WriteSection(Catalog.EncodeChunkMap(appended), appendedId, OwnerKey(appendedId)), ChunkMapSegment = segment };
    }

    /// <summary>Grants left out because they had already expired (access-controlled files).</summary>
    internal int ExpiredGrants => _access?.ExpiredGrants ?? 0;

    private DateTimeOffset Now => _options.Now ?? DateTimeOffset.UtcNow;

    private static string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    private void ResetChunk()
    {
        foreach (var part in _parts)
        {
            part.Bytes = 0;
            // The previous buffers now belong to the worker encoding them: take recycled ones, or new ones.
            part.Columns = part.Free.TryDequeue(out var recycled) ? recycled : part.Cols.Select(i => Nested.Buffer(_columns[i], _options.Serializer)).ToArray();
        }
        _chunkRows = 0;
    }

    private byte[] Preamble()
    {
        var buf = new byte[FormatConstants.PreambleSize];
        FormatConstants.Magic.CopyTo(buf);
        ushort flags = 0;
        if (_keys is not null || _access is not null) flags |= FormatConstants.FlagEncrypted;
        if (_options.Password is not null) flags |= FormatConstants.FlagPassword;
        if (_access is not null) flags |= FormatConstants.FlagAccess;
        BinaryPrimitives.WriteUInt16LittleEndian(buf.AsSpan(FormatConstants.FlagsOffset), flags);
        _fileId.CopyTo(buf, 8);
        _salt.CopyTo(buf, 24);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(56), _options.Password is not null ? (uint)_options.KdfIterations : 0);
        return buf;
    }

    private void Write(byte[] data)
    {
        _output.Write(data);
        _position += data.Length;
    }

    private byte[] Section(ReadOnlySpan<byte> raw, string sectionId, byte[]? key, JazminCodec? codec = null) =>
        SectionCodec.Encode(raw, codec ?? _options.Codec, _options.CompressionLevel, key, _fileId, sectionId);

    private const int TinySection = 256; // raw bytes below which catalog sections are not compressed

    /// <summary>
    /// Writes a catalog section and returns its reference (with its digest in access-controlled files). Tiny ones
    /// (statistics and directories of small partitions) are stored uncompressed: compression would save a few bytes at
    /// most, and each call costs time and memory.
    /// </summary>
    private SectionRef WriteSection(ReadOnlySpan<byte> raw, string sectionId, byte[]? key, JazminCodec? codec = null) =>
        WriteEncoded(Section(raw, sectionId, key, codec ?? (raw.Length < TinySection ? JazminCodec.None : null)));

    /// <summary>Writes an encoded section and returns its reference (with its digest in access-controlled files).</summary>
    private SectionRef WriteEncoded(byte[] section)
    {
        var at = new SectionRef(_position, section.Length, _access is not null ? AccessCrypto.Digest(section) : null);
        Write(section);
        return at;
    }

    /// <summary>Key of a catalog section: a keyring group (key/password files), or derived from <paramref name="secret"/> (spec 7.6.3).</summary>
    private byte[]? Key(string sectionId, byte[]? secret, string group = FormatConstants.KeyringData) =>
        _access is not null ? AccessCrypto.SectionKey(secret!, _salt, sectionId) : _keys?.SectionKey(group, sectionId);

    /// <summary>Appends a row given as name/value pairs. Unknown names are rejected.</summary>
    public void WriteRow(IReadOnlyDictionary<string, object?> row)
    {
        var values = new object?[_columns.Length];
        foreach (var (name, value) in row)
        {
            if (!_ordinals.TryGetValue(name, out var i)) Fault($"Row {RowCount}: unknown column '{name}'");
            values[i] = value;
        }
        WriteValues(values);
    }

    /// <summary>Appends a row given as values in column order (fastest).</summary>
    public void WriteValues(params object?[] values)
    {
        if (_finished) throw new JazminValidationException("Writer is already finished");
        if (values.Length != _columns.Length) Fault($"Row {RowCount}: expected {_columns.Length} values, got {values.Length}");
        var normalized = _normalized;
        try
        {
            var directDates = _directDates ??= DirectDateColumns();
            for (var i = 0; i < _columns.Length; i++)
            {
                if (directDates[i] && values[i] is { } raw && Values.ToEpochMs(raw) is { } ms)
                {
                    _dateMs[i] = ms; // stored straight into the column buffer: no boxed long per value
                    normalized[i] = DateMarker;
                    continue;
                }
                normalized[i] = Values.Normalize(_columns[i].Type, values[i], _columns[i].Name, _options.JsonOptions);
                if (normalized[i] is null && !_columns[i].Nullable) Fault($"Row {RowCount}: column '{_columns[i].Name}' is not nullable");
                if (normalized[i] is { } nested && _stagers?[i].Stage is { } stage)
                {
                    stage.Clear();
                    _stagers[i].Stager.Stage(nested, stage);
                    normalized[i] = stage;
                }
            }
            if (_sortCols is not null) CheckOrder(normalized);
        }
        catch (JazminValidationException)
        {
            _faulted = true;
            throw;
        }

        if (_access is not null)
        {
            // A chunk holds exactly one partition, so a key can be granted whole chunks.
            var partition = _current.PartitionCol >= 0 ? AccessCrypto.PartitionName(normalized[_current.PartitionCol]) : FormatConstants.WholeTable;
            if (_chunkRows > 0 && partition != _chunkPartition) FlushChunk();
            _chunkPartition = partition;
        }

        // Values are collected per column, in typed buffers, and encoded when the chunk is flushed.
        var bytes = 0;
        foreach (var part in _parts)
        {
            var cols = part.Cols;
            var buffers = part.Columns;
            for (var j = 0; j < cols.Length; j++)
            {
                var value = normalized[cols[j]];
                if (ReferenceEquals(value, DateMarker)) ((LongColumn)buffers[j]).AddLong(_dateMs[cols[j]]);
                else buffers[j].Add(value);
                part.Bytes += buffers[j] is NestedColumn nested ? (int)nested.TakeBytes() : EstimateSize(value);
            }
            bytes += part.Bytes;
        }
        foreach (var ix in _indexBuilders) ix.Builder.Add(RowCount, normalized[ix.Col]);

        RowCount++;
        _chunkRows++;
        if (_chunkRows >= _current.ChunkRows || bytes >= _current.ChunkBytes) FlushChunk();
    }

    /// <summary>Approximate encoded size of a normalized value, used to cap chunks at ChunkBytes.</summary>
    private static int EstimateSize(object? value) => value switch
    {
        null => 0,
        string s => s.Length + 1,
        byte[] b => b.Length + 2,
        double => 8,
        bool => 1,
        _ => 5,
    };

    /// <summary>
    /// The current chunk's payload for one column group, as a function a worker can run: the typed buffers are
    /// encoded there, then reset and returned for a later chunk.
    /// </summary>
    private static Action<ByteWriter> Payload(Part part)
    {
        var columns = part.Columns;
        var free = part.Free;
        return output =>
        {
            var scratch = _scratchWriter ??= new ByteWriter(64 * 1024);
            foreach (var column in columns) column.Encode(output, scratch);
            foreach (var column in columns) column.Reset();
            free.Enqueue(columns); // reused for a later chunk
        };
    }

    /// <summary>Writes finished chunks in order: all of them, or just those already done (bounding work in flight).</summary>
    private void DrainPending(bool all)
    {
        while (_pending.Count > 0 && (all || _pending.Count > _options.MaxDegreeOfParallelism || _pending.Peek().Work.IsCompleted))
        {
            var chunk = _pending.Dequeue();
            var sections = chunk.Work.GetAwaiter().GetResult(); // rethrows a worker's exception here
            for (var g = 0; g < sections.Length; g++)
            {
                var (buffer, length, digest) = sections[g];
                chunk.Entry.Parts[g] = new SectionRef(_position, length, digest);
                _output.Write(buffer, 0, length);
                _position += length;
                System.Buffers.ArrayPool<byte>.Shared.Return(buffer);
            }
        }
    }

    private static readonly object DateMarker = new(); // "this date is in _dateMs" (fast path)
    private bool[]? _directDates;
    private long[] _dateMs = [];

    /// <summary>Date columns that only feed the column buffers (not sort keys, indexes or partitions).</summary>
    private bool[] DirectDateColumns()
    {
        _dateMs = new long[_columns.Length];
        var used = new HashSet<int>(_sortCols ?? []);
        foreach (var ix in _indexBuilders) used.Add(ix.Col);
        if (_current.PartitionCol >= 0) used.Add(_current.PartitionCol);
        return _columns.Select((c, i) => c.Type == JazminType.DateTime && !used.Contains(i)).ToArray();
    }

    private void CheckOrder(object?[] normalized)
    {
        // Two key arrays are reused (current and previous row): no allocation per row.
        var cols = _sortCols!;
        var key = _sortKeyScratch ??= new object?[cols.Length];
        for (var k = 0; k < cols.Length; k++)
        {
            var value = normalized[cols[k]];
            key[k] = value is null ? null : Values.ToKey(_columns[cols[k]].Type, value);
        }
        if (_lastSortKey is not null && SortKeys.Compare(_lastSortKey, key) > 0)
            Fault($"Row {RowCount} is out of order for SortedBy [{string.Join(", ", _current.SortedBy!)}]");
        _sortKeyScratch = _lastSortKey;
        _lastSortKey = key;
    }

    private void Fault(string message)
    {
        _faulted = true;
        throw new JazminValidationException(message);
    }

    private void FlushChunk()
    {
        if (_chunkRows == 0) return;
        var ordinal = _firstOrdinal + _chunks.Count;
        var partition = _access is null ? FormatConstants.WholeTable : _secrets!.AddPartition(_chunkPartition!);
        var stats = new ColumnStats[_columns.Length];
        foreach (var part in _parts)
            for (var j = 0; j < part.Cols.Length; j++) stats[part.Cols[j]] = part.Columns[j].Stats(); // before a worker resets the buffers
        var entry = new WrittenChunk
        {
            Ordinal = ordinal, RowStart = RowCount - _chunkRows, RowCount = _chunkRows, Partition = partition,
            Parts = new SectionRef[_parts.Length], Stats = stats,
        };
        _chunks.Add(entry);
        var partitionSecret = _access is null ? null : _secrets!.PartitionSecret(partition);
        var jobs = _parts.Select(part =>
        {
            var sectionId = FormatConstants.ChunkSectionId(_tableIndex, ordinal, part.Name);
            var key = _access is not null
                ? AccessCrypto.PartKey(partitionSecret!, _secrets!.ColumnSecret(part.Name), _salt, sectionId)
                : _keys?.SectionKey(FormatConstants.KeyringData, sectionId);
            return (SectionId: sectionId, Key: key, Payload: Payload(part));
        }).ToList();
        var digests = _access is not null;
        var (codec, level, fileId) = (_options.Codec, _options.CompressionLevel, _fileId);
        (byte[], int, byte[]?)[] Work() => jobs.Select(j =>
        {
            var payload = _payloadWriter ??= new ByteWriter(256 * 1024);
            payload.Reset();
            j.Payload(payload);
            var (buffer, length) = SectionCodec.EncodePooled(payload.AsSpan(), codec, level, j.Key, fileId, j.SectionId);
            return (buffer, length, digests ? AccessCrypto.Digest(buffer.AsSpan(0, length)) : null);
        }).ToArray();
        var work = _options.MaxDegreeOfParallelism > 1 ? Task.Run(Work) : Task.FromResult(Work());
        _pending.Enqueue(new PendingChunk(entry, work));
        ResetChunk();
        DrainPending(all: false);
    }

    /// <summary>Writes the catalog, header (and key slots and signature) and trailer, then closes the output (unless leaveOpen).</summary>
    public void Finish()
    {
        if (_finished) return;
        EndTable();
        if (_continue is null)
        {
            // Declared tables that were never started are written empty.
            for (var i = 0; i < _tables.Length; i++)
            {
                if (_written.ContainsKey(i)) continue;
                BeginTable(_tables[i], i);
                EndTable();
            }
        }

        var cont = _continue;
        var segment = cont is null ? 0 : cont.Header.AppendCount + 1;
        var tables = cont is null
            ? Enumerable.Range(0, _tables.Length).Select(i => _written[i].Table).ToList()
            : cont.Header.Tables.Select((t, i) => _written.TryGetValue(i, out var w) ? w.Table : t).ToList();
        var deltas = _deltas;
        // Features are named when, and only when, the file uses them (spec 12); an append keeps the file's.
        var readerFeatures = new List<string>(cont?.Header.ReaderFeatures ?? []);
        if (_usesIndexDeltas && !readerFeatures.Contains(FormatConstants.IndexDeltas)) readerFeatures.Add(FormatConstants.IndexDeltas);
        if (!readerFeatures.Contains(FormatConstants.NestedColumns) && _tables.Any(t => t.Columns.Any(c => TypeNames.IsNested(c.Type))))
            readerFeatures.Add(FormatConstants.NestedColumns);
        var header = new HeaderDef
        {
            ReaderFeatures = readerFeatures,
            WriterFeatures = new List<string>(cont?.Header.WriterFeatures ?? []),
            Created = cont?.Header.Created ?? Now.ToUnixTimeMilliseconds(),
            Modified = cont is null ? 0 : Now.ToUnixTimeMilliseconds(),
            AppendCount = segment,
            Metadata = (_options.Metadata ?? new JsonObject()).ToJsonString(),
            Tables = tables,
            Keyring = _keys?.Keyring,
            Files = _fileEntries.Count > 0 ? WriteFileDirectories(segment) : null,
            Deltas = deltas,
        };

        (long Offset, int Length, byte[] Section)? keySlots = null;
        if (_access is not null)
        {
            const string catalogId = "owner/catalog";
            // Indexes of every table; when appending, the other tables' come from the file.
            var catalog = cont is null
                ? _written.OrderBy(w => w.Key).Select(w => w.Value.Map! with { Indexes = w.Value.Indexes }).ToList()
                : cont.OwnerCatalog!.Where(c => c.Table != _tableIndex)
                    .Append(_written[_tableIndex].Map! with { Indexes = _written[_tableIndex].Indexes }).OrderBy(c => c.Table).ToList();
            var ownerCatalog = WriteSection(Catalog.EncodeOwnerCatalog(catalog), catalogId, AccessCrypto.SectionKey(_secrets!.Owner, _salt, catalogId));
            var directoryText = OwnerDirectoryText();
            var directoryChanged = cont is null || directoryText != cont.DirectoryText;
            var ownerDirectory = directoryChanged
                // Not compressed: its size must not hint at the secrets and names it holds (spec 13, compression side channels).
                ? WriteSection(Encoding.UTF8.GetBytes(directoryText), "owner", AccessCrypto.OwnerDirectoryKey(_secrets.Owner, _salt), JazminCodec.None)
                : cont!.DirectoryRef!;
            header.Access = new AccessRefs(ownerDirectory, ownerCatalog);
            if (directoryChanged)
            {
                // Key slots in pages, then the page list the owner signs (spec 7.6.4). Sealed slots are random bytes:
                // compressing them would only cost time on every open.
                var pages = AccessCrypto.BuildKeySlotPages(KeySlotEntries(), _options.KeySlotPageBytes).Select((page, n) =>
                {
                    var pageSection = Section(page.Raw, $"keyslots/{n}", null, JazminCodec.None);
                    var at = (page.FirstId, _position, pageSection.Length, AccessCrypto.Digest(pageSection));
                    Write(pageSection);
                    return at;
                }).ToList();
                var section = Section(AccessCrypto.BuildKeySlotList(pages), "keyslots", null, JazminCodec.None);
                keySlots = (_position, section.Length, section);
                Write(section);
            }
            else
            {
                keySlots = cont!.KeySlots; // unchanged grants and partitions: the existing slots stay valid (spec 11.2)
            }
        }

        var headerSection = Section(Catalog.EncodeHeader(header), FormatConstants.HeaderSectionId,
            _access is not null ? AccessCrypto.HeaderKey(_secrets!.Header, _salt) : _keys?.HeaderKey);
        var headerOffset = _position;
        Write(headerSection);
        (long Offset, int Length)? signature = null;
        if (_access is not null)
        {
            var section = Section(AccessCrypto.BuildSignature(_options.Key!.Bytes, _fileId, keySlots!.Value.Section, headerSection), "signature", null, JazminCodec.None);
            signature = (_position, section.Length);
            Write(section);
        }
        SyncToDisk(); // data first: a trailer must never point at data that is not on disk yet

        var trailer = new byte[FormatConstants.TrailerSize];
        BinaryPrimitives.WriteUInt64LittleEndian(trailer, (ulong)headerOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(trailer.AsSpan(8), (uint)headerSection.Length);
        BinaryPrimitives.WriteUInt64LittleEndian(trailer.AsSpan(12), (ulong)(keySlots?.Offset ?? 0));
        BinaryPrimitives.WriteUInt32LittleEndian(trailer.AsSpan(20), (uint)(keySlots?.Length ?? 0));
        BinaryPrimitives.WriteUInt64LittleEndian(trailer.AsSpan(24), (ulong)(signature?.Offset ?? 0));
        BinaryPrimitives.WriteUInt32LittleEndian(trailer.AsSpan(32), (uint)(signature?.Length ?? 0));
        BinaryPrimitives.WriteUInt32LittleEndian(trailer.AsSpan(36), Crc32.Compute(trailer.AsSpan(0, 36)));
        FormatConstants.Magic.CopyTo(trailer.AsSpan(40));
        Write(trailer);
        SyncToDisk();

        _finished = true;
        if (!_leaveOpen) _output.Dispose();
    }

    /// <summary>Column groups for the header: definitions inline, or (restricted groups) in their own locked section (spec 7.6.5).</summary>
    private List<ColumnGroupDef> ColumnGroupDefs()
    {
        ColumnDef Definition(int i) => ColumnDef.Of(_columns[i], i);
        var previous = (_continue?.Table.ColumnGroups ?? []).ToDictionary(g => g.Name, StringComparer.Ordinal);
        return _parts.Select(part =>
        {
            if (_access is null || part.Name == FormatConstants.DefaultColumnGroup)
                return new ColumnGroupDef { Name = part.Name, Columns = part.Cols.Select(Definition).ToList() };
            var definitions = previous.GetValueOrDefault(part.Name)?.Definitions;
            if (definitions is null || part.Cols.Any(c => _options.Grown?.Contains(_columns[c].Name) == true)) // new, or nested columns grew
            {
                var sectionId = $"{_tableIndex}/columns/{part.Name}";
                definitions = WriteSection(Catalog.EncodeColumnDefinitions(part.Cols.Select(Definition)), sectionId,
                    AccessCrypto.SectionKey(_secrets!.ColumnSecret(part.Name), _salt, sectionId));
            }
            return new ColumnGroupDef { Name = part.Name, ColumnCount = part.Cols.Length, Definitions = definitions };
        }).ToList();
    }

    /// <summary>Index sections for this writer's rows: one segment per index (spec 8).</summary>
    private List<IndexRef> WriteIndexes(int segment)
    {
        byte[]? IndexKey(string sectionId) => Key(sectionId, _secrets?.Owner, FormatConstants.KeyringIndex);
        var refs = new List<IndexRef>();
        foreach (var ix in _indexBuilders)
        {
            var baseId = FormatConstants.IndexSectionId(_tableIndex, ix.Column, ix.Kind, segment);
            if (ix.Builder is TrigramIndexBuilder trigram)
            {
                refs.Add(new IndexRef(ix.Column, ix.Kind, WriteSection(trigram.Encode(), baseId, IndexKey(baseId)), segment));
                continue;
            }
            // Pages are built a batch at a time (one page per thread) and compressed in parallel, then written in order:
            // only one batch of pages is held at a time.
            var sorted = (SortedIndexBuilder)ix.Builder;
            var pages = new List<IndexPageRef>();
            var batch = new List<(byte[] First, int Count, byte[] Raw)>();
            void WriteBatch()
            {
                var ids = batch.Select((_, i) => $"{baseId}/page/{pages.Count + i}").ToArray();
                var keys = ids.Select(IndexKey).ToArray(); // derived here: key derivation is not shared between threads
                var sections = new byte[batch.Count][];
                Parallel.For(0, batch.Count, new ParallelOptions { MaxDegreeOfParallelism = _options.MaxDegreeOfParallelism }, i =>
                    sections[i] = Section(batch[i].Raw, ids[i], keys[i], batch[i].Raw.Length < TinySection ? JazminCodec.None : null));
                for (var i = 0; i < batch.Count; i++) pages.Add(new IndexPageRef(batch[i].First, batch[i].Count, WriteEncoded(sections[i])));
                batch.Clear();
            }
            foreach (var page in sorted.Pages(_options.IndexPageBytes, _indexDeltas))
            {
                _usesIndexDeltas |= _indexDeltas;
                batch.Add(page);
                if (batch.Count >= _options.MaxDegreeOfParallelism) WriteBatch();
            }
            if (batch.Count > 0) WriteBatch();
            SectionRef? nulls = null;
            if (sorted.Nulls.Count > 0) nulls = WriteSection(RowSet.EncodeSection(sorted.Nulls), $"{baseId}/nulls", IndexKey($"{baseId}/nulls"));
            var directory = Catalog.EncodeIndexDirectory(pages, nulls, _access is not null);
            refs.Add(new IndexRef(ix.Column, ix.Kind, WriteSection(directory, baseId, IndexKey(baseId)), segment));
        }
        return refs;
    }

    /// <summary>
    /// Statistics blocks and one chunk-directory segment per partition this writer added rows to (spec 6.3, 6.4).
    /// Returns the partitions with their new segment, sorted by id.
    /// </summary>
    private List<PartitionDef> WriteDirectories()
    {
        var written = new List<PartitionDef>();
        foreach (var chunks in _chunks.GroupBy(c => c.Partition))
        {
            var partition = chunks.Key;
            var list = chunks.ToList();
            // Segment n of a partition's directory (n > 0 after appends) has ids ending "/n".
            var position = _continue?.SegmentCounts.GetValueOrDefault(partition) ?? 0;
            var suffix = position > 0 ? $"/{position}" : "";
            var secret = _access is null ? null : _secrets!.PartitionSecret(partition);
            // One block per column for a table without partitions (a query loads only its columns' statistics);
            // one block per column group in access-controlled files (few sections however many partitions). Partitions
            // of a single chunk keep theirs too: the owner's searches across all partitions skip chunks with them.
            var blocks = _access is null
                ? Enumerable.Range(0, _columns.Length).Select(i => (Group: FormatConstants.DefaultColumnGroup, Cols: new[] { i })).ToList()
                : _parts.Select(p => (Group: p.Name, Cols: p.Cols)).ToList();
            var statistics = blocks.Select((block, b) =>
            {
                var sectionId = $"{_tableIndex}/stats/{partition}/{b}{suffix}";
                var entries = block.Cols.Select(col =>
                {
                    var bounds = list.Select(c => Bounds.Of(_columns[col].Type, c.Stats[col])).ToList();
                    return new ColumnStatsEntry(list.Select(c => c.Stats[col].Nulls).ToArray(), bounds.Select(x => x.Min).ToArray(), bounds.Select(x => x.Max).ToArray())
                    {
                        Leaves = LeafEntries(list, col),
                    };
                });
                var key = _access is not null
                    ? AccessCrypto.PartKey(secret!, _secrets!.ColumnSecret(block.Group), _salt, sectionId)
                    : _keys?.SectionKey(FormatConstants.KeyringData, sectionId);
                return new StatsBlock(block.Cols, WriteSection(Catalog.EncodeStatistics(entries), sectionId, key));
            }).ToList();
            var directoryId = $"{_tableIndex}/dir/{partition}{suffix}";
            var entriesOut = list.Select(c => new ChunkEntry { Ordinal = c.Ordinal, RowStart = c.RowStart, RowCount = c.RowCount, Parts = c.Parts }).ToList();
            var at = WriteSection(Catalog.EncodeChunkDirectory(entriesOut, statistics, _access is not null), directoryId, Key(directoryId, secret));
            written.Add(new PartitionDef { Id = _access is not null ? Base64Url.Decode(partition) : [], Segments = [at] });
        }
        written.Sort((a, b) => a.Id.AsSpan().SequenceCompareTo(b.Id));
        return written;
    }

    /// <summary>A nested column's leaf statistics over these chunks (spec 6.4): every chunk of a segment has the same leaves.</summary>
    private static LeafStatsEntry[] LeafEntries(List<WrittenChunk> chunks, int col)
    {
        if (chunks[0].Stats[col].Leaves is not { } first) return [];
        return [.. first.Select((leaf, k) =>
        {
            var bounds = chunks.Select(c => Bounds.Of(leaf.Type, c.Stats[col].Leaves![k].Stats)).ToList();
            return new LeafStatsEntry(leaf.Path, [.. chunks.Select(c => c.Stats[col].Leaves![k].Stats.Count)], [.. chunks.Select(c => c.Stats[col].Leaves![k].Stats.Nulls)],
                [.. bounds.Select(x => x.Min)], [.. bounds.Select(x => x.Max)]);
        })];
    }

    /// <summary>
    /// Where the partitions are listed (spec 6.3, 11.2): in the header (at most InlinePartitions), or in a partition-table
    /// section; an append to a file with a partition table, or one that would list too many partitions in the header,
    /// writes a delta with the new segments instead of rewriting the list.
    /// </summary>
    private void PlacePartitions(TableDef table, List<PartitionDef> written, List<SectionRef> deltas)
    {
        var cont = _continue;
        if (cont is null)
        {
            if (written.Count > FormatConstants.InlinePartitions)
            {
                var sectionId = $"{_tableIndex}/partitions";
                // Ids and digests do not compress, and readers scan the table for their own entries: store it as is.
                table.PartitionTable = WriteSection(Catalog.EncodePartitionTable(written), sectionId, Key(sectionId, _secrets?.Header), JazminCodec.None);
            }
            else
            {
                table.Partitions = written;
            }
            return;
        }
        table.Partitions = cont.Table.Partitions.Select(p => new PartitionDef { Id = p.Id, Segments = new List<SectionRef>(p.Segments) }).ToList();
        table.PartitionTable = cont.Table.PartitionTable;
        if (written.Count == 0) return;
        var inline = table.Partitions.ToDictionary(p => Convert.ToHexString(p.Id));
        var added = written.Count(p => !inline.ContainsKey(Convert.ToHexString(p.Id)));
        if (table.PartitionTable is not null || deltas.Count > 0 || inline.Count + added > FormatConstants.InlinePartitions)
        {
            var sectionId = $"delta/{deltas.Count}";
            deltas.Add(WriteSection(Catalog.EncodeDelta(_tableIndex, written), sectionId, Key(sectionId, _secrets?.Header)));
            return;
        }
        foreach (var p in written)
        {
            if (inline.TryGetValue(Convert.ToHexString(p.Id), out var known)) known.Segments.AddRange(p.Segments);
            else table.Partitions.Add(p);
        }
        table.Partitions.Sort((a, b) => a.Id.AsSpan().SequenceCompareTo(b.Id));
    }

    private static JsonNode GrantList(IReadOnlyList<string>? names) =>
        names is null ? JsonValue.Create("*")! : new JsonArray(names.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray());

    /// <summary>
    /// Owner-only JSON with the partition names and the grants (including the access keys, so updates can re-issue
    /// them). Clients never read it, so its size does not affect them.
    /// </summary>
    private string OwnerDirectoryText()
    {
        var directory = new JsonObject
        {
            ["partitions"] = new JsonArray(_secrets!.Names.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()),
        };
        if (_fileGroupNames.Count > 0) directory["fileGroups"] = new JsonArray(_fileGroupNames.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray());
        directory["grants"] = new JsonArray(_access!.Grants.Select(g =>
        {
            var grant = new JsonObject { ["key"] = g.Key.Export(), ["rows"] = GrantList(g.Rows), ["columns"] = GrantList(g.Columns) };
            if (g.Label is not null) grant["label"] = g.Label;
            if (g.Files is { Count: > 0 } files) grant["files"] = files.Contains(EmbeddedFiles.Everyone) ? "*" : new JsonArray(files.Select(f => (JsonNode?)f).ToArray());
            if (g.Expires is { } expires) grant["expires"] = Iso(expires);
            grant["mode"] = g.Mode == JazminGrantMode.Online ? "online" : "offline";
            if (g.Share is not null) grant["share"] = Convert.ToBase64String(g.Share);
            return (JsonNode?)grant;
        }).ToArray());
        return directory.ToJsonString();
    }

    /// <summary>The key-slot payload: one small slot for the owner, one per grant (spec 7.6.4).</summary>
    private List<(byte[] Id, byte[] Sealed, bool Online)> KeySlotEntries()
    {
        var s = _secrets!;
        var allColumns = _allGroupNames;
        var header = Convert.ToBase64String(s.Header);
        var slots = new List<(byte[] Id, byte[] Sealed, bool Online)>
        {
            AccessCrypto.SealSlot(_options.Key!.Bytes, _salt, _fileId, new JsonObject { ["header"] = header, ["owner"] = Convert.ToBase64String(s.Owner) }),
        };
        foreach (var grant in _access!.Grants)
        {
            var partitions = new JsonObject();
            var partitionNames = new JsonObject();
            foreach (var name in grant.Rows ?? (IEnumerable<string>)s.PartitionNames.Values.ToList())
            {
                var id = s.PartitionId(name);
                if (!s.PartitionNames.ContainsKey(id) || partitions.ContainsKey(id)) continue; // not present in this version
                partitions[id] = Convert.ToBase64String(s.PartitionSecret(id));
                partitionNames[id] = name;
            }
            var columns = new JsonObject((grant.Columns ?? allColumns)
                .Select(n => new KeyValuePair<string, JsonNode?>(n, Convert.ToBase64String(s.ColumnSecret(n)))));
            var bundle = new JsonObject { ["header"] = header, ["partitions"] = partitions, ["partitionNames"] = partitionNames, ["columns"] = columns };
            bundle["submission"] = Convert.ToBase64String(_options.Key!.SubmissionKey(grant.Key.Id).Bytes); // what this holder sends back (spec 7.8)
            // File groups this key sees: everyone's, its partitions', and the named ones it was granted.
            var fileSecrets = new JsonObject();
            foreach (var name in _fileGroupNames)
            {
                var id = s.PartitionId(name);
                var visible = name == EmbeddedFiles.Everyone || (grant.Files?.Contains(EmbeddedFiles.Everyone) ?? false) || (grant.Files?.Contains(name) ?? false)
                    || (grant.Rows is null ? s.PartitionNames.ContainsKey(id) : grant.Rows.Contains(name));
                if (visible) fileSecrets[id] = Convert.ToBase64String(s.FileGroupSecret(id));
            }
            if (fileSecrets.Count > 0) bundle["files"] = fileSecrets;
            if (grant.Expires is { } expires) bundle["expires"] = Iso(expires);
            if (grant.Mode == JazminGrantMode.Online) bundle["online"] = true;
            slots.Add(AccessCrypto.SealSlot(grant.Key.Secret, _salt, _fileId, bundle, grant.Share));
        }
        return slots;
    }

    /// <summary>
    /// Abandons the file without writing the catalog and trailer, so readers will reject it as
    /// incomplete. Use when the input fails part-way. Closes the output unless leaveOpen.
    /// </summary>
    public void Abort()
    {
        _faulted = true;
        _finished = true;
        foreach (var chunk in _pending)
        {
            try
            {
                chunk.Work.Wait(); // let workers finish before the output is cut back or closed
            }
            catch (AggregateException)
            {
                // the write is being abandoned anyway
            }
        }
        _pending.Clear();
        if (_continue is not null)
        {
            // A failed append leaves no trace: cut back to the previous end and restore the flags.
            _output.SetLength(_continue.ValidEnd);
            WriteFlags(_continue.Flags);
            _output.Flush();
        }
        if (!_leaveOpen) _output.Dispose();
    }

    /// <summary>
    /// Writes rows from an async source (a database cursor, a network stream). Instead of blocking while chunks are
    /// compressed, it awaits the compression workers, so no thread is held up.
    /// </summary>
    public async Task WriteRowsAsync(IAsyncEnumerable<IReadOnlyDictionary<string, object?>> rows, CancellationToken cancellationToken = default)
    {
        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            await WaitForWorkersAsync().ConfigureAwait(false);
            WriteRow(row);
        }
    }

    /// <summary>Writes positional rows from an async source (see WriteRowsAsync).</summary>
    public async Task WriteValuesAsync(IAsyncEnumerable<object?[]> rows, CancellationToken cancellationToken = default)
    {
        await foreach (var values in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            await WaitForWorkersAsync().ConfigureAwait(false);
            WriteValues(values);
        }
    }

    /// <summary>
    /// When the next chunk would have to wait for the oldest one still being compressed, waits for it here without
    /// blocking a thread (the synchronous path would block in DrainPending).
    /// </summary>
    internal async ValueTask WaitForWorkersAsync()
    {
        if (_pending.Count > 0 && _pending.Count >= _options.MaxDegreeOfParallelism) await _pending.Peek().Work.ConfigureAwait(false);
    }

    /// <summary>Finish for async code: awaits the compression workers instead of blocking, then writes the catalog.</summary>
    public async Task FinishAsync(CancellationToken cancellationToken = default)
    {
        if (_finished) return;
        FlushChunk();
        while (_pending.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _pending.Peek().Work.ConfigureAwait(false);
            DrainPending(all: false);
        }
        Finish();
    }

    /// <summary>DisposeAsync finishes the file like Dispose, awaiting the compression workers.</summary>
    public async ValueTask DisposeAsync()
    {
        if (!_finished && !_faulted)
        {
            await FinishAsync().ConfigureAwait(false);
            return;
        }
        _finished = true;
        if (!_leaveOpen) await _output.DisposeAsync().ConfigureAwait(false);
    }

    /// <summary>Finishes the file unless a row failed validation, in which case the output is left incomplete.</summary>
    public void Dispose()
    {
        if (!_finished && !_faulted)
        {
            Finish();
            return;
        }
        _finished = true;
        if (!_leaveOpen) _output.Dispose();
    }
}

/// <summary>Orders sort-key tuples; nulls first.</summary>
internal static class SortKeys
{
    public static int Compare(object?[] a, object?[] b)
    {
        for (var i = 0; i < a.Length; i++)
        {
            if (a[i] is null && b[i] is null) continue;
            if (a[i] is null) return -1;
            if (b[i] is null) return 1;
            var c = Values.Compare(a[i]!, b[i]!) ?? 0;
            if (c != 0) return c;
        }
        return 0;
    }
}
