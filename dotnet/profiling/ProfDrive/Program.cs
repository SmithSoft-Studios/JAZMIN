// Focused profiling driver: loops ONE JAZMIN path with no inter-iteration GC,
// so a CPU trace attributes self-time to library code, not harness GC.
// Usage: ProfDrive <read|deser|write> [rows] [iters]
using System.Diagnostics;
using Jazmin;
using Jazmin.Serialization;

var mode = args.Length > 0 ? args[0] : "read";
var rows = args.Length > 1 ? int.Parse(args[1]) : 200_000;
var iters = args.Length > 2 ? int.Parse(args[2]) : 0;

var countries = new[] { "ZA", "NA", "BW", "ZW", "MZ", "LS", "SZ", "ZM" };
var first = new[] { "Ann", "Bob", "Thabo", "Lerato", "Pieter", "Aisha", "Sipho", "Maria" };
var last = new[] { "Smith", "Johnson", "Ndlovu", "Botha", "Naidoo", "Mokoena", "van Wyk", "Dlamini" };
var people = Enumerable.Range(0, rows).Select(i => new Customer
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

var indexes = new Dictionary<string, JazminIndexKind[]>
{
    ["Id"] = new[] { JazminIndexKind.Sorted },
    ["Country"] = new[] { JazminIndexKind.Sorted },
    ["Name"] = new[] { JazminIndexKind.Trigram },
};
var indexed = new JazminSerializerSettings { Indexes = indexes };
var tmp = Path.Combine(Path.GetTempPath(), "profdrive.jzm");
File.WriteAllBytes(tmp, JazminConvert.SerializeObject(people, indexed));
var jzmBytes = File.ReadAllBytes(tmp);
var target = (int)(rows * 0.73);

var sw = Stopwatch.StartNew();
long sink = 0;
switch (mode)
{
    case "read": // point lookup via Sorted index - the read priority path (open per lookup)
        iters = iters > 0 ? iters : 20_000;
        for (var i = 0; i < iters; i++)
        {
            using var r = JazminReader.Open(jzmBytes);
            var c = r.Query<Customer>(x => x.Id == target).First();
            sink += c.Age;
        }
        break;
    case "readreuse": // same lookup but reader opened ONCE, reused across iterations
        iters = iters > 0 ? iters : 20_000;
        {
            using var r = JazminReader.Open(jzmBytes);
            for (var i = 0; i < iters; i++)
                sink += r.Query<Customer>(x => x.Id == target).First().Age;
        }
        break;
    case "deser": // full materialization of every row
        iters = iters > 0 ? iters : 300;
        for (var i = 0; i < iters; i++)
        {
            var all = JazminConvert.DeserializeObject<List<Customer>>(jzmBytes)!;
            sink += all.Count;
        }
        break;
    case "write": // serialize + build 3 indexes
        iters = iters > 0 ? iters : 300;
        for (var i = 0; i < iters; i++)
            sink += JazminConvert.SerializeObject(people, indexed).Length;
        break;
}
sw.Stop();
Console.WriteLine($"{mode}: {iters} iters, {rows} rows, {sw.Elapsed.TotalMilliseconds:N0} ms total, {sw.Elapsed.TotalMilliseconds / iters:N3} ms/iter (sink={sink})");

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
