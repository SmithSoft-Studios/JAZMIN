using Jazmin.Format;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Sorted indexes in pages (spec 8.1): the same answers however many pages, while a lookup reads one page.</summary>
public class PagedIndexTests
{
    // Rows sorted by seq, so indexes on the other columns are used (not chunk statistics).
    private static readonly JazminColumn[] Columns =
    {
        new("seq", JazminType.Int) { Nullable = false },
        new("account", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] },
        new("price", JazminType.Float) { Indexes = [JazminIndexKind.Sorted] },
        new("when", JazminType.DateTime) { Indexes = [JazminIndexKind.Sorted] },
    };

    private static readonly DateTime Start = new(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private static object?[] Row(int i) => new object?[]
    {
        (long)i,
        i % 17 == 0 ? null : $"ACC{(i * 7919) % 1000:D4}",
        (long)((i * 104729) % 5000 - 2500),
        i % 13 == 0 ? null : ((i * 31) % 997) / 4.0,
        Start.AddDays((i * 613) % 3000),
    };

    private const int Small = 200; // many small pages

    private static byte[] Write(int rows, int? pageBytes = null, JazminKey? key = null, JazminAccessOptions? access = null)
    {
        var stream = new MemoryStream();
        var options = new JazminWriteOptions { SortedBy = ["seq"], Key = key, Access = access };
        if (pageBytes is { } p) options.IndexPageBytes = p;
        using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            for (var i = 0; i < rows; i++) writer.WriteValues(Row(i));
        return stream.ToArray();
    }

    private static readonly JazminFilter[] Filters =
    {
        JazminFilter.Eq("account", "ACC0001"), JazminFilter.Eq("account", "ACC9999"), JazminFilter.Eq("account", "A"), JazminFilter.Eq("account", "ZZZ"),
        JazminFilter.In("account", "ACC0001", "ACC0500", "ACC0999", "nope"),
        JazminFilter.StartsWith("account", "ACC00"), JazminFilter.StartsWith("account", "ACC0"), JazminFilter.StartsWith("account", "X"),
        JazminFilter.IsNull("account"),
        JazminFilter.Eq("amount", -2500L), JazminFilter.Eq("amount", 2499L), JazminFilter.Eq("amount", 0L),
        JazminFilter.Gt("amount", 2400L), JazminFilter.Gte("amount", 2400L), JazminFilter.Lt("amount", -2400L), JazminFilter.Lte("amount", -2400L),
        JazminFilter.Gt("amount", 9999L), JazminFilter.Lt("amount", -9999L), JazminFilter.Gte("amount", -100L) & JazminFilter.Lt("amount", 100L),
        JazminFilter.Eq("price", 0.25), JazminFilter.Gt("price", 248.0), JazminFilter.Lte("price", 1.0), JazminFilter.IsNull("price"),
        JazminFilter.Eq("when", Start), JazminFilter.Gte("when", new DateTime(2031, 1, 1, 0, 0, 0, DateTimeKind.Utc)),
        JazminFilter.Eq("account", "ACC0001") & JazminFilter.Gt("amount", 0L),
    };

    private static List<long> Ids(JazminReader reader, JazminFilter filter) =>
        reader.Find(filter, new JazminQueryOptions { Select = ["seq"] }).Select(r => (long)r["seq"]!).ToList();

    [Fact]
    public void PagedIndex_AnswersEveryLookupLikeAWholeIndex()
    {
        using var whole = JazminReader.Open(Write(3000));
        using var paged = JazminReader.Open(Write(3000, Small));
        Assert.Equal(whole.Indexes, paged.Indexes); // pages are a storage detail
        foreach (var filter in Filters)
        {
            Assert.Equal("index", paged.Explain(filter).Strategy);
            Assert.Equal(Ids(whole, filter), Ids(paged, filter));
        }
    }

    [Fact]
    public void LargeIndex_IsPagedByDefault_AndALookupReadsOnePage()
    {
        var columns = new[] { Columns[0], Columns[2] };
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, columns, new JazminWriteOptions { SortedBy = ["seq"], ChunkRows = 1000 }, leaveOpen: true))
            for (var i = 0; i < 200_000; i++) writer.WriteValues((long)i, (long)((i * 104729L) % 1_000_003));
        var bytes = stream.ToArray();

        var counting = new CountingStream(new MemoryStream(bytes));
        using var reader = JazminReader.Open(counting);
        var opened = counting.BytesRead;
        var target = (123_456 * 104729L) % 1_000_003;
        Assert.Equal([123_456L], reader.Find(JazminFilter.Eq("amount", target)).Select(r => (long)r["seq"]!));
        Assert.True(bytes.Length > 1_000_000, $"file is large ({bytes.Length} bytes)");
        Assert.True(counting.BytesRead - opened < 100_000, $"lookup read {counting.BytesRead - opened} bytes (directory, one page, one chunk)");
    }

    [Fact]
    public void PagedIndexes_WorkWithAppendsCompactionEncryptionAndAccessControl()
    {
        var key = JazminKey.Generate();
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-paged-").FullName, "grow.jzm");
        File.WriteAllBytes(path, Write(2000, Small, key));
        JazminFile.Append(path, new JazminAppend
        {
            Key = key,
            Insert = Enumerable.Range(2000, 1000).Select(i => (IReadOnlyDictionary<string, object?>)Columns.Select((c, j) => (c.Name, Row(i)[j])).ToDictionary(x => x.Name, x => x.Item2)).ToList(),
        }); // the append writes its own index segment
        using var whole = JazminReader.Open(Write(3000));
        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = key }))
            foreach (var filter in Filters) Assert.Equal(Ids(whole, filter), Ids(reader, filter));
        JazminFile.Compact(path, key);
        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = key }))
            foreach (var filter in Filters) Assert.Equal(Ids(whole, filter), Ids(reader, filter));

        // Access-controlled: the owner reads paged indexes whose pages carry digests.
        var owner = JazminKey.Generate();
        var access = new JazminAccessOptions { PartitionBy = "account", Grants = [new JazminGrant(owner.CreateAccessKey()) { Rows = ["ACC0001"], Columns = ["*"] }] };
        using var asOwner = JazminReader.Open(Write(3000, Small, owner, access), new JazminReadOptions { Key = owner });
        foreach (var filter in Filters) Assert.Equal(Ids(whole, filter), Ids(asOwner, filter));
    }

    private sealed class CountingStream(Stream inner) : Stream
    {
        public long BytesRead { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, count));
        public override int Read(Span<byte> buffer) => Count(inner.Read(buffer));
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        private int Count(int n)
        {
            BytesRead += n;
            return n;
        }
    }
}
