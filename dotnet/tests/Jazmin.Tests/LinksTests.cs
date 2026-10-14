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
}
