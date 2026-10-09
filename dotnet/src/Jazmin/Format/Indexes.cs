namespace Jazmin.Format;

/// <summary>Helpers for sorted, de-duplicated arrays of row ids.</summary>
internal static class RowSet
{
    public static long[] Intersect(long[] a, long[] b)
    {
        var result = new List<long>(Math.Min(a.Length, b.Length));
        int i = 0, j = 0;
        while (i < a.Length && j < b.Length)
        {
            if (a[i] == b[j])
            {
                result.Add(a[i]);
                i++;
                j++;
            }
            else if (a[i] < b[j]) i++;
            else j++;
        }
        return result.ToArray();
    }

    public static long[] Union(IReadOnlyList<long[]> lists)
    {
        if (lists.Count == 0) return Array.Empty<long>();
        if (lists.Count == 1) return lists[0];
        var all = lists.SelectMany(l => l).ToArray();
        Array.Sort(all);
        var result = new List<long>(all.Length);
        for (var i = 0; i < all.Length; i++)
            if (i == 0 || all[i] != all[i - 1]) result.Add(all[i]);
        return result.ToArray();
    }

    public static void WritePostings(ByteWriter writer, IReadOnlyList<long> rowIds)
    {
        writer.VarUInt((ulong)rowIds.Count);
        long previous = 0;
        foreach (var id in rowIds)
        {
            writer.VarUInt((ulong)(id - previous));
            previous = id;
        }
    }

    public static long[] ReadPostings(ByteReader reader)
    {
        var count = reader.Length();
        if (count > reader.Remaining) throw new JazminFormatException("Postings are truncated"); // each takes at least one byte
        var ids = new long[count];
        long previous = 0;
        for (var i = 0; i < count; i++)
        {
            previous += (long)reader.VarUInt();
            ids[i] = previous;
        }
        return ids;
    }

    /// <summary>Checks the encoding byte that starts index, page, postings and deleted-rows sections (spec 8).</summary>
    public static void CheckEncoding(ByteReader reader, string what)
    {
        var encoding = reader.Byte();
        if (encoding != FormatConstants.PostingsEncoding) throw new JazminFormatException($"{what} uses encoding {encoding}, which this reader does not support");
    }

    /// <summary>A postings section (null cells, deleted rows): encoding byte, then postings.</summary>
    public static byte[] EncodeSection(IReadOnlyList<long> rowIds)
    {
        var writer = new ByteWriter(rowIds.Count * 2 + 8);
        writer.Byte(FormatConstants.PostingsEncoding);
        WritePostings(writer, rowIds);
        return writer.ToArray();
    }

    public static long[] DecodeSection(byte[] raw, string what)
    {
        var reader = new ByteReader(raw);
        CheckEncoding(reader, what);
        var ids = ReadPostings(reader);
        if (!reader.Eof) throw new JazminFormatException($"{what} has trailing bytes");
        return ids;
    }
}

internal interface IIndexBuilder
{
    void Add(long rowId, object? internalValue);
}

internal sealed class KeyComparer : IComparer<object>
{
    public static readonly KeyComparer Instance = new();

    public int Compare(object? x, object? y) => Values.Compare(x!, y!) ?? 0;
}

/// <summary>Builds a sorted value index: distinct values in ascending order, each with its row ids.</summary>
internal sealed class SortedIndexBuilder(JazminType type) : IIndexBuilder
{
    // Distinct keys, each with its first row id; later row ids only for keys seen again, so a column of unique values
    // (ids) needs no list per key. Entries are kept in blocks small enough to stay off the large object heap: growing
    // one large array would force full garbage collections of the writer's whole heap.
    // Keys are kept in ascending runs: one while they arrive in order (ids, a sorted column), a few more when some arrive
    // out of order (rows appended after the rest, partitions regrouped by compaction), merged when the pages are
    // written. Past MaxRuns runs (keys in no particular order), they move to a lookup table, as first seen.
    private const int BlockSize = 2048;
    private const int MaxRuns = 32;
    private struct Entry
    {
        public object Key;
        public long FirstRow;
        public List<long>? MoreRows;
    }

    private List<Entry[]> _blocks = new();
    private int _count;
    private readonly List<int> _runStarts = [0]; // first entry of each ascending run
    private Dictionary<object, int>? _positions; // table mode: key -> entry, once the keys form more than MaxRuns runs
    private readonly List<long> _nulls = new();

    private ref Entry At(int i) => ref _blocks[i / BlockSize][i % BlockSize];

