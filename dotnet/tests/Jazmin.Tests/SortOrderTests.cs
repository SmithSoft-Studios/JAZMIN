using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Other text orders (spec 6.7): text sorted ignoring case and accents (NoCase), with the numbers inside it by value
/// (Natural), or both, kept by writers, appends, updates and rewrites; SortedBy keeps the plain leading keys.
/// </summary>
[Collection("Temporary sort folders")] // re-sorts make and delete jazmin-sort-* in the temp folder, which other tests count
public class SortOrderTests
{
    private static JsonNode Vectors => JsonNode.Parse(File.ReadAllText(Path.Combine(Fuzzing.Fixtures, "sort-orders.json")))!;

    private static List<string> SortWith(IEnumerable<string> list, JazminSortKey key) =>
        list.Select(s => (S: s, K: new object?[] { SortOrder.Key(JazminType.String, s, key) }))
            .OrderBy(x => x.K, Comparer<object?[]>.Create(SortKeys.Compare)).Select(x => x.S).ToList();

    [Fact]
    public void TheSharedVectors_FoldedForms_AndEachOrderFromAShuffledCopy()
    {
        var v = Vectors;
        foreach (var pair in v["fold"]!.AsArray()) Assert.Equal((string)pair![1]!, SortOrder.Fold((string)pair[0]!));
        foreach (var (name, key) in new[]
        {
            ("nocase", new JazminSortKey("s") { NoCase = true }), ("natural", new JazminSortKey("s") { Natural = true }),
            ("naturalNocase", new JazminSortKey("s") { NoCase = true, Natural = true }),
        })
        {
            var list = v[name]!.AsArray().Select(n => (string)n!).ToList();
            Assert.Equal(list, SortWith(Enumerable.Reverse(list), key));
            Assert.Equal(list, SortWith(list.Order(StringComparer.Ordinal), key));
        }
    }

    private static readonly JazminColumn[] Columns =
        [new("region", JazminType.String), new("name", JazminType.String) { Indexes = [JazminIndexKind.Sorted] }, new("n", JazminType.Int)];

    private static readonly string[] Names = ["apple", "Banana", "café", "Cafe2", "Émile", "file1", "file10", "File2", "zebra", "Zoë"]; // no natural: '10' before '2'

    private static List<string> NamesOf(JazminReader r, JazminQueryOptions? options = null) => r.Rows(options).Select(x => (string)x["name"]!).ToList();

    [Fact]
    public void ATableSortedIgnoringCase_IsWrittenInThatOrder_Checked_AndReadBothWays()
    {
        var sort = new[] { new JazminSortKey("name") { NoCase = true } };
        var bytes = TestData.Write(Columns, Names.Select((name, n) => new object?[] { "A", name, (long)n }), new JazminWriteOptions { Sort = sort, ChunkRows = 3 });
        using (var r = JazminReader.Open(bytes))
        {
            Assert.Null(r.SortedBy); // no plain leading key: readers without Sort see an unsorted table
            Assert.Equal(sort, r.Sort);
            Assert.Equal(Names, NamesOf(r));
            Assert.Equal(Names.Reverse(), NamesOf(r, new JazminQueryOptions { Reverse = true }));
            Assert.Contains(r.Indexes, ix => ix.Column == "name" && ix.Kind == JazminIndexKind.Sorted);
        }
        Assert.Contains("is out of order for SortedBy [name (nocase)]", Assert.Throws<JazminValidationException>(() =>
            TestData.Write(Columns, [["A", "b", 1L], ["A", "A", 2L]], new JazminWriteOptions { Sort = sort })).Message);
        Assert.Contains("out of order for SortedBy [name]", Assert.Throws<JazminValidationException>(() =>
            TestData.Write(Columns, Names.Select((name, n) => new object?[] { "A", name, (long)n }), new JazminWriteOptions { SortedBy = ["name"] })).Message);
        Assert.Contains("NoCase and Natural are for string columns ('n' is int)", Assert.Throws<JazminValidationException>(() =>
            TestData.Write(Columns, [], new JazminWriteOptions { Sort = [new JazminSortKey("n") { Natural = true }] })).Message);
        Assert.Contains("not both", Assert.Throws<JazminValidationException>(() =>
            TestData.Write(Columns, [], new JazminWriteOptions { SortedBy = ["name"], Sort = sort })).Message);
    }

