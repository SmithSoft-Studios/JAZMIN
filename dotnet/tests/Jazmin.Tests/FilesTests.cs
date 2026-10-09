using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace Jazmin.Tests;

public class FilesTests
{
    private static readonly JazminColumn[] Columns = { new("id", JazminType.Int), new("group", JazminType.String) };
    private static readonly byte[] Big = RandomNumberGenerator.GetBytes(700 * 1024); // 3 blocks, incompressible

    private static IEnumerable<object?[]> Rows() =>
        new[] { "A", "B", "C", "D", "E" }.SelectMany((g, k) => Enumerable.Range(0, 20).Select(i => new object?[] { (long)(k * 100 + i), g }));

    private static byte[] Write(JazminWriteOptions options)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            foreach (var row in Rows()) writer.WriteValues(row);
        return stream.ToArray();
    }

    private static string Text(byte[] bytes) => Encoding.UTF8.GetString(bytes);

    [Fact]
    public void Files_RoundTrip_Whole_ByRange_AndAsAStream()
    {
        var dir = Directory.CreateTempSubdirectory("jazmin-files-").FullName;
        File.WriteAllBytes(Path.Combine(dir, "logo.png"), Big);
        var key = JazminKey.Generate();
        var bytes = Write(new JazminWriteOptions
        {
            Key = key,
            Files =
            [
                new JazminFileInput("index.html", Encoding.UTF8.GetBytes("<h1>Hi</h1>")),
                JazminFileInput.FromFile("img/logo.png", Path.Combine(dir, "logo.png")),
                new JazminFileInput("empty.txt", []),
                new JazminFileInput("data.bin", [1, 2, 3]) { Type = "application/x-custom" },
            ],
            Package = new JazminPackage { Entry = "index.html", Title = "Demo", AllowedOrigins = ["https://api.example.com"] },
        });
        using var r = JazminReader.Open(bytes, new JazminReadOptions { Key = key });
        Assert.Equal(new[] { ("data.bin", "application/x-custom", 3L), ("empty.txt", "text/plain", 0L), ("img/logo.png", "image/png", (long)Big.Length), ("index.html", "text/html", 11L) },
            r.Files.Select(f => (f.Path, f.Type, f.Size)).OrderBy(f => f.Path, StringComparer.Ordinal));
        Assert.Equal(Convert.ToHexString(SHA256.HashData(Big)).ToLowerInvariant(), r.Files.Single(f => f.Path == "img/logo.png").Sha256);
        Assert.Equal(new[] { "*" }, r.Files[0].Groups);
        Assert.Equal("<h1>Hi</h1>", Text(r.ReadFile("index.html")));
        Assert.Equal(Big, r.ReadFile("img/logo.png"));
        Assert.Empty(r.ReadFile("empty.txt"));
        Assert.Equal(Big[262_000..263_000], r.ReadFileRange("img/logo.png", 262_000, 263_000)); // across a block boundary
        using (var stream = r.OpenFile("img/logo.png"))
        {
            var copy = new MemoryStream();
            stream.CopyTo(copy);
            Assert.Equal(Big, copy.ToArray());
            stream.Position = 600_000;
            var tail = new byte[10];
            stream.ReadExactly(tail);
            Assert.Equal(Big[600_000..600_010], tail);
        }
        Assert.Equal("index.html", r.Package!.Entry);
        Assert.Equal(new[] { "https://api.example.com" }, r.Package.AllowedOrigins);
        Assert.Equal(100, r.RowCount);
        Assert.Throws<JazminValidationException>(() => r.ReadFile("missing.txt"));
    }

    [Fact]
    public void IdenticalContent_IsStoredOnce_AndAPathCannotBeAddedTwice()
    {
        var one = Write(new JazminWriteOptions { Files = [new JazminFileInput("a.bin", Big)] });
        var three = Write(new JazminWriteOptions { Files = [new JazminFileInput("a.bin", Big), new JazminFileInput("copy/b.bin", Big), new JazminFileInput("c.bin", Big.ToArray())] });
        Assert.True(three.Length - one.Length < 1024, $"{three.Length - one.Length} extra bytes");
        using (var r = JazminReader.Open(three)) Assert.Equal(Big, r.ReadFile("copy/b.bin"));
        Assert.Throws<JazminValidationException>(() => Write(new JazminWriteOptions { Files = [new JazminFileInput("x", [1]), new JazminFileInput("x", [2])] }));
    }

    [Fact]
    public void DataOnlyFiles_AreUnchanged_PathsAndPackage_AreValidated()
    {
        using (var plain = JazminReader.Open(Write(new JazminWriteOptions())))
        {
            Assert.Empty(plain.Files);
            Assert.Null(plain.Package);
        }
        foreach (var bad in new[] { "../x", "/abs", "a//b", "a\\b", "./x", "" })
            Assert.Throws<JazminValidationException>(() => Write(new JazminWriteOptions { Files = [new JazminFileInput(bad, [1])] }));
        Assert.Throws<JazminValidationException>(() => Write(new JazminWriteOptions { Files = [new JazminFileInput("a", [1])], Package = new JazminPackage { Entry = "b" } }));
        Assert.Throws<JazminValidationException>(() => Write(new JazminWriteOptions { Files = [new JazminFileInput("a", [1])], Package = new JazminPackage { AllowedOrigins = ["http://x.com"] } }));
    }

    private sealed record AccessScenario(JazminKey Owner, Dictionary<string, JazminAccessKey> Keys, byte[] Shared, byte[] File);

    /// <summary>The example from the design: shared, partly shared and group-only files.</summary>
    private static AccessScenario AccessFile()
    {
        var owner = JazminKey.Generate();
        var keys = new[] { "a", "b", "d", "e", "all", "tpl" }.ToDictionary(n => n, _ => owner.CreateAccessKey());
        var shared = RandomNumberGenerator.GetBytes(5000);
        var file = Write(new JazminWriteOptions
        {
            Key = owner,
            SortedBy = ["group", "id"],
            Files =
            [
                new JazminFileInput("index.html", Encoding.UTF8.GetBytes("<main>everyone</main>")),
                new JazminFileInput("appendix.html", Encoding.UTF8.GetBytes("A and B")) { Groups = ["A", "B"] },
                new JazminFileInput("img/logoD.png", Encoding.UTF8.GetBytes("D only")) { Groups = ["D"] },
                new JazminFileInput("docs/terms.pdf", shared) { Groups = ["A", "B", "C", "D"] },
                new JazminFileInput("docs/terms-copy.pdf", shared) { Groups = ["template"] },
            ],
            Access = new JazminAccessOptions
            {
                PartitionBy = "group",
                Grants =
                [
                    new JazminGrant(keys["a"]) { Rows = ["A"] }, new JazminGrant(keys["b"]) { Rows = ["B"] }, new JazminGrant(keys["d"]) { Rows = ["D"] },
                    new JazminGrant(keys["e"]) { Rows = ["E"] }, new JazminGrant(keys["all"]), new JazminGrant(keys["tpl"]) { Rows = ["C"], Files = ["template"] },
                ],
            },
        });
        return new AccessScenario(owner, keys, shared, file);
    }

    private static string[] Visible(byte[] file, JazminAccessKey key)
    {
        using var r = JazminReader.Open(file, new JazminReadOptions { AccessKey = key, CheckClockRollback = false });
        return r.Files.Select(f => f.Path).Order(StringComparer.Ordinal).ToArray();
    }

    [Fact]
    public void AccessControlledFiles_EachKeySeesExactlyItsGroupsFiles()
    {
        var s = AccessFile();
        Assert.Equal(new[] { "appendix.html", "docs/terms.pdf", "index.html" }, Visible(s.File, s.Keys["a"]));
        Assert.Equal(new[] { "appendix.html", "docs/terms.pdf", "index.html" }, Visible(s.File, s.Keys["b"]));
        Assert.Equal(new[] { "docs/terms.pdf", "img/logoD.png", "index.html" }, Visible(s.File, s.Keys["d"]));
        Assert.Equal(new[] { "index.html" }, Visible(s.File, s.Keys["e"]));
        Assert.Equal(new[] { "appendix.html", "docs/terms.pdf", "img/logoD.png", "index.html" }, Visible(s.File, s.Keys["all"]));
        Assert.Equal(new[] { "docs/terms-copy.pdf", "docs/terms.pdf", "index.html" }, Visible(s.File, s.Keys["tpl"]));

        using (var d = JazminReader.Open(s.File, new JazminReadOptions { AccessKey = s.Keys["d"], CheckClockRollback = false }))
        {
            Assert.Equal("D only", Text(d.ReadFile("img/logoD.png")));
            Assert.Equal(s.Shared, d.ReadFile("docs/terms.pdf"));
            Assert.Throws<JazminValidationException>(() => d.ReadFile("appendix.html"));
            Assert.Null(d.Files.Single(f => f.Path == "index.html").Groups);
        }
        using var o = JazminReader.Open(s.File, new JazminReadOptions { Key = s.Owner });
        var groups = o.Files.ToDictionary(f => f.Path, f => string.Join(",", f.Groups!));
        Assert.Equal("A,B", groups["appendix.html"]);
        Assert.Equal("A,B,C,D", groups["docs/terms.pdf"]);
        Assert.Equal("template", groups["docs/terms-copy.pdf"]);
        Assert.Equal("D", groups["img/logoD.png"]);
        Assert.Equal("*", groups["index.html"]);
    }

    [Fact]
    public void Append_AddsReplacesRemoves_ReusesContent_CompactDropsUnused()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-files-").FullName, "f.jzm");
        var key = JazminKey.Generate();
        File.WriteAllBytes(path, Write(new JazminWriteOptions
        {
            Key = key,
            Files = [new JazminFileInput("keep.txt", Encoding.UTF8.GetBytes("keep")), new JazminFileInput("big.bin", Big), new JazminFileInput("old.txt", Encoding.UTF8.GetBytes("v1"))],
        }));
        var before = new FileInfo(path).Length;
        JazminFile.Append(path, new JazminAppend
        {
            Key = key,
            AddFiles = [new JazminFileInput("big-copy.bin", Big), new JazminFileInput("old.txt", Encoding.UTF8.GetBytes("v2"))],
            RemoveFiles = ["keep.txt"],
        });
        Assert.True(new FileInfo(path).Length - before < 10_000, "an identical file is referenced, not stored again");
        using (var r = JazminReader.Open(path, new JazminReadOptions { Key = key }))
        {
            Assert.Equal(new[] { "big-copy.bin", "big.bin", "old.txt" }, r.Files.Select(f => f.Path).Order(StringComparer.Ordinal));
            Assert.Equal("v2", Text(r.ReadFile("old.txt")));
            Assert.Equal(Big, r.ReadFile("big-copy.bin"));
        }
        Assert.Throws<JazminValidationException>(() => JazminFile.Append(path, new JazminAppend { Key = key, RemoveFiles = ["nope"] }));

        JazminFile.Append(path, new JazminAppend { Key = key, RemoveFiles = ["big.bin", "big-copy.bin"] });
        var grown = new FileInfo(path).Length;
        JazminFile.Compact(path, key);
        Assert.True(new FileInfo(path).Length < grown - Big.Length / 2, "compaction dropped the unreferenced content");
        using var after = JazminReader.Open(path, new JazminReadOptions { Key = key });
        Assert.Equal(new[] { "old.txt" }, after.Files.Select(f => f.Path));
        Assert.Equal(100, after.RowCount);
    }

    [Fact]
    public void FileActions_AreChecked_WhenWritten_AndKept_ByAppendUpdateAndCompact()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-files-").FullName, "f.jzm");
        var key = JazminKey.Generate();
        var pdf = new JazminPdfSettings { Format = "A5", Landscape = true, Margin = new JazminPdfMargin { Top = "1cm" }, PreferCssPageSize = true };
        var statement = new JazminFileActions { PdfSettings = pdf, Image = false };
        var data = new JazminFileActions { Open = false, Save = false };
        File.WriteAllBytes(path, Write(new JazminWriteOptions
        {
            Key = key,
            Files =
            [
                new JazminFileInput("index.html", Encoding.UTF8.GetBytes("<p>statement</p>")) { Actions = statement },
                new JazminFileInput("data.csv", Encoding.UTF8.GetBytes("a,b")) { Actions = data },
                new JazminFileInput("plain.txt", Encoding.UTF8.GetBytes("p")),
            ],
            Package = new JazminPackage { Entry = "index.html", Pdf = new JazminPdfSettings { Format = "Letter", Scale = 0.9, PrintBackground = false } },
        }));
        Dictionary<string, JazminFileActions?> ActionsOf()
        {
            using var r = JazminReader.Open(path, new JazminReadOptions { Key = key });
            return r.Files.ToDictionary(f => f.Path, f => f.Actions);
        }
        Assert.Equal(new Dictionary<string, JazminFileActions?> { ["index.html"] = statement, ["data.csv"] = data, ["plain.txt"] = null }, ActionsOf());
        using (var r = JazminReader.Open(path, new JazminReadOptions { Key = key }))
            Assert.Equal(new JazminPdfSettings { Format = "Letter", Scale = 0.9, PrintBackground = false }, r.Package!.Pdf);

        JazminFile.Append(path, new JazminAppend { Key = key, AddFiles = [new JazminFileInput("more.txt", [1]) { Actions = new JazminFileActions { Print = false } }] });
        JazminFile.Update(path, new JazminUpdate { Key = key, RemoveFiles = ["plain.txt"] });
        JazminFile.Compact(path, key);
        Assert.Equal(new Dictionary<string, JazminFileActions?> { ["index.html"] = statement, ["data.csv"] = data, ["more.txt"] = new JazminFileActions { Print = false } }, ActionsOf());
        using (var r = JazminReader.Open(path, new JazminReadOptions { Key = key }))
            Assert.Equal("Letter", r.Package!.Pdf!.Format);

        byte[] With(JazminFileActions actions) => Write(new JazminWriteOptions { Files = [new JazminFileInput("a.html", [1]) { Actions = actions }] });
        JazminFileActions? Stored(JazminFileActions actions)
        {
            using var r = JazminReader.Open(With(actions), new JazminReadOptions());
            return r.Files[0].Actions;
        }
        Assert.Null(Stored(new JazminFileActions()));
        Assert.Equal(new JazminFileActions { Pdf = false, Print = true }, Stored(new JazminFileActions { Pdf = false, Print = true }));
        Assert.Contains("actions.pdf.format: 'B5' is not one of", Assert.Throws<JazminValidationException>(() => With(new JazminFileActions { PdfSettings = new JazminPdfSettings { Format = "B5" } })).Message);
        Assert.Contains("a length such as 12mm", Assert.Throws<JazminValidationException>(() => With(new JazminFileActions { PdfSettings = new JazminPdfSettings { Margin = new JazminPdfMargin { Left = "12" } } })).Message);
        Assert.Contains("Pdf is false but PdfSettings", Assert.Throws<JazminValidationException>(() => With(new JazminFileActions { Pdf = false, PdfSettings = new JazminPdfSettings() })).Message);
        Assert.Contains("package.pdf.scale", Assert.Throws<JazminValidationException>(() => Write(new JazminWriteOptions
        {
            Files = [new JazminFileInput("a.html", [1])],
            Package = new JazminPackage { Pdf = new JazminPdfSettings { Scale = 3 } },
        })).Message);
    }

    [Fact]
    public void UpdateAndCompact_KeepFilesAndTheirGroups()
    {
        var s = AccessFile();
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-files-").FullName, "f.jzm");
        File.WriteAllBytes(path, s.File);
        JazminFile.Update(path, new JazminUpdate
        {
            Key = s.Owner,
            AddFiles = [new JazminFileInput("news.html", Encoding.UTF8.GetBytes("B news")) { Groups = ["B"] }],
            RemoveFiles = ["docs/terms-copy.pdf"],
        });
        Assert.Equal(new[] { "appendix.html", "docs/terms.pdf", "index.html", "news.html" }, Visible(File.ReadAllBytes(path), s.Keys["b"]));
        Assert.Equal(new[] { "docs/terms.pdf", "index.html" }, Visible(File.ReadAllBytes(path), s.Keys["tpl"]));
        JazminFile.Compact(path, s.Owner);
        Assert.Equal(new[] { "docs/terms.pdf", "img/logoD.png", "index.html" }, Visible(File.ReadAllBytes(path), s.Keys["d"]));
        JazminFile.Append(path, new JazminAppend { Key = s.Owner, AddFiles = [new JazminFileInput("d2.txt", Encoding.UTF8.GetBytes("more D")) { Groups = ["D"] }] });
        using var d = JazminReader.Open(File.ReadAllBytes(path), new JazminReadOptions { AccessKey = s.Keys["d"], CheckClockRollback = false });
        Assert.Equal("more D", Text(d.ReadFile("d2.txt")));
        Assert.Equal("D only", Text(d.ReadFile("img/logoD.png")));
    }
}
