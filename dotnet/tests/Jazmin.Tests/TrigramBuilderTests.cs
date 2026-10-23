using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

public class TrigramBuilderTests
{
    /// <summary>
    /// The straightforward definition (spec 8.2): distinct ASCII-lower-cased grams, ordinal order (or, with
    /// <paramref name="reversed"/>, the opposite order: an index that breaks the rule). Value i is row i, or
    /// <paramref name="rowIds"/>[i].
    /// </summary>
    private static byte[] Reference(IReadOnlyList<string?> values, bool reversed = false, IReadOnlyList<long>? rowIds = null)
    {
        var grams = new SortedDictionary<string, List<long>>(StringComparer.Ordinal);
        for (var i = 0; i < values.Count; i++)
        {
            if (values[i] is not { } text) continue;
            foreach (var gram in Trigrams.Of(text))
            {
                if (!grams.TryGetValue(gram, out var ids)) grams[gram] = ids = new List<long>();
                ids.Add(rowIds?[i] ?? i);
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
    public void Builder_WritesTheSameBytesAsTheDefinition_ForLongPostingsAndFarApartRowIds()
    {
        // Row ids as an append's index segment has them (not from 0), with gaps up to 2^40: deltas of one to six varint
        // bytes. Some grams are in most rows, so their postings grow to thousands of entries.
        string?[] words = ["common", "Common text", "rare", "x", null, "ünïcode", "COMMON", "abcabcabc"];
        var random = new Random(3);
        var rowIds = new List<long>();
        var values = new List<string?>();
        var rowId = 5_000_000_000L;
        for (var i = 0; i < 40_000; i++)
        {
            rowId += random.Next(8) switch { 0 => 1L << random.Next(41), 1 => random.Next(1, 300), _ => 1 };
            rowIds.Add(rowId);
            values.Add(words[random.Next(words.Length)] is { } word ? $"{word} {i % 13}" : null);
        }
        var builder = new TrigramIndexBuilder();
        for (var i = 0; i < values.Count; i++) builder.Add(rowIds[i], values[i]);
        Assert.Equal(Reference(values, rowIds: rowIds), builder.Encode());
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
