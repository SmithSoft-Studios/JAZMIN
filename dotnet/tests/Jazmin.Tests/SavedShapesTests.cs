using System.Text;
using System.Text.Json.Nodes;
using Jazmin.Formats;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Saved export shapes (docs/design/saved-shapes.md): kept in the file directories, listed only for keys that can use
/// them, refused when a key that would see one can't see a column it uses (as js/test/saved-shapes.test.js).
/// </summary>
public class SavedShapesTests
{
    private static readonly JazminColumn[] Columns =
    [
        new("id", JazminType.Int), new("account", JazminType.String), new("amount", JazminType.Float),
        new("balance", JazminType.Float), new("region", JazminType.String),
    ];

    private static readonly object?[][] Rows = Enumerable.Range(0, 40)
        .Select(i => new object?[] { (long)i, $"A{i % 4}", i * 1.5, 1000.0 - i, i % 2 == 1 ? "ZA" : "NA" }).ToArray();

    private static JsonObject Json(string text) => JsonNode.Parse(text)!.AsObject();
    private static readonly string Totals = """{"$groupBy":"account","$sort":["account"],"$rows":{"account":"account","total":{"$sum":"amount"},"count":{"$count":true}}}""";
    private static readonly string Balances = """{"$rows":{"id":"id","balance":"balance"},"$limit":3}""";

    private static JazminSavedShape Shape(string name, string shape, IReadOnlyList<string>? groups = null) => new(name, Json(shape)) { Groups = groups };

    private static string[] Names(JazminReader r) => r.Shapes.Select(s => s.Name).ToArray();

    private static string Temp(string name)
    {
        var dir = Directory.CreateTempSubdirectory("jazmin-shapes-").FullName;
        return Path.Combine(dir, name);
    }

    private sealed record Shared(JazminKey Owner, JazminAccessKey Bob, JazminAccessKey Sally);

