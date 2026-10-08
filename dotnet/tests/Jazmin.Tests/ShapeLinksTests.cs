using System.Globalization;
using System.Text.Json.Nodes;
using Jazmin.Formats;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Export shapes that follow links between tables ($from / $on, docs/design/export-shapes.md section 7): the output is
/// checked against the same nesting done by hand, with every way the links can be fetched (as js/test/shape-links.test.js).
/// </summary>
public class ShapeLinksTests
{
    private sealed record Product(string Sku, string Name, string Price);
    private sealed record Customer(long Id, string Name, string Country);
    private sealed record Order(long Id, long? CustomerId, DateTime Placed, string Total);
    private sealed record Line(long OrderId, long LineNo, string Sku, string Amount, long? CustomerId);

    private static readonly List<Product> Products = Enumerable.Range(0, 12)
        .Select(i => new Product($"P{i:D2}", $"Product {i}", $"{10 + i}.50")).OrderBy(p => p.Sku, StringComparer.Ordinal).ToList();
    private static readonly List<Customer> Customers = Enumerable.Range(0, 30)
        .Select(i => new Customer(i + 1, $"Customer {i + 1}", new[] { "ZA", "NA", "BW" }[i % 3])).ToList();
    private static readonly List<Order> Orders = [];
    private static readonly List<Line> Lines = MakeOrders(); // field initializers run in order, before File is written

    private static List<Line> MakeOrders()
    {
        var lines = new List<Line>();
        for (long id = 1; id <= 200; id++)
        {
            long? customer = id == 7 ? null : 1 + id * 7 % 29; // customer 30 has no orders; order 7 has no customer
            Orders.Add(new Order(id, customer, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(id * 37 % 200), $"{id * 3}.00"));
            for (long n = 1; n <= id % 5; n++) // order 5, 10, ... has no lines
            {
                var sku = id % 11 == 0 && n == 1 ? "GONE" : $"P{(id + n) % 12:D2}"; // a line whose product is missing
                lines.Add(new Line(id, n, sku, $"{n}.25", customer));
            }
        }
        return lines;
    }

