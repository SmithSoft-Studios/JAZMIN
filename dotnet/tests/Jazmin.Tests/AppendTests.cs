using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

public sealed class AppendTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-append-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("section", JazminType.String) { Indexes = [JazminIndexKind.Sorted, JazminIndexKind.Trigram] },
        new("amount", JazminType.Float),
    };

    private static Dictionary<string, object?> Row(long id, string? section = null) =>
        new() { ["id"] = id, ["section"] = section ?? $"S{id / 10}", ["amount"] = id * 1.5 };

    private string Write(string name, IEnumerable<Dictionary<string, object?>> rows, JazminWriteOptions? options = null)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        foreach (var row in rows) writer.WriteRow(row);
        return path;
    }

    private static long[] Ids(string path, JazminReadOptions? options = null, JazminFilter? filter = null)
    {
        using var r = JazminReader.Open(path, options);
        return r.Find(filter).Select(x => (long)x["id"]!).ToArray();
    }

    private static IEnumerable<Dictionary<string, object?>> Range(int from, int count) => Enumerable.Range(from, count).Select(i => Row(i));

    /// <summary>Bytes 4-5 hold the flags, which an append updates; everything else must be untouched.</summary>
    private static bool SamePrefix(byte[] before, byte[] after) =>
        before.AsSpan(0, 4).SequenceEqual(after.AsSpan(0, 4)) && before.AsSpan(6).SequenceEqual(after.AsSpan(6, before.Length - 6));

    [Fact]
    public void Append_AddsRowsWithoutChangingExistingBytes_IndexesCoverAllSegments()
    {
        var path = Write("a.jzm", Range(0, 50), new JazminWriteOptions { ChunkRows = 16 });
        var before = File.ReadAllBytes(path);
        var result = JazminFile.Append(path, new JazminAppend { Insert = [Row(50), Row(51, "Special")] });
        Assert.Equal(new JazminAppendResult(52, 2, 0, 0, 1, 0, false), result);
        Assert.True(SamePrefix(before, File.ReadAllBytes(path)));

        using var r = JazminReader.Open(path);
        Assert.Equal(1, r.AppendCount);
        Assert.Equal(Enumerable.Range(0, 52).Select(i => (long)i), r.Rows().Select(x => (long)x["id"]!));
        Assert.Equal(new JazminPlan("index", 1, r.ChunkCount, 0), r.Explain(JazminFilter.Eq("id", 51)));
        Assert.Equal(new[] { 51L }, r.Find(JazminFilter.Contains("section", "Special")).Select(x => (long)x["id"]!));
        Assert.Equal(Enumerable.Range(10, 10).Select(i => (long)i), r.Find(JazminFilter.Eq("section", "S1")).Select(x => (long)x["id"]!));
    }

    [Fact]
    public void WrittenAt_IsWhenTheFileWasCreated_ThenWhenItWasLastAppendedTo()
    {
        var created = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var appended = new DateTimeOffset(2026, 1, 2, 12, 0, 0, TimeSpan.Zero);
        var path = Write("written.jzm", Range(0, 3), new JazminWriteOptions { Now = created });
        using (var reader = JazminReader.Open(path)) Assert.Equal(created, reader.WrittenAt);
        JazminFile.Append(path, new JazminAppend { Insert = [Row(9)], Now = appended });
        using (var reader = JazminReader.Open(path)) Assert.Equal(appended, reader.WrittenAt);
    }

    [Fact]
    public void AppendResults_MatchTheFile_RowAppendAndDeletedRowCounts()
    {
        var owner = JazminKey.Generate();
        foreach (var (name, options) in new[]
        {
            ("plain", (JazminWriteOptions?)null),
            ("shared", new JazminWriteOptions { Key = owner, Access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(owner.CreateAccessKey()) { Rows = ["S1"] }] } }),
        })
        {
            var path = Write($"results-{name}.jzm", Range(0, 30), options);
            var key = options?.Key;
            var changes = new[]
            {
                new JazminAppend { Insert = [Row(30), Row(31)] },
                new JazminAppend { Delete = JazminFilter.Eq("section", "S1") },
                new JazminAppend { Upsert = [Changed(Row(5), -1), Row(40, "S2")], KeyColumns = ["id"] },
                new JazminAppend { Insert = [Row(5), Row(5)] }, // the same id twice more
                new JazminAppend { Upsert = [Changed(Row(5), -2)], KeyColumns = ["id"] }, // replaces all three rows of id 5
                new JazminAppend { Delete = JazminFilter.Eq("section", "S1"), Insert = [Row(50, "S1")] }, // nothing left to delete in S1
            };
            foreach (var change in changes)
            {
                change.Key = key;
                var result = JazminFile.Append(path, change);
                using var reader = JazminReader.Open(path, new JazminReadOptions { Key = key });
                Assert.Equal((reader.RowCount, reader.AppendCount, reader.DeletedRowCount), (result.RowCount, result.AppendCount, result.DeletedRowCount));
            }
        }

        static Dictionary<string, object?> Changed(Dictionary<string, object?> row, double amount)
        {
            row["amount"] = amount;
            return row;
        }
    }

    [Fact]
    public void DeleteAndUpsert_AreRecordedAsDeletions_AndSkippedEverywhere()
    {
        var path = Write("d.jzm", Range(0, 30), new JazminWriteOptions { ChunkRows = 8 });
        var result = JazminFile.Append(path, new JazminAppend
        {
            Delete = JazminFilter.Eq("section", "S0"),
            Upsert = [new Dictionary<string, object?> { ["id"] = 15L, ["section"] = "S1", ["amount"] = 999.0 }, Row(99, "S9")],
            KeyColumns = ["id"],
        });
        Assert.Equal(new JazminAppendResult(21, 1, 1, 10, 1, 11, false), result);
        using var r = JazminReader.Open(path);
        Assert.Equal(21, r.RowCount);
        Assert.Equal(11, r.DeletedRowCount);
        Assert.Equal(new[] { 999.0 }, r.Find(JazminFilter.Eq("id", 15)).Select(x => (double)x["amount"]!));
        Assert.Equal(0, r.Count(JazminFilter.Eq("section", "S0")));
        Assert.Throws<JazminValidationException>(() => r.Get(3));
        Assert.Equal(15L, r.Get(30)["id"]);
    }

    [Fact]
    public void SortedFiles_AppendsMustComeAfter_AndFailedAppendLeavesFileByteIdentical()
    {
        var path = Write("s.jzm", Range(0, 20), new JazminWriteOptions { SortedBy = ["id"], ChunkRows = 8 });
        JazminFile.Append(path, new JazminAppend { Insert = [Row(20), Row(21)] });
        var before = File.ReadAllBytes(path);
        var error = Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend { Insert = [Row(5)] }));
        Assert.Contains("must sort after the existing rows", error.Message);
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.Equal(new[] { "s.jzm" }, Directory.GetFiles(_dir).Select(Path.GetFileName));
        Assert.Equal(new[] { 19L, 20, 21 }, Ids(path, filter: JazminFilter.Gte("id", 19)));
    }

    /// <summary>No handle is left open on the file: it can be opened with no sharing at all.</summary>
    private static void AssertClosed(string path)
    {
        using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
    }

    [Fact]
    public void Create_RefusedByAnOption_CreatesNoFile_AndLeavesAnExistingFileAsItWas()
    {
        var refused = new JazminWriteOptions { Key = JazminKey.Generate(), Password = "secret" };
        var path = Path.Combine(_dir, "new.jzm");
        Assert.Throws<JazminValidationException>(() => JazminWriter.Create(path, Columns, refused));
        Assert.Throws<JazminValidationException>(() => JazminWriter.Create(path, new JazminWriteOptions { Tables = [] }));
        Assert.False(File.Exists(path));

        var existing = Write("old.jzm", Range(0, 20));
        var before = File.ReadAllBytes(existing);
        var error = Assert.Throws<JazminValidationException>(() => JazminWriter.Create(existing, Columns, refused));
        Assert.Equal("Supply either Key or Password, not both", error.Message);
        Assert.Equal(before, File.ReadAllBytes(existing));
        AssertClosed(existing);
        Assert.Equal(20, Ids(existing).Length);
    }

    [Fact]
    public void Create_RefusedByAStoredFile_RemovesTheFileItStarted()
    {
        var path = Path.Combine(_dir, "files.jzm");
        var twice = new JazminWriteOptions { Files = [new JazminFileInput("a.txt", [1]), new JazminFileInput("a.txt", [2])] };
        var error = Assert.Throws<JazminValidationException>(() => JazminWriter.Create(path, Columns, twice));
        Assert.Equal("File 'a.txt' is added twice", error.Message);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void Append_RefusedByAStoredFile_LeavesFileByteIdentical_AndClosed()
    {
        var path = Write("a.jzm", Range(0, 20));
        var before = File.ReadAllBytes(path);
        Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend
        {
            Insert = [Row(20)],
            AddFiles = [new JazminFileInput("a.txt", [1]), new JazminFileInput("a.txt", [2])],
        }));
        Assert.Equal(before, File.ReadAllBytes(path));
        AssertClosed(path);
        Assert.Equal(new[] { "a.jzm" }, Directory.GetFiles(_dir).Select(Path.GetFileName));
    }

    [Fact]
    public void InterruptedAppend_IsIgnoredByReaders_AndCleanedUpByNextAppend()
    {
        var path = Write("crash.jzm", Range(0, 20));
        JazminFile.Append(path, new JazminAppend { Insert = [Row(20)] });
        using (var f = new FileStream(path, FileMode.Append))
            f.Write([1, 0, 0, 0, .. Enumerable.Repeat((byte)7, 300), .. "JZMN"u8]);
        using (var r = JazminReader.Open(path))
        {
            Assert.True(r.Recovered);
            Assert.Equal(21, r.RowCount);
        }
        JazminFile.Append(path, new JazminAppend { Insert = [Row(21)] });
        using var after = JazminReader.Open(path);
        Assert.False(after.Recovered);
        Assert.Equal(new[] { 20L, 21 }, after.Rows().Select(x => (long)x["id"]!).TakeLast(2));
    }

    [Fact]
    public void ReadersOpenedBeforeAnAppend_KeepReadingTheirVersion()
    {
        var path = Write("live.jzm", Range(0, 20));
        using var early = JazminReader.Open(path);
        JazminFile.Append(path, new JazminAppend { Insert = [Row(20)], Delete = JazminFilter.Eq("id", 0) });
        Assert.Equal(20, early.RowCount);
        Assert.Equal(0L, early.Rows().First()["id"]);
    }

    [Fact]
    public void FullUpdateAndCompact_WhileReadersHaveTheFileOpen_ReplaceIt_OnWindowsToo()
    {
        var path = Write("rename.jzm", Range(0, 20));
        using (var early = JazminReader.Open(path))
        {
            JazminFile.Update(path, new JazminUpdate { Insert = [Row(20)] });
            using var middle = JazminReader.Open(path);
            JazminFile.Append(path, new JazminAppend { Insert = [Row(21)] });
            JazminFile.Compact(path);
            // Each open reader still reads the version it opened, rows included.
            Assert.Equal((20, 20), (early.RowCount, early.Rows().Count()));
            Assert.Equal((21, 21), (middle.RowCount, middle.Rows().Count()));
        }
        Assert.Equal(22, Ids(path).Length);
        Assert.Equal(new[] { "rename.jzm" }, Directory.GetFiles(_dir).Select(Path.GetFileName)); // no temporary or old versions left
    }

    [Fact]
    public void FullUpdate_OfAFileHeldWithoutRenameSharing_LeavesItAsItWas()
    {
        if (!OperatingSystem.IsWindows()) return; // only Windows refuses to rename an open file
        var path = Write("held.jzm", Range(0, 20));
        var before = File.ReadAllBytes(path);
        using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) // another program: no renames or deletes
        {
            var error = Assert.Throws<JazminException>(() => JazminFile.Update(path, new JazminUpdate { Insert = [Row(20)] }));
            Assert.Contains("another program has it open and doesn't allow it to be renamed", error.Message);
            Assert.Equal(before, File.ReadAllBytes(path));
            Assert.Equal(new[] { "held.jzm" }, Directory.GetFiles(_dir).Select(Path.GetFileName)); // temporary file removed
        }
        JazminFile.Update(path, new JazminUpdate { Insert = [Row(20)] }); // once it is closed
        Assert.Equal(21, Ids(path).Length);
    }

    [Fact]
    public void WindowsReplace_InOneStepOrTwo_KeepsOpenReadersOnTheirVersion()
    {
        if (!OperatingSystem.IsWindows()) return;
        foreach (var twoSteps in new[] { false, true })
        {
            var target = Path.Combine(_dir, $"replace-{twoSteps}.bin");
            var temp = target + ".tmp";
            File.WriteAllText(target, "old version");
            File.WriteAllText(temp, "new version");
            using (var reader = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                Assert.True(twoSteps ? WindowsFiles.TryReplaceInTwoSteps(temp, target) : WindowsFiles.TryPosixReplace(temp, target));
                Assert.Equal("old version", new StreamReader(reader).ReadToEnd());
            }
            Assert.Equal("new version", File.ReadAllText(target));
            Assert.Equal(new[] { Path.GetFileName(target) }, Directory.GetFiles(_dir, "replace-*").Select(Path.GetFileName));
            File.Delete(target);
        }

        // Held without rename sharing: nothing changes.
        var held = Path.Combine(_dir, "held.bin");
        File.WriteAllText(held, "old version");
        File.WriteAllText(held + ".tmp", "new version");
        using (new FileStream(held, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            Assert.False(WindowsFiles.TryPosixReplace(held + ".tmp", held));
            Assert.False(WindowsFiles.TryReplaceInTwoSteps(held + ".tmp", held));
        }
        Assert.Equal("old version", File.ReadAllText(held));
        Assert.Equal(new[] { "held.bin", "held.bin.tmp" }, Directory.GetFiles(_dir, "held.*").Select(Path.GetFileName).Order());
    }

    [Fact]
    public void EncryptedAndPasswordFiles_CanBeAppended()
    {
        var key = JazminKey.Generate();
        var path = Write("k.jzm", [Row(1)], new JazminWriteOptions { Key = key });
        JazminFile.Append(path, new JazminAppend { Key = key, Insert = [Row(2)] });
        Assert.Equal(new[] { 1L, 2 }, Ids(path, new JazminReadOptions { Key = key }));
        Assert.Throws<JazminKeyException>(() => JazminFile.Append(path, new JazminAppend { Key = JazminKey.Generate(), Insert = [Row(3)] }));

        var pw = Write("p.jzm", [Row(1)], new JazminWriteOptions { Password = "pw", KdfIterations = 1000 });
        JazminFile.Append(pw, new JazminAppend { Password = "pw", Insert = [Row(2)], Delete = JazminFilter.Eq("id", 1) });
        Assert.Equal(new[] { 2L }, Ids(pw, new JazminReadOptions { Password = "pw" }));
    }

    [Fact]
    public void AccessControlled_OwnerAppends_GrantsCarryOver()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var carol = owner.CreateAccessKey();
        var path = Write("acl.jzm", [Row(1, "A"), Row(2, "B")], new JazminWriteOptions
        {
            Key = owner,
            SortedBy = ["section"],
            Access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["A", "C"], Label = "Bob" }] },
        });
        JazminFile.Append(path, new JazminAppend { Key = owner, Insert = [Row(3, "C")], Grant = [new JazminGrant(carol) { Label = "Carol" }] });
        Assert.Equal(new[] { 1L, 3 }, Ids(path, new JazminReadOptions { AccessKey = bob }));
        Assert.Equal(new[] { 1L, 2, 3 }, Ids(path, new JazminReadOptions { AccessKey = carol }));
        Assert.Throws<JazminKeyException>(() => JazminFile.Append(path, new JazminAppend { Key = JazminKey.Generate(), Insert = [Row(4, "D")] }));

        JazminFile.Append(path, new JazminAppend { Key = owner, Delete = JazminFilter.Eq("id", 1) });
        using var r = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob });
        Assert.Equal(new[] { 3L }, r.Rows().Select(x => (long)x["id"]!));
        Assert.Equal(1, r.DeletedRowCount);
    }

    [Fact]
    public void Append_MayWidenAGrantButNotNarrowIt()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Write("narrow.jzm", [Row(1, "A"), Row(2, "B")], new JazminWriteOptions
        {
            Key = owner,
            SortedBy = ["section"],
            Access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["A"] }] },
        });
        JazminFile.Append(path, new JazminAppend { Key = owner, Insert = [Row(3, "C")], Grant = [new JazminGrant(bob) { Rows = ["A", "C"] }] }); // wider
        Assert.Equal(new[] { 1L, 3 }, Ids(path, new JazminReadOptions { AccessKey = bob }));
        foreach (var narrower in new[]
        {
            new JazminGrant(bob) { Rows = ["C"] },
            new JazminGrant(bob) { Rows = ["A", "C"], ExpiresIn = TimeSpan.FromDays(1) },
            new JazminGrant(bob) { Rows = ["A", "C"], Mode = JazminGrantMode.Online },
        })
        {
            var error = Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend { Key = owner, Insert = [Row(4, "C")], Grant = [narrower] }));
            Assert.Contains("narrower than before", error.Message);
        }
        JazminFile.Update(path, new JazminUpdate { Key = owner, Grant = [new JazminGrant(bob) { Rows = ["C"] }] }); // a rewrite re-locks the file
        Assert.Equal(new[] { 3L }, Ids(path, new JazminReadOptions { AccessKey = bob }));
    }

    [Fact]
    public void Compact_RemovesDeletedRowsAndSupersededData()
    {
        var path = Write("c.jzm", Range(0, 200), new JazminWriteOptions { ChunkRows = 32 });
        for (var n = 0; n < 5; n++)
            JazminFile.Append(path, new JazminAppend { Insert = [Row(200 + n)], Delete = JazminFilter.Lt("id", (n + 1) * 20) });
        long[] live;
        using (var before = JazminReader.Open(path))
        {
            live = before.Rows().Select(x => (long)x["id"]!).ToArray();
            Assert.Equal(5, before.AppendCount);
        }

        var result = JazminFile.Compact(path);
        Assert.True(result.BytesAfter < result.BytesBefore, $"{result.BytesAfter} < {result.BytesBefore}");
        using var r = JazminReader.Open(path);
        Assert.Equal(0, r.AppendCount);
        Assert.Equal(0, r.DeletedRowCount);
        Assert.Equal(live, r.Rows().Select(x => (long)x["id"]!));
        Assert.Equal("index", r.Explain(JazminFilter.Eq("id", 150)).Strategy);
    }

    [Fact]
    public void AutoCompact_TriggersAtThreshold()
    {
        var path = Write("auto.jzm", Range(0, 10));
        Assert.False(JazminFile.Append(path, new JazminAppend { Insert = [Row(10)], AutoCompact = new(Appends: 2) }).Compacted);
        var second = JazminFile.Append(path, new JazminAppend { Insert = [Row(11)], AutoCompact = new(Appends: 2) });
        Assert.True(second.Compacted);
        Assert.Equal(12, second.RowCount);
        Assert.True(JazminFile.Append(path, new JazminAppend { Delete = JazminFilter.Lt("id", 5), AutoCompact = new(DeletedRatio: 0.25) }).Compacted);
        using var r = JazminReader.Open(path);
        Assert.Equal(7, r.RowCount);
    }

    [Fact]
    public void OneWriterAtATime()
    {
        var path = Write("lock.jzm", [Row(1)]);
        File.WriteAllText(path + ".lock", "");
        Assert.Throws<JazminException>(() => JazminFile.Append(path, new JazminAppend { Insert = [Row(2)] }));
        Assert.Throws<JazminException>(() => JazminFile.Update(path, new JazminUpdate { Insert = [Row(2)] }));
        Assert.Throws<JazminException>(() => JazminFile.Compact(path));
        File.Delete(path + ".lock");
        JazminFile.Append(path, new JazminAppend { Insert = [Row(2)] });
        Assert.Equal(new[] { 1L, 2 }, Ids(path));
    }
}