    public void Add(long rowId, object? internalValue)
    {
        if (internalValue is null)
        {
            _nulls.Add(rowId);
            return;
        }
        var key = Values.ToKey(type, internalValue);
        if (Values.IsNaN(key)) return; // NaN is never indexed
        if (_positions is null && _count > 0)
        {
            // Keys arriving in ascending order (ids, a sorted column) can only repeat the last one: no lookup needed.
            ref var last = ref At(_count - 1);
            var order = KeyComparer.Instance.Compare(last.Key, key);
            if (order == 0 && last.Key.Equals(key))
            {
                (last.MoreRows ??= new List<long>()).Add(rowId);
                return;
            }
            if (order >= 0)
            {
                if (_runStarts.Count < MaxRuns) _runStarts.Add(_count); // this key starts a new run
                else ToTable();
            }
        }
        if (_positions is not null && _positions.TryGetValue(key, out var at))
        {
            (At(at).MoreRows ??= new List<long>()).Add(rowId);
            return;
        }
        if (_count % BlockSize == 0) _blocks.Add(new Entry[BlockSize]);
        At(_count) = new Entry { Key = key, FirstRow = rowId };
        _positions?.Add(key, _count);
        _count++;
    }

    /// <summary>Table mode: one entry per key, as first seen (the same key in later runs joins it), with a lookup table.</summary>
    private void ToTable()
    {
        var blocks = _blocks;
        var count = _count;
        _blocks = new List<Entry[]>();
        _count = 0;
        _runStarts.Clear();
        _runStarts.Add(0);
        var positions = new Dictionary<object, int>(count * 2);
        for (var i = 0; i < count; i++)
        {
            var entry = blocks[i / BlockSize][i % BlockSize];
            if (positions.TryGetValue(entry.Key, out var at))
            {
                var more = At(at).MoreRows ??= new List<long>();
                more.Add(entry.FirstRow);
                if (entry.MoreRows is { } later) more.AddRange(later);
                continue;
            }
            if (_count % BlockSize == 0) _blocks.Add(new Entry[BlockSize]);
            At(_count) = entry;
            positions.Add(entry.Key, _count++);
        }
        _positions = positions;
    }

    /// <summary>Row ids of null cells.</summary>
    public IReadOnlyList<long> Nulls => _nulls;

    /// <summary>
    /// The distinct keys in ascending order, as entry positions: the first, and those of the same key in later runs
    /// (their row ids follow, in the order they were added). Runs are merged, the oldest first among equal keys.
    /// </summary>
    private IEnumerable<(int First, List<int>? Others)> SortedEntries()
    {
        if (_positions is not null || _runStarts.Count == 1)
        {
            foreach (var at in SortedPositions()) yield return (at, null);
            yield break;
        }
        var runs = _runStarts.Count;
        var next = _runStarts.ToArray();
        var ends = new int[runs];
        for (var r = 0; r < runs; r++) ends[r] = r + 1 < runs ? _runStarts[r + 1] : _count;
        while (true)
        {
            var best = -1; // the run with the smallest key; on a tie, the oldest (first seen)
            for (var r = 0; r < runs; r++)
            {
                if (next[r] < ends[r] && (best < 0 || KeyComparer.Instance.Compare(At(next[r]).Key, At(next[best]).Key) < 0)) best = r;
            }
            if (best < 0) yield break;
            var first = next[best]++;
            var key = At(first).Key;
            List<int>? others = null;
            for (var r = best + 1; r < runs; r++)
            {
                if (next[r] < ends[r] && KeyComparer.Instance.Compare(At(next[r]).Key, key) == 0 && At(next[r]).Key.Equals(key)) (others ??= []).Add(next[r]++);
            }
            yield return (first, others);
        }
    }

    /// <summary>
    /// Positions of the distinct keys in ascending key order: as first seen while keys arrived in order; otherwise
    /// sorted, numbers and strings as typed arrays (the same order as <see cref="KeyComparer"/>: -0 is folded into 0 and
    /// NaN is never indexed), other keys with the comparer.
    /// </summary>
    private IEnumerable<int> SortedPositions()
    {
        if (_positions is null) return Enumerable.Range(0, _count);
        var order = new int[_count];
        for (var i = 0; i < order.Length; i++) order[i] = i;
        switch (At(0).Key)
        {
            case long:
                Array.Sort(KeysAs<long>(), order);
                break;
            case double:
                Array.Sort(KeysAs<double>(), order);
                break;
            case string:
                Array.Sort(KeysAs<string>(), order, StringComparer.Ordinal);
                break;
            default:
                Array.Sort(KeysAs<object>(), order, KeyComparer.Instance);
                break;
        }
        return order;
    }

    private T[] KeysAs<T>()
    {
        var keys = new T[_count];
        for (var i = 0; i < _count; i++) keys[i] = (T)At(i).Key;
        return keys;
    }

