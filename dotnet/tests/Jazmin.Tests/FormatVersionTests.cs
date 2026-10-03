using System.Buffers.Binary;
using Jazmin.Format;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Format 1.0 (docs/rfc/draft-jazmin-format-03.md): features, decimals, partitions, hidden column names.</summary>
public class FormatVersionTests
{
    private static readonly JazminColumn[] Money =
    {
        new("id", JazminType.Int) { Nullable = false },
        new("amount", JazminType.Decimal) { Indexes = [JazminIndexKind.Sorted] },
    };

    [Fact]
    public void DraftFiles_AreRefusedWithAClearMessage()
    {
        var bytes = TestData.Write(TestData.AllTypes, TestData.AllTypesRows());
        "JZMN"u8.CopyTo(bytes);
        var error = Assert.Throws<JazminFormatException>(() => JazminReader.Open(bytes));
        Assert.Contains("pre-release JAZMIN draft format", error.Message);
    }

    [Fact]
    public void AFileThatNeedsAnUnknownReaderFeature_IsRefused_NotMisread()
    {
        // Rewrites the (unencrypted) header with a reader feature this library does not know, and a fresh trailer.
        var bytes = TestData.Write(TestData.AllTypes, TestData.AllTypesRows());
        var trailer = bytes.AsSpan(bytes.Length - FormatConstants.TrailerSize);
        var headerOffset = (int)BinaryPrimitives.ReadUInt64LittleEndian(trailer);
        var headerLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(trailer[8..]);
        var header = Catalog.DecodeHeader(SectionCodec.Decode(bytes[headerOffset..(headerOffset + headerLength)], null, bytes[8..24], "header"));
        header.ReaderFeatures.Add("pages");
        var section = SectionCodec.Encode(Catalog.EncodeHeader(header), JazminCodec.Deflate, null, null, bytes[8..24], "header");
        var newTrailer = new byte[FormatConstants.TrailerSize];
        BinaryPrimitives.WriteUInt64LittleEndian(newTrailer, (ulong)headerOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(newTrailer.AsSpan(8), (uint)section.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(newTrailer.AsSpan(36), Crc32.Compute(newTrailer.AsSpan(0, 36)));
        FormatConstants.Magic.CopyTo(newTrailer.AsSpan(40));
        byte[] changed = [.. bytes[..headerOffset], .. section, .. newTrailer];
        var error = Assert.Throws<JazminFormatException>(() => JazminReader.Open(changed));
        Assert.Contains("needs the 'pages' feature", error.Message);
    }

    [Fact]
    public void Decimals_AreOrderedByValue_InFiltersStatisticsAndIndexes()
    {
        // Text order would put "10.5" before "9"; value order puts it after. 12.5 and 12.50 are the same value.
        var amounts = new[] { "9", "10.5", "-2", "12.50", "100", "0.001", "-0.5" };
        var bytes = TestData.Write(Money, amounts.Select((a, i) => new object?[] { (long)i, a }), new JazminWriteOptions { ChunkRows = 2 });
        using var reader = JazminReader.Open(bytes);
        List<string> Amounts(JazminFilter filter) => reader.Find(filter).Select(r => (string)r["amount"]!).ToList();
        Assert.Equal(["10.5", "12.50", "100"], Amounts(JazminFilter.Gt("amount", "9.99")));
        Assert.Equal(["12.50"], Amounts(JazminFilter.Eq("amount", "12.5")));
        Assert.Equal(["-2", "-0.5"], Amounts(JazminFilter.Lt("amount", 0m)));
        Assert.Equal("index", reader.Explain(JazminFilter.Eq("amount", "12.5")).Strategy);

        // Without the index, chunk statistics (min/max by value) still skip chunks.
        var plain = TestData.Write([Money[0], new JazminColumn("amount", JazminType.Decimal)], amounts.Select((a, i) => new object?[] { (long)i, a }),
            new JazminWriteOptions { ChunkRows = 2 });
        using var scan = JazminReader.Open(plain);
        Assert.Equal(new JazminPlan("scan", 7, 4, 3), scan.Explain(JazminFilter.Gte("amount", "100")));
        Assert.Equal(["100"], scan.Find(JazminFilter.Gte("amount", "100")).Select(r => (string)r["amount"]!));
    }

    [Fact]
    public void AnEmptyFile_KeepsItsIndexes_ForLaterAppends()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-empty-").FullName, "empty.jzm");
        File.WriteAllBytes(path, TestData.Write(Money, []));
        JazminFile.Append(path, new JazminAppend
        {
            Insert = Enumerable.Range(0, 50).Select(i => (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?> { ["id"] = (long)i, ["amount"] = $"{i}.25" }).ToList(),
        });
        using var reader = JazminReader.Open(path);
        Assert.Equal([("amount", JazminIndexKind.Sorted)], reader.Indexes);
        Assert.Equal(new JazminPlan("index", 1, 1, 0), reader.Explain(JazminFilter.Eq("amount", "7.25")));
    }

    [Fact]
    public void ManyPartitions_UseAPartitionTable_AppendsWriteDeltas_AndTheOwnerReadsOnlyThePartitionsItNeeds()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var columns = new[] { new JazminColumn("section", JazminType.String) { Nullable = false }, new JazminColumn("n", JazminType.Int) };
        IEnumerable<object?[]> Rows(int from, int to) => Enumerable.Range(from, to - from).Select(i => new object?[] { $"S{i / 3:D3}", (long)i });
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-partitions-").FullName, "p.jzm");
        File.WriteAllBytes(path, TestData.Write(columns, Rows(0, 300), new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["S007", "S120"] }] },
        }));
        JazminFile.Append(path, new JazminAppend
        {
            Key = owner,
            Insert = Rows(300, 363).Select(v => (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?> { ["section"] = v[0], ["n"] = v[1] }).ToList(),
        });
        JazminFile.Append(path, new JazminAppend
        {
            Key = owner,
            Insert = [new Dictionary<string, object?> { ["section"] = "S007", ["n"] = 1000L }],
        });

        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = owner }))
        {
            Assert.Equal(364, reader.RowCount);
            Assert.Equal([21L, 22L, 23L, 1000L], reader.Find(JazminFilter.Eq("section", "S007")).Select(r => (long)r["n"]!));
            Assert.Equal(121, reader.Access!.VisiblePartitions.Count);
            Assert.Equal(364, reader.Rows().Count());
        }
        using (var reader = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }))
        {
            Assert.Equal(["S007", "S120"], reader.Access!.VisiblePartitions.Order());
            Assert.Equal([21L, 22L, 23L, 360L, 361L, 362L, 1000L], reader.Rows().Select(r => (long)r["n"]!));
        }
    }

    [Fact]
    public void HiddenColumnNames_AreNotReadableWithAnAccessKey()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var columns = new[] { new JazminColumn("id", JazminType.Int), new JazminColumn("salary", JazminType.Decimal) };
        var bytes = TestData.Write(columns, [[1L, "100.00"]], new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { ColumnGroups = new() { ["pii"] = ["salary"] }, Grants = [new JazminGrant(bob) { Columns = ["*"] }] },
        });
        using var reader = JazminReader.Open(bytes, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false });
        Assert.Equal(["id"], reader.Columns.Select(c => c.Name));
        var error = Assert.Throws<JazminValidationException>(() => reader.Find(JazminFilter.Gt("salary", 0m)).ToList());
        Assert.Contains("salary", error.Message);
        Assert.False(bytes.AsSpan().IndexOf("salary"u8) >= 0, "the hidden column's name is stored in the clear");
    }

    [Fact]
    public void AnAccessKeysScans_SkipChunksOfItsPartitions_UsingStatistics()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var columns = new[] { new JazminColumn("branch", JazminType.String), new JazminColumn("n", JazminType.Int) };
        var bytes = TestData.Write(columns, Enumerable.Range(0, 400).Select(i => new object?[] { i < 200 ? "A" : "B", (long)i }), new JazminWriteOptions
        {
            ChunkRows = 20,
            Key = owner,
            Access = new JazminAccessOptions { PartitionBy = "branch", Grants = [new JazminGrant(bob) { Rows = ["B"] }] },
        });
        using var reader = JazminReader.Open(bytes, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false });
        Assert.Equal(new JazminPlan("scan", 200, 10, 9), reader.Explain(JazminFilter.Gte("n", 390L)));
        Assert.Equal(Enumerable.Range(390, 10).Select(i => (long)i), reader.Find(JazminFilter.Gte("n", 390L)).Select(r => (long)r["n"]!));
    }

    [Fact]
    public void KeySlotsAreInPages_EachKeyReadsTheSignedListAndItsOwnPage()
    {
        var owner = JazminKey.Generate();
        var keys = Enumerable.Range(0, 300).Select(_ => owner.CreateAccessKey()).ToArray();
        var columns = new[] { new JazminColumn("branch", JazminType.String), new JazminColumn("n", JazminType.Int) };
        var bytes = TestData.Write(columns, Enumerable.Range(0, 300).Select(i => new object?[] { $"B{i}", (long)i }), new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { PartitionBy = "branch", Grants = keys.Select((k, i) => new JazminGrant(k) { Rows = [$"B{i}"] }).ToList() },
        });
        foreach (var i in new[] { 0, 17, 150, 299 })
        {
            using var reader = JazminReader.Open(bytes, new JazminReadOptions { AccessKey = keys[i], CheckClockRollback = false });
            Assert.Equal([(long)i], reader.Rows().Select(r => (long)r["n"]!));
        }
        using (var asOwner = JazminReader.Open(bytes, new JazminReadOptions { Key = owner })) Assert.Equal(300, asOwner.RowCount);

        // A changed byte in one page stops only the keys whose slots are in it.
        var trailer = bytes.AsSpan(bytes.Length - FormatConstants.TrailerSize);
        var listAt = (int)BinaryPrimitives.ReadUInt64LittleEndian(trailer[12..]);
        var list = bytes.AsSpan(listAt + FormatConstants.EnvelopeSize); // stored uncompressed after its envelope
        Assert.True(BinaryPrimitives.ReadUInt32LittleEndian(list) > 5);
        var firstPage = (int)BinaryPrimitives.ReadUInt64LittleEndian(list[(4 + 8)..]);
        var tampered = (byte[])bytes.Clone();
        tampered[firstPage + 40] ^= 1;
        var refused = 0;
        foreach (var key in keys)
        {
            try
            {
                JazminReader.Open(tampered, new JazminReadOptions { AccessKey = key, CheckClockRollback = false }).Dispose();
            }
            catch (JazminFormatException e)
            {
                Assert.Contains("does not match the owner's signature", e.Message);
                refused++;
            }
        }
        Assert.InRange(refused, 1, keys.Length - 1);
    }
}
