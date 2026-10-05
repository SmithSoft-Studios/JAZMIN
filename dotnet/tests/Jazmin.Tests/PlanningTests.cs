using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Query planning (issue #7): range conditions on one column make one bounded index lookup; an index lookup that would
/// read more than scanning the chunks the filter leaves is not made; index rows outside those chunks are not read.
/// Mirrors js/test/planning.test.js.
/// </summary>
public sealed class PlanningTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-planning-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly DateTime Start = new(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private static DateTime Day(double days) => Start.AddDays(days);

    private static readonly JazminColumn[] Columns =
    {
        new("account", JazminType.String) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("at", JazminType.DateTime) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Int) { Nullable = false },
        new("description", JazminType.String) { Indexes = [JazminIndexKind.Trigram] },
    };

    /// <summary>60,000 rows: every account's rows over a year, sorted by account then time, with a unique time on every row.</summary>
    private static readonly List<(string Account, DateTime At, long Amount, string Description)> Rows = Enumerable.Range(0, 60_000)
        .Select(i => ($"ACC{i % 40:D3}", Start.AddMilliseconds(i * 523_000.0), (long)(i * 7919 % 10_000), $"Purchase {i % 997} at shop {i % 53}"))
        .OrderBy(r => r.Item1, StringComparer.Ordinal).ThenBy(r => r.Item2).ToList();

    private string Write(string name, int count, int chunkRows, int? indexPageBytes = null)
    {
        var path = Path.Combine(_dir, name);
        var options = new JazminWriteOptions { SortedBy = ["account", "at"], ChunkRows = chunkRows };
        if (indexPageBytes is { } bytes) options.IndexPageBytes = bytes;
        using var writer = JazminWriter.Create(path, Columns, options);
        foreach (var (account, at, amount, description) in Rows.Take(count))
            writer.WriteRow(new Dictionary<string, object?> { ["account"] = account, ["at"] = at, ["amount"] = amount, ["description"] = description });
        return path;
    }

    private static JazminPlan Analyze(string path, JazminFilter filter, long? limit = null)
    {
        using var reader = JazminReader.Open(path);
        return reader.Explain(filter, analyze: true, new JazminQueryOptions { Limit = limit });
    }

    private static JazminFilter Range(DateTime? from, DateTime? to) =>
        JazminFilter.And(new[] { from is { } f ? JazminFilter.Gte("at", f) : null, to is { } t ? JazminFilter.Lt("at", t) : null }.OfType<JazminFilter>().ToArray());

    [Fact]
    public void A_range_on_one_column_reads_only_the_index_pages_it_spans()
    {
        var plan = Analyze(Write("a.jzm", 60_000, 500), Range(Day(100), Day(101)));
        Assert.Equal("index", plan.Strategy);
        Assert.Equal(Rows.LongCount(r => r.At >= Day(100) && r.At < Day(101)), plan.Cost!.Rows);
        // The directory and one or two pages - not the half of the index each bound would read on its own.
        Assert.True(plan.Cost.IndexPagesRead <= 3, $"{plan.Cost.IndexPagesRead} index sections read");
    }

    [Fact]
    public void A_sort_range_is_scanned_instead_of_reading_a_costly_index()
    {
        var path = Write("a.jzm", 60_000, 500);
        var keyset = JazminFilter.And(JazminFilter.Eq("account", "ACC007"), JazminFilter.Gt("at", Day(200)));
        var plan = Analyze(path, keyset, limit: 50);
        // Only the time index's directory is read, to plan: none of its pages.
        Assert.Equal(("scan", 50L, 1), (plan.Strategy, plan.Cost!.Rows, plan.Cost.IndexPagesRead));
        Assert.True(plan.Cost.ChunksRead <= 2, $"{plan.Cost.ChunksRead} chunks read");
        Assert.Equal(Rows.LongCount(r => r.Account == "ACC007" && r.At > Day(200)), Analyze(path, keyset).Cost!.Rows);
        // A text search inside the account is answered by scanning its chunks: the trigram index is not read.
        var search = Analyze(path, JazminFilter.And(JazminFilter.Eq("account", "ACC007"), JazminFilter.Contains("description", "shop 7")));
        Assert.Equal(("scan", 0), (search.Strategy, search.Cost!.IndexPagesRead));
        Assert.Equal(Rows.LongCount(r => r.Account == "ACC007" && r.Description.Contains("shop 7")), search.Cost.Rows);
    }

    [Fact]
    public void Index_rows_outside_the_chunks_a_scan_would_read_are_not_read()
    {
        // A cheap index (one page) is still used, but only within the account's chunks.
        var path = Write("small.jzm", 6000, 100, indexPageBytes: 1 << 20);
        var scanChunks = Analyze(path, JazminFilter.Eq("account", "ACC003")).Cost!.ChunksRead;
        var plan = Analyze(path, JazminFilter.And(JazminFilter.Eq("account", "ACC003"), JazminFilter.Gte("at", Start)));
        Assert.Equal(Rows.Take(6000).LongCount(r => r.Account == "ACC003"), plan.Cost!.Rows);
        Assert.True(plan.Cost.ChunksRead <= scanChunks, $"{plan.Cost.ChunksRead} chunks read, the account has {scanChunks}");
    }

    [Fact]
    public void Every_plan_returns_the_same_rows_as_checking_every_row()
    {
        var path = Write("a.jzm", 60_000, 500);
        using var reader = JazminReader.Open(path);
        void Check(JazminFilter filter, Func<(string Account, DateTime At, long Amount, string Description), bool> expected) =>
            Assert.Equal(Rows.LongCount(expected), reader.Find(filter).LongCount());
        Check(Range(Day(10), Day(11)), r => r.At >= Day(10) && r.At < Day(11));
        Check(JazminFilter.And(JazminFilter.Gt("at", Day(300)), JazminFilter.Lt("amount", 100)), r => r.At > Day(300) && r.Amount < 100);
        Check(JazminFilter.And(JazminFilter.Eq("account", "ACC001"), JazminFilter.Gte("at", Day(50)), JazminFilter.Lte("at", Day(60))),
            r => r.Account == "ACC001" && r.At >= Day(50) && r.At <= Day(60));
        Check(JazminFilter.And(JazminFilter.In("account", "ACC002", "ACC030"), JazminFilter.Lt("at", Day(5))), r => r.Account is "ACC002" or "ACC030" && r.At < Day(5));
        Check(JazminFilter.Or(JazminFilter.Lt("at", Day(1)), JazminFilter.And(JazminFilter.Eq("account", "ACC039"), JazminFilter.Eq("amount", 1))),
            r => r.At < Day(1) || (r.Account == "ACC039" && r.Amount == 1));
        Check(JazminFilter.And(JazminFilter.Contains("description", "shop 5"), Range(Day(200), Day(201))),
            r => r.Description.Contains("shop 5") && r.At >= Day(200) && r.At < Day(201));
        Check(JazminFilter.And(JazminFilter.Not(JazminFilter.Eq("account", "ACC000")), JazminFilter.Gte("at", Day(364))), r => r.Account != "ACC000" && r.At >= Day(364));
        Check(JazminFilter.And(JazminFilter.Gt("at", Day(100)), JazminFilter.Lt("at", Day(100))), _ => false);
        Check(JazminFilter.And(JazminFilter.Gte("at", Day(100)), JazminFilter.Lte("at", Day(100)), JazminFilter.Gt("amount", -1)), r => r.At == Day(100));
    }
}
