using System.Buffers.Binary;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// <see cref="JazminReader.Storage"/>: how a file's bytes are used, for deciding whether to compact it. A file written in
/// full uses every byte; an append leaves the replaced header behind; deleted rows stay stored until compaction.
/// Mirrors js/test/storage.test.js.
/// </summary>
[Collection("Fixture files")] // reads every fixture, which InteropTests writes: not at the same time (Windows refuses)
public sealed class StorageTests
{
    private static readonly string Fixtures = FindFixtures();
    private static readonly JsonObject Keys = JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures, "keys.json")))!.AsObject();

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures");
            if (File.Exists(Path.Combine(candidate, "keys.json"))) return candidate;
        }
        throw new DirectoryNotFoundException("spec/fixtures not found");
    }

    private static JazminStorage StorageOf(string file, JazminReadOptions options)
    {
        using var reader = JazminReader.Open(file, options);
        return reader.Storage();
    }

    /// <summary>The header length the trailer names: the bytes an append replaces (with the 44-byte trailer).</summary>
    private static int HeaderLength(string file)
    {
        var bytes = File.ReadAllBytes(file);
        return (int)BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(bytes.Length - 44 + 8));
    }

    [Fact]
    public void Every_fixture_written_in_full_uses_every_byte_and_appended_ones_have_unused_bytes()
    {
        foreach (var file in Directory.GetFiles(Fixtures, "*.jzm"))
        {
            var facts = JazminFile.Inspect(file);
            var options = !facts.Encrypted ? new JazminReadOptions()
                : facts.PasswordProtected ? new JazminReadOptions { Password = (string)Keys["password"]! }
                : new JazminReadOptions { Key = JazminKey.Parse((string)Keys["key"]!) };
            var s = StorageOf(file, options);
            var name = Path.GetFileName(file);
            Assert.True(s.FileBytes == new FileInfo(file).Length && s.UsedBytes + s.UnusedBytes == s.FileBytes, name);
            if (facts.Appended) Assert.True(s.UnusedBytes > 0 && s.AppendCount > 0, $"{name}: appended, so some bytes are unused");
            else Assert.True(s is { UnusedBytes: 0, DeletedRows: 0, AppendCount: 0 }, $"{name}: {s}");
        }
    }

    [Fact]
    public void An_append_leaves_the_replaced_header_unused_deleted_rows_stay_and_compaction_gives_every_byte_back()
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-storage-").FullName, "orders.jzm");
        var key = JazminKey.Generate();
        JazminColumn[] columns =
        [
            new("id", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] },
            new("customer", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
            new("note", JazminType.String),
        ];
        using (var writer = JazminWriter.Create(file, columns, new JazminWriteOptions { Key = key, ChunkRows = 500 }))
            for (var i = 0; i < 2000; i++)
                writer.WriteRow(new Dictionary<string, object?> { ["id"] = (long)i, ["customer"] = $"C{i % 50}", ["note"] = string.Concat(Enumerable.Repeat($"order {i} ", 4)) });
        var options = new JazminReadOptions { Key = key };
        var s = StorageOf(file, options);
        Assert.Equal((0L, 0L, 4L, 500L), (s.UnusedBytes, s.DeletedRows, s.Tables[0].Chunks, s.Tables[0].RowsPerChunk));
        Assert.Equal(["id/sorted/1", "customer/sorted/1"], s.Tables[0].Indexes.Select(ix => $"{ix.Column}/{ix.Kind}/{ix.Segments}"));

        var replaced = HeaderLength(file) + 44;
        JazminFile.Append(file, new JazminAppend { Key = key, Insert = [new Dictionary<string, object?> { ["id"] = 5000L, ["customer"] = "C1", ["note"] = "new" }] });
        s = StorageOf(file, options);
        Assert.Equal((replaced, 1, 5L), (s.UnusedBytes, s.AppendCount, s.Tables[0].Chunks));
        Assert.Equal([2, 2], s.Tables[0].Indexes.Select(ix => ix.Segments));

        JazminFile.Append(file, new JazminAppend { Key = key, Delete = JazminFilter.Lt("id", 400L) });
        s = StorageOf(file, options);
        Assert.Equal((400L, 1601L, 400L), (s.DeletedRows, s.Tables[0].Rows, s.Tables[0].DeletedRows));
        Assert.True(s.DeletedBytes > 0 && s.DeletedBytes < s.UsedBytes / 4, $"DeletedBytes {s.DeletedBytes}");

        var before = new FileInfo(file).Length;
        JazminFile.Compact(file, key);
        s = StorageOf(file, options);
        Assert.Equal((0L, 0L, 0, new FileInfo(file).Length), (s.UnusedBytes, s.DeletedRows, s.AppendCount, s.FileBytes));
        Assert.Equal([1, 1], s.Tables[0].Indexes.Select(ix => ix.Segments));
        Assert.True(s.FileBytes < before);
    }

    [Fact]
    public void A_shared_file_is_measured_with_its_owner_key_every_table_and_an_access_key_is_refused()
    {
        var owner = JazminKey.Parse((string)Keys["key"]!);
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-storage-").FullName, "tables.jzm");
        File.Copy(Path.Combine(Fixtures, "js-tables-access.jzm"), file);
        var s = StorageOf(file, new JazminReadOptions { Key = owner });
        Assert.Equal(0, s.UnusedBytes);
        Assert.True(s.Tables.Count >= 2);
        using var bob = JazminReader.Open(file, new JazminReadOptions { AccessKey = JazminAccessKey.Parse((string)Keys["bob"]!) });
        Assert.Contains("measured with its owner key", Assert.Throws<JazminValidationException>(() => bob.Storage()).Message);
    }
}
