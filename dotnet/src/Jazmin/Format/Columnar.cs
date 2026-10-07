using System.Text.Json.Nodes;

namespace Jazmin.Format;

/// <summary>Columnar chunk layout (spec section 5.4): one stream per column, with per-type encodings.</summary>
internal static class Columnar
{
    public const byte Plain = 0, Delta = 1, Dictionary = 2, Bitmap = 3, Scaled = 4;
    private const byte HasNulls = 0x10;
    private const int MaxWriteScale = 15;
    private const long MaxMantissa = 9007199254740991; // 2^53 - 1
    private static readonly double[] Pow10 = Enumerable.Range(0, 23).Select(s => Math.Pow(10, s)).ToArray(); // exact for s <= 22

    private static bool Allowed(JazminType type, int encoding) => encoding == Plain || (type, encoding) switch
    {
        (JazminType.Bool, Bitmap) => true,
        (JazminType.Int or JazminType.DateTime, Delta) => true,
        (JazminType.Float, Scaled) => true,
        (JazminType.String or JazminType.Decimal, Dictionary) => true,
        _ => false,
    };

    // ---- writing ----------------------------------------------------------------------------

    private static int VarIntSize(long v)
    {
        var z = (ulong)((v << 1) ^ (v >> 63));
        var n = 1;
        while (z >= 0x80) { z >>= 7; n++; }
        return n;
    }

    /// <summary>Scale (0..15) at which m / 10^s gives exactly v's bits, or -1 (always for -0, NaN, infinities).</summary>
    internal static int ScaleOf(double v, out long mantissa)
    {
        mantissa = 0;
        if (!double.IsFinite(v) || (v == 0 && double.IsNegative(v))) return -1;
        for (var s = 0; s <= MaxWriteScale; s++)
        {
            var m = Math.Round(v * Pow10[s]);
            if (Math.Abs(m) > MaxMantissa) return -1;
            if (BitConverter.DoubleToInt64Bits(m / Pow10[s]) == BitConverter.DoubleToInt64Bits(v))
            {
                mantissa = (long)m;
                return s;
            }
        }
        return -1;
    }

    private static void WritePlain(ByteWriter w, JazminType type, List<object> values)
    {
        foreach (var v in values)
        {
            switch (type)
            {
                case JazminType.Bool: w.Byte((bool)v ? (byte)1 : (byte)0); break;
                case JazminType.Int or JazminType.DateTime: w.VarInt((long)v); break;
                case JazminType.Float: w.Float64((double)v); break;
                case JazminType.Binary: w.Blob((byte[])v); break;
                case JazminType.Decimal: Decimals.Write(w, v); break; // scale + integer (spec 5.1)
                default: w.String((string)v); break; // string, json (normalized to text)
            }
        }
    }

