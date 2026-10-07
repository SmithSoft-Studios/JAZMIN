using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Key rotation (TASKS S-2): a file encrypted with a key or password, encrypted again under a new one without decoding
/// its rows. Everything readable before is readable after, with the new key or password only.
/// </summary>
public sealed class RotateKeyTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-rotate-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static readonly JazminColumn[] ClientColumns =
    [
        new("clientId", JazminType.String) { Nullable = false },
        new("name", JazminType.String) { Indexes = [JazminIndexKind.Sorted, JazminIndexKind.Trigram] },
        new("since", JazminType.DateTime) { Indexes = [JazminIndexKind.Sorted] },
    ];

    private static readonly JazminColumn[] TransactionColumns =
    [
        new("clientId", JazminType.String) { Nullable = false },
        new("line", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Decimal),
        new("memo", JazminType.String) { Indexes = [JazminIndexKind.Trigram] },
    ];

    private static readonly byte[] Pattern = Enumerable.Range(0, 600_000).Select(i => (byte)(i * 31 + 7)).ToArray();

    /// <summary>The two-table file: chunks of 20 rows, sorted and trigram indexes, embedded files and package settings.</summary>
    private string Write(string name, JazminKey? key = null, string? password = null, bool compactIndexes = false)
    {
        var path = Path.Combine(_dir, name);
        var options = new JazminWriteOptions
        {
            Tables =
            [
                new JazminTable("clients", ClientColumns) { SortedBy = ["clientId"] },
                new JazminTable("transactions", TransactionColumns) { SortedBy = ["clientId", "line"], ChunkRows = 20 },
            ],
            ChunkRows = 20,
            Metadata = new JsonObject { ["title"] = "Rotation", ["version"] = 3 },
            Files =
            [
                new JazminFileInput("index.html", Encoding.UTF8.GetBytes("<h1>Rotation</h1>")),
                new JazminFileInput("docs/big.bin", Pattern),
                new JazminFileInput("docs/same.bin", Pattern), // the same bytes: stored once
                new JazminFileInput("empty.txt", []),
            ],
            Package = new JazminPackage { Entry = "index.html", Title = "Rotation" },
            Key = key,
            Password = password,
            KdfIterations = 1000,
            CompactIndexes = compactIndexes,
        };
        using var writer = JazminWriter.Create(path, options);
        for (var i = 0; i < 300; i++)
            writer.WriteValues([$"C{i:D4}", i % 9 == 0 ? null : $"Client {i} {new[] { "Ltd", "Inc", "Trust" }[i % 3]}", new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(i)]);
        writer.StartTable("transactions");
        for (var k = 0; k < 300; k++)
            for (var i = 0; i < 12; i++)
                writer.WriteValues([$"C{k:D4}", (long)(k * 12 + i), $"{(k * 7 + i) % 500}.{i * 3:D2}", i % 4 == 0 ? null : $"Payment {i} for C{k:D4}"]);
        return path;
    }

    /// <summary>Everything a key holder can read: tables, rows, index lookups, embedded files, metadata and package settings.</summary>
    private static string Snapshot(string path, JazminKey? key = null, string? password = null)
    {
        var options = new JazminReadOptions { Key = key, Password = password };
        using var r = JazminReader.Open(path, options);
        using var t = r.OpenTable("transactions");
        static string Rows(IEnumerable<IReadOnlyDictionary<string, object?>> rows) =>
            string.Join("\n", rows.Select(row => string.Join("|", row.Select(p => $"{p.Key}={Convert.ToString(p.Value, CultureInfo.InvariantCulture)}"))));
        var parts = new List<string>
        {
            string.Join(",", r.Tables),
            r.Metadata.ToJsonString(),
            $"{r.Package?.Entry}/{r.Package?.Title}",
            string.Join(";", r.Files.Select(f => $"{f.Path}:{Convert.ToBase64String(r.ReadFile(f.Path))}:{Convert.ToBase64String(r.ReadFileRange(f.Path, Math.Min(10, f.Size), Math.Min(2000, f.Size)))}")),
            Rows(r.Rows()),
            string.Join(",", r.Indexes),
            Rows(r.Find(JazminFilter.StartsWith("name", "Client 2"))),
            Rows(r.Find(JazminFilter.IContains("name", "TRUST"))),
            Rows(r.Find(JazminFilter.Gte("since", new DateTime(2020, 6, 1, 0, 0, 0, DateTimeKind.Utc)) & JazminFilter.Lt("since", new DateTime(2020, 7, 1, 0, 0, 0, DateTimeKind.Utc)))),
            Rows(r.Find(JazminFilter.IsNull("name"))),
            Rows(t.Rows()),
            Rows(t.Find(JazminFilter.In("line", 5L, 77L, 2999L, 3599L))),
            Rows(t.Find(JazminFilter.Contains("memo", "for C01"))),
            Rows(t.Find(JazminFilter.Eq("clientId", "C0123"))),
        };
        return string.Join("\n---\n", parts);
    }

    [Fact]
    public void AFileUnderANewKey_ReadsAsBefore_WithTheNewKeyOnly()
    {
        var key = JazminKey.Generate();
        var path = Write("key.jzm", key);
        var before = Snapshot(path, key);
        var size = new FileInfo(path).Length;

        var newKey = JazminKey.Generate();
        var result = JazminFile.RotateKey(path, new JazminKeyRotation { Key = key, NewKey = newKey });
        Assert.True(result.Sections > 100);
        Assert.Equal(before, Snapshot(path, newKey));
        Assert.Throws<JazminKeyException>(() => Snapshot(path, key));
        // Sections keep their lengths: only the header (new keyring, compressed again) may differ by a few bytes.
        Assert.InRange(new FileInfo(path).Length - size, -64, 64);
    }

    [Fact]
    public void KeysAndPasswords_ChangePlaces_WithCompactIndexesToo()
    {
        var path = Write("password.jzm", password: "correct horse battery staple", compactIndexes: true);
        var before = Snapshot(path, password: "correct horse battery staple");

        var key = JazminKey.Generate();
        JazminFile.RotateKey(path, new JazminKeyRotation { Password = "correct horse battery staple", NewKey = key });
        Assert.Equal(before, Snapshot(path, key));
        Assert.Throws<JazminKeyException>(() => Snapshot(path, password: "correct horse battery staple"));

        JazminFile.RotateKey(path, new JazminKeyRotation { Key = key, NewPassword = "another one", KdfIterations = 2000 });
        Assert.Equal(before, Snapshot(path, password: "another one"));
        Assert.Throws<JazminKeyException>(() => Snapshot(path, key));
        using var reader = JazminReader.Open(path, new JazminReadOptions { Password = "another one" });
        Assert.Equal(2000, reader.KdfIterations);
    }

    [Fact]
    public void AFileWithAppends_IsCompactedFirst_DroppingItsEarlierVersions()
    {
        var key = JazminKey.Generate();
        var path = Write("appended.jzm", key);
        JazminFile.Append(path, new JazminAppend
        {
            Key = key,
            Table = "transactions",
            Insert = [new Dictionary<string, object?> { ["clientId"] = "C9999", ["line"] = 99_999L, ["amount"] = "1.00", ["memo"] = "late" }],
            Delete = JazminFilter.Lt("line", 30L),
        });
        JazminFile.Append(path, new JazminAppend { Key = key, AddFiles = [new JazminFileInput("late.txt", Encoding.UTF8.GetBytes("added later"))] });
        var before = Snapshot(path, key);
        var size = new FileInfo(path).Length;

        var newKey = JazminKey.Generate();
        JazminFile.RotateKey(path, new JazminKeyRotation { Key = key, NewKey = newKey });
        Assert.Equal(before, Snapshot(path, newKey));
        Assert.Throws<JazminKeyException>(() => Snapshot(path, key));
        Assert.True(new FileInfo(path).Length < size); // the earlier versions are gone
    }

    [Fact]
    public void Rotation_RefusesWhatItCannotDo_AndLeavesTheFileAsItWas()
    {
        var plain = Path.Combine(_dir, "plain.jzm");
        using (var writer = JazminWriter.Create(plain, [new JazminColumn("n", JazminType.Int)])) writer.WriteValues([1L]);
        Assert.Throws<JazminValidationException>(() => JazminFile.RotateKey(plain, new JazminKeyRotation { NewKey = JazminKey.Generate() }));

        var key = JazminKey.Generate();
        var path = Path.Combine(_dir, "kept.jzm");
        using (var writer = JazminWriter.Create(path, [new JazminColumn("n", JazminType.Int)], new JazminWriteOptions { Key = key })) writer.WriteValues([1L]);
        var bytes = File.ReadAllBytes(path);
        Assert.Throws<JazminValidationException>(() => JazminFile.RotateKey(path, new JazminKeyRotation { Key = key }));
        Assert.Throws<JazminValidationException>(() => JazminFile.RotateKey(path, new JazminKeyRotation { Key = key, NewKey = JazminKey.Generate(), NewPassword = "x" }));
        Assert.Throws<JazminKeyException>(() => JazminFile.RotateKey(path, new JazminKeyRotation { Key = JazminKey.Generate(), NewKey = JazminKey.Generate() }));
        Assert.Throws<JazminValidationException>(() => JazminFile.RotateKey(path, new JazminKeyRotation { Key = key, NewPassword = "x", KdfIterations = 10 }));
        Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));

        var owner = JazminKey.Generate();
        var shared = Path.Combine(_dir, "shared.jzm");
        using (var writer = JazminWriter.Create(shared, [new JazminColumn("region", JazminType.String) { Nullable = false }, new JazminColumn("n", JazminType.Int)],
                   new JazminWriteOptions { Key = owner, Access = new JazminAccessOptions { PartitionBy = "region", Grants = [] } }))
            writer.WriteValues(["ZA", 1L]);
        Assert.Throws<JazminValidationException>(() => JazminFile.RotateKey(shared, new JazminKeyRotation { Key = owner, NewKey = JazminKey.Generate() }));
    }
}
