using System.Globalization;
using System.Numerics;

namespace Jazmin.Format;

/// <summary>
/// Key form of a decimal (spec 5.1, 5.2): the value reduced (trailing zeros removed), so 12.5 and 12.50 are equal,
/// and compared numerically.
/// </summary>
internal sealed record DecimalKey(BigInteger M, int S) : IComparable<DecimalKey>
{
    public static DecimalKey Of(BigInteger m, int s)
    {
        while (s > 0 && !m.IsZero && (m % 10).IsZero)
        {
            m /= 10;
            s--;
        }
        return new DecimalKey(m.IsZero ? BigInteger.Zero : m, m.IsZero ? 0 : s);
    }

    public int CompareTo(DecimalKey? other)
    {
        if (other is null) return 1;
        if (S == other.S) return M.CompareTo(other.M);
        return S < other.S
            ? (M * BigInteger.Pow(10, other.S - S)).CompareTo(other.M)
            : M.CompareTo(other.M * BigInteger.Pow(10, S - other.S));
    }

    public override string ToString() => Decimals.Format(M, S);
}

/// <summary>Exact decimals: stored as a scale and an integer, read back as canonical text (spec 5.1).</summary>
internal static class Decimals
{
    private const int MaxScale = 255;
    private const int MaxDigits = 256;
    private const int MaxVarintBytes = 132; // 256 digits need at most 851 bits (+1 for the sign)

    private static JazminValidationException Fail(string column, string message) => new($"Column '{column}': {message}");

    /// <summary>Parses decimal text into (m, s); throws a validation error for anything else.</summary>
    public static (BigInteger M, int S) Parse(string text, string column = "decimal")
    {
        var negative = text.StartsWith('-');
        var body = negative ? text.AsSpan(1) : text.AsSpan();
        var point = body.IndexOf('.');
        var whole = point < 0 ? body : body[..point];
        var fraction = point < 0 ? ReadOnlySpan<char>.Empty : body[(point + 1)..];
        if (whole.Length == 0 || (point >= 0 && fraction.Length == 0) || !AllDigits(whole) || !AllDigits(fraction))
            throw Fail(column, $"expected a decimal string like '-12.50', got '{text}'");
        if (fraction.Length > MaxScale) throw Fail(column, $"more than {MaxScale} digits after the point");
        var digits = string.Concat(whole, fraction).TrimStart('0');
        if (digits.Length > MaxDigits) throw Fail(column, $"more than {MaxDigits} significant digits");
        var m = digits.Length == 0 ? BigInteger.Zero : BigInteger.Parse(digits, NumberStyles.None, CultureInfo.InvariantCulture);
        return (negative ? -m : m, fraction.Length);
    }

    private static bool AllDigits(ReadOnlySpan<char> s)
    {
        foreach (var c in s) if (c is < '0' or > '9') return false;
        return true;
    }

    /// <summary>Canonical text of m × 10^-s: no leading zeros, no sign on zero, the scale's digits after the point.</summary>
    public static string Format(BigInteger m, int s)
    {
        var negative = m.Sign < 0;
        var digits = BigInteger.Abs(m).ToString(CultureInfo.InvariantCulture).PadLeft(s + 1, '0');
        var text = s > 0 ? $"{digits[..^s]}.{digits[^s..]}" : digits;
        return negative ? "-" + text : text;
    }

    private static string Format(bool negative, ulong magnitude, int s)
    {
        var digits = magnitude.ToString(CultureInfo.InvariantCulture).PadLeft(s + 1, '0');
        var text = s > 0 ? string.Concat(digits.AsSpan(0, digits.Length - s), ".", digits.AsSpan(digits.Length - s)) : digits;
        return negative && magnitude != 0 ? "-" + text : text;
    }

    /// <summary>Canonical text of decimal text.</summary>
    public static string Canonical(string text, string column)
    {
        var (m, s) = Parse(text, column);
        return Format(m, s);
    }

    public static DecimalKey Key(string text)
    {
        var (m, s) = Parse(text);
        return DecimalKey.Of(m, s);
    }

    /// <summary>
    /// Numeric order of two canonical decimal texts without parsing them (statistics while writing):
    /// sign, then the length and digits of the whole part, then the fraction digits.
    /// </summary>
    public static int CompareCanonical(string a, string b)
    {
        bool na = a[0] == '-', nb = b[0] == '-';
        if (na != nb) return na ? -1 : 1;
        var c = CompareMagnitudes(na ? a.AsSpan(1) : a.AsSpan(), nb ? b.AsSpan(1) : b.AsSpan());
        return na ? -c : c;
    }

