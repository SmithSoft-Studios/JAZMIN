using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Index lookups and access-controlled reads decode only the columns a query uses (issue #11). The rows must be the same
/// as with every column decoded. Mirrors js/test/needed-columns.test.js.
/// </summary>
public class NeededColumnsTests
{
    private static readonly string Dir = FindFixtures();
    private static readonly JazminKey Key = JazminKey.Parse((string)JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "keys.json")))!["key"]!);
    private static readonly string?[] Filters = [null, """{"id":{"lt":40}}""", """{"country":"NA"}""", """{"score":{"gt":50}}""", """{"name":{"contains":"son"}}""", """{"not":{"country":"ZA"}}"""];
    private static readonly string[][] Selects = [["id"], ["balance"], ["blob", "name"], ["extra", "joined", "active"]];

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures");
            if (File.Exists(Path.Combine(candidate, "keys.json"))) return candidate;
        }
        throw new InvalidOperationException("spec/fixtures not found");
    }

    /// <summary>A row as comparable text: column names and values in order.</summary>
    private static string Text(IEnumerable<KeyValuePair<string, object?>> row) =>
        string.Join("|", row.Select(p => $"{p.Key}={(p.Value is byte[] b ? Convert.ToBase64String(b) : p.Value is JsonNode n ? n.ToJsonString() : Convert.ToString(p.Value, System.Globalization.CultureInfo.InvariantCulture))}"));

    [Theory]
    [InlineData("js-paged-key.jzm")]
    [InlineData("js-access.jzm")]
    public void A_query_returns_the_selected_columns_of_the_full_rows(string file)
    {
        using var reader = JazminReader.Open(Path.Combine(Dir, file), new JazminReadOptions { Key = Key });
        foreach (var where in Filters)
        {
            var filter = where is null ? null : JazminFilter.Parse(where);
            var full = reader.Find(filter).Select(r => r.ToDictionary(p => p.Key, p => p.Value)).ToList();
            foreach (var select in Selects)
            {
                var expected = full.Select(r => Text(select.Select(c => new KeyValuePair<string, object?>(c, r[c])))).ToList();
                Assert.Equal(expected, reader.Find(filter, new JazminQueryOptions { Select = select }).Select(Text).ToList());
                Assert.Equal(expected.Skip(3).Take(4), reader.Find(filter, new JazminQueryOptions { Select = select, Offset = 3, Limit = 4 }).Select(Text));
            }
        }
    }

    [Theory]
    [InlineData("js-paged-key.jzm")]
    [InlineData("js-access.jzm")]
    public void A_chunk_decoded_for_a_narrow_query_is_not_reused_where_every_column_is_needed(string file)
    {
        using var reader = JazminReader.Open(Path.Combine(Dir, file), new JazminReadOptions { Key = Key });
        var whole = Text(reader.Find(JazminFilter.Eq("id", 3)).Single());
        Assert.Equal("id=3", Text(reader.Find(JazminFilter.Eq("id", 3), new JazminQueryOptions { Select = ["id"] }).Single()));
        Assert.Equal(whole, Text(reader.Get(3)));
        Assert.Equal(whole, Text(reader.Find(JazminFilter.Eq("id", 3)).Single()));
    }
}
