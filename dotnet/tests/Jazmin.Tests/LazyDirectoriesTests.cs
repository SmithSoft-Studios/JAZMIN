using Jazmin.Format;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// A file's chunk directories (one per partition and append) are read when a query first needs them, not when it is
/// opened: opening a file after many appends costs the same as after none (issue #275). Mirrors
/// js/test/lazy-directories.test.js.
/// </summary>
public sealed class LazyDirectoriesTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-lazy-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("name", JazminType.String),
    };

    private static Dictionary<string, object?> Row(long id) => new() { ["id"] = id, ["name"] = $"Name {id}" };

    private string Write(string name, JazminKey? key)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions { Key = key, ChunkRows = 25 });
        for (var i = 0; i < 100; i++) writer.WriteRow(Row(i));
        return path;
    }

    /// <summary>A keyed file with three appends: four chunk directories.</summary>
    private (string Path, JazminKey Key, List<JazminReader.RotatedSection> Directories) AppendedFile()
    {
        var key = JazminKey.Generate();
        var path = Write("t.jzm", key);
        for (var a = 0; a < 3; a++) JazminFile.Append(path, new JazminAppend { Key = key, Insert = [Row(100 + a)] });
        using var r = JazminReader.Open(path, new JazminReadOptions { Key = key });
        return (path, key, r.KeyRotation().Sections.Where(s => s.SectionId.StartsWith("0/dir/", StringComparison.Ordinal)).ToList());
    }

    /// <summary>A read-only stream over bytes that records the ranges read.</summary>
    private sealed class RecordingStream(byte[] bytes) : Stream
    {
        private readonly MemoryStream _inner = new(bytes, writable: false);
        public List<(long Position, int Length)> Reads { get; } = new();
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => _inner.Length;
        public override long Position { get => _inner.Position; set => _inner.Position = value; }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => Record(_inner.Read(buffer, offset, count));
        public override int Read(Span<byte> buffer) => Record(_inner.Read(buffer));
        public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        private int Record(int n)
        {
            Reads.Add((_inner.Position - n, n));
            return n;
        }
    }

    private static List<string> ReadsOf(RecordingStream stream, IEnumerable<JazminReader.RotatedSection> sections) =>
        sections.Where(s => stream.Reads.Any(r => r.Position < s.Offset + s.Length && s.Offset < r.Position + r.Length)).Select(s => s.SectionId).ToList();

    [Fact]
    public void Open_ReadsNoChunkDirectory_TheFirstQueryReadsThem()
    {
        var (path, key, directories) = AppendedFile();
        Assert.Equal(4, directories.Count); // the original rows and each append have a chunk directory
        var stream = new RecordingStream(File.ReadAllBytes(path));
        using var r = JazminReader.Open(stream, new JazminReadOptions { Key = key });
        Assert.Empty(ReadsOf(stream, directories));
        Assert.Equal(103, r.RowCount);
        Assert.Equal(3, r.AppendCount);
        Assert.Equal(7, r.ChunkCount);
        Assert.Empty(ReadsOf(stream, directories));
        Assert.Equal(new[] { 99L, 100, 101, 102 }, r.Find(JazminFilter.Gte("id", 99)).Select(x => (long)x["id"]!));
        Assert.Equal(4, ReadsOf(stream, directories).Count);
    }

    [Fact]
    public void DamagedChunkDirectory_TheFileOpens_TheFirstQueryFailsWithAFormatError()
    {
        var (path, key, directories) = AppendedFile();
        var bytes = File.ReadAllBytes(path);
        var last = directories[^1];
        bytes[last.Offset + last.Length - 1] ^= 0xff; // fails its CRC-32 check
        using var r = JazminReader.Open(bytes, new JazminReadOptions { Key = key });
        Assert.Equal(103, r.RowCount);
        Assert.Throws<JazminFormatException>(() => r.Rows().ToList());
        Assert.Throws<JazminFormatException>(() => r.Get(0));
    }

    [Fact]
    public void UnencryptedFile_WithADamagedChunkDirectory_Opens_TheFirstQueryFails()
    {
        var bytes = File.ReadAllBytes(Write("plain.jzm", null));
        SectionRef directory;
        using (var r0 = JazminReader.Open(bytes)) directory = r0.AppendState().Table.Partitions[0].Segments[0]; // the one partition's
        bytes[directory.Offset + directory.Length - 1] ^= 0xff;
        using var r = JazminReader.Open(bytes);
        Assert.Equal(100, r.RowCount);
        Assert.Throws<JazminFormatException>(() => r.Count(JazminFilter.Gte("id", 50)));
    }
}
