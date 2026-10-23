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

// --- 1. Newtonsoft-style one-liners (USER-GUIDE 6.1) -------------------------------------------------
byte[] bytes = JazminConvert.SerializeObject(customers);
List<Customer> back = JazminConvert.DeserializeObject<List<Customer>>(bytes)!;
Console.WriteLine($"1. Round-tripped {back.Count} customers in {bytes.Length} bytes");

// --- 2. Encrypted file + LINQ query that uses indexes (USER-GUIDE 8.3) -------------------------------
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

// --- 3. Untyped rows and the JSON filter language, as in JavaScript and GraphQL "where" (USER-GUIDE 8.1) ---
using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = key }))
{
    foreach (var row in reader.Find("""{ "Name": { "icontains": "ndlovu" } }"""))
        Console.WriteLine($"3. Row {row.RowId}: {row["Name"]} joined {row["Joined"]:yyyy-MM-dd}");
}

// --- 4. Streaming writer for very large data (constant memory) (USER-GUIDE 6.5) ----------------------
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

// --- 5. Convert to and from JSON / CSV / XML (USER-GUIDE 11) -----------------------------------------
var fromJson = JazminConvert.FromJson("""[{"sku":"A1","qty":3},{"sku":"B2","qty":null}]""");
Console.WriteLine("5. " + JazminConvert.ToCsv(fromJson).Replace("\r\n", " | "));
Console.WriteLine("   " + JazminConvert.ToJson(fromJson, new JazminSerializerSettings { NullValueHandling = NullValueHandling.Ignore }));

// --- 6. Append small changes cheaply, then compact when you choose (USER-GUIDE 17) -------------------
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

// --- 7. One file, many keys, each for a limited time (USER-GUIDE 15, 18) -----------------------------
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

// --- 8. Export shapes: nested JSON / XML from flat rows (details taken once per client, with totals) (USER-GUIDE 21.1) ---
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

// --- 9. Async: write from an async source, read without blocking the calling thread (USER-GUIDE 22) ---
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

// --- 11. Newtonsoft-style settings: camelCase names, a converter for your own type, no stored defaults (USER-GUIDE 6.3) ---
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

// --- 14. Rows as UTF-8 JSON, written as they are read (for HTTP responses and System.Text.Json) (USER-GUIDE 11.2) ---
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

// --- 21. Export shapes saved in the file (USER-GUIDE 21.7), offered by name. In a shared file each key sees only the
// shapes it can use: "Balances" is for the finance group, and every key that sees it must see the balance column.
var bankOwner = JazminKey.Generate();
var teller = bankOwner.CreateAccessKey();
var branchesPath = Path.Combine(dir, "branches.jzm");
using (var writer = JazminWriter.Create(branchesPath, [new("id", JazminType.Int), new("branch", JazminType.String), new("balance", JazminType.Decimal)], new JazminWriteOptions
{
    Key = bankOwner,
    Access = new JazminAccessOptions { ColumnGroups = new() { ["money"] = ["balance"] }, Grants = [new JazminGrant(teller) { Columns = ["*"], Label = "Teller" }] },
    Shapes =
    [
        new JazminSavedShape("Accounts per branch", JsonNode.Parse("""{ "$groupBy": "branch", "$sort": ["branch"], "$rows": { "branch": "branch", "accounts": { "$count": true } } }""")!.AsObject()) { IsDefault = true },
        new JazminSavedShape("Balances", JsonNode.Parse("""{ "$rows": { "id": "id", "balance": "balance" } }""")!.AsObject()) { Groups = ["finance"] },
    ],
}))
{
    writer.WriteValues(1L, "CPT", 1520.75m);
    writer.WriteValues(2L, "JHB", 99.10m);
    writer.WriteValues(3L, "CPT", 0.00m);
}
using (var asTeller = JazminReader.Open(branchesPath, new JazminReadOptions { AccessKey = teller }))
{
    Console.WriteLine($"21. [{string.Join(", ", asTeller.Shapes.Select(s => s.Name))}] {JazminShape.FromFile(asTeller, "Accounts per branch").ToJson(asTeller)}");
    // 21. [Accounts per branch] [{"branch":"CPT","accounts":2},{"branch":"JHB","accounts":1}]
}

// ---- Changing a file you already have (sections 22-26) -----------------------------------------------------------------

// --- 22. Does the file need compacting? (USER-GUIDE 17.5): Storage() reads only the file's directories, never its rows.
var ledgerPath = Path.Combine(dir, "ledger.jzm");
JazminColumn[] ledgerColumns = [new("id", JazminType.Int), new("status", JazminType.String)];
using (var writer = JazminWriter.Create(ledgerPath, ledgerColumns, new JazminWriteOptions { SortedBy = ["id"] }))
{
    for (var i = 0L; i < 1000; i++) writer.WriteValues(i, "open");
}
for (var i = 0; i < 3; i++)
{
    JazminFile.Append(ledgerPath, new JazminAppend
    {
        Delete = JazminFilter.Lt("id", (i + 1) * 100L),
        Insert = [new Dictionary<string, object?> { ["id"] = 1000L + i, ["status"] = "new" }],
    });
}
JazminStorage used;
using (var reader = JazminReader.Open(ledgerPath)) used = reader.Storage();
JazminFile.Compact(ledgerPath);
using (var reader = JazminReader.Open(ledgerPath))
{
    Console.WriteLine($"22. {used.DeletedRows} deleted rows, {used.AppendCount} appends, {used.UnusedBytes / 1024.0:0.0} KB unused; compacted: {reader.Storage().DeletedRows} deleted rows");
    // 22. 300 deleted rows, 3 appends, 0.7 KB unused; compacted: 0 deleted rows
}

