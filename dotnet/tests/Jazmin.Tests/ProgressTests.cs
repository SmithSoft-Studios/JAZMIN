using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Progress and stopping for long reads (issue #184): <see cref="JazminQueryOptions.Progress"/> reports
/// { Done, Total, Matches } after each chunk read (chunks done and planned, matching rows so far), and a cancellation
/// token stops the read before its next chunk. Without them nothing changes. Mirrors js/test/progress.test.js.
/// </summary>
public sealed class ProgressTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-progress-").FullName;
    private const int Rows = 2000;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false },
        new("section", JazminType.String) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Float),
    };

    private static Dictionary<string, object?> Row(long id) => new() { ["id"] = id, ["section"] = $"S{id % 10}", ["amount"] = (double)(id * 37 % 1000) };

    private string Write(string name, JazminWriteOptions options)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        for (var i = 0; i < Rows; i++) writer.WriteRow(Row(i));
        return path;
    }

    private string PlainFile() => Write("plain.jzm", new JazminWriteOptions { SortedBy = ["id"], ChunkRows = 50 });

    /// <summary>Reports as they come, checked: Done grows by whole chunks up to Total, which never changes.</summary>
    private sealed class Recorder(Action<JazminReadProgress>? also = null) : IProgress<JazminReadProgress>
    {
        public List<JazminReadProgress> Calls { get; } = [];

        public void Report(JazminReadProgress value)
        {
            if (Calls.Count > 0)
            {
                var last = Calls[^1];
                Assert.Equal(last.Total, value.Total);
                Assert.True(value.Done > last.Done && value.Matches >= last.Matches);
            }
            Assert.InRange(value.Done, 1, value.Total);
            Calls.Add(value);
            also?.Invoke(value);
        }
    }

    private static readonly (string Label, string Where)[] Filters =
    [
        ("a scan", """{"amount":{"gt":900}}"""),
        ("an index", """{"section":"S3"}"""),
        ("the sort order", """{"id":{"gte":1500}}"""),
    ];

    [Fact]
    public async Task Count_and_CountAsync_report_each_chunk_ending_at_the_total_with_the_count()
    {
        using var reader = JazminReader.Open(PlainFile());
        foreach (var (label, where) in Filters)
        {
            var filter = JazminFilter.Parse(where);
            var expected = reader.Count(filter);
            foreach (var async in new[] { false, true })
            {
                var recorder = new Recorder();
                var n = async ? await reader.CountAsync(filter, recorder) : reader.Count(filter, recorder);
                Assert.Equal(expected, n);
                if (recorder.Calls.Count == 0) continue; // answered without reading a chunk (an exact index count)
                var total = recorder.Calls[0].Total;
                Assert.Equal(new JazminReadProgress(total, total, expected), recorder.Calls[^1]);
            }
        }
        var scan = new Recorder();
        reader.Count(JazminFilter.Parse("""{"amount":{"gt":900}}"""), scan);
        Assert.Equal(Rows / 50, scan.Calls.Count); // no statistics rule a chunk out: each is read and reported
    }

    [Fact]
    public async Task Find_FindAsync_and_explain_report_each_chunk_ending_at_the_total_with_the_rows()
    {
        using var reader = JazminReader.Open(PlainFile());
        foreach (var (label, where) in Filters)
        {
            var filter = JazminFilter.Parse(where);
            var expected = reader.Find(filter).Select(r => (long)r["id"]!).ToList();
            foreach (var how in new[] { "Find", "FindAsync", "Explain" })
            {
                var recorder = new Recorder();
                var options = new JazminQueryOptions { Progress = recorder };
                List<long> ids = [];
                if (how == "Find") ids = reader.Find(filter, options).Select(r => (long)r["id"]!).ToList();
                else if (how == "FindAsync") await foreach (var r in reader.FindAsync(filter, options)) ids.Add((long)r["id"]!);
                else Assert.Equal(expected.Count, reader.Explain(filter, true, options).Cost!.Rows);
                if (how != "Explain") Assert.Equal(expected, ids);
                Assert.True(recorder.Calls.Count > 0, $"{label}, {how}");
                var total = recorder.Calls[0].Total;
                Assert.Equal(new JazminReadProgress(total, total, expected.Count), recorder.Calls[^1]);
            }
        }
    }

    [Fact]
    public void A_limit_ends_the_read_early_and_the_last_report_says_how_far_it_got()
    {
        using var reader = JazminReader.Open(PlainFile());
        var recorder = new Recorder();
        Assert.Equal(120, reader.Find(JazminFilter.Parse("""{"amount":{"gte":0}}"""), new JazminQueryOptions { Limit = 120, Progress = recorder }).Count());
        Assert.Equal(120, recorder.Calls[^1].Matches);
        Assert.True(recorder.Calls[^1].Done < recorder.Calls[^1].Total);
    }

    [Fact]
    public async Task A_token_stops_a_read_before_its_next_chunk_and_one_cancelled_before_reads_nothing()
    {
        using var reader = JazminReader.Open(PlainFile());
        var filter = JazminFilter.Parse("""{"amount":{"gt":900}}""");
        // Cancelled from a progress report (as another part of a program would, between chunks): no further chunk is read.
        foreach (var how in new[] { "Count", "CountAsync", "Find", "FindAsync" })
        {
            using var stop = new CancellationTokenSource();
            var recorder = new Recorder(p => { if (p.Done == 3) stop.Cancel(); });
            var options = new JazminQueryOptions { Progress = recorder, CancellationToken = stop.Token };
            Func<Task> run = how switch
            {
                "Count" => () => Task.FromResult(reader.Count(filter, recorder, stop.Token)),
                "CountAsync" => () => reader.CountAsync(filter, recorder, stop.Token),
                "Find" => () => Task.FromResult(reader.Find(filter, options).Count()),
                _ => async () => { await foreach (var _ in reader.FindAsync(filter, options)) { } },
            };
            await Assert.ThrowsAnyAsync<OperationCanceledException>(run);
            Assert.Equal(3, recorder.Calls.Count);
        }
        // FindAsync's own token stops the read the same way.
        using (var stop = new CancellationTokenSource())
        {
            var recorder = new Recorder(p => { if (p.Done == 3) stop.Cancel(); });
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            {
                await foreach (var _ in reader.FindAsync(filter, new JazminQueryOptions { Progress = recorder }, stop.Token)) { }
            });
            Assert.True(recorder.Calls.Count <= 3, $"{recorder.Calls.Count} chunks after the stop");
        }
        // Cancelled before the call: nothing is read.
        var cancelled = new CancellationToken(true);
        Assert.ThrowsAny<OperationCanceledException>(() => reader.Count(filter, null, cancelled));
        Assert.ThrowsAny<OperationCanceledException>(() => reader.Find(filter, new JazminQueryOptions { CancellationToken = cancelled }).Count());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.CountAsync(filter, null, cancelled));
        // The reader still works afterwards.
        Assert.Equal(reader.Find(filter).LongCount(), reader.Count(filter));
    }

    [Fact]
    public void Progress_in_access_controlled_files_for_the_owner_and_an_access_key()
    {
        var key = JazminKey.Generate();
        var bob = key.CreateAccessKey();
        var access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["S2", "S5"], Columns = ["*"] }] };
        var path = Write("access.jzm", new JazminWriteOptions { Key = key, ChunkRows = 50, Access = access });
        foreach (var options in new[] { new JazminReadOptions { Key = key }, new JazminReadOptions { AccessKey = bob } })
        {
            using var reader = JazminReader.Open(path, options);
            var filter = JazminFilter.Parse("""{"amount":{"gt":500}}""");
            var expected = reader.Find(filter).LongCount();
            var counted = new Recorder();
            Assert.Equal(expected, reader.Count(filter, counted));
            Assert.Equal(new JazminReadProgress(counted.Calls[0].Total, counted.Calls[0].Total, expected), counted.Calls[^1]);
            var found = new Recorder();
            Assert.Equal(expected, reader.Find(filter, new JazminQueryOptions { Progress = found }).LongCount());
            Assert.Equal(new JazminReadProgress(found.Calls[0].Total, found.Calls[0].Total, expected), found.Calls[^1]);
        }
    }
}
