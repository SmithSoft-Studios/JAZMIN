using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Formats;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Rows as a JSON token stream (TASKS J-3): <see cref="JazminJsonReader"/> gives the tokens one at a time, as Newtonsoft's
/// JsonReader does, and <see cref="JazminJsonStream"/> the same JSON as bytes for System.Text.Json pipelines. Both give
/// what <see cref="JsonFormat.Write"/> writes.
/// </summary>
public sealed class JsonTokenTests
{
    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int) { Nullable = false },
        new("name", JazminType.String),
        new("amount", JazminType.Decimal),
        new("score", JazminType.Float),
        new("active", JazminType.Bool),
        new("at", JazminType.DateTime),
        new("blob", JazminType.Binary),
        new("extra", JazminType.Json),
        new("two words", JazminType.String),
    ];

    private static byte[] File(int rows = 300)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions { ChunkRows = 64 }, leaveOpen: true))
        {
            for (var i = 0; i < rows; i++)
            {
                writer.WriteValues([
                    (long)i - 150,
                    i % 7 == 0 ? null : $"Name \"{i}\" é 👋",
                    i % 5 == 0 ? null : $"{i * 37 % 1000}.{i % 100:D2}",
                    i % 11 == 0 ? null : i * 0.25 - 3,
                    i % 3 == 0 ? null : i % 2 == 0,
                    i % 13 == 0 ? null : new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i * 97),
                    i % 4 == 0 ? null : new byte[] { (byte)i, 0, 255 },
                    i % 6 == 0 ? null : JsonNode.Parse($$"""{"i":{{i}},"tags":["a",{{(i % 2 == 0 ? "true" : "null")}},{"deep":[{{i}},1.5,"x"]}],"empty":{},"none":[]}"""),
                    $"w{i}",
                ]);
            }
        }
        return stream.ToArray();
    }

    /// <summary>The JSON text's tokens as (kind, text), read with System.Text.Json; numbers in a canonical form.</summary>
    private static List<(string Kind, string Text)> TokensOfText(byte[] json)
    {
        var tokens = new List<(string, string)>();
        var reader = new Utf8JsonReader(json);
        while (reader.Read())
        {
            tokens.Add(reader.TokenType switch
            {
                JsonTokenType.PropertyName => ("name", reader.GetString()!),
                JsonTokenType.String => ("string", reader.GetString()!),
                JsonTokenType.Number => ("number", Number(Encoding.UTF8.GetString(reader.ValueSpan))),
                JsonTokenType.True => ("bool", "True"),
                JsonTokenType.False => ("bool", "False"),
                JsonTokenType.Null => ("null", ""),
                var other => (other.ToString(), ""),
            });
        }
        return tokens;
    }

    private static string Number(string text) => text.Contains('.') || text.Contains('e') || text.Contains('E')
        ? double.Parse(text, CultureInfo.InvariantCulture).ToString("R", CultureInfo.InvariantCulture)
        : text;

    /// <summary>The token reader's tokens in the same form: dates as their JSON text, bytes as base64, decimals exactly.</summary>
    private static List<(string Kind, string Text)> TokensOfReader(JazminJsonReader json)
    {
        var tokens = new List<(string, string)>();
        while (json.Read())
        {
            tokens.Add(json.TokenType switch
            {
                JazminJsonToken.StartArray => ("StartArray", ""),
                JazminJsonToken.EndArray => ("EndArray", ""),
                JazminJsonToken.StartObject => ("StartObject", ""),
                JazminJsonToken.EndObject => ("EndObject", ""),
                JazminJsonToken.PropertyName => ("name", (string)json.Value!),
                JazminJsonToken.String => ("string", (string)json.Value!),
                JazminJsonToken.Integer => ("number", ((long)json.Value!).ToString(CultureInfo.InvariantCulture)),
                JazminJsonToken.Float => ("number", Number(json.Value is double d ? d.ToString("R", CultureInfo.InvariantCulture) : (string)json.Value!)),
                JazminJsonToken.Boolean => ("bool", ((bool)json.Value!).ToString()),
                JazminJsonToken.Null => ("null", ""),
                JazminJsonToken.Date => ("string", ((DateTime)json.Value!).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)),
                JazminJsonToken.Bytes => ("string", Convert.ToBase64String((byte[])json.Value!)),
                var other => throw new InvalidOperationException($"Unexpected token {other}"),
            });
        }
        return tokens;
    }

    private static byte[] Written(JazminReader reader, JazminFilter? filter = null, JazminQueryOptions? options = null, Formatting formatting = Formatting.None)
    {
        var columns = options?.Select is { } select ? select.Select(name => reader.Columns.First(c => c.Name == name)).ToList() : reader.Columns;
        var output = new MemoryStream();
        JsonFormat.Write(output, columns, reader.Find(filter, options), formatting);
        return output.ToArray();
    }

    [Fact]
    public void TheTokenReader_GivesTheTokensOfTheJsonText_WithDepthAndPath()
    {
        using var reader = JazminReader.Open(File());
        using var json = new JazminJsonReader(reader);
        Assert.Equal(TokensOfText(Written(reader)), TokensOfReader(json));
        Assert.False(json.Read());
        Assert.Equal(JazminJsonToken.None, json.TokenType);

        using var again = new JazminJsonReader(reader, JazminFilter.Eq("id", -149L));
        var seen = new List<(JazminJsonToken, int, string)>();
        while (again.Read()) seen.Add((again.TokenType, again.Depth, again.Path));
        Assert.Equal((JazminJsonToken.StartArray, 0, ""), seen[0]);
        Assert.Equal((JazminJsonToken.StartObject, 1, "[0]"), seen[1]);
        Assert.Equal((JazminJsonToken.PropertyName, 2, "[0].id"), seen[2]);
        Assert.Equal((JazminJsonToken.Integer, 2, "[0].id"), seen[3]);
        Assert.Contains((JazminJsonToken.PropertyName, 2, "[0]['two words']"), seen);
        Assert.Contains((JazminJsonToken.Float, 6, "[0].extra.tags[2].deep[1]"), seen);
        Assert.Equal((JazminJsonToken.EndArray, 0, ""), seen[^1]);
    }

    [Fact]
    public void TheStream_IsTheJsonText_AndFeedsSystemTextJson()
    {
        using var reader = JazminReader.Open(File());
        var cases = new (JazminFilter? Filter, JazminQueryOptions? Options, Formatting Formatting)[]
        {
            (null, null, Formatting.None),
            (null, null, Formatting.Indented),
            (JazminFilter.Gt("id", 0L), new() { Select = ["id", "extra", "amount"], Offset = 5, Limit = 40 }, Formatting.None),
            (JazminFilter.Eq("id", 9999L), null, Formatting.Indented), // no rows
        };
        foreach (var (filter, options, formatting) in cases)
        {
            var expected = Written(reader, filter, options, formatting);
            using (var stream = new JazminJsonStream(reader, filter, options, formatting))
                Assert.Equal(expected, ReadAll(stream, 1)); // one byte at a time
            using (var stream = new JazminJsonStream(reader, filter, options, formatting))
                Assert.Equal(expected, ReadAll(stream, 100_000));
        }

        using (var stream = new JazminJsonStream(reader))
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(Written(reader)), JsonNode.Parse(stream)));
        using (var stream = new JazminJsonStream(reader))
        {
            var rows = JsonSerializer.DeserializeAsyncEnumerable<Dictionary<string, JsonElement>>(stream).ToBlockingEnumerable().ToList();
            Assert.Equal(300, rows.Count);
            Assert.Equal(-150, rows[0]!["id"].GetInt64());
            Assert.Equal("w299", rows[^1]!["two words"].GetString());
        }
    }

    private static byte[] ReadAll(Stream stream, int size)
    {
        var output = new MemoryStream();
        var buffer = new byte[size];
        int n;
        while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, n);
        return output.ToArray();
    }
}
