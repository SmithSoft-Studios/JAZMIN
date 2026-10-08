using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Json columns are kept as stored (UTF-8): typed members are deserialized straight from it, and a JsonNode is made only
/// when one is asked for. Every read path gives the objects that were written; errors are those of before.
/// </summary>
public sealed class JsonColumnTests
{
    public sealed record Line(string Sku, int Quantity, decimal Price);

    public sealed class Address
    {
        public string Street { get; set; } = "";
        public string? City { get; set; }
    }

    public sealed class Order
    {
        public int Id { get; set; }
        public List<Line> Lines { get; set; } = [];
        public Address? Address { get; set; }
        public Dictionary<string, int> Counts { get; set; } = [];
        public JsonElement Extra { get; set; }
        public JsonNode? Raw { get; set; }
        public object? Anything { get; set; }
        public string Tier { get; set; } = "";
    }

    private static readonly List<Order> Orders = Enumerable.Range(0, 120).Select(i => new Order
    {
        Id = i,
        Lines = [.. Enumerable.Range(0, i % 4).Select(n => new Line($"S{i}-{n}", n + 1, 9.5m + n))],
        Address = i % 5 == 0 ? null : new Address { Street = $"{i} Main Road", City = i % 2 == 0 ? "Durban" : null },
        Counts = new() { ["a"] = i, ["b"] = i * 2 },
        Extra = JsonDocument.Parse($$"""{"n":{{i}},"tags":["x","y"]}""").RootElement.Clone(),
        Raw = new JsonObject { ["i"] = i, ["text"] = "ünïcødé €" },
        Anything = new JsonArray(i, "two"),
        Tier = i % 3 == 0 ? "Gold" : "Silver",
    }).ToList();

    private static string Text(Order o) => JsonSerializer.Serialize(o);

    private static void Same(IEnumerable<Order> actual, IEnumerable<Order>? expected = null) =>
        Assert.Equal((expected ?? Orders).Select(Text), actual.Select(Text));

    [Fact]
    public void TypedMembers_AreReadAsWritten_ByEveryReadPath()
    {
        var file = JazminConvert.SerializeObject(Orders, new JazminSerializerSettings { ChunkRows = 32 });
        Same(JazminConvert.DeserializeObject<List<Order>>(file)!);
        using var reader = JazminReader.Open(file);
        Same(reader.Rows<Order>());
        Same(reader.Query<Order>(o => o.Id % 7 == 0), Orders.Where(o => o.Id % 7 == 0));
        Same(reader.AsQueryable<Order>().Where(o => o.Id > 30).Skip(5).Take(20), Orders.Where(o => o.Id > 30).Skip(5).Take(20));
        Assert.Equal(Orders.SelectMany(o => o.Lines).Sum(l => l.Quantity * l.Price), reader.AsQueryable<Order>().SelectMany(o => o.Lines).Sum(l => l.Quantity * l.Price));
    }

    [Fact]
    public void AnAccessControlledFile_ReadsRowByRow_WithTheSameObjects()
    {
        var owner = JazminKey.Generate();
        var gold = owner.CreateAccessKey();
        var map = TypeMap.For(typeof(Order));
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, map.Columns, new JazminWriteOptions
        {
            Key = owner,
            ChunkRows = 32,
            Access = new JazminAccessOptions { PartitionBy = "Tier", Grants = [new JazminGrant(gold) { Rows = ["Gold"] }] },
        }, leaveOpen: true))
            foreach (var order in Orders) writer.WriteValues(map.ToValues(order, null));
        using var reader = JazminReader.Open(stream.ToArray(), new JazminReadOptions { AccessKey = gold, CheckClockRollback = false });
        Same(reader.Rows<Order>(), Orders.Where(o => o.Tier == "Gold"));
    }

    [Fact]
    public void UntypedRows_GiveTheSameJsonNode_EachTime()
    {
        using var reader = JazminReader.Open(JazminConvert.SerializeObject(Orders));
        var row = reader.Find(Query.JazminFilter.Eq("Id", 7L)).Single();
        var lines = Assert.IsAssignableFrom<JsonNode>(row["Lines"]);
        Assert.Same(lines, row["Lines"]);
        Assert.Equal(JsonSerializer.Serialize(Orders[7].Lines), lines.ToJsonString());
        Assert.Equal("ünïcødé €", (string)((JsonNode)row["Raw"]!)["text"]!);
        Assert.Null(reader.Find(Query.JazminFilter.Eq("Id", 5L)).Single()["Address"]); // stored as null
    }

    [Fact]
    public void Errors_AreThoseOfBefore()
    {
        // Valid JSON that does not fit the member: a conversion error. JSON that is not valid: a damaged file.
        Assert.Contains("Cannot convert a json value to Int32",
            Assert.Throws<JazminValidationException>(() => TypeMap.DeserializeRaw("{\"a\":1}"u8.ToArray(), typeof(int), null)).Message);
        Assert.Throws<JazminFormatException>(() => TypeMap.DeserializeRaw("{\"a\":"u8.ToArray(), typeof(Dictionary<string, int>), null));
        Assert.Throws<JazminFormatException>(() => TypeMap.DeserializeRaw("null"u8.ToArray(), typeof(Address), null));
        Assert.Throws<JazminFormatException>(() => Format.Values.ParseJson("[1,"u8.ToArray(), "A json value"));
    }
}
