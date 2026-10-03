using System.Diagnostics;
using Jazmin;
using Jazmin.Query;

/// <summary>
/// Access control at scale: 1.37M statement lines in 5,000 sections, one client key per section.
/// Run: dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks -- access [sections] [linesPerSection]
/// </summary>
internal static class AccessBenchmark
{
    public static void Run(string[] args)
    {
        var sections = args.Length > 1 ? int.Parse(args[1]) : 5000;
        var lines = args.Length > 2 ? int.Parse(args[2]) : 274;
        static string Id(int s) => $"ACC{s:D6}";
        var owner = JazminKey.Generate();
        var clients = Enumerable.Range(0, sections).Select(_ => owner.CreateAccessKey()).ToArray();
        var columns = new[]
        {
            new JazminColumn("section", JazminType.String),
            new JazminColumn("line", JazminType.Int),
            new JazminColumn("amount", JazminType.Float),
        };
        var path = Path.Combine(Path.GetTempPath(), $"jazmin-access-{Guid.NewGuid():N}.jzm");
        var results = new List<(string, string)>();

        var sw = Stopwatch.StartNew();
        using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions
        {
            Key = owner,
            SortedBy = ["section"],
            Access = new JazminAccessOptions
            {
                PartitionBy = "section",
                Grants = clients.Select((k, s) => new JazminGrant(k) { Rows = [Id(s)], Label = $"Client {s}" }).ToList(),
            },
        }))
        {
            for (var s = 0; s < sections; s++)
                for (var l = 0; l < lines; l++) writer.WriteValues(Id(s), (long)l, l * 1.5);
        }
        results.Add(($"Write {sections * lines:N0} lines, {sections} client grants", $"{sw.Elapsed.TotalSeconds:N1} s, {new FileInfo(path).Length / 1048576.0:N1} MB"));

        // Warm up well past .NET's tiered-compilation threshold (30 calls) so results reflect a
        // long-running service rather than first-call JIT cost.
        double Time(Action action, int repeat = 20)
        {
            for (var i = 0; i < 50; i++) action();
            var t = Stopwatch.StartNew();
            for (var i = 0; i < repeat; i++) action();
            return t.Elapsed.TotalMilliseconds / repeat;
        }

        var target = (int)(sections * 0.73);
        results.Add(("Client: open + own section", $"{Time(() =>
        {
            using var r = JazminReader.Open(path, new JazminReadOptions { AccessKey = clients[target] });
            r.Rows().ToList();
        }):N2} ms"));
        results.Add(("Owner: open + one section", $"{Time(() =>
        {
            using var r = JazminReader.Open(path, new JazminReadOptions { Key = owner });
            r.Find(JazminFilter.Eq("section", Id(target))).ToList();
        }):N2} ms"));
        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = owner }))
        {
            var random = new Random(1);
            results.Add(("Owner: per section, file open", $"{Time(() => reader.Find(JazminFilter.Eq("section", Id(random.Next(sections)))).ToList(), 500):N2} ms"));
        }
        File.Delete(path);

        Console.WriteLine($"\nJAZMIN access-control benchmark - {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}\n");
        var width = results.Max(r => r.Item1.Length);
        foreach (var (label, value) in results) Console.WriteLine($"{label.PadRight(width)}  {value}");
    }
}
