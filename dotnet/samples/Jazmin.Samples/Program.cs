// Runnable versions of the .NET examples in docs/USER-GUIDE.md.
// Run: dotnet run --project samples/Jazmin.Samples
using System.ComponentModel;
using System.Text.Json.Nodes;
using Jazmin;
using Jazmin.Formats;
using Jazmin.Query;
using Jazmin.Serialization;

var dir = Directory.CreateTempSubdirectory("jazmin-samples-").FullName;
var path = Path.Combine(dir, "customers.jzm");

var customers = new List<Customer>
{
    new() { Id = 1, Name = "Ann Johnson", Country = "ZA", Tier = Tier.Gold, Balance = 1520.75m, Joined = new DateTime(2024, 1, 2, 0, 0, 0, DateTimeKind.Utc) },
    new() { Id = 2, Name = "Bob Smith", Country = null, Tier = Tier.Silver, Balance = 99.10m, Joined = new DateTime(2024, 3, 4, 0, 0, 0, DateTimeKind.Utc) },
    new() { Id = 3, Name = "Thabo Ndlovu", Country = "ZA", Tier = Tier.Bronze, Balance = 0m, Joined = new DateTime(2025, 6, 7, 0, 0, 0, DateTimeKind.Utc) },
};

// --- 1. Newtonsoft-style one-liners ------------------------------------------------------------
byte[] bytes = JazminConvert.SerializeObject(customers);
List<Customer> back = JazminConvert.DeserializeObject<List<Customer>>(bytes)!;
Console.WriteLine($"1. Round-tripped {back.Count} customers in {bytes.Length} bytes");

// --- 2. Encrypted file + LINQ query that uses indexes --------------------------------------------
var key = JazminKey.Generate();
Console.WriteLine($"2. Store this key safely: {key.Export()[..12]}...");
new JazminSerializer(new JazminSerializerSettings { Key = key, Metadata = new JsonObject { ["source"] = "crm" } })
    .Serialize(path, customers);

using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = key }))
{
    foreach (var c in reader.Query<Customer>(c => c.Country == "ZA" && c.Balance > 100m))
        Console.WriteLine($"   LINQ match: {c.Id} {c.Name}");
    Console.WriteLine($"   Plan for Id == 3: {reader.Explain(JazminFilter.Eq("Id", 3))}");
}

// --- 3. Untyped rows and the JSON filter language (same as JavaScript / GraphQL "where") --------
using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = key }))
{
    foreach (var row in reader.Find("""{ "Name": { "icontains": "ndlovu" } }"""))
        Console.WriteLine($"3. Row {row.RowId}: {row["Name"]} joined {row["Joined"]:yyyy-MM-dd}");
}

// --- 4. Streaming writer for very large data (constant memory) ------------------------------------
var bigPath = Path.Combine(dir, "big.jzm");
var columns = new[]
{
    new JazminColumn("id", JazminType.Int) { Nullable = false, Indexes = new[] { JazminIndexKind.Sorted } },
    new JazminColumn("reading", JazminType.Float) { Description = "Sensor reading", Attributes = new JsonObject { ["unit"] = "kPa" } },
};
using (var writer = JazminWriter.Create(bigPath, columns, new JazminWriteOptions { Codec = JazminCodec.Brotli }))
{
    for (long i = 0; i < 1_000_000; i++) writer.WriteValues(i, Math.Sin(i / 1000.0));
}
using (var reader = JazminReader.Open(bigPath))
{
    var row = reader.Find(JazminFilter.Eq("id", 765_432)).Single();
    Console.WriteLine($"4. 1,000,000 rows in {new FileInfo(bigPath).Length / 1024:N0} KB; id 765432 -> {row["reading"]}");
}

// --- 5. Convert to and from JSON / CSV / XML --------------------------------------------------------
var fromJson = JazminConvert.FromJson("""[{"sku":"A1","qty":3},{"sku":"B2","qty":null}]""");
Console.WriteLine("5. " + JazminConvert.ToCsv(fromJson).Replace("\r\n", " | "));
Console.WriteLine("   " + JazminConvert.ToJson(fromJson, new JazminSerializerSettings { NullValueHandling = NullValueHandling.Ignore }));

