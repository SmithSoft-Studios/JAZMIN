using System.Collections.Concurrent;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace Jazmin;

/// <summary>
/// A key that opens only the parts of a file it has been granted. Its text form ("jza1-...")
/// carries the owner's fingerprint, so a reader can verify the file was signed by the same
/// owner that issued the key. Create one with <see cref="JazminKey.CreateAccessKey"/>.
/// </summary>
public sealed class JazminAccessKey
{
    private const string Prefix = "jza1-";
    internal const int SecretSize = 32;
    internal const int FingerprintSize = 8;
    private const int ChecksumSize = 4;

    private readonly byte[] _secret;
    private readonly byte[] _fingerprint;
    private string? _id; // each a hash: worked out once
    private string? _text;

    public JazminAccessKey(ReadOnlySpan<byte> secret, ReadOnlySpan<byte> ownerFingerprint)
    {
        if (secret.Length != SecretSize) throw new JazminKeyException("An access key secret must be 32 bytes");
        if (ownerFingerprint.Length != FingerprintSize) throw new JazminKeyException("An owner fingerprint must be 8 bytes");
        _secret = secret.ToArray();
        _fingerprint = ownerFingerprint.ToArray();
    }

    public static JazminAccessKey Parse(string text)
    {
        if (text is null || !text.StartsWith(Prefix, StringComparison.Ordinal))
            throw new JazminKeyException($"Access key text must start with '{Prefix}'");
        byte[] raw;
        try
        {
            raw = Base64Url.Decode(text[Prefix.Length..]);
        }
        catch (FormatException)
        {
            throw new JazminKeyException("Access key text is not valid base64url");
        }
        if (raw.Length != SecretSize + FingerprintSize + ChecksumSize) throw new JazminKeyException("Access key text has the wrong length");
        var body = raw.AsSpan(0, SecretSize + FingerprintSize);
        if (!SHA256.HashData(body)[..ChecksumSize].AsSpan().SequenceEqual(raw.AsSpan(SecretSize + FingerprintSize)))
            throw new JazminKeyException("Key checksum mismatch - the key text is mistyped or corrupted");
        // The text in its standard form: no need to hash again.
        return new JazminAccessKey(body[..SecretSize], body[SecretSize..]) { _text = Prefix + Base64Url.Encode(raw) };
    }

    /// <summary>
    /// A key from the owner directory, which the owner key decrypts and authenticates, so its checksum (there to catch
    /// mistyped keys) is not checked again. Each check is a hash; a file can grant thousands of keys.
    /// </summary>
    internal static JazminAccessKey FromOwnerDirectory(string text)
    {
        byte[] raw;
        try
        {
            raw = text is not null && text.StartsWith(Prefix, StringComparison.Ordinal) ? Base64Url.Decode(text[Prefix.Length..]) : [];
        }
        catch (FormatException)
        {
            raw = [];
        }
        if (raw.Length != SecretSize + FingerprintSize + ChecksumSize) return Parse(text!); // reported as for any key
        return new JazminAccessKey(raw.AsSpan(0, SecretSize), raw.AsSpan(SecretSize, FingerprintSize)) { _text = Prefix + Base64Url.Encode(raw) };
    }

    internal ReadOnlySpan<byte> Secret => _secret;

    internal ReadOnlySpan<byte> OwnerFingerprint => _fingerprint;

    /// <summary>Short public identifier (hex) of this key, safe to log.</summary>
    public string Id => _id ??= Convert.ToHexString(OwnerSigning.SlotId(_secret)).ToLowerInvariant();

    /// <summary>The key's secret text ("jza1-..."), to send to its holder or pass to Parse. Keep it out of logs.</summary>
    public string Export()
    {
        if (_text is not null) return _text;
        var body = new byte[SecretSize + FingerprintSize];
        _secret.CopyTo(body, 0);
        _fingerprint.CopyTo(body, SecretSize);
        return _text = Prefix + Base64Url.Encode([.. body, .. SHA256.HashData(body)[..ChecksumSize]]);
    }

    /// <summary>
    /// For now the same as <see cref="Export"/>. From 2.0 it prints only the key's <see cref="Id"/>
    /// (docs/SECURITY-REVIEW.md, D2): use <see cref="Export"/> to store or send a key.
    /// </summary>
    public override string ToString() => Export();
}

internal static class Base64Url
{
    public static string Encode(byte[] data) => Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] Decode(string text)
    {
        var s = text.Replace('-', '+').Replace('_', '/');
        s += (s.Length % 4) switch { 2 => "==", 3 => "=", 0 => "", _ => throw new FormatException() };
        return Convert.FromBase64String(s);
    }
}

