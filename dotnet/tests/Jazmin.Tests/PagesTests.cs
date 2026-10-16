using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Document pages (spec 6.8, 1.7): package.pages (the document's pages, in order, each with its own settings),
/// package.files (the document's own files, kept out of viewers' lists of files) and a file's page in a file group's
/// directory (pages only that group's keys know of). Writers check them; append, update and compact keep them.
/// </summary>
[Collection("Temporary sort folders")] // rewrites make and delete jazmin-sort-* in the temp folder, which other tests count
public sealed class PagesTests
{
    private static readonly JazminColumn[] ClientColumns = [new("clientId", JazminType.String) { Nullable = false }, new("name", JazminType.String)];
    private static readonly JazminColumn[] TxColumns = [new("clientId", JazminType.String) { Nullable = false }, new("amount", JazminType.Decimal)];
    private static readonly string[] Cdn = ["https://cdn.jsdelivr.net"];

    private static JazminFileInput Html(string path, IReadOnlyList<string>? groups = null, JazminPage? page = null) =>
        new(path, Encoding.UTF8.GetBytes($"<p>{path}")) { Groups = groups, Page = page };

    private static List<JazminFileInput> DocumentFiles() =>
    [
        Html("customers.html"), Html("transactions.html"), Html("summary.html"), Html("statement.html"),
        new("app.js", [1]), new("style.css", [2]), new("fonts/a.woff2", [3]), new("fonts/b.woff2", [4]), new("readme.txt", [5]),
    ];

    private static readonly JazminPage[] FourPages =
    [
        new() { Path = "customers.html", Title = "Customers", Table = "clients", Actions = new JazminFileActions { Print = false, Pdf = false } },
        new() { Path = "transactions.html", Title = "Transactions", Table = "transactions" },
        new() { Path = "summary.html", Title = "Summary", Online = JazminOnline.Required },
        new() { Path = "statement.html", Title = "Statement", Pdf = new JazminPdfSettings { Format = "A4", Landscape = true }, Actions = new JazminFileActions { Print = true, Pdf = true, Image = false } },
    ];

    private static JazminPackage Document() => new() { Pages = FourPages, Files = ["app.js", "style.css", "fonts/"], AllowedOrigins = Cdn };

    /// <summary>A file with two tables (clients, transactions); shared (partitioned by client) when grants are given.</summary>
    private static string Write(JazminPackage? package, IReadOnlyList<JazminFileInput>? files = null, JazminKey? owner = null, IReadOnlyList<JazminGrant>? grants = null)
    {
        var file = Path.Combine(Directory.CreateTempSubdirectory("jazmin-pages-").FullName, "statements.jzm");
        var partitionBy = grants is null ? null : "clientId";
        using var writer = JazminWriter.Create(file, new JazminWriteOptions
        {
            Key = owner, Package = package, Files = files ?? DocumentFiles(),
            Access = grants is null ? null : new JazminAccessOptions { Grants = [.. grants] },
            Tables = [new JazminTable("clients", ClientColumns) { PartitionBy = partitionBy }, new JazminTable("transactions", TxColumns) { PartitionBy = partitionBy }],
        });
        for (var c = 1; c <= 3; c++) writer.WriteRow(new Dictionary<string, object?> { ["clientId"] = $"C{c}", ["name"] = $"Client {c}" });
        writer.StartTable("transactions");
        for (var i = 0; i < 9; i++) writer.WriteRow(new Dictionary<string, object?> { ["clientId"] = $"C{i / 3 + 1}", ["amount"] = $"{i}.25" });
        return file;
    }

    private static JazminPackage PackageOf(string file, JazminReadOptions? options = null)
    {
        using var reader = JazminReader.Open(file, options);
        return reader.Package!;
    }

    private static void Refused(Action write, string message) => Assert.Equal(message, Assert.Throws<JazminValidationException>(write).Message);

    [Fact]
    public void Pages_and_the_documents_own_files_round_trip_and_the_entry_is_the_first_page()
    {
        var package = PackageOf(Write(Document()));
        Assert.Equal("customers.html", package.Entry);
        Assert.Equal(FourPages, package.Pages);
        Assert.Equal(["app.js", "style.css", "fonts/"], package.Files);
        Assert.Equal(Cdn, package.AllowedOrigins);

        // An entry given is kept when it is one of the pages.
        Assert.Equal("summary.html", PackageOf(Write(new JazminPackage { Entry = "summary.html", Pages = FourPages, AllowedOrigins = Cdn })).Entry);
        // Settings without pages are as before.
        var plain = PackageOf(Write(new JazminPackage { Entry = "customers.html" }));
        Assert.Equal(("customers.html", null, null), (plain.Entry, plain.Pages, plain.Files));
    }

    [Fact]
    public void The_settings_are_stored_with_the_json_names_the_javascript_library_uses()
    {
        var json = EmbeddedFiles.PackageJson(new JazminPackage
        {
            Pages =
            [
                new() { Path = "a.html", Title = "A", Online = JazminOnline.Optional, Table = "t", Pdf = new JazminPdfSettings { Format = "A4" }, Actions = new JazminFileActions { Print = true, Pdf = false, Image = false } },
                new() { Path = "b.html", Title = "B" },
            ],
            Files = ["app.js", "fonts/"],
            AllowedOrigins = Cdn,
        }, ["a.html", "b.html", "app.js", "fonts/x.woff2"], ["t"])!;
        Assert.Equal("""{"entry":"a.html","allowedOrigins":["https://cdn.jsdelivr.net"],"pages":[{"path":"a.html","title":"A","online":"optional","table":"t","pdf":{"format":"A4"},"actions":{"print":true,"pdf":false,"image":false}},{"path":"b.html","title":"B"}],"files":["app.js","fonts/"]}""",
            json.ToJsonString());
        var page = EmbeddedFiles.DirectoryPageJson(new JazminPage { Title = "Mine", Online = JazminOnline.Required, Table = "t", Actions = new JazminFileActions { Image = true }, Order = 2 },
            "mine.html", ["t"], hasOrigins: true);
        Assert.Equal("""{"title":"Mine","online":"required","table":"t","actions":{"image":true},"order":2}""", page.ToJsonString());
    }

    [Fact]
    public void Writers_refuse_pages_and_files_that_are_not_right()
    {
        static JazminPage P(string path, string? title = "T") => new() { Path = path, Title = title };
        void Package(JazminPackage package, string message) => Refused(() => Write(package), message);

        Package(new JazminPackage { Pages = [P("nope.html")] }, "package.pages[0].path 'nope.html' is not one of the stored files");
        Package(new JazminPackage { Pages = [P("customers.html"), P("summary.html"), P("customers.html")] }, "package.pages: 'customers.html' is listed twice");
        Package(new JazminPackage { Pages = [P("customers.html"), P("summary.html", null)] }, "package.pages[1].title is required");
        Package(new JazminPackage { Pages = [P("customers.html", "")] }, "package.pages[0].title is required");
        Package(new JazminPackage { Entry = "statement.html", Pages = [P("customers.html")] }, "package.entry 'statement.html' is not one of package.pages");
        Package(new JazminPackage { Pages = [P("customers.html") with { Table = "payments" }] }, "package.pages[0].table 'payments' is not a table of the file");
        Package(new JazminPackage { Pages = [P("customers.html") with { Online = JazminOnline.Required }] }, "package.pages[0].online needs allowedOrigins");
        Package(new JazminPackage { Pages = [P("customers.html") with { Pdf = new JazminPdfSettings { Scale = 5 } }] }, "package.pages[0].pdf.scale must be a number from 0.1 to 2");
        Package(new JazminPackage { Pages = [P("customers.html") with { Actions = new JazminFileActions { Save = false } }] }, "package.pages[0].actions: unknown action 'save' (print, pdf, image)");
        Package(new JazminPackage { Pages = [P("customers.html") with { Actions = new JazminFileActions { PdfSettings = new JazminPdfSettings() } }] }, "package.pages[0].actions.pdf must be true or false");
        Package(new JazminPackage { Pages = [P("customers.html") with { Order = 1 }] }, "package.pages[0].order is only for a page in a file group's directory");
        Package(new JazminPackage { Pages = [new JazminPage { Title = "T" }] }, "package.pages[0].path is required");
        Package(new JazminPackage { Pages = [] }, "package.pages must be a non-empty array of pages: { path, title }");
        Package(new JazminPackage { Pages = [null!] }, "package.pages[0] must be a page: { path, title }");

        Package(new JazminPackage { Files = ["app.js", "nope.js"] }, "package.files: 'nope.js' is not one of the stored files");
        Package(new JazminPackage { Files = ["img/"] }, "package.files: no stored file is in the folder 'img/'");
        Package(new JazminPackage { Files = ["fonts/", "app.js", "fonts/"] }, "package.files: 'fonts/' is listed twice");

        // A file's page, in its group's directory: only in shared files, never also in package.pages, checked as pages are.
        var owner = JazminKey.Generate();
        JazminGrant[] grants = [new(owner.CreateAccessKey()) { Rows = ["C1"] }];
        void Page(JazminPage page, string message, JazminPackage? package = null, IReadOnlyList<JazminGrant>? shared = null) =>
            Refused(() => Write(package, [.. DocumentFiles().Where(f => f.Path != "summary.html"), Html("summary.html", ["C1"], page)], owner, shared ?? grants), message);
        var mine = new JazminPage { Title = "Mine" };
        Refused(() => Write(null, [Html("summary.html", page: mine)]), "File 'summary.html': page needs an access-controlled file (use package.pages)");
        Page(mine, "File 'summary.html': its page is also in package.pages", new JazminPackage { Pages = [P("customers.html"), P("summary.html")] });
        Page(new JazminPage(), "File 'summary.html': page.title is required");
        Page(mine with { Table = "payments" }, "File 'summary.html': page.table 'payments' is not a table of the file");
        Page(mine with { Online = JazminOnline.Optional }, "File 'summary.html': page.online needs allowedOrigins");
        Page(mine with { Actions = new JazminFileActions { List = false } }, "File 'summary.html': page.actions: unknown action 'list' (print, pdf, image)");
        Page(mine with { Pdf = new JazminPdfSettings { Format = "B5" } }, "File 'summary.html': page.pdf.format: 'B5' is not one of A0, A1, A2, A3, A4, A5, A6, Letter, Legal, Tabloid, Ledger");
        Page(mine with { Path = "summary.html" }, "File 'summary.html': page.path is not used: the page is the file itself");
    }

    [Fact]
    public void Append_update_and_compact_keep_them_and_new_package_settings_replace_them()
    {
        var file = Write(Document());
        void Kept(string when)
        {
            var package = PackageOf(file);
            Assert.True(FourPages.SequenceEqual(package.Pages!), $"{when}: pages");
            Assert.True(new[] { "app.js", "style.css", "fonts/" }.SequenceEqual(package.Files!), $"{when}: files");
            Assert.Equal("customers.html", package.Entry);
        }
        JazminFile.Append(file, new JazminAppend { Table = "clients", AddFiles = [new JazminFileInput("news.txt", [6])] });
        Kept("appended");
        JazminFile.Update(file, new JazminUpdate { AddFiles = [new JazminFileInput("more.txt", [7])] });
        Kept("updated");
        JazminFile.Compact(file);
        Kept("compacted");

        // A page's table follows a rename; a page's table can't be removed while the page reads it.
        JazminFile.Update(file, new JazminUpdate { RenameTables = new Dictionary<string, string> { ["transactions"] = "tx" } });
        Assert.Equal(["clients", "tx", null, null], PackageOf(file).Pages!.Select(p => p.Table));
        Refused(() => JazminFile.Update(file, new JazminUpdate { RemoveTables = ["tx"] }), "package.pages[1].table 'tx' is not a table of the file");
        // Nor a page's file, or one of the document's own.
        Refused(() => JazminFile.Append(file, new JazminAppend { Table = "clients", RemoveFiles = ["app.js"] }), "package.files: 'app.js' is not one of the stored files");
        Refused(() => JazminFile.Update(file, new JazminUpdate { RemoveFiles = ["summary.html"] }), "package.pages[2].path 'summary.html' is not one of the stored files");

        JazminFile.Update(file, new JazminUpdate { Package = new JazminPackage { Pages = [new() { Path = "statement.html", Title = "Statement" }] } });
        var replaced = PackageOf(file);
        Assert.Equal(("statement.html", null), (replaced.Entry, replaced.Files));
        Assert.Equal([new JazminPage { Path = "statement.html", Title = "Statement" }], replaced.Pages);
    }

    [Fact]
    public void A_page_in_a_file_groups_directory_is_known_only_to_that_groups_keys_and_rewrites_keep_it()
    {
        var owner = JazminKey.Generate();
        var (ann, bob) = (owner.CreateAccessKey(), owner.CreateAccessKey());
        var page = new JazminPage { Title = "Your summary", Table = "transactions", Order = 2, Actions = new JazminFileActions { Print = false } };
        var file = Write(new JazminPackage { Pages = [FourPages[0], FourPages[1]], Files = ["app.js"] },
            [.. DocumentFiles().Where(f => f.Path != "summary.html"), Html("summary.html", ["C1"], page)], owner,
            [new JazminGrant(ann) { Rows = ["C1"] }, new JazminGrant(bob) { Rows = ["C2"] }]);
        JazminPage? PageFor(JazminReadOptions options)
        {
            using var reader = JazminReader.Open(file, options);
            Assert.Null(reader.Files.Single(f => f.Path == "customers.html").Page);
            return reader.Files.SingleOrDefault(f => f.Path == "summary.html")?.Page;
        }
        void Kept(string when, string table = "transactions")
        {
            Assert.True(page with { Table = table } == PageFor(new JazminReadOptions { AccessKey = ann, CheckClockRollback = false }), $"{when}: ann");
            Assert.True(page with { Table = table } == PageFor(new JazminReadOptions { Key = owner }), $"{when}: owner");
            Assert.True(PageFor(new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }) is null, $"{when}: bob doesn't see the file");
            Assert.Equal(["customers.html", "transactions.html"], PackageOf(file, new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }).Pages!.Select(p => p.Path));
        }
        Kept("written");
        JazminFile.Compact(file, owner);
        Kept("compacted");
        JazminFile.Update(file, new JazminUpdate { Key = owner, AddFiles = [new JazminFileInput("news.txt", [6]) { Groups = ["C2"] }] });
        Kept("updated");
        JazminFile.Append(file, new JazminAppend { Key = owner, Table = "clients", AddFiles = [new JazminFileInput("more.txt", [7]) { Groups = ["C1"] }] });
        Kept("appended");
        JazminFile.Update(file, new JazminUpdate { Key = owner, RenameTables = new Dictionary<string, string> { ["transactions"] = "tx" } });
        Kept("renamed", table: "tx");
        // The package's pages no longer read the table, but this page does.
        JazminFile.Update(file, new JazminUpdate { Key = owner, Package = new JazminPackage { Pages = [FourPages[0]] } });
        Refused(() => JazminFile.Update(file, new JazminUpdate { Key = owner, RemoveTables = ["tx"] }), "File 'summary.html': page.table 'tx' is not a table of the file");
    }

    [Fact]
    public void Readers_leave_out_settings_of_the_wrong_type()
    {
        var package = EmbeddedFiles.PackageFrom(JsonNode.Parse("""
            { "pages": [7, null, { "path": 1, "title": "No path" }, { "path": "x.html" },
                        { "path": "a.html", "title": "A", "online": true, "table": 3, "pdf": { "scale": "big" }, "actions": { "print": "yes", "open": true, "image": false }, "order": 1 },
                        { "path": "b.html", "title": "B", "online": "optional", "table": "t", "actions": { "pdf": { "format": "A4" } } }],
              "files": ["app.js", 3, null, "fonts/"] }
            """))!;
        Assert.Equal(
        [
            new JazminPage { Path = "a.html", Title = "A", Pdf = new JazminPdfSettings(), Actions = new JazminFileActions { Image = false } },
            new JazminPage { Path = "b.html", Title = "B", Online = JazminOnline.Optional, Table = "t" },
        ], package.Pages);
        Assert.Equal(["app.js", "fonts/"], package.Files);
        var wrong = EmbeddedFiles.PackageFrom(JsonNode.Parse("""{ "entry": "a.html", "pages": { "path": "a.html" }, "files": "app.js" }"""))!;
        Assert.Equal(("a.html", null, null), (wrong.Entry, wrong.Pages, wrong.Files));

        Assert.Null(EmbeddedFiles.PageFrom(JsonNode.Parse("""{ "order": 1 }"""), directory: true));
        Assert.Null(EmbeddedFiles.PageFrom(JsonNode.Parse("[]"), directory: true));
        Assert.Equal(new JazminPage { Title = "Mine" }, EmbeddedFiles.PageFrom(JsonNode.Parse("""{ "title": "Mine", "path": "x.html", "order": "first", "online": "sometimes" }"""), directory: true));
        Assert.Equal(new JazminPage { Title = "Mine", Order = 3 }, EmbeddedFiles.PageFrom(JsonNode.Parse("""{ "title": "Mine", "order": 3 }"""), directory: true));
    }
}
