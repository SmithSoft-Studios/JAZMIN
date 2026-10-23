// The cache's expiry test moves the clock on purpose: the option is obsolete for callers, still honoured until 2.0.
#pragma warning disable CS0618

using System.Security.Cryptography;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Picking up a file's new versions: Changed(), Refresh() and <see cref="JazminReaderCache"/> (issue #275).</summary>
public sealed class RefreshTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-refresh-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("section", JazminType.String),
    };

    private static Dictionary<string, object?> Row(long id) => new() { ["id"] = id, ["section"] = id % 2 == 1 ? "A" : "B" };
    private static IReadOnlyList<IReadOnlyDictionary<string, object?>> Rows(int from, int count) => Enumerable.Range(from, count).Select(i => Row(i)).ToList();
    private static long[] Ids(JazminReader r) => r.Rows().Select(x => (long)x["id"]!).ToArray();
    private static long[] Range(int from, int count) => Enumerable.Range(from, count).Select(i => (long)i).ToArray();
    private static void Closed(JazminReader r) => Assert.Throws<ObjectDisposedException>(() => r.Changed());

    private string Write(string name, int count, JazminWriteOptions? options = null)
    {
        var path = Path.Combine(_dir, name);
        using var writer = JazminWriter.Create(path, Columns, options);
        foreach (var row in Rows(0, count)) writer.WriteRow(row);
        return path;
    }

    private string Shared(string name, JazminKey owner, JazminGrant grant, DateTimeOffset? now = null) => Write(name, 3, new JazminWriteOptions
    {
        Key = owner,
        Now = now,
        Access = new JazminAccessOptions { PartitionBy = "section", Grants = [grant] },
    });

    [Fact]
    public void Unchanged_ChangedIsFalse_AndRefreshReturnsTheSameReader()
    {
        var path = Write("same.jzm", 5);
        using var r = JazminReader.Open(path);
        Assert.False(r.Changed());
        Assert.Same(r, r.Refresh());
        Assert.Equal(Range(0, 5), Ids(r));
    }

    [Fact]
    public void AfterAnAppend_RefreshOpensTheNewVersion_TheOldReaderKeepsItsVersion()
    {
        var key = JazminKey.Generate();
        var path = Write("append.jzm", 5, new JazminWriteOptions { Key = key });
        var old = JazminReader.Open(path, new JazminReadOptions { Key = key });
        JazminFile.Append(path, new JazminAppend { Key = key, Insert = Rows(5, 2) });
        Assert.True(old.Changed());
        using var fresh = old.Refresh();
        Assert.NotSame(old, fresh);
        Assert.Equal(1, fresh.AppendCount);
        Assert.Equal(Range(0, 7), Ids(fresh));
        Assert.False(fresh.Changed());
        Assert.Equal(Range(0, 5), Ids(old));
        old.Dispose();
        Assert.Equal(new[] { 6L }, fresh.Find(JazminFilter.Eq("id", 6L)).Select(x => (long)x["id"]!));
    }

    [Fact]
    public void AfterUpdateOrCompact_ChangedIsTrue_AndRefreshReadsTheNewFile()
    {
        var path = Write("replace.jzm", 4);
        var first = JazminReader.Open(path);
        JazminFile.Update(path, new JazminUpdate { Insert = Rows(4, 1) });
        Assert.True(first.Changed());
        var second = first.Refresh();
        Assert.NotEqual(first.FileId, second.FileId);
        Assert.Equal(Range(0, 5), Ids(second));
        Assert.Equal(Range(0, 4), Ids(first));
        first.Dispose();

        JazminFile.Append(path, new JazminAppend { Insert = Rows(5, 1) });
        JazminFile.Compact(path);
        Assert.True(second.Changed());
        using var third = second.Refresh();
        Assert.Equal(Range(0, 6), Ids(third));
        Assert.Equal(0, third.AppendCount);
        second.Dispose();
    }

    [Fact]
    public void AnInterruptedAppend_IsNotAChange()
    {
        var path = Write("crash.jzm", 3);
        JazminFile.Append(path, new JazminAppend { Insert = Rows(3, 1) });
        using var r = JazminReader.Open(path);
        using (var f = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
            f.Write([1, 0, 0, 0, .. Enumerable.Repeat((byte)7, 300), .. "JZMN"u8]);
        Assert.False(r.Changed());
        Assert.Same(r, r.Refresh());
        JazminFile.Append(path, new JazminAppend { Insert = Rows(4, 1) });
        Assert.True(r.Changed());
        using var fresh = r.Refresh();
        Assert.Equal(Range(0, 5), Ids(fresh));
    }

    [Fact]
    public void AReaderOpenedFromBytesOrAStream_RefusesChangedAndRefresh()
    {
        var path = Write("bytes.jzm", 2);
        using var r = JazminReader.Open(File.ReadAllBytes(path));
        Assert.Throws<JazminValidationException>(() => r.Changed());
        Assert.Throws<JazminValidationException>(() => r.Refresh());
        using var s = JazminReader.Open(new MemoryStream(File.ReadAllBytes(path)));
        Assert.Throws<JazminValidationException>(() => s.Changed());
    }

    [Fact]
    public async Task OpenAsyncReaders_KnowTheirPath_AndOpenTableReadersRefreshToTheSameTable()
    {
        var path = Write("async.jzm", 2);
        using var r = await JazminReader.OpenAsync(path);
        Assert.False(r.Changed());
        JazminFile.Append(path, new JazminAppend { Insert = Rows(2, 1) });
        using var fresh = r.Refresh();
        Assert.Equal(Range(0, 3), Ids(fresh));

        var multi = Path.Combine(_dir, "tables.jzm");
        using (var writer = JazminWriter.Create(multi, new JazminWriteOptions { Tables = [new JazminTable("a", Columns), new JazminTable("b", Columns)] }))
        {
            foreach (var row in Rows(0, 2)) writer.WriteRow(row);
            writer.StartTable("b");
            foreach (var row in Rows(10, 2)) writer.WriteRow(row);
        }
        using var a = JazminReader.Open(multi);
        using var b = a.OpenTable("b");
        JazminFile.Append(multi, new JazminAppend { Table = "b", Insert = Rows(12, 1) });
        using var b2 = b.Refresh();
        Assert.Equal("b", b2.TableName);
        Assert.Equal(Range(10, 3), Ids(b2));
    }

    [Fact]
    public void ADisposedReader_RefusesChangedAndRefresh()
    {
        var path = Write("closed.jzm", 1);
        var r = JazminReader.Open(path);
        r.Dispose();
        Closed(r);
        Assert.Throws<ObjectDisposedException>(() => r.Refresh());
    }

    [Fact]
    public void APasswordFileRefreshedAfterAnAppend_ReusesTheDerivedKey()
    {
        var path = Write("password.jzm", 2, new JazminWriteOptions { Password = "correct horse", KdfIterations = 1000 });
        var r = JazminReader.Open(path, new JazminReadOptions { Password = "correct horse" });
        JazminFile.Append(path, new JazminAppend { Password = "correct horse", Insert = Rows(2, 1) });
        var fresh = r.Refresh();
        Assert.NotNull(r.DerivedKeyBytes);
        Assert.Same(r.DerivedKeyBytes, fresh.DerivedKeyBytes);
        Assert.Equal(Range(0, 3), Ids(fresh));
        r.Dispose();
        Assert.Null(r.DerivedKeyBytes);
        fresh.Dispose();

        var r2 = JazminReader.Open(path, new JazminReadOptions { Password = "correct horse" });
        JazminFile.Update(path, new JazminUpdate { Password = "correct horse", Insert = Rows(3, 1) });
        using var r3 = r2.Refresh();
        Assert.NotSame(r2.DerivedKeyBytes, r3.DerivedKeyBytes);
        Assert.Equal(Range(0, 4), Ids(r3));
        r2.Dispose();
    }

    [Fact]
    public void ARefreshThatFails_KeyRevoked_ThrowsAsOpenWould_AndLeavesTheOldReaderWorking()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Shared("revoked.jzm", owner, new JazminGrant(bob));
        using var r = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob });
        JazminFile.RevokeAccess(path, owner, bob);
        Assert.True(r.Changed());
        Assert.Throws<JazminKeyException>(() => r.Refresh());
        Assert.Equal(Range(0, 3), Ids(r).Order());
    }

    [Fact]
    public async Task ARefreshAfterTheKeyExpired_ThrowsAsOpenWould_AndLeavesTheOldReaderWorking()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var expires = DateTimeOffset.UtcNow.AddMilliseconds(1500); // the system clock: Refresh() opens with the options the reader was given
        var path = Shared("expiring.jzm", owner, new JazminGrant(bob) { Expires = expires });
        using var r = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false });
        JazminFile.Append(path, new JazminAppend { Key = owner, Insert = Rows(3, 1) });
        var wait = expires - DateTimeOffset.UtcNow + TimeSpan.FromMilliseconds(50);
        if (wait > TimeSpan.Zero) await Task.Delay(wait);
        Assert.Throws<JazminAccessExpiredException>(() => r.Refresh());
        Assert.Equal(3, Ids(r).Length);
    }

    [Fact]
    public void AFileThatIsGone_CountsAsChanged_AndRefreshThrowsAsOpenWould()
    {
        var path = Write("gone.jzm", 2);
        using var r = JazminReader.Open(path);
        File.Move(path, path + ".moved");
        var started = DateTime.UtcNow;
        Assert.True(r.Changed());
        if (OperatingSystem.IsWindows())
            Assert.True(DateTime.UtcNow - started >= TimeSpan.FromMilliseconds(90), "on Windows a missing path is tried again for about 100 ms");
        else
            Assert.True(DateTime.UtcNow - started < TimeSpan.FromMilliseconds(90), "elsewhere a missing path is not waited for (a replace there is one step)");
        Assert.Throws<FileNotFoundException>(() => r.Refresh());
        Assert.Equal(Range(0, 2), Ids(r));
        File.Move(path + ".moved", path);
        Assert.False(r.Changed());
    }

    [Fact]
    public void AFileReplacedAtOnceByAnotherOfTheSameSize_IsAChange()
    {
        var path = Write("same-size.jzm", 3);
        var other = Path.Combine(_dir, "same-size.new");
        using (var writer = JazminWriter.Create(other, Columns))
            foreach (var row in Rows(10, 3)) writer.WriteRow(row);
        Assert.Equal(new FileInfo(path).Length, new FileInfo(other).Length);
        // Same times too, as a file system with a coarse clock (FAT: 2 s, many network shares: 1 s) can give them.
        File.SetCreationTimeUtc(other, File.GetCreationTimeUtc(path));
        File.SetLastWriteTimeUtc(other, File.GetLastWriteTimeUtc(path));
        using var r = JazminReader.Open(path);
        File.Move(path, path + ".old"); // as an update replaces a file that is open (on Windows)
        File.Move(other, path);
        Assert.True(r.Changed());
        using var fresh = r.Refresh();
        Assert.Equal(Range(10, 3), Ids(fresh));
    }

    [Fact]
    public void ACopyOfTheSameFile_AppendedToAlike_PutInItsPlace_IsAChange()
    {
        var key = JazminKey.Generate();
        var path = Path.Combine(_dir, "restored.jzm");
        var (other, source) = (path + ".copy", Write("restored.base", 2, new JazminWriteOptions { Key = key }));
        static byte[] Last44(string f) => File.ReadAllBytes(f)[^44..];
        for (var attempt = 0; attempt < 20; attempt++)
        {
            File.Copy(source, path, true);
            File.Copy(source, other, true); // the same file elsewhere: a backup, another machine's synced copy
            JazminFile.Append(path, new JazminAppend { Key = key, Insert = [new Dictionary<string, object?> { ["id"] = 2L, ["section"] = "two" }] });
            JazminFile.Append(other, new JazminAppend { Key = key, Insert = [new Dictionary<string, object?> { ["id"] = 2L, ["section"] = "TWO" }] });
            if (new FileInfo(path).Length == new FileInfo(other).Length) break; // (now and then a byte apart: tried again)
        }
        Assert.Equal(Last44(path), Last44(other)); // the same size and trailer
        using var cache = new JazminReaderCache(10);
        JazminReader first;
        using (var lease = cache.Open(path, new JazminReadOptions { Key = key }))
        {
            first = lease.Reader;
            Assert.Equal("two", first.Find(JazminFilter.Eq("id", 2L)).Single()["section"]);
        }
        File.Move(path, path + ".old"); // as a restore or a sync tool puts the copy in place
        File.Move(other, path);
        Assert.True(first.Changed());
        using var second = cache.Open(path, new JazminReadOptions { Key = key });
        Assert.NotSame(first, second.Reader);
        Assert.Equal("TWO", second.Reader.Find(JazminFilter.Eq("id", 2L)).Single()["section"]);
    }

    [Fact]
    public void AnAppendBeingWritten_IsNotAChangeUntilItIsDone_HoweverOftenChangedIsAsked()
    {
        var path = Write("growing.jzm", 3);
        JazminFile.Append(path, new JazminAppend { Insert = Rows(3, 1) });
        using var r = JazminReader.Open(path);
        for (var i = 0; i < 3; i++)
        {
            using (var f = new FileStream(path, FileMode.Append)) f.Write(RandomNumberGenerator.GetBytes(40_000)); // its trailer not yet written
            Assert.False(r.Changed());
        }
        JazminFile.Append(path, new JazminAppend { Insert = Rows(4, 1) }); // done (it starts again from the end of the last version)
        Assert.True(r.Changed());
        using var fresh = r.Refresh();
        Assert.Equal(Range(0, 5), Ids(fresh));
    }

    [Fact]
    public void AnAppendThatFinishedInsideBytesCheckedBefore_ThenMoreBytesAfterThem_IsAChange()
    {
        var path = Write("finished-inside.jzm", 3);
        JazminFile.Append(path, new JazminAppend { Insert = Rows(3, 1) });
        using var r = JazminReader.Open(path);
        using (var f = new FileStream(path, FileMode.Append)) f.Write(RandomNumberGenerator.GetBytes(200_000)); // an interrupted append
        Assert.False(r.Changed());
        var checkedSize = new FileInfo(path).Length;
        JazminFile.Append(path, new JazminAppend { Insert = Rows(4, 1) }); // replaces those bytes: a new version, ending well before them
        Assert.True(new FileInfo(path).Length < checkedSize);
        using (var f = new FileStream(path, FileMode.Append)) f.Write(RandomNumberGenerator.GetBytes(300_000)); // the next append, unfinished
        Assert.True(new FileInfo(path).Length > checkedSize);
        Assert.True(r.Changed());
        using var fresh = r.Refresh();
        Assert.Equal(Range(0, 5), Ids(fresh));
    }

    // ---- JazminReaderCache -----------------------------------------------------------------------------------------

    [Fact]
    public void Cache_LeasesTheSameReaderAgain_WhileTheFileIsUnchanged()
    {
        var key = JazminKey.Generate();
        var path = Write("cache.jzm", 3, new JazminWriteOptions { Key = key });
        var cache = new JazminReaderCache(10);
        var lease = cache.Open(path, new JazminReadOptions { Key = key });
        var reader = lease.Reader;
        Assert.Equal(Range(0, 3), Ids(reader));
        lease.Release();
        lease.Dispose(); // twice is harmless (Dispose releases it, for `using`)
        using (var again = cache.Open(path, new JazminReadOptions { Key = key }))
            Assert.Same(reader, again.Reader);
        Assert.Equal(1, cache.Count);
        cache.Dispose();
        Closed(reader);
    }

    [Fact]
    public void Cache_ReplacesAnIdleReaderWhoseFileChanged_AndClosesTheOldOne()
    {
        var path = Write("cache-change.jzm", 2);
        using var cache = new JazminReaderCache(10);
        JazminReader old;
        using (var first = cache.Open(path)) old = first.Reader;
        JazminFile.Append(path, new JazminAppend { Insert = Rows(2, 1) });
        using (var second = cache.Open(path))
        {
            Assert.NotSame(old, second.Reader);
            Assert.Equal(Range(0, 3), Ids(second.Reader));
        }
        Closed(old);
        JazminFile.Update(path, new JazminUpdate { Insert = Rows(3, 1) });
        using var third = cache.Open(path);
        Assert.Equal(Range(0, 4), Ids(third.Reader));
    }

    [Fact]
    public void Cache_AReaderInUseIsNeverClosedOrReplacedUnderItsUser()
    {
        var path = Write("cache-lease.jzm", 2);
        using var cache = new JazminReaderCache(10);
        var busy = cache.Open(path);
        JazminFile.Append(path, new JazminAppend { Insert = Rows(2, 1) });
        var other = cache.Open(path);
        Assert.NotSame(busy.Reader, other.Reader);
        Assert.Equal(Range(0, 3), Ids(other.Reader));
        Assert.Equal(Range(0, 2), Ids(busy.Reader));
        var separate = other.Reader;
        other.Dispose();
        Closed(separate);
        Assert.Equal(Range(0, 2), Ids(busy.Reader));
        busy.Dispose();
        using var next = cache.Open(path);
        Assert.Equal(Range(0, 3), Ids(next.Reader));
    }

    [Fact]
    public void Cache_ClosesTheLeastRecentlyUsedFirst_OneInUseWhenItsLeaseIsReleased()
    {
        var files = new[] { "a", "b", "c" }.Select(n => Write($"{n}.jzm", 1)).ToArray();
        using var cache = new JazminReaderCache(2);
        var a = cache.Open(files[0]);
        var b = cache.Open(files[1]);
        b.Dispose();
        cache.Open(files[0]).Dispose(); // a used again: b is now the least recently used
        var c = cache.Open(files[2]);
        Closed(b.Reader);
        Assert.Equal(2, cache.Count);
        var d = cache.Open(files[1]); // a is now the least recently used, still leased
        Assert.Equal(2, cache.Count);
        Assert.Equal(Range(0, 1), Ids(a.Reader));
        a.Dispose();
        Closed(a.Reader);
        c.Dispose();
        d.Dispose();
    }

    [Fact]
    public void Cache_EntriesArePerKey_AWrongKeyNeverGetsACachedReader()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Write("cache-keys.jzm", 4, new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { PartitionBy = "section", Grants = [new JazminGrant(bob) { Rows = ["A"] }] },
        });
        using var cache = new JazminReaderCache(10);
        cache.Open(path, new JazminReadOptions { Key = owner }).Dispose();
        using var asBob = cache.Open(path, new JazminReadOptions { AccessKey = JazminAccessKey.Parse(bob.Export()) });
        Assert.Equal(new long[] { 1, 3 }, Ids(asBob.Reader));
        Assert.Equal(2, cache.Count);
        Assert.Throws<JazminKeyException>(() => cache.Open(path, new JazminReadOptions { Key = JazminKey.Generate() }));
        Assert.Throws<JazminKeyException>(() => cache.Open(path));
        Assert.Equal(2, cache.Count);
    }

    [Fact]
    public void Cache_ChecksExpiryOnEachOpen_AnExpiredKeyIsDroppedAndRefused()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Shared("cache-expiry.jzm", owner, new JazminGrant(bob) { ExpiresIn = TimeSpan.FromHours(2) }, T0);
        using var cache = new JazminReaderCache(10);
        JazminReader reader;
        using (var lease = cache.Open(path, new JazminReadOptions { AccessKey = bob, Now = T0.AddHours(1), CheckClockRollback = false })) reader = lease.Reader;
        Assert.Throws<JazminAccessExpiredException>(() => cache.Open(path, new JazminReadOptions { AccessKey = bob, Now = T0.AddHours(3), CheckClockRollback = false }));
        Closed(reader);
        Assert.Equal(0, cache.Count);
    }

    [Fact]
    public void Cache_ClearAndDispose_IdleReadersCloseNow_LeasedOnesWhenReleased()
    {
        var path = Write("cache-clear.jzm", 2);
        var cache = new JazminReaderCache(10);
        var idle = cache.Open(path);
        idle.Dispose();
        cache.Clear();
        Closed(idle.Reader);
        Assert.Equal(0, cache.Count);
        var held = cache.Open(path);
        cache.Dispose();
        Assert.Equal(Range(0, 2), Ids(held.Reader));
        held.Dispose();
        Closed(held.Reader);
        Assert.Throws<ObjectDisposedException>(() => cache.Open(path));
        Assert.Throws<JazminValidationException>(() => new JazminReaderCache(0));
    }

    [Fact]
    public void Cache_AReaderWhoseRefreshFails_IsDroppedAndClosed_AndOpenThrowsAsOpenWould()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Shared("cache-revoked.jzm", owner, new JazminGrant(bob));
        using var cache = new JazminReaderCache(10);
        JazminReader reader;
        using (var lease = cache.Open(path, new JazminReadOptions { AccessKey = bob })) reader = lease.Reader;
        JazminFile.RevokeAccess(path, owner, bob);
        Assert.Throws<JazminKeyException>(() => cache.Open(path, new JazminReadOptions { AccessKey = bob }));
        Assert.Equal(0, cache.Count);
        Closed(reader);
    }

    [Fact]
    public async Task Cache_IsThreadSafe_ManyRequestsAtOnce()
    {
        var files = Enumerable.Range(0, 8).Select(i => Write($"t{i}.jzm", 20)).ToArray();
        using var cache = new JazminReaderCache(4);
        await Parallel.ForAsync(0, 400, async (i, _) =>
        {
            using var lease = cache.Open(files[i % files.Length]);
            Assert.Single(lease.Reader.Find(JazminFilter.Eq("id", (long)(i % 20))));
            await Task.Yield();
        });
        Assert.True(cache.Count <= 4);
    }

    [Fact]
    public void Cache_ALockOpenedThroughOneLease_IsNotOpenForTheNext_TheReaderIsClosed()
    {
        var owner = JazminKey.Generate();
        var staff = owner.CreateAccessKey();
        var path = Path.Combine(_dir, "cache-unlock.jzm");
        using (var w = JazminWriter.Create(path, [new("id", JazminType.Int), new("dept", JazminType.String),
            new("account", JazminType.String) { Mask = new JazminMask("pay") { Show = JazminMaskShow.KeepFormat(4) } }], new JazminWriteOptions
        {
            Key = owner, Access = new JazminAccessOptions { PartitionBy = "dept", Grants = [new JazminGrant(staff)] },
            Locks = new Dictionary<string, JazminLockOptions?> { ["pay"] = new() { Password = "pw", Iterations = 1000 } },
        }))
            w.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["dept"] = "A", ["account"] = "4821 0393 7712 4821" });
        using var cache = new JazminReaderCache(10);
        var options = new JazminReadOptions { AccessKey = staff, CheckClockRollback = false };
        JazminReader unlocked;
        using (var first = cache.Open(path, options))
        {
            unlocked = first.Reader;
            Assert.False(unlocked.Rows().Single().ContainsKey("account"));
            unlocked.Unlock("pay", password: "pw");
            Assert.Equal("4821 0393 7712 4821", unlocked.Rows().Single()["account"]);
        }
        Closed(unlocked); // disposed when released: no later request may use the lock it opened
        Assert.Equal(0, cache.Count);
        JazminReader second;
        using (var lease = cache.Open(path, options)) // another request, the same key, no password
        {
            second = lease.Reader;
            Assert.NotSame(unlocked, second);
            Assert.False(second.Rows().Single().ContainsKey("account"), "the lock is closed for this request");
            Assert.False(second.Locks.Single().Unlocked);
        }
        using (var third = cache.Open(path, options))
            Assert.Same(second, third.Reader); // a reader with no lock open stays cached
    }
}
