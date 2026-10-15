using System.Globalization;
using System.Text;
using Jazmin.Format;

namespace Jazmin;

/// <summary>
/// A key of a table's order (spec 6.7): a column, its text compared ignoring case and accents (<see cref="NoCase"/>),
/// and/or with the numbers inside it by value (<see cref="Natural"/>). Both only for string columns; without them the
/// column compares as its values do.
/// </summary>
public sealed record JazminSortKey(string Column)
{
    /// <summary>apple, Banana, Émile: case and accents ignored.</summary>
    public bool NoCase { get; init; }

    /// <summary>A2 before A10: the numbers inside the text by value.</summary>
    public bool Natural { get; init; }

    internal bool Plain => !NoCase && !Natural;

    public override string ToString() =>
        Plain ? Column : $"{Column} ({string.Join(", ", new[] { NoCase ? "nocase" : null, Natural ? "natural" : null }.OfType<string>())})";
}

/// <summary>A table's order (spec 6.7): its keys as values compare by, other text comparisons included.</summary>
internal static class SortOrder
{
    /// <summary>The order from SortedBy (names, compared as values) or Sort (keys); never both.</summary>
    public static IReadOnlyList<JazminSortKey>? Of(IReadOnlyList<string>? sortedBy, IReadOnlyList<JazminSortKey>? sort, string where = "SortedBy")
    {
        if (sortedBy is not null && sort is not null) throw new JazminValidationException($"Give the order as {where} or as Sort, not both");
        if (sort is not null) return sort;
        return sortedBy?.Select(n => new JazminSortKey(n)).ToList();
    }

    /// <summary>The order's leading plain keys: the catalog's sorted_by.</summary>
    public static List<string> Plain(IReadOnlyList<JazminSortKey> keys) => keys.TakeWhile(k => k.Plain).Select(k => k.Column).ToList();

    /// <summary>The keys as the catalog's sort keeps them, or empty when the order is plain.</summary>
    public static List<JazminSortKey> Catalog(IReadOnlyList<JazminSortKey>? keys) => keys is not null && keys.Any(k => !k.Plain) ? keys.ToList() : [];

    public static string Describe(IReadOnlyList<JazminSortKey> keys) => string.Join(", ", keys);

    /// <summary>Whether two orders are the same: the same columns, compared the same way.</summary>
    public static bool Same(IReadOnlyList<JazminSortKey>? a, IReadOnlyList<JazminSortKey>? b) => (a ?? []).SequenceEqual(b ?? []);

    /// <summary>
    /// A value's sort key for this key (normalized value, not null): its key form (plain), its folded text (nocase), or
    /// its natural-order parts.
    /// </summary>
    public static object Key(JazminType type, object value, JazminSortKey key)
    {
        if (key.Plain) return Values.ToKey(type, value);
        var text = key.NoCase ? Fold((string)value) : (string)value;
        return key.Natural ? new NaturalKey(text) : text;
    }

    /// <summary>A text's folded form (spec 6.7, nocase): NFD, nonspacing marks removed, each code point lowercased on its own.</summary>
    public static string Fold(string text)
    {
        var decomposed = text.Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        foreach (var rune in decomposed.EnumerateRunes())
        {
            if (Rune.GetUnicodeCategory(rune) == UnicodeCategory.NonSpacingMark) continue;
            builder.Append(Rune.ToLowerInvariant(rune).ToString());
        }
        return builder.ToString();
    }
}

/// <summary>A text in natural order (spec 6.7): runs of ASCII digits by value, other runs as text, a digit run first.</summary>
internal sealed class NaturalKey : IComparable<NaturalKey>
{
    // Each part: a digit run as (digits without leading zeros, run length), or other text (Length -1).
    private readonly (string Text, int Length)[] _parts;

    public NaturalKey(string text)
    {
        var parts = new List<(string, int)>();
        var i = 0;
        while (i < text.Length)
        {
            var start = i;
            var digits = char.IsAsciiDigit(text[i]);
            while (i < text.Length && char.IsAsciiDigit(text[i]) == digits) i++;
            var run = text[start..i];
            parts.Add(digits ? (run.TrimStart('0'), run.Length) : (run, -1));
        }
        _parts = parts.ToArray();
    }

    public int CompareTo(NaturalKey? other)
    {
        if (other is null) return 1;
        var n = Math.Min(_parts.Length, other._parts.Length);
        for (var i = 0; i < n; i++)
        {
            var (x, xLength) = _parts[i];
            var (y, yLength) = other._parts[i];
            var xDigits = xLength >= 0;
            if (xDigits != (yLength >= 0)) return xDigits ? -1 : 1; // a digit run before other text
            int c;
            if (xDigits)
            {
                c = x.Length != y.Length ? x.Length.CompareTo(y.Length) : string.CompareOrdinal(x, y);
                if (c == 0) c = xLength.CompareTo(yLength); // equal values: the shorter run first
            }
            else c = string.CompareOrdinal(x, y);
            if (c != 0) return c;
        }
        return _parts.Length.CompareTo(other._parts.Length);
    }
}
