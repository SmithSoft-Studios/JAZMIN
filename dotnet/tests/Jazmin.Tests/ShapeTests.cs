using System.Text.Json.Nodes;
using Jazmin.Formats;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Export shapes (docs/design/export-shapes.md), mirroring js/test/shape.test.js.</summary>
public class ShapeTests
{
    private static readonly JazminColumn[] Columns =
    {
        new("client", JazminType.String),
        new("clientName", JazminType.String),
        new("address", JazminType.String),
        new("date", JazminType.DateTime),
        new("amount", JazminType.Float),
        new("fee", JazminType.Decimal),
        new("units", JazminType.Int),
    };

    private static DateTime Day(int d) => new(2025, 3, d, 0, 0, 0, DateTimeKind.Utc);

    private static readonly object?[][] Rows =
    {
        new object?[] { "C1", "ABC Corp", "10 Test Street", Day(4), 250.5, "1.25", 9007199254740991L },
        new object?[] { "C2", "Test", "2 Test Place", Day(2), 20000.0, "0.10", 1L },
        new object?[] { "C1", "ABC Corp", "10 Test Street", Day(1), 1000.0, "2", 1L },
        new object?[] { null, null, null, null, null, null, null },
    };

    private static JazminReader Reader(JazminWriteOptions? options = null)
    {
        var stream = new MemoryStream();
        options ??= new JazminWriteOptions();
        options.Metadata = new JsonObject { ["title"] = "March statements" };
        using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            foreach (var row in Rows) writer.WriteValues(row);
        return JazminReader.Open(stream.ToArray(), new JazminReadOptions { Key = options.Key });
    }

    private const string Statement = """
        {
          "statement": { "$meta": "title" },
          "clients": {
            "$rows": {
              "id": "client", "name": "clientName",
              "balance": { "$sum": "amount" }, "fees": { "$sum": "fee" },
              "transactions": { "$rows": { "date": "date", "amount": "amount" }, "$sort": ["date"], "$xmlItem": "transaction" }
            },
            "$groupBy": "client", "$filter": { "client": { "isNull": false } }, "$xmlItem": "client"
          },
          "largest": { "$rows": { "client": "client", "amount": "amount" }, "$filter": { "amount": { "gt": 10000 } } },
          "total": { "$sum": "amount" }, "count": { "$count": true }, "units": { "$sum": "units" },
          "latest": { "$max": "date" }, "firstName": "clientName", "label": { "$value": "v1" }, "version": 2
        }
        """;

