#:project ../src/Jazmin/Jazmin.csproj
#:package System.Security.Cryptography.Pkcs@10.0.13
#:package System.Formats.Cbor@10.0.13
#:property PublishAot=false
// Writes the test vectors for publisher signatures (spec 6.9) into spec/fixtures/publisher: a TEST PKI, signed files,
// damaged ones, status answers, a revocation list, a confirmation receipt, a transparency log and expected.json.
// Every key it makes is for tests only. Check the result with dotnet/scripts/publisher-verify.cs.
//
//   dotnet run -c Release dotnet/scripts/publisher-vectors.cs               keeps the certificates in pki/ when they exist
//   dotnet run -c Release dotnet/scripts/publisher-vectors.cs -- --new-pki  makes them again
//
// Keys come from fixed seeds, so they are the same on every run. ECDSA signatures, and the file ids, salts and nonces
// the library writes, are random: the fixtures' bytes change on every run, their expected results don't.
using System.Buffers.Binary;
using System.Formats.Asn1;
using System.Formats.Cbor;
using System.Globalization;
using System.IO.Compression;
using System.Numerics;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin;

var repo = Util.FindRepo();
var outDir = Path.Combine(repo, "spec", "fixtures", "publisher");
var newPki = args.Contains("--new-pki");
foreach (var sub in new[] { "pki", "test-keys", "status", "log" }) Directory.CreateDirectory(Path.Combine(outDir, sub));
foreach (var old in Directory.GetFiles(outDir, "*.jzm").Concat(Directory.GetFiles(outDir, "*.qr.txt"))
             .Concat(Directory.GetFiles(Path.Combine(outDir, "status"))).Concat(Directory.GetFiles(Path.Combine(outDir, "log"))))
    File.Delete(old);
if (newPki)
    foreach (var old in Directory.GetFiles(Path.Combine(outDir, "pki")).Concat(Directory.GetFiles(Path.Combine(outDir, "test-keys"))))
        File.Delete(old);
var tmp = Directory.CreateTempSubdirectory("jazmin-publisher-").FullName;

// ---- the TEST PKI (spec 6.9.4) --------------------------------------------------------------------------------------
var pki = new Pki(Path.Combine(outDir, "pki"), Path.Combine(outDir, "test-keys"), newPki);
DateTimeOffset At(string iso) => Util.At(iso);
X500DistinguishedName Sable() => Util.Dn("Sable Line Logistics (Pty) Ltd", "Sable Line Logistics (Pty) Ltd", "NTRZA-2020/123456/07");
var rootName = Util.Dn("JAZMIN Test Root CA (TEST ONLY)", "JAZMIN test vectors");
var root2Name = Util.Dn("JAZMIN Test Root CA 2 (TEST ONLY)", "JAZMIN test vectors");
var root = pki.Make("test-root", rootName, true, null, At("2025-01-01T00:00:00Z"), At("2044-12-31T23:59:59Z"), Pki.Ca(2));
var issuing = pki.Make("test-issuing", Util.Dn("JAZMIN Test Issuing CA 1 (TEST ONLY)", "JAZMIN test vectors"), false, root,
    At("2025-01-01T00:00:00Z"), At("2027-12-31T23:59:59Z"), Pki.Ca(0));
// A new root, not built into readers: trusted through a cross-certificate the trusted root signs.
var root2 = pki.Make("test-root-2", root2Name, true, null, At("2026-06-01T00:00:00Z"), At("2046-05-31T23:59:59Z"), Pki.Ca(2));
var cross2 = pki.Make("test-root-2-cross", root2Name, true, root, At("2026-06-01T00:00:00Z"), At("2036-05-31T23:59:59Z"), Pki.Ca(2), keyName: "test-root-2");
var issuing2 = pki.Make("test-issuing-2", Util.Dn("JAZMIN Test Issuing CA 2 (TEST ONLY)", "JAZMIN test vectors"), false, root2,
    At("2026-06-01T00:00:00Z"), At("2028-05-31T23:59:59Z"), Pki.Ca(0));
