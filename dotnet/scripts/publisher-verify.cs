#:project ../src/Jazmin/Jazmin.csproj
#:package System.Security.Cryptography.Pkcs@10.0.13
#:package System.Formats.Cbor@10.0.13
#:property PublishAot=false
// Checks the publisher-signature test vectors in spec/fixtures/publisher (written by publisher-vectors.cs): verifies
// every file as spec 6.9.8 says, with nothing but the files and expected.json's inputs (the trusted root, the time, the
// revocation list and the files' keys), and compares each result with expected.json. Then checks the status answers,
// the confirmation receipt, the QR string and the log, and opens every file with this repository's library, which
// knows nothing of 6.9, to show that it still reads the rows (6.9.1).
//
//   dotnet run -c Release dotnet/scripts/publisher-verify.cs [-- <folder>]
using System.Buffers.Binary;
using System.Formats.Asn1;
using System.Formats.Cbor;
using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using Jazmin;

var dir = args.Length > 0 ? args[0] : Path.Combine(Util.FindRepo(), "spec", "fixtures", "publisher");
var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "expected.json")))!.AsObject();
var trust = new Trust(
    expected["trustedRoots"]!.AsArray().Select(p => Der.Parse(File.ReadAllBytes(Path.Combine(dir, (string)p!)))).ToList(),
    Util.At((string)expected["verifyAt"]!));
var failures = 0;
var counts = new SortedDictionary<string, int>();
void Count(string what, int n = 1) => counts[what] = counts.GetValueOrDefault(what) + n;
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
    if (problem is not null) failures++;
    Console.WriteLine($"{(problem is null ? "ok  " : "FAIL")} {label}{(problem is null ? "" : $"\n       {problem}")}");
}

// Whether .NET's own certificate class reads the test certificates' extensions (it could not with a 2.25 UUID arc).
Check("X509Certificate2 reads every test certificate's extensions (arc 2.999.1)", () =>
{
    foreach (var path in Directory.GetFiles(Path.Combine(dir, "pki"), "*.der"))
    {
        var c = X509CertificateLoader.LoadCertificate(File.ReadAllBytes(path));
        var oids = c.Extensions.Select(e => e.Oid!.Value).ToList();
        if (oids.Any(string.IsNullOrEmpty)) return Path.GetFileName(path);
        Count("certificates X509Certificate2 reads");
    }
    return null;
});

// The revocation list the verifier holds (6.9.5).
Check("revocation list: a JWS from a status certificate chaining to the trusted root", () =>
{
    var (payload, _) = trust.Jws(File.ReadAllText(Path.Combine(dir, (string)expected["revocationList"]!)).Trim(), Oids.Status, "issued", []);
    trust.ListIssued = Util.At((string)payload["issued"]!);
    foreach (var entry in payload["revoked"]!.AsArray())
    {
        if (!Util.Reasons.Contains((string?)entry!["reason"])) return $"reason {entry["reason"]}";
        trust.Revoked[Util.Name(entry["certificate"]!)] = Util.At((string)entry["from"]!);
    }
    Count("JWS verified");
    return trust.Revoked.Count == expected["revocations"]!.AsArray().Count ? null : "unexpected entries";
});

// Every file, without a key and with each of its keys.
var digests = new Dictionary<string, (byte[] D, string Code, byte[] FactsDigest)>();
foreach (var fixture in expected["fixtures"]!.AsArray().Select(f => f!.AsObject()))
{
    var name = (string)fixture["file"]!;
    var bytes = File.ReadAllBytes(Path.Combine(dir, name));
    var want = fixture["result"]!.AsObject();
    var keys = fixture["keys"]!.AsObject();
    Check($"{name}: {want["status"]}{(want["reason"] is null ? "" : $" ({want["reason"]})")}, no key", () =>
    {
        var result = Verifier.Verify(bytes, trust, null, counts, out var info);
        if (info is not null) digests[name] = info.Value;
        var noKey = (JsonObject)want.DeepClone();
        if (noKey["factsNeedKey"] is JsonValue v && (bool)v) noKey["facts"] = null;
        Count("files verified");
        return Util.Same(result, noKey);
    });
    foreach (var (kind, value) in keys)
        Check($"{name}: {want["status"]}, with the {kind}", () =>
        {
            var result = Verifier.Verify(bytes, trust, new FileKey(kind, (string)value!), new SortedDictionary<string, int>(), out _);
            Count("files verified with a key");
            return Util.Same(result, want);
        });
    var library = fixture["library"]!.AsObject();
    Check($"{name}: the library {((bool?)library["reads"] == true ? "reads its rows" : "refuses it")}", () =>
    {
        var (reads, rows, texts, error) = Util.Library(bytes, keys, keys.ContainsKey("ownerKey") ? "ownerKey" : keys.Select(k => k.Key).FirstOrDefault());
        if (reads != (bool?)library["reads"]) return $"reads: {reads} ({error})";
        if (!reads) return null;
        Count("files the library reads");
        if (rows != (int)library["rows"]!) return $"rows: {rows}";
        if (library["text"] is JsonNode text && !texts.Contains((string)text!)) return $"no row has '{text}'";
        if (library["accessRows"] is JsonNode accessRows)
        {
            var (accessReads, visible, _, accessError) = Util.Library(bytes, keys, "accessKey");
            if (!accessReads || visible != (int)accessRows) return $"with the access key: {visible} rows ({accessError})";
        }
        return null;
    });
}

// The status answer asked for online, and the confirmation receipt (6.9.5).
foreach (var answer in expected["statusAnswers"]!.AsArray().Select(a => a!.AsObject()))
    Check($"{answer["file"]}: an online status answer for {answer["for"]} and its own nonce", () =>
    {
        var (payload, _) = trust.Jws(File.ReadAllText(Path.Combine(dir, (string)answer["file"]!)).Trim(), Oids.Status, "time", []);
        var file = digests[(string)answer["for"]!];
        Count("JWS verified");
        return (string?)payload["nonce"] != (string?)answer["nonce"] ? "nonce"
            : (string?)payload["digest"] != Util.B64Url(file.D) ? "digest"
            : (string?)payload["code"] != file.Code ? "code"
            : !JsonNode.DeepEquals(payload["certificate"], answer["certificate"]) ? "certificate"
            : (string?)payload["status"] != (string?)answer["status"] ? "status"
            : Util.B64UrlDecode((string)payload["nonce"]!).Length < 16 ? "nonce shorter than 16 bytes" : null;
    });
foreach (var receipt in expected["confirmationReceipts"]!.AsArray().Select(a => a!.AsObject()))
    Check($"{receipt["file"]}: a confirmation receipt for {receipt["for"]}", () =>
    {
        var (payload, _) = trust.Jws(File.ReadAllText(Path.Combine(dir, (string)receipt["file"]!)).Trim(), Oids.Confirmation, "time", []);
        var file = digests[(string)receipt["for"]!];
        Count("JWS verified");
        return (string?)payload["digest"] != Util.B64Url(file.D) ? "digest"
            : (string?)payload["code"] != file.Code ? "code"
            : (string?)payload["facts"] != Util.B64Url(file.FactsDigest) ? "facts"
            : (string?)payload["party"] != (string?)receipt["party"] ? "party"
            : (string?)payload["status"] != (string?)receipt["status"] ? "status" : null;
    });
