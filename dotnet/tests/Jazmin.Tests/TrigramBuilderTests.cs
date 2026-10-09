using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

public class TrigramBuilderTests
{
    /// <summary>
    /// The straightforward definition (spec 8.2): distinct ASCII-lower-cased grams, ordinal order (or, with
    /// <paramref name="reversed"/>, the opposite order: an index that breaks the rule).
    /// </summary>
    private static byte[] Reference(IReadOnlyList<string?> values, bool reversed = false)
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
        foreach (var (gram, ids) in reversed ? grams.Reverse() : grams)
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

    [Fact]
    public void Lookups_ReturnTheRowsWithEveryGramOfTheText_ReadRarestGramFirst()
    {
        var random = new Random(11);
        string Word(int length) => string.Concat(Enumerable.Range(0, length).Select(_ => "abcde fgAB"[random.Next(10)]));
        var values = Enumerable.Range(0, 3000).Select(i => i % 97 == 0 ? null : Word(4 + random.Next(20))).ToList();
        var valueGrams = values.Select(v => v is null ? null : Trigrams.Of(v)).ToList();
        List<long> RowsWith(IEnumerable<string> grams) =>
            Enumerable.Range(0, values.Count).Where(id => valueGrams[id] is { } own && grams.All(own.Contains)).Select(id => (long)id).ToList();
        foreach (var reversed in new[] { false, true })
        {
            var index = TrigramIndex.Decode(Reference(values, reversed));
            for (var k = 0; k < 200; k++)
            {
                var source = values[k * 7] ?? "abcd";
                var text = k % 2 == 1 ? Word(3 + random.Next(5)) : source[1..Math.Min(8, source.Length)]; // 3 characters or more
                var lookup = new IndexLookup.Contains(text, false);
                Assert.Equal(RowsWith(Trigrams.Of(text)).ToArray(), index.Rows(lookup));
                // The rarest gram's rows: at least the matches, as many as its postings hold, from its first to its last.
                var rarest = Trigrams.Of(text).Select(gram => RowsWith([gram])).OrderBy(ids => ids.Count).First();
                Assert.Equal(rarest.Count, index.Bound(lookup));
                Assert.Equal(rarest.Count > 0 ? rarest[^1] - rarest[0] + 1 : 0, index.Span(lookup));
            }
        }
    }
}
