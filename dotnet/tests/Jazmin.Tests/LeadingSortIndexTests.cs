using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// A sorted index on the leading SortedBy column is not written: readers find that column's values from chunk statistics
/// and have never used such an index (spec 6.7). Other indexes, and a trigram index on that column, are.
/// </summary>
public sealed class LeadingSortIndexTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-leading-sort-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static readonly JazminColumn[] Columns =
    [
        new("code", JazminType.String) { Nullable = false, Indexes = [JazminIndexKind.Sorted, JazminIndexKind.Trigram] },
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Float),
    ];

    private static object?[] Row(int i) => [$"C{i:D5}", (long)(i * 7919 % 100_003), i / 4.0];

    [Fact]
    public void LeadingSortColumn_GetsNoSortedIndex_AndQueriesFindTheSameRows_BeforeAndAfterAnAppend()
    {
        var path = Path.Combine(_dir, "codes.jzm");
        var rows = Enumerable.Range(0, 1500).Select(Row).ToList();
        using (var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions { SortedBy = ["code"], ChunkRows = 100 }))
            foreach (var row in rows) writer.WriteValues(row);

        void Check()
        {
            using var reader = JazminReader.Open(path);
            Assert.Equal(["code/Trigram", "id/Sorted"], reader.Indexes.Select(i => $"{i.Column}/{i.Kind}").Order(StringComparer.Ordinal));
            var queries = new (JazminFilter Filter, Func<object?[], bool> Test)[]
            {
                (JazminFilter.Eq("code", "C00500"), r => (string)r[0]! == "C00500"),
                (JazminFilter.And(JazminFilter.Gte("code", "C00100"), JazminFilter.Lt("code", "C00230")),
                    r => string.CompareOrdinal((string)r[0]!, "C00100") >= 0 && string.CompareOrdinal((string)r[0]!, "C00230") < 0),
                (JazminFilter.Contains("code", "0050"), r => ((string)r[0]!).Contains("0050", StringComparison.Ordinal)),
                (JazminFilter.StartsWith("code", "C014"), r => ((string)r[0]!).StartsWith("C014", StringComparison.Ordinal)),
                (JazminFilter.Lt("id", 500L), r => (long)r[1]! < 500),
            };
            foreach (var (filter, test) in queries)
                Assert.Equal(rows.Where(test).Select(r => (string)r[0]!), reader.Find(filter).Select(r => (string)r["code"]!));
            // Chunk statistics locate the value: every chunk but the one holding it is skipped.
            var plan = reader.Explain(JazminFilter.Eq("code", "C00500"));
            Assert.Equal(1, plan.Chunks - plan.ChunksSkipped);
        }

        Check();
        var more = Enumerable.Range(1500, 300).Select(Row).ToList();
        JazminFile.Append(path, new JazminAppend { Insert = more.Select(r => (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?> { ["code"] = r[0], ["id"] = r[1], ["amount"] = r[2] }).ToList() });
        rows.AddRange(more);
        Check();
    }
}
