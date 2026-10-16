using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Masked columns (spec 7.6.8): a column shown masked until its lock opens, with a shown column made by a rule and, for
/// masked rows only, an unmasked column.
/// </summary>
public class MasksTests
{
    private const int Iterations = 1000; // the lowest allowed: tests stay quick

    private static JazminColumn[] Columns() =>
    [
        new("id", JazminType.Int), new("dept", JazminType.String), new("name", JazminType.String),
        new("account", JazminType.String) { Mask = new JazminMask("pay") { Show = JazminMaskShow.KeepFormat(4) } },
        new("email", JazminType.String) { Mask = new JazminMask("pay") { Show = JazminMaskShow.KeepFormat() } },
        new("salary", JazminType.Decimal) { Mask = new JazminMask("hr") { Rows = JazminFilter.Gte("id", 2L) } },
    ];

    private static readonly Dictionary<string, object?>[] Staff =
    [
        new() { ["id"] = 1L, ["dept"] = "A", ["name"] = "Ann", ["account"] = "4821 0393 7712 4821", ["email"] = "thandi@example.com", ["salary"] = "52000.00" },
        new() { ["id"] = 2L, ["dept"] = "A", ["name"] = "Ben", ["account"] = "1111 2222 3333 4444", ["email"] = "ben@example.org", ["salary"] = "61000.50" },
        new() { ["id"] = 3L, ["dept"] = "B", ["name"] = "Cas", ["account"] = "9", ["email"] = null, ["salary"] = null },
    ];

    private static Dictionary<string, JazminLockOptions?> Locks() => new()
    {
        ["pay"] = new() { Password = "pw", Iterations = Iterations },
        ["hr"] = new() { Online = true },
    };

    private sealed record StaffFile(JazminKey Owner, JazminAccessKey Staff, JazminAccessKey DeptB, string Path);

