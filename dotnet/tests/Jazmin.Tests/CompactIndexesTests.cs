using Jazmin.Format;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Compact sorted indexes (reader feature 'index-deltas', spec 8.1): pages with encoding 1 hold keys and first row ids
/// as differences from the previous entry's. Written only when asked for; files that use them name the feature, which
/// readers before 1.2 refuse.
/// </summary>
public sealed class CompactIndexesTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-compact-indexes-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static readonly Dictionary<JazminType, object[]> Values = new()
    {
        [JazminType.Int] = [0L, 1L, -1L, 7L, 1000L, -1000L, (long)int.MaxValue, long.MaxValue, long.MinValue, long.MaxValue - 1, 9007199254740993L],
        [JazminType.DateTime] = [0L, 1L, -1L, 86_400_000L, 1_791_331_200_000L, -2_208_988_800_000L, 8_640_000_000_000_000L],
        [JazminType.String] = ["", "a", "ab", "abc", "abd", "b", "TX00A1", "TX00A2", "TX00B", "é", "éa", "ê", "日本", "日本語", "👋", "👋👋", new string('z', 300)],
        [JazminType.Float] = [0.0, 1.5, -1.5, 1e300, -1e-300, 0.1 + 0.2],
        [JazminType.Decimal] = ["0", "1.5", "-1.5", "123456789012345678901234567890.12", "0.001"],
        [JazminType.Bool] = [true, false],
    };

    [Fact]
    public void PagesWithKeysAsDifferences_DecodeToTheSameKeysAndRowIds_ForEveryIndexableType()
    {
        foreach (var (type, list) in Values)
        {
            for (var seed = 1; seed <= 3; seed++)
            {
                var random = new Random(seed);
                var plain = new SortedIndexBuilder(type);
                var compact = new SortedIndexBuilder(type);
                for (var row = 0; row < 3000; row++)
                {
                    // Repeated values, nulls, and rows out of key order (several runs).
                    var value = random.NextDouble() < 0.05 ? null : list[random.Next(list.Length)];
                    plain.Add(row, value);
                    compact.Add(row, value);
                }
                var plainPages = plain.Pages(200).ToList(); // many small pages: each starts afresh
                var compactPages = compact.Pages(200, deltas: true).ToList();
                Assert.Equal(plainPages.Count, compactPages.Count);
                for (var i = 0; i < plainPages.Count; i++)
                {
                    Assert.Equal(FormatConstants.IndexDeltasEncoding, compactPages[i].Raw[0]);
                    Assert.Equal(plainPages[i].First, compactPages[i].First);
                    Assert.Equal(plainPages[i].Count, compactPages[i].Count);
                    var expected = SortedIndex.DecodePage(plainPages[i].Raw, type);
                    var actual = SortedIndex.DecodePage(compactPages[i].Raw, type, deltas: true);
                    Assert.Equal(expected.Count, actual.Count);
                    var all = new IndexLookup.Range(null, false, null, false);
                    Assert.Equal(expected.Between(all), actual.Between(all));
                    foreach (var value in list)
                    {
                        var key = Format.Values.ToKey(type, value);
                        Assert.Equal(expected.Eq(key), actual.Eq(key));
                    }
                    if (type == JazminType.String)
                        foreach (var prefix in new[] { "a", "TX00", "日本", "👋" })
                            Assert.Equal(expected.Prefix(prefix), actual.Prefix(prefix));
                    Assert.Throws<JazminFormatException>(() => SortedIndex.DecodePage(compactPages[i].Raw, type)); // not without the feature
                }
            }
        }
    }

    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("code", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new("at", JazminType.DateTime) { Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Float),
    ];

    private static object?[] Row(int i) =>
        [(long)(i * 7919 % 50_021), i % 13 == 0 ? null : $"TX{i * 104729 % 99_991}", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i), i / 8.0];

    private static readonly JazminFilter[] Queries =
    [
        JazminFilter.Eq("id", 4242L),
        JazminFilter.Gte("id", 1000L) & JazminFilter.Lt("id", 1400L),
        JazminFilter.In("id", 1L, 7919L, 49_999L, 77L),
        JazminFilter.Eq("code", "TX1234"),
        JazminFilter.StartsWith("code", "TX99"),
        JazminFilter.IsNull("code"),
        JazminFilter.Gte("at", new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc)) & JazminFilter.Lt("at", new DateTime(2026, 1, 2, 3, 0, 0, DateTimeKind.Utc)),
    ];

    private string Write(string name, int rows, bool compact)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions { CompactIndexes = compact });
        for (var i = 0; i < rows; i++) writer.WriteValues(Row(i));
        return path;
    }

    private static List<string> Results(string path)
    {
        using var reader = JazminReader.Open(path);
        return Queries.Select(q => string.Join(",", reader.Find(q).Select(r => $"{r["id"]}/{r["code"]}"))).ToList();
    }

    private static bool UsesCompactIndexes(string path)
    {
        using var reader = JazminReader.Open(path);
        return reader.CompactIndexes;
    }

    [Fact]
    public void CompactIndexes_GiveTheSameRows_InASmallerFile_NamingTheFeature()
    {
        var plain = Write("plain.jzm", 6000, compact: false);
        var compact = Write("compact.jzm", 6000, compact: true);
        Assert.Equal(Results(plain), Results(compact));
        Assert.True(new FileInfo(compact).Length < new FileInfo(plain).Length);
        Assert.False(UsesCompactIndexes(plain));
        Assert.True(UsesCompactIndexes(compact));

        // Without a sorted index the file does not use the feature, so it does not name it.
        var unindexed = Path.Combine(_dir, "unindexed.jzm");
        using (var writer = JazminWriter.Create(unindexed, [new JazminColumn("n", JazminType.Int)], new JazminWriteOptions { CompactIndexes = true }))
            writer.WriteValues([1L]);
        Assert.False(UsesCompactIndexes(unindexed));
    }

    [Fact]
    public void Appends_KeepTheFilesEncoding_AndUpdateKeepsItUnlessToldOtherwise()
    {
        var compact = Write("grows-compact.jzm", 3000, compact: true);
        var plain = Write("grows-plain.jzm", 3000, compact: false);
        static List<IReadOnlyDictionary<string, object?>> Rows(int from, int count) => Enumerable.Range(from, count)
            .Select(i => (IReadOnlyDictionary<string, object?>)Columns.Select((c, j) => (c.Name, Row(i)[j])).ToDictionary(p => p.Name, p => p.Item2)).ToList();
        JazminFile.Append(compact, new JazminAppend { Insert = Rows(3000, 2000) });
        JazminFile.Append(plain, new JazminAppend { Insert = Rows(3000, 2000) });
        Assert.Equal(Results(plain), Results(compact));
        Assert.True(UsesCompactIndexes(compact));
        Assert.False(UsesCompactIndexes(plain));

        JazminFile.Compact(compact);
        Assert.True(UsesCompactIndexes(compact));
        JazminFile.Update(compact, new JazminUpdate { Insert = Rows(5000, 10) });
        Assert.True(UsesCompactIndexes(compact));
        JazminFile.Update(compact, new JazminUpdate { CompactIndexes = false });
        Assert.False(UsesCompactIndexes(compact));
        JazminFile.Update(plain, new JazminUpdate { Insert = Rows(5000, 10), CompactIndexes = true });
        Assert.True(UsesCompactIndexes(plain));
        Assert.Equal(Results(plain), Results(compact));
    }
}
