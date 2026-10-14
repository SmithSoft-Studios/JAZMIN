using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Links between a file's tables (<see cref="JazminWriteOptions.Links"/>, <see cref="JazminReader.Links"/>,
/// <see cref="JazminReader.CheckLinks"/>): declared in the file, checked when written, kept through renames, and checked
/// against the rows. Mirrors js/test/links.test.js.
/// </summary>
public sealed class LinksTests
{
    private static readonly JazminColumn[] ClientColumns = [new("clientId", JazminType.String), new("name", JazminType.String)];
    private static readonly JazminColumn[] TxColumns = [new("clientId", JazminType.String), new("amount", JazminType.Decimal)];
    private static readonly JazminLink Client = new("client", new JazminLinkSide("transactions", ["clientId"]), new JazminLinkSide("clients", ["clientId"]));
    private static readonly (string Id, string Name)[] Clients = [("C1", "Ann"), ("C2", "Ben"), ("C2", "Ben again"), ("C4", "Dee")];
    private static readonly string?[] TxClients = [null, "C1", "C1", "C2", "C3", "C5", "C5"]; // in clientId order, empty first

    private static string Write(bool sorted, IReadOnlyList<JazminLink>? links = null)
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-links-").FullName, "statements.jzm");
        using var writer = JazminWriter.Create(file, new JazminWriteOptions
        {
            Links = links ?? [Client],
            Tables = [
                new JazminTable("clients", ClientColumns) { SortedBy = sorted ? ["clientId"] : null },
                new JazminTable("transactions", TxColumns) { SortedBy = sorted ? ["clientId"] : null },
            ],
        });
        foreach (var (id, name) in Clients) writer.WriteRow(new Dictionary<string, object?> { ["clientId"] = id, ["name"] = name });
        writer.StartTable("transactions");
        for (var i = 0; i < TxClients.Length; i++) writer.WriteRow(new Dictionary<string, object?> { ["clientId"] = TxClients[i], ["amount"] = $"{i}" });
        return file;
    }

    [Theory]
    [InlineData(true, "merge")]
    [InlineData(false, "hash")]
    public void Links_are_declared_read_back_and_checked_the_same_way_sorted_or_not(bool sorted, string method)
    {
        using var reader = JazminReader.Open(Write(sorted));
        Assert.Equal([Client.Name], reader.Links.Select(l => l.Name));
        Assert.Equal(["clientId"], reader.Links[0].From.Columns);
        // The metadata as the JavaScript library writes it.
        Assert.Equal("""[{"name":"client","from":{"table":"transactions","columns":["clientId"]},"to":{"table":"clients","columns":["clientId"]}}]""",
            reader.Metadata["jazmin.links"]!.ToJsonString());
        var check = reader.CheckLinks(limit: 1).Single();
        Assert.Equal((method, 7L, 1L, 3L, 1L), (check.Method, check.Rows, check.Empty, check.Missing, check.DuplicateTargets));
        Assert.Equal("C3", check.Examples.Single()[0]);
        Assert.Equal("C2", check.DuplicateExamples.Single()[0]);
    }

    [Fact]
    public void Links_are_checked_when_written_and_follow_a_renamed_table()
    {
        void Refused(JazminLink link, string message) =>
            Assert.Contains(message, Assert.Throws<JazminValidationException>(() => Write(false, [link])).Message);
        Refused(Client with { To = new JazminLinkSide("nope", ["clientId"]) }, "Link 'client': to table 'nope' isn't in the file");
        Refused(Client with { To = new JazminLinkSide("clients", ["nope"]) }, "table 'clients' has no column 'nope'");
        Refused(Client with { From = new JazminLinkSide("transactions", ["amount"]) }, "transactions.amount is decimal but clients.clientId is string");
        Assert.Contains("declared twice", Assert.Throws<JazminValidationException>(() => Write(false, [Client, Client])).Message);

        var file = Write(false);
        JazminFile.Update(file, new JazminUpdate { RenameTables = new Dictionary<string, string> { ["transactions"] = "tx" } });
        using (var reader = JazminReader.Open(file)) Assert.Equal("tx", reader.Links.Single().From.Table);
        Assert.Contains("Link 'client' uses table 'tx', which is being removed",
            Assert.Throws<JazminValidationException>(() => JazminFile.Update(file, new JazminUpdate { RemoveTables = ["tx"] })).Message);
        JazminFile.Update(file, new JazminUpdate { RemoveTables = ["tx"], Links = [] });
        using (var reader = JazminReader.Open(file))
        {
            Assert.Empty(reader.Links);
            Assert.Null(reader.Metadata["jazmin.links"]);
        }
    }

    [Fact]
    public void A_table_linked_to_itself_a_link_of_two_columns_and_a_check_after_an_append()
    {
        static string Show(JazminLinkCheck c) => $"{c.Rows} {c.Empty} {c.Missing} [{string.Join("; ", c.Examples.Select(e => string.Join(",", e)))}] {c.Method}";
        var dir = Directory.CreateTempSubdirectory("jazmin-links-").FullName;
        var staff = Path.Combine(dir, "staff.jzm");
        using (var w = JazminWriter.Create(staff, new JazminWriteOptions
        {
            Tables = [new JazminTable("employees", [new("id", JazminType.Int), new("managerId", JazminType.Int)]) { SortedBy = ["id"] }],
            Links = [new JazminLink("manager", new JazminLinkSide("employees", ["managerId"]), new JazminLinkSide("employees", ["id"]))],
        }))
        {
            w.WriteValues(1L, null);
            w.WriteValues(2L, 1L);
            w.WriteValues(3L, 9L);
        }
        using (var r = JazminReader.Open(staff)) Assert.Equal("3 1 1 [9] hash", Show(r.CheckLinks().Single()));
        JazminFile.Append(staff, new JazminAppend { Table = "employees", Insert = [new Dictionary<string, object?> { ["id"] = 4L, ["managerId"] = 3L }], Delete = JazminFilter.Eq("id", 1L) });
        using (var r = JazminReader.Open(staff)) Assert.Equal("3 0 2 [1; 9] hash", Show(r.CheckLinks().Single()));

        foreach (var (sorted, method) in new[] { (true, "merge"), (false, "hash") })
        {
            var file = Path.Combine(dir, $"visits-{sorted}.jzm");
            JazminColumn[] columns = [new("region", JazminType.String), new("code", JazminType.Int)];
            IReadOnlyList<string>? order = sorted ? ["region", "code"] : null;
            using (var w = JazminWriter.Create(file, new JazminWriteOptions
            {
                Tables = [new JazminTable("places", columns) { SortedBy = order }, new JazminTable("visits", columns) { SortedBy = order }],
                Links = [new JazminLink("place", new JazminLinkSide("visits", ["region", "code"]), new JazminLinkSide("places", ["region", "code"]))],
            }))
            {
                w.WriteValues("A", 1L); w.WriteValues("A", 2L); w.WriteValues("B", 1L);
                w.StartTable("visits");
                w.WriteValues("A", 1L); w.WriteValues("A", 3L); w.WriteValues("B", null); w.WriteValues("B", 1L);
            }
            using var r = JazminReader.Open(file);
            Assert.Equal($"4 1 1 [A,3] {method}", Show(r.CheckLinks().Single()));
        }
    }
}