    /// <summary>
    /// The index as pages (spec 8.1) of about <paramref name="pageBytes"/> raw bytes each, built one at a time:
    /// First is the page's smallest key in bound form, Raw = encoding byte + varint count + entries. With
    /// <paramref name="deltas"/>, encoding 1: keys and first row ids as differences from the previous entry's (reader
    /// feature 'index-deltas'). A small index is one page. Row ids of null cells are in <see cref="Nulls"/>.
    /// </summary>
    public IEnumerable<(byte[] First, int Count, byte[] Raw)> Pages(int pageBytes, bool deltas = false)
    {
        var body = new ByteWriter(Math.Min(pageBytes * 2, 1 << 20));
        var postings = new List<long>();
        var keys = deltas ? new PageKeys(type) : null;
        long previousFirst = 0;
        // Encoding 1 pages are cut where encoding 0 pages would be, so they hold as many entries: a lookup decodes a whole
        // page, and fuller pages made lookups up to 30% slower. They are smaller to read and decompress instead.
        long plainBytes = 0;
        object? first = null;
        var count = 0;
        foreach (var (at, others) in SortedEntries())
        {
            var entry = At(at);
            if (count == 0) first = entry.Key;
            var plainKey = keys?.Write(body, entry.Key) ?? 0;
            if (keys is null) Values.Encode(body, type, entry.Key);
            postings.Clear();
            postings.Add(entry.FirstRow);
            if (entry.MoreRows is { } more) postings.AddRange(more);
            foreach (var other in others ?? [])
            {
                postings.Add(At(other).FirstRow);
                if (At(other).MoreRows is { } later) postings.AddRange(later);
            }
            if (keys is not null)
            {
                var postingsStart = body.Length;
                WriteRowIds(body, postings, previousFirst);
                plainBytes += plainKey + body.Length - postingsStart - ByteWriter.VarIntSize(postings[0] - previousFirst) + ByteWriter.VarUIntSize((ulong)postings[0]);
                previousFirst = postings[0];
            }
            else
            {
                RowSet.WritePostings(body, postings);
            }
            count++;
            if ((keys is null ? body.Length : plainBytes) < pageBytes) continue;
            yield return (Bounds.Encode(type, first!), count, PageBytes(count, body, deltas));
            body.Reset();
            count = 0;
            keys?.Reset(); // each page starts afresh, so it decodes on its own
            previousFirst = 0;
            plainBytes = 0;
        }
        if (count > 0) yield return (Bounds.Encode(type, first!), count, PageBytes(count, body, deltas));
    }

    /// <summary>Postings as <see cref="RowSet.WritePostings"/>, but the first row id as the zigzag difference from the previous entry's.</summary>
    private static void WriteRowIds(ByteWriter writer, List<long> rowIds, long previousFirst)
    {
        writer.VarUInt((ulong)rowIds.Count);
        writer.VarInt(rowIds[0] - previousFirst);
        for (var i = 1; i < rowIds.Count; i++) writer.VarUInt((ulong)(rowIds[i] - rowIds[i - 1]));
    }

    private static byte[] PageBytes(int count, ByteWriter body, bool deltas)
    {
        var raw = new ByteWriter(body.Length + 11);
        raw.Byte(deltas ? FormatConstants.IndexDeltasEncoding : FormatConstants.PostingsEncoding);
        raw.VarUInt((ulong)count);
        raw.Bytes(body.AsSpan());
        return raw.ToArray();
    }
}

/// <summary>
/// A sorted index (spec 8.1): only the directory is read up front; each lookup reads the pages it needs through the
/// loader (part <c>page/&lt;n&gt;</c> or <c>nulls</c>), and a few decoded pages are kept, so memory stays bounded
/// however large the index is.
/// </summary>
internal sealed class PagedSortedIndex : IIndex
{
    private const int PagesCached = 8;
    private readonly JazminType _type;
    private readonly (object First, int Count, SectionRef At)[] _pages;
    private readonly SectionRef? _nulls;
    private readonly Func<string, SectionRef, byte[]> _load;
    private readonly Dictionary<int, SortedIndex> _cache = new();
    private readonly LinkedList<int> _recent = new(); // least recently used first

    private readonly bool _deltas;

    /// <summary>With <paramref name="deltas"/> (the file has reader feature 'index-deltas'), pages may use encoding 1.</summary>
    public PagedSortedIndex(IndexDirectory directory, JazminType type, Func<string, SectionRef, byte[]> load, bool deltas = false)
    {
        _deltas = deltas;
        _pages = directory.Pages
            .Select(p => (Bounds.Decode(type, p.First) ?? throw new JazminFormatException("Index page has no first key"), p.Count, p.At))
            .ToArray();
        _nulls = directory.Nulls;
        _type = type;
        _load = load;
    }

    private SortedIndex Page(int i)
    {
        if (_cache.TryGetValue(i, out var page))
        {
            _recent.Remove(i);
        }
        else
        {
            page = SortedIndex.DecodePage(_load($"page/{i}", _pages[i].At), _type, _deltas);
            if (page.Count != _pages[i].Count) throw new JazminFormatException("Index page does not match its directory");
            if (_cache.Count >= PagesCached)
            {
                _cache.Remove(_recent.First!.Value);
                _recent.RemoveFirst();
            }
            _cache[i] = page;
        }
        _recent.AddLast(i);
        return page;
    }

