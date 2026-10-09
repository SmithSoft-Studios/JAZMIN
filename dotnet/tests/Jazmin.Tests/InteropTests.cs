using Jazmin.Formats;
using System.Globalization;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Reads the files written by the JavaScript library (spec/fixtures/js-*.jzm) and writes
/// dotnet-*.jzm for the JavaScript tests to read, all checked against spec/fixtures/dataset.json.
/// </summary>
public class InteropTests
{
    private static readonly string Dir = FindFixtures();

    /// <summary>
    /// Where the dotnet-*.jzm files are written. Only when JAZMIN_WRITE_FIXTURES=1 (as in CI, or when
    /// regenerating fixtures after a format change) do they replace the shared files that the
    /// JavaScript tests read; otherwise a temp folder is used, so local test runs leave the repo clean.
    /// </summary>
    private static readonly string OutDir = Environment.GetEnvironmentVariable("JAZMIN_WRITE_FIXTURES") == "1"
        ? Dir
        : Directory.CreateTempSubdirectory("jazmin-fixtures-").FullName;
    private static readonly JsonObject Dataset = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "dataset.json")))!.AsObject();
    private static readonly JsonObject Keys = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "keys.json")))!.AsObject();

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures");
            if (File.Exists(Path.Combine(candidate, "dataset.json"))) return candidate;
        }
        throw new InvalidOperationException("spec/fixtures/dataset.json not found - run `node scripts/make-fixtures.js` in js/");
    }

    private static List<JazminColumn> DatasetColumns() => Dataset["columns"]!.AsArray().Select(c => new JazminColumn(
        (string)c!["name"]!, TypeNames.Parse((string)c["type"]!))
    {
        Nullable = (bool?)c["nullable"] ?? true,
        Description = (string?)c["description"],
        Attributes = c["attributes"]?.DeepClone().AsObject(),
        Indexes = c["index"]?.AsArray().Select(k => TypeNames.ParseIndex((string)k!)!.Value).ToArray() ?? Array.Empty<JazminIndexKind>(),
    }).ToList();

    private static List<JsonObject> DatasetRows() => Dataset["rows"]!.AsArray().Select(r => r!.AsObject()).ToList();

    /// <summary>Appended fixtures: rows [0, AppendSplit) written, the rest appended, then ids &lt; 10 deleted.</summary>
    private const int AppendSplit = 400;

    /// <summary>
    /// *-many-partitions-access.jzm: rows [0, 100) written partitioned by id (more partitions than the header lists, so a
    /// partition table), then rows up to 120 appended (a delta) and ids &lt; 10 deleted.
    /// </summary>
    private static readonly (int Written, int Total) PartitionsSplit = (100, 120);

    private static bool AppendedLive(JsonObject r) => long.Parse((string)r["id"]!, CultureInfo.InvariantCulture) >= 10;

    /// <summary>Dataset rows a fixture should contain.</summary>
    private static List<JsonObject> LiveRows(string file) =>
        file.Contains("-many-partitions") ? DatasetRows().Take(PartitionsSplit.Total).Where(AppendedLive).ToList()
        : file.Contains("-appended") ? DatasetRows().Where(AppendedLive).ToList()
        : DatasetRows();

    /// <summary>Canonical text of a dataset cell (int as string, datetime ISO, binary base64...).</summary>
    private static string Canonical(JazminType type, JsonNode? node) => node is null ? "<null>" : type switch
    {
        JazminType.Float => ((double)node).ToString("R", CultureInfo.InvariantCulture),
        JazminType.Bool => (bool)node ? "true" : "false",
        JazminType.Json => node.ToJsonString(),
        JazminType.DateTime => DateTime.Parse((string)node!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal).ToString("O"),
        _ => (string)node!,
    };

    private static string Canonical(JazminType type, object? value) => value switch
    {
        null => "<null>",
        double d => d.ToString("R", CultureInfo.InvariantCulture),
        bool b => b ? "true" : "false",
        JsonNode n => n.ToJsonString(),
        DateTime dt => dt.ToString("O"),
        byte[] bytes => Convert.ToBase64String(bytes),
        long l => l.ToString(CultureInfo.InvariantCulture),
        _ => (string)value,
    };

    private static object? FromDataset(JazminType type, JsonNode? node) => node is null ? null : type switch
    {
        JazminType.Int => long.Parse((string)node!, CultureInfo.InvariantCulture),
        JazminType.Float => (double)node,
        JazminType.Bool => (bool)node,
        JazminType.DateTime => DateTime.Parse((string)node!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal),
        JazminType.Binary => Convert.FromBase64String((string)node!),
        JazminType.Json => node.DeepClone(),
        _ => (string)node!,
    };

    private static JazminReadOptions OptionsFor(string file) =>
        file.EndsWith("-key.jzm") ? new JazminReadOptions { Key = JazminKey.Parse((string)Keys["key"]!) }
        : file.EndsWith("-password.jzm") ? new JazminReadOptions { Password = (string)Keys["password"]! }
        : new JazminReadOptions();

    private static void AssertMatchesDataset(string file, string? dir = null)
    {
        using var reader = JazminReader.Open(Path.Combine(dir ?? Dir, file), OptionsFor(file));
        var columns = DatasetColumns();
        Assert.Equal(columns.Select(c => (c.Name, c.Type)), reader.Columns.Select(c => (c.Name, c.Type)));
        Assert.True(JsonNode.DeepEquals(Dataset["metadata"], reader.Metadata));

        var expected = LiveRows(file);
        var actual = reader.Rows().ToList();
        Assert.Equal(expected.Count, actual.Count);
        for (var r = 0; r < expected.Count; r++)
            foreach (var c in columns)
                Assert.Equal(Canonical(c.Type, expected[r][c.Name]), Canonical(c.Type, actual[r][c.Name]));

        void ExpectIds(JazminFilter filter, Func<JsonObject, bool> predicate) => Assert.Equal(
            expected.Where(predicate).Select(x => (string)x["id"]!),
            reader.Find(filter).Select(x => ((long)x["id"]!).ToString(CultureInfo.InvariantCulture)));

        ExpectIds(JazminFilter.Eq("country", "BW"), x => (string?)x["country"] == "BW");
        ExpectIds(JazminFilter.IContains("name", "johnson"), x => ((string?)x["name"])?.Contains("johnson", StringComparison.OrdinalIgnoreCase) == true);
        ExpectIds(JazminFilter.Gte("joined", "2015-03-01T00:00:00.000Z") & JazminFilter.Lt("joined", "2015-03-05T00:00:00.000Z"),
            x => x["joined"] is not null && string.CompareOrdinal((string)x["joined"]!, "2015-03-01T00:00:00.000Z") >= 0
                 && string.CompareOrdinal((string)x["joined"]!, "2015-03-05T00:00:00.000Z") < 0);
        ExpectIds(JazminFilter.Gt("id", "9007199254740992"), x => long.Parse((string)x["id"]!, CultureInfo.InvariantCulture) > 9007199254740992L);
        ExpectIds(JazminFilter.Eq("active", true) & JazminFilter.Gt("score", 50.0),
            x => (bool?)x["active"] == true && x["score"] is not null && (double)x["score"]! > 50);
        if (!file.Contains("-appended"))
        {
            // The shared export shape gives the same output from files written by either library.
            var shape = JazminShape.Parse(File.ReadAllText(Path.Combine(Dir, "shape.json")));
            var expectedShape = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "shape-expected.json")));
            var actualShape = JsonNode.Parse(shape.ToJson(reader));
            Assert.True(JsonNode.DeepEquals(expectedShape, actualShape), actualShape!.ToJsonString());
        }
        if (file.Contains("-paged"))
        {
            // A prefix lookup and a null lookup across the pages of paged indexes.
            ExpectIds(JazminFilter.StartsWith("name", "Person 1"), x => ((string?)x["name"])?.StartsWith("Person 1", StringComparison.Ordinal) == true);
            ExpectIds(JazminFilter.IsNull("country"), x => x["country"] is null);
        }
    }

    private static JazminAccessOptions AccessFixture() => new()
    {
        PartitionBy = "country",
        ColumnGroups = new() { ["pii"] = ["balance", "blob"] },
        Grants =
        [
            new JazminGrant(JazminAccessKey.Parse((string)Keys["bob"]!)) { Rows = ["ZA"], Columns = ["*"], Label = "Bob" },
            new JazminGrant(JazminAccessKey.Parse((string)Keys["sally"]!)) { Rows = ["BW", "NA"], Label = "Sally" },
            new JazminGrant(JazminAccessKey.Parse((string)Keys["carol"]!)) { Columns = ["*"], Label = "Carol", Mode = JazminGrantMode.Online, Expires = FixtureExpiry },
            new JazminGrant(JazminAccessKey.Parse((string)Keys["erin"]!)) { Columns = ["*"], Label = "Erin", Expires = FixtureExpiry },
        ],
    };

    private static readonly DateTimeOffset FixtureExpiry = new(2099, 1, 1, 0, 0, 0, TimeSpan.Zero);

    /// <summary>Access options for *-many-partitions-access.jzm (mirrored in js/test/fixture-helpers.js).</summary>
    private static JazminAccessOptions PartitionsFixture() => new()
    {
        PartitionBy = "id",
        ColumnGroups = new() { ["pii"] = ["balance", "blob"] },
        Grants =
        [
            new JazminGrant(JazminAccessKey.Parse((string)Keys["bob"]!)) { Rows = ["7", "42", "105"], Columns = ["*"], Label = "Bob" },
            new JazminGrant(JazminAccessKey.Parse((string)Keys["sally"]!)) { Label = "Sally" },
        ],
    };

    // ---- embedded files, mirrored from js/test/fixture-helpers.js --------------------------------------

    private static List<JazminFileInput> FixtureFiles()
    {
        var pattern = Enumerable.Range(0, 600_000).Select(i => (byte)((i * 31 + 7) & 255)).ToArray();
        return
        [
            new JazminFileInput("index.html", System.Text.Encoding.UTF8.GetBytes("<h1>JAZMIN interop</h1>")),
            new JazminFileInput("docs/za.bin", pattern) { Groups = ["ZA"] },
            new JazminFileInput("docs/shared.bin", pattern) { Groups = ["BW", "NA"] },
            new JazminFileInput("img/logo.svg", System.Text.Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")) { Groups = ["template"] },
            new JazminFileInput("empty.txt", []),
        ];
    }

    // A document (format 1.4): what viewers may do with its files, and page settings for its PDFs. Mirrored from
    // DOCUMENT_FILES and DOCUMENT_PACKAGE in js/test/fixture-helpers.js.
    private static List<JazminFileInput> DocumentFiles() =>
    [
        new JazminFileInput("index.html", System.Text.Encoding.UTF8.GetBytes("<h1>JAZMIN interop document</h1>"))
        {
            Actions = new JazminFileActions { Print = false, PdfSettings = new JazminPdfSettings { Format = "A5", Margin = new JazminPdfMargin { Top = "12mm" } } },
        },
        new JazminFileInput("data.csv", System.Text.Encoding.UTF8.GetBytes("a,b\n1,2\n")) { Actions = new JazminFileActions { Open = false, Save = false } },
        new JazminFileInput("logo.svg", System.Text.Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")),
    ];

    private static readonly JazminPackage DocumentPackage = new()
    {
        Entry = "index.html", Title = "Document", Pdf = new JazminPdfSettings { Format = "Letter", Landscape = true, Scale = 0.9 },
    };

    private static void AssertDocument(string path)
    {
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = JazminKey.Parse((string)Keys["key"]!) });
        var expected = DocumentFiles();
        Assert.Equal(expected.ToDictionary(f => f.Path, f => f.Actions), reader.Files.ToDictionary(f => f.Path, f => f.Actions));
        foreach (var f in expected) Assert.Equal(f.Content, reader.ReadFile(f.Path));
        Assert.Equal(DocumentPackage.Entry, reader.Package!.Entry);
        Assert.Equal(DocumentPackage.Title, reader.Package.Title);
        Assert.Equal(DocumentPackage.Pdf, reader.Package.Pdf);
    }

    [Fact]
    public void ReadsADocumentsFileActionsWrittenByJavaScript() => AssertDocument(Path.Combine(Dir, "js-document-key.jzm"));

    // ---- change files (spec 7.9), mirrored from EDIT_* in js/test/fixture-helpers.js ------------------------------

    private static readonly JazminColumn[] EditColumns =
    [
        new("claim", JazminType.String) { Nullable = false }, new("region", JazminType.String) { Nullable = false }, new("status", JazminType.String),
        new("amount", JazminType.Decimal), new("due", JazminType.DateTime), new("note", JazminType.String),
    ];

    private static Dictionary<string, object?> EditRow(string claim, string region, string? status, string? amount, DateTime? due, string? note) =>
        new() { ["claim"] = claim, ["region"] = region, ["status"] = status, ["amount"] = amount, ["due"] = due, ["note"] = note };

    private static readonly Dictionary<string, object?>[] EditRows =
    [
        EditRow("C-1", "A", "open", "100.50", new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc), null),
        EditRow("C-2", "A", "open", "20.00", null, "call back"),
        EditRow("C-3", "B", "closed", "7.25", null, null),
    ];

    private static readonly JazminEditSettings EditSettings = new() { Key = ["claim"], Columns = ["region", "status", "amount", "due", "note"], Add = true, Delete = true };

    private static readonly Dictionary<string, object?>[] EditAfter =
    [
        EditRow("C-1", "A", "paid", "99.95", new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc), null),
        EditRow("C-3", "B", "closed", "7.25", null, null),
        EditRow("C-9", "B", "new", null, null, "from the document"),
    ];

    private static void AssertChangesApply(string source, string change)
    {
        var key = JazminKey.Parse((string)Keys["key"]!);
        var copy = Path.Combine(Directory.CreateTempSubdirectory("jazmin-edit-").FullName, "edit.jzm");
        File.Copy(source, copy);
        var result = JazminFile.ApplyChanges(copy, File.ReadAllBytes(change), new JazminApplyChangesOptions { Key = key });
        Assert.Equal((null, false, 1L, 1L, 1L, 0, 0), (result.Sender, result.FileChanged, result.Updated, result.Added, result.Deleted, result.Conflicts.Count, result.Refused.Count));
        using var after = JazminReader.Open(copy, new JazminReadOptions { Key = key });
        var rows = after.Rows().OrderBy(r => (string)r["claim"]!, StringComparer.Ordinal).ToList();
        Assert.Equal(EditAfter.Length, rows.Count);
        for (var i = 0; i < rows.Count; i++)
            foreach (var (name, value) in EditAfter[i])
                Assert.True(Equals(value, rows[i][name] is DateTime d ? d.ToUniversalTime() : rows[i][name]), $"{EditAfter[i]["claim"]}.{name}: {rows[i][name]} != {value}");
    }

    [Fact]
    public void AppliesChangeFilesWrittenByJavaScript() => AssertChangesApply(Path.Combine(Dir, "js-edit-key.jzm"), Path.Combine(Dir, "js-edit-changes.jzm"));

    [Fact]
    public void WritesChangeFilesForJavaScript()
    {
        var key = JazminKey.Parse((string)Keys["key"]!);
        var source = Path.Combine(OutDir, "dotnet-edit-key.jzm");
        using (var writer = JazminWriter.Create(source, EditColumns, new JazminWriteOptions
        {
            Key = key,
            Files = [new JazminFileInput("index.html", System.Text.Encoding.UTF8.GetBytes("<h1>Claims</h1>"))],
            Package = new JazminPackage { Entry = "index.html", Edit = EditSettings },
        }))
        {
            foreach (var row in EditRows) writer.WriteRow(row);
        }
        using (var reader = JazminReader.Open(source, new JazminReadOptions { Key = key }))
        {
            var change = JazminFile.WriteChanges(reader, new JazminChanges
            {
                Update = [new Dictionary<string, object?> { ["claim"] = "C-1", ["status"] = "paid", ["amount"] = "99.95", ["due"] = new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc) }],
                Add = [new Dictionary<string, object?> { ["claim"] = "C-9", ["region"] = "B", ["status"] = "new", ["note"] = "from the document" }],
                Delete = [new Dictionary<string, object?> { ["claim"] = "C-2" }],
            }, key);
            File.WriteAllBytes(Path.Combine(OutDir, "dotnet-edit-changes.jzm"), change);
        }
        AssertChangesApply(source, Path.Combine(OutDir, "dotnet-edit-changes.jzm"));
    }

    [Fact]
    public void WritesADocumentsFileActionsForJavaScript()
    {
        const string file = "dotnet-document-key.jzm";
        var columns = DatasetColumns();
        using (var writer = JazminWriter.Create(Path.Combine(OutDir, file), columns, new JazminWriteOptions
        {
            ChunkRows = 64,
            Metadata = Dataset["metadata"]!.DeepClone().AsObject(),
            Key = JazminKey.Parse((string)Keys["key"]!),
            Files = DocumentFiles(),
            Package = DocumentPackage,
        }))
        {
            foreach (var row in DatasetRows())
                writer.WriteValues(columns.Select(c => FromDataset(c.Type, row[c.Name])).ToArray());
        }
        AssertMatchesDataset(file, OutDir);
        AssertDocument(Path.Combine(OutDir, file));
    }

    private static readonly Dictionary<string, string[]> FilesViews = new()
    {
        ["key"] = ["docs/shared.bin", "docs/za.bin", "empty.txt", "img/logo.svg", "index.html"],
        ["bob"] = ["docs/za.bin", "empty.txt", "img/logo.svg", "index.html"],
        ["sally"] = ["docs/shared.bin", "empty.txt", "index.html"],
        ["carol"] = ["docs/shared.bin", "docs/za.bin", "empty.txt", "index.html"],
        ["erin"] = ["docs/shared.bin", "docs/za.bin", "empty.txt", "index.html"],
    };

    private static JazminAccessOptions FilesAccessFixture()
    {
        var access = AccessFixture();
        var bob = access.Grants[0];
        access.Grants[0] = new JazminGrant(bob.Key) { Rows = bob.Rows, Columns = bob.Columns, Label = bob.Label, Files = ["template"] };
        return access;
    }

    private static void AssertFilesViews(string file, string? dir, bool accessControlled)
    {
        var path = Path.Combine(dir ?? Dir, file);
        var expected = FixtureFiles().ToDictionary(f => f.Path, f => f.Content!);
        var owner = JazminKey.Parse((string)Keys["key"]!);
        foreach (var (name, paths) in FilesViews.Where(v => accessControlled || v.Key == "key"))
        {
            var options = name == "key" ? new JazminReadOptions { Key = owner } : new JazminReadOptions { AccessKey = JazminAccessKey.Parse((string)Keys[name]!), CheckClockRollback = false };
            if (name == "carol") options.UnlockToken = JazminFile.IssueUnlockToken(path, owner, options.AccessKey!.Id);
            using var reader = JazminReader.Open(path, options);
            Assert.Equal(paths, reader.Files.Select(f => f.Path).Order(StringComparer.Ordinal));
            foreach (var p in paths) Assert.Equal(expected[p], reader.ReadFile(p));
            Assert.Equal("index.html", reader.Package!.Entry);
            Assert.Equal("Interop", reader.Package.Title);
        }
    }

    [Theory]
    [InlineData("js-files-key.jzm", false)]
    [InlineData("js-files-access.jzm", true)]
    public void ReadsEmbeddedFilesWrittenByJavaScript(string file, bool accessControlled) => AssertFilesViews(file, null, accessControlled);

    /// <summary>Embedded files written by the browser writer (js/browser): the same files, and no package settings.</summary>
    [Fact]
    public void ReadsEmbeddedFilesWrittenInTheBrowser()
    {
        const string file = "browser-files-key.jzm";
        AssertMatchesDataset(file);
        var expected = FixtureFiles().ToDictionary(f => f.Path, f => f.Content!);
        using var reader = JazminReader.Open(Path.Combine(Dir, file), new JazminReadOptions { Key = JazminKey.Parse((string)Keys["key"]!) });
        Assert.Equal(FilesViews["key"], reader.Files.Select(f => f.Path).Order(StringComparer.Ordinal));
        foreach (var p in FilesViews["key"]) Assert.Equal(expected[p], reader.ReadFile(p));
        Assert.Null(reader.Package);
    }

    [Theory]
    [InlineData("dotnet-files-key.jzm", false)]
    [InlineData("dotnet-files-access.jzm", true)]
    public void WritesEmbeddedFilesForJavaScript(string file, bool accessControlled)
    {
        var columns = DatasetColumns();
        using (var writer = JazminWriter.Create(Path.Combine(OutDir, file), columns, new JazminWriteOptions
        {
            ChunkRows = 64,
            Metadata = Dataset["metadata"]!.DeepClone().AsObject(),
            Key = JazminKey.Parse((string)Keys["key"]!),
            Access = accessControlled ? FilesAccessFixture() : null,
            ChunkMap = false, // written as before the owner chunk map (spec 7.6.5), so readers keep reading such files
            Files = FixtureFiles(),
            Package = new JazminPackage { Entry = "index.html", Title = "Interop" },
        }))
        {
            foreach (var row in DatasetRows())
                writer.WriteValues(columns.Select(c => FromDataset(c.Type, row[c.Name])).ToArray());
        }
        if (accessControlled) AssertAccessViews(file, OutDir);
        else AssertMatchesDataset(file, OutDir);
        AssertFilesViews(file, OutDir, accessControlled);
    }

    /// <summary>
    /// The owner's chunk map (spec 7.6.5): written by either library, read by both; older files without one read as
    /// before. Owner lookups by id find the rows either way.
    /// </summary>
    [Theory]
    [InlineData("js-access.jzm", true)]
    [InlineData("js-appended-access.jzm", true)]
    [InlineData("js-many-partitions-access.jzm", true)]
    [InlineData("js-tables-access.jzm", true)]
    [InlineData("js-files-access.jzm", false)]
    [InlineData("dotnet-access.jzm", true)]
    [InlineData("dotnet-appended-access.jzm", true)]
    [InlineData("dotnet-many-partitions-access.jzm", true)]
    [InlineData("dotnet-tables-access.jzm", true)]
    [InlineData("dotnet-files-access.jzm", false)]
    public void Owner_chunk_maps_are_read_across_libraries(string file, bool hasMap)
    {
        var owner = JazminKey.Parse((string)Keys["key"]!);
        var path = Path.Combine(Dir, file);
        List<JazminRow> all;
        using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = owner }))
        {
            var map = reader.AppendState().ChunkMap;
            Assert.Equal(hasMap, map is not null);
            if (map is not null) Assert.Equal(reader.ChunkCount, map.Chunks);
            all = reader.Rows().ToList();
        }
        foreach (var id in new[] { (long)all[0]["id"]!, (long)all[all.Count / 2]["id"]!, (long)all[^1]["id"]!, -1L })
        {
            using var reader = JazminReader.Open(path, new JazminReadOptions { Key = owner });
            Assert.Equal(all.Where(r => (long)r["id"]! == id).Select(r => r.RowId), reader.Find(JazminFilter.Eq("id", id)).Select(r => r.RowId));
        }
    }

    /// <summary>Opens an access fixture with each key and checks it shows exactly that key's grant.</summary>
    private static void AssertAccessViews(string file, string? dir = null)
    {
        var owner = JazminKey.Parse((string)Keys["key"]!);
        var carol = JazminAccessKey.Parse((string)Keys["carol"]!);
        var views = file.Contains("-many-partitions")
            ? new (JazminReadOptions Options, Func<JsonObject, bool> Visible, string[] Hidden)[]
            {
                (new() { Key = owner }, _ => true, []),
                (new() { AccessKey = JazminAccessKey.Parse((string)Keys["bob"]!) }, r => (string)r["id"]! is "7" or "42" or "105", ["balance", "blob"]),
                (new() { AccessKey = JazminAccessKey.Parse((string)Keys["sally"]!) }, _ => true, []),
            }
            : new (JazminReadOptions Options, Func<JsonObject, bool> Visible, string[] Hidden)[]
            {
                (new() { Key = owner }, _ => true, []),
                (new() { AccessKey = JazminAccessKey.Parse((string)Keys["bob"]!) }, r => (string?)r["country"] == "ZA", ["balance", "blob"]),
                (new() { AccessKey = JazminAccessKey.Parse((string)Keys["sally"]!) }, r => (string?)r["country"] is "BW" or "NA", []),
                (new() { AccessKey = carol, UnlockToken = JazminFile.IssueUnlockToken(Path.Combine(dir ?? Dir, file), owner, carol.Id), CheckClockRollback = false },
                    _ => true, ["balance", "blob"]),
                (new() { AccessKey = JazminAccessKey.Parse((string)Keys["erin"]!), CheckClockRollback = false }, _ => true, ["balance", "blob"]),
            };
        foreach (var (options, visible, hidden) in views)
        {
            using var reader = JazminReader.Open(Path.Combine(dir ?? Dir, file), options);
            if (options.AccessKey is { } accessKey && (accessKey.Id == carol.Id || options.CheckClockRollback == false))
            {
                Assert.Equal(accessKey.Id == carol.Id, reader.Access!.Online);
                Assert.Equal(FixtureExpiry, reader.Access.Expires);
            }
            var columns = DatasetColumns().Where(c => !hidden.Contains(c.Name)).ToList();
            Assert.Equal(columns.Select(c => c.Name), reader.Columns.Select(c => c.Name));
            var live = LiveRows(file);
            var expected = live.Where(visible).ToList();
            var actual = reader.Rows().ToList();
            Assert.Equal(expected.Count, actual.Count);
            for (var r = 0; r < expected.Count; r++)
                foreach (var c in columns)
                    Assert.Equal(Canonical(c.Type, expected[r][c.Name]), Canonical(c.Type, actual[r][c.Name]));
            Assert.Equal(live.Count - expected.Count, reader.HiddenRowCount);
        }
    }

    [Theory]
    [InlineData("js-access.jzm")]
    [InlineData("js-many-partitions-access.jzm")]
    public void ReadsAccessControlledFileWrittenByJavaScript(string file) => AssertAccessViews(file);

    [Fact]
    public void WritesAccessControlledFileForJavaScript()
    {
        const string file = "dotnet-access.jzm";
        var columns = DatasetColumns();
        using (var writer = JazminWriter.Create(Path.Combine(OutDir, file), columns, new JazminWriteOptions
        {
            ChunkRows = 64,
            KeySlotPageBytes = 300, // key slots in small pages (spec 7.6.4), so readers of either library find slots across pages
            Metadata = Dataset["metadata"]!.DeepClone().AsObject(),
            Key = JazminKey.Parse((string)Keys["key"]!),
            Access = AccessFixture(),
        }))
        {
            foreach (var row in DatasetRows())
                writer.WriteValues(columns.Select(c => FromDataset(c.Type, row[c.Name])).ToArray());
        }
        AssertAccessViews(file, OutDir);
    }

    [Fact]
    public void ReadsAppendedFilesWrittenByJavaScript()
    {
        AssertMatchesDataset("js-appended.jzm");
        AssertAccessViews("js-appended-access.jzm");
    }

    [Theory]
    [InlineData("dotnet-appended.jzm", false)]
    [InlineData("dotnet-appended-access.jzm", true)]
    [InlineData("dotnet-many-partitions-access.jzm", true)]
    public void WritesAppendedFilesForJavaScript(string file, bool accessControlled)
    {
        var columns = DatasetColumns();
        var key = accessControlled ? JazminKey.Parse((string)Keys["key"]!) : null;
        var manyPartitions = file.Contains("-many-partitions");
        var (written, total) = manyPartitions ? PartitionsSplit : (AppendSplit, DatasetRows().Count);
        var rows = DatasetRows().Take(total).Select(row => columns.Select(c => FromDataset(c.Type, row[c.Name])).ToArray()).ToList();
        var path = Path.Combine(OutDir, file);
        using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions
        {
            ChunkRows = 64,
            Metadata = Dataset["metadata"]!.DeepClone().AsObject(),
            Key = key,
            Access = !accessControlled ? null : manyPartitions ? PartitionsFixture() : AccessFixture(),
        }))
        {
            foreach (var values in rows.Take(written)) writer.WriteValues(values);
        }
        JazminFile.Append(path, new JazminAppend
        {
            Key = key,
            ChunkRows = 64,
            Insert = rows.Skip(written).Select(v => (IReadOnlyDictionary<string, object?>)columns.Select((c, i) => (c.Name, v[i])).ToDictionary(x => x.Name, x => x.Item2)).ToList(),
            Delete = JazminFilter.Lt("id", 10),
        });
        if (accessControlled) AssertAccessViews(file, OutDir);
        else AssertMatchesDataset(file, OutDir);
    }

    // ---- several tables (D-3), mirrored from js/test/fixture-helpers.js ----------------------------------

    private static readonly JazminColumn[] CountryColumns =
    [
        new("country", JazminType.String) { Indexes = [JazminIndexKind.Sorted] }, new("people", JazminType.Int), new("firstId", JazminType.Int),
    ];

    /// <summary>The second table of *-tables*.jzm: one row per country of the dataset, sorted by country.</summary>
    private static List<object?[]> CountryRows() => DatasetRows()
        .Where(r => r["country"] is not null)
        .GroupBy(r => (string)r["country"]!)
        .OrderBy(g => g.Key, StringComparer.Ordinal)
        .Select(g => new object?[] { g.Key, (long)g.Count(), long.Parse((string)g.First()["id"]!, CultureInfo.InvariantCulture) })
        .ToList();

    private static JazminWriteOptions TablesFixture(bool accessControlled)
    {
        var access = accessControlled ? AccessFixture() : null;
        return new JazminWriteOptions
        {
            ChunkRows = 64,
            Metadata = Dataset["metadata"]!.DeepClone().AsObject(),
            Key = accessControlled ? JazminKey.Parse((string)Keys["key"]!) : null,
            Access = access is null ? null : new JazminAccessOptions { Grants = access.Grants },
            Tables =
            [
                new JazminTable("people", DatasetColumns()) { PartitionBy = access?.PartitionBy, ColumnGroups = access?.ColumnGroups ?? new() },
                new JazminTable("countries", CountryColumns) { SortedBy = ["country"], PartitionBy = access?.PartitionBy },
            ],
        };
    }

    /// <summary>The first table is the dataset (checked like the other fixtures); the second, read with each key, shows its countries.</summary>
    private static void AssertTablesViews(string file, string? dir, bool accessControlled)
    {
        var path = Path.Combine(dir ?? Dir, file);
        if (accessControlled) AssertAccessViews(file, dir);
        else AssertMatchesDataset(file, dir);
        var owner = JazminKey.Parse((string)Keys["key"]!);
        JazminReadOptions As(string key) => new() { AccessKey = JazminAccessKey.Parse((string)Keys[key]!), CheckClockRollback = false };
        var views = accessControlled
            ? new (JazminReadOptions Options, Func<string, bool> Visible)[]
            {
                (new() { Key = owner }, _ => true), (As("bob"), c => c == "ZA"), (As("sally"), c => c is "BW" or "NA"), (As("erin"), _ => true),
            }
            : [(new JazminReadOptions(), _ => true)];
        foreach (var (options, visible) in views)
        {
            using var people = JazminReader.Open(path, options);
            using var countries = people.OpenTable("countries");
            Assert.Equal(["people", "countries"], people.Tables);
            Assert.Equal(CountryColumns.Select(c => c.Name), countries.Columns.Select(c => c.Name));
            var expected = CountryRows().Where(r => visible((string)r[0]!)).Select(r => string.Join("|", r.Select(v => Canonical(JazminType.String, v)))).ToList();
            Assert.Equal(expected, countries.Rows().Select(r => string.Join("|", CountryColumns.Select(c => Canonical(c.Type, r[c.Name])))));
        }
        if (!accessControlled)
        {
            // A shape linking the two tables gives the same output from files written by either library.
            using var people = JazminReader.Open(path);
            var shape = JazminShape.Parse(File.ReadAllText(Path.Combine(Dir, "shape-links.json")));
            var expectedLinks = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "shape-links-expected.json")));
            var actualLinks = JsonNode.Parse(shape.ToJson(people));
            Assert.True(JsonNode.DeepEquals(expectedLinks, actualLinks), actualLinks!.ToJsonString());
        }
    }

    [Theory]
    [InlineData("js-tables.jzm", false)]
    [InlineData("js-tables-access.jzm", true)]
    public void ReadsTablesWrittenByJavaScript(string file, bool accessControlled) => AssertTablesViews(file, null, accessControlled);

    [Theory]
    [InlineData("dotnet-tables.jzm", false)]
    [InlineData("dotnet-tables-access.jzm", true)]
    public void WritesTablesForJavaScript(string file, bool accessControlled)
    {
        var columns = DatasetColumns();
        using (var writer = JazminWriter.Create(Path.Combine(OutDir, file), TablesFixture(accessControlled)))
        {
            foreach (var row in DatasetRows())
                writer.WriteValues(columns.Select(c => FromDataset(c.Type, row[c.Name])).ToArray());
            writer.StartTable("countries");
            foreach (var row in CountryRows()) writer.WriteValues(row);
        }
        AssertTablesViews(file, OutDir, accessControlled);
    }

    [Theory]
    [InlineData("js-plain.jzm")]
    [InlineData("js-brotli.jzm")]
    [InlineData("js-key.jzm")]
    [InlineData("js-password.jzm")]
    [InlineData("js-paged-key.jzm")]
    [InlineData("js-paged-compact.jzm")] // sorted index keys as differences (reader feature 'index-deltas')
    [InlineData("browser-plain.jzm")] // written by the browser writer (js/browser), without indexes
    [InlineData("browser-key.jzm")]
    [InlineData("browser-password.jzm")]
    public void ReadsFilesWrittenByJavaScript(string file) => AssertMatchesDataset(file);

    /// <summary>
    /// Sorted indexes in many small pages (spec 8.1), read back by the JavaScript tests; the compact one has keys and
    /// first row ids as differences (reader feature 'index-deltas').
    /// </summary>
    [Theory]
    [InlineData("dotnet-paged-key.jzm", false)]
    [InlineData("dotnet-paged-compact.jzm", true)]
    public void WritesPagedIndexFixtureForJavaScript(string file, bool compact)
    {
        var columns = DatasetColumns();
        var options = new JazminWriteOptions
        {
            ChunkRows = 64,
            Metadata = Dataset["metadata"]!.DeepClone().AsObject(),
            Key = compact ? null : JazminKey.Parse((string)Keys["key"]!),
            IndexPageBytes = 512,
            CompactIndexes = compact,
        };
        using (var writer = JazminWriter.Create(Path.Combine(OutDir, file), columns, options))
        {
            foreach (var row in DatasetRows())
                writer.WriteValues(columns.Select(c => FromDataset(c.Type, row[c.Name])).ToArray());
        }
        AssertMatchesDataset(file, OutDir);
    }

    [Theory]
    [InlineData("dotnet-plain.jzm", JazminCodec.Deflate, false, false)]
    [InlineData("dotnet-brotli.jzm", JazminCodec.Brotli, false, false)]
    [InlineData("dotnet-key.jzm", JazminCodec.Deflate, true, false)]
    [InlineData("dotnet-password.jzm", JazminCodec.Deflate, false, true)]
    public void WritesFilesForJavaScript(string file, JazminCodec codec, bool useKey, bool usePassword)
    {
        var columns = DatasetColumns();
        var options = new JazminWriteOptions
        {
            Codec = codec,
            ChunkRows = 64,
            Metadata = Dataset["metadata"]!.DeepClone().AsObject(),
            Key = useKey ? JazminKey.Parse((string)Keys["key"]!) : null,
            Password = usePassword ? (string)Keys["password"]! : null,
            KdfIterations = (int)Keys["kdfIterations"]!,
        };
        using (var writer = JazminWriter.Create(Path.Combine(OutDir, file), columns, options))
        {
            foreach (var row in DatasetRows())
                writer.WriteValues(columns.Select(c => FromDataset(c.Type, row[c.Name])).ToArray());
        }
        AssertMatchesDataset(file, OutDir);
    }

    // ---- nested columns (spec 5.4): spec/fixtures/nested.json, in the form JSON output writes its rows ----

    private static readonly JsonObject NestedFixture = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "nested.json")))!.AsObject();

    private static JazminColumn NestedDefinition(JsonNode c, string name) => new((string?)c["name"] ?? name, TypeNames.Parse((string)c["type"]!))
    {
        Nullable = (bool?)c["nullable"] ?? true,
        Item = c["item"] is { } item ? NestedDefinition(item, "item") : null,
        Fields = c["fields"]?.AsArray().Select(f => NestedDefinition(f!, "")).ToArray(),
    };

    private static void AssertNested(byte[] bytes)
    {
        var rows = NestedFixture["rows"]!;
        var actual = JsonNode.Parse(JazminConvert.ToJson(bytes));
        Assert.True(JsonNode.DeepEquals(rows, actual), "JSON output differs from nested.json");
        foreach (var id in new[] { 0, 37, 149 })
            Assert.True(JsonNode.DeepEquals(new JsonArray(rows[id]!.DeepClone()), JsonNode.Parse(JazminConvert.ToJson(bytes, null, JazminFilter.Eq("id", (long)id)))), $"row {id}");
    }

    [Fact]
    public void ReadsNestedColumnsWrittenByJavaScript() => AssertNested(File.ReadAllBytes(Path.Combine(Dir, "js-nested.jzm")));

    [Fact]
    public void WritesNestedColumnsForJavaScript()
    {
        var columns = NestedFixture["columns"]!.AsArray().Select(c => NestedDefinition(c!, "")).ToArray();
        var path = Path.Combine(OutDir, "dotnet-nested.jzm");
        using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions { ChunkRows = 64 }))
            foreach (var row in NestedFixture["rows"]!.AsArray())
                writer.WriteValues(columns.Select(c => c.Type == JazminType.Int ? (object?)(long)row![c.Name]! : row![c.Name]?.DeepClone()).ToArray());
        AssertNested(File.ReadAllBytes(path));
    }

    // ---- nested columns given fields by appending (spec 5.4): *-nested-grown.jzm ----

    private const int NestedGrownSplit = 100; // rows before it were written without the fields added later

    /// <summary>The nested columns without their last fields (staff items' projects, head's at), as first written.</summary>
    private static JazminColumn[] NestedColumnsBefore() => NestedFixture["columns"]!.AsArray().Select(c =>
    {
        var column = NestedDefinition(c!, "");
        if (column.Name == "staff")
        {
            var item = column.Item!;
            return JazminColumn.ListOf("staff", new JazminColumn("item", item.Type) { Nullable = item.Nullable, Fields = item.Fields!.Take(item.Fields!.Count - 1).ToArray() });
        }
        return column.Name == "head" ? new JazminColumn("head", column.Type) { Nullable = column.Nullable, Fields = column.Fields!.Take(column.Fields!.Count - 1).ToArray() } : column;
    }).ToArray();

    /// <summary>A nested.json row without the fields added later, or (as read back) with them null.</summary>
    private static JsonObject NestedRowBefore(JsonNode row, bool asRead)
    {
        var copy = row.DeepClone().AsObject();
        void Strip(JsonObject? o, string name)
        {
            if (o is null) return;
            o.Remove(name);
            if (asRead) o[name] = null;
        }
        if (copy["staff"] is JsonArray staff) foreach (var item in staff) Strip(item as JsonObject, "projects");
        Strip(copy["head"] as JsonObject, "at");
        return copy;
    }

    private static void AssertNestedGrown(byte[] bytes)
    {
        var expected = new JsonArray(NestedFixture["rows"]!.AsArray().Select(r => (JsonNode?)((long)r!["id"]! < NestedGrownSplit ? NestedRowBefore(r, true) : r.DeepClone())).ToArray());
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(JazminConvert.ToJson(bytes))), "JSON output differs");
        foreach (var id in new[] { 0, 99, 100, 149 })
            Assert.True(JsonNode.DeepEquals(new JsonArray(expected[id]!.DeepClone()), JsonNode.Parse(JazminConvert.ToJson(bytes, null, JazminFilter.Eq("id", (long)id)))), $"row {id}");
    }

    [Fact]
    public void ReadsNestedColumnsGrownByJavaScript() => AssertNestedGrown(File.ReadAllBytes(Path.Combine(Dir, "js-nested-grown.jzm")));

    [Fact]
    public void WritesNestedColumnsGrownForJavaScript()
    {
        var before = NestedColumnsBefore();
        var full = NestedFixture["columns"]!.AsArray().Select(c => NestedDefinition(c!, "")).ToArray();
        var rows = NestedFixture["rows"]!.AsArray();
        var path = Path.Combine(OutDir, "dotnet-nested-grown.jzm");
        object? Value(JazminColumn c, JsonNode row) => c.Type == JazminType.Int ? (object?)(long)row[c.Name]! : row[c.Name]?.DeepClone();
        using (var writer = JazminWriter.Create(path, before, new JazminWriteOptions { ChunkRows = 64 }))
            foreach (var row in rows.Take(NestedGrownSplit))
                writer.WriteValues(before.Select(c => Value(c, NestedRowBefore(row!, false))).ToArray());
        JazminFile.Append(path, new JazminAppend
        {
            Insert = [.. rows.Skip(NestedGrownSplit).Select(row => (IReadOnlyDictionary<string, object?>)full.ToDictionary(c => c.Name, c => Value(c, row!)))],
            Columns = [.. full.Where(c => c.Name is "staff" or "head")],
            ChunkRows = 64,
        });
        AssertNestedGrown(File.ReadAllBytes(path));
    }

    /// <summary>Filters on nested columns (spec 9.2), with the ids each selects in nested.json: the same from either writer's file.</summary>
    [Theory]
    [InlineData("js-nested.jzm")]
    [InlineData("dotnet-nested.jzm")]
    public void FiltersOnNestedColumns_SelectTheRowsTheFixtureLists(string file)
    {
        var path = Path.Combine(Dir, file);
        if (!File.Exists(path)) return; // dotnet-nested.jzm: written by WritesNestedColumnsForJavaScript
        using var reader = JazminReader.Open(path);
        foreach (var item in JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "nested-filters.json")))!.AsArray())
        {
            var filter = JazminFilter.Parse(item!["filter"]!.ToJsonString());
            var ids = item["ids"]!.AsArray().Select(x => (long)x!).ToList();
            Assert.True(ids.SequenceEqual(reader.Find(filter).Select(r => (long)r["id"]!)), item["filter"]!.ToJsonString());
            Assert.Equal(ids.Count, reader.Count(filter));
        }
    }
}
