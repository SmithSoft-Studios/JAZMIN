using System.Buffers;
using System.Buffers.Binary;
using System.Formats.Asn1;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Format;

namespace Jazmin;

/// <summary>What <see cref="JazminFile.VerifyPublisher(string, JazminPublisherOptions?)"/> concludes about a file (spec 6.9.8).</summary>
public enum JazminPublisherStatus
{
    /// <summary>No publisher signature, or one an append, update or moved bytes left behind (6.9.1).</summary>
    None,

    /// <summary>Signed by a publisher a trusted root certifies, and not changed since.</summary>
    Certified,

    /// <summary>Signed and not changed since, but by a key no trusted root certifies: show no name, code or facts.</summary>
    Signed,

    /// <summary>Changed since it was signed (<see cref="JazminPublisherResult.Reason"/>: "digest" or "coverage").</summary>
    Changed,

    /// <summary>Certified, but its publisher took it back.</summary>
    Withdrawn,

    /// <summary>Certified, but its publisher replaced it.</summary>
    Superseded,

    /// <summary>The signature fails a check (<see cref="JazminPublisherResult.Reason"/> says which).</summary>
    Invalid,

    /// <summary>Not a valid file (its last bytes are not a valid trailer), so not verified.</summary>
    NotVerified,
}

/// <summary>What <see cref="JazminFile.VerifyPublisher(string, JazminPublisherOptions?)"/> uses besides the file.</summary>
public sealed class JazminPublisherOptions
{
    /// <summary>The file's key, or a shared file's owner key: reads the facts of an encrypted file.</summary>
    public JazminKey? Key { get; set; }

    /// <summary>A shared file's access key: reads the facts.</summary>
    public JazminAccessKey? AccessKey { get; set; }

    /// <summary>The file's password: reads the facts.</summary>
    public string? Password { get; set; }

    /// <summary>A revocation list the app holds (a compact JWS, spec 6.9.5). One that doesn't verify is not used.</summary>
    public string? RevocationList { get; set; }

    /// <summary>An online status answer the app asked for with its own nonce (spec 6.9.5).</summary>
    public JazminStatusAnswer? StatusAnswer { get; set; }
}

/// <summary>An online status answer (a compact JWS) and the nonce the app asked with (base64url, at least 16 bytes).</summary>
public sealed record JazminStatusAnswer(string Answer, string Nonce);

/// <summary>A signer as its certificate names it (spec 6.9.4).</summary>
/// <param name="Name">commonName: the verified name.</param>
/// <param name="Organization">organizationName.</param>
/// <param name="Registration">organizationIdentifier, for example "NTRZA-2020/123456/07".</param>
/// <param name="Country">countryName.</param>
/// <param name="Domain">The first verified domain (dNSName).</param>
/// <param name="Kind">"company" or "individual".</param>
public sealed record JazminPublisherIdentity(string? Name, string? Organization, string? Registration, string? Country, string? Domain, string? Kind);

/// <summary>The status stored in the signature block at signing (spec 6.9.5): "valid", "revoked", "withdrawn" or "superseded".</summary>
public sealed record JazminStoredStatus(string Status, DateTimeOffset? From);

/// <summary>
/// The result of verifying a file's publisher signature (spec 6.9.8). The publisher's identity, the code, the facts and
/// the times are set only when <see cref="Status"/> is Certified, Withdrawn or Superseded.
/// </summary>
public sealed record JazminPublisherResult
{
    public JazminPublisherStatus Status { get; init; }

    /// <summary>
    /// Changed: "digest" or "coverage". Invalid: "block", "algorithms", "signature", "chain", "timestamp", "log",
    /// "revoked" or "facts". NotVerified: "not-a-valid-file". Otherwise null.
    /// </summary>
    public string? Reason { get; init; }

    /// <summary>The publisher's verified name (commonName).</summary>
    public string? Name { get; init; }

    public string? Organization { get; init; }

    /// <summary>organizationIdentifier, for example "NTRZA-2020/123456/07".</summary>
    public string? Registration { get; init; }

    public string? Country { get; init; }

    /// <summary>The publisher's first verified domain.</summary>
    public string? Domain { get; init; }

    /// <summary>"company" or "individual".</summary>
    public string? Kind { get; init; }

    /// <summary>The document code, for example "JZ-7F3K9-2QD40" (spec 6.9.3).</summary>
    public string? Code { get; init; }

    /// <summary>The document's kind, for example "payslip" (spec 6.9.3).</summary>
    public string? DocumentKind { get; init; }

    /// <summary>The credential that signed, as the certifier names it.</summary>
    public string? Credential { get; init; }

    /// <summary>When the signer says it signed; <see cref="Timestamp"/> is the time that is proven.</summary>
    public DateTimeOffset? SignedAt { get; init; }

    /// <summary>The time the publisher signature's timestamp proves.</summary>
    public DateTimeOffset? Timestamp { get; init; }

    /// <summary>The co-signers, in the block's order.</summary>
    public IReadOnlyList<JazminPublisherIdentity> Cosigners { get; init; } = [];

    /// <summary>The signed facts; null when there are none, or the file is encrypted and no key given reads them.</summary>
    public IReadOnlyDictionary<string, string>? Facts { get; init; }

    /// <summary>The file is encrypted, so its facts need its key, access key or password.</summary>
    public bool FactsNeedKey { get; init; }

    /// <summary>The status stored in the block, when it verifies.</summary>
    public JazminStoredStatus? StatusAnswer { get; init; }

    /// <summary>How fresh the revocation check is: the newest statement about the publisher's certificate used; null when none.</summary>
    public DateTimeOffset? CheckedAt { get; init; }
}

/// <summary>What a verifier trusts (spec 6.9.4): its roots (DER), the id-jazmin-* arc, and the time it verifies at.</summary>
internal sealed record JazminPublisherTrust(IReadOnlyList<byte[]> Roots, string? Arc, DateTimeOffset At)
{
    /// <summary>
    /// The trust built into this library, at the current time. SmithSoft's roots (6.9.4): none yet; added before 1.8.0 is
    /// released. The arc is not assigned yet.
    /// </summary>
    public static JazminPublisherTrust BuiltIn() => new([], null, DateTimeOffset.UtcNow);
}

/// <summary>
/// Verifies a publisher signature (spec 6.9.8). Reads the trailer, the block before the header, and the bytes the
/// signature covers in pieces of at most 1 MiB; certificates and RFC 3161 tokens with a strict DER reader of its own.
/// </summary>
internal static class Publisher
{
    private const int ChunkSize = 1 << 20;
    private const int FooterSize = 16;

    internal static JazminPublisherResult Verify(Stream? stream, byte[]? data, JazminPublisherOptions? options, JazminPublisherTrust trust)
    {
        using var file = new Source(stream, data);
        return new Verification(file, options ?? new JazminPublisherOptions(), trust).Run();
    }

    private static JazminPublisherResult Result(JazminPublisherStatus status, string? reason = null) => new() { Status = status, Reason = reason };

    /// <summary>The file's bytes: an array, or a seekable stream read in pieces.</summary>
    private sealed class Source(Stream? stream, byte[]? data) : IDisposable
    {
        private byte[]? _buffer;

        public long Length => data?.LongLength ?? stream!.Length;

        public void Read(long at, Span<byte> into)
        {
            if (data is not null)
            {
                data.AsSpan(checked((int)at), into.Length).CopyTo(into);
                return;
            }
            stream!.Position = at;
            stream.ReadExactly(into);
        }

        public byte[] Read(long at, int length)
        {
            var bytes = new byte[length];
            Read(at, bytes);
            return bytes;
        }

        /// <summary>A range as an array segment: a view of an array file, a copy read from a stream.</summary>
        public ArraySegment<byte> Segment(long at, int length) => data is not null ? new ArraySegment<byte>(data, checked((int)at), length) : Read(at, length);

        /// <summary>Adds bytes [at, at + length) to <paramref name="hash"/>, at most 1 MiB in memory at a time.</summary>
        public void Hash(IncrementalHash hash, long at, long length)
        {
            if (data is not null)
            {
                hash.AppendData(data, checked((int)at), checked((int)length));
                return;
            }
            if (length == 0) return;
            _buffer ??= ArrayPool<byte>.Shared.Rent((int)Math.Min(ChunkSize, length));
            stream!.Position = at;
            while (length > 0)
            {
                var n = (int)Math.Min(length, _buffer.Length);
                stream.ReadExactly(_buffer, 0, n);
                hash.AppendData(_buffer, 0, n);
                length -= n;
            }
        }

        public void Dispose()
        {
            if (_buffer is not null) ArrayPool<byte>.Shared.Return(_buffer);
            _buffer = null;
        }
    }

    // ---- the block's messages (spec 6.9.6) -------------------------------------------------------

    private sealed class Block
    {
        public ReadOnlyMemory<byte> Signed;
        public readonly List<Signature> Signatures = [];
        public ReadOnlyMemory<byte> Facts;
        public string Status = "";
        public readonly List<ReadOnlyMemory<byte>> Certificates = [];

