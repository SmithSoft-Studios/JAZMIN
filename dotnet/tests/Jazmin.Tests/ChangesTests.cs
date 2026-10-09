using System.Text;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Editable documents (spec 7.9): package.edit checked by writers; change files made from an open file and applied to
/// it; rows changed since the sender's copy held unless overwritten; a shared file's senders limited to their grant.
/// Mirrors js/test/changes.test.js.
/// </summary>
public class ChangesTests
{
    private static readonly JazminColumn[] Columns =
    [
        new("claim", JazminType.String) { Nullable = false },
        new("region", JazminType.String) { Nullable = false },
        new("status", JazminType.String),
        new("amount", JazminType.Decimal),
        new("due", JazminType.DateTime),
        new("note", JazminType.String),
        new("internal", JazminType.String),
    ];

    private static readonly JazminEditSettings Edit = new() { Key = ["claim"], Columns = ["region", "status", "amount", "due", "note"], Add = true, Delete = true };
    private static readonly DateTime Due = new(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);

    private static IReadOnlyDictionary<string, object?> Row(params (string Name, object? Value)[] values) =>
        values.ToDictionary(v => v.Name, v => v.Value);

    private static readonly IReadOnlyDictionary<string, object?>[] Claims =
    [
        Row(("claim", "C-1"), ("region", "A"), ("status", "open"), ("amount", "100.50"), ("due", Due), ("note", null), ("internal", "x")),
        Row(("claim", "C-2"), ("region", "A"), ("status", "open"), ("amount", "20.00"), ("due", null), ("note", "call back"), ("internal", "y")),
        Row(("claim", "C-3"), ("region", "B"), ("status", "closed"), ("amount", "7.25"), ("due", null), ("note", null), ("internal", "z")),
    ];

    private static readonly JazminFileInput Doc = new("index.html", Encoding.UTF8.GetBytes("<p>claims</p>"));

    private static string Temp() => Directory.CreateTempSubdirectory("jazmin-changes-").FullName;

    private static void WriteFile(string path, JazminWriteOptions options)
    {
        using var writer = JazminWriter.Create(path, Columns, options);
        foreach (var row in Claims) writer.WriteRow(row);
    }

    private static Dictionary<string, JazminRow> RowsOf(string path, JazminReadOptions? options = null)
    {
        using var reader = JazminReader.Open(path, options);
        return reader.Rows().ToDictionary(r => (string)r["claim"]!);
    }

