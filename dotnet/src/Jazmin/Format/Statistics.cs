using System.Text;

namespace Jazmin.Format;

/// <summary>Per-chunk statistics for one column, in key form (spec section 6.4).</summary>
internal sealed class ColumnStats
{
    public long Nulls { get; set; }
    public object? Min { get; set; }
    public object? Max { get; set; }

    /// <summary>A leaf of a nested column: its entries in the chunk, null or not (a column's are its rows).</summary>
    public long Count { get; set; }

    /// <summary>A nested column's leaves (spec 6.4), as the writer collects them; null for other columns.</summary>
    public List<LeafStats>? Leaves { get; set; }
}

/// <summary>
/// One leaf of a nested column (a field or item that is not a list or object) in a chunk: <see cref="Path"/> is the field
/// positions from the column to it (a list's item adds none).
/// </summary>
internal sealed record LeafStats(int[] Path, JazminType Type, ColumnStats Stats);

/// <summary>Statistics bounds as stored (spec 6.5): key-form bytes, empty when unbounded.</summary>
internal static class Bounds
{
    private const int MaxStringStat = 64;

    /// <summary>The stored bounds of one chunk's statistics.</summary>
    public static (byte[] Min, byte[] Max) Of(JazminType type, ColumnStats stats)
    {
        if (stats.Min is null || stats.Max is null) return ([], []);
        if (type == JazminType.Float && (!double.IsFinite((double)stats.Min) || !double.IsFinite((double)stats.Max))) return ([], []);
        if (type == JazminType.String)
        {
            // A prefix is still a lower bound; a truncated max would not be an upper bound.
            var min = (string)stats.Min;
            if (min.Length > MaxStringStat) min = min[..(char.IsHighSurrogate(min[MaxStringStat - 1]) ? MaxStringStat - 1 : MaxStringStat)];
            var max = (string)stats.Max;
            return (Encoding.UTF8.GetBytes(min), max.Length > MaxStringStat ? [] : Encoding.UTF8.GetBytes(max));
        }
        return (Encode(type, stats.Min), Encode(type, stats.Max));
    }

    /// <summary>Key-form bytes of a bound: the value encoding, except strings, which are bare UTF-8.</summary>
    public static byte[] Encode(JazminType type, object key)
    {
        if (type == JazminType.String) return Encoding.UTF8.GetBytes((string)key);
        var w = new ByteWriter(16);
        Values.Encode(w, type, key);
        return w.ToArray();
    }

    /// <summary>A bound in key form, or null when unbounded.</summary>
    public static object? Decode(JazminType type, byte[] bytes)
    {
        if (bytes.Length == 0) return null;
        if (type == JazminType.String) return Encoding.UTF8.GetString(bytes);
        var reader = new ByteReader(bytes);
        var key = Values.DecodeKey(reader, type);
        if (!reader.Eof) throw new JazminFormatException("Statistics bound has trailing bytes");
        return key;
    }
}
