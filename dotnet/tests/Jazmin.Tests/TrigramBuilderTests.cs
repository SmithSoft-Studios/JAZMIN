using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

public class TrigramBuilderTests
{
    /// <summary>The straightforward definition (spec 8.2): distinct ASCII-lower-cased grams, ordinal order.</summary>
    private static byte[] Reference(IReadOnlyList<string?> values)
    {
        var grams = new SortedDictionary<string, List<long>>(StringComparer.Ordinal);
        for (var id = 0; id < values.Count; id++)
        {
            if (values[id] is not { } text) continue;
            foreach (var gram in Trigrams.Of(text))
            {
                if (!grams.TryGetValue(gram, out var ids)) grams[gram] = ids = new List<long>();
                ids.Add(id);
            }
        }
        var writer = new ByteWriter();
        writer.Byte(0); // encoding byte (spec 8.2)
        writer.VarUInt((ulong)grams.Count);
        foreach (var (gram, ids) in grams)
        {
            foreach (var ch in gram) writer.UInt16(ch);
            RowSet.WritePostings(writer, ids);
        }
        return writer.ToArray();
    }

    [Fact]
    public void Builder_WritesTheSameBytesAsTheDefinition()
    {
        string[] alphabet = ["a", "B", "z", "Z", " ", "é", "É", "ß", "😀", "­", "Ω", "x", "1"];
        var random = new Random(7);
        for (var round = 0; round < 50; round++)
        {
            var values = Enumerable.Range(0, 400).Select(_ => random.NextDouble() < 0.05
                ? null
                : string.Concat(Enumerable.Range(0, random.Next(12)).Select(_ => alphabet[random.Next(alphabet.Length)]))).ToList();
            var builder = new TrigramIndexBuilder();
            for (var id = 0; id < values.Count; id++) builder.Add(id, values[id]);
            Assert.Equal(Reference(values), builder.Encode());
        }
    }
}