    [Fact]
    public void Shape_NestsGroupsTotalsAndFilters()
    {
        using var reader = Reader();
        var json = JazminShape.Parse(Statement).ToJson(reader);
        Assert.Contains("\"units\":9007199254740993", json); // int sums are exact
        Assert.Contains("\"fees\":0.10", json); // decimal sums keep their scale
        var expected = JsonNode.Parse("""
            {
              "statement": "March statements",
              "clients": [
                { "id": "C1", "name": "ABC Corp", "balance": 1250.5, "fees": 3.25,
                  "transactions": [ { "date": "2025-03-01T00:00:00.000Z", "amount": 1000 }, { "date": "2025-03-04T00:00:00.000Z", "amount": 250.5 } ] },
                { "id": "C2", "name": "Test", "balance": 20000, "fees": 0.10,
                  "transactions": [ { "date": "2025-03-02T00:00:00.000Z", "amount": 20000 } ] }
              ],
              "largest": [ { "client": "C2", "amount": 20000 } ],
              "total": 21250.5, "count": 4, "units": 9007199254740993, "latest": "2025-03-04T00:00:00.000Z",
              "firstName": "ABC Corp", "label": "v1", "version": 2
            }
            """);
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(json)), json);
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(JazminShape.Parse(Statement).ToJson(reader, indented: true))));
    }

    [Fact]
    public void Xml_UsesElementsAndItemNames_AndOmitsNulls()
    {
        using var reader = Reader();
        var shape = JazminShape.Parse("""{ "title": { "$meta": "title" }, "clients": { "$rows": { "id": "client", "fees": { "$sum": "fee" } }, "$groupBy": "client", "$xmlItem": "client", "$limit": 2 }, "nothing": null }""");
        var xml = shape.ToXml(reader);
        Assert.Contains("<export>", xml);
        Assert.Contains("<title>March statements</title>", xml);
        Assert.Contains("<clients>\n    <client>\n      <id>C1</id>\n      <fees>3.25</fees>\n    </client>".Replace("\n", Environment.NewLine), xml);
        Assert.DoesNotContain("nothing", xml);
        Assert.Contains("<field name=\"a b\">C1</field>", JazminShape.Parse("""{ "$rows": { "a b": "client" }, "$limit": 1 }""").ToXml(reader, root: "list"));
    }

    [Fact]
    public void Groups_StreamOnSortedFiles_WithTheSameResultAsUnsortedFiles()
    {
        var columns = new[] { new JazminColumn("k", JazminType.String), new JazminColumn("n", JazminType.Int), new JazminColumn("v", JazminType.Float) };
        object?[] Row(int i) => [i % 7 == 0 ? null : $"K{i % 40}", (long)i, i % 3 == 0 ? null : i / 2.0];
        var rows = Enumerable.Range(0, 3000).Select(Row).ToList();
        byte[] Write(IEnumerable<object?[]> data, JazminWriteOptions options)
        {
            var stream = new MemoryStream();
            using (var writer = new JazminWriter(stream, columns, options, leaveOpen: true))
                foreach (var r in data) writer.WriteValues(r);
            return stream.ToArray();
        }
        const string body = """{ "k": "k", "first": "n", "count": { "$count": true }, "total": { "$sum": "v" }, "low": { "$min": "v" }, "top": { "$rows": "n", "$sort": ["-n"], "$limit": 2 } }""";
        using var unsorted = JazminReader.Open(Write(rows, new JazminWriteOptions { ChunkRows = 100 }));
        var sortedRows = rows.OrderBy(r => (string?)r[0], StringComparer.Ordinal).ThenBy(r => (long)r[1]!).ToList();
        using var sorted = JazminReader.Open(Write(sortedRows, new JazminWriteOptions { ChunkRows = 100, SortedBy = ["k", "n"] }));
        var a = JsonNode.Parse(JazminShape.Parse($$"""{ "$rows": {{body}}, "$groupBy": "k", "$sort": ["k"] }""").ToJson(unsorted))!.AsArray();
        var b = JsonNode.Parse(JazminShape.Parse($$"""{ "$rows": {{body}}, "$groupBy": "k" }""").ToJson(sorted))!.AsArray();
        Assert.True(JsonNode.DeepEquals(a, b));
        Assert.Equal(41, a.Count);
        Assert.Null(a[0]!["k"]); // nulls sort first
        Assert.Equal("[2996,2989]", a[0]!["top"]!.ToJsonString());
        Assert.Equal(3, JsonNode.Parse(JazminShape.Parse("""{ "$rows": "k", "$groupBy": "k", "$limit": 3 }""").ToJson(sorted))!.AsArray().Count);

        // Unsorted files with nested lists collect groups in batches: the result does not depend on the batch size.
        const string nestedBody = """{ "k": "k", "first": "n", "count": { "$count": true }, "all": { "$rows": { "n": "n", "v": "v" }, "$filter": { "v": { "gt": 100 } } } }""";
        var nested = JazminShape.Parse($$"""{ "$rows": {{nestedBody}}, "$groupBy": "k", "$sort": ["k"] }""");
        var whole = nested.ToJson(unsorted);
        nested.BatchRows = 50;
        Assert.Equal(whole, nested.ToJson(unsorted));
        nested.BatchRows = 1;
        Assert.Equal(whole, nested.ToJson(unsorted));
        nested.BatchRows = null; // by the reader's priority
        using var speed = JazminReader.Open(Write(rows, new JazminWriteOptions { ChunkRows = 100 }), new JazminReadOptions { Priority = JazminPriority.Speed });
        Assert.Equal(whole, nested.ToJson(speed));
        Assert.Equal(whole, JazminShape.Parse($$"""{ "$rows": {{nestedBody}}, "$groupBy": "k" }""").ToJson(sorted));
    }

    [Fact]
    public void EmptySets_GiveCountZeroAndNulls()
    {
        using var reader = Reader();
        var shape = JazminShape.Parse("""{ "n": { "$count": true }, "total": { "$sum": "amount" }, "top": { "$max": "amount" }, "name": "clientName", "list": { "$rows": "client" } }""");
        Assert.Equal("""{"n":0,"total":null,"top":null,"name":null,"list":[]}""", shape.ToJson(reader, JazminFilter.Gt("amount", 1e9)));
        Assert.Equal("""{"n":1,"total":20000,"top":20000,"name":"Test","list":["C2"]}""", shape.ToJson(reader, JazminFilter.Eq("client", "C2")));
        Assert.Equal("""[{"c":null,"n":[null]},{"c":"C1","n":[9007199254740991,1]},{"c":"C2","n":[1]}]""",
            JazminShape.Parse("""{ "$rows": { "c": "client", "n": { "$rows": "units" } }, "$groupBy": "client", "$sort": ["client"] }""").ToJson(reader));
    }

    [Theory]
    [InlineData("""{ "a": "nope" }""", "Shape at a: unknown or hidden column 'nope'")]
    [InlineData("""{ "a": { "$rows": { "b": { "$rows": "client" } } } }""", "Shape at a[].b: a list inside a row list needs $groupBy on the outer list")]
    [InlineData("""{ "a": { "$rows": { "s": { "$sum": "amount" } } } }""", "Shape at a[].s: aggregates need a set of rows (use $groupBy on the list)")]
    [InlineData("""{ "a": { "$sum": "client" } }""", "Shape at a.$sum: $sum is not supported on string column 'client'")]
    [InlineData("""{ "a": ["client"] }""", "Shape at a: arrays are not templates; use { \"$rows\": ... } for a list")]
    [InlineData("""{ "a": { "$rows": "client", "$limit": -1 } }""", "Shape at a.$limit: must be a non-negative integer")]
    [InlineData("""{ "a": { "$rows": "client", "$other": 1 } }""", "Shape at a: unknown list option '$other'")]
    [InlineData("""{ "a": { "$count": true, "b": 1 } }""", "Shape at a: '$' members cannot be mixed with other members ($count, b)")]
    [InlineData("""{ "a": { "$avg": "amount" } }""", "Shape at a: unknown operator '$avg'")]
    public void Shapes_AreValidatedBeforeAnyDataIsRead(string shape, string message)
    {
        using var reader = Reader();
        var error = Assert.Throws<JazminValidationException>(() => JazminShape.Parse(shape).Validate(reader));
        Assert.Equal(message, error.Message);
        Assert.Contains("unknown column 'zz'", Assert.Throws<JazminValidationException>(() =>
            JazminShape.Parse("""{ "a": { "$rows": "client", "$filter": { "zz": 1 } } }""").Validate(reader)).Message);
    }

    [Fact]
    public void AnAccessKey_CannotExportColumnsItCannotSee()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions
            {
                PartitionBy = "client",
                ColumnGroups = new() { ["money"] = ["amount", "fee"] },
                Grants = [new JazminGrant(bob) { Rows = ["C1"], Columns = ["*"] }], // '*': the default group, not 'money'
            },
        }, leaveOpen: true))
            foreach (var row in Rows) writer.WriteValues(row);
        using var asBob = JazminReader.Open(stream.ToArray(), new JazminReadOptions { AccessKey = bob });
        Assert.Equal("""{"n":2,"names":["ABC Corp","ABC Corp"]}""", JazminShape.Parse("""{ "n": { "$count": true }, "names": { "$rows": "clientName" } }""").ToJson(asBob));
        Assert.Contains("unknown or hidden column 'amount'", Assert.Throws<JazminValidationException>(() => JazminShape.Parse("""{ "t": { "$sum": "amount" } }""").ToJson(asBob)).Message);
    }

    [Fact]
    public void JsonSchema_DescribesTheOutput()
    {
        using var reader = Reader();
        var schema = JazminShape.Parse(Statement).ToJsonSchema(reader);
        Assert.Equal("https://json-schema.org/draft/2020-12/schema", (string?)schema["$schema"]);
        Assert.Equal(false, (bool?)schema["additionalProperties"]);
        var client = schema["properties"]!["clients"]!["items"]!;
        Assert.Equal("""{"type":["string","null"]}""", client["properties"]!["id"]!.ToJsonString());
        Assert.Equal("""{"type":["string","null"],"format":"date-time"}""", client["properties"]!["transactions"]!["items"]!["properties"]!["date"]!.ToJsonString());
        Assert.Equal("""{"type":"integer","minimum":0}""", schema["properties"]!["count"]!.ToJsonString());
        Assert.Equal("""{"const":"v1"}""", schema["properties"]!["label"]!.ToJsonString());
    }
}
