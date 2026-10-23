using Jazmin.Query;

namespace Jazmin;

// Several calls written as one append (GitHub #275). Each append flushes to disk twice (spec 11.2), whatever its size,
// so one append for many calls costs about what one call does. The calls are written in call order, and each call's
// delete and upsert see the file as the earlier calls leave it: the file ends up as running the calls one after another
// would. A call that would see a row an earlier call adds is a clash (JazminFile.OrderedRows): a transaction refuses it,
// and the group writer starts a new append there.

/// <summary>
/// Calls collected in memory and written by <see cref="Commit"/> as one append: all of them or none, with one pair of
/// flushes to disk. They are written in call order, and each call's delete and upsert see the file as the earlier calls
/// leave it. A call that would see a row an earlier call adds (a delete matching it, an upsert with its key, rows sorting
/// before it in a sorted file) is refused at commit. No lock or file handle is held until then. Disposing without
/// committing rolls back. Not for use from several threads at once.
/// </summary>
public sealed class JazminTransaction : IDisposable
{
    private readonly string _path;
    private readonly JazminAppend _options;
    private List<JazminFile.AppendCall> _calls = [];
    private string _state = "open";

    internal JazminTransaction(string path, JazminAppend options)
    {
        ArgumentNullException.ThrowIfNull(path);
        foreach (var (name, given) in new[] { ("Insert", options.Insert.Count > 0), ("Upsert", options.Upsert.Count > 0), ("Delete", options.Delete is not null) })
            if (given) throw new JazminValidationException($"BeginAppend: give rows to change with the transaction's {name}, not as the {name} option");
        _path = path;
        _options = options;
    }

    public void Insert(IEnumerable<IReadOnlyDictionary<string, object?>> rows)
    {
        Open();
        _calls.Add(new JazminFile.AppendCall(JazminAppendWriter.RowList(rows), [], null));
    }

    /// <summary>Rows that replace rows with the same <see cref="JazminAppend.KeyColumns"/> (given to BeginAppend).</summary>
    public void Upsert(IEnumerable<IReadOnlyDictionary<string, object?>> rows)
    {
        Open();
        JazminAppendWriter.NeedsKeyColumns(_options);
        _calls.Add(new JazminFile.AppendCall([], JazminAppendWriter.RowList(rows), null));
    }

    public void Delete(JazminFilter filter)
    {
        Open();
        ArgumentNullException.ThrowIfNull(filter);
        _calls.Add(new JazminFile.AppendCall([], [], filter));
    }

    /// <summary>Writes the calls as one append and returns its result. If it fails the file is left as it was; either way the transaction ends.</summary>
    public JazminAppendResult Commit()
    {
        Open();
        _state = "failed";
        var calls = _calls;
        _calls = [];
        var (result, _) = JazminFile.AppendCallsLocked(_path, _options, calls, split: false);
        _state = "committed";
        return result;
    }

    /// <summary>Discards the calls: nothing was written.</summary>
    public void Rollback()
    {
        Open();
        _state = "rolled back";
        _calls = [];
    }

    /// <summary>Rolls back unless the transaction has ended.</summary>
    public void Dispose()
    {
        if (_state == "open") Rollback();
    }

    private void Open()
    {
        if (_state == "open") return;
        throw new JazminValidationException(_state == "failed"
            ? "This transaction failed to commit and has ended: begin a new one"
            : $"This transaction is already {_state}: begin a new one");
    }
}

/// <summary>
/// Many callers' changes merged into few appends (group commit), safe for concurrent callers. Each call completes with
/// the result of the append that wrote it, shared by the other calls in that batch, or fails with its own error: a
/// failed batch is tried again in halves. One background task writes: a batch starts when the first call arrives (or
/// after maxDelay) and takes calls up to maxRows rows; calls made while a batch is written make the next one. Calls are
/// written in call order; a call that would see a row an earlier call adds starts a new append.
/// </summary>
public sealed class JazminAppendWriter : IAsyncDisposable
{
    private sealed record Item(JazminFile.AppendCall Call, int Rows, TaskCompletionSource<JazminAppendResult> Done);

    private readonly string _path;
    private readonly JazminAppend _options;
    private readonly TimeSpan _maxDelay;
    private readonly int _maxRows;
    private readonly object _gate = new();
    private readonly Queue<Item> _queue = new();
    private int _queuedRows;
    private bool _running;
    private bool _closed;
    private TaskCompletionSource _wake = new(TaskCreationOptions.RunContinuationsAsynchronously); // ends a maxDelay wait early
    private Task _last = Task.CompletedTask;

    internal JazminAppendWriter(string path, JazminAppend options, TimeSpan maxDelay, int maxRows)
    {
        ArgumentNullException.ThrowIfNull(path);
        foreach (var (name, given) in new[]
        {
            ("Insert", options.Insert.Count > 0), ("Upsert", options.Upsert.Count > 0), ("Delete", options.Delete is not null),
        })
            if (given) throw new JazminValidationException($"OpenWriter: give rows to change with the writer's {name}Async, not as the {name} option");
        foreach (var (name, given) in new[]
        {
            ("Metadata", options.Metadata is not null), ("Grant", options.Grant.Count > 0), ("AddFiles", options.AddFiles.Count > 0),
            ("RemoveFiles", options.RemoveFiles.Count > 0), ("Package", options.Package is not null), ("AddShapes", options.AddShapes.Count > 0),
            ("RemoveShapes", options.RemoveShapes.Count > 0), ("Locks", options.Locks is not null), ("Columns", options.Columns is not null),
        })
            if (given) throw new JazminValidationException($"OpenWriter: {name} changes the file as a whole, and every batch would write it again; use JazminFile.Append or BeginAppend for it");
        if (maxRows < 1) throw new JazminValidationException("OpenWriter: maxRows must be 1 or more");
        if (maxDelay < TimeSpan.Zero) throw new JazminValidationException("OpenWriter: maxDelay must not be negative");
        _path = path;
        _options = options;
        _maxDelay = maxDelay;
        _maxRows = maxRows;
    }

