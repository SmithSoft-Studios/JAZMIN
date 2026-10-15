namespace Jazmin;

/// <summary>
/// Rows put into a new sort order within a memory budget, for a rewrite that changes a table's SortedBy
/// (<see cref="JazminFile.Update"/>). Up to <c>runRows</c> rows are sorted in memory; beyond that each run of sorted rows
/// is written to a temporary JAZMIN file locked with a key made for it and never kept, so no row reaches the disk
/// readable, and the runs are then merged as they are read back. Equal keys keep the order the rows came in. The same as
/// the JavaScript library's sort-rows.js.
/// </summary>
internal sealed class RowSorter : IDisposable
{
    /// <summary>Rows sorted in memory at a time, by priority: larger runs gave no more speed, only memory.</summary>
    public static int RunRows(JazminPriority priority) => priority switch
    {
        JazminPriority.Memory => 10_000,
        JazminPriority.Speed => 100_000,
        _ => 25_000,
    };

    private const int RunChunkRows = 512; // the merge decodes one chunk of each run at a time

    private readonly IReadOnlyList<JazminColumn> _columns;
    private readonly Func<object?[], object?[]> _sortKey;
    private readonly int _runRows;
    private readonly JazminCodec _codec;
    private readonly List<(object?[] Key, object?[] Values)> _buffer = new();
    private readonly List<(string File, JazminKey Key)> _runs = new();
    private readonly List<JazminReader> _readers = new();
    private string? _dir;

    private readonly Action<int>? _onSorted;

    /// <summary><paramref name="onSorted"/>: called with the number of rows each time a run of them is sorted (progress).</summary>
    public RowSorter(IReadOnlyList<JazminColumn> columns, Func<object?[], object?[]> sortKey, int runRows, JazminCodec codec, Action<int>? onSorted = null)
    {
        _onSorted = onSorted;
        if (runRows < 1) throw new JazminValidationException("The sort needs at least 1 row in memory");
        _columns = columns.Select(c => c.With([])).ToList(); // the runs need no indexes
        _sortKey = sortKey;
        _runRows = runRows;
        _codec = codec;
    }

    /// <summary>How many runs went to temporary files (0: sorted in memory).</summary>
    public int Runs => _runs.Count;

    /// <summary>Adds a row's values (not changed afterwards: the sorter keeps them until written).</summary>
    public void Add(object?[] values)
    {
        _buffer.Add((_sortKey(values), values));
        if (_buffer.Count >= _runRows) Spill();
    }

    private static readonly Comparer<object?[]> KeyOrder = Comparer<object?[]>.Create(SortKeys.Compare);

    /// <summary>The buffered rows, sorted; equal keys in the order they came (OrderBy is a stable sort).</summary>
    private List<(object?[] Key, object?[] Values)> Sorted()
    {
        var sorted = _buffer.OrderBy(entry => entry.Key, KeyOrder).ToList();
        _buffer.Clear();
        return sorted;
    }

    /// <summary>Writes the buffered rows, sorted, as a run in a temporary file locked with a key of its own.</summary>
    private void Spill()
    {
        if (_buffer.Count == 0) return;
        _dir ??= Directory.CreateTempSubdirectory("jazmin-sort-").FullName;
        var file = Path.Combine(_dir, $"run-{_runs.Count}.jzm");
        var count = _buffer.Count;
        var key = JazminKey.Generate();
        // Small chunks, light compression and one thread: the merge holds one decoded chunk per run, read once.
        using (var writer = JazminWriter.Create(file, _columns, new JazminWriteOptions
        {
            Key = key, Codec = _codec, CompressionLevel = 1, ChunkRows = RunChunkRows, MaxDegreeOfParallelism = 1,
        }))
        {
            foreach (var (_, values) in Sorted()) writer.WriteValues(values);
        }
        _runs.Add((file, key));
        _onSorted?.Invoke(count);
    }

    /// <summary>Every row added, in the new order. Call once, then dispose.</summary>
    public IEnumerable<object?[]> Rows()
    {
        if (_runs.Count == 0)
        {
            var sorted = Sorted();
            _onSorted?.Invoke(sorted.Count);
            foreach (var (_, values) in sorted) yield return values;
            yield break;
        }
        Spill();
        // A k-way merge of the runs: each run's next row, by key and then by run (runs keep the rows' order).
        var heads = new PriorityQueue<(int Run, IEnumerator<JazminRow> Rows, object?[] Values), (object?[] Key, int Run)>(
            Comparer<(object?[] Key, int Run)>.Create((a, b) =>
            {
                var c = SortKeys.Compare(a.Key, b.Key);
                return c != 0 ? c : a.Run.CompareTo(b.Run);
            }));
        for (var i = 0; i < _runs.Count; i++)
        {
            var reader = JazminReader.Open(_runs[i].File, new JazminReadOptions { Key = _runs[i].Key });
            _readers.Add(reader);
            var rows = reader.Rows().GetEnumerator();
            if (rows.MoveNext())
            {
                var values = rows.Current.RawValues;
                heads.Enqueue((i, rows, values), (_sortKey(values), i));
            }
        }
        while (heads.TryDequeue(out var head, out _))
        {
            yield return head.Values;
            if (head.Rows.MoveNext())
            {
                var values = head.Rows.Current.RawValues;
                heads.Enqueue((head.Run, head.Rows, values), (_sortKey(values), head.Run));
            }
        }
    }

    /// <summary>Closes the runs and deletes their files.</summary>
    public void Dispose()
    {
        foreach (var reader in _readers) reader.Dispose();
        _readers.Clear();
        _buffer.Clear();
        if (_dir is not null)
        {
            try { Directory.Delete(_dir, recursive: true); } catch (IOException) { } // best effort: the temp folder
            _dir = null;
        }
    }
}