        /// <summary>A PublisherSignatures message, or null when it isn't one.</summary>
        public static Block? Parse(ArraySegment<byte> payload)
        {
            try
            {
                var block = new Block();
                var r = new ProtoReader(payload);
                while (r.Next(out var field))
                {
                    switch (field)
                    {
                        case 1: block.Signed = r.Bytes(); break;
                        case 2: block.Signatures.Add(Signature.Parse(r.Bytes())); break;
                        case 3: block.Facts = r.Bytes(); break;
                        case 4: block.Status = r.String(); break;
                        case 5: block.Certificates.Add(r.Bytes()); break;
                        default: r.Skip(); break;
                    }
                }
                return block;
            }
            catch (JazminFormatException)
            {
                return null;
            }
        }
    }

    private sealed class Signature
    {
        public string Algorithm = "";
        public ReadOnlyMemory<byte> Value;
        public readonly List<ReadOnlyMemory<byte>> Certificates = [];
        public string Role = "";
        public ReadOnlyMemory<byte> Timestamp;
        public string LogReceipt = "";
        public readonly List<Certificate> Parsed = [];

        public static Signature Parse(ArraySegment<byte> message)
        {
            var s = new Signature();
            var r = new ProtoReader(message);
            while (r.Next(out var field))
            {
                switch (field)
                {
                    case 1: s.Algorithm = r.String(); break;
                    case 2: s.Value = r.Bytes(); break;
                    case 3: s.Certificates.Add(r.Bytes()); break;
                    case 4: s.Role = r.String(); break;
                    case 5: s.Timestamp = r.Bytes(); break;
                    case 6: s.LogReceipt = r.String(); break;
                    default: r.Skip(); break;
                }
            }
            return s;
        }
    }

    private sealed class SignedDocument
    {
        public ulong Version;
        public ReadOnlyMemory<byte> FileId;
        public ReadOnlyMemory<byte> FileDigest;
        public string Code = "";
        public string Kind = "";
        public ReadOnlyMemory<byte> FactsDigest;
        public readonly List<string> Algorithms = [];
        public string Credential = "";
        public long SignedAt;

        /// <summary>A SignedDocument message, or null when it isn't one.</summary>
        public static SignedDocument? Parse(ReadOnlyMemory<byte> signed)
        {
            try
            {
                var d = new SignedDocument();
                var r = new ProtoReader(System.Runtime.InteropServices.MemoryMarshal.TryGetArray(signed, out var segment) ? segment : signed.ToArray());
                while (r.Next(out var field))
                {
                    switch (field)
                    {
                        case 1: d.Version = r.UInt64(); break;
                        case 2: d.FileId = r.Bytes(); break;
                        case 3: d.FileDigest = r.Bytes(); break;
                        case 4: d.Code = r.String(); break;
                        case 5: d.Kind = r.String(); break;
                        case 6: d.FactsDigest = r.Bytes(); break;
                        case 7: d.Algorithms.Add(r.String()); break;
                        case 8: d.Credential = r.String(); break;
                        case 9: d.SignedAt = r.SignedInt64(); break;
                        default: r.Skip(); break;
                    }
                }
                return d;
            }
            catch (JazminFormatException)
            {
                return null;
            }
        }
    }

    // ---- certificates (spec 6.9.4) ---------------------------------------------------------------

    private static class Oid
    {
        public const string SignedData = "1.2.840.113549.1.7.2";
        public const string TstInfo = "1.2.840.113549.1.9.16.1.4";
        public const string ContentType = "1.2.840.113549.1.9.3";
        public const string MessageDigest = "1.2.840.113549.1.9.4";
        public const string SigningCertificateV2 = "1.2.840.113549.1.9.16.2.47";
        public const string Sha256 = "2.16.840.1.101.3.4.2.1";
        public const string EcPublicKey = "1.2.840.10045.2.1";
        public const string P256 = "1.2.840.10045.3.1.7";
        public const string P384 = "1.3.132.0.34";
        public const string EcdsaSha256 = "1.2.840.10045.4.3.2";
        public const string EcdsaSha384 = "1.2.840.10045.4.3.3";
        public const string TimeStamping = "1.3.6.1.5.5.7.3.8";
        public const string BasicConstraints = "2.5.29.19";
        public const string KeyUsage = "2.5.29.15";
        public const string ExtKeyUsage = "2.5.29.37";
        public const string Policies = "2.5.29.32";
        public const string SubjectKeyId = "2.5.29.14";
        public const string AuthorityKeyId = "2.5.29.35";
        public const string SubjectAltName = "2.5.29.17";
        public const string CommonName = "2.5.4.3";
        public const string Organization = "2.5.4.10";
        public const string OrganizationIdentifier = "2.5.4.97";
        public const string Country = "2.5.4.6";
    }

    /// <summary>The id-jazmin-* identifiers under the trust's arc (6.9.4). Without an arc they match nothing.</summary>
    private sealed class ArcOids(string? arc)
    {
        public readonly string Policy = arc is null ? "" : arc + ".1";
        public readonly string DocumentSigning = arc is null ? "" : arc + ".2";
        public readonly string Status = arc is null ? "" : arc + ".3";
        public readonly string PublisherKind = arc is null ? "" : arc + ".5";
        public readonly string Log = arc is null ? "" : arc + ".6";
    }

    private static readonly Asn1Tag Context0 = new(TagClass.ContextSpecific, 0, isConstructed: true);
    private static readonly Asn1Tag Context1 = new(TagClass.ContextSpecific, 1, isConstructed: true);
    private static readonly Asn1Tag Context3 = new(TagClass.ContextSpecific, 3, isConstructed: true);
    private static readonly Asn1Tag KeyIdentifier = new(TagClass.ContextSpecific, 0);
    private static readonly Asn1Tag DnsName = new(TagClass.ContextSpecific, 2);

    private readonly record struct Extension(string Oid, bool Critical, ReadOnlyMemory<byte> Value);

    /// <summary>A certificate read with a small, strict DER reader (6.9.4: no general X.509 processing).</summary>
    private sealed class Certificate
    {
        public required ReadOnlyMemory<byte> Raw { get; init; }
        public required ReadOnlyMemory<byte> Tbs { get; init; }
        public required string SignatureAlgorithm { get; init; }
        public required byte[] SignatureValue { get; init; }
        public required int Version { get; init; }
        public required ReadOnlyMemory<byte> Serial { get; init; }
        public required ReadOnlyMemory<byte> Issuer { get; init; }
        public required ReadOnlyMemory<byte> Subject { get; init; }
        public required DateTimeOffset NotBefore { get; init; }
        public required DateTimeOffset NotAfter { get; init; }
        public required ReadOnlyMemory<byte> Spki { get; init; }
        public required string KeyAlgorithm { get; init; }
        public required string Curve { get; init; }
        public required ReadOnlyMemory<byte> Point { get; init; }
        public required List<Extension> Extensions { get; init; }

        private byte[]? _sha256;
        private string? _thumbprint;
        private Dictionary<string, string>? _attributes;

        /// <summary>SHA-256 of the certificate's DER.</summary>
        public byte[] Sha256 => _sha256 ??= SHA256.HashData(Raw.Span);

        /// <summary>x5t#S256: base64url of <see cref="Sha256"/>.</summary>
        public string Thumbprint => _thumbprint ??= Base64Url.Encode(Sha256);

        public string SerialHex => Convert.ToHexStringLower(Serial.Span);

        public Extension? Find(string oid)
        {
            foreach (var e in Extensions)
                if (e.Oid == oid) return e;
            return null;
        }

        /// <summary>The subject's attributes, by OID (the last of each). Throws when the subject is malformed.</summary>
        public Dictionary<string, string> Attributes => _attributes ??= ReadAttributes(Subject);

        public string? CommonName => Attributes.GetValueOrDefault(Oid.CommonName);

        /// <summary>subjectKeyIdentifier, or null.</summary>
        public ReadOnlyMemory<byte>? SubjectKeyId
        {
            get
            {
                if (Find(Oid.SubjectKeyId) is not { } e) return null;
                var r = new AsnReader(e.Value, AsnEncodingRules.DER);
                if (!r.TryReadPrimitiveOctetString(out var id)) throw new AsnContentException();
                r.ThrowIfNotEmpty();
                return id;
            }
        }

        /// <summary>authorityKeyIdentifier's keyIdentifier, or null.</summary>
        public ReadOnlyMemory<byte>? AuthorityKeyId
        {
            get
            {
                if (Find(Oid.AuthorityKeyId) is not { } e) return null;
                var outer = new AsnReader(e.Value, AsnEncodingRules.DER);
                var seq = outer.ReadSequence();
                outer.ThrowIfNotEmpty();
                if (!seq.HasData || !seq.PeekTag().HasSameClassAndValue(KeyIdentifier)) return null;
                if (!seq.TryReadPrimitiveOctetString(out var id, KeyIdentifier)) throw new AsnContentException();
                return id;
            }
        }

        /// <summary>The certificate's one extended key usage, or null (none, or more than one).</summary>
        public string? Eku
        {
            get
            {
                if (Find(Oid.ExtKeyUsage) is not { } e) return null;
                var list = Oids(e.Value, policies: false);
                return list.Count == 1 ? list[0] : null;
            }
        }

        /// <summary>The first dNSName of subjectAltName, or null.</summary>
        public string? Domain
        {
            get
            {
                if (Find(Oid.SubjectAltName) is not { } san) return null;
                var outer = new AsnReader(san.Value, AsnEncodingRules.DER);
                var names = outer.ReadSequence();
                outer.ThrowIfNotEmpty();
                while (names.HasData)
                {
                    if (names.PeekTag().HasSameClassAndValue(DnsName)) return names.ReadCharacterString(UniversalTagNumber.IA5String, DnsName);
                    names.ReadEncodedValue();
                }
                return null;
            }
        }

