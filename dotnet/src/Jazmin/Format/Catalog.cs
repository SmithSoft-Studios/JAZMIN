namespace Jazmin.Format;

// Catalog messages of spec/jazmin.proto (spec 6), with their Protocol Buffers encoding.

/// <summary>Where a section is; Digest (SHA-256 of the whole section) in access-controlled files.</summary>
internal sealed record SectionRef(long Offset, int Length, byte[]? Digest = null);

internal sealed class ColumnDef
{
    public int Position { get; init; }
    public required string Name { get; init; }
    public JazminType Type { get; init; }
    public bool Required { get; init; }
    public string? Description { get; init; }
    public string? Attributes { get; init; } // JSON object as text
}

internal sealed class ColumnGroupDef
{
    public required string Name { get; init; }
    public List<ColumnDef> Columns { get; init; } = new(); // the default group, and every group of other files
    public int ColumnCount { get; init; } // restricted groups
    public SectionRef? Definitions { get; init; } // restricted groups: a ColumnDefinitions section
}

internal sealed class PartitionDef
{
    public byte[] Id { get; init; } = []; // 12 bytes in access-controlled files; empty otherwise
    public List<SectionRef> Segments { get; init; } = new();
}

internal sealed record IndexRef(string Column, string Kind, SectionRef Section, int Segment);

internal sealed class TableDef
{
    public string Name { get; set; } = "";
    public int ColumnCount { get; set; }
    public List<ColumnGroupDef> ColumnGroups { get; set; } = new();
    public List<string> SortedBy { get; set; } = new();
    public string PartitionBy { get; set; } = "";
    public long RowCount { get; set; }
    public long DeletedCount { get; set; }
    public int ChunkCount { get; set; }
    public List<PartitionDef> Partitions { get; set; } = new();
    public SectionRef? PartitionTable { get; set; }
    public List<IndexRef> Indexes { get; set; } = new();
    public SectionRef? Deletes { get; set; }
}

internal sealed class FilesInfo
{
    public List<(string Group, SectionRef Section)> Directories { get; init; } = new();
    public int NextContent { get; init; }
    public string Package { get; init; } = ""; // JSON object as text
    public int Segment { get; init; }
}

internal sealed record AccessRefs(SectionRef OwnerDirectory, SectionRef OwnerCatalog);

internal sealed class HeaderDef
{
    public List<string> ReaderFeatures { get; set; } = new();
    public List<string> WriterFeatures { get; set; } = new();
    public long Created { get; set; } // ms since 1970
    public long Modified { get; set; }
    public int AppendCount { get; set; }
    public string Metadata { get; set; } = ""; // JSON object as text
    public List<TableDef> Tables { get; set; } = new();
    public Dictionary<string, byte[]>? Keyring { get; set; }
    public FilesInfo? Files { get; set; }
    public AccessRefs? Access { get; set; }
    public List<SectionRef> Deltas { get; set; } = new();
}

internal sealed class ChunkEntry
{
    public int Ordinal { get; init; }
    public long RowStart { get; init; }
    public int RowCount { get; init; }
    public required SectionRef[] Parts { get; init; } // one per column group
}

internal sealed record StatsBlock(int[] Columns, SectionRef Section);

internal sealed record ChunkDirectory(List<ChunkEntry> Chunks, List<StatsBlock> Statistics);

/// <summary>
/// One directory segment as lists, without an object per chunk (readers keep chunk details in arrays): offsets, lengths
/// and digests (32 bytes each) hold <c>groupCount</c> parts per chunk.
/// </summary>
internal sealed record ChunkDirectoryLists(
    int[] Ordinals, long[] RowStarts, int[] RowCounts, long[] Offsets, int[] Lengths, byte[]? Digests, List<StatsBlock> Statistics);

/// <summary>One column of a statistics section: per chunk, the null count and bounds in key form (empty = unbounded).</summary>
internal sealed record ColumnStatsEntry(long[] NullCounts, byte[][] Min, byte[][] Max);

internal sealed record IndexPageRef(byte[] First, int Count, SectionRef At);