// --- 6. Append small changes cheaply, then compact when you choose ---------------------------------
var linesPath = Path.Combine(dir, "lines.jzm");
var lineColumns = new[] { new JazminColumn("section", JazminType.String), new JazminColumn("amount", JazminType.Float) };
using (var writer = JazminWriter.Create(linesPath, lineColumns, new JazminWriteOptions { Key = key }))
{
    writer.WriteValues("A", 1.0);
    writer.WriteValues("B", 2.0);
}
var appended = JazminFile.Append(linesPath, new JazminAppend
{
    Key = key,
    Insert = [new Dictionary<string, object?> { ["section"] = "C", ["amount"] = 3.0 }],
    Delete = JazminFilter.Eq("section", "A"),
});
Console.WriteLine($"6. Appended: {appended.Inserted} inserted, {appended.Deleted} deleted, {appended.RowCount} rows now");
var compacted = JazminFile.Compact(linesPath, key);
Console.WriteLine($"   Compacted: {compacted.BytesBefore:N0} -> {compacted.BytesAfter:N0} bytes");

// --- 7. One file, many keys, each for a limited time ----------------------------------------------
// Bob: 2 hours (offline). Sally: 14 days (online - she also needs an unlock token from your key service).
var owner = JazminKey.Generate();
var bob = owner.CreateAccessKey();
var sally = owner.CreateAccessKey();
var sharedPath = Path.Combine(dir, "statements.jzm");
using (var writer = JazminWriter.Create(sharedPath, lineColumns, new JazminWriteOptions
{
    Key = owner,
    SortedBy = ["section"],
    Access = new JazminAccessOptions
    {
        PartitionBy = "section",
        Grants =
        [
            new JazminGrant(bob) { Rows = ["B"], ExpiresIn = TimeSpan.FromHours(2), Label = "Bob" },
            new JazminGrant(sally) { Rows = ["A"], ExpiresIn = TimeSpan.FromDays(14), Mode = JazminGrantMode.Online, Label = "Sally" },
        ],
    },
}))
{
    writer.WriteValues("A", 1.0);
    writer.WriteValues("B", 2.0);
}
// CheckClockRollback = false only stops this sample writing a last-seen record; leave it on in real apps.
using (var bobView = JazminReader.Open(sharedPath, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }))
    Console.WriteLine($"7. Bob sees {bobView.Rows().Count()} row(s) until {bobView.Access!.Expires:u}");
try
{
    using var _ = JazminReader.Open(sharedPath, new JazminReadOptions { AccessKey = sally, CheckClockRollback = false });
}
catch (JazminUnlockRequiredException e)
{
    var token = JazminFile.IssueUnlockToken(sharedPath, owner, e.KeyId); // normally your key service does this, after 2FA
    using var sallyView = JazminReader.Open(sharedPath, new JazminReadOptions { AccessKey = sally, UnlockToken = token, CheckClockRollback = false });
    Console.WriteLine($"   Sally sees {sallyView.Rows().Count()} row(s) until {sallyView.Access!.Expires:u}");
}

// --- 8. Export shapes: nested JSON / XML from flat rows (details taken once per client, with totals) -----
var statementsPath = Path.Combine(dir, "statements.jzm");
using (var writer = JazminWriter.Create(statementsPath,
    [new("client", JazminType.String), new("name", JazminType.String), new("date", JazminType.DateTime), new("amount", JazminType.Float)],
    new JazminWriteOptions { SortedBy = ["client"] }))
{
    writer.WriteValues("C1", "ABC Corp", new DateTime(2025, 3, 1, 0, 0, 0, DateTimeKind.Utc), 1000.0);
    writer.WriteValues("C1", "ABC Corp", new DateTime(2025, 3, 4, 0, 0, 0, DateTimeKind.Utc), 250.5);
    writer.WriteValues("C2", "Test Ltd", new DateTime(2025, 3, 2, 0, 0, 0, DateTimeKind.Utc), 20000.0);
}
var shape = JazminShape.Parse("""
    {
      "clients": {
        "$rows": { "id": "client", "name": "name", "balance": { "$sum": "amount" }, "lines": { "$rows": { "date": "date", "amount": "amount" } } },
        "$groupBy": "client",
        "$xmlItem": "client"
      },
      "total": { "$sum": "amount" }
    }
    """);