    private static int CompareMagnitudes(ReadOnlySpan<char> a, ReadOnlySpan<char> b)
    {
        int pa = a.IndexOf('.'), pb = b.IndexOf('.');
        var wa = pa < 0 ? a : a[..pa];
        var wb = pb < 0 ? b : b[..pb];
        if (wa.Length != wb.Length) return wa.Length < wb.Length ? -1 : 1; // canonical: no leading zeros
        var c = wa.SequenceCompareTo(wb);
        if (c != 0) return Math.Sign(c);
        var fa = pa < 0 ? ReadOnlySpan<char>.Empty : a[(pa + 1)..];
        var fb = pb < 0 ? ReadOnlySpan<char>.Empty : b[(pb + 1)..];
        for (var i = 0; i < Math.Max(fa.Length, fb.Length); i++)
        {
            var x = i < fa.Length ? fa[i] : '0';
            var y = i < fb.Length ? fb[i] : '0';
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    /// <summary>Writes a decimal (canonical text or key) as varint scale + zigzag varint of m (spec 5.1).</summary>
    public static void Write(ByteWriter writer, object value)
    {
        if (value is string text && TrySmall(text, out var small, out var scale))
        {
            writer.VarUInt((ulong)scale);
            writer.VarInt(small);
            return;
        }
        var (m, s) = value is DecimalKey key ? (key.M, key.S) : Parse((string)value);
        writer.VarUInt((ulong)s);
        if (m >= long.MinValue && m <= long.MaxValue)
        {
            writer.VarInt((long)m);
            return;
        }
        var z = m.Sign >= 0 ? m << 1 : ((-m) << 1) - 1;
        while (z >= 0x80)
        {
            writer.Byte((byte)((byte)(z & 0x7f) | 0x80));
            z >>= 7;
        }
        writer.Byte((byte)z);
    }

    /// <summary>Canonical text with at most 18 digits as (m, s) without a BigInteger (the common case).</summary>
    private static bool TrySmall(string text, out long m, out int s)
    {
        m = 0;
        s = 0;
        var negative = text.Length > 0 && text[0] == '-';
        var digits = 0;
        var point = -1;
        for (var i = negative ? 1 : 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '.' && point < 0 && digits > 0)
            {
                point = i;
                continue;
            }
            if (c is < '0' or > '9' || ++digits > 18) return false;
            m = m * 10 + (c - '0');
        }
        if (digits == 0 || (point >= 0 && point == text.Length - 1)) return false;
        if (text.Length > (negative ? 2 : 1) && text[negative ? 1 : 0] == '0' && (point < 0 || point > (negative ? 2 : 1))) return false; // not canonical
        s = point < 0 ? 0 : text.Length - point - 1;
        if (negative) m = -m;
        return true;
    }

    /// <summary>Reads the zigzag varint of m: magnitude in a ulong when it fits, else a BigInteger.</summary>
    private static (bool Negative, ulong Magnitude, BigInteger? Big) ReadM(ByteReader reader)
    {
        ulong z = 0;
        var shift = 0;
        for (var n = 0; n < MaxVarintBytes; n++)
        {
            var b = reader.Byte();
            if (shift < 63 || (shift == 63 && b <= 1))
            {
                z |= (ulong)(b & 0x7f) << shift;
                if ((b & 0x80) == 0)
                {
                    var negative = (z & 1) != 0;
                    return (negative, negative ? (z >> 1) + 1 : z >> 1, null);
                }
                shift += 7;
                continue;
            }
            // Past 64 bits: finish with BigInteger.
            var big = new BigInteger(z) | (new BigInteger(b & 0x7f) << shift);
            while ((b & 0x80) != 0)
            {
                if (++n >= MaxVarintBytes) throw new JazminFormatException("Decimal value is too long");
                shift += 7;
                b = reader.Byte();
                big |= new BigInteger(b & 0x7f) << shift;
            }
            var neg = !big.IsEven;
            return (neg, 0, neg ? -((big + 1) >> 1) : big >> 1);
        }
        throw new JazminFormatException("Decimal value is too long");
    }

    private static int ReadScale(ByteReader reader)
    {
        var s = reader.VarUInt();
        return s <= MaxScale ? (int)s : throw new JazminFormatException("Decimal scale is invalid");
    }

    /// <summary>Reads a decimal as canonical text.</summary>
    public static string ReadText(ByteReader reader)
    {
        var s = ReadScale(reader);
        var (negative, magnitude, big) = ReadM(reader);
        return big is { } m ? Format(m, s) : Format(negative, magnitude, s);
    }

    /// <summary>Passes over a decimal without making its text (a row a query does not return).</summary>
    public static void Skip(ByteReader reader)
    {
        ReadScale(reader);
        for (var n = 0; n < MaxVarintBytes; n++)
            if ((reader.Byte() & 0x80) == 0) return;
        throw new JazminFormatException("Decimal value is too long");
    }

    /// <summary>Reads a decimal in key form.</summary>
    public static DecimalKey ReadKey(ByteReader reader)
    {
        var s = ReadScale(reader);
        var (negative, magnitude, big) = ReadM(reader);
        var m = big ?? (negative ? -new BigInteger(magnitude) : new BigInteger(magnitude));
        return DecimalKey.Of(m, s);
    }
}
