using System.Text.Json;
using Jazmin.Formats;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

public sealed class StreamingImportTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-import-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private string File(string name, string text)
    {
        var path = Path.Combine(_dir, name);
        System.IO.File.WriteAllText(path, text);
        return path;
    }

    private const string Tricky = """
        [ { "id": 1, "text": "brace } and { inside", "nested": { "a": [1, { "b": "]" }] } },
          { "id": 2, "text": "quote \" and \\ backslash", "emoji": "Zoë 👋 €" },
          { "id": 3, "text": "", "nested": null } ]
        """;

    [Fact]
    public void ReadObjects_StreamsArrayAndJsonLines()
    {
        var expected = JsonDocument.Parse(Tricky).RootElement.EnumerateArray().Select(e => e.GetRawText()).ToList();
        Assert.Equal(expected, JsonFormat.ReadObjects(File("a.json", Tricky)).Select(e => e.GetRawText()));

        var lines = string.Join("\n", JsonDocument.Parse(Tricky).RootElement.EnumerateArray().Select(e => e.GetRawText()));
        Assert.Equal(3, JsonFormat.ReadObjects(File("a.jsonl", "﻿" + lines + "\n\n")).Count());
    }

    [Fact]
    public void FromJsonFile_InfersSchemaAndSupportsSectionQueries()
    {
        var rows = Enumerable.Range(0, 5000).Select(i => new { section = $"S{i / 100}", line = i, amount = i * 0.5 + 0.25, note = i % 3 == 0 ? "x" : null });
        var input = File("big.json", JsonSerializer.Serialize(rows));
        var output = Path.Combine(_dir, "big.jzm");
        JazminConvert.FromJsonFile(input, output, new JazminSerializerSettings
        {
            ChunkRows = 256,
            Indexes = new() { ["section"] = new[] { JazminIndexKind.Sorted } },
        });

        using var reader = JazminReader.Open(output);
        Assert.Equal(new[] { "section:String:False", "line:Int:False", "amount:Float:False", "note:String:True" },
            reader.Columns.Select(c => $"{c.Name}:{c.Type}:{c.Nullable}"));
        var section = reader.Find(JazminFilter.Eq("section", "S42")).ToList();
        Assert.Equal(Enumerable.Range(4200, 100).Select(i => (long)i), section.Select(r => (long)r["line"]!));
    }

    public sealed class StatementLine
    {
        public string Section { get; set; } = "";
        public long Line { get; set; }
        public double Amount { get; set; }
    }

    [Fact]
    public void Query_MatchesPocoPropertiesToFileColumnsCaseInsensitively()
    {
        // JSON from another system uses lower-case names; the C# class uses PascalCase.
        var rows = Enumerable.Range(0, 1000).Select(i => new { section = $"S{i / 100}", line = i, amount = i + 0.5 });
        var input = File("lines.json", JsonSerializer.Serialize(rows));
        var output = Path.Combine(_dir, "lines.jzm");
        JazminConvert.FromJsonFile(input, output, new JazminSerializerSettings { ChunkRows = 100 });

        using var reader = JazminReader.Open(output);
        var sectionId = "S7";
        var lines = reader.Query<StatementLine>(l => l.Section == sectionId).ToList();
        Assert.Equal(Enumerable.Range(700, 100).Select(i => (long)i), lines.Select(l => l.Line));
        Assert.Equal(9, reader.Explain(JazminFilter.Eq("section", "S7")).ChunksSkipped);

        // 'line' is an int column but Amount-style mismatches must not break queries:
        // a double property over an int column is checked in memory instead of translated.
        Assert.Equal(new[] { 5L }, reader.Query<MismatchedLine>(l => l.Line == 5.0 && l.Section == "S0").Select(l => (long)l.Line));
    }

    public sealed class MismatchedLine
    {
        public string Section { get; set; } = "";
        public double Line { get; set; }
    }

    [Fact]
    public void FromJsonFile_DeletesOutputWhenInputIsBroken()
    {
        var input = File("broken.json", """[ {"a": 1}, {"a": 2}, {"a": """);
        var output = Path.Combine(_dir, "broken.jzm");
        var columns = new[] { new JazminColumn("a", JazminType.Int) };
        Assert.ThrowsAny<JsonException>(() => JazminConvert.FromJsonFile(input, output, columns: columns));
        Assert.False(System.IO.File.Exists(output));
    }

    [Fact]
    public void Abort_LeavesAFileThatReadersReject()
    {
        var stream = new MemoryStream();
        var writer = new JazminWriter(stream, new[] { new JazminColumn("a", JazminType.Int) }, leaveOpen: true);
        writer.WriteValues(1L);
        writer.Abort();
        writer.Dispose();
        Assert.Throws<JazminFormatException>(() => JazminReader.Open(stream.ToArray()));
    }
}
