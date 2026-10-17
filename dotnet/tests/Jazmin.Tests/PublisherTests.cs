using System.Buffers.Binary;
using System.Globalization;
using System.Text.Json.Nodes;
using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// VerifyPublisher (spec 6.9.8): every vector in spec/fixtures/publisher gives the result expected.json names, verified
/// with the test trust (its root, the arc 2.999.1, its time) and its revocation list, without a key and with each key.
/// </summary>
public sealed class PublisherTests : IDisposable
{
    private static readonly string Dir = FindFixtures();
    private static readonly JsonObject Expected = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "expected.json")))!.AsObject();
    private static readonly JazminPublisherTrust Trust = new(
        Expected["trustedRoots"]!.AsArray().Select(p => File.ReadAllBytes(Path.Combine(Dir, (string)p!))).ToList(),
        "2.999.1",
        DateTimeOffset.Parse((string)Expected["verifyAt"]!, CultureInfo.InvariantCulture));
    private static readonly string RevocationList = File.ReadAllText(Path.Combine(Dir, (string)Expected["revocationList"]!)).Trim();
    private readonly string _temp = Directory.CreateTempSubdirectory("jazmin-publisher-").FullName;

    public void Dispose() => Directory.Delete(_temp, true);

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures", "publisher");
            if (File.Exists(Path.Combine(candidate, "expected.json"))) return candidate;
        }
        throw new InvalidOperationException("spec/fixtures/publisher not found");
    }

    public static IEnumerable<object[]> Files() => Expected["fixtures"]!.AsArray().Select(f => new object[] { (string)f!["file"]! });

    private static JsonObject Fixture(string file) => Expected["fixtures"]!.AsArray().Single(f => (string)f!["file"]! == file)!.AsObject();

    private static JazminPublisherResult Verify(string file, JazminPublisherOptions? options = null)
    {
        options ??= new JazminPublisherOptions();
        options.RevocationList ??= RevocationList;
        return JazminFile.VerifyPublisher(Path.Combine(Dir, file), options, Trust);
    }

    /// <summary>The result as expected.json writes it (the JavaScript library's form: times to the second).</summary>
    private static JsonObject Json(JazminPublisherResult r)
    {
        static string? Iso(DateTimeOffset? t) => t?.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        return new JsonObject
        {
            ["status"] = r.Status == JazminPublisherStatus.NotVerified ? "not-verified" : r.Status.ToString().ToLowerInvariant(),
            ["name"] = r.Name, ["organization"] = r.Organization, ["registration"] = r.Registration, ["country"] = r.Country,
            ["domain"] = r.Domain, ["kind"] = r.Kind, ["code"] = r.Code, ["documentKind"] = r.DocumentKind, ["credential"] = r.Credential,
            ["signedAt"] = Iso(r.SignedAt), ["timestamp"] = Iso(r.Timestamp),
            ["cosigners"] = new JsonArray(r.Cosigners.Select(c => (JsonNode)new JsonObject
            {
                ["name"] = c.Name, ["organization"] = c.Organization, ["registration"] = c.Registration, ["country"] = c.Country,
                ["domain"] = c.Domain, ["kind"] = c.Kind,
            }).ToArray()),
            ["facts"] = r.Facts is null ? null : new JsonObject(r.Facts.Select(f => KeyValuePair.Create(f.Key, (JsonNode?)f.Value))),
            ["factsNeedKey"] = r.FactsNeedKey,
            ["statusAnswer"] = r.StatusAnswer is null ? null : new JsonObject { ["status"] = r.StatusAnswer.Status, ["from"] = Iso(r.StatusAnswer.From) },
            ["checkedAt"] = Iso(r.CheckedAt),
            ["reason"] = r.Reason,
        };
    }

    /// <summary>Every field the expected result has; a result that isn't certified, withdrawn or superseded shows nothing else.</summary>
    private static void AssertSame(JsonObject want, JazminPublisherResult result, string label)
    {
        var got = Json(result);
        foreach (var (name, value) in want)
            Assert.True(JsonNode.DeepEquals(got[name], value), $"{label}: {name} is {got[name]?.ToJsonString() ?? "null"}, expected {value?.ToJsonString() ?? "null"}");
        if (result.Status is JazminPublisherStatus.Certified or JazminPublisherStatus.Withdrawn or JazminPublisherStatus.Superseded) return;
        Assert.True(result is { Organization: null, Registration: null, Country: null, Domain: null, DocumentKind: null, Credential: null, SignedAt: null,
            Timestamp: null, Cosigners.Count: 0, FactsNeedKey: false, StatusAnswer: null, CheckedAt: null }, $"{label}: shows more than its status");
    }

    [Theory]
    [MemberData(nameof(Files))]
    public void Each_vector_gives_the_expected_result_without_a_key_and_with_each_of_its_keys(string file)
    {
        var fixture = Fixture(file);
        var want = fixture["result"]!.AsObject();
        var noKey = want.DeepClone().AsObject();
        if ((bool?)want["factsNeedKey"] == true) noKey["facts"] = null;
        AssertSame(noKey, Verify(file), $"{file}, no key");
        foreach (var (kind, value) in fixture["keys"]!.AsObject())
        {
            var text = (string)value!;
            var options = kind switch
            {
                "password" => new JazminPublisherOptions { Password = text },
                "key" or "ownerKey" => new JazminPublisherOptions { Key = JazminKey.Parse(text) },
                "accessKey" => new JazminPublisherOptions { AccessKey = JazminAccessKey.Parse(text) },
                _ => throw new InvalidOperationException(kind),
            };
            AssertSame(want, Verify(file, options), $"{file}, with the {kind}");
        }
    }

    [Fact]
    public void A_key_that_does_not_read_the_file_leaves_the_facts_out()
    {
        var result = Verify("signed-password.jzm", new JazminPublisherOptions { Password = "not the password" });
        Assert.Equal(JazminPublisherStatus.Certified, result.Status);
        Assert.Null(result.Facts);
        Assert.True(result.FactsNeedKey);
        Assert.Null(Verify("signed-cosigned.jzm", new JazminPublisherOptions { Key = JazminKey.Generate() }).Facts);
    }

    [Fact]
    public void An_online_status_answer_for_the_apps_nonce_is_used_and_one_for_another_nonce_is_not()
    {
        var asked = Expected["statusAnswers"]!.AsArray()[0]!;
        var file = (string)asked["for"]!;
        var answer = File.ReadAllText(Path.Combine(Dir, (string)asked["file"]!)).Trim();
        var time = DateTimeOffset.Parse((string)asked["time"]!, CultureInfo.InvariantCulture);
        var without = Verify(file);
        Assert.Equal(JazminPublisherStatus.Certified, without.Status);
        Assert.True(without.CheckedAt < time); // the stored status and the revocation list are older

        var online = Verify(file, new JazminPublisherOptions { StatusAnswer = new JazminStatusAnswer(answer, (string)asked["nonce"]!) });
        Assert.Equal(JazminPublisherStatus.Certified, online.Status);
        Assert.Equal(time, online.CheckedAt);

        var otherNonce = Verify(file, new JazminPublisherOptions { StatusAnswer = new JazminStatusAnswer(answer, Base64Url.Encode(new byte[16])) });
        Assert.Equal(Json(without).ToJsonString(), Json(otherNonce).ToJsonString());
    }

    [Fact]
    public void The_public_overloads_trust_only_the_built_in_roots()
    {
        // None yet: a file the test root certifies shows as signed by an unknown key, with nothing from its certificate.
        var signed = JazminFile.VerifyPublisher(Path.Combine(Dir, "signed-plain.jzm"));
        AssertSame(Fixture("untrusted-root.jzm")["result"]!.AsObject(), signed, "signed-plain.jzm, built-in trust");
        Assert.Equal(JazminPublisherStatus.None, JazminFile.VerifyPublisher(File.ReadAllBytes(Path.Combine(Dir, "unsigned.jzm"))).Status);
        Assert.Equal(JazminPublisherStatus.NotVerified, JazminFile.VerifyPublisher(File.OpenRead(Path.Combine(Dir, "changed-trailing-byte.jzm"))).Status);
    }

    [Theory]
    [MemberData(nameof(Files))]
    public void The_path_bytes_and_stream_overloads_agree(string file)
    {
        var path = Path.Combine(Dir, file);
        var options = new JazminPublisherOptions { RevocationList = RevocationList };
        var fromPath = Json(JazminFile.VerifyPublisher(path, options, Trust)).ToJsonString();
        Assert.Equal(fromPath, Json(JazminFile.VerifyPublisher(File.ReadAllBytes(path), options, Trust)).ToJsonString());
        var stream = new MemoryStream(File.ReadAllBytes(path));
        Assert.Equal(fromPath, Json(JazminFile.VerifyPublisher(stream, options, leaveOpen: true, Trust)).ToJsonString());
        Assert.True(stream.CanRead); // left open
        JazminFile.VerifyPublisher(stream, options, leaveOpen: false, Trust);
        Assert.False(stream.CanRead);
    }

    [Fact]
    public void A_file_streamed_from_disk_is_hashed_in_pieces_not_read_whole()
    {
        // signed-plain.jzm with 32 MiB inserted after the preamble, the trailer's offsets moved: the block is found and the
        // whole file is hashed (and doesn't match D), with about 1 MiB in memory.
        var original = File.ReadAllBytes(Path.Combine(Dir, "signed-plain.jzm"));
        const int padding = 32 << 20;
        var path = Path.Combine(_temp, "padded.jzm");
        using (var output = File.Create(path))
        {
            output.Write(original, 0, FormatConstants.PreambleSize);
            output.Write(new byte[padding]);
            var rest = original.AsSpan(FormatConstants.PreambleSize).ToArray();
            var trailer = rest.AsSpan(rest.Length - FormatConstants.TrailerSize);
            BinaryPrimitives.WriteUInt64LittleEndian(trailer, BinaryPrimitives.ReadUInt64LittleEndian(trailer) + padding);
            Assert.Equal(0u, BinaryPrimitives.ReadUInt32LittleEndian(trailer[20..])); // no key slots or signature section to move
            Assert.Equal(0u, BinaryPrimitives.ReadUInt32LittleEndian(trailer[32..]));
            BinaryPrimitives.WriteUInt32LittleEndian(trailer[36..], Crc32.Compute(trailer[..36]));
            output.Write(rest);
        }
        var length = new FileInfo(path).Length;
        var options = new JazminPublisherOptions { RevocationList = RevocationList };
        JazminFile.VerifyPublisher(Path.Combine(Dir, "signed-plain.jzm"), options, Trust); // warm up

        using var padded = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1);
        var counting = new CountingStream(padded);
        var before = GC.GetAllocatedBytesForCurrentThread();
        var result = JazminFile.VerifyPublisher(counting, options, leaveOpen: true, Trust);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.Equal(JazminPublisherStatus.Changed, result.Status);
        Assert.Equal("digest", result.Reason);
        Assert.InRange(counting.BytesRead, length, length + FormatConstants.PreambleSize); // each byte read once (the preamble twice)
        Assert.True(allocated < 4L << 20, $"{allocated:N0} bytes allocated for a {length:N0}-byte file");

        // A file without a block: only the trailer and the 16 bytes before the header are read.
        using var unsignedFile = File.OpenRead(Path.Combine(Dir, "unsigned.jzm"));
        var unsigned = new CountingStream(unsignedFile);
        Assert.Equal(JazminPublisherStatus.None, JazminFile.VerifyPublisher(unsigned, null, leaveOpen: true, Trust).Status);
        Assert.Equal(FormatConstants.TrailerSize + 16, unsigned.BytesRead);
    }
}
