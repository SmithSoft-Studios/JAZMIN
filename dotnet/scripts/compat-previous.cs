#:package Jazmin@1.8.2
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
// Limits per key (spec 7.9.1): no release that doesn't know them may apply a change file to such a file. 1.8 and later
// know them: they apply what a key may send, refuse the rest with the reason, and keep the limit.
var knowsLimits = Version.Parse(version) >= new Version(1, 8);
Check(knowsLimits ? "limits per key: the limited key reads every row, and may send only what its limit allows"
    : "limits per key: the limited key reads every row; the document takes no changes there", () =>
{
    using var r = Open("edit-limits.jzm", keys["reader"]!.GetValue<string>());
    return knowsLimits
        ? Same(new object?[] { r.RowCount, r.Edit?.Columns, r.Edit?.Add, r.Edit?.Delete }, new object?[] { 60L, new[] { "note" }, false, false })
        : Same(new object?[] { r.RowCount, r.Package?.Edit is null }, new object?[] { 60L, true });
});
Check(knowsLimits ? "limits per key: the out-of-limit changes are refused with their reasons; nothing applied, the file unchanged"
    : "limits per key: applying the out-of-limit change file is refused, also as a dry run", () =>
{
    var copy = Path.Combine(Path.GetTempPath(), $"jazmin-compat-{Guid.NewGuid():N}.jzm");
    File.Copy(Path.Combine(folder, "edit-limits.jzm"), copy);
    var before = File.ReadAllBytes(copy);
    var change = File.ReadAllBytes(Path.Combine(folder, "edit-limits-change.jzm"));
    var owner = JazminKey.Parse(keys["owner"]!.GetValue<string>());
    if (knowsLimits)
    {
        var result = JazminFile.ApplyChanges(copy, change, new JazminApplyChangesOptions { Key = owner });
        return Same(new object[] { result.Updated, result.Added, result.Deleted, result.Refused.Select(r => r.Op).ToArray() }, new object[] { 0L, 0L, 0L, new[] { "update", "delete" } })
            ?? (File.ReadAllBytes(copy).AsSpan().SequenceEqual(before) ? null : "the file changed");
    }
    foreach (var dryRun in new[] { true, false })
    {
        try
        {
            JazminFile.ApplyChanges(copy, change, new JazminApplyChangesOptions { Key = owner, DryRun = dryRun });
            return $"applied (dry run: {dryRun})";
        }
        catch (JazminException error) when (error.Message.Contains("doesn't take changes", StringComparison.Ordinal)) { }
    }
    return File.ReadAllBytes(copy).AsSpan().SequenceEqual(before) ? null : "the file changed";
});
if (knowsLimits)
    Check("limits per key: a rewrite keeps the limit", () =>
    {
        var copy = Path.Combine(Path.GetTempPath(), $"jazmin-compat-{Guid.NewGuid():N}.jzm");
        File.Copy(Path.Combine(folder, "edit-limits.jzm"), copy);
        var owner = JazminKey.Parse(keys["owner"]!.GetValue<string>());
        JazminFile.Compact(copy, owner);
        using var r = JazminReader.Open(copy, new JazminReadOptions { Key = owner });
        var edit = r.Access!.Grants[0].Edit;
        return Same(new object?[] { edit?.Columns, edit?.Add, edit?.Delete }, new object?[] { new[] { "note" }, false, false });
    });
else if (Version.Parse(version) >= new Version(1, 7))
    Check("limits per key: a rewrite is refused (the writer feature edit-limits), the file unchanged", () =>
    {
        var copy = Path.Combine(Path.GetTempPath(), $"jazmin-compat-{Guid.NewGuid():N}.jzm");
        File.Copy(Path.Combine(folder, "edit-limits.jzm"), copy);
        var before = File.ReadAllBytes(copy);
        try
        {
            JazminFile.Compact(copy, JazminKey.Parse(keys["owner"]!.GetValue<string>()));
            return "rewritten";
        }
        catch (JazminException error) when (error.Message.Contains("edit-limits", StringComparison.Ordinal)) { }
        return File.ReadAllBytes(copy).AsSpan().SequenceEqual(before) ? null : "the file changed";
    });
return failed == 0 ? 0 : 1;