    /// <summary>Last page whose first key is &lt;= value, or -1 if value is below every key.</summary>
    private int PageFor(object value)
    {
        int lo = 0, hi = _pages.Length;
        while (lo < hi)
        {
            var mid = (lo + hi) >>> 1;
            if ((Values.Compare(_pages[mid].First, value) ?? 0) <= 0) lo = mid + 1;
            else hi = mid;
        }
        return lo - 1;
    }

    /// <summary>The first and last page a lookup reads (last &lt; first: none), from the directory alone.</summary>
    private (int From, int To) PageSpan(IndexLookup lookup)
    {
        var last = _pages.Length - 1;
        switch (lookup)
        {
            case IndexLookup.Eq eq:
            {
                if (Values.IsNaN(eq.Value)) return (0, -1);
                var i = PageFor(eq.Value);
                return (Math.Max(i, 0), i);
            }
            case IndexLookup.Range range:
                if ((range.Low is not null && Values.IsNaN(range.Low)) || (range.High is not null && Values.IsNaN(range.High))) return (0, -1);
                return (range.Low is null ? 0 : Math.Max(PageFor(range.Low), 0), range.High is null ? last : PageFor(range.High));
            case IndexLookup.Prefix prefix:
            {
                // Keys starting with the text are contiguous: they continue while the next page may still start with it.
                var from = Math.Max(PageFor(prefix.Text), 0);
                var to = from;
                while (to < last && ((string)_pages[to + 1].First).StartsWith(prefix.Text, StringComparison.Ordinal)) to++;
                return (from, Math.Min(to, last));
            }
            default:
                return (0, -1);
        }
    }

    public long? Cost(IndexLookup lookup)
    {
        switch (lookup)
        {
            case IndexLookup.Contains: return null;
            case IndexLookup.Nulls: return _nulls?.Length ?? 0;
        }
        var pages = new HashSet<int>();
        void Add((int From, int To) span)
        {
            for (var i = span.From; i <= span.To; i++)
                if (!_cache.ContainsKey(i)) pages.Add(i);
        }
        if (lookup is IndexLookup.In @in) foreach (var value in @in.Values) Add(PageSpan(new IndexLookup.Eq(value)));
        else Add(PageSpan(lookup));
        return pages.Sum(i => (long)_pages[i].At.Length);
    }

    public long[] Rows(IndexLookup lookup, long? scanRows = null)
    {
        switch (lookup)
        {
            case IndexLookup.Eq eq: return EqRows(eq.Value);
            case IndexLookup.In @in: return RowSet.Union(@in.Values.Select(EqRows).ToList());
            case IndexLookup.Nulls: return _nulls is { } at ? RowSet.DecodeSection(_load("nulls", at), "Index null postings") : Array.Empty<long>();
            case IndexLookup.Range or IndexLookup.Prefix:
            {
                var (from, to) = PageSpan(lookup);
                var lists = new List<long[]>();
                for (var j = from; j <= to; j++)
                    lists.Add(lookup is IndexLookup.Prefix prefix ? Page(j).Prefix(prefix.Text) : Page(j).Between((IndexLookup.Range)lookup));
                return RowSet.Union(lists);
            }
            default:
                return Array.Empty<long>();
        }
    }

    private long[] EqRows(object value)
    {
        if (Values.IsNaN(value)) return Array.Empty<long>();
        var i = PageFor(value);
        return i < 0 ? Array.Empty<long>() : Page(i).Eq(value);
    }
}

/// <summary>
/// A lookup an index answers, built from filter conditions by <see cref="Query.FilterEngine.IndexPlan"/>. Every index
/// reports the lookup's <see cref="IIndex.Cost"/> - the bytes of index data it still has to read, from what is already
/// in memory, without reading anything; null when it cannot answer - and its <see cref="IIndex.Rows"/>.
/// </summary>
internal abstract record IndexLookup
{
    public sealed record Eq(object Value) : IndexLookup;

    public sealed record In(object[] Values) : IndexLookup;

    /// <summary>Keys between Low and High; an absent bound is unbounded on that side.</summary>
    public sealed record Range(object? Low, bool LowInclusive, object? High, bool HighInclusive) : IndexLookup;

    public sealed record Prefix(string Text) : IndexLookup;

    public sealed record Nulls : IndexLookup;

    public sealed record Contains(string Text, bool CaseInsensitive) : IndexLookup;
}

/// <summary>An index of one column (one segment, or several combined).</summary>
internal interface IIndex
{
    /// <summary>Bytes of index data the lookup still has to read (nothing is read to answer this), or null when this index cannot answer it.</summary>
    long? Cost(IndexLookup lookup);

