using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Limits per key on what a key may send back (spec 7.9.1): a grant's Edit narrows the document's package.edit for its
/// key; writers store the settings as editByKey and name the writer feature edit-limits while a limit narrows something;
/// WriteChanges and ApplyChanges keep each key to its limit; a limit an older release lost allows nothing. Mirrors
/// js/test/edit-limits.test.js.
/// </summary>
public class EditLimitsTests
{
    private static readonly JazminColumn[] Columns =
    [
        new("ack", JazminType.String) { Nullable = false },
        new("ward", JazminType.String) { Nullable = false },
        new("result", JazminType.String),
        new("ackAction", JazminType.String),
        new("ackNote", JazminType.String),
    ];

    private static readonly JazminEditSettings Edit = new() { Key = ["ack"], Columns = ["ward", "ackAction", "ackNote"], Add = true, Delete = true };
    private static readonly JazminEditLimit IpcLimit = new() { Columns = ["ackNote"], Add = false, Delete = false };
    private static readonly JazminFileInput Doc = new("index.html", Encoding.UTF8.GetBytes("<p>critical results</p>"));

    private static Dictionary<string, object?> Row(string ack, string ward, string result) =>
        new() { ["ack"] = ack, ["ward"] = ward, ["result"] = result, ["ackAction"] = null, ["ackNote"] = null };

    private static readonly Dictionary<string, object?>[] Acks = [Row("A-1", "W1", "K+ 6.9"), Row("A-2", "W1", "Hb 6.1"), Row("A-3", "W2", "Na 118")];

    private sealed record Hospital(string File, JazminKey Owner, JazminAccessKey Doctor, JazminAccessKey Ipc);

