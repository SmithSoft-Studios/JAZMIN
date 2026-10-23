using System.Diagnostics;
using System.Text.Json;
using Jazmin;
using Jazmin.Query;

/// <summary>
/// One encrypted file per tenant (issue #275): each request opens its tenant's file with that tenant's key and looks
/// up one row. Without a cache every request reads, decrypts and opens the file; with <see cref="JazminReaderCache"/>
/// an open reader is leased instead, checked with Changed() first. Prints one JSON line per run: run the modes in turn,
/// several times, and compare the medians.
/// Run: dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks -- tenants [open|cache] [tenants] [rows] [passes] [folder]
/// </summary>
internal static class TenantsBenchmark
{
    public static void Run(string[] args)
    {
        var mode = args.Length > 1 ? args[1] : "open";
        var tenants = args.Length > 2 ? int.Parse(args[2]) : 1000;
        var rows = args.Length > 3 ? int.Parse(args[3]) : 500;
        var passes = args.Length > 4 ? int.Parse(args[4]) : 5;
        var dir = args.Length > 5 ? args[5] : Path.Combine(Path.GetTempPath(), $"jazmin-tenants-net-{tenants}x{rows}");
        string File(int t) => Path.Combine(dir, $"tenant-{t:D5}.jzm");
        var keysFile = Path.Combine(dir, "keys.json");
        if (!System.IO.File.Exists(keysFile))
        {
            Directory.CreateDirectory(dir);
            var columns = new[]
            {
                new JazminColumn("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
                new JazminColumn("customer", JazminType.String),
                new JazminColumn("amount", JazminType.Float),
                new JazminColumn("note", JazminType.String),
            };
            var made = new List<string>();
            for (var t = 0; t < tenants; t++)
            {
                var key = JazminKey.Generate();
                made.Add(key.Export());
                using var writer = JazminWriter.Create(File(t), columns, new JazminWriteOptions { Key = key });
                for (var i = 0; i < rows; i++) writer.WriteValues((long)i, $"C{t}-{i % 97}", i * 1.25, $"Invoice {t}/{i}");
            }
            System.IO.File.WriteAllText(keysFile, JsonSerializer.Serialize(made)); // made-up keys for a throwaway folder
        }
        var keys = JsonSerializer.Deserialize<List<string>>(System.IO.File.ReadAllText(keysFile))!.Select(JazminKey.Parse).ToArray();

        var random = new Random(12345);
        using var cache = mode == "cache" ? new JazminReaderCache(tenants) : null;
        var found = 0L;
        void Request(int t)
        {
            var id = (long)random.Next(rows);
            var options = new JazminReadOptions { Key = keys[t] };
            if (cache is not null)
            {
                using var lease = cache.Open(File(t), options);
                foreach (var row in lease.Reader.Find(JazminFilter.Eq("id", id))) found += (long)row["id"]! == id ? 1 : 0;
            }
            else
            {
                using var reader = JazminReader.Open(File(t), options);
                foreach (var row in reader.Find(JazminFilter.Eq("id", id))) found += (long)row["id"]! == id ? 1 : 0;
            }
        }

        static long Memory()
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            return GC.GetTotalMemory(true);
        }
        var before = Memory();
        var timings = new List<double>();
        for (var p = 0; p < passes; p++)
        {
            var order = Enumerable.Range(0, tenants).ToArray();
            random.Shuffle(order);
            var sw = Stopwatch.StartNew();
            foreach (var t in order) Request(t);
            timings.Add(sw.Elapsed.TotalMilliseconds / tenants);
        }
        var after = Memory();
        if (found != (long)tenants * passes) throw new InvalidOperationException($"expected {tenants * passes} rows, found {found}");
        var warm = timings.Skip(1).Order().ToList();
        using var process = Process.GetCurrentProcess();
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            mode, tenants, rows, runtime = Environment.Version.ToString(),
            firstPassMsPerRequest = Math.Round(timings[0], 4),
            warmMsPerRequest = Math.Round(warm[warm.Count / 2], 4), // median of the later passes
            retainedManagedKB = (after - before) / 1024,
            workingSetMB = process.WorkingSet64 / 1048576,
            peakWorkingSetMB = process.PeakWorkingSet64 / 1048576,
        }));
    }
}
