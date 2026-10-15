using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Reading last first (<see cref="JazminQueryOptions.Reverse"/>): Find's rows in the other order, with Offset and Limit
/// counted from the end, whatever the read uses (a scan, chunk statistics, an index, a shared file's partitions).
/// </summary>
public class ReverseTests
{
    private static readonly DateTime T0 = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int), new("at", JazminType.DateTime), new("account", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Float), new("branch", JazminType.String),
    ];

    private static IEnumerable<object?[]> Rows() => Enumerable.Range(0, 5000).Select(i => new object?[]
        { (long)i, T0.AddHours(i), $"A{i % 37}", (double)(i * 7919 % 1000), new[] { "north", "south", "east" }[i % 3] });

    public sealed class Entry
    {
        public long Id { get; set; }
        public DateTime At { get; set; }
        public string Account { get; set; } = "";
        public string Branch { get; set; } = "";
    }

    private static readonly (string Label, JazminFilter? Filter, long Offset, long? Limit)[] Cases =
    [
        ("every row", null, 0, null),
        ("the newest 50", null, 0, 50),
        ("a page further back", null, 1234, 100),
        ("an offset past whole chunks", null, 4100, null),
        ("a date range (chunk statistics)", JazminFilter.And(JazminFilter.Gte("at", T0.AddHours(1000)), JazminFilter.Lt("at", T0.AddHours(1500))), 0, 75),
        ("an index lookup", JazminFilter.Eq("account", "A5"), 3, 40),
        ("a scan filter", JazminFilter.Gt("amount", 900.0), 10, 200),
        ("nothing matches", JazminFilter.Eq("account", "nope"), 0, null),
    ];

    private static long[] Ids(IEnumerable<JazminRow> rows) => rows.Select(r => (long)r["id"]!).ToArray();

    private static long[] Backwards(JazminReader reader, JazminFilter? filter, long offset, long? limit) =>
        Ids(reader.Find(filter)).Reverse().Skip((int)offset).Take((int)(limit ?? int.MaxValue)).ToArray();

    private static void CheckEveryCase(JazminReader reader, string where)
    {
        foreach (var (label, filter, offset, limit) in Cases)
            Assert.True(Backwards(reader, filter, offset, limit).SequenceEqual(Ids(reader.Find(filter, new JazminQueryOptions { Offset = offset, Limit = limit, Reverse = true }))), $"{where}: {label}");
    }

    [Fact]
    public void Reverse_GivesFindsRowsLastFirst_WithOffsetAndLimitFromTheEnd()
    {
        using var reader = JazminReader.Open(TestData.Write(Columns, Rows(), new JazminWriteOptions { SortedBy = ["at"], ChunkRows = 256 }));
        CheckEveryCase(reader, "plain");
        Assert.Equal([4999L, 4998, 4997], Ids(reader.Rows(new JazminQueryOptions { Reverse = true, Limit = 3 })));
        var selected = reader.Find(JazminFilter.Eq("branch", "east"), new JazminQueryOptions { Select = ["id", "amount"], Reverse = true, Limit = 1 }).Single();
        Assert.Equal(["id", "amount"], selected.Keys);
    }

    [Fact]
    public async Task Reverse_SkipsDeletedRows_AndReadsAppendedAndSharedFiles_AndAsync()
    {
        var dir = Directory.CreateTempSubdirectory("jazmin-reverse-").FullName;
        var path = Path.Combine(dir, "ledger.jzm");
        File.WriteAllBytes(path, TestData.Write(Columns, Rows(), new JazminWriteOptions { SortedBy = ["at"], ChunkRows = 256 }));
        JazminFile.Append(path, new JazminAppend
        {
            Insert = [new Dictionary<string, object?> { ["id"] = 5000L, ["at"] = T0.AddHours(5000), ["account"] = "A1", ["amount"] = 1.0, ["branch"] = "north" }],
            Delete = JazminFilter.In("id", 4999L, 4500L, 17L),
        });
        using (var reader = JazminReader.Open(path))
        {
            CheckEveryCase(reader, "appended");
            Assert.Equal([5000L, 4998], Ids(reader.Rows(new JazminQueryOptions { Reverse = true, Limit = 2 })));
            var async = new List<long>();
            await foreach (var row in reader.FindAsync(JazminFilter.Eq("account", "A5"), new JazminQueryOptions { Reverse = true, Limit = 10 })) async.Add((long)row["id"]!);
            Assert.Equal(Backwards(reader, JazminFilter.Eq("account", "A5"), 0, 10), async);
        }

        var owner = JazminKey.Generate();
        var north = owner.CreateAccessKey();
        var byBranch = Rows().OrderBy(r => (string)r[4]!, StringComparer.Ordinal).ThenBy(r => (long)r[0]!);
        var shared = TestData.Write(Columns, byBranch, new JazminWriteOptions
        {
            Key = owner, SortedBy = ["branch", "at"], ChunkRows = 256,
            Access = new JazminAccessOptions { PartitionBy = "branch", Grants = [new JazminGrant(north) { Rows = ["north", "east"] }] },
        });
        using (var asOwner = JazminReader.Open(shared, new JazminReadOptions { Key = owner })) CheckEveryCase(asOwner, "shared, owner");
        using (var asNorth = JazminReader.Open(shared, new JazminReadOptions { AccessKey = north })) CheckEveryCase(asNorth, "shared, access key");
    }

    [Fact]
    public void LinqReverse_AfterTheFilters_IsReadLastFirst_AndElsewhereRunsInMemory()
    {
        using var reader = JazminReader.Open(TestData.Write(Columns, Rows(), new JazminWriteOptions { SortedBy = ["at"], ChunkRows = 256 }));
        var entries = reader.AsQueryable<Entry>();
        Assert.Equal(Backwards(reader, JazminFilter.Eq("branch", "east"), 0, 5), entries.Where(e => e.Branch == "east").Reverse().Take(5).Select(e => e.Id).ToArray());
        Assert.Equal([4989L, 4988, 4987], entries.OrderBy(e => e.At).Reverse().Skip(10).Take(3).Select(e => e.Id).ToArray());
        Assert.Equal(Enumerable.Range(0, 10).Reverse().Select(i => (long)i), entries.Where(e => e.Id < 10).Select(e => e.Id).Reverse().ToArray());
        Assert.Equal(Backwards(reader, null, 0, 3), entries.Reverse().Reverse().Reverse().Take(3).Select(e => e.Id).ToArray()); // one pushed, two in memory
        Assert.Equal(13, entries.Where(e => e.Account == "A5").Reverse().Skip(122).Count());
    }
}