    /// <summary>
    /// The sorted row ids the lookup finds (a superset of the matching rows); or null, given the rows a scan would read
    /// (<paramref name="scanRows"/>), when the lookup narrows nothing (common text: <see cref="LazyTrigramIndex"/>).
    /// </summary>
    long[]? Rows(IndexLookup lookup, long? scanRows = null);
}

/// <summary>Combines the original index with one segment per append (row ids never overlap).</summary>
internal sealed class CompositeIndex(IReadOnlyList<IIndex> parts) : IIndex
{
    public long? Cost(IndexLookup lookup)
    {
        long total = 0;
        foreach (var part in parts)
        {
            if (part.Cost(lookup) is not { } cost) return null;
            total += cost;
        }
        return total;
    }

    public long[] Rows(IndexLookup lookup, long? scanRows = null) => RowSet.Union(parts.Select(p => p.Rows(lookup) ?? throw new InvalidOperationException("A sorted index answers every lookup it costs")).ToList());
}

/// <summary>
/// A trigram index read only when a lookup is made (one segment for the original rows, plus one per append): until then
/// a lookup costs the whole index's size, so a planner can choose a scan without reading it.
/// </summary>
internal sealed class LazyTrigramIndex(long bytes, Func<IReadOnlyList<TrigramIndex>> load) : IIndex
{
    private const double CommonShare = 0.25;
    private IReadOnlyList<TrigramIndex>? _segments;

    public long? Cost(IndexLookup lookup) =>
        lookup is IndexLookup.Contains c && TrigramIndex.Answers(c.Text, c.CaseInsensitive) ? (_segments is null ? bytes : 0) : null;

    /// <summary>
    /// Row ids that may match; or null, given the rows a scan would read, when the text is common: its rarest gram is in
    /// over a quarter of them, spread over more than three quarters. Its rows then fall in most chunks, and a scan checks
    /// each row more cheaply. Common text in rows that are together still uses the index, which skips the chunks around
    /// them.
    /// </summary>
    public long[]? Rows(IndexLookup lookup, long? scanRows = null)
    {
        var segments = _segments ??= load();
        if (scanRows is { } rows && segments.Sum(s => s.Bound(lookup)) > rows * CommonShare && segments.Sum(s => s.Span(lookup)) > rows * (1 - CommonShare))
            return null;
        // Segments hold different rows: each one's candidates are found apart, then united.
        return segments.Count == 1 ? segments[0].Rows(lookup) : RowSet.Union(segments.Select(s => s.Rows(lookup)).ToList());
    }

    /// <summary>Gives the segments' buffers back to the pool (the reader is closed).</summary>
    public void Release()
    {
        if (_segments is null) return;
        foreach (var segment in _segments) segment.Release();
        _segments = null;
    }
}

internal sealed class SortedIndex
{
    private readonly object[] _keys;
    private readonly long[][] _postings;

    private SortedIndex(object[] keys, long[][] postings)
    {
        _keys = keys;
        _postings = postings;
    }

    public int Count => _keys.Length;

    /// <summary>
    /// One page of a sorted index (spec 8.1): encoding byte, then entries. <paramref name="deltas"/>: the file has reader
    /// feature 'index-deltas', so the page may use encoding 1.
    /// </summary>
    public static SortedIndex DecodePage(byte[] raw, JazminType type, bool deltas = false)
    {
        var reader = new ByteReader(raw);
        var encoding = reader.Byte();
        var compact = deltas && encoding == FormatConstants.IndexDeltasEncoding;
        if (encoding != FormatConstants.PostingsEncoding && !compact)
            throw new JazminFormatException($"Index page uses encoding {encoding}, which this reader does not support");
        var (keys, postings) = compact ? ReadCompactEntries(reader, type) : ReadEntries(reader, type);
        if (!reader.Eof) throw new JazminFormatException("Index page has trailing bytes");
        return new SortedIndex(keys, postings);
    }

    private static (object[] Keys, long[][] Postings) ReadEntries(ByteReader reader, JazminType type)
    {
        var count = reader.Length();
        if (count > reader.Remaining) throw new JazminFormatException("Index page is truncated");
        var keys = new object[count];
        var postings = new long[count][];
        for (var i = 0; i < count; i++)
        {
            keys[i] = Values.DecodeKey(reader, type);
            postings[i] = RowSet.ReadPostings(reader);
        }
        return (keys, postings);
    }

    private static (object[] Keys, long[][] Postings) ReadCompactEntries(ByteReader reader, JazminType type)
    {
        var count = reader.Length();
        if (count > reader.Remaining) throw new JazminFormatException("Index page is truncated");
        var keys = new object[count];
        var postings = new long[count][];
        var pageKeys = new PageKeys(type);
        long previousFirst = 0;
        for (var i = 0; i < count; i++)
        {
            keys[i] = pageKeys.Read(reader);
            postings[i] = ReadRowIds(reader, previousFirst);
            previousFirst = postings[i][0];
        }
        return (keys, postings);
    }

