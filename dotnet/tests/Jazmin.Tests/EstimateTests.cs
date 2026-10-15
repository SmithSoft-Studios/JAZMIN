using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Estimate (issue #185): what a read would cost, known before it starts, from directories, statistics and indexes only.
/// The same files and filters give the same numbers in js/test/estimate.test.js (both libraries plan reads alike).
/// </summary>
public sealed class EstimateTests : IDisposable
{
    private static readonly string Dir = FindFixtures();
    private static readonly JazminKey Key = JazminKey.Parse((string)JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "keys.json")))!["key"]!);
    private readonly string _temp = Directory.CreateTempSubdirectory("jazmin-estimate-").FullName;

    public void Dispose() => Directory.Delete(_temp, true);

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures");
            if (File.Exists(Path.Combine(candidate, "keys.json"))) return candidate;
        }
        throw new InvalidOperationException("spec/fixtures not found");
    }

    [Theory]
    // The JavaScript library's estimates of the same files (js/test/estimate.test.js reads them the same way).
    [InlineData("js-paged-key.jzm", """{"id":7}""", 0L, 1, 1L, 1147L, 0, 0L, 0L)]
    [InlineData("js-paged-key.jzm", """{"country":"NA"}""", 0L, 8, 100L, 8899L, 0, 0L, 0L)]
    [InlineData("js-paged-key.jzm", """{"score":{"gt":50}}""", 0L, 3, 180L, 3276L, 3, 180L, 3276L)]
    [InlineData("js-paged-key.jzm", null, 100L, 7, 436L, 7752L, 0, 0L, 0L)]
    [InlineData("js-access.jzm", """{"score":{"gt":50}}""", 0L, 126, 126L, 21291L, 126, 126L, 21291L)]
    [InlineData("js-access.jzm", null, 100L, 400, 400L, 67349L, 0, 0L, 0L)]
    public void Estimate_names_the_chunks_Find_then_reads_and_equals_the_JavaScript_library(string file, string? where, long offset,
        int chunks, long rows, long bytes, int countChunks, long countRows, long countBytes)
    {
        var filter = where is null ? null : JazminFilter.Parse(where);
        using var reader = JazminReader.Open(Path.Combine(Dir, file), new JazminReadOptions { Key = Key });
        Assert.Equal(new JazminReadEstimate(chunks, rows, bytes, countChunks, countRows, countBytes), reader.Estimate(filter, offset));
        using var fresh = JazminReader.Open(Path.Combine(Dir, file), new JazminReadOptions { Key = Key });
        var actual = fresh.Explain(filter, analyze: true, new JazminQueryOptions { Offset = offset }).Cost!;
        Assert.Equal(chunks, actual.ChunksRead);
        Assert.True(rows >= actual.Rows);
    }

    [Fact]
    public void Estimate_says_what_Count_reads_nothing_when_indexes_or_statistics_answer_it()
    {
        var path = Path.Combine(_temp, "e.jzm");
        using (var writer = JazminWriter.Create(path,
            [new JazminColumn("id", JazminType.Int) { Nullable = false }, new JazminColumn("city", JazminType.String) { Indexes = [JazminIndexKind.Sorted] }, new JazminColumn("amount", JazminType.Float)],
            new JazminWriteOptions { SortedBy = ["id"], ChunkRows = 100 }))
        {
            for (var id = 0; id < 2000; id++)
                writer.WriteRow(new Dictionary<string, object?> { ["id"] = (long)id, ["city"] = id % 2 == 0 ? "Durban" : "Cape Town", ["amount"] = (double)(id * 37 % 1000) });
        }
        using var reader = JazminReader.Open(path);
        Assert.Equal(0, reader.Estimate("""{"city":"Durban"}""").CountChunks);
        Assert.Equal(0, reader.Estimate("""{"id":{"gte":1000}}""").CountChunks);
        var scan = reader.Estimate("""{"amount":{"gt":900}}""");
        Assert.Equal((20, 2000L), (scan.CountChunks, scan.CountRows));
        Assert.Equal(scan.Bytes, scan.CountBytes);
        var partial = reader.Estimate("""{"id":{"gte":1050}}""");
        Assert.Equal((1, 100L), (partial.CountChunks, partial.CountRows));
        Assert.ThrowsAny<Exception>(() => reader.Estimate("""{"nope":1}"""));
    }
}
