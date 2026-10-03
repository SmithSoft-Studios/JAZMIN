// Indicative benchmark: JAZMIN vs Newtonsoft.Json vs System.Text.Json on the same POCOs.
// Run: dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks [rows]
// Results depend on hardware and data shape - re-run on your own data before quoting numbers.
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using Jazmin;
using Jazmin.Serialization;

if (args.Length > 0 && args[0] == "streaming")
{
    StreamingComparison.Run(args);
    return;
}

if (args.Length > 0 && args[0] == "wide")
{
    WideBenchmark.Run(args);
    return;
}

if (args.Length > 0 && args[0] == "access")
{
    AccessBenchmark.Run(args);
    return;
}

var rowsCount = args.Length > 0 ? int.Parse(args[0]) : 200_000;
var countries = new[] { "ZA", "NA", "BW", "ZW", "MZ", "LS", "SZ", "ZM" };
var first = new[] { "Ann", "Bob", "Thabo", "Lerato", "Pieter", "Aisha", "Sipho", "Maria" };
var last = new[] { "Smith", "Johnson", "Ndlovu", "Botha", "Naidoo", "Mokoena", "van Wyk", "Dlamini" };
var people = Enumerable.Range(0, rowsCount).Select(i => new Customer
{
    Id = i,
    Name = $"{first[i % 8]} {last[i * 7 % 8]}",
    Email = $"user{i}@example.com",
    Country = countries[i * 13 % 8],
    Age = 18 + i * 31 % 70,
    Balance = Math.Round(i * 7919 % 1_000_000 * 1.37) / 100,
    Joined = new DateTime(2015, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(i % 3650),
    Active = i % 3 != 0,
}).ToList();

var dir = Directory.CreateTempSubdirectory("jazmin-bench-").FullName;
string F(string name) => Path.Combine(dir, name);
var results = new List<(string Label, string Value)>();
void Row(string label, string value) => results.Add((label, value));

static double Time(Action action, int repeat = 3)
{
    // Warm-up for every contender alike: lets tiered JIT optimise library code (the framework's own
    // serializers are precompiled), so the timings compare steady-state speed.
    for (var i = 0; i < 3; i++) action();
    var best = double.MaxValue;
    for (var i = 0; i < repeat; i++)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        var sw = Stopwatch.StartNew();
        action();
        best = Math.Min(best, sw.Elapsed.TotalMilliseconds);
    }
    return best;
}

static double AllocatedMb(Action action)
{
    GC.Collect();
    var before = GC.GetTotalAllocatedBytes(true);
    action();
    return (GC.GetTotalAllocatedBytes(true) - before) / 1048576.0;
}

string Kb(string file) => $"{new FileInfo(F(file)).Length / 1024:N0} KB";
var key = JazminKey.Generate();
var indexes = new Dictionary<string, JazminIndexKind[]>
{
    ["Id"] = new[] { JazminIndexKind.Sorted },
    ["Country"] = new[] { JazminIndexKind.Sorted },
    ["Name"] = new[] { JazminIndexKind.Trigram },
};
var indexed = new JazminSerializerSettings { Indexes = indexes };
var secure = new JazminSerializerSettings { Key = key, Indexes = indexes };

// ---- Size ----------------------------------------------------------------------------------
File.WriteAllText(F("newtonsoft.json"), Newtonsoft.Json.JsonConvert.SerializeObject(people));
File.WriteAllBytes(F("stj.json"), System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(people));
using (var gz = new GZipStream(File.Create(F("newtonsoft.json.gz")), CompressionLevel.Optimal))
    gz.Write(File.ReadAllBytes(F("newtonsoft.json")));
File.WriteAllBytes(F("plain.jzm"), JazminConvert.SerializeObject(people));
File.WriteAllBytes(F("brotli.jzm"), JazminConvert.SerializeObject(people, new JazminSerializerSettings { Codec = JazminCodec.Brotli }));
File.WriteAllBytes(F("indexed.jzm"), JazminConvert.SerializeObject(people, indexed));
File.WriteAllBytes(F("secure.jzm"), JazminConvert.SerializeObject(people, secure));

Row("Rows", rowsCount.ToString("N0"));
Row("Size: Newtonsoft JSON", Kb("newtonsoft.json"));
Row("Size: Newtonsoft JSON + gzip", Kb("newtonsoft.json.gz"));
Row("Size: JAZMIN deflate, no indexes", Kb("plain.jzm"));
Row("Size: JAZMIN brotli, no indexes", Kb("brotli.jzm"));
Row("Size: JAZMIN deflate + 3 indexes", Kb("indexed.jzm"));
Row("Size: JAZMIN + indexes + AES-256-GCM", Kb("secure.jzm"));

