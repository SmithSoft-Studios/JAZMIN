using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Explain with analyze: what a query read. The same files and queries are checked with the same numbers in js/test/explain.test.js.</summary>
public class ExplainTests
{
    private static readonly string Dir = FindFixtures();
    private static readonly JazminKey Key = JazminKey.Parse((string)JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "keys.json")))!["key"]!);

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures");
            if (File.Exists(Path.Combine(candidate, "keys.json"))) return candidate;
        }
        throw new InvalidOperationException("spec/fixtures not found");
    }

    private static JazminPlan Analyze(string file, string? where, JazminQueryOptions? options = null)
    {
        using var reader = JazminReader.Open(Path.Combine(Dir, file), new JazminReadOptions { Key = Key });
        return reader.Explain(where is null ? null : JazminFilter.Parse(where), analyze: true, options);
    }

    [Theory]
    [InlineData("js-paged-key.jzm", """{"id":7}""", null, null, null, "index", 1L, 1L, 1817L, 1, 2, 9L)]
    [InlineData("js-paged-key.jzm", """{"country":"NA"}""", null, null, null, "index", 100L, 100L, 9187L, 8, 2, 72L)]
    [InlineData("js-paged-key.jzm", """{"score":{"gt":50}}""", "id", null, null, "scan", 500L, 126L, 3493L, 3, 0, 6L)]
    // Only the filter's and the selected columns are decoded, and a column group with neither is not read (issue #11).
    [InlineData("js-access.jzm", """{"score":{"gt":50}}""", "id", null, null, "scan", 500L, 126L, 63939L, 126, 0, 252L)]
    [InlineData("js-paged-key.jzm", """{"country":"NA"}""", "id", null, null, "index", 100L, 100L, 9187L, 8, 2, 16L)]
    // Chunks wholly before the offset are counted, not read (issue #8): one chunk read for this page.
    [InlineData("js-paged-key.jzm", null, null, 100L, 10L, "scan", 500L, 10L, 1145L, 1, 0, 9L)]
    [InlineData("js-access.jzm", null, null, 100L, 10L, "scan", 500L, 10L, 37147L, 10, 0, 90L)]
    public void Analyze_reports_rows_bytes_chunks_index_pages_and_columns(string file, string? where, string? select, long? offset, long? limit,
        string strategy, long candidateRows, long rows, long bytesRead, int chunksRead, int indexPagesRead, long columnsDecoded)
    {
        var options = new JazminQueryOptions { Select = select is null ? null : [select], Offset = offset ?? 0, Limit = limit };
        var plan = Analyze(file, where, options);
        Assert.Equal(strategy, plan.Strategy);
        Assert.Equal(candidateRows, plan.CandidateRows);
        var cost = Assert.IsType<JazminQueryCost>(plan.Cost);
        Assert.Equal((rows, bytesRead, chunksRead, indexPagesRead, columnsDecoded), (cost.Rows, cost.BytesRead, cost.ChunksRead, cost.IndexPagesRead, cost.ColumnsDecoded));
        Assert.True(cost.Elapsed >= TimeSpan.Zero);
    }

    [Fact]
    public void Explain_without_analyze_is_unchanged_and_analyze_leaves_the_reader_as_it_was()
    {
        using var reader = JazminReader.Open(Path.Combine(Dir, "js-paged-key.jzm"), new JazminReadOptions { Key = Key });
        Assert.Equal(new JazminPlan("index", 1, reader.ChunkCount, 0), reader.Explain(JazminFilter.Eq("id", 7)));
        Assert.Null(reader.Explain(JazminFilter.Eq("id", 7), analyze: false).Cost);
        var before = reader.Find(JazminFilter.Eq("country", "NA"), new JazminQueryOptions { Limit = 5 }).Select(r => r.RowId).ToList();
        Assert.Equal(5, reader.Explain(JazminFilter.Eq("country", "NA"), analyze: true, new JazminQueryOptions { Limit = 5 }).Cost!.Rows);
        Assert.Equal(before, reader.Find(JazminFilter.Eq("country", "NA"), new JazminQueryOptions { Limit = 5 }).Select(r => r.RowId).ToList());
        Assert.Equal(0, reader.Explain(JazminFilter.Eq("id", 7), analyze: true).Cost!.IndexPagesRead); // already loaded
    }
}