foreach (var stapled in Directory.GetFiles(Path.Combine(dir, "status"), "*.status.jws"))
    Check($"status/{Path.GetFileName(stapled)}: the same answer as in the block of {Path.GetFileName(stapled).Replace(".status.jws", ".jzm")}", () =>
    {
        var block = Verifier.ReadBlock(File.ReadAllBytes(Path.Combine(dir, Path.GetFileName(stapled).Replace(".status.jws", ".jzm"))));
        return block?.Status == File.ReadAllText(stapled).Trim() ? null : "differs";
    });

// The QR form (6.9.7): the publisher's certificate comes from the file it was printed from.
foreach (var qr in expected["qr"]!.AsArray().Select(a => a!.AsObject()))
    Check($"{qr["file"]}: a COSE_Sign1 signed with the publisher's key, matching {qr["for"]}", () =>
    {
        var text = File.ReadAllText(Path.Combine(dir, (string)qr["file"]!)).Trim();
        var block = Verifier.ReadBlock(File.ReadAllBytes(Path.Combine(dir, (string)qr["for"]!)))!;
        var certificate = Der.Parse(block.Signatures[0].Certificates[0]);
        var (kid, payload) = Qr.Verify(text, certificate);
        var signed = Verifier.ParseSignedDocument(block.Signed);
        Count("QR codes verified");
        return Convert.ToHexString(kid).ToLowerInvariant() != (string?)qr["kid"] ? "kid"
            : Convert.ToHexString(kid) != Convert.ToHexString(SHA256.HashData(certificate.Raw)[..8]) ? "kid is not the certificate's"
            : Util.Same(payload, qr["payload"]!) is { } diff ? diff
            : (string?)payload["code"] != signed.Code || (string?)payload["kind"] != signed.Kind || (long)payload["signed_at"]! != signed.SignedAt ? "differs from the file's SignedDocument"
            : null;
    });

// The log (6.9.5): the checkpoint, the entries and every receipt.
Check("log/checkpoint.txt: signed by the test log certificate's key; leaves.json and the proofs agree with it and with the blocks", () =>
{
    var pool = new[] { "test-log.der", "test-issuing.der" }.Select(n => Der.Parse(File.ReadAllBytes(Path.Combine(dir, "pki", n)))).ToList();
    var (size, root) = trust.Checkpoint(File.ReadAllText(Path.Combine(dir, "log", "checkpoint.txt")), pool, trust.Now) ?? throw new InvalidOperationException("checkpoint does not verify");
    var leaves = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "log", "leaves.json")))!.AsObject();
    var entries = leaves["entries"]!.AsArray();
    if (size != entries.Count || size != (int)expected["log"]!["treeSize"]! || Convert.ToBase64String(root) != (string?)leaves["rootHash"]) return "tree size or root";
    foreach (var e in entries.Select(e => e!.AsObject()))
    {
        var file = (string)e["file"]!;
        var role = (string)e["role"]!;
        var proof = File.ReadAllText(Path.Combine(dir, "log", $"{Path.GetFileNameWithoutExtension(file)}.{role}.proof.txt"));
        var entry = Convert.FromBase64String((string)e["entry"]!);
        var block = Verifier.ReadBlock(File.ReadAllBytes(Path.Combine(dir, file)))!;
        if ((bool)e["inFile"]!)
        {
            var signature = block.Signatures.Single(s => s.Role == role);
            if (signature.LogReceipt != proof) return $"{file} {role}: the proof file differs from the block's receipt";
            if (!Merkle.Entry(block.Signed, signature.Value).AsSpan().SequenceEqual(entry)) return $"{file} {role}: entry";
        }
        if (trust.Receipt(proof, entry, pool, trust.Now) != (int)e["index"]!) return $"{file} {role}: receipt";
        Count("log receipts checked");
    }
    return null;
});

// Every certified file's document code (6.9.3).
Check("document codes: JZ- and two groups of five Crockford Base32 symbols, the last a valid check", () =>
{
    foreach (var code in expected["fixtures"]!.AsArray().Select(f => (string?)f!["result"]!["code"]).OfType<string>())
    {
        if (!Util.ValidCode(code)) return code;
        Count("document codes checked");
    }
    return null;
});

Console.WriteLine();
foreach (var (what, n) in counts) Console.WriteLine($"{n,4} {what}");
Console.WriteLine(failures == 0 ? "All checks passed." : $"{failures} check(s) failed.");
return failures == 0 ? 0 : 1;

// =====================================================================================================================

static class Oids
{
    public const string Arc = "2.999.1";
    public const string Policy = Arc + ".1";
    public const string DocumentSigning = Arc + ".2";
    public const string Status = Arc + ".3";
    public const string Confirmation = Arc + ".4";
    public const string PublisherKind = Arc + ".5";
    public const string Log = Arc + ".6";
    public const string TimeStamping = "1.3.6.1.5.5.7.3.8";
    public const string P256 = "1.2.840.10045.3.1.7";
    public const string P384 = "1.3.132.0.34";
    public const string EcdsaSha256 = "1.2.840.10045.4.3.2";
    public const string EcdsaSha384 = "1.2.840.10045.4.3.3";
    public const string Sha256 = "2.16.840.1.101.3.4.2.1";
    public const string BasicConstraints = "2.5.29.19", KeyUsage = "2.5.29.15", ExtKeyUsage = "2.5.29.37", Policies = "2.5.29.32",
        SubjectKeyId = "2.5.29.14", AuthorityKeyId = "2.5.29.35", SubjectAltName = "2.5.29.17";
}

sealed record FileKey(string Kind, string Text);

sealed record Signature(string Algorithm, byte[] Value, List<byte[]> Certificates, string Role, byte[] Timestamp, string LogReceipt);

sealed record Block(byte[] Signed, List<Signature> Signatures, byte[] Facts, string Status, List<byte[]> Certificates, long B, Trailer Trailer);

sealed record SignedDocument(uint Version, byte[] FileId, byte[] FileDigest, string Code, string Kind, byte[] FactsDigest, List<string> Algorithms, string Credential, long SignedAt);

sealed record Trailer(long HeaderOffset, int HeaderLength, long KeySlotsOffset, int KeySlotsLength, long SignatureOffset, int SignatureLength);

sealed record Chain(bool Trusted, string? Problem, Der Leaf, List<Der> Certificates)
{
    public bool ValidAt(DateTimeOffset t) => Certificates.All(c => t >= c.NotBefore && t <= c.NotAfter);
}

/// <summary>What the verifier trusts: the built-in roots, the revocation list it holds, and its clock.</summary>
sealed class Trust(List<Der> roots, DateTimeOffset now)
{
    public DateTimeOffset Now => now;
    public Dictionary<string, DateTimeOffset> Revoked { get; } = new();
    public DateTimeOffset? ListIssued { get; set; }

    /// <summary>
    /// A chain as a signature lists it (6.9.4): the leaf, its issuing certificate, optionally a cross-certificate.
    /// Trusted when it reaches a built-in root; Problem when a trusted chain is outside the profile.
    /// </summary>
    public Chain Check(List<byte[]> listed, string eku)
    {
        var leaf = Der.Parse(listed[0]);
        var untrusted = new Chain(false, null, leaf, [leaf]);
        if (listed.Count is < 2 or > 3) return untrusted; // a self-signed certificate alone, or no chain the profile has
        var issuing = Der.Parse(listed[1]);
        var cross = listed.Count == 3 ? Der.Parse(listed[2]) : null;
        if (!Profile.Issued(issuing, leaf)) return untrusted;
        Der? root;
        if (cross is null) root = roots.FirstOrDefault(r => Profile.Issued(r, issuing));
        else root = Profile.Issued(cross, issuing) ? roots.FirstOrDefault(r => Profile.Issued(r, cross)) : null;
        if (root is null) return untrusted;
        var problem = Profile.Check(leaf, Profile.Role.Leaf, eku) ?? Profile.Check(issuing, Profile.Role.Issuing, null)
            ?? (cross is null ? null : Profile.Check(cross, Profile.Role.Cross, null)) ?? Profile.Check(root, Profile.Role.Root, null);
        return new Chain(true, problem, leaf, cross is null ? [leaf, issuing, root] : [leaf, issuing, cross, root]);
    }

