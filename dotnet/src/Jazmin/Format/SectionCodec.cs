using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.IO.Compression;
using System.Text;

namespace Jazmin.Format;

/// <summary>Builds and opens sections: 16-byte envelope + payload. Pipeline: raw -> compress -> (encrypt) -> CRC-32.</summary>
internal static class SectionCodec
{
    public static byte[] Encode(ReadOnlySpan<byte> raw, JazminCodec codec, int? level, byte[]? key, byte[] fileId, string sectionId)
    {
        var (buffer, length) = EncodePooled(raw, codec, level, key, fileId, sectionId);
        var section = buffer.AsSpan(0, length).ToArray();
        ArrayPool<byte>.Shared.Return(buffer);
        return section;
    }

    [ThreadStatic]
    private static MemoryStream? _compressed; // per-thread compression buffer, reused (no large allocations per section)

    /// <summary>
    /// Builds a section into a buffer rented from <see cref="ArrayPool{T}.Shared"/> (return it when written).
    /// Compression goes to a reused per-thread buffer, and encryption writes straight into the section.
    /// </summary>
    public static (byte[] Buffer, int Length) EncodePooled(ReadOnlySpan<byte> raw, JazminCodec codec, int? level, byte[]? key, byte[] fileId, string sectionId)
    {
        var codecId = codec;
        ReadOnlySpan<byte> body = raw;
        if (codec != JazminCodec.None)
        {
            var compressed = CompressInto(codec, raw, level);
            if (compressed.Length < raw.Length) body = compressed;
            else codecId = JazminCodec.None; // compression did not help - store as-is
        }
        var payloadLength = key is null ? body.Length : Crypto.NonceSize + body.Length + Crypto.TagSize;
        var length = FormatConstants.EnvelopeSize + payloadLength;
        var section = ArrayPool<byte>.Shared.Rent(length);
        var envelope = section.AsSpan(0, FormatConstants.EnvelopeSize);
        envelope.Clear();
        envelope[0] = (byte)codecId;
        envelope[1] = key is null ? (byte)0 : FormatConstants.SectionEncrypted;
        BinaryPrimitives.WriteUInt32LittleEndian(envelope[4..], (uint)raw.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(envelope[8..], (uint)payloadLength);
        var payload = section.AsSpan(FormatConstants.EnvelopeSize, payloadLength);
        if (key is null) body.CopyTo(payload);
        else
        {
            var nonce = payload[..Crypto.NonceSize];
            RandomNumberGenerator.Fill(nonce);
            using var gcm = new AesGcm(key, Crypto.TagSize);
            gcm.Encrypt(nonce, body, payload.Slice(Crypto.NonceSize, body.Length), payload[(Crypto.NonceSize + body.Length)..], Aad(fileId, envelope, sectionId));
        }
        BinaryPrimitives.WriteUInt32LittleEndian(envelope[12..], Crc32.Compute(payload));
        return (section, length);
    }

    private static ReadOnlySpan<byte> CompressInto(JazminCodec codec, ReadOnlySpan<byte> raw, int? level)
    {
        var output = _compressed ??= new MemoryStream(256 * 1024);
        output.SetLength(0);
        switch (codec)
        {
            case JazminCodec.Deflate:
                using (var deflate = new DeflateStream(output, DeflateLevel(level), leaveOpen: true)) deflate.Write(raw);
                return output.GetBuffer().AsSpan(0, (int)output.Length);
            case JazminCodec.Brotli:
            {
                var max = BrotliEncoder.GetMaxCompressedLength(raw.Length);
                if (output.Capacity < max) output.Capacity = max;
                var destination = output.GetBuffer();
                if (!BrotliEncoder.TryCompress(raw, destination, out var written, Math.Clamp(level ?? 6, 0, 11), 22))
                    throw new JazminException("Brotli compression failed");
                return destination.AsSpan(0, written);
            }
            default:
                throw new JazminValidationException($"Unknown codec {codec}");
        }
    }

    public static int PayloadLength(ReadOnlySpan<byte> envelope) => (int)BinaryPrimitives.ReadUInt32LittleEndian(envelope[8..]);

    /// <summary>
    /// Like <see cref="Decode"/>, but an unencrypted, uncompressed payload is returned in place
    /// (no copy). Used for large signed sections such as key slots.
    /// </summary>
    public static ArraySegment<byte> DecodeSegment(byte[] section, byte[]? key, byte[] fileId, string sectionId)
    {
        if (key is null && section.Length >= FormatConstants.EnvelopeSize && section[0] == (byte)JazminCodec.None
            && (section[1] & FormatConstants.SectionEncrypted) == 0)
        {
            var payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(section.AsSpan(8));
            var rawLength = BinaryPrimitives.ReadUInt32LittleEndian(section.AsSpan(4));
            if (payloadLength != section.Length - FormatConstants.EnvelopeSize || rawLength != payloadLength)
                throw new JazminFormatException($"Section '{sectionId}' is truncated");
            var body = section.AsSpan(FormatConstants.EnvelopeSize);
            if (Crc32.Compute(body) != BinaryPrimitives.ReadUInt32LittleEndian(section.AsSpan(12)))
                throw new JazminFormatException($"Section '{sectionId}' failed its CRC-32 check");
            return new ArraySegment<byte>(section, FormatConstants.EnvelopeSize, (int)payloadLength);
        }
        return Decode(section, key, fileId, sectionId);
    }

    /// <summary>
    /// Verifies, decrypts and decompresses a section held in <paramref name="section"/>[0..sectionLength) into a buffer
    /// rented from <see cref="ArrayPool{T}.Shared"/> (return it when decoded). Intermediate buffers are pooled too.
    /// </summary>
    public static (byte[] Buffer, int Length) DecodePooled(byte[] section, int sectionLength, byte[]? key, byte[] fileId, string sectionId)
    {
        if (sectionLength < FormatConstants.EnvelopeSize) throw new JazminFormatException($"Section '{sectionId}' is truncated");
        var envelope = section.AsSpan(0, FormatConstants.EnvelopeSize);
        var codec = (JazminCodec)envelope[0];
        var encrypted = (envelope[1] & FormatConstants.SectionEncrypted) != 0;
        var declaredLength = BinaryPrimitives.ReadUInt32LittleEndian(envelope[4..]);
        if (declaredLength > Array.MaxLength) throw TooLarge(sectionId);
        var rawLength = (int)declaredLength;
        var payloadLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(envelope[8..]);
        if (payloadLength != sectionLength - FormatConstants.EnvelopeSize) throw new JazminFormatException($"Section '{sectionId}' is truncated");
        var body = section.AsSpan(FormatConstants.EnvelopeSize, payloadLength);
        if (Crc32.Compute(body) != BinaryPrimitives.ReadUInt32LittleEndian(envelope[12..]))
            throw new JazminFormatException($"Section '{sectionId}' failed its CRC-32 check");
        if (key is not null && !encrypted)
            throw new JazminFormatException($"Section '{sectionId}' is not encrypted but the file is"); // prevents downgrade

        var plain = section;
        var plainOffset = FormatConstants.EnvelopeSize;
        var plainLength = payloadLength;
        byte[]? decrypted = null;
        try
        {
            if (encrypted)
            {
                if (key is null) throw new JazminKeyException("This file is encrypted - supply a key or password");
                if (payloadLength < Crypto.NonceSize + Crypto.TagSize) throw new JazminKeyException("Encrypted section is too short");
                plainLength = payloadLength - Crypto.NonceSize - Crypto.TagSize;
                decrypted = ArrayPool<byte>.Shared.Rent(Math.Max(plainLength, 1));
                try
                {
                    using var gcm = new AesGcm(key, Crypto.TagSize);
                    gcm.Decrypt(body[..Crypto.NonceSize], body.Slice(Crypto.NonceSize, plainLength), body[(Crypto.NonceSize + plainLength)..],
                        decrypted.AsSpan(0, plainLength), Aad(fileId, envelope, sectionId));
                }
                catch (CryptographicException e)
                {
                    throw new JazminKeyException("Decryption failed - wrong key/password or the data was tampered with", e);
                }
                plain = decrypted;
                plainOffset = 0;
            }

            if (codec == JazminCodec.None && plainLength != rawLength) throw WrongLength(sectionId);
            if (codec != JazminCodec.None && rawLength > MaxPreallocate)
            {
                var large = DecompressLarge(codec, plain, plainOffset, plainLength, rawLength, sectionId);
                var pooled = ArrayPool<byte>.Shared.Rent(rawLength);
                large.AsSpan(0, rawLength).CopyTo(pooled);
                return (pooled, rawLength);
            }
            var output = ArrayPool<byte>.Shared.Rent(Math.Max(rawLength, 1));
            try
            {
                if (codec == JazminCodec.None) plain.AsSpan(plainOffset, plainLength).CopyTo(output);
                else DecompressInto(codec, plain, plainOffset, plainLength, output, rawLength, sectionId);
                return (output, rawLength);
            }
            catch
            {
                ArrayPool<byte>.Shared.Return(output);
                throw;
            }
        }
        finally
        {
            if (decrypted is not null) ArrayPool<byte>.Shared.Return(decrypted);
        }
    }

    /// <summary>Verifies, decrypts and decompresses a section.</summary>
    public static byte[] Decode(byte[] section, byte[]? key, byte[] fileId, string sectionId)
    {
        if (section.Length < FormatConstants.EnvelopeSize) throw new JazminFormatException($"Section '{sectionId}' is truncated");
        var envelope = section.AsSpan(0, FormatConstants.EnvelopeSize);
        var codec = (JazminCodec)envelope[0];
        var encrypted = (envelope[1] & FormatConstants.SectionEncrypted) != 0;
        var rawLength = BinaryPrimitives.ReadUInt32LittleEndian(envelope[4..]);
        var payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(envelope[8..]);
        if (payloadLength != section.Length - FormatConstants.EnvelopeSize) throw new JazminFormatException($"Section '{sectionId}' is truncated");
        ReadOnlySpan<byte> body = section.AsSpan(FormatConstants.EnvelopeSize);
        if (Crc32.Compute(body) != BinaryPrimitives.ReadUInt32LittleEndian(envelope[12..]))
            throw new JazminFormatException($"Section '{sectionId}' failed its CRC-32 check");

        if (key is not null && !encrypted)
            throw new JazminFormatException($"Section '{sectionId}' is not encrypted but the file is"); // prevents downgrade
        byte[] plain;
        if (encrypted)
        {
            if (key is null) throw new JazminKeyException("This file is encrypted - supply a key or password");
            plain = Crypto.Decrypt(key, body, Aad(fileId, envelope, sectionId));
        }
        else
        {
            plain = body.ToArray();
        }

        var raw = Decompress(codec, plain, rawLength, sectionId);
        if (raw.Length != rawLength) throw new JazminFormatException($"Section '{sectionId}' has the wrong decompressed length");
        return raw;
    }

    /// <summary>
    /// The section under another key and file id (key rotation, TASKS S-2): its CRC and the old key's authentication
    /// tag are checked, and its stored payload is decrypted and encrypted again, not decompressed. The result has the
    /// same length.
    /// </summary>
    public static byte[] Reencrypt(ReadOnlySpan<byte> section, byte[] key, byte[] fileId, string sectionId, byte[] newKey, byte[] newFileId)
    {
        if (section.Length < FormatConstants.EnvelopeSize) throw new JazminFormatException($"Section '{sectionId}' is truncated");
        var envelope = section[..FormatConstants.EnvelopeSize];
        var body = section[FormatConstants.EnvelopeSize..];
        if (BinaryPrimitives.ReadUInt32LittleEndian(envelope[8..]) != body.Length) throw new JazminFormatException($"Section '{sectionId}' is truncated");
        if (Crc32.Compute(body) != BinaryPrimitives.ReadUInt32LittleEndian(envelope[12..]))
            throw new JazminFormatException($"Section '{sectionId}' failed its CRC-32 check");
        if ((envelope[1] & FormatConstants.SectionEncrypted) == 0) throw new JazminFormatException($"Section '{sectionId}' is not encrypted but the file is");
        var plain = Crypto.Decrypt(key, body, Aad(fileId, envelope, sectionId));
        var sealedBody = Crypto.Encrypt(newKey, plain, Aad(newFileId, envelope, sectionId));
        var output = new byte[FormatConstants.EnvelopeSize + sealedBody.Length];
        envelope.CopyTo(output);
        sealedBody.CopyTo(output, FormatConstants.EnvelopeSize);
        BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(8), (uint)sealedBody.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(12), Crc32.Compute(sealedBody));
        return output;
    }