    private static byte WriteBody(ByteWriter w, JazminType type, List<object> values)
    {
        switch (type)
        {
            case JazminType.Bool:
            {
                var bits = new byte[(values.Count + 7) >> 3];
                for (var i = 0; i < values.Count; i++) if ((bool)values[i]) bits[i >> 3] |= (byte)(1 << (i & 7));
                w.Bytes(bits);
                return Bitmap;
            }
            case JazminType.Int or JazminType.DateTime when values.Count > 1:
            {
                long plain = 0, delta = VarIntSize((long)values[0]);
                var deltas = new long[values.Count - 1];
                var fits = true;
                for (var i = 0; i < values.Count; i++)
                {
                    plain += VarIntSize((long)values[i]);
                    if (i == 0) continue;
                    try
                    {
                        deltas[i - 1] = checked((long)values[i] - (long)values[i - 1]);
                    }
                    catch (OverflowException)
                    {
                        fits = false;
                        break;
                    }
                    delta += VarIntSize(deltas[i - 1]);
                }
                if (fits && delta < plain)
                {
                    w.VarInt((long)values[0]);
                    foreach (var d in deltas) w.VarInt(d);
                    return Delta;
                }
                WritePlain(w, type, values);
                return Plain;
            }
            case JazminType.Float:
            {
                var scales = new int[values.Count];
                var mantissas = new long[values.Count];
                long scaledSize = 0;
                for (var i = 0; i < values.Count; i++)
                {
                    scales[i] = ScaleOf((double)values[i], out mantissas[i]);
                    scaledSize += scales[i] < 0 ? 9 : 1 + VarIntSize(mantissas[i]);
                }
                if (scaledSize < values.Count * 8L)
                {
                    for (var i = 0; i < values.Count; i++)
                    {
                        if (scales[i] < 0)
                        {
                            w.Byte(255);
                            w.Float64((double)values[i]);
                        }
                        else
                        {
                            w.Byte((byte)scales[i]);
                            w.VarInt(mantissas[i]);
                        }
                    }
                    return Scaled;
                }
                WritePlain(w, type, values);
                return Plain;
            }
            case JazminType.String or JazminType.Decimal:
            {
                var ids = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var v in values) ids.TryAdd((string)v, ids.Count);
                if (values.Count > 0 && ids.Count * 2 <= values.Count)
                {
                    w.VarUInt((ulong)ids.Count);
                    foreach (var key in ids.Keys) // insertion order = id order
                    {
                        if (type == JazminType.Decimal) Decimals.Write(w, key);
                        else w.String(key);
                    }
                    foreach (var v in values) w.VarUInt((ulong)ids[(string)v]);
                    return Dictionary;
                }
                WritePlain(w, type, values);
                return Plain;
            }
            default:
                WritePlain(w, type, values);
                return Plain;
        }
    }

    /// <summary>
    /// Encodes one chunk payload. <paramref name="columns"/>[j] holds the chunk's values of column j in
    /// normalized form (null for null).
    /// </summary>
    public static byte[] Encode(IReadOnlyList<JazminType> types, IReadOnlyList<List<object?>> columns, int rowCount)
    {
        var output = new ByteWriter(64 * 1024);
        var body = new ByteWriter(1024);
        for (var j = 0; j < types.Count; j++)
        {
            var all = columns[j];
            byte[]? nulls = null;
            var values = new List<object>(rowCount);
            for (var r = 0; r < rowCount; r++)
            {
                if (all[r] is { } v) values.Add(v);
                else
                {
                    nulls ??= new byte[(rowCount + 7) >> 3];
                    nulls[r >> 3] |= (byte)(1 << (r & 7));
                }
            }
            body.Reset();
            var encoding = WriteBody(body, types[j], values);
            output.VarUInt((ulong)(1 + (nulls?.Length ?? 0) + body.Length));
            output.Byte((byte)(encoding | (nulls is null ? 0 : HasNulls)));
            if (nulls is not null) output.Bytes(nulls);
            output.Bytes(body.AsSpan());
        }
        return output.ToArray();
    }

    // ---- reading ----------------------------------------------------------------------------

    /// <summary>
    /// Decodes a columnar payload into one array per column (public value forms, null for null).
    /// Columns with <paramref name="wanted"/>[j] false are skipped and left null.
    /// </summary>
    public static object?[]?[] Decode(byte[] raw, IReadOnlyList<JazminType> types, int rowCount, int ordinal, bool[]? wanted = null, StringPool? strings = null)
    {
        var typed = DecodeTyped(raw, raw.Length, types, rowCount, ordinal, wanted, strings);
        var columns = new object?[]?[types.Count];
        for (var j = 0; j < typed.Length; j++)
        {
            if (typed[j] is not { } column) continue;
            var values = new object?[rowCount];
            for (var r = 0; r < rowCount; r++) values[r] = column.Get(r);
            columns[j] = values;
        }
        return columns;
    }

    /// <summary>
    /// Decodes a columnar payload into typed columns (no boxing): values are boxed only when read with
    /// <see cref="DecodedColumn.Get"/>. Columns with <paramref name="wanted"/>[j] false are skipped and left null.
    /// </summary>
    public static DecodedColumn?[] DecodeTyped(byte[] raw, int rawLength, IReadOnlyList<JazminType> types, int rowCount, int ordinal, bool[]? wanted = null, StringPool? strings = null)
    {
        // Every column takes at least a bit per row: a damaged row count fails here instead of sizing the arrays.
        if (rowCount < 0 || (rowCount > 0 && rowCount > (long)rawLength * 8)) throw new JazminFormatException($"Chunk {ordinal}: row count does not match its size");
        var reader = new ByteReader(raw, 0, rawLength);
        var columns = new DecodedColumn?[types.Count];
        for (var j = 0; j < types.Count; j++)
        {
            var length = reader.VarUInt();
            if (length < 1 || length > (ulong)(rawLength - reader.Position))
                throw new JazminFormatException($"Chunk {ordinal}: invalid stream length");
            var end = reader.Position + (int)length;
            if (wanted is not null && !wanted[j])
            {
                reader.Skip((int)length);
                continue;
            }
            var type = types[j];
            var flags = reader.Byte();
            var encoding = flags & 0x0f;
            if ((flags & 0xe0) != 0) throw new JazminFormatException($"Chunk {ordinal}: reserved stream flags are set");
            if (encoding > Scaled || !Allowed(type, encoding))
                throw new JazminFormatException($"Chunk {ordinal}: encoding {encoding} is not valid for a {type} column");
            byte[]? nulls = (flags & HasNulls) != 0 ? reader.Bytes((rowCount + 7) >> 3).ToArray() : null;
            var column = DecodedColumn.For(type, rowCount, nulls);
            var row = -1;
            int NextRow()
            {
                do row++;
                while (nulls is not null && row < rowCount && (nulls[row >> 3] & (1 << (row & 7))) != 0);
                return row;
            }
            var count = rowCount;
            if (nulls is not null) for (var r = 0; r < rowCount; r++) if ((nulls[r >> 3] & (1 << (r & 7))) != 0) count--;

            switch (encoding)
            {
                case Plain:
                    for (var i = 0; i < count; i++) column.ReadPlain(NextRow(), reader, strings);
                    break;
                case Delta:
                {
                    var longs = ((LongValues)column).Values;
                    long previous = 0;
                    for (var i = 0; i < count; i++)
                    {
                        var d = reader.VarInt();
                        previous = i == 0 ? d : unchecked(previous + d);
                        longs[NextRow()] = previous;
                    }
                    break;
                }
                case Dictionary:
                {
                    var k = reader.VarUInt();
                    // Each entry takes at least one byte. The nulls bitmap or k itself may already have run past the stream.
                    if (k < 1 || reader.Position > end || k > (ulong)(end - reader.Position)) throw new JazminFormatException($"Chunk {ordinal}: invalid dictionary size");
                    var entries = new string[(int)k];
                    for (var i = 0; i < entries.Length; i++)
                        entries[i] = type == JazminType.Decimal ? Decimals.ReadText(reader) : strings?.Read(reader) ?? reader.String();
                    var texts = ((StringValues)column).Values;
                    for (var i = 0; i < count; i++)
                    {
                        var id = reader.VarUInt();
                        if (id >= k) throw new JazminFormatException($"Chunk {ordinal}: dictionary index out of range");
                        texts[NextRow()] = entries[(int)id];
                    }
                    break;
                }
                case Bitmap:
                {
                    var bits = reader.Bytes((count + 7) >> 3);
                    var bools = ((BoolValues)column).Values;
                    for (var i = 0; i < count; i++) bools[NextRow()] = (bits[i >> 3] & (1 << (i & 7))) != 0;
                    break;
                }
                case Scaled:
                {
                    var doubles = ((DoubleValues)column).Values;
                    for (var i = 0; i < count; i++)
                    {
                        var s = reader.Byte();
                        double v;
                        if (s == 255) v = reader.Float64();
                        else if (s <= 22)
                        {
                            var m = reader.VarInt();
                            if (m > MaxMantissa + 1 || m < -(MaxMantissa + 1)) throw new JazminFormatException($"Chunk {ordinal}: scaled value out of range");
                            v = m / Pow10[s];
                        }
                        else throw new JazminFormatException($"Chunk {ordinal}: invalid scale {s}");
                        doubles[NextRow()] = v;
                    }
                    break;
                }
            }
            if (reader.Position != end) throw new JazminFormatException($"Chunk {ordinal}: stream length does not match its contents");
            columns[j] = column;
        }
        if (reader.Position != rawLength) throw new JazminFormatException($"Chunk {ordinal} has trailing bytes");
        return columns;
    }
}