    /// <summary>
    /// The chain of a certificate the block shares (6.9.6): its issuing certificate and any cross-certificate, found by
    /// issuer name and authorityKeyIdentifier among the signatures' chains and the block's certificates (6.9.4).
    /// </summary>
    public Chain Build(Der leaf, List<Der> pool, string eku)
    {
        var issuing = pool.FirstOrDefault(c => Profile.Issued(c, leaf));
        if (issuing is null) return Check([leaf.Raw], eku);
        if (roots.Any(r => Profile.Issued(r, issuing))) return Check([leaf.Raw, issuing.Raw], eku);
        var cross = pool.FirstOrDefault(c => Profile.Issued(c, issuing));
        return Check(cross is null ? [leaf.Raw, issuing.Raw] : [leaf.Raw, issuing.Raw, cross.Raw], eku);
    }

    /// <summary>An RFC 3161 token over SHA-256(value), by a time-stamping certificate whose chain is trusted (6.9.5): the time it proves.</summary>
    public DateTimeOffset? Timestamp(byte[] token, byte[] value, List<Der> pool)
    {
        if (token.Length == 0 || !Rfc3161TimestampToken.TryDecode(token, out var decoded, out var used) || used != token.Length) return null;
        if (decoded.TokenInfo.HashAlgorithmId.Value != Oids.Sha256) return null;
        var candidates = new X509Certificate2Collection();
        foreach (var c in pool) candidates.Add(X509CertificateLoader.LoadCertificate(c.Raw));
        if (!decoded.VerifySignatureForHash(SHA256.HashData(value), HashAlgorithmName.SHA256, out var signer, candidates) || signer is null) return null;
        var chain = Build(Der.Parse(signer.RawData), pool, Oids.TimeStamping);
        var at = decoded.TokenInfo.Timestamp;
        return chain.Trusted && chain.Problem is null && chain.ValidAt(at) ? at : null;
    }

    /// <summary>
    /// A compact JWS (ES256) from a trusted certificate with this extended key usage, valid at the payload's time. x5t#S256
    /// names the certificate, which is in x5c or, when x5c is left out, among the block's certificates.
    /// </summary>
    public (JsonObject Payload, Der Signer) Jws(string jws, string eku, string timeField, List<Der> pool)
    {
        var parts = jws.Split('.');
        if (parts.Length != 3) throw new InvalidOperationException("not a compact JWS");
        var header = JsonNode.Parse(Util.B64UrlDecode(parts[0]))!.AsObject();
        if ((string?)header["alg"] != "ES256") throw new InvalidOperationException("alg");
        var thumbprint = (string?)header["x5t#S256"] ?? throw new InvalidOperationException("no x5t#S256");
        var chains = header["x5c"] is JsonArray x5c
            ? [Check(x5c.Select(c => Convert.FromBase64String((string)c!)).ToList(), eku)]
            : pool.Where(c => Util.B64Url(SHA256.HashData(c.Raw)) == thumbprint).Select(c => Build(c, pool, eku)).ToList();
        chains = chains.Where(c => Util.B64Url(SHA256.HashData(c.Leaf.Raw)) == thumbprint).ToList();
        byte[] input = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]), signature = Util.B64UrlDecode(parts[2]);
        foreach (var chain in chains.Where(c => c.Trusted && c.Problem is null))
        {
            using var key = chain.Leaf.Key();
            if (!key.VerifyData(input, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) continue;
            var payload = JsonNode.Parse(Util.B64UrlDecode(parts[1]))!.AsObject();
            var at = Util.At((string)payload[timeField]!);
            if (!chain.ValidAt(at) || at > now) throw new InvalidOperationException("time");
            return (payload, chain.Leaf);
        }
        throw new InvalidOperationException("no trusted certificate signed it");
    }

    /// <summary>
    /// A C2SP checkpoint signed (type 0x02: DER ECDSA over SHA-256 of the note's text) by a trusted log certificate's key,
    /// valid at <paramref name="at"/>, whose commonName is the origin and the key name: its tree size and root hash.
    /// </summary>
    public (long Size, byte[] Root)? Checkpoint(string note, List<Der> pool, DateTimeOffset at)
    {
        var split = note.IndexOf("\n\n", StringComparison.Ordinal);
        if (split < 0) return null;
        var body = note[..(split + 1)];
        var lines = body.TrimEnd('\n').Split('\n');
        if (lines.Length < 3) return null;
        var verified = false;
        foreach (var log in pool.Where(c => Profile.Eku(c) == Oids.Log))
        {
            var chain = Build(log, pool, Oids.Log);
            if (!chain.Trusted || chain.Problem is not null || !chain.ValidAt(at)) continue;
            var id = SHA256.HashData(log.Spki)[..4];
            using var key = log.Key();
            foreach (var line in note[(split + 2)..].Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var fields = line.Split(' ');
                if (lines[0] != log.CommonName || fields.Length != 3 || fields[0] != "—" || fields[1] != log.CommonName) continue; // origin and key name: its commonName
                var raw = Convert.FromBase64String(fields[2]);
                if (raw.Length < 5 || !raw.AsSpan(0, 4).SequenceEqual(id)) continue;
                byte[] data = Encoding.UTF8.GetBytes(body), signature = raw[4..];
                verified |= key.VerifyData(data, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
            }
        }
        if (!verified) return null;
        return (long.Parse(lines[1], NumberStyles.None, CultureInfo.InvariantCulture), Convert.FromBase64String(lines[2]));
    }

    /// <summary>A receipt (C2SP tlog-proof@v1) for this entry: the index it proves, or -1.</summary>
    public long Receipt(string text, byte[] entry, List<Der> pool, DateTimeOffset at)
    {
        var pos = 0;
        string Line()
        {
            var nl = text.IndexOf('\n', pos);
            if (nl < 0) throw new InvalidOperationException("receipt ends early");
            var line = text[pos..nl];
            pos = nl + 1;
            return line;
        }
        if (Line() != "c2sp.org/tlog-proof@v1") return -1;
        var l = Line();
        if (l.StartsWith("extra ", StringComparison.Ordinal)) l = Line();
        if (!l.StartsWith("index ", StringComparison.Ordinal)) return -1;
        var index = long.Parse(l[6..], NumberStyles.None, CultureInfo.InvariantCulture);
        var proof = new List<byte[]>();
        while ((l = Line()).Length > 0) proof.Add(Convert.FromBase64String(l));
        var checkpoint = Checkpoint(text[pos..], pool, at);
        if (checkpoint is null) return -1;
        var (size, root) = checkpoint.Value;
        return Merkle.Verify(index, size, SHA256.HashData([0x00, .. entry]), proof, root) ? index : -1;
    }
}

