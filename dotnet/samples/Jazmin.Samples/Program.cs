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