var sable = pki.Make("sable-line-logistics", Sable(), false, issuing,
    At("2026-01-01T00:00:00Z"), At("2026-12-31T23:59:59Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "sable.example"));
var sable2025 = pki.Make("sable-line-logistics-2025", Sable(), false, issuing,
    At("2025-01-01T00:00:00Z"), At("2025-12-31T23:59:59Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "sable.example"));
var sablePayroll = pki.Make("sable-line-logistics-payroll", Sable(), false, issuing,
    At("2026-03-01T00:00:00Z"), At("2027-02-28T23:59:59Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "sable.example"));
var sableRoot2 = pki.Make("sable-line-logistics-root-2", Sable(), false, issuing2,
    At("2026-07-01T00:00:00Z"), At("2027-06-30T23:59:59Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "sable.example"));
var thandi = pki.Make("tm-bookkeeping", Util.Dn("Thandi Mokoena", "TM Bookkeeping"), false, issuing,
    At("2026-02-01T00:00:00Z"), At("2027-01-31T23:59:59Z"), Pki.Leaf(Oids.DocumentSigning, false, "individual", null));
var auditor = pki.Make("khumalo-partners", Util.Dn("Khumalo & Partners Incorporated", "Khumalo & Partners Incorporated", "NTRZA-2011/004321/21"), false, issuing,
    At("2026-01-01T00:00:00Z"), At("2026-12-31T23:59:59Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "khumalo-audit.example"));
var statusCert = pki.Make("test-status", Util.Dn("JAZMIN Test Status 1 (TEST ONLY)", "JAZMIN test vectors"), false, issuing,
    At("2025-01-01T00:00:00Z"), At("2027-12-31T23:59:59Z"), Pki.Leaf(Oids.Status, false, null, null));
var confirmCert = pki.Make("test-confirmation", Util.Dn("JAZMIN Test Confirmation 1 (TEST ONLY)", "JAZMIN test vectors"), false, issuing,
    At("2026-01-01T00:00:00Z"), At("2026-12-31T23:59:59Z"), Pki.Leaf(Oids.Confirmation, false, null, null));
var logCert = pki.Make("test-log", Util.Dn("JAZMIN Test Log 1 (TEST ONLY)", "JAZMIN test vectors"), false, issuing,
    At("2025-01-01T00:00:00Z"), At("2027-12-31T23:59:59Z"), Pki.Leaf(Oids.Log, false, null, null));
var tsa = pki.Make("test-timestamping", Util.Dn("JAZMIN Test Time-Stamping 1 (TEST ONLY)", "JAZMIN test vectors"), false, issuing,
    At("2025-01-01T00:00:00Z"), At("2027-12-31T23:59:59Z"), Pki.Leaf(Oids.TimeStamping, true, null, null));
// Someone else's PKI that copies Sable Line Logistics' name: a self-signed root, an issuing CA and a leaf.
var fakeRoot = pki.Make("untrusted-root", Sable(), true, null, At("2026-01-01T00:00:00Z"), At("2036-01-01T00:00:00Z"), Pki.Ca(2));
var fakeIssuing = pki.Make("untrusted-issuing", Util.Dn("Sable Line Logistics Issuing CA", "Sable Line Logistics (Pty) Ltd"), false, fakeRoot,
    At("2026-01-01T00:00:00Z"), At("2028-01-01T00:00:00Z"), Pki.Ca(0));
var fakeSable = pki.Make("untrusted-sable-line-logistics", Sable(), false, fakeIssuing,
    At("2026-01-01T00:00:00Z"), At("2027-01-01T00:00:00Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "sable.example"));
// A cross-certificate from a root that isn't trusted, though it has the trusted root's name.
var fakeTestRoot = pki.Make("untrusted-test-root", rootName, true, null, At("2026-01-01T00:00:00Z"), At("2036-01-01T00:00:00Z"), Pki.Ca(2));
var fakeRoot2 = pki.Make("untrusted-root-2", root2Name, true, null, At("2026-06-01T00:00:00Z"), At("2036-05-31T23:59:59Z"), Pki.Ca(2));
var fakeCross = pki.Make("untrusted-root-2-cross", root2Name, true, fakeTestRoot, At("2026-06-01T00:00:00Z"), At("2036-05-31T23:59:59Z"), Pki.Ca(2),
    keyName: "untrusted-root-2");
var fakeIssuing2 = pki.Make("untrusted-issuing-2", Util.Dn("JAZMIN Test Issuing CA 2 (TEST ONLY)", "JAZMIN test vectors"), false, fakeRoot2,
    At("2026-06-01T00:00:00Z"), At("2028-05-31T23:59:59Z"), Pki.Ca(0));
var fakeSable2 = pki.Make("untrusted-sable-line-logistics-2", Sable(), false, fakeIssuing2,
    At("2026-07-01T00:00:00Z"), At("2027-06-30T23:59:59Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "sable.example"));
// Signing with one's own key: a self-signed publisher certificate, alone.
var selfSigned = pki.Make("self-signed-sable-line-logistics", Sable(), false, null,
    At("2026-01-01T00:00:00Z"), At("2027-01-01T00:00:00Z"), Pki.Leaf(Oids.DocumentSigning, false, "company", "sable.example"));

// ---- the files' keys (tests only) ------------------------------------------------------------------------------------
var password = "Sable-Payroll-2026!";
var masterKey = JazminKey.Parse(Util.KeyText(Util.Seed("jazmin-key/annual-statements", 32)));
var ownerKey = JazminKey.Parse(Util.KeyText(Util.Seed("jazmin-key/statement-owner", 32)));
var accessKey = new JazminAccessKey(Util.Seed("jazmin-access-key/account-4410", 32), SHA256.HashData(ownerKey.OwnerPublicKey)[..8]);

// ---- what each signed file holds -------------------------------------------------------------------------------------
var verifyAt = At("2026-10-17T12:00:00Z");
var revokedFrom = At("2026-09-15T00:00:00Z");
var sableIdentity = Util.Identity("Sable Line Logistics (Pty) Ltd", "Sable Line Logistics (Pty) Ltd", "NTRZA-2020/123456/07", "ZA", "sable.example", "company");
var identities = new Dictionary<Cert, JsonObject>
{
    [sable] = sableIdentity, [sable2025] = sableIdentity, [sablePayroll] = sableIdentity, [sableRoot2] = sableIdentity,
    [thandi] = Util.Identity("Thandi Mokoena", "TM Bookkeeping", null, "ZA", null, "individual"),
    [auditor] = Util.Identity("Khumalo & Partners Incorporated", "Khumalo & Partners Incorporated", "NTRZA-2011/004321/21", "ZA", "khumalo-audit.example", "company"),
};
Content Payslip(string recipient, string period, params (string Item, string Type, decimal Amount)[] lines) => Content.Payslip(recipient, period, lines);
Cert[] Normal() => [issuing];
var specs = new List<Spec>
{
    new("signed-plain.jzm", "A payslip, not encrypted, signed by a certified company", sable, Normal(), null, At("2026-10-01T09:00:00Z"), "none",
        Payslip("••••1234", "2026-09", ("Basic salary", "earning", 16200.00m), ("Overtime (12 h)", "earning", 2250.00m), ("PAYE", "deduction", -3317.63m),
            ("UIF", "deduction", -184.50m), ("Pension fund", "deduction", -845.50m)), "valid", "certified"),
    new("signed-password.jzm", "A payslip encrypted with a password: the facts are encrypted too (6.9.3)", sable, Normal(), null, At("2026-10-01T09:05:00Z"), "password",
        Payslip("••••5678", "2026-09", ("Basic salary", "earning", 24500.00m), ("Travel allowance", "earning", 1800.00m), ("PAYE", "deduction", -5121.40m),
            ("UIF", "deduction", -177.12m), ("Medical aid", "deduction", -2130.00m)), "valid", "certified"),
    new("signed-shared.jzm", "An access-controlled (shared) statement: the signature covers the header and the owner's signature section", sable, Normal(), null,
        At("2026-10-02T10:00:00Z"), "access", Content.Statement(), "valid", "certified"),
    new("signed-sole-trader.jzm", "An invoice from a sole trader (kind individual), no domain", thandi, Normal(), null, At("2026-10-03T14:30:00Z"), "none",
        Content.Invoice(), "valid", "certified"),
    new("signed-cosigned.jzm", "Annual financial statements encrypted with a key, signed by the company and co-signed by its auditor", sable, Normal(), auditor,
        At("2026-10-08T11:00:00Z"), "key", Content.FinancialStatements(), "valid", "certified") { CosignedAt = At("2026-10-08T15:00:00Z") },
    new("signed-paper.jzm", "A tax certificate with its QR code (6.9.7) in signed-paper.qr.txt", sable, Normal(), null, At("2026-10-10T12:00:00Z"), "none",
        Content.TaxCertificate(), "valid", "certified"),
    new("cross-certified.jzm", "Signed under a new root that readers don't have built in: the chain carries a cross-certificate the trusted root signed", sableRoot2,
        [issuing2, cross2], null, At("2026-10-06T08:00:00Z"), "none",
        Payslip("••••2468", "2026-09", ("Basic salary", "earning", 17350.00m), ("PAYE", "deduction", -3402.15m), ("UIF", "deduction", -173.50m)), "valid", "certified"),
    new("expired-certificate.jzm", "Signed in 2025 with a certificate that has since expired: the timestamp is inside its validity", sable2025, Normal(), null,
        At("2025-06-02T08:00:00Z"), "none", Payslip("••••1234", "2025-05", ("Basic salary", "earning", 15400.00m), ("PAYE", "deduction", -2990.10m),
            ("UIF", "deduction", -154.00m)), "valid", "certified"),
    new("timestamp-outside.jzm", "Signed with the 2025 certificate after it expired: the timestamp is outside its validity", sable2025, Normal(), null,
        At("2026-02-01T08:00:00Z"), "none", Payslip("••••1234", "2026-01", ("Basic salary", "earning", 16200.00m), ("PAYE", "deduction", -3105.20m),
            ("UIF", "deduction", -162.00m)), "none", "invalid") { Reason = "validity" },
    new("revoked-before.jzm", "Signed with the payroll certificate before the date it is revoked from", sablePayroll, Normal(), null, At("2026-09-01T08:00:00Z"), "none",
        Payslip("••••4321", "2026-08", ("Basic salary", "earning", 12800.00m), ("PAYE", "deduction", -1876.45m), ("UIF", "deduction", -128.00m)), "valid", "certified"),
    new("revoked.jzm", "Signed with the payroll certificate after the date it is revoked from. The status stored at signing says valid; the revocation list is more recent and wins",
        sablePayroll, Normal(), null, At("2026-10-05T08:00:00Z"), "none",
        Payslip("••••4321", "2026-09", ("Basic salary", "earning", 12800.00m), ("Bonus", "earning", 40000.00m), ("PAYE", "deduction", -13980.00m),
            ("UIF", "deduction", -177.12m)), "valid", "invalid") { Reason = "revoked" },
    new("stripped-algorithm.jzm", "Signed with ES256 and ML-DSA-65; the ML-DSA-65 signature was removed, so 'algorithms' no longer matches", sable, Normal(), null,
        At("2026-10-07T08:00:00Z"), "none", Payslip("••••7788", "2026-09", ("Basic salary", "earning", 19800.00m), ("PAYE", "deduction", -3840.00m),
            ("UIF", "deduction", -177.12m)), "valid", "invalid") { Reason = "algorithms", Algorithms = ["ES256", "ML-DSA-65"] },
    new("stripped-cosignature.jzm", "Signed by the company and co-signed by its auditor (both ES256); the co-signature was removed, so 'algorithms' no longer matches",
        sable, Normal(), auditor, At("2026-10-08T12:00:00Z"), "none",
        Payslip("••••1357", "2026-09", ("Basic salary", "earning", 21000.00m), ("PAYE", "deduction", -4200.00m), ("UIF", "deduction", -177.12m)), "valid", "invalid")
    { CosignedAt = At("2026-10-08T16:00:00Z"), StripCosigner = true, Reason = "algorithms" },
    new("superseded.jzm", "A payslip its publisher replaced: the status at signing says superseded", sable, Normal(), null, At("2026-10-09T08:00:00Z"), "none",
        Payslip("••••3456", "2026-09", ("Basic salary", "earning", 14100.00m), ("PAYE", "deduction", -2601.75m), ("UIF", "deduction", -141.00m)),
        "superseded", "superseded") { StatusFrom = At("2026-10-12T00:00:00Z"), StatusTime = At("2026-10-12T09:00:00Z") },
    new("withdrawn.jzm", "A payslip issued in error: the status at signing says withdrawn", sable, Normal(), null, At("2026-10-10T08:00:00Z"), "none",
        Payslip("••••9012", "2026-09", ("Basic salary", "earning", 98000.00m), ("PAYE", "deduction", -38204.10m), ("UIF", "deduction", -177.12m)),
        "withdrawn", "withdrawn") { StatusFrom = At("2026-10-11T00:00:00Z"), StatusTime = At("2026-10-12T09:00:00Z") },
    new("untrusted-root.jzm", "Signed with a certificate naming Sable Line Logistics that chains to its own self-signed root, not a trusted one", fakeSable,
        [fakeIssuing], null, At("2026-10-08T09:00:00Z"), "none", Payslip("••••1234", "2026-09", ("Basic salary", "earning", 16200.00m),
            ("Performance bonus", "earning", 85000.00m), ("PAYE", "deduction", -38410.00m), ("UIF", "deduction", -177.12m)), "none", "signed") { Untrusted = true },
    new("cross-untrusted.jzm", "A chain with a cross-certificate signed by a root that isn't trusted, though it has the trusted root's name", fakeSable2,
        [fakeIssuing2, fakeCross], null, At("2026-10-08T09:30:00Z"), "none", Payslip("••••1234", "2026-09", ("Basic salary", "earning", 16200.00m),
            ("Retention bonus", "earning", 60000.00m), ("PAYE", "deduction", -27400.00m), ("UIF", "deduction", -177.12m)), "none", "signed") { Untrusted = true },
    new("self-signed.jzm", "Signed with one's own key: a self-signed certificate naming Sable Line Logistics, alone", selfSigned, [], null,
        At("2026-10-08T10:00:00Z"), "none", Payslip("••••1234", "2026-09", ("Basic salary", "earning", 16200.00m), ("PAYE", "deduction", -3105.20m)),
        "none", "signed") { Untrusted = true },
};

var docs = new List<Doc>();
var tokenSerial = 0;
foreach (var spec in specs)
{
    var file = spec.Content.Write(tmp, spec, password, masterKey, ownerKey, accessKey);
    var trailer = Jzm.ReadTrailer(file, file.Length) ?? throw new InvalidOperationException($"{spec.File}: no trailer");
    var digest = Jzm.FileDigest(file, trailer.HeaderOffset, trailer);
    var factsPlain = (byte[])[.. RandomNumberGenerator.GetBytes(16), .. Encoding.UTF8.GetBytes(Util.Jcs(spec.Content.Facts))];
    var factsDigest = SHA256.HashData(factsPlain);
    var factsStored = spec.Encryption == "none" ? factsPlain : Jzm.EncryptFacts(file, trailer, spec.Encryption, factsPlain, password, masterKey, ownerKey);
    var code = Util.DocumentCode(spec.File);
    string[] algorithms = spec.Algorithms ?? (spec.Cosigner is null ? ["ES256"] : ["ES256", "ES256"]); // one per signature, in order
    var signed = Proto.SignedDocument(file[8..24], digest, code, spec.Content.Kind, factsDigest, algorithms,
        Util.Credential(spec.Publisher), spec.SignedAt.ToUnixTimeMilliseconds());
    var doc = new Doc(spec, file, trailer, digest, signed, factsStored, factsDigest, code);
    doc.Sigs.Add(Sign(spec.Publisher, spec.Chain, "publisher", signed, spec.Untrusted ? null : spec.SignedAt.AddSeconds(2)));
    if (spec.Cosigner is not null)
    {
        var cosignature = Sign(spec.Cosigner, [issuing], "cosigner", signed, spec.CosignedAt!.Value.AddSeconds(2));
        if (spec.StripCosigner) doc.Stripped.Add(cosignature);
        else doc.Sigs.Add(cosignature);
    }
    if (spec.Stapled != "none")
        doc.Status = Jws.Sign(Util.StatusAnswer(digest, spec.Publisher, spec.Chain[0], code, spec.Stapled, spec.StatusFrom, spec.StatusTime ?? spec.SignedAt.AddSeconds(5), digest),
            statusCert, null); // no x5c: the block carries the status certificate
    if (!spec.Untrusted)
    {
        doc.Shared.Add(tsa);
        if (doc.Status.Length > 0) doc.Shared.Add(statusCert);
        doc.Shared.Add(logCert);
        if (!doc.Sigs.Any(s => s.Chain.Contains(issuing))) doc.Shared.Add(issuing); // the shared certificates' issuing certificate
    }
    docs.Add(doc);
}

Sig Sign(Cert signer, Cert[] chain, string role, byte[] signed, DateTimeOffset? stampAt)
{
    byte[] message = [.. "JAZMIN/1/publisher"u8, .. signed];
    var value = signer.Key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    byte[] stamp = stampAt is null ? [] : Tsa.Stamp(value, stampAt.Value, tsa, ++tokenSerial);
    return new Sig(role, signer, chain, value, stamp, stampAt);
}

// ---- the transparency log (6.9.5): an entry per signature, oldest first -------------------------------------------------
var origin = "log.jazmin.example/test";
var entries = docs.SelectMany(d => d.Sigs.Concat(d.Stripped).Where(s => s.StampedAt is not null).Select(s => (Doc: d, Sig: s)))
    .OrderBy(e => e.Sig.StampedAt).ToList();
var leaves = entries.Select(e => Merkle.Entry(e.Doc.Signed, e.Sig.Value)).ToList();
var rootHash = Merkle.Root(leaves, 0, leaves.Count);
var (checkpoint, verifierKey) = Merkle.Checkpoint(origin, leaves.Count, rootHash, logCert);
File.WriteAllText(Path.Combine(outDir, "log", "checkpoint.txt"), checkpoint);
File.WriteAllText(Path.Combine(outDir, "log", "test-log.vkey"), verifierKey + "\n");
var leafList = new JsonArray();
for (var i = 0; i < entries.Count; i++)
{
    var (doc, sig) = entries[i];
    sig.Receipt = Merkle.Proof(i, leaves, checkpoint);
    var stripped = doc.Stripped.Contains(sig);
    File.WriteAllText(Path.Combine(outDir, "log", $"{Path.GetFileNameWithoutExtension(doc.Spec.File)}.{sig.Role}.proof.txt"), sig.Receipt);
    leafList.Add(new JsonObject
    {
        ["index"] = i, ["file"] = doc.Spec.File, ["role"] = sig.Role, ["inFile"] = !stripped, ["timestamp"] = Util.Iso(sig.StampedAt!.Value),
        ["entry"] = Convert.ToBase64String(leaves[i]), ["leafHash"] = Convert.ToBase64String(Merkle.LeafHash(leaves[i])),
    });
}
Util.WriteJson(Path.Combine(outDir, "log", "leaves.json"), new JsonObject
{
    ["comment"] = "Entries of the test transparency log (6.9.5): \"JAZMIN/1/log\" || SHA-256(signed) || SHA-256(value); leaf hash SHA-256(0x00 || entry)",
    ["origin"] = origin, ["treeSize"] = leaves.Count, ["rootHash"] = Convert.ToBase64String(rootHash), ["entries"] = leafList,
});

// ---- the blocks, put into the files -----------------------------------------------------------------------------------
var finals = new Dictionary<string, byte[]>();
foreach (var doc in docs)
{
    var payload = Proto.PublisherSignatures(doc.Signed, doc.Sigs.Select(s => Proto.PublisherSignature("ES256", s.Value,
        [s.Signer.Der, .. s.Chain.Select(c => c.Der)], s.Role, s.Timestamp, s.Receipt)).ToList(), doc.FactsStored, doc.Status, doc.Shared.Select(c => c.Der).ToList());
    var bytes = Jzm.InsertBlock(doc.File, Jzm.Block(payload));
    finals[doc.Spec.File] = bytes;
    File.WriteAllBytes(Path.Combine(outDir, doc.Spec.File), bytes);
    if (doc.Status.Length > 0) File.WriteAllText(Path.Combine(outDir, "status", Path.GetFileNameWithoutExtension(doc.Spec.File) + ".status.jws"), doc.Status + "\n");
}

// ---- damaged files ----------------------------------------------------------------------------------------------------
var plainDoc = docs.Single(d => d.Spec.File == "signed-plain.jzm");
var plain = finals["signed-plain.jzm"];
var damaged = new List<(string File, string From, string Description, string Status, string? Reason, JsonObject Library)>();
void Damaged(string name, string from, byte[] bytes, string description, string status, string? reason, JsonObject library)
{
    File.WriteAllBytes(Path.Combine(outDir, name), bytes);
    damaged.Add((name, from, description, status, reason, library));
}
{
    var changed = (byte[])plain.Clone();
    var at = changed.AsSpan().IndexOf("Overtime (12 h)"u8);
    if (at < 0) throw new InvalidOperationException("signed-plain.jzm: the overtime text was not found");
    changed[at + 10] = (byte)'7';
    Jzm.FixSectionCrc(changed, at);
    Damaged("changed-byte.jzm", "signed-plain.jzm", changed,
        "One byte before B changed ('Overtime (12 h)' to 'Overtime (72 h)') and its section's CRC fixed: readers show the new text, only the signature notices",
        "changed", "digest", new JsonObject { ["reads"] = true, ["rows"] = 5, ["text"] = "Overtime (72 h)" });
}
{
    var t = Jzm.ReadTrailer(plain, plain.Length)!;
    Damaged("changed-extra-byte.jzm", "signed-plain.jzm", Jzm.InsertAt(plain, t.HeaderOffset, 0x00),
        "One byte inserted between the block and the header (trailer offsets moved): the 16 bytes before the header are no longer the block's footer, so the file shows as not signed (6.9.1)",
        "none", null, new JsonObject { ["reads"] = true, ["rows"] = 5 });
    Damaged("changed-trailing-byte.jzm", "signed-plain.jzm", [.. plain, 0x00],
        "One byte appended after the trailer: the file's last bytes are not a valid trailer, so it is not a valid file (4.2) and is not verified (6.9.1)",
        "not-verified", "not-a-valid-file", new JsonObject { ["reads"] = false });
    var crc = (byte[])plain.Clone();
    var footer = (int)t.HeaderOffset - 16;
    var b = footer - (int)BinaryPrimitives.ReadUInt32LittleEndian(crc.AsSpan(footer));
    crc[b + (footer - b) / 2] ^= 0x01; // a byte in the middle of the payload; the CRC no longer matches
    Damaged("invalid-block-crc.jzm", "signed-plain.jzm", crc,
        "One byte of the block's payload changed (the block isn't covered by D, but its CRC no longer matches): a damaged signature block (6.9.1)",
        "invalid", "block", new JsonObject { ["reads"] = true, ["rows"] = 5 });
}
{
    var shared = finals["signed-shared.jzm"];
    var t = Jzm.ReadTrailer(shared, shared.Length)!;
    Damaged("changed-gap.jzm", "signed-shared.jzm", Jzm.InsertAt(shared, t.SignatureOffset, 0x00),
        "One byte inserted between the header and the signature section of the shared file (trailer offsets moved): a byte after B that is not the block, the header or the signature section",
        "changed", "coverage", new JsonObject { ["reads"] = true, ["rows"] = 5, ["accessRows"] = 3 });
}
{
    var path = Path.Combine(tmp, "appended.jzm");
    File.WriteAllBytes(path, plain);
    JazminFile.Append(path, new JazminAppend
    {
        Insert = [new Dictionary<string, object?> { ["line"] = 6L, ["item"] = "Back pay (August)", ["type"] = "earning", ["amount"] = 500.00m }],
        Now = At("2026-10-14T08:00:00Z"),
    });
    Damaged("appended.jzm", "signed-plain.jzm", File.ReadAllBytes(path),
        "signed-plain.jzm with a row appended by the library afterwards (11.2): the new header has no block before it, so the file shows as not signed (6.9.1)",
        "none", null, new JsonObject { ["reads"] = true, ["rows"] = 6 });
}
{
    var spec = new Spec("unsigned.jzm", "A file without a block", sable, Normal(), null, At("2026-10-01T09:00:00Z"), "none",
        Payslip("••••1234", "2026-09", ("Basic salary", "earning", 16200.00m), ("PAYE", "deduction", -3105.20m)), "none", "none");
    Damaged("unsigned.jzm", "", spec.Content.Write(tmp, spec, password, masterKey, ownerKey, accessKey), "A file without a publisher signature", "none", null,
        new JsonObject { ["reads"] = true, ["rows"] = 2 });
}

// ---- status answers, the revocation list and a confirmation receipt (6.9.5) ----------------------------------------
var onlineNonce = Util.Seed("online-status-nonce", 16);
var online = Jws.Sign(Util.StatusAnswer(plainDoc.Digest, sable, issuing, plainDoc.Code, "valid", null, At("2026-10-17T11:59:00Z"), onlineNonce), statusCert, issuing);
File.WriteAllText(Path.Combine(outDir, "status", "signed-plain.online.jws"), online + "\n");
var revocationList = Jws.Sign(new JsonObject
{
    ["issued"] = "2026-10-16T00:00:00Z",
    ["next"] = "2026-10-23T00:00:00Z",
    ["revoked"] = new JsonArray(new JsonObject { ["certificate"] = Util.CertName(sablePayroll, issuing), ["from"] = Util.Iso(revokedFrom), ["reason"] = "keyCompromise" }),
}, statusCert, issuing);
File.WriteAllText(Path.Combine(outDir, "status", "revocation-list.jws"), revocationList + "\n");
var party = "First Test Bank Ltd / FTB-000173";
var receipt = Jws.Sign(new JsonObject
{
    ["party"] = party, ["digest"] = Util.B64Url(plainDoc.Digest), ["code"] = plainDoc.Code, ["facts"] = Util.B64Url(plainDoc.FactsDigest),
    ["status"] = "valid", ["time"] = "2026-10-16T10:15:00Z",
}, confirmCert, issuing);
File.WriteAllText(Path.Combine(outDir, "status", "signed-plain.confirmation.jws"), receipt + "\n");

// ---- the QR form (6.9.7) ------------------------------------------------------------------------------------------------
var paper = docs.Single(d => d.Spec.File == "signed-paper.jzm");
var qr = Qr.Make(paper.Code, paper.Spec.Content.Kind, paper.Spec.Content.Facts, paper.Spec.SignedAt.ToUnixTimeMilliseconds(), sable);
File.WriteAllText(Path.Combine(outDir, "signed-paper.qr.txt"), qr + "\n");

// ---- expected.json --------------------------------------------------------------------------------------------------------
var fixtures = new JsonArray();
foreach (var doc in docs)
{
    var s = doc.Spec;
    var trusted = s.Expected is "certified" or "withdrawn" or "superseded";
    var result = new JsonObject { ["status"] = s.Expected };
    if (trusted)
    {
        foreach (var (k, v) in identities[s.Publisher]) result[k] = v?.DeepClone();
        result["code"] = doc.Code;
        result["documentKind"] = s.Content.Kind;
        result["credential"] = Util.Credential(s.Publisher);
        result["signedAt"] = Util.Iso(s.SignedAt);
        result["timestamp"] = Util.Iso(s.SignedAt.AddSeconds(2));
        result["cosigners"] = new JsonArray(doc.Sigs.Where(g => g.Role == "cosigner").Select(g => (JsonNode)identities[g.Signer].DeepClone()).ToArray());
        result["facts"] = s.Content.Facts.DeepClone();
        result["factsNeedKey"] = s.Encryption != "none";
        if (s.Stapled != "none") result["statusAnswer"] = new JsonObject { ["status"] = s.Stapled, ["from"] = s.StatusFrom is null ? null : Util.Iso(s.StatusFrom.Value) };
    }
    else
    {
        foreach (var k in new[] { "name", "kind", "code", "facts" }) result[k] = null;
    }
    result["reason"] = s.Reason;
    fixtures.Add(new JsonObject
    {
        ["file"] = s.File,
        ["description"] = s.Description,
        ["encryption"] = s.Encryption,
        ["keys"] = Util.Keys(s.Encryption, password, masterKey, ownerKey, accessKey),
        ["fileDigest"] = Util.B64Url(doc.Digest),
        ["result"] = result,
        ["library"] = s.Encryption == "access"
            ? new JsonObject { ["reads"] = true, ["rows"] = s.Content.Rows.Count, ["accessRows"] = s.Content.Rows.Count(r => (string)r[0]! == "ACC-4410") }
            : new JsonObject { ["reads"] = true, ["rows"] = s.Content.Rows.Count },
    });
}
foreach (var d in damaged)
{
    var from = d.From.Length == 0 ? null : specs.Single(s => s.File == d.From);
    fixtures.Add(new JsonObject
    {
        ["file"] = d.File,
        ["description"] = d.Description,
        ["derivedFrom"] = d.From.Length == 0 ? null : d.From,
        ["encryption"] = from?.Encryption ?? "none",
        ["keys"] = Util.Keys(from?.Encryption ?? "none", password, masterKey, ownerKey, accessKey),
        ["result"] = new JsonObject { ["status"] = d.Status, ["name"] = null, ["kind"] = null, ["code"] = null, ["facts"] = null, ["reason"] = d.Reason },
        ["library"] = d.Library,
    });
}
var expected = new JsonObject
{
    ["comment"] = "Expected results of verifying each file (spec 6.9.8) at verifyAt, trusting only trustedRoots, holding revocationList. TEST KEYS ONLY: see README.md.",
    ["spec"] = "docs/rfc/draft-jazmin-format-03.md, section 6.9",
    ["verifyAt"] = Util.Iso(verifyAt),
    ["trustedRoots"] = new JsonArray("pki/test-root.der"),
    ["revocationList"] = "status/revocation-list.jws",
    ["log"] = new JsonObject
    {
        ["origin"] = origin, ["certificate"] = "pki/test-log.der", ["verifierKey"] = verifierKey, ["checkpoint"] = "log/checkpoint.txt", ["treeSize"] = leaves.Count,
    },
    ["oids"] = new JsonObject
    {
        ["arc"] = Oids.Arc, ["id-jazmin-policy"] = Oids.Policy, ["id-jazmin-document-signing"] = Oids.DocumentSigning, ["id-jazmin-status"] = Oids.Status,
        ["id-jazmin-confirmation"] = Oids.Confirmation, ["id-jazmin-publisher-kind"] = Oids.PublisherKind, ["id-jazmin-log"] = Oids.Log,
    },
    ["secrets"] = new JsonObject { ["password"] = password, ["key"] = masterKey.ToString(), ["ownerKey"] = ownerKey.ToString(), ["accessKey"] = accessKey.ToString() },
    ["fixtures"] = fixtures,
    ["statusAnswers"] = new JsonArray(new JsonObject
    {
        ["file"] = "status/signed-plain.online.jws", ["for"] = "signed-plain.jzm", ["nonce"] = Util.B64Url(onlineNonce), ["status"] = "valid",
        ["certificate"] = Util.CertName(sable, issuing), ["time"] = "2026-10-17T11:59:00Z",
    }),
    ["revocations"] = new JsonArray(new JsonObject
    {
        ["certificate"] = Util.CertName(sablePayroll, issuing), ["file"] = "pki/sable-line-logistics-payroll.der", ["from"] = Util.Iso(revokedFrom), ["reason"] = "keyCompromise",
    }),
    ["confirmationReceipts"] = new JsonArray(new JsonObject
    {
        ["file"] = "status/signed-plain.confirmation.jws", ["for"] = "signed-plain.jzm", ["party"] = party, ["status"] = "valid", ["time"] = "2026-10-16T10:15:00Z",
    }),
    ["qr"] = new JsonArray(new JsonObject
    {
        ["file"] = "signed-paper.qr.txt", ["for"] = "signed-paper.jzm", ["certificate"] = "pki/sable-line-logistics.der",
        ["kid"] = Convert.ToHexString(SHA256.HashData(sable.Der)[..8]).ToLowerInvariant(),
        ["payload"] = new JsonObject
        {
            ["code"] = paper.Code, ["kind"] = paper.Spec.Content.Kind, ["facts"] = paper.Spec.Content.Facts.DeepClone(),
            ["signed_at"] = paper.Spec.SignedAt.ToUnixTimeMilliseconds(),
        },
    }),
};
Util.WriteJson(Path.Combine(outDir, "expected.json"), expected);
Directory.Delete(tmp, true);
var plainBlock = (int)BinaryPrimitives.ReadUInt32LittleEndian(plain.AsSpan((int)Jzm.ReadTrailer(plain, plain.Length)!.HeaderOffset - 16)) + 16;
Console.WriteLine($"Wrote {fixtures.Count} files, {leaves.Count} log entries, the PKI and expected.json to {outDir}");
Console.WriteLine($"signed-plain.jzm: {plain.Length} bytes, of which the block (one signature) is {plainBlock}");

// =====================================================================================================================

static class Oids
{
    public const string Arc = "2.999.1"; // ITU-T X.660's arc for examples (6.9.4)
    public const string Policy = Arc + ".1";
    public const string DocumentSigning = Arc + ".2";
    public const string Status = Arc + ".3";
    public const string Confirmation = Arc + ".4";
    public const string PublisherKind = Arc + ".5";
    public const string Log = Arc + ".6";
    public const string TimeStamping = "1.3.6.1.5.5.7.3.8";
    public const string OrganizationIdentifier = "2.5.4.97";
    public const string Sha256 = "2.16.840.1.101.3.4.2.1";
    public const string TstInfo = "1.2.840.113549.1.9.16.1.4";
    public const string SigningCertificateV2 = "1.2.840.113549.1.9.16.2.47";
}

sealed class Cert(string name, ECDsa key, X509Certificate2 x)
{
    public string Name => name;
    public ECDsa Key => key;
    public X509Certificate2 X => x;
    public byte[] Der => x.RawData;
    public byte[] Spki => x.PublicKey.ExportSubjectPublicKeyInfo();
    public byte[] Ski => ((X509SubjectKeyIdentifierExtension)x.Extensions["2.5.29.14"]!).SubjectKeyIdentifierBytes.ToArray();
}

sealed class Pki(string certDir, string keyDir, bool renew)
{
    public const string KeyWarning = "TEST KEY ONLY: JAZMIN publisher signature test vectors (spec 6.9). Never trust anything signed with it.\n";
    private static readonly BigInteger N256 = BigInteger.Parse("0FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", NumberStyles.HexNumber);
    private static readonly BigInteger N384 = BigInteger.Parse("0FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC7634D81F4372DDF581A0DB248B0A77AECEC196ACCC52973", NumberStyles.HexNumber);

    /// <summary>A key from a fixed seed: d = (OS2IP(HKDF-SHA256(seed, info = "test-key/" + name)) mod (n - 1)) + 1, as 7.6.1 derives owner keys.</summary>
    public static ECDsa TestKey(string name, bool p384)
    {
        var size = p384 ? 48 : 32;
        var okm = new byte[size + 16];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, Encoding.UTF8.GetBytes(Util.SeedText), okm, ReadOnlySpan<byte>.Empty, Encoding.UTF8.GetBytes("test-key/" + name));
        var d = BigInteger.Remainder(new BigInteger(okm, isUnsigned: true, isBigEndian: true), (p384 ? N384 : N256) - 1) + 1;
        var bytes = d.ToByteArray(isUnsigned: true, isBigEndian: true);
        var fixedBytes = new byte[size];
        bytes.CopyTo(fixedBytes, size - bytes.Length);
        return ECDsa.Create(new ECParameters { Curve = p384 ? ECCurve.NamedCurves.nistP384 : ECCurve.NamedCurves.nistP256, D = fixedBytes });
    }

    public static Action<CertificateRequest> Ca(int pathLength) => r =>
    {
        r.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, pathLength, true));
        r.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
    };

    /// <summary>A leaf of the profile: basic constraints and key usage critical, one extended key usage (critical only for time-stamping).</summary>
    public static Action<CertificateRequest> Leaf(string eku, bool ekuCritical, string? kind, string? domain) => r =>
    {
        r.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        r.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        r.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid(eku) }, ekuCritical));
        if (domain is not null)
        {
            var san = new SubjectAlternativeNameBuilder();
            san.AddDnsName(domain);
            r.CertificateExtensions.Add(san.Build());
        }
        if (kind is not null)
        {
            var w = new AsnWriter(AsnEncodingRules.DER);
            w.WriteCharacterString(UniversalTagNumber.UTF8String, kind);
            r.CertificateExtensions.Add(new X509Extension(Oids.PublisherKind, w.Encode(), false));
        }
    };

    private static X509Extension Policies()
    {
        var w = new AsnWriter(AsnEncodingRules.DER);
        using (w.PushSequence())
        using (w.PushSequence())
            w.WriteObjectIdentifier(Oids.Policy);
        return new X509Extension("2.5.29.32", w.Encode(), false);
    }

    /// <summary>A certificate for the key named <paramref name="keyName"/> (default: its own name), signed by the issuer's key or self-signed.</summary>
    public Cert Make(string name, X500DistinguishedName subject, bool p384, Cert? issuer, DateTimeOffset from, DateTimeOffset to, Action<CertificateRequest> extensions,
        string? keyName = null)
    {
        var key = TestKey(keyName ?? name, p384);
        if (keyName is null) File.WriteAllText(Path.Combine(keyDir, name + ".key.pem"), KeyWarning + key.ExportPkcs8PrivateKeyPem() + "\n");
        var derPath = Path.Combine(certDir, name + ".der");
        if (!renew && File.Exists(derPath))
        {
            var kept = X509CertificateLoader.LoadCertificate(File.ReadAllBytes(derPath));
            if (kept.PublicKey.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(key.ExportSubjectPublicKeyInfo())) return new Cert(name, key, kept);
        }
        var signerKey = issuer?.Key ?? key;
        var request = new CertificateRequest(subject, key, signerKey.KeySize == 384 ? HashAlgorithmName.SHA384 : HashAlgorithmName.SHA256);
        extensions(request);
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, X509SubjectKeyIdentifierHashAlgorithm.Sha1, false));
        if (issuer is not null) request.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromSubjectKeyIdentifier(issuer.Ski));
        request.CertificateExtensions.Add(Policies());
        var serial = SHA256.HashData(Encoding.UTF8.GetBytes("serial/" + name))[..16];
        serial[0] = (byte)((serial[0] & 0x3F) | 0x40); // positive, 16 bytes
        var x = request.Create(issuer?.X.SubjectName ?? subject, X509SignatureGenerator.CreateForECDsa(signerKey), from, to, serial);
        File.WriteAllBytes(derPath, x.RawData);
        File.WriteAllText(Path.Combine(certDir, name + ".pem"), x.ExportCertificatePem() + "\n");
        return new Cert(name, key, x);
    }
}

sealed class Spec(string file, string description, Cert publisher, Cert[] chain, Cert? cosigner, DateTimeOffset signedAt, string encryption, Content content,
    string stapled, string expected)
{
    public string File => file;
    public string Description => description;
    public Cert Publisher => publisher;
    public Cert[] Chain => chain;           // the certificates after the leaf: issuing, then optionally a cross-certificate
    public Cert? Cosigner => cosigner;
    public DateTimeOffset SignedAt => signedAt;
    public string Encryption => encryption; // none, password, key, access
    public Content Content => content;
    public string Stapled => stapled;       // the status answer in the block: valid, withdrawn, superseded or none
    public string Expected => expected;
    public DateTimeOffset? CosignedAt { get; init; }
    public DateTimeOffset? StatusFrom { get; init; }
    public DateTimeOffset? StatusTime { get; init; }
    public string? Reason { get; init; }
    public string[]? Algorithms { get; init; }
    public bool StripCosigner { get; init; }
    public bool Untrusted { get; init; }
}

sealed class Sig(string role, Cert signer, Cert[] chain, byte[] value, byte[] timestamp, DateTimeOffset? stampedAt)
{
    public string Role => role;
    public Cert Signer => signer;
    public Cert[] Chain => chain;
    public byte[] Value => value;
    public byte[] Timestamp => timestamp;
    public DateTimeOffset? StampedAt => stampedAt;
    public string Receipt { get; set; } = "";
}

sealed class Doc(Spec spec, byte[] file, Trailer trailer, byte[] digest, byte[] signed, byte[] factsStored, byte[] factsDigest, string code)
{
    public Spec Spec => spec;
    public byte[] File => file;
    public Trailer Trailer => trailer;
    public byte[] Digest => digest;
    public byte[] Signed => signed;
    public byte[] FactsStored => factsStored;
    public byte[] FactsDigest => factsDigest;
    public string Code => code;
    public List<Sig> Sigs { get; } = [];
    public List<Sig> Stripped { get; } = []; // made and logged, then removed from the block
    public List<Cert> Shared { get; } = [];  // PublisherSignatures.certificates
    public string Status { get; set; } = "";
}

/// <summary>A document's table, rows, metadata and facts.</summary>
sealed class Content(string kind, JsonObject facts, JazminColumn[] columns, List<object?[]> rows, JsonObject metadata, string? partitionBy = null)
{
    public string Kind => kind;
    public JsonObject Facts => facts;
    public List<object?[]> Rows => rows;

    public byte[] Write(string tmp, Spec spec, string password, JazminKey masterKey, JazminKey ownerKey, JazminAccessKey accessKey)
    {
        var path = Path.Combine(tmp, Guid.NewGuid().ToString("N") + ".jzm");
        var options = new JazminWriteOptions { Metadata = (JsonObject)metadata.DeepClone(), Now = spec.SignedAt.AddMinutes(-5), MaxDegreeOfParallelism = 1 };
        switch (spec.Encryption)
        {
            case "none": options.Codec = JazminCodec.None; break; // codec 0: the text a damaged file changes is visible
            case "password": options.Password = password; break;
            case "key": options.Key = masterKey; break;
            case "access":
                options.Key = ownerKey;
                options.Access = new JazminAccessOptions { PartitionBy = partitionBy, Grants = [new JazminGrant(accessKey) { Rows = ["ACC-4410"], Label = "Account 4410" }] };
                break;
        }
        using (var writer = JazminWriter.Create(path, columns, options))
            foreach (var row in rows) writer.WriteValues(row);
        var bytes = System.IO.File.ReadAllBytes(path);
        System.IO.File.Delete(path);
        return bytes;
    }

    private static readonly JazminColumn[] PayslipColumns =
        [new("line", JazminType.Int), new("item", JazminType.String), new("type", JazminType.String), new("amount", JazminType.Decimal)];

    public static Content Payslip(string recipient, string period, (string Item, string Type, decimal Amount)[] lines)
    {
        var gross = lines.Where(l => l.Amount > 0).Sum(l => l.Amount);
        var net = lines.Sum(l => l.Amount);
        var facts = new JsonObject
        {
            ["period"] = period, ["recipient"] = recipient, ["gross"] = Util.Money(gross), ["net"] = Util.Money(net), ["currency"] = "ZAR",
        };
        var rows = lines.Select((l, i) => new object?[] { (long)(i + 1), l.Item, l.Type, l.Amount }).ToList();
        return new Content("payslip", facts, PayslipColumns, rows,
            new JsonObject { ["document"] = "payslip", ["employer"] = "Sable Line Logistics (Pty) Ltd", ["period"] = period });
    }

    public static Content Statement()
    {
        var rows = new List<object?[]>();
        void Account(string account, decimal opening, params (string Date, string Reference, string Description, decimal Amount)[] lines)
        {
            var balance = opening;
            foreach (var l in lines)
            {
                balance += l.Amount;
                rows.Add([account, l.Date, l.Reference, l.Description, l.Amount, balance]);
            }
        }
        Account("ACC-4410", 41250.55m, ("2026-09-03", "INV-88120", "Freight Durban to Johannesburg", 12400.00m),
            ("2026-09-12", "PMT-55102", "Payment received, thank you", -9800.00m), ("2026-09-25", "INV-88391", "Cold-chain storage, September", 4360.00m));
        Account("ACC-7782", 0.00m, ("2026-09-08", "INV-88244", "Freight Cape Town to Gqeberha", 8900.00m),
            ("2026-09-30", "PMT-55340", "Payment received, thank you", -8900.00m));
        var closing = rows.Where(r => (string)r[0]! == "ACC-4410").Select(r => (decimal)r[5]!).Last();
        return new Content("statement",
            new JsonObject { ["period"] = "2026-09", ["account"] = "••••4410", ["closing"] = Util.Money(closing), ["currency"] = "ZAR" },
            [new("account", JazminType.String), new("date", JazminType.String), new("reference", JazminType.String), new("description", JazminType.String),
                new("amount", JazminType.Decimal), new("balance", JazminType.Decimal)],
            rows, new JsonObject { ["document"] = "statement", ["publisher"] = "Sable Line Logistics (Pty) Ltd", ["period"] = "2026-09" }, "account");
    }

    public static Content Invoice()
    {
        var lines = new (string Description, decimal Quantity, decimal Rate)[]
        {
            ("Monthly bookkeeping, September 2026", 1m, 4500.00m), ("Payroll processing (payslips)", 24m, 100.00m),
        };
        var rows = lines.Select((l, i) => new object?[] { (long)(i + 1), l.Description, l.Quantity, l.Rate, l.Quantity * l.Rate }).ToList();
        return new Content("invoice",
            new JsonObject
            {
                ["number"] = "TMB-2026-0142", ["date"] = "2026-10-03", ["buyer"] = "Sable Line Logistics (Pty) Ltd",
                ["total"] = Util.Money(lines.Sum(l => l.Quantity * l.Rate)), ["currency"] = "ZAR",
            },
            [new("line", JazminType.Int), new("description", JazminType.String), new("quantity", JazminType.Decimal), new("rate", JazminType.Decimal),
                new("amount", JazminType.Decimal)],
            rows, new JsonObject { ["document"] = "invoice", ["supplier"] = "Thandi Mokoena t/a TM Bookkeeping" });
    }

    public static Content FinancialStatements()
    {
        var rows = new List<object?[]>
        {
            new object?[] { 1L, "Revenue", 84210000.00m, 76950000.00m }, new object?[] { 2L, "Cost of sales", -61480000.00m, -56120000.00m },
            new object?[] { 3L, "Operating expenses", -14320000.00m, -13870000.00m }, new object?[] { 4L, "Finance costs", -2289600.00m, -2410300.00m },
            new object?[] { 5L, "Profit for the year", 6120400.00m, 4549700.00m },
        };
        return new Content("annual-financial-statements",
            new JsonObject
            {
                ["year"] = "2026", ["revenue"] = "84210000.00", ["profit"] = "6120400.00", ["currency"] = "ZAR", ["auditor"] = "Khumalo & Partners Incorporated",
            },
            [new("line", JazminType.Int), new("caption", JazminType.String), new("current", JazminType.Decimal), new("prior", JazminType.Decimal)],
            rows, new JsonObject { ["document"] = "annual-financial-statements", ["company"] = "Sable Line Logistics (Pty) Ltd", ["year"] = "2026" });
    }

    public static Content TaxCertificate() => new("tax-certificate",
        new JsonObject { ["year"] = "2026", ["recipient"] = "••••1234" },
        [new("code", JazminType.String), new("description", JazminType.String), new("amount", JazminType.Decimal)],
        [
            ["3601", "Income: salary", 194400.00m], ["3605", "Annual bonus", 16200.00m], ["4102", "PAYE", -38991.42m], ["4141", "UIF (employee and employer)", -4250.88m],
        ],
        new JsonObject { ["document"] = "tax-certificate", ["employer"] = "Sable Line Logistics (Pty) Ltd", ["year"] = "2026" });
}

sealed record Trailer(long HeaderOffset, int HeaderLength, long KeySlotsOffset, int KeySlotsLength, long SignatureOffset, int SignatureLength);

/// <summary>The parts of the file format the vectors need (spec 4, 6.9, 7.3, 7.6.4).</summary>
static class Jzm
{
    public static Trailer? ReadTrailer(byte[] f, int end)
    {
        if (end < 64 + 44 || end > f.Length) return null;
        var t = f.AsSpan(end - 44, 44);
        if (!t[40..].SequenceEqual("JZM1"u8) || Util.Crc32(t[..36]) != BinaryPrimitives.ReadUInt32LittleEndian(t[36..])) return null;
        return new Trailer((long)BinaryPrimitives.ReadUInt64LittleEndian(t), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[8..]),
            (long)BinaryPrimitives.ReadUInt64LittleEndian(t[12..]), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[20..]),
            (long)BinaryPrimitives.ReadUInt64LittleEndian(t[24..]), (int)BinaryPrimitives.ReadUInt32LittleEndian(t[32..]));
    }

    public static byte[] Trailer(Trailer t)
    {
        var b = new byte[44];
        BinaryPrimitives.WriteUInt64LittleEndian(b, (ulong)t.HeaderOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(8), (uint)t.HeaderLength);
        BinaryPrimitives.WriteUInt64LittleEndian(b.AsSpan(12), (ulong)t.KeySlotsOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(20), (uint)t.KeySlotsLength);
        BinaryPrimitives.WriteUInt64LittleEndian(b.AsSpan(24), (ulong)t.SignatureOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(32), (uint)t.SignatureLength);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(36), Util.Crc32(b.AsSpan(0, 36)));
        "JZM1"u8.CopyTo(b.AsSpan(40));
        return b;
    }

    /// <summary>D (6.9.2), with B the offset where the block's payload starts.</summary>
    public static byte[] FileDigest(byte[] f, long b, Trailer t) => SHA256.HashData([
        .. "JAZMIN/1/publisher-file"u8, .. f.AsSpan(8, 16), .. SHA256.HashData(f.AsSpan(0, (int)b)),
        .. SHA256.HashData(f.AsSpan((int)t.HeaderOffset, t.HeaderLength)),
        .. SHA256.HashData(t.SignatureLength > 0 ? f.AsSpan((int)t.SignatureOffset, t.SignatureLength) : ReadOnlySpan<byte>.Empty)]);

    /// <summary>The block (6.9.1): the payload, then its 16-byte footer.</summary>
    public static byte[] Block(byte[] payload)
    {
        var footer = new byte[16];
        BinaryPrimitives.WriteUInt32LittleEndian(footer, (uint)payload.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(footer.AsSpan(4), Util.Crc32(payload));
        BinaryPrimitives.WriteUInt16LittleEndian(footer.AsSpan(8), 1);
        "JZPS"u8.CopyTo(footer.AsSpan(12));
        return [.. payload, .. footer];
    }

    /// <summary>Puts the block just before the header and moves the trailer's offsets of the sections after it.</summary>
    public static byte[] InsertBlock(byte[] f, byte[] block)
    {
        var t = ReadTrailer(f, f.Length)!;
        var trailerStart = f.Length - 44;
        var headerEnd = t.HeaderOffset + t.HeaderLength;
        if (t.SignatureLength > 0 ? headerEnd != t.SignatureOffset || t.SignatureOffset + t.SignatureLength != trailerStart : headerEnd != trailerStart)
            throw new InvalidOperationException("The header (and signature section) don't end the file");
        if (t.KeySlotsLength > 0 && t.KeySlotsOffset + t.KeySlotsLength > t.HeaderOffset) throw new InvalidOperationException("Key slots after the header");
        var moved = t with
        {
            HeaderOffset = t.HeaderOffset + block.Length,
            SignatureOffset = t.SignatureLength > 0 ? t.SignatureOffset + block.Length : 0,
        };
        return [.. f.AsSpan(0, (int)t.HeaderOffset), .. block, .. f.AsSpan((int)t.HeaderOffset, trailerStart - (int)t.HeaderOffset), .. Trailer(moved)];
    }

    /// <summary>Inserts one byte at an offset at or after the block, moving the trailer's offsets of what follows it.</summary>
    public static byte[] InsertAt(byte[] f, long at, byte value)
    {
        var t = ReadTrailer(f, f.Length)!;
        var moved = t with
        {
            HeaderOffset = t.HeaderOffset >= at ? t.HeaderOffset + 1 : t.HeaderOffset,
            SignatureOffset = t.SignatureLength > 0 && t.SignatureOffset >= at ? t.SignatureOffset + 1 : t.SignatureOffset,
        };
        var trailerStart = f.Length - 44;
        return [.. f.AsSpan(0, (int)at), value, .. f.AsSpan((int)at, trailerStart - (int)at), .. Trailer(moved)];
    }

    /// <summary>Walks the sections from the preamble and fixes the CRC of the one holding <paramref name="at"/>.</summary>
    public static void FixSectionCrc(byte[] f, int at)
    {
        var pos = 64;
        while (pos + 16 <= f.Length)
        {
            var length = (int)BinaryPrimitives.ReadUInt32LittleEndian(f.AsSpan(pos + 8));
            if (at >= pos + 16 && at < pos + 16 + length)
            {
                BinaryPrimitives.WriteUInt32LittleEndian(f.AsSpan(pos + 12), Util.Crc32(f.AsSpan(pos + 16, length)));
                return;
            }
            pos += 16 + length;
        }
        throw new InvalidOperationException("No section holds that offset");
    }

    /// <summary>A section's stored payload, for sections stored with codec 0 and not encrypted (key slots).</summary>
    public static byte[] PlainSection(byte[] f, long offset, int length)
    {
        var payloadLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(f.AsSpan((int)offset + 8));
        if (f[offset] != 0 || f[offset + 1] != 0 || 16 + payloadLength != length) throw new InvalidOperationException("Not a plain section");
        return f.AsSpan((int)offset + 16, payloadLength).ToArray();
    }

    /// <summary>H of an access-controlled file, from the slot of <paramref name="secret"/> (the owner key or an access key's secret; 7.6.4).</summary>
    public static byte[] HeaderSecret(byte[] f, Trailer t, byte[] secret)
    {
        var fileId = f.AsSpan(8, 16).ToArray();
        var salt = f.AsSpan(24, 32).ToArray();
        var id = SHA256.HashData([.. "JAZMIN/1/slot-id"u8, .. secret])[..8];
        var list = PlainSection(f, t.KeySlotsOffset, t.KeySlotsLength);
        var pages = (int)BinaryPrimitives.ReadUInt32LittleEndian(list);
        var pick = -1;
        for (var i = 0; i < pages; i++)
            if (list.AsSpan(4 + i * 52, 8).SequenceCompareTo(id) <= 0) pick = i;
        if (pick < 0) throw new InvalidOperationException("No key-slot page for this key");
        var entry = list.AsSpan(4 + pick * 52, 52);
        var pageOffset = (long)BinaryPrimitives.ReadUInt64LittleEndian(entry[8..]);
        var pageLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(entry[16..]);
        if (!SHA256.HashData(f.AsSpan((int)pageOffset, pageLength)).AsSpan().SequenceEqual(entry[20..52])) throw new InvalidOperationException("Key-slot page digest");
        var page = PlainSection(f, pageOffset, pageLength);
        var count = (int)BinaryPrimitives.ReadUInt32LittleEndian(page);
        var blobs = 4 + count * 16;
        for (var i = 0; i < count; i++)
        {
            var slot = page.AsSpan(4 + i * 16, 16);
            if (!slot[..8].SequenceEqual(id)) continue;
            var start = blobs + (int)BinaryPrimitives.ReadUInt32LittleEndian(slot[8..]);
            var length = (int)(BinaryPrimitives.ReadUInt32LittleEndian(slot[12..]) & 0x7FFFFFFF);
            var plain = Util.Open(Util.Hkdf(secret, salt, "JAZMIN/1/slot"), page.AsSpan(start, length), [.. fileId, .. id]);
            var bundle = JsonNode.Parse(plain)!.AsObject();
            return Convert.FromBase64String((string)bundle["header"]!);
        }
        throw new InvalidOperationException("No slot for this key");
    }

    /// <summary>The keyring's "data" secret of a file encrypted with a key or password (7.3): from the decrypted header.</summary>
    public static byte[] KeyringData(byte[] f, Trailer t, byte[] master)
    {
        var at = (int)t.HeaderOffset;
        var envelope = f.AsSpan(at, 16);
        var payloadLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(envelope[8..]);
        var key = Util.Hkdf(master, f.AsSpan(24, 32).ToArray(), "JAZMIN/1/header");
        var plain = Util.Open(key, f.AsSpan(at + 16, payloadLength), [.. f.AsSpan(8, 16), .. envelope[..8], .. "header"u8]);
        var raw = Util.Decompress(envelope[0], plain);
        var keyring = Pb.Field(raw, 8) ?? throw new InvalidOperationException("No keyring in the header");
        return Pb.Field(keyring, 1) ?? throw new InvalidOperationException("No data secret in the keyring");
    }

    /// <summary>
    /// The key of the facts (6.9.3): the key a section named "publisher/facts" gets. With a key or password (7.3):
    /// HKDF(master, keyring.data, "JAZMIN/1/publisher/facts"); access-controlled (7.6.3): HKDF(H, salt, "JAZMIN/1/publisher/facts").
    /// </summary>
    public static byte[] FactsKey(byte[] f, Trailer t, string encryption, string password, JazminKey masterKey, JazminKey ownerKey)
    {
        var salt = f.AsSpan(24, 32).ToArray();
        return encryption switch
        {
            "key" => Util.Hkdf(masterKey.ToBytes(), KeyringData(f, t, masterKey.ToBytes()), "JAZMIN/1/publisher/facts"),
            "password" => Password(),
            "access" => Util.Hkdf(HeaderSecret(f, t, ownerKey.ToBytes()), salt, "JAZMIN/1/publisher/facts"),
            _ => throw new ArgumentException(encryption),
        };
        byte[] Password()
        {
            var master = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, (int)BinaryPrimitives.ReadUInt32LittleEndian(f.AsSpan(56)), HashAlgorithmName.SHA256, 32);
            return Util.Hkdf(master, KeyringData(f, t, master), "JAZMIN/1/publisher/facts");
        }
    }

    /// <summary>The associated data of the facts (6.9.3): file_id || 00 01 00 00 || u32(length) || "publisher/facts".</summary>
    public static byte[] FactsAad(ReadOnlySpan<byte> fileId, int rawLength)
    {
        var envelope = new byte[8];
        envelope[1] = 0x01;
        BinaryPrimitives.WriteUInt32LittleEndian(envelope.AsSpan(4), (uint)rawLength);
        return [.. fileId, .. envelope, .. "publisher/facts"u8];
    }

    public static byte[] EncryptFacts(byte[] f, Trailer t, string encryption, byte[] plain, string password, JazminKey masterKey, JazminKey ownerKey) =>
        Util.Seal(FactsKey(f, t, encryption, password, masterKey, ownerKey), plain, FactsAad(f.AsSpan(8, 16), plain.Length));
}

/// <summary>Protocol Buffers: encoding the 6.9.6 messages, and reading one field of a message.</summary>
static class Pb
{
    public static byte[]? Field(ReadOnlySpan<byte> b, int wanted)
    {
        var pos = 0;
        byte[]? found = null;
        while (pos < b.Length)
        {
            var key = Varint(b, ref pos);
            switch (key & 7)
            {
                case 0: Varint(b, ref pos); break;
                case 1: pos += 8; break;
                case 5: pos += 4; break;
                case 2:
                    var length = (int)Varint(b, ref pos);
                    if ((int)(key >> 3) == wanted) found = b.Slice(pos, length).ToArray();
                    pos += length;
                    break;
                default: throw new InvalidOperationException("wire type");
            }
        }
        return found;
    }

    private static ulong Varint(ReadOnlySpan<byte> b, ref int pos)
    {
        ulong v = 0;
        for (var shift = 0; ; shift += 7)
        {
            var x = b[pos++];
            v |= (ulong)(x & 0x7F) << shift;
            if (x < 0x80) return v;
        }
    }
}

static class Proto
{
    private static void Varint(MemoryStream s, ulong v)
    {
        while (v >= 0x80)
        {
            s.WriteByte((byte)(v | 0x80));
            v >>= 7;
        }
        s.WriteByte((byte)v);
    }

    private static void Bytes(MemoryStream s, int field, ReadOnlySpan<byte> b, bool always = false)
    {
        if (b.Length == 0 && !always) return;
        Varint(s, (ulong)(field << 3 | 2));
        Varint(s, (ulong)b.Length);
        s.Write(b);
    }

    private static void Text(MemoryStream s, int field, string v, bool always = false) => Bytes(s, field, Encoding.UTF8.GetBytes(v), always);

    private static void Number(MemoryStream s, int field, ulong v)
    {
        if (v == 0) return;
        Varint(s, (ulong)(field << 3));
        Varint(s, v);
    }

    public static byte[] SignedDocument(byte[] fileId, byte[] digest, string code, string kind, byte[] factsDigest, string[] algorithms, string credential, long signedAt)
    {
        var s = new MemoryStream();
        Number(s, 1, 1);
        Bytes(s, 2, fileId);
        Bytes(s, 3, digest);
        Text(s, 4, code);
        Text(s, 5, kind);
        Bytes(s, 6, factsDigest);
        foreach (var a in algorithms) Text(s, 7, a, true);
        Text(s, 8, credential);
        Number(s, 9, (ulong)signedAt);
        return s.ToArray();
    }

    public static byte[] PublisherSignature(string algorithm, byte[] value, byte[][] certificates, string role, byte[] timestamp, string receipt)
    {
        var s = new MemoryStream();
        Text(s, 1, algorithm);
        Bytes(s, 2, value);
        foreach (var c in certificates) Bytes(s, 3, c, true);
        Text(s, 4, role);
        Bytes(s, 5, timestamp);
        Text(s, 6, receipt);
        return s.ToArray();
    }

    public static byte[] PublisherSignatures(byte[] signed, List<byte[]> signatures, byte[] facts, string status, List<byte[]> certificates)
    {
        var s = new MemoryStream();
        Bytes(s, 1, signed);
        foreach (var g in signatures) Bytes(s, 2, g, true);
        Bytes(s, 3, facts);
        Text(s, 4, status);
        foreach (var c in certificates) Bytes(s, 5, c, true);
        return s.ToArray();
    }
}

/// <summary>RFC 3161 time-stamp tokens from the test time-stamping certificate, carrying no certificates (6.9.5).</summary>
static class Tsa
{
    public static byte[] Stamp(byte[] value, DateTimeOffset at, Cert tsa, int serial)
    {
        var info = new Rfc3161TimestampTokenInfo(new Oid(Oids.Policy), new Oid(Oids.Sha256), SHA256.HashData(value), new byte[] { 0x01, (byte)serial }, at,
            accuracyInMicroseconds: 1_000_000);
        var cms = new SignedCms(new ContentInfo(new Oid(Oids.TstInfo), info.Encode()), false);
        var signer = new CmsSigner(SubjectIdentifierType.IssuerAndSerialNumber, tsa.X, tsa.Key)
        {
            DigestAlgorithm = new Oid(Oids.Sha256),
            IncludeOption = X509IncludeOption.None,
        };
        var w = new AsnWriter(AsnEncodingRules.DER); // SigningCertificateV2 { certs { ESSCertIDv2 { certHash } } } (RFC 5035)
        using (w.PushSequence())
        using (w.PushSequence())
        using (w.PushSequence())
            w.WriteOctetString(SHA256.HashData(tsa.Der));
        signer.SignedAttributes.Add(new AsnEncodedData(new Oid(Oids.SigningCertificateV2), w.Encode()));
        cms.ComputeSignature(signer);
        return cms.Encode();
    }
}

/// <summary>JSON Web Signatures in compact form, ES256 (6.9.5): x5c holds the signer and its issuing certificate, unless the block carries them.</summary>
static class Jws
{
    public static string Sign(JsonObject payload, Cert signer, Cert? issuing)
    {
        var header = new JsonObject { ["alg"] = "ES256" };
        if (issuing is not null) header["x5c"] = new JsonArray(Convert.ToBase64String(signer.Der), Convert.ToBase64String(issuing.Der));
        var input = Util.B64Url(Encoding.UTF8.GetBytes(header.ToJsonString(Util.Compact))) + "." + Util.B64Url(Encoding.UTF8.GetBytes(payload.ToJsonString(Util.Compact)));
        var signature = signer.Key.SignData(Encoding.ASCII.GetBytes(input), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return input + "." + Util.B64Url(signature);
    }
}

/// <summary>The log (6.9.5): RFC 9162 Merkle tree hashing (2.1), C2SP checkpoints signed with a log certificate's key, tlog-proof receipts.</summary>
static class Merkle
{
    /// <summary>A signature's entry: "JAZMIN/1/log" || SHA-256(signed) || SHA-256(value).</summary>
    public static byte[] Entry(byte[] signed, byte[] value) => [.. "JAZMIN/1/log"u8, .. SHA256.HashData(signed), .. SHA256.HashData(value)];

    public static byte[] LeafHash(byte[] entry) => SHA256.HashData([0x00, .. entry]);

    private static int Split(int n)
    {
        var k = 1;
        while (k << 1 < n) k <<= 1;
        return k;
    }

    public static byte[] Root(List<byte[]> leaves, int start, int n) => n switch
    {
        0 => SHA256.HashData(ReadOnlySpan<byte>.Empty),
        1 => LeafHash(leaves[start]),
        _ => SHA256.HashData([0x01, .. Root(leaves, start, Split(n)), .. Root(leaves, start + Split(n), n - Split(n))]),
    };

    /// <summary>PATH(m, D[n]) of RFC 9162 2.1.3.1: from the leaf's sibling up to the root's child.</summary>
    public static List<byte[]> Path(int m, List<byte[]> leaves, int start, int n)
    {
        if (n <= 1) return [];
        var k = Split(n);
        return m < k
            ? [.. Path(m, leaves, start, k), Root(leaves, start + k, n - k)]
            : [.. Path(m - k, leaves, start + k, n - k), Root(leaves, start, k)];
    }

    /// <summary>A C2SP signed note in the tlog-checkpoint form, signed with type 0x02 (ECDSA P-256), and the log's verifier key.</summary>
    public static (string Note, string VerifierKey) Checkpoint(string origin, int size, byte[] root, Cert log)
    {
        var body = $"{origin}\n{size}\n{Convert.ToBase64String(root)}\n";
        var spki = log.Spki;
        var keyId = SHA256.HashData(spki)[..4];
        var signature = log.Key.SignData(Encoding.UTF8.GetBytes(body), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        var note = body + "\n— " + origin + " " + Convert.ToBase64String([.. keyId, .. signature]) + "\n";
        return (note, $"{origin}+{Convert.ToHexString(keyId).ToLowerInvariant()}+{Convert.ToBase64String([0x02, .. spki])}");
    }

    /// <summary>A receipt in the C2SP tlog-proof@v1 form: the index, the inclusion proof and the checkpoint.</summary>
    public static string Proof(int index, List<byte[]> leaves, string checkpoint)
    {
        var sb = new StringBuilder("c2sp.org/tlog-proof@v1\n").Append("index ").Append(index).Append('\n');
        foreach (var h in Path(index, leaves, 0, leaves.Count)) sb.Append(Convert.ToBase64String(h)).Append('\n');
        return sb.Append('\n').Append(checkpoint).ToString();
    }
}

/// <summary>The QR form (6.9.7): "JZ1:" + Base45(zlib(COSE_Sign1)).</summary>
static class Qr
{
    private const string Base45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

    public static string Make(string code, string kind, JsonObject facts, long signedAt, Cert publisher)
    {
        var p = new CborWriter();
        p.WriteStartMap(4);
        p.WriteTextString("code");
        p.WriteTextString(code);
        p.WriteTextString("kind");
        p.WriteTextString(kind);
        p.WriteTextString("facts");
        p.WriteStartMap(facts.Count);
        foreach (var name in facts.Select(f => f.Key).Order(StringComparer.Ordinal))
        {
            p.WriteTextString(name);
            p.WriteTextString((string)facts[name]!);
        }
        p.WriteEndMap();
        p.WriteTextString("signed_at");
        p.WriteInt64(signedAt);
        p.WriteEndMap();
        var payload = p.Encode();
        var h = new CborWriter();
        h.WriteStartMap(2);
        h.WriteInt32(1);
        h.WriteInt32(-7); // ES256
        h.WriteInt32(4);
        h.WriteByteString(SHA256.HashData(publisher.Der)[..8]); // kid
        h.WriteEndMap();
        var protectedHeader = h.Encode();
        var toSign = new CborWriter();
        toSign.WriteStartArray(4);
        toSign.WriteTextString("Signature1");
        toSign.WriteByteString(protectedHeader);
        toSign.WriteByteString(Array.Empty<byte>());
        toSign.WriteByteString(payload);
        toSign.WriteEndArray();
        var signature = publisher.Key.SignData(toSign.Encode(), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var cose = new CborWriter();
        cose.WriteTag((CborTag)18);
        cose.WriteStartArray(4);
        cose.WriteByteString(protectedHeader);
        cose.WriteStartMap(0);
        cose.WriteEndMap();
        cose.WriteByteString(payload);
        cose.WriteByteString(signature);
        cose.WriteEndArray();
        var zipped = new MemoryStream();
        using (var z = new ZLibStream(zipped, CompressionLevel.SmallestSize, leaveOpen: true)) z.Write(cose.Encode());
        var bytes = zipped.ToArray();
        var sb = new StringBuilder("JZ1:");
        for (var i = 0; i + 1 < bytes.Length; i += 2)
        {
            var v = bytes[i] * 256 + bytes[i + 1];
            sb.Append(Base45[v % 45]).Append(Base45[v / 45 % 45]).Append(Base45[v / 2025]);
        }
        if (bytes.Length % 2 == 1) sb.Append(Base45[bytes[^1] % 45]).Append(Base45[bytes[^1] / 45]);
        return sb.ToString();
    }
}

static class Util
{
    public const string SeedText = "JAZMIN publisher signature test vectors - TEST KEYS ONLY";
    public static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly JsonSerializerOptions Indented = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, WriteIndented = true, NewLine = "\n" };

    public static string FindRepo()
    {
        foreach (var start in new[] { AppContext.GetData("EntryPointFileDirectoryPath") as string, Environment.CurrentDirectory })
            for (var dir = start; dir is not null; dir = Path.GetDirectoryName(dir))
                if (File.Exists(Path.Combine(dir, "spec", "jazmin.proto"))) return dir;
        throw new InvalidOperationException("Run from the repository (spec/jazmin.proto not found)");
    }

    public static DateTimeOffset At(string iso) => DateTimeOffset.Parse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);

    public static string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    public static string Money(decimal v) => v.ToString("0.00", CultureInfo.InvariantCulture);

    public static byte[] Seed(string info, int length)
    {
        var okm = new byte[length];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, Encoding.UTF8.GetBytes(SeedText), okm, ReadOnlySpan<byte>.Empty, Encoding.UTF8.GetBytes(info));
        return okm;
    }

    public static string KeyText(byte[] key) => "jzk1-" + B64Url([.. key, .. SHA256.HashData(key)[..4]]);

    public static string B64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>A certificate as JWS payloads name it (6.9.5): the base64url SHA-256 of its issuing certificate's SPKI, and its serial in lowercase hex.</summary>
    public static JsonObject CertName(Cert c, Cert issuing) => new()
    {
        ["issuer"] = B64Url(SHA256.HashData(issuing.Spki)), ["serial"] = c.X.SerialNumber.ToLowerInvariant(),
    };

    public static string Credential(Cert c) => c.Name switch
    {
        "sable-line-logistics" => "sable-line-logistics/2026",
        "sable-line-logistics-2025" => "sable-line-logistics/2025",
        "sable-line-logistics-payroll" => "sable-line-logistics/payroll-2026",
        "sable-line-logistics-root-2" => "sable-line-logistics/2026-root-2",
        "tm-bookkeeping" => "tm-bookkeeping/2026",
        _ => c.Name,
    };

    public static X500DistinguishedName Dn(string cn, string? organization = null, string? organizationIdentifier = null, string country = "ZA")
    {
        var b = new X500DistinguishedNameBuilder();
        b.AddCountryOrRegion(country);
        if (organization is not null) b.AddOrganizationName(organization);
        if (organizationIdentifier is not null) b.Add(Oids.OrganizationIdentifier, organizationIdentifier, UniversalTagNumber.UTF8String);
        b.AddCommonName(cn);
        return b.Build();
    }

    public static JsonObject Identity(string name, string? organization, string? registration, string country, string? domain, string kind) => new()
    {
        ["name"] = name, ["organization"] = organization, ["registration"] = registration, ["country"] = country, ["domain"] = domain, ["kind"] = kind,
    };

    public static JsonObject Keys(string encryption, string password, JazminKey masterKey, JazminKey ownerKey, JazminAccessKey accessKey) => encryption switch
    {
        "password" => new JsonObject { ["password"] = password },
        "key" => new JsonObject { ["key"] = masterKey.ToString() },
        "access" => new JsonObject { ["ownerKey"] = ownerKey.ToString(), ["accessKey"] = accessKey.ToString() },
        _ => new JsonObject(),
    };

    /// <summary>A document code (6.9.3): JZ- and two groups of five Crockford Base32 symbols, the last a check.</summary>
    public static string DocumentCode(string seed)
    {
        const string alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        var h = SHA256.HashData(Encoding.UTF8.GetBytes("document-code/" + seed));
        var values = h[..9].Select(b => b & 31).ToList();
        values.Add(values.Select((v, i) => v * (i + 1)).Sum() % 32);
        var text = new string(values.Select(v => alphabet[v]).ToArray());
        return $"JZ-{text[..5]}-{text[5..]}";
    }

    /// <summary>A status answer (6.9.5) about the publisher's certificate.</summary>
    public static JsonObject StatusAnswer(byte[] digest, Cert publisher, Cert issuing, string code, string status, DateTimeOffset? from, DateTimeOffset time, byte[] nonce)
    {
        var answer = new JsonObject { ["digest"] = B64Url(digest), ["certificate"] = CertName(publisher, issuing), ["code"] = code, ["status"] = status };
        if (from is not null) answer["from"] = Iso(from.Value);
        answer["time"] = Iso(time);
        answer["nonce"] = B64Url(nonce);
        return answer;
    }

    /// <summary>JCS (RFC 8785) of an object whose values are all text, as facts are (6.9.3).</summary>
    public static string Jcs(JsonObject facts)
    {
        var sb = new StringBuilder("{");
        foreach (var name in facts.Select(f => f.Key).Order(StringComparer.Ordinal))
        {
            if (sb.Length > 1) sb.Append(',');
            JcsString(sb, name);
            sb.Append(':');
            JcsString(sb, (string)facts[name]!);
        }
        return sb.Append('}').ToString();
    }

    private static void JcsString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    public static byte[] Hkdf(byte[] ikm, byte[] salt, string info)
    {
        var key = new byte[32];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, key, salt, Encoding.UTF8.GetBytes(info));
        return key;
    }

    public static byte[] Seal(byte[] key, byte[] plain, byte[] aad)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var output = new byte[12 + plain.Length + 16];
        nonce.CopyTo(output, 0);
        using var gcm = new AesGcm(key, 16);
        gcm.Encrypt(nonce, plain, output.AsSpan(12, plain.Length), output.AsSpan(12 + plain.Length), aad);
        return output;
    }

    public static byte[] Open(byte[] key, ReadOnlySpan<byte> payload, byte[] aad)
    {
        var plain = new byte[payload.Length - 28];
        using var gcm = new AesGcm(key, 16);
        gcm.Decrypt(payload[..12], payload[12..^16], payload[^16..], plain, aad);
        return plain;
    }

    /// <summary>A section's payload after decryption, decompressed by its codec (4.3).</summary>
    public static byte[] Decompress(byte codec, byte[] data)
    {
        if (codec == 0) return data;
        var output = new MemoryStream();
        using (Stream z = codec == 1 ? new DeflateStream(new MemoryStream(data), CompressionMode.Decompress) : new BrotliStream(new MemoryStream(data), CompressionMode.Decompress))
            z.CopyTo(output);
        return output.ToArray();
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

    public static void WriteJson(string path, JsonNode node) => File.WriteAllText(path, node.ToJsonString(Indented) + "\n");
}