    private static byte[] Aad(byte[] fileId, ReadOnlySpan<byte> envelope, string sectionId)
    {
        var id = Encoding.UTF8.GetBytes(sectionId);
        var aad = new byte[fileId.Length + 8 + id.Length];
        fileId.CopyTo(aad, 0);
        envelope[..8].CopyTo(aad.AsSpan(fileId.Length));
        id.CopyTo(aad, fileId.Length + 8);
        return aad;
    }

    private static CompressionLevel DeflateLevel(int? level) => level switch
    {
        null => CompressionLevel.Optimal,
        0 => CompressionLevel.NoCompression,
        <= 3 => CompressionLevel.Fastest,
        <= 8 => CompressionLevel.Optimal,
        _ => CompressionLevel.SmallestSize,
    };

    /// <summary>
    /// Sections up to this size are decompressed straight into a buffer of their declared size. A damaged size cannot
    /// reserve more than this up front: larger sections grow their buffer as the data arrives.
    /// </summary>
    private const int MaxPreallocate = 64 * 1024 * 1024;

    private static JazminFormatException WrongLength(string sectionId) => new($"Section '{sectionId}' has the wrong decompressed length");

    private static JazminFormatException TooLarge(string sectionId) => new($"Section '{sectionId}' is larger than this reader supports");

