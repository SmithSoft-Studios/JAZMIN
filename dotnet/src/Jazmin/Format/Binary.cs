using System.Buffers.Binary;
using System.Text;

namespace Jazmin.Format;

/// <summary>Growable little-endian byte buffer.</summary>
internal sealed class ByteWriter
{
    private byte[] _buffer;

    public ByteWriter(int initialSize = 1024) => _buffer = new byte[Math.Max(16, initialSize)];

    public int Length { get; private set; }

    public void Reset() => Length = 0;

    private void Ensure(int extra)
    {
        var needed = Length + extra;
        if (needed <= _buffer.Length) return;
        var size = _buffer.Length * 2;
        while (size < needed) size *= 2;
        Array.Resize(ref _buffer, size);
    }

    public void Byte(byte value)
    {
        Ensure(1);
        _buffer[Length++] = value;
    }

    public void Bytes(ReadOnlySpan<byte> source)
    {
        Ensure(source.Length);
        source.CopyTo(_buffer.AsSpan(Length));
        Length += source.Length;
    }

    /// <summary>Appends <paramref name="count"/> zero bytes and returns their offset (e.g. a null bitmap filled in later).</summary>
    public int Reserve(int count)
    {
        Ensure(count);
        var at = Length;
        _buffer.AsSpan(at, count).Clear();
        Length += count;
        return at;
    }

    public void OrByte(int offset, byte mask) => _buffer[offset] |= mask;

    public void UInt16(ushort value)
    {
        Ensure(2);
        BinaryPrimitives.WriteUInt16LittleEndian(_buffer.AsSpan(Length), value);
        Length += 2;
    }

    public void Float64(double value)
    {
        Ensure(8);
        BinaryPrimitives.WriteDoubleLittleEndian(_buffer.AsSpan(Length), value);
        Length += 8;
    }

    /// <summary>Unsigned LEB128 varint.</summary>
    public void VarUInt(ulong value)
    {
        Ensure(10);
        while (value >= 0x80)
        {
            _buffer[Length++] = (byte)(value | 0x80);
            value >>= 7;
        }
        _buffer[Length++] = (byte)value;
    }

    /// <summary>Signed varint using ZigZag encoding.</summary>
    public void VarInt(long value) => VarUInt((ulong)((value << 1) ^ (value >> 63)));

    /// <summary>Bytes <see cref="VarUInt"/> writes for <paramref name="value"/>.</summary>
    public static int VarUIntSize(ulong value) => (70 - System.Numerics.BitOperations.LeadingZeroCount(value | 1)) / 7;

    /// <summary>Bytes <see cref="VarInt"/> writes for <paramref name="value"/>.</summary>
    public static int VarIntSize(long value) => VarUIntSize((ulong)((value << 1) ^ (value >> 63)));

    /// <summary>varint length prefix followed by UTF-8 bytes.</summary>
    public void String(string value)
    {
        var size = Encoding.UTF8.GetByteCount(value);
        VarUInt((ulong)size);
        Ensure(size);
        Encoding.UTF8.GetBytes(value, _buffer.AsSpan(Length, size));
        Length += size;
    }

    public void Blob(ReadOnlySpan<byte> value)
    {
        VarUInt((ulong)value.Length);
        Bytes(value);
    }

    public ReadOnlySpan<byte> AsSpan() => _buffer.AsSpan(0, Length);

    public byte[] ToArray() => _buffer.AsSpan(0, Length).ToArray();
}

/// <summary>Sequential little-endian reader over a byte array.</summary>
internal sealed class ByteReader
{
    private readonly byte[] _buffer;
    private readonly int _end; // pooled buffers may be longer than their content

    public ByteReader(byte[] buffer, int position = 0) : this(buffer, position, buffer.Length)
    {
    }

    public ByteReader(byte[] buffer, int position, int end)
    {
        _buffer = buffer;
        Position = position;
        _end = end;
    }

    public int Position { get; private set; }

    public bool Eof => Position >= _end;