    /// <summary>Bob sees region ZA and not the money group; Sally sees everything and the named file group 'finance'.</summary>
    private static Shared WriteShared(string path, params JazminSavedShape[] shapes)
    {
        var owner = JazminKey.Generate();
        var keys = new Shared(owner, owner.CreateAccessKey(), owner.CreateAccessKey());
        File.WriteAllBytes(path, TestData.Write(Columns, Rows, new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions
            {
                PartitionBy = "region",
                ColumnGroups = new() { ["money"] = ["balance"] },
                Grants =
                [
                    new JazminGrant(keys.Bob) { Rows = ["ZA"], Columns = ["*"], Label = "Bob" },
                    new JazminGrant(keys.Sally) { Files = ["finance"], Label = "Sally" },
                ],
            },
            Shapes = shapes,
        }));
        return keys;
    }

    [Fact]
    public void SavedShape_ListedByName_ExportsWhatTheShapeExports()
    {
        var file = TestData.Write(Columns, Rows, new JazminWriteOptions
        {
            Shapes = [new JazminSavedShape("Totals", Json(Totals)) { IsDefault = true, Description = "Per account" }, Shape("Balances", Balances)],
        });
        using var r = JazminReader.Open(file);
        Assert.Equal(["Balances", "Totals"], Names(r));
        var totals = r.Shapes[1];
        Assert.Equal(("Per account", true, (string?)null, "*"), (totals.Description, totals.IsDefault, totals.Table, string.Join(",", totals.Groups!)));
        Assert.Equal(Json(Totals).ToJsonString(), totals.Shape.ToJsonString());
        var saved = JazminShape.FromFile(r, "Totals");
        Assert.Equal(JazminShape.FromJson(Json(Totals)).ToJson(r), saved.ToJson(r));
        Assert.Equal(JazminShape.FromJson(Json(Totals)).ToJson(r, JazminFilter.Gt("amount", 20.0), indented: true), saved.ToJson(r, JazminFilter.Gt("amount", 20.0), indented: true));
        Assert.Equal(JazminShape.FromJson(Json(Balances)).ToXml(r, root: "balances"), JazminShape.FromFile(r, "Balances").ToXml(r, root: "balances"));
        Assert.Equal(JazminShape.FromJson(Json(Totals)).ToJsonSchema(r).ToJsonString(), saved.ToJsonSchema(r).ToJsonString());
        Assert.Equal("No saved shape 'Nope' is visible with this key", Assert.Throws<JazminValidationException>(() => JazminShape.FromFile(r, "Nope")).Message);
        r.Shapes[0].Shape["$limit"] = 99; // a copy: the reader's list does not change
        Assert.Equal(3, (int)r.Shapes[0].Shape["$limit"]!);
    }

    [Fact]
    public void ShapeThatDoesNotFit_IsRefusedWhenWritten()
    {
        string Refused(params JazminSavedShape[] shapes) =>
            Assert.Throws<JazminValidationException>(() => TestData.Write(Columns, Rows, new JazminWriteOptions { Shapes = shapes })).Message;
        Assert.Equal("Saved shape 'X': Shape at shape[].a: unknown or hidden column 'nope'", Refused(Shape("X", """{"$rows":{"a":"nope"}}""")));
        Assert.Equal("Saved shape 'X': unknown table 'other'", Refused(new JazminSavedShape("X", Json(Totals)) { Table = "other" }));
        Assert.Equal("Saved shape 'X' is given twice", Refused(Shape("X", Totals), Shape("X", Balances)));
        Assert.Equal("Saved shapes 'X' and 'Y' are both the default for everyone",
            Refused(new JazminSavedShape("X", Json(Totals)) { IsDefault = true }, new JazminSavedShape("Y", Json(Balances)) { IsDefault = true }));
        Assert.Equal("shapes[0]: name must be text of 1 to 200 characters", Refused(Shape("", Totals)));
        Assert.Equal("Saved shape 'X': groups must be '*' or a non-empty array", Refused(Shape("X", Totals, [])));
        // Different groups may each have their own default.
        TestData.Write(Columns, Rows, new JazminWriteOptions
        {
            Key = JazminKey.Generate(),
            Shapes = [new JazminSavedShape("X", Json(Totals)) { IsDefault = true, Groups = ["a"] }, new JazminSavedShape("Y", Json(Balances)) { IsDefault = true, Groups = ["b"] }],
        });
    }

    [Fact]
    public void SavedShapes_AreEncryptedWithTheDirectories()
    {
        var key = JazminKey.Generate();
        var single = TestData.Write(Columns, Rows, new JazminWriteOptions { Key = key, Shapes = [Shape("Quarterly balances", Balances)] });
        var path = Temp("shared.jzm");
        WriteShared(path, Shape("Quarterly balances", Balances, ["finance"]));
        foreach (var bytes in new[] { single, File.ReadAllBytes(path) })
        {
            var text = Encoding.Latin1.GetString(bytes);
            Assert.DoesNotContain("Quarterly", text);
            Assert.DoesNotContain("balance", text);
        }
        using var r = JazminReader.Open(single, new JazminReadOptions { Key = key });
        Assert.Equal(["Quarterly balances"], Names(r));
    }

    [Fact]
    public void SharedFile_EachKeySeesOnlyTheShapesOfItsGroupsThatItCanUse()
    {
        var path = Temp("shared.jzm");
        var keys = WriteShared(path,
            Shape("Totals", Totals), Shape("Balances", Balances, ["finance"]), Shape("South", """{"$rows":"id","$limit":2}""", ["ZA"]),
            new JazminSavedShape("North", Json("""{"$rows":"id","$limit":2}""")) { Groups = ["NA"], IsDefault = true });
        using var owner = JazminReader.Open(path, new JazminReadOptions { Key = keys.Owner });
        Assert.Equal(["Balances:finance", "North:NA", "South:ZA", "Totals:*"], owner.Shapes.Select(s => $"{s.Name}:{string.Join(",", s.Groups!)}"));
        using var bob = JazminReader.Open(path, new JazminReadOptions { AccessKey = keys.Bob });
        Assert.Equal(["South", "Totals"], Names(bob));
        Assert.All(bob.Shapes, s => Assert.Null(s.Groups));
        Assert.Throws<JazminValidationException>(() => JazminShape.FromFile(bob, "Balances"));
        Assert.Equal("[1,3]", JazminShape.FromFile(bob, "South").ToJson(bob)); // Bob's rows only
        using var sally = JazminReader.Open(path, new JazminReadOptions { AccessKey = keys.Sally });
        Assert.Equal(["Balances", "North", "South", "Totals"], Names(sally)); // rows '*': every partition's group
        Assert.Equal(JazminShape.FromFile(owner, "Balances").ToJson(owner), JazminShape.FromFile(sally, "Balances").ToJson(sally));
    }

    [Fact]
    public void SharedFile_ShapeIsRefused_WhenAKeyThatWouldSeeItCannotSeeAColumn_AlsoWhenGrantedLater()
    {
        var everyone = Assert.Throws<JazminValidationException>(() => WriteShared(Temp("a.jzm"), Shape("Balances", Balances))).Message;
        Assert.Matches(@"^Saved shape 'Balances' doesn't fit access key [0-9a-f]+ \(Bob\), which sees it \(a shape for everyone\): Shape at shape\[\]\.balance: unknown or hidden column 'balance'$", everyone);
        var partition = Assert.Throws<JazminValidationException>(() => WriteShared(Temp("b.jzm"), Shape("Balances", Balances, ["ZA"]))).Message;
        Assert.Matches(@"^Saved shape 'Balances' doesn't fit access key [0-9a-f]+ \(Bob\), which sees it \(file group 'ZA'\)", partition);

        var path = Temp("shared.jzm");
        var keys = WriteShared(path, Shape("Balances", Balances, ["finance"]), Shape("North balances", Balances, ["NA"]));
        var before = File.ReadAllBytes(path);
        JazminGrant BobFinance(IReadOnlyList<string>? columns) => new(keys.Bob) { Rows = ["ZA"], Columns = columns, Files = ["finance"], Label = "Bob" };
        Assert.Matches(@"\(Bob\), which sees it \(file group 'finance'\)",
            Assert.Throws<JazminValidationException>(() => JazminFile.Update(path, new JazminUpdate { Key = keys.Owner, Grant = [BobFinance(["*"])] })).Message);
        Assert.Matches(@"\(Bob\), which sees it \(file group 'finance'\)",
            Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend { Key = keys.Owner, Grant = [BobFinance(["*"])] })).Message);
        // More rows: Bob's key would see the shapes of partition NA.
        Assert.Matches(@"^Saved shape 'North balances' doesn't fit access key [0-9a-f]+ \(Bob\), which sees it \(file group 'NA'\)",
            Assert.Throws<JazminValidationException>(() => JazminFile.Update(path, new JazminUpdate
            {
                Key = keys.Owner, Grant = [new JazminGrant(keys.Bob) { Rows = ["NA", "ZA"], Columns = ["*"], Label = "Bob" }],
            })).Message);
        Assert.Equal(before, File.ReadAllBytes(path));
        // Seeing the columns too is fine.
        JazminFile.Update(path, new JazminUpdate { Key = keys.Owner, Grant = [BobFinance(null)] });
        using var bob = JazminReader.Open(path, new JazminReadOptions { AccessKey = keys.Bob });
        Assert.Equal(["Balances"], Names(bob));
    }

    [Fact]
    public void AppendUpdateCompactionAndKeyRotation_KeepSavedShapes()
    {
        var path = Temp("f.jzm");
        var key = JazminKey.Generate();
        File.WriteAllBytes(path, TestData.Write(Columns, Rows, new JazminWriteOptions { Key = key, Shapes = [Shape("Totals", Totals), Shape("Balances", Balances)] }));
        string[] NamesWith(JazminKey k)
        {
            using var r = JazminReader.Open(path, new JazminReadOptions { Key = k });
            return Names(r);
        }
        JazminFile.Append(path, new JazminAppend { Key = key, Insert = [new Dictionary<string, object?> { ["id"] = 40L, ["account"] = "A0", ["amount"] = 1.0, ["balance"] = 1.0, ["region"] = "ZA" }] });
        Assert.Equal(["Balances", "Totals"], NamesWith(key));
        JazminFile.Append(path, new JazminAppend { Key = key, AddShapes = [Shape("Ids", """{"$rows":"id","$limit":2}""")], RemoveShapes = ["Balances"] });
        Assert.Equal(["Ids", "Totals"], NamesWith(key));
        JazminFile.Update(path, new JazminUpdate { Key = key, AddShapes = [new JazminSavedShape("Ids", Json("""{"$rows":"id","$limit":1}""")) { Description = "Replaced" }] });
        using (var r = JazminReader.Open(path, new JazminReadOptions { Key = key }))
        {
            Assert.Equal("[0]", JazminShape.FromFile(r, "Ids").ToJson(r));
            Assert.Equal("Replaced", r.Shapes.Single(s => s.Name == "Ids").Description);
        }
        JazminFile.Compact(path, key);
        var newKey = JazminKey.Generate();
        JazminFile.RotateKey(path, new JazminKeyRotation { Key = key, NewKey = newKey });
        using (var r = JazminReader.Open(path, new JazminReadOptions { Key = newKey }))
        {
            Assert.Equal(["Ids", "Totals"], Names(r));
            Assert.Equal(JazminShape.FromJson(Json(Totals)).ToJson(r), JazminShape.FromFile(r, "Totals").ToJson(r));
        }
        Assert.Equal("RemoveShapes: no saved shape 'Gone'",
            Assert.Throws<JazminValidationException>(() => JazminFile.Update(path, new JazminUpdate { Key = newKey, RemoveShapes = ["Gone"] })).Message);
        Assert.Equal("RemoveShapes: no saved shape 'Gone'",
            Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend { Key = newKey, RemoveShapes = ["Gone"] })).Message);
        JazminFile.Update(path, new JazminUpdate { Key = newKey, RemoveShapes = ["Ids", "Totals"] });
        Assert.Empty(NamesWith(newKey));
        // A file without files or shapes gets its first shape by append.
        var plain = Temp("plain.jzm");
        File.WriteAllBytes(plain, TestData.Write(Columns, Rows));
        JazminFile.Append(plain, new JazminAppend { AddShapes = [Shape("Totals", Totals)] });
        using (var r = JazminReader.Open(plain)) Assert.Equal(["Totals"], Names(r));
        Assert.Equal("Saved shape 'Bad': Shape at shape[]: unknown or hidden column 'nope'",
            Assert.Throws<JazminValidationException>(() => JazminFile.Append(plain, new JazminAppend { AddShapes = [Shape("Bad", """{"$rows":"nope"}""")] })).Message);
    }

    [Fact]
    public void SharedFile_CompactionAndANewOwnerKey_KeepSavedShapesForTheSameGroups()
    {
        var path = Temp("shared.jzm");
        var keys = WriteShared(path, Shape("Totals", Totals), Shape("Balances", Balances, ["finance"]));
        JazminFile.Compact(path, keys.Owner);
        var rotated = JazminFile.RotateOwnerKey(path, keys.Owner);
        using (var owner = JazminReader.Open(path, new JazminReadOptions { Key = rotated.OwnerKey }))
            Assert.Equal(["Balances:finance", "Totals:*"], owner.Shapes.Select(s => $"{s.Name}:{string.Join(",", s.Groups!)}"));
        Assert.Equal(["Bob", "Sally"], rotated.AccessKeys.Select(k => k.Label));
        foreach (var k in rotated.AccessKeys)
        {
            using var r = JazminReader.Open(path, new JazminReadOptions { AccessKey = k.Key });
            Assert.Equal(k.Label == "Bob" ? ["Totals"] : ["Balances", "Totals"], Names(r));
        }
    }

    [Fact]
    public void SeveralTables_AShapeReadsItsOwnTable_LinksToOthers_AndIsCheckedAgainstThem()
    {
        var path = Temp("tables.jzm");
        var clients = new JazminTable("clients", [new("id", JazminType.Int), new("name", JazminType.String)]);
        var tx = new JazminTable("tx", [new("client", JazminType.Int), new("amount", JazminType.Float)]);
        var withTx = """{"$rows":{"name":"name","tx":{"$from":"tx","$on":{"client":"id"},"$rows":"amount"}}}""";
        using (var writer = JazminWriter.Create(path, new JazminWriteOptions
        {
            Tables = [clients, tx],
            Shapes = [new JazminSavedShape("Clients", Json(withTx)) { Table = "clients" }, new JazminSavedShape("Amounts", Json("""{"$rows":"amount"}""")) { Table = "tx" }],
        }))
        {
            writer.WriteValues(1L, "Ann");
            writer.WriteValues(2L, "Ben");
            writer.StartTable("tx");
            writer.WriteValues(1L, 5.0);
            writer.WriteValues(2L, 7.0);
            writer.WriteValues(1L, 9.0);
        }
        using (var r = JazminReader.Open(path))
        {
            Assert.Equal(["Amounts:tx", "Clients:"], r.Shapes.Select(s => $"{s.Name}:{s.Table}")); // the first table needs no name
            Assert.Equal("""[{"name":"Ann","tx":[5,9]},{"name":"Ben","tx":[7]}]""", JazminShape.FromFile(r, "Clients").ToJson(r));
            Assert.Equal("[5,7,9]", JazminShape.FromFile(r, "Amounts").ToJson(r)); // read from its own table
            using var txReader = r.OpenTable("tx");
            Assert.Equal(JazminShape.FromFile(r, "Clients").ToJson(r), JazminShape.FromFile(txReader, "Clients").ToJson(txReader));
        }
        JazminFile.Append(path, new JazminAppend
        {
            Table = "tx", Insert = [new Dictionary<string, object?> { ["client"] = 2L, ["amount"] = 1.0 }],
            AddShapes = [new JazminSavedShape("Big", Json("""{"$rows":"amount","$filter":{"amount":{"gt":6}}}""")) { Table = "tx" }],
        });
        using (var r = JazminReader.Open(path))
        {
            Assert.Equal("""[{"name":"Ann","tx":[5,9]},{"name":"Ben","tx":[7,1]}]""", JazminShape.FromFile(r, "Clients").ToJson(r));
            Assert.Equal("[7,9]", JazminShape.FromFile(r, "Big").ToJson(r));
        }
        Assert.Equal("Saved shape 'Bad': Shape at shape[].x.$on.nope: unknown or hidden column 'nope' in table 'tx'",
            Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend
            {
                Table = "tx", AddShapes = [Shape("Bad", """{"$rows":{"x":{"$from":"tx","$on":{"nope":"id"},"$rows":"amount"}}}""")],
            })).Message);
        JazminFile.Update(path, new JazminUpdate { Table = "tx", AddShapes = [new JazminSavedShape("Count", Json("""{"$count":true}""")) { Table = "tx" }] });
        using (var r = JazminReader.Open(path)) Assert.Equal(["Amounts", "Big", "Clients", "Count"], Names(r));
    }
}