// --- 23. Indexes and the sort order of an existing file (USER-GUIDE 16.1), in one rewrite that keeps everything else.
// Rows are put in a new order within a memory budget; the old first sort column gets an index, so lookups stay fast.
JazminFile.Update(ledgerPath, new JazminUpdate
{
    Indexes = new Dictionary<string, IReadOnlyList<JazminIndexKind>> { ["status"] = [JazminIndexKind.Sorted, JazminIndexKind.Trigram] },
    SortedBy = ["status", "id"],
});
using (var reader = JazminReader.Open(ledgerPath))
{
    Console.WriteLine($"23. [{string.Join(", ", reader.SortedBy!)}] [{string.Join(", ", reader.Indexes.Select(ix => $"{ix.Column}:{ix.Kind}"))}]");
    // 23. [status, id] [id:Sorted, status:Trigram]
}

// --- 24. Tables added, renamed and removed (USER-GUIDE 23.5): an added table's rows can be any sequence, read once.
var shopPath = Path.Combine(dir, "shop.jzm");
using (var writer = JazminWriter.Create(shopPath, [new("clientId", JazminType.String) { Nullable = false }, new("name", JazminType.String)], new JazminWriteOptions { SortedBy = ["clientId"] }))
{
    writer.WriteValues("C1", "Ann");
    writer.WriteValues("C2", "Ben");
}
JazminColumn[] orderColumns = [new("orderId", JazminType.Int), new("clientId", JazminType.String), new("total", JazminType.Decimal)];
IReadOnlyDictionary<string, object?> OrderRow(long id, string client, string total) => new Dictionary<string, object?> { ["orderId"] = id, ["clientId"] = client, ["total"] = total };
JazminFile.Update(shopPath, new JazminUpdate
{
    RenameTables = new Dictionary<string, string> { [""] = "clients" }, // a file's single table has no name until it is given one
    AddTables =
    [
        new JazminAddedTable(new JazminTable("orders", orderColumns) { SortedBy = ["clientId", "orderId"] }, [OrderRow(2, "C2", "15.00"), OrderRow(1, "C1", "40.50"), OrderRow(3, "C1", "9.99")]),
        new JazminAddedTable(new JazminTable("scratch", [new JazminColumn("note", JazminType.String)]), [new Dictionary<string, object?> { ["note"] = "temporary" }]),
    ],
});
JazminFile.Update(shopPath, new JazminUpdate { RemoveTables = ["scratch"] });
using (var reader = JazminReader.Open(shopPath)) Console.WriteLine($"24. [{string.Join(", ", reader.Tables)}]");
// 24. [clients, orders]

// --- 25. Links between tables (USER-GUIDE 23.6): declared once, kept in the file (names only, never values), and
// checked against the rows. Both tables are sorted by the link, so they are walked side by side.
var orderClient = new JazminLink("client", new JazminLinkSide("orders", ["clientId"]), new JazminLinkSide("clients", ["clientId"]));
JazminFile.Update(shopPath, new JazminUpdate { Links = [orderClient] });
using (var reader = JazminReader.Open(shopPath))
{
    var check = reader.CheckLinks().Single();
    Console.WriteLine($"25. [{string.Join(", ", reader.Links.Select(l => l.Name))}] {check.Rows} rows checked, {check.Missing} find nothing ({check.Method})");
    // 25. [client] 3 rows checked, 0 find nothing (merge)
}

// --- 26. A client's key changed in every table, in one rewrite (USER-GUIDE 23.7): Set + Where on the main table, and
// the same in Tables for the others. Rows whose sort column changes move to their place; the link still holds.
var rekeyClient = new JazminTableChanges { Set = new Dictionary<string, object?> { ["clientId"] = "C9" }, Where = JazminFilter.Eq("clientId", "C1") };
var rekeyResult = JazminFile.Update(shopPath, new JazminUpdate
{
    Tables = new Dictionary<string, JazminTableChanges> { ["clients"] = rekeyClient, ["orders"] = rekeyClient },
});
using (var reader = JazminReader.Open(shopPath))
using (var orderTable = reader.OpenTable("orders"))
{
    Console.WriteLine($"26. {rekeyResult.Tables!["clients"].Updated} client and {rekeyResult.Tables["orders"].Updated} orders re-keyed; "
        + $"[{string.Join(", ", orderTable.Rows().Select(o => $"{o["clientId"]}/{o["orderId"]}"))}] missing: {reader.CheckLinks().Single().Missing}");
    // 26. 1 client and 2 orders re-keyed; [C2/2, C9/1, C9/3] missing: 0
}

// --- 27. Which JAZMIN versions read a file (USER-GUIDE 3.2): the reader features it needs, here smaller indexes (opt-in).
// Empty for files every 1.x release reads.
var featuredPath = Path.Combine(dir, "featured.jzm");
using (var writer = JazminWriter.Create(featuredPath, [new("id", JazminType.Int), new("city", JazminType.String) { Indexes = [JazminIndexKind.Sorted] }], new JazminWriteOptions { CompactIndexes = true }))
{
    for (var i = 0L; i < 50; i++) writer.WriteValues(i, i % 2 == 1 ? "CPT" : "JHB");
}
using (var plain = JazminReader.Open(ledgerPath))
using (var featured = JazminReader.Open(featuredPath))
{
    Console.WriteLine($"27. [{string.Join(", ", plain.ReaderFeatures)}] [{string.Join(", ", featured.ReaderFeatures)}]");
    // 27. [] [index-deltas]
}