    private static readonly JazminColumn[] CustomerColumns =
        [new("id", JazminType.Int) { Nullable = false }, new("name", JazminType.String), new("country", JazminType.String)];
    private static readonly JazminColumn[] ProductColumns =
        [new("sku", JazminType.String) { Nullable = false }, new("name", JazminType.String), new("price", JazminType.Decimal)];
    private static readonly JazminColumn[] OrderColumns =
    [
        new("id", JazminType.Int) { Nullable = false }, new("customer_id", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] },
        new("placed", JazminType.DateTime), new("total", JazminType.Decimal),
    ];
    private static readonly JazminColumn[] LineColumns =
    [
        new("order_id", JazminType.Int) { Nullable = false }, new("line", JazminType.Int) { Nullable = false },
        new("sku", JazminType.String), new("amount", JazminType.Decimal), new("customer_id", JazminType.Int),
    ];

    private static byte[] Write(JazminWriteOptions options, bool products = true)
    {
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, options, leaveOpen: true))
        {
            foreach (var c in Customers) writer.WriteValues(c.Id, c.Name, c.Country);
            if (products)
            {
                writer.StartTable("products");
                foreach (var p in Products) writer.WriteValues(p.Sku, p.Name, p.Price);
            }
            writer.StartTable("orders");
            foreach (var o in Orders) writer.WriteValues(o.Id, o.CustomerId, o.Placed, o.Total);
            writer.StartTable("order_lines");
            foreach (var l in Lines) writer.WriteValues(l.OrderId, l.LineNo, l.Sku, l.Amount, l.CustomerId);
        }
        return stream.ToArray();
    }

    private static readonly byte[] File = Write(new JazminWriteOptions
    {
        Tables =
        [
            new JazminTable("customers", CustomerColumns) { SortedBy = ["id"] },
            new JazminTable("products", ProductColumns) { SortedBy = ["sku"] },
            new JazminTable("orders", OrderColumns) { SortedBy = ["id"], ChunkRows = 16 },
            new JazminTable("order_lines", LineColumns) { SortedBy = ["order_id", "line"], ChunkRows = 32 },
        ],
    });

    private const string Shape = """
        { "$rows": {
            "id": "id", "name": "name",
            "orders": {
              "$from": "orders", "$on": { "customer_id": "id" }, "$sort": ["placed", "id"],
              "$rows": {
                "id": "id", "placed": "placed", "total": "total",
                "lines": { "$from": "order_lines", "$on": { "order_id": "id" },
                  "$rows": { "line": "line", "amount": "amount", "product": { "$from": "products", "$on": { "sku": "sku" }, "$one": { "name": "name", "price": "price" } } } },
                "lineCount": { "$from": "order_lines", "$on": { "order_id": "id" }, "$one": { "$count": true } },
                "lineTotal": { "$from": "order_lines", "$on": { "order_id": "id" }, "$one": { "$sum": "amount" } } } } } }
        """;

    private static decimal Money(string text) => decimal.Parse(text, CultureInfo.InvariantCulture);

    private static JsonNode ExpectedOrder(Order o)
    {
        var lines = Lines.Where(l => l.OrderId == o.Id).ToList();
        return new JsonObject
        {
            ["id"] = o.Id,
            ["placed"] = o.Placed.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
            ["total"] = Money(o.Total),
            ["lines"] = new JsonArray(lines.Select(l =>
            {
                var p = Products.FirstOrDefault(x => x.Sku == l.Sku);
                return (JsonNode)new JsonObject
                {
                    ["line"] = l.LineNo,
                    ["amount"] = Money(l.Amount),
                    ["product"] = p is null ? null : new JsonObject { ["name"] = p.Name, ["price"] = Money(p.Price) },
                };
            }).ToArray()),
            ["lineCount"] = lines.Count > 0 ? lines.Count : null,
            ["lineTotal"] = lines.Count > 0 ? lines.Sum(l => Money(l.Amount)) : null,
        };
    }

    private static JsonNode ExpectedCustomer(Customer c) => new JsonObject
    {
        ["id"] = c.Id,
        ["name"] = c.Name,
        ["orders"] = new JsonArray(Orders.Where(o => o.CustomerId == c.Id).OrderBy(o => o.Placed).ThenBy(o => o.Id).Select(ExpectedOrder).ToArray()),
    };

    private static void AssertSame(JsonNode expected, string actual) =>
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(actual)), actual);

    [Theory]
    [InlineData(null, null)] // by priority
    [InlineData(3, 0)] // tiny batches, every table queried
    [InlineData(1, 0)] // one parent per batch
    [InlineData(null, 1_000_000)] // every table held
    public void CustomersOrdersLinesAndProducts_AsByHand(int? batch, int? tableRows)
    {
        var shape = JazminShape.Parse(Shape);
        shape.LinkBatch = batch;
        shape.LinkTableRows = tableRows;
        using var reader = JazminReader.Open(File);
        AssertSame(new JsonArray(Customers.Select(ExpectedCustomer).ToArray()), shape.ToJson(reader));
        AssertSame(new JsonArray(ExpectedCustomer(Customers[2]), ExpectedCustomer(Customers[29])), shape.ToJson(reader, Query.JazminFilter.In("id", 3L, 30L)));
    }

    [Fact]
    public void TheSameOutput_WithEveryReaderPriority()
    {
        var shape = JazminShape.Parse(Shape);
        using var balanced = JazminReader.Open(File);
        var whole = shape.ToJson(balanced, indented: true);
        foreach (var priority in new[] { JazminPriority.Memory, JazminPriority.Speed })
        {
            using var reader = JazminReader.Open(File, new JazminReadOptions { Priority = priority });
            Assert.Equal(whole, shape.ToJson(reader, indented: true));
        }
    }

    [Fact]
    public void LinksInTheRootObject_FollowTheRootSet()
    {
        var shape = JazminShape.Parse("""
            { "customer": "name", "orders": { "$from": "orders", "$on": { "customer_id": "id" }, "$rows": "id" },
              "spent": { "$from": "orders", "$on": { "customer_id": "id" }, "$one": { "$sum": "total" } } }
            """);
        using var reader = JazminReader.Open(File);
        var theirs = Orders.Where(o => o.CustomerId == 4).ToList();
        AssertSame(new JsonObject
        {
            ["customer"] = "Customer 4",
            ["orders"] = new JsonArray(theirs.Select(o => (JsonNode)o.Id).ToArray()),
            ["spent"] = theirs.Sum(o => Money(o.Total)),
        }, shape.ToJson(reader, Query.JazminFilter.Eq("id", 4L)));
        AssertSame(new JsonObject { ["customer"] = "Customer 30", ["orders"] = new JsonArray(), ["spent"] = null },
            shape.ToJson(reader, Query.JazminFilter.Eq("id", 30L)));
    }

    [Fact]
    public void LinksFromAnotherTable_WithFilterSortLimitAndGroups()
    {
        var shape = JazminShape.Parse("""
            { "$rows": {
                "order": "id",
                "who": { "$from": "customers", "$on": { "id": "customer_id" }, "$one": "name" },
                "big": { "$from": "order_lines", "$on": { "order_id": "id" }, "$filter": { "line": { "gte": 2 } }, "$sort": ["-line"], "$limit": 2, "$rows": "line" },
                "bySku": { "$from": "order_lines", "$on": { "order_id": "id" }, "$groupBy": "sku", "$sort": ["sku"], "$rows": { "sku": "sku", "n": { "$count": true } } } },
              "$filter": { "id": { "lte": 12 } } }
            """);
        var expected = new JsonArray(Orders.Where(o => o.Id <= 12).Select(o =>
        {
            var lines = Lines.Where(l => l.OrderId == o.Id).ToList();
            return (JsonNode)new JsonObject
            {
                ["order"] = o.Id,
                ["who"] = o.CustomerId is { } c ? Customers[(int)c - 1].Name : null,
                ["big"] = new JsonArray(lines.Where(l => l.LineNo >= 2).Select(l => l.LineNo).OrderDescending().Take(2).Select(x => (JsonNode)x).ToArray()),
                ["bySku"] = new JsonArray(lines.Select(l => l.Sku).Distinct().Order(StringComparer.Ordinal)
                    .Select(sku => (JsonNode)new JsonObject { ["sku"] = sku, ["n"] = lines.Count(l => l.Sku == sku) }).ToArray()),
            };
        }).ToArray());
        using var reader = JazminReader.Open(File, new JazminReadOptions { Table = "orders" });
        AssertSame(expected, shape.ToJson(reader));
        shape.LinkBatch = 2;
        shape.LinkTableRows = 0;
        AssertSame(expected, shape.ToJson(reader));
    }

    [Fact]
    public void LinksInsideGroups_OnTwoColumns_AndToTheSameTable()
    {
        using var reader = JazminReader.Open(File);
        var grouped = JazminShape.Parse("""
            { "$rows": { "country": "country", "customers": { "$rows": { "id": "id", "orders": { "$from": "orders", "$on": { "customer_id": "id" }, "$one": { "$count": true } } } } },
              "$groupBy": "country", "$sort": ["country"] }
            """);
        int? CountOf(Customer c) => Orders.Count(o => o.CustomerId == c.Id) is var n && n > 0 ? n : null;
        AssertSame(new JsonArray(new[] { "BW", "NA", "ZA" }.Select(country => (JsonNode)new JsonObject
        {
            ["country"] = country,
            ["customers"] = new JsonArray(Customers.Where(c => c.Country == country)
                .Select(c => (JsonNode)new JsonObject { ["id"] = c.Id, ["orders"] = CountOf(c) }).ToArray()),
        }).ToArray()), grouped.ToJson(reader));

        using var orders = reader.OpenTable("orders");
        var twoColumns = JazminShape.Parse("""
            { "$rows": { "id": "id", "lines": { "$from": "order_lines", "$on": { "order_id": "id", "customer_id": "customer_id" }, "$rows": "line" } }, "$filter": { "id": { "lte": 10 } } }
            """);
        AssertSame(new JsonArray(Orders.Where(o => o.Id <= 10).Select(o => (JsonNode)new JsonObject
        {
            ["id"] = o.Id,
            ["lines"] = new JsonArray((o.CustomerId is null ? [] : Lines.Where(l => l.OrderId == o.Id)).Select(l => (JsonNode)l.LineNo).ToArray()),
        }).ToArray()), twoColumns.ToJson(orders));

        var staff = TestData.Write([new JazminColumn("id", JazminType.Int), new JazminColumn("name", JazminType.String), new JazminColumn("boss", JazminType.Int)],
            [[1L, "Ann", null], [2L, "Bob", 1L], [3L, "Cy", 1L], [4L, "Di", 2L]]);
        var tree = JazminShape.Parse("""
            { "$rows": { "name": "name", "reports": { "$from": "", "$on": { "boss": "id" }, "$rows": { "name": "name", "reports": { "$from": "", "$on": { "boss": "id" }, "$rows": "name" } } } },
              "$filter": { "boss": null } }
            """);
        using var org = JazminReader.Open(staff);
        Assert.Equal("""[{"name":"Ann","reports":[{"name":"Bob","reports":["Di"]},{"name":"Cy","reports":[]}]}]""", tree.ToJson(org));
    }

    [Fact]
    public void Links_CompareDecimalKeysByValue()
    {
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Tables =
            [
                new JazminTable("prices", [new JazminColumn("code", JazminType.String), new JazminColumn("price", JazminType.Decimal)]),
                new JazminTable("bands", [new JazminColumn("price", JazminType.Decimal), new JazminColumn("band", JazminType.String)]),
            ],
        }, leaveOpen: true))
        {
            writer.WriteValues("a", "7.5");
            writer.WriteValues("b", "8.00");
            writer.WriteValues("c", null);
            writer.StartTable("bands");
            writer.WriteValues("7.50", "low");
            writer.WriteValues("8", "mid");
            writer.WriteValues("8.0", "mid too");
        }
        var shape = JazminShape.Parse("""{ "$rows": { "code": "code", "bands": { "$from": "bands", "$on": { "price": "price" }, "$rows": "band" } } }""");
        using var reader = JazminReader.Open(stream.ToArray());
        const string expected = """[{"code":"a","bands":["low"]},{"code":"b","bands":["mid","mid too"]},{"code":"c","bands":[]}]""";
        Assert.Equal(expected, shape.ToJson(reader));
        shape.LinkTableRows = 0;
        Assert.Equal(expected, shape.ToJson(reader));
    }

    [Fact]
    public void LinksSortedLikeTheirParents_AreReadInStep_WithEveryCase()
    {
        // Parents with a null key and repeated keys; linked rows with a null key, rows no parent links (more than a
        // stream skips before it seeks), and a nested link whose parents repeat (asked again: a query of its own).
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Tables =
            [
                new JazminTable("parents", [new JazminColumn("k", JazminType.Int), new JazminColumn("name", JazminType.String)]) { SortedBy = ["k"] },
                new JazminTable("kids", [new JazminColumn("k", JazminType.Int), new JazminColumn("j", JazminType.Int)]) { SortedBy = ["k", "j"], ChunkRows = 256 },
                new JazminTable("grand", [new JazminColumn("k", JazminType.Int), new JazminColumn("j", JazminType.Int), new JazminColumn("v", JazminType.String)]) { SortedBy = ["k", "j"] },
            ],
        }, leaveOpen: true))
        {
            foreach (var (k, name) in new (long?, string)[] { (null, "n"), (1, "a"), (1, "b"), (2, "c"), (4, "d"), (9000, "e") }) writer.WriteValues(k, name);
            writer.StartTable("kids");
            foreach (var (k, j) in new (long?, long)[] { (null, 5), (1, 10), (1, 20), (2, 30), (3, 31) }) writer.WriteValues(k, j);
            for (long k = 5; k < 9000; k++) writer.WriteValues(k, k * 10);
            writer.WriteValues(9000L, 90000L);
            writer.WriteValues(9000L, 90001L);
            writer.StartTable("grand");
            foreach (var (k, j, v) in new (long, long, string)[] { (1, 10, "x10"), (1, 20, "x20"), (2, 30, "x30"), (9000, 90000, "y"), (9000, 90001, "z") }) writer.WriteValues(k, j, v);
        }
        var shape = JazminShape.Parse("""
            { "$rows": { "name": "name",
                "kids": { "$from": "kids", "$on": { "k": "k" }, "$rows": { "j": "j", "g": { "$from": "grand", "$on": { "j": "j", "k": "k" }, "$rows": "v" } } },
                "later": { "$from": "kids", "$on": { "k": "k" }, "$filter": { "j": { "gte": 20 } }, "$one": { "$count": true } } } }
            """);
        string Row(string name, string kids, string later) => $$"""{"name":"{{name}}","kids":[{{kids}}],"later":{{later}}}""";
        var ab = """{"j":10,"g":["x10"]},{"j":20,"g":["x20"]}""";
        var a = Row("a", ab, "1");
        var b = Row("b", ab, "1");
        var e = Row("e", """{"j":90000,"g":["y"]},{"j":90001,"g":["z"]}""", "2");
        var all = $"[{Row("n", "", "null")},{a},{b},{Row("c", """{"j":30,"g":["x30"]}""", "1")},{Row("d", "", "null")},{e}]";
        var some = $"[{a},{b},{e}]";
        using var reader = JazminReader.Open(stream.ToArray());

        shape.LinkTableRows = 0; // every linked table queried, not held
        Assert.Equal(all, shape.ToJson(reader));
        Assert.Equal(3, shape.LinkStreams);
        Assert.Equal(some, shape.ToJson(reader, Query.JazminFilter.In("k", 1L, 9000L)));

        shape.LinkBatch = 2; // the same in batches
        Assert.Equal(all, shape.ToJson(reader));
        Assert.Equal(0, shape.LinkStreams);
        Assert.Equal(some, shape.ToJson(reader, Query.JazminFilter.In("k", 1L, 9000L)));

        shape.LinkBatch = null;
        shape.LinkTableRows = null; // held
        Assert.Equal(all, shape.ToJson(reader));
        Assert.Equal(0, shape.LinkStreams);
    }

    [Theory]
    [InlineData("""{ "$rows": { "o": { "$from": "nope", "$on": { "id": "id" }, "$rows": "id" } } }""", "unknown table 'nope'")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$on": { "customer": "id" }, "$rows": "id" } } }""", "unknown or hidden column 'customer' in table 'orders'")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$on": { "customer_id": "idd" }, "$rows": "id" } } }""", "unknown or hidden column 'idd'")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$on": { "customer_id": "name" }, "$rows": "id" } } }""", "links int column 'customer_id' to string column 'name'")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$on": {}, "$rows": "id" } } }""", "$on needs at least one")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$rows": "id" } } }""", "$on needs at least one")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$on": { "customer_id": "id" }, "$rows": "id", "$one": "id" } } }""", "one of $rows or $one")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$on": { "customer_id": "id" }, "$rows": "nope" } } }""", "unknown or hidden column 'nope' in table 'orders'")]
    [InlineData("""{ "$rows": { "o": { "$from": "orders", "$on": { "customer_id": "id" }, "$one": "id", "$sort": ["id"] } } }""", "unknown option '$sort'")]
    public void LinksAreChecked_BeforeAnyDataIsRead(string shape, string message)
    {
        using var reader = JazminReader.Open(File);
        var e = Assert.Throws<JazminValidationException>(() => JazminShape.Parse(shape).ToJson(reader));
        Assert.Contains(message, e.Message);
    }

    [Fact]
    public void ASharedFile_EachLinkedTableShowsTheKeyOnlyItsPartitionsAndColumns()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var shared = Write(new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { Grants = [new JazminGrant(bob) { Rows = ["3", "*"], Columns = ["*"] }] },
            Tables =
            [
                new JazminTable("customers", CustomerColumns) { PartitionBy = "id", ColumnGroups = new() { ["secret"] = ["country"] } },
                new JazminTable("orders", OrderColumns) { PartitionBy = "customer_id" },
                new JazminTable("order_lines", LineColumns), // one partition, '*': granted
            ],
        }, products: false);
        var shape = JazminShape.Parse("""
            { "$rows": { "id": "id", "orders": { "$from": "orders", "$on": { "customer_id": "id" }, "$rows": { "id": "id", "lines": { "$from": "order_lines", "$on": { "order_id": "id" }, "$rows": "line" } } } } }
            """);
        using var view = JazminReader.Open(shared, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false });
        AssertSame(new JsonArray(new JsonObject
        {
            ["id"] = 3,
            ["orders"] = new JsonArray(Orders.Where(o => o.CustomerId == 3).Select(o => (JsonNode)new JsonObject
            {
                ["id"] = o.Id,
                ["lines"] = new JsonArray(Lines.Where(l => l.OrderId == o.Id).Select(l => (JsonNode)l.LineNo).ToArray()),
            }).ToArray()),
        }), shape.ToJson(view));
        var e = Assert.Throws<JazminValidationException>(() => JazminShape.Parse("""{ "$rows": { "c": "country" } }""").ToJson(view));
        Assert.Contains("unknown or hidden column 'country'", e.Message);
        using var all = JazminReader.Open(shared, new JazminReadOptions { Key = owner });
        Assert.Equal(Customers.Count, JsonNode.Parse(shape.ToJson(all))!.AsArray().Count);
    }

    [Fact]
    public void Links_InXml_AndInTheJsonSchema()
    {
        using var reader = JazminReader.Open(File);
        var shape = JazminShape.Parse("""
            { "$rows": { "id": "id", "orders": { "$from": "orders", "$on": { "customer_id": "id" }, "$rows": { "id": "id", "first": { "$from": "order_lines", "$on": { "order_id": "id" }, "$one": "sku" } }, "$limit": 1, "$xmlItem": "order" } },
              "$filter": { "id": 1 }, "$xmlItem": "customer" }
            """);
        var first = Orders.First(o => o.CustomerId == 1);
        var sku = Lines.FirstOrDefault(l => l.OrderId == first.Id)?.Sku;
        var xml = string.Join("\n",
            new[] { "<?xml version=\"1.0\" encoding=\"utf-8\"?>", "<export>", "  <customer>", "    <id>1</id>", "    <orders>", "      <order>", $"        <id>{first.Id}</id>" }
                .Concat(sku is null ? [] : [$"        <first>{sku}</first>"])
                .Concat(["      </order>", "    </orders>", "  </customer>", "</export>"]));
        Assert.Equal(xml, shape.ToXml(reader).Replace("\r\n", "\n"));

        var schema = JazminShape.Parse(Shape).ToJsonSchema(reader);
        var order = schema["items"]!["properties"]!["orders"]!["items"]!;
        Assert.Equal("array", (string)schema["items"]!["properties"]!["orders"]!["type"]!);
        Assert.Equal("""["object","null"]""", order["properties"]!["lines"]!["items"]!["properties"]!["product"]!["type"]!.ToJsonString());
        Assert.Equal("""["integer","null"]""", order["properties"]!["lineCount"]!["type"]!.ToJsonString());
        Assert.Equal("""["number","null"]""", order["properties"]!["total"]!["type"]!.ToJsonString());
    }
}
