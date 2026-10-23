using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Several calls as one append: JazminFile.BeginAppend (a transaction) and JazminFile.OpenWriter (group commit).</summary>
public sealed class TransactionTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-tx-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("v", JazminType.String),
    };

    private static readonly DateTimeOffset Now = new(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);

    private static Dictionary<string, object?> Row(long id, object? v) => new() { ["id"] = id, ["v"] = v };

    private string Base(string name, JazminWriteOptions? options = null)
    {
        var path = Path.Combine(_dir, name);
        using (var writer = JazminWriter.Create(path, Columns, options ?? new JazminWriteOptions { Now = Now }))
            foreach (var row in new[] { Row(1, "a"), Row(2, "b"), Row(3, "c") }) writer.WriteRow(row);
        return path;
    }

    private static (List<(long, string?)> Rows, int AppendCount) Read(string path, JazminKey? key = null)
    {
        using var r = JazminReader.Open(path, new JazminReadOptions { Key = key });
        return (r.Rows().Select(x => ((long)x["id"]!, (string?)x["v"])).ToList(), r.AppendCount);
    }

    /// <summary>A call: ("insert" | "upsert", rows) or ("delete", filter).</summary>
    private sealed record Call(string Kind, IReadOnlyList<Dictionary<string, object?>>? Rows = null, JazminFilter? Filter = null);

    private static Call Insert(params Dictionary<string, object?>[] rows) => new("insert", rows);

    private static Call Upsert(params Dictionary<string, object?>[] rows) => new("upsert", rows);

    private static Call Delete(JazminFilter filter) => new("delete", Filter: filter);

    /// <summary>The same calls, one Append each: what a transaction or the writer must match. Returns the summed counts.</summary>
    private static (long Inserted, long Updated, long Deleted) Sequential(string path, IEnumerable<Call> calls)
    {
        var (inserted, updated, deleted) = (0L, 0L, 0L);
        foreach (var c in calls)
        {
            var append = new JazminAppend { KeyColumns = ["id"], Now = Now };
            if (c.Kind == "insert") append.Insert = c.Rows!;
            else if (c.Kind == "upsert") append.Upsert = c.Rows!;
            else append.Delete = c.Filter;
            var r = JazminFile.Append(path, append);
            (inserted, updated, deleted) = (inserted + r.Inserted, updated + r.Updated, deleted + r.Deleted);
        }
        return (inserted, updated, deleted);
    }

    private static void Run(JazminTransaction tx, IEnumerable<Call> calls)
    {
        foreach (var c in calls)
        {
            if (c.Kind == "insert") tx.Insert(c.Rows!);
            else if (c.Kind == "upsert") tx.Upsert(c.Rows!);
            else tx.Delete(c.Filter!);
        }
    }

    private static Task<JazminAppendResult> Send(JazminAppendWriter w, Call c) =>
        c.Kind == "insert" ? w.InsertAsync(c.Rows!) : c.Kind == "upsert" ? w.UpsertAsync(c.Rows!) : w.DeleteAsync(c.Filter!);

    // Calls that don't see each other's rows: one append writes what the calls would, one after another.
    private static readonly Call[] Calls =
    [
        Insert(Row(10, "x"), Row(11, "y")),
        Delete(JazminFilter.Eq("id", 2)),
        Upsert(Row(3, "C"), Row(12, "z")),
        Insert(Row(13, "w")),
        Delete(JazminFilter.Eq("v", "a")),
        Upsert(Row(1, "A")), // deleted by the call before: added again, as an insert
    ];

    [Fact]
    public void Transaction_CommitsItsCallsAsOneAppend_WithTheResultOfRunningThemInTurn()
    {
        var expected = Base("seq.jzm");
        var counts = Sequential(expected, Calls);

        var path = Base("tx.jzm");
        using var tx = JazminFile.BeginAppend(path, new JazminAppend { KeyColumns = ["id"], Now = Now });
        Run(tx, Calls);
        var result = tx.Commit();
        var want = Read(expected).Rows;
        var (rows, appendCount) = Read(path);
        Assert.Equal(want, rows);
        Assert.Equal(1, appendCount);
        Assert.Equal(counts, (result.Inserted, result.Updated, result.Deleted));
        Assert.Equal(want.Count, result.RowCount);
        Assert.Equal(1, result.AppendCount);
    }

    [Fact]
    public void Transaction_WritesTheSameBytesAsOneAppendWithTheSameRows()
    {
        var a = Base("a.jzm");
        var b = Path.Combine(_dir, "b.jzm");
        File.Copy(a, b); // a file id of its own each time a file is written
        JazminFile.Append(a, new JazminAppend { Insert = [Row(10, "x"), Row(11, "y"), Row(12, "z")], Delete = JazminFilter.Eq("id", 2), Now = Now });
        using var tx = JazminFile.BeginAppend(b, new JazminAppend { Now = Now });
        tx.Insert([Row(10, "x")]);
        tx.Delete(JazminFilter.Eq("id", 2));
        tx.Insert([Row(11, "y"), Row(12, "z")]);
        tx.Commit();
        Assert.Equal(File.ReadAllBytes(a), File.ReadAllBytes(b));
    }

    [Fact]
    public void FailingCommit_LeavesTheFileByteForByte_AndEndsTheTransaction()
    {
        var path = Base("fail.jzm");
        var before = File.ReadAllBytes(path);
        var tx = JazminFile.BeginAppend(path, new JazminAppend { KeyColumns = ["id"] });
        tx.Insert([Row(10, "x")]);
        tx.Delete(JazminFilter.Eq("id", 1));
        tx.Insert([Row(11, 42L)]); // not a string
        Assert.Throws<JazminValidationException>(() => tx.Commit());
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.False(File.Exists(path + ".lock"));
        Assert.Contains("failed", Assert.Throws<JazminValidationException>(() => tx.Insert([Row(12, "z")])).Message);
        Assert.Contains("failed", Assert.Throws<JazminValidationException>(() => tx.Commit()).Message);
    }

    [Fact]
    public void Rollback_DiscardsTheCalls_AndDisposeWithoutCommitRollsBack()
    {
        var path = Base("rollback.jzm");
        var before = File.ReadAllBytes(path);
        var tx = JazminFile.BeginAppend(path);
        tx.Insert([Row(10, "x")]);
        tx.Rollback();
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.Contains("rolled back", Assert.Throws<JazminValidationException>(() => tx.Insert([Row(11, "y")])).Message);
        Assert.Contains("rolled back", Assert.Throws<JazminValidationException>(() => tx.Commit()).Message);

        using (var disposed = JazminFile.BeginAppend(path))
            disposed.Insert([Row(10, "x")]);
        Assert.Equal(before, File.ReadAllBytes(path));

        var done = JazminFile.BeginAppend(path);
        done.Insert([Row(10, "x")]);
        done.Commit();
        Assert.Contains("committed", Assert.Throws<JazminValidationException>(() => done.Delete(JazminFilter.Eq("id", 1))).Message);
        Assert.Contains("committed", Assert.Throws<JazminValidationException>(() => done.Rollback()).Message);
        done.Dispose(); // nothing to roll back
    }

    [Fact]
    public void Transaction_HoldsNoLockUntilCommit()
    {
        var path = Base("nolock.jzm");
        using var tx = JazminFile.BeginAppend(path);
        tx.Insert([Row(10, "x")]);
        Assert.False(File.Exists(path + ".lock"));
        JazminFile.Append(path, new JazminAppend { Insert = [Row(20, "other")] }); // another writer in between
        tx.Commit();
        Assert.Equal([1L, 2, 3, 20, 10], Read(path).Rows.Select(r => r.Item1));
    }

    [Fact]
    public void Transaction_RefusesACallThatWouldSeeARowAnEarlierCallAdds()
    {
        foreach (var (calls, message) in new (Call[], string)[]
        {
            ([Insert(Row(10, "x")), Delete(JazminFilter.Eq("id", 10))], "call 2 (delete) matches a row that call 1 (insert) adds"),
            ([Insert(Row(10, "x")), Upsert(Row(10, "y"))], "call 2 (upsert) has the key of a row that call 1 (insert) adds"),
            ([Upsert(Row(10, "x")), Upsert(Row(10, "y"))], "call 2 (upsert) has the key of a row that call 1 (upsert) adds"),
        })
        {
            var path = Base($"clash-{Guid.NewGuid():N}.jzm");
            var before = File.ReadAllBytes(path);
            using var tx = JazminFile.BeginAppend(path, new JazminAppend { KeyColumns = ["id"] });
            Run(tx, calls);
            Assert.Contains(message, Assert.Throws<JazminValidationException>(() => tx.Commit()).Message);
            Assert.Equal(before, File.ReadAllBytes(path));
        }
        // Not clashes: a delete before the insert, and a later insert of a key an earlier upsert wrote.
        var fine = Base("fine.jzm");
        using var ok = JazminFile.BeginAppend(fine, new JazminAppend { KeyColumns = ["id"] });
        ok.Delete(JazminFilter.Eq("id", 10));
        ok.Insert([Row(10, "x")]);
        ok.Upsert([Row(11, "y")]);
        ok.Insert([Row(11, "z")]);
        ok.Commit();
        Assert.Equal([(1L, "a"), (2, "b"), (3, "c"), (10, "x"), (11, "y"), (11, "z")], Read(fine).Rows);
    }

    [Fact]
    public async Task Upserts_TheLastRowForAKeyInACallWins_AndAnEmptyKeyIsAKey()
    {
        JazminColumn[] nullable = [new("id", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] }, new("v", JazminType.String)];
        static Dictionary<string, object?> R(long? id, string v) => new() { ["id"] = id, ["v"] = v };
        string Start(string name)
        {
            var path = Path.Combine(_dir, name);
            using (var writer = JazminWriter.Create(path, nullable, new JazminWriteOptions { Now = Now }))
                foreach (var row in new[] { R(null, "n"), R(1, "a") }) writer.WriteRow(row);
            return path;
        }
        static List<(long?, string?)> Rows(string path)
        {
            using var r = JazminReader.Open(path);
            return r.Rows().Select(x => ((long?)x["id"], (string?)x["v"])).ToList();
        }

        Call[] calls = [Upsert(R(1, "b"), R(null, "m"), R(1, "c")), Insert(R(2, "x"))]; // one call: id 1 once, as "c"
        var expected = Start("seq.jzm");
        var counts = Sequential(expected, calls);
        var path = Start("tx.jzm");
        using (var tx = JazminFile.BeginAppend(path, new JazminAppend { KeyColumns = ["id"], Now = Now }))
        {
            Run(tx, calls);
            var result = tx.Commit();
            Assert.Equal(counts, (result.Inserted, result.Updated, result.Deleted));
        }
        Assert.Equal(Rows(expected), Rows(path));
        Assert.Equal([(null, "m"), (1L, "c"), (2L, "x")], Rows(path));

        // A later call upserting the empty key of a row an earlier call adds would see that row: a clash, as for any key.
        using (var clash = JazminFile.BeginAppend(Start("clash.jzm"), new JazminAppend { KeyColumns = ["id"] }))
        {
            clash.Insert([R(null, "n2")]);
            clash.Upsert([R(null, "m")]);
            Assert.Contains("call 2 (upsert) has the key of a row that call 1 (insert) adds", Assert.Throws<JazminValidationException>(() => clash.Commit()).Message);
        }

        // The group writer splits there instead: the file is as the calls in turn leave it.
        Call[] split = [Insert(R(null, "n2")), Upsert(R(null, "m"), R(null, "m2"))];
        var want = Start("seq2.jzm");
        Sequential(want, split);
        var grouped = Start("writer.jzm");
        await using (var w = JazminFile.OpenWriter(grouped, new JazminAppend { KeyColumns = ["id"] }))
            await Task.WhenAll(split.Select(c => Send(w, c)));
        Assert.Equal(Rows(want), Rows(grouped));
        Assert.Equal([(1L, "a"), (null, "m2")], Rows(grouped));
    }

    [Fact]
    public void SortedFiles_ACallWhoseRowsSortBeforeAnEarlierCallsIsRefused()
    {
        var path = Base("sorted.jzm", new JazminWriteOptions { SortedBy = ["id"], Now = Now });
        using var tx = JazminFile.BeginAppend(path);
        tx.Insert([Row(20, "x")]);
        tx.Insert([Row(10, "y")]);
        Assert.Contains("call 2 (insert) has rows that sort before those call 1 (insert) adds", Assert.Throws<JazminValidationException>(() => tx.Commit()).Message);
        using var ok = JazminFile.BeginAppend(path);
        ok.Insert([Row(11, "y"), Row(10, "x")]); // within one call: sorted, as Append does
        ok.Insert([Row(20, "z")]);
        ok.Commit();
        Assert.Equal([1L, 2, 3, 10, 11, 20], Read(path).Rows.Select(r => r.Item1));
    }

    [Fact]
    public void BeginAppend_RefusesRowsInItsOptions_AndUpsertWithoutKeyColumns()
    {
        var path = Base("options.jzm");
        Assert.Contains("Insert", Assert.Throws<JazminValidationException>(() => JazminFile.BeginAppend(path, new JazminAppend { Insert = [Row(1, "x")] })).Message);
        Assert.Contains("Delete", Assert.Throws<JazminValidationException>(() => JazminFile.BeginAppend(path, new JazminAppend { Delete = JazminFilter.Eq("id", 1) })).Message);
        using var tx = JazminFile.BeginAppend(path);
        Assert.Contains("KeyColumns", Assert.Throws<JazminValidationException>(() => tx.Upsert([Row(1, "x")])).Message);
    }

    [Fact]
    public void SeveralDeletes_EachRowCountsOnce_ForTheFirstCallThatDeletesIt()
    {
        JazminColumn[] dated = [new("id", JazminType.Int), new("at", JazminType.DateTime)];
        var rows = Enumerable.Range(0, 6).Select(i => new Dictionary<string, object?> { ["id"] = (long)i, ["at"] = new DateTimeOffset(2026, 1, i + 1, 0, 0, 0, TimeSpan.Zero) }).ToList();
        string Make(string name)
        {
            var p = Path.Combine(_dir, name);
            using var w = JazminWriter.Create(p, dated);
            foreach (var r in rows) w.WriteRow(r);
            return p;
        }
        Dictionary<string, object?> At(long id, int year, int day) => new() { ["id"] = id, ["at"] = new DateTimeOffset(year, 1, day, 0, 0, 0, TimeSpan.Zero) };
        Call[] calls =
        [
            Delete(JazminFilter.Lt("at", new DateTimeOffset(2026, 1, 3, 0, 0, 0, TimeSpan.Zero))),
            Upsert(At(1, 2027, 1), At(4, 2027, 2)),
            Delete(JazminFilter.Lte("at", new DateTimeOffset(2026, 1, 5, 0, 0, 0, TimeSpan.Zero))),
        ];
        var expected = Make("seq.jzm");
        var counts = Sequential(expected, calls);
        var path = Make("tx.jzm");
        using var tx = JazminFile.BeginAppend(path, new JazminAppend { KeyColumns = ["id"] });
        Run(tx, calls);
        var result = tx.Commit();
        Assert.Equal(counts, (result.Inserted, result.Updated, result.Deleted));
        static List<string> Rows(string p)
        {
            using var r = JazminReader.Open(p);
            return r.Rows().Select(x => $"{x["id"]} {x["at"]}").ToList();
        }
        Assert.Equal(Rows(expected), Rows(path));
    }

    [Fact]
    public async Task Writer_MergesCallsIntoOneAppend_EachResolvesWithThatAppendsResult()
    {
        var path = Base("writer.jzm");
        var results = new JazminAppendResult[50];
        await using (var w = JazminFile.OpenWriter(path, new JazminAppend { Now = Now }, maxDelay: TimeSpan.FromMilliseconds(50)))
            results = await Task.WhenAll(Enumerable.Range(0, 50).Select(i => w.InsertAsync([Row(100 + i, $"r{i}")])));
        Assert.Single(results.Distinct());
        Assert.Equal(50, results[0].Inserted);
        var (rows, appendCount) = Read(path);
        Assert.Equal(1, appendCount);
        Assert.Equal(Enumerable.Range(100, 50).Select(i => (long)i), rows.Skip(3).Select(r => r.Item1));
    }

    [Fact]
    public async Task Writer_IsSafeForConcurrentCallers_AndKeepsEachCallersOrder()
    {
        var path = Base("concurrent.jzm");
        await using (var w = JazminFile.OpenWriter(path))
        {
            await Task.WhenAll(Enumerable.Range(0, 8).Select(t => Task.Run(async () =>
            {
                for (var i = 0; i < 25; i++) await w.InsertAsync([Row(1000 * (t + 1) + i, $"t{t}")]);
            })));
        }
        var (rows, appendCount) = Read(path);
        Assert.Equal(203, rows.Count);
        Assert.True(appendCount <= 200, $"{appendCount} appends");
        foreach (var group in rows.Skip(3).GroupBy(r => r.Item1 / 1000))
            Assert.Equal(group.Select(r => r.Item1).Order(), group.Select(r => r.Item1));
    }

    [Fact]
    public async Task Writer_SplitsABatchWhereACallWouldSeeAnEarlierCallsRow()
    {
        Call[] calls =
        [
            Insert(Row(10, "x")),
            Delete(JazminFilter.Eq("id", 10)), // sees the row above: a new append
            Insert(Row(11, "y")),
            Upsert(Row(11, "Y")), // sees the row above: another
            Insert(Row(12, "z")),
        ];
        var expected = Base("seq.jzm");
        Sequential(expected, calls);
        var path = Base("split.jzm");
        JazminAppendResult[] results;
        await using (var w = JazminFile.OpenWriter(path, new JazminAppend { KeyColumns = ["id"] }, maxDelay: TimeSpan.FromMilliseconds(50)))
            results = await Task.WhenAll(calls.Select(c => Send(w, c)));
        var (rows, appendCount) = Read(path);
        Assert.Equal(Read(expected).Rows, rows);
        Assert.Equal(3, appendCount);
        Assert.Equal([1, 2, 2, 3, 3], results.Select(r => r.AppendCount));
    }

    [Fact]
    public async Task Writer_ABadCallFailsAlone_TheOthersAreWrittenInOrder()
    {
        var path = Base("errors.jzm");
        var w = JazminFile.OpenWriter(path, maxDelay: TimeSpan.FromMilliseconds(50));
        var calls = Enumerable.Range(0, 20).Select(i => w.InsertAsync([Row(100 + i, i is 7 or 13 ? (long)i : $"r{i}")])).ToList();
        await w.DisposeAsync();
        for (var i = 0; i < 20; i++)
        {
            if (i is 7 or 13) Assert.IsType<JazminValidationException>(await Record.ExceptionAsync(() => calls[i]));
            else Assert.Equal(TaskStatus.RanToCompletion, calls[i].Status);
        }
        Assert.Equal(Enumerable.Range(100, 20).Where(i => i is not (107 or 113)).Select(i => (long)i), Read(path).Rows.Skip(3).Select(r => r.Item1));
    }

    [Fact]
    public async Task Writer_AnErrorNotAboutTheCallsFailsTheWholeBatch()
    {
        var path = Base("locked.jzm");
        File.WriteAllText(path + ".lock", "");
        var w = JazminFile.OpenWriter(path, maxDelay: TimeSpan.FromMilliseconds(50));
        var a = w.InsertAsync([Row(10, "x")]);
        var b = w.InsertAsync([Row(11, "y")]);
        Assert.Contains("Another writer", (await Assert.ThrowsAsync<JazminException>(() => a)).Message);
        await Assert.ThrowsAsync<JazminException>(() => b);
        File.Delete(path + ".lock");
        await w.DisposeAsync();
    }

    [Fact]
    public async Task Writer_MaxRowsBoundsABatch_FlushAndDisposeWait_ThenCallsAreRefused()
    {
        var path = Base("batches.jzm");
        var w = JazminFile.OpenWriter(path, maxRows: 10, maxDelay: TimeSpan.FromSeconds(30));
        var first = Enumerable.Range(0, 25).Select(i => w.InsertAsync([Row(100 + i, "x")])).ToList();
        await w.FlushAsync(); // doesn't wait the 30 seconds
        var appends = (await Task.WhenAll(first)).Select(r => r.AppendCount).Distinct().ToList();
        Assert.Equal([1, 2, 3], appends);
        var late = w.InsertAsync([Row(200, "late")]);
        await w.DisposeAsync();
        Assert.Equal(4, (await late).AppendCount);
        Assert.Contains("closed", (await Assert.ThrowsAsync<JazminValidationException>(() => w.InsertAsync([Row(300, "closed")]))).Message);
        Assert.Equal(29, Read(path).Rows.Count);
    }

    [Fact]
    public async Task OpenWriter_RefusesOptionsEveryBatchWouldWriteAgain()
    {
        var path = Base("refuse.jzm");
        foreach (var (options, name) in new (JazminAppend, string)[]
        {
            (new JazminAppend { Insert = [Row(1, "x")] }, "Insert"),
            (new JazminAppend { Delete = JazminFilter.Eq("id", 1) }, "Delete"),
            (new JazminAppend { Metadata = [] }, "Metadata"),
            (new JazminAppend { Grant = [new JazminGrant(JazminKey.Generate().CreateAccessKey())] }, "Grant"),
            (new JazminAppend { AddFiles = [new JazminFileInput("a.txt", "x"u8.ToArray())] }, "AddFiles"),
            (new JazminAppend { RemoveFiles = ["a.txt"] }, "RemoveFiles"),
            (new JazminAppend { Package = new JazminPackage() }, "Package"),
            (new JazminAppend { RemoveShapes = ["s"] }, "RemoveShapes"),
            (new JazminAppend { Locks = new Dictionary<string, JazminLockOptions?>() }, "Locks"),
            (new JazminAppend { Columns = [] }, "Columns"),
        })
            Assert.Contains(name, Assert.Throws<JazminValidationException>(() => JazminFile.OpenWriter(path, options)).Message);
        Assert.Throws<JazminValidationException>(() => JazminFile.OpenWriter(path, maxRows: 0));
        Assert.Throws<JazminValidationException>(() => JazminFile.OpenWriter(path, maxDelay: TimeSpan.FromMilliseconds(-1)));
        await using var w = JazminFile.OpenWriter(path);
        Assert.Contains("KeyColumns", (await Assert.ThrowsAsync<JazminValidationException>(() => w.UpsertAsync([Row(1, "x")]))).Message);
    }

    [Fact]
    public async Task MaskedColumns_ADeleteAfterACallThatAddsRowsIsAClash_SinceTheWriterChangesRowsAsItStoresThem()
    {
        var owner = JazminKey.Generate();
        JazminColumn[] columns =
        [
            new("id", JazminType.Int), new("dept", JazminType.String),
            new("salary", JazminType.Decimal) { Mask = new JazminMask("hr") { Rows = JazminFilter.Gte("id", 2L) } },
        ];
        string Start(string name)
        {
            var path = Path.Combine(_dir, name);
            using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions
            {
                Key = owner, Access = new JazminAccessOptions { PartitionBy = "dept" },
                Locks = new Dictionary<string, JazminLockOptions?> { ["hr"] = new() { Online = true } },
            }))
            {
                writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["dept"] = "A", ["salary"] = "52000.00" });
                writer.WriteRow(new Dictionary<string, object?> { ["id"] = 2L, ["dept"] = "A", ["salary"] = "61000.50" });
            }
            return path;
        }
        List<string> Show(string path)
        {
            using var r = JazminReader.Open(path, new JazminReadOptions { Key = owner });
            return r.Rows().Select(x => string.Join(",", x.Values)).ToList();
        }
        // Row 0 is outside the mask's rows, so the writer stores its salary in salary_unmasked, where the delete looks.
        var insert = new Dictionary<string, object?> { ["id"] = 0L, ["dept"] = "A", ["salary"] = "70000.00" };
        var delete = JazminFilter.Gte("salary_unmasked", "60000");
        var expected = Start("seq.jzm");
        JazminFile.Append(expected, new JazminAppend { Key = owner, Insert = [insert] });
        JazminFile.Append(expected, new JazminAppend { Key = owner, Delete = delete });
        Assert.Equal(2, Show(expected).Count); // run in turn, the delete removes the inserted row

        using (var tx = JazminFile.BeginAppend(Start("tx.jzm"), new JazminAppend { Key = owner }))
        {
            tx.Insert([insert]);
            tx.Delete(delete);
            Assert.Contains("call 2 (delete) may match a row that call 1 (insert) adds", Assert.Throws<JazminValidationException>(() => tx.Commit()).Message);
        }

        var grouped = Start("writer.jzm");
        await using (var w = JazminFile.OpenWriter(grouped, new JazminAppend { Key = owner }))
            await Task.WhenAll(w.InsertAsync([insert]), w.DeleteAsync(delete));
        Assert.Equal(Show(expected), Show(grouped));
    }

    [Fact]
    public async Task TransactionsAndTheWriter_OnEncryptedAndSharedFiles_WithTheOwnerKey()
    {
        var owner = JazminKey.Generate();
        var reader = owner.CreateAccessKey();
        foreach (var (name, options) in new (string, JazminWriteOptions)[]
        {
            ("key", new JazminWriteOptions { Key = owner }),
            ("shared", new JazminWriteOptions { Key = owner, Access = new JazminAccessOptions { PartitionBy = "v", Grants = [new JazminGrant(reader) { Rows = ["a"] }] } }),
        })
        {
            var path = Base($"{name}.jzm", options);
            using (var tx = JazminFile.BeginAppend(path, new JazminAppend { Key = owner, KeyColumns = ["id"] }))
            {
                tx.Upsert([Row(1, "a2")]);
                tx.Insert([Row(10, "a")]);
                tx.Commit();
            }
            await using (var w = JazminFile.OpenWriter(path, new JazminAppend { Key = owner }, maxDelay: TimeSpan.FromMilliseconds(50)))
                await Task.WhenAll(w.InsertAsync([Row(11, "a")]), w.DeleteAsync(JazminFilter.Eq("id", 2)));
            var (rows, appendCount) = Read(path, owner);
            Assert.Equal([(3L, "c"), (1, "a2"), (10, "a"), (11, "a")], rows);
            Assert.Equal(2, appendCount);
        }
    }

    [Fact]
    public async Task Writer_WaitsMaxDelayForMoreCallsBeforeWriting()
    {
        var path = Base("delay.jzm");
        await using var w = JazminFile.OpenWriter(path, maxDelay: TimeSpan.FromMilliseconds(200));
        var a = w.InsertAsync([Row(10, "x")]);
        await Task.Delay(5);
        var b = w.InsertAsync([Row(11, "y")]);
        Assert.Equal(1, (await a).AppendCount);
        Assert.Equal(1, (await b).AppendCount); // the second call joined the first one's append
    }

    [Fact]
    public async Task Writer_ABatchThatFailsForAReasonNotAboutItsCalls_LeavesTheFileByteForByte()
    {
        var path = Base("locked.jzm");
        var before = File.ReadAllBytes(path);
        File.WriteAllText(path + ".lock", ""); // another writer holds the file
        var w = JazminFile.OpenWriter(path);
        var calls = new[] { w.InsertAsync([Row(10, "x")]), w.InsertAsync([Row(11, "y")]) };
        foreach (var call in calls) await Assert.ThrowsAnyAsync<Exception>(() => call);
        await w.DisposeAsync();
        Assert.Equal(before, File.ReadAllBytes(path));
        File.Delete(path + ".lock");
    }

    [Fact]
    public async Task TransactionsAndTheWriter_MatchOneAppendPerCall_WithAutoCompact_SeveralTables_AndCompositeDecimalKeys()
    {
        static Dictionary<string, object?> Priced(string code, string price, string v) => new() { ["code"] = code, ["price"] = price, ["v"] = v };
        var setups = new (string Name, Func<JazminAppend> Options, Func<string, string> Write, Call[] Calls, string? Table)[]
        {
            ("autoCompact", () => new JazminAppend { KeyColumns = ["id"], AutoCompact = new JazminAutoCompact(Appends: 1), Now = Now }, name => Base(name),
                [Insert(Row(10, "x")), Upsert(Row(2, "B"), Row(11, "y")), Delete(JazminFilter.Eq("id", 1L))], null),
            ("tables", () => new JazminAppend { KeyColumns = ["id"], Table = "orders", Now = Now }, name =>
            {
                var path = Path.Combine(_dir, name);
                using (var writer = JazminWriter.Create(path, new JazminWriteOptions { Now = Now, Tables = [new JazminTable("notes", [new("n", JazminType.Int)]), new JazminTable("orders", Columns)] }))
                {
                    writer.WriteRow(new Dictionary<string, object?> { ["n"] = 1L });
                    writer.StartTable("orders");
                    writer.WriteRow(Row(1, "a"));
                    writer.WriteRow(Row(2, "b"));
                }
                return path;
            }, [Upsert(Row(2, "B"), Row(3, "c")), Delete(JazminFilter.Eq("id", 1L)), Insert(Row(4, "d"))], "orders"),
        };
        foreach (var (name, options, write, calls, table) in setups)
        {
            var expected = write($"{name}-seq.jzm");
            var (inserted, updated, deleted) = (0L, 0L, 0L);
            foreach (var c in calls)
            {
                var append = options();
                if (c.Kind == "insert") append.Insert = c.Rows!;
                else if (c.Kind == "upsert") append.Upsert = c.Rows!;
                else append.Delete = c.Filter;
                var r = JazminFile.Append(expected, append);
                (inserted, updated, deleted) = (inserted + r.Inserted, updated + r.Updated, deleted + r.Deleted);
            }
            var viaTx = write($"{name}-tx.jzm");
            JazminAppendResult committed;
            using (var tx = JazminFile.BeginAppend(viaTx, options()))
            {
                Run(tx, calls);
                committed = tx.Commit();
            }
            Assert.Equal(RowsOf(expected, table), RowsOf(viaTx, table));
            Assert.Equal((inserted, updated, deleted), (committed.Inserted, committed.Updated, committed.Deleted));
            if (table is not null) Assert.Equal(RowsOf(expected, "notes"), RowsOf(viaTx, "notes"));
            var viaWriter = write($"{name}-writer.jzm");
            await using (var w = JazminFile.OpenWriter(viaWriter, options()))
                await Task.WhenAll(calls.Select(c => Send(w, c)));
            Assert.Equal(RowsOf(expected, table), RowsOf(viaWriter, table));
        }

        // Composite keys with a decimal: '1.5' and '1.50' are one key, and in one call the last row for a key wins.
        JazminColumn[] priced = [new("code", JazminType.String), new("price", JazminType.Decimal), new("v", JazminType.String)];
        string Prices(string name)
        {
            var path = Path.Combine(_dir, name);
            using (var writer = JazminWriter.Create(path, priced, new JazminWriteOptions { Now = Now }))
                foreach (var row in new[] { Priced("A", "1.50", "a"), Priced("A", "2.00", "b"), Priced("B", "1.5", "c") }) writer.WriteRow(row);
            return path;
        }
        JazminAppend Keyed() => new() { KeyColumns = ["code", "price"], Now = Now };
        var seq = Prices("priced-seq.jzm");
        var first = Keyed();
        first.Upsert = [Priced("A", "1.5", "A1"), Priced("A", "1.500", "A2")];
        JazminFile.Append(seq, first);
        var second = Keyed();
        second.Delete = JazminFilter.Eq("v", "b");
        JazminFile.Append(seq, second);
        var third = Keyed();
        third.Upsert = [Priced("B", "1.50", "C")];
        JazminFile.Append(seq, third);
        var pricedTx = Prices("priced-tx.jzm");
        using (var tx = JazminFile.BeginAppend(pricedTx, Keyed()))
        {
            tx.Upsert([Priced("A", "1.5", "A1"), Priced("A", "1.500", "A2")]);
            tx.Delete(JazminFilter.Eq("v", "b"));
            tx.Upsert([Priced("B", "1.50", "C")]);
            tx.Commit();
        }
        Assert.Equal(RowsOf(seq, null), RowsOf(pricedTx, null));
    }

    private static List<string> RowsOf(string path, string? table)
    {
        using var r = JazminReader.Open(path, new JazminReadOptions { Table = table });
        return r.Rows().Select(x => string.Join(",", x.Values.Select(v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)))).ToList();
    }
}
