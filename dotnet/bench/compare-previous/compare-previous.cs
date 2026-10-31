#:property PublishAot=false
// This library against the previous release (release checklist), the twin of js/bench/compare-previous.mjs: the
// workloads in workloads.cs.txt are built twice, against the previous NuGet package and against this repository, and
// each workload runs in a process of its own, the two versions taking turns at going first; the median of --rounds
// runs of time and peak memory. Reads use one file both read, made by the previous release. Run it on a quiet machine.
//
//   dotnet run -c Release dotnet/bench/compare-previous/compare-previous.cs -- [--version 1.7.6] [--rows 500000] [--rounds 5]
//     [--only "<workload>"]   (one workload again, with more rounds, before calling a change a regression)
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

string Option(string name, string fallback) => args.SkipWhile(a => a != name).Skip(1).FirstOrDefault() ?? fallback;
var version = Option("--version", "1.7.6");
if (!Regex.IsMatch(version, @"^\d+\.\d+\.\d+$")) throw new ArgumentException($"--version is a release such as 1.6.2, not '{version}'");
var rows = int.Parse(Option("--rows", "500000"));
var rounds = int.Parse(Option("--rounds", "5"));
var here = Path.GetDirectoryName(Path.GetFullPath(Environment.GetCommandLineArgs().FirstOrDefault(a => a.EndsWith("compare-previous.cs")) ?? "dotnet/bench/compare-previous/compare-previous.cs"))!;
var root = Path.GetFullPath(Path.Combine(here, "..", "..", ".."));
var body = File.ReadAllText(Path.Combine(root, "dotnet", "bench", "compare-previous", "workloads.cs.txt"));
var work = Directory.CreateTempSubdirectory("jazmin-compare-").FullName;

// The workloads, built against each version once.
string Build(string name, string reference)
{
    var folder = Path.Combine(work, name);
    Directory.CreateDirectory(folder);
    var source = Path.Combine(folder, "bench.cs");
    File.WriteAllText(source, $"{reference}\n{body}");
    var output = Path.Combine(folder, "bin");
    Run("dotnet", ["build", "-c", "Release", source, "-o", output, "-v", "q", "-nologo"]);
    return Path.Combine(output, "bench.dll");
}
(string Out, long PeakBytes) Run(string file, string[] arguments)
{
    var start = new ProcessStartInfo(file) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
    foreach (var a in arguments) start.ArgumentList.Add(a);
    using var process = Process.Start(start)!;
    var output = process.StandardOutput.ReadToEndAsync();
    var errors = process.StandardError.ReadToEndAsync();
    long peak = 0;
    while (!process.WaitForExit(20))
    {
        try
        {
            process.Refresh();
            peak = Math.Max(peak, process.PeakWorkingSet64);
        }
        catch (InvalidOperationException)
        {
        }
    }
    if (process.ExitCode != 0) throw new InvalidOperationException($"{file} {string.Join(' ', arguments)}: {errors.Result}{output.Result}");
    return (output.Result, peak);
}

var previous = Build("previous", $"#:package Jazmin@{version}");
var current = Build("this", $"#:project {Path.Combine(root, "dotnet", "src", "Jazmin", "Jazmin.csproj")}");
var data = Path.Combine(work, "data");
Directory.CreateDirectory(data);
Run("dotnet", [previous, "make", data, rows.ToString()]);

string[] workloads = ["open + count (index)", "find, text search (trigram)", "find, scan (no index)", "every row", "write", "update (insert, keeps order)"];
if (Option("--only", "") is { Length: > 0 } only) workloads = workloads.Contains(only) ? [only] : throw new ArgumentException($"No workload '{only}' ({string.Join(", ", workloads)})");
double Median(IEnumerable<double> list) => list.Order().ElementAt(list.Count() / 2);
Console.WriteLine($"{rows:N0} rows, {rounds} rounds; median time and peak memory (working set). {version} vs this version.\n");
Console.WriteLine("| Workload | ms before | ms now | change | MB before | MB now |");
Console.WriteLine("|---|---|---|---|---|---|");
var slower = 0;
foreach (var workload in workloads)
{
    var seen = new Dictionary<string, List<(double Ms, double Mb, long Result)>> { ["previous"] = [], ["this"] = [] };
    for (var round = 0; round < rounds; round++)
    {
        var order = round % 2 == 0 ? new[] { ("previous", previous), ("this", current) } : [("this", current), ("previous", previous)]; // who goes first takes turns
        foreach (var (name, dll) in order)
        {
            var (output, peak) = Run("dotnet", [dll, workload, data, rows.ToString()]);
            var json = JsonDocument.Parse(output).RootElement;
            seen[name].Add((json.GetProperty("ms").GetDouble(), peak / 1048576.0, json.GetProperty("result").GetInt64()));
        }
    }
    if (seen.Values.SelectMany(v => v).Select(v => v.Result).Distinct().Count() != 1) throw new InvalidOperationException($"{workload}: the versions give different results");
    var (before, now) = (Median(seen["previous"].Select(v => v.Ms)), Median(seen["this"].Select(v => v.Ms)));
    var change = (now - before) / before;
    if (change > 0.1) slower++;
    Console.WriteLine($"| {workload} | {before:F1} | {now:F1} | {(change >= 0 ? "+" : "")}{change * 100:F0}% | {Median(seen["previous"].Select(v => v.Mb)):F0} | {Median(seen["this"].Select(v => v.Mb)):F0} |");
}
Directory.Delete(work, true);
Console.WriteLine(slower > 0 ? $"\n{slower} workload(s) more than 10% slower: run again on a quiet machine before calling it a regression." : "\nNone more than 10% slower.");
