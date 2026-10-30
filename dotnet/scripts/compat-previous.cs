#:package Jazmin@1.7.5
#:property PublishAot=false
// Checks that the previous release (the package above: change its version for the next release) reads the files this
// one writes: the twin of js/scripts/compat-previous.mjs, which writes them and keys.json into a folder first.
//
//   node js/scripts/compat-previous.mjs --out <folder>
//   dotnet run -c Release dotnet/scripts/compat-previous.cs -- <folder>
using System.Text.Json.Nodes;
using Jazmin;

var folder = args.Length > 0 ? args[0] : throw new ArgumentException("Give the folder js/scripts/compat-previous.mjs wrote");
var keys = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "keys.json")))!;
var version = typeof(JazminReader).Assembly.GetName().Version!.ToString(3);
var failed = 0;

JazminReader Open(string name, string? key = null) => JazminReader.Open(File.ReadAllBytes(Path.Combine(folder, name)), key is null
    ? new JazminReadOptions()
    : key.StartsWith("jzk1-", StringComparison.Ordinal) ? new JazminReadOptions { Key = JazminKey.Parse(key) } : new JazminReadOptions { AccessKey = JazminAccessKey.Parse(key) });
string? Same<T>(T actual, T expected) =>
    System.Text.Json.JsonSerializer.Serialize(actual) == System.Text.Json.JsonSerializer.Serialize(expected) ? null : $"{System.Text.Json.JsonSerializer.Serialize(actual)} != {System.Text.Json.JsonSerializer.Serialize(expected)}";
void Check(string label, Func<string?> check)
{
    string? problem;
    try
    {
        problem = check();
    }
    catch (Exception error)
    {
        problem = $"{error.GetType().Name}: {error.Message}";
    }
    if (problem is not null) failed++;
    Console.WriteLine($"{(problem is null ? "ok  " : "FAIL")} {version} {label}{(problem is null ? "" : $"\n       {problem}")}");
}

Check("other text orders: every row; SortedBy is the plain leading key", () =>
{
    using var r = Open("sort.jzm");
    return Same(new object[] { r.RowCount, r.SortedBy, r.Find(Jazmin.Query.JazminFilter.Eq("region", "East")).Count() }, new object[] { 60L, new[] { "region" }, 20 });
});
Check("the newer package settings: the document and the settings that version knows", () =>
{
    using var r = Open("package.jzm");
    return Same(new object?[] { r.Package!.Entry, r.Package.Title, r.Package.AllowedOrigins, r.RowCount }, new object?[] { "index.html", "Online", new[] { "https://cdn.jsdelivr.net" }, 60L });
});
Check("stored-file options: the files, rows and each file's content", () =>
{
    using var r = Open("file-options.jzm", keys["reader"]!.GetValue<string>());
    return Same(new object[] { r.Files.Select(f => f.Path).Order(StringComparer.Ordinal).ToArray(), r.RowCount, System.Text.Encoding.UTF8.GetString(r.ReadFile("terms.pdf")) },
        new object[] { new[] { "font.woff2", "index.html", "terms.pdf" }, 60L, "terms" });
});
Check("locked files: the rows and the open file; the locked one refused (before 1.7: no key for it; 1.7 on: locked)", () =>
{
    using var r = Open("locks.jzm", keys["reader"]!.GetValue<string>());
    var problem = Same(new object[] { r.RowCount, System.Text.Encoding.UTF8.GetString(r.ReadFile("readme.txt")) }, new object[] { 60L, "open" });
    if (problem is not null) return problem;
    try
    {
        r.ReadFile("contract.pdf");
        return "not refused";
    }
    catch (JazminException error)
    {
        return error.Message.Contains("key", StringComparison.OrdinalIgnoreCase) || error.Message.Contains("is locked", StringComparison.Ordinal) ? null : error.Message;
    }
});
Check("masked columns: an access key reads the rows and what the column shows, never the masked values", () =>
{
    using var r = Open("masks.jzm", keys["reader"]!.GetValue<string>());
    var first = r.Rows().First();
    return Same(new object?[] { r.Columns.Select(c => c.Name).ToArray(), first["account_shown"], first.TryGetValue("account", out _) },
        new object?[] { new[] { "id", "region", "name", "account_shown" }, "•••• 1000", false });
});
Check("document pages: the rows, the entry page, and every page and file as a stored file", () =>
{
    using var r = Open("pages.jzm", keys["reader"]!.GetValue<string>());
    return Same(new object?[] { r.RowCount, r.Package!.Entry, r.Files.Select(f => f.Path).Order(StringComparer.Ordinal).ToArray(), System.Text.Encoding.UTF8.GetString(r.ReadFile("board.html")) },
        new object?[] { 60L, "index.html", new[] { "app.js", "board.html", "detail.html", "index.html" }, "board" });
});
Check("masked columns: the owner reads every column", () =>
{
    using var r = Open("masks.jzm", keys["owner"]!.GetValue<string>());
    return Same((string?)r.Rows().First()["account"], "4821 1000");
});
return failed == 0 ? 0 : 1;
