using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Filters on nested columns (spec 9.2): `any` and `all` on a list's items, `match` on an object's fields, to any depth.
/// Conditions in one `any` apply to the same item; a null list or object matches nothing; an empty list has no item
/// that matches `any`, and matches `all`. Rows are those the same condition in C# selects, whether checked on a chunk's
/// typed values or on rows (an access-controlled file).
/// </summary>
public sealed class NestedFilterTests
{
    public sealed class Geo
    {
        public double Lat { get; set; }
        public double Lng { get; set; }
    }

    public sealed class Address
    {
        public string? City { get; set; }
        public string? Zip { get; set; }
        public Geo? Geo { get; set; }
    }

    public sealed class Line
    {
        public string? Sku { get; set; }
        public int? Qty { get; set; }
        public decimal Price { get; set; }
        public List<string>? Tags { get; set; }
    }

    public sealed class Order
    {
        public int Id { get; set; }
        public string Tier { get; set; } = "";
        public List<Line?>? Lines { get; set; }
        public Address? Ship { get; set; }
        public List<List<int?>?>? Grid { get; set; }
        public List<string?>? Labels { get; set; }
    }

    private static readonly List<Order> Orders = Enumerable.Range(0, 200).Select(i => new Order
    {
        Id = i,
        Tier = i % 4 == 0 ? "Gold" : "Silver",
        Lines = i % 9 == 0 ? null : i % 7 == 0 ? [] : [.. Enumerable.Range(0, 1 + i % 3).Select(n => n == 2 && i % 2 == 0 ? null : new Line
        {
            Sku = n == 1 && i % 5 == 0 ? null : $"S{(i + n) % 4}", Qty = i % 6 == 0 ? null : 1 + (i + n) % 5, Price = 10m * ((i + n) % 8),
            Tags = n == 0 ? null : [(i + n) % 3 == 0 ? "red" : "blue", $"t{n}"],
        })],
        Ship = i % 5 == 0 ? null : new Address { City = i % 3 == 0 ? "Durban" : i % 3 == 1 ? null : "Gqeberha", Zip = i % 2 == 0 ? null : $"{4000 + i}", Geo = i % 4 == 1 ? null : new Geo { Lat = -29 + i / 50.0, Lng = 31 } },
        Grid = i % 8 == 0 ? null : [[], [i % 10, null], null],
        Labels = i % 6 == 0 ? null : ["alpha", null, $"x{i % 4}"],
    }).ToList();

    private static readonly JazminSerializerSettings Nested = new() { NestedColumns = true, ChunkRows = 32 };
    private static readonly byte[] File = JazminConvert.SerializeObject(Orders, Nested);

    private static readonly (string Filter, Func<Order, bool> Expected)[] Cases =
    [
        ("""{ "Lines": { "any": { "Sku": "S1", "Qty": { "gt": 2 } } } }""", o => o.Lines?.Any(l => l is not null && l.Sku == "S1" && l.Qty > 2) == true),
        ("""{ "Lines": { "all": { "Qty": { "gte": 2 } } } }""", o => o.Lines?.All(l => l is not null && l.Qty >= 2) == true),
        ("""{ "Lines": { "all": { "Qty": 99 } } }""", o => o.Lines?.All(l => l is not null && l.Qty == 99) == true), // empty lists match
        ("""{ "Lines": { "any": { "Qty": null } } }""", o => o.Lines?.Any(l => l is not null && l.Qty is null) == true),
        ("""{ "Lines": { "any": { "Price": { "gte": 50 } } }, "Tier": "Gold" }""", o => o.Tier == "Gold" && o.Lines?.Any(l => l is not null && l.Price >= 50) == true),
        ("""{ "Lines": { "any": { "Tags": { "any": "red" } } } }""", o => o.Lines?.Any(l => l?.Tags?.Any(t => t == "red") == true) == true),
        ("""{ "Labels": { "any": { "startsWith": "x" } } }""", o => o.Labels?.Any(x => x is not null && x.StartsWith('x')) == true),
        ("""{ "Labels": { "any": null } }""", o => o.Labels?.Any(x => x is null) == true),
        ("""{ "Ship": { "match": { "City": "Durban", "Geo": { "match": { "Lat": { "lt": -28 } } } } } }""", o => o.Ship is { City: "Durban", Geo.Lat: < -28 }),
        ("""{ "Ship": { "match": { "Zip": null, "Geo": { "isNull": false } } } }""", o => o.Ship is { Zip: null, Geo: not null }),
        ("""{ "Ship": { "match": { "Geo": null } } }""", o => o.Ship is { Geo: null }),
        ("""{ "Grid": { "any": { "any": { "gt": 5 } } } }""", o => o.Grid?.Any(r => r?.Any(v => v > 5) == true) == true),
        ("""{ "or": [ { "Lines": { "any": { "Price": { "gt": 60 } } } }, { "Ship": { "isNull": true } } ] }""", o => o.Lines?.Any(l => l?.Price > 60) == true || o.Ship is null),
        ("""{ "not": { "Lines": { "any": { "Sku": "S1" } } } }""", o => !(o.Lines?.Any(l => l?.Sku == "S1") == true)),
        ("""{ "Lines": { "any": { "or": [ { "Sku": "S0" }, { "not": { "Qty": { "lt": 4 } } } ] } } }""", o => o.Lines?.Any(l => l is not null && (l.Sku == "S0" || !(l.Qty < 4))) == true),
    ];