/// <summary>A certificate read with a small, strict DER parser (6.9.4: no general X.509 processing).</summary>
sealed class Der
{
    public required byte[] Raw { get; init; }
    public required byte[] Tbs { get; init; }
    public required string SignatureAlgorithm { get; init; }
    public required byte[] Signature { get; init; }
    public required int Version { get; init; }
    public required string SerialHex { get; init; }
    public required byte[] Issuer { get; init; }
    public required byte[] Subject { get; init; }
    public required DateTimeOffset NotBefore { get; init; }
    public required DateTimeOffset NotAfter { get; init; }
    public required byte[] Spki { get; init; }
    public required string KeyAlgorithm { get; init; }
    public required string Curve { get; init; }
    public required List<(string Oid, bool Critical, byte[] Value)> Extensions { get; init; }

    /// <summary>subjectKeyIdentifier, or null.</summary>
    public byte[]? SubjectKeyId => Extension(Oids.SubjectKeyId) is { } e ? AsnDecoder.ReadOctetString(e.Value, AsnEncodingRules.DER, out _) : null;

    /// <summary>authorityKeyIdentifier's keyIdentifier, or null.</summary>
    public byte[]? AuthorityKeyId
    {
        get
        {
            if (Extension(Oids.AuthorityKeyId) is not { } e) return null;
            var seq = new AsnReader(e.Value, AsnEncodingRules.DER).ReadSequence();
            var keyId = new Asn1Tag(TagClass.ContextSpecific, 0);
            return seq.HasData && seq.PeekTag().HasSameClassAndValue(keyId) ? seq.ReadOctetString(keyId) : null;
        }
    }

    public string? CommonName => SubjectAttributes().GetValueOrDefault("2.5.4.3");

    public (bool Critical, byte[] Value)? Extension(string oid) =>
        Extensions.Where(e => e.Oid == oid).Select(e => ((bool, byte[])?)(e.Critical, e.Value)).FirstOrDefault();

    public ECDsa Key()
    {
        var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(Spki, out _);
        return key;
    }

    public static Der Parse(byte[] raw)
    {
        const AsnEncodingRules rules = AsnEncodingRules.DER;
        var outer = new AsnReader(raw, rules);
        var cert = outer.ReadSequence();
        outer.ThrowIfNotEmpty();
        var tbsBytes = cert.ReadEncodedValue().ToArray();
        var algorithm = cert.ReadSequence();
        var signatureAlgorithm = algorithm.ReadObjectIdentifier();
        algorithm.ThrowIfNotEmpty();
        var signature = cert.ReadBitString(out _);
        cert.ThrowIfNotEmpty();
        var tbs = new AsnReader(tbsBytes, rules).ReadSequence();
        var version = 1;
        var versionTag = new Asn1Tag(TagClass.ContextSpecific, 0, true);
        if (tbs.PeekTag().HasSameClassAndValue(versionTag)) version = (int)tbs.ReadSequence(versionTag).ReadInteger() + 1;
        var serial = tbs.ReadIntegerBytes().ToArray();
        if (tbs.ReadSequence().ReadObjectIdentifier() != signatureAlgorithm) throw new InvalidOperationException("signature algorithms differ");
        var issuer = tbs.ReadEncodedValue().ToArray();
        var validity = tbs.ReadSequence();
        DateTimeOffset Time() => validity.PeekTag().HasSameClassAndValue(Asn1Tag.UtcTime) ? validity.ReadUtcTime() : validity.ReadGeneralizedTime();
        var notBefore = Time();
        var notAfter = Time();
        var subject = tbs.ReadEncodedValue().ToArray();
        var spki = tbs.ReadEncodedValue().ToArray();
        var keyAlgorithm = new AsnReader(spki, rules).ReadSequence().ReadSequence();
        var keyOid = keyAlgorithm.ReadObjectIdentifier();
        var curve = keyAlgorithm.HasData && keyAlgorithm.PeekTag().HasSameClassAndValue(Asn1Tag.ObjectIdentifier) ? keyAlgorithm.ReadObjectIdentifier() : "";
        var extensions = new List<(string, bool, byte[])>();
        var extensionsTag = new Asn1Tag(TagClass.ContextSpecific, 3, true);
        if (tbs.HasData && tbs.PeekTag().HasSameClassAndValue(extensionsTag))
        {
            var list = tbs.ReadSequence(extensionsTag).ReadSequence();
            while (list.HasData)
            {
                var e = list.ReadSequence();
                var oid = e.ReadObjectIdentifier();
                var critical = e.PeekTag().HasSameClassAndValue(Asn1Tag.Boolean) && e.ReadBoolean();
                var value = e.ReadOctetString();
                if (extensions.Any(x => x.Item1 == oid)) throw new InvalidOperationException($"extension {oid} twice");
                extensions.Add((oid, critical, value));
            }
        }
        tbs.ThrowIfNotEmpty();
        return new Der
        {
            Raw = raw, Tbs = tbsBytes, SignatureAlgorithm = signatureAlgorithm, Signature = signature, Version = version,
            SerialHex = Convert.ToHexString(serial).ToLowerInvariant(), Issuer = issuer, Subject = subject, NotBefore = notBefore, NotAfter = notAfter,
            Spki = spki, KeyAlgorithm = keyOid, Curve = curve, Extensions = extensions,
        };
    }

    /// <summary>The subject's attributes, by OID.</summary>
    public Dictionary<string, string> SubjectAttributes()
    {
        var result = new Dictionary<string, string>();
        var name = new AsnReader(Subject, AsnEncodingRules.DER).ReadSequence();
        while (name.HasData)
        {
            var set = name.ReadSetOf();
            while (set.HasData)
            {
                var pair = set.ReadSequence();
                var oid = pair.ReadObjectIdentifier();
                result[oid] = pair.ReadCharacterString((UniversalTagNumber)pair.PeekTag().TagValue);
            }
        }
        return result;
    }
}

/// <summary>The certificate profile of 6.9.4, checked strictly.</summary>
static class Profile
{
    public enum Role { Root, Cross, Issuing, Leaf }

    private static HashSet<int> KeyUsage(byte[] value)
    {
        var bits = new AsnReader(value, AsnEncodingRules.DER).ReadBitString(out var unused);
        var set = new HashSet<int>();
        for (var i = 0; i < bits.Length * 8 - unused; i++)
            if ((bits[i / 8] & (0x80 >> (i % 8))) != 0) set.Add(i);
        return set;
    }

    private static List<string> OidSequence(byte[] value, bool policies)
    {
        var list = new List<string>();
        var seq = new AsnReader(value, AsnEncodingRules.DER).ReadSequence();
        while (seq.HasData) list.Add(policies ? seq.ReadSequence().ReadObjectIdentifier() : seq.ReadObjectIdentifier());
        return list;
    }

    /// <summary>The certificate's one extended key usage, or null.</summary>
    public static string? Eku(Der c) => c.Extension(Oids.ExtKeyUsage) is { } e && OidSequence(e.Value, false) is [var only] ? only : null;

