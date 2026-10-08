using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Format;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Nested columns (spec 5.4, reader feature 'nested-columns'): list and object members stored as columns of their own
/// fields, opt-in. Every read path gives the objects that were written, the same as json columns do; untyped rows show
/// the same JSON; lookups read one row's slice of each stream.
/// </summary>
public sealed class NestedColumnTests : IDisposable
{
    public sealed class Project
    {
        public string Code { get; set; } = "";
        public decimal Revenue { get; set; }
        public DateTime Start { get; set; }
        public string? Note { get; set; }
        public int? Hours { get; set; }
    }

    public sealed class Employee
    {
        public string Name { get; set; } = "";
        public bool Active { get; set; }
        public double Score { get; set; }
        public List<Project>? Projects { get; set; }
        public string[] Tags { get; set; } = [];
        public byte[]? Photo { get; set; }
        public JsonNode? Extra { get; set; } // a json field inside a nested object
        public Employee? Mentor { get; set; } // contains itself: stays json
    }

    public sealed class Address
    {
        public string Street { get; set; } = "";
        public string? City { get; set; }
    }

    public sealed record Point(double X, double Y); // a constructor with parameters

    public sealed class Company
    {
        public int Id { get; set; }
        public string Tier { get; set; } = "";
        public List<Employee?>? Staff { get; set; }
        public Address? Head { get; set; }
        public List<int> Scores { get; set; } = [];
        public List<List<string?>>? Grid { get; set; }
        public Point? Location { get; set; }
        public Dictionary<string, int> Counts { get; set; } = []; // not nestable: stays json
    }

    private static readonly DateTime Epoch = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private static Company Make(int i) => new()
    {
        Id = i,
        Tier = i % 3 == 0 ? "Gold" : "Silver",
        Staff = i % 7 == 0 ? null : i % 5 == 0 ? [] : [.. Enumerable.Range(0, 1 + i % 4).Select(n => n == 2 ? null : new Employee
        {
            Name = $"E{i}-{n} ünï €",
            Active = (i + n) % 2 == 0,
            Score = (i * 10 + n) / 4.0,
            Projects = n == 1 ? null : [.. Enumerable.Range(0, (i + n) % 3).Select(k => new Project
            {
                Code = $"P{(i + k) % 9}", Revenue = k == 0 ? 9.50m : 1000m + i, Start = Epoch.AddDays(i + k).AddSeconds(n),
                Note = k % 2 == 0 ? null : "note", Hours = k == 1 ? null : k * 8,
            })],
            Tags = i % 4 == 0 ? [] : ["a", $"t{n}"],
            Photo = n == 0 ? [(byte)i, 0, 255] : null,
            Extra = n == 3 ? new JsonObject { ["i"] = i, ["list"] = new JsonArray(1, "x") } : null,
            Mentor = n == 0 && i % 2 == 0 ? new Employee { Name = "M" } : null,
        })],
        Head = i % 3 == 0 ? null : new Address { Street = $"{i} Main", City = i % 2 == 0 ? "Durban" : null },
        Scores = [.. Enumerable.Range(0, i % 5).Select(n => n * i)],
        Grid = i % 4 == 0 ? null : [[], ["x", null, $"{i}"], [null]],
        Location = i % 6 == 0 ? null : new Point(i / 2.0, -i),
        Counts = new() { ["a"] = i },
    };

    private static readonly List<Company> Companies = Enumerable.Range(0, 150).Select(Make).ToList();

    private static readonly JazminSerializerSettings Nested = new() { NestedColumns = true, ChunkRows = 32 };
    private static readonly JazminSerializerSettings AsJson = new() { ChunkRows = 32 };

    private static readonly byte[] NestedFile = JazminConvert.SerializeObject(Companies, Nested);
    private static readonly byte[] JsonFile = JazminConvert.SerializeObject(Companies, AsJson);

    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-nested-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static string Text(object? value) => JsonSerializer.Serialize(value);

    /// <summary>Datetime fields are written as datetime columns are (with milliseconds), not as .NET wrote them into JSON.</summary>
    private static string Dates(string text) => System.Text.RegularExpressions.Regex.Replace(text, @"(T\d\d:\d\d:\d\d)\.000Z", "$1Z");

    private static void Same(IEnumerable<Company> actual, IEnumerable<Company>? expected = null) =>
        Assert.Equal((expected ?? Companies).Select(Text), actual.Select(Text));

