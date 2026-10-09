using System.Buffers;

namespace Jazmin.Format;

/// <summary>
/// One column of a chunk being written in the columnar layout (spec 5.4): values are kept in typed arrays
/// (no boxing per value), statistics are computed on the typed values, and the stream is encoded from them.
/// The encoding choices are the same as <see cref="Columnar.Encode"/>, so the bytes are identical.
/// </summary>
internal abstract class ColumnBuffer
{
    private byte[] _nulls = new byte[64];
    protected int Rows;
    protected bool HasNulls;
    public long NullCount { get; private set; }

    /// <summary>The values added since the last reset, null or not.</summary>
    public int Count => Rows;

    /// <summary>A buffer for one column; ordered types also collect min/max for the chunk statistics (spec 6.4).</summary>
    public static ColumnBuffer For(JazminType type) => type switch
    {
        JazminType.Int or JazminType.DateTime => new LongColumn(type, withStats: true),
        JazminType.Float => new DoubleColumn(withStats: true),
        JazminType.Bool => new BoolColumn(withStats: true),
        JazminType.Binary => new BytesColumn(),
        JazminType.String => new StringColumn(dictionary: true, ordered: true),
        JazminType.Decimal => new StringColumn(dictionary: true, ordered: true) { Decimals = true },
        _ => new StringColumn(dictionary: true, ordered: false) { JsonText = true }, // json: plain
    };

    /// <summary>Appends a normalized value (spec 5.1 internal form) or null.</summary>
    public void Add(object? value)
    {
        if (Rows >> 3 >= _nulls.Length) Array.Resize(ref _nulls, _nulls.Length * 2);
        if (value is null)
        {
            _nulls[Rows >> 3] |= (byte)(1 << (Rows & 7));
            HasNulls = true;
            NullCount++;
        }
        else
        {
            AddValue(value);
        }
        Rows++;
    }

    /// <summary>Counts a non-null value already stored by a typed Add method.</summary>
    protected void Advance()
    {
        if (Rows >> 3 >= _nulls.Length) Array.Resize(ref _nulls, _nulls.Length * 2);
        Rows++;
    }

    protected abstract void AddValue(object value);

    /// <summary>Empties the buffer for the next chunk, keeping its arrays (no allocation in steady state).</summary>
    public void Reset()
    {
        Array.Clear(_nulls, 0, Math.Min(_nulls.Length, (Rows + 7) >> 3));
        Rows = 0;
        HasNulls = false;
        NullCount = 0;
        ResetValues();
    }

    protected abstract void ResetValues();

    protected abstract byte EncodeBody(ByteWriter body);

    public abstract ColumnStats Stats();

    /// <summary>Writes this column's stream: varuint length, flags, optional null bitmap, body.</summary>
    public void Encode(ByteWriter output, ByteWriter scratch)
    {
        scratch.Reset();
        var encoding = EncodeBody(scratch);
        var nullBytes = HasNulls ? (Rows + 7) >> 3 : 0;
        output.VarUInt((ulong)(1 + nullBytes + scratch.Length));
        output.Byte((byte)(encoding | (HasNulls ? 0x10 : 0)));
        if (HasNulls) output.Bytes(_nulls.AsSpan(0, nullBytes));
        output.Bytes(scratch.AsSpan());
    }

    protected static int VarIntSize(long v)
    {
        var z = (ulong)((v << 1) ^ (v >> 63));
        var n = 1;
        while (z >= 0x80)
        {
            z >>= 7;
            n++;
        }
        return n;
    }
}

internal sealed class LongColumn(JazminType type, bool withStats) : ColumnBuffer
{
    private long[] _values = new long[256];
    private int _count;
    private long _min = long.MaxValue, _max = long.MinValue;

    protected override void AddValue(object value) => Store((long)value);

    /// <summary>Appends a non-null value without boxing (dates converted by the writer).</summary>
    public void AddLong(long value)
    {
        Store(value);
        Advance();
    }

