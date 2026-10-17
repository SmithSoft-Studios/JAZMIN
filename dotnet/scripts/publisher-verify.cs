#:project ../src/Jazmin/Jazmin.csproj
#:package System.Security.Cryptography.Pkcs@10.0.13
#:package System.Formats.Cbor@10.0.13
#:property PublishAot=false
// Checks the publisher-signature test vectors in spec/fixtures/publisher (written by publisher-vectors.cs): verifies
// every file as spec 6.9.8 says, with nothing but the files and expected.json's inputs (the trusted root, the time, the
// revocation list, the log's key and the files' keys), and compares each result with expected.json. Then checks the
// status answers, the confirmation receipt, the QR string and the log, and opens every file with this repository's
// library, which knows nothing of 6.9, to show that it still reads the rows (6.9.1).
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
    (string)expected["log"]!["verifierKey"]!, Util.At((string)expected["verifyAt"]!));
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

// The revocation list the verifier holds (6.9.5).
Check("revocation list: a JWS from a status certificate chaining to the trusted root", () =>
{
    var (payload, _) = trust.Jws(File.ReadAllText(Path.Combine(dir, (string)expected["revocationList"]!)).Trim(), Oids.Status, "issued");
    foreach (var entry in payload["revoked"]!.AsArray())
        trust.Revoked[(string)entry!["serial"]!] = Util.At((string)entry["from"]!);
    Count("JWS verified");
    return trust.Revoked.Count == expected["revocations"]!.AsArray().Count ? null : "unexpected entries";
});