// --- 28. Records sent back from the field, filed by the library's rules (USER-GUIDE 15.6): the phone locks its records
// with Ann's submission key (she gets it by opening the shared file); the owner's service files them. A dry run first.
var fieldOwner = JazminKey.Generate();
var ann = fieldOwner.CreateAccessKey();
var fieldPath = Path.Combine(dir, "field.jzm");
JazminColumn[] fieldColumns = [new("id", JazminType.String) { Nullable = false }, new("inspector", JazminType.String), new("note", JazminType.String)];
using (var writer = JazminWriter.Create(fieldPath, fieldColumns, new JazminWriteOptions
{
    Key = fieldOwner,
    Access = new JazminAccessOptions { PartitionBy = "inspector", Grants = [new JazminGrant(ann) { Rows = ["ann"], Label = "Ann" }] },
}))
{
    writer.WriteValues("r1", "ann", "roof ok");
}
JazminKey annSubmissionKey;
using (var annView = JazminReader.Open(fieldPath, new JazminReadOptions { AccessKey = ann })) annSubmissionKey = annView.SubmissionKey!;
var batchPath = Path.Combine(dir, "batch.jzm");
using (var writer = JazminWriter.Create(batchPath, fieldColumns, new JazminWriteOptions { Key = annSubmissionKey }))
{
    writer.WriteValues("r1", null, "roof leaks");
    writer.WriteValues("r2", null, "gate broken");
}
var upload = File.ReadAllBytes(batchPath);
var dryRun = JazminFile.FileSubmission(fieldPath, upload, new JazminFileSubmissionOptions { Key = fieldOwner, KeyId = ann.Id, DryRun = true });
var filedBatch = JazminFile.FileSubmission(fieldPath, upload, new JazminFileSubmissionOptions { Key = fieldOwner, KeyId = ann.Id });
Console.WriteLine($"28. dry run: {dryRun.Filed} new, {dryRun.Updated} changed; filed: {filedBatch.Filed} new, {filedBatch.Updated} changed");
// 28. dry run: 1 new, 1 changed; filed: 1 new, 1 changed

// --- 29. The owner's list of grants (USER-GUIDE 15.1), with each key's extra file groups, so a tool can change a grant
// without losing them: a new grant for a key replaces the old one whole.
var docsOwner = JazminKey.Generate();
var reviewer = docsOwner.CreateAccessKey();
var contractsPath = Path.Combine(dir, "contracts.jzm");
using (var writer = JazminWriter.Create(contractsPath, [new JazminColumn("id", JazminType.Int)], new JazminWriteOptions
{
    Key = docsOwner,
    Files = [new JazminFileInput("contracts/lease.txt", "The lease"u8.ToArray()) { Groups = ["legal"] }],
    Access = new JazminAccessOptions { Grants = [new JazminGrant(reviewer) { Files = ["legal"], Label = "Reviewer" }] },
}))
{
    writer.WriteValues(1L);
}
using (var asOwner = JazminReader.Open(contractsPath, new JazminReadOptions { Key = docsOwner }))
{
    Console.WriteLine($"29. [{string.Join(", ", asOwner.Access!.Grants!.Select(g => $"{g.Label}: files [{string.Join(", ", g.Files ?? ["*"])}]"))}]");
    // 29. [Reviewer: files [legal]]
}

// --- 30. Stored files locked (USER-GUIDE 19.6): a key that sees them lists them, and opens one only with its password;
// an online lock opens with the token the owner's key service hands out after its own checks (2FA, say).
var claimOwner = JazminKey.Generate();
var claimant = claimOwner.CreateAccessKey();
var claimPath = Path.Combine(dir, "claim.jzm");
using (var writer = JazminWriter.Create(claimPath, [new JazminColumn("id", JazminType.Int)], new JazminWriteOptions
{
    Key = claimOwner,
    Access = new JazminAccessOptions { Grants = [new JazminGrant(claimant)] },
    Files = [new JazminFileInput("contract.pdf", "The contract"u8.ToArray()) { Lock = "contracts" }, new JazminFileInput("scan.png", "The scan"u8.ToArray()) { Lock = "medical" }],
    Locks = new Dictionary<string, JazminLockOptions?>
    {
        ["contracts"] = new() { Password = "correct horse battery staple" },
        ["medical"] = new() { Online = true },
    },
}))
{
    writer.WriteValues(1L);
}
using (var claimView = JazminReader.Open(claimPath, new JazminReadOptions { AccessKey = claimant }))
{
    var refused = "";
    try
    {
        claimView.ReadFile("contract.pdf");
    }
    catch (JazminFileLockedException e)
    {
        refused = $"{e.GetType().Name} ({e.Kind})";
    }
    claimView.Unlock("contracts", password: "correct horse battery staple");
    claimView.Unlock("medical", unlockToken: JazminFile.IssueFileUnlockToken(claimPath, claimOwner, "medical")); // from the key service
    Console.WriteLine($"30. {refused} -> {System.Text.Encoding.UTF8.GetString(claimView.ReadFile("contract.pdf"))} / {System.Text.Encoding.UTF8.GetString(claimView.ReadFile("scan.png"))}");
    // 30. JazminFileLockedException (Password) -> The contract / The scan
}

// --- 31. The newest rows first (USER-GUIDE 9.7): a file sorted by time, read from its end as fast as from its start.
var journalPath = Path.Combine(dir, "ledger.jzm");
using (var writer = JazminWriter.Create(journalPath,
    [new JazminColumn("id", JazminType.Int), new JazminColumn("at", JazminType.DateTime), new JazminColumn("account", JazminType.String) { Indexes = [JazminIndexKind.Sorted] }],
    new JazminWriteOptions { SortedBy = ["at"] }))
{
    for (var i = 0; i < 10000; i++) writer.WriteValues((long)i, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i), $"A{i % 50}");
}
using (var journal = JazminReader.Open(journalPath))
{
    var newest = journal.Find(JazminFilter.Eq("account", "A7"), new JazminQueryOptions { Reverse = true, Limit = 3 }).Select(r => (long)r["id"]!);
    Console.WriteLine($"31. [{string.Join(", ", newest)}]");
    // 31. [9957, 9907, 9857]
}

