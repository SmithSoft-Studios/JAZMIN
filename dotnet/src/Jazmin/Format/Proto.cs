using System.Text;

namespace Jazmin.Format;

/// <summary>
/// The Protocol Buffers wire format (spec 6): a small codec for the catalog messages of spec/jazmin.proto.
/// Writers omit fields holding their default value (proto3); readers skip fields they do not know.
/// </summary>
internal sealed class ProtoWriter(int size = 256)
{
    private const int Varint = 0, Len = 2;
    private readonly ByteWriter _w = new(size);

    public int Length => _w.Length;

    private void Tag(int field, int wire) => _w.VarUInt((ulong)((field << 3) | wire));

    /// <summary>uint32 / uint64 / bool / enum; zero is omitted.</summary>
    public ProtoWriter UInt(int field, ulong value)
    {
        if (value == 0) return this;
        Tag(field, Varint);
        _w.VarUInt(value);
        return this;
    }

    public ProtoWriter UInt(int field, long value) => UInt(field, checked((ulong)value));

    /// <summary>int64: negative values use 64-bit two's complement, as Protocol Buffers does.</summary>
    public ProtoWriter Int64(int field, long value) => UInt(field, unchecked((ulong)value));

    public ProtoWriter Bool(int field, bool value) => UInt(field, value ? 1UL : 0UL);

    /// <summary>bytes; empty is omitted.</summary>
    public ProtoWriter Bytes(int field, ReadOnlySpan<byte> value) => value.Length == 0 ? this : Always(field, value);

    public ProtoWriter String(int field, string? value) => string.IsNullOrEmpty(value) ? this : Bytes(field, Encoding.UTF8.GetBytes(value));

    /// <summary>A length-delimited value written even when empty (elements of repeated bytes and messages).</summary>
    public ProtoWriter Always(int field, ReadOnlySpan<byte> value)
    {
        Tag(field, Len);
        _w.VarUInt((ulong)value.Length);
        _w.Bytes(value);
        return this;
    }

    /// <summary>A message field built by <paramref name="build"/>; written even when empty when <paramref name="always"/> is set.</summary>
    public ProtoWriter Message(int field, Action<ProtoWriter>? build, bool always = false)
    {
        if (build is null) return this;
        var inner = new ProtoWriter();
        build(inner);
        return inner.Length == 0 && !always ? this : Always(field, inner.AsSpan());
    }

    /// <summary>Packed repeated varints (values must not be negative).</summary>
    public ProtoWriter Packed(int field, IReadOnlyList<long> values)
    {
        if (values.Count == 0) return this;
        var inner = new ByteWriter(values.Count * 2 + 8);
        foreach (var v in values) inner.VarUInt(checked((ulong)v));
        return Always(field, inner.AsSpan());
    }

    public ReadOnlySpan<byte> AsSpan() => _w.AsSpan();

    public byte[] ToArray() => _w.ToArray();
}

/// <summary>Reads the fields of one message in order. Length-delimited values are views of the same array.</summary>
internal sealed class ProtoReader
{
    private readonly byte[] _buffer;
    private readonly int _end;
    private int _pos;

    public ProtoReader(ArraySegment<byte> message)
    {
        _buffer = message.Array ?? [];
        _pos = message.Offset;
        _end = message.Offset + message.Count;
    }

    public int Wire { get; private set; }

    private static JazminFormatException Bad(string what) => new($"Catalog: {what}");

    /// <summary>Moves to the next field; false at the end of the message.</summary>
    public bool Next(out int field)
    {
        if (_pos >= _end)
        {
            field = 0;
            return false;
        }
        var tag = ReadVarint();
        if (tag >> 3 is 0 or > int.MaxValue) throw Bad("invalid field number");
        field = (int)(tag >> 3);
        Wire = (int)(tag & 7);
        return true;
    }

    private ulong ReadVarint()
    {
        ulong result = 0;
        for (var shift = 0; shift < 70; shift += 7)
        {
            if (_pos >= _end) throw Bad("message is truncated");
            var b = _buffer[_pos++];
            if (shift == 63 && b > 1) throw Bad("varint is too long");
            result |= (ulong)(b & 0x7f) << shift;
            if ((b & 0x80) == 0) return result;
        }
        throw Bad("varint is too long");
    }

    /// <summary>A varint field (uint64, enum, bool).</summary>
    public ulong UInt64()
    {
        if (Wire != 0) throw Bad($"expected a number, found wire type {Wire}");
        return ReadVarint();
    }

    public int Int32()
    {
        var v = UInt64();
        return v <= int.MaxValue ? (int)v : throw Bad("value out of range");
    }

    public long Int64Value()
    {
        var v = UInt64();
        return v <= long.MaxValue ? (long)v : throw Bad("value out of range");
    }

    /// <summary>int64 (two's complement for negative values).</summary>
    public long SignedInt64() => unchecked((long)UInt64());

    public bool Bool() => UInt64() != 0;

    /// <summary>A length-delimited field (bytes, string, message, packed list).</summary>
    public ArraySegment<byte> Bytes()
    {
        if (Wire != 2) throw Bad($"expected bytes, found wire type {Wire}");
        var n = ReadVarint();
        if (n > (ulong)(_end - _pos)) throw Bad("message is truncated");
        var segment = new ArraySegment<byte>(_buffer, _pos, (int)n);
        _pos += (int)n;
        return segment;
    }

    public string String() => Encoding.UTF8.GetString(Bytes());

    public byte[] ByteArray() => Bytes().ToArray();

    /// <summary>Packed varints (a single unpacked value is accepted too, as the format allows).</summary>
    public void Packed(List<long> output)
    {
        if (Wire == 0)
        {
            output.Add(Int64Value());
            return;
        }
        var inner = new ProtoReader(Bytes());
        while (inner._pos < inner._end)
        {
            var v = inner.ReadVarint();
            output.Add(v <= long.MaxValue ? (long)v : throw Bad("value out of range"));
        }
    }

    /// <summary>Skips a field this reader does not use.</summary>
    public void Skip()
    {
        switch (Wire)
        {
            case 0: ReadVarint(); break;
            case 1: Advance(8); break;
            case 2: Bytes(); break;
            case 5: Advance(4); break;
            default: throw Bad($"unsupported wire type {Wire}");
        }
    }

    private void Advance(int n)
    {
        if (n > _end - _pos) throw Bad("message is truncated");
        _pos += n;
    }
}
