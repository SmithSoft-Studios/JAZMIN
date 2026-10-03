using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

public class QueryTests
{
    private sealed record Customer(long Id, string Name, string? Country, long Age, DateTime Joined);

    private static readonly string[] Countries = { "ZA", "NA", "BW", "ZW" };

    private static readonly List<Customer> Customers = Enumerable.Range(0, 2000).Select(i => new Customer(
        i,
        $"Customer {i} {(i % 7 == 0 ? "Johnson" : "Smith")}",
        i % 50 == 0 ? null : Countries[i % 4],
        18 + i % 60,
        new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(i))).ToList();

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = new[] { JazminIndexKind.Sorted } },
        new("name", JazminType.String) { Indexes = new[] { JazminIndexKind.Trigram } },
        new("country", JazminType.String) { Indexes = new[] { JazminIndexKind.Sorted } },
        new("age", JazminType.Int),
        new("joined", JazminType.DateTime) { Indexes = new[] { JazminIndexKind.Sorted } },
    };

    private static readonly JazminKey Key = JazminKey.Generate();

    private static byte[] Build(JazminKey? key) => TestData.Write(Columns,
        Customers.Select(c => new object?[] { c.Id, c.Name, c.Country, c.Age, c.Joined }),
        new JazminWriteOptions { ChunkRows = 100, Key = key });

    private static readonly byte[] Plain = Build(null);
    private static readonly byte[] Encrypted = Build(Key);

    public static TheoryData<bool> Modes => new() { false, true };

    private static JazminReader Open(bool encrypted) =>
        encrypted ? JazminReader.Open(Encrypted, new JazminReadOptions { Key = Key }) : JazminReader.Open(Plain);

    private static void ExpectSame(JazminReader reader, JazminFilter filter, Func<Customer, bool> predicate)
    {
        var expected = Customers.Where(predicate).Select(c => c.Id).ToList();
        var actual = reader.Find(filter).Select(r => (long)r["id"]!).ToList();
        Assert.Equal(expected, actual);
    }

    [Theory]
    [MemberData(nameof(Modes))]
    public void IndexedFilters_MatchFullScan(bool encrypted)
    {
        using var r = Open(encrypted);
        ExpectSame(r, JazminFilter.Eq("country", "ZA"), c => c.Country == "ZA");
        ExpectSame(r, JazminFilter.In("country", "NA", "BW"), c => c.Country is "NA" or "BW");
        ExpectSame(r, JazminFilter.Gte("id", 100) & JazminFilter.Lt("id", 120), c => c.Id is >= 100 and < 120);
        ExpectSame(r, JazminFilter.StartsWith("country", "Z"), c => c.Country?.StartsWith('Z') == true);
        ExpectSame(r, JazminFilter.Eq("country", null), c => c.Country is null);
        ExpectSame(r, JazminFilter.Gt("joined", "2024-01-01T00:00:00Z"), c => c.Joined > new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc));
    }

    [Theory]
    [MemberData(nameof(Modes))]
    public void TrigramIndex_AnswersContains(bool encrypted)
    {
        using var r = Open(encrypted);
        ExpectSame(r, JazminFilter.Contains("name", "Johnson"), c => c.Name.Contains("Johnson"));
        ExpectSame(r, JazminFilter.IContains("name", "JOHNSON"), c => c.Name.Contains("johnson", StringComparison.OrdinalIgnoreCase));
        ExpectSame(r, JazminFilter.Contains("name", "johnson"), _ => false);
        Assert.Equal("index", r.Explain(JazminFilter.Contains("name", "Johnson")).Strategy);
    }

    [Theory]
    [MemberData(nameof(Modes))]
    public void BooleanCombinations(bool encrypted)
    {
        using var r = Open(encrypted);
        ExpectSame(r, JazminFilter.Eq("country", "ZA") & JazminFilter.Gt("age", 70), c => c.Country == "ZA" && c.Age > 70);
        ExpectSame(r, JazminFilter.Eq("country", "BW") | JazminFilter.Lt("id", 5), c => c.Country == "BW" || c.Id < 5);
        ExpectSame(r, JazminFilter.Eq("country", "BW") | JazminFilter.Eq("age", 18), c => c.Country == "BW" || c.Age == 18);
        ExpectSame(r, !JazminFilter.Eq("country", "ZA"), c => c.Country != "ZA");
        ExpectSame(r, JazminFilter.Ne("age", 18), c => c.Age != 18);
    }

    [Fact]
    public void JsonFilter_IsIdenticalToJavaScriptForm()
    {
        using var r = Open(false);
        var rows = r.Find("""{ "country": "ZA", "age": { "gte": 70 }, "or": [ { "name": { "contains": "Johnson" } }, { "id": { "lt": 100 } } ] }""").ToList();
        var expected = Customers.Where(c => c.Country == "ZA" && c.Age >= 70 && (c.Name.Contains("Johnson") || c.Id < 100)).Select(c => c.Id);
        Assert.Equal(expected, rows.Select(x => (long)x["id"]!));
    }

    [Fact]
    public void IndexLookup_TouchesOneRow()
    {
        using var r = Open(false);
        Assert.Equal(new JazminPlan("index", 1, 20, 0), r.Explain(JazminFilter.Eq("id", 1234)));
    }

    [Fact]
    public void ChunkStatistics_SkipChunks()
    {
        var bytes = TestData.Write(new[] { new JazminColumn("age", JazminType.Int) }, Enumerable.Range(0, 2000).Select(i => new object?[] { (long)i }),
            new JazminWriteOptions { ChunkRows = 100 });
        using var r = JazminReader.Open(bytes);
        Assert.Equal(19, r.Explain(JazminFilter.Gte("age", 1950)).ChunksSkipped);
    }

    [Fact]
    public void SelectLimitOffset()
    {
        using var r = Open(false);
        var page = r.Find(JazminFilter.Eq("country", "ZA"), new JazminQueryOptions { Select = new[] { "id", "country" }, Offset = 2, Limit = 3 }).ToList();
        Assert.Equal(Customers.Where(c => c.Country == "ZA").Skip(2).Take(3).Select(c => c.Id), page.Select(p => (long)p["id"]!));
        Assert.Equal(2, page[0].Count);
    }

    [Fact]
    public void Filters_AreValidated()
    {
        using var r = Open(false);
        Assert.Throws<JazminValidationException>(() => r.Find(JazminFilter.Eq("nope", 1)));
        Assert.Throws<JazminValidationException>(() => r.Find("""{ "age": { "like": 1 } }"""));
        Assert.Throws<JazminValidationException>(() => r.Find(JazminFilter.Contains("age", "1")));
    }

    [Fact]
    public void SortedFiles_BinarySearchedChunkRanges_MatchAFullScan()
    {
        // Duplicate keys span chunk boundaries (7 rows per key, 5 rows per chunk).
        var columns = new[] { new JazminColumn("k", JazminType.Int), new JazminColumn("i", JazminType.Int) };
        var rows = Enumerable.Range(0, 700).Select(i => new object?[] { (long)(i / 7), (long)i }).ToList();
        using var r = JazminReader.Open(TestData.Write(columns, rows, new JazminWriteOptions { SortedBy = ["k"], ChunkRows = 5 }));
        var cases = new (JazminFilter Filter, Func<long, long, bool> Predicate)[]
        {
            (JazminFilter.Eq("k", 50), (k, _) => k == 50),
            (JazminFilter.Gte("k", 10) & JazminFilter.Lt("k", 13), (k, _) => k is >= 10 and < 13),
            (JazminFilter.Gt("k", 98), (k, _) => k > 98),
            (JazminFilter.Lte("k", 0), (k, _) => k <= 0),
            (JazminFilter.Gt("k", 5) & JazminFilter.Lt("k", 5), (_, _) => false),
            (JazminFilter.Eq("k", 1000), (_, _) => false),
            (JazminFilter.Gte("k", 3) & JazminFilter.Lt("i", 30), (k, i) => k >= 3 && i < 30),
            (JazminFilter.Eq("k", 1) | JazminFilter.Eq("k", 99), (k, _) => k is 1 or 99),
        };
        foreach (var (filter, predicate) in cases)
        {
            var expected = rows.Where(x => predicate((long)x[0]!, (long)x[1]!)).Select(x => (long)x[1]!);
            Assert.Equal(expected, r.Find(filter).Select(x => (long)x["i"]!));
        }
        Assert.Equal(r.ChunkCount - 2, r.Explain(JazminFilter.Eq("k", 50)).ChunksSkipped);
    }

    [Fact]
    public void StringOperands_AreCoerced()
    {
        using var r = Open(false);
        Assert.Equal(new[] { 42L }, r.Find("""{ "id": { "eq": "42" } }""").Select(x => (long)x["id"]!));
    }
}
