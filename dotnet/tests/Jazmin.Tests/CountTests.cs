using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Count without reading what it doesn't need (issue #16): chunks whose statistics prove every row matches are counted
/// by their row counts, without being read, and in the others only the filter's columns are decoded. Every count must
/// equal the number of rows Find returns. Mirrors js/test/count.test.js.
/// </summary>
public sealed class CountTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-count-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("section", JazminType.String) { Nullable = false },
        new("score", JazminType.Float),
        new("note", JazminType.String),
    };

    private static readonly string[] Filters =
    [
        """{"id":{"gte":300}}""",
        """{"id":{"gte":64,"lt":640}}""",
        """{"section":"S5"}""",
        """{"section":{"in":["S3","S4"]},"id":{"lt":450}}""",
        """{"score":{"gt":20}}""",
        """{"note":null}""",
        """{"not":{"section":"S1"}}""",
        """{"or":[{"section":"S2"},{"id":{"gte":900}}]}""",
        """{"id":12345}""",
        "{}",
    ];

    private static Dictionary<string, object?> Row(long id) => new()
    {
        ["id"] = id, ["section"] = $"S{id / 100}", ["score"] = id % 7 == 0 ? double.NaN : id / 10.0, ["note"] = id % 5 == 0 ? null : $"note {id}",
    };

    private string Write(string name, int rows, JazminWriteOptions options, JazminColumn[]? columns = null)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, columns ?? Columns, options);
        for (var i = 0; i < rows; i++) writer.WriteRow(Row(i));
        return path;
    }

    private static void AssertCountsMatch(JazminReader reader)
    {
        foreach (var where in Filters)
        {
            var filter = JazminFilter.Parse(where);
            Assert.True(reader.Find(filter).LongCount() == reader.Count(filter), where);
        }
    }

    [Fact]
    public void Count_equals_the_rows_find_returns_with_appended_and_deleted_rows()
    {
        var path = Write("appended.jzm", 1000, new JazminWriteOptions { SortedBy = ["id"], ChunkRows = 64 });
        JazminFile.Append(path, new JazminAppend { Insert = Enumerable.Range(1000, 100).Select(i => Row(i)).ToList(), Delete = JazminFilter.Parse("""{"id":{"lt":30}}""") });
        JazminFile.Append(path, new JazminAppend { Delete = JazminFilter.Parse("""{"id":{"in":[500,501,777,1050]}}""") });
        using var reader = JazminReader.Open(path);
        AssertCountsMatch(reader);
        Assert.Equal(reader.RowCount, reader.Count(JazminFilter.Parse("""{"id":{"gte":0}}""")));
    }

    [Fact]
    public void Count_equals_the_rows_find_returns_in_access_controlled_files_for_the_owner_and_an_access_key()
    {
        var key = JazminKey.Generate();
        var bob = key.CreateAccessKey();
        var access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["S2", "S5"], Columns = ["*"] }] };
        var path = Write("access.jzm", 1000, new JazminWriteOptions { Key = key, ChunkRows = 32, Access = access });
        foreach (var options in new[] { new JazminReadOptions { Key = key }, new JazminReadOptions { AccessKey = bob } })
        {
            using var reader = JazminReader.Open(path, options);
            AssertCountsMatch(reader);
            Assert.Equal(100, reader.Count(JazminFilter.Eq("section", "S5")));
        }
    }

    [Fact]
    public void Chunks_every_row_of_which_matches_are_counted_without_reading_them()
    {
        var bytes = File.ReadAllBytes(Write("plain.jzm", 1000, new JazminWriteOptions { SortedBy = ["id"], ChunkRows = 64 }));
        var stream = new CountingStream(new MemoryStream(bytes));
        using (var reader = JazminReader.Open(stream))
        {
            reader.Count(JazminFilter.Parse("""{"id":{"gte":0}}""")); // loads the id statistics
            var before = stream.BytesRead;
            Assert.Equal(576, reader.Count(JazminFilter.Parse("""{"id":{"gte":64,"lt":640}}"""))); // chunks 1-9 exactly
            Assert.Equal(before, stream.BytesRead);
        }

        // With partly matching chunks at both ends, only those two are read: less than Find reads.
        var filter = JazminFilter.Parse("""{"id":{"gte":60,"lt":645}}""");
        var counting = new CountingStream(new MemoryStream(bytes));
        var finding = new CountingStream(new MemoryStream(bytes));
        using (var reader = JazminReader.Open(counting))
        using (var other = JazminReader.Open(finding))
            Assert.Equal(other.Find(filter).LongCount(), reader.Count(filter));
        Assert.True(counting.BytesRead < finding.BytesRead / 3, $"Count read {counting.BytesRead} bytes, Find {finding.BytesRead}");
    }

    [Fact]
    public void A_filter_sorted_indexes_answer_exactly_is_counted_from_the_index_alone()
    {
        JazminColumn[] indexed =
        [
            new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
            new("section", JazminType.String) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
            new("score", JazminType.Float) { Indexes = [JazminIndexKind.Sorted] },
            new("note", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        ];
        var path = Write("indexed.jzm", 1000, new JazminWriteOptions { SortedBy = ["id"], ChunkRows = 64 }, indexed);
        JazminFile.Append(path, new JazminAppend { Insert = Enumerable.Range(1000, 100).Select(i => Row(i)).ToList(), Delete = JazminFilter.Parse("""{"section":"S5","id":{"lt":520}}""") });
        var bytes = File.ReadAllBytes(path);
        using (var reader = JazminReader.Open(bytes))
        {
            AssertCountsMatch(reader);
            foreach (var where in new[]
            {
                """{"section":"S5"}""", """{"section":{"in":["S3","S10",null]}}""", """{"section":{"gte":"S3","lt":"S6"}}""", """{"section":{"startsWith":"S1"}}""",
                """{"section":{"ne":"S2"}}""", """{"note":null}""", """{"note":{"isNull":false}}""", """{"score":0}""", """{"score":{"gte":10,"lt":20}}""",
                """{"section":"S5","score":{"gt":55}}""",
            })
            {
                var filter = JazminFilter.Parse(where);
                Assert.True(reader.Find(filter).LongCount() == reader.Count(filter), where);
            }
            var nan = JazminFilter.Gt("score", double.NaN);
            Assert.Equal(reader.Find(nan).LongCount(), reader.Count(nan));
        }

        // Index pages only: far less than the chunks Find reads.
        var filter2 = JazminFilter.Parse("""{"section":{"in":["S2","S7"]}}""");
        var counting = new CountingStream(new MemoryStream(bytes));
        var finding = new CountingStream(new MemoryStream(bytes));
        using (var reader = JazminReader.Open(counting))
        using (var other = JazminReader.Open(finding))
        {
            Assert.Equal(200, reader.Count(filter2));
            Assert.Equal(200, other.Find(filter2).LongCount());
        }
        Assert.True(counting.BytesRead < finding.BytesRead / 2, $"Count read {counting.BytesRead} bytes, Find {finding.BytesRead}");
    }
}