    /// <summary>Postings of an entry in a page with encoding 1: the first row id is a zigzag difference from the previous entry's.</summary>
    private static long[] ReadRowIds(ByteReader reader, long previousFirst)
    {
        var count = reader.Length();
        if (count < 1 || count > reader.Remaining) throw new JazminFormatException("Postings are truncated"); // each takes at least one byte
        var ids = new long[count];
        var step = reader.VarInt();
        var previous = unchecked(previousFirst + step);
        if (previous < 0 || (step > 0 && previous < previousFirst)) throw new JazminFormatException("A row id is out of range");
        ids[0] = previous;
        for (var i = 1; i < count; i++)
        {
            var delta = reader.VarUInt();
            if (delta > (ulong)(long.MaxValue - previous)) throw new JazminFormatException("A row id is out of range");
            previous += (long)delta;
            ids[i] = previous;
        }
        return ids;
    }

    /// <summary>First position whose key is &gt;= value (or &gt; value when strict).</summary>
    private int Bound(object value, bool strict)
    {
        int lo = 0, hi = _keys.Length;
        while (lo < hi)
        {
            var mid = (lo + hi) >>> 1;
            var c = Values.Compare(_keys[mid], value) ?? 0;
            if (c < 0 || (strict && c == 0)) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    private long[] Span(int from, int to) => RowSet.Union(_postings[from..to]);

    public long[] Eq(object value)
    {
        if (Values.IsNaN(value)) return Array.Empty<long>();
        var i = Bound(value, false);
        return i < _keys.Length && Values.Compare(_keys[i], value) == 0 ? _postings[i] : Array.Empty<long>();
    }

    /// <summary>Rows whose key lies within the range (an absent bound: unbounded on that side).</summary>
    public long[] Between(IndexLookup.Range range)
    {
        var from = range.Low is null ? 0 : Bound(range.Low, !range.LowInclusive);
        var to = range.High is null ? _keys.Length : Bound(range.High, range.HighInclusive);
        return to > from ? Span(from, to) : Array.Empty<long>();
    }

    public long[] Prefix(string text)
    {
        var start = Bound(text, false);
        var end = start;
        while (end < _keys.Length && ((string)_keys[end]).StartsWith(text, StringComparison.Ordinal)) end++;
        return Span(start, end);
    }
}

internal static class Trigrams
{
    /// <summary>ASCII-only lower-casing, so every implementation builds identical indexes.</summary>
    public static string AsciiLower(string text)
    {
        var chars = text.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
            if (chars[i] is >= 'A' and <= 'Z') chars[i] = (char)(chars[i] + 32);
        return new string(chars);
    }

    public static HashSet<string> Of(string text)
    {
        var lower = AsciiLower(text);
        var grams = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i + 3 <= lower.Length; i++) grams.Add(lower.Substring(i, 3));
        return grams;
    }
}

internal sealed class TrigramIndexBuilder : IIndexBuilder
{
    // Gram -> row ids. A gram of chars (c0, c1, c2) is keyed as c0 << 32 | c1 << 16 | c2: no strings are
    // created while building, and numeric order equals ordinal string order.
    private readonly Dictionary<ulong, List<long>> _grams = new();

    public void Add(long rowId, object? internalValue)
    {
        if (internalValue is not string text || text.Length < 3) return;
        static ulong Lower(char c) => c is >= 'A' and <= 'Z' ? (ulong)(c + 32) : c; // same folding as AsciiLower
        ulong a = Lower(text[0]), b = Lower(text[1]);
        for (var i = 2; i < text.Length; i++)
        {
            var c = Lower(text[i]);
            var key = (a << 32) | (b << 16) | c;
            if (!_grams.TryGetValue(key, out var ids)) _grams[key] = new List<long> { rowId };
            else if (ids[^1] != rowId) ids.Add(rowId); // a gram repeated within one value counts once
            a = b;
            b = c;
        }
    }

    public byte[] Encode()
    {
        var writer = new ByteWriter();
        var grams = _grams.Keys.ToArray();
        Array.Sort(grams);
        writer.Byte(FormatConstants.PostingsEncoding);
        writer.VarUInt((ulong)grams.Length);
        foreach (var gram in grams)
        {
            writer.UInt16((ushort)(gram >> 32));
            writer.UInt16((ushort)(gram >> 16));
            writer.UInt16((ushort)gram);
            RowSet.WritePostings(writer, _grams[gram]);
        }
        return writer.ToArray();
    }
}

internal sealed class TrigramIndex
{
    private byte[] _raw;
    private readonly int _length; // the index's bytes are _raw[0.._length): a pooled buffer is longer
    private readonly bool _pooled;
    private readonly long[] _grams; // each gram as c0 << 32 | c1 << 16 | c2, ascending (ordinal order)
    private readonly int[] _offsets; // where each gram's postings start in _raw

