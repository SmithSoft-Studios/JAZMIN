using System.Globalization;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Filtered scans decode the filter's columns first, and the other columns only for chunks with matching rows (text,
/// decimals, json and binary made only for those rows; integers and dates checked as stored). The rows returned must be
/// exactly those that filtering every row in memory gives, for every column type, with nulls, index candidates and
/// deleted rows (as js/test/scan-decode.test.js).
/// </summary>
public class ScanDecodeTests
{
    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int) { Nullable = false },
        new("name", JazminType.String) { Indexes = [JazminIndexKind.Sorted] }, // repeats: written as a dictionary
        new("note", JazminType.String), // all different: written plain
        new("amount", JazminType.Decimal),
        new("doc", JazminType.Json),
        new("blob", JazminType.Binary),
        new("score", JazminType.Float),
        new("flag", JazminType.Bool),
        new("at", JazminType.DateTime),
    ];

    private static readonly DateTime Start = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private static object?[] Row(int i) =>
    [
        (long)i,
        i % 7 == 0 ? null : $"name {i % 13}",
        i % 5 == 0 ? null : $"note {i} {new string('x', i % 9)}",
        i % 6 == 0 ? null : $"{i}.{i % 100:D2}",
        i % 4 == 0 ? null : new JsonObject { ["i"] = i, ["tags"] = new JsonArray(i % 3) },
        i % 8 == 0 ? null : new byte[] { (byte)(i & 255), 7 },
        i % 9 == 0 ? null : i / 3.0,
        i % 2 == 0,
        i % 10 == 0 ? null : Start.AddHours(i),
    ];

    private static byte[] Write(Action<JazminWriteOptions>? configure = null)
    {
        var options = new JazminWriteOptions { ChunkRows = 32 };
        configure?.Invoke(options);
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            for (var i = 0; i < 300; i++) writer.WriteValues(Row(i));
        return stream.ToArray();
    }

    private static readonly JazminFilter[] Filters =
    [
        JazminFilter.In("id", 3L, 50L, 299L, 1000L),
        JazminFilter.Eq("name", "name 4"), // index candidates
        JazminFilter.Gt("amount", "100"),
        JazminFilter.In("at", Start.AddHours(7), Start.AddHours(211)),
        JazminFilter.Lt("score", 5.0) | JazminFilter.IsNull("doc"),
        !JazminFilter.Eq("flag", true),
        JazminFilter.Contains("note", "xxxxxxx"),
        JazminFilter.Gte("id", 40L) & JazminFilter.Lt("id", 200L) & JazminFilter.Ne("id", 77L) & JazminFilter.IsNull("blob", false),
    ];

    private static string Text(object? value) => value switch
    {
        null => "null",
        byte[] bytes => Convert.ToHexString(bytes),
        JsonNode node => node.ToJsonString(),
        DateTime date => date.ToString("O", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString()!,
    };

    private static string Line(IReadOnlyDictionary<string, object?> row, IEnumerable<string> names) =>
        string.Join("|", names.Select(n => Text(row[n])));

    /// <summary>Every row filtered in memory, as the reader's filter engine compares values.</summary>
    private static List<string> InMemory(JazminReader reader, JazminFilter filter, IReadOnlyList<string> names)
    {
        var bound = BoundFilter.Bind(filter, reader.Columns)!;
        return reader.Find((JazminFilter?)null)
            .Where(row => FilterEngine.Evaluate(bound, reader.Columns.Select(c => row[c.Name]).ToArray()))
            .Select(row => Line(row, names)).ToList();
    }

    [Fact]
    public void AFilteredScan_ReturnsWhatFilteringEveryRowInMemoryGives()
    {
        using var reader = JazminReader.Open(Write());
        var all = Columns.Select(c => c.Name).ToList();
        string[] some = ["note", "amount", "doc", "blob"];
        foreach (var filter in Filters)
        {
            var expected = InMemory(reader, filter, all);
            Assert.Equal(expected, reader.Find(filter).Select(r => Line(r, all)).ToList());
            Assert.Equal(InMemory(reader, filter, some), reader.Find(filter, new JazminQueryOptions { Select = some }).Select(r => Line(r, some)).ToList());
            Assert.Equal(expected.Skip(2).Take(3).ToList(), reader.Find(filter, new JazminQueryOptions { Offset = 2, Limit = 3 }).Select(r => Line(r, all)).ToList());
            Assert.Equal(expected.Count, reader.Count(filter));
        }
    }

    [Fact]
    public void RowsDeletedByAnAppend_AreLeftOut()
    {
        var path = Path.Combine(Path.GetTempPath(), $"scan-{Guid.NewGuid():N}.jzm");
        try
        {
            File.WriteAllBytes(path, Write(o => o.SortedBy = ["id"]));
            var last = Columns.Zip(Row(299)).ToDictionary(p => p.First.Name, p => p.Second);
            last["note"] = "changed";
            JazminFile.Append(path, new JazminAppend { Upsert = [last], KeyColumns = ["id"], Delete = JazminFilter.Eq("id", 50L) });
            using var reader = JazminReader.Open(path);
            var all = Columns.Select(c => c.Name).ToList();
            Assert.Equal(299, reader.RowCount);
            foreach (var filter in Filters)
                Assert.Equal(InMemory(reader, filter, all), reader.Find(filter).Select(r => Line(r, all)).ToList());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void AChunkWithoutMatchingRows_DecodesOnlyTheFiltersColumns()
    {
        using var reader = JazminReader.Open(Write());
        var cost = reader.Explain(JazminFilter.Contains("note", "note 33 "), analyze: true).Cost!; // one row, in chunk 1 of 10
        Assert.Equal(1, cost.Rows);
        Assert.Equal(10, cost.ChunksRead);
        Assert.Equal(10 + 8, cost.ColumnsDecoded); // the note column of every chunk, and the other 8 of the one that matches
    }
}