    private void Store(long v)
    {
        if (_count == _values.Length) Array.Resize(ref _values, _count * 2);
        _values[_count++] = v;
        if (withStats)
        {
            if (v < _min) _min = v;
            if (v > _max) _max = v;
        }
    }

    protected override byte EncodeBody(ByteWriter body)
    {
        var values = _values.AsSpan(0, _count);
        if (values.Length > 1)
        {
            long plain = 0, delta = VarIntSize(values[0]);
            var fits = true;
            for (var i = 0; i < values.Length; i++)
            {
                plain += VarIntSize(values[i]);
                if (i == 0) continue;
                var d = values[i] - values[i - 1];
                if (((values[i] ^ values[i - 1]) & (values[i] ^ d)) < 0) // signed overflow
                {
                    fits = false;
                    break;
                }
                delta += VarIntSize(d);
            }
            if (fits && delta < plain)
            {
                body.VarInt(values[0]);
                for (var i = 1; i < values.Length; i++) body.VarInt(values[i] - values[i - 1]);
                return Columnar.Delta;
            }
        }
        foreach (var v in values) body.VarInt(v);
        return Columnar.Plain;
    }

    public override ColumnStats Stats() => new()
    {
        Nulls = NullCount,
        Min = withStats && _count > 0 ? _min : null,
        Max = withStats && _count > 0 ? _max : null,
    };

    public JazminType Type => type;

    protected override void ResetValues()
    {
        _count = 0;
        _min = long.MaxValue;
        _max = long.MinValue;
    }
}

internal sealed class DoubleColumn(bool withStats) : ColumnBuffer
{
    private double[] _values = new double[256];
    private int _count;
    private double _min = double.PositiveInfinity, _max = double.NegativeInfinity;
    private bool _any;

    protected override void AddValue(object value)
    {
        var v = (double)value;
        if (_count == _values.Length) Array.Resize(ref _values, _count * 2);
        _values[_count++] = v;
        if (withStats && !double.IsNaN(v))
        {
            var key = v == 0 ? 0.0 : v; // fold -0 into 0
            if (!_any || key < _min) _min = key;
            if (!_any || key > _max) _max = key;
            _any = true;
        }
    }

    protected override byte EncodeBody(ByteWriter body)
    {
        var values = _values.AsSpan(0, _count);
        var scaleArray = ArrayPool<int>.Shared.Rent(values.Length);
        var mantissaArray = ArrayPool<long>.Shared.Rent(values.Length);
        try
        {
            return EncodeScaled(body, values, scaleArray.AsSpan(0, values.Length), mantissaArray.AsSpan(0, values.Length));
        }
        finally
        {
            ArrayPool<int>.Shared.Return(scaleArray);
            ArrayPool<long>.Shared.Return(mantissaArray);
        }
    }

    private static byte EncodeScaled(ByteWriter body, ReadOnlySpan<double> values, Span<int> scales, Span<long> mantissas)
    {
        long scaledSize = 0;
        for (var i = 0; i < values.Length; i++)
        {
            scales[i] = Columnar.ScaleOf(values[i], out mantissas[i]);
            scaledSize += scales[i] < 0 ? 9 : 1 + VarIntSize(mantissas[i]);
        }
        if (scaledSize < values.Length * 8L)
        {
            for (var i = 0; i < values.Length; i++)
            {
                if (scales[i] < 0)
                {
                    body.Byte(255);
                    body.Float64(values[i]);
                }
                else
                {
                    body.Byte((byte)scales[i]);
                    body.VarInt(mantissas[i]);
                }
            }
            return Columnar.Scaled;
        }
        foreach (var v in values) body.Float64(v);
        return Columnar.Plain;
    }

    public override ColumnStats Stats() => new() { Nulls = NullCount, Min = withStats && _any ? _min : null, Max = withStats && _any ? _max : null };

    protected override void ResetValues()
    {
        _count = 0;
        _any = false;
    }
}

internal sealed class BoolColumn(bool withStats) : ColumnBuffer
{
    private byte[] _bits = new byte[32];
    private int _count;
    private bool _anyFalse, _anyTrue;