    /// <summary>A query over the file gives what it gives over the list.</summary>
    private static void SameQuery<T>(IQueryable<Company> file, Func<IQueryable<Company>, T> query) =>
        Assert.Equal(Text(query(Companies.AsQueryable())), Text(query(file)));

    [Fact]
    public void Members_AreStoredAsNestedColumns_OnlyWhenAskedFor()
    {
        using (var reader = JazminReader.Open(JsonFile))
            Assert.All(reader.Columns.Where(c => c.Name is not ("Id" or "Tier")), c => Assert.Equal(JazminType.Json, c.Type));
        using (var reader = JazminReader.Open(NestedFile))
        {
            // A member that contains itself (Mentor), a dictionary (Counts), and JsonNode members stay json.
            Assert.Equal(
            [
                "Id: int", "Tier: string?",
                "Staff: list<object{Name: string?, Active: bool, Score: float, Projects: list<object{Code: string?, Revenue: decimal, Start: datetime, Note: string?, Hours: int?}?>?, Tags: list<string?>?, Photo: binary?, Extra: json?, Mentor: json?}?>?",
                "Head: object{Street: string?, City: string?}?", "Scores: list<int>?", "Grid: list<list<string?>?>?", "Location: object{X: float, Y: float}?", "Counts: json?",
            ], reader.Columns.Select(c => c.ToString()));
        }
        Assert.Contains(FormatConstants.NestedColumns, ReaderFeatures(NestedFile));
        Assert.DoesNotContain(FormatConstants.NestedColumns, ReaderFeatures(JsonFile));
        Assert.True(NestedFile.Length < JsonFile.Length);
    }

    public sealed class Chosen
    {
        public int Id { get; set; }
        [JazminNested] public List<Address> Addresses { get; set; } = [];
        [JazminNested(false)] public Address? Kept { get; set; }
        public List<int> Plain { get; set; } = [];
    }

    public sealed class Refused
    {
        [JazminNested] public Dictionary<string, int> Counts { get; set; } = [];
    }

    [Fact]
    public void TheAttribute_ChoosesPerMember_AndRefusesWhatCannotBeNested()
    {
        var items = new List<Chosen> { new() { Id = 1, Addresses = [new() { Street = "a" }], Kept = new() { Street = "b" }, Plain = [1] } };
        foreach (var settings in new[] { new JazminSerializerSettings(), new JazminSerializerSettings { NestedColumns = true } })
        {
            var file = JazminConvert.SerializeObject(items, settings);
            using var reader = JazminReader.Open(file);
            Assert.Equal(JazminType.List, reader.Columns.Single(c => c.Name == "Addresses").Type);
            Assert.Equal(JazminType.Json, reader.Columns.Single(c => c.Name == "Kept").Type);
            Assert.Equal(settings.NestedColumns ? JazminType.List : JazminType.Json, reader.Columns.Single(c => c.Name == "Plain").Type);
            Assert.Equal(Text(items), Text(JazminConvert.DeserializeObject<List<Chosen>>(file, settings)));
        }
        var error = Assert.Throws<JazminValidationException>(() => JazminConvert.SerializeObject(new List<Refused> { new() }));
        Assert.Contains("cannot be stored as nested columns", error.Message);
    }

    [Fact]
    public void EveryReadPath_GivesTheObjectsWritten_WithNullsAndEmptyListsAtEveryLevel()
    {
        Same(JazminConvert.DeserializeObject<List<Company>>(NestedFile, Nested)!);
        Same(JazminConvert.DeserializeObject<List<Company>>(NestedFile)!); // read settings do not matter: the file says how
        using var reader = JazminReader.Open(NestedFile);
        Same(reader.Rows<Company>());
        Same(reader.Query<Company>(c => c.Id % 7 == 3), Companies.Where(c => c.Id % 7 == 3));
        var q = reader.AsQueryable<Company>();
        SameQuery(q, s => s.Where(c => c.Id > 30).Skip(5).Take(20).ToList());
        SameQuery(q, s => s.Where(c => c.Staff != null).SelectMany(c => c.Staff!).Where(e => e != null && e.Projects != null)
            .SelectMany(e => e!.Projects!, (e, p) => new { e!.Name, p.Code, p.Revenue, p.Hours }).ToList());
        SameQuery(q, s => s.Select(c => new { c.Id, c.Head, Cities = c.Head == null ? null : c.Head.City, c.Location }).ToList());
        SameQuery(q, s => s.Where(c => c.Grid != null).Select(c => c.Grid!.Count + c.Scores.Sum()).ToList());
    }