    private TrigramIndex(byte[] raw, int length, bool pooled, long[] grams, int[] offsets)
    {
        _raw = raw;
        _length = length;
        _pooled = pooled;
        _grams = grams;
        _offsets = offsets;
    }

    /// <summary>Gives a pooled buffer back (the reader is closed): the index is not used again.</summary>
    public void Release()
    {
        if (_pooled && _raw.Length > 0) System.Buffers.ArrayPool<byte>.Shared.Return(_raw);
        _raw = [];
    }

    /// <summary>
    /// Reads where each gram's postings are, into two arrays: no strings are made, and no row ids until a lookup needs a
    /// gram's. Indexed text often repeats (names, categories), and then the postings are millions of row ids.
    /// </summary>
    public static TrigramIndex Decode(byte[] raw) => Decode(raw, raw.Length, pooled: false);

    /// <summary>
    /// An index in raw[0..length). With <paramref name="pooled"/>, raw was rented from the shared pool, and
    /// <see cref="Release"/> gives it back: a fresh array of megabytes for each reader made full collections frequent.
    /// </summary>
    public static TrigramIndex Decode(byte[] raw, int length, bool pooled)
    {
        var reader = new ByteReader(raw, 0, length);
        RowSet.CheckEncoding(reader, "Trigram index");
        var count = reader.Length();
        if (count > reader.Remaining / 7) throw new JazminFormatException("Trigram index is truncated"); // 6 bytes of gram, then postings
        var grams = new long[count];
        var offsets = new int[count];
        var ascending = true;
        for (var i = 0; i < count; i++)
        {
            long c0 = reader.UInt16(), c1 = reader.UInt16();
            var gram = c0 << 32 | c1 << 16 | reader.UInt16();
            if (i > 0 && gram <= grams[i - 1]) ascending = false;
            grams[i] = gram;
            offsets[i] = reader.Position;
            SkipPostings(reader, raw, length);
        }
        if (!reader.Eof) throw new JazminFormatException("Trigram index has trailing bytes");
        if (!ascending) Array.Sort(grams, offsets); // spec 8.2 orders the grams; an index that does not is still read
        return new TrigramIndex(raw, length, pooled, grams, offsets);
    }

    /// <summary>
    /// Steps over postings without making the row ids: eight bytes at a time, counting the bytes that end a varint (high
    /// bit clear). A window ends at most 8 varints, so while 8 or more are left it is stepped over whole.
    /// </summary>
    private static void SkipPostings(ByteReader reader, byte[] raw, int length)
    {
        var count = reader.Length();
        if (count > reader.Remaining) throw new JazminFormatException("Postings are truncated"); // each takes at least one byte
        var start = reader.Position;
        var pos = start;
        var left = count;
        for (; left >= 8 && pos <= length - 8; pos += 8)
            left -= System.Numerics.BitOperations.PopCount(~System.Buffers.Binary.BinaryPrimitives.ReadUInt64LittleEndian(raw.AsSpan(pos)) & 0x8080808080808080UL);
        for (; left > 0; pos++)
        {
            if (pos >= length) throw new JazminFormatException("Postings are truncated");
            if ((raw[pos] & 0x80) == 0) left--;
        }
        reader.Skip(pos - start);
    }

    /// <summary>The postings of each gram of the text, rarest first, as (At, Count); or null when a gram is in no row.</summary>
    private List<(int At, int Count)>? Lists(string text)
    {
        var lists = new List<(int At, int Count)>();
        foreach (var gram in Trigrams.Of(text))
        {
            var i = Array.BinarySearch(_grams, (long)gram[0] << 32 | (long)gram[1] << 16 | gram[2]);
            if (i < 0) return null;
            lists.Add((_offsets[i], new ByteReader(_raw, _offsets[i], _length).Length()));
        }
        lists.Sort((x, y) => x.Count.CompareTo(y.Count));
        return lists;
    }

    /// <summary>At most how many rows <see cref="Rows"/> returns: those of the text's rarest gram, from the postings' counts alone.</summary>
    public long Bound(IndexLookup lookup) => Lists(((IndexLookup.Contains)lookup).Text) is { Count: > 0 } lists ? lists[0].Count : 0;

    /// <summary>How far apart the rows of the text's rarest gram are: from its first row id to its last, inclusive.</summary>
    public long Span(IndexLookup lookup)
    {
        if (Lists(((IndexLookup.Contains)lookup).Text) is not { Count: > 0 } lists) return 0;
        var reader = new ByteReader(_raw, lists[0].At, _length);
        var count = reader.Length();
        long first = 0, last = 0;
        for (var i = 0; i < count; i++)
        {
            last += (long)reader.VarUInt();
            if (i == 0) first = last;
        }
        return count > 0 ? last - first + 1 : 0;
    }