// --- 32. Text kept ignoring case and accents, with numbers by value (USER-GUIDE 16.1): Update puts the rows in that order.
var namesPath = Path.Combine(dir, "names.jzm");
using (var writer = JazminWriter.Create(namesPath, [new JazminColumn("name", JazminType.String)]))
{
    foreach (var name in new[] { "file10", "File2", "émile", "file1", "Apple" }) writer.WriteValues(name);
}
JazminFile.Update(namesPath, new JazminUpdate { Sort = [new JazminSortKey("name") { NoCase = true, Natural = true }] });
using (var namesReader = JazminReader.Open(namesPath))
{
    Console.WriteLine($"32. [{string.Join(", ", namesReader.Rows().Select(r => r["name"]))}] {string.Join(", ", namesReader.Sort!)}");
    // 32. [Apple, émile, file1, File2, file10] name (nocase, natural)
}

// --- 33. A masked column (USER-GUIDE 15.7): a key granted it sees what the owner lets it show, until it unlocks the column.
var payOwner = JazminKey.Generate();
var payClerk = payOwner.CreateAccessKey();
var payPath = Path.Combine(dir, "pay.jzm");
using (var writer = JazminWriter.Create(payPath,
    [
        new JazminColumn("id", JazminType.Int), new JazminColumn("name", JazminType.String),
        new JazminColumn("account", JazminType.String) { Mask = new JazminMask("pay") { Show = JazminMaskShow.KeepFormat(4) } },
    ],
    new JazminWriteOptions
    {
        Key = payOwner, Access = new JazminAccessOptions { Grants = [new JazminGrant(payClerk)] },
        Locks = new Dictionary<string, JazminLockOptions?> { ["pay"] = new() { Password = "correct horse battery staple" } },
    }))
{
    writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["name"] = "Thandi", ["account"] = "4821 0393 7712 4821" });
}
using (var payView = JazminReader.Open(payPath, new JazminReadOptions { AccessKey = payClerk }))
{
    var before = payView.Rows().First()["account_shown"];
    payView.Unlock("pay", password: "correct horse battery staple");
    Console.WriteLine($"33. {before} -> {payView.Rows().First()["account"]}");
    // Exports give it as one column, as viewers show it: masked unless asked for its revealed values. ExportView gives
    // the columns and rows for CsvFormat, JsonFormat and XmlFormat (JazminJsonStream uses it too).
    string Csv(bool revealMasked)
    {
        var (columns, rows) = payView.ExportView(revealMasked: revealMasked);
        using var text = new StringWriter();
        CsvFormat.Write(text, columns, rows);
        return text.ToString().Replace("\r", "\\r").Replace("\n", "\\n");
    }
    Console.WriteLine($"    export: {Csv(revealMasked: false)} -> {Csv(revealMasked: true)}");
    // 33. •••• •••• •••• 4821 -> 4821 0393 7712 4821
    //     export: id,name,account\r\n1,Thandi,•••• •••• •••• 4821\r\n -> id,name,account\r\n1,Thandi,4821 0393 7712 4821\r\n
}