/// <summary>
/// Deterministic ECDSA P-256 owner signing key (spec 7.6.1):
///   d = (OS2IP(HKDF(master, "", "JAZMIN/1/owner-signing", 48)) mod (n - 1)) + 1
/// The public point is computed here (not by the platform) so every OS derives the same key.
/// </summary>
internal static class OwnerSigning
{
    private static readonly BigInteger P = Parse("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
    private static readonly BigInteger N = Parse("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    private static readonly BigInteger A = P - 3;
    private static readonly BigInteger Gx = Parse("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296");
    private static readonly BigInteger Gy = Parse("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5");
    private static readonly ConcurrentDictionary<string, (byte[] D, byte[] PublicKey)> Cache = new();

    private static BigInteger Parse(string hex) => BigInteger.Parse("0" + hex, System.Globalization.NumberStyles.HexNumber);

    /// <summary>Returns (private scalar, 65-byte uncompressed public point) for an owner key.</summary>
    public static (byte[] D, byte[] PublicKey) Derive(ReadOnlySpan<byte> master)
    {
        var cacheKey = Convert.ToHexString(SHA256.HashData(master));
        if (Cache.TryGetValue(cacheKey, out var cached)) return cached;
        var okm = new byte[48];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, master, okm, ReadOnlySpan<byte>.Empty, Encoding.UTF8.GetBytes("JAZMIN/1/owner-signing"));
        var d = BigInteger.Remainder(new BigInteger(okm, isUnsigned: true, isBigEndian: true), N - 1) + 1;
        var (x, y) = Multiply(d);
        var result = (Fixed32(d), (byte[])[0x04, .. Fixed32(x), .. Fixed32(y)]);
        if (Cache.Count > 16) Cache.Clear(); // a few owner keys per process: kept small, like the JavaScript cache
        Cache[cacheKey] = result;
        return result;
    }

    private static byte[] Fixed32(BigInteger value)
    {
        var bytes = value.ToByteArray(isUnsigned: true, isBigEndian: true);
        if (bytes.Length == 32) return bytes;
        var padded = new byte[32];
        bytes.CopyTo(padded, 32 - bytes.Length);
        return padded;
    }

    private static BigInteger Mod(BigInteger v) => ((v % P) + P) % P;

    private static BigInteger Inverse(BigInteger v) => BigInteger.ModPow(Mod(v), P - 2, P);

    /// <summary>Affine double-and-add scalar multiplication d*G (run once per key, then cached).</summary>
    private static (BigInteger X, BigInteger Y) Multiply(BigInteger k)
    {
        (BigInteger X, BigInteger Y)? result = null;
        var addend = (X: Gx, Y: Gy);
        while (k > 0)
        {
            if (!k.IsEven) result = result is null ? addend : Add(result.Value, addend);
            addend = Double(addend);
            k >>= 1;
        }
        return result!.Value;
    }

    private static (BigInteger, BigInteger) Add((BigInteger X, BigInteger Y) p, (BigInteger X, BigInteger Y) q)
    {
        if (p.X == q.X) return Double(p); // P256 scalars here never hit the point at infinity
        var s = Mod((q.Y - p.Y) * Inverse(q.X - p.X));
        var x = Mod(s * s - p.X - q.X);
        return (x, Mod(s * (p.X - x) - p.Y));
    }

    private static (BigInteger, BigInteger) Double((BigInteger X, BigInteger Y) p)
    {
        var s = Mod((3 * p.X * p.X + A) * Inverse(2 * p.Y));
        var x = Mod(s * s - 2 * p.X);
        return (x, Mod(s * (p.X - x) - p.Y));
    }

    public static byte[] Sign(ReadOnlySpan<byte> master, byte[] message)
    {
        var (d, publicKey) = Derive(master);
        using var ecdsa = ECDsa.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            D = d,
            Q = new ECPoint { X = publicKey[1..33], Y = publicKey[33..] },
        });
        return ecdsa.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    public static bool Verify(byte[] publicKey, byte[] message, byte[] signature)
    {
        if (publicKey.Length != 65 || publicKey[0] != 0x04) return false;
        try
        {
            using var ecdsa = ECDsa.Create(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = publicKey[1..33], Y = publicKey[33..] },
            });
            return ecdsa.VerifyData(message, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (CryptographicException)
        {
            return false; // not a valid point on the curve
        }
    }

    /// <summary>First 8 bytes of SHA-256 of the owner's public key.</summary>
    public static byte[] Fingerprint(byte[] publicKey) => SHA256.HashData(publicKey)[..JazminAccessKey.FingerprintSize];

    /// <summary>Identifier of the key slot opened by a secret (access secret or owner key bytes).</summary>
    public static byte[] SlotId(ReadOnlySpan<byte> secret) =>
        SHA256.HashData([.. "JAZMIN/1/slot-id"u8, .. secret])[..8];
}
