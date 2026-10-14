using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Tables in an existing file (<see cref="JazminUpdate.AddTables"/>, <see cref="JazminUpdate.RemoveTables"/>,
/// <see cref="JazminUpdate.RenameTables"/>): one rewrite that keeps everything else; saved shapes and the document's
/// edits follow a rename; nothing is left reading a table that is gone. Mirrors js/test/tables-change.test.js.
/// </summary>
public sealed class TablesChangeTests
{
    private static readonly JazminColumn[] ClientColumns = [new("clientId", JazminType.String) { Nullable = false }, new("name", JazminType.String)];
    private static readonly JazminColumn[] TxColumns = [new("clientId", JazminType.String) { Nullable = false }, new("amount", JazminType.Decimal), new("at", JazminType.DateTime)];

    private static Dictionary<string, object?> Client(int i) => new() { ["clientId"] = $"C{i}", ["name"] = $"Client {i}" };

    private static Dictionary<string, object?> Tx(int i, int client) =>
        new() { ["clientId"] = $"C{client}", ["amount"] = $"{i}.25", ["at"] = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(i) };

    private static string Write(JazminKey? key, JazminAccessOptions? access = null, JazminPackage? package = null, IReadOnlyList<JazminSavedShape>? shapes = null,
        string txName = "transactions", string? partitionBy = null)
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-tables-change-").FullName, "statements.jzm");
        using var writer = JazminWriter.Create(file, new JazminWriteOptions
        {
            Key = key, Access = access, Package = package, Shapes = shapes,
            Files = package is null ? null : [new JazminFileInput("index.html", Encoding.UTF8.GetBytes("<p>x"))],
            Tables = [new JazminTable("clients", ClientColumns) { PartitionBy = partitionBy }, new JazminTable(txName, TxColumns) { PartitionBy = partitionBy }],
        });
        for (var c = 1; c <= 3; c++) writer.WriteRow(Client(c));
        writer.StartTable(txName);
        for (var i = 0; i < 30; i++) writer.WriteRow(Tx(i, i / 10 + 1));
        return file;
    }

    private static Dictionary<string, long> Tables(string file, JazminReadOptions? options = null)
    {
        using var reader = JazminReader.Open(file, options);
        return reader.Tables.ToDictionary(t => t, t =>
        {
            using var r = reader.OpenTable(t);
            return r.RowCount;
        });
    }

    [Fact]
    public void A_table_is_added_with_its_rows_put_in_its_order_and_the_others_are_kept()
    {
        var key = JazminKey.Generate();
        var file = Write(key);
        var payments = Enumerable.Range(0, 12).Select(i => (IReadOnlyDictionary<string, object?>)Tx(100 - i, i % 3 + 1)).ToList();
        JazminFile.Update(file, new JazminUpdate
        {
            Key = key, SortRunRows = 5,
            AddTables = [new JazminAddedTable(new JazminTable("payments", TxColumns) { SortedBy = ["clientId", "at"] }, payments)],
        });
        Assert.Equal(new Dictionary<string, long> { ["clients"] = 3, ["transactions"] = 30, ["payments"] = 12 }, Tables(file, new JazminReadOptions { Key = key }));
        using var reader = JazminReader.Open(file, new JazminReadOptions { Key = key, Table = "payments" });
        var order = reader.Rows().Select(r => $"{r["clientId"]}|{(DateTime)r["at"]!:O}").ToList();
        Assert.Equal(order.Order(StringComparer.Ordinal), order);
        Assert.Equal(["clientId", "at"], reader.SortedBy!);
    }

    [Fact]
    public void A_renamed_table_takes_shapes_and_the_document_with_it_and_a_removed_one_must_take_them_too()
    {
        var shape = JsonNode.Parse("""{ "$rows": { "name": "name", "lines": { "$from": "tx", "$on": { "clientId": "clientId" }, "$rows": "amount" } } }""")!.AsObject();
        var file = Write(null,
            package: new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Table = "tx", Key = ["clientId", "at"], Columns = ["amount"] } },
            shapes: [new JazminSavedShape("Lines", shape) { Table = "clients" }], txName: "tx");
        JazminFile.Update(file, new JazminUpdate { RenameTables = new Dictionary<string, string> { ["tx"] = "transactions" } });
        using (var reader = JazminReader.Open(file))
        {
            Assert.Equal(["clients", "transactions"], reader.Tables);
            Assert.Equal("transactions", reader.Package!.Edit!.Table);
            Assert.Equal("transactions", (string?)reader.Shapes.Single().Shape["$rows"]!["lines"]!["$from"]);
        }
        void Refused(JazminUpdate change, string message) => Assert.Contains(message, Assert.Throws<JazminValidationException>(() => JazminFile.Update(file, change)).Message);
        Refused(new JazminUpdate { RemoveTables = ["transactions"] }, "The document's edits change table 'transactions', which is being removed");
        JazminFile.Update(file, new JazminUpdate { Package = new JazminPackage { Entry = "index.html" } });
        Refused(new JazminUpdate { RemoveTables = ["transactions"] }, "Saved shape 'Lines' reads table 'transactions', which is being removed");
        JazminFile.Update(file, new JazminUpdate { RemoveTables = ["transactions"], RemoveShapes = ["Lines"] });
        Assert.Equal(["clients"], Tables(file).Keys);
        Refused(new JazminUpdate { RemoveTables = ["nope"] }, "RemoveTables: the file has no table 'nope'");
        Refused(new JazminUpdate { RemoveTables = ["clients"] }, "A file needs at least one table");
        Refused(new JazminUpdate { AddTables = [new JazminAddedTable(new JazminTable("clients", ClientColumns), [])] }, "Table 'clients' would be in the file twice");
    }

    [Fact]
    public void A_shape_and_a_document_reading_the_first_table_keep_reading_it_when_it_is_renamed()
    {
        var file = Write(null,
            package: new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Key = ["clientId"], Columns = ["name"] } },
            shapes: [new JazminSavedShape("Names", JsonNode.Parse("""{ "$rows": "name" }""")!.AsObject())]);
        JazminFile.Update(file, new JazminUpdate { RenameTables = new Dictionary<string, string> { ["clients"] = "people" } });
        using var reader = JazminReader.Open(file);
        Assert.Equal(["people", "transactions"], reader.Tables);
        Assert.Equal("people", reader.Package!.Edit!.Table);
        Assert.Equal("people", reader.Shapes.Single().Table ?? reader.Tables[0]);
    }

    [Fact]
    public void A_shared_file_gets_a_table_each_key_sees_its_own_partitions_of()
    {
        var owner = JazminKey.Generate();
        var ann = owner.CreateAccessKey();
        var file = Write(owner, new JazminAccessOptions { Grants = [new JazminGrant(ann) { Rows = ["C1"] }] }, partitionBy: "clientId");
        var payments = Enumerable.Range(0, 12).Select(i => (IReadOnlyDictionary<string, object?>)Tx(i, i % 3 + 1)).ToList();
        JazminFile.Update(file, new JazminUpdate
        {
            Key = owner, AddTables = [new JazminAddedTable(new JazminTable("payments", TxColumns) { PartitionBy = "clientId" }, payments)],
        });
        using var reader = JazminReader.Open(file, new JazminReadOptions { AccessKey = ann, Table = "payments" });
        var seen = reader.Rows().Select(r => (string)r["clientId"]!).ToList();
        Assert.Equal(4, seen.Count);
        Assert.All(seen, c => Assert.Equal("C1", c));
    }
}
