using System.Collections;

namespace Jazmin;

/// <summary>
/// One row. Values: bool, long, double, string, DateTime (UTC), byte[], JsonNode, or null.
/// Decimal columns are exact strings (use <see cref="GetDecimal"/> for System.Decimal).
/// </summary>
public sealed class JazminRow : IReadOnlyDictionary<string, object?>
{
    private readonly RowShape _shape;
    private object?[]? _values;
    private readonly Format.DecodedColumn?[]? _chunkColumns; // columnar scans: the chunk's typed columns (no copy per row)
    private readonly int _index;

    internal JazminRow(long rowId, RowShape shape, object?[] values)
    {
        RowId = rowId;
        _shape = shape;
        _values = values;
    }

    /// <summary>A row that reads its values from a decoded columnar chunk (columns not decoded read as null).</summary>
    internal JazminRow(long rowId, RowShape shape, Format.DecodedColumn?[] chunkColumns, int index)
    {
        RowId = rowId;
        _shape = shape;
        _chunkColumns = chunkColumns;
        _index = index;
    }

    internal IReadOnlyList<JazminColumn> Columns => _shape.Columns;

    /// <summary>A columnar scan's row: the chunk's decoded columns (null otherwise) and the row's position in them.</summary>
    internal Format.DecodedColumn?[]? ChunkColumns => _chunkColumns;

    internal int ChunkIndex => _index;

    /// <summary>Value by position in the file's full column list (ignores Select).</summary>
    internal object? ValueAt(int columnIndex) => _values is not null ? _values[columnIndex] : _chunkColumns![columnIndex]?.Get(_index);

    /// <summary>The row's values in full column order (shared with the reader's chunk cache - do not modify).</summary>
    internal object?[] RawValues
    {
        get
        {
            if (_values is null)
            {
                var values = new object?[_shape.Columns.Count];
                for (var c = 0; c < values.Length; c++) values[c] = _chunkColumns![c]?.Get(_index);
                _values = values;
            }
            return _values;
        }
    }

    /// <summary>Zero-based position of this row in the file.</summary>
    public long RowId { get; }

    public int Count => _shape.Selection.Length;

    public IEnumerable<string> Keys => _shape.Selection.Select(i => _shape.Columns[i].Name);

    public IEnumerable<object?> Values => _shape.Selection.Select(ValueAt);

    public object? this[string key] => TryGetValue(key, out var value) ? value : throw new KeyNotFoundException($"Column '{key}' is not in this row");

    /// <summary>Value by position within the selected columns.</summary>
    public object? this[int ordinal] => ValueAt(_shape.Selection[ordinal]);

    public bool ContainsKey(string key) => _shape.IndexOf(key) >= 0;

    public bool TryGetValue(string key, out object? value)
    {
        var i = _shape.IndexOf(key);
        value = i >= 0 ? ValueAt(i) : null;
        return i >= 0;
    }

    public T? Get<T>(string column) => (T?)this[column];

    public decimal? GetDecimal(string column) =>
        this[column] is string s ? decimal.Parse(s, System.Globalization.CultureInfo.InvariantCulture) : null;

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() =>
        _shape.Selection.Select(i => new KeyValuePair<string, object?>(_shape.Columns[i].Name, ValueAt(i))).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

/// <summary>
/// What all rows of one query share: the file's columns, the selected positions, and a name lookup built the first
/// time a value is read by name.
/// </summary>
internal sealed class RowShape(IReadOnlyList<JazminColumn> columns, int[] selection)
{
    private const int ScanUpTo = 8; // up to this many columns, comparing each name is faster than the lookup
    private Dictionary<string, int>? _byName;

    public IReadOnlyList<JazminColumn> Columns { get; } = columns;

    public int[] Selection { get; } = selection;

    /// <summary>Position in <see cref="Columns"/> of the selected column with this exact name, or -1.</summary>
    public int IndexOf(string key)
    {
        if (Selection.Length <= ScanUpTo)
        {
            foreach (var i in Selection)
                if (Columns[i].Name == key) return i;
            return -1;
        }
        var byName = Volatile.Read(ref _byName) ?? ByName();
        return key is not null && byName.TryGetValue(key, out var index) ? index : -1; // null: not found, as a scan finds
    }

    private Dictionary<string, int> ByName()
    {
        var byName = new Dictionary<string, int>(Selection.Length, StringComparer.Ordinal);
        foreach (var i in Selection) byName.TryAdd(Columns[i].Name, i); // a column selected twice: the first, as a scan finds
        return Interlocked.CompareExchange(ref _byName, byName, null) ?? byName; // rows read on several threads share one
    }
}