internal sealed record IndexDirectory(List<IndexPageRef> Pages, SectionRef? Nulls);

internal static class Catalog
{
    private const int DigestSize = 32;

    private static JazminFormatException Bad(string what) => new($"Catalog: {what}");

    private static int TypeId(JazminType type) => type switch
    {
        JazminType.Bool => 1,
        JazminType.Int => 2,
        JazminType.Float => 3,
        JazminType.Decimal => 4,
        JazminType.String => 5,
        JazminType.DateTime => 6,
        JazminType.Binary => 7,
        JazminType.Json => 8,
        _ => throw new JazminValidationException($"Unknown type {type}"),
    };

    private static JazminType TypeOf(ulong id, string column) => id switch
    {
        1 => JazminType.Bool,
        2 => JazminType.Int,
        3 => JazminType.Float,
        4 => JazminType.Decimal,
        5 => JazminType.String,
        6 => JazminType.DateTime,
        7 => JazminType.Binary,
        8 => JazminType.Json,
        _ => throw Bad($"column '{column}' has an unknown type"),
    };

    /// <summary>Numbers stored as differences: the first absolute, then each from the previous one.</summary>
    private static long[] Differences(IReadOnlyList<long> values)
    {
        var output = new long[values.Count];
        long previous = 0;
        for (var i = 0; i < values.Count; i++)
        {
            output[i] = values[i] - previous;
            previous = values[i];
        }
        return output;
    }

    private static List<long> Cumulative(List<long> values)
    {
        long total = 0;
        for (var i = 0; i < values.Count; i++) values[i] = total = checked(total + values[i]);
        return values;
    }

    private static int Int(long v) => v is >= 0 and <= int.MaxValue ? (int)v : throw Bad("value out of range");

    // ---- SectionRef ---------------------------------------------------------------------------------

    private static Action<ProtoWriter> WriteRef(SectionRef r) => w =>
    {
        w.UInt(1, r.Offset).UInt(2, (ulong)r.Length);
        if (r.Digest is not null) w.Bytes(3, r.Digest);
    };

