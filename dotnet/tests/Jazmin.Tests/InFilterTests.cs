using System.Diagnostics;
using System.Globalization;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// `in` conditions are checked with a hash set of the listed keys (and chunk statistics with the keys in order), so a
/// long list costs about as much as a short one. Equality is the same as `eq`: decimals by value, -0 equal to 0, NaN
/// equal to nothing, strings converted to the column's type, null in the list ignored.
/// </summary>
public class InFilterTests
{
    private sealed record Row(long Id, double Ratio, string? Price, string? Code, bool Flag, DateTime At);

    private static readonly List<Row> Rows = Enumerable.Range(0, 3000).Select(i => new Row(
        i,
        i % 97 == 0 ? double.NaN : i % 11 == 0 ? -0.0 : i / 4.0,
        i % 13 == 0 ? null : $"{i % 50}.{(i % 2 == 0 ? "50" : "5")}", // 7.50 and 7.5: one value
        i % 17 == 0 ? null : $"C{i % 300}",
        i % 3 == 0,
        new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddHours(i % 400))).ToList();

    private static JazminColumn[] Columns(bool indexed) =>
    [
        new("id", JazminType.Int) { Nullable = false },
        new("ratio", JazminType.Float) { Indexes = indexed ? [JazminIndexKind.Sorted] : [] },
        new("price", JazminType.Decimal) { Indexes = indexed ? [JazminIndexKind.Sorted] : [] },
        new("code", JazminType.String) { Indexes = indexed ? [JazminIndexKind.Sorted] : [] },
        new("flag", JazminType.Bool) { Indexes = indexed ? [JazminIndexKind.Sorted] : [] },
        new("at", JazminType.DateTime) { Indexes = indexed ? [JazminIndexKind.Sorted] : [] },
    ];

    private static IEnumerable<object?[]> Values(IEnumerable<Row> rows) =>
        rows.Select(r => new object?[] { r.Id, r.Ratio, r.Price, r.Code, r.Flag, r.At });

    private static readonly Dictionary<string, byte[]> Files = new()
    {
        ["scanned"] = TestData.Write(Columns(false), Values(Rows), new JazminWriteOptions { ChunkRows = 256 }),
        ["indexed"] = TestData.Write(Columns(true), Values(Rows), new JazminWriteOptions { ChunkRows = 256 }),
        ["sorted"] = TestData.Write(Columns(false),
            Values(Rows.OrderBy(r => r.Code ?? "", StringComparer.Ordinal).ThenBy(r => r.Id)),
            new JazminWriteOptions { ChunkRows = 64, SortedBy = ["code", "id"] }),
    };

    private static decimal? Money(string? price) => price is null ? null : decimal.Parse(price, CultureInfo.InvariantCulture);

    private static readonly (JazminFilter Filter, Func<Row, bool> Expected)[] Cases =
    [
        (JazminFilter.In("id", 5L, "7", 2999L, 5000L), r => r.Id is 5 or 7 or 2999),
        (JazminFilter.In("ratio", double.NaN, 0.0, 2.5), r => !double.IsNaN(r.Ratio) && (r.Ratio == 0 || r.Ratio == 2.5)),
        (JazminFilter.In("price", "7.5", "8.50", null), r => Money(r.Price) is 7.5m or 8.5m),
        (JazminFilter.In("code", "C1", "C2", "nope"), r => r.Code is "C1" or "C2"),
        (JazminFilter.In("flag", true), r => r.Flag),
        (JazminFilter.In("at", "2026-01-01T05:00:00Z", new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc)),
            r => r.At == new DateTime(2026, 1, 1, 5, 0, 0, DateTimeKind.Utc) || r.At == new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc)),
        (JazminFilter.In("code"), _ => false),
        (!JazminFilter.In("code", "C1"), r => r.Code != "C1"),
        (JazminFilter.In("code", "C3", "C4") & JazminFilter.Eq("flag", false), r => r.Code is "C3" or "C4" && !r.Flag),
    ];

    [Theory]
    [InlineData("scanned")]
    [InlineData("indexed")]
    [InlineData("sorted")]
    public void TheSameRowsAsCheckingEachListedValue(string file)
    {
        using var reader = JazminReader.Open(Files[file]);
        foreach (var (filter, expected) in Cases)
        {
            var want = Rows.Where(expected).Select(r => r.Id).Order().ToList();
            var got = reader.Find(filter).Select(r => (long)r["id"]!).Order().ToList();
            Assert.Equal(want, got);
            Assert.Equal(want.Count, reader.Count(filter));
        }
    }

    [Fact]
    public void ChunkStatisticsSkipTheChunksHoldingNoneOfTheListedValues()
    {
        using var reader = JazminReader.Open(Files["sorted"]);
        var plan = reader.Explain(JazminFilter.In("code", "C10", "C11"));
        Assert.True(plan.ChunksSkipped >= plan.Chunks - 3, $"{plan.ChunksSkipped} of {plan.Chunks} skipped");
    }

    [Fact]
    public void ALongListCostsAboutAsMuchAsAShortOne()
    {
        var file = TestData.Write(
            [new JazminColumn("id", JazminType.Int) { Nullable = false }, new JazminColumn("code", JazminType.String)],
            Enumerable.Range(0, 100_000).Select(i => new object?[] { (long)i, $"K{(long)i * 7919 % 100_000}" }));
        var values = Enumerable.Range(0, 20_000).Select(i => (object?)$"K{i * 5}").ToArray();
        using var reader = JazminReader.Open(file);
        var watch = Stopwatch.StartNew();
        Assert.Equal(20_000, reader.Count(JazminFilter.In("code", values)));
        Assert.True(watch.ElapsedMilliseconds < 3000, $"{watch.ElapsedMilliseconds} ms (comparing each row with each value took many seconds)");
    }
}