// ---- Serialize -----------------------------------------------------------------------------
Row("Serialize: Newtonsoft", $"{Time(() => Newtonsoft.Json.JsonConvert.SerializeObject(people)):N0} ms");
Row("Serialize: System.Text.Json", $"{Time(() => System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(people)):N0} ms");
Row("Serialize: JAZMIN (no indexes)", $"{Time(() => JazminConvert.SerializeObject(people)):N0} ms");
Row("Serialize: JAZMIN (+3 indexes)", $"{Time(() => JazminConvert.SerializeObject(people, indexed)):N0} ms");

// ---- Deserialize all ----------------------------------------------------------------------
var nsText = File.ReadAllText(F("newtonsoft.json"));
var stjBytes = File.ReadAllBytes(F("stj.json"));
var jzmBytes = File.ReadAllBytes(F("plain.jzm"));
Row("Deserialize all: Newtonsoft", $"{Time(() => Newtonsoft.Json.JsonConvert.DeserializeObject<List<Customer>>(nsText)):N0} ms");
Row("Deserialize all: System.Text.Json", $"{Time(() => System.Text.Json.JsonSerializer.Deserialize<List<Customer>>(stjBytes)):N0} ms");
Row("Deserialize all: JAZMIN", $"{Time(() => JazminConvert.DeserializeObject<List<Customer>>(jzmBytes)):N0} ms");

// ---- Point lookup from disk ---------------------------------------------------------------
var target = (int)(rowsCount * 0.73);
Row("Lookup Id: Newtonsoft (read + parse all)",
    $"{Time(() => Newtonsoft.Json.JsonConvert.DeserializeObject<List<Customer>>(File.ReadAllText(F("newtonsoft.json")))!.First(c => c.Id == target)):N1} ms");
Row("Lookup Id: System.Text.Json (read + parse all)",
    $"{Time(() => System.Text.Json.JsonSerializer.Deserialize<List<Customer>>(File.ReadAllBytes(F("stj.json")))!.First(c => c.Id == target)):N1} ms");
Row("Lookup Id: JAZMIN LINQ + index",
    $"{Time(() => { using var r = JazminReader.Open(F("indexed.jzm")); r.Query<Customer>(c => c.Id == target).First(); }):N1} ms");
Row("Lookup Id: JAZMIN encrypted LINQ + index",
    $"{Time(() => { using var r = JazminReader.Open(F("secure.jzm"), new JazminReadOptions { Key = key }); r.Query<Customer>(c => c.Id == target).First(); }):N1} ms");

// ---- Filtered query -----------------------------------------------------------------------
Row("Filter: Newtonsoft (parse all + LINQ)",
    $"{Time(() => Newtonsoft.Json.JsonConvert.DeserializeObject<List<Customer>>(File.ReadAllText(F("newtonsoft.json")))!.Count(c => c.Country == "NA" && c.Age > 80)):N0} ms");
Row("Filter: JAZMIN LINQ (index + exact check)",
    $"{Time(() => { using var r = JazminReader.Open(F("indexed.jzm")); r.Query<Customer>(c => c.Country == "NA" && c.Age > 80).Count(); }):N0} ms");

// ---- Allocations --------------------------------------------------------------------------
Row("Allocated for one lookup: Newtonsoft",
    $"{AllocatedMb(() => Newtonsoft.Json.JsonConvert.DeserializeObject<List<Customer>>(File.ReadAllText(F("newtonsoft.json")))!.First(c => c.Id == target)):N1} MB");
Row("Allocated for one lookup: JAZMIN",
    $"{AllocatedMb(() => { using var r = JazminReader.Open(F("indexed.jzm")); r.Query<Customer>(c => c.Id == target).First(); }):N1} MB");

Console.WriteLine($"\nJAZMIN benchmark - {RuntimeInformation.FrameworkDescription}, {RuntimeInformation.OSDescription}\n");
var width = results.Max(r => r.Label.Length);
foreach (var (label, value) in results) Console.WriteLine($"{label.PadRight(width)}  {value}");
Directory.Delete(dir, true);

public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string Country { get; set; } = "";
    public int Age { get; set; }
    public double Balance { get; set; }
    public DateTime Joined { get; set; }
    public bool Active { get; set; }
}