/// <summary>A decoded column of one chunk: typed values by row, boxed only when read.</summary>
internal abstract class DecodedColumn(byte[]? nulls)
{
    public bool IsNull(int row) => nulls is not null && (nulls[row >> 3] & (1 << (row & 7))) != 0;

    public object? Get(int row) => IsNull(row) ? null : Box(row);

    protected abstract object Box(int row);

    public abstract void ReadPlain(int row, ByteReader reader, StringPool? strings);

    public static DecodedColumn For(JazminType type, int rows, byte[]? nulls) => type switch
    {
        JazminType.Int => new LongValues(rows, nulls, dates: false),
        JazminType.DateTime => new LongValues(rows, nulls, dates: true),
        JazminType.Float => new DoubleValues(rows, nulls),
        JazminType.Bool => new BoolValues(rows, nulls),
        JazminType.String => new StringValues(rows, nulls, decimals: false),
        JazminType.Decimal => new StringValues(rows, nulls, decimals: true),
        _ => new ObjectValues(rows, nulls, json: type == JazminType.Json),
    };
}

internal sealed class LongValues(int rows, byte[]? nulls, bool dates) : DecodedColumn(nulls)
{
    public long[] Values { get; } = new long[rows];
    protected override object Box(int row) => dates ? Format.Values.FromEpochMs(Values[row]) : Format.Values.BoxInt(Values[row]);
    public override void ReadPlain(int row, ByteReader reader, StringPool? strings) => Values[row] = reader.VarInt();
}

