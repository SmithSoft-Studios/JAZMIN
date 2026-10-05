using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Decimals may have up to 256 digits (spec 5.1): rows, statistics bounds and indexes must keep them whole. The JS
/// writer once lost bytes of long decimals (js/test/big-decimal.test.js); this checks .NET does not.
/// </summary>
public sealed class BigDecimalTests
{
    private static List<string> Decimals(int digits, int count) =>
        Enumerable.Range(0, count).Select(i => new string('9', digits - 7) + i.ToString("D6") + ".5").ToList(); // `digits` significant digits

    [Theory]
    [InlineData(22)]
    [InlineData(40)]
    [InlineData(80)]
    [InlineData(256)]
    public void Files_with_long_decimals_read_back_filter_and_index_exactly(int digits)
    {
        var values = Decimals(digits, 1500);
        var all = new List<string> { "1.5", "2.5" }.Concat(values).ToList();
        foreach (var key in new[] { null, JazminKey.Generate() })
        {
            var stream = new MemoryStream();
            var columns = new[] { new JazminColumn("d", JazminType.Decimal) { Indexes = [JazminIndexKind.Sorted] } };
            using (var writer = new JazminWriter(stream, columns, new JazminWriteOptions { ChunkRows = 2, Key = key }, leaveOpen: true))
                foreach (var d in all) writer.WriteRow(new Dictionary<string, object?> { ["d"] = d });
            using var reader = JazminReader.Open(stream.ToArray(), new JazminReadOptions { Key = key });
            Assert.Equal(all, reader.Rows().Select(r => (string)r["d"]!).ToList());
            Assert.Equal(["1.5", "2.5"], reader.Find(JazminFilter.Parse("""{"d":{"lt":"1000"}}""")).Select(r => (string)r["d"]!).ToList());
            Assert.Equal(values.Count, reader.Count(JazminFilter.Parse("""{"d":{"gt":"1000"}}""")));
            Assert.Equal([values[777]], reader.Find(JazminFilter.Eq("d", values[777])).Select(r => (string)r["d"]!).ToList());
            Assert.Equal(1, reader.Explain(JazminFilter.Parse("""{"d":{"lt":"1000"}}"""), analyze: true).Cost!.ChunksRead);
        }
    }
}