        public bool ValidAt(DateTimeOffset t) => t >= NotBefore && t <= NotAfter;

        /// <summary>A certificate, or null when it isn't strict DER of an X.509 certificate.</summary>
        public static Certificate? TryParse(ReadOnlyMemory<byte> raw)
        {
            try
            {
                return Parse(raw);
            }
            catch (Exception e) when (e is AsnContentException or OverflowException)
            {
                return null;
            }
        }

        private static Certificate Parse(ReadOnlyMemory<byte> raw)
        {
            const AsnEncodingRules der = AsnEncodingRules.DER;
            var outer = new AsnReader(raw, der);
            var cert = outer.ReadSequence();
            outer.ThrowIfNotEmpty();
            var tbsBytes = cert.ReadEncodedValue();
            var algorithm = cert.ReadSequence();
            var signatureAlgorithm = algorithm.ReadObjectIdentifier();
            algorithm.ThrowIfNotEmpty();
            var signature = cert.ReadBitString(out var unused);
            if (unused != 0) throw new AsnContentException();
            cert.ThrowIfNotEmpty();

            var tbsOuter = new AsnReader(tbsBytes, der);
            var tbs = tbsOuter.ReadSequence();
            tbsOuter.ThrowIfNotEmpty();
            var version = 1;
            if (tbs.PeekTag().HasSameClassAndValue(Context0))
            {
                var explicitVersion = tbs.ReadSequence(Context0);
                version = (int)explicitVersion.ReadInteger() + 1;
                explicitVersion.ThrowIfNotEmpty();
            }
            var serial = tbs.ReadIntegerBytes();
            var inner = tbs.ReadSequence();
            if (inner.ReadObjectIdentifier() != signatureAlgorithm) throw new AsnContentException();
            inner.ThrowIfNotEmpty();
            if (!tbs.PeekTag().HasSameClassAndValue(Asn1Tag.Sequence)) throw new AsnContentException();
            var issuer = tbs.ReadEncodedValue();
            var validity = tbs.ReadSequence();
            var notBefore = Time(validity);
            var notAfter = Time(validity);
            validity.ThrowIfNotEmpty();
            if (!tbs.PeekTag().HasSameClassAndValue(Asn1Tag.Sequence)) throw new AsnContentException();
            var subject = tbs.ReadEncodedValue();
            var spki = tbs.ReadEncodedValue();
            var spkiReader = new AsnReader(spki, der).ReadSequence();
            var keyAlgorithm = spkiReader.ReadSequence();
            var keyOid = keyAlgorithm.ReadObjectIdentifier();
            var curve = keyAlgorithm.HasData && keyAlgorithm.PeekTag().HasSameClassAndValue(Asn1Tag.ObjectIdentifier) ? keyAlgorithm.ReadObjectIdentifier() : "";
            if (!spkiReader.TryReadPrimitiveBitString(out var pointUnused, out var point) || pointUnused != 0) throw new AsnContentException();
            spkiReader.ThrowIfNotEmpty();
            var extensions = new List<Extension>();
            if (tbs.HasData && tbs.PeekTag().HasSameClassAndValue(Context3))
            {
                var wrapper = tbs.ReadSequence(Context3);
                var list = wrapper.ReadSequence();
                wrapper.ThrowIfNotEmpty();
                while (list.HasData)
                {
                    var e = list.ReadSequence();
                    var oid = e.ReadObjectIdentifier();
                    var critical = e.PeekTag().HasSameClassAndValue(Asn1Tag.Boolean) && e.ReadBoolean();
                    if (!e.TryReadPrimitiveOctetString(out var value)) throw new AsnContentException();
                    e.ThrowIfNotEmpty();
                    foreach (var x in extensions)
                        if (x.Oid == oid) throw new AsnContentException(); // an extension twice
                    extensions.Add(new Extension(oid, critical, value));
                }
            }
            tbs.ThrowIfNotEmpty();
            return new Certificate
            {
                Raw = raw, Tbs = tbsBytes, SignatureAlgorithm = signatureAlgorithm, SignatureValue = signature, Version = version, Serial = serial,
                Issuer = issuer, Subject = subject, NotBefore = notBefore, NotAfter = notAfter, Spki = spki, KeyAlgorithm = keyOid, Curve = curve,
                Point = point, Extensions = extensions,
            };
        }

        private static DateTimeOffset Time(AsnReader validity) =>
            validity.PeekTag().HasSameClassAndValue(Asn1Tag.UtcTime) ? validity.ReadUtcTime() : validity.ReadGeneralizedTime();

        private static Dictionary<string, string> ReadAttributes(ReadOnlyMemory<byte> subject)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            var outer = new AsnReader(subject, AsnEncodingRules.DER);
            var name = outer.ReadSequence();
            outer.ThrowIfNotEmpty();
            while (name.HasData)
            {
                var set = name.ReadSetOf();
                while (set.HasData)
                {
                    var pair = set.ReadSequence();
                    var oid = pair.ReadObjectIdentifier();
                    var tag = pair.PeekTag();
                    if (tag.TagClass != TagClass.Universal) throw new AsnContentException();
                    result[oid] = pair.ReadCharacterString((UniversalTagNumber)tag.TagValue);
                    pair.ThrowIfNotEmpty();
                }
            }
            return result;
        }

