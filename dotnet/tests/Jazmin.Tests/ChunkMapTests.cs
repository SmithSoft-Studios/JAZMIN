using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// The owner's chunk map (spec 7.6.5): in a shared file, an owner's index lookup reads only the chunk directories of the
/// partitions holding its rows, not every partition's. Files without a map (written before it) read as before.
/// Mirrors js/test/chunk-map.test.js.
/// </summary>
public sealed class ChunkMapTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-chunkmap-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private const int People = 40;
    private static readonly JazminKey Owner = JazminKey.Generate();

    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("person", JazminType.String) { Nullable = false },
        new("code", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Float),
    ];

    private static string Person(long p) => $"P{p:D2}";

    private static Dictionary<string, object?> Row(long i, long? p = null, double? amount = null) => new()
    {
        ["id"] = i, ["person"] = Person(p ?? i / 100 % People), ["code"] = $"C{i % 500}", ["amount"] = amount ?? i / 4.0,
    };

    /// <summary>A shared file of 40 people, then appends: rows for existing and new people, deletes and upserts.</summary>
    private string SharedFile(bool chunkMap = true)
    {
        var path = Path.Combine(_dir, $"shared-{Guid.NewGuid():N}.jzm");
        using (var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions
        {
            Key = Owner,
            ChunkRows = 64,
            ChunkMap = chunkMap,
            Access = new JazminAccessOptions { PartitionBy = "person", Grants = [new JazminGrant(Owner.CreateAccessKey()) { Rows = [Person(0)] }] },
        }))
        {
            for (var i = 0; i < 4000; i++) writer.WriteRow(Row(i));
        }
        JazminFile.Append(path, new JazminAppend { Key = Owner, Insert = [.. Enumerable.Range(0, 300).Select(i => Row(4000 + i, i % 3))] });
        JazminFile.Append(path, new JazminAppend
        {
            Key = Owner, Delete = JazminFilter.Eq("code", "C7"), Upsert = [Row(15, amount: -1), Row(9000, 99)], KeyColumns = ["id"],
        });
        return path;
    }

    private static readonly JazminFilter[] Filters =
    [
        JazminFilter.Eq("id", 17L),
        JazminFilter.In("id", 3L, 3999L, 4150L, 9000L, 15L, 7L, 123456L),
        JazminFilter.Eq("code", "C42"),
        JazminFilter.In("code", "C1", "C499"),
        JazminFilter.Eq("code", "C42") & JazminFilter.Gt("amount", 10.0),
        JazminFilter.Gte("id", 4290L) & JazminFilter.Lt("id", 4310L),
    ];

    private static List<(long, string, double)> Rows(IEnumerable<JazminRow> rows) =>
        rows.Select(r => ((long)r["id"]!, (string)r["person"]!, (double)r["amount"]!)).Order().ToList();

    /// <summary>What the reader finds when every partition is loaded first (the way without a map).</summary>
    private static List<(long, string, double)> Expected(string path, JazminFilter filter)
    {
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        reader.Count(); // loads every partition
        return Rows(reader.Find(filter));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)] // an older file
    public void Owner_lookups_find_the_same_rows_as_reading_every_partition(bool chunkMap)
    {
        var path = SharedFile(chunkMap);
        foreach (var filter in Filters)
        {
            var expected = Expected(path, filter);
            using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner }))
                Assert.Equal(expected, Rows(reader.Find(filter)));
            using (var counting = JazminReader.Open(path, new JazminReadOptions { Key = Owner }))
                Assert.Equal(expected.Count, counting.Count(filter));
        }
        List<long> ids;
        using (var all = JazminReader.Open(path, new JazminReadOptions { Key = Owner })) ids = all.Rows().Select(r => (long)r["id"]!).ToList();
        foreach (var rowId in new long[] { 0, 1, 63, 64, 3999, 4000, 4299, 4300 })
        {
            using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
            try
            {
                Assert.Contains((long)reader.Get(rowId)["id"]!, ids);
            }
            catch (JazminValidationException e)
            {
                Assert.Contains("deleted", e.Message); // the old version of an upserted row
            }
        }
    }

    private static long BytesOfOneLookup(string path)
    {
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        return reader.Explain(JazminFilter.Eq("id", 1717L), analyze: true).Cost!.BytesRead;
    }

    [Fact]
    public void An_id_lookup_reads_one_partitions_directory_not_all_forty()
    {
        var withMap = BytesOfOneLookup(SharedFile());
        var without = BytesOfOneLookup(SharedFile(chunkMap: false));
        Assert.True(withMap < without * 0.6, $"with the map {withMap} bytes, without {without}");
    }

    [Fact]
    public void Compaction_writes_one_and_later_appends_extend_it()
    {
        var path = SharedFile(chunkMap: false);
        var before = BytesOfOneLookup(path);
        JazminFile.Compact(path, Owner, regroup: true);
        JazminFile.Append(path, new JazminAppend { Key = Owner, Insert = [Row(5000, 5), Row(5001, 120)] });
        Assert.True(BytesOfOneLookup(path) < before * 0.6, "compaction wrote a map, and the append kept it");
        foreach (var filter in Filters.Append(JazminFilter.In("id", 5000L, 5001L)))
        {
            var expected = Expected(path, filter);
            using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
            Assert.Equal(expected, Rows(reader.Find(filter)));
        }
    }

    [Fact]
    public void Each_table_of_a_file_with_several_has_its_own()
    {
        var path = Path.Combine(_dir, "tables.jzm");
        JazminColumn[] other = [new("ref", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] }, new("person", JazminType.String) { Nullable = false }];
        using (var writer = JazminWriter.Create(path, new JazminWriteOptions
        {
            Key = Owner,
            ChunkRows = 64,
            Access = new JazminAccessOptions { Grants = [new JazminGrant(Owner.CreateAccessKey()) { Rows = [Person(0)] }] },
            Tables = [new JazminTable("first", Columns) { PartitionBy = "person" }, new JazminTable("second", other) { PartitionBy = "person" }],
        }))
        {
            for (var i = 0; i < 2000; i++) writer.WriteRow(Row(i));
            writer.StartTable("second");
            for (var i = 0; i < 1000; i++) writer.WriteRow(new Dictionary<string, object?> { ["ref"] = (long)i, ["person"] = Person(i / 50) });
        }
        JazminFile.Append(path, new JazminAppend { Key = Owner, Table = "second", Insert = [new Dictionary<string, object?> { ["ref"] = 5000L, ["person"] = Person(77) }] });
        using var first = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        using var second = first.OpenTable("second");
        Assert.Equal([Person(12)], first.Find(JazminFilter.Eq("id", 1234L)).Select(r => (string)r["person"]!));
        Assert.Equal([Person(19), Person(77)], second.Find(JazminFilter.In("ref", 999L, 5000L)).Select(r => (string)r["person"]!).Order());
    }
}