// --- 34. Progress and Stop on a long read (USER-GUIDE 22.1): a progress report after each chunk with the chunks read,
// the chunks planned and the matches so far; a cancellation token stops the read before its next chunk, and it throws
// OperationCanceledException. Find takes both in JazminQueryOptions; Count and CountAsync as arguments. Here Stop is
// pressed part-way, from the progress report. (ReportNow, at the end of this file, reports at once, so the lines print
// in order; Progress<T> reports later, on the thread pool or an app's UI thread.)
var visitsPath = Path.Combine(dir, "visits.jzm");
string[] visitCities = ["Durban", "Cape Town", "Pretoria", "Polokwane"];
using (var writer = JazminWriter.Create(visitsPath,
    [
        new JazminColumn("id", JazminType.Int) { Nullable = false }, new JazminColumn("customer", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new JazminColumn("city", JazminType.String), new JazminColumn("amount", JazminType.Int),
    ]))
{
    for (var i = 0; i < 100_000; i++) writer.WriteValues((long)i, $"C{i / 100 * 37 % 1000:000}", visitCities[i % 4], (long)(i % 1000));
}
using (var visits = JazminReader.Open(visitsPath))
{
    var inDurban = JazminFilter.Eq("city", "Durban");
    JazminReadProgress last = default;
    var durban = visits.Count(inDurban, new ReportNow<JazminReadProgress>(p => last = p));
    using var stop = new CancellationTokenSource();
    var stopped = "";
    try
    {
        visits.Find(inDurban, new JazminQueryOptions { CancellationToken = stop.Token, Progress = new ReportNow<JazminReadProgress>(p => { if (p.Done == 3) stop.Cancel(); }) }).Count();
    }
    catch (OperationCanceledException e)
    {
        stopped = e.GetType().Name;
    }
    using var stopAsync = new CancellationTokenSource(); // stopButton.Click += (_, _) => stopAsync.Cancel();
    var stoppedAsync = "";
    try
    {
        await visits.CountAsync(inDurban, new ReportNow<JazminReadProgress>(p => { if (p.Done == 5) stopAsync.Cancel(); }), stopAsync.Token);
    }
    catch (OperationCanceledException e)
    {
        stoppedAsync = e.GetType().Name;
    }
    Console.WriteLine($"34. {durban} in Durban, {last.Done} of {last.Total} chunks read; Find stopped after 3: {stopped}; CountAsync stopped after 5: {stoppedAsync}");
    // 34. 25000 in Durban, 25 of 25 chunks read; Find stopped after 3: OperationCanceledException; CountAsync stopped after 5: OperationCanceledException
}

// --- 35. Progress for a rewrite (USER-GUIDE 16.1): Update and Compact report the stage, done and total in up to three
// stages: Sort (only when the order changes), Write (after each chunk) and Indexes (at the end). A cancellation token
// stops it at its next report and leaves the file as it was. Here, the last report of each stage.
var rewriteStages = new Dictionary<JazminWriteStage, string>();
JazminFile.Update(visitsPath, new JazminUpdate
{
    SortedBy = ["city", "id"],
    Progress = new ReportNow<JazminWriteProgress>(p => rewriteStages[p.Stage] = $"{p.Stage} {p.Done}/{p.Total}"),
});
Console.WriteLine($"35. [{string.Join(", ", rewriteStages.Values)}]");
// 35. [Sort 100000/100000, Write 100000/100000, Indexes 1/1]

// --- 36. What a read would cost, before it runs (USER-GUIDE 9.6): Estimate reads no rows, only the chunk directories,
// statistics and indexes. Find reads at most Chunks/Rows; Count reads CountChunks (0 when an index answers it).
using (var planned = JazminReader.Open(visitsPath))
{
    string CostOf(JazminFilter filter)
    {
        var e = planned.Estimate(filter);
        return $"find {e.Chunks} chunks/{e.Rows} rows, count {e.CountChunks} chunks";
    }
    Console.WriteLine($"36. customer (indexed): {CostOf(JazminFilter.Eq("customer", "C074"))}; amount (no index): {CostOf(JazminFilter.Eq("amount", 500L))}");
    // 36. customer (indexed): find 4 chunks/100 rows, count 0 chunks; amount (no index): find 25 chunks/100000 rows, count 25 chunks
}

// --- 37. What viewers offer for each stored file (USER-GUIDE 19.3): List = false keeps a page's script out of viewers'
// lists of the file's files, and in a shared file GroupActions gives each file group its own actions: here HR may
// download the payslips and staff may only view them. The owner sees each group's actions.
var payslipsOwner = JazminKey.Generate();
var hrKey = payslipsOwner.CreateAccessKey();
var staffKey = payslipsOwner.CreateAccessKey();
var payslipsPath = Path.Combine(dir, "payslips.jzm");
using (var writer = JazminWriter.Create(payslipsPath, [new JazminColumn("id", JazminType.Int)], new JazminWriteOptions
{
    Key = payslipsOwner,
    Files =
    [
        new JazminFileInput("index.html", "<h1>Payslips</h1><script src=\"app.js\"></script>"u8.ToArray()),
        new JazminFileInput("app.js", "jazmin.query({});"u8.ToArray()) { Actions = new JazminFileActions { List = false } },
        new JazminFileInput("payslips.pdf", "Payslips, March"u8.ToArray())
        {
            Groups = ["hr", "staff"],
            GroupActions = new Dictionary<string, JazminFileActions> { ["hr"] = new() { Save = true }, ["staff"] = new() { Save = false } },
        },
    ],
    Package = new JazminPackage { Entry = "index.html" },
    Access = new JazminAccessOptions { Grants = [new JazminGrant(hrKey) { Files = ["hr"], Label = "HR" }, new JazminGrant(staffKey) { Files = ["staff"], Label = "Staff" }] },
}))
{
    writer.WriteValues(1L);
}
foreach (var (label, accessKey) in new[] { ("HR", hrKey), ("Staff", staffKey) })
{
    using var view = JazminReader.Open(payslipsPath, new JazminReadOptions { AccessKey = accessKey });
    Console.WriteLine($"{(label == "HR" ? "37." : "   ")} {label}: {string.Join("; ", view.Files.Select(f => $"{f.Path} list {f.Actions?.List ?? true}, save {f.Actions?.Save ?? true}"))}");
}
using (var asOwner = JazminReader.Open(payslipsPath, new JazminReadOptions { Key = payslipsOwner }))
    Console.WriteLine($"    owner: {string.Join(", ", asOwner.Files.Single(f => f.Path == "payslips.pdf").GroupActions!.Select(g => $"{g.Key} save {g.Value?.Save}"))}");
// 37. HR: app.js list False, save True; index.html list True, save True; payslips.pdf list True, save True
//     Staff: app.js list False, save True; index.html list True, save True; payslips.pdf list True, save False
//     owner: hr save True, staff save False

// --- 38. A document that needs the internet (USER-GUIDE 24.1): Online Required when it doesn't work offline (a chart
// library from a CDN), Optional when it works with less (a font that falls back). It needs AllowedOrigins, the only
// sites its pages may load from. Viewers then say it needs to be online, and offline show a message instead.
var salesBytes = new MemoryStream();
using (var writer = new JazminWriter(salesBytes, [new JazminColumn("month", JazminType.String), new JazminColumn("sales", JazminType.Int)], new JazminWriteOptions
{
    Files = [new JazminFileInput("index.html", "<canvas id=\"chart\"></canvas><script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.6\"></script>"u8.ToArray())],
    Package = new JazminPackage { Entry = "index.html", Online = JazminOnline.Required, AllowedOrigins = ["https://cdn.jsdelivr.net"] },
}, leaveOpen: true))
{
    writer.WriteValues("Jan", 120L);
    writer.WriteValues("Feb", 135L);
}
using (var sales = JazminReader.Open(salesBytes.ToArray()))
    Console.WriteLine($"38. entry {sales.Package!.Entry}, online {sales.Package.Online}, allowed origins [{string.Join(", ", sales.Package.AllowedOrigins!)}]");
// 38. entry index.html, online Required, allowed origins [https://cdn.jsdelivr.net]

// --- 39. Document pages (USER-GUIDE 19.7, 19.2): viewers show each page as a tab, in order. One reads the clients
// table, one needs the internet, one has only Print and PDF buttons. Package.Files names the pages' own files (a folder
// ends in '/'), which viewers keep out of the Files tab. The package is in the header every key reads, so a page only
// some keys may know of is marked on its file instead: only the directors see the Board pack tab, or that the file exists.
var boardOwner = JazminKey.Generate();
var director = boardOwner.CreateAccessKey();
var clerk = boardOwner.CreateAccessKey();
var bankPath = Path.Combine(dir, "bank.jzm");
using (var writer = JazminWriter.Create(bankPath, new JazminWriteOptions
{
    Tables =
    [
        new JazminTable("clients", [new JazminColumn("clientId", JazminType.String), new JazminColumn("name", JazminType.String)]),
        new JazminTable("transactions", [new JazminColumn("clientId", JazminType.String), new JazminColumn("amount", JazminType.Decimal)]),
    ],
    Key = boardOwner,
    Access = new JazminAccessOptions { Grants = [new JazminGrant(director) { Files = ["directors"], Label = "Director" }, new JazminGrant(clerk) { Label = "Clerk" }] },
    Files =
    [
        new JazminFileInput("clients.html", "<h1>Clients</h1>"u8.ToArray()),
        new JazminFileInput("summary.html", "<h1>Summary</h1>"u8.ToArray()),
        new JazminFileInput("statement.html", "<h1>Statement</h1>"u8.ToArray()),
        new JazminFileInput("assets/app.js", "jazmin.query({});"u8.ToArray()),
        new JazminFileInput("assets/style.css", "h1 { color: navy }"u8.ToArray()),
        new JazminFileInput("board.html", "<h1>Board pack</h1>"u8.ToArray()) { Groups = ["directors"], Page = new JazminPage { Title = "Board pack", Order = 1 } },
    ],
    Package = new JazminPackage
    {
        // Entry is left out: it is the first page, the one older viewers show.
        Pages =
        [
            new JazminPage { Path = "clients.html", Title = "Clients", Table = "clients" },
            new JazminPage { Path = "summary.html", Title = "Summary", Online = JazminOnline.Required }, // the other tabs still work offline
            new JazminPage { Path = "statement.html", Title = "Statement", Actions = new JazminFileActions { Image = false } },
        ],
        Files = ["assets/"],
        AllowedOrigins = ["https://cdn.jsdelivr.net"],
    },
}))
{
    writer.WriteValues("C1", "Acme");
    writer.StartTable("transactions");
    writer.WriteValues("C1", 10.00m);
}
foreach (var (label, accessKey) in new[] { ("Director", director), ("Clerk", clerk) })
{
    using var view = JazminReader.Open(bankPath, new JazminReadOptions { AccessKey = accessKey });
    IEnumerable<string> tabs = [.. view.Package!.Pages!.Select(p => p.Title!), .. view.Files.Where(f => f.Page is not null).Select(f => $"{f.Page!.Title} ({f.Path})")];
    Console.WriteLine($"{(label == "Director" ? "39." : "   ")} {label} [{string.Join(", ", tabs)}]");
}
// 39. Director [Clients, Summary, Statement, Board pack (board.html)]
//     Clerk [Clients, Summary, Statement]

// --- 40. Locks and key services (USER-GUIDE 19.6): Package.KeyService names the service that gives out the file's
// online locks' tokens, and a lock can name its own, so the medical aid signs its own people in (with its own 2FA) and
// holds only its lock's token. A service that stores tokens instead of the owner key lists them with ListFileUnlockTokens.
var clinic = JazminKey.Generate();
var patient = clinic.CreateAccessKey();
var visitPath = Path.Combine(dir, "visit.jzm");
using (var writer = JazminWriter.Create(visitPath, [new JazminColumn("id", JazminType.Int)], new JazminWriteOptions
{
    Key = clinic,
    Access = new JazminAccessOptions { Grants = [new JazminGrant(patient)] },
    Files = [new JazminFileInput("scan.png", "The scan"u8.ToArray()) { Lock = "medical" }, new JazminFileInput("invoice.pdf", "The invoice"u8.ToArray()) { Lock = "billing" }],
    Locks = new Dictionary<string, JazminLockOptions?>
    {
        ["medical"] = new() { Online = true, KeyService = "https://keys.medicalaid.example" },
        ["billing"] = new() { Online = true },
    },
    Package = new JazminPackage { KeyService = "https://keys.clinic.example" },
}))
{
    writer.WriteValues(1L);
}
using (var patientView = JazminReader.Open(visitPath, new JazminReadOptions { AccessKey = patient }))
{
    Console.WriteLine($"40. {string.Join(", ", patientView.Locks.Select(l => $"{l.Id}: {l.KeyService}"))}");
    patientView.Unlock("medical", unlockToken: JazminFile.IssueFileUnlockToken(visitPath, clinic, "medical")); // the medical aid's service
    var billingToken = JazminFile.ListFileUnlockTokens(visitPath, clinic).Single(t => t.LockId == "billing").Token; // the clinic's service
    patientView.Unlock("billing", unlockToken: billingToken);
    Console.WriteLine($"    {System.Text.Encoding.UTF8.GetString(patientView.ReadFile("scan.png"))} / {System.Text.Encoding.UTF8.GetString(patientView.ReadFile("invoice.pdf"))}");
    // 40. billing: https://keys.clinic.example/, medical: https://keys.medicalaid.example/
    //     The scan / The invoice
}

// --- 41. Masking and unmasking later (USER-GUIDE 15.7): an update with the owner key masks a column that wasn't masked
// and unmasks one that was. Nobody gains access: the clerk saw the phone number and now sees its last 4 digits; the
// salary was masked and is now plain.
var hrOwner = JazminKey.Generate();
var hrClerk = hrOwner.CreateAccessKey();
var staffPath = Path.Combine(dir, "staff.jzm");
using (var writer = JazminWriter.Create(staffPath,
    [
        new JazminColumn("id", JazminType.Int), new JazminColumn("name", JazminType.String), new JazminColumn("phone", JazminType.String),
        new JazminColumn("salary", JazminType.Decimal) { Mask = new JazminMask("hr") },
    ],
    new JazminWriteOptions
    {
        Key = hrOwner, Access = new JazminAccessOptions { Grants = [new JazminGrant(hrClerk)] },
        Locks = new Dictionary<string, JazminLockOptions?> { ["hr"] = new() { Password = "correct horse battery staple" } },
    }))
{
    writer.WriteValues(1L, "Thandi", "082 555 0199", 42000.00m);
}
string AsClerk()
{
    using var view = JazminReader.Open(staffPath, new JazminReadOptions { AccessKey = hrClerk });
    var row = view.Rows().First();
    return $"{{{string.Join(", ", row.Select(c => FormattableString.Invariant($"{c.Key}: {c.Value}")))}}} masked [{string.Join(", ", view.Masked.Select(m => m.Column))}]";
}
var beforeMasks = AsClerk();
JazminFile.Update(staffPath, new JazminUpdate
{
    Key = hrOwner,
    Masks = new Dictionary<string, JazminMask?> { ["phone"] = new JazminMask("hr") { Show = JazminMaskShow.LastOf(4) }, ["salary"] = null },
});
Console.WriteLine($"41. {beforeMasks} -> {AsClerk()}");
// 41. {id: 1, name: Thandi, phone: 082 555 0199} masked [salary] -> {id: 1, name: Thandi, salary: 42000.00, phone_shown: ••••0199} masked [phone]

// --- 42. Regrouping partitions (USER-GUIDE 17.4): in a shared file each append starts new chunks, one per person it
// adds rows for, so many small syncs leave each person's rows in many small chunks. Compact keeps them;
// Compact(path, key, regroup: true) writes each person's rows together.
var syncOwner = JazminKey.Generate();
var syncsPath = Path.Combine(dir, "syncs.jzm");
using (var writer = JazminWriter.Create(syncsPath, [new JazminColumn("person", JazminType.String), new JazminColumn("visit", JazminType.Int)], new JazminWriteOptions
{
    Key = syncOwner,
    Access = new JazminAccessOptions
    {
        PartitionBy = "person",
        Grants = [new JazminGrant(syncOwner.CreateAccessKey()) { Rows = ["ann"] }, new JazminGrant(syncOwner.CreateAccessKey()) { Rows = ["ben"] }],
    },
}))
{
    writer.WriteValues("ann", 0L);
    writer.WriteValues("ben", 0L);
}
for (var day = 1L; day <= 5; day++)
{
    JazminFile.Append(syncsPath, new JazminAppend
    {
        Key = syncOwner,
        Insert = [new Dictionary<string, object?> { ["person"] = "ann", ["visit"] = day }, new Dictionary<string, object?> { ["person"] = "ben", ["visit"] = day }],
    });
}
long SyncChunks()
{
    using var view = JazminReader.Open(syncsPath, new JazminReadOptions { Key = syncOwner });
    return view.Storage().Tables[0].Chunks;
}
var appendedChunks = SyncChunks();
JazminFile.Compact(syncsPath, syncOwner);
var compactedChunks = SyncChunks();
JazminFile.Compact(syncsPath, syncOwner, regroup: true);
Console.WriteLine($"42. {appendedChunks} chunks after 5 syncs; compacted: {compactedChunks}; regrouped: {SyncChunks()}");
// 42. 12 chunks after 5 syncs; compacted: 12; regrouped: 2

// 43. Publisher signatures (USER-GUIDE 26): who published a file, that it hasn't changed, and the facts signed with it.
// A file written here has no publisher signature: None. The repository's test files are signed under a test root no
// release trusts, so they show as Signed, with no name or facts, until SmithSoft's root is built in (1.8.1).
string? signedTestFile = null;
for (var up = new DirectoryInfo(AppContext.BaseDirectory); up is not null && signedTestFile is null; up = up.Parent)
{
    var candidate = Path.Combine(up.FullName, "spec", "fixtures", "publisher", "signed-plain.jzm");
    if (File.Exists(candidate)) signedTestFile = candidate;
}
var signed43 = signedTestFile is null ? null : JazminFile.VerifyPublisher(signedTestFile);
Console.WriteLine($"43. {JazminFile.VerifyPublisher(path).Status}{(signed43 is null ? "" : $" {signed43.Status} {signed43.Name ?? "null"}")}");
// 43. None Signed null

// 44. Limits per key (USER-GUIDE 19.5): one shared document, different keys allowed different changes. The doctor may
// acknowledge a result; infection control may only add a note. The owner's ApplyChanges refuses anything else, even in
// a change file made by hand; files with limits take changes only through 1.8 or later (older releases still read them).
var acks44 = Path.Combine(dir, "acks.jzm");
var hospital44 = JazminKey.Generate();
var doctor44 = hospital44.CreateAccessKey();
var ipc44 = hospital44.CreateAccessKey();
using (var writer = JazminWriter.Create(acks44,
    [new("ack", JazminType.String) { Nullable = false }, new("ward", JazminType.String) { Nullable = false }, new("ackAction", JazminType.String), new("ackNote", JazminType.String)],
    new JazminWriteOptions
    {
        Key = hospital44,
        Files = [new JazminFileInput("index.html", System.Text.Encoding.UTF8.GetBytes("<h1>Critical results</h1>"))],
        Package = new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Key = ["ack"], Columns = ["ackAction", "ackNote"] } },
        Access = new JazminAccessOptions
        {
            PartitionBy = "ward",
            Grants =
            [
                new JazminGrant(doctor44) { Label = "Doctor" },
                new JazminGrant(ipc44) { Label = "Infection control", Edit = new JazminEditLimit { Columns = ["ackNote"] } },
            ],
        },
    }))
{
    writer.WriteRow(new Dictionary<string, object?> { ["ack"] = "A-1", ["ward"] = "W1", ["ackAction"] = null, ["ackNote"] = null });
    writer.WriteRow(new Dictionary<string, object?> { ["ack"] = "A-2", ["ward"] = "W2", ["ackAction"] = null, ["ackNote"] = null });
}
string refused44;
byte[] note44;
string allowed44;
using (var asIpc = JazminReader.Open(acks44, new JazminReadOptions { AccessKey = ipc44, AccessState = null }))
{
    allowed44 = string.Join(",", asIpc.Edit!.Columns);
    try
    {
        JazminFile.WriteChanges(asIpc, new JazminChanges { Update = [new Dictionary<string, object?> { ["ack"] = "A-1", ["ackAction"] = "acknowledged" }] });
        refused44 = "not refused";
    }
    catch (JazminValidationException error)
    {
        refused44 = error.Message;
    }
    note44 = JazminFile.WriteChanges(asIpc, new JazminChanges { Update = [new Dictionary<string, object?> { ["ack"] = "A-1", ["ackNote"] = "isolation started" }] });
}
Console.WriteLine($"44. {allowed44} | {refused44} | {JazminFile.ApplyChanges(acks44, note44, new JazminApplyChangesOptions { Key = hospital44 }).Updated} applied");
JazminFile.GrantAccess(acks44, hospital44, new JazminGrant(ipc44) { Rows = ["W1"], Label = "Infection control" }); // Edit not given: the limit is kept
// 44. ackNote | Column 'ackAction' can't be changed with this key | 1 applied