        /// <summary>A SEQUENCE OF OBJECT IDENTIFIER, or of PolicyInformation (the policy's identifier).</summary>
        public static List<string> Oids(ReadOnlyMemory<byte> value, bool policies)
        {
            var list = new List<string>();
            var outer = new AsnReader(value, AsnEncodingRules.DER);
            var seq = outer.ReadSequence();
            outer.ThrowIfNotEmpty();
            while (seq.HasData) list.Add(policies ? seq.ReadSequence().ReadObjectIdentifier() : seq.ReadObjectIdentifier());
            return list;
        }
    }

    /// <summary>
    /// A chain as a signature lists it (6.9.4): the leaf, its issuing certificate, optionally a cross-certificate, then the
    /// trusted root. Problem: a trusted chain outside the profile.
    /// </summary>
    private sealed record Chain(bool Trusted, string? Problem, Certificate Leaf, Certificate[] Certificates)
    {
        public static Chain Untrusted(Certificate leaf) => new(false, null, leaf, [leaf]);

        public bool ValidAt(DateTimeOffset t)
        {
            foreach (var c in Certificates)
                if (!c.ValidAt(t)) return false;
            return true;
        }
    }

    private enum Role { Root, Cross, Issuing, Leaf }

    /// <summary>A statement about a certificate (6.9.5): when it was made, and from when it says the certificate is revoked.</summary>
    private readonly record struct Statement(DateTimeOffset Time, DateTimeOffset? RevokedFrom);

    /// <summary>A status answer that verified (6.9.5).</summary>
    private sealed record Answer(string Status, DateTimeOffset? From, DateTimeOffset Time);

    /// <summary>A revocation list that verified (6.9.5): when it was issued, and the certificates it revokes from when.</summary>
    private sealed record Revocations(DateTimeOffset Issued, Dictionary<string, DateTimeOffset> Revoked);

    private static readonly JsonDocumentOptions UniqueNames = new() { AllowDuplicateProperties = false };

    // ---- the steps (spec 6.9.8) ------------------------------------------------------------------

    private sealed class Verification(Source file, JazminPublisherOptions options, JazminPublisherTrust trust)
    {
        private readonly JazminPublisherTrust _trust = trust;
        private readonly ArcOids _oids = new(trust.Arc);
        private readonly Dictionary<(Certificate Issuer, Certificate Child), bool> _issued = [];
        private List<Certificate>? _roots;

        private List<Certificate> Roots
        {
            get
            {
                if (_roots is not null) return _roots;
                _roots = new List<Certificate>(_trust.Roots.Count);
                foreach (var root in _trust.Roots) _roots.Add(Certificate.TryParse(root) ?? throw new JazminException("A trusted root is not a valid certificate"));
                return _roots;
            }
        }

        public JazminPublisherResult Run()
        {
            // 0. A file that doesn't start with the magic, or whose last bytes are not a valid trailer, is not a valid file
            // (4.2), and isn't verified (6.9.1).
            var size = file.Length;
            if (size < FormatConstants.PreambleSize + FormatConstants.TrailerSize) return Result(JazminPublisherStatus.NotVerified, "not-a-valid-file");
            Span<byte> t = stackalloc byte[FormatConstants.TrailerSize];
            file.Read(size - FormatConstants.TrailerSize, t);
            if (!t[40..].SequenceEqual(FormatConstants.Magic) || Crc32.Compute(t[..36]) != BinaryPrimitives.ReadUInt32LittleEndian(t[36..]))
                return Result(JazminPublisherStatus.NotVerified, "not-a-valid-file");
            var preamble = file.Read(0, FormatConstants.PreambleSize);
            if (!preamble.AsSpan(0, 4).SequenceEqual(FormatConstants.Magic)) return Result(JazminPublisherStatus.NotVerified, "not-a-valid-file");
            var h = (long)BinaryPrimitives.ReadUInt64LittleEndian(t);
            long headerLength = BinaryPrimitives.ReadUInt32LittleEndian(t[8..]);
            var slotsAt = BinaryPrimitives.ReadUInt64LittleEndian(t[12..]);
            var slotsOffset = (long)slotsAt;
            long slotsLength = BinaryPrimitives.ReadUInt32LittleEndian(t[20..]);
            var signatureOffset = (long)BinaryPrimitives.ReadUInt64LittleEndian(t[24..]);
            long signatureLength = BinaryPrimitives.ReadUInt32LittleEndian(t[32..]);
            var trailerStart = size - FormatConstants.TrailerSize;
            if (h < FormatConstants.PreambleSize || h > trailerStart || headerLength > trailerStart - h
                || Math.Max(h + headerLength, signatureOffset + signatureLength) != trailerStart)
                return Result(JazminPublisherStatus.NotVerified, "not-a-valid-file");

            // 1. The block before the header: its footer, CRC and payload (6.9.1), then its coverage.
            if (h < FormatConstants.PreambleSize + FooterSize) return Result(JazminPublisherStatus.None);
            Span<byte> footer = stackalloc byte[FooterSize];
            file.Read(h - FooterSize, footer);
            if (!footer[12..].SequenceEqual("JZPS"u8)) return Result(JazminPublisherStatus.None);
            long blockLength = BinaryPrimitives.ReadUInt32LittleEndian(footer);
            var b = h - FooterSize - blockLength;
            if (b < FormatConstants.PreambleSize || BinaryPrimitives.ReadUInt16LittleEndian(footer[8..]) != 1 || BinaryPrimitives.ReadUInt16LittleEndian(footer[10..]) != 0
                || blockLength > Array.MaxLength)
                return Invalid("block");
            var payload = file.Segment(b, (int)blockLength);
            if (Crc32.Compute(payload) != BinaryPrimitives.ReadUInt32LittleEndian(footer[4..])) return Invalid("block");
            if (Block.Parse(payload) is not { } block || SignedDocument.Parse(block.Signed) is not { Version: 1 } signed) return Invalid("block");
            var headerEnd = h + headerLength;
            if (signatureLength > 0 ? headerEnd != signatureOffset || signatureOffset + signatureLength != trailerStart : headerEnd != trailerStart)
                return Result(JazminPublisherStatus.Changed, "coverage");
            // Every section the trailer points to lies in a covered range: the key slots before B.
            if (slotsLength > 0 && (slotsAt > (ulong)b || (ulong)slotsLength > (ulong)b - slotsAt)) return Result(JazminPublisherStatus.Changed, "coverage");

            // 2. D (6.9.2) and the file id.
            var fileId = preamble.AsSpan(8, FormatConstants.FileIdSize);
            var d = FileDigest(fileId, b, h, headerLength, signatureOffset, signatureLength);
            if (!signed.FileId.Span.SequenceEqual(fileId) || !signed.FileDigest.Span.SequenceEqual(d)) return Result(JazminPublisherStatus.Changed, "digest");

            // 3. algorithms entry for entry, the publisher first, and each signature this reader knows.
            var signatures = block.Signatures;
            if (signatures.Count != signed.Algorithms.Count || signatures.Count == 0 || signatures[0].Role != "publisher") return Invalid("algorithms");
            for (var i = 0; i < signatures.Count; i++)
                if (signatures[i].Algorithm != signed.Algorithms[i] || (i > 0 && signatures[i].Role != "cosigner")) return Invalid("algorithms");
            if (signatures[0].Algorithm != "ES256") return Invalid("algorithms");
            var pool = new List<Certificate>();
            foreach (var s in signatures)
                foreach (var der in s.Certificates)
                {
                    if (Certificate.TryParse(der) is not { } c) return Invalid("chain");
                    s.Parsed.Add(c);
                    pool.Add(c);
                }
            foreach (var der in block.Certificates)
            {
                if (Certificate.TryParse(der) is not { } c) return Invalid("chain");
                pool.Add(c);
            }
            var message = new byte[18 + block.Signed.Length];
            "JAZMIN/1/publisher"u8.CopyTo(message);
            block.Signed.Span.CopyTo(message.AsSpan(18));
            var chains = new List<(Signature Signature, Chain Chain)>();
            foreach (var s in signatures)
            {
                if (s.Algorithm != "ES256") continue; // a later algorithm this reader doesn't know (6.9.2)
                if (s.Parsed.Count == 0) return Invalid("chain");
                if (!VerifyEcdsa(s.Parsed[0], message, s.Value.Span, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) return Invalid("signature");
                chains.Add((s, Check(s.Parsed, _oids.DocumentSigning)));
            }
            // Signed: the publisher's certificate doesn't chain to a trusted root. No name, facts or code.
            if (!chains[0].Chain.Trusted) return Result(JazminPublisherStatus.Signed);

            // 4. Each chain, timestamp and log receipt.
            var times = new DateTimeOffset[chains.Count];
            for (var i = 0; i < chains.Count; i++)
            {
                var (s, chain) = chains[i];
                if (!chain.Trusted || chain.Problem is not null) return Invalid("chain");
                if (Timestamp(s.Timestamp, s.Value.Span, pool) is not { } at || !chain.ValidAt(at)) return Invalid("timestamp");
                if (!Receipt(s.LogReceipt, LogEntry(block.Signed.Span, s.Value.Span), pool, at)) return Invalid("log");
                times[i] = at;
            }

            // 5. Revocation: per certificate, the most recent statement held (6.9.5). The stored and online answers are
            // about the publisher's certificate; the list about every one.
            var publisher = chains[0].Chain;
            var digest = Base64Url.Encode(d);
            var publisherName = Name(publisher.Certificates[0], publisher.Certificates[1]);
            var stored = block.Status.Length > 0 ? StatusAnswer(block.Status, digest, digest, signed.Code, publisherName, pool) : null;
            var online = options.StatusAnswer is { } asked && NonceLongEnough(asked.Nonce)
                ? StatusAnswer((asked.Answer ?? "").Trim(), digest, asked.Nonce, signed.Code, publisherName, pool)
                : null;
            var list = options.RevocationList is { } text ? RevocationList(text.Trim()) : null;
            DateTimeOffset? checkedAt = null;
            for (var i = 0; i < chains.Count; i++)
            {
                var chain = chains[i].Chain;
                Statement? latest = null;
                void Consider(Statement statement)
                {
                    if (latest is null || statement.Time > latest.Value.Time) latest = statement;
                }
                if (i == 0 && stored is not null) Consider(new Statement(stored.Time, stored.Status == "revoked" ? stored.From : null));
                if (list is not null) Consider(new Statement(list.Issued, list.Revoked.TryGetValue(Name(chain.Certificates[0], chain.Certificates[1]), out var from) ? from : null));
                if (i == 0 && online is not null) Consider(new Statement(online.Time, online.Status == "revoked" ? online.From : null));
                if (i == 0) checkedAt = latest?.Time;
                if (latest?.RevokedFrom is { } revokedFrom && revokedFrom <= times[i]) return Invalid("revoked");
            }

            // 6. The facts, with a key that reads the header, or in a file that isn't encrypted (6.9.3).
            var flags = BinaryPrimitives.ReadUInt16LittleEndian(preamble.AsSpan(FormatConstants.FlagsOffset));
            var encrypted = (flags & FormatConstants.FlagEncrypted) != 0;
            Dictionary<string, string>? facts = null;
            if (signed.FactsDigest.Length > 0)
            {
                byte[]? plain = null;
                if (!encrypted) plain = block.Facts.ToArray();
                else if (Keys(preamble, flags, slotsOffset, slotsLength) is { } keys)
                {
                    plain = DecryptFacts(keys.Facts, block.Facts.Span, fileId);
                    // Facts that don't open with a key that reads the header were changed; a key that reads neither reads nothing.
                    if (plain is null && ReadsHeader(keys.Header, h, headerLength, preamble[8..24])) return Invalid("facts");
                }
                if (plain is not null)
                {
                    if (!SHA256.HashData(plain).AsSpan().SequenceEqual(signed.FactsDigest.Span) || plain.Length < 16) return Invalid("facts");
                    facts = ParseFacts(plain.AsSpan(16));
                    if (facts is null) return Invalid("facts");
                }
            }

            // Withdrawn or superseded: only status answers say so, the most recent of the stored and online ones (6.9.5).
            var status = JazminPublisherStatus.Certified;
            var answer = online is not null && (stored is null || online.Time > stored.Time) ? online : stored;
            if (answer is { Status: "withdrawn" or "superseded", From: { } since } && since <= _trust.At)
                status = answer.Status == "withdrawn" ? JazminPublisherStatus.Withdrawn : JazminPublisherStatus.Superseded;

            var cosigners = new JazminPublisherIdentity[chains.Count - 1];
            for (var i = 1; i < chains.Count; i++) cosigners[i - 1] = Identity(chains[i].Chain.Leaf);
            var identity = Identity(publisher.Leaf);
            return new JazminPublisherResult
            {
                Status = status,
                Name = identity.Name,
                Organization = identity.Organization,
                Registration = identity.Registration,
                Country = identity.Country,
                Domain = identity.Domain,
                Kind = identity.Kind,
                Code = signed.Code,
                DocumentKind = signed.Kind,
                Credential = signed.Credential,
                SignedAt = signed.SignedAt is >= -62_135_596_800_000 and <= 253_402_300_799_999 ? DateTimeOffset.FromUnixTimeMilliseconds(signed.SignedAt) : null,
                Timestamp = times[0],
                Cosigners = cosigners,
                Facts = facts,
                FactsNeedKey = encrypted,
                StatusAnswer = stored is null ? null : new JazminStoredStatus(stored.Status, stored.From),
                CheckedAt = checkedAt,
            };
        }

        private static JazminPublisherResult Invalid(string reason) => Result(JazminPublisherStatus.Invalid, reason);

        /// <summary>
        /// D = SHA-256("JAZMIN/1/publisher-file" || file_id || SHA-256(bytes[0, B)) || SHA-256(header section) ||
        /// SHA-256(signature section, or no bytes)) (6.9.2).
        /// </summary>
        private byte[] FileDigest(ReadOnlySpan<byte> fileId, long b, long h, long headerLength, long signatureOffset, long signatureLength)
        {
            ReadOnlySpan<byte> label = "JAZMIN/1/publisher-file"u8;
            Span<byte> input = stackalloc byte[label.Length + FormatConstants.FileIdSize + 3 * 32];
            label.CopyTo(input);
            fileId.CopyTo(input[label.Length..]);
            var at = label.Length + FormatConstants.FileIdSize;
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            file.Hash(sha, 0, b);
            sha.GetHashAndReset(input.Slice(at, 32));
            file.Hash(sha, h, headerLength);
            sha.GetHashAndReset(input.Slice(at + 32, 32));
            if (signatureLength > 0) file.Hash(sha, signatureOffset, signatureLength);
            sha.GetHashAndReset(input.Slice(at + 64, 32));
            return SHA256.HashData(input);
        }

        // ---- chains (6.9.4) ----

        /// <summary>Whether <paramref name="issuer"/> issued <paramref name="child"/>: its name, its key identifier when the child names one, and its signature.</summary>
        private bool Issued(Certificate issuer, Certificate child)
        {
            if (_issued.TryGetValue((issuer, child), out var known)) return known;
            bool result;
            try
            {
                result = child.Issuer.Span.SequenceEqual(issuer.Subject.Span)
                    && (child.AuthorityKeyId is not { } aki || (issuer.SubjectKeyId is { } ski && aki.Span.SequenceEqual(ski.Span)))
                    && SignedBy(child, issuer);
            }
            catch (AsnContentException)
            {
                result = false; // a malformed key identifier: no issuer found by it
            }
            _issued[(issuer, child)] = result;
            return result;
        }

        private static bool SignedBy(Certificate child, Certificate issuer)
        {
            var hash = child.SignatureAlgorithm switch
            {
                Oid.EcdsaSha256 => HashAlgorithmName.SHA256,
                Oid.EcdsaSha384 => HashAlgorithmName.SHA384,
                _ => default,
            };
            return hash != default && VerifyEcdsa(issuer, child.Tbs.Span, child.SignatureValue, DSASignatureFormat.Rfc3279DerSequence, hash);
        }

        private Certificate? TrustedIssuer(Certificate child)
        {
            foreach (var root in Roots)
                if (Issued(root, child)) return root;
            return null;
        }

        private Certificate? IssuerIn(IReadOnlyList<Certificate> pool, Certificate child)
        {
            foreach (var c in pool)
                if (Issued(c, child)) return c;
            return null;
        }

        /// <summary>
        /// A chain as listed (6.9.4): trusted when the issuing certificate is signed by a trusted root, or by the root in the
        /// cross-certificate and the cross-certificate by a trusted root. No other chain is accepted.
        /// </summary>
        private Chain Check(IReadOnlyList<Certificate> listed, string eku)
        {
            var leaf = listed[0];
            if (listed.Count is < 2 or > 3) return Chain.Untrusted(leaf); // a self-signed certificate alone, or no chain the profile has
            var issuing = listed[1];
            var cross = listed.Count == 3 ? listed[2] : null;
            if (!Issued(issuing, leaf)) return Chain.Untrusted(leaf);
            var root = cross is null ? TrustedIssuer(issuing) : Issued(cross, issuing) ? TrustedIssuer(cross) : null;
            if (root is null) return Chain.Untrusted(leaf);
            var problem = Profile(leaf, Role.Leaf, eku) ?? Profile(issuing, Role.Issuing, null)
                ?? (cross is null ? null : Profile(cross, Role.Cross, null)) ?? Profile(root, Role.Root, null);
            return new Chain(true, problem, leaf, cross is null ? [leaf, issuing, root] : [leaf, issuing, cross, root]);
        }

        /// <summary>
        /// The chain of a certificate the block shares (6.9.6): its issuing certificate and any cross-certificate, found by
        /// issuer name and authorityKeyIdentifier among <paramref name="pool"/> (6.9.4).
        /// </summary>
        private Chain Build(Certificate leaf, IReadOnlyList<Certificate> pool, string eku)
        {
            if (IssuerIn(pool, leaf) is not { } issuing) return Chain.Untrusted(leaf);
            if (TrustedIssuer(issuing) is not null) return Check([leaf, issuing], eku);
            return Check(IssuerIn(pool, issuing) is { } cross ? [leaf, issuing, cross] : [leaf, issuing], eku);
        }

        /// <summary>
        /// The profile's rows (6.9.4): a root (and a cross-certificate) P-384 signed with ecdsa-with-SHA384 and path length 2;
        /// an issuing certificate P-256 signed with ecdsa-with-SHA384, path length 0; leaves P-256 signed with
        /// ecdsa-with-SHA256, one extended key usage. Only the listed extensions, with their criticality, and the key
        /// identifiers the profile requires. Null when inside it.
        /// </summary>
        private string? Profile(Certificate c, Role role, string? eku)
        {
            try
            {
                if (c.Version != 3) return "not X.509 v3";
                if (c.KeyAlgorithm != Oid.EcPublicKey || c.Curve != (role is Role.Root or Role.Cross ? Oid.P384 : Oid.P256)) return "key";
                if (c.SignatureAlgorithm != (role == Role.Leaf ? Oid.EcdsaSha256 : Oid.EcdsaSha384)) return "signature algorithm";
                var publisher = role == Role.Leaf && eku == _oids.DocumentSigning;
                foreach (var e in c.Extensions)
                {
                    bool allowed;
                    if (e.Oid is Oid.BasicConstraints or Oid.KeyUsage) allowed = e.Critical;
                    else if (e.Oid == Oid.ExtKeyUsage) allowed = role == Role.Leaf && e.Critical == (eku == Oid.TimeStamping);
                    else if (e.Oid is Oid.Policies or Oid.SubjectKeyId or Oid.AuthorityKeyId) allowed = !e.Critical;
                    else if (e.Oid == Oid.SubjectAltName) allowed = publisher && !e.Critical;
                    else if (e.Oid == _oids.PublisherKind) allowed = publisher && !e.Critical && PublisherKind(c) is "company" or "individual";
                    else allowed = false;
                    if (!allowed) return $"extension {e.Oid}";
                }
                var ca = false;
                int? pathLength = null;
                if (c.Find(Oid.BasicConstraints) is { } basic)
                {
                    var outer = new AsnReader(basic.Value, AsnEncodingRules.DER);
                    var seq = outer.ReadSequence();
                    outer.ThrowIfNotEmpty();
                    if (seq.HasData && seq.PeekTag().HasSameClassAndValue(Asn1Tag.Boolean)) ca = seq.ReadBoolean();
                    if (seq.HasData) pathLength = (int)seq.ReadInteger();
                    seq.ThrowIfNotEmpty();
                }
                var usage = c.Find(Oid.KeyUsage) is { } u ? KeyUsage(u.Value) : -1;
                if (role == Role.Leaf)
                {
                    if (ca) return "a leaf that is a CA";
                    if (usage != 1 << 0) return "key usage"; // digitalSignature
                    if (c.Eku != eku) return "extended key usage";
                    _ = c.Attributes; // what a reader shows of it must read
                    if (publisher) _ = c.Domain;
                }
                else
                {
                    if (!ca || pathLength != (role == Role.Issuing ? 0 : 2)) return "basic constraints";
                    if (usage != ((1 << 5) | (1 << 6))) return "key usage"; // keyCertSign, cRLSign
                }
                if (c.Find(Oid.Policies) is not { } policies || !Certificate.Oids(policies.Value, policies: true).Contains(_oids.Policy)) return "certificate policy";
                // subjectKeyIdentifier in root, cross- and issuing certificates; authorityKeyIdentifier in every one but a root.
                if (role != Role.Leaf && c.SubjectKeyId is null) return "no subjectKeyIdentifier";
                if (role != Role.Root && c.AuthorityKeyId is null) return "no authorityKeyIdentifier";
                return null;
            }
            catch (Exception e) when (e is AsnContentException or ArgumentException or OverflowException)
            {
                return "malformed";
            }
        }

        /// <summary>The key usage bits, bit i of the BIT STRING as 1 &lt;&lt; i.</summary>
        private static int KeyUsage(ReadOnlyMemory<byte> value)
        {
            var reader = new AsnReader(value, AsnEncodingRules.DER);
            var bits = reader.ReadBitString(out var unused);
            reader.ThrowIfNotEmpty();
            if (bits.Length > 2) return -1; // bits this profile doesn't use
            var set = 0;
            for (var i = 0; i < bits.Length * 8 - unused; i++)
                if ((bits[i / 8] & (0x80 >> (i % 8))) != 0) set |= 1 << i;
            return set;
        }

        /// <summary>id-jazmin-publisher-kind: a UTF8String, or null.</summary>
        private string? PublisherKind(Certificate c)
        {
            if (c.Find(_oids.PublisherKind) is not { } kind) return null;
            var reader = new AsnReader(kind.Value, AsnEncodingRules.DER);
            var text = reader.ReadCharacterString(UniversalTagNumber.UTF8String);
            reader.ThrowIfNotEmpty();
            return text;
        }

        /// <summary>What a reader shows of a trusted publisher's certificate (6.9.4).</summary>
        private JazminPublisherIdentity Identity(Certificate c)
        {
            var a = c.Attributes;
            return new JazminPublisherIdentity(a.GetValueOrDefault(Oid.CommonName), a.GetValueOrDefault(Oid.Organization),
                a.GetValueOrDefault(Oid.OrganizationIdentifier), a.GetValueOrDefault(Oid.Country), c.Domain, PublisherKind(c));
        }

        /// <summary>A certificate's name in statements (6.9.5): issuer (base64url SHA-256 of its issuing certificate's SPKI) and serial.</summary>
        private static string Name(Certificate certificate, Certificate issuing) =>
            Base64Url.Encode(SHA256.HashData(issuing.Spki.Span)) + "/" + certificate.SerialHex;

        /// <summary>ECDSA with the certificate's key (P-256 or P-384, an uncompressed point); false when it doesn't verify.</summary>
        private static bool VerifyEcdsa(Certificate key, ReadOnlySpan<byte> data, ReadOnlySpan<byte> signature, DSASignatureFormat format,
            HashAlgorithmName? hash = null)
        {
            var (curve, size) = key.Curve switch
            {
                Oid.P256 => (ECCurve.NamedCurves.nistP256, 32),
                Oid.P384 => (ECCurve.NamedCurves.nistP384, 48),
                _ => (default(ECCurve), 0),
            };
            var point = key.Point.Span;
            if (key.KeyAlgorithm != Oid.EcPublicKey || size == 0 || point.Length != 1 + 2 * size || point[0] != 0x04) return false;
            try
            {
                using var ecdsa = ECDsa.Create(new ECParameters { Curve = curve, Q = new ECPoint { X = point.Slice(1, size).ToArray(), Y = point.Slice(1 + size, size).ToArray() } });
                return ecdsa.VerifyData(data, signature, hash ?? HashAlgorithmName.SHA256, format);
            }
            catch (Exception e) when (e is CryptographicException or PlatformNotSupportedException)
            {
                return false; // not a point on the curve (Windows reports it as an unsupported curve)
            }
        }

        // ---- the timestamp (6.9.5) ----

        /// <summary>
        /// The time an RFC 3161 token over SHA-256(<paramref name="value"/>) proves, from a time-stamping certificate whose
        /// chain is trusted, inside the profile and valid then; null otherwise. Read with this verifier's own DER reader.
        /// </summary>
        private DateTimeOffset? Timestamp(ReadOnlyMemory<byte> token, ReadOnlySpan<byte> value, List<Certificate> pool)
        {
            if (token.IsEmpty) return null;
            try
            {
                const AsnEncodingRules der = AsnEncodingRules.DER;
                var outer = new AsnReader(token, der);
                var contentInfo = outer.ReadSequence();
                outer.ThrowIfNotEmpty();
                if (contentInfo.ReadObjectIdentifier() != Oid.SignedData) return null;
                var content = contentInfo.ReadSequence(Context0);
                contentInfo.ThrowIfNotEmpty();
                var signedData = content.ReadSequence();
                content.ThrowIfNotEmpty();
                signedData.ReadInteger(); // version
                signedData.ReadSetOf(); // digestAlgorithms
                var encapsulated = signedData.ReadSequence();
                if (encapsulated.ReadObjectIdentifier() != Oid.TstInfo) return null;
                var eContent = encapsulated.ReadSequence(Context0);
                encapsulated.ThrowIfNotEmpty();
                if (!eContent.TryReadPrimitiveOctetString(out var tstInfo)) return null;
                eContent.ThrowIfNotEmpty();
                // The signer is among the block's certificates and the token's own (a token SHOULD carry none the block has).
                var candidates = pool;
                if (signedData.HasData && signedData.PeekTag().HasSameClassAndValue(Context0))
                {
                    candidates = [.. pool];
                    var set = signedData.ReadSetOf(Context0);
                    while (set.HasData)
                    {
                        if (Certificate.TryParse(set.ReadEncodedValue()) is not { } c) return null;
                        candidates.Add(c);
                    }
                }
                if (signedData.HasData && signedData.PeekTag().HasSameClassAndValue(Context1)) signedData.ReadEncodedValue(); // crls
                var signerInfos = signedData.ReadSetOf();
                signedData.ThrowIfNotEmpty();
                var signerInfo = signerInfos.ReadSequence();
                signerInfos.ThrowIfNotEmpty(); // one SignerInfo
                signerInfo.ReadInteger(); // version
                ReadOnlyMemory<byte> sidIssuer = default, sidSerial = default, sidKeyId = default;
                var bySerial = signerInfo.PeekTag().HasSameClassAndValue(Asn1Tag.Sequence);
                if (bySerial)
                {
                    var sid = signerInfo.ReadSequence(); // issuerAndSerialNumber
                    sidIssuer = sid.ReadEncodedValue();
                    sidSerial = sid.ReadIntegerBytes();
                    sid.ThrowIfNotEmpty();
                }
                else if (!signerInfo.TryReadPrimitiveOctetString(out sidKeyId, KeyIdentifier)) return null; // subjectKeyIdentifier
                if (!IsSha256(signerInfo.ReadSequence())) return null; // digestAlgorithm
                if (!signerInfo.PeekTag().HasSameClassAndValue(Context0)) return null;
                var signedAttributes = signerInfo.PeekEncodedValue();
                var attributes = signerInfo.ReadSetOf(Context0);
                bool contentType = false;
                ReadOnlyMemory<byte>? messageDigest = null, certHash = null;
                while (attributes.HasData)
                {
                    var attribute = attributes.ReadSequence();
                    var type = attribute.ReadObjectIdentifier();
                    var values = attribute.ReadSetOf();
                    attribute.ThrowIfNotEmpty();
                    switch (type)
                    {
                        case Oid.ContentType:
                            if (contentType || values.ReadObjectIdentifier() != Oid.TstInfo) return null;
                            contentType = true;
                            break;
                        case Oid.MessageDigest:
                            if (messageDigest is not null || !values.TryReadPrimitiveOctetString(out var md)) return null;
                            messageDigest = md;
                            break;
                        case Oid.SigningCertificateV2:
                            if (certHash is not null) return null;
                            var signingCertificate = values.ReadSequence();
                            var first = signingCertificate.ReadSequence().ReadSequence(); // the first ESSCertIDv2
                            if (first.PeekTag().HasSameClassAndValue(Asn1Tag.Sequence) && !IsSha256(first.ReadSequence())) return null; // SHA-256 by default
                            if (!first.TryReadPrimitiveOctetString(out var hash)) return null;
                            certHash = hash;
                            break;
                        default:
                            continue; // other attributes (signing time) are not used
                    }
                    values.ThrowIfNotEmpty();
                }
                if (!contentType || messageDigest is not { } digest || certHash is not { } signerHash) return null;
                var algorithm = signerInfo.ReadSequence();
                if (algorithm.ReadObjectIdentifier() != Oid.EcdsaSha256) return null;
                algorithm.ThrowIfNotEmpty();
                if (!signerInfo.TryReadPrimitiveOctetString(out var signature)) return null;
                if (signerInfo.HasData && signerInfo.PeekTag().HasSameClassAndValue(Context1)) signerInfo.ReadEncodedValue(); // unsignedAttrs
                signerInfo.ThrowIfNotEmpty();

                // TSTInfo: version 1, the policy, SHA-256 of the signature's value, the time.
                Span<byte> hashed = stackalloc byte[32];
                SHA256.HashData(tstInfo.Span, hashed);
                if (!hashed.SequenceEqual(digest.Span)) return null;
                var infoOuter = new AsnReader(tstInfo, der);
                var info = infoOuter.ReadSequence();
                infoOuter.ThrowIfNotEmpty();
                if (info.ReadInteger() != 1 || info.ReadObjectIdentifier() != _oids.Policy) return null;
                var imprint = info.ReadSequence();
                if (!IsSha256(imprint.ReadSequence()) || !imprint.TryReadPrimitiveOctetString(out var imprinted)) return null;
                imprint.ThrowIfNotEmpty();
                SHA256.HashData(value, hashed);
                if (!hashed.SequenceEqual(imprinted.Span)) return null;
                info.ReadIntegerBytes(); // serialNumber
                var genTime = info.ReadGeneralizedTime();

                // The signer: named by sid, its SHA-256 the first certHash, its signature over the attributes as a SET.
                var signedBytes = signedAttributes.ToArray();
                signedBytes[0] = 0x31;
                foreach (var c in candidates)
                {
                    var named = bySerial
                        ? c.Issuer.Span.SequenceEqual(sidIssuer.Span) && c.Serial.Span.SequenceEqual(sidSerial.Span)
                        : c.SubjectKeyId is { } ski && ski.Span.SequenceEqual(sidKeyId.Span);
                    if (!named || !c.Sha256.AsSpan().SequenceEqual(signerHash.Span)) continue;
                    if (!VerifyEcdsa(c, signedBytes, signature.Span, DSASignatureFormat.Rfc3279DerSequence)) continue;
                    var chain = Build(c, candidates, Oid.TimeStamping);
                    return chain.Trusted && chain.Problem is null && chain.ValidAt(genTime) ? genTime : null;
                }
                return null;
            }
            catch (Exception e) when (e is AsnContentException or OverflowException)
            {
                return null;
            }
        }

        /// <summary>An AlgorithmIdentifier for SHA-256, its parameters absent or NULL.</summary>
        private static bool IsSha256(AsnReader algorithm)
        {
            if (algorithm.ReadObjectIdentifier() != Oid.Sha256) return false;
            if (algorithm.HasData) algorithm.ReadNull();
            algorithm.ThrowIfNotEmpty();
            return true;
        }

        // ---- the log (6.9.5) ----

        /// <summary>The log entry of a signature: "JAZMIN/1/log" || SHA-256(signed) || SHA-256(the signature's value).</summary>
        private static byte[] LogEntry(ReadOnlySpan<byte> signed, ReadOnlySpan<byte> value)
        {
            var entry = new byte[12 + 64];
            "JAZMIN/1/log"u8.CopyTo(entry);
            SHA256.HashData(signed, entry.AsSpan(12, 32));
            SHA256.HashData(value, entry.AsSpan(44, 32));
            return entry;
        }

        /// <summary>Whether a receipt (C2SP tlog-proof@v1) proves this entry is in a checkpoint a trusted log certificate signed.</summary>
        private bool Receipt(string text, byte[] entry, List<Certificate> pool, DateTimeOffset at)
        {
            try
            {
                var pos = 0;
                string Line()
                {
                    var nl = text.IndexOf('\n', pos);
                    if (nl < 0) throw new FormatException("The receipt ends early");
                    var line = text[pos..nl];
                    pos = nl + 1;
                    return line;
                }
                if (Line() != "c2sp.org/tlog-proof@v1") return false;
                var l = Line();
                if (l.StartsWith("extra ", StringComparison.Ordinal)) l = Line();
                if (!l.StartsWith("index ", StringComparison.Ordinal)) return false;
                var index = long.Parse(l.AsSpan(6), NumberStyles.None, CultureInfo.InvariantCulture);
                var proof = new List<byte[]>();
                while ((l = Line()).Length > 0) proof.Add(Convert.FromBase64String(l));
                if (Checkpoint(text[pos..], pool, at) is not { } checkpoint) return false;
                var (size, root) = checkpoint;
                var leaf = new byte[1 + entry.Length];
                entry.CopyTo(leaf, 1);
                return InTree(index, size, SHA256.HashData(leaf), proof, root);
            }
            catch (Exception e) when (e is FormatException or OverflowException)
            {
                return false;
            }
        }

        /// <summary>
        /// A C2SP checkpoint signed (DER ECDSA over SHA-256 of the note's text) by a trusted log certificate valid at
        /// <paramref name="at"/>, whose commonName is the origin and the key name, key id SHA-256(SPKI)[..4]: its size and root.
        /// </summary>
        private (long Size, byte[] Root)? Checkpoint(string note, List<Certificate> pool, DateTimeOffset at)
        {
            var split = note.IndexOf("\n\n", StringComparison.Ordinal);
            if (split < 0) return null;
            var body = note[..(split + 1)];
            var lines = body.TrimEnd('\n').Split('\n');
            if (lines.Length < 3) return null;
            var signatureLines = note[(split + 2)..].Split('\n', StringSplitOptions.RemoveEmptyEntries);
            byte[]? data = null;
            var verified = false;
            Span<byte> id = stackalloc byte[32];
            foreach (var log in pool)
            {
                if (verified) break;
                if (EkuOf(log) != _oids.Log) continue;
                var chain = Build(log, pool, _oids.Log);
                if (!chain.Trusted || chain.Problem is not null || !chain.ValidAt(at) || lines[0] != log.CommonName) continue;
                SHA256.HashData(log.Spki.Span, id);
                foreach (var line in signatureLines)
                {
                    var fields = line.Split(' ');
                    if (fields.Length != 3 || fields[0] != "—" || fields[1] != log.CommonName) continue; // an em dash
                    var raw = Convert.FromBase64String(fields[2]);
                    if (raw.Length < 5 || !raw.AsSpan(0, 4).SequenceEqual(id[..4])) continue;
                    data ??= Encoding.UTF8.GetBytes(body);
                    if (VerifyEcdsa(log, data, raw.AsSpan(4), DSASignatureFormat.Rfc3279DerSequence))
                    {
                        verified = true;
                        break;
                    }
                }
            }
            if (!verified) return null;
            return (long.Parse(lines[1], NumberStyles.None, CultureInfo.InvariantCulture), Convert.FromBase64String(lines[2]));
        }

        /// <summary>A certificate's one extended key usage; null when it has none, several, or a malformed list.</summary>
        private static string? EkuOf(Certificate c)
        {
            try
            {
                return c.Eku;
            }
            catch (AsnContentException)
            {
                return null;
            }
        }

        /// <summary>RFC 9162 (2.1.3.2): whether the inclusion proof puts this leaf at <paramref name="index"/> of a tree of <paramref name="size"/> with this root.</summary>
        private static bool InTree(long index, long size, byte[] leafHash, List<byte[]> proof, byte[] root)
        {
            if (index >= size) return false;
            long fn = index, sn = size - 1;
            Span<byte> r = stackalloc byte[32];
            Span<byte> node = stackalloc byte[65];
            leafHash.CopyTo(r);
            node[0] = 0x01;
            foreach (var p in proof)
            {
                if (p.Length != 32 || sn == 0) return false;
                if ((fn & 1) == 1 || fn == sn)
                {
                    p.CopyTo(node[1..]);
                    r.CopyTo(node[33..]);
                    while ((fn & 1) == 0 && fn != 0)
                    {
                        fn >>= 1;
                        sn >>= 1;
                    }
                }
                else
                {
                    r.CopyTo(node[1..]);
                    p.CopyTo(node[33..]);
                }
                SHA256.HashData(node, r);
                fn >>= 1;
                sn >>= 1;
            }
            return sn == 0 && r.SequenceEqual(root);
        }

        // ---- statements: status answers and revocation lists (6.9.5) ----

        /// <summary>
        /// A compact JWS (ES256) from a trusted certificate with this extended key usage, valid at the payload's
        /// <paramref name="timeField"/>, which must not be after the time verified at. x5t#S256 names the certificate, in
        /// x5c or, without x5c, among <paramref name="pool"/>. Null when it doesn't verify.
        /// </summary>
        private (JsonObject Payload, DateTimeOffset Time)? Jws(string jws, string eku, string timeField, List<Certificate> pool)
        {
            var first = jws.IndexOf('.');
            var second = first < 0 ? -1 : jws.IndexOf('.', first + 1);
            if (second < 0 || jws.IndexOf('.', second + 1) >= 0) return null;
            try
            {
                if (JsonNode.Parse(Base64Url.Decode(jws[..first]), documentOptions: UniqueNames) is not JsonObject header
                    || Text(header, "alg") != "ES256" || Text(header, "x5t#S256") is not { } thumbprint)
                    return null;
                var chains = new List<Chain>();
                if (header["x5c"] is JsonArray x5c)
                {
                    var listed = new List<Certificate>(x5c.Count);
                    foreach (var item in x5c)
                    {
                        if (String(item) is not { } der || Certificate.TryParse(Convert.FromBase64String(der)) is not { } c) return null;
                        listed.Add(c);
                    }
                    if (listed.Count == 0) return null;
                    chains.Add(Check(listed, eku));
                }
                else
                {
                    foreach (var c in pool)
                        if (c.Thumbprint == thumbprint) chains.Add(Build(c, pool, eku));
                }
                byte[]? input = null, signature = null;
                foreach (var chain in chains)
                {
                    if (chain.Leaf.Thumbprint != thumbprint || !chain.Trusted || chain.Problem is not null) continue;
                    input ??= Encoding.ASCII.GetBytes(jws, 0, second);
                    signature ??= Base64Url.Decode(jws[(second + 1)..]);
                    if (!VerifyEcdsa(chain.Leaf, input, signature, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) continue;
                    if (JsonNode.Parse(Base64Url.Decode(jws[(first + 1)..second]), documentOptions: UniqueNames) is not JsonObject payload) return null;
                    if (!TryTime(Text(payload, timeField), out var time) || !chain.ValidAt(time) || time > _trust.At) return null;
                    return (payload, time);
                }
                return null;
            }
            catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException)
            {
                return null; // not JSON, base64url or UTF-8 as a JWS needs
            }
        }

        /// <summary>
        /// A status answer about the publisher's certificate (6.9.5) for this D, nonce and code, from a trusted status
        /// certificate; null when it doesn't verify or lacks a required field (then it isn't used).
        /// </summary>
        private Answer? StatusAnswer(string jws, string digest, string nonce, string code, string publisherName, List<Certificate> pool)
        {
            if (Jws(jws, _oids.Status, "time", pool) is not { } verified) return null;
            var (payload, time) = verified;
            try
            {
                if (Text(payload, "digest") != digest || Text(payload, "nonce") != nonce || Text(payload, "code") != code
                    || CertificateName(payload["certificate"]) != publisherName)
                    return null;
                var status = Text(payload, "status");
                if (status is not ("valid" or "revoked" or "withdrawn" or "superseded")) return null;
                DateTimeOffset? from = null;
                if (payload["from"] is not null)
                {
                    if (!TryTime(Text(payload, "from"), out var parsed)) return null;
                    from = parsed;
                }
                else if (status != "valid") return null; // from is REQUIRED with revoked, withdrawn and superseded
                return new Answer(status, from, time);
            }
            catch (InvalidOperationException)
            {
                return null; // a name or text that isn't valid UTF-8
            }
        }

        /// <summary>A revocation list (6.9.5) from a trusted status certificate, carried in its x5c; null when it doesn't verify or is malformed.</summary>
        private Revocations? RevocationList(string jws)
        {
            if (Jws(jws, _oids.Status, "issued", []) is not { } verified) return null;
            try
            {
                if (verified.Payload["revoked"] is not JsonArray entries) return null;
                var revoked = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
                foreach (var entry in entries)
                {
                    // The reason isn't checked: a name this reader doesn't know still revokes (fail closed).
                    if (entry is not JsonObject e || CertificateName(e["certificate"]) is not { } name || !TryTime(Text(e, "from"), out var from)) return null;
                    if (!revoked.TryGetValue(name, out var earlier) || from < earlier) revoked[name] = from;
                }
                return new Revocations(verified.Time, revoked);
            }
            catch (InvalidOperationException)
            {
                return null; // a name or text that isn't valid UTF-8
            }
        }

        private static bool NonceLongEnough(string? nonce)
        {
            try
            {
                return nonce is not null && Base64Url.Decode(nonce).Length >= 16;
            }
            catch (FormatException)
            {
                return false;
            }
        }

        // ---- the facts (6.9.3) ----

        /// <summary>
        /// The facts key and the header key of the key given, derived as the header's key is: from the master key (a key, or
        /// a password), or in a shared file from H in this key's slot. Null when the options hold no key for this file.
        /// </summary>
        private (byte[] Facts, byte[] Header)? Keys(byte[] preamble, ushort flags, long slotsOffset, long slotsLength)
        {
            var salt = preamble[24..56];
            if ((flags & FormatConstants.FlagAccess) != 0)
            {
                if (options.AccessKey is null && options.Key is null) return null;
                var header = HeaderSecret(options.AccessKey is not null ? options.AccessKey.Secret : options.Key!.Bytes, preamble[8..24], salt, slotsOffset, slotsLength);
                return header is null ? null : (Crypto.Hkdf(header, salt, "JAZMIN/1/publisher/facts"), AccessCrypto.HeaderKey(header, salt));
            }
            byte[] master;
            if (options.Key is not null) master = options.Key.ToBytes();
            else
            {
                var iterations = BinaryPrimitives.ReadUInt32LittleEndian(preamble.AsSpan(56));
                if (string.IsNullOrEmpty(options.Password) || (flags & FormatConstants.FlagPassword) == 0
                    || iterations is < FormatConstants.MinKdfIterations or > FormatConstants.MaxKdfIterations)
                    return null;
                master = Crypto.DeriveFromPassword(options.Password, salt, (int)iterations);
            }
            return (Crypto.Hkdf(master, salt, "JAZMIN/1/publisher/facts"), Crypto.Hkdf(master, salt, "JAZMIN/1/header"));
        }

        /// <summary>H from this key's slot (7.6.4), as the reader finds it; null when the key has none, or it needs an unlock token.</summary>
        private byte[]? HeaderSecret(ReadOnlySpan<byte> secret, byte[] fileId, byte[] salt, long slotsOffset, long slotsLength)
        {
            var size = file.Length;
            if (slotsLength == 0 || slotsOffset < FormatConstants.PreambleSize || slotsOffset > size - slotsLength) return null;
            try
            {
                var list = SectionCodec.DecodeSegment(JazminReader.PlainSection(file.Read(slotsOffset, (int)slotsLength), "keyslots"), null, fileId, "keyslots");
                if (AccessCrypto.FindKeySlotPage(list, OwnerSigning.SlotId(secret)) is not { } page) return null;
                var (index, offset, length, digest) = page;
                if (offset < FormatConstants.PreambleSize || length < 0 || offset > size - length) return null;
                var pageSection = file.Read(offset, length);
                if (!AccessCrypto.Digest(pageSection).AsSpan().SequenceEqual(digest)) return null;
                var keySlots = AccessCrypto.ParseKeySlots(SectionCodec.DecodeSegment(JazminReader.PlainSection(pageSection, $"keyslots/{index}"), null, fileId, $"keyslots/{index}"));
                return String(AccessCrypto.UnsealSlot(keySlots, secret, salt, fileId)?["header"]) is { } header ? Convert.FromBase64String(header) : null;
            }
            catch (Exception e) when (e is JazminException or FormatException)
            {
                return null; // no slot this key opens (an online slot needs an unlock token)
            }
        }

        /// <summary>The stored facts decrypted (AES-256-GCM, 6.9.3), or null when they don't open with this key.</summary>
        private static byte[]? DecryptFacts(byte[] key, ReadOnlySpan<byte> stored, ReadOnlySpan<byte> fileId)
        {
            if (stored.Length < Crypto.NonceSize + Crypto.TagSize) return null;
            ReadOnlySpan<byte> label = "publisher/facts"u8;
            Span<byte> aad = stackalloc byte[FormatConstants.FileIdSize + 8 + label.Length];
            fileId.CopyTo(aad);
            aad.Slice(FormatConstants.FileIdSize, 8).Clear();
            aad[FormatConstants.FileIdSize + 1] = FormatConstants.SectionEncrypted; // the envelope of codec 0 with the ENCRYPTED flag (7.4)
            BinaryPrimitives.WriteUInt32LittleEndian(aad[(FormatConstants.FileIdSize + 4)..], (uint)(stored.Length - Crypto.NonceSize - Crypto.TagSize));
            label.CopyTo(aad[(FormatConstants.FileIdSize + 8)..]);
            try
            {
                return Crypto.Decrypt(key, stored, aad);
            }
            catch (JazminKeyException)
            {
                return null;
            }
        }

        /// <summary>Whether the header section opens with this header key: the key reads the file.</summary>
        private bool ReadsHeader(byte[] headerKey, long h, long headerLength, byte[] fileId)
        {
            if (headerLength > Array.MaxLength) return false;
            var section = file.Read(h, (int)headerLength);
            try
            {
                var (buffer, _) = SectionCodec.DecodePooled(section, section.Length, headerKey, fileId, FormatConstants.HeaderSectionId);
                ArrayPool<byte>.Shared.Return(buffer);
                return true;
            }
            catch (JazminException)
            {
                return false;
            }
        }

        /// <summary>The facts: a JSON object of text values (6.9.3), in their order; null when they are anything else.</summary>
        private static Dictionary<string, string>? ParseFacts(ReadOnlySpan<byte> json)
        {
            try
            {
                var reader = new Utf8JsonReader(json);
                if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) return null;
                var facts = new Dictionary<string, string>(StringComparer.Ordinal);
                while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
                {
                    var name = reader.GetString()!;
                    if (!reader.Read() || reader.TokenType != JsonTokenType.String || !facts.TryAdd(name, reader.GetString()!)) return null;
                }
                return reader.TokenType == JsonTokenType.EndObject && !reader.Read() ? facts : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }

    /// <summary>A member's text, or null when it is missing or not a string.</summary>
    private static string? Text(JsonObject o, string name) => String(o[name]);

    /// <summary>A JSON string's text, or null when the node isn't a string (or its text isn't valid UTF-8).</summary>
    private static string? String(JsonNode? node)
    {
        try
        {
            return node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>A certificate named in a statement (6.9.5): "issuer/serial", or null when malformed.</summary>
    private static string? CertificateName(JsonNode? node) =>
        node is JsonObject o && Text(o, "issuer") is { } issuer && Text(o, "serial") is { } serial ? issuer + "/" + serial : null;

    /// <summary>
    /// A time as statements give it (6.9.5): RFC 3339 in UTC, "yyyy-MM-ddTHH:mm:ss", optional fractional seconds, and "Z".
    /// An offset such as +02:00 is not a UTC time. Fractions finer than 100 ns are cut to 100 ns.
    /// </summary>
    private static bool TryTime(string? text, out DateTimeOffset time)
    {
        time = default;
        if (text is not { Length: >= 20 } || text[^1] != 'Z') return false;
        var body = text.AsSpan(0, text.Length - 1);
        if (body.Length > 19)
        {
            if (body[19] != '.' || body.Length == 20) return false;
            foreach (var c in body[20..])
                if (!char.IsAsciiDigit(c)) return false;
            if (body.Length > 27) body = body[..27];
        }
        return DateTimeOffset.TryParseExact(body, body.Length == 19 ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out time);
    }
}
