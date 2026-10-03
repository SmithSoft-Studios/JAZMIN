using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Jazmin.Tests;

public class RoundTripTests
{
    private static void AssertRowsEqual(object?[] expected, object?[] actual)
    {
        Assert.Equal(expected.Length, actual.Length);
        for (var i = 0; i < expected.Length; i++)
        {
            if (expected[i] is JsonNode node) Assert.Equal(node.ToJsonString(), ((JsonNode)actual[i]!).ToJsonString());
            else Assert.Equal(expected[i], actual[i]);
        }
    }

    [Fact]
    public void EveryType_RoundTrips()
    {
        var bytes = TestData.Write(TestData.AllTypes, TestData.AllTypesRows(), new JazminWriteOptions { Metadata = new JsonObject { ["source"] = "test" } });
        using var reader = JazminReader.Open(bytes);
        Assert.Equal(3, reader.RowCount);
        Assert.Equal("test", (string?)reader.Metadata["source"]);
        Assert.Equal("Primary key", reader.Columns[0].Description);
        var rows = reader.Rows().Select(TestData.Values).ToList();
        var expected = TestData.AllTypesRows();
        for (var i = 0; i < expected.Length; i++) AssertRowsEqual(expected[i], rows[i]);
    }

    [Fact]
    public void ManyChunks_ReadInOrder_AndGetIsRandomAccess()
    {
        var columns = new[] { new JazminColumn("id", JazminType.Int), new JazminColumn("name", JazminType.String) };
        var bytes = TestData.Write(columns, Enumerable.Range(0, 1000).Select(i => new object?[] { (long)i, $"n{i}" }),
            new JazminWriteOptions { ChunkRows = 64 });
        using var reader = JazminReader.Open(bytes);
        Assert.Equal(16, reader.ChunkCount);
        Assert.Equal(Enumerable.Range(0, 1000).Select(i => (long)i), reader.Rows().Select(r => (long)r["id"]!));
        Assert.Equal("n777", reader.Get(777)["name"]);
    }

    [Fact]
    public void EmptyFile_IsValid()
    {
        using var reader = JazminReader.Open(TestData.Write(new[] { new JazminColumn("x", JazminType.Int) }, Array.Empty<object?[]>()));
        Assert.Equal(0, reader.RowCount);
        Assert.Empty(reader.Rows());
    }

    [Theory]
    [InlineData(JazminCodec.Deflate)]
    [InlineData(JazminCodec.Brotli)]
    public void Compression_IsMuchSmallerThanJson(JazminCodec codec)
    {
        var columns = new[] { new JazminColumn("id", JazminType.Int), new JazminColumn("country", JazminType.String), new JazminColumn("amount", JazminType.Float) };
        var rows = Enumerable.Range(0, 5000).Select(i => new object?[] { (long)i, i % 3 != 0 ? "South Africa" : "Namibia", i * 1.5 }).ToList();
        var json = JsonSerializer.SerializeToUtf8Bytes(rows.Select(r => new { id = r[0], country = r[1], amount = r[2] }));
        var size = TestData.Write(columns, rows, new JazminWriteOptions { Codec = codec }).Length;
        Assert.True(size < json.Length / 4, $"{codec}: {size} bytes vs JSON {json.Length}");
    }

    [Fact]
    public void Writer_ValidatesRows()
    {
        using var writer = new JazminWriter(new MemoryStream(), TestData.AllTypes);
        Assert.Throws<JazminValidationException>(() => writer.WriteRow(new Dictionary<string, object?> { ["id"] = "x" }));
        Assert.Throws<JazminValidationException>(() => writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["nme"] = "typo" }));
        Assert.Throws<JazminValidationException>(() => writer.WriteRow(new Dictionary<string, object?> { ["name"] = "no id" }));
        Assert.Throws<JazminValidationException>(() => writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["balance"] = "1e5" }));
    }

    [Fact]
    public void Encrypted_WithKey_ReadableOnlyWithThatKey()
    {
        var key = JazminKey.Generate();
        var bytes = TestData.Write(TestData.AllTypes, TestData.AllTypesRows(),
            new JazminWriteOptions { Key = key, Metadata = new JsonObject { ["owner"] = "secret-team" } });
        Assert.DoesNotContain("secret-team", Encoding.UTF8.GetString(bytes));
        Assert.DoesNotContain("Ann", Encoding.UTF8.GetString(bytes));

        using (var reader = JazminReader.Open(bytes, new JazminReadOptions { Key = JazminKey.Parse(key.ToString()) }))
        {
            Assert.True(reader.IsEncrypted);
            Assert.Equal(3, reader.Rows().Count());
        }
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(bytes));
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(bytes, new JazminReadOptions { Key = JazminKey.Generate() }));
    }

    [Fact]
    public void Encrypted_WithPassword()
    {
        var bytes = TestData.Write(TestData.AllTypes, TestData.AllTypesRows(), new JazminWriteOptions { Password = "correct horse", KdfIterations = 1000 });
        using (var reader = JazminReader.Open(bytes, new JazminReadOptions { Password = "correct horse" }))
            Assert.Equal("Ann", reader.Get(0)["name"]);
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(bytes, new JazminReadOptions { Password = "wrong" }));
    }

    [Fact]
    public void KeyForUnencryptedFile_IsAnError()
    {
        var bytes = TestData.Write(TestData.AllTypes, TestData.AllTypesRows());
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(bytes, new JazminReadOptions { Key = JazminKey.Generate() }));
    }

    [Fact]
    public void Corruption_IsDetected()
    {
        var bytes = TestData.Write(TestData.AllTypes, TestData.AllTypesRows());
        Assert.Throws<JazminFormatException>(() => JazminReader.Open(bytes[..^3]));

        var damaged = (byte[])bytes.Clone();
        damaged[80] ^= 0xff;
        using (var reader = JazminReader.Open(damaged))
            Assert.Throws<JazminFormatException>(() => reader.Rows().ToList());

        var notJazmin = (byte[])bytes.Clone();
        notJazmin[0] = 0;
        Assert.Throws<JazminFormatException>(() => JazminReader.Open(notJazmin));
    }

    [Fact]
    public void SwappingEncryptedChunks_IsDetected()
    {
        var key = JazminKey.Generate();
        var bytes = TestData.Write(new[] { new JazminColumn("id", JazminType.Int) }, Enumerable.Range(0, 4).Select(i => new object?[] { (long)i }),
            new JazminWriteOptions { Key = key, ChunkRows = 2, Codec = JazminCodec.None });
        const int first = 64;
        var length = BitConverter.ToInt32(bytes, first + 8) + 16;
        var a = bytes[first..(first + length)];
        var b = bytes[(first + length)..(first + 2 * length)];
        b.CopyTo(bytes, first);
        a.CopyTo(bytes, first + length);
        using var reader = JazminReader.Open(bytes, new JazminReadOptions { Key = key });
        Assert.Throws<JazminKeyException>(() => reader.Rows().ToList());
    }

    [Fact]
    public void Dispose_WithoutFinish_StillWritesCompleteFile()
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new[] { new JazminColumn("x", JazminType.Int) }, leaveOpen: true))
            writer.WriteValues(1L);
        using var reader = JazminReader.Open(stream.ToArray());
        Assert.Equal(1, reader.RowCount);
    }
}