// 45. Checking a whole file (USER-GUIDE 17.6): a query checks only the sections it reads, so a changed byte in an index
// no query uses goes unnoticed. Verify() checks every section of the current version, one at a time: in a file with a
// key or password by each section's CRC-32 and authentication tag, in a shared file by the owner's signature (owner
// key), in a plain file by its CRC-32s. It names the first section that fails.
var checked45 = Path.Combine(dir, "checked.jzm");
var key45 = JazminKey.Generate();
using (var writer = JazminWriter.Create(checked45,
    [new("id", JazminType.Int) { Indexes = [JazminIndexKind.Sorted] }, new("name", JazminType.String) { Indexes = [JazminIndexKind.Trigram] }],
    new JazminWriteOptions { Key = key45 }))
{
    for (var i = 1L; i <= 1000; i++) writer.WriteValues(i, $"customer {i}");
}
JazminVerification verified45;
using (var reader = JazminReader.Open(checked45, new JazminReadOptions { Key = key45 })) verified45 = reader.Verify();
var damaged45 = File.ReadAllBytes(checked45);
damaged45[100] ^= 1; // one byte of a copy, in the first section after the 64-byte preamble
string caught45;
using (var reader = JazminReader.Open(damaged45, new JazminReadOptions { Key = key45 }))
{
    try
    {
        reader.Verify();
        caught45 = "not noticed";
    }
    catch (JazminFormatException error)
    {
        caught45 = error.Message;
    }
}
Console.WriteLine($"45. {verified45.CheckedBy}, {verified45.Sections} sections, {verified45.UnusedBytes} bytes unused | {caught45}");
// 45. encryption, 8 sections, 0 bytes unused | Section '0/chunk/0/*' failed its CRC-32 check