    /// <summary>Whether a trigram index can narrow a search for the text: not under 3 characters, nor case-insensitive non-ASCII.</summary>
    public static bool Answers(string text, bool caseInsensitive) => !(caseInsensitive && text.Any(c => c > 0x7f)) && Trigrams.Of(text).Count > 0;

    /// <summary>Superset of rows that may contain the text (a search the index <see cref="Answers"/>).</summary>
    public long[] Rows(IndexLookup lookup)
    {
        if (Lists(((IndexLookup.Contains)lookup).Text) is not { Count: > 0 } lists) return Array.Empty<long>();
        // From the rarest gram, so the ids kept shrink fastest; the other grams' postings are intersected as they are read.
        var result = RowSet.ReadPostings(new ByteReader(_raw, lists[0].At, _length));
        for (var i = 1; i < lists.Count && result.Length > 0; i++) result = IntersectPostings(new ByteReader(_raw, lists[i].At, _length), result);
        return result;
    }

    /// <summary>Postings intersected with the sorted row ids <paramref name="ids"/> as they are read, kept in place in <paramref name="ids"/>.</summary>
    private static long[] IntersectPostings(ByteReader reader, long[] ids)
    {
        var count = reader.Length();
        if (count > reader.Remaining) throw new JazminFormatException("Postings are truncated"); // each takes at least one byte
        long previous = 0;
        int j = 0, kept = 0;
        for (var i = 0; i < count && j < ids.Length; i++)
        {
            previous += (long)reader.VarUInt();
            while (j < ids.Length && ids[j] < previous) j++;
            if (j < ids.Length && ids[j] == previous) ids[kept++] = ids[j++];
        }
        return kept == ids.Length ? ids : ids[..kept];
    }
}

/// <summary>
/// The keys of a sorted index page with encoding 1 (reader feature 'index-deltas', spec 8.1), written or read in order:
/// an int or datetime key as the difference from the previous key (the first as in encoding 0), a string key as the
/// number of UTF-8 bytes it shares with the previous key and the bytes after them. Keys of other types are as in
/// encoding 0.
/// </summary>
internal sealed class PageKeys(JazminType type)
{
    private bool _started;
    private long _previous;
    private byte[] _bytes = new byte[64]; // strings: the previous key's UTF-8 bytes (a buffer reused while reading)
    private int _length;

    public void Reset()
    {
        _started = false;
        _length = 0;
    }

    /// <summary>Writes the key; returns the size it takes in encoding 0.</summary>
    public int Write(ByteWriter writer, object key)
    {
        switch (type)
        {
            case JazminType.Int:
            case JazminType.DateTime:
            {
                var value = (long)key;
                if (_started) writer.VarUInt(unchecked((ulong)value - (ulong)_previous)); // keys ascend: the difference fits
                else writer.VarInt(value);
                (_previous, _started) = (value, true);
                return ByteWriter.VarIntSize(value);
            }
            case JazminType.String:
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes((string)key);
                var max = Math.Min(bytes.Length, _length);
                var shared = 0;
                while (shared < max && bytes[shared] == _bytes[shared]) shared++;
                writer.VarUInt((ulong)shared);
                writer.VarUInt((ulong)(bytes.Length - shared));
                writer.Bytes(bytes.AsSpan(shared));
                (_bytes, _length) = (bytes, bytes.Length);
                return ByteWriter.VarUIntSize((ulong)bytes.Length) + bytes.Length;
            }
            default:
            {
                var start = writer.Length;
                Values.Encode(writer, type, key); // written as in encoding 0
                return writer.Length - start;
            }
        }
    }

    public object Read(ByteReader reader)
    {
        switch (type)
        {
            case JazminType.Int:
            case JazminType.DateTime:
            {
                long value;
                if (!_started) value = reader.VarInt();
                else
                {
                    var step = reader.VarUInt();
                    if (step == 0 || step > unchecked((ulong)long.MaxValue - (ulong)_previous)) throw new JazminFormatException("Index page keys are not ascending");
                    value = unchecked((long)((ulong)_previous + step));
                }
                (_previous, _started) = (value, true);
                return value;
            }
            case JazminType.String:
            {
                var shared = reader.Length();
                var rest = reader.Length();
                if (shared > _length || rest > reader.Remaining) throw new JazminFormatException("Index page is truncated");
                var length = shared + rest;
                if (_bytes.Length < length)
                {
                    var grown = new byte[Math.Max(length, _bytes.Length * 2)];
                    Array.Copy(_bytes, grown, shared);
                    _bytes = grown;
                }
                reader.Bytes(rest).CopyTo(_bytes.AsSpan(shared));
                _length = length;
                return System.Text.Encoding.UTF8.GetString(_bytes, 0, length);
            }
            default:
                return Values.DecodeKey(reader, type);
        }
    }
}
