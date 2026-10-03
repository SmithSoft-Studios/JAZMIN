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
