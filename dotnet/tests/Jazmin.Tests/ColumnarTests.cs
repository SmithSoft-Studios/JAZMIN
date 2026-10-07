using Jazmin.Format;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

public class ColumnarTests
{
    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false },
        new("big", JazminType.Int),
        new("flag", JazminType.Bool),
        new("amount", JazminType.Float),
        new("price", JazminType.Decimal),
        new("country", JazminType.String),
        new("note", JazminType.String),
        new("when", JazminType.DateTime),
        new("blob", JazminType.Binary),
    };

    private static readonly double[] Floats = { 0, -0.0, 1.5, 12.34, -0.01, 0.1 + 0.2, 1e300, -1e-300, double.NaN, double.PositiveInfinity, double.NegativeInfinity, 123456789.123, 9007199254740992 };

    private static object?[] Row(int i) => new object?[]
    {
        (long)i,
        i % 50 == 0 ? null : i % 7 == 0 ? long.MaxValue : i % 11 == 0 ? long.MinValue : i * 1000L,
        i % 9 == 0 ? null : i % 3 == 0,
        i % 13 == 0 ? null : Floats[i % Floats.Length],
        i % 4 == 0 ? null : i % 5 == 0 ? "-0.05" : $"{i}.10",
        new[] { "ZA", "NA", "BW" }[i % 3],
        i % 6 == 0 ? null : $"note {i} 👋 é",
        i % 8 == 0 ? null : new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i),
        i % 5 == 0 ? null : new byte[] { (byte)i, 1, 2 },
    };

    private static byte[] Write(int rows = 700, JazminKey? key = null)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions { ChunkRows = 256, Key = key }, leaveOpen: true))
            for (var i = 0; i < rows; i++) writer.WriteValues(Row(i));
        return stream.ToArray();
    }

    private static List<object?[]> Read(byte[] bytes, JazminKey? key = null)
    {
        using var reader = JazminReader.Open(bytes, new JazminReadOptions { Key = key });
        return reader.Rows().Select(r => Columns.Select(c => r[c.Name]).ToArray()).ToList();
    }

    [Fact]
    public void EveryTypeAndEdgeValue_RoundTrips()
    {
        var columnar = Read(Write());
        Assert.Equal(700, columnar.Count);
        for (var i = 0; i < columnar.Count; i++)
            for (var j = 0; j < Columns.Length; j++)
                Assert.Equal(Row(i)[j], columnar[i][j]);
        Assert.True(double.IsNegative((double)columnar[1][3]!) && (double)columnar[1][3]! == 0); // -0 keeps its sign
        Assert.True(double.IsNaN((double)columnar[8][3]!));
        Assert.Equal(0.1 + 0.2, columnar[5][3]);
        Assert.Equal(long.MaxValue, columnar[7][1]);
        Assert.Equal(long.MinValue, columnar[11][1]);
    }

    [Fact]
    public void Files_StartWithTheFormatMagic()
    {
        var file = Write(20_000);
        Assert.True(file.AsSpan(0, 4).SequenceEqual("JZM1"u8));
        Assert.True(file.AsSpan(file.Length - 4).SequenceEqual("JZM1"u8));
    }

    [Fact]
    public void Filters_DecodingOnlyTheirColumns_ReturnExactlyTheMatchingRows()
    {
        using var col = JazminReader.Open(Write());
        var all = col.Rows().Select(r => r.RawValues.ToArray()).ToList();
        IEnumerable<string> Expected(JazminFilter filter, JazminQueryOptions? option)
        {
            var plan = BoundFilter.Bind(filter, Columns)!;
            var select = option?.Select ?? Columns.Select(c => c.Name).ToList();
            return all.Where(v => FilterEngine.Evaluate(plan, v)).Skip((int)(option?.Offset ?? 0)).Take((int)(option?.Limit ?? int.MaxValue))
                .Select(v => string.Join("|", select.Select(name => $"{name}={v[Array.FindIndex(Columns, c => c.Name == name)]}")));
        }
        var filters = new[]
        {
            JazminFilter.Eq("country", "NA"),
            JazminFilter.And(JazminFilter.Eq("country", "ZA"), JazminFilter.Eq("flag", true)),
            JazminFilter.Or(JazminFilter.Gt("big", 100_000L), JazminFilter.IsNull("note")),
            JazminFilter.Not(JazminFilter.In("country", "ZA", "BW")),
            JazminFilter.Parse("{ \"note\": { \"icontains\": \"NOTE 1\" } }"),
        };
        var options = new JazminQueryOptions?[] { null, new() { Select = ["id", "note"] }, new() { Offset = 3, Limit = 7 }, new() { Select = ["note"], Limit = 2 } };
        foreach (var filter in filters)
            foreach (var option in options)
                Assert.Equal(Expected(filter, option), col.Find(filter, option).Select(r => string.Join("|", r.Select(p => $"{p.Key}={p.Value}"))));
    }

    [Fact]
    public void EncryptedColumnarFiles_ReadBack()
    {
        var key = JazminKey.Generate();
        Assert.Equal(700, Read(Write(key: key), key).Count);
    }

    [Fact]
    public void Append_And_Update_KeepEveryValue()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-col-").FullName, "f.jzm");
        File.WriteAllBytes(path, Write(300));
        JazminFile.Append(path, new JazminAppend
        {
            Insert = Enumerable.Range(300, 50).Select(i => (IReadOnlyDictionary<string, object?>)Columns.Select((c, j) => (c.Name, Row(i)[j])).ToDictionary(x => x.Name, x => x.Item2)).ToList(),
            Delete = JazminFilter.Lt("id", 10),
        });
        using (var reader = JazminReader.Open(path))
            Assert.Equal(Enumerable.Range(10, 340).Select(i => (long)i), reader.Rows().Select(r => (long)r["id"]!));
        JazminFile.Update(path, new JazminUpdate());
        using (var reader = JazminReader.Open(path))
        {
            var rows = reader.Rows().ToList();
            Assert.Equal(340, rows.Count);
            for (var j = 0; j < Columns.Length; j++) Assert.Equal(Row(42)[j], rows[32][Columns[j].Name]);
        }
    }

    [Fact]
    public void TypedColumnBuffers_EncodeTheSameBytesAsTheReferenceEncoder()
    {
        var random = new Random(3);
        object? Value(JazminType type, int i) => random.Next(10) == 0 ? null : type switch
        {
            JazminType.Int => random.Next(6) switch { 0 => long.MaxValue, 1 => long.MinValue, 2 => (long)i * 1000, _ => (long)random.Next(-500, 500) },
            JazminType.DateTime => 1_700_000_000_000L + i * 60_000L + random.Next(1000),
            JazminType.Float => random.Next(7) switch { 0 => -0.0, 1 => double.NaN, 2 => double.PositiveInfinity, 3 => random.NextDouble(), _ => random.Next(100_000) / 100.0 },
            JazminType.Bool => random.Next(2) == 0,
            JazminType.String => random.Next(3) == 0 ? $"unique {i} 👋" : new[] { "ZA", "NA", "1.50" }[random.Next(3)],
            JazminType.Decimal => random.Next(3) == 0 ? $"{i}.{i % 100:D2}" : new[] { "1.50", "-0.05", "12" }[random.Next(3)],
            JazminType.Json => "{\"i\":" + i + "}",
            _ => new[] { (byte)i, (byte)(i >> 8) },
        };
        foreach (var type in Enum.GetValues<JazminType>())
        {
            foreach (var rows in new[] { 0, 1, 2, 17, 600 })
            {
                var values = Enumerable.Range(0, rows).Select(i => Value(type, i)).ToList();
                var reference = Columnar.Encode([type], [values], rows);
                var buffer = ColumnBuffer.For(type);
                foreach (var v in values) buffer.Add(v);
                var output = new ByteWriter();
                buffer.Encode(output, new ByteWriter());
                Assert.True(reference.AsSpan().SequenceEqual(output.AsSpan()), $"{type}, {rows} rows");
            }
        }
    }

    [Fact]
    public void ParallelAndSequentialWriters_ProduceTheSameData()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        byte[] WriteWith(int parallelism, bool access)
        {
            var stream = new MemoryStream();
            var options = new JazminWriteOptions
            {
                ChunkRows = 37, MaxDegreeOfParallelism = parallelism, Key = owner,
                SortedBy = access ? ["country", "id"] : null,
                Access = access ? new JazminAccessOptions { PartitionBy = "country", Grants = [new JazminGrant(bob) { Rows = ["NA"] }] } : null,
            };
            using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            {
                var rows = Enumerable.Range(0, 2000).Select(Row);
                if (access) rows = rows.OrderBy(r => (string)r[5]!, StringComparer.Ordinal).ThenBy(r => (long)r[0]!);
                foreach (var row in rows) writer.WriteValues(row);
            }
            return stream.ToArray();
        }
        string Dump(byte[] file, JazminReadOptions options)
        {
            using var reader = JazminReader.Open(file, options);
            return string.Join(Environment.NewLine, reader.Rows().Select(r => string.Join("|", r.Select(p => $"{p.Key}={p.Value}"))))
                + $"#{reader.ChunkCount}";
        }
        foreach (var access in new[] { false, true })
        {
            var sequential = WriteWith(1, access);
            var parallel = WriteWith(8, access);
            // (lengths may differ by a few bytes: the encrypted header holds random keys, which compress differently)
            Assert.Equal(Dump(sequential, new JazminReadOptions { Key = owner }), Dump(parallel, new JazminReadOptions { Key = owner }));
            if (access)
                Assert.Equal(Dump(sequential, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }),
                    Dump(parallel, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }));
        }
    }

    [Fact]
    public void ParallelAndSequentialReads_ReturnTheSameRows()
    {
        var key = JazminKey.Generate();
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions { ChunkRows = 50, Key = key }, leaveOpen: true))
            for (var i = 0; i < 3000; i++) writer.WriteValues(Row(i));
        var file = stream.ToArray();
        string Dump(int parallelism, JazminFilter? filter, JazminQueryOptions? options)
        {
            using var reader = JazminReader.Open(file, new JazminReadOptions { Key = key, MaxDegreeOfParallelism = parallelism });
            return string.Join(Environment.NewLine, reader.Find(filter, options).Select(r => string.Join("|", r.Select(p => $"{p.Key}={p.Value}"))));
        }
        var cases = new (JazminFilter? Filter, JazminQueryOptions? Options)[]
        {
            (null, null),
            (null, new() { Select = ["id", "amount"] }),
            (JazminFilter.Eq("country", "NA"), new() { Select = ["id"] }),
            (JazminFilter.Gt("big", 0L), new() { Limit = 7 }), // stops early while chunks are still in flight
            (null, new() { Offset = 1234, Limit = 10 }),
        };
        foreach (var (filter, options) in cases) Assert.Equal(Dump(1, filter, options), Dump(4, filter, options));
    }

    [Fact]
    public void MalformedStreams_AreRejected()
    {
        var good = Columnar.Encode(new[] { JazminType.String }, new[] { new List<object?> { "a", "a", "a", "b" } }, 4);
        Assert.Equal(new object?[] { "a", "a", "a", "b" }, Columnar.Decode(good, new[] { JazminType.String }, 4, 0)[0]);

        static byte[] Stream(byte flags, params byte[] body)
        {
            var w = new ByteWriter();
            w.VarUInt((ulong)(1 + body.Length));
            w.Byte(flags);
            w.Bytes(body);
            return w.ToArray();
        }
        Assert.Throws<JazminFormatException>(() => Columnar.Decode(Stream(9), new[] { JazminType.Int }, 0, 0));
        Assert.Throws<JazminFormatException>(() => Columnar.Decode(Stream(Columnar.Dictionary), new[] { JazminType.Int }, 0, 0));
        Assert.Throws<JazminFormatException>(() => Columnar.Decode(Stream(0x20), new[] { JazminType.Int }, 0, 0));
        Assert.Throws<JazminFormatException>(() => Columnar.Decode(Stream(Columnar.Dictionary, 1, 1, 0x61, 3), new[] { JazminType.String }, 1, 0));
        Assert.Throws<JazminFormatException>(() => Columnar.Decode(good.Concat(new byte[] { 0 }).ToArray(), new[] { JazminType.String }, 4, 0));
        Assert.ThrowsAny<JazminException>(() => Columnar.Decode(Stream(Columnar.Plain, 2), new[] { JazminType.Int }, 2, 0));
    }

    [Fact]
    public void DictionaryStream_ReadPastItsEnd_IsRejected()
    {
        // Fuzz findings: the nulls bitmap ran past the end of the stream, so the dictionary size was checked against a
        // negative length left. A size whose int was negative failed to allocate (OverflowException); one that wrapped to a
        // small array was indexed past its end (IndexOutOfRangeException).
        foreach (var size in new ulong[] { 0x1_0000_0002, 0xffff_ffff })
        {
            var w = new ByteWriter();
            w.VarUInt(1); // the stream holds only its flags
            w.Byte(Columnar.Dictionary | 0x10); // with nulls
            w.Bytes(new byte[] { 0, 0 }); // nulls of 16 rows, none null
            w.VarUInt(size);
            w.Bytes(new byte[] { 1, 0x61, 1, 0x62, 5, 5 }); // entries "a" and "b", then ids
            Assert.Throws<JazminFormatException>(() => Columnar.Decode(w.ToArray(), new[] { JazminType.String }, 16, 0));
        }
    }
}