// Every file, without a key and with each of its keys.
var digests = new Dictionary<string, (byte[] D, string Code, byte[] FactsDigest, byte[] Leaf)>();
foreach (var fixture in expected["fixtures"]!.AsArray().Select(f => f!.AsObject()))
{
    var name = (string)fixture["file"]!;
    var bytes = File.ReadAllBytes(Path.Combine(dir, name));
    var want = fixture["result"]!.AsObject();
    var keys = fixture["keys"]!.AsObject();
    Check($"{name}: {want["status"]}{(want["reason"] is null ? "" : $" ({want["reason"]})")}, no key", () =>
    {
        var result = Verifier.Verify(bytes, trust, null, out var info);
        if (info is not null) digests[name] = info.Value;
        var noKey = (JsonObject)want.DeepClone();
        if (noKey["factsNeedKey"] is JsonValue v && (bool)v) noKey["facts"] = null;
        Count("files verified");
        return Util.Same(result, noKey);
    });
    foreach (var (kind, value) in keys)
        Check($"{name}: {want["status"]}, with the {kind}", () =>
        {
            var result = Verifier.Verify(bytes, trust, new FileKey(kind, (string)value!), out _);
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
        var (payload, _) = trust.Jws(File.ReadAllText(Path.Combine(dir, (string)answer["file"]!)).Trim(), Oids.Status, "time");
        var file = digests[(string)answer["for"]!];
        Count("JWS verified");
        return (string?)payload["nonce"] != (string?)answer["nonce"] ? "nonce"
            : (string?)payload["digest"] != Util.B64Url(file.D) ? "digest"
            : (string?)payload["code"] != file.Code ? "code"
            : (string?)payload["serial"] != (string?)answer["serial"] ? "serial"
            : (string?)payload["status"] != (string?)answer["status"] ? "status"
            : Util.B64UrlDecode((string)payload["nonce"]!).Length < 16 ? "nonce shorter than 16 bytes" : null;
    });
foreach (var receipt in expected["confirmationReceipts"]!.AsArray().Select(a => a!.AsObject()))
    Check($"{receipt["file"]}: a confirmation receipt for {receipt["for"]}", () =>
    {
        var (payload, _) = trust.Jws(File.ReadAllText(Path.Combine(dir, (string)receipt["file"]!)).Trim(), Oids.Confirmation, "time");
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

// The QR form (6.9.7).
foreach (var qr in expected["qr"]!.AsArray().Select(a => a!.AsObject()))
    Check($"{qr["file"]}: a COSE_Sign1 signed with the publisher's key, matching {qr["for"]}", () =>
    {
        var text = File.ReadAllText(Path.Combine(dir, (string)qr["file"]!)).Trim();
        var block = Verifier.ReadBlock(File.ReadAllBytes(Path.Combine(dir, (string)qr["for"]!)))!;
        var certificate = Der.Parse(block.Signatures.Single(s => s.Role == "publisher").Certificates[0]);
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
Check("log/checkpoint.txt: signed by the test log key; leaves.json and the proofs agree with it and with the blocks", () =>
{
    var checkpoint = File.ReadAllText(Path.Combine(dir, "log", "checkpoint.txt"));
    var (size, root) = trust.Checkpoint(checkpoint) ?? throw new InvalidOperationException("checkpoint does not verify");
    var leaves = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "log", "leaves.json")))!.AsObject();
    var entries = leaves["entries"]!.AsArray();
    if (size != entries.Count || size != (int)expected["log"]!["treeSize"]! || Convert.ToBase64String(root) != (string?)leaves["rootHash"]) return "tree size or root";
    foreach (var entry in entries.Select(e => e!.AsObject()))
    {
        var file = (string)entry["file"]!;
        var role = (string)entry["role"]!;
        var proof = File.ReadAllBytes(Path.Combine(dir, "log", $"{Path.GetFileNameWithoutExtension(file)}.{role}.proof.txt"));
        var block = Verifier.ReadBlock(File.ReadAllBytes(Path.Combine(dir, file)))!;
        if (!block.Signatures.Single(s => s.Role == role).LogReceipt.AsSpan().SequenceEqual(proof)) return $"{file} {role}: the proof file differs from the block's receipt";
        if (Convert.ToBase64String(SHA256.HashData(block.Signed)) != (string?)entry["leaf"]) return $"{file}: leaf";
        if (trust.Receipt(proof, block.Signed) != (int)entry["index"]!) return $"{file} {role}: receipt";
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
    public const string Arc = "2.25.75298837481848457984537899361864557046";
    public const string Policy = Arc + ".1";
    public const string DocumentSigning = Arc + ".2";
    public const string Status = Arc + ".3";
    public const string Confirmation = Arc + ".4";
    public const string PublisherKind = Arc + ".5";
    public const string TimeStamping = "1.3.6.1.5.5.7.3.8";
    public const string P256 = "1.2.840.10045.3.1.7";
    public const string P384 = "1.3.132.0.34";
    public const string EcdsaSha256 = "1.2.840.10045.4.3.2";
    public const string EcdsaSha384 = "1.2.840.10045.4.3.3";
    public const string Sha256 = "2.16.840.1.101.3.4.2.1";
}

sealed record FileKey(string Kind, string Text);

sealed record Signature(string Algorithm, byte[] Value, List<byte[]> Certificates, string Role, byte[] Timestamp, byte[] LogReceipt);

sealed record Block(byte[] Signed, List<Signature> Signatures, byte[] Facts, string Status, long B, Trailer Trailer, int End);

sealed record SignedDocument(uint Version, byte[] FileId, byte[] FileDigest, string Code, string Kind, byte[] FactsDigest, List<string> Algorithms, string Credential, long SignedAt);

sealed record Trailer(long HeaderOffset, int HeaderLength, long KeySlotsOffset, int KeySlotsLength, long SignatureOffset, int SignatureLength);

/// <summary>What the verifier trusts: the built-in roots, the log's key, the revocation list it holds, and its clock.</summary>
sealed class Trust(List<Der> roots, string logVerifierKey, DateTimeOffset now)
{
    public DateTimeOffset Now => now;
    public Dictionary<string, DateTimeOffset> Revoked { get; } = new();
    private readonly (string Name, byte[] Id, ECDsa Key) _log = ParseVerifierKey(logVerifierKey);

    /// <summary>name+hex(key id)+base64(0x02 || SPKI): a C2SP signed-note ECDSA verifier key.</summary>
    private static (string, byte[], ECDsa) ParseVerifierKey(string vkey)
    {
        var parts = vkey.Split('+', 3);
        var raw = Convert.FromBase64String(parts[2]);
        if (raw[0] != 0x02) throw new InvalidOperationException("Not an ECDSA (0x02) verifier key");
        var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(raw.AsSpan(1), out _);
        var id = SHA256.HashData(raw.AsSpan(1))[..4];
        if (Convert.ToHexString(id).ToLowerInvariant() != parts[1]) throw new InvalidOperationException("Verifier key id");
        return (parts[0], id, key);
    }

    /// <summary>
    /// A chain as a block or a JWS carries it: the signer's certificate, then its issuing certificate (6.9.4). Problem:
    /// something outside the profile. Trusted: the issuing certificate is signed by a trusted root.
    /// </summary>
    public (bool Trusted, string? Problem, Der Leaf, Der Issuing, Der? Root) Chain(List<byte[]> ders, string eku)
    {
        if (ders.Count != 2) return (false, "the chain is not a leaf and its issuing certificate", null!, null!, null);
        Der leaf, issuing;
        try
        {
            leaf = Der.Parse(ders[0]);
            issuing = Der.Parse(ders[1]);
        }
        catch (Exception error)
        {
            return (false, $"not a certificate of the profile: {error.Message}", null!, null!, null);
        }
        var problem = Profile.Check(leaf, Profile.Role.Leaf, eku) ?? Profile.Check(issuing, Profile.Role.Issuing, null);
        if (problem is not null) return (false, problem, leaf, issuing, null);
        if (!leaf.Issuer.AsSpan().SequenceEqual(issuing.Subject) || !Profile.SignedBy(leaf, issuing))
            return (false, "the leaf is not signed by the issuing certificate", leaf, issuing, null);
        var root = roots.FirstOrDefault(r => issuing.Issuer.AsSpan().SequenceEqual(r.Subject) && Profile.SignedBy(issuing, r));
        if (root is null) return (false, null, leaf, issuing, null);
        problem = Profile.Check(root, Profile.Role.Root, null);
        return (problem is null, problem, leaf, issuing, root);
    }

    public static bool ValidAt(Der c, DateTimeOffset t) => t >= c.NotBefore && t <= c.NotAfter;

    /// <summary>An RFC 3161 token over SHA-256(value) from a trusted time-stamping certificate (6.9.5): the time it proves.</summary>
    public DateTimeOffset? Timestamp(byte[] token, byte[] value)
    {
        if (token.Length == 0 || !Rfc3161TimestampToken.TryDecode(token, out var decoded, out var used) || used != token.Length) return null;
        if (decoded.TokenInfo.HashAlgorithmId.Value != Oids.Sha256) return null;
        if (!decoded.VerifySignatureForHash(SHA256.HashData(value), HashAlgorithmName.SHA256, out var signer, null) || signer is null) return null;
        var tsa = Der.Parse(signer.RawData);
        var issuing = decoded.AsSignedCms().Certificates.Cast<X509Certificate2>().Select(c => Der.Parse(c.RawData))
            .FirstOrDefault(c => c.Subject.AsSpan().SequenceEqual(tsa.Issuer));
        if (issuing is null) return null;
        var chain = Chain([tsa.Raw, issuing.Raw], Oids.TimeStamping);
        var at = decoded.TokenInfo.Timestamp;
        return chain.Trusted && ValidAt(chain.Leaf, at) && ValidAt(chain.Issuing, at) && ValidAt(chain.Root!, at) ? at : null;
    }

    /// <summary>A compact JWS (ES256, x5c) from a trusted certificate with this extended key usage, valid at the payload's time.</summary>
    public (JsonObject Payload, Der Signer) Jws(string jws, string eku, string timeField)
    {
        var parts = jws.Split('.');
        if (parts.Length != 3) throw new InvalidOperationException("not a compact JWS");
        var header = JsonNode.Parse(Util.B64UrlDecode(parts[0]))!.AsObject();
        if ((string?)header["alg"] != "ES256") throw new InvalidOperationException("alg");
        var chain = Chain(header["x5c"]!.AsArray().Select(c => Convert.FromBase64String((string)c!)).ToList(), eku);
        if (!chain.Trusted) throw new InvalidOperationException($"x5c: {chain.Problem ?? "not trusted"}");
        using var key = chain.Leaf.Key();
        byte[] input = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]), signature = Util.B64UrlDecode(parts[2]);
        if (!key.VerifyData(input, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
            throw new InvalidOperationException("signature");
        var payload = JsonNode.Parse(Util.B64UrlDecode(parts[1]))!.AsObject();
        var at = Util.At((string)payload[timeField]!);
        if (!ValidAt(chain.Leaf, at) || !ValidAt(chain.Issuing, at) || at > now) throw new InvalidOperationException("time");
        return (payload, chain.Leaf);
    }

    /// <summary>A C2SP checkpoint signed by the log: its tree size and root hash.</summary>
    public (long Size, byte[] Root)? Checkpoint(string note)
    {
        var split = note.IndexOf("\n\n", StringComparison.Ordinal);
        if (split < 0) return null;
        var body = note[..(split + 1)];
        var verified = false;
        foreach (var line in note[(split + 2)..].Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var fields = line.Split(' ');
            if (fields.Length != 3 || fields[0] != "—" || fields[1] != _log.Name) continue;
            var raw = Convert.FromBase64String(fields[2]);
            if (!raw.AsSpan(0, 4).SequenceEqual(_log.Id)) continue;
            byte[] data = Encoding.UTF8.GetBytes(body), signature = raw[4..];
            verified |= _log.Key.VerifyData(data, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        }
        var lines = body.TrimEnd('\n').Split('\n');
        if (!verified || lines.Length < 3 || lines[0] != _log.Name) return null;
        return (long.Parse(lines[1], NumberStyles.None, CultureInfo.InvariantCulture), Convert.FromBase64String(lines[2]));
    }

    /// <summary>A receipt in the C2SP tlog-proof@v1 form for the leaf SHA-256(signed): the index it proves, or -1.</summary>
    public long Receipt(byte[] receipt, byte[] signed)
    {
        var text = Encoding.UTF8.GetString(receipt);
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
        var checkpoint = Checkpoint(text[pos..]);
        if (checkpoint is null) return -1;
        var (size, root) = checkpoint.Value;
        return Merkle.Verify(index, size, SHA256.HashData([0x00, .. SHA256.HashData(signed)]), proof, root) ? index : -1;
    }
}

/// <summary>
/// A certificate read with a small, strict DER parser (no general X.509 processing, as 6.9.4 allows). Not
/// X509Certificate2: on Windows, CryptoAPI can't hold an extension OID with a 128-bit arc, as the 2.25 test arc has.
/// </summary>
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
        if (tbs.PeekTag().HasSameClassAndValue(versionTag))
        {
            var v = tbs.ReadSequence(versionTag);
            version = (int)v.ReadInteger() + 1;
        }
        var serial = tbs.ReadIntegerBytes().ToArray();
        var inner = tbs.ReadSequence();
        if (inner.ReadObjectIdentifier() != signatureAlgorithm) throw new InvalidOperationException("signature algorithms differ");
        var issuer = tbs.ReadEncodedValue().ToArray();
        var validity = tbs.ReadSequence();
        DateTimeOffset Time() => validity.PeekTag().HasSameClassAndValue(Asn1Tag.UtcTime) ? validity.ReadUtcTime() : validity.ReadGeneralizedTime();
        var notBefore = Time();
        var notAfter = Time();
        var subject = tbs.ReadEncodedValue().ToArray();
        var spki = tbs.ReadEncodedValue().ToArray();
        var spkiReader = new AsnReader(spki, rules).ReadSequence();
        var keyAlgorithm = spkiReader.ReadSequence();
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

    /// <summary>The subject's attributes, by OID (each RDN a single attribute).</summary>
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
    public enum Role { Root, Issuing, Leaf }

    /// <summary>The key usage bits set (bit 0 digitalSignature, 5 keyCertSign, 6 cRLSign).</summary>
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

    public static string? Check(Der c, Role role, string? eku)
    {
        if (c.Version != 3) return "not X.509 v3";
        if (c.KeyAlgorithm != "1.2.840.10045.2.1" || c.Curve != (role == Role.Root ? Oids.P384 : Oids.P256)) return "key";
        if (c.SignatureAlgorithm != (role == Role.Leaf ? Oids.EcdsaSha256 : Oids.EcdsaSha384)) return "signature algorithm";
        var basic = c.Extension("2.5.29.19");
        var ca = false;
        int? pathLength = null;
        if (basic is { } b)
        {
            var seq = new AsnReader(b.Value, AsnEncodingRules.DER).ReadSequence();
            if (seq.HasData && seq.PeekTag().HasSameClassAndValue(Asn1Tag.Boolean)) ca = seq.ReadBoolean();
            if (seq.HasData) pathLength = (int)seq.ReadInteger();
        }
        var usage = c.Extension("2.5.29.15") is { } u ? KeyUsage(u.Value) : null;
        var extended = c.Extension("2.5.29.37");
        if (role == Role.Leaf)
        {
            if (ca) return "a leaf that is a CA";
            if (usage is null || !usage.SetEquals([0])) return "key usage";
            if (extended is null || OidSequence(extended.Value.Value, false) is not [var only] || only != eku) return "extended key usage";
            if (eku == Oids.TimeStamping && !extended.Value.Critical) return "id-kp-timeStamping not critical";
        }
        else
        {
            if (basic is not { Critical: true } || !ca || pathLength != (role == Role.Root ? 1 : 0)) return "basic constraints";
            if (usage is null || !usage.SetEquals([5, 6])) return "key usage";
            if (extended is not null) return "a CA with an extended key usage";
        }
        if (c.Extension("2.5.29.32") is not { } policies || !OidSequence(policies.Value, true).Contains(Oids.Policy)) return "certificate policy";
        foreach (var e in c.Extensions)
            if (e.Critical && e.Oid is not ("2.5.29.19" or "2.5.29.15" or "2.5.29.37")) return $"unknown critical extension {e.Oid}";
        return null;
    }

    /// <summary>Whether the issuer's key signed the certificate.</summary>
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
        if (c.Extension("2.5.29.17") is { } san)
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

/// <summary>The verifying steps of 6.9.8.</summary>
static class Verifier
{
    public static Trailer? ReadTrailer(byte[] f, int end)
    {
        if (end < 64 + 44 || end > f.Length) return null;
        var t = f.AsSpan(end - 44, 44);
        if (!t[40..].SequenceEqual("JZM1"u8) || Util.Crc32(t[..36]) != BinaryPrimitives.ReadUInt32LittleEndian(t[36..])) return null;
        var trailer = new Trailer((long)BinaryPrimitives.ReadUInt64LittleEndian(t), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[8..]),
            (long)BinaryPrimitives.ReadUInt64LittleEndian(t[12..]), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[20..]),
            (long)BinaryPrimitives.ReadUInt64LittleEndian(t[24..]), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[32..]));
        var last = Math.Max(trailer.HeaderOffset + trailer.HeaderLength, trailer.SignatureOffset + trailer.SignatureLength);
        return trailer.HeaderOffset >= 64 && last == end - 44 ? trailer : null; // 4.2
    }

    /// <summary>
    /// Step 1: the block before the header. A file that doesn't end with a valid trailer is looked at through its last
    /// valid one (as 11.2 recovers appended files), with the bytes after it noted.
    /// </summary>
    public static (Block? Block, string? Problem, bool BytesAfter) FindBlock(byte[] f)
    {
        var end = f.Length;
        var t = ReadTrailer(f, end);
        for (var e = f.Length - 1; t is null && e >= 64 + 44; e--)
            if ((t = ReadTrailer(f, e)) is not null) end = e;
        if (t is null) return (null, null, false);
        var h = (int)t.HeaderOffset;
        if (h < 64 + 16 || !f.AsSpan(h - 4, 4).SequenceEqual("JZPS"u8)) return (null, null, end != f.Length);
        var footer = f.AsSpan(h - 16, 16);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(footer);
        var b = (long)h - 16 - length;
        if (b < 64) return (null, "the block starts inside the preamble", end != f.Length);
        if (BinaryPrimitives.ReadUInt16LittleEndian(footer[8..]) != 1 || BinaryPrimitives.ReadUInt16LittleEndian(footer[10..]) != 0) return (null, "block version", end != f.Length);
        var payload = f.AsSpan((int)b, (int)length);
        if (Util.Crc32(payload) != BinaryPrimitives.ReadUInt32LittleEndian(footer[4..])) return (null, "block CRC", end != f.Length);
        var fields = Pb.Parse(payload);
        var signatures = fields.Where(x => x.Field == 2).Select(x =>
        {
            var s = Pb.Parse(x.Data);
            return new Signature(Pb.Text(s, 1), Pb.Bytes(s, 2), s.Where(y => y.Field == 3).Select(y => y.Data).ToList(), Pb.Text(s, 4), Pb.Bytes(s, 5), Pb.Bytes(s, 6));
        }).ToList();
        return (new Block(Pb.Bytes(fields, 1), signatures, Pb.Bytes(fields, 3), Pb.Text(fields, 4), b, t, end), null, end != f.Length);
    }

    public static Block? ReadBlock(byte[] f) => FindBlock(f).Block;

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

    public static JsonObject Verify(byte[] f, Trust trust, FileKey? key, out (byte[] D, string Code, byte[] FactsDigest, byte[] Leaf)? info)
    {
        info = null;
        // 1. the block, and that the bytes after B are the block, the header and the signature section
        var (block, problem, bytesAfter) = FindBlock(f);
        if (problem is not null) return Result("invalid", "block");
        if (block is null) return Result("none", null);
        if (bytesAfter) return Result("changed", "after-trailer");
        var t = block.Trailer;
        var trailerStart = block.End - 44;
        var headerEnd = t.HeaderOffset + t.HeaderLength;
        if (t.SignatureLength > 0 ? headerEnd != t.SignatureOffset || t.SignatureOffset + t.SignatureLength != trailerStart : headerEnd != trailerStart)
            return Result("changed", "coverage");
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
        // 2. D and the file id
        var d = SHA256.HashData([
            .. "JAZMIN/1/publisher-file"u8, .. f.AsSpan(8, 16), .. SHA256.HashData(f.AsSpan(0, (int)block.B)),
            .. SHA256.HashData(f.AsSpan((int)t.HeaderOffset, t.HeaderLength)),
            .. SHA256.HashData(t.SignatureLength > 0 ? f.AsSpan((int)t.SignatureOffset, t.SignatureLength) : ReadOnlySpan<byte>.Empty)]);
        if (!signed.FileId.AsSpan().SequenceEqual(f.AsSpan(8, 16)) || !signed.FileDigest.AsSpan().SequenceEqual(d)) return Result("changed", "digest");
        info = (d, signed.Code, signed.FactsDigest, SHA256.HashData(block.Signed));
        // 3. the algorithms, and each signature this reader knows
        if (!block.Signatures.Select(s => s.Algorithm).ToHashSet().SetEquals(signed.Algorithms)) return Result("invalid", "algorithms");
        if (block.Signatures.Count(s => s.Role == "publisher") != 1 || block.Signatures.Any(s => s.Role is not ("publisher" or "cosigner"))) return Result("invalid", "block");
        var known = block.Signatures.Where(s => s.Algorithm == "ES256").ToList();
        if (known.All(s => s.Role != "publisher")) return Result("invalid", "algorithms");
        var chains = new List<(Signature Sig, bool Trusted, Der Leaf, Der Issuing, Der? Root)>();
        foreach (var s in known)
        {
            var chain = trust.Chain(s.Certificates, Oids.DocumentSigning);
            if (chain.Problem is not null) return Result("invalid", "chain");
            using var publicKey = chain.Leaf.Key();
            byte[] message = [.. "JAZMIN/1/publisher"u8, .. block.Signed];
            if (!publicKey.VerifyData(message, s.Value, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                return Result("invalid", "signature");
            chains.Add((s, chain.Trusted, chain.Leaf, chain.Issuing, chain.Root));
        }
        // 4. a chain that doesn't end in a trusted root gives "signed", with no name
        if (chains.Any(c => !c.Trusted)) return Result("signed", null);
        var times = new Dictionary<Signature, DateTimeOffset>();
        foreach (var c in chains)
        {
            if (trust.Timestamp(c.Sig.Timestamp, c.Sig.Value) is not { } at) return Result("invalid", "timestamp");
            if (!Trust.ValidAt(c.Leaf, at) || !Trust.ValidAt(c.Issuing, at) || !Trust.ValidAt(c.Root!, at)) return Result("invalid", "validity");
            if (trust.Receipt(c.Sig.LogReceipt, block.Signed) < 0) return Result("invalid", "log-receipt");
            times[c.Sig] = at;
        }
        var publisher = chains.Single(c => c.Sig.Role == "publisher");
        var signedAt = times[publisher.Sig];
        // 5. revocation: the status in the block, then the revocation list held
        JsonObject? answer = null;
        if (block.Status.Length > 0)
        {
            try
            {
                answer = trust.Jws(block.Status, Oids.Status, "time").Payload;
            }
            catch (Exception)
            {
                return Result("invalid", "status");
            }
            if ((string?)answer["digest"] != Util.B64Url(d) || (string?)answer["nonce"] != Util.B64Url(d) || (string?)answer["code"] != signed.Code
                || (string?)answer["serial"] != publisher.Leaf.SerialHex)
                return Result("invalid", "status");
            if ((string?)answer["status"] == "revoked" && (answer["from"] is null || Util.At((string)answer["from"]!) <= signedAt)) return Result("invalid", "revoked");
        }
        foreach (var c in chains)
            if (trust.Revoked.TryGetValue(c.Leaf.SerialHex, out var from) && from <= times[c.Sig]) return Result("invalid", "revoked");
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
        result["cosigners"] = new JsonArray(chains.Where(c => c.Sig.Role == "cosigner").Select(c => (JsonNode)Profile.Identity(c.Leaf)).ToArray());
        result["facts"] = facts;
        result["factsNeedKey"] = encrypted;
        if (answer is not null) result["statusAnswer"] = new JsonObject { ["status"] = answer["status"]!.DeepClone(), ["from"] = answer["from"]?.DeepClone() };
        result["reason"] = null;
        return result;
    }
}

/// <summary>The facts of an encrypted file: decrypted with the header's key derivation and "publisher/facts" (6.9.3).</summary>
static class Facts
{
    public static byte[] Decrypt(byte[] f, Trailer t, byte[] stored, FileKey key)
    {
        var salt = f.AsSpan(24, 32).ToArray();
        var flags = BinaryPrimitives.ReadUInt16LittleEndian(f.AsSpan(4));
        byte[] ikm;
        if ((flags & 4) != 0)
        {
            var secret = key.Kind switch
            {
                "ownerKey" or "key" => Util.ParseKey(key.Text),
                "accessKey" => Util.ParseAccessKey(key.Text),
                _ => throw new InvalidOperationException("an access-controlled file needs the owner key or an access key"),
            };
            ikm = HeaderSecret(f, t, secret);
        }
        else if ((flags & 2) != 0)
        {
            if (key.Kind != "password") throw new InvalidOperationException("a password file needs its password");
            ikm = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(key.Text), salt, (int)BinaryPrimitives.ReadUInt32LittleEndian(f.AsSpan(56)), HashAlgorithmName.SHA256, 32);
        }
        else ikm = Util.ParseKey(key.Text);
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

    /// <summary>H, from the key's slot (7.6.4): the key-slot list, its page (checked against its digest), the sealed bundle.</summary>
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

/// <summary>RFC 9162 section 2.1.3.2: verifying an inclusion proof.</summary>
static class Merkle
{
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
                if ((fn & 1) == 0)
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

/// <summary>The QR form (6.9.7): "JZ1:" + Base45(zlib(COSE_Sign1)), ES256, key identifier SHA-256(certificate)[0..8].</summary>
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

    /// <summary>The 32 bytes of a "jzk1-" key, its checksum checked (7.2).</summary>
    public static byte[] ParseKey(string text)
    {
        var raw = B64UrlDecode(text["jzk1-".Length..]);
        if (raw.Length != 36 || !SHA256.HashData(raw.AsSpan(0, 32))[..4].AsSpan().SequenceEqual(raw.AsSpan(32))) throw new InvalidOperationException("key checksum");
        return raw[..32];
    }

    /// <summary>The secret of a "jza1-" access key, its checksum checked (7.6.1).</summary>
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
