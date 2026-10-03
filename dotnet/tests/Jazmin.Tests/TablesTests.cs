using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Several tables in one file (TASKS D-3, docs/design/several-tables.md). Mirrors js/test/tables.test.js.</summary>
public sealed class TablesTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-tables-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly JazminColumn[] ClientColumns =
    [
        new("clientId", JazminType.String) { Nullable = false }, new("name", JazminType.String), new("address", JazminType.String),
    ];

    private static readonly JazminColumn[] TransactionColumns =
    [
        new("clientId", JazminType.String) { Nullable = false }, new("line", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] },
        new("amount", JazminType.Decimal),
    ];

    private static readonly string[] ClientIds = ["C1", "C2", "C3"];

    private static readonly object?[][] Clients = ClientIds.Select(id => new object?[] { id, $"Client {id}", $"{id} Long Street, Cape Town" }).ToArray();

    private static readonly object?[][] Transactions = ClientIds.SelectMany((id, c) =>
        Enumerable.Range(0, 50).Select(i => new object?[] { id, (long)(c * 50 + i), $"{i}.25" })).ToArray();

    private static List<JazminTable> Tables(bool partitioned = false, Dictionary<string, string[]>? clientGroups = null) =>
    [
        new JazminTable("clients", ClientColumns) { SortedBy = ["clientId"], PartitionBy = partitioned ? "clientId" : null, ColumnGroups = clientGroups ?? new() },
        new JazminTable("transactions", TransactionColumns) { SortedBy = ["clientId", "line"], ChunkRows = 20, PartitionBy = partitioned ? "clientId" : null },
    ];

    private static byte[] WriteTables(JazminWriteOptions options, IEnumerable<object?[]>? extra = null)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, options, leaveOpen: true))
        {
            foreach (var row in Clients) writer.WriteValues(row);
            writer.StartTable("transactions");
            foreach (var row in Transactions) writer.WriteValues(row);
        }
        return stream.ToArray();
    }

    private string Save(string name, byte[] data)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllBytes(path, data);
        return path;
    }

    [Fact]
    public void TwoTables_AreWrittenOneAfterTheOther_AndReadByName()
    {
        var file = WriteTables(new JazminWriteOptions { Tables = Tables() });
        using var first = JazminReader.Open(file);
        Assert.Equal(["clients", "transactions"], first.Tables);
        Assert.Equal("clients", first.TableName); // the first table by default
        Assert.Equal(Clients.Select(c => (string)c[1]!), first.Rows().Select(r => (string)r["name"]!));

        using var t = JazminReader.Open(file, new JazminReadOptions { Table = "transactions" });
        Assert.Equal("transactions", t.TableName);
        Assert.Equal(150, t.RowCount);
        Assert.Equal(["clientId", "line", "amount"], t.Columns.Select(c => c.Name));
        Assert.Equal([("line", JazminIndexKind.Sorted)], t.Indexes);
        Assert.Equal("index", t.Explain(JazminFilter.Eq("line", 77L)).Strategy);
        Assert.Equal("C2", t.Find(JazminFilter.Eq("line", 77L)).Single()["clientId"]);
        Assert.Equal(50, t.Count(JazminFilter.Eq("clientId", "C2")));
        Assert.Equal(8, t.ChunkCount); // 20-row chunks
        var error = Assert.Throws<JazminValidationException>(() => JazminReader.Open(file, new JazminReadOptions { Table = "nope" }));
        Assert.Contains("no table 'nope' (tables: 'clients', 'transactions')", error.Message);
    }

    [Fact]
    public void TableDefinitions_AreCheckedBeforeAnythingIsWritten()
    {
        void Bad(JazminWriteOptions options, string message) =>
            Assert.Contains(message, Assert.Throws<JazminValidationException>(() => new JazminWriter(new MemoryStream(), options)).Message);
        Bad(new JazminWriteOptions { Tables = [] }, "at least one table");
        Bad(new JazminWriteOptions { Tables = [new JazminTable("", ClientColumns)] }, "needs a name");
        Bad(new JazminWriteOptions { Tables = [new JazminTable("a", ClientColumns), new JazminTable("a", ClientColumns)] }, "declared twice");
        Bad(new JazminWriteOptions { Tables = Tables(), SortedBy = ["clientId"] }, "in each table");
        Bad(new JazminWriteOptions { Tables = [new JazminTable("a", ClientColumns) { PartitionBy = "clientId" }] }, "need an access-controlled file");
        Bad(new JazminWriteOptions { Tables = [new JazminTable("a", ClientColumns) { SortedBy = ["nope"] }] }, "unknown column 'nope'");
        Assert.Contains("in each table", Assert.Throws<JazminValidationException>(() => new JazminWriter(new MemoryStream(), ClientColumns, new JazminWriteOptions { Tables = Tables() })).Message);

        using var writer = new JazminWriter(new MemoryStream(), new JazminWriteOptions { Tables = Tables() });
        Assert.Contains("no table 'nope'", Assert.Throws<JazminValidationException>(() => writer.StartTable("nope")).Message);
        writer.StartTable("transactions");
        Assert.Contains("already been written", Assert.Throws<JazminValidationException>(() => writer.StartTable("transactions")).Message);
        Assert.Equal("transactions", writer.TableName);
    }

    [Fact]
    public void Tables_CanBeWrittenInAnyOrder_AndATableNeverStartedIsWrittenEmpty()
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions { Tables = [.. Tables(), new JazminTable("notes", [new JazminColumn("text", JazminType.String)])] }, leaveOpen: true))
        {
            writer.StartTable("transactions");
            foreach (var row in Transactions) writer.WriteValues(row);
        }
        var file = stream.ToArray();
        using var clients = JazminReader.Open(file);
        Assert.Equal(["clients", "transactions", "notes"], clients.Tables); // the declared order
        Assert.Equal(0, clients.RowCount);
        using var transactions = clients.OpenTable("transactions");
        Assert.Equal(150, transactions.RowCount);
        using var notes = clients.OpenTable("notes");
        Assert.Equal(["text"], notes.Columns.Select(c => c.Name));
    }

    [Fact]
    public void EncryptedWithAKey_EachTableIsLocked()
    {
        var key = JazminKey.Generate();
        var file = WriteTables(new JazminWriteOptions { Key = key, Tables = Tables() });
        using var t = JazminReader.Open(file, new JazminReadOptions { Key = key, Table = "transactions" });
        Assert.Equal(3L, t.Find(JazminFilter.Eq("line", 3L)).Single()["line"]);
        Assert.DoesNotContain("Long Street", System.Text.Encoding.Latin1.GetString(file));
    }

    [Fact]
    public void Access_FollowsThePartitions_AndALookupTableNeedsStar()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var carol = owner.CreateAccessKey();
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions { Grants = [new JazminGrant(bob) { Rows = ["C1"] }, new JazminGrant(carol) { Rows = ["C2", "*"] }] },
            Tables = [.. Tables(partitioned: true, clientGroups: new() { ["contact"] = ["address"] }), new JazminTable("rates", [new JazminColumn("currency", JazminType.String), new JazminColumn("rate", JazminType.Float)])],
        }, leaveOpen: true))
        {
            foreach (var row in Clients) writer.WriteValues(row);
            writer.StartTable("transactions");
            foreach (var row in Transactions) writer.WriteValues(row);
            writer.StartTable("rates");
            writer.WriteValues("USD", 18.2);
        }
        var file = stream.ToArray();
        List<JazminRow> Read(JazminAccessKey key, string table)
        {
            using var r = JazminReader.Open(file, new JazminReadOptions { AccessKey = key, Table = table, CheckClockRollback = false });
            return r.Rows().ToList();
        }
        Assert.Equal(["C1"], Read(bob, "clients").Select(r => (string)r["clientId"]!));
        Assert.Equal(["C1"], Read(bob, "transactions").Select(r => (string)r["clientId"]!).Distinct());
        Assert.Empty(Read(bob, "rates")); // not granted '*'
        Assert.Equal("C2 Long Street, Cape Town", Read(carol, "clients").Single()["address"]); // the contact group of the clients table
        Assert.Equal(18.2, Read(carol, "rates").Single()["rate"]);
        using var ownerReader = JazminReader.Open(file, new JazminReadOptions { Key = owner, Table = "transactions" });
        Assert.Equal(150, ownerReader.RowCount);
        Assert.Equal([("line", JazminIndexKind.Sorted)], ownerReader.Indexes);
    }

    [Fact]
    public void OpenTable_ReadsAnotherTableOfTheSameOpenFile()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Save("shared.jzm", WriteTables(new JazminWriteOptions
        {
            Key = owner, Access = new JazminAccessOptions { Grants = [new JazminGrant(bob) { Rows = ["C2"] }] }, Tables = Tables(partitioned: true),
        }));
        var clients = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false });
        var transactions = clients.OpenTable("transactions");
        Assert.Equal("transactions", transactions.TableName);
        Assert.Throws<JazminValidationException>(() => clients.OpenTable("nope"));
        clients.Dispose(); // the file stays open for the other reader
        Assert.Equal(50, transactions.RowCount);
        var third = transactions.OpenTable("clients");
        Assert.Equal("Client C2", third.Get(1)["name"]);
        transactions.Dispose();
        if (OperatingSystem.IsWindows())
            Assert.Throws<JazminException>(() => JazminFile.Update(path, new JazminUpdate { Key = owner })); // `third` still holds the file
        third.Dispose();
        JazminFile.Update(path, new JazminUpdate { Key = owner }); // every reader closed: the file can be replaced
        Assert.Throws<ObjectDisposedException>(() => third.OpenTable("transactions"));
    }

    [Fact]
    public void AppendUpdateAndCompact_ChangeOneTable_AndKeepTheOthers()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var path = Save("statements.jzm", WriteTables(new JazminWriteOptions
        {
            Key = owner, Access = new JazminAccessOptions { Grants = [new JazminGrant(bob) { Rows = ["C1", "C4"] }] }, Tables = Tables(partitioned: true),
        }));
        JazminFile.Append(path, new JazminAppend
        {
            Key = owner, Table = "transactions", Delete = JazminFilter.Lt("line", 10L),
            Insert = [new Dictionary<string, object?> { ["clientId"] = "C4", ["line"] = 1000L, ["amount"] = "9.99" }],
        });
        JazminFile.Append(path, new JazminAppend
        {
            Key = owner, Table = "clients", Insert = [new Dictionary<string, object?> { ["clientId"] = "C4", ["name"] = "Client C4", ["address"] = "Durban" }],
        });
        var transactionsOf = new JazminReadOptions { Key = owner, Table = "transactions" };
        using (var t = JazminReader.Open(path, transactionsOf))
        {
            Assert.Equal(141, t.RowCount);
            Assert.Equal(2, t.AppendCount);
            Assert.Equal("9.99", t.Find(JazminFilter.Eq("line", 1000L)).Single()["amount"]); // the appended index segment
        }
        using (var c = JazminReader.Open(path, new JazminReadOptions { Key = owner })) Assert.Equal(4, c.RowCount);
        using (var b = JazminReader.Open(path, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }))
        {
            Assert.Equal(["C1", "C4"], b.Rows().Select(r => (string)r["clientId"]!));
            using var bt = b.OpenTable("transactions");
            Assert.Equal(["C1", "C4"], bt.Rows().Select(r => (string)r["clientId"]!).Distinct().Order());
        }

        var result = JazminFile.Update(path, new JazminUpdate
        {
            Key = owner, Table = "clients", KeyColumns = ["clientId"],
            Upsert = [new Dictionary<string, object?> { ["clientId"] = "C1", ["name"] = "Renamed", ["address"] = "x" }],
        });
        Assert.Equal(4, result.RowCount);
        Assert.Equal(1, result.Updated);
        using (var c = JazminReader.Open(path, new JazminReadOptions { Key = owner })) Assert.Equal("Renamed", c.Get(0)["name"]);
        using (var t = JazminReader.Open(path, transactionsOf))
        {
            Assert.Equal(141, t.RowCount); // copied into the new version
            Assert.Equal(0, t.AppendCount);
        }

        JazminFile.Compact(path, owner);
        using (var t = JazminReader.Open(path, transactionsOf))
        {
            Assert.Equal(["clients", "transactions"], t.Tables);
            Assert.Single(t.Find(JazminFilter.Eq("line", 1000L)));
        }
        JazminFile.RevokeAccess(path, owner, bob);
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(path, new JazminReadOptions { AccessKey = bob, Table = "transactions", CheckClockRollback = false }));
    }

    [Fact]
    public void ANormalizedFile_IsSmallerThanTheFlatOne()
    {
        // A statement file: 2,000 clients with their details, 10 transactions each (mirrored in js/test/tables.test.js).
        string[] details = ["name", "address", "city", "email", "phone", "taxNumber"];
        var detailColumns = details.Select(d => new JazminColumn(d, JazminType.String)).ToArray();
        string[] cities = ["Cape Town", "Durban", "Johannesburg", "Pretoria"];
        var people = Enumerable.Range(0, 2000).Select(c => new object?[]
        {
            $"C{c:00000}", $"Client {c} Trading (Pty) Ltd", $"{c % 997} Long Street, Unit {c % 50}", cities[c % 4], $"accounts{c}@client{c}.co.za",
            $"+27 21 {c * 7919 % 10_000_000:0000000}", (4_000_000_000L + c * 13).ToString(System.Globalization.CultureInfo.InvariantCulture),
        }).ToArray();
        var lines = people.SelectMany((p, c) => Enumerable.Range(0, 10).Select(i => new object?[] { p[0], (long)(c * 10 + i), $"{(c * 31 + i * 17) % 10_000}.{i}0" })).ToArray();
        var flat = TestData.Write([.. TransactionColumns, .. detailColumns], lines.Select(l => (object?[])[.. l, .. people[(int)((long)l[1]! / 10)].Skip(1)]),
            new JazminWriteOptions { SortedBy = ["clientId", "line"] });
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Tables =
            [
                new JazminTable("clients", [ClientColumns[0], .. detailColumns]) { SortedBy = ["clientId"] },
                new JazminTable("transactions", TransactionColumns) { SortedBy = ["clientId", "line"] },
            ],
        }, leaveOpen: true))
        {
            foreach (var row in people) writer.WriteValues(row);
            writer.StartTable("transactions");
            foreach (var row in lines) writer.WriteValues(row);
        }
        // Dictionary encoding already stores a chunk's repeated values once, so the saving is modest.
        Assert.True(stream.Length < flat.Length * 0.99, $"normalized {stream.Length} bytes, flat {flat.Length}");
    }
}
