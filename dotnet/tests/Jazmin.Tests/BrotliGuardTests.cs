using System.Text;
using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Brotli and CVE-2026-111497 (a flaw in the Brotli decoder, October 2026): change files and submissions, which people
/// the owner doesn't control write and JAZMIN never writes with Brotli, are refused if they use it, before anything is
/// decompressed. Mirrors js/test/brotli-guard.test.js.
/// </summary>
public sealed class BrotliGuardTests
{
    private static string Temp() => Directory.CreateTempSubdirectory("jazmin-brotli-").FullName;

    // Patched runtimes (Microsoft's advisory, dotnet/announcements#494): 10.0.14, and 11.0.0-rc.3 for .NET 11 previews,
    // which all report Environment.Version 11.0.0: only the framework description tells them apart.
    [Theory]
    [InlineData("10.0.13", ".NET 10.0.13", false)]
    [InlineData("10.0.14", ".NET 10.0.14", true)]
    [InlineData("10.0.15", ".NET 10.0.15", true)]
    [InlineData("11.0.0", ".NET 11.0.0-preview.7.26404.104", false)]
    [InlineData("11.0.0", ".NET 11.0.0-rc.1.26451.101", false)]
    [InlineData("11.0.0", ".NET 11.0.0-rc.2.26478.121", false)]
    [InlineData("11.0.0", ".NET 11.0.0-rc.3.26522.148", true)]
    [InlineData("11.0.0", ".NET 11.0.0", true)]
    [InlineData("12.0.0", ".NET 12.0.0-preview.1.27050.101", true)]
    public void Brotli_decoder_requires_the_patched_dotnet_runtime(string version, string description, bool expected) =>
        Assert.Equal(expected, SectionCodec.HasPatchedBrotliDecoder(Version.Parse(version), description));

    [Fact]
    public void Brotli_sections_are_refused_until_the_runtime_is_patched()
    {
        var columns = new[] { new JazminColumn("note", JazminType.String) };
        var rows = Enumerable.Range(0, 200).Select(i => new object?[] { $"{i}: {string.Concat(Enumerable.Repeat("a Brotli section ", 20))}" });
        var bytes = TestData.Write(columns, rows, new JazminWriteOptions { Codec = JazminCodec.Brotli });
        using var reader = JazminReader.Open(bytes);

        if (SectionCodec.HasPatchedBrotliDecoder(Environment.Version, System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription))
            Assert.Equal(200, reader.Rows().Count());
        else
            Assert.Contains("10.0.14", Assert.Throws<JazminValidationException>(() => reader.Rows().ToList()).Message, StringComparison.Ordinal);
    }

    /// <summary>The same file written again with Brotli: its rows, columns and metadata as they are.</summary>
    private static byte[] WithBrotli(byte[] file, JazminKey key)
    {
        using var reader = JazminReader.Open(file, new JazminReadOptions { Key = key });
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, reader.Columns, new JazminWriteOptions { Key = key, Metadata = reader.Metadata, Codec = JazminCodec.Brotli }, leaveOpen: true))
            foreach (var row in reader.Rows()) writer.WriteRow(row);
        return stream.ToArray();
    }

    [Fact]
    public void ApplyChanges_refuses_a_change_file_with_Brotli_sections()
    {
        var path = Path.Combine(Temp(), "claims.jzm");
        var key = JazminKey.Generate();
        JazminColumn[] columns = [new("claim", JazminType.String) { Nullable = false }, new("status", JazminType.String)];
        using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions
        {
            Key = key, Files = [new JazminFileInput("index.html", Encoding.UTF8.GetBytes("<p>claims</p>"))],
            Package = new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Key = ["claim"], Columns = ["status"] } },
        }))
            writer.WriteRow(new Dictionary<string, object?> { ["claim"] = "C-1", ["status"] = "open" });
        byte[] change;
        using (var source = JazminReader.Open(path, new JazminReadOptions { Key = key }))
            change = JazminFile.WriteChanges(source, new JazminChanges { Update = [new Dictionary<string, object?> { ["claim"] = "C-1", ["status"] = "paid" }] }, key);
        var brotli = WithBrotli(change, key);
        var error = Assert.Throws<JazminFormatException>(() => JazminFile.ApplyChanges(path, brotli, new JazminApplyChangesOptions { Key = key, DryRun = true }));
        Assert.Contains("Brotli", error.Message, StringComparison.Ordinal);
        Assert.Equal(1, JazminFile.ApplyChanges(path, change, new JazminApplyChangesOptions { Key = key }).Updated); // as JAZMIN writes it (deflate)
    }

    [Fact]
    public void FileSubmission_refuses_a_batch_with_Brotli_sections()
    {
        var shared = Path.Combine(Temp(), "shared.jzm");
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        JazminColumn[] visits = [new("id", JazminType.String) { Nullable = false }, new("person", JazminType.String), new("note", JazminType.String)];
        using (var writer = JazminWriter.Create(shared, visits, new JazminWriteOptions
        {
            Key = owner, Access = new JazminAccessOptions { PartitionBy = "person", Grants = [new JazminGrant(bob) { Rows = ["P1"] }] },
        }))
            writer.WriteRow(new Dictionary<string, object?> { ["id"] = "seed", ["person"] = "P1", ["note"] = "first" });
        // Enough rows that compressing pays: a section that doesn't get smaller is stored as is, whatever the codec.
        byte[] Batch(JazminCodec codec)
        {
            using var stream = new MemoryStream();
            using (var writer = new JazminWriter(stream, visits, new JazminWriteOptions { Key = owner.SubmissionKey(bob.Id), Codec = codec }, leaveOpen: true))
                for (var i = 0; i < 200; i++)
                    writer.WriteRow(new Dictionary<string, object?> { ["id"] = $"b{i}", ["person"] = "P1", ["note"] = string.Concat(Enumerable.Repeat("a visit to the site, all well ", 4)) });
            return stream.ToArray();
        }
        var brotli = Batch(JazminCodec.Brotli);
        Assert.True(brotli.AsSpan().IndexOf((ReadOnlySpan<byte>)[2, 1, 0, 0]) >= 0, "the batch has a Brotli section (codec 2, encrypted)");
        var error = Assert.ThrowsAny<JazminException>(() => JazminFile.FileSubmission(shared, brotli, new JazminFileSubmissionOptions { Key = owner, KeyId = bob.Id, DryRun = true }));
        Assert.Contains("Brotli", error.Message, StringComparison.Ordinal);
        Assert.Equal(200, JazminFile.FileSubmission(shared, Batch(JazminCodec.Deflate), new JazminFileSubmissionOptions { Key = owner, KeyId = bob.Id }).Filed);
    }
}