    public Task<JazminAppendResult> InsertAsync(IEnumerable<IReadOnlyDictionary<string, object?>> rows) =>
        Call(() => new JazminFile.AppendCall(RowList(rows), [], null));

    /// <summary>Rows that replace rows with the same <see cref="JazminAppend.KeyColumns"/> (given to OpenWriter).</summary>
    public Task<JazminAppendResult> UpsertAsync(IEnumerable<IReadOnlyDictionary<string, object?>> rows) => Call(() =>
    {
        NeedsKeyColumns(_options);
        return new JazminFile.AppendCall([], RowList(rows), null);
    });

    public Task<JazminAppendResult> DeleteAsync(JazminFilter filter) => Call(() =>
    {
        ArgumentNullException.ThrowIfNull(filter);
        return new JazminFile.AppendCall([], [], filter);
    });

    /// <summary>Writes what is waiting now, without waiting for maxDelay, and completes once it is written (or has failed).</summary>
    public async Task FlushAsync()
    {
        Task last;
        lock (_gate)
        {
            last = _last;
            if (_queue.Count > 0) _wake.TrySetResult();
        }
        try
        {
            await last.ConfigureAwait(false);
        }
        catch
        {
            // each call's error goes to its caller
        }
    }

    /// <summary>Writes what is waiting, then refuses further calls.</summary>
    public async ValueTask DisposeAsync()
    {
        lock (_gate) _closed = true;
        await FlushAsync().ConfigureAwait(false);
    }

    internal static IReadOnlyList<IReadOnlyDictionary<string, object?>> RowList(IEnumerable<IReadOnlyDictionary<string, object?>> rows)
    {
        ArgumentNullException.ThrowIfNull(rows);
        return rows.ToList();
    }

    internal static void NeedsKeyColumns(JazminAppend options)
    {
        if (options.KeyColumns is null || options.KeyColumns.Count == 0) throw new JazminValidationException("Upsert needs KeyColumns, e.g. KeyColumns = [\"id\"]");
    }

    private Task<JazminAppendResult> Call(Func<JazminFile.AppendCall> make)
    {
        JazminFile.AppendCall call;
        try
        {
            call = make();
        }
        catch (Exception e)
        {
            return Task.FromException<JazminAppendResult>(e);
        }
        var item = new Item(call, call.Insert.Count + call.Upsert.Count, new TaskCompletionSource<JazminAppendResult>(TaskCreationOptions.RunContinuationsAsynchronously));
        lock (_gate)
        {
            if (_closed) return Task.FromException<JazminAppendResult>(new JazminValidationException("This writer is closed"));
            _queue.Enqueue(item);
            _queuedRows += item.Rows;
            _last = item.Done.Task;
            if (_queuedRows >= _maxRows) _wake.TrySetResult();
            if (!_running)
            {
                _running = true;
                _ = Task.Run(RunAsync);
            }
        }
        return item.Done.Task;
    }

    /// <summary>The background task: waits maxDelay (unless woken), then writes batches until nothing is waiting.</summary>
    private async Task RunAsync()
    {
        if (_maxDelay > TimeSpan.Zero)
        {
            Task wake;
            lock (_gate) wake = _wake.Task;
            await Task.WhenAny(wake, Task.Delay(_maxDelay)).ConfigureAwait(false);
        }
        while (true)
        {
            var batch = new List<Item>();
            lock (_gate)
            {
                var rows = 0;
                while (_queue.Count > 0 && (batch.Count == 0 || rows + _queue.Peek().Rows <= _maxRows))
                {
                    var item = _queue.Dequeue();
                    rows += item.Rows;
                    batch.Add(item);
                }
                _queuedRows -= rows;
                if (batch.Count == 0)
                {
                    _running = false; // under the lock: a call made after this starts the task again
                    if (_wake.Task.IsCompleted) _wake = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    return;
                }
            }
            Write(batch);
        }
    }

    private void Write(List<Item> items)
    {
        (JazminAppendResult Result, int Taken) outcome;
        try
        {
            outcome = JazminFile.AppendCallsLocked(_path, _options, items.Select(i => i.Call).ToList(), split: true);
        }
        catch (JazminValidationException) when (items.Count > 1)
        {
            // Bad rows or a bad filter fail only their own call: the batch is tried again in halves, in order.
            var half = (items.Count + 1) / 2;
            Write(items.GetRange(0, half));
            Write(items.GetRange(half, items.Count - half));
            return;
        }
        catch (Exception e)
        {
            foreach (var item in items) item.Done.TrySetException(e);
            return;
        }
        for (var i = 0; i < outcome.Taken; i++) items[i].Done.TrySetResult(outcome.Result);
        if (outcome.Taken < items.Count) Write(items.GetRange(outcome.Taken, items.Count - outcome.Taken)); // a clash: the rest in a new append
    }
}
