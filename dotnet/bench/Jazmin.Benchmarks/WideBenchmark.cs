using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Jazmin;
using Jazmin.Query;

/// <summary>
/// Wide-table benchmark: JAZMIN vs System.Text.Json on many rows x many columns, without holding the data in
/// memory. Both sides are written and read as streams; each measurement runs in its own process so its peak
/// memory is measured cleanly. Same data as js/bench/wide.js.
/// Run: dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks -- wide [rows=1000000] [columns=300] [dir]
/// </summary>
internal static class WideBenchmark
{
    private static readonly string[] Kinds = ["status", "name", "amount", "money", "date", "flag", "price", "qty"];
    private static readonly string[] Statuses = ["paid", "due", "overdue", "void", "draft", "sent", "partial", "disputed"];
    private static readonly string[] Names = Enumerable.Range(0, 2000).Select(i => $"Customer {i} {new[] { "Ltd", "Inc", "CC", "Trust" }[i % 4]}").ToArray();
    private static readonly DateTime Base = new(2015, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private static JazminColumn[] Columns(int count)
    {
        var columns = new List<JazminColumn> { new("id", JazminType.Int) { Nullable = false } };
        for (var c = 1; c < count; c++)
        {
            var kind = Kinds[c % Kinds.Length];
            var type = kind switch
            {
                "status" or "name" => JazminType.String,
                "amount" or "qty" => JazminType.Int,
                "money" => JazminType.Float,
                "date" => JazminType.DateTime,
                "flag" => JazminType.Bool,
                _ => JazminType.Decimal,
            };
            columns.Add(new JazminColumn($"{kind}_{c}", type));
        }
        return columns.ToArray();
    }

    /// <summary>Row values in column order (same formula as the JS benchmark).</summary>
    private static void Fill(object?[] values, long r)
    {
        values[0] = r;
        for (var c = 1; c < values.Length; c++)
        {
            var h = (uint)(unchecked((int)((r + 1) * 2654435761L)) ^ (c * 40503));
            if (h % 20 == 0)
            {
                values[c] = null;
                continue;
            }
            values[c] = (c % 8) switch
            {
                0 => Statuses[h % 8],
                1 => Names[h % 2000],
                2 => (long)(h % 10_000_000),
                3 => (h % 1_000_000) / 100.0,
                4 => Base.AddMilliseconds(r * 60_000L + h % 86_400 * 1000L),
                5 => (h & 1) == 1,
                6 => $"{h % 100_000}.{h % 100:D2}",
                _ => (long)(h % 101),
            };
        }
    }

    public static void Run(string[] args)
    {
        var rows = args.Length > 1 ? long.Parse(args[1], CultureInfo.InvariantCulture) : 1_000_000;
        var cols = args.Length > 2 ? int.Parse(args[2], CultureInfo.InvariantCulture) : 300;
        var dir = args.Length > 3 ? args[3] : Path.Combine(Path.GetTempPath(), $"jazmin-wide-net-{rows}x{cols}");
        if (args.Length > 4)
        {
            Phase(args[4], rows, cols, dir);
            return;
        }
        Directory.CreateDirectory(dir);
        string[] phases = ["write-jzm", "write-json", "open-jzm", "lookup-jzm", "lookup-json", "project-jzm", "project-json", "filter-jzm", "filter-json", "scan-jzm", "scan-json"];
        var results = new Dictionary<string, (double Ms, double PeakMb, string Result)>();
        foreach (var phase in phases)
        {
            Console.Error.WriteLine($"  {phase}...");
            var psi = new ProcessStartInfo(Environment.ProcessPath!) { RedirectStandardOutput = true, UseShellExecute = false };
            foreach (var a in new[] { "wide", rows.ToString(CultureInfo.InvariantCulture), cols.ToString(CultureInfo.InvariantCulture), dir, phase }) psi.ArgumentList.Add(a);
            using var child = Process.Start(psi)!;
            var output = child.StandardOutput.ReadToEnd().Trim().Split('|');
            child.WaitForExit();
            results[phase] = (double.Parse(output[0], CultureInfo.InvariantCulture), double.Parse(output[1], CultureInfo.InvariantCulture), output[2]);
        }
        string Mb(string bytes) => $"{long.Parse(bytes, CultureInfo.InvariantCulture) / 1048576:N0} MB";
        string T((double Ms, double PeakMb, string Result) r) => $"{r.Ms / 1000:N2} s, {r.PeakMb:N0} MB RAM";
        Console.WriteLine($"\nWide benchmark - {rows:N0} rows x {cols} columns, {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}\n");
        Console.WriteLine($"Size: JSON                        {Mb(results["write-json"].Result)}");
        Console.WriteLine($"Size: JAZMIN (columnar)           {Mb(results["write-jzm"].Result)}");
        Console.WriteLine($"Write: System.Text.Json           {T(results["write-json"])}");
        Console.WriteLine($"Write: JAZMIN                     {T(results["write-jzm"])}");
        Console.WriteLine($"Open: JAZMIN (header)             {T(results["open-jzm"])}  ({results["open-jzm"].Result} chunks)");
        foreach (var (label, key) in new[] { ("Lookup one id", "lookup"), ("Sum 3 of the columns", "project"), ("Filter 2 conditions", "filter"), ("Read every row", "scan") })
        {
            Console.WriteLine($"{label}: JSON stream".PadRight(34) + T(results[$"{key}-json"]));
            Console.WriteLine($"{label}: JAZMIN".PadRight(34) + T(results[$"{key}-jzm"]));
            if (results[$"{key}-json"].Result != results[$"{key}-jzm"].Result)
                Console.WriteLine($"  !! results differ: {results[$"{key}-json"].Result} vs {results[$"{key}-jzm"].Result}");
        }
        Console.WriteLine($"\nFiles kept in {dir} (delete when done).");
    }

    private static void Phase(string phase, long rows, int cols, string dir)
    {
        var columns = Columns(cols);
        var jzm = Path.Combine(dir, "wide.jzm");
        var json = Path.Combine(dir, "wide.json");
        var target = (long)Math.Floor(rows * 0.731);
        var (p1, p2, p3) = (columns[2].Name, columns[3].Name, columns[10].Name);
        var (status, amount) = (columns[8].Name, columns[2].Name);
        var sw = Stopwatch.StartNew();
        string result;
        switch (phase)
        {
            case "write-jzm":
            {
                var values = new object?[cols];
                using (var w = JazminWriter.Create(jzm, columns, new JazminWriteOptions { SortedBy = ["id"] }))
                    for (long r = 0; r < rows; r++)
                    {
                        Fill(values, r);
                        w.WriteValues(values);
                    }
                result = new FileInfo(jzm).Length.ToString(CultureInfo.InvariantCulture);
                break;
            }
            case "write-json":
            {
                var values = new object?[cols];
                using (var stream = File.Create(json, 1 << 20))
                using (var w = new Utf8JsonWriter(stream))
                {
                    w.WriteStartArray();
                    for (long r = 0; r < rows; r++)
                    {
                        Fill(values, r);
                        w.WriteStartObject();
                        for (var c = 0; c < cols; c++)
                        {
                            w.WritePropertyName(columns[c].Name);
                            switch (values[c])
                            {
                                case null: w.WriteNullValue(); break;
                                case string s: w.WriteStringValue(s); break;
                                case long l: w.WriteNumberValue(l); break;
                                case double d: w.WriteNumberValue(d); break;
                                case bool b: w.WriteBooleanValue(b); break;
                                case DateTime dt: w.WriteStringValue(dt); break;
                            }
                        }
                        w.WriteEndObject();
                        if (w.BytesPending > 1 << 20) w.Flush();
                    }
                    w.WriteEndArray();
                }
                result = new FileInfo(json).Length.ToString(CultureInfo.InvariantCulture);
                break;
            }
            case "open-jzm":
            {
                using var r = JazminReader.Open(jzm);
                result = r.ChunkCount.ToString(CultureInfo.InvariantCulture);
                break;
            }
            case "lookup-jzm":
            {
                using var r = JazminReader.Open(jzm);
                result = r.Find(JazminFilter.Eq("id", target)).First()["id"]!.ToString()!;
                break;
            }
            case "lookup-json":
                result = JsonRows(json).First(e => e.GetProperty("id").GetInt64() == target).GetProperty("id").GetInt64().ToString(CultureInfo.InvariantCulture);
                break;
            case "project-jzm":
            {
                using var r = JazminReader.Open(jzm);
                double sum = 0;
                foreach (var row in r.Rows(new JazminQueryOptions { Select = [p1, p2, p3] }))
                    sum += Num(row[p1]) + Num(row[p2]) + Num(row[p3]);
                result = Math.Round(sum).ToString(CultureInfo.InvariantCulture);
                break;
            }
            case "project-json":
            {
                double sum = 0;
                foreach (var e in JsonRows(json)) sum += Num(e, p1) + Num(e, p2) + Num(e, p3);
                result = Math.Round(sum).ToString(CultureInfo.InvariantCulture);
                break;
            }
            case "filter-jzm":
            {
                using var r = JazminReader.Open(jzm);
                result = r.Find(JazminFilter.And(JazminFilter.Eq(status, "paid"), JazminFilter.Gt(amount, 5_000_000L)), new JazminQueryOptions { Select = ["id"] })
                    .LongCount().ToString(CultureInfo.InvariantCulture);
                break;
            }
            case "filter-json":
                result = JsonRows(json).LongCount(e => e.GetProperty(status) is { ValueKind: JsonValueKind.String } s && s.GetString() == "paid"
                    && e.GetProperty(amount) is { ValueKind: JsonValueKind.Number } a && a.GetInt64() > 5_000_000).ToString(CultureInfo.InvariantCulture);
                break;
            case "scan-jzm":
            {
                using var r = JazminReader.Open(jzm);
                result = r.Rows().LongCount().ToString(CultureInfo.InvariantCulture);
                break;
            }
            case "scan-json":
                result = JsonRows(json).LongCount().ToString(CultureInfo.InvariantCulture);
                break;
            default:
                throw new ArgumentException($"Unknown phase {phase}");
        }
        var ms = sw.Elapsed.TotalMilliseconds;
        Console.Write($"{ms.ToString(CultureInfo.InvariantCulture)}|{(Process.GetCurrentProcess().PeakWorkingSet64 / 1048576.0).ToString(CultureInfo.InvariantCulture)}|{result}");
    }

    private static double Num(object? v) => v switch { long l => l, double d => d, _ => 0 };

    private static double Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;

    /// <summary>Streams the array elements of a JSON file (System.Text.Json, bounded memory).</summary>
    private static IEnumerable<JsonElement> JsonRows(string path)
    {
        using var stream = File.OpenRead(path);
        foreach (var e in JsonSerializer.DeserializeAsyncEnumerable<JsonElement>(stream).ToBlockingEnumerable()) yield return e;
    }
}
