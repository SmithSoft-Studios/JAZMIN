using System.Diagnostics;
using System.Text.Json;
using Jazmin;
using Jazmin.Serialization;
using Newtonsoft.Json;

/// <summary>
/// Streaming JSON (Newtonsoft JsonTextReader, System.Text.Json DeserializeAsyncEnumerable)
/// vs JAZMIN on a large statement file, read one section at a time.
/// Run: dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks -- streaming path/to/statements.json [sections]
/// (generate the JSON with: node js/bench/sections.js, or any array of objects with a "section" field).
/// </summary>
internal static class StreamingComparison
{
    public sealed class Line
    {
        [JsonProperty("section")] [System.Text.Json.Serialization.JsonPropertyName("section")]
        public string Section { get; set; } = "";
        [JsonProperty("client")] [System.Text.Json.Serialization.JsonPropertyName("client")]
        public string Client { get; set; } = "";
        [JsonProperty("line")] [System.Text.Json.Serialization.JsonPropertyName("line")]
        public long LineNo { get; set; }
        [JsonProperty("date")] [System.Text.Json.Serialization.JsonPropertyName("date")]
        public DateTime Date { get; set; }
        [JsonProperty("description")] [System.Text.Json.Serialization.JsonPropertyName("description")]
        public string Description { get; set; } = "";
        [JsonProperty("amount")] [System.Text.Json.Serialization.JsonPropertyName("amount")]
        public double Amount { get; set; }
        [JsonProperty("balance")] [System.Text.Json.Serialization.JsonPropertyName("balance")]
        public double Balance { get; set; }
        [JsonProperty("category")] [System.Text.Json.Serialization.JsonPropertyName("category")]
        public string Category { get; set; } = "";
    }

    // JAZMIN column names come from the JSON ("section", "line"...); property mapping is case-insensitive.
    public sealed class JzLine
    {
        public string Section { get; set; } = "";
        public string Client { get; set; } = "";
        public long Line { get; set; }
        public DateTime Date { get; set; }
        public string Description { get; set; } = "";
        public double Amount { get; set; }
        public double Balance { get; set; }
        public string Category { get; set; } = "";
    }

    private static string Id(int s) => $"ACC{s:D6}";

    private static (double Ms, double AllocMb) Measure(Action action)
    {
        GC.Collect();
        var before = GC.GetTotalAllocatedBytes(true);
        var sw = Stopwatch.StartNew();
        action();
        return (sw.Elapsed.TotalMilliseconds, (GC.GetTotalAllocatedBytes(true) - before) / 1048576.0);
    }

    private static List<Line> NewtonsoftSection(string path, string id)
    {
        var serializer = Newtonsoft.Json.JsonSerializer.CreateDefault();
        using var text = new StreamReader(path);
        using var reader = new JsonTextReader(text);
        var lines = new List<Line>();
        while (reader.Read())
        {
            if (reader.TokenType != JsonToken.StartObject) continue;
            var line = serializer.Deserialize<Line>(reader)!;
            if (line.Section == id) lines.Add(line);
            else if (lines.Count > 0) break; // section passed (rows are grouped)
        }
        return lines;
    }

    private static List<Line> StjSection(string path, string id)
    {
        using var stream = File.OpenRead(path);
        var lines = new List<Line>();
        foreach (var line in System.Text.Json.JsonSerializer.DeserializeAsyncEnumerable<Line>(stream).ToBlockingEnumerable())
        {
            if (line!.Section == id) lines.Add(line);
            else if (lines.Count > 0) break;
        }
        return lines;
    }

    /// <summary>Quick profile of JAZMIN reads only (expects the .jzm from a previous run).</summary>
    private static void JazminOnly(string jzm, int sections)
    {
        string F(double ms) => ms >= 1000 ? $"{ms / 1000:N2} s" : $"{ms:N2} ms";
        using (var reader = JazminReader.Open(jzm))
        {
            reader.Query<JzLine>(l => l.Section == Id(1)).ToList();
            var q = Measure(() => { for (var s = 0; s < 200; s++) reader.Query<JzLine>(l => l.Section == Id(s * 7)).ToList(); });
            Console.WriteLine($"Query<T> per section: {F(q.Ms / 200)}");
            var f = Measure(() => { for (var s = 0; s < 200; s++) reader.Find(Jazmin.Query.JazminFilter.Eq("section", Id(s * 7))).ToList(); });
            Console.WriteLine($"Find per section:     {F(f.Ms / 200)}");
        }
        for (var i = 0; i < 2; i++)
        {
            var raw = Measure(() => { using var r = JazminReader.Open(jzm); foreach (var _ in r.Rows()) { } });
            var typed = Measure(() => { using var r = JazminReader.Open(jzm); foreach (var _ in r.Rows<JzLine>()) { } });
            Console.WriteLine($"full untyped {F(raw.Ms)} ({raw.AllocMb:N0} MB alloc), typed {F(typed.Ms)} ({typed.AllocMb:N0} MB alloc)");
        }
    }

