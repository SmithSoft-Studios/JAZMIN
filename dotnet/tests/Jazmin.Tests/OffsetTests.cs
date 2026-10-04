using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Paging with an offset (issue #8): chunks whose every row matches and lies before the offset are counted, not read.
/// Every page must equal the same slice of the full result. Mirrors js/test/offset.test.js.
/// </summary>
public sealed class OffsetTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-offset-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private const int Chunk = 64;
    private static readonly long[] Offsets = [0, 1, 29, 33, 34, 63, 64, 65, 100, 128, 500, 543, 960, 1000, 1030, 1060, 1065, 5000];

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("section", JazminType.String) { Nullable = false },
        new("score", JazminType.Float),
    };

    private static Dictionary<string, object?> Row(long id) =>
        new() { ["id"] = id, ["section"] = $"S{id / 100}", ["score"] = id % 7 == 0 ? double.NaN : id / 10.0 };

    private string Write(string name, int rows, JazminWriteOptions options)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        for (var i = 0; i < rows; i++) writer.WriteRow(Row(i));
        return path;
    }

    private static List<long> Ids(JazminReader reader, string? where, long offset = 0, long? limit = null) =>
        reader.Find(where is null ? null : JazminFilter.Parse(where), new JazminQueryOptions { Offset = offset, Limit = limit })
            .Select(r => (long)r["id"]!).ToList();

    private static void AssertPagesMatch(JazminReader reader, string? where)
    {
        var all = Ids(reader, where);
        foreach (var offset in Offsets)
            Assert.Equal(all.Skip((int)offset).Take(9).ToList(), Ids(reader, where, offset, 9));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("""{"id":{"gte":300}}""")]
    [InlineData("""{"section":"S5"}""")]
    [InlineData("""{"score":{"gt":20}}""")] // float: never whole, since NaN is not in statistics
    [InlineData("""{"not":{"section":"S1"}}""")]
    [InlineData("""{"or":[{"section":"S2"},{"id":{"gte":900}}]}""")]
    [InlineData("""{"section":{"in":["S3","S4"]},"id":{"lt":450}}""")]
    public void Pages_equal_slices_of_the_full_result_with_appended_and_deleted_rows(string? where)
    {
        var path = Write("appended.jzm", 1000, new JazminWriteOptions { SortedBy = ["id"], ChunkRows = Chunk });
        JazminFile.Append(path, new JazminAppend { Insert = Enumerable.Range(1000, 100).Select(i => Row(i)).ToList(), Delete = JazminFilter.Parse("""{"id":{"lt":30}}""") });
        JazminFile.Append(path, new JazminAppend { Delete = JazminFilter.Parse("""{"id":{"in":[500,501,777,1050]}}""") });
        using var reader = JazminReader.Open(path);
        AssertPagesMatch(reader, where);
    }

    [Fact]
    public void A_deep_page_and_the_last_rows_read_only_the_chunks_they_return()
    {
        using var reader = JazminReader.Open(Write("plain.jzm", 1000, new JazminWriteOptions { SortedBy = ["id"], ChunkRows = Chunk }));
        int ChunksRead(string? where, long offset, long limit) =>
            reader.Explain(where is null ? null : JazminFilter.Parse(where), analyze: true, new JazminQueryOptions { Offset = offset, Limit = limit }).Cost!.ChunksRead;
        Assert.Equal(1, ChunksRead(null, 600, 5)); // rows 600-604: one chunk (576-639)
        Assert.Equal(1, ChunksRead(null, 990, 50)); // the last chunk
        Assert.Equal(2, ChunksRead("""{"section":"S5"}""", 80, 5)); // chunk 7 counted by reading it, chunk 8 skipped, page in chunk 9
        Assert.Equal([580L, 581, 582, 583, 584], Ids(reader, """{"section":"S5"}""", 80, 5));
        Assert.Equal(1, ChunksRead(null, 0, 64)); // a page ending on a chunk boundary does not read the next chunk
    }

    [Fact]
    public void Access_controlled_files_skip_whole_chunks_of_a_pinned_partition()
    {
        var key = JazminKey.Generate();
        var path = Write("access.jzm", 1000, new JazminWriteOptions { Key = key, ChunkRows = 32, Access = new JazminAccessOptions { PartitionBy = "section" } });
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = key });
        var all = Ids(reader, """{"section":"S5"}""");
        Assert.Equal(100, all.Count);
        var page = reader.Explain(JazminFilter.Eq("section", "S5"), analyze: true, new JazminQueryOptions { Offset = 40, Limit = 10 }).Cost!;
        Assert.Equal((10L, 1), (page.Rows, page.ChunksRead)); // S5's chunks hold 32, 32, 32 and 4 rows
        Assert.Equal(all.Skip(40).Take(10), Ids(reader, """{"section":"S5"}""", 40, 10));
        var both = Ids(reader, """{"section":{"in":["S5","S6"]}}""");
        Assert.Equal(both.Skip(120).Take(10), Ids(reader, """{"section":{"in":["S5","S6"]}}""", 120, 10));
        AssertPagesMatch(reader, """{"section":"S7","id":{"gte":720}}""");
    }
}