    [Fact]
    public void Lookups_AndSelectiveScans_GiveTheirRowsWhole()
    {
        // One row: its slice of each stream. Many rows: every row decoded, text made only for those returned.
        using var reader = JazminReader.Open(NestedFile);
        var q = reader.AsQueryable<Company>();
        foreach (var c in Companies) Assert.Equal(Text(c), Text(q.Single(x => x.Id == c.Id)));
        SameQuery(q, s => s.Where(c => c.Id == 40 || c.Id == 43).ToList());
        SameQuery(q, s => s.Where(c => c.Id % 3 == 1).ToList());
        SameQuery(q, s => s.Where(c => c.Tier == "Gold" && c.Id > 100).Select(c => c.Staff).ToList());
        Assert.Equal(Companies.Where(c => c.Staff is null).Select(c => (long)c.Id), reader.Find(JazminFilter.IsNull("Staff")).Select(r => (long)r["Id"]!));
        Assert.Equal(Companies.Where(c => c.Head is not null).Select(c => (long)c.Id), reader.Find(JazminFilter.IsNull("Head", false)).Select(r => (long)r["Id"]!));
        Assert.Throws<JazminValidationException>(() => reader.Find(JazminFilter.Eq("Scores", 1L)).ToList()); // not ordered, as json
        foreach (var c in Companies.Where(c => c.Id % 10 == 0))
            Assert.Equal(Text(Untyped(JsonFile, c.Id)), Dates(Text(Untyped(NestedFile, c.Id))));
    }

    private static Dictionary<string, JsonNode?> Untyped(byte[] file, int id)
    {
        using var reader = JazminReader.Open(file);
        var row = reader.Find(JazminFilter.Eq("Id", (long)id)).Single();
        return reader.Columns.ToDictionary(c => c.Name, c => row[c.Name] is { } v ? v as JsonNode ?? JsonValue.Create(v) : null);
    }

    [Fact]
    public void UntypedRowsAndExports_ShowTheSameJson_AsJsonColumns()
    {
        Assert.Equal(JazminConvert.ToJson(JsonFile), Dates(JazminConvert.ToJson(NestedFile)));
        Assert.Equal(JazminConvert.ToCsv(JsonFile), Dates(JazminConvert.ToCsv(NestedFile)));
        Assert.Equal(JazminConvert.ToXml(JsonFile), Dates(JazminConvert.ToXml(NestedFile)));
        using var json = JazminReader.Open(JsonFile);
        using var nested = JazminReader.Open(NestedFile);
        var row = nested.Rows().First(r => (long)r["Id"]! == 1);
        Assert.Same(row["Staff"], row["Staff"]); // made once per row
        Assert.Equal(json.Rows().Select(r => Text(r["Staff"])), nested.Rows().Select(r => Dates(Text(r["Staff"]))));
    }

    [Fact]
    public void AppendAndCompact_KeepNestedValues()
    {
        var path = Path.Combine(_dir, "a.jzm");
        File.WriteAllBytes(path, JazminConvert.SerializeObject(Companies.Take(100).ToList(), Nested));
        var map = TypeMap.For(typeof(Company), Nested);
        IReadOnlyDictionary<string, object?> Row(Company c) => map.Columns.Select(x => x.Name).Zip(map.ToValues(c, Nested)).ToDictionary(p => p.First, p => p.Second);
        // As .NET objects, and as JSON (how untyped callers give them).
        string[] nestedMembers = ["Staff", "Head", "Scores", "Grid", "Location"];
        var asJson = Row(Companies[101]).ToDictionary(p => p.Key, p => nestedMembers.Contains(p.Key) ? JsonSerializer.SerializeToNode(p.Value) : p.Value);
        JazminFile.Append(path, new JazminAppend { Insert = [Row(Companies[100]), asJson, .. Companies.Skip(102).Select(Row)] });
        Same(JazminConvert.DeserializeObject<List<Company>>(File.ReadAllBytes(path))!);
        JazminFile.Append(path, new JazminAppend { Delete = JazminFilter.Lt("Id", 10L) });
        JazminFile.Compact(path);
        Same(JazminConvert.DeserializeObject<List<Company>>(File.ReadAllBytes(path))!, Companies.Skip(10));
        using var reader = JazminReader.Open(path);
        Assert.Equal(JazminType.List, reader.Columns.Single(c => c.Name == "Staff").Type);
    }