    private static byte[] Decompress(JazminCodec codec, byte[] body, uint rawLength, string sectionId)
    {
        if (codec == JazminCodec.None) return body;
        if (rawLength > Array.MaxLength) throw TooLarge(sectionId);
        if (rawLength > MaxPreallocate) return DecompressLarge(codec, body, 0, body.Length, (int)rawLength, sectionId);
        var output = new byte[rawLength];
        DecompressInto(codec, body, 0, body.Length, output, (int)rawLength, sectionId);
        return output;
    }

    /// <summary>Decompresses into <paramref name="output"/>[0..rawLength); damaged data is a JazminFormatException.</summary>
    private static void DecompressInto(JazminCodec codec, byte[] body, int offset, int length, byte[] output, int rawLength, string sectionId)
    {
        try
        {
            switch (codec)
            {
                case JazminCodec.Deflate:
                {
                    using var deflate = new DeflateStream(new MemoryStream(body, offset, length, writable: false), CompressionMode.Decompress);
                    var read = 0;
                    while (read < rawLength)
                    {
                        var n = deflate.Read(output, read, rawLength - read);
                        if (n == 0) break;
                        read += n;
                    }
                    if (read != rawLength || deflate.ReadByte() != -1) throw WrongLength(sectionId);
                    break;
                }
                case JazminCodec.Brotli:
                    if (!BrotliDecoder.TryDecompress(body.AsSpan(offset, length), output.AsSpan(0, rawLength), out var written) || written != rawLength)
                        throw new JazminFormatException($"Section '{sectionId}' could not be decompressed");
                    break;
                default:
                    throw new JazminFormatException($"Unsupported codec id {(int)codec}");
            }
        }
        catch (InvalidDataException e)
        {
            throw new JazminFormatException($"Section '{sectionId}' could not be decompressed", e);
        }
    }

    /// <summary>A section larger than <see cref="MaxPreallocate"/>: the buffer grows with the data, up to the declared length.</summary>
    private static byte[] DecompressLarge(JazminCodec codec, byte[] body, int offset, int length, int rawLength, string sectionId)
    {
        try
        {
            using var input = new MemoryStream(body, offset, length, writable: false);
            using Stream stream = codec switch
            {
                JazminCodec.Deflate => new DeflateStream(input, CompressionMode.Decompress),
                JazminCodec.Brotli => new BrotliStream(input, CompressionMode.Decompress),
                _ => throw new JazminFormatException($"Unsupported codec id {(int)codec}"),
            };
            var output = new MemoryStream();
            var buffer = new byte[81920];
            int n;
            while ((n = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + n > rawLength) throw WrongLength(sectionId);
                output.Write(buffer, 0, n);
            }
            if (output.Length != rawLength) throw WrongLength(sectionId);
            return output.GetBuffer().Length == rawLength ? output.GetBuffer() : output.ToArray();
        }
        catch (Exception e) when (e is InvalidDataException or InvalidOperationException) // BrotliStream reports bad data as the latter
        {
            throw new JazminFormatException($"Section '{sectionId}' could not be decompressed", e);
        }
    }
}
