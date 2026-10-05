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
    // Distinct keys in the order first seen, each with its first row id; later row ids only for keys seen again, so a
    // column of unique values (ids) needs no list per key. Entries are kept in blocks small enough to stay off the large
    // object heap: growing one large array would force full garbage collections of the writer's whole heap.
    private const int BlockSize = 2048;
    private struct Entry
    {
        public object Key;
        public long FirstRow;
        public List<long>? MoreRows;
    }

    private readonly List<Entry[]> _blocks = new();
    private int _count;
    private Dictionary<object, int>? _positions; // made when keys stop arriving in ascending order
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
            if (order >= 0) _positions = Positions();
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

    private Dictionary<object, int> Positions()
    {
        var positions = new Dictionary<object, int>(_count * 2);
        for (var i = 0; i < _count; i++) positions.Add(At(i).Key, i);
        return positions;
    }

    /// <summary>Row ids of null cells.</summary>
    public IReadOnlyList<long> Nulls => _nulls;

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
    /// First is the page's smallest key in bound form, Raw = encoding byte + varint count + entries.
    /// A small index is one page. Row ids of null cells are in <see cref="Nulls"/>.
    /// </summary>
    public IEnumerable<(byte[] First, int Count, byte[] Raw)> Pages(int pageBytes)
    {
        var body = new ByteWriter(Math.Min(pageBytes * 2, 1 << 20));
        var postings = new List<long>();
        object? first = null;
        var count = 0;
        foreach (var at in SortedPositions())
        {
            var entry = At(at);
            if (count == 0) first = entry.Key;
            Values.Encode(body, type, entry.Key);
            postings.Clear();
            postings.Add(entry.FirstRow);
            if (entry.MoreRows is { } more) postings.AddRange(more);
            RowSet.WritePostings(body, postings);
            count++;
            if (body.Length < pageBytes) continue;
            yield return (Bounds.Encode(type, first!), count, PageBytes(count, body));
            body.Reset();
            count = 0;
        }
        if (count > 0) yield return (Bounds.Encode(type, first!), count, PageBytes(count, body));
    }

    private static byte[] PageBytes(int count, ByteWriter body)
    {
        var raw = new ByteWriter(body.Length + 11);
        raw.Byte(FormatConstants.PostingsEncoding);
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

    public PagedSortedIndex(IndexDirectory directory, JazminType type, Func<string, SectionRef, byte[]> load)
    {
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
            page = SortedIndex.DecodePage(_load($"page/{i}", _pages[i].At), _type);
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

    public long[] Rows(IndexLookup lookup)
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

    /// <summary>The sorted row ids the lookup finds (a superset of the matching rows).</summary>
    long[] Rows(IndexLookup lookup);
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

    public long[] Rows(IndexLookup lookup) => RowSet.Union(parts.Select(p => p.Rows(lookup)).ToList());
}

/// <summary>A trigram index read only when a lookup is made: until then a lookup costs the whole index's size.</summary>
internal sealed class LazyTrigramIndex(long bytes, Func<IIndex> load) : IIndex
{
    private IIndex? _index;

    public long? Cost(IndexLookup lookup) =>
        lookup is IndexLookup.Contains c && TrigramIndex.Answers(c.Text, c.CaseInsensitive) ? (_index is null ? bytes : 0) : null;

    public long[] Rows(IndexLookup lookup) => (_index ??= load()).Rows(lookup);
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

    /// <summary>One page of a sorted index (spec 8.1): encoding byte, then entries.</summary>
    public static SortedIndex DecodePage(byte[] raw, JazminType type)
    {
        var reader = new ByteReader(raw);
        RowSet.CheckEncoding(reader, "Index page");
        var (keys, postings) = ReadEntries(reader, type);
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

internal sealed class TrigramIndex : IIndex
{
    private readonly Dictionary<string, long[]> _grams;

    private TrigramIndex(Dictionary<string, long[]> grams) => _grams = grams;

    public static TrigramIndex Decode(byte[] raw)
    {
        var reader = new ByteReader(raw);
        RowSet.CheckEncoding(reader, "Trigram index");
        var count = reader.Length();
        if (count > reader.Remaining / 7) throw new JazminFormatException("Trigram index is truncated"); // 6 bytes of gram, then postings
        var grams = new Dictionary<string, long[]>(count, StringComparer.Ordinal);
        for (var i = 0; i < count; i++)
        {
            var gram = new string(new[] { (char)reader.UInt16(), (char)reader.UInt16(), (char)reader.UInt16() });
            grams[gram] = RowSet.ReadPostings(reader);
        }
        if (!reader.Eof) throw new JazminFormatException("Trigram index has trailing bytes");
        return new TrigramIndex(grams);
    }

    /// <summary>Whether a trigram index can narrow a search for the text: not under 3 characters, nor case-insensitive non-ASCII.</summary>
    public static bool Answers(string text, bool caseInsensitive) => !(caseInsensitive && text.Any(c => c > 0x7f)) && Trigrams.Of(text).Count > 0;

    public long? Cost(IndexLookup lookup) => lookup is IndexLookup.Contains c && Answers(c.Text, c.CaseInsensitive) ? 0 : null;

    /// <summary>Superset of rows that may contain the text (a search the index <see cref="Answers"/>).</summary>
    public long[] Rows(IndexLookup lookup)
    {
        var grams = Trigrams.Of(((IndexLookup.Contains)lookup).Text);
        long[]? result = null;
        foreach (var gram in grams)
        {
            if (!_grams.TryGetValue(gram, out var ids)) return Array.Empty<long>();
            result = result is null ? ids : RowSet.Intersect(result, ids);
            if (result.Length == 0) return result;
        }
        return result ?? Array.Empty<long>();
    }
}