    public sealed class Reading
    {
        public double Value { get; set; }
        public string Label { get; set; } = "";
    }

    public sealed class Sensor
    {
        public int Id { get; set; }
        public List<Reading> Readings { get; set; } = [];
    }

    [Fact]
    public void FloatsThatAreNotFinite_AreKept_AndWrittenAsNullInOutput()
    {
        var sensors = new List<Sensor>
        {
            new() { Id = 1, Readings = [new() { Value = double.NaN, Label = "NaN" }, new() { Value = double.PositiveInfinity }, new() { Value = double.NegativeInfinity }] },
            new() { Id = 2, Readings = [new() { Value = -0.0, Label = "Infinity" }] },
        };
        var path = Path.Combine(_dir, "sensors.jzm");
        File.WriteAllBytes(path, JazminConvert.SerializeObject(sensors, Nested));
        // Output follows spec 10.1 (null); a string field that reads "NaN" stays text.
        Assert.Equal("""[{"Id":1,"Readings":[{"Value":null,"Label":"NaN"},{"Value":null,"Label":""},{"Value":null,"Label":""}]},{"Id":2,"Readings":[{"Value":-0,"Label":"Infinity"}]}]""",
            JazminConvert.ToJson(File.ReadAllBytes(path)));
        // Untyped rows keep them (as text), so rewriting the file keeps them too.
        JazminFile.Append(path, new JazminAppend { Delete = JazminFilter.Eq("Id", 99L) });
        JazminFile.Compact(path);
        var back = JazminConvert.DeserializeObject<List<Sensor>>(File.ReadAllBytes(path))!;
        Assert.Equal([double.NaN, double.PositiveInfinity, double.NegativeInfinity], back[0].Readings.Select(r => r.Value));
        Assert.True(double.IsNegative(back[1].Readings[0].Value));
    }

    // A class as first written, and as it is later: a new member, a new list member, a new member inside the list's items.
    public sealed class TaskV1
    {
        public string Title { get; set; } = "";
    }

    public sealed class TaskV2
    {
        public string Title { get; set; } = "";
        public int? Hours { get; set; }
    }

    public sealed class TeamV1
    {
        public int Id { get; set; }
        public string Tier { get; set; } = "";
        public List<TaskV1> Tasks { get; set; } = [];
    }

    public sealed class TeamV2
    {
        public int Id { get; set; }
        public string Tier { get; set; } = "";
        public List<TaskV2> Tasks { get; set; } = [];
        public List<string>? Tags { get; set; }
    }

    private static readonly JazminSerializerSettings Grown = new() { NestedColumns = true, ChunkRows = 8 };

    private static Dictionary<string, object?> RowOf(TeamV2 t) => new() { ["Id"] = (long)t.Id, ["Tier"] = t.Tier, ["Tasks"] = t.Tasks };

    [Fact]
    public void AppendedObjectsWithNewMembers_AddFields_AndEarlierRowsReadThemAsNull()
    {
        var path = Path.Combine(_dir, "grown.jzm");
        var before = Enumerable.Range(0, 20).Select(i => new TeamV1 { Id = i, Tier = i % 2 == 0 ? "Gold" : "Silver", Tasks = [.. Enumerable.Range(0, i % 3).Select(k => new TaskV1 { Title = $"T{i}-{k}" })] }).ToList();
        File.WriteAllBytes(path, JazminConvert.SerializeObject(before, Grown));
        var after = Enumerable.Range(20, 20).Select(i => new TeamV2 { Id = i, Tier = "Gold", Tasks = [.. Enumerable.Range(0, i % 3).Select(k => new TaskV2 { Title = $"T{i}-{k}", Hours = k == 1 ? null : k * 4 })] }).ToList();
        JazminFile.Append(path, new JazminAppend { Insert = [.. after.Select(RowOf)] });

        var expected = before.Select(t => new TeamV2 { Id = t.Id, Tier = t.Tier, Tasks = [.. t.Tasks.Select(k => new TaskV2 { Title = k.Title })] }).Concat(after).ToList();
        void Check()
        {
            var bytes = File.ReadAllBytes(path);
            Assert.Equal(Text(expected), Text(JazminConvert.DeserializeObject<List<TeamV2>>(bytes)));
            using var reader = JazminReader.Open(bytes);
            Assert.Equal("Tasks: list<object{Title: string?, Hours: int?}?>?", reader.Columns.Single(c => c.Name == "Tasks").ToString());
            foreach (var id in new[] { 0, 5, 19, 20, 33 }) // lookups in chunks written before and after
                Assert.Equal(Text(expected[id]), Text(reader.AsQueryable<TeamV2>().Single(t => t.Id == id)));
            Assert.Equal(Text(expected.Where(t => t.Id % 3 == 0)), Text(reader.AsQueryable<TeamV2>().Where(t => t.Id % 3 == 0).ToList()));
            Assert.Equal("""[{"Title":"T1-0","Hours":null}]""", ((JsonNode)reader.Find(JazminFilter.Eq("Id", 1L)).Single()["Tasks"]!).ToJsonString());
        }
        Check();
        JazminFile.Compact(path); // every chunk written again, with every field
        Check();
    }