    protected override void AddValue(object value)
    {
        var v = (bool)value;
        if (_count >> 3 >= _bits.Length) Array.Resize(ref _bits, _bits.Length * 2);
        if (v) _bits[_count >> 3] |= (byte)(1 << (_count & 7));
        _count++;
        if (v) _anyTrue = true;
        else _anyFalse = true;
    }

    protected override byte EncodeBody(ByteWriter body)
    {
        body.Bytes(_bits.AsSpan(0, (_count + 7) >> 3));
        return Columnar.Bitmap;
    }

    public override ColumnStats Stats() => new()
    {
        Nulls = NullCount,
        Min = withStats && (_anyFalse || _anyTrue) ? !_anyFalse : null,
        Max = withStats && (_anyFalse || _anyTrue) ? _anyTrue : null,
    };

    protected override void ResetValues()
    {
        Array.Clear(_bits, 0, Math.Min(_bits.Length, (_count + 7) >> 3));
        _count = 0;
        _anyFalse = _anyTrue = false;
    }
}

internal sealed class StringColumn(bool dictionary, bool ordered) : ColumnBuffer
{
    [ThreadStatic]
    private static Dictionary<string, int>? _ids;

    private string[] _values = new string[256];
    private int _count;
    private string? _min, _max;

    /// <summary>json columns: always plain (no dictionary), as the reference encoder does.</summary>
    public bool JsonText { get; init; }

    /// <summary>decimal columns: canonical text, stored as scale + integer and ordered by value.</summary>
    public bool Decimals { get; init; }

    private int Compare(string a, string b) => Decimals ? Format.Decimals.CompareCanonical(a, b) : string.CompareOrdinal(a, b);

    protected override void AddValue(object value)
    {
        var v = (string)value;
        if (_count == _values.Length) Array.Resize(ref _values, _count * 2);
        _values[_count++] = v;
        if (ordered)
        {
            if (_min is null || Compare(v, _min) < 0) _min = v;
            if (_max is null || Compare(v, _max) > 0) _max = v;
        }
    }

    private void WriteValue(ByteWriter body, string v)
    {
        if (Decimals) Format.Decimals.Write(body, v);
        else body.String(v);
    }

    protected override byte EncodeBody(ByteWriter body)
    {
        var values = _values.AsSpan(0, _count);
        if (dictionary && !JsonText && values.Length > 0)
        {
            var ids = _ids ??= new Dictionary<string, int>(StringComparer.Ordinal); // reused per thread
            ids.Clear();
            var limit = values.Length / 2; // a dictionary is used only when at most half the values are distinct
            foreach (var v in values)
            {
                ids.TryAdd(v, ids.Count);
                if (ids.Count > limit) break;
            }
            if (ids.Count <= limit)
            {
                body.VarUInt((ulong)ids.Count);
                foreach (var key in ids.Keys) WriteValue(body, key);
                foreach (var v in values) body.VarUInt((ulong)ids[v]);
                return Columnar.Dictionary;
            }
        }
        foreach (var v in values) WriteValue(body, v);
        return Columnar.Plain;
    }

    public override ColumnStats Stats() => Decimals
        ? new() { Nulls = NullCount, Min = _min is null ? null : Format.Decimals.Key(_min), Max = _max is null ? null : Format.Decimals.Key(_max) }
        : new() { Nulls = NullCount, Min = _min, Max = _max };

    protected override void ResetValues()
    {
        Array.Clear(_values, 0, _count); // release the strings
        _count = 0;
        _min = _max = null;
    }
}

internal sealed class BytesColumn : ColumnBuffer
{
    private readonly List<byte[]> _values = new();

    protected override void AddValue(object value)
    {
        var v = (byte[])value;
        _values.Add(v);
    }

    protected override byte EncodeBody(ByteWriter body)
    {
        foreach (var v in _values) body.Blob(v);
        return Columnar.Plain;
    }

    public override ColumnStats Stats() => new() { Nulls = NullCount };

    protected override void ResetValues() => _values.Clear();
}
