using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Locked stored files (spec 6.8.1): a password, an unlock token from the owner's key service, or both.</summary>
public class LocksTests
{
    private static readonly JazminColumn[] Columns = { new("id", JazminType.Int), new("group", JazminType.String) };
    private static readonly byte[] Contract = RandomNumberGenerator.GetBytes(300 * 1024); // two blocks
    private const int Iterations = 1000; // the lowest allowed: tests stay quick

    private static IEnumerable<object?[]> Rows() =>
        new[] { "A", "B" }.SelectMany((g, k) => Enumerable.Range(0, 10).Select(i => new object?[] { (long)(k * 100 + i), g }));

    private static byte[] Write(JazminWriteOptions options)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            foreach (var row in Rows()) writer.WriteValues(row);
        return stream.ToArray();
    }

    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);

    private static string Text(byte[] bytes) => Encoding.UTF8.GetString(bytes);

    private sealed record Locked(JazminKey Owner, JazminAccessKey A, JazminAccessKey B, string Path);

    private static Locked WriteLocked()
    {
        var owner = JazminKey.Generate();
        var (a, b) = (owner.CreateAccessKey(), owner.CreateAccessKey());
        var path = System.IO.Path.Combine(Directory.CreateTempSubdirectory("jazmin-locks-").FullName, "claim.jzm");
        File.WriteAllBytes(path, Write(new JazminWriteOptions
        {
            Key = owner, SortedBy = ["group", "id"],
            Access = new JazminAccessOptions { PartitionBy = "group", Grants = [new JazminGrant(a) { Rows = ["A"] }, new JazminGrant(b)] },
            Files =
            [
                new JazminFileInput("contract.pdf", Contract) { Groups = ["A", "B"], Lock = "contracts" },
                new JazminFileInput("terms.pdf", Bytes("terms")) { Groups = ["A", "B"], Lock = "contracts" },
                new JazminFileInput("scan.png", Bytes("medical scan")) { Groups = ["B"], Lock = "medical" },
                new JazminFileInput("both.txt", Bytes("both kinds")) { Groups = ["A"], Lock = "vault" },
                new JazminFileInput("readme.txt", Bytes("open to all")) { Groups = ["A", "B"] },
            ],
            Locks = new Dictionary<string, JazminLockOptions?>
            {
                ["contracts"] = new() { Password = "correct horse", Iterations = Iterations },
                ["medical"] = new() { Online = true },
                ["vault"] = new() { Password = "vault pass", Online = true, Iterations = Iterations },
            },
        }));
        return new Locked(owner, a, b, path);
    }

    private static JazminReader AsKey(string path, JazminAccessKey key) => JazminReader.Open(File.ReadAllBytes(path), new JazminReadOptions { AccessKey = key });

    [Fact]
    public void ALockedFile_IsListedWithItsLock_AndOpensOnlyAfterUnlocking()
    {
        var f = WriteLocked();
        using var r = AsKey(f.Path, f.A);
        Assert.Equal(
            [("both.txt", new JazminLockInfo("vault", JazminLockKind.Both, false)), ("contract.pdf", new JazminLockInfo("contracts", JazminLockKind.Password, false)),
                ("readme.txt", null), ("terms.pdf", new JazminLockInfo("contracts", JazminLockKind.Password, false))],
            r.Files.Select(x => (x.Path, x.Lock)).OrderBy(x => x.Path, StringComparer.Ordinal));
        Assert.Equal([new JazminLockInfo("contracts", JazminLockKind.Password, false), new JazminLockInfo("vault", JazminLockKind.Both, false)], r.Locks);
        Assert.Equal("open to all", Text(r.ReadFile("readme.txt")));
        var locked = Assert.Throws<JazminFileLockedException>(() => r.ReadFile("contract.pdf"));
        Assert.IsAssignableFrom<JazminKeyException>(locked);
        Assert.Equal("File 'contract.pdf' is locked (lock 'contracts'): unlock it with its password", locked.Message);
        Assert.Equal(("contract.pdf", "contracts", JazminLockKind.Password), (locked.Path, locked.Lock, locked.Kind));
        Assert.Throws<JazminFileLockedException>(() => r.ReadFileRange("terms.pdf", 0, 2));
        Assert.Throws<JazminFileLockedException>(() => r.OpenFile("terms.pdf"));

        Assert.Contains("Wrong password for lock 'contracts'", Assert.Throws<JazminKeyException>(() => r.Unlock("contracts", password: "wrong")).Message);
        Assert.Contains("No lock 'nope' is visible with this key", Assert.Throws<JazminValidationException>(() => r.Unlock("nope", password: "x")).Message);
        Assert.Contains("Lock 'contracts' needs its password", Assert.Throws<JazminValidationException>(() => r.Unlock("contracts")).Message);
        r.Unlock("contracts", password: "correct horse");
        Assert.Equal(Contract, r.ReadFile("contract.pdf"));
        Assert.Equal("terms", Text(r.ReadFile("terms.pdf"))); // one unlock opens every file of the lock
        Assert.Equal(new JazminLockInfo("contracts", JazminLockKind.Password, true), r.Files.Single(x => x.Path == "terms.pdf").Lock);
        Assert.Contains("unlock it with its password and an unlock token from the file owner's key service",
            Assert.Throws<JazminFileLockedException>(() => r.ReadFile("both.txt")).Message);

        // Both: the password and the token, each wrong one refused.
        var token = JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "vault");
        Assert.StartsWith("jzf1-", token);
        Assert.Contains("Lock 'vault' needs its password and an unlock token", Assert.Throws<JazminValidationException>(() => r.Unlock("vault", password: "vault pass")).Message);
        Assert.Contains("Wrong password or unlock token for lock 'vault'", Assert.Throws<JazminKeyException>(() => r.Unlock("vault", "nope", token)).Message);
        Assert.Contains("Wrong password or unlock token", Assert.Throws<JazminKeyException>(() => r.Unlock("vault", "vault pass", JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "medical"))).Message);
        r.Unlock("vault", "vault pass", token);
        Assert.Equal("both kinds", Text(r.ReadFile("both.txt")));
    }

    [Fact]
    public void AnOnlineLock_OpensWithTheKeyServicesToken_AndTheOwnerOpensEveryLock()
    {
        var f = WriteLocked();
        using (var r = AsKey(f.Path, f.B))
        {
            Assert.Equal(["contracts", "medical", "vault"], r.Locks.Select(l => l.Id));
            Assert.Contains("unlock it with an unlock token from the file owner's key service", Assert.Throws<JazminFileLockedException>(() => r.ReadFile("scan.png")).Message);
            Assert.Contains("Lock 'medical' needs an unlock token", Assert.Throws<JazminValidationException>(() => r.Unlock("medical", password: "x")).Message);
            Assert.Contains("Unlock token has the wrong length", Assert.Throws<JazminKeyException>(() => r.Unlock("medical", unlockToken: "jzf1-AAAA")).Message);
            Assert.Contains("Wrong unlock token for lock 'medical'",
                Assert.Throws<JazminKeyException>(() => r.Unlock("medical", unlockToken: JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "vault"))).Message);
            r.Unlock("medical", unlockToken: JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "medical"));
            Assert.Equal("medical scan", Text(r.ReadFile("scan.png")));
            // Another table of the same reader shares the unlock.
            using var same = r.OpenTable(r.TableName);
            Assert.Equal("medical scan", Text(same.ReadFile("scan.png")));
        }
        Assert.Contains("Lock 'contracts' is a password lock: it has no unlock token",
            Assert.Throws<JazminValidationException>(() => JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "contracts")).Message);
        Assert.Contains("No lock 'nope' in this file", Assert.Throws<JazminValidationException>(() => JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "nope")).Message);

        using var o = JazminReader.Open(f.Path, new JazminReadOptions { Key = f.Owner });
        Assert.Equal([("contracts", true), ("medical", true), ("vault", true)], o.Locks.Select(l => (l.Id, l.Unlocked)));
        Assert.Equal(Contract, o.ReadFile("contract.pdf"));
        Assert.Equal("medical scan", Text(o.ReadFile("scan.png")));
        Assert.Equal("both kinds", Text(o.ReadFile("both.txt")));
        Assert.Equal(new JazminLockInfo("medical", JazminLockKind.Online, true), o.Files.Single(x => x.Path == "scan.png").Lock);
        Assert.Equal(["file-locks"], o.WriterFeatures);
        Assert.Empty(o.ReaderFeatures); // no reader feature: older readers still read the file
    }

    [Fact]
    public void TheSameBytes_StoredUnlockedAndLocked_AreTwoContents()
    {
        var owner = JazminKey.Generate();
        var a = owner.CreateAccessKey();
        var dir = Directory.CreateTempSubdirectory("jazmin-locks-").FullName;
        var path = System.IO.Path.Combine(dir, "twice.jzm");
        File.WriteAllBytes(System.IO.Path.Combine(dir, "contract.pdf"), Contract);
        File.WriteAllBytes(path, Write(new JazminWriteOptions
        {
            Key = owner, Access = new JazminAccessOptions { PartitionBy = "group", Grants = [new JazminGrant(a)] },
            Files =
            [
                new JazminFileInput("open.bin", Contract) { Groups = ["A"] },
                new JazminFileInput("locked.bin", new FileInfo(System.IO.Path.Combine(dir, "contract.pdf"))) { Groups = ["A"], Lock = "l" }, // from disk
            ],
            Locks = new Dictionary<string, JazminLockOptions?> { ["l"] = new() { Password = "pw", Iterations = Iterations } },
        }));
        using var r = AsKey(path, a);
        Assert.Equal(Contract, r.ReadFile("open.bin"));
        Assert.Throws<JazminFileLockedException>(() => r.ReadFile("locked.bin"));
    }

    [Fact]
    public void Locks_AreRefusedOutsideSharedFiles_AndChecked()
    {
        var owner = JazminKey.Generate();
        Dictionary<string, JazminLockOptions?> Lock(JazminLockOptions? l) => new() { ["l"] = l };
        var good = Lock(new JazminLockOptions { Password = "pw", Iterations = Iterations });
        string Refused(JazminWriteOptions options) => Assert.Throws<JazminValidationException>(() => Write(options)).Message;
        Assert.Equal("Locks need an access-controlled file (spec 6.8.1): with one key or password, that key would open every lock",
            Refused(new() { Key = owner, Files = [new JazminFileInput("a", [1]) { Lock = "l" }], Locks = good }));
        Assert.Contains("Locks need an access-controlled file", Refused(new() { Password = "pw", Locks = good }));
        JazminWriteOptions Shared(Dictionary<string, JazminLockOptions?> locks, JazminFileInput? file = null) => new()
        {
            Key = owner, Access = new JazminAccessOptions { PartitionBy = "group", Grants = [new JazminGrant(owner.CreateAccessKey())] },
            Files = file is null ? null : [file], Locks = locks,
        };
        Assert.Equal("File 'a': no lock 'm' (locks: l)", Refused(Shared(good, new JazminFileInput("a", [1]) { Groups = ["A"], Lock = "m" })));
        Assert.Equal("Lock 'l': give a Password, Online = true, or both", Refused(Shared(Lock(new JazminLockOptions()))));
        Assert.Equal("Lock 'l': the password must be a non-empty string", Refused(Shared(Lock(new JazminLockOptions { Password = "" }))));
        Assert.Equal("Lock 'l': Iterations must be from 1000 to 10000000", Refused(Shared(Lock(new JazminLockOptions { Password = "x", Iterations = 10 }))));
        Assert.Equal("A lock id is 1 to 64 characters", Refused(Shared(new() { [new string('x', 65)] = new JazminLockOptions { Online = true } })));
    }

    [Fact]
    public void RewritesAndAppends_KeepTheLocks_AndALockCanChangeOrGo()
    {
        var f = WriteLocked();
        var token = JazminFile.IssueFileUnlockToken(f.Path, f.Owner, "medical");
        void Check(string when, string password = "correct horse")
        {
            using (var r = AsKey(f.Path, f.A))
            {
                Assert.Throws<JazminFileLockedException>(() => r.ReadFile("contract.pdf"));
                r.Unlock("contracts", password: password);
                Assert.True(Contract.SequenceEqual(r.ReadFile("contract.pdf")), when);
            }
            using var b = AsKey(f.Path, f.B);
            b.Unlock("medical", unlockToken: token); // the same token across versions: the lock keeps its secret
            Assert.True(Text(b.ReadFile("scan.png")) == "medical scan", when);
        }
        Check("written");
        JazminFile.Compact(f.Path, f.Owner);
        Check("compacted");
        JazminFile.Update(f.Path, new JazminUpdate { Key = f.Owner, AddFiles = [new JazminFileInput("new.txt", Bytes("new")) { Groups = ["A"], Lock = "contracts" }] });
        Check("updated");
        JazminFile.Append(f.Path, new JazminAppend
        {
            Key = f.Owner, Insert = [new Dictionary<string, object?> { ["id"] = 500L, ["group"] = "B" }],
            AddFiles = [new JazminFileInput("more.txt", Bytes("more")) { Groups = ["A"], Lock = "contracts" }],
        });
        Check("appended");
        using (var r = AsKey(f.Path, f.A))
        {
            r.Unlock("contracts", password: "correct horse");
            Assert.Equal("more", Text(r.ReadFile("more.txt")));
            Assert.Equal("new", Text(r.ReadFile("new.txt")));
        }

        // A new password: the old one stops working, the files stay.
        JazminFile.Append(f.Path, new JazminAppend { Key = f.Owner, Locks = new Dictionary<string, JazminLockOptions?> { ["contracts"] = new() { Password = "new pass", Iterations = Iterations } } });
        using (var changed = AsKey(f.Path, f.A))
        {
            Assert.Contains("Wrong password", Assert.Throws<JazminKeyException>(() => changed.Unlock("contracts", password: "correct horse")).Message);
        }
        Check("password changed by an append", "new pass");
        JazminFile.Update(f.Path, new JazminUpdate { Key = f.Owner, Locks = new Dictionary<string, JazminLockOptions?> { ["contracts"] = new() { Password = "third", Iterations = Iterations } } });
        Check("password changed by an update", "third");

        // A password as well: the online lock becomes both kinds and keeps its secret.
        JazminFile.Update(f.Path, new JazminUpdate { Key = f.Owner, Locks = new Dictionary<string, JazminLockOptions?> { ["medical"] = new() { Password = "med", Online = true, Iterations = Iterations } } });
        using (var both = AsKey(f.Path, f.B))
        {
            Assert.Equal(JazminLockKind.Both, both.Locks.Single(l => l.Id == "medical").Kind);
            both.Unlock("medical", "med", token);
            Assert.Equal("medical scan", Text(both.ReadFile("scan.png")));
        }

        // Removed: its files stay, unlocked.
        JazminFile.Update(f.Path, new JazminUpdate { Key = f.Owner, Locks = new Dictionary<string, JazminLockOptions?> { ["contracts"] = null } });
        using (var open = AsKey(f.Path, f.A))
        {
            Assert.Null(open.Files.Single(x => x.Path == "contract.pdf").Lock);
            Assert.Equal(Contract, open.ReadFile("contract.pdf"));
            Assert.Equal(["vault"], open.Locks.Select(l => l.Id));
        }
        JazminFile.Append(f.Path, new JazminAppend { Key = f.Owner, Locks = new Dictionary<string, JazminLockOptions?> { ["vault"] = null, ["medical"] = null } });
        using (var o = JazminReader.Open(f.Path, new JazminReadOptions { Key = f.Owner }))
        {
            Assert.Empty(o.Locks);
            Assert.Empty(o.WriterFeatures); // no lock left: no writer feature
            Assert.Equal("both kinds", Text(o.ReadFile("both.txt")));
        }
        Assert.Contains("Locks: no lock 'gone' to remove", Assert.Throws<JazminValidationException>(() =>
            JazminFile.Update(f.Path, new JazminUpdate { Key = f.Owner, Locks = new Dictionary<string, JazminLockOptions?> { ["gone"] = null } })).Message);
    }

    [Fact]
    public void AWriterFeatureTheLibraryDoesNotKnow_StopsAppendsAndRewrites_NotReads()
    {
        var bytes = TestData.Write(Columns, Rows());
        var trailer = bytes.AsSpan(bytes.Length - FormatConstants.TrailerSize);
        var headerOffset = (int)BinaryPrimitives.ReadUInt64LittleEndian(trailer);
        var headerLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(trailer[8..]);
        var header = Catalog.DecodeHeader(SectionCodec.Decode(bytes[headerOffset..(headerOffset + headerLength)], null, bytes[8..24], "header"));
        header.WriterFeatures.Add("future-thing");
        var section = SectionCodec.Encode(Catalog.EncodeHeader(header), JazminCodec.Deflate, null, null, bytes[8..24], "header");
        var newTrailer = new byte[FormatConstants.TrailerSize];
        BinaryPrimitives.WriteUInt64LittleEndian(newTrailer, (ulong)headerOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(newTrailer.AsSpan(8), (uint)section.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(newTrailer.AsSpan(36), Crc32.Compute(newTrailer.AsSpan(0, 36)));
        FormatConstants.Magic.CopyTo(newTrailer.AsSpan(40));
        var path = System.IO.Path.Combine(Directory.CreateTempSubdirectory("jazmin-locks-").FullName, "future.jzm");
        File.WriteAllBytes(path, [.. bytes[..headerOffset], .. section, .. newTrailer]);
        using (var r = JazminReader.Open(path))
        {
            Assert.Equal(20, r.RowCount);
            Assert.Equal(["future-thing"], r.WriterFeatures);
        }
        const string refused = "This file needs the writer feature 'future-thing' to be modified, which this JAZMIN library does not support";
        Assert.Equal(refused, Assert.Throws<JazminFormatException>(() => JazminFile.Append(path, new JazminAppend { Insert = [new Dictionary<string, object?> { ["id"] = 1L, ["group"] = "A" }] })).Message);
        Assert.Equal(refused, Assert.Throws<JazminFormatException>(() => JazminFile.Update(path, new JazminUpdate { Insert = [new Dictionary<string, object?> { ["id"] = 1L, ["group"] = "A" }] })).Message);
        Assert.Equal(refused, Assert.Throws<JazminFormatException>(() => JazminFile.Compact(path)).Message);
    }

    [Fact]
    public void KeyServices_TheFilesForItsOnlineLocks_ALocksOwnOverIt_KeptByRewrites()
    {
        var owner = JazminKey.Generate();
        var a = owner.CreateAccessKey();
        var path = System.IO.Path.Combine(Directory.CreateTempSubdirectory("jazmin-locks-").FullName, "services.jzm");
        JazminWriteOptions Options(JazminPackage package, Dictionary<string, JazminLockOptions?> locks) => new()
        {
            Key = owner, SortedBy = ["group", "id"], Access = new JazminAccessOptions { PartitionBy = "group", Grants = [new JazminGrant(a)] },
            Files =
            [
                new JazminFileInput("contract.pdf", Bytes("contract")) { Groups = ["A"], Lock = "contracts" },
                new JazminFileInput("scan.png", Bytes("scan")) { Groups = ["A"], Lock = "medical" },
                new JazminFileInput("statement.pdf", Bytes("statement")) { Groups = ["A"], Lock = "bank" },
            ],
            Package = package, Locks = locks,
        };
        var allOnline = new Dictionary<string, JazminLockOptions?> { ["contracts"] = new() { Online = true }, ["medical"] = new() { Online = true }, ["bank"] = new() { Online = true } };
        foreach (var bad in new[] { "http://keys.example.com", "https://user:pw@keys.example.com", "https://keys.example.com/#x" })
            Assert.Contains("package.keyService must be an https address", Assert.Throws<JazminValidationException>(() => Write(Options(new JazminPackage { KeyService = bad }, allOnline))).Message);
        var fileService = new JazminPackage { KeyService = "https://keys.owner.example/unlock" };
        Assert.Contains("Lock 'contracts': KeyService is for online locks", Assert.Throws<JazminValidationException>(() => Write(Options(fileService,
            new() { ["contracts"] = new() { Password = "pw", KeyService = "https://k.example" }, ["medical"] = new() { Online = true }, ["bank"] = new() { Online = true } }))).Message);
        File.WriteAllBytes(path, Write(Options(fileService, new()
        {
            ["contracts"] = new() { Password = "pw", Iterations = Iterations },
            ["medical"] = new() { Online = true, KeyService = "https://keys.medicalaid.example/jazmin" },
            ["bank"] = new() { Online = true },
        })));
        Dictionary<string, string?> Services()
        {
            using var r = AsKey(path, a);
            var found = r.Locks.ToDictionary(l => l.Id, l => l.KeyService);
            Assert.Equal(found["medical"], r.Files.Single(f => f.Path == "scan.png").Lock!.KeyService);
            return found;
        }
        var expected = new Dictionary<string, string?> { ["bank"] = "https://keys.owner.example/unlock", ["contracts"] = null, ["medical"] = "https://keys.medicalaid.example/jazmin" };
        Assert.Equal(expected, Services());
        Assert.Equal([("bank", JazminLockKind.Online, (string?)null), ("medical", JazminLockKind.Online, "https://keys.medicalaid.example/jazmin")],
            JazminFile.ListFileUnlockTokens(path, owner).Select(t => (t.LockId, t.Kind, t.KeyService)));
        Assert.Equal(JazminFile.IssueFileUnlockToken(path, owner, "medical"), JazminFile.ListFileUnlockTokens(path, owner).Single(t => t.LockId == "medical").Token);
        JazminFile.Compact(path, owner);
        Assert.Equal(expected, Services());
        JazminFile.Append(path, new JazminAppend { Key = owner, Insert = [new Dictionary<string, object?> { ["id"] = 500L, ["group"] = "B" }] });
        Assert.Equal(expected, Services());
        JazminFile.Update(path, new JazminUpdate { Key = owner, Locks = new Dictionary<string, JazminLockOptions?> { ["medical"] = new() { Online = true, Password = "m", Iterations = Iterations } } });
        Assert.Equal(expected, Services()); // a password added: the service stays
        JazminFile.Update(path, new JazminUpdate { Key = owner, Locks = new Dictionary<string, JazminLockOptions?> { ["medical"] = new() { Online = true, KeyService = "" } } });
        Assert.Equal(new Dictionary<string, string?>(expected) { ["medical"] = "https://keys.owner.example/unlock" }, Services()); // "": the file's
    }
}