// 46. Batch writes and transactions (USER-GUIDE 17.7): each append flushes to disk twice, whatever its size, so batch.
// A transaction writes its calls as one append (all or none); the group writer merges many callers' calls into few
// appends, on one background task, safe for concurrent callers.
var orders46 = Path.Combine(dir, "orders.jzm");
using (var writer = JazminWriter.Create(orders46, [new("id", JazminType.Int) { Nullable = false }, new("status", JazminType.String)]))
{
    writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["status"] = "new" });
    writer.WriteRow(new Dictionary<string, object?> { ["id"] = 2L, ["status"] = "new" });
}
JazminAppendResult committed46;
using (var tx = JazminFile.BeginAppend(orders46, new JazminAppend { KeyColumns = ["id"] }))
{
    tx.Upsert([new Dictionary<string, object?> { ["id"] = 1L, ["status"] = "paid" }]);
    tx.Insert([new Dictionary<string, object?> { ["id"] = 3L, ["status"] = "new" }]);
    tx.Delete(JazminFilter.Eq("id", 2));
    committed46 = tx.Commit(); // Dispose without Commit rolls back
}
JazminAppendResult[] results46;
await using (var groupWriter = JazminFile.OpenWriter(orders46, maxDelay: TimeSpan.FromMilliseconds(5)))
    results46 = await Task.WhenAll(new[] { 4L, 5L, 6L }.Select(id => groupWriter.InsertAsync([new Dictionary<string, object?> { ["id"] = id, ["status"] = "new" }]))); // three callers
