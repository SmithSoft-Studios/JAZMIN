using System.Text;
using System.Text.Json.Nodes;
using System.Xml;
using Jazmin.Formats;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Streaming XML import (TASKS C-2): <see cref="XmlFormat.Parse"/> now reads its rows with <see cref="XmlFormat.ReadRows"/>,
/// which <see cref="JazminConvert.FromXmlFile"/> uses on a file; both must give what the parser before streaming gave.
/// </summary>
public sealed class XmlStreamTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-xml-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>The parser before streaming (1.1.0): the reference.</summary>
    private static TabularData ReferenceParse(string xml)
    {
        var names = new List<string>();
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        var records = new List<Dictionary<int, string>>();
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { IgnoreComments = true, DtdProcessing = DtdProcessing.Prohibit });
        reader.MoveToContent();
        if (reader.IsEmptyElement) return TextValues.FromText(names, new List<string?[]>(), true);
        reader.ReadStartElement();
        while (reader.MoveToContent() == XmlNodeType.Element)
        {
            var record = new Dictionary<int, string>();
            if (reader.IsEmptyElement) reader.Read();
            else
            {
                reader.ReadStartElement();
                while (reader.MoveToContent() == XmlNodeType.Element)
                {
                    var name = reader.LocalName == "field" && reader.GetAttribute("name") is { } attr ? attr : reader.LocalName;
                    var value = reader.ReadElementContentAsString();
                    if (!index.TryGetValue(name, out var i))
                    {
                        index[name] = i = names.Count;
                        names.Add(name);
                    }
                    record[i] = value;
                }
                reader.ReadEndElement();
            }
            records.Add(record);
        }
        var rows = records.Select(r => names.Select((_, i) => r.TryGetValue(i, out var v) ? v : null).ToArray()).ToList();
        return TextValues.FromText(names, rows, true);
    }

    private static string Outcome(Func<TabularData> parse)
    {
        try
        {
            var data = parse();
            return string.Join(";", data.Columns.Select(c => $"{c.Name}:{c.Type}:{c.Nullable}")) + "#"
                + string.Join("|", data.Rows.Select(r => string.Join(",", r.Select(v => v?.ToString() ?? "<null>"))));
        }
        catch (Exception e)
        {
            return $"{e.GetType().Name}: {e.Message}";
        }
    }

    [Fact]
    public void Parse_GivesWhatTheParserBeforeStreamingGave()
    {
        var random = new Random(11);
        string[] values = ["text", "42", "2.5", "true", "&amp;", "&#233;", "é", "<![CDATA[x<y]]>", " ", ""];
        string[] extras = ["<!-- c -->", "<?pi x?>", "<a><b>1</b></a>", "stray", "</row>", "<row>"];
        for (var n = 0; n < 2000; n++)
        {
            var xml = new StringBuilder(random.Next(3) == 0 ? "<?xml version=\"1.0\"?>\n" : "").Append("<jazmin>");
            for (var r = random.Next(4); r > 0; r--)
            {
                xml.Append("<row>");
                for (var f = random.Next(4); f > 0; f--)
                {
                    var name = "abc"[random.Next(3)].ToString();
                    xml.Append(random.Next(7) == 0 ? $"<{name}/>" : $"<{name}>{values[random.Next(values.Length)]}</{name}>");
                    if (random.Next(10) == 0) xml.Append("<field name=\"two words\">x</field>");
                }
                if (random.Next(8) == 0) xml.Append(extras[random.Next(extras.Length)]);
                xml.Append("</row>");
            }
            if (random.Next(10) != 0) xml.Append("</jazmin>");
            var text = xml.ToString();
            Assert.Equal(Outcome(() => ReferenceParse(text)), Outcome(() => XmlFormat.Parse(text)));
        }
    }

    private static string Text(JazminRow row) => string.Join("|", row.Values.Select(v => v switch
    {
        byte[] b => Convert.ToBase64String(b),
        JsonNode node => node.ToJsonString(),
        DateTime d => d.ToString("O"),
        _ => v?.ToString(),
    }));

    [Fact]
    public void FromXmlFile_GivesWhatFromXmlGives()
    {
        var path = Path.Combine(_dir, "source.jzm");
        using (var writer = JazminWriter.Create(path, [new("id", JazminType.Int), new("amount", JazminType.Float) { Nullable = true },
                   new("active", JazminType.Bool), new("label", JazminType.String) { Nullable = true }, new("two words", JazminType.String)]))
        {
            for (var i = 0; i < 2500; i++)
                writer.WriteValues([(long)i, i % 7 == 0 ? null : i * 1.25, i % 2 == 0, i % 5 == 0 ? null : $"L & {i % 9} <x>", $"w{i}"]);
        }
        var text = JazminConvert.ToXml(File.ReadAllBytes(path));
        var xml = Path.Combine(_dir, "rows.xml");
        File.WriteAllText(xml, text);
        var output = Path.Combine(_dir, "rows.jzm");
        JazminConvert.FromXmlFile(xml, output);
        using var expected = JazminReader.Open(JazminConvert.FromXml(text));
        using var actual = JazminReader.Open(output);
        Assert.Equal(expected.Columns.Select(c => (c.Name, c.Type, c.Nullable)), actual.Columns.Select(c => (c.Name, c.Type, c.Nullable)));
        Assert.Equal(expected.Rows().Select(Text), actual.Rows().Select(Text));

        // A column that first appears after some rows is nullable, as FromXml infers it.
        var late = Path.Combine(_dir, "late.xml");
        File.WriteAllText(late, "<jazmin><row><a>1</a></row><row><a>2</a><b>x</b></row></jazmin>");
        var lateOutput = Path.Combine(_dir, "late.jzm");
        JazminConvert.FromXmlFile(late, lateOutput);
        using var lateExpected = JazminReader.Open(JazminConvert.FromXml(File.ReadAllText(late)));
        using var lateActual = JazminReader.Open(lateOutput);
        Assert.Equal(lateExpected.Columns.Select(c => (c.Name, c.Type, c.Nullable)), lateActual.Columns.Select(c => (c.Name, c.Type, c.Nullable)));
    }

    [Fact]
    public void FromXmlFile_WithColumns_ReadsEachValueAsItsType_SoAnXmlExportImportsBackExactly()
    {
        JazminColumn[] columns =
        [
            new("id", JazminType.Int), new("at", JazminType.DateTime), new("price", JazminType.Decimal), new("ok", JazminType.Bool),
            new("data", JazminType.Binary), new("meta", JazminType.Json), new("ratio", JazminType.Float),
        ];
        var path = Path.Combine(_dir, "typed.jzm");
        using (var writer = JazminWriter.Create(path, columns.Select(c => new JazminColumn(c.Name, c.Type) { Nullable = true }).ToList()))
        {
            for (var i = 0; i < 300; i++)
                writer.WriteValues([(long)i, i % 4 == 0 ? null : new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i), $"{i}.05", i % 3 == 0,
                    new byte[] { (byte)i, 7 }, JsonNode.Parse($"{{\"i\":{i},\"tags\":[\"a\",\"<b>\"]}}"), i / 8.0]);
        }
        var bytes = File.ReadAllBytes(path);
        var xml = Path.Combine(_dir, "export.xml");
        File.WriteAllText(xml, JazminConvert.ToXml(bytes));
        using var source = JazminReader.Open(bytes);
        var back = Path.Combine(_dir, "back.jzm");
        JazminConvert.FromXmlFile(xml, back, columns: source.Columns);
        using var imported = JazminReader.Open(back);
        Assert.Equal(source.Rows().Select(Text), imported.Rows().Select(Text));
    }

    [Fact]
    public void FromXmlFile_ReportsWhatIsWrong_AndLeavesNoOutput()
    {
        var xml = Path.Combine(_dir, "bad.xml");
        var output = Path.Combine(_dir, "bad.jzm");
        File.WriteAllText(xml, "<jazmin><row><c>1</c></row></jazmin>");
        Assert.Contains("XML element 'c' is not one of the columns given", Assert.Throws<JazminValidationException>(() =>
            JazminConvert.FromXmlFile(xml, output, columns: [new JazminColumn("a", JazminType.Int)])).Message);
        Assert.False(File.Exists(output));
        File.WriteAllText(xml, "<jazmin><row><a>1</a></row><row><a>");
        Assert.ThrowsAny<XmlException>(() => JazminConvert.FromXmlFile(xml, output));
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void ToXml_DeclaresUtf8_SoTheSavedFileLoadsAnywhere()
    {
        // ToXml used to declare utf-16 (a .NET string's encoding): saved as UTF-8, as File.WriteAllText and web responses
        // do, the file was refused by readers that trust the declaration ("There is no Unicode byte order mark").
        var path = Path.Combine(_dir, "source.jzm");
        using (var writer = JazminWriter.Create(path, [new("id", JazminType.Int), new("label", JazminType.String)], new JazminWriteOptions { Metadata = new JsonObject { ["title"] = "Été" } }))
            for (var i = 0; i < 20; i++) writer.WriteValues([(long)i, $"é{i}"]);
        using var reader = JazminReader.Open(path);
        var texts = new[]
        {
            JazminConvert.ToXml(File.ReadAllBytes(path)),
            JazminShape.Parse("""{ "title": { "$meta": "title" }, "rows": { "$rows": { "id": "id", "label": "label" }, "$xmlItem": "row" } }""").ToXml(reader),
        };
        foreach (var text in texts)
        {
            Assert.StartsWith("<?xml version=\"1.0\" encoding=\"utf-8\"?>", text);
            var saved = Path.Combine(_dir, "saved.xml");
            File.WriteAllText(saved, text);
            var document = new XmlDocument();
            document.Load(saved);
            Assert.Contains("é1", document.DocumentElement!.InnerText);
        }
    }
}
