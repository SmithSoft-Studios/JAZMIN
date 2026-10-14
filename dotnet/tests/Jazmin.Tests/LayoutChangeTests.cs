using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Changing an existing file's indexes and sort order (<see cref="JazminUpdate.Indexes"/>, <see cref="JazminUpdate.SortedBy"/>):
/// everything else in the file is kept; a new sort order is applied within a memory budget, through temporary files
/// locked with a key of their own when the rows don't fit. Mirrors js/test/layout-change.test.js.
/// </summary>
public sealed class LayoutChangeTests
{
    private static readonly string[] Cities = ["Durban", "Cape Town", "Pretoria"];

    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("customer", JazminType.String),
        new("city", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Decimal),
        new("at", JazminType.DateTime),
    ];

    private static Dictionary<string, object?> Row(long i) => new()
    {
        ["id"] = i, ["customer"] = $"C{i % 37:000}", ["city"] = Cities[i % 3], ["amount"] = $"{i * 7 % 1000}.50",
        ["at"] = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i),
    };

    private static string Write(IEnumerable<Dictionary<string, object?>> rows, JazminKey key, IReadOnlyList<string>? sortedBy = null)
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-layout-").FullName, "orders.jzm");
        using var writer = JazminWriter.Create(file, Columns, new JazminWriteOptions { Key = key, SortedBy = sortedBy, Metadata = new() { ["title"] = "Orders" } });
        foreach (var row in rows) writer.WriteRow(row);
        return file;
    }

    private static List<string> IndexesOf(string file, JazminKey key)
    {
        using var reader = JazminReader.Open(file, new JazminReadOptions { Key = key });
        return reader.Indexes.Select(ix => $"{ix.Column}:{TypeNames.IndexName(ix.Kind)}").Order(StringComparer.Ordinal).ToList();
    }

    [Fact]
    public void Indexes_are_added_changed_and_removed_and_queries_answer_the_same()
    {
        var key = JazminKey.Generate();
        var file = Write(Enumerable.Range(0, 3000).Select(i => Row(i)), key, ["id"]);
        List<long> Ids(JazminFilter filter)
        {
            using var reader = JazminReader.Open(file, new JazminReadOptions { Key = key });
            return reader.Find(filter).Select(r => (long)r["id"]!).ToList();
        }
        var before = Ids(JazminFilter.Eq("customer", "C005"));

        JazminFile.Update(file, new JazminUpdate { Key = key, Indexes = new Dictionary<string, IReadOnlyList<JazminIndexKind>> { ["customer"] = [JazminIndexKind.Sorted, JazminIndexKind.Trigram], ["city"] = [] } });
        Assert.Equal(["customer:sorted", "customer:trigram"], IndexesOf(file, key)); // id is the sort order: no index needed
        Assert.Equal(before, Ids(JazminFilter.Eq("customer", "C005")));
        using (var reader = JazminReader.Open(file, new JazminReadOptions { Key = key }))
        {
            Assert.Equal("Orders", (string?)reader.Metadata["title"]);
            Assert.Equal(["id"], reader.SortedBy!);
        }

        void Invalid(Dictionary<string, IReadOnlyList<JazminIndexKind>> indexes, string message) =>
            Assert.Contains(message, Assert.Throws<JazminValidationException>(() => JazminFile.Update(file, new JazminUpdate { Key = key, Indexes = indexes })).Message);
        Invalid(new() { ["nope"] = [JazminIndexKind.Sorted] }, "Indexes: unknown column 'nope'");
        Invalid(new() { ["amount"] = [JazminIndexKind.Trigram] }, "a trigram index is not supported on decimal");
        Assert.Equal(["customer:sorted", "customer:trigram"], IndexesOf(file, key)); // refused: unchanged
    }

    [Theory]
    [InlineData(100_000)]
    [InlineData(400)]
    public void A_new_sort_order_in_memory_or_through_temporary_runs_gives_the_same_rows_in_the_same_order(int runRows)
    {
        var key = JazminKey.Generate();
        var source = Enumerable.Range(0, 5000).Select(i => Row(4999 - i)).ToList();
        var expected = source.OrderBy(r => (string)r["customer"]!, StringComparer.Ordinal).ThenBy(r => (DateTime)r["at"]!).Select(r => (long)r["id"]!).ToList();
        var file = Write(source, key);
        var sortDirs = Directory.GetDirectories(Path.GetTempPath(), "jazmin-sort-*").Length;
        JazminFile.Update(file, new JazminUpdate { Key = key, SortedBy = ["customer", "at"], SortRunRows = runRows });
        Assert.Equal(sortDirs, Directory.GetDirectories(Path.GetTempPath(), "jazmin-sort-*").Length); // the temporary runs are deleted
        using (var reader = JazminReader.Open(file, new JazminReadOptions { Key = key }))
        {
            Assert.Equal(["customer", "at"], reader.SortedBy);
            Assert.Equal(expected, reader.Rows().Select(r => (long)r["id"]!).ToList());
        }
        Assert.Contains("id:sorted", IndexesOf(file, key)); // the column it was sorted by before keeps fast lookups

        // Equal keys keep their order; no order at all keeps the rows where they are.
        JazminFile.Update(file, new JazminUpdate { Key = key, SortedBy = ["city"], SortRunRows = runRows });
        List<long> order;
        using (var reader = JazminReader.Open(file, new JazminReadOptions { Key = key }))
            order = reader.Rows().Select(r => (long)r["id"]!).ToList();
        foreach (var city in Cities)
        {
            using var reader = JazminReader.Open(file, new JazminReadOptions { Key = key });
            var ids = reader.Rows().Where(r => (string)r["city"]! == city).Select(r => (long)r["id"]!).ToList();
            var byCustomer = source.Where(r => (string)r["city"]! == city).OrderBy(r => (string)r["customer"]!, StringComparer.Ordinal).ThenBy(r => (DateTime)r["at"]!).Select(r => (long)r["id"]!).ToList();
            Assert.Equal(byCustomer, ids); // within a city, the order they had (customer, at)
        }
        JazminFile.Update(file, new JazminUpdate { Key = key, SortedBy = [] });
        using (var reader = JazminReader.Open(file, new JazminReadOptions { Key = key }))
        {
            Assert.Null(reader.SortedBy);
            Assert.Equal(order, reader.Rows().Select(r => (long)r["id"]!).ToList());
        }
        Assert.Contains("Unknown column 'nope'", Assert.Throws<JazminValidationException>(() => JazminFile.Update(file, new JazminUpdate { Key = key, SortedBy = ["nope"] })).Message);
    }

    [Fact]
    public void A_shared_file_is_re_sorted_with_its_grants_and_each_keys_view_kept()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-layout-").FullName, "shared.jzm");
        using (var writer = JazminWriter.Create(file, Columns, new JazminWriteOptions
        {
            Key = owner, Access = new JazminAccessOptions { PartitionBy = "city", Grants = [new JazminGrant(bob) { Rows = ["Durban"] }] },
        }))
            for (var i = 0; i < 900; i++) writer.WriteRow(Row(i));
        JazminFile.Update(file, new JazminUpdate
        {
            Key = owner, SortedBy = ["city", "amount"], SortRunRows = 100,
            Indexes = new Dictionary<string, IReadOnlyList<JazminIndexKind>> { ["customer"] = [JazminIndexKind.Trigram] },
        });
        using var bobs = JazminReader.Open(file, new JazminReadOptions { AccessKey = bob });
        var seen = bobs.Rows().Select(r => (string)r["city"]!).ToList();
        Assert.Equal(300, seen.Count);
        Assert.All(seen, c => Assert.Equal("Durban", c));
        Assert.Equal(["city", "amount"], bobs.SortedBy);
        Assert.Contains("customer:trigram", IndexesOf(file, owner));
    }
}