internal sealed class DoubleValues(int rows, byte[]? nulls) : DecodedColumn(nulls)
{
    public double[] Values { get; } = new double[rows];
    protected override object Box(int row) => Values[row];
    public override void ReadPlain(int row, ByteReader reader, StringPool? strings) => Values[row] = reader.Float64();
}

internal sealed class BoolValues(int rows, byte[]? nulls) : DecodedColumn(nulls)
{
    public bool[] Values { get; } = new bool[rows];
    protected override object Box(int row) => Values[row] ? Format.Values.BoxedTrue : Format.Values.BoxedFalse;
    public override void ReadPlain(int row, ByteReader reader, StringPool? strings) => Values[row] = reader.Byte() != 0;
}

internal sealed class StringValues(int rows, byte[]? nulls, bool decimals) : DecodedColumn(nulls)
{
    public string[] Values { get; } = new string[rows];
    protected override object Box(int row) => Values[row];
    public override void ReadPlain(int row, ByteReader reader, StringPool? strings) =>
        Values[row] = decimals ? Decimals.ReadText(reader) : strings?.Read(reader) ?? reader.String();
}

internal sealed class ObjectValues(int rows, byte[]? nulls, bool json) : DecodedColumn(nulls)
{
    public object[] Values { get; } = new object[rows];
    protected override object Box(int row) => Values[row];
    public override void ReadPlain(int row, ByteReader reader, StringPool? strings) =>
        Values[row] = json ? Format.Values.ParseJson(reader.String(), "A json value") ?? throw new JazminFormatException("json value is null") : reader.Blob();
}
