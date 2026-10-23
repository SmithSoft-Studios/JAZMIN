using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Writing with Regroup (issue #275): in an access-controlled file a chunk holds one partition, so rows of many
/// partitions in turn make a chunk of nearly every row. With Regroup the writer holds rows per partition (a bounded
/// number) and writes a partition's rows together: stored rows are grouped by partition, each partition's rows in their
/// input order. Mirrors js/test/write-regroup.test.js.
/// </summary>
public sealed class WriteRegroupTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-write-regroup-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminKey Owner = JazminKey.Generate();
    private static readonly JazminAccessKey Durban = Owner.CreateAccessKey();
    private static readonly JazminAccessKey Cape = Owner.CreateAccessKey();
    private static readonly JazminAccessKey Head = Owner.CreateAccessKey();
    private static readonly string[] Cities = ["Durban", "Cape Town", "Johannesburg", "Pretoria", "Bloemfontein", "Gqeberha", "East London", "Polokwane"];

    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("city", JazminType.String) { Nullable = false },
        new("amount", JazminType.Int),
        new("note", JazminType.String),
    ];

    private static JazminAccessOptions Access() => new()
    {
        PartitionBy = "city",
        ColumnGroups = new() { ["private"] = ["note"] },
        Grants =
        [
            new JazminGrant(Durban) { Rows = ["Durban"], Columns = ["*", "private"] },
            new JazminGrant(Cape) { Rows = ["Cape Town"], Columns = ["*"] },
            new JazminGrant(Head) { Columns = ["*", "private"] },
        ],
    };

    private sealed record Row(long Id, string City, long Amount, string Note)
    {
        public IReadOnlyDictionary<string, object?> Values => new Dictionary<string, object?> { ["id"] = Id, ["city"] = City, ["amount"] = Amount, ["note"] = Note };
    }

    /// <summary><paramref name="n"/> rows with the cities in a seeded random order (the same rows as the JS tests).</summary>
    private static List<Row> CityRows(int n, int seed = 1)
    {
        long s = seed;
        long Next() => (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16; // the high bits: the low ones repeat
        return Enumerable.Range(0, n).Select(i => new Row(i, Cities[Next() % Cities.Length], Next() % 100000, $"note {i}")).ToList();
    }

    private string Write(string name, IEnumerable<Row> rows, JazminWriteOptions options)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        foreach (var row in rows) writer.WriteRow(row.Values);
        return path;
    }

    private static JazminWriteOptions Options(bool regroup, int chunkRows = 64) => new() { Key = Owner, Access = Access(), ChunkRows = chunkRows, Regroup = regroup };

    private static List<long> Ids(IEnumerable<JazminRow> rows) => rows.Select(r => (long)r["id"]!).ToList();

    private static List<long> IdsOf(IEnumerable<Row> rows, string? city = null) => rows.Where(r => city is null || r.City == city).Select(r => r.Id).ToList();

    private static int ChunksNeeded(List<Row> rows, int chunkRows) => Cities.Sum(c => (rows.Count(r => r.City == c) + chunkRows - 1) / chunkRows);

    [Fact]
    public void Interleaved_partitions_are_stored_a_partition_at_a_time_each_in_as_few_chunks_as_its_rows_need()
    {
        var rows = CityRows(800);
        var plain = Write("interleaved.jzm", rows, Options(regroup: false));
        var grouped = Write("regrouped.jzm", rows, Options(regroup: true));

        using (var before = JazminReader.Open(plain, new JazminReadOptions { Key = Owner }))
        {
            Assert.Equal(IdsOf(rows), Ids(before.Rows())); // off by default: input order, as before
            Assert.True(before.ChunkCount > 600, $"{before.ChunkCount} chunks");
        }
        using (var after = JazminReader.Open(grouped, new JazminReadOptions { Key = Owner }))
        {
            Assert.Equal(ChunksNeeded(rows, 64), after.ChunkCount);
            var all = after.Rows().ToList();
            Assert.Equal(IdsOf(rows), Ids(all).Order());
            foreach (var city in Cities) Assert.Equal(IdsOf(rows, city), Ids(all.Where(r => (string)r["city"]! == city))); // input order
        }
        Assert.True(new FileInfo(grouped).Length * 4 < new FileInfo(plain).Length, "the regrouped file is much smaller");
    }

    [Fact]
    public void Each_key_sees_exactly_its_partitions_and_column_groups()
    {
        var rows = CityRows(800);
        var path = Write("keys.jzm", rows, Options(regroup: true));

        using (var d = JazminReader.Open(path, new JazminReadOptions { AccessKey = Durban }))
        {
            Assert.Equal(["id", "city", "amount", "note"], d.Columns.Select(c => c.Name));
            var seen = d.Rows().ToList();
            Assert.Equal(IdsOf(rows, "Durban"), Ids(seen));
            Assert.Equal(rows.Where(r => r.City == "Durban").Select(r => r.Note), seen.Select(r => (string)r["note"]!));
        }
        using (var c = JazminReader.Open(path, new JazminReadOptions { AccessKey = Cape }))
        {
            Assert.Equal(["id", "city", "amount"], c.Columns.Select(col => col.Name));
            Assert.Equal(IdsOf(rows, "Cape Town"), Ids(c.Rows()));
        }
        using (var h = JazminReader.Open(path, new JazminReadOptions { AccessKey = Head }))
        {
            Assert.Equal(["id", "city", "amount", "note"], h.Columns.Select(col => col.Name));
            var all = h.Rows().ToList();
            Assert.Equal(IdsOf(rows), Ids(all).Order());
            foreach (var city in Cities) Assert.Equal(IdsOf(rows, city), Ids(all.Where(r => (string)r["city"]! == city)));
        }
        // Lookups by the owner's index find rows by their new row numbers.
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        foreach (var id in new long[] { 0, 399, 799 })
        {
            var found = reader.Find(JazminFilter.Eq("id", id)).ToList();
            Assert.Equal([id], Ids(found));
            Assert.Equal(rows[(int)id].City, found[0]["city"]);
            Assert.Equal(rows[(int)id].Amount, found[0]["amount"]);
        }
        Assert.Equal(IdsOf(rows, "Durban").Count, reader.Count(JazminFilter.Eq("city", "Durban")));
    }

    [Fact]
    public void A_SortedBy_must_start_with_the_partition_column()
    {
        var rows = CityRows(20);
        var options = Options(regroup: true);
        options.SortedBy = ["id"];
        var error = Assert.Throws<JazminValidationException>(() => Write("by-id.jzm", rows, options));
        Assert.Contains("Regroup would break the SortedBy order [id]: it needs no SortedBy, or one that starts with the partition column 'city'", error.Message);
        Assert.False(File.Exists(Path.Combine(_dir, "by-id.jzm"))); // refused before the file is made

        // Sorted by the partition column first: rows already arrive grouped, and are written as given.
        var byCity = rows.OrderBy(r => r.City, StringComparer.Ordinal).ThenBy(r => r.Id).ToList();
        var sorted = Options(regroup: true);
        sorted.SortedBy = ["city", "id"];
        var path = Write("by-city.jzm", byCity, sorted);
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        Assert.Equal(IdsOf(byCity), Ids(reader.Rows()));
    }

    [Fact]
    public void Regroup_needs_an_access_controlled_file_with_PartitionBy()
    {
        var rows = CityRows(5);
        Assert.Contains("Regroup applies to access-controlled files with PartitionBy",
            Assert.Throws<JazminValidationException>(() => Write("plain.jzm", rows, new JazminWriteOptions { Regroup = true })).Message);
        Assert.Contains("Regroup applies to access-controlled files with PartitionBy",
            Assert.Throws<JazminValidationException>(() => Write("no-partitions.jzm", rows, new JazminWriteOptions { Key = Owner, Access = new JazminAccessOptions(), Regroup = true })).Message);
        var path = Write("off.jzm", rows, new JazminWriteOptions { Regroup = false }); // false is the default, and allowed anywhere
        using var reader = JazminReader.Open(path);
        Assert.Equal(IdsOf(rows), Ids(reader.Rows()));
    }

    [Fact]
    public void The_rows_held_stay_within_the_limits_by_rows_and_by_bytes()
    {
        // Rows: at most 100 held.
        var path = Path.Combine(_dir, "rows-limit.jzm");
        var rows = CityRows(3000);
        long most = 0;
        using (var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions { Key = Owner, Access = Access(), Regroup = true, RegroupRows = 100, RegroupBytes = 1_000_000_000 }))
        {
            foreach (var row in rows)
            {
                writer.WriteRow(row.Values);
                most = Math.Max(most, writer.Held.Rows);
                Assert.True(writer.Held.Rows < 100);
            }
            Assert.True(most >= 50, $"held up to {most} rows");
            Assert.Equal(rows.Count, writer.RowCount); // rows given, held ones included
        }
        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner }))
            Assert.Equal(IdsOf(rows), Ids(reader.Rows()).Order());

        // Bytes: wide rows, at most 20,000 estimated bytes held (about 19 rows of 1,000 characters).
        var wide = Path.Combine(_dir, "bytes-limit.jzm");
        using (var writer = JazminWriter.Create(wide, Columns, new JazminWriteOptions { Key = Owner, Access = Access(), Regroup = true, RegroupRows = 1_000_000_000, RegroupBytes = 20000 }))
        {
            foreach (var row in CityRows(500))
            {
                writer.WriteRow((row with { Note = new string('x', 1000) }).Values);
                Assert.True(writer.Held.Bytes < 20000);
                Assert.True(writer.Held.Rows < 20);
            }
        }
        using (var reader = JazminReader.Open(wide, new JazminReadOptions { Key = Owner }))
            Assert.Equal(500, reader.Rows().Count());
    }

    [Fact]
    public void The_default_limits_hold_a_streamed_input_to_at_most_65536_rows()
    {
        // 100 partitions: 100 chunks of 4,096 rows would be more than the limit, so it is reached, and half is written out.
        var path = Path.Combine(_dir, "streamed.jzm");
        long most = 0;
        using (var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions { Key = Owner, Access = Access(), Regroup = true }))
        {
            long s = 7;
            for (var i = 0; i < 150000; i++)
            {
                s = (s * 1103515245 + 12345) & 0x7fffffff;
                writer.WriteRow(new Row(i, $"P{(s >> 16) % 100}", i, $"note {i}").Values);
                most = Math.Max(most, writer.Held.Rows);
            }
        }
        Assert.True(most is < 65536 and > 60000, $"held up to {most} rows");
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        Assert.Equal(150000, reader.RowCount);
        Assert.Equal(Enumerable.Range(0, 150000).Select(i => (long)i), Ids(reader.Rows()).Order());
        Assert.True(reader.ChunkCount < 600, $"{reader.ChunkCount} chunks"); // as given: nearly a chunk a row
    }

    [Fact]
    public async Task WriteRowsAsync_with_an_async_source_and_the_row_numbers_in_errors_are_the_input_order()
    {
        var rows = CityRows(800);
        async IAsyncEnumerable<IReadOnlyDictionary<string, object?>> Source()
        {
            foreach (var row in rows)
            {
                await Task.Yield();
                yield return row.Values;
            }
        }
        var path = Path.Combine(_dir, "async.jzm");
        await using (var writer = JazminWriter.Create(path, Columns, Options(regroup: true)))
        {
            await writer.WriteRowsAsync(Source());
            await writer.FinishAsync();
        }
        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner }))
        {
            Assert.Equal(ChunksNeeded(rows, 64), reader.ChunkCount);
            var all = reader.Rows().ToList();
            foreach (var city in Cities) Assert.Equal(IdsOf(rows, city), Ids(all.Where(r => (string)r["city"]! == city)));
        }

        using (var writer = JazminWriter.Create(Path.Combine(_dir, "bad.jzm"), Columns, Options(regroup: true)))
        {
            for (var i = 0; i < 7; i++) writer.WriteRow(rows[i].Values);
            var bad = new Dictionary<string, object?>(rows[7].Values) { ["colour"] = "red" };
            Assert.Contains("Row 7: unknown column 'colour'", Assert.Throws<JazminValidationException>(() => writer.WriteRow(bad)).Message);
        }
        using (var writer = JazminWriter.Create(Path.Combine(_dir, "null.jzm"), Columns, Options(regroup: true)))
        {
            for (var i = 0; i < 6; i++) writer.WriteRow(rows[i].Values);
            var missing = new Dictionary<string, object?>(rows[6].Values) { ["id"] = null };
            Assert.Contains("Row 6: column 'id' is not nullable", Assert.Throws<JazminValidationException>(() => writer.WriteRow(missing)).Message);
        }
    }

    [Fact]
    public void Tables_with_PartitionBy_are_regrouped_the_others_written_as_given()
    {
        var rows = CityRows(300);
        var totals = Cities.Select(c => (City: c, People: (long)rows.Count(r => r.City == c))).ToList();
        var path = Path.Combine(_dir, "tables.jzm");
        var access = Access();
        using (var writer = JazminWriter.Create(path, new JazminWriteOptions
        {
            Key = Owner, Access = new JazminAccessOptions { Grants = access.Grants }, ChunkRows = 64, Regroup = true,
            Tables =
            [
                new JazminTable("people", Columns) { PartitionBy = "city", ColumnGroups = new() { ["private"] = ["note"] } },
                new JazminTable("totals", [new JazminColumn("city", JazminType.String), new JazminColumn("people", JazminType.Int)]),
            ],
        }))
        {
            foreach (var row in rows) writer.WriteRow(row.Values);
            writer.StartTable("totals");
            foreach (var (city, people) in totals) writer.WriteValues(city, people);
        }
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        Assert.Equal(ChunksNeeded(rows, 64), reader.ChunkCount);
        Assert.Equal(IdsOf(rows), Ids(reader.Rows()).Order());
        using var other = reader.OpenTable("totals");
        Assert.Equal(totals, other.Rows().Select(r => ((string)r["city"]!, (long)r["people"]!)));
    }

    [Fact]
    public void Nested_json_binary_and_large_int_values_are_held_and_written_as_given()
    {
        JazminColumn[] columns =
        [
            new("id", JazminType.Int), new("city", JazminType.String),
            JazminColumn.ListOf("tags", new JazminColumn("item", JazminType.String)), new("extra", JazminType.Json),
            new("blob", JazminType.Binary), new("big", JazminType.Int),
        ];
        var rows = CityRows(400);
        var path = Path.Combine(_dir, "nested.jzm");
        using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions { Key = Owner, Access = new JazminAccessOptions { PartitionBy = "city" }, ChunkRows = 32, Regroup = true }))
        {
            foreach (var r in rows) writer.WriteValues(r.Id, r.City, new[] { r.City, $"t{r.Id % 3}" }, new JsonObject { ["n"] = r.Id }, new byte[] { (byte)(r.Id & 255), 7 }, (1L << 60) + r.Id);
        }
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        var all = reader.Rows().ToList();
        foreach (var city in Cities)
        {
            var mine = all.Where(r => (string)r["city"]! == city).ToList();
            Assert.Equal(IdsOf(rows, city), Ids(mine));
            foreach (var r in mine)
            {
                var id = (long)r["id"]!;
                Assert.Equal(new[] { city, $"t{id % 3}" }, ((JsonArray)r["tags"]!).Select(n => (string)n!));
                Assert.Equal(id, (long)((JsonNode)r["extra"]!)["n"]!);
                Assert.Equal(new byte[] { (byte)(id & 255), 7 }, (byte[])r["blob"]!);
                Assert.Equal((1L << 60) + id, (long)r["big"]!);
            }
        }
    }

    [Fact]
    public void A_row_held_keeps_the_values_given_though_the_caller_reuses_a_buffer_or_list_for_the_next_row()
    {
        JazminColumn[] columns =
        [
            new("id", JazminType.Int), new("city", JazminType.String), new("blob", JazminType.Binary),
            JazminColumn.ListOf("tags", new JazminColumn("item", JazminType.String)), new("extra", JazminType.Json),
        ];
        var rows = CityRows(300);
        var path = Path.Combine(_dir, "reused.jzm");
        var blob = new byte[2];
        var tags = new List<string>();
        var extra = new JsonObject();
        using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions { Key = Owner, Access = new JazminAccessOptions { PartitionBy = "city" }, Regroup = true }))
        {
            foreach (var r in rows)
            {
                blob[0] = (byte)(r.Id & 255);
                blob[1] = 7;
                tags.Clear();
                tags.Add(r.City);
                tags.Add($"t{r.Id}");
                extra["n"] = r.Id;
                writer.WriteValues(r.Id, r.City, blob, tags, extra);
            }
        }
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = Owner });
        var all = reader.Rows().ToList();
        Assert.Equal(rows.Count, all.Count);
        foreach (var r in all)
        {
            var id = (long)r["id"]!;
            Assert.Equal(new byte[] { (byte)(id & 255), 7 }, (byte[])r["blob"]!);
            Assert.Equal(new[] { (string)r["city"]!, $"t{id}" }, ((JsonArray)r["tags"]!).Select(n => (string)n!));
            Assert.Equal(id, (long)((JsonNode)r["extra"]!)["n"]!);
        }
    }
}