    private static Hospital Make(Func<JazminAccessKey, JazminAccessKey, List<JazminGrant>>? grants = null, JazminEditSettings? edit = null,
        Dictionary<string, string[]>? columnGroups = null, bool noEdit = false)
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-edit-limits-").FullName, "acks.jzm");
        var owner = JazminKey.Generate();
        var doctor = owner.CreateAccessKey();
        var ipc = owner.CreateAccessKey();
        using var writer = JazminWriter.Create(file, Columns, new JazminWriteOptions
        {
            Key = owner,
            Files = [Doc],
            Package = new JazminPackage { Entry = "index.html", Edit = noEdit ? null : edit ?? Edit },
            Access = new JazminAccessOptions
            {
                PartitionBy = "ward",
                ColumnGroups = columnGroups ?? new(),
                Grants = grants?.Invoke(doctor, ipc) ??
                [
                    new JazminGrant(doctor) { Label = "Doctor" },
                    new JazminGrant(ipc) { Label = "Infection control", Edit = IpcLimit },
                ],
            },
        });
        foreach (var row in Acks) writer.WriteRow(row);
        return new Hospital(file, owner, doctor, ipc);
    }

    private static JazminReader As(string file, JazminAccessKey key) => JazminReader.Open(file, new JazminReadOptions { AccessKey = key, AccessState = null });

    private static Dictionary<string, JazminGrantInfo> GrantsOf(string file, JazminKey owner)
    {
        using var r = JazminReader.Open(file, new JazminReadOptions { Key = owner });
        return r.Access!.Grants!.ToDictionary(g => g.Label ?? g.KeyId);
    }

    private static IReadOnlyList<string> FeaturesOf(string file, JazminKey owner)
    {
        using var r = JazminReader.Open(file, new JazminReadOptions { Key = owner });
        return r.WriterFeatures;
    }

    private static Dictionary<string, JazminRow> RowsOf(string file, JazminKey owner)
    {
        using var r = JazminReader.Open(file, new JazminReadOptions { Key = owner });
        return r.Rows().ToDictionary(x => (string)x["ack"]!);
    }

    private static string Show(JazminEditLimit? limit) => limit is null ? "none" : Changes.EditLimitJson(limit).ToJsonString();

    private static string Show(JazminEditSettings? edit) => edit is null ? "null"
        : $"{string.Join(",", edit.Key)}|{string.Join(",", edit.Columns)}|{edit.Add}|{edit.Delete}";

    /// <summary>A change file made by hand with a key's submission key: a sender who bypasses WriteChanges.</summary>
    private static byte[] Forged(string file, JazminAccessKey key, params Dictionary<string, object?>[] rows)
    {
        using var r = As(file, key);
        string[] names = ["ward", "ackAction", "ackNote"];
        var columns = new List<JazminColumn> { new("jazmin.op", JazminType.String) { Nullable = false }, new("jazmin.set", JazminType.Json), new("ack", JazminType.String) { Nullable = false } };
        foreach (var n in names) columns.AddRange([new JazminColumn(n, JazminType.String), new JazminColumn($"jazmin.before.{n}", JazminType.String)]);
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, columns, new JazminWriteOptions
        {
            Key = r.SubmissionKey,
            Metadata = new JsonObject
            {
                ["jazmin.changes"] = new JsonObject
                {
                    ["version"] = 1, ["file"] = r.FileId, ["table"] = r.TableName, ["key"] = new JsonArray("ack"),
                    ["columns"] = new JsonArray(names.Select(n => (JsonNode?)n).ToArray()), ["sender"] = r.Access!.KeyId,
                },
            },
        }, leaveOpen: true))
        {
            foreach (var row in rows)
            {
                var full = names.SelectMany(n => new[] { n, $"jazmin.before.{n}" }).ToDictionary(n => n, _ => (object?)null);
                foreach (var (name, value) in row) full[name] = value;
                writer.WriteRow(full);
            }
        }
        return stream.ToArray();
    }

    private static Dictionary<string, object?> Change(string op, string ack, string[]? set, params (string Name, object? Value)[] values)
    {
        var row = new Dictionary<string, object?> { ["jazmin.op"] = op, ["jazmin.set"] = set is null ? null : new JsonArray(set.Select(s => (JsonNode?)s).ToArray()), ["ack"] = ack };
        foreach (var (name, value) in values) row[name] = value;
        return row;
    }

    private static Dictionary<string, object?> Update(string ack, string column, string value) => new() { ["ack"] = ack, [column] = value };

    [Fact]
    public void AFileWithoutLimits_IsWrittenAsBefore()
    {
        var h = Make((d, i) => [new JazminGrant(d) { Label = "Doctor" }, new JazminGrant(i) { Label = "Infection control" }]);
        Assert.Empty(FeaturesOf(h.File, h.Owner));
        Assert.All(GrantsOf(h.File, h.Owner).Values, g => Assert.True(g.Edit is null && !g.EditLost && !g.EditUnreadable));
        using (var r = As(h.File, h.Ipc))
        {
            Assert.Null(r.Access!.Edit);
            Assert.False(r.Access.EditLost);
            Assert.Equal(Show(Edit), Show(r.Edit));
        }
        // A limit that narrows nothing is not kept.
        var same = Make((d, i) => [new JazminGrant(d), new JazminGrant(i) { Label = "ipc", Edit = new JazminEditLimit { Columns = Edit.Columns, Add = true, Delete = true } }]);
        Assert.Empty(FeaturesOf(same.File, same.Owner));
        Assert.Null(GrantsOf(same.File, same.Owner)["ipc"].Edit);
    }

    [Fact]
    public void ALimit_NarrowsTheDocument_ForItsKey()
    {
        var h = Make();
        Assert.Equal(["edit-limits"], FeaturesOf(h.File, h.Owner));
        var grants = GrantsOf(h.File, h.Owner);
        Assert.Null(grants["Doctor"].Edit);
        Assert.False(grants["Doctor"].EditLost);
        Assert.Equal(Show(IpcLimit), Show(grants["Infection control"].Edit));
        using (var ipc = As(h.File, h.Ipc))
        {
            Assert.Equal(Show(Edit), Show(ipc.Package!.Edit)); // the document's settings, from editByKey
            Assert.Equal(Show(IpcLimit), Show(ipc.Access!.Edit));
            Assert.Equal("ack|ackNote|False|False", Show(ipc.Edit));
        }
        using var doctor = As(h.File, h.Doctor);
        Assert.Null(doctor.Access!.Edit);
        Assert.Equal(Show(Edit), Show(doctor.Edit));
    }

    [Fact]
    public void WriteChanges_KeepsTheSenderToItsLimit_AndApplyChangesAppliesWhatItAllows()
    {
        var h = Make();
        byte[] note;
        using (var ipc = As(h.File, h.Ipc))
        {
            Assert.Equal("Column 'ackAction' can't be changed with this key",
                Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(ipc, new JazminChanges { Update = [Update("A-1", "ackAction", "acknowledged")] })).Message);
            Assert.Equal("This key can't add rows",
                Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(ipc, new JazminChanges { Add = [new Dictionary<string, object?> { ["ack"] = "A-9", ["ward"] = "W1", ["ackNote"] = "x" }] })).Message);
            Assert.Equal("This key can't delete rows",
                Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(ipc, new JazminChanges { Delete = [new Dictionary<string, object?> { ["ack"] = "A-1" }] })).Message);
            note = JazminFile.WriteChanges(ipc, new JazminChanges { Update = [Update("A-1", "ackNote", "isolation started")] });
        }
        using (var change = JazminReader.Open(note, new JazminReadOptions { Key = h.Owner.SubmissionKey(h.Ipc.Id) }))
            Assert.Equal(["ackNote"], change.Metadata!["jazmin.changes"]!["columns"]!.AsArray().Select(n => (string)n!).ToList());
        var result = JazminFile.ApplyChanges(h.File, note, new JazminApplyChangesOptions { Key = h.Owner });
        Assert.Equal((1L, 0L, 0L, 0), (result.Updated, result.Added, result.Deleted, result.Refused.Count));
        byte[] acked;
        using (var doctor = As(h.File, h.Doctor))
            acked = JazminFile.WriteChanges(doctor, new JazminChanges { Update = [Update("A-1", "ackAction", "acknowledged")], Delete = [new Dictionary<string, object?> { ["ack"] = "A-2" }] });
        result = JazminFile.ApplyChanges(h.File, acked, new JazminApplyChangesOptions { Key = h.Owner });
        Assert.Equal((1L, 1L, 0), (result.Updated, result.Deleted, result.Refused.Count));
        var rows = RowsOf(h.File, h.Owner);
        Assert.Equal(("acknowledged", "isolation started", false), ((string?)rows["A-1"]["ackAction"], (string?)rows["A-1"]["ackNote"], rows.ContainsKey("A-2")));
    }

    [Fact]
    public void ApplyChanges_RefusesAHandMadeChangeFileOutsideTheLimit_AlsoWithOverwrite()
    {
        var h = Make();
        var change = Forged(h.File, h.Ipc,
            Change("update", "A-1", ["ackAction"], ("ackAction", "acknowledged")),
            Change("add", "A-9", ["ward", "ackNote"], ("ward", "W1"), ("ackNote", "x")),
            Change("delete", "A-2", null),
            Change("update", "A-3", ["ackNote"], ("ackNote", "allowed")));
        string[] refused =
        [
            "update A-1: column 'ackAction' can't be changed by this sender",
            "add A-9: this sender's grant doesn't allow adding rows",
            "delete A-2: this sender's grant doesn't allow deleting rows",
        ];
        static string[] Refusals(JazminChangesResult r) => r.Refused.Select(x => $"{x.Op} {x.Key["ack"]}: {x.Reason}").ToArray();
        Assert.Equal(refused, Refusals(JazminFile.ApplyChanges(h.File, change, new JazminApplyChangesOptions { Key = h.Owner, DryRun = true })));
        var result = JazminFile.ApplyChanges(h.File, change, new JazminApplyChangesOptions { Key = h.Owner, Overwrite = true });
        Assert.Equal((1L, 0L, 0L), (result.Updated, result.Added, result.Deleted));
        Assert.Equal(refused, Refusals(result));
        var rows = RowsOf(h.File, h.Owner);
        Assert.Equal((null, true, "allowed", false), ((string?)rows["A-1"]["ackAction"], rows.ContainsKey("A-2"), (string?)rows["A-3"]["ackNote"], rows.ContainsKey("A-9")));
    }

    [Fact]
    public void AReadOnlyKey_MaySendNothing()
    {
        var h = Make((d, i) => [new JazminGrant(d), new JazminGrant(i) { Label = "ipc", Edit = new JazminEditLimit { Columns = [], Add = false, Delete = false } }]);
        using (var ipc = As(h.File, h.Ipc))
        {
            Assert.Equal("ack||False|False", Show(ipc.Edit));
            Assert.Equal("This key can't send changes to this document",
                Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(ipc, new JazminChanges { Update = [Update("A-1", "ackNote", "x")] })).Message);
        }
        var result = JazminFile.ApplyChanges(h.File, Forged(h.File, h.Ipc, Change("update", "A-1", ["ackNote"], ("ackNote", "x"))), new JazminApplyChangesOptions { Key = h.Owner });
        Assert.Equal("column 'ackNote' can't be changed by this sender", Assert.Single(result.Refused).Reason);
    }

    [Fact]
    public void ALimitGivenWithAGrant_MayOnlyNarrow()
    {
        string Refused(JazminEditLimit limit, JazminEditSettings? edit = null, Dictionary<string, string[]>? groups = null, IReadOnlyList<string>? columns = null) =>
            Assert.Throws<JazminValidationException>(() => Make((d, i) => [new JazminGrant(d), new JazminGrant(i) { Columns = columns, Edit = limit }], edit, groups)).Message;
        Assert.Equal("grant 1: edit can only narrow the document's: 'result' isn't an editable column", Refused(new JazminEditLimit { Columns = ["result"] }));
        Assert.Equal("grant 1: edit can only narrow the document's: the document doesn't allow adding rows",
            Refused(new JazminEditLimit { Add = true }, new JazminEditSettings { Key = ["ack"], Columns = ["ackNote"] }));
        Assert.Equal("grant 1: edit can only narrow the document's: the document doesn't allow deleting rows",
            Refused(new JazminEditLimit { Delete = true }, new JazminEditSettings { Key = ["ack"], Columns = ["ackNote"] }));
        Assert.Equal("grant 1: edit.columns names a column twice", Refused(new JazminEditLimit { Columns = ["ackNote", "ackNote"] }));
        Assert.Equal("grant 1: edit.columns: 'ackAction' isn't in a column group this key sees",
            Refused(new JazminEditLimit { Columns = ["ackAction"] }, groups: new() { ["clinical"] = ["ackAction"] }, columns: ["*"]));
    }

    [Fact]
    public void Limits_AreCarriedByUpdateCompactAppendGrantAccessAndANewOwnerKey()
    {
        var h = Make();
        string LimitOf(JazminKey owner) => Show(GrantsOf(h.File, owner)["Infection control"].Edit);
        JazminFile.Update(h.File, new JazminUpdate { Key = h.Owner, Insert = [Row("A-4", "W2", "pH 7.0")] });
        Assert.Equal(Show(IpcLimit), LimitOf(h.Owner));
        JazminFile.Compact(h.File, h.Owner);
        Assert.Equal(Show(IpcLimit), LimitOf(h.Owner));
        JazminFile.Append(h.File, new JazminAppend { Key = h.Owner, Insert = [Row("A-5", "W1", "Glu 1.9")] });
        Assert.Equal(Show(IpcLimit), LimitOf(h.Owner));
        JazminFile.GrantAccess(h.File, h.Owner, new JazminGrant(h.Ipc) { Rows = ["W1"], Label = "Infection control" }); // given again: the limit is kept
        Assert.Equal(Show(IpcLimit), LimitOf(h.Owner));
        Assert.Equal(["edit-limits"], FeaturesOf(h.File, h.Owner));

        var rotation = JazminFile.RotateOwnerKey(h.File, h.Owner);
        Assert.Equal(Show(IpcLimit), LimitOf(rotation.OwnerKey));
        var newIpc = rotation.AccessKeys.Single(k => k.Label == "Infection control").Key;
        using (var ipc = As(h.File, newIpc)) Assert.Equal(Show(IpcLimit), Show(ipc.Access!.Edit));

        JazminFile.GrantAccess(h.File, rotation.OwnerKey, new JazminGrant(newIpc) { Label = "Infection control", Edit = JazminEditLimit.None }); // removed
        Assert.Equal("none", LimitOf(rotation.OwnerKey));
        Assert.Empty(FeaturesOf(h.File, rotation.OwnerKey));
    }

    [Fact]
    public void Append_MayNarrowOrWidenALimit()
    {
        var h = Make((d, i) => [new JazminGrant(d), new JazminGrant(i) { Label = "ipc" }]);
        Assert.Empty(FeaturesOf(h.File, h.Owner));
        JazminFile.Append(h.File, new JazminAppend { Key = h.Owner, Grant = [new JazminGrant(h.Ipc) { Label = "ipc", Edit = IpcLimit }] });
        Assert.Equal(Show(IpcLimit), Show(GrantsOf(h.File, h.Owner)["ipc"].Edit));
        Assert.Equal(["edit-limits"], FeaturesOf(h.File, h.Owner));
        using (var ipc = As(h.File, h.Ipc))
            Assert.Contains("can't be changed with this key", Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(ipc, new JazminChanges { Update = [Update("A-1", "ackAction", "x")] })).Message);
        JazminFile.Append(h.File, new JazminAppend { Key = h.Owner, Grant = [new JazminGrant(h.Ipc) { Label = "ipc", Edit = new JazminEditLimit { Columns = ["ackAction", "ackNote"] } }] });
        Assert.Equal("{\"columns\":[\"ackAction\",\"ackNote\"]}", Show(GrantsOf(h.File, h.Owner)["ipc"].Edit));
    }

    [Fact]
    public void ALimitAnOlderReleaseLost_AllowsNothing_UntilGrantedAgainWithALimit()
    {
        // What an append by a release that doesn't know limits leaves: editByKey, the grant without edit.
        var h = Make((d, i) => [new JazminGrant(d) { Label = "Doctor" }, new JazminGrant(i) { Label = "ipc", EditLost = true }]);
        Assert.Equal(["edit-limits"], FeaturesOf(h.File, h.Owner));
        Assert.True(GrantsOf(h.File, h.Owner)["ipc"].EditLost);
        using (var ipc = As(h.File, h.Ipc))
        {
            Assert.True(ipc.Access!.EditLost);
            Assert.Equal("ack||False|False", Show(ipc.Edit));
            Assert.Equal("This key's limits were lost: ask the file's owner to grant it again",
                Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(ipc, new JazminChanges { Update = [Update("A-1", "ackNote", "x")] })).Message);
        }
        var change = Forged(h.File, h.Ipc, Change("update", "A-1", ["ackNote"], ("ackNote", "x")));
        Assert.Equal("this sender's limits were lost when an older release rewrote the file: grant the key again",
            Assert.Single(JazminFile.ApplyChanges(h.File, change, new JazminApplyChangesOptions { Key = h.Owner }).Refused).Reason);

        JazminFile.Compact(h.File, h.Owner);
        JazminFile.GrantAccess(h.File, h.Owner, new JazminGrant(h.Ipc) { Rows = ["W1"], Label = "ipc" });
        Assert.True(GrantsOf(h.File, h.Owner)["ipc"].EditLost);
        JazminFile.GrantAccess(h.File, h.Owner, new JazminGrant(h.Ipc) { Label = "ipc", Edit = IpcLimit });
        var mended = GrantsOf(h.File, h.Owner)["ipc"];
        Assert.Equal((false, Show(IpcLimit)), (mended.EditLost, Show(mended.Edit)));
        Assert.Equal(1, JazminFile.ApplyChanges(h.File, change, new JazminApplyChangesOptions { Key = h.Owner }).Updated);
    }

    [Fact]
    public void TheDocumentWithoutEditSettings_KeepsTheLimits()
    {
        var h = Make();
        JazminFile.Update(h.File, new JazminUpdate { Key = h.Owner, Package = new JazminPackage { Entry = "index.html" } });
        Assert.Equal(Show(IpcLimit), Show(GrantsOf(h.File, h.Owner)["Infection control"].Edit));
        Assert.Equal(["edit-limits"], FeaturesOf(h.File, h.Owner));
        using (var ipc = As(h.File, h.Ipc)) Assert.Null(ipc.Edit);
        JazminFile.Update(h.File, new JazminUpdate { Key = h.Owner, Package = new JazminPackage { Entry = "index.html", Edit = Edit } });
        using (var ipc = As(h.File, h.Ipc)) Assert.Equal("ack|ackNote|False|False", Show(ipc.Edit));
    }
}
