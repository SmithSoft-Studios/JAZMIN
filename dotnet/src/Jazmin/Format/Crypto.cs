using System.Security.Cryptography;
using System.Text;

namespace Jazmin.Format;

internal static class Crypto
{
    private const int KeySize = 32;
    internal const int NonceSize = 12;
    internal const int TagSize = 16;

    public static byte[] DeriveFromPassword(string password, byte[] salt, int iterations)
    {
        if (string.IsNullOrEmpty(password)) throw new JazminKeyException("Password must be a non-empty string");
        return Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, KeySize);
    }

    /// <summary>HKDF-SHA256 (RFC 5869) producing a 32-byte key.</summary>
    public static byte[] Hkdf(ReadOnlySpan<byte> ikm, ReadOnlySpan<byte> salt, string info)
    {
        var output = new byte[KeySize];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, output, salt, Encoding.UTF8.GetBytes(info));
        return output;
    }

    /// <summary>AES-256-GCM. Output: nonce(12) || ciphertext || tag(16).</summary>
    public static byte[] Encrypt(byte[] key, ReadOnlySpan<byte> plaintext, ReadOnlySpan<byte> aad)
    {
        var output = new byte[NonceSize + plaintext.Length + TagSize];
        var nonce = output.AsSpan(0, NonceSize);
        RandomNumberGenerator.Fill(nonce);
        using var gcm = new AesGcm(key, TagSize);
        gcm.Encrypt(nonce, plaintext, output.AsSpan(NonceSize, plaintext.Length), output.AsSpan(NonceSize + plaintext.Length), aad);
        return output;
    }

    public static byte[] Decrypt(byte[] key, ReadOnlySpan<byte> payload, ReadOnlySpan<byte> aad)
    {
        if (payload.Length < NonceSize + TagSize) throw new JazminKeyException("Encrypted section is too short");
        var bodyLength = payload.Length - NonceSize - TagSize;
        var plaintext = new byte[bodyLength];
        try
        {
            using var gcm = new AesGcm(key, TagSize);
            gcm.Decrypt(payload[..NonceSize], payload.Slice(NonceSize, bodyLength), payload[(NonceSize + bodyLength)..], plaintext, aad);
        }
        catch (CryptographicException e)
        {
            throw new JazminKeyException("Decryption failed - wrong key/password or the data was tampered with", e);
        }
        return plaintext;
    }
}

/// <summary>
/// Key hierarchy (spec section 7):
///   master     = key bytes, or PBKDF2-SHA256(password, salt, iterations)
///   headerKey  = HKDF(master, salt, "JAZMIN/1/header")
///   sectionKey = HKDF(master, keyring[group], "JAZMIN/1/" + sectionId)
/// </summary>
internal sealed class KeySchedule
{
    private readonly byte[] _master;

    public KeySchedule(byte[] master, byte[] salt)
    {
        _master = master;
        HeaderKey = Crypto.Hkdf(master, salt, "JAZMIN/1/header");
    }

    public byte[] HeaderKey { get; }

    public Dictionary<string, byte[]> Keyring { get; set; } = new();

    public byte[] SectionKey(string group, string sectionId)
    {
        if (!Keyring.TryGetValue(group, out var secret)) throw new JazminKeyException($"Keyring has no secret for group '{group}'");
        return Crypto.Hkdf(_master, secret, $"JAZMIN/1/{sectionId}");
    }
}
