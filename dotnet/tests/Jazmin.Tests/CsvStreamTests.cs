using System.Text;
using System.Text.Json.Nodes;
using Jazmin.Formats;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Streaming CSV import (TASKS C-2): records read a buffer at a time must be exactly those of the whole text, and a file
/// imported with <see cref="JazminConvert.FromCsvFile"/> must equal <see cref="JazminConvert.FromCsv"/> of its text.
/// </summary>
public sealed class CsvStreamTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-csv-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>The parser before streaming (1.1.0), on the whole text: the reference the streaming one must match.</summary>
    private static List<string?[]> ReferenceRecords(string text, char delimiter)
    {
        var records = new List<string?[]>();
        var record = new List<string?>();
        var field = new StringBuilder();
        bool quoted = false, inQuotes = false;
        void EndField()
        {
            record.Add(quoted || field.Length > 0 ? field.ToString() : null);
            field.Clear();
            quoted = false;
        }
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (inQuotes)
            {
                if (ch == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"')
                    {
                        field.Append('"');
                        i++;
                    }
                    else inQuotes = false;
                }
                else field.Append(ch);
                continue;
            }
            if (ch == '"' && field.Length == 0 && !quoted)
            {
                inQuotes = true;
                quoted = true;
            }
            else if (ch == delimiter) EndField();
            else if (ch is '\r' or '\n')
            {
                EndField();
                records.Add(record.ToArray());
                record.Clear();
                if (ch == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
            }
            else field.Append(ch);
        }
        if (inQuotes) throw new JazminValidationException("CSV ends inside a quoted field");
        if (field.Length > 0 || quoted || record.Count > 0)
        {
            EndField();
            records.Add(record.ToArray());
        }
        return records;
    }

    /// <summary>Hands out at most a few characters per read, so quotes and line endings fall across buffers.</summary>
    private sealed class TrickleReader(string text, Random random) : TextReader
    {
        private int _at;

        public override int Read(char[] buffer, int index, int count)
        {
            var n = Math.Min(Math.Min(count, 1 + random.Next(3)), text.Length - _at);
            text.CopyTo(_at, buffer, index, n);
            _at += n;
            return n;
        }
    }

    private static string Outcome(Func<IEnumerable<string?[]>> records)
    {
        try
        {
            return string.Join("|", records().Select(r => string.Join(",", r.Select(f => f is null ? "<null>" : $"[{f}]"))));
        }
        catch (JazminValidationException e)
        {
            return "error: " + e.Message;
        }
    }

    [Fact]
    public void RecordsReadInPieces_EqualThoseOfTheWholeText()
    {
        var random = new Random(7);
        string[] parts = ["a", "bc", " ", "\"", "\"\"", "\r", "\n", "\r\n", "é", "日本", "\"x\"\"y\"", ""];
        for (var n = 0; n < 3000; n++)
        {
            var delimiter = n % 3 == 0 ? ';' : ',';
            var text = new StringBuilder();
            for (var k = random.Next(60); k > 0; k--) text.Append(random.Next(parts.Length + 1) is var p && p == parts.Length ? delimiter.ToString() : parts[p]);
            if (random.Next(2) == 0) text.Append('"');
            var csv = text.ToString();
            var expected = Outcome(() => ReferenceRecords(csv, delimiter));
            Assert.Equal(expected, Outcome(() => CsvFormat.ReadRecords(new StringReader(csv), delimiter).ToList()));
            Assert.Equal(expected, Outcome(() => CsvFormat.ReadRecords(new TrickleReader(csv, random), delimiter).ToList()));
        }
    }

    [Fact]
    public void FromCsvFile_GivesWhatFromCsvGives()
    {
        var lines = new List<string> { "id,amount,active,label,when" };
        for (var i = 0; i < 2500; i++)
            lines.Add($"{i},{(i % 7 == 0 ? "" : (i * 1.25).ToString(System.Globalization.CultureInfo.InvariantCulture))},{i % 2 == 0},{(i % 5 == 0 ? "" : $"\"L, {i % 9}\"")},2026-10-{1 + i % 28:00}");
        var text = "﻿" + string.Join("\r\n", lines) + "\r\n";
        var csv = Path.Combine(_dir, "rows.csv");
        File.WriteAllText(csv, text, new UTF8Encoding(false));
        var output = Path.Combine(_dir, "rows.jzm");
        JazminConvert.FromCsvFile(csv, output);
        using var expected = JazminReader.Open(JazminConvert.FromCsv(text));
        using var actual = JazminReader.Open(output);
        Assert.Equal(expected.Columns.Select(c => (c.Name, c.Type, c.Nullable)), actual.Columns.Select(c => (c.Name, c.Type, c.Nullable)));
        Assert.Equal(expected.Rows().Select(r => string.Join("|", r.Values)), actual.Rows().Select(r => string.Join("|", r.Values)));
    }

    [Fact]
    public void FromCsvFile_WithColumns_ReadsEachValueAsItsType_SoACsvExportImportsBackExactly()
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
                    new byte[] { (byte)i, 7 }, JsonNode.Parse($"{{\"i\":{i},\"tags\":[\"a\",\"b\"]}}"), i / 8.0]);
        }
        var bytes = File.ReadAllBytes(path);
        var csv = Path.Combine(_dir, "export.csv");
        File.WriteAllText(csv, JazminConvert.ToCsv(bytes));
        using var source = JazminReader.Open(bytes);
        var back = Path.Combine(_dir, "back.jzm");
        JazminConvert.FromCsvFile(csv, back, columns: source.Columns);
        using var imported = JazminReader.Open(back);
        Assert.Equal(source.Rows().Select(Text), imported.Rows().Select(Text));

        static string Text(JazminRow row) => string.Join("|", row.Values.Select(v => v switch
        {
            byte[] b => Convert.ToBase64String(b),
            JsonNode node => node.ToJsonString(),
            DateTime d => d.ToString("O"),
            _ => v?.ToString(),
        }));
    }

    [Fact]
    public void FromCsvFile_ReportsWhatIsWrong_AndLeavesNoOutput()
    {
        string File_(string text)
        {
            var path = Path.Combine(_dir, $"bad-{Guid.NewGuid():N}.csv");
            File.WriteAllText(path, text);
            return path;
        }
        var output = Path.Combine(_dir, "bad.jzm");
        Assert.Contains("CSV has no header row", Assert.Throws<JazminValidationException>(() => JazminConvert.FromCsvFile(File_(""), output)).Message);
        Assert.Contains("CSV line 3 has more fields than the header",
            Assert.Throws<JazminValidationException>(() => JazminConvert.FromCsvFile(File_("a,b\n1,2\n1,2,3\n"), output)).Message);
        Assert.Contains("CSV ends inside a quoted field",
            Assert.Throws<JazminValidationException>(() => JazminConvert.FromCsvFile(File_("a,b\n\"1,2\n"), output)).Message);
        Assert.Contains("CSV column 'c' is not one of the columns given", Assert.Throws<JazminValidationException>(() =>
            JazminConvert.FromCsvFile(File_("a,c\n1,2\n"), output, columns: [new JazminColumn("a", JazminType.Int), new JazminColumn("b", JazminType.Int)])).Message);
        Assert.False(File.Exists(output));
    }
}
