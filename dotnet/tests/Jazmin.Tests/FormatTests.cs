using System.Text.Json.Nodes;
using Jazmin.Formats;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

public class FormatTests
{
    private const string PeopleJson = """
        [{"id":1,"name":"Ann, \"the brave\"","city":"Cape Town","score":1.5,"active":true},
         {"id":2,"name":"Bob\nNewline","city":null,"score":2,"active":false},
         {"id":3,"name":"","city":"Durban","score":null,"active":null}]
        """;

    [Fact]
    public void Json_RoundTrip()
    {
        var json = JazminConvert.ToJson(JazminConvert.FromJson(PeopleJson));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(PeopleJson), JsonNode.Parse(json)), json);
    }

    [Fact]
    public void Json_BigIntegersAndDecimalsExact()
    {
        var bytes = TestData.Write(new[] { new JazminColumn("big", JazminType.Int), new JazminColumn("money", JazminType.Decimal) },
            new[] { new object?[] { 4611686018427387904L, "12345678901234567890.12" } });
        Assert.Equal("""[{"big":4611686018427387904,"money":12345678901234567890.12}]""", JazminConvert.ToJson(bytes));
    }

    [Fact]
    public void Json_NullHandlingFormattingAndFilter()
    {
        var bytes = JazminConvert.FromJson(PeopleJson);
        var ignored = JsonNode.Parse(JazminConvert.ToJson(bytes, new JazminSerializerSettings { NullValueHandling = NullValueHandling.Ignore }))!;
        Assert.False(ignored[1]!.AsObject().ContainsKey("city"));
        Assert.Contains("\n", JazminConvert.ToJson(bytes, new JazminSerializerSettings { Formatting = Formatting.Indented }));
        Assert.Equal(2, JsonNode.Parse(JazminConvert.ToJson(bytes, filter: JazminFilter.Gt("id", 1)))!.AsArray().Count);
    }

    [Fact]
    public void Csv_RoundTrip_NullVersusEmpty()
    {
        var csv = JazminConvert.ToCsv(JazminConvert.FromJson(PeopleJson));
        Assert.StartsWith("id,name,city,score,active\r\n", csv);
        Assert.Contains("\"Ann, \"\"the brave\"\"\"", csv);
        var back = JazminConvert.FromCsv(csv);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(PeopleJson), JsonNode.Parse(JazminConvert.ToJson(back))));
        using var reader = JazminReader.Open(back);
        Assert.Equal(new[] { JazminType.Int, JazminType.String, JazminType.String, JazminType.Float, JazminType.Bool }, reader.Columns.Select(c => c.Type));
    }

    [Fact]
    public void Csv_WithoutInference_KeepsText()
    {
        var data = CsvFormat.Parse("zip,n\n0042,1\n", inferTypes: false);
        Assert.Equal("0042", data.Rows[0][0]);
    }

    [Fact]
    public void Xml_RoundTrip_WithInvalidElementNames()
    {
        var json = """[{"first name":"Ann & <Co>","age":31},{"first name":null,"age":5}]""";
        var xml = JazminConvert.ToXml(JazminConvert.FromJson(json));
        Assert.Contains("<field name=\"first name\">Ann &amp; &lt;Co&gt;</field>", xml);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(json), JsonNode.Parse(JazminConvert.ToJson(JazminConvert.FromXml(xml)))));
    }
}
