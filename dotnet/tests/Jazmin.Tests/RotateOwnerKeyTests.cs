#pragma warning disable CS0618 // JazminReadOptions.Now: the test sets the clock
using System.Globalization;
using System.Text;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// A shared (access-controlled) file under a new owner key: every access key is replaced, each grant keeping what it
/// opened, and none of the old keys open the file afterwards.
/// </summary>
public sealed class RotateOwnerKeyTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-rotate-owner-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly string[] Countries = ["ZA", "NA", "BW"];

    private static readonly JazminColumn[] Columns =
    [
        new("country", JazminType.String) { Nullable = false },
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("name", JazminType.String) { Indexes = [JazminIndexKind.Trigram] },
        new("balance", JazminType.Decimal),
        new("note", JazminType.String),
    ];

    /// <summary>What a key opens: its columns, rows, an index lookup and its embedded files.</summary>
    private static string View(string path, JazminReadOptions options)
    {
        options.Now = T0.AddHours(4); // after the rotation, at T0 + 3 h
        options.CheckClockRollback = false;
        using var r = JazminReader.Open(path, options);
        static string Rows(IEnumerable<IReadOnlyDictionary<string, object?>> rows) =>
            string.Join("\n", rows.Select(row => string.Join("|", row.Select(p => $"{p.Key}={Convert.ToString(p.Value, CultureInfo.InvariantCulture)}"))));
        return string.Join("\n---\n",
            string.Join(",", r.Columns.Select(c => c.Name)),
            Rows(r.Rows()),
            Rows(r.Find(JazminFilter.In("id", 3L, 4L, 5L, 300L))),
            string.Join(";", r.Files.Select(f => $"{f.Path}:{Encoding.UTF8.GetString(r.ReadFile(f.Path))}")));
    }

    [Fact]
    public void EveryAccessKey_IsReplaced_KeepingWhatItOpened_AndTheOldKeysOpenNothing()
    {
        var path = Path.Combine(_dir, "shared.jzm");
        var owner = JazminKey.Generate();
        var (alice, bob, carol, dave) = (owner.CreateAccessKey(), owner.CreateAccessKey(), owner.CreateAccessKey(), owner.CreateAccessKey());
        var options = new JazminWriteOptions
        {
            Key = owner,
            Now = T0,
            Files =
            [
                new JazminFileInput("all.txt", Encoding.UTF8.GetBytes("for everyone")),
                new JazminFileInput("team.txt", Encoding.UTF8.GetBytes("for the team")) { Groups = ["team"] },
            ],
            Access = new JazminAccessOptions
            {
                PartitionBy = "country",
                ColumnGroups = new() { ["money"] = ["balance"] },
                Grants =
                [
                    new JazminGrant(alice) { Rows = ["ZA"], Label = "Alice", Files = ["team"] },
                    new JazminGrant(bob) { Rows = ["NA", "BW"], Columns = ["*"], Label = "Bob" }, // the default group only: balance hidden
                    new JazminGrant(carol) { Label = "Carol", Mode = JazminGrantMode.Online, Expires = new DateTimeOffset(2099, 1, 1, 0, 0, 0, TimeSpan.Zero) },
                    new JazminGrant(dave) { Label = "Dave", Expires = T0.AddHours(2) }, // expired before the rotation
                ],
            },
        };
        using (var writer = JazminWriter.Create(path, Columns, options))
            for (var i = 0; i < 600; i++) writer.WriteValues([Countries[i % 3], (long)i, $"Person {i}", $"{i}.50", i % 5 == 0 ? null : $"note {i}"]);

        var before = new
        {
            Owner = View(path, new() { Key = owner }),
            Alice = View(path, new() { AccessKey = alice }),
            Bob = View(path, new() { AccessKey = bob }),
            Carol = View(path, new() { AccessKey = carol, UnlockToken = JazminFile.IssueUnlockToken(path, owner, carol.Id, T0) }),
        };

        var result = JazminFile.RotateOwnerKey(path, owner, now: T0.AddHours(3));
        Assert.Equal(
            [(alice.Id, "Alice", JazminGrantMode.Offline), (bob.Id, "Bob", JazminGrantMode.Offline), (carol.Id, "Carol", JazminGrantMode.Online)],
            result.AccessKeys.Select(k => (k.PreviousKeyId, k.Label, k.Mode))); // Dave's grant had expired
        var next = result.AccessKeys.ToDictionary(k => k.Label!, k => k.Key);
        Assert.Equal(before.Owner, View(path, new() { Key = result.OwnerKey }));
        Assert.Equal(before.Alice, View(path, new() { AccessKey = next["Alice"] }));
        Assert.Equal(before.Bob, View(path, new() { AccessKey = next["Bob"] }));
        var token = JazminFile.IssueUnlockToken(path, result.OwnerKey, next["Carol"].Id, T0.AddHours(3));
        Assert.Equal(before.Carol, View(path, new() { AccessKey = next["Carol"], UnlockToken = token }));
        Assert.Equal(new DateTimeOffset(2099, 1, 1, 0, 0, 0, TimeSpan.Zero), result.AccessKeys[2].Expires);

        Assert.Throws<JazminKeyException>(() => View(path, new() { Key = owner }));
        foreach (var old in new[] { alice, bob, carol, dave })
            Assert.ThrowsAny<JazminException>(() => View(path, new() { AccessKey = old }));
    }

    [Fact]
    public void OwnerKeyRotation_RefusesFilesThatAreNotShared_AndKeysThatAreNotTheOwners()
    {
        var plain = Path.Combine(_dir, "plain.jzm");
        var key = JazminKey.Generate();
        using (var writer = JazminWriter.Create(plain, [new JazminColumn("n", JazminType.Int)], new JazminWriteOptions { Key = key })) writer.WriteValues([1L]);
        Assert.Throws<JazminValidationException>(() => JazminFile.RotateOwnerKey(plain, key));

        var path = Path.Combine(_dir, "refused.jzm");
        var owner = JazminKey.Generate();
        using (var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions
               {
                   Key = owner,
                   Access = new JazminAccessOptions { PartitionBy = "country", Grants = [new JazminGrant(owner.CreateAccessKey()) { Rows = ["ZA"] }] },
               }))
            writer.WriteValues(["ZA", 1L, "One", "1.00", null]);
        var bytes = File.ReadAllBytes(path);
        Assert.Throws<JazminKeyException>(() => JazminFile.RotateOwnerKey(path, JazminKey.Generate()));
        Assert.Equal(bytes, File.ReadAllBytes(path));
    }
}
