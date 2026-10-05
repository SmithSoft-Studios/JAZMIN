using System.Security.Cryptography;

namespace Jazmin;

/// <summary>
/// A 256-bit JAZMIN master key. Its text form ("jzk1-...") carries a 4-byte SHA-256
/// checksum so typos are detected before any decryption is attempted.
/// </summary>
public sealed class JazminKey
{
    private const string Prefix = "jzk1-";
    private const int KeySize = 32;
    private const int ChecksumSize = 4;
    private readonly byte[] _bytes;

    public JazminKey(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != KeySize) throw new JazminKeyException($"A JAZMIN key must be exactly {KeySize} bytes");
        _bytes = bytes.ToArray();
    }

    public static JazminKey Generate() => new(RandomNumberGenerator.GetBytes(KeySize));

    public static JazminKey Parse(string text)
    {
        if (text is null || !text.StartsWith(Prefix, StringComparison.Ordinal))
            throw new JazminKeyException($"Key text must start with '{Prefix}'");
        byte[] raw;
        try
        {
            raw = FromBase64Url(text[Prefix.Length..]);
        }
        catch (FormatException)
        {
            throw new JazminKeyException("Key text is not valid base64url");
        }
        if (raw.Length != KeySize + ChecksumSize) throw new JazminKeyException("Key text has the wrong length");
        var bytes = raw.AsSpan(0, KeySize);
        if (!Checksum(bytes).AsSpan().SequenceEqual(raw.AsSpan(KeySize)))
            throw new JazminKeyException("Key checksum mismatch - the key text is mistyped or corrupted");
        return new JazminKey(bytes);
    }

    /// <summary>Returns a copy of the raw key bytes.</summary>
    public byte[] ToBytes() => (byte[])_bytes.Clone();

    internal ReadOnlySpan<byte> Bytes => _bytes;

    /// <summary>The owner's public signing key (65-byte uncompressed P-256 point), stable for this key.</summary>
    public byte[] OwnerPublicKey => (byte[])OwnerSigning.Derive(_bytes).PublicKey.Clone();

    /// <summary>
    /// Creates a new access key issued by this (owner) key. Grant it rows/columns of a file with
    /// <see cref="JazminAccessOptions.Grants"/> or <see cref="JazminFile.GrantAccess"/>; on its own it opens nothing.
    /// </summary>
    public JazminAccessKey CreateAccessKey() =>
        new(RandomNumberGenerator.GetBytes(32), OwnerSigning.Fingerprint(OwnerSigning.Derive(_bytes).PublicKey));

    /// <summary>
    /// The submission key of one of this owner's access keys (spec 7.8): the key of the files its holder sends back,
    /// such as records captured offline. The writer seals it into that key's slot of each shared file, so only someone
    /// who opens the shared file with that access key (and its unlock token, for an online grant) gets it
    /// (<see cref="JazminReader.SubmissionKey"/>); the owner derives it here. <paramref name="keyId"/> is the access
    /// key's <see cref="JazminAccessKey.Id"/>.
    /// </summary>
    public JazminKey SubmissionKey(string keyId)
    {
        if (keyId is null || keyId.Length != 16 || !keyId.All(char.IsAsciiHexDigitLower)) throw new JazminValidationException($"'{keyId}' is not an access key id");
        return new(Format.Crypto.Hkdf(_bytes, [], $"JAZMIN/1/submission/{keyId}"));
    }

    /// <summary>The submission key of <paramref name="accessKey"/> (see <see cref="SubmissionKey(string)"/>).</summary>
    public JazminKey SubmissionKey(JazminAccessKey accessKey) => SubmissionKey(accessKey.Id);

    public override string ToString()
    {
        var raw = new byte[KeySize + ChecksumSize];
        _bytes.CopyTo(raw, 0);
        Checksum(_bytes).CopyTo(raw, KeySize);
        return Prefix + ToBase64Url(raw);
    }

    private static byte[] Checksum(ReadOnlySpan<byte> bytes) => SHA256.HashData(bytes)[..ChecksumSize];

    private static string ToBase64Url(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string text)
    {
        var s = text.Replace('-', '+').Replace('_', '/');
        s += (s.Length % 4) switch { 2 => "==", 3 => "=", 0 => "", _ => throw new FormatException() };
        return Convert.FromBase64String(s);
    }
}