using (var statements = JazminReader.Open(statementsPath))
{
    Console.WriteLine("8. " + shape.ToJson(statements));
    Console.WriteLine(shape.ToXml(statements));
}

// --- 9. Async: write from an async source, read without blocking the calling thread ---------------
static async IAsyncEnumerable<object?[]> Cursor()
{
    for (var i = 0; i < 1000; i++)
    {
        if (i % 250 == 0) await Task.Yield(); // e.g. the next page of a database query
        yield return [(long)i, i / 4.0];
    }
}
var asyncPath = Path.Combine(dir, "async.jzm");
await using (var asyncWriter = JazminWriter.Create(asyncPath, [new("id", JazminType.Int) { Nullable = false }, new("amount", JazminType.Float)],
    new JazminWriteOptions { SortedBy = ["id"] }))
{
    await asyncWriter.WriteValuesAsync(Cursor());
}
using (var asyncReader = await JazminReader.OpenAsync(asyncPath))
{
    var total = 0.0;
    await foreach (var row in asyncReader.FindAsync(JazminFilter.Gte("id", 500L))) total += (double)row["amount"]!;
    Console.WriteLine($"9. Async total: {total}");
}

// --- 10. Several tables: client details once, transactions by client (USER-GUIDE section 23) -------
var tablesPath = Path.Combine(dir, "tables.jzm");
using (var tablesWriter = JazminWriter.Create(tablesPath, new JazminWriteOptions
{
    Tables =
    [
        new JazminTable("clients", [new JazminColumn("clientId", JazminType.String), new JazminColumn("name", JazminType.String)]) { SortedBy = ["clientId"], ChunkRows = 256 },
        new JazminTable("transactions", [new JazminColumn("clientId", JazminType.String), new JazminColumn("amount", JazminType.Float)]) { SortedBy = ["clientId"] },
    ],
}))
{
    tablesWriter.WriteValues("C1", "Acme");
    tablesWriter.WriteValues("C2", "Bolt");
    tablesWriter.StartTable("transactions");
    tablesWriter.WriteValues("C1", 10.0);
    tablesWriter.WriteValues("C1", 5.0);
    tablesWriter.WriteValues("C2", 7.0);
}
using (var clientsReader = JazminReader.Open(tablesPath))
using (var linesReader = clientsReader.OpenTable("transactions")) // same open file, no second open
{
    var name = clientsReader.Find(JazminFilter.Eq("clientId", "C1")).Single()["name"];
    Console.WriteLine($"10. Tables {string.Join(", ", clientsReader.Tables)}: {name} has {linesReader.Count(JazminFilter.Eq("clientId", "C1"))} lines");
}

// --- 11. Newtonsoft-style settings: camelCase names, a converter for your own type, no stored defaults --
var shopSettings = new JazminSerializerSettings
{
    NamingStrategy = JazminNamingStrategy.CamelCase,
    Converters = [new MoneyConverter()],
    DefaultValueHandling = DefaultValueHandling.IgnoreAndPopulate,
};
var orderBytes = JazminConvert.SerializeObject(new List<Order> { new() { OrderId = 1, Total = new Money(1250, "ZAR") }, new() { OrderId = 2 } }, shopSettings);
var orders = JazminConvert.DeserializeObject<List<Order>>(orderBytes, shopSettings)!;
Console.WriteLine($"11. {JazminConvert.ToJson(orderBytes, new JazminSerializerSettings { NullValueHandling = NullValueHandling.Ignore })} -> {orders[0].Total}");

// --- 12. LINQ the reader runs, and speed or memory first (USER-GUIDE 8.3 and 20.4) -----------------
using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = key, Priority = JazminPriority.Speed }))
{
    var people = reader.AsQueryable<Customer>();
    var page = people.Where(c => c.Country == "ZA").Skip(1).Take(5).Select(c => c.Name).ToList(); // filter, offset, 1 column
    Console.WriteLine($"12. {people.Count(c => c.Country == "ZA")} in ZA; page 2: {string.Join(", ", page)}");
}