    private static SectionRef ReadRef(ArraySegment<byte> message)
    {
        long offset = 0;
        var length = 0;
        byte[]? digest = null;
        var r = new ProtoReader(message);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: offset = r.Int64Value(); break;
                case 2: length = r.Int32(); break;
                case 3: digest = r.ByteArray(); break;
                default: r.Skip(); break;
            }
        }
        return new SectionRef(offset, length, digest);
    }

    // ---- Columns ------------------------------------------------------------------------------------

    private static Action<ProtoWriter> WriteColumn(ColumnDef c) => w =>
        w.UInt(1, (ulong)c.Position).String(2, c.Name).UInt(3, (ulong)TypeId(c.Type)).Bool(4, c.Required)
            .String(5, c.Description).String(6, c.Attributes);

    private static ColumnDef ReadColumn(ArraySegment<byte> message)
    {
        int position = 0;
        string name = "";
        ulong type = 0, unit = 0;
        bool required = false;
        string? description = null, attributes = null;
        var r = new ProtoReader(message);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: position = r.Int32(); break;
                case 2: name = r.String(); break;
                case 3: type = r.UInt64(); break;
                case 4: required = r.Bool(); break;
                case 5: description = r.String(); break;
                case 6: attributes = r.String(); break;
                case 7: unit = r.UInt64(); break;
                default: r.Skip(); break;
            }
        }
        if (unit != 0) throw Bad($"column '{name}' uses an unknown time unit");
        return new ColumnDef { Position = position, Name = name, Type = TypeOf(type, name), Required = required, Description = description, Attributes = attributes };
    }

    public static byte[] EncodeColumnDefinitions(IEnumerable<ColumnDef> columns)
    {
        var w = new ProtoWriter();
        foreach (var c in columns) w.Message(1, WriteColumn(c), true);
        return w.ToArray();
    }

    public static List<ColumnDef> DecodeColumnDefinitions(byte[] raw)
    {
        var columns = new List<ColumnDef>();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            if (f == 1) columns.Add(ReadColumn(r.Bytes()));
            else r.Skip();
        }
        return columns;
    }

    // ---- Partitions, indexes, tables ------------------------------------------------------------------

    private static Action<ProtoWriter> WritePartition(PartitionDef p) => w =>
    {
        w.Bytes(1, p.Id);
        foreach (var s in p.Segments) w.Message(2, WriteRef(s), true);
    };

    private static PartitionDef ReadPartition(ArraySegment<byte> message)
    {
        var p = new PartitionDef();
        byte[] id = [];
        var r = new ProtoReader(message);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: id = r.ByteArray(); break;
                case 2: p.Segments.Add(ReadRef(r.Bytes())); break;
                default: r.Skip(); break;
            }
        }
        return new PartitionDef { Id = id, Segments = p.Segments };
    }

    private static Action<ProtoWriter> WriteIndexRef(IndexRef ix) => w =>
        w.String(1, ix.Column).String(2, ix.Kind).Message(3, WriteRef(ix.Section)).UInt(4, (ulong)ix.Segment);

    private static IndexRef ReadIndexRef(ArraySegment<byte> message)
    {
        string column = "", kind = "";
        SectionRef? section = null;
        var segment = 0;
        var r = new ProtoReader(message);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: column = r.String(); break;
                case 2: kind = r.String(); break;
                case 3: section = ReadRef(r.Bytes()); break;
                case 4: segment = r.Int32(); break;
                default: r.Skip(); break;
            }
        }
        return new IndexRef(column, kind, section ?? throw Bad($"index on '{column}' has no section"), segment);
    }

    private static Action<ProtoWriter> WriteTable(TableDef t) => w =>
    {
        w.String(1, t.Name).UInt(2, (ulong)t.ColumnCount);
        foreach (var g in t.ColumnGroups)
        {
            w.Message(3, gw =>
            {
                gw.String(1, g.Name);
                foreach (var c in g.Columns) gw.Message(2, WriteColumn(c), true);
                gw.UInt(3, (ulong)g.ColumnCount).Message(4, g.Definitions is null ? null : WriteRef(g.Definitions));
            }, true);
        }
        foreach (var name in t.SortedBy) w.Always(4, System.Text.Encoding.UTF8.GetBytes(name));
        w.String(5, t.PartitionBy).UInt(6, t.RowCount).UInt(7, t.DeletedCount).UInt(8, (ulong)t.ChunkCount);
        foreach (var p in t.Partitions) w.Message(9, WritePartition(p), true);
        w.Message(10, t.PartitionTable is null ? null : WriteRef(t.PartitionTable));
        foreach (var ix in t.Indexes) w.Message(11, WriteIndexRef(ix), true);
        w.Message(12, t.Deletes is null ? null : WriteRef(t.Deletes));
    };

    private static TableDef ReadTable(ArraySegment<byte> message)
    {
        var t = new TableDef();
        var r = new ProtoReader(message);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: t.Name = r.String(); break;
                case 2: t.ColumnCount = r.Int32(); break;
                case 3:
                {
                    string name = "";
                    var columns = new List<ColumnDef>();
                    var count = 0;
                    SectionRef? definitions = null;
                    var g = new ProtoReader(r.Bytes());
                    while (g.Next(out var gf))
                    {
                        switch (gf)
                        {
                            case 1: name = g.String(); break;
                            case 2: columns.Add(ReadColumn(g.Bytes())); break;
                            case 3: count = g.Int32(); break;
                            case 4: definitions = ReadRef(g.Bytes()); break;
                            default: g.Skip(); break;
                        }
                    }
                    t.ColumnGroups.Add(new ColumnGroupDef { Name = name, Columns = columns, ColumnCount = count, Definitions = definitions });
                    break;
                }
                case 4: t.SortedBy.Add(r.String()); break;
                case 5: t.PartitionBy = r.String(); break;
                case 6: t.RowCount = r.Int64Value(); break;
                case 7: t.DeletedCount = r.Int64Value(); break;
                case 8: t.ChunkCount = r.Int32(); break;
                case 9: t.Partitions.Add(ReadPartition(r.Bytes())); break;
                case 10: t.PartitionTable = ReadRef(r.Bytes()); break;
                case 11: t.Indexes.Add(ReadIndexRef(r.Bytes())); break;
                case 12: t.Deletes = ReadRef(r.Bytes()); break;
                default: r.Skip(); break;
            }
        }
        return t;
    }

    // ---- Header -------------------------------------------------------------------------------------

    private static readonly string[] KeyringGroups = ["", FormatConstants.KeyringData, FormatConstants.KeyringIndex, FormatConstants.KeyringFiles];

    public static byte[] EncodeHeader(HeaderDef h)
    {
        var w = new ProtoWriter(1024);
        foreach (var f in h.ReaderFeatures) w.Always(1, System.Text.Encoding.UTF8.GetBytes(f));
        foreach (var f in h.WriterFeatures) w.Always(2, System.Text.Encoding.UTF8.GetBytes(f));
        w.Int64(3, h.Created).Int64(4, h.Modified).UInt(5, (ulong)h.AppendCount).String(6, h.Metadata);
        foreach (var t in h.Tables) w.Message(7, WriteTable(t), true);
        if (h.Keyring is { } keyring)
        {
            w.Message(8, kw =>
            {
                for (var i = 1; i < KeyringGroups.Length; i++)
                    if (keyring.TryGetValue(KeyringGroups[i], out var secret)) kw.Bytes(i, secret);
            });
        }
        if (h.Files is { } files)
        {
            w.Message(9, fw =>
            {
                foreach (var (group, section) in files.Directories) fw.Message(1, dw => dw.String(1, group).Message(2, WriteRef(section)), true);
                fw.UInt(2, (ulong)files.NextContent).String(3, files.Package).UInt(4, (ulong)files.Segment);
            }, true);
        }
        if (h.Access is { } access) w.Message(10, aw => aw.Message(1, WriteRef(access.OwnerDirectory)).Message(2, WriteRef(access.OwnerCatalog)), true);
        foreach (var d in h.Deltas) w.Message(11, WriteRef(d), true);
        return w.ToArray();
    }

    public static HeaderDef DecodeHeader(byte[] raw)
    {
        var h = new HeaderDef();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: h.ReaderFeatures.Add(r.String()); break;
                case 2: h.WriterFeatures.Add(r.String()); break;
                case 3: h.Created = r.SignedInt64(); break;
                case 4: h.Modified = r.SignedInt64(); break;
                case 5: h.AppendCount = r.Int32(); break;
                case 6: h.Metadata = r.String(); break;
                case 7: h.Tables.Add(ReadTable(r.Bytes())); break;
                case 8:
                {
                    var keyring = new Dictionary<string, byte[]>();
                    var k = new ProtoReader(r.Bytes());
                    while (k.Next(out var kf))
                    {
                        if (kf < KeyringGroups.Length) keyring[KeyringGroups[kf]] = k.ByteArray();
                        else k.Skip();
                    }
                    h.Keyring = keyring;
                    break;
                }
                case 9:
                {
                    var directories = new List<(string, SectionRef)>();
                    int next = 0, segment = 0;
                    var package = "";
                    var fr = new ProtoReader(r.Bytes());
                    while (fr.Next(out var ff))
                    {
                        switch (ff)
                        {
                            case 1:
                            {
                                var group = "";
                                SectionRef? section = null;
                                var d = new ProtoReader(fr.Bytes());
                                while (d.Next(out var df))
                                {
                                    if (df == 1) group = d.String();
                                    else if (df == 2) section = ReadRef(d.Bytes());
                                    else d.Skip();
                                }
                                directories.Add((group, section ?? throw Bad("file directory without a section")));
                                break;
                            }
                            case 2: next = fr.Int32(); break;
                            case 3: package = fr.String(); break;
                            case 4: segment = fr.Int32(); break;
                            default: fr.Skip(); break;
                        }
                    }
                    h.Files = new FilesInfo { Directories = directories, NextContent = next, Package = package, Segment = segment };
                    break;
                }
                case 10:
                {
                    SectionRef? directory = null, catalog = null;
                    var a = new ProtoReader(r.Bytes());
                    while (a.Next(out var af))
                    {
                        if (af == 1) directory = ReadRef(a.Bytes());
                        else if (af == 2) catalog = ReadRef(a.Bytes());
                        else a.Skip();
                    }
                    h.Access = new AccessRefs(directory ?? throw Bad("owner directory is missing"), catalog ?? throw Bad("owner catalog is missing"));
                    break;
                }
                case 11: h.Deltas.Add(ReadRef(r.Bytes())); break;
                default: r.Skip(); break;
            }
        }
        if (h.Tables.Count == 0) throw Bad("the header lists no table");
        return h;
    }

    // ---- Partition table, deltas, owner catalog -------------------------------------------------------

    public static byte[] EncodePartitionTable(IEnumerable<PartitionDef> partitions)
    {
        var w = new ProtoWriter();
        foreach (var p in partitions) w.Message(1, WritePartition(p), true);
        return w.ToArray();
    }

    public static List<PartitionDef> DecodePartitionTable(byte[] raw)
    {
        var partitions = new List<PartitionDef>();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            if (f == 1) partitions.Add(ReadPartition(r.Bytes()));
            else r.Skip();
        }
        return partitions;
    }

    /// <summary>
    /// The partitions with these ids in a PartitionTable section, decoding only those: a key holder needs its own few
    /// entries, not every partition's (spec 6.3).
    /// </summary>
    public static List<PartitionDef> FindPartitions(byte[] raw, IReadOnlyList<byte[]> ids)
    {
        var found = new List<PartitionDef>();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            if (f != 1)
            {
                r.Skip();
                continue;
            }
            var entry = r.Bytes();
            var span = entry.AsSpan();
            // Writers put the id first: compare it in place. Any other field order is decoded in full.
            var idFirst = span.Length >= 2 && span[0] == 0x0a && span[1] < 0x80 && 2 + span[1] <= span.Length;
            if (idFirst)
            {
                var id = span.Slice(2, span[1]);
                var match = false;
                foreach (var want in ids) match |= id.SequenceEqual(want);
                if (match) found.Add(ReadPartition(entry));
                continue;
            }
            var p = ReadPartition(entry);
            if (ids.Any(want => want.AsSpan().SequenceEqual(p.Id))) found.Add(p);
        }
        return found;
    }

    /// <summary>Delta: new partitions, and new directory segments of existing ones, per table.</summary>
    public static byte[] EncodeDelta(int table, IEnumerable<PartitionDef> partitions)
    {
        var w = new ProtoWriter();
        w.Message(1, tw =>
        {
            tw.UInt(1, (ulong)table);
            foreach (var p in partitions) tw.Message(2, WritePartition(p), true);
        }, true);
        return w.ToArray();
    }

    public static List<(int Table, List<PartitionDef> Partitions)> DecodeDelta(byte[] raw)
    {
        var tables = new List<(int, List<PartitionDef>)>();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            if (f != 1)
            {
                r.Skip();
                continue;
            }
            var table = 0;
            var partitions = new List<PartitionDef>();
            var t = new ProtoReader(r.Bytes());
            while (t.Next(out var tf))
            {
                if (tf == 1) table = t.Int32();
                else if (tf == 2) partitions.Add(ReadPartition(t.Bytes()));
                else t.Skip();
            }
            tables.Add((table, partitions));
        }
        return tables;
    }

    /// <summary>The owner catalog (spec 7.6.5): the indexes of every table.</summary>
    public static byte[] EncodeOwnerCatalog(IEnumerable<(int Table, List<IndexRef> Indexes)> tables)
    {
        var w = new ProtoWriter();
        foreach (var (table, indexes) in tables)
        {
            w.Message(1, tw =>
            {
                tw.UInt(1, (ulong)table);
                foreach (var ix in indexes) tw.Message(2, WriteIndexRef(ix), true);
            }, true);
        }
        return w.ToArray();
    }

    /// <summary>The indexes of one table in the owner catalog.</summary>
    public static List<IndexRef> DecodeOwnerCatalog(byte[] raw, int table) =>
        DecodeOwnerCatalog(raw).FirstOrDefault(t => t.Table == table).Indexes ?? new List<IndexRef>();

    public static List<(int Table, List<IndexRef> Indexes)> DecodeOwnerCatalog(byte[] raw)
    {
        var tables = new List<(int Table, List<IndexRef> Indexes)>();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            if (f != 1)
            {
                r.Skip();
                continue;
            }
            var number = 0;
            var indexes = new List<IndexRef>();
            var t = new ProtoReader(r.Bytes());
            while (t.Next(out var tf))
            {
                if (tf == 1) number = t.Int32();
                else if (tf == 2) indexes.Add(ReadIndexRef(t.Bytes()));
                else t.Skip();
            }
            tables.Add((number, indexes));
        }
        return tables;
    }

    // ---- Chunk directories and statistics (spec 6.3, 6.4) ---------------------------------------------

    public static byte[] EncodeChunkDirectory(IReadOnlyList<ChunkEntry> chunks, IReadOnlyList<StatsBlock> statistics, bool withDigests)
    {
        var parts = chunks.SelectMany(c => c.Parts).ToList();
        var w = new ProtoWriter(chunks.Count * 12 + parts.Count * (withDigests ? 40 : 8) + 64);
        w.Packed(1, Differences(chunks.Select(c => (long)c.Ordinal).ToList()));
        w.Packed(2, Differences(chunks.Select(c => c.RowStart).ToList()));
        w.Packed(3, chunks.Select(c => (long)c.RowCount).ToList());
        w.Packed(4, Differences(parts.Select(p => p.Offset).ToList()));
        w.Packed(5, parts.Select(p => (long)p.Length).ToList());
        if (withDigests) w.Bytes(6, parts.SelectMany(p => p.Digest!).ToArray());
        foreach (var s in statistics) w.Message(7, sw => sw.Packed(1, s.Columns.Select(c => (long)c).ToList()).Message(2, WriteRef(s.Section)), true);
        return w.ToArray();
    }

    public static ChunkDirectory DecodeChunkDirectory(byte[] raw, int groupCount)
    {
        var d = DecodeChunkDirectoryLists(raw, groupCount);
        var chunks = new List<ChunkEntry>(d.Ordinals.Length);
        for (var i = 0; i < d.Ordinals.Length; i++)
        {
            var parts = new SectionRef[groupCount];
            for (var g = 0; g < groupCount; g++)
            {
                var k = i * groupCount + g;
                parts[g] = new SectionRef(d.Offsets[k], d.Lengths[k], d.Digests?[(k * DigestSize)..((k + 1) * DigestSize)]);
            }
            chunks.Add(new ChunkEntry { Ordinal = d.Ordinals[i], RowStart = d.RowStarts[i], RowCount = d.RowCounts[i], Parts = parts });
        }
        return new ChunkDirectory(chunks, d.Statistics);
    }

    public static ChunkDirectoryLists DecodeChunkDirectoryLists(byte[] raw, int groupCount)
    {
        List<long> ordinals = new(), rowStarts = new(), rowCounts = new(), offsets = new(), lengths = new();
        byte[]? digests = null;
        var statistics = new List<StatsBlock>();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: r.Packed(ordinals); break;
                case 2: r.Packed(rowStarts); break;
                case 3: r.Packed(rowCounts); break;
                case 4: r.Packed(offsets); break;
                case 5: r.Packed(lengths); break;
                case 6: digests = r.ByteArray(); break;
                case 7:
                {
                    var columns = new List<long>();
                    SectionRef? section = null;
                    var s = new ProtoReader(r.Bytes());
                    while (s.Next(out var sf))
                    {
                        if (sf == 1) s.Packed(columns);
                        else if (sf == 2) section = ReadRef(s.Bytes());
                        else s.Skip();
                    }
                    statistics.Add(new StatsBlock(columns.Select(Int).ToArray(), section ?? throw Bad("statistics block without a section")));
                    break;
                }
                default: r.Skip(); break;
            }
        }
        Cumulative(ordinals);
        Cumulative(rowStarts);
        Cumulative(offsets);
        var n = ordinals.Count;
        if (rowStarts.Count != n || rowCounts.Count != n || offsets.Count != n * groupCount || lengths.Count != n * groupCount)
            throw Bad("chunk directory lists are inconsistent");
        if (digests is not null && digests.Length != n * groupCount * DigestSize) throw Bad("chunk directory digests are inconsistent");
        return new ChunkDirectoryLists(ordinals.Select(Int).ToArray(), rowStarts.ToArray(), rowCounts.Select(Int).ToArray(),
            offsets.ToArray(), lengths.Select(Int).ToArray(), digests, statistics);
    }

    public static byte[] EncodeStatistics(IEnumerable<ColumnStatsEntry> columns)
    {
        var w = new ProtoWriter();
        foreach (var c in columns)
        {
            w.Message(1, cw =>
            {
                cw.Packed(1, c.NullCounts);
                foreach (var b in c.Min) cw.Always(2, b);
                foreach (var b in c.Max) cw.Always(3, b);
            }, true);
        }
        return w.ToArray();
    }

    public static List<ColumnStatsEntry> DecodeStatistics(byte[] raw)
    {
        var columns = new List<ColumnStatsEntry>();
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            if (f != 1)
            {
                r.Skip();
                continue;
            }
            var nulls = new List<long>();
            List<byte[]> min = new(), max = new();
            var c = new ProtoReader(r.Bytes());
            while (c.Next(out var cf))
            {
                switch (cf)
                {
                    case 1: c.Packed(nulls); break;
                    case 2: min.Add(c.ByteArray()); break;
                    case 3: max.Add(c.ByteArray()); break;
                    default: c.Skip(); break;
                }
            }
            columns.Add(new ColumnStatsEntry(nulls.ToArray(), min.ToArray(), max.ToArray()));
        }
        return columns;
    }

    // ---- Sorted index directory (spec 8.1) ----------------------------------------------------------

    public static byte[] EncodeIndexDirectory(IReadOnlyList<IndexPageRef> pages, SectionRef? nulls, bool withDigests)
    {
        var w = new ProtoWriter(pages.Count * 24 + 64);
        foreach (var p in pages) w.Always(1, p.First);
        w.Packed(2, pages.Select(p => (long)p.Count).ToList());
        w.Packed(3, Differences(pages.Select(p => p.At.Offset).ToList()));
        w.Packed(4, pages.Select(p => (long)p.At.Length).ToList());
        if (withDigests) w.Bytes(5, pages.SelectMany(p => p.At.Digest!).ToArray());
        w.Message(6, nulls is null ? null : WriteRef(nulls));
        return w.ToArray();
    }

    public static IndexDirectory DecodeIndexDirectory(byte[] raw)
    {
        var firsts = new List<byte[]>();
        List<long> counts = new(), offsets = new(), lengths = new();
        byte[]? digests = null;
        SectionRef? nulls = null;
        var r = new ProtoReader(raw);
        while (r.Next(out var f))
        {
            switch (f)
            {
                case 1: firsts.Add(r.ByteArray()); break;
                case 2: r.Packed(counts); break;
                case 3: r.Packed(offsets); break;
                case 4: r.Packed(lengths); break;
                case 5: digests = r.ByteArray(); break;
                case 6: nulls = ReadRef(r.Bytes()); break;
                default: r.Skip(); break;
            }
        }
        Cumulative(offsets);
        var n = firsts.Count;
        if (counts.Count != n || offsets.Count != n || lengths.Count != n) throw Bad("index directory lists are inconsistent");
        if (digests is not null && digests.Length != n * DigestSize) throw Bad("index directory digests are inconsistent");
        var pages = new List<IndexPageRef>(n);
        for (var i = 0; i < n; i++)
            pages.Add(new IndexPageRef(firsts[i], Int(counts[i]), new SectionRef(offsets[i], Int(lengths[i]), digests?[(i * DigestSize)..((i + 1) * DigestSize)])));
        return new IndexDirectory(pages, nulls);
    }
}