    private static void Check(JazminReader reader)
    {
        foreach (var (filter, expected) in Cases)
        {
            var want = Orders.Where(expected).Select(o => o.Id).ToList();
            Assert.True(want.Count > 0 && want.Count < Orders.Count, $"{filter}: {want.Count} rows (the case should select some)");
            Assert.Equal(want, reader.Find(JazminFilter.Parse(filter)).Select(r => (int)(long)r["Id"]!).ToList());
            // Columns the filter checks but the rows do not return are decoded with only the fields it reads.
            Assert.Equal(want, reader.Find(JazminFilter.Parse(filter), new JazminQueryOptions { Select = ["Id"] }).Select(r => (int)(long)r["Id"]!).ToList());
            Assert.Equal(want.Count, reader.Count(JazminFilter.Parse(filter)));
        }
    }

    [Fact]
    public void FiltersOnNestedColumns_SelectTheRowsTheSameConditionsInCSharpSelect()
    {
        using var reader = JazminReader.Open(File);
        Check(reader);
        // The same through the API, with the item itself named for lists of other items.
        Assert.Equal(Orders.Where(Cases[0].Expected).Select(o => (long)o.Id),
            reader.Find(JazminFilter.Any("Lines", JazminFilter.Eq("Sku", "S1") & JazminFilter.Gt("Qty", 2L))).Select(r => (long)r["Id"]!));
        Assert.Equal(Orders.Where(o => o.Labels?.Any(x => x == "alpha") == true).Select(o => (long)o.Id),
            reader.Find(JazminFilter.Any("Labels", JazminFilter.Eq(JazminFilter.Itself, "alpha"))).Select(r => (long)r["Id"]!));
        Assert.Equal(Orders.Where(o => o.Ship?.City == "Gqeberha").Select(o => (long)o.Id),
            reader.Find(JazminFilter.Match("Ship", JazminFilter.Eq("City", "Gqeberha"))).Select(r => (long)r["Id"]!));
    }

