using System.Globalization;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// A row's values read by name are those read by position, for narrow and wide rows and every way of reading rows.
/// Names match exactly; a name the row does not hold is not found.
/// </summary>
public sealed class RowLookupTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-row-lookup-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static readonly string[] Countries = ["ZA", "NA", "BW"];

    // Wide enough that a row looks names up rather than checking each one, with names of several lengths.
    private static readonly JazminColumn[] Columns =
    [
        new("country", JazminType.String) { Nullable = false },
        new("id", JazminType.Int) { Nullable = false },
        .. Enumerable.Range(0, 18).Select(j => new JazminColumn(j % 2 == 0 ? $"amount_{j}" : $"n{j}", j % 3 == 0 ? JazminType.String : JazminType.Int)),
        new("balance", JazminType.Decimal),
    ];

    private static readonly string[] Names = Columns.Select(c => c.Name).ToArray();

    private static object?[] Row(int i) =>
    [
        Countries[i % 3], (long)i,
        .. Enumerable.Range(0, 18).Select(j => i % 7 == j % 7 ? null : j % 3 == 0 ? $"s{i}-{j}" : (object)(long)(i * 31 + j)),
        $"{i}.25",
    ];

    private string Write(string name, JazminAccessOptions? access = null, JazminKey? key = null)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions { ChunkRows = 100, Key = key, Access = access });
        for (var i = 0; i < 300; i++) writer.WriteValues(Row(i));
        return path;
    }

    /// <summary>Every value by name (the caller's own copy of the name) equals the value at its position and the one written.</summary>
    private static void AssertByName(JazminRow row, IReadOnlyList<string> names)
    {
        Assert.Equal(names, row.Keys);
        var written = Row((int)row.RowId);
        for (var k = 0; k < names.Count; k++)
        {
            var name = new string(names[k].AsSpan());
            Assert.Equal(row[k], row[name]);
            Assert.True(row.TryGetValue(name, out var value));
            Assert.Equal(row[k], value);
            Assert.True(row.ContainsKey(name));
            Assert.Equal(Convert.ToString(written[Array.IndexOf(Names, name)], CultureInfo.InvariantCulture), Convert.ToString(value, CultureInfo.InvariantCulture));
        }
        foreach (var other in Names.Except(names).Append("ID").Append("missing").Append(null!)) // not selected, another case, absent
        {
            Assert.False(row.ContainsKey(other));
            Assert.False(row.TryGetValue(other, out var none));
            Assert.Null(none);
            Assert.Throws<KeyNotFoundException>(() => row[other]);
        }
    }

    [Fact]
    public void WideAndNarrowRows_ReadByName_AsByPosition()
    {
        var path = Write("rows.jzm");
        using var reader = JazminReader.Open(path);

        var all = reader.Rows().ToList();
        Assert.Equal(300, all.Count);
        foreach (var row in all) AssertByName(row, Names);
        AssertByName(reader.Get(123), Names);

        string[] wide = [.. Names.Reverse().Take(12)]; // not in file order
        string[] narrow = ["balance", "n17", "country"];
        string[] twice = ["id", "balance", "id"]; // the same column selected twice
        foreach (var select in new[] { wide, narrow, twice })
        {
            var rows = reader.Find(JazminFilter.Eq("country", "NA"), new JazminQueryOptions { Select = select }).ToList();
            Assert.Equal(100, rows.Count);
            foreach (var row in rows) AssertByName(row, select);
        }
    }

    [Fact]
    public void SharedFileRows_ReadVisibleColumnsByName_AndNotHiddenOnes()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Write("shared.jzm", new JazminAccessOptions
        {
            PartitionBy = "country",
            ColumnGroups = new() { ["money"] = ["balance"] },
            Grants = [new JazminGrant(bob) { Rows = ["NA", "BW"], Columns = ["*"] }], // the default group only: balance hidden
        }, owner);

        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = owner }))
        {
            foreach (var row in reader.Rows()) AssertByName(row, Names);
            AssertByName(reader.Get(7), Names);
        }
        using (var reader = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob }))
        {
            var rows = reader.Rows().ToList();
            Assert.Equal(200, rows.Count);
            foreach (var row in rows) AssertByName(row, Names[..^1]);
        }
    }

    [Fact]
    public void RowsReadOnSeveralThreads_ReadByName_AsByPosition()
    {
        var path = Write("threads.jzm");
        for (var attempt = 0; attempt < 20; attempt++)
        {
            using var reader = JazminReader.Open(path); // the rows' name lookup is built on the first read by name, by any thread
            var rows = reader.Rows().ToList();
            Parallel.ForEach(rows, new ParallelOptions { MaxDegreeOfParallelism = 8 }, row => AssertByName(row, Names));
        }
    }
}
