using System.Globalization;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Changing rows with <see cref="JazminUpdate.Set"/> and <see cref="JazminUpdate.Where"/>, and several tables in one
/// rewrite (<see cref="JazminUpdate.Tables"/>): a client's key changed in every table that refers to it, rows moved to
/// their place when a sort column changes, a shared file's partitions kept. Mirrors js/test/rekey.test.js.
/// </summary>
[Collection("Temporary sort folders")] // re-sorts make and delete jazmin-sort-* in the temp folder, which these tests count
public sealed class RekeyTests
{
    private static readonly JazminColumn[] ClientColumns = [new("clientId", JazminType.String) { Nullable = false }, new("name", JazminType.String)];
    private static readonly JazminColumn[] TxColumns = [new("clientId", JazminType.String) { Nullable = false }, new("amount", JazminType.Decimal), new("status", JazminType.String)];
    private static readonly string[] Names = ["Ann", "Ben", "Cat"];
    private static readonly JazminLink Client = new("client", new JazminLinkSide("transactions", ["clientId"]), new JazminLinkSide("clients", ["clientId"]));

    private static Dictionary<string, object?> Tx(string client, string amount, string status) => new() { ["clientId"] = client, ["amount"] = amount, ["status"] = status };

    private static string Write(JazminKey? owner = null, JazminAccessOptions? access = null)
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-rekey-").FullName, "statements.jzm");
        var shared = access is not null;
        using var writer = JazminWriter.Create(file, new JazminWriteOptions
        {
            Key = owner, Access = access, Links = shared ? null : [Client],
            Tables = [
                new JazminTable("clients", ClientColumns) { SortedBy = shared ? null : ["clientId"], PartitionBy = shared ? "clientId" : null },
                new JazminTable("transactions", TxColumns) { SortedBy = shared ? null : ["clientId"], PartitionBy = shared ? "clientId" : null },
            ],
        });
        for (var c = 0; c < 3; c++) writer.WriteRow(new Dictionary<string, object?> { ["clientId"] = $"C{c + 1}", ["name"] = Names[c] });
        writer.StartTable("transactions");
        for (var i = 0; i < 30; i++) writer.WriteRow(Tx($"C{i / 10 + 1}", $"{i}.25", "open"));
        return file;
    }

    private static List<JazminRow> Rows(string file, string table, JazminReadOptions? options = null)
    {
        using var reader = JazminReader.Open(file, new JazminReadOptions { Key = options?.Key, AccessKey = options?.AccessKey, Table = table });
        return reader.Rows().ToList();
    }

    [Fact]
    public void A_clients_key_is_changed_in_every_table_in_one_rewrite_rows_move_and_the_link_still_holds()
    {
        var file = Write();
        var result = JazminFile.Update(file, new JazminUpdate
        {
            Table = "clients", Set = new Dictionary<string, object?> { ["clientId"] = "C9" }, Where = JazminFilter.Eq("clientId", "C1"),
            Tables = new Dictionary<string, JazminTableChanges>
            {
                ["transactions"] = new() { Set = new Dictionary<string, object?> { ["clientId"] = "C9" }, Where = JazminFilter.Eq("clientId", "C1") },
            },
            SortRunRows = 4, // more rows than this go through the sorter's temporary files (transactions); fewer are merged in (clients)
        });
        Assert.Equal((3L, 1L), (result.RowCount, result.Updated));
        Assert.Equal(new JazminUpdateResult(30, 0, 10, 0), result.Tables!["transactions"]);
        Assert.Equal(new JazminUpdateResult(3, 0, 1, 0), result.Tables["clients"] with { Tables = null });
        Assert.Equal(["C2", "C3", "C9"], Rows(file, "clients").Select(r => (string)r["clientId"]!));
        var tx = Rows(file, "transactions");
        Assert.Equal(Enumerable.Repeat("C2", 10).Concat(Enumerable.Repeat("C3", 10)).Concat(Enumerable.Repeat("C9", 10)), tx.Select(r => (string)r["clientId"]!));
        Assert.Equal(Enumerable.Range(0, 10).Select(i => i + 0.25m), tx.Skip(20).Select(r => Convert.ToDecimal(r["amount"], CultureInfo.InvariantCulture))); // equal keys keep their order
        using var reader = JazminReader.Open(file);
        var check = reader.CheckLinks().Single();
        Assert.Equal((0L, "merge"), (check.Missing, check.Method));
    }

    [Fact]
    public void Set_on_columns_the_order_does_not_use_keeps_the_order_deletes_go_first_and_upserts_replace_whole_rows()
    {
        var file = Write();
        var result = JazminFile.Update(file, new JazminUpdate
        {
            Table = "transactions",
            Delete = JazminFilter.Eq("amount", "0.25"),
            Upsert = [Tx("C1", "1.25", "paid by hand")], KeyColumns = ["clientId", "amount"],
            Insert = [Tx("C2", "99.00", "new")],
            Set = new Dictionary<string, object?> { ["status"] = "closed" }, Where = JazminFilter.Eq("clientId", "C1"),
        });
        Assert.Equal((30L, 1L, 9L, 1L), (result.RowCount, result.Inserted, result.Updated, result.Deleted)); // 1 upserted + 8 set
        Assert.Null(result.Tables);
        var tx = Rows(file, "transactions");
        Assert.Equal(Enumerable.Repeat("closed", 8).Append("paid by hand"), tx.Where(r => (string)r["clientId"]! == "C1").Select(r => (string)r["status"]!)); // an upserted row goes after rows of equal sort value
        Assert.Equal(Enumerable.Repeat("open", 10).Append("new"), tx.Where(r => (string)r["clientId"]! == "C2").Select(r => (string)r["status"]!));

        // Every row: JazminFilter.And().
        JazminFile.Update(file, new JazminUpdate { Table = "transactions", Set = new Dictionary<string, object?> { ["status"] = "archived" }, Where = JazminFilter.And() });
        Assert.All(Rows(file, "transactions"), r => Assert.Equal("archived", r["status"]));
    }

    [Fact]
    public void Changes_that_would_go_wrong_are_refused_before_anything_is_written()
    {
        var file = Write();
        var before = File.ReadAllBytes(file);
        void Refused(JazminUpdate update, string message) =>
            Assert.Contains(message, Assert.Throws<JazminValidationException>(() => JazminFile.Update(file, update)).Message);
        Dictionary<string, object?> Set(string column, object? value) => new() { [column] = value };
        Refused(new JazminUpdate { Set = Set("name", "x") }, "Set and Where go together");
        Refused(new JazminUpdate { Where = JazminFilter.Eq("clientId", "C1") }, "Set and Where go together");
        Refused(new JazminUpdate { Set = new Dictionary<string, object?>(), Where = JazminFilter.And() }, "Set needs a column to set");
        Refused(new JazminUpdate { Set = Set("nope", 1), Where = JazminFilter.And() }, "Table 'clients': Set: unknown column 'nope'");
        Refused(new JazminUpdate { Set = Set("clientId", 5), Where = JazminFilter.And() }, "Table 'clients': Set: Column 'clientId'");
        Refused(new JazminUpdate { Set = Set("clientId", null), Where = JazminFilter.And() }, "Table 'clients': Set: column 'clientId' can't be empty");
        Refused(new JazminUpdate { Tables = new Dictionary<string, JazminTableChanges> { ["nope"] = new() } }, "Tables: the file has no table 'nope'");
        Refused(new JazminUpdate
        {
            Delete = JazminFilter.Eq("clientId", "C1"),
            Tables = new Dictionary<string, JazminTableChanges> { ["clients"] = new() { Delete = JazminFilter.Eq("clientId", "C2") } },
        }, "give table 'clients''s changes either in Tables or with the update's other options");
        Refused(new JazminUpdate
        {
            RemoveTables = ["transactions"], Links = [],
            Tables = new Dictionary<string, JazminTableChanges> { ["transactions"] = new() { Set = Set("status", "x"), Where = JazminFilter.And() } },
        }, "Table 'transactions' is being removed");
        Assert.Equal(before, File.ReadAllBytes(file));

        // The main table's changes can be given in Tables; the others are copied as they are.
        var result = JazminFile.Update(file, new JazminUpdate
        {
            Tables = new Dictionary<string, JazminTableChanges> { ["clients"] = new() { Set = Set("name", "Benjamin"), Where = JazminFilter.Eq("clientId", "C2") } },
        });
        Assert.Equal(["clients"], result.Tables!.Keys);
        Assert.Equal(["Ann", "Benjamin", "Cat"], Rows(file, "clients").Select(r => (string)r["name"]!));
        Assert.Equal(30, Rows(file, "transactions").Count(r => (string)r["status"]! == "open"));
    }

    [Fact]
    public void A_shared_files_partition_column_cant_be_set_other_columns_can_and_each_key_sees_its_own_rows()
    {
        var owner = JazminKey.Generate();
        var ann = owner.CreateAccessKey();
        var file = Write(owner, new JazminAccessOptions { Grants = [new JazminGrant(ann) { Rows = ["C1"] }] });
        JazminTableChanges Changes(string column, string value) =>
            new() { Set = new Dictionary<string, object?> { [column] = value }, Where = JazminFilter.Eq("clientId", "C1") };
        Assert.Contains("Table 'transactions': Set changes the partition column 'clientId': the rows would leave the partitions keys are granted",
            Assert.Throws<JazminValidationException>(() => JazminFile.Update(file, new JazminUpdate
            {
                Key = owner, Tables = new Dictionary<string, JazminTableChanges> { ["transactions"] = Changes("clientId", "C9") },
            })).Message);
        JazminFile.Update(file, new JazminUpdate { Key = owner, Tables = new Dictionary<string, JazminTableChanges> { ["transactions"] = Changes("status", "paid") } });
        var seen = Rows(file, "transactions", new JazminReadOptions { AccessKey = ann });
        Assert.Equal(10, seen.Count);
        Assert.All(seen, r => Assert.Equal(("C1", "paid"), ((string)r["clientId"]!, (string)r["status"]!)));
    }
}