    [Fact]
    public void Edit_IsChecked_ByWriters_AndReadBack()
    {
        byte[] With(JazminEditSettings edit)
        {
            var stream = new MemoryStream();
            using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions { Files = [Doc], Package = new JazminPackage { Entry = "index.html", Edit = edit } }, leaveOpen: true))
                foreach (var row in Claims) writer.WriteRow(row);
            return stream.ToArray();
        }
        using (var reader = JazminReader.Open(With(Edit)))
        {
            var edit = reader.Package!.Edit!;
            Assert.Equal(["claim"], edit.Key);
            Assert.Equal(Edit.Columns, edit.Columns);
            Assert.True(edit.Add && edit.Delete);
        }
        Assert.Contains("identify a row", Assert.Throws<JazminValidationException>(() => With(new JazminEditSettings { Columns = ["note"] })).Message);
        Assert.Contains("'claim' is a key column", Assert.Throws<JazminValidationException>(() => With(new JazminEditSettings { Key = ["claim"], Columns = ["claim"] })).Message);
        Assert.Contains("allows nothing", Assert.Throws<JazminValidationException>(() => With(new JazminEditSettings { Key = ["claim"] })).Message);
        Assert.Contains("package.edit.key: no column 'nope'", Assert.Throws<JazminValidationException>(() => With(new JazminEditSettings { Key = ["nope"], Columns = ["note"] })).Message);
        Assert.Contains("package.edit.columns: no column 'nope'", Assert.Throws<JazminValidationException>(() => With(new JazminEditSettings { Key = ["claim"], Columns = ["nope"] })).Message);
        Assert.Contains("no table 'other'", Assert.Throws<JazminValidationException>(() => With(new JazminEditSettings { Key = ["claim"], Columns = ["note"], Table = "other" })).Message);
        Assert.Contains("column 'region' can't be empty, so added rows must set it",
            Assert.Throws<JazminValidationException>(() => With(new JazminEditSettings { Key = ["claim"], Columns = ["note"], Add = true })).Message);
        var jsonKey = Assert.Throws<JazminValidationException>(() =>
        {
            using var writer = new JazminWriter(new MemoryStream(), [new JazminColumn("k", JazminType.Json), new JazminColumn("v", JazminType.String)],
                new JazminWriteOptions { Files = [Doc], Package = new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Key = ["k"], Columns = ["v"] } } });
            writer.WriteRow(Row(("k", "1"), ("v", "a")));
        });
        Assert.Contains("'k' is a json column; keys are", jsonKey.Message);
    }

    [Fact]
    public void OwnFile_ChangesAdditionsAndDeletions_AreWritten_WithTheirTypes_ADryRunWritesNothing()
    {
        var path = Path.Combine(Temp(), "claims.jzm");
        var key = JazminKey.Generate();
        WriteFile(path, new JazminWriteOptions { Key = key, Files = [Doc], Package = new JazminPackage { Entry = "index.html", Edit = Edit } });
        byte[] change;
        using (var source = JazminReader.Open(path, new JazminReadOptions { Key = key }))
        {
            var changes = new JazminChanges
            {
                Update = [Row(("claim", "C-1"), ("status", "paid"), ("amount", "99.95"), ("due", new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc)))],
                Add = [Row(("claim", "C-9"), ("region", "B"), ("status", "new"), ("note", "from the document"))],
                Delete = [Row(("claim", "C-2"))],
            };
            Assert.Contains("Give the key or password", Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(source, changes)).Message);
            change = JazminFile.WriteChanges(source, changes, key);
        }
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(change));

        var dry = JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Key = key, DryRun = true });
        Assert.Equal((null, false, 1L, 1L, 1L, 0, 0), (dry.Sender, dry.FileChanged, dry.Updated, dry.Added, dry.Deleted, dry.Conflicts.Count, dry.Refused.Count));
        Assert.Equal("open", RowsOf(path, new JazminReadOptions { Key = key })["C-1"]["status"]);

        var applied = JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Key = key });
        Assert.Equal((1L, 1L, 1L), (applied.Updated, applied.Added, applied.Deleted));
        var after = RowsOf(path, new JazminReadOptions { Key = key });
        Assert.Equal(new[] { "C-1", "C-3", "C-9" }, after.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(("paid", "99.95", new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc), "x"), ((string)after["C-1"]["status"]!, (string)after["C-1"]["amount"]!, ((DateTime)after["C-1"]["due"]!).ToUniversalTime(), (string)after["C-1"]["internal"]!));
        Assert.Equal(("B", "new", null, "from the document", null), ((string)after["C-9"]["region"]!, (string)after["C-9"]["status"]!, after["C-9"]["amount"], (string)after["C-9"]["note"]!, after["C-9"]["internal"]));

        // The same change file again: its rows are no longer as the sender saw them.
        var again = JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Key = key });
        Assert.Equal([("add", "C-9", "exists"), ("update", "C-1", "changed"), ("delete", "C-2", "missing")],
            again.Conflicts.Select(c => (c.Op, (string)c.Key["claim"]!, c.Kind)));
        Assert.Equal(["status", "amount", "due"], again.Conflicts[1].Columns!.Select(c => c.Name));
    }

    [Fact]
    public void Conflicts_AreHeld_Reported_AndAppliedOnlyWithOverwrite()
    {
        var path = Path.Combine(Temp(), "claims.jzm");
        WriteFile(path, new JazminWriteOptions { Files = [Doc], Package = new JazminPackage { Entry = "index.html", Edit = Edit } });
        byte[] change;
        using (var source = JazminReader.Open(path))
            change = JazminFile.WriteChanges(source, new JazminChanges
            {
                Update = [Row(("claim", "C-1"), ("status", "approved")), Row(("claim", "C-2"), ("note", "done"))],
                Delete = [Row(("claim", "C-3"))],
            });
        static Dictionary<string, object?> With(IReadOnlyDictionary<string, object?> row, string name, object? value) => new(row) { [name] = value };
        JazminFile.Update(path, new JazminUpdate
        {
            Upsert = [With(Claims[0], "status", "rejected"), With(Claims[1], "status", "paid"), With(Claims[2], "note", "disputed")],
            KeyColumns = ["claim"],
        });

        var held = JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions());
        Assert.Equal(1, held.Updated);
        Assert.Equal(2, held.Conflicts.Count);
        Assert.Equal(new JazminChangedColumn("status", "open", "approved", "rejected"), held.Conflicts[0].Columns!.Single());
        Assert.Equal(("delete", "changed"), (held.Conflicts[1].Op, held.Conflicts[1].Kind));
        Assert.Equal(new JazminChangedColumn("note", null, null, "disputed"), held.Conflicts[1].Columns!.Single());
        var now = RowsOf(path);
        Assert.Equal(("rejected", "paid", "done"), ((string)now["C-1"]["status"]!, (string)now["C-2"]["status"]!, (string)now["C-2"]["note"]!));

        var forced = JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Overwrite = true });
        Assert.Equal((2L, 1L, 0), (forced.Updated, forced.Deleted, forced.Conflicts.Count));
        now = RowsOf(path);
        Assert.Equal("approved", now["C-1"]["status"]);
        Assert.False(now.ContainsKey("C-3"));

        byte[] next;
        using (var later = JazminReader.Open(path)) next = JazminFile.WriteChanges(later, new JazminChanges { Update = [Row(("claim", "C-2"), ("note", "closed"))] });
        JazminFile.Compact(path);
        Assert.True(JazminFile.ApplyChanges(path, next, new JazminApplyChangesOptions()).FileChanged);
    }

    [Fact]
    public void TheSendersSide_OnlyWhatTheDocumentAllows_RowsTheKeySees_OneChangePerRow()
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions { Files = [Doc], Package = new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Key = ["claim"], Columns = ["status"] } } }, leaveOpen: true))
            foreach (var row in Claims) writer.WriteRow(row);
        using var source = JazminReader.Open(stream.ToArray());
        string Fails(JazminChanges changes) => Assert.Throws<JazminValidationException>(() => JazminFile.WriteChanges(source, changes)).Message;
        Assert.Contains("Column 'note' can't be changed through this document", Fails(new JazminChanges { Update = [Row(("claim", "C-1"), ("note", "x"))] }));
        Assert.Contains("doesn't allow adding rows", Fails(new JazminChanges { Add = [Row(("claim", "C-9"), ("status", "new"))] }));
        Assert.Contains("doesn't allow deleting rows", Fails(new JazminChanges { Delete = [Row(("claim", "C-1"))] }));
        Assert.Contains("appears twice", Fails(new JazminChanges { Update = [Row(("claim", "C-1"), ("status", "a")), Row(("claim", "C-1"), ("status", "b"))] }));
        Assert.Contains("No row with claim C-7 is visible", Fails(new JazminChanges { Update = [Row(("claim", "C-7"), ("status", "a"))] }));
        Assert.Contains("without its key column 'claim'", Fails(new JazminChanges { Update = [Row(("status", "a"))] }));
        Assert.Contains("changes nothing", Fails(new JazminChanges { Update = [Row(("claim", "C-1"))] }));
        Assert.Contains("No changes to save", Fails(new JazminChanges()));
        using var change = JazminReader.Open(JazminFile.WriteChanges(source, new JazminChanges { Update = [Row(("claim", "C-1"), ("status", "a"))] }));
        Assert.Null((string?)change.Metadata["jazmin.changes"]!["sender"]);
    }

    [Fact]
    public void SharedFile_TheSender_IsFoundBySubmissionKey_AndLimitedToItsGrant()
    {
        var path = Path.Combine(Temp(), "shared.jzm");
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var sally = owner.CreateAccessKey();
        var access = new JazminAccessOptions { PartitionBy = "region" };
        access.ColumnGroups["private"] = ["internal", "note"];
        access.Grants.Add(new JazminGrant(bob) { Rows = ["A"] });
        access.Grants.Add(new JazminGrant(sally) { Rows = ["B"], Columns = ["*"] });
        WriteFile(path, new JazminWriteOptions { Key = owner, Files = [Doc], Package = new JazminPackage { Entry = "index.html", Edit = Edit }, Access = access });

        byte[] change;
        using (var asBob = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }))
        {
            Assert.Equal(bob.Id, asBob.Access!.KeyId);
            change = JazminFile.WriteChanges(asBob, new JazminChanges
            {
                Update = [Row(("claim", "C-1"), ("status", "paid"), ("note", "ok"))],
                Add = [Row(("claim", "C-8"), ("status", "new"))],
                Delete = [Row(("claim", "C-2"))],
            });
        }
        var result = JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Key = owner });
        Assert.Equal((bob.Id, false, 1L, 1L, 1L, 0, 0), (result.Sender, result.FileChanged, result.Updated, result.Added, result.Deleted, result.Conflicts.Count, result.Refused.Count));
        var rows = RowsOf(path, new JazminReadOptions { Key = owner });
        Assert.Equal(("paid", "ok", "A", "new"), ((string)rows["C-1"]["status"]!, (string)rows["C-1"]["note"]!, (string)rows["C-8"]["region"]!, (string)rows["C-8"]["status"]!));
        Assert.False(rows.ContainsKey("C-2"));
        Assert.Contains("doesn't open with the submission key", Assert.Throws<JazminValidationException>(() =>
            JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Key = owner, KeyId = sally.Id })).Message);
        Assert.Contains("has no grant in this file", Assert.Throws<JazminValidationException>(() =>
            JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Key = owner, KeyId = owner.CreateAccessKey().Id })).Message);

        // Sally doesn't see note: her change files can't set it.
        using (var asSally = JazminReader.Open(path, new JazminReadOptions { AccessKey = sally, CheckClockRollback = false }))
        {
            Assert.Contains("Column 'note' can't be changed", Assert.Throws<JazminValidationException>(() =>
                JazminFile.WriteChanges(asSally, new JazminChanges { Update = [Row(("claim", "C-3"), ("note", "x"))] })).Message);
            var hers = JazminFile.WriteChanges(asSally, new JazminChanges { Update = [Row(("claim", "C-3"), ("status", "reopened"))], Add = [Row(("claim", "C-4"), ("status", "new"))] });
            var applied = JazminFile.ApplyChanges(path, hers, new JazminApplyChangesOptions { Key = owner });
            Assert.Equal((sally.Id, 1L, 1L), (applied.Sender, applied.Updated, applied.Added));
        }
        Assert.Equal("B", RowsOf(path, new JazminReadOptions { Key = owner })["C-4"]["region"]);
    }
}