    /// <summary>
    /// The profile's rows: a root (and a cross-certificate, a root's key certified by another root) P-384 signed with
    /// ecdsa-with-SHA384 and path length 2; an issuing certificate P-256 signed with ecdsa-with-SHA384, path length 0; leaves
    /// P-256 signed with ecdsa-with-SHA256, one extended key usage. Only the listed extensions, with their criticality.
    /// </summary>
    public static string? Check(Der c, Role role, string? eku)
    {
        if (c.Version != 3) return "not X.509 v3";
        if (c.KeyAlgorithm != "1.2.840.10045.2.1" || c.Curve != (role is Role.Root or Role.Cross ? Oids.P384 : Oids.P256)) return "key";
        if (c.SignatureAlgorithm != (role == Role.Leaf ? Oids.EcdsaSha256 : Oids.EcdsaSha384)) return "signature algorithm";
        var publisher = role == Role.Leaf && eku == Oids.DocumentSigning;
        foreach (var e in c.Extensions)
        {
            var allowed = e.Oid switch
            {
                Oids.BasicConstraints or Oids.KeyUsage => e.Critical,
                Oids.ExtKeyUsage => role == Role.Leaf && e.Critical == (eku == Oids.TimeStamping),
                Oids.Policies or Oids.SubjectKeyId or Oids.AuthorityKeyId => !e.Critical,
                Oids.SubjectAltName => publisher && !e.Critical,
                Oids.PublisherKind => publisher && !e.Critical
                    && AsnDecoder.ReadCharacterString(e.Value, AsnEncodingRules.DER, UniversalTagNumber.UTF8String, out _) is "company" or "individual",
                _ => false,
            };
            if (!allowed) return $"extension {e.Oid}";
        }
        var ca = false;
        int? pathLength = null;
        if (c.Extension(Oids.BasicConstraints) is { } b)
        {
            var seq = new AsnReader(b.Value, AsnEncodingRules.DER).ReadSequence();
            if (seq.HasData && seq.PeekTag().HasSameClassAndValue(Asn1Tag.Boolean)) ca = seq.ReadBoolean();
            if (seq.HasData) pathLength = (int)seq.ReadInteger();
        }
        var usage = c.Extension(Oids.KeyUsage) is { } u ? KeyUsage(u.Value) : null;
        if (role == Role.Leaf)
        {
            if (ca) return "a leaf that is a CA";
            if (usage is null || !usage.SetEquals([0])) return "key usage";
            if (Eku(c) != eku) return "extended key usage";
        }
        else
        {
            if (!ca || pathLength != (role == Role.Issuing ? 0 : 2)) return "basic constraints";
            if (usage is null || !usage.SetEquals([5, 6])) return "key usage";
        }
        if (c.Extension(Oids.Policies) is not { } policies || !OidSequence(policies.Value, true).Contains(Oids.Policy)) return "certificate policy";
        return null;
    }

    /// <summary>Whether <paramref name="issuer"/> issued <paramref name="child"/>: its name, its key identifier when the child names one, and its signature.</summary>
    public static bool Issued(Der issuer, Der child) =>
        child.Issuer.AsSpan().SequenceEqual(issuer.Subject)
        && (child.AuthorityKeyId is null || issuer.SubjectKeyId is { } ski && child.AuthorityKeyId.AsSpan().SequenceEqual(ski))
        && SignedBy(child, issuer);

    public static bool SignedBy(Der child, Der issuer)
    {
        var hash = child.SignatureAlgorithm switch
        {
            Oids.EcdsaSha256 => HashAlgorithmName.SHA256,
            Oids.EcdsaSha384 => HashAlgorithmName.SHA384,
            _ => default,
        };
        if (hash == default) return false;
        using var key = issuer.Key();
        return key.VerifyData(child.Tbs, child.Signature, hash, DSASignatureFormat.Rfc3279DerSequence);
    }

    /// <summary>What a reader shows of a trusted publisher certificate (6.9.4).</summary>
    public static JsonObject Identity(Der c)
    {
        var attributes = c.SubjectAttributes();
        var kind = c.Extension(Oids.PublisherKind) is { } k ? AsnDecoder.ReadCharacterString(k.Value, AsnEncodingRules.DER, UniversalTagNumber.UTF8String, out _) : null;
        string? domain = null;
        if (c.Extension(Oids.SubjectAltName) is { } san)
        {
            var names = new AsnReader(san.Value, AsnEncodingRules.DER).ReadSequence();
            var dns = new Asn1Tag(TagClass.ContextSpecific, 2);
            while (names.HasData && domain is null)
                if (names.PeekTag().HasSameClassAndValue(dns)) domain = names.ReadCharacterString(UniversalTagNumber.IA5String, dns);
                else names.ReadEncodedValue();
        }
        return new JsonObject
        {
            ["name"] = attributes.GetValueOrDefault("2.5.4.3"), ["organization"] = attributes.GetValueOrDefault("2.5.4.10"),
            ["registration"] = attributes.GetValueOrDefault("2.5.4.97"), ["country"] = attributes.GetValueOrDefault("2.5.4.6"), ["domain"] = domain, ["kind"] = kind,
        };
    }
}