    [Fact]
    public void AnAccessControlledFile_ChecksTheSameFilters_OnItsRows()
    {
        var owner = JazminKey.Generate();
        var map = TypeMap.For(typeof(Order), Nested);
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, map.Columns, new JazminWriteOptions
        {
            Key = owner, ChunkRows = 32, Access = new JazminAccessOptions { PartitionBy = "Tier" },
        }, leaveOpen: true))
            foreach (var o in Orders) writer.WriteValues(map.ToValues(o, Nested));
        using var reader = JazminReader.Open(stream.ToArray(), new JazminReadOptions { Key = owner });
        foreach (var (filter, expected) in Cases) // rows come partition by partition: compared as sets
            Assert.Equal(Orders.Where(expected).Select(o => o.Id).Order(), reader.Find(JazminFilter.Parse(filter)).Select(r => (int)(long)r["Id"]!).Order());
    }

    [Fact]
    public void JsonNumbersCompareExactly_AndNullMeansIsNull_ForEveryType()
    {
        // Whole numbers stay integers (as doubles, 2^53 + 1 would be 2^53); numbers compare with decimals; null is isNull.
        JazminColumn[] columns = [new("id", JazminType.Int), new("amount", JazminType.Decimal), new("extra", JazminType.Json)];
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, columns, new JazminWriteOptions(), leaveOpen: true))
        {
            writer.WriteValues([9007199254740992L, "12.50", null]);
            writer.WriteValues([9007199254740993L, "50", System.Text.Json.Nodes.JsonNode.Parse("[1]")]);
        }
        using var reader = JazminReader.Open(stream.ToArray());
        long[] Ids(string filter) => [.. reader.Find(JazminFilter.Parse(filter)).Select(r => (long)r["id"]!)];
        Assert.Equal([9007199254740993L], Ids("""{ "id": 9007199254740993 }"""));
        Assert.Equal([9007199254740993L], Ids("""{ "amount": { "gte": 50 } }"""));
        Assert.Equal([9007199254740992L], Ids("""{ "amount": 12.5 }"""));
        Assert.Equal([9007199254740992L], Ids("""{ "extra": null }"""));
        Assert.Equal([9007199254740993L], Ids("""{ "extra": { "ne": null } }"""));
    }

    private static string Describe(JazminFilter f) => f switch
    {
        JazminFilter.Condition { Value: JazminFilter inner } c => $"{(c.Column == "" ? "$" : c.Column)} {c.Op} ({Describe(inner)})",
        JazminFilter.Condition c => $"{(c.Column == "" ? "$" : c.Column)} {c.Op} {c.Value}",
        JazminFilter.Group g => $"{g.Kind}[{string.Join(", ", g.Items.Select(Describe))}]",
        JazminFilter.Negation n => $"not({Describe(n.Item)})",
        _ => "?",
    };

    [Fact]
    public void LinqConditionsOnNestedColumns_BecomeTheirFilters_AndGiveWhatLinqToObjectsGives()
    {
        using var reader = JazminReader.Open(File);
        var city = "Durban";
        // The C# condition; the filter the reader checks while decoding (null: not shown); whether it is all of the condition.
        (System.Linq.Expressions.Expression<Func<Order, bool>> Query, string? Pushed, bool Exact)[] cases =
        [
            (o => o.Lines != null && o.Lines.Any(l => l != null && l.Sku == "S1" && l.Qty > 2), "and[Lines isNull False, Lines any (and[Sku eq S1, Qty gt 2])]", true),
            (o => o.Lines != null && o.Lines.All(l => l != null && l.Qty >= 2), "and[Lines isNull False, Lines all (Qty gte 2)]", true),
            (o => o.Ship != null && o.Ship.City == city, "and[Ship isNull False, Ship match (City eq Durban)]", true),
            (o => o.Ship != null && o.Ship.Geo != null && o.Ship.Geo.Lat < -28, "and[and[Ship isNull False, Ship match (Geo isNull False)], Ship match (Geo match (Lat lt -28))]", true),
            (o => o.Labels != null && o.Labels.Contains("alpha") && o.Tier == "Gold", "and[and[Labels isNull False, Labels any ($ eq alpha)], Tier eq Gold]", true),
            (o => o.Labels != null && o.Labels.Any(x => x == null), "and[Labels isNull False, Labels any ($ isNull True)]", true),
            (o => o.Labels != null && o.Labels.Any(x => x != null && x.StartsWith("x", StringComparison.Ordinal)), null, true),
            (o => o.Grid != null && o.Grid.Any(r => r != null && r.Any(v => v > 5)), "and[Grid isNull False, Grid any (and[$ isNull False, $ any ($ gt 5)])]", true),
            (o => o.Lines != null && o.Lines.Any(l => l != null && l.Tags != null && l.Tags.Contains("red")), null, true),
            (o => o.Lines != null && !o.Lines.Any(l => l != null && l.Sku == "S1"), "and[Lines isNull False, not(Lines any (Sku eq S1))]", true),
            (o => o.Ship != null && o.Ship.City == "Gqeberha" || o.Tier == "Gold", null, true),
            // Decimals compare in memory: the rest still narrows the rows, and every row read is checked.
            (o => o.Lines != null && o.Lines.Any(l => l != null && l.Sku == "S1" && l.Price > 10), "and[Lines isNull False, Lines any (Sku eq S1)]", false),
            (o => o.Lines != null && o.Lines.Any(l => l != null && l.Price >= 50), "Lines isNull False", false),
            (o => o.Lines != null && o.Lines.All(l => l == null || l.Qty > 1), "Lines isNull False", false),
        ];
        // Reading needs no settings: the file says which columns are nested. With them, the same.
        foreach (var settings in new[] { null, Nested })
        {
            var q = reader.AsQueryable<Order>(settings);
            foreach (var (query, pushed, exact) in cases)
            {
                var want = Orders.Where(query.Compile()).Select(o => o.Id).ToList();
                Assert.True(want.Count > 0 && want.Count < Orders.Count, $"{query}: {want.Count} rows (the case should select some)");
                var translation = reader.Translate(query, TypeMap.For(typeof(Order), settings));
                Assert.True(exact == translation.Exact, $"{query}: exact should be {exact}");
                if (pushed is not null) Assert.Equal(pushed, Describe(translation.Filter!));
                Assert.Equal(want, q.Where(query).Select(o => o.Id).ToList());
                Assert.Equal(want, reader.Query(query, settings).Select(o => o.Id).ToList());
                Assert.Equal(want.Count, q.Count(query));
            }
        }
    }

    [Fact]
    public void ANestedColumnTheFilterChecks_IsDecodedWithTheFieldsTheFilterReads_AndThoseTheQueryReads()
    {
        // The query reads only Qty from Lines; the filter checks Sku as the chunk is decoded, so Sku is decoded too.
        using var reader = JazminReader.Open(File);
        var want = Orders.Where(o => o.Lines != null && o.Lines.Any(l => l != null && l.Sku == "S2"))
            .Select(o => new { o.Id, Qtys = o.Lines!.Select(l => l == null ? null : l.Qty).ToList() }).ToList();
        var got = reader.AsQueryable<Order>().Where(o => o.Lines != null && o.Lines.Any(l => l != null && l.Sku == "S2"))
            .Select(o => new { o.Id, Qtys = o.Lines!.Select(l => l == null ? null : l.Qty).ToList() }).ToList();
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(want), System.Text.Json.JsonSerializer.Serialize(got));
    }

    [Fact]
    public void StatisticsOfNestedFields_SkipChunksNoItemCanMatch_AndNeverChangeResults()
    {
        // Values that grow with the id, so each chunk of 32 orders holds its own range of them (10 chunks).
        var orders = Enumerable.Range(0, 320).Select(i => new Order
        {
            Id = i, Tier = "Gold",
            Lines = [new Line { Sku = $"S{i:D4}", Qty = i, Price = 1m }, new Line { Sku = $"T{i:D4}", Qty = i + 1, Price = 2m, Tags = ["x"] }],
            Ship = new Address { City = $"C{i / 32}", Geo = new Geo { Lat = i } },
            Grid = [[i]], Labels = [$"L{i:D4}"],
        }).ToList();
        using var reader = JazminReader.Open(JazminConvert.SerializeObject(orders, Nested));
        Assert.Equal(10, reader.ChunkCount);
        void Skips(string filter, int skipped, Func<Order, bool> expected)
        {
            Assert.Equal(skipped, reader.Explain(JazminFilter.Parse(filter)).ChunksSkipped);
            Assert.Equal(orders.Where(expected).Select(o => o.Id), reader.Find(JazminFilter.Parse(filter)).Select(r => (int)(long)r["Id"]!));
            Assert.Equal(orders.Count(expected), reader.Count(JazminFilter.Parse(filter)));
        }
        Skips("""{ "Lines": { "any": { "Qty": 100 } } }""", 9, o => o.Lines!.Any(l => l!.Qty == 100));
        Skips("""{ "Lines": { "any": { "Qty": { "gt": 300 }, "Sku": { "lt": "T" } } } }""", 9, o => o.Lines!.Any(l => l!.Qty > 300 && string.CompareOrdinal(l.Sku, "T") < 0));
        Skips("""{ "Lines": { "any": { "Price": null } } }""", 10, _ => false); // no line has a null price: every chunk skipped
        Skips("""{ "Ship": { "match": { "City": "C5" } } }""", 9, o => o.Ship!.City == "C5");
        Skips("""{ "Ship": { "match": { "Geo": { "match": { "Lat": { "lt": 10 } } } } } }""", 9, o => o.Ship!.Geo!.Lat < 10);
        Skips("""{ "Labels": { "any": "L0042" } }""", 9, o => o.Labels!.Contains("L0042"));
        Skips("""{ "Grid": { "any": { "any": { "gte": 316 } } } }""", 9, o => o.Grid!.Any(r => r!.Any(v => v >= 316)));
        Skips("""{ "or": [ { "Lines": { "any": { "Qty": 5 } } }, { "Ship": { "match": { "City": "C9" } } } ] }""", 8, o => o.Lines!.Any(l => l!.Qty == 5) || o.Ship!.City == "C9");
        // `all` passes empty lists, and `not` the opposite of what statistics bound: neither skips a chunk.
        Skips("""{ "Lines": { "all": { "Qty": { "gte": 300 } } } }""", 0, o => o.Lines!.All(l => l!.Qty >= 300));
        Skips("""{ "not": { "Lines": { "any": { "Qty": 5 } } } }""", 0, o => !o.Lines!.Any(l => l!.Qty == 5));
        // LINQ conditions become the same filters.
        Assert.Equal([99, 100], reader.AsQueryable<Order>().Where(o => o.Lines!.Any(l => l != null && l.Qty == 100)).Select(o => o.Id).ToList());
        // A chunk whose lists are all null matches no any, all or match on them.
        var someNull = orders.Select(o => new Order { Id = o.Id, Tier = o.Tier, Lines = o.Id < 32 ? null : o.Lines }).ToList();
        using var nulls = JazminReader.Open(JazminConvert.SerializeObject(someNull, Nested));
        Assert.Equal(1, nulls.Explain(JazminFilter.Parse("""{ "Lines": { "all": { "Qty": { "gte": 0 } } } }""")).ChunksSkipped);
        Assert.Equal(288, nulls.Count(JazminFilter.Parse("""{ "Lines": { "all": { "Qty": { "gte": 0 } } } }""")));
    }

    [Fact]
    public void StatisticsOfNestedFields_ThatDoNotFitTheColumn_AreRefused()
    {
        // The statistics section of Lines, rewritten in place (same length) with one value changed.
        var map = TypeMap.For(typeof(Order), Nested);
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, map.Columns, new JazminWriteOptions { ChunkRows = 32, Codec = JazminCodec.None }, leaveOpen: true))
            foreach (var o in Orders.Take(64)) writer.WriteValues(map.ToValues(o, Nested));
        var original = stream.ToArray();
        var filter = JazminFilter.Parse("""{ "Lines": { "any": { "Qty": 3 } } }""");
        byte[] Changed(Action<Format.LeafStatsEntry[]> change)
        {
            var buf = (byte[])original.Clone();
            foreach (var (at, length) in Fuzzing.Sections(buf))
            {
                List<Format.ColumnStatsEntry> stats;
                try
                {
                    stats = Format.Catalog.DecodeStatistics(buf[(at + 16)..(at + 16 + length)]);
                }
                catch (Exception)
                {
                    continue;
                }
                if (stats.Count == 0 || stats[0].Leaves.Length == 0) continue;
                change(stats[0].Leaves);
                var output = Format.Catalog.EncodeStatistics(stats);
                Assert.Equal(length, output.Length); // the change keeps every varint's size
                output.CopyTo(buf, at + 16);
                System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(at + 12), Format.Crc32.Compute(output));
                return buf;
            }
            throw new InvalidOperationException("no statistics of nested fields found");
        }
        void Refused(Action<Format.LeafStatsEntry[]> change, string message)
        {
            using var reader = JazminReader.Open(Changed(change));
            Assert.Contains(message, Assert.Throws<JazminFormatException>(() => reader.Count(filter)).Message);
        }
        Refused(l => l[0] = l[0] with { Path = [99] }, "Statistics name a field that does not exist");
        Refused(l => l[1] = l[1] with { Path = l[0].Path }, "Statistics name a field twice");
        Refused(l => l[0].NullCounts[0] = l[0].Counts[0] + 1, "Statistics count more nulls than values");
        using var unchanged = JazminReader.Open(Changed(_ => { }));
        Assert.Equal(Orders.Take(64).Count(o => o.Lines?.Any(l => l?.Qty == 3) == true), unchanged.Count(filter));
    }

    [Fact]
    public void FiltersThatDoNotFitTheColumns_AreRefused()
    {
        using var reader = JazminReader.Open(File);
        void Refused(string filter, string message) =>
            Assert.Contains(message, Assert.Throws<JazminValidationException>(() => reader.Find(JazminFilter.Parse(filter)).ToList()).Message);
        Refused("""{ "Ship": { "any": { "City": "x" } } }""", "'any' only applies to list columns, and 'Ship' is a object");
        Refused("""{ "Lines": { "match": { "Sku": "x" } } }""", "'match' only applies to object columns");
        Refused("""{ "Lines": { "any": { "Colour": "x" } } }""", "unknown column 'Colour'");
        Refused("""{ "Lines": { "eq": 1 } }""", "'eq' is not supported on list column 'Lines'");
        Refused("""{ "Labels": { "any": { "gt": 5, "Sku": "x" } } }""", "unknown operator 'Sku'");
    }
}
