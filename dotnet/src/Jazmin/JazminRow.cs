using System.Collections;

namespace Jazmin;

/// <summary>
/// One row. Values: bool, long, double, string, DateTime (UTC), byte[], JsonNode, or null.
/// Decimal columns are exact strings (use <see cref="GetDecimal"/> for System.Decimal).
/// </summary>
public sealed class JazminRow : IReadOnlyDictionary<string, object?>
{
    private readonly IReadOnlyList<JazminColumn> _columns;
    private readonly int[] _selection;
    private object?[]? _values;
    private readonly Format.DecodedColumn?[]? _chunkColumns; // columnar scans: the chunk's typed columns (no copy per row)
    private readonly int _index;

    internal JazminRow(long rowId, IReadOnlyList<JazminColumn> columns, int[] selection, object?[] values)
    {
        RowId = rowId;
        _columns = columns;
        _selection = selection;
        _values = values;
    }

    /// <summary>A row that reads its values from a decoded columnar chunk (columns not decoded read as null).</summary>
    internal JazminRow(long rowId, IReadOnlyList<JazminColumn> columns, int[] selection, Format.DecodedColumn?[] chunkColumns, int index)
    {
        RowId = rowId;
        _columns = columns;
        _selection = selection;
        _chunkColumns = chunkColumns;
        _index = index;
    }

    internal IReadOnlyList<JazminColumn> Columns => _columns;

    /// <summary>Value by position in the file's full column list (ignores Select).</summary>
    internal object? ValueAt(int columnIndex) => _values is not null ? _values[columnIndex] : _chunkColumns![columnIndex]?.Get(_index);

    /// <summary>The row's values in full column order (shared with the reader's chunk cache - do not modify).</summary>
    internal object?[] RawValues
    {
        get
        {
            if (_values is null)
            {
                var values = new object?[_columns.Count];
                for (var c = 0; c < values.Length; c++) values[c] = _chunkColumns![c]?.Get(_index);
                _values = values;
            }
            return _values;
        }
    }

    /// <summary>Zero-based position of this row in the file.</summary>
    public long RowId { get; }

    public int Count => _selection.Length;

    public IEnumerable<string> Keys => _selection.Select(i => _columns[i].Name);

    public IEnumerable<object?> Values => _selection.Select(ValueAt);

    public object? this[string key] => TryGetValue(key, out var value) ? value : throw new KeyNotFoundException($"Column '{key}' is not in this row");

    /// <summary>Value by position within the selected columns.</summary>
    public object? this[int ordinal] => ValueAt(_selection[ordinal]);

    public bool ContainsKey(string key) => IndexOf(key) >= 0;

    public bool TryGetValue(string key, out object? value)
    {
        var i = IndexOf(key);
        value = i >= 0 ? ValueAt(i) : null;
        return i >= 0;
    }

    public T? Get<T>(string column) => (T?)this[column];

    public decimal? GetDecimal(string column) =>
        this[column] is string s ? decimal.Parse(s, System.Globalization.CultureInfo.InvariantCulture) : null;

    private int IndexOf(string key)
    {
        foreach (var i in _selection)
            if (_columns[i].Name == key) return i;
        return -1;
    }

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() =>
        _selection.Select(i => new KeyValuePair<string, object?>(_columns[i].Name, ValueAt(i))).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