// --- 13. A new key without rewriting the rows: when a key may have leaked (USER-GUIDE 10) ----------
var newKey = JazminKey.Generate();
var rotation = JazminFile.RotateKey(path, new JazminKeyRotation { Key = key, NewKey = newKey });
using (var rekeyed = JazminReader.Open(path, new JazminReadOptions { Key = newKey }))
    Console.WriteLine($"13. {rotation.Sections} sections encrypted again; {rekeyed.RowCount} rows open with the new key");

// --- 14. Rows as UTF-8 JSON, written as they are read (for HTTP responses and System.Text.Json) ------
using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = newKey }))
using (var json = new JazminJsonStream(reader, JazminFilter.Eq("Country", "ZA")))
using (var text = new StreamReader(json))
    Console.WriteLine($"14. {text.ReadToEnd()[..60]}...");

// --- 15. Across tables: a shape that nests each client's transactions, and LINQ (USER-GUIDE 21.6, 23.2) --
using (var clientsReader = JazminReader.Open(tablesPath))
using (var linesReader = clientsReader.OpenTable("transactions"))
{
    var linked = JazminShape.Parse("""
        { "$rows": { "id": "clientId", "name": "name",
            "transactions": { "$from": "transactions", "$on": { "clientId": "clientId" }, "$rows": "amount" },
            "total": { "$from": "transactions", "$on": { "clientId": "clientId" }, "$one": { "$sum": "amount" } } } }
        """);
    Console.WriteLine("15. " + linked.ToJson(clientsReader)); // both tables sorted by clientId: each read once

    var camel = new JazminSerializerSettings { NamingStrategy = JazminNamingStrategy.CamelCase }; // ClientId -> clientId
    var clientRows = clientsReader.AsQueryable<Client>(camel);
    var transactionRows = linesReader.AsQueryable<Transaction>(camel);
    string name = clientRows.Where(c => c.ClientId == "C1").Select(c => c.Name).Single();       // lambda syntax
    var amounts = (from t in transactionRows where t.ClientId == "C1" select t.Amount).ToList(); // query syntax
    var ids = clientRows.Where(c => c.Name.StartsWith("B")).Select(c => c.ClientId).ToList();
    var theirs = transactionRows.Where(t => ids.Contains(t.ClientId)).ToList();                  // an `in` filter
    Console.WriteLine($"    {name}: {string.Join(" + ", amounts)}; clients starting with B have {theirs.Count} transaction(s)");

    // A sub-query per client: read once, as a lookup by ClientId (not a query per client).
    var totals = clientRows.Select(c => new { c.Name, Total = transactionRows.Where(t => t.ClientId == c.ClientId).Sum(t => t.Amount) }).ToList();
    Console.WriteLine($"    {string.Join(", ", totals.Select(t => $"{t.Name} {t.Total}"))}");
}

// --- 16. LINQ over nested collections: SelectMany, GroupBy, anonymous objects (USER-GUIDE 8.3) ----------
// The reader reads only the columns the query uses (here Departments, a JSON column); Name and Founded are not read.
var companies = new[] { "Acme", "Bolt" }.Select((name, c) => new Company
{
    Name = name,
    Founded = 1990 + c,
    Departments = [.. new[] { "Sales", "Build" }.Select((d, i) => new Department
    {
        Name = d,
        Employees = [new() { Name = $"{name} lead {d}", Projects = [new() { Name = $"{d} {c}", Category = i == 0 ? "Product" : "Service", Revenue = 12_000 * (c + i + 1) }] }],
    })],
}).ToList();
var companiesPath = Path.Combine(dir, "companies.jzm");
File.WriteAllBytes(companiesPath, JazminConvert.SerializeObject(companies));
using (var reader = JazminReader.Open(companiesPath))
{
    var report = reader.AsQueryable<Company>()
        .SelectMany(c => c.Departments)
        .SelectMany(d => d.Employees, (d, e) => new { Department = d.Name, Employee = e })
        .SelectMany(x => x.Employee.Projects, (x, p) => new { x.Department, Employee = x.Employee.Name, Project = p.Name, p.Category, p.Revenue })
        .Where(x => x.Revenue > 10_000)
        .GroupBy(x => new { x.Department, x.Category })
        .Select(g => new { g.Key.Department, g.Key.Category, Revenue = g.Sum(x => x.Revenue), TopProject = g.OrderByDescending(x => x.Revenue).First().Project })
        .OrderByDescending(x => x.Revenue)
        .ToList();
    Console.WriteLine($"16. {string.Join("; ", report.Select(r => $"{r.Department}/{r.Category}: {r.Revenue} (top {r.TopProject})"))}");
}