    private static byte[] Write(IEnumerable<JazminColumn> columns, IEnumerable<IReadOnlyDictionary<string, object?>> rows, JazminWriteOptions options)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, columns, options, leaveOpen: true))
            foreach (var row in rows) writer.WriteRow(row);
        return stream.ToArray();
    }

    private static StaffFile WriteStaff()
    {
        var owner = JazminKey.Generate();
        var (staff, deptB) = (owner.CreateAccessKey(), owner.CreateAccessKey());
        var path = System.IO.Path.Combine(Directory.CreateTempSubdirectory("jazmin-masks-").FullName, "staff.jzm");
        File.WriteAllBytes(path, Write(Columns(), Staff, new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { PartitionBy = "dept", Grants = [new JazminGrant(staff), new JazminGrant(deptB) { Rows = ["B"] }] },
            Locks = Locks(),
        }));
        return new StaffFile(owner, staff, deptB, path);
    }

    private static JazminReader AsKey(string path, JazminAccessKey key) => JazminReader.Open(File.ReadAllBytes(path), new JazminReadOptions { AccessKey = key });

    private static object? Value(JazminRow row, string column) => row.TryGetValue(column, out var value) ? value : "(none)";

    [Fact]
    public void What_a_masked_value_shows_by_each_rule()
    {
        Assert.Equal("••••4821", Masks.ShownText(JazminMaskShow.LastOf(4), "4821 0393 7712 4821"));
        Assert.Equal("••••", Masks.ShownText(JazminMaskShow.LastOf(4), "482")); // too short to show any of it
        Assert.Equal("85••••87", Masks.ShownText(JazminMaskShow.FirstAndLast(2, 2), "8501015009087"));
        Assert.Equal("•••• ••••-•••• 4821", Masks.ShownText(JazminMaskShow.KeepFormat(4), "4821 0393-7712 4821"));
        Assert.Equal("t•••••@example.com", Masks.ShownText(JazminMaskShow.KeepFormat(4), "thandi@example.com")); // an email keeps its domain
        Assert.Equal("••••50", Masks.ShownText(JazminMaskShow.LastOf(2), "61000.50"));
        Assert.Equal("••••😀", Masks.ShownText(JazminMaskShow.LastOf(1), "ab😀")); // by code points: a character is never split
        Assert.Null(Masks.ShownText(JazminMaskShow.LastOf(4), null));
        Assert.Equal("2024-03-01T10:00:00.000Z", Masks.TextOf(JazminType.DateTime, 1709287200000L));
        Assert.Equal("true", Masks.TextOf(JazminType.Bool, true));
    }

    [Fact]
    public void The_fast_shown_text_is_the_same_as_by_code_points_for_every_rule()
    {
        string[] pieces = ["4821", " ", "-", ".", "@", "é", "ß", "Ж", "٣", "½", "x", "Z", "0", "/", "••", "名"];
        var random = new Random(7);
        JazminMaskShow[] rules = [JazminMaskShow.LastOf(0), JazminMaskShow.LastOf(4), JazminMaskShow.FirstAndLast(2, 3), JazminMaskShow.KeepFormat(0),
            JazminMaskShow.KeepFormat(4), JazminMaskShow.KeepFormat(64)];
        for (var i = 0; i < 3000; i++)
        {
            var text = string.Concat(Enumerable.Range(0, random.Next(12)).Select(_ => pieces[random.Next(pieces.Length)]));
            foreach (var rule in rules) Assert.True(Masks.ShownText(rule, text) == Masks.ShownRunes(rule, text), $"{rule.Kind} {rule.Last} '{text}'");
        }
    }

    [Fact]
    public void A_key_granted_a_masked_column_sees_it_masked_with_its_shown_and_unmasked_columns_until_it_unlocks()
    {
        var f = WriteStaff();
        using var r = AsKey(f.Path, f.Staff);
        Assert.Equal(["id", "dept", "name", "account_shown", "email_shown", "salary_unmasked"], r.Columns.Select(c => c.Name));
        Assert.Equal(
            [
                ("account", JazminType.String, "mask.account", "pay", JazminLockKind.Password, false, "account_shown", null),
                ("email", JazminType.String, "mask.email", "pay", JazminLockKind.Password, false, "email_shown", null),
                ("salary", JazminType.Decimal, "mask.salary", "hr", JazminLockKind.Online, false, null, "salary_unmasked"),
            ],
            r.Masked.Select(m => (m.Column, m.Type, m.Group, m.Lock.Id, m.Lock.Kind!.Value, m.Lock.Unlocked, m.Shown, m.Unmasked)));
        Assert.Equal([3, 3, 3], r.Masked.Select(m => m.At)); // account, email and salary come after id, dept and name
        Assert.Equal([new JazminLockInfo("hr", JazminLockKind.Online, false), new JazminLockInfo("pay", JazminLockKind.Password, false)], r.Locks);
        Assert.Equal(
            [("•••• •••• •••• 4821", "t•••••@example.com", "52000.00"), ("•••• •••• •••• 4444", "b••@example.org", null), ("9", null, null)],
            r.Rows().Select(x => (Value(x, "account_shown"), Value(x, "email_shown"), Value(x, "salary_unmasked")?.ToString())));
        Assert.Throws<JazminValidationException>(() => r.Find(JazminFilter.Eq("account", "9")).ToList()); // as for a hidden column
        Assert.Throws<JazminKeyException>(() => r.Unlock("pay", password: "nope"));

        r.Unlock("pay", password: "pw");
        Assert.Equal([3L], r.Find(JazminFilter.Eq("account", "9")).Select(x => (long)x["id"]!)); // unlocked, a column like any other
        Assert.Equal([true, true, false], r.Masked.Select(m => m.Lock.Unlocked));
        Assert.DoesNotContain(r.Columns, c => c.Name == "salary"); // its own lock still shuts salary
        r.Unlock("hr", unlockToken: JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "hr"));
        Assert.Equal([(null, "52000.00"), ("61000.50", null), (null, null)],
            r.Rows().Select(x => (x["salary"]?.ToString(), x["salary_unmasked"]?.ToString())));
    }

    [Fact]
    public void Masks_are_per_grant_and_per_partition_and_a_grant_without_the_masked_group_never_sees_it()
    {
        var f = WriteStaff();
        using (var b = AsKey(f.Path, f.DeptB))
        {
            Assert.Equal([3L], b.Rows().Select(x => (long)x["id"]!));
            b.Unlock("pay", password: "pw");
            Assert.Equal(["9"], b.Rows().Select(x => (string?)x["account"]));
        }
        var owner = JazminKey.Generate();
        var reader = owner.CreateAccessKey();
        var narrow = Write(Columns(), Staff, new JazminWriteOptions
        {
            Key = owner, Locks = Locks(),
            Access = new JazminAccessOptions { ColumnGroups = new() { ["contact"] = ["name"] }, Grants = [new JazminGrant(reader) { Columns = ["contact"] }] },
        });
        using var n = JazminReader.Open(narrow, new JazminReadOptions { AccessKey = reader });
        Assert.Empty(n.Masked);
        Assert.Empty(n.Locks);
    }

    [Fact]
    public void The_owner_sees_everything_and_rewrites_and_appends_keep_the_masks_with_new_rows_following_the_rows_filter()
    {
        var f = WriteStaff();
        using (var o = JazminReader.Open(f.Path, new JazminReadOptions { Key = f.Owner }))
        {
            Assert.Equal([("account", true), ("email", true), ("salary", true)], o.Masked.Select(m => (m.Column, m.Lock.Unlocked)));
            // The owner sees how each is masked, and every lock, also those only masked columns use.
            Assert.Equal([JazminMaskShow.KeepFormat(4), JazminMaskShow.KeepFormat(4), JazminMaskShow.None], o.Masked.Select(m => m.Show));
            Assert.Equal([false, false, true], o.Masked.Select(m => m.Rows is not null));
            Assert.Equal([("hr", JazminLockKind.Online, true), ("pay", JazminLockKind.Password, true)], o.Locks.Select(l => (l.Id, l.Kind!.Value, l.Unlocked)));
            Assert.Equal("61000.50", o.Rows().ElementAt(1)["salary"]?.ToString());
            Assert.Equal(["file-locks", "masked-columns"], o.WriterFeatures.Order(StringComparer.Ordinal));
            Assert.Empty(o.ReaderFeatures); // older readers read the file, the masked columns hidden
            Assert.Null(o.Access!.Grants![0].Columns); // a grant of every column group, the masked ones too
        }
        void Check(string when, (long, string?, string?, string?)[] expected)
        {
            using var r = AsKey(f.Path, f.Staff);
            Assert.True(r.Masked.Count == 3, when);
            r.Unlock("pay", password: "pw");
            Assert.Equal(expected, r.Rows().Select(x => ((long)x["id"]!, (string?)x["account"], (string?)x["account_shown"], x["salary_unmasked"]?.ToString())));
        }
        (long, string?, string?, string?)[] before =
            [(1, "4821 0393 7712 4821", "•••• •••• •••• 4821", "52000.00"), (2, "1111 2222 3333 4444", "•••• •••• •••• 4444", null), (3, "9", "9", null)];
        Check("written", before);
        JazminFile.Compact(f.Path, f.Owner);
        Check("compacted", before);
        JazminFile.Update(f.Path, new JazminUpdate
        {
            Key = f.Owner,
            Insert = [new Dictionary<string, object?> { ["id"] = 0L, ["dept"] = "A", ["name"] = "Dee", ["account"] = "7777 8888", ["salary"] = "1.00" }],
        });
        (long, string?, string?, string?) dee = (0, "7777 8888", "•••• 8888", "1.00");
        Check("updated", [.. before, dee]);
        JazminFile.Append(f.Path, new JazminAppend
        {
            Key = f.Owner,
            Insert = [new Dictionary<string, object?> { ["id"] = 9L, ["dept"] = "B", ["name"] = "Eve", ["account"] = "1234 5678", ["salary"] = "2.00" }],
        });
        Check("appended", [.. before, dee, (9, "1234 5678", "•••• 5678", null)]);
    }

    [Fact]
    public void A_rows_value_goes_where_the_rows_filter_says_each_time_it_is_written()
    {
        var (columns, masks, _) = Masks.ForTable(Columns(), []);
        Assert.Equal(["id", "dept", "name", "account", "email", "salary", "account_shown", "email_shown", "salary_unmasked"], columns.Select(c => c.Name));
        var masker = new RowMasker(masks, columns, null);
        (object?, object?) Written(long id, string? salary, string? unmasked)
        {
            var row = masker.Apply([id, "A", "x", null, null, salary, null, null, unmasked]);
            return (row[5], row[8]);
        }
        Assert.Equal(("5.00", null), Written(2, "5.00", null)); // matches: masked
        Assert.Equal((null, "5.00"), Written(1, "5.00", null)); // doesn't: unmasked
        Assert.Equal((null, "5.00"), Written(2, null, "5.00")); // only an unmasked value (one the file has): kept
        Assert.Equal(("5.00", null), Written(2, "5.00", "old")); // a masked value wins
    }

    [Fact]
    public void An_update_unmasks_a_column_for_the_keys_that_had_it_masked_folding_its_shown_and_unmasked_columns_back()
    {
        var owner = JazminKey.Generate();
        var (staff, noMask) = (owner.CreateAccessKey(), owner.CreateAccessKey());
        var path = System.IO.Path.Combine(Directory.CreateTempSubdirectory("jazmin-masks-").FullName, "staff.jzm");
        File.WriteAllBytes(path, Write(Columns(), Staff, new JazminWriteOptions
        {
            Key = owner, Locks = Locks(),
            Access = new JazminAccessOptions { PartitionBy = "dept", Grants = [new JazminGrant(staff), new JazminGrant(noMask) { Columns = ["*"] }] },
        }));
        JazminFile.Update(path, new JazminUpdate { Key = owner, Masks = new Dictionary<string, JazminMask?> { ["account"] = null, ["salary"] = null } });
        using (var r = AsKey(path, staff))
        {
            Assert.Equal(["id", "dept", "name", "account", "salary", "email_shown"], r.Columns.Select(c => c.Name));
            Assert.Equal(["email"], r.Masked.Select(m => m.Column));
            Assert.Equal([("4821 0393 7712 4821", "52000.00"), ("1111 2222 3333 4444", "61000.50"), ("9", null)],
                r.Rows().Select(x => ((string?)x["account"], x["salary"]?.ToString())));
        }
        using (var n = AsKey(path, noMask))
            Assert.DoesNotContain(n.Columns, c => c.Name is "account" or "salary"); // a key that never had them still hasn't
        Assert.Contains("column 'account' isn't masked", Assert.Throws<JazminValidationException>(() =>
            JazminFile.Update(path, new JazminUpdate { Key = owner, Masks = new Dictionary<string, JazminMask?> { ["account"] = null } })).Message);
    }

    [Fact]
    public void An_update_masks_a_column_anew_for_the_keys_that_saw_it_in_a_named_group_or_the_default_one()
    {
        var owner = JazminKey.Generate();
        var (contact, other) = (owner.CreateAccessKey(), owner.CreateAccessKey());
        var path = System.IO.Path.Combine(Directory.CreateTempSubdirectory("jazmin-masks-").FullName, "people.jzm");
        File.WriteAllBytes(path, Write(
            [new("id", JazminType.Int), new("name", JazminType.String), new("phone", JazminType.String), new("email", JazminType.String)],
            [
                new Dictionary<string, object?> { ["id"] = 1L, ["name"] = "Ann", ["phone"] = "082 555 1234", ["email"] = "ann@example.com" },
                new Dictionary<string, object?> { ["id"] = 2L, ["name"] = "Ben", ["phone"] = "083 555 9876", ["email"] = "ben@example.org" },
            ],
            new JazminWriteOptions
            {
                Key = owner,
                Access = new JazminAccessOptions
                {
                    ColumnGroups = new() { ["contact"] = ["phone"] },
                    Grants = [new JazminGrant(contact) { Columns = ["*", "contact"] }, new JazminGrant(other) { Columns = ["*"] }],
                },
            }));
        JazminFile.Update(path, new JazminUpdate
        {
            Key = owner, Locks = new Dictionary<string, JazminLockOptions?> { ["pay"] = new() { Password = "pw", Iterations = Iterations } },
            Masks = new Dictionary<string, JazminMask?>
            {
                ["phone"] = new("pay") { Show = JazminMaskShow.LastOf(4) },
                ["email"] = new("pay") { Show = JazminMaskShow.KeepFormat() },
            },
        });
        using (var a = AsKey(path, contact))
        {
            Assert.Equal(["phone", "email"], a.Masked.Select(m => m.Column));
            Assert.Equal([("••••1234", "a••@example.com"), ("••••9876", "b••@example.org")], a.Rows().Select(x => ((string?)x["phone_shown"], (string?)x["email_shown"])));
            a.Unlock("pay", password: "pw");
            Assert.Equal(["082 555 1234", "083 555 9876"], a.Rows().Select(x => (string?)x["phone"]));
        }
        using (var b = AsKey(path, other))
            Assert.Equal(["email"], b.Masked.Select(m => m.Column)); // phone stays out of reach; email was in the default group
        // Given again with another rule: the shown values follow it.
        JazminFile.Update(path, new JazminUpdate { Key = owner, Masks = new Dictionary<string, JazminMask?> { ["phone"] = new("pay") { Show = JazminMaskShow.FirstAndLast(3, 2) } } });
        using (var again = AsKey(path, contact))
            Assert.Equal(["082••••34", "083••••76"], again.Rows().Select(x => (string?)x["phone_shown"]));
        Assert.Contains("Masks: no column 'nope'", Assert.Throws<JazminValidationException>(() =>
            JazminFile.Update(path, new JazminUpdate { Key = owner, Masks = new Dictionary<string, JazminMask?> { ["nope"] = new("pay") } })).Message);
    }

    [Fact]
    public void Masks_are_checked()
    {
        var owner = JazminKey.Generate();
        var access = new JazminAccessOptions { Grants = [new JazminGrant(owner.CreateAccessKey())] };
        var locks = new Dictionary<string, JazminLockOptions?> { ["pay"] = new() { Password = "pw", Iterations = Iterations } };
        JazminColumn[] Col(JazminMask mask) => [new("id", JazminType.Int), new("account", JazminType.String) { Mask = mask }];
        string Refused(JazminColumn[] columns, JazminAccessOptions? a = null, Dictionary<string, JazminLockOptions?>? l = null, bool shared = true) =>
            Assert.Throws<JazminValidationException>(() => Write(columns, [], new JazminWriteOptions { Key = owner, Access = shared ? a ?? access : null, Locks = shared ? l ?? locks : null })).Message;

        Assert.Contains("masked columns need an access-controlled file", Refused(Col(new("pay")), shared: false));
        Assert.Contains("Column 'account': mask: no lock 'nope' (locks: pay)", Refused(Col(new("nope"))));
        Assert.Contains("needs the lock that opens it", Refused(Col(new(""))));
        Assert.Contains("Show.Last must be a whole number from 0 to 64", Refused(Col(new("pay") { Show = JazminMaskShow.LastOf(99) })));
        Assert.Contains("the shown column 'label' is not a column", Refused(Col(new("pay") { Show = JazminMaskShow.FromColumn("label") })));
        Assert.Contains("a column 'account_shown' is there already", Refused([.. Col(new("pay") { Show = JazminMaskShow.LastOf(4) }), new("account_shown", JazminType.String)]));
        Assert.Contains("a binary column can't be masked", Refused([new("id", JazminType.Int), new("photo", JazminType.Binary) { Mask = new("pay") }]));
        Assert.Contains("two column groups", Refused(Col(new("pay")), new JazminAccessOptions { Grants = access.Grants, ColumnGroups = new() { ["money"] = ["account"] } }));
        Assert.Contains("no lock 'pay'", Refused(Col(new("pay")), l: new() { ["pay"] = null }));

        // A shown column the owner fills: no rule, the values as given.
        var own = Write([.. Col(new("pay") { Show = JazminMaskShow.FromColumn("label") }), new("label", JazminType.String)],
            [new Dictionary<string, object?> { ["id"] = 1L, ["account"] = "12345", ["label"] = "Savings ending 45" }],
            new JazminWriteOptions { Key = owner, Access = access, Locks = locks });
        using var r = JazminReader.Open(own, new JazminReadOptions { AccessKey = access.Grants[0].Key });
        Assert.Equal([(1L, "Savings ending 45")], r.Rows().Select(x => ((long)x["id"]!, (string?)x["label"])));
        Assert.Equal(["id", "label"], r.Columns.Select(c => c.Name));
        Assert.Equal("label", r.Masked[0].Shown);
    }

    [Fact]
    public void An_unlock_reaches_the_readers_of_the_files_other_tables_opened_before_it()
    {
        var owner = JazminKey.Generate();
        var key = owner.CreateAccessKey();
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Tables = [new JazminTable("notes", [new JazminColumn("n", JazminType.Int)]), new JazminTable("people", Columns())],
            Key = owner, Access = new JazminAccessOptions { Grants = [new JazminGrant(key)] }, Locks = Locks(),
        }, leaveOpen: true))
        {
            writer.WriteValues(1L);
            writer.StartTable("people");
            foreach (var row in Staff) writer.WriteRow(row);
        }
        using var notes = JazminReader.Open(stream.ToArray(), new JazminReadOptions { AccessKey = key });
        using var people = notes.OpenTable("people");
        Assert.Empty(notes.Masked);
        Assert.Equal(3, people.Masked.Count);
        Assert.DoesNotContain(people.Columns, c => c.Name == "account");
        notes.Unlock("pay", password: "pw");
        Assert.Equal(["4821 0393 7712 4821", "1111 2222 3333 4444", "9"], people.Rows().Select(x => (string?)x["account"]));
    }

    [Fact]
    public void The_package_says_how_viewers_show_revealed_values_by_column_and_is_checked()
    {
        var owner = JazminKey.Generate();
        JazminWriteOptions Options(JazminPackage package) => new()
        {
            Key = owner, Access = new JazminAccessOptions { Grants = [new JazminGrant(owner.CreateAccessKey())] }, Locks = Locks(),
            Files = [new JazminFileInput("index.html", "<p>Staff</p>"u8.ToArray())], Package = package,
        };
        var view = new JazminMaskView { Reveal = JazminMaskReveal.Column, Seconds = 0, WhenHidden = true, IdleSeconds = 120 };
        var bytes = Write(Columns(), Staff, Options(new JazminPackage { Entry = "index.html", Masks = new Dictionary<string, JazminMaskView> { ["salary"] = view } }));
        using (var r = JazminReader.Open(bytes, new JazminReadOptions { Key = owner }))
            Assert.Equal(view, r.Package!.Masks!["salary"]);
        Assert.Contains("a whole number of seconds from 0 to 86400", Assert.Throws<JazminValidationException>(() =>
            Write(Columns(), Staff, Options(new JazminPackage { Masks = new Dictionary<string, JazminMaskView> { ["salary"] = new() { Seconds = -1 } } }))).Message);
    }
}
