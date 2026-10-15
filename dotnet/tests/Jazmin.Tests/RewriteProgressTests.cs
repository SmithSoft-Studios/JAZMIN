using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Progress and stopping for rewrites (issue #184, part 3): writers, <see cref="JazminFile.Update"/> and
/// <see cref="JazminFile.Compact(string, JazminUpdate, bool)"/> report (Stage, Done, Total): Sort (rows put into a new
/// sort order, when the order changes), Write (rows written, after each chunk) and Indexes (indexes built at the end).
/// A cancelled token stops them at the next report: a stopped writer leaves no file, a stopped update or compact leaves
/// the file as it was. Mirrors js/test/rewrite-progress.test.js.
/// </summary>
[Collection("Temporary sort folders")] // re-sorts make and delete jazmin-sort-* in the temp folder, which other tests count
public sealed class RewriteProgressTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-rewrite-progress-").FullName;
    private const int Rows = 2000;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false },
        new("name", JazminType.String) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Float),
    };

    private static Dictionary<string, object?> Row(long id) => new() { ["id"] = id, ["name"] = $"n{id * 7919 % Rows}", ["amount"] = (double)(id * 37 % 1000) };

    private string Write(string name, JazminWriteOptions options)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        for (var i = 0; i < Rows; i++) writer.WriteRow(Row(i));
        return path;
    }

    /// <summary>Reports, checked as they come: within a stage, Done grows and Total stays.</summary>
    private sealed class Recorder(Func<JazminWriteProgress, bool>? stopWhen = null, CancellationTokenSource? stop = null) : IProgress<JazminWriteProgress>
    {
        public List<JazminWriteProgress> Calls { get; } = [];

        public List<JazminWriteProgress> Stage(JazminWriteStage stage) => Calls.Where(c => c.Stage == stage).ToList();

        public void Report(JazminWriteProgress value)
        {
            var last = Calls.LastOrDefault(c => c.Stage == value.Stage);
            if (last != default)
            {
                Assert.Equal(last.Total, value.Total);
                Assert.True(value.Done > last.Done, $"{value.Stage}: {value.Done} after {last.Done}");
            }
            Calls.Add(value);
            if (stopWhen?.Invoke(value) == true) stop!.Cancel();
        }
    }

    [Fact]
    public void A_writer_reports_each_chunk_written_then_each_index()
    {
        var recorder = new Recorder();
        Write("w.jzm", new JazminWriteOptions { ChunkRows = 50, SortedBy = ["id"], Progress = recorder });
        var written = recorder.Stage(JazminWriteStage.Write);
        Assert.Equal(Rows / 50, written.Count);
        Assert.Equal(new JazminWriteProgress(JazminWriteStage.Write, Rows, null), written[^1]); // a writer doesn't know how many rows will come
        Assert.Equal(new JazminWriteProgress(JazminWriteStage.Indexes, 1, 1), recorder.Stage(JazminWriteStage.Indexes)[^1]);
        Assert.True(recorder.Calls.IndexOf(recorder.Stage(JazminWriteStage.Indexes)[0]) > recorder.Calls.IndexOf(written[^1]));
    }

    [Fact]
    public void An_update_that_changes_the_sort_order_reports_sorting_writing_and_indexes()
    {
        var path = Write("u.jzm", new JazminWriteOptions { ChunkRows = 50, SortedBy = ["id"] });
        var recorder = new Recorder();
        JazminFile.Update(path, new JazminUpdate
        {
            SortedBy = ["amount"], Indexes = new Dictionary<string, IReadOnlyList<JazminIndexKind>> { ["id"] = [JazminIndexKind.Sorted] },
            SortRunRows = 300, Progress = recorder,
        });
        Assert.True(recorder.Stage(JazminWriteStage.Sort).Count >= Rows / 300);
        Assert.Equal(new JazminWriteProgress(JazminWriteStage.Sort, Rows, Rows), recorder.Stage(JazminWriteStage.Sort)[^1]);
        Assert.Equal(new JazminWriteProgress(JazminWriteStage.Write, Rows, Rows), recorder.Stage(JazminWriteStage.Write)[^1]);
        Assert.Equal(new JazminWriteProgress(JazminWriteStage.Indexes, 2, 2), recorder.Stage(JazminWriteStage.Indexes)[^1]);
        using var reader = JazminReader.Open(path);
        Assert.Equal(["amount"], reader.SortedBy);
        Assert.Equal(Rows, reader.RowCount);
        Assert.Equal(1, reader.Count(JazminFilter.Eq("name", "n7")));
    }

    [Fact]
    public void Compact_reports_writing_and_no_sort_stage_when_the_order_stays()
    {
        var path = Write("c.jzm", new JazminWriteOptions { ChunkRows = 50, SortedBy = ["id"] });
        var recorder = new Recorder();
        JazminFile.Compact(path, new JazminUpdate { Progress = recorder });
        Assert.Empty(recorder.Stage(JazminWriteStage.Sort));
        Assert.Equal(new JazminWriteProgress(JazminWriteStage.Write, Rows, Rows), recorder.Stage(JazminWriteStage.Write)[^1]);
    }

    [Fact]
    public void A_token_stops_a_rewrite_leaving_the_file_as_it_was_and_a_stopped_writer_leaves_no_file()
    {
        var path = Write("s.jzm", new JazminWriteOptions { ChunkRows = 50, SortedBy = ["id"] });
        var before = File.ReadAllBytes(path);
        var amountIndex = new Dictionary<string, IReadOnlyList<JazminIndexKind>> { ["amount"] = [JazminIndexKind.Sorted] };
        var cases = new (string Label, Func<JazminWriteProgress, bool> StopWhen, Action<IProgress<JazminWriteProgress>, CancellationToken> Run)[]
        {
            ("update, while sorting", p => p.Stage == JazminWriteStage.Sort,
                (p, t) => JazminFile.Update(path, new JazminUpdate { SortedBy = ["amount"], SortRunRows = 300, Progress = p, CancellationToken = t })),
            ("update, while writing", p => p.Stage == JazminWriteStage.Write,
                (p, t) => JazminFile.Update(path, new JazminUpdate { SortedBy = ["amount"], SortRunRows = 300, Progress = p, CancellationToken = t })),
            ("update, while indexing", p => p.Stage == JazminWriteStage.Indexes,
                (p, t) => JazminFile.Update(path, new JazminUpdate { Indexes = amountIndex, Progress = p, CancellationToken = t })),
            // After the last report the new file is complete; a stop still keeps it from replacing the old one.
            ("update, after the last report", p => p.Stage == JazminWriteStage.Indexes && p.Done == p.Total,
                (p, t) => JazminFile.Update(path, new JazminUpdate { Indexes = amountIndex, Progress = p, CancellationToken = t })),
            ("compact", p => p.Stage == JazminWriteStage.Write, (p, t) => JazminFile.Compact(path, new JazminUpdate { Progress = p, CancellationToken = t })),
        };
        foreach (var (label, stopWhen, run) in cases)
        {
            using var stop = new CancellationTokenSource();
            var recorder = new Recorder(stopWhen, stop);
            Assert.ThrowsAny<OperationCanceledException>(() => run(recorder, stop.Token));
            Assert.True(before.AsSpan().SequenceEqual(File.ReadAllBytes(path)), $"{label}: the file is unchanged");
            Assert.Equal(["s.jzm"], Directory.GetFiles(_dir).Select(Path.GetFileName));
        }

        // A writer stopped part-way leaves no file, even when disposed by a using block.
        var target = Path.Combine(_dir, "new.jzm");
        using (var stop = new CancellationTokenSource())
        {
            var recorder = new Recorder(p => p.Done >= 500, stop);
            Assert.ThrowsAny<OperationCanceledException>(() => Write("new.jzm", new JazminWriteOptions { ChunkRows = 50, Progress = recorder, CancellationToken = stop.Token }));
        }
        Assert.False(File.Exists(target));

        // Cancelled before the call: nothing is read or written.
        var cancelled = new CancellationToken(true);
        Assert.ThrowsAny<OperationCanceledException>(() => JazminFile.Update(path, new JazminUpdate { SortedBy = ["amount"], CancellationToken = cancelled }));
        Assert.ThrowsAny<OperationCanceledException>(() => Write("new.jzm", new JazminWriteOptions { CancellationToken = cancelled }));
        Assert.True(before.AsSpan().SequenceEqual(File.ReadAllBytes(path)));
        Assert.False(File.Exists(target));
    }
}