    public static void Run(string[] args)
    {
        var json = args[1];
        var sections = args.Length > 2 ? int.Parse(args[2]) : 5000;
        var jzm = Path.ChangeExtension(json, ".jzm");
        var rows = new List<(string, string)>();
        string F(double ms) => ms >= 1000 ? $"{ms / 1000:N1} s" : $"{ms:N2} ms";

        if (args.Length > 3 && args[3] == "jazmin-only") { JazminOnly(jzm, sections); return; }
        var convert = Measure(() => JazminConvert.FromJsonFile(json, jzm, new JazminSerializerSettings
        {
            Indexes = new() { ["section"] = new[] { JazminIndexKind.Sorted } },
        }));
        rows.Add(("Convert JSON -> JAZMIN (once)", $"{F(convert.Ms)}, file {new FileInfo(jzm).Length / 1048576.0:N1} MB"));

        var probes = new[] { ("first", Id(0)), ("middle", Id(sections / 2)), ("last", Id(sections - 1)) };
        foreach (var (name, id) in probes)
        {
            var ns = Measure(() => NewtonsoftSection(json, id));
            var stj = Measure(() => StjSection(json, id));
            rows.Add(($"{name} section: Newtonsoft JsonTextReader", $"{F(ns.Ms)}, {ns.AllocMb:N0} MB allocated"));
            rows.Add(($"{name} section: System.Text.Json streaming", $"{F(stj.Ms)}, {stj.AllocMb:N0} MB allocated"));
        }

        using (var reader = JazminReader.Open(jzm))
        {
            reader.Query<JzLine>(l => l.Section == Id(1)).ToList(); // warm up JIT and load the index once
            var times = new List<double>();
            double alloc = 0;
            foreach (var (_, id) in probes)
            {
                var m = Measure(() => reader.Query<JzLine>(l => l.Section == id).ToList());
                times.Add(m.Ms);
                alloc = Math.Max(alloc, m.AllocMb);
            }
            rows.Add(("any section: JAZMIN Query<T> (file open)", $"{F(times.Average())} avg, {alloc:N1} MB allocated"));

            var all = Measure(() =>
            {
                for (var s = 0; s < sections; s++) reader.Query<JzLine>(l => l.Section == Id(s)).ToList();
            });
            rows.Add(($"all {sections} sections: JAZMIN", F(all.Ms)));
        }

        var nsFull = Measure(() => NewtonsoftSection(json, "no-such-section"));
        var stjFull = Measure(() => StjSection(json, "no-such-section"));
        var jzFull = Measure(() =>
        {
            using var reader = JazminReader.Open(jzm);
            foreach (var _ in reader.Rows<JzLine>()) { }
        });
        rows.Add(("full read: Newtonsoft JsonTextReader", F(nsFull.Ms)));
        rows.Add(("full read: System.Text.Json streaming", F(stjFull.Ms)));
        rows.Add(("full read: JAZMIN Rows<T>()", F(jzFull.Ms)));
        var jzRaw = Measure(() =>
        {
            using var reader = JazminReader.Open(jzm);
            foreach (var _ in reader.Rows()) { }
        });
        rows.Add(("full read: JAZMIN Rows() untyped", F(jzRaw.Ms)));
        using (var reader = JazminReader.Open(jzm))
        {
            reader.Find(Jazmin.Query.JazminFilter.Eq("section", Id(1))).ToList();
            var f = Measure(() => { foreach (var (_, id) in probes) reader.Find(Jazmin.Query.JazminFilter.Eq("section", id)).ToList(); });
            rows.Add(("any section: JAZMIN Find (untyped)", F(f.Ms / probes.Length)));
        }
        rows.Add(($"projected, all {sections} sections: Newtonsoft streaming", $"{F(probes.Length > 0 ? Measure(() => NewtonsoftSection(json, Id(sections / 2))).Ms * sections : 0)}"));

        Console.WriteLine($"\nStreaming JSON vs JAZMIN - {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}\n");
        var width = rows.Max(r => r.Item1.Length);
        foreach (var (label, value) in rows) Console.WriteLine($"{label.PadRight(width)}  {value}");
        File.Delete(jzm);
    }
}