// --- 17. Nested columns: lists and classes stored as columns of their fields (USER-GUIDE 6.2) -------------
// Opt-in. Smaller files and faster reads at volume; such a file needs JAZMIN 1.4 or later to read.
var many = Enumerable.Range(0, 500).Select(c => new Company
{
    Name = $"Company {c}",
    Founded = 1950 + c % 70,
    Departments = [.. new[] { "Sales", "Build", "Support" }.Select((d, i) => new Department
    {
        Name = d,
        Employees = [.. Enumerable.Range(0, 3).Select(e => new Employee
        {
            Name = $"{d} {c}-{e}",
            Projects = [new() { Name = $"{d} project {c % 40}", Category = (c + i) % 2 == 0 ? "Product" : "Service", Revenue = 1_000 * ((c + e) % 50) }],
        })],
    })],
}).ToList();
var asJsonBytes = JazminConvert.SerializeObject(many);
var nestedBytes = JazminConvert.SerializeObject(many, new JazminSerializerSettings { NestedColumns = true });
using (var reader = JazminReader.Open(nestedBytes))
{
    Console.WriteLine($"17. {reader.Columns.Single(c => c.Name == "Departments")}");
    Console.WriteLine($"    {nestedBytes.Length} bytes (as json columns: {asJsonBytes.Length})");
    // Reads Departments only; settings are not needed to read (the file says how its columns are stored).
    var revenue = reader.AsQueryable<Company>().SelectMany(c => c.Departments).SelectMany(d => d.Employees).SelectMany(e => e.Projects).Sum(p => p.Revenue);
    var nestedBack = JazminConvert.DeserializeObject<List<Company>>(nestedBytes)!;
    Console.WriteLine($"    revenue {revenue}; {nestedBack.Count} companies read back, first: {nestedBack[0].Departments[0].Employees[0].Name}");
    // Conditions on nested fields become filters (USER-GUIDE 8.3), checked as the file is decoded: only matches are built.
    var employer = reader.AsQueryable<Company>().Where(c => c.Departments.Any(d => d.Employees.Any(e => e.Name == "Build 7-0"))).Select(c => c.Name).Single();
    Console.WriteLine($"    {employer} employs Build 7-0");
}

// --- 18. A print-ready document: what viewers may do with each file, and page settings for PDFs (USER-GUIDE 19.3) --
var statementBytes = new MemoryStream();
using (var writer = new JazminWriter(statementBytes, [new JazminColumn("account", JazminType.String)], new JazminWriteOptions
{
    Files =
    [
        new JazminFileInput("index.html", "<h1>Statement</h1>"u8.ToArray())
        {
            Actions = new JazminFileActions { PdfSettings = new JazminPdfSettings { Format = "A4", Margin = new JazminPdfMargin { Top = "15mm" } } },
        },
        // The page reads it; viewers don't offer it.
        new JazminFileInput("data.csv", "account\nA1\n"u8.ToArray()) { Actions = new JazminFileActions { Open = false, Save = false } },
    ],
    Package = new JazminPackage { Entry = "index.html", Title = "Statement", Pdf = new JazminPdfSettings { Format = "A4" } },
}, leaveOpen: true))
{
    writer.WriteValues("A1");
}
using (var reader = JazminReader.Open(statementBytes.ToArray()))
{
    foreach (var f in reader.Files)
        Console.WriteLine($"18. {f.Path}: save {f.Actions?.Save ?? true}, PDF page {f.Actions?.PdfSettings?.Format ?? reader.Package!.Pdf!.Format}");
}

