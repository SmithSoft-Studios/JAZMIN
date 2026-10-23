using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

public sealed class UpdateTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-update-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("section", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Float),
    };

    private static Dictionary<string, object?> Row(long id, string? section, double? amount = null) =>
        new() { ["id"] = id, ["section"] = section, ["amount"] = amount };

    private string Write(string name, IEnumerable<Dictionary<string, object?>> rows, JazminWriteOptions? options = null)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        foreach (var row in rows) writer.WriteRow(row);
        return path;
    }

    private static long[] Ids(string path, JazminReadOptions? options = null)
    {
        using var r = JazminReader.Open(path, options);
        return r.Rows().Select(x => (long)x["id"]!).ToArray();
    }

    [Fact]
    public void Unsorted_UpsertInsertDelete_IndexesSurvive()
    {
        var path = Write("a.jzm", new[] { 1L, 2, 3, 4 }.Select(i => Row(i, "A", i)), new JazminWriteOptions { Metadata = new JsonObject { ["v"] = 1 } });
        var result = JazminFile.Update(path, new JazminUpdate
        {
            Upsert = [Row(2, "B", 20), Row(9, "C", 90)],
            KeyColumns = ["id"],
            Insert = [Row(5, "A", 5)],
            Delete = JazminFilter.Eq("id", 4),
            Metadata = new JsonObject { ["v"] = 2 },
        });
        Assert.Equal(new JazminUpdateResult(5, 2, 1, 1), result);
        using var r = JazminReader.Open(path);
        Assert.Equal(new[] { "1A1", "2B20", "3A3", "5A5", "9C90" }, r.Rows().Select(x => $"{x["id"]}{x["section"]}{x["amount"]}"));
        Assert.Equal(2, (int)r.Metadata["v"]!);
        Assert.Equal("index", r.Explain(JazminFilter.Eq("id", 9)).Strategy);
    }

    [Fact]
    public void Writer_EnforcesSortedBy()
    {
        var options = new JazminWriteOptions { SortedBy = ["section"] };
        Assert.Throws<JazminValidationException>(() => Write("bad.jzm", [Row(2, "B"), Row(1, "A")], options));
    }

    [Fact]
    public void Sorted_NewAndChangedRowsLandInSortedPosition()
    {
        var rows = new[] { "A", "B", "D" }.SelectMany((s, i) => new[] { 0, 1 }.Select(n => Row(i * 10 + n, s, n)));
        var path = Write("s.jzm", rows, new JazminWriteOptions { SortedBy = ["section", "id"], ChunkRows = 2 });
        JazminFile.Update(path, new JazminUpdate
        {
            Insert = [Row(30, "C", 1), Row(1, "A", 9)],
            Upsert = [Row(0, "E", 0)], // moves from section A to the end
            KeyColumns = ["id"],
        });
        using var r = JazminReader.Open(path);
        Assert.Equal(new[] { "section", "id" }, r.SortedBy);
        Assert.Equal(new[] { "A1", "A1", "B10", "B11", "C30", "D20", "D21", "E0" }, r.Rows().Select(x => $"{x["section"]}{x["id"]}"));
    }

    private static readonly JazminColumn[] IdAndV = [new("id", JazminType.Int), new("v", JazminType.String)];

    private static Dictionary<string, object?> Iv(long? id, string v) => new() { ["id"] = id, ["v"] = v };

    private string WriteWith(string name, JazminColumn[] columns, IEnumerable<Dictionary<string, object?>> rows)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, columns);
        foreach (var row in rows) writer.WriteRow(row);
        return path;
    }

    private static string[] Texts(string path, Func<JazminRow, string> text, JazminReadOptions? options = null)
    {
        using var r = JazminReader.Open(path, options);
        return r.Rows().Select(text).ToArray();
    }

    private static string IdV(JazminRow row) => $"{row["id"]}{row["v"]}";

    [Fact]
    public void Upsert_TheLastRowForAKeyWins_AsIfTheRowsWereUpsertedOneAfterAnother()
    {
        var path = WriteWith("last.jzm", IdAndV, [Iv(1, "a"), Iv(2, "x")]);
        var result = JazminFile.Update(path, new JazminUpdate { Upsert = [Iv(1, "b"), Iv(1, "c"), Iv(3, "p"), Iv(3, "q")], KeyColumns = ["id"] });
        Assert.Equal(["1c", "2x", "3q"], Texts(path, IdV));
        Assert.Equal(new JazminUpdateResult(3, 1, 1, 0), result);

        // One after another, a new key is added at the end and then replaced where it is.
        JazminFile.Update(path, new JazminUpdate { Upsert = [Iv(4, "d"), Iv(5, "e"), Iv(4, "f")], KeyColumns = ["id"] });
        Assert.Equal(["4f", "5e"], Texts(path, IdV).Skip(3));

        // Keys with empty parts: an empty part matches an empty part.
        JazminColumn[] abv = [new("a", JazminType.Int), new("b", JazminType.String), new("v", JazminType.String)];
        static Dictionary<string, object?> Abv(long? a, string? b, string v) => new() { ["a"] = a, ["b"] = b, ["v"] = v };
        var composite = WriteWith("composite.jzm", abv, [Abv(1, null, "old"), Abv(2, "x", "kept")]);
        var both = JazminFile.Update(composite, new JazminUpdate
        {
            Upsert = [Abv(1, null, "1"), Abv(1, "x", "2"), Abv(1, null, "3"), Abv(null, null, "4"), Abv(2, "y", "5"), Abv(null, null, "6")],
            KeyColumns = ["a", "b"],
        });
        Assert.Equal(["3", "kept", "2", "6", "5"], Texts(composite, r => (string)r["v"]!));
        Assert.Equal(new JazminUpdateResult(5, 3, 1, 0), both);

        var single = WriteWith("single-null.jzm", IdAndV, [Iv(1, "a")]);
        var nulls = JazminFile.Update(single, new JazminUpdate { Upsert = [Iv(null, "n1"), Iv(1, "b"), Iv(null, "n2")], KeyColumns = ["id"] });
        Assert.Equal(["1b", "n2"], Texts(single, IdV));
        Assert.Equal(new JazminUpdateResult(2, 1, 1, 0), nulls);
    }

    [Fact]
    public void Upsert_InASortedFile_TheLastRowForAKeyGoesInAtItsSortedPlace()
    {
        var path = Write("sorted-last.jzm", [Row(1, "B"), Row(2, "D")], new JazminWriteOptions { SortedBy = ["section"] });
        var result = JazminFile.Update(path, new JazminUpdate { Upsert = [Row(1, "E"), Row(9, "F"), Row(1, "A"), Row(9, "C")], KeyColumns = ["id"] });
        Assert.Equal(["A1", "C9", "D2"], Texts(path, r => $"{r["section"]}{r["id"]}"));
        Assert.Equal(new JazminUpdateResult(3, 1, 1, 0), result);
    }

    [Fact]
    public void Upsert_InASharedFile_TheLastRowForAKeyWins_WhenItsRowsAreInDifferentPartitions()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var carol = owner.CreateAccessKey();
        var path = Write("shared-last.jzm", [Row(1, "A", 1), Row(2, "B", 2)], new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["A"] }, new JazminGrant(carol) { Rows = ["B"] }] },
        });
        var result = JazminFile.Update(path, new JazminUpdate
        {
            Key = owner,
            Upsert = [Row(1, "B", 10), Row(3, "A", 30), Row(1, "A", 11), Row(3, "B", 31)],
            KeyColumns = ["id"],
        });
        Assert.Equal(new JazminUpdateResult(3, 1, 1, 0), result);
        static string Text(JazminRow r) => $"{r["id"]}{r["amount"]}";
        Assert.Equal(["111"], Texts(path, Text, new JazminReadOptions { AccessKey = bob }));
        Assert.Equal(["22", "331"], Texts(path, Text, new JazminReadOptions { AccessKey = carol }));
    }

    [Fact]
    public void Upsert_InSeveralTablesAtOnce_TheLastRowForAKeyWinsInEach()
    {
        var path = Path.Combine(_dir, "tables-last.jzm");
        using (var writer = JazminWriter.Create(path, new JazminWriteOptions { Tables = [new JazminTable("first", IdAndV), new JazminTable("second", IdAndV)] }))
        {
            writer.WriteRow(Iv(1, "a"));
            writer.StartTable("second");
            writer.WriteRow(Iv(1, "a"));
        }
        var result = JazminFile.Update(path, new JazminUpdate
        {
            Tables = new Dictionary<string, JazminTableChanges>
            {
                ["first"] = new() { Upsert = [Iv(1, "b"), Iv(1, "c")], KeyColumns = ["id"] },
                ["second"] = new() { Upsert = [Iv(2, "p"), Iv(2, "q")], KeyColumns = ["id"] },
            },
        });
        Assert.Equal((1L, 0L, 1L, 0L), (result.Tables!["first"].RowCount, result.Tables["first"].Inserted, result.Tables["first"].Updated, result.Tables["first"].Deleted));
        Assert.Equal(new JazminUpdateResult(2, 1, 0, 0), result.Tables["second"]);
        Assert.Equal(["1c"], Texts(path, IdV, new JazminReadOptions { Table = "first" }));
        Assert.Equal(["1a", "2q"], Texts(path, IdV, new JazminReadOptions { Table = "second" }));
    }

    [Fact]
    public void Encrypted_StaysProtected_AndFailedUpdateLeavesFileUntouched()
    {
        var key = JazminKey.Generate();
        var path = Write("k.jzm", [Row(1, "A")], new JazminWriteOptions { Key = key });
        var before = File.ReadAllBytes(path);
        Assert.Throws<JazminKeyException>(() => JazminFile.Update(path, new JazminUpdate { Key = JazminKey.Generate(), Insert = [Row(2, "B")] }));
        Assert.ThrowsAny<JazminException>(() => JazminFile.Update(path, new JazminUpdate
        {
            Key = key,
            Insert = [new Dictionary<string, object?> { ["id"] = "not a number" }],
        }));
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.Equal(new[] { "k.jzm" }, Directory.GetFiles(_dir).Select(Path.GetFileName));
        JazminFile.Update(path, new JazminUpdate { Key = key, Insert = [Row(2, "B")] });
        Assert.Equal(new[] { 1L, 2 }, Ids(path, new JazminReadOptions { Key = key }));

        var pw = Write("p.jzm", [Row(1, "A")], new JazminWriteOptions { Password = "secret", KdfIterations = 1000 });
        JazminFile.Update(pw, new JazminUpdate { Password = "secret", Insert = [Row(2, "A")] });
        using var r = JazminReader.Open(pw, new JazminReadOptions { Password = "secret" });
        Assert.Equal(1000, r.KdfIterations);
        Assert.Equal(2, r.RowCount);
    }

    [Fact]
    public void AccessControlled_OnlyOwnerUpdates_GrantAndRevokeReissueAccess()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var carol = owner.CreateAccessKey();
        var path = Write("acl.jzm", [Row(1, "A"), Row(2, "B")], new JazminWriteOptions
        {
            Key = owner,
            SortedBy = ["section"],
            Access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["A"], Label = "Bob" }] },
        });
        Assert.Equal(new[] { 1L }, Ids(path, new JazminReadOptions { AccessKey = bob }));

        JazminFile.Update(path, new JazminUpdate { Key = owner, Insert = [Row(3, "A"), Row(4, "C")] });
        Assert.Equal(new[] { 1L, 3 }, Ids(path, new JazminReadOptions { AccessKey = bob }));
        Assert.Equal(new[] { 1L, 3, 2, 4 }, Ids(path, new JazminReadOptions { Key = owner }));

        JazminFile.GrantAccess(path, owner, new JazminGrant(carol) { Label = "Carol" });
        Assert.Equal(new[] { 1L, 3, 2, 4 }, Ids(path, new JazminReadOptions { AccessKey = carol }));
        JazminFile.RevokeAccess(path, owner, bob);
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(path, new JazminReadOptions { AccessKey = bob }));
        using var r = JazminReader.Open(path, new JazminReadOptions { Key = owner });
        Assert.Equal(new[] { "Carol" }, r.Access!.Grants!.Select(g => g.Label));
    }
}