/// <summary>The verifying steps of 6.9.8, and what a reader concludes about the block (6.9.1).</summary>
static class Verifier
{
    /// <summary>A valid trailer at the file's end (4.2), or null.</summary>
    public static Trailer? ReadTrailer(byte[] f)
    {
        if (f.Length < 64 + 44) return null;
        var t = f.AsSpan(f.Length - 44, 44);
        if (!t[40..].SequenceEqual("JZM1"u8) || Util.Crc32(t[..36]) != BinaryPrimitives.ReadUInt32LittleEndian(t[36..])) return null;
        var trailer = new Trailer((long)BinaryPrimitives.ReadUInt64LittleEndian(t), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[8..]),
            (long)BinaryPrimitives.ReadUInt64LittleEndian(t[12..]), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[20..]),
            (long)BinaryPrimitives.ReadUInt64LittleEndian(t[24..]), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[32..]));
        var last = Math.Max(trailer.HeaderOffset + trailer.HeaderLength, trailer.SignatureOffset + trailer.SignatureLength);
        return trailer.HeaderOffset >= 64 && last == f.Length - 44 ? trailer : null;
    }

    /// <summary>Step 1: the block before the header. Problem: magic present, but the block is damaged (invalid).</summary>
    public static (Block? Block, string? Problem) FindBlock(byte[] f, Trailer t)
    {
        var h = (int)t.HeaderOffset;
        if (h < 64 + 16 || !f.AsSpan(h - 4, 4).SequenceEqual("JZPS"u8)) return (null, null);
        var footer = f.AsSpan(h - 16, 16);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(footer);
        var b = (long)h - 16 - length;
        if (b < 64) return (null, "the payload would start inside the preamble");
        if (BinaryPrimitives.ReadUInt16LittleEndian(footer[8..]) != 1) return (null, "unknown version");
        if (BinaryPrimitives.ReadUInt16LittleEndian(footer[10..]) != 0) return (null, "non-zero reserved");
        var payload = f.AsSpan((int)b, (int)length);
        if (Util.Crc32(payload) != BinaryPrimitives.ReadUInt32LittleEndian(footer[4..])) return (null, "CRC");
        try
        {
            var fields = Pb.Parse(payload);
            var signatures = fields.Where(x => x.Field == 2).Select(x =>
            {
                var s = Pb.Parse(x.Data);
                return new Signature(Pb.Text(s, 1), Pb.Bytes(s, 2), s.Where(y => y.Field == 3).Select(y => y.Data).ToList(), Pb.Text(s, 4), Pb.Bytes(s, 5), Pb.Text(s, 6));
            }).ToList();
            return (new Block(Pb.Bytes(fields, 1), signatures, Pb.Bytes(fields, 3), Pb.Text(fields, 4), fields.Where(x => x.Field == 5).Select(x => x.Data).ToList(), b, t), null);
        }
        catch (Exception)
        {
            return (null, "not a PublisherSignatures");
        }
    }

    public static Block? ReadBlock(byte[] f) => ReadTrailer(f) is { } t ? FindBlock(f, t).Block : null;

    public static SignedDocument ParseSignedDocument(byte[] signed)
    {
        var s = Pb.Parse(signed);
        return new SignedDocument((uint)Pb.Number(s, 1), Pb.Bytes(s, 2), Pb.Bytes(s, 3), Pb.Text(s, 4), Pb.Text(s, 5), Pb.Bytes(s, 6),
            s.Where(x => x.Field == 7).Select(x => Encoding.UTF8.GetString(x.Data)).ToList(), Pb.Text(s, 8), (long)Pb.Number(s, 9));
    }

    private static JsonObject Result(string status, string? reason) => new()
    {
        ["status"] = status, ["name"] = null, ["kind"] = null, ["code"] = null, ["facts"] = null, ["reason"] = reason,
    };

    public static JsonObject Verify(byte[] f, Trust trust, FileKey? key, SortedDictionary<string, int> counts, out (byte[] D, string Code, byte[] FactsDigest)? info)
    {
        info = null;
        void Count(string what) => counts[what] = counts.GetValueOrDefault(what) + 1;
        // A file whose last bytes are not a valid trailer is not a valid file, and isn't verified (6.9.1).
        if (ReadTrailer(f) is not { } t) return Result("not-verified", "not-a-valid-file");
        // 1. the block, its CRC, version and coverage
        var (block, problem) = FindBlock(f, t);
        if (problem is not null) return Result("invalid", "block");
        if (block is null) return Result("none", null);
        SignedDocument signed;
        try
        {
            signed = ParseSignedDocument(block.Signed);
        }
        catch (Exception)
        {
            return Result("invalid", "block");
        }
        if (signed.Version != 1) return Result("invalid", "block");
        var trailerStart = f.Length - 44;
        var headerEnd = t.HeaderOffset + t.HeaderLength;
        if (t.SignatureLength > 0 ? headerEnd != t.SignatureOffset || t.SignatureOffset + t.SignatureLength != trailerStart : headerEnd != trailerStart)
            return Result("changed", "coverage");
        // 2. D and the file id
        var d = SHA256.HashData([
            .. "JAZMIN/1/publisher-file"u8, .. f.AsSpan(8, 16), .. SHA256.HashData(f.AsSpan(0, (int)block.B)),
            .. SHA256.HashData(f.AsSpan((int)t.HeaderOffset, t.HeaderLength)),
            .. SHA256.HashData(t.SignatureLength > 0 ? f.AsSpan((int)t.SignatureOffset, t.SignatureLength) : ReadOnlySpan<byte>.Empty)]);
        if (!signed.FileId.AsSpan().SequenceEqual(f.AsSpan(8, 16)) || !signed.FileDigest.AsSpan().SequenceEqual(d)) return Result("changed", "digest");
        info = (d, signed.Code, signed.FactsDigest);
        // 3. algorithms entry for entry, the publisher first, and each signature this reader knows
        if (!block.Signatures.Select(s => s.Algorithm).SequenceEqual(signed.Algorithms)) return Result("invalid", "algorithms");
        if (block.Signatures.Count == 0 || block.Signatures[0].Role != "publisher" || block.Signatures.Skip(1).Any(s => s.Role != "cosigner"))
            return Result("invalid", "algorithms"); // step 3: the first signature is the publisher's
        if (block.Signatures[0].Algorithm != "ES256") return Result("invalid", "algorithms");
        var pool = new List<Der>();
        try
        {
            foreach (var der in block.Signatures.SelectMany(s => s.Certificates).Concat(block.Certificates)) pool.Add(Der.Parse(der));
        }
        catch (Exception)
        {
            return Result("invalid", "chain");
        }
        var chains = new List<(Signature Sig, Chain Chain)>();
        foreach (var s in block.Signatures.Where(s => s.Algorithm == "ES256"))
        {
            if (s.Certificates.Count == 0) return Result("invalid", "chain");
            using var publicKey = Der.Parse(s.Certificates[0]).Key();
            byte[] message = [.. "JAZMIN/1/publisher"u8, .. block.Signed];
            if (!publicKey.VerifyData(message, s.Value, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                return Result("invalid", "signature");
            chains.Add((s, trust.Check(s.Certificates, Oids.DocumentSigning)));
        }
        // "signed": the publisher's certificate doesn't chain to a trusted root. No name, facts or code.
        if (!chains[0].Chain.Trusted) return Result("signed", null);
        // 4. each chain, timestamp and log receipt
        var times = new List<DateTimeOffset>();
        foreach (var (sig, chain) in chains)
        {
            if (!chain.Trusted || chain.Problem is not null) return Result("invalid", "chain");
            if (trust.Timestamp(sig.Timestamp, sig.Value, pool) is not { } at) return Result("invalid", "timestamp");
            Count("timestamps verified");
            if (!chain.ValidAt(at)) return Result("invalid", "timestamp"); // the timestamp must be inside the chain's validity
            if (trust.Receipt(sig.LogReceipt, Merkle.Entry(block.Signed, sig.Value), pool, at) < 0) return Result("invalid", "log");
            Count("log receipts verified in files");
            times.Add(at);
        }
        var publisher = chains[0].Chain;
        var signedAt = times[0];
        // 5. revocation: of the statements held, the most recent by its time (6.9.5); the stored one covers only the publisher.
        JsonObject? answer = null;
        if (block.Status.Length > 0)
        {
            try
            {
                answer = trust.Jws(block.Status, Oids.Status, "time", pool).Payload;
                if ((string?)answer["digest"] != Util.B64Url(d) || (string?)answer["nonce"] != Util.B64Url(d) || (string?)answer["code"] != signed.Code
                    || Util.Name(answer["certificate"]!) != Util.Name(publisher.Certificates[0], publisher.Certificates[1])
                    || ((string?)answer["status"] is "revoked" or "withdrawn" or "superseded" && answer["from"] is null)) // from is REQUIRED with them
                    answer = null;
            }
            catch (Exception)
            {
                answer = null; // not a statement this reader can rely on: as if there were none
            }
            if (answer is not null) Count("stored status answers verified");
        }
        for (var i = 0; i < chains.Count; i++)
        {
            var chain = chains[i].Chain;
            var statements = new List<(DateTimeOffset Time, DateTimeOffset? RevokedFrom)>();
            if (i == 0 && answer is not null)
                statements.Add((Util.At((string)answer["time"]!), (string?)answer["status"] == "revoked" ? Util.At((string)answer["from"]!) : null));
            if (trust.ListIssued is { } issued)
                statements.Add((issued, trust.Revoked.TryGetValue(Util.Name(chain.Certificates[0], chain.Certificates[1]), out var from) ? from : null));
            if (statements.Count > 0 && statements.MaxBy(s => s.Time).RevokedFrom is { } revokedFrom && revokedFrom <= times[i]) return Result("invalid", "revoked");
        }
        // 6. the facts, with a key that reads the header (or in a file that isn't encrypted)
        var encrypted = (BinaryPrimitives.ReadUInt16LittleEndian(f.AsSpan(4)) & 1) != 0;
        JsonNode? facts = null;
        if (signed.FactsDigest.Length > 0 && (!encrypted || key is not null))
        {
            byte[] plain;
            try
            {
                plain = encrypted ? Facts.Decrypt(f, t, block.Facts, key!) : block.Facts;
            }
            catch (Exception)
            {
                return Result("invalid", "facts");
            }
            if (!SHA256.HashData(plain).AsSpan().SequenceEqual(signed.FactsDigest)) return Result("invalid", "facts");
            facts = JsonNode.Parse(plain.AsSpan(16));
        }
        var status = "certified";
        if (answer is not null && (string?)answer["status"] is "withdrawn" or "superseded" && (answer["from"] is null || Util.At((string)answer["from"]!) <= trust.Now))
            status = (string)answer["status"]!;
        var result = new JsonObject { ["status"] = status };
        foreach (var (k, v) in Profile.Identity(publisher.Leaf)) result[k] = v?.DeepClone();
        result["code"] = signed.Code;
        result["documentKind"] = signed.Kind;
        result["credential"] = signed.Credential;
        result["signedAt"] = Util.Iso(DateTimeOffset.FromUnixTimeMilliseconds(signed.SignedAt));
        result["timestamp"] = Util.Iso(signedAt);
        result["cosigners"] = new JsonArray(chains.Skip(1).Select(c => (JsonNode)Profile.Identity(c.Chain.Leaf)).ToArray());
        result["facts"] = facts;
        result["factsNeedKey"] = encrypted;
        if (answer is not null) result["statusAnswer"] = new JsonObject { ["status"] = answer["status"]!.DeepClone(), ["from"] = answer["from"]?.DeepClone() };
        result["reason"] = null;
        return result;
    }
}

/// <summary>The facts of an encrypted file (6.9.3): HKDF(master or H, preamble salt, "JAZMIN/1/publisher/facts").</summary>
static class Facts
{
    public static byte[] Decrypt(byte[] f, Trailer t, byte[] stored, FileKey key)
    {
        var salt = f.AsSpan(24, 32).ToArray();
        var flags = BinaryPrimitives.ReadUInt16LittleEndian(f.AsSpan(4));
        byte[] ikm;
        if ((flags & 4) != 0) // access-controlled: H, from the key's slot
        {
            var secret = key.Kind switch
            {
                "ownerKey" or "key" => Util.ParseKey(key.Text),
                "accessKey" => Util.ParseAccessKey(key.Text),
                _ => throw new InvalidOperationException("an access-controlled file needs the owner key or an access key"),
            };
            ikm = HeaderSecret(f, t, secret);
        }
        else ikm = (flags & 2) != 0 // the master key, or the one a password derives (7.2)
            ? Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(key.Text), salt, (int)BinaryPrimitives.ReadUInt32LittleEndian(f.AsSpan(56)), HashAlgorithmName.SHA256, 32)
            : Util.ParseKey(key.Text);
        var factsKey = Util.Hkdf(ikm, salt, "JAZMIN/1/publisher/facts");
        var rawLength = stored.Length - 28;
        var envelope = new byte[8];
        envelope[1] = 0x01;
        BinaryPrimitives.WriteUInt32LittleEndian(envelope.AsSpan(4), (uint)rawLength);
        var plain = new byte[rawLength];
        using var gcm = new AesGcm(factsKey, 16);
        gcm.Decrypt(stored.AsSpan(0, 12), stored.AsSpan(12, rawLength), stored.AsSpan(12 + rawLength), plain, [.. f.AsSpan(8, 16), .. envelope, .. "publisher/facts"u8]);
        return plain;
    }

    /// <summary>H, from the key's slot (7.6.4).</summary>
    private static byte[] HeaderSecret(byte[] f, Trailer t, byte[] secret)
    {
        var id = SHA256.HashData([.. "JAZMIN/1/slot-id"u8, .. secret])[..8];
        var list = Plain(f, t.KeySlotsOffset, t.KeySlotsLength);
        var pages = (int)BinaryPrimitives.ReadUInt32LittleEndian(list);
        var pick = -1;
        for (var i = 0; i < pages; i++)
            if (list.AsSpan(4 + i * 52, 8).SequenceCompareTo(id) <= 0) pick = i;
        var entry = list.AsSpan(4 + pick * 52, 52);
        var offset = (long)BinaryPrimitives.ReadUInt64LittleEndian(entry[8..]);
        var length = (int)BinaryPrimitives.ReadUInt32LittleEndian(entry[16..]);
        if (!SHA256.HashData(f.AsSpan((int)offset, length)).AsSpan().SequenceEqual(entry[20..])) throw new InvalidOperationException("page digest");
        var page = Plain(f, offset, length);
        var count = (int)BinaryPrimitives.ReadUInt32LittleEndian(page);
        for (var i = 0; i < count; i++)
        {
            var slot = page.AsSpan(4 + i * 16, 16);
            if (!slot[..8].SequenceEqual(id)) continue;
            var start = 4 + count * 16 + (int)BinaryPrimitives.ReadUInt32LittleEndian(slot[8..]);
            var size = (int)(BinaryPrimitives.ReadUInt32LittleEndian(slot[12..]) & 0x7FFFFFFF);
            var sealedSlot = page.AsSpan(start, size);
            var plain = new byte[size - 28];
            using var gcm = new AesGcm(Util.Hkdf(secret, f.AsSpan(24, 32).ToArray(), "JAZMIN/1/slot"), 16);
            gcm.Decrypt(sealedSlot[..12], sealedSlot[12..^16], sealedSlot[^16..], plain, [.. f.AsSpan(8, 16), .. id]);
            return Convert.FromBase64String((string)JsonNode.Parse(plain)!["header"]!);
        }
        throw new InvalidOperationException("no slot for this key");
    }

    private static byte[] Plain(byte[] f, long offset, int length)
    {
        var payloadLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(f.AsSpan((int)offset + 8));
        if (f[offset] != 0 || f[offset + 1] != 0 || 16 + payloadLength != length) throw new InvalidOperationException("key slots must be stored plain");
        return f.AsSpan((int)offset + 16, payloadLength).ToArray();
    }
}

