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
    private readonly Dictionary<object, List<long>> _entries = new();
    private readonly List<long> _nulls = new();

    public void Add(long rowId, object? internalValue)
    {
        if (internalValue is null)
        {
            _nulls.Add(rowId);
            return;
        }
        var key = Values.ToKey(type, internalValue);
        if (Values.IsNaN(key)) return; // NaN is never indexed
        if (!_entries.TryGetValue(key, out var ids)) _entries[key] = ids = new List<long>();
        ids.Add(rowId);
    }

    /// <summary>Row ids of null cells.</summary>
    public IReadOnlyList<long> Nulls => _nulls;

    private object[] SortedKeys()
    {
        var keys = _entries.Keys.ToArray();
        Array.Sort(keys, KeyComparer.Instance);
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
        object? first = null;
        var count = 0;
        foreach (var key in SortedKeys())
        {
            if (count == 0) first = key;
            Values.Encode(body, type, key);
            RowSet.WritePostings(body, _entries[key]);
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
internal sealed class PagedSortedIndex : ISortedIndex
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

    public long[] Nulls => _nulls is { } at ? RowSet.DecodeSection(_load("nulls", at), "Index null postings") : Array.Empty<long>();

    public long[] Eq(object value)
    {
        if (Values.IsNaN(value)) return Array.Empty<long>();
        var i = PageFor(value);
        return i < 0 ? Array.Empty<long>() : Page(i).Eq(value);
    }

    /// <summary>Reads only the pages the range spans.</summary>
    public long[] Range(string op, object value)
    {
        if (Values.IsNaN(value)) return Array.Empty<long>();
        var i = PageFor(value);
        var lists = new List<long[]>();
        if (op is "gt" or "gte")
            for (var j = Math.Max(i, 0); j < _pages.Length; j++) lists.Add(Page(j).Range(op, value));
        else
            for (var j = 0; j <= i; j++) lists.Add(Page(j).Range(op, value));
        return RowSet.Union(lists);
    }

    public long[] Prefix(string text)
    {
        var lists = new List<long[]>();
        // Keys starting with the text are contiguous: continue while the next page may still start with it.
        for (var j = Math.Max(PageFor(text), 0); j < _pages.Length; j++)
        {
            lists.Add(Page(j).Prefix(text));
            if (j + 1 >= _pages.Length || !((string)_pages[j + 1].First).StartsWith(text, StringComparison.Ordinal)) break;
        }
        return RowSet.Union(lists);
    }
}

/// <summary>Lookups a sorted index answers (one segment, or several combined).</summary>
internal interface ISortedIndex
{
    long[] Nulls { get; }
    long[] Eq(object value);
    long[] Range(string op, object value);
    long[] Prefix(string text);
}

/// <summary>Lookups a trigram index answers (one segment, or several combined).</summary>
internal interface ITrigramIndex
{
    long[]? Candidates(string text, bool caseInsensitive);
}

/// <summary>Combines the original index with one segment per append (row ids never overlap).</summary>
internal sealed class CompositeSortedIndex(IReadOnlyList<ISortedIndex> parts) : ISortedIndex
{
    public long[] Nulls => RowSet.Union(parts.Select(p => p.Nulls).ToList());
    public long[] Eq(object value) => RowSet.Union(parts.Select(p => p.Eq(value)).ToList());
    public long[] Range(string op, object value) => RowSet.Union(parts.Select(p => p.Range(op, value)).ToList());
    public long[] Prefix(string text) => RowSet.Union(parts.Select(p => p.Prefix(text)).ToList());
}

internal sealed class CompositeTrigramIndex(IReadOnlyList<ITrigramIndex> parts) : ITrigramIndex
{
    public long[]? Candidates(string text, bool caseInsensitive)
    {
        var lists = new List<long[]>();
        foreach (var part in parts)
        {
            var ids = part.Candidates(text, caseInsensitive);
            if (ids is null) return null;
            lists.Add(ids);
        }
        return RowSet.Union(lists);
    }
}

internal sealed class SortedIndex : ISortedIndex
{
    private readonly object[] _keys;
    private readonly long[][] _postings;

    private SortedIndex(object[] keys, long[][] postings)
    {
        _keys = keys;
        _postings = postings;
    }

    public long[] Nulls => Array.Empty<long>(); // a page holds no null postings

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

    public long[] Range(string op, object value)
    {
        if (Values.IsNaN(value)) return Array.Empty<long>();
        return op switch
        {
            "gt" => Span(Bound(value, true), _keys.Length),
            "gte" => Span(Bound(value, false), _keys.Length),
            "lt" => Span(0, Bound(value, false)),
            "lte" => Span(0, Bound(value, true)),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
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

internal sealed class TrigramIndex : ITrigramIndex
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

    /// <summary>
    /// Superset of rows that may contain the text, or null when the index cannot help
    /// (text shorter than 3, or case-insensitive search with non-ASCII characters).
    /// </summary>
    public long[]? Candidates(string text, bool caseInsensitive)
    {
        if (caseInsensitive && text.Any(c => c > 0x7f)) return null;
        var grams = Trigrams.Of(text);
        if (grams.Count == 0) return null;
        long[]? result = null;
        foreach (var gram in grams)
        {
            if (!_grams.TryGetValue(gram, out var ids)) return Array.Empty<long>();
            result = result is null ? ids : RowSet.Intersect(result, ids);
            if (result.Length == 0) return result;
        }
        return result;
    }
}
