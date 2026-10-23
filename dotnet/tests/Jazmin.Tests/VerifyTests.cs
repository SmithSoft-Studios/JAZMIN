using System.Buffers.Binary;
using System.Text.Json.Nodes;
using Jazmin.Format;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// <see cref="JazminReader.Verify"/>: checks every section of the file's current version, not only those a query reads
/// (issue #275: a byte changed in an index no query used went unnoticed). Shared files: each section's SHA-256 against
/// the owner's signature; files with a key or password: each section's CRC-32 and authentication tag; plain files:
/// CRC-32 only. Mirrors js/test/verify.test.js.
/// </summary>
[Collection("Fixture files")] // reads every fixture, which InteropTests writes: not at the same time (Windows refuses)
public sealed class VerifyTests
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

    private static JazminVerification VerifyOf(string file, JazminReadOptions options)
    {
        using var reader = JazminReader.Open(file, options);
        return reader.Verify();
    }

    private static JazminVerification VerifyOf(byte[] data, JazminReadOptions options)
    {
        using var reader = JazminReader.Open(data, options);
        return reader.Verify();
    }

    [Fact]
    public void Every_fixture_verifies_and_the_bytes_checked_and_the_unused_bytes_make_up_the_file()
    {
        foreach (var file in Directory.GetFiles(Fixtures, "*.jzm"))
        {
            var facts = JazminFile.Inspect(file);
            var options = !facts.Encrypted ? new JazminReadOptions()
                : facts.PasswordProtected ? new JazminReadOptions { Password = (string)Keys["password"]! }
                : new JazminReadOptions { Key = JazminKey.Parse((string)Keys["key"]!) };
            var result = VerifyOf(file, options);
            var name = Path.GetFileName(file);
            Assert.True(result.CheckedBy == (facts.AccessControlled ? "signature" : facts.Encrypted ? "encryption" : "checksum"), $"{name}: {result}");
            Assert.True(result.Sections > 0, name);
            Assert.True(64 + result.Bytes + result.UnusedBytes + result.PublisherBytes + 44 == new FileInfo(file).Length, $"{name}: {result}");
            if (!facts.Appended) Assert.True(result.UnusedBytes == 0, $"{name}: written in full, so every byte is checked");
        }
    }

    private static readonly string[] Cities = ["Durban", "Cape Town", "Pretoria"];

    private static List<Dictionary<string, object?>> Rows(int n) => Enumerable.Range(0, n).Select(i => new Dictionary<string, object?>
    {
        ["id"] = (long)(i + 1), ["name"] = $"name {i * 7919 % 1000} {i % 37}", ["city"] = Cities[i % 3], ["amountCents"] = (long)(i * 977 % 50000),
        ["note"] = string.Concat(Enumerable.Repeat($"note {i} ", 1 + i % 5)),
    }).ToList();

    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] }, new("name", JazminType.String) { Indexes = [JazminIndexKind.Trigram] },
        new("city", JazminType.String) { Indexes = [JazminIndexKind.Sorted] }, new("amountCents", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] },
        new("note", JazminType.String),
    ];

    private static byte[] Write(int rows, JazminWriteOptions options)
    {
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            foreach (var row in Rows(rows)) writer.WriteRow(row);
        return stream.ToArray();
    }

    /// <summary>Flips bytes across the whole file (every byte of the preamble and trailer, a stride elsewhere): each is caught.</summary>
    private static void AssertEveryFlipCaught(byte[] good, JazminReadOptions options, int tries = 600, bool fileId = true)
    {
        var positions = new SortedSet<int>();
        for (var p = 0; p < 64; p++)
            if (fileId || p < 8 || p >= 24) positions.Add(p);
        for (var p = good.Length - 44; p < good.Length; p++) positions.Add(p);
        var step = Math.Max(1, (good.Length - 108) / tries);
        for (var p = 64 + good.Length % step; p < good.Length - 44; p += step) positions.Add(p);
        var silent = new List<int>();
        foreach (var p in positions)
        {
            var bad = (byte[])good.Clone();
            bad[p] ^= 0xff;
            try
            {
                VerifyOf(bad, options);
                silent.Add(p);
            }
            catch (Exception e)
            {
                Assert.True(e is JazminException, $"byte {p}: {e}");
            }
        }
        Assert.True(silent.Count == 0, $"bytes changed without Verify() noticing (of {positions.Count} tried): {string.Join(", ", silent)}");
    }

    [Fact]
    public void A_changed_byte_anywhere_in_an_encrypted_file_is_caught_also_in_indexes_no_query_reads()
    {
        var key = JazminKey.Generate();
        var good = Write(3000, new JazminWriteOptions { Key = key, ChunkRows = 500 });
        Assert.Equal("encryption", VerifyOf(good, new JazminReadOptions { Key = key }).CheckedBy);
        AssertEveryFlipCaught(good, new JazminReadOptions { Key = key });
    }

    [Fact]
    public void A_changed_byte_anywhere_in_a_shared_file_is_caught_with_the_owner_key_and_an_access_key_is_refused()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var good = Write(1500, new JazminWriteOptions
        {
            Key = owner, ChunkRows = 300,
            Access = new JazminAccessOptions { PartitionBy = "city", ColumnGroups = new() { ["private"] = ["note"] }, Grants = [new JazminGrant(bob) { Rows = ["Durban"], Columns = [] }] },
        });
        Assert.Equal("signature", VerifyOf(good, new JazminReadOptions { Key = owner }).CheckedBy);
        AssertEveryFlipCaught(good, new JazminReadOptions { Key = owner }, tries: 400);
        Assert.Throws<JazminValidationException>(() => VerifyOf(good, new JazminReadOptions { AccessKey = bob }));
    }

    [Fact]
    public void A_plain_file_is_checked_by_its_checksums_so_accidental_damage_anywhere_is_caught()
    {
        var good = Write(1500, new JazminWriteOptions { ChunkRows = 500 });
        Assert.Equal("checksum", VerifyOf(good, new JazminReadOptions()).CheckedBy);
        // Nothing in a plain file depends on its file id (preamble bytes 8-23): only encryption or a signature binds it.
        AssertEveryFlipCaught(good, new JazminReadOptions(), tries: 400, fileId: false);
    }

    [Fact]
    public void An_appended_file_has_its_current_version_checked_whole_and_the_bytes_it_replaced_counted_as_unused()
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-verify-").FullName, "appended.jzm");
        var key = JazminKey.Generate();
        using (var writer = JazminWriter.Create(file, Columns, new JazminWriteOptions { Key = key, ChunkRows = 400 }))
            foreach (var row in Rows(1000)) writer.WriteRow(row);
        JazminFile.Append(file, new JazminAppend { Key = key, Insert = Rows(10).Select(r => new Dictionary<string, object?>(r) { ["id"] = (long)r["id"]! + 5000 }).ToList() });
        JazminFile.Append(file, new JazminAppend { Key = key, Delete = JazminFilter.Lt("id", 50L) });
        var options = new JazminReadOptions { Key = key };
        var result = VerifyOf(file, options);
        Assert.True(result.UnusedBytes > 0);
        Assert.Equal(new FileInfo(file).Length, 64 + result.Bytes + result.UnusedBytes + result.PublisherBytes + 44);
        var good = File.ReadAllBytes(file);
        // The last append's header ends the file, just before its trailer: a change there is caught.
        var inHeader = (byte[])good.Clone();
        inHeader[good.Length - 44 - 20] ^= 1;
        Assert.ThrowsAny<JazminException>(() => VerifyOf(inHeader, options));
        // A damaged last trailer makes readers fall back to the version before it (an interrupted append): Verify() says so.
        var inTrailer = (byte[])good.Clone();
        inTrailer[good.Length - 10] ^= 1;
        Assert.Throws<JazminFormatException>(() => VerifyOf(inTrailer, options));
    }

    [Fact]
    public void A_change_only_the_authentication_tag_catches_in_a_section_Verify_decodes_to_find_others_is_a_format_error()
    {
        var key = JazminKey.Generate();
        var good = Write(3000, new JazminWriteOptions { Key = key, ChunkRows = 500 });
        JazminReader.RotatedSection directory;
        using (var reader = JazminReader.Open(good, new JazminReadOptions { Key = key }))
            directory = reader.KeyRotation().Sections.First(s => s.SectionId.EndsWith("/sorted", StringComparison.Ordinal)); // a sorted index's directory
        var bad = (byte[])good.Clone();
        var at = (int)directory.Offset;
        bad[at + 16 + 20] ^= 1; // in the encrypted payload
        BinaryPrimitives.WriteUInt32LittleEndian(bad.AsSpan(at + 12), Crc32.Compute(bad.AsSpan(at + 16, directory.Length - 16))); // only the tag can tell
        var error = Assert.Throws<JazminFormatException>(() => VerifyOf(bad, new JazminReadOptions { Key = key }));
        Assert.Contains("modified", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_shared_file_with_locked_embedded_files_verifies_whole_with_the_owner_key_the_locks_left_closed()
    {
        var owner = JazminKey.Generate();
        var good = Write(200, new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { PartitionBy = "city" },
            Files = [new JazminFileInput("contract.pdf", new byte[300 * 1024]) { Lock = "contracts" }, new JazminFileInput("readme.txt", "open"u8.ToArray())],
            Locks = new Dictionary<string, JazminLockOptions?> { ["contracts"] = new() { Password = "correct horse", Iterations = 1000 } },
        });
        var result = VerifyOf(good, new JazminReadOptions { Key = owner });
        Assert.Equal(("signature", 0L), (result.CheckedBy, result.UnusedBytes));
        var bad = (byte[])good.Clone();
        bad[good.Length / 2] ^= 1; // the locked 300 KB contract is most of the file
        Assert.ThrowsAny<JazminException>(() => VerifyOf(bad, new JazminReadOptions { Key = owner }));
    }

    /// <summary>The file with its trailer's CRC made right again after a change to trailer bytes 0-35, as someone changing a file would.</summary>
    private static byte[] WithTrailerCrc(byte[] bytes)
    {
        var t = bytes.Length - 44;
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(t + 36), Crc32.Compute(bytes.AsSpan(t, 36)));
        return bytes;
    }

    private static byte[] WithFlags(byte[] file, Func<ushort, ushort> change)
    {
        var bad = (byte[])file.Clone();
        BinaryPrimitives.WriteUInt16LittleEndian(bad.AsSpan(4), change(BinaryPrimitives.ReadUInt16LittleEndian(bad.AsSpan(4))));
        return bad;
    }

    [Fact]
    public void Preamble_flags_and_trailer_fields_no_checksum_covers_must_hold_values_the_format_allows()
    {
        var key = JazminKey.Generate();
        var owner = JazminKey.Generate();
        var keyFile = Write(300, new JazminWriteOptions { Key = key, ChunkRows = 100 });
        var plainFile = Write(300, new JazminWriteOptions { ChunkRows = 100 });
        var sharedFile = Write(300, new JazminWriteOptions { Key = owner, ChunkRows = 100, Access = new JazminAccessOptions { PartitionBy = "city" } });

        // PASSWORD (spec 4.1, 7.6) only on an encrypted file that isn't shared, with an iteration count readers accept. (A key
        // file given the flag and a valid count can't be told from a password file opened with its derived key: not covered.)
        foreach (var (file, options, counts) in new (byte[], JazminReadOptions, uint[])[]
        {
            (keyFile, new JazminReadOptions { Key = key }, [0]),
            (plainFile, new JazminReadOptions(), [0, 1000]),
            (sharedFile, new JazminReadOptions { Key = owner }, [0, 1000]),
        })
        {
            foreach (var iterations in counts)
            {
                var bad = WithFlags(file, f => (ushort)(f | FormatConstants.FlagPassword));
                BinaryPrimitives.WriteUInt32LittleEndian(bad.AsSpan(56), iterations);
                Assert.Throws<JazminFormatException>(() => VerifyOf(bad, options));
            }
        }
        // Trailer bytes 12-35 locate the key-slot list and signature of a shared file; in other files they are 0.
        foreach (var at in new[] { 12, 20, 24, 32 })
        {
            var bad = (byte[])keyFile.Clone();
            bad[bad.Length - 44 + at] = 1;
            Assert.Throws<JazminFormatException>(() => VerifyOf(WithTrailerCrc(bad), new JazminReadOptions { Key = key }));
        }
        // The reserved bytes of the shared file's signature section (its envelope bytes 2-3, in no checksum or signature).
        var signatureAt = (int)BinaryPrimitives.ReadUInt64LittleEndian(sharedFile.AsSpan(sharedFile.Length - 44 + 24));
        var badEnvelope = (byte[])sharedFile.Clone();
        badEnvelope[signatureAt + 2] = 1;
        Assert.Throws<JazminFormatException>(() => VerifyOf(badEnvelope, new JazminReadOptions { Key = owner }));

        // An appended file has the APPENDED flag (11.2). A file never appended to may have it: an append cut short leaves it.
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-verify-").FullName, "appended.jzm");
        File.WriteAllBytes(path, keyFile);
        JazminFile.Append(path, new JazminAppend { Key = key, Insert = Rows(5).Select(r => new Dictionary<string, object?>(r) { ["id"] = (long)r["id"]! + 5000 }).ToList() });
        var cleared = WithFlags(File.ReadAllBytes(path), f => (ushort)(f & ~FormatConstants.FlagAppended));
        Assert.Throws<JazminFormatException>(() => VerifyOf(cleared, new JazminReadOptions { Key = key }));
        Assert.Equal(0, VerifyOf(WithFlags(keyFile, f => (ushort)(f | FormatConstants.FlagAppended)), new JazminReadOptions { Key = key }).UnusedBytes);
    }

    [Fact]
    public void A_section_length_beyond_the_end_of_the_file_is_refused()
    {
        // A plain file whose chunk directory (no tag) gives the last chunk's part a length of 2,000,000,000, every CRC right.
        var bad = File.ReadAllBytes(Path.Combine(Fixtures, "damaged", "verify-section-length.jzm"));
        using var reader = JazminReader.Open(bad);
        Assert.Equal(2, reader.Find(JazminFilter.Lt("id", 3L)).Count()); // the file opens and answers queries
        Assert.Contains("outside the file", Assert.Throws<JazminFormatException>(() => reader.Verify()).Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Signed_files_count_the_publisher_block_apart_and_bytes_added_around_it_or_a_damaged_block_are_a_change()
    {
        var dir = Path.Combine(Fixtures, "publisher");
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "expected.json")))!["fixtures"]!.AsArray();
        string[] changed = ["changed-gap.jzm", "changed-extra-byte.jzm", "invalid-block-crc.jzm", "invalid-block-reserved.jzm"];
        string[] skipped = ["changed-byte.jzm", "changed-trailing-byte.jzm"]; // a section, or the trailer: covered above
        foreach (var fixture in expected)
        {
            var name = (string)fixture!["file"]!;
            if (skipped.Contains(name)) continue;
            var file = Path.Combine(dir, name);
            var k = fixture["keys"]?.AsObject();
            var options = k?["password"] is { } password ? new JazminReadOptions { Password = (string)password! }
                : k?["key"] is { } key ? new JazminReadOptions { Key = JazminKey.Parse((string)key!) }
                : k?["ownerKey"] is { } ownerKey ? new JazminReadOptions { Key = JazminKey.Parse((string)ownerKey!) }
                : new JazminReadOptions();
            if (changed.Contains(name))
            {
                Assert.Throws<JazminFormatException>(() => VerifyOf(file, options));
                continue;
            }
            var result = VerifyOf(file, options);
            Assert.True(64 + result.Bytes + result.UnusedBytes + result.PublisherBytes + 44 == new FileInfo(file).Length, $"{name}: {result}");
            if (name == "appended.jzm")
            {
                Assert.Equal(0, result.PublisherBytes); // the block is before the header the append replaced: an earlier version
                Assert.True(result.UnusedBytes > 0);
            }
            else
            {
                Assert.True(result.UnusedBytes == 0, $"{name}: {result}");
                Assert.True(result.PublisherBytes > 0 == (name != "unsigned.jzm"), $"{name}: {result}");
            }
        }
    }

    /// <summary>The offset of the first deflate-compressed section: sections follow each other from byte 64, chunk data first.</summary>
    private static int FirstCompressedSection(byte[] file)
    {
        for (var at = 64; at < file.Length - 44; at += 16 + (int)BinaryPrimitives.ReadUInt32LittleEndian(file.AsSpan(at + 8)))
            if (file[at] == (byte)JazminCodec.Deflate) return at;
        throw new InvalidOperationException("no compressed section");
    }

    [Fact]
    public void Verify_quick_checks_a_plain_files_sections_by_their_checksums_and_envelopes_without_decompressing()
    {
        var good = Write(1500, new JazminWriteOptions { ChunkRows = 500 });
        var full = VerifyOf(good, new JazminReadOptions());
        JazminVerification Quick(byte[] data)
        {
            using var r = JazminReader.Open(data);
            return r.Verify(quick: true);
        }
        Assert.Equal(full, Quick(good)); // the same sections and bytes
        var at = FirstCompressedSection(good);
        // Caught by both: a changed payload byte (its CRC-32), an unknown codec.
        var payload = (byte[])good.Clone();
        payload[at + 20] ^= 1;
        Assert.Throws<JazminFormatException>(() => Quick(payload));
        var codec = (byte[])good.Clone();
        codec[at] = 7;
        Assert.Throws<JazminFormatException>(() => Quick(codec));
        // Caught only by the full check: the decompressed length in the envelope, which no CRC-32 covers. A query reading
        // the section would refuse it too.
        var rawLength = (byte[])good.Clone();
        BinaryPrimitives.WriteUInt32LittleEndian(rawLength.AsSpan(at + 4), BinaryPrimitives.ReadUInt32LittleEndian(rawLength.AsSpan(at + 4)) + 1);
        Assert.Throws<JazminFormatException>(() => VerifyOf(rawLength, new JazminReadOptions()));
        Assert.Equal(full, Quick(rawLength));
    }

    [Fact]
    public void Verify_quick_on_an_encrypted_file_is_the_full_check_since_the_tag_covers_the_envelope_too()
    {
        var key = JazminKey.Generate();
        var good = Write(1500, new JazminWriteOptions { Key = key, ChunkRows = 500 });
        var options = new JazminReadOptions { Key = key };
        using (var reader = JazminReader.Open(good, options))
            Assert.Equal(reader.Verify(), reader.Verify(quick: true));
        var at = FirstCompressedSection(good);
        var rawLength = (byte[])good.Clone();
        BinaryPrimitives.WriteUInt32LittleEndian(rawLength.AsSpan(at + 4), BinaryPrimitives.ReadUInt32LittleEndian(rawLength.AsSpan(at + 4)) + 1);
        using var changed = JazminReader.Open(rawLength, options);
        Assert.Throws<JazminFormatException>(() => changed.Verify(quick: true));
    }

    [Fact]
    public void A_closed_reader_refuses_Verify()
    {
        var reader = JazminReader.Open(Write(10, new JazminWriteOptions()));
        reader.Dispose();
        Assert.Throws<JazminValidationException>(() => reader.Verify());
    }
}
