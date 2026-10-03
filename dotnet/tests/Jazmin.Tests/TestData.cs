using System.Text.Json.Nodes;

namespace Jazmin.Tests;

internal static class TestData
{
    public static readonly JazminColumn[] AllTypes =
    {
        new("id", JazminType.Int) { Nullable = false, Description = "Primary key" },
        new("name", JazminType.String),
        new("active", JazminType.Bool),
        new("score", JazminType.Float),
        new("balance", JazminType.Decimal),
        new("joined", JazminType.DateTime),
        new("avatar", JazminType.Binary),
        new("tags", JazminType.Json),
    };

    public static object?[][] AllTypesRows() => new[]
    {
        new object?[] { 1L, "Ann", true, 9.5, "1234.50", new DateTime(2024, 1, 2, 3, 4, 5, 678, DateTimeKind.Utc), new byte[] { 1, 2, 3 }, JsonNode.Parse("[\"a\",{\"b\":1}]") },
        new object?[] { 2L, null, false, -0.25, "-0.01", null, null, null },
        new object?[] { long.MaxValue, "Zoë 👋", null, null, null, DateTime.UnixEpoch, Array.Empty<byte>(), new JsonObject() },
    };

    public static byte[] Write(IEnumerable<JazminColumn> columns, IEnumerable<object?[]> rows, JazminWriteOptions? options = null)
    {
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, columns, options, leaveOpen: true))
        {
            foreach (var row in rows) writer.WriteValues(row);
        }
        return stream.ToArray();
    }

    public static object?[] Values(JazminRow row) => row.Values.ToArray();
}
