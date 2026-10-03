using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Async APIs (TASKS J-1): the same results as the synchronous ones, without blocking the caller.</summary>
public class AsyncTests
{
    public class Line
    {
        public long Id { get; set; }
        public string Account { get; set; } = "";
        public double? Amount { get; set; }
        public DateTime When { get; set; }
    }

    private static readonly JazminColumn[] Columns =
    {
        new("Id", JazminType.Int) { Nullable = false },
        new("Account", JazminType.String) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("Amount", JazminType.Float),
        new("When", JazminType.DateTime) { Nullable = false },
    };

    private static object?[] Row(int i) =>
        [(long)i, $"ACC{(i * 7919) % 300:D3}", i % 9 == 0 ? null : (i % 1000) / 4.0, new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddHours(i)];

    private static byte[] Write(int rows = 3000)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions { SortedBy = ["Id"], ChunkRows = 100 }, leaveOpen: true))
            for (var i = 0; i < rows; i++) writer.WriteValues(Row(i));
        return stream.ToArray();
    }

    private static async Task<List<T>> ToListAsync<T>(IAsyncEnumerable<T> items)
    {
        var list = new List<T>();
        await foreach (var item in items) list.Add(item);
        return list;
    }

    private static List<Dictionary<string, object?>> Plain(IEnumerable<JazminRow> rows) => rows.Select(r => r.ToDictionary(p => p.Key, p => p.Value)).ToList();

    private static readonly JazminFilter?[] Filters =
    {
        null,
        JazminFilter.Gte("Id", 1200L) & JazminFilter.Lt("Id", 1300L),
        JazminFilter.Eq("Account", "ACC042"),
        JazminFilter.Gt("Amount", 240.0),
    };

    [Fact]
    public async Task FindAsync_ReturnsWhatFindReturns()
    {
        using var reader = JazminReader.Open(Write());
        foreach (var filter in Filters)
        {
            Assert.Equal(Plain(reader.Find(filter)), Plain(await ToListAsync(reader.FindAsync(filter))));
            var options = new JazminQueryOptions { Select = ["Id", "Amount"], Limit = 25, Offset = 10 };
            Assert.Equal(Plain(reader.Find(filter, options)), Plain(await ToListAsync(reader.FindAsync(filter, options))));
        }
        Assert.Equal(Plain(reader.Rows()), Plain(await ToListAsync(reader.RowsAsync())));
        Assert.Equal(Plain(reader.Find("""{ "Account": "ACC007" }""")), Plain(await ToListAsync(reader.FindAsync("""{ "Account": "ACC007" }"""))));
        Assert.Equal(reader.Query<Line>(l => l.Amount > 200).Select(l => l.Id), (await ToListAsync(reader.QueryAsync<Line>(l => l.Amount > 200))).Select(l => l.Id));
        Assert.Equal(3000, (await ToListAsync(reader.RowsAsync<Line>())).Count);
    }

    [Fact]
    public async Task FindAsync_DoesNotRunOnTheCallersThread_AndStopsEarlyOrOnCancellation()
    {
        // File reads wait at a gate: if the first batch ran on the caller's thread, MoveNextAsync could not return.
        var gated = new GatedStream(Write());
        using var reader = JazminReader.Open(gated, leaveOpen: true);
        await using (var rows = reader.RowsAsync().GetAsyncEnumerator())
        {
            gated.Close(); // chunk reads now wait until the gate opens
            // MoveNextAsync must return at once (the batch runs elsewhere), not block at the gate.
            var call = Task.Factory.StartNew(() => rows.MoveNextAsync().AsTask());
            Assert.True(call.Wait(TimeSpan.FromSeconds(10)), "MoveNextAsync blocked its caller");
            var first = call.Result;
            Assert.False(first.IsCompleted); // the batch is still waiting at the gate on a thread-pool thread
            gated.Open();
            Assert.True(await first);
        }

        var n = 0;
        await foreach (var row in reader.FindAsync(JazminFilter.Gte("Id", 100L)))
        {
            Assert.Single(reader.Find(JazminFilter.Eq("Id", (long)row["Id"]!))); // the reader can be used between items
            if (++n == 5) break;
        }

        using var cts = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var _ in reader.RowsAsync(cancellationToken: cts.Token)) cts.Cancel();
        });
        Assert.Equal(3000, reader.Rows().Count()); // still usable afterwards
        Assert.Throws<JazminValidationException>(() => reader.FindAsync(JazminFilter.Eq("Nope", 1))); // validated at the call
    }

    [Fact]
    public async Task OpenAsync_AndAsyncDeserialization()
    {
        var key = JazminKey.Generate();
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-async-").FullName, "a.jzm");
        using (var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions { Key = key }))
            for (var i = 0; i < 500; i++) writer.WriteValues(Row(i));
        using (var reader = await JazminReader.OpenAsync(path, new JazminReadOptions { Key = key }))
            Assert.Equal(500, (await ToListAsync(reader.RowsAsync())).Count);
        await Assert.ThrowsAsync<JazminKeyException>(() => JazminReader.OpenAsync(path));

        var serializer = new JazminSerializer();
        var lines = Enumerable.Range(0, 2000).Select(i => new Line { Id = i, Account = $"A{i % 7}", Amount = i % 5 == 0 ? null : i / 2.0, When = new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i) }).ToList();
        var stream = new MemoryStream();
        serializer.Serialize(stream, lines);
        stream.Position = 0;
        var streamed = await ToListAsync(serializer.DeserializeAsyncEnumerable<Line>(stream));
        Assert.Equal(lines.Select(l => (l.Id, l.Account, l.Amount, l.When)), streamed.Select(l => (l.Id, l.Account, l.Amount, l.When)));
        stream.Position = 0;
        Assert.Equal(2000, (await serializer.DeserializeAsync<List<Line>>(stream))!.Count);
    }

    /// <summary>A stream whose reads wait while the gate is closed.</summary>
    private sealed class GatedStream(byte[] data) : MemoryStream(data, writable: false)
    {
        private readonly ManualResetEventSlim _gate = new(true);

        public void Close() => _gate.Reset();

        public void Open() => _gate.Set();

        public override int Read(byte[] buffer, int offset, int count)
        {
            _gate.Wait();
            return base.Read(buffer, offset, count);
        }

        public override int Read(Span<byte> buffer)
        {
            _gate.Wait();
            return base.Read(buffer);
        }
    }

    private static async IAsyncEnumerable<T> Slowly<T>(IEnumerable<T> items)
    {
        var n = 0;
        foreach (var item in items)
        {
            if (++n % 500 == 0) await Task.Yield(); // e.g. a database cursor fetching the next page
            yield return item;
        }
    }

    [Fact]
    public async Task AsyncWriters_TakeAsyncSources_AndMatchSyncWrites()
    {
        var options = new JazminWriteOptions { SortedBy = ["Id"], ChunkRows = 100, MaxDegreeOfParallelism = 2 };
        var asyncStream = new MemoryStream();
        await using (var writer = new JazminWriter(asyncStream, Columns, options, leaveOpen: true))
            await writer.WriteValuesAsync(Slowly(Enumerable.Range(0, 3000).Select(Row)));
        using (var a = JazminReader.Open(asyncStream.ToArray()))
        using (var b = JazminReader.Open(Write()))
            Assert.Equal(Plain(b.Rows()), Plain(a.Rows()));

        var dictStream = new MemoryStream();
        var writer2 = new JazminWriter(dictStream, Columns, options, leaveOpen: true);
        await writer2.WriteRowsAsync(Slowly(Enumerable.Range(0, 1000).Select(i => (IReadOnlyDictionary<string, object?>)Columns.Select((c, j) => (c.Name, Row(i)[j])).ToDictionary(x => x.Name, x => x.Item2))));
        await writer2.FinishAsync();
        using (var r = JazminReader.Open(dictStream.ToArray())) Assert.Equal(1000, r.RowCount);

        var lines = Enumerable.Range(0, 1500).Select(i => new Line { Id = i, Account = $"A{i % 7}", Amount = i / 2.0, When = new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc) }).ToList();
        var serialized = new MemoryStream();
        await new JazminSerializer().SerializeAsync(serialized, Slowly(lines));
        serialized.Position = 0;
        Assert.Equal(lines.Select(l => l.Id), new JazminSerializer().DeserializeEnumerable<Line>(serialized).Select(l => l.Id));
    }
}