    [Fact]
    public void APlainLeadingKey_StaysSortedBy_AndIsBinarySearched()
    {
        var rows = new[] { "A", "B", "C" }.SelectMany(region => new[] { "x1", "x2", "x10", "x20", "x100" }.Select((name, n) => new object?[] { region, name, (long)n }));
        var sort = new[] { new JazminSortKey("region"), new JazminSortKey("name") { Natural = true } };
        using var r = JazminReader.Open(TestData.Write(Columns, rows, new JazminWriteOptions { Sort = sort, ChunkRows = 5 }));
        Assert.Equal(["region"], r.SortedBy);
        Assert.Equal(sort, r.Sort);
        Assert.Equal(["x1", "x2", "x10", "x20", "x100"], NamesOf(r).Take(5));
        Assert.Equal(2, r.Explain(JazminFilter.Eq("region", "B")).ChunksSkipped);
    }

    [Fact]
    public void AppendsUpdatesCompactionAndResorts_KeepTheOrder()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-sort-orders-").FullName, "kept.jzm");
        var order = new[] { new JazminSortKey("name") { NoCase = true, Natural = true } };
        File.WriteAllBytes(path, TestData.Write(Columns, new[] { "file1", "File2", "file10" }.Select((name, n) => new object?[] { "A", name, (long)n }),
            new JazminWriteOptions { Sort = order, ChunkRows = 2 }));
        Dictionary<string, object?> Row(string name, long n) => new() { ["region"] = "A", ["name"] = name, ["n"] = n };
        List<string> Names() { using var r = JazminReader.Open(path); return NamesOf(r); }

        JazminFile.Append(path, new JazminAppend { Insert = [Row("FILE20", 3), Row("file11", 4)] });
        Assert.Contains("Appended rows must sort after the existing rows", Assert.Throws<JazminValidationException>(() =>
            JazminFile.Append(path, new JazminAppend { Insert = [Row("file3", 5)] })).Message);
        Assert.Equal(["file1", "File2", "file10", "file11", "FILE20"], Names());
        JazminFile.Update(path, new JazminUpdate { Insert = [Row("file3", 5), Row("File15", 6)] });
        Assert.Equal(["file1", "File2", "file3", "file10", "file11", "File15", "FILE20"], Names()); // merged at their place
        JazminFile.Update(path, new JazminUpdate { Set = new Dictionary<string, object?> { ["name"] = "file12" }, Where = JazminFilter.Eq("n", 0L) });
        Assert.Equal(["File2", "file3", "file10", "file11", "file12", "File15", "FILE20"], Names()); // a row whose sort value is set moves
        JazminFile.Compact(path);
        using (var r = JazminReader.Open(path)) Assert.Equal(order, r.Sort);
        JazminFile.Update(path, new JazminUpdate { SortedBy = ["name"] });
        using (var r = JazminReader.Open(path))
        {
            Assert.Equal(["FILE20", "File15", "File2", "file10", "file11", "file12", "file3"], NamesOf(r));
            Assert.Equal(["name"], r.SortedBy);
            Assert.Null(r.Sort);
        }
        JazminFile.Update(path, new JazminUpdate { Sort = order, SortRunRows = 2 }); // runs of 2 rows: merged through temporary files
        using (var r = JazminReader.Open(path))
        {
            Assert.Equal(["File2", "file3", "file10", "file11", "file12", "File15", "FILE20"], NamesOf(r));
            Assert.Equal(order, r.Sort);
        }
    }
}