Console.WriteLine($"46. {committed46.AppendCount} {committed46.Updated} {committed46.Inserted} {committed46.Deleted} | {string.Join(",", results46.Select(r => r.AppendCount))} {results46[0].Inserted}");
// 46. 1 1 1 1 | 2,2,2 3

// 47. Rows of many partitions in turn (USER-GUIDE 15.5): a chunk holds one partition, so rows written as they come make
// a chunk of nearly every row. Regroup = true stores each partition's rows together, each in the order given; the
// file's row order then differs from the order given (here clinic 0's visits come first).
var owner47 = JazminKey.Generate();
string Clinics47(bool regroup)
{
    var file = Path.Combine(dir, $"clinics-{regroup}.jzm");
    using (var writer = JazminWriter.Create(file, [new JazminColumn("clinic", JazminType.String), new JazminColumn("visit", JazminType.Int)],
        new JazminWriteOptions { Key = owner47, Access = new JazminAccessOptions { PartitionBy = "clinic" }, Regroup = regroup }))
    {
        for (var i = 0L; i < 1000; i++) writer.WriteValues($"clinic {i % 4}", i);
    }
    using var reader = JazminReader.Open(file, new JazminReadOptions { Key = owner47 });
    return $"{reader.ChunkCount} chunks, first visits {string.Join(", ", reader.Rows().Take(3).Select(r => r["visit"]))}";
}
Console.WriteLine($"47. as given: {Clinics47(false)}; regrouped: {Clinics47(true)}");
// 47. as given: 1000 chunks, first visits 0, 1, 2; regrouped: 4 chunks, first visits 0, 4, 8

Directory.Delete(dir, true);

/// <summary>
/// Reports at once, on the thread doing the work, so a console program prints in order. Progress&lt;T&gt; reports
/// later, on the thread pool (or on the UI thread of an app, which is what a progress bar needs).
/// </summary>
public sealed class ReportNow<T>(Action<T> report) : IProgress<T>
{
    public void Report(T value) => report(value);
}

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
