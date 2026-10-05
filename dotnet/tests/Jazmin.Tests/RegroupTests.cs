using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Compacting with regroup (issue #17): appends from many people leave one chunk per append; regrouping writes each
/// partition's rows together, in their file order, so each partition spans as few chunks as its rows need. Mirrors
/// js/test/regroup.test.js.
/// </summary>
public sealed class RegroupTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-regroup-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminKey Owner = JazminKey.Generate();
    private static readonly JazminAccessKey Bob = Owner.CreateAccessKey();
    private static readonly string[] People = ["P1", "P2", "P3", "P4", "P5"];

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("person", JazminType.String) { Nullable = false },
        new("value", JazminType.Float),
    };

    private static List<IReadOnlyDictionary<string, object?>> SyncRows(int round, string person) =>
        Enumerable.Range(0, 3).Select(k => (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?>
        {
            ["id"] = (long)(round * 100 + Array.IndexOf(People, person) * 10 + k), ["person"] = person, ["value"] = round + k / 10.0,
        }).ToList();

    private string Write(string name, IEnumerable<IReadOnlyDictionary<string, object?>> rows, JazminWriteOptions options)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        foreach (var row in rows) writer.WriteRow(row);
        return path;
    }

    /// <summary>10 rounds of syncs from 5 people, one append each, and a delete: 50 chunks.</summary>
    private string AppendedFile()
    {
        var access = new JazminAccessOptions { PartitionBy = "person", Grants = [new JazminGrant(Bob) { Rows = ["P2", "P4"], Columns = ["*"] }] };
        var path = Write("synced.jzm", SyncRows(0, "P1"), new JazminWriteOptions { Key = Owner, Access = access });
        for (var round = 0; round < 10; round++)
            foreach (var person in People)
                if (round > 0 || person != "P1") JazminFile.Append(path, new JazminAppend { Key = Owner, Insert = SyncRows(round, person) });
        JazminFile.Append(path, new JazminAppend { Key = Owner, Delete = JazminFilter.Parse("""{"id":{"in":[101,523]}}""") });
        return path;
    }

    private static List<long> Ids(IEnumerable<JazminRow> rows) => rows.Select(r => (long)r["id"]!).ToList();

    [Fact]
    public void Regrouping_puts_each_partition_in_as_few_chunks_as_its_rows_need_in_file_order()
    {
        var path = AppendedFile();
        Dictionary<string, List<long>> byPerson;
        List<long> all;
        using (var before = JazminReader.Open(path, new JazminReadOptions { Key = Owner }))
        {
            Assert.Equal(50, before.ChunkCount);
            byPerson = People.ToDictionary(p => p, p => Ids(before.Find(JazminFilter.Eq("person", p))));
            all = Ids(before.Rows()).Order().ToList();
        }

        JazminFile.Compact(path, Owner);
        using (var compacted = JazminReader.Open(path, new JazminReadOptions { Key = Owner }))
            Assert.Equal(50, compacted.ChunkCount); // compacting alone keeps one chunk per append

        JazminFile.Compact(path, Owner, regroup: true);
        using (var after = JazminReader.Open(path, new JazminReadOptions { Key = Owner }))
        {
            Assert.Equal(People.Length, after.ChunkCount);
            foreach (var p in People) Assert.Equal(byPerson[p], Ids(after.Find(JazminFilter.Eq("person", p))));
            Assert.Equal(all, Ids(after.Rows()).Order().ToList());
            Assert.Equal(0, after.Count(JazminFilter.Eq("id", 101L))); // deleted rows stay deleted
        }
        using var asBob = JazminReader.Open(path, new JazminReadOptions { AccessKey = Bob });
        Assert.Equal(byPerson["P2"].Concat(byPerson["P4"]).Order(), Ids(asBob.Rows()).Order());
    }

    [Fact]
    public void Regroup_needs_a_partitioned_file_whose_sort_order_allows_it()
    {
        var one = new[] { (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?> { ["id"] = 1L, ["person"] = "P1", ["value"] = 1.0 } };
        var plain = Write("plain.jzm", one, new JazminWriteOptions { Key = Owner });
        Assert.Contains("PartitionBy", Assert.Throws<JazminValidationException>(() => JazminFile.Compact(plain, Owner, regroup: true)).Message);
        var byId = Write("by-id.jzm", one, new JazminWriteOptions { Key = Owner, SortedBy = ["id"], Access = new JazminAccessOptions { PartitionBy = "person" } });
        Assert.Contains("SortedBy", Assert.Throws<JazminValidationException>(() => JazminFile.Compact(byId, Owner, regroup: true)).Message);

        // Sorted by the partition column first: already grouped, and allowed.
        var two = new[]
        {
            (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?> { ["id"] = 2L, ["person"] = "P1", ["value"] = 1.0 },
            new Dictionary<string, object?> { ["id"] = 1L, ["person"] = "P2", ["value"] = 1.0 },
        };
        var byPerson = Write("by-person.jzm", two, new JazminWriteOptions { Key = Owner, SortedBy = ["person", "id"], Access = new JazminAccessOptions { PartitionBy = "person" } });
        JazminFile.Compact(byPerson, Owner, regroup: true);
        using var reader = JazminReader.Open(byPerson, new JazminReadOptions { Key = Owner });
        Assert.Equal([2L, 1L], Ids(reader.Rows()));
    }
}