    [Fact]
    public void FieldsAreAddedFromDefinitionsGiven_AndOtherChangesAreRefused()
    {
        var path = Path.Combine(_dir, "given.jzm");
        JazminColumn[] columns = [new("id", JazminType.Int), JazminColumn.ObjectOf("head", new JazminColumn("city", JazminType.String))];
        using (var w = JazminWriter.Create(path, columns)) w.WriteValues([1L, JsonNode.Parse("""{"city":"Durban"}""")]);
        JazminColumn Head(params JazminColumn[] fields) => JazminColumn.ObjectOf("head", fields);
        IReadOnlyDictionary<string, object?> Row(long id, string head) => new Dictionary<string, object?> { ["id"] = id, ["head"] = JsonNode.Parse(head) };

        // JSON rows: the new field's definition is given.
        Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend { Insert = [Row(2, """{"city":"Gqeberha","zip":"6001"}""")] }));
        JazminFile.Append(path, new JazminAppend { Insert = [Row(2, """{"city":"Gqeberha","zip":"6001"}""")], Columns = [Head(new JazminColumn("city", JazminType.String), new JazminColumn("zip", JazminType.String))] });
        Assert.Equal(["""{"city":"Durban","zip":null}""", """{"city":"Gqeberha","zip":"6001"}"""], JazminReader.Open(path).Rows().Select(r => ((JsonNode)r["head"]!).ToJsonString()));

        void Refused(JazminColumn definition, string message) =>
            Assert.Contains(message, Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend { Columns = [definition] })).Message);
        Refused(Head(new JazminColumn("city", JazminType.String)), "fields cannot be removed");
        Refused(Head(new JazminColumn("zip", JazminType.String), new JazminColumn("city", JazminType.String)), "fields cannot be renamed or reordered");
        Refused(Head(new JazminColumn("city", JazminType.Int), new JazminColumn("zip", JazminType.String)), "a string cannot become a int");
        Refused(Head(new JazminColumn("city", JazminType.String), new JazminColumn("zip", JazminType.String), new JazminColumn("country", JazminType.String) { Nullable = false }), "a field added later must allow null");
        Refused(new JazminColumn("id", JazminType.Int), "only those can be given fields");

        // Writing .NET objects that have members the definition lacks is refused, never left out.
        using var writer = new JazminWriter(new MemoryStream(), [JazminColumn.ListOf("tasks", JazminColumn.ObjectOf("item", new JazminColumn("Title", JazminType.String)))]);
        var error = Assert.Throws<JazminValidationException>(() => writer.WriteValues([new List<TaskV2> { new() { Title = "a", Hours = 2 } }]));
        Assert.Contains("TaskV2 has 'Hours', which is not one of its fields", error.Message);
    }

    [Fact]
    public void AnAccessControlledFile_GrowsALockedColumnGroup_AndUpdateGrowsToo()
    {
        var owner = JazminKey.Generate();
        var gold = owner.CreateAccessKey();
        var path = Path.Combine(_dir, "grown-access.jzm");
        var map = TypeMap.For(typeof(TeamV1), Grown);
        using (var writer = JazminWriter.Create(path, map.Columns, new JazminWriteOptions
        {
            Key = owner,
            ChunkRows = 4,
            Access = new JazminAccessOptions { PartitionBy = "Tier", ColumnGroups = new() { ["work"] = ["Tasks"] }, Grants = [new JazminGrant(gold) { Rows = ["Gold"] }] },
        }))
            writer.WriteValues(map.ToValues(new TeamV1 { Id = 1, Tier = "Gold", Tasks = [new() { Title = "a" }] }, Grown));
        JazminFile.Append(path, new JazminAppend { Key = owner, Insert = [RowOf(new TeamV2 { Id = 2, Tier = "Gold", Tasks = [new() { Title = "b", Hours = 3 }] })] });
        using (var reader = JazminReader.Open(path, new JazminReadOptions { AccessKey = gold, CheckClockRollback = false }))
            Assert.Equal("""[{"Id":1,"Tier":"Gold","Tasks":[{"Title":"a","Hours":null}],"Tags":null},{"Id":2,"Tier":"Gold","Tasks":[{"Title":"b","Hours":3}],"Tags":null}]""",
                JsonSerializer.Serialize(reader.Rows<TeamV2>()));

        // Update (a rewrite) adds fields from objects the same way.
        var plain = Path.Combine(_dir, "grown-update.jzm");
        File.WriteAllBytes(plain, JazminConvert.SerializeObject(new List<TeamV1> { new() { Id = 1, Tasks = [new() { Title = "a" }] } }, Grown));
        JazminFile.Update(plain, new JazminUpdate { Insert = [RowOf(new TeamV2 { Id = 2, Tasks = [new() { Title = "b", Hours = 5 }] })] });
        Assert.Equal([null, 5], JazminConvert.DeserializeObject<List<TeamV2>>(File.ReadAllBytes(plain))!.Select(t => t.Tasks[0].Hours));
    }

    [Fact]
    public void AnAccessControlledFile_ReadsItsRows_WithTheSameObjects()
    {
        var owner = JazminKey.Generate();
        var gold = owner.CreateAccessKey();
        var map = TypeMap.For(typeof(Company), Nested);
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, map.Columns, new JazminWriteOptions
        {
            Key = owner,
            ChunkRows = 32,
            Access = new JazminAccessOptions { PartitionBy = "Tier", Grants = [new JazminGrant(gold) { Rows = ["Gold"] }] },
        }, leaveOpen: true))
            foreach (var c in Companies) writer.WriteValues(map.ToValues(c, Nested));
        using var reader = JazminReader.Open(stream.ToArray(), new JazminReadOptions { AccessKey = gold, CheckClockRollback = false });
        Same(reader.Rows<Company>(), Companies.Where(c => c.Tier == "Gold"));
    }

    [Fact]
    public void ColumnsDefinedByHand_TakeJsonValues()
    {
        JazminColumn[] columns =
        [
            new("id", JazminType.Int) { Nullable = false },
            JazminColumn.ListOf("lines", JazminColumn.ObjectOf("item", new JazminColumn("sku", JazminType.String), new JazminColumn("qty", JazminType.Int))),
        ];
        var lines = new[] { """[{"sku":"a","qty":1},{"sku":null,"qty":2}]""", "[]", null, """[null]""" };
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, columns, new JazminWriteOptions(), leaveOpen: true))
            for (var i = 0; i < lines.Length; i++) writer.WriteValues([(long)i, lines[i] is null ? null : JsonNode.Parse(lines[i]!)]);
        using var reader = JazminReader.Open(stream.ToArray());
        Assert.Equal(lines, reader.Rows().Select(r => (r["lines"] as JsonNode)?.ToJsonString()));
        // A row whose nested value is bad deep inside is refused whole, as other bad rows are: the rows before and
        // after it are written, and nothing of it.
        using var again = new MemoryStream();
        using (var w = new JazminWriter(again, columns, new JazminWriteOptions(), leaveOpen: true))
        {
            w.WriteValues([1L, JsonNode.Parse("""[{"sku":"a","qty":1}]""")]);
            var bad = Assert.Throws<JazminValidationException>(() => w.WriteValues([2L, JsonNode.Parse("""[{"sku":"b","qty":1},{"sku":"c","qty":"many"}]""")]));
            Assert.Contains("Column 'lines[].qty'", bad.Message);
            Assert.Throws<JazminValidationException>(() => w.WriteValues([3L, JsonNode.Parse("""[{"sku":"d","colour":"red"}]""")]));
            w.WriteValues([4L, JsonNode.Parse("""[{"sku":"e","qty":5}]""")]);
            w.Finish();
        }
        using var kept = JazminReader.Open(again.ToArray());
        Assert.Equal(["""[{"sku":"a","qty":1}]""", """[{"sku":"e","qty":5}]"""], kept.Rows().Select(r => ((JsonNode)r["lines"]!).ToJsonString()));
    }

    [Fact]
    public void DamagedNestedStreams_FailWithJazminException()
    {
        // Every chunk payload damaged byte by byte, decoded with the file's columns: an error is a JazminFormatException.
        var file = JazminConvert.SerializeObject(Companies, new JazminSerializerSettings { NestedColumns = true, ChunkRows = 16, Codec = JazminCodec.None });
        using var reader = JazminReader.Open(file);
        var schema = reader.Columns;
        var types = schema.Select(c => c.Type).ToArray();
        var payload = Fuzzing.Payloads([file]).Where(p => p.Length > 200).MaxBy(p => p.Length)!;
        var intact = Columnar.DecodeTyped(payload, payload.Length, types, 16, 0, schema: schema);
        Assert.IsType<NestedValues>(intact[2]); // a chunk: Staff
        var (decoded, failed) = (0, 0);
        var rng = new Random(7);
        for (var n = 0; n < 3000; n++)
        {
            var damaged = (byte[])payload.Clone();
            for (var k = 1 + rng.Next(3); k > 0; k--) damaged[rng.Next(damaged.Length)] = (byte)rng.Next(256);
            if (n % 10 == 0) damaged = damaged[..rng.Next(damaged.Length)];
            try
            {
                var rows = 16;
                var wanted = n % 3 == 0 ? null : Enumerable.Range(0, rows).Select(r => r == n % rows).ToArray();
                var columns = Columnar.DecodeTyped(damaged, damaged.Length, types, rows, 0, rows: wanted, schema: schema);
                for (var j = 0; j < columns.Length; j++)
                    if (columns[j] is NestedValues nested)
                        for (var r = 0; r < rows; r++)
                            if (wanted is null || wanted[r]) _ = (nested.Get(r), nested.Read(r, Members[schema[j].Name], null));
                decoded++;
            }
            catch (JazminException)
            {
                failed++; // damaged (or decoded, then refused by the member's type)
            }
        }
        Assert.True(decoded > 100 && failed > 100, $"{decoded} decoded, {failed} failed");
    }

    [Fact]
    public void ColumnsNestedTooDeeply_AreRefused_WhenWrittenAndWhenRead()
    {
        static JazminColumn Deep(int levels) => levels == 0 ? new JazminColumn("item", JazminType.Int) : JazminColumn.ListOf("item", Deep(levels - 1));
        using (var ok = new JazminWriter(new MemoryStream(), [JazminColumn.ListOf("x", Deep(FormatConstants.MaxNestingDepth - 1))])) ok.WriteValues([null]);
        var error = Assert.Throws<JazminValidationException>(() => new JazminWriter(new MemoryStream(), [JazminColumn.ListOf("x", Deep(FormatConstants.MaxNestingDepth))]));
        Assert.Contains("nested more than 64 levels deep", error.Message);
        var sorted = Assert.Throws<JazminValidationException>(() => new JazminWriter(new MemoryStream(), [JazminColumn.ListOf("x", Deep(0))], new JazminWriteOptions { SortedBy = ["x"] }));
        Assert.Contains("SortedBy: a list column cannot be sorted", sorted.Message);
        // A file is never read so deep that reading it could exhaust the stack.
        var definitions = Catalog.EncodeColumnDefinitions([ColumnDef.Of(JazminColumn.ListOf("x", Deep(200)), 0)]);
        Assert.Throws<JazminFormatException>(() => Catalog.DecodeColumnDefinitions(definitions));
    }

    private static readonly Dictionary<string, Type> Members = typeof(Company).GetProperties().ToDictionary(p => p.Name, p => p.PropertyType);

    private static List<string> ReaderFeatures(byte[] bytes)
    {
        var trailer = bytes.AsSpan(bytes.Length - FormatConstants.TrailerSize);
        var at = (int)BinaryPrimitives.ReadUInt64LittleEndian(trailer);
        var length = (int)BinaryPrimitives.ReadUInt32LittleEndian(trailer[8..]);
        return Catalog.DecodeHeader(SectionCodec.Decode(bytes[at..(at + length)], null, bytes[8..24], "header")).ReaderFeatures;
    }
}