// --- 19. An editable document (USER-GUIDE 19.5): a change file carries the values the person saw, so a row someone
// else changed in the meantime is held for the owner instead of overwritten.
var tasksPath = Path.Combine(dir, "tasks.jzm");
var taskColumns = new[] { new JazminColumn("id", JazminType.Int) { Nullable = false }, new JazminColumn("task", JazminType.String), new JazminColumn("owner", JazminType.String) };
using (var writer = JazminWriter.Create(tasksPath, taskColumns, new JazminWriteOptions
{
    Files = [new JazminFileInput("index.html", "<h1>Tasks</h1>"u8.ToArray())],
    Package = new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Key = ["id"], Columns = ["owner"] } },
}))
{
    writer.WriteValues(1L, "Call the client", null);
    writer.WriteValues(2L, "Send the quote", null);
}
byte[] taskChanges;
using (var seen = JazminReader.Open(tasksPath))
    taskChanges = JazminFile.WriteChanges(seen, new JazminChanges
    {
        Update = [new Dictionary<string, object?> { ["id"] = 1L, ["owner"] = "Ann" }, new Dictionary<string, object?> { ["id"] = 2L, ["owner"] = "Ann" }],
    });
JazminFile.Update(tasksPath, new JazminUpdate { Upsert = [new Dictionary<string, object?> { ["id"] = 2L, ["task"] = "Send the quote", ["owner"] = "Ben" }], KeyColumns = ["id"] });
var taskResult = JazminFile.ApplyChanges(tasksPath, taskChanges, new JazminApplyChangesOptions());
Console.WriteLine($"19. {taskResult.Updated} updated; " + string.Join("; ", taskResult.Conflicts.Select(c => $"task {c.Key["id"]} held: {string.Join(", ", c.Columns!.Select(x => $"{x.Name} is now {x.Now}"))}")));

// --- 20. A small file a page opened from disk shows with no choosing (USER-GUIDE 24.4): the file made into a script,
// which the page opens with JazminBrowser.openScript('statement.jzm.js', { password }). The file inside stays as it is,
// still encrypted. A whole sample: js/examples/from-disk.
var statementPath = Path.Combine(dir, "statement.jzm");
File.WriteAllBytes(statementPath, statementBytes.ToArray());
var scriptPath = Path.Combine(dir, "statement.jzm.js");
File.WriteAllText(scriptPath, JazminFile.PortableScript(statementPath));
Console.WriteLine($"20. {Path.GetFileName(scriptPath)}: {new FileInfo(scriptPath).Length / 1024.0:0.0} KB, for a {new FileInfo(statementPath).Length / 1024.0:0.0} KB file");

Directory.Delete(dir, true);

public readonly record struct Money(long Cents, string Currency);

/// <summary>Stores money as "1250 ZAR" (a converter for a type of your own).</summary>
public sealed class MoneyConverter : JazminConverter<Money>
{
    public override JazminType ColumnType => JazminType.String;
    public override object? Write(Money value) => $"{value.Cents} {value.Currency}";
    public override Money Read(object stored)
    {
        var parts = ((string)stored).Split(' ');
        return new Money(long.Parse(parts[0]), parts[1]);
    }
}

public class Company
{
    public string Name { get; set; } = "";
    public int Founded { get; set; }
    public List<Department> Departments { get; set; } = [];
}

public class Department
{
    public string Name { get; set; } = "";
    public List<Employee> Employees { get; set; } = [];
}

public class Employee
{
    public string Name { get; set; } = "";
    public List<Project> Projects { get; set; } = [];
}

public class Project
{
    public string Name { get; set; } = "";
    public string Category { get; set; } = "";
    public decimal Revenue { get; set; }
}

public class Client
{
    public string ClientId { get; set; } = "";
    public string Name { get; set; } = "";
}

public class Transaction
{
    public string ClientId { get; set; } = "";
    public double Amount { get; set; }
}

public class Order
{
    public int OrderId { get; set; }
    public Money? Total { get; set; }
}

public enum Tier { Bronze, Silver, Gold }

public class Customer
{
    [JazminIndex]
    public int Id { get; set; }

    [JazminIndex(JazminIndexKind.Sorted, JazminIndexKind.Trigram)]
    [Description("Full name")]
    public string Name { get; set; } = "";

    [JazminIndex]
    public string? Country { get; set; }

    public Tier Tier { get; set; }

    public decimal Balance { get; set; }

    public DateTime Joined { get; set; }

    [JazminIgnore]
    public string? PasswordHash { get; set; }
}