/// <summary>The log (6.9.5): entries, and RFC 9162 section 2.1.3.2's inclusion proof check.</summary>
static class Merkle
{
    public static byte[] Entry(byte[] signed, byte[] value) => [.. "JAZMIN/1/log"u8, .. SHA256.HashData(signed), .. SHA256.HashData(value)];

    public static bool Verify(long index, long size, byte[] leafHash, List<byte[]> proof, byte[] root)
    {
        if (index >= size) return false;
        long fn = index, sn = size - 1;
        var r = leafHash;
        foreach (var p in proof)
        {
            if (p.Length != 32 || sn == 0) return false;
            if ((fn & 1) == 1 || fn == sn)
            {
                r = SHA256.HashData([0x01, .. p, .. r]);
                while ((fn & 1) == 0 && fn != 0)
                {
                    fn >>= 1;
                    sn >>= 1;
                }
            }
            else r = SHA256.HashData([0x01, .. r, .. p]);
            fn >>= 1;
            sn >>= 1;
        }
        return sn == 0 && r.AsSpan().SequenceEqual(root);
    }
}

/// <summary>The QR form (6.9.7): "JZ1:" + Base45(zlib(COSE_Sign1)), alg -7 and kid in the protected header.</summary>
static class Qr
{
    private const string Base45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

