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