    /// <summary>Bytes left to read.</summary>
    public int Remaining => _end - Position;

    private void Need(int count)
    {
        if (count < 0 || count > _end - Position) throw new JazminFormatException("Unexpected end of data");
    }

    public byte Byte()
    {
        Need(1);
        return _buffer[Position++];
    }

    /// <summary>Advances past <paramref name="count"/> bytes (usable from compiled expressions).</summary>
    public void Skip(int count)
    {
        Need(count);
        Position += count;
    }

    public ReadOnlySpan<byte> Bytes(int count)
    {
        Need(count);
        var span = _buffer.AsSpan(Position, count);
        Position += count;
        return span;
    }

    public ushort UInt16()
    {
        Need(2);
        var value = BinaryPrimitives.ReadUInt16LittleEndian(_buffer.AsSpan(Position));
        Position += 2;
        return value;
    }

    public double Float64()
    {
        Need(8);
        var value = BinaryPrimitives.ReadDoubleLittleEndian(_buffer.AsSpan(Position));
        Position += 8;
        return value;
    }

    public ulong VarUInt()
    {
        ulong result = 0;
        var shift = 0;
        while (true)
        {
            if (shift > 63) throw new JazminFormatException("Varint too long");
            var b = Byte();
            result |= (ulong)(b & 0x7f) << shift;
            if ((b & 0x80) == 0) return result;
            shift += 7;
        }
    }

    public long VarInt()
    {
        var z = VarUInt();
        return (long)(z >> 1) ^ -(long)(z & 1);
    }

    /// <summary>Reads a varint length that must fit in the remaining buffer.</summary>
    public int Length()
    {
        var size = VarUInt();
        if (size > int.MaxValue) throw new JazminFormatException("Length too large");
        return (int)size;
    }

    public string String() => Encoding.UTF8.GetString(Bytes(Length()));

    public byte[] Blob() => Bytes(Length()).ToArray();
}

/// <summary>CRC-32 (IEEE 802.3, as used by ZIP/PNG), computed 8 bytes at a time ("slicing-by-8").</summary>
internal static class Crc32
{
    private static readonly uint[][] Tables = BuildTables();

    private static uint[][] BuildTables()
    {
        var tables = new uint[8][];
        tables[0] = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xedb88320 ^ (c >> 1) : c >> 1;
            tables[0][n] = c;
        }
        for (var t = 1; t < 8; t++)
        {
            tables[t] = new uint[256];
            for (var n = 0; n < 256; n++) tables[t][n] = (tables[t - 1][n] >> 8) ^ tables[0][tables[t - 1][n] & 0xff];
        }
        return tables;
    }

    public static uint Compute(ReadOnlySpan<byte> data)
    {
        uint[] t0 = Tables[0], t1 = Tables[1], t2 = Tables[2], t3 = Tables[3], t4 = Tables[4], t5 = Tables[5], t6 = Tables[6], t7 = Tables[7];
        var crc = 0xffffffffu;
        var i = 0;
        for (; i + 8 <= data.Length; i += 8)
        {
            crc ^= BinaryPrimitives.ReadUInt32LittleEndian(data[i..]);
            crc = t7[crc & 0xff] ^ t6[(crc >> 8) & 0xff] ^ t5[(crc >> 16) & 0xff] ^ t4[crc >> 24]
                ^ t3[data[i + 4]] ^ t2[data[i + 5]] ^ t1[data[i + 6]] ^ t0[data[i + 7]];
        }
        for (; i < data.Length; i++) crc = t0[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
        return crc ^ 0xffffffffu;
    }

    /// <summary>Reference byte-at-a-time implementation (used by tests).</summary>
    internal static uint ComputeBytewise(ReadOnlySpan<byte> data)
    {
        var crc = 0xffffffffu;
        foreach (var b in data) crc = Tables[0][(crc ^ b) & 0xff] ^ (crc >> 8);
        return crc ^ 0xffffffffu;
    }
}