    public static (byte[] Kid, JsonObject Payload) Verify(string text, Der certificate)
    {
        if (!text.StartsWith("JZ1:", StringComparison.Ordinal)) throw new InvalidOperationException("prefix");
        var b45 = text[4..];
        var bytes = new List<byte>();
        for (var i = 0; i < b45.Length; i += 3)
        {
            var c = Base45.IndexOf(b45[i]) + Base45.IndexOf(b45[i + 1]) * 45;
            if (i + 2 < b45.Length)
            {
                var v = c + Base45.IndexOf(b45[i + 2]) * 2025;
                bytes.Add((byte)(v / 256));
                bytes.Add((byte)(v % 256));
            }
            else bytes.Add((byte)c);
        }
        var cose = new MemoryStream();
        using (var z = new ZLibStream(new MemoryStream(bytes.ToArray()), CompressionMode.Decompress)) z.CopyTo(cose);
        var r = new CborReader(cose.ToArray());
        if (r.ReadTag() != (CborTag)18 || r.ReadStartArray() != 4) throw new InvalidOperationException("not a COSE_Sign1");
        var protectedHeader = r.ReadByteString();
        r.SkipValue(); // unprotected
        var payload = r.ReadByteString();
        var signature = r.ReadByteString();
        var h = new CborReader(protectedHeader);
        byte[]? kid = null;
        int? alg = null;
        var n = h.ReadStartMap();
        for (var i = 0; i < n; i++)
        {
            var label = h.ReadInt32();
            if (label == 1) alg = h.ReadInt32();
            else if (label == 4) kid = h.ReadByteString();
            else h.SkipValue();
        }
        if (alg != -7 || kid is null) throw new InvalidOperationException("protected header");
        var w = new CborWriter();
        w.WriteStartArray(4);
        w.WriteTextString("Signature1");
        w.WriteByteString(protectedHeader);
        w.WriteByteString(Array.Empty<byte>());
        w.WriteByteString(payload);
        w.WriteEndArray();
        using var key = certificate.Key();
        if (!key.VerifyData(w.Encode(), signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) throw new InvalidOperationException("signature");
        var p = new CborReader(payload);
        var result = new JsonObject();
        var count = p.ReadStartMap();
        for (var i = 0; i < count; i++)
        {
            var name = p.ReadTextString();
            if (name == "facts")
            {
                var facts = new JsonObject();
                var m = p.ReadStartMap();
                for (var j = 0; j < m; j++) facts[p.ReadTextString()] = p.ReadTextString();
                p.ReadEndMap();
                result[name] = facts;
            }
            else if (name == "signed_at") result[name] = p.ReadInt64();
            else result[name] = p.ReadTextString();
        }
        return (kid, result);
    }
}

/// <summary>A small Protocol Buffers reader: the fields of one message.</summary>
static class Pb
{
    public static List<(int Field, ulong Number, byte[] Data)> Parse(ReadOnlySpan<byte> b)
    {
        var fields = new List<(int, ulong, byte[])>();
        var pos = 0;
        ulong Varint(ReadOnlySpan<byte> s)
        {
            ulong v = 0;
            for (var shift = 0; ; shift += 7)
            {
                if (shift > 63) throw new InvalidOperationException("varint");
                var x = s[pos++];
                v |= (ulong)(x & 0x7F) << shift;
                if (x < 0x80) return v;
            }
        }
        while (pos < b.Length)
        {
            var key = Varint(b);
            var field = (int)(key >> 3);
            switch (key & 7)
            {
                case 0: fields.Add((field, Varint(b), Array.Empty<byte>())); break;
                case 1: pos += 8; break;
                case 5: pos += 4; break;
                case 2:
                    var length = (int)Varint(b);
                    fields.Add((field, 0, b.Slice(pos, length).ToArray()));
                    pos += length;
                    break;
                default: throw new InvalidOperationException("wire type");
            }
        }
        if (pos != b.Length) throw new InvalidOperationException("truncated");
        return fields;
    }

    public static byte[] Bytes(List<(int Field, ulong Number, byte[] Data)> f, int field) => f.LastOrDefault(x => x.Field == field).Data ?? [];

    public static string Text(List<(int Field, ulong Number, byte[] Data)> f, int field) => Encoding.UTF8.GetString(Bytes(f, field));

    public static ulong Number(List<(int Field, ulong Number, byte[] Data)> f, int field) => f.LastOrDefault(x => x.Field == field).Number;
}

static class Util
{
    public static readonly HashSet<string?> Reasons = ["keyCompromise", "affiliationChanged", "superseded", "cessationOfOperation", "privilegeWithdrawn"];

    public static string FindRepo()
    {
        foreach (var start in new[] { AppContext.GetData("EntryPointFileDirectoryPath") as string, Environment.CurrentDirectory })
            for (var dir = start; dir is not null; dir = Path.GetDirectoryName(dir))
                if (File.Exists(Path.Combine(dir, "spec", "jazmin.proto"))) return dir;
        throw new InvalidOperationException("Run from the repository (spec/jazmin.proto not found)");
    }

    public static DateTimeOffset At(string iso) => DateTimeOffset.Parse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);

    public static string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    public static string B64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] B64UrlDecode(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }

    /// <summary>A certificate's name in JWS payloads (6.9.5), as text to compare: issuer (SHA-256 of the issuing SPKI) and serial.</summary>
    public static string Name(JsonNode name) => $"{(string?)name["issuer"]}/{(string?)name["serial"]}";

    public static string Name(Der certificate, Der issuing) => $"{B64Url(SHA256.HashData(issuing.Spki))}/{certificate.SerialHex}";

    public static byte[] ParseKey(string text)
    {
        var raw = B64UrlDecode(text["jzk1-".Length..]);
        if (raw.Length != 36 || !SHA256.HashData(raw.AsSpan(0, 32))[..4].AsSpan().SequenceEqual(raw.AsSpan(32))) throw new InvalidOperationException("key checksum");
        return raw[..32];
    }

    public static byte[] ParseAccessKey(string text)
    {
        var raw = B64UrlDecode(text["jza1-".Length..]);
        if (raw.Length != 44 || !SHA256.HashData(raw.AsSpan(0, 40))[..4].AsSpan().SequenceEqual(raw.AsSpan(40))) throw new InvalidOperationException("access key checksum");
        return raw[..32];
    }

    public static byte[] Hkdf(byte[] ikm, byte[] salt, string info)
    {
        var key = new byte[32];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, key, salt, Encoding.UTF8.GetBytes(info));
        return key;
    }

    public static bool ValidCode(string code)
    {
        const string alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        if (code.Length != 14 || !code.StartsWith("JZ-", StringComparison.Ordinal) || code[8] != '-') return false;
        var symbols = (code[3..8] + code[9..]).Select(c => alphabet.IndexOf(c)).ToList();
        if (symbols.Any(v => v < 0)) return false;
        return symbols.Take(9).Select((v, i) => v * (i + 1)).Sum() % 32 == symbols[9];
    }

    public static string? Same(JsonNode actual, JsonNode expected) =>
        JsonNode.DeepEquals(actual, expected) ? null : $"got {actual.ToJsonString()}\n       want {expected.ToJsonString()}";

    /// <summary>Opens the file with this repository's library and reads every row.</summary>
    public static (bool Reads, int Rows, HashSet<string> Texts, string? Error) Library(byte[] file, JsonObject keys, string? which)
    {
        try
        {
            var options = new JazminReadOptions();
            var text = which is null ? null : (string)keys[which]!;
            switch (which)
            {
                case "password": options.Password = text; break;
                case "key" or "ownerKey": options.Key = JazminKey.Parse(text!); break;
                case "accessKey": options.AccessKey = JazminAccessKey.Parse(text!); break;
            }
            using var reader = JazminReader.Open(file, options);
            var rows = reader.Rows().ToList();
            return (true, rows.Count, rows.SelectMany(r => r.Values).OfType<string>().ToHashSet(), null);
        }
        catch (Exception error)
        {
            return (false, 0, [], $"{error.GetType().Name}: {error.Message}");
        }
    }

    private static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(n =>
    {
        var c = (uint)n;
        for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    public static uint Crc32(ReadOnlySpan<byte> data)
    {
        var c = 0xFFFFFFFFu;
        foreach (var b in data) c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }
}
