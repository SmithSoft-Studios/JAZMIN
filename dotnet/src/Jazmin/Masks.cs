using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jazmin.Format;
using Jazmin.Query;

namespace Jazmin;

/// <summary>What a masked value shows until its lock opens (spec 7.6.8).</summary>
public enum JazminMaskShowKind
{
    /// <summary>Nothing: no shown column.</summary>
    None,

    /// <summary>The last characters: ••••4821.</summary>
    Last,

    /// <summary>The first and last characters: 85••••87.</summary>
    FirstAndLast,

    /// <summary>Spaces, dashes and other marks kept, the last letters and digits shown: •••• •••• •••• 4821; an email keeps its domain.</summary>
    KeepFormat,

    /// <summary>The owner's own text, given in another column.</summary>
    Column,
}

/// <summary>
/// What a masked column's values show until its lock opens (spec 7.6.8): made by the writer in a shown column
/// ("&lt;column&gt;_shown"), an ordinary column that can be sorted and indexed.
/// </summary>
public sealed record JazminMaskShow
{
    private JazminMaskShow(JazminMaskShowKind kind, int first, int last, string? columnName) => (Kind, First, Last, ColumnName) = (kind, first, last, columnName);

    public JazminMaskShowKind Kind { get; }

    /// <summary>The first characters shown (<see cref="JazminMaskShowKind.FirstAndLast"/>).</summary>
    public int First { get; }

    /// <summary>The last characters (or letters and digits, for <see cref="JazminMaskShowKind.KeepFormat"/>) shown.</summary>
    public int Last { get; }

    /// <summary>The column the owner gives the shown values in (<see cref="JazminMaskShowKind.Column"/>).</summary>
    public string? ColumnName { get; }

    /// <summary>No shown column.</summary>
    public static JazminMaskShow None { get; } = new(JazminMaskShowKind.None, 0, 0, null);

    /// <summary>The last <paramref name="last"/> characters (0 to 64): ••••4821.</summary>
    public static JazminMaskShow LastOf(int last) => new(JazminMaskShowKind.Last, 0, last, null);

    /// <summary>The first and last characters (0 to 64 each): 85••••87.</summary>
    public static JazminMaskShow FirstAndLast(int first, int last) => new(JazminMaskShowKind.FirstAndLast, first, last, null);

    /// <summary>The value's format kept, its last <paramref name="last"/> letters and digits shown: •••• •••• •••• 4821.</summary>
    public static JazminMaskShow KeepFormat(int last = 4) => new(JazminMaskShowKind.KeepFormat, 0, last, null);

    /// <summary>The owner's own text, in column <paramref name="column"/> of the table (such as "Savings ending 45").</summary>
    public static JazminMaskShow FromColumn(string column) => new(JazminMaskShowKind.Column, 0, 0, column);
}

/// <summary>
/// A masked column (spec 7.6.8): keys granted it see it only once its lock (<see cref="JazminWriteOptions.Locks"/>) is
/// unlocked; until then they see what <see cref="Show"/> makes. Needs a shared file. <see cref="Rows"/> masks only the
/// rows that match: the others' values go to an ordinary column "&lt;column&gt;_unmasked".
/// </summary>
/// <param name="Lock">The lock that opens it: a password, an unlock token from the owner's key service, or both.</param>
public sealed record JazminMask(string Lock)
{
    public JazminMaskShow Show { get; init; } = JazminMaskShow.None;

    /// <summary>Only the rows that match are masked (null: every row).</summary>
    public JazminFilter? Rows { get; init; }
}

/// <summary>
/// A masked column of the table (spec 7.6.8), as <see cref="JazminReader.Masked"/> lists it. Until <see cref="Lock"/> is
/// unlocked the column isn't in <see cref="JazminReader.Columns"/>.
/// </summary>
/// <param name="Column">The masked column's name.</param>
/// <param name="Type">Its type.</param>
/// <param name="Group">The column group it is kept in, "mask." and its name.</param>
/// <param name="Lock">The lock that opens it.</param>
/// <param name="Shown">The column with what its values show, if it has one.</param>
/// <param name="Unmasked">The column with its values in the rows that aren't masked, if only some rows are.</param>
/// <param name="At">Where the column is (or will be, once unlocked) in <see cref="JazminReader.Columns"/>: viewers show it in its place.</param>
/// <param name="Show">The owner only: what its values show (the rule, as <see cref="JazminUpdate.Masks"/> takes it).</param>
/// <param name="Rows">The owner only: the rows masked, when not every row is.</param>
public sealed record JazminMaskedColumn(string Column, JazminType Type, string Group, JazminLockInfo Lock, string? Shown, string? Unmasked, int At,
    JazminMaskShow? Show = null, JazminFilter? Rows = null);

/// <summary>How a viewer shows a revealed masked value (spec 7.6.8).</summary>
public enum JazminMaskReveal
{
    /// <summary>One value at a time (the default).</summary>
    Value,

    /// <summary>The whole column at once.</summary>
    Column,
}

/// <summary>
/// How viewers show a masked column's revealed values (1.7, spec 7.6.8), for people looking on: by default one value
/// at a time for 30 seconds, masked again when the page is hidden or after 60 seconds idle. Unset settings keep the default.
/// </summary>
public sealed record JazminMaskView
{
    public JazminMaskReveal? Reveal { get; init; }

    /// <summary>Seconds a revealed value stays shown (0 to 86400; 0: until masked again some other way).</summary>
    public int? Seconds { get; init; }

    /// <summary>Masked again when the page is hidden.</summary>
    public bool? WhenHidden { get; init; }

    /// <summary>Masked again after this many seconds without input (0 to 86400; 0: never).</summary>
    public int? IdleSeconds { get; init; }

    /// <summary>False: viewers never export its revealed values (an export has what they show). Unset: when asked.</summary>
    public bool? Export { get; init; }
}

/// <summary>A masked column as the writer keeps it: its group, lock, shown rule, added columns and rows filter (JSON).</summary>
internal sealed record MaskSpec(string Column, string Group, string Lock, JazminMaskShow Show, string? Shown, string? Unmasked, JsonNode? Rows);

/// <summary>
/// Masked columns (spec 7.6.8): a column of a shared file shown masked until its lock (6.8.1) opens. The writer keeps it
/// in a column group of its own, makes its shown column by a rule, and moves the rows not masked to its unmasked column.
/// </summary>
internal static class Masks
{
    /// <summary>The writer feature of a file with masked columns (spec 7.6.8, 12).</summary>
    public const string Feature = "masked-columns";

    private const string Dots = "••••";
    private static readonly Regex GroupNameRule = new("^[A-Za-z0-9_.-]{1,64}$", RegexOptions.CultureInvariant);

    /// <summary>A masked column's group: "mask." and its name, or a name made from it when that isn't a valid group name.</summary>
    public static string GroupName(string column)
    {
        var plain = $"mask.{column}";
        return GroupNameRule.IsMatch(plain) ? plain : $"mask.{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(column)))[..16].ToLowerInvariant()}";
    }

    /// <summary>
    /// The column group of a masked column's shown and unmasked columns (spec 7.6.8): granted with the masked group, not
    /// locked, so a key without the masked column sees nothing of it. "&lt;group&gt;.open", or a name made from it.
    /// </summary>
    public static string OpenGroupName(string group)
    {
        var plain = $"{group}.open";
        return GroupNameRule.IsMatch(plain) ? plain : $"mask.{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(group)))[..16].ToLowerInvariant()}.open";
    }

    private static byte[] GroupAad(string lockId, string group) => Encoding.UTF8.GetBytes($"JAZMIN/1/lock/{lockId}/column-group/{group}");

    /// <summary>A masked column group's secret sealed under its lock's key.</summary>
    public static byte[] SealGroup(LockState lockState, string group, byte[] secret) => Crypto.Encrypt(lockState.Key, secret, GroupAad(lockState.Id, group));

    /// <summary>A masked column group's secret from its sealed form; throws <see cref="JazminKeyException"/> when the lock key is wrong.</summary>
    public static byte[] OpenGroup(byte[] lockKey, string lockId, string group, byte[] sealedSecret) => Crypto.Decrypt(lockKey, sealedSecret, GroupAad(lockId, group));

    /// <summary>A normalized value as text: what a shown rule masks.</summary>
    public static string TextOf(JazminType type, object value) => value switch
    {
        long ms when type == JazminType.DateTime => Values.IsoText(ms),
        long n => n.ToString(CultureInfo.InvariantCulture),
        double d => d.ToString("R", CultureInfo.InvariantCulture),
        bool b => b ? "true" : "false",
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "",
    };

    private static bool IsWordChar(Rune r) => Rune.GetUnicodeCategory(r) is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter
        or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
        or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber;

    private static bool IsWordChar(char c) => char.IsAsciiLetterOrDigit(c) || (c >= 0x80 && char.GetUnicodeCategory(c) is UnicodeCategory.UppercaseLetter
        or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
        or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber);

    /// <summary>
    /// What a masked value shows, by its rule (null for none), by code points so a character is never split. Text without
    /// surrogate pairs (nearly all) is masked by characters with one allocation: the result.
    /// </summary>
    public static string? ShownText(JazminMaskShow show, string? value)
    {
        if (value is null) return null;
        if (value.AsSpan().IndexOfAnyInRange('\uD800', '\uDFFF') >= 0) return ShownRunes(show, value);
        switch (show.Kind)
        {
            case JazminMaskShowKind.Last:
                return value.Length > show.Last ? string.Concat(Dots, value.AsSpan(value.Length - show.Last)) : Dots;
            case JazminMaskShowKind.FirstAndLast:
                return value.Length > show.First + show.Last
                    ? string.Concat(value.AsSpan(0, show.First), Dots, value.AsSpan(value.Length - show.Last)) : Dots;
            case JazminMaskShowKind.KeepFormat:
            {
                var at = value.LastIndexOf('@');
                if (at > 0)
                {
                    return string.Create(value.Length, (value, at), static (span, s) => // an email: its domain kept
                    {
                        span[0] = s.value[0];
                        span[1..s.at].Fill('•');
                        s.value.AsSpan(s.at).CopyTo(span[s.at..]);
                    });
                }
                return string.Create(value.Length, (value, show.Last), static (span, s) =>
                {
                    var keep = s.Last;
                    for (var i = span.Length - 1; i >= 0; i--)
                    {
                        var c = s.value[i];
                        span[i] = !IsWordChar(c) || keep-- > 0 ? c : '•';
                    }
                });
            }
            default:
                return null;
        }
    }

    /// <summary><see cref="ShownText"/> for text with surrogate pairs: by code points.</summary>
    internal static string? ShownRunes(JazminMaskShow show, string value)
    {
        var text = value.EnumerateRunes().ToArray();
        string Join(IEnumerable<Rune> runes) => string.Concat(runes.Select(r => r.ToString()));
        switch (show.Kind)
        {
            case JazminMaskShowKind.Last:
                return text.Length > show.Last ? Dots + Join(text[^show.Last..]) : Dots;
            case JazminMaskShowKind.FirstAndLast:
                return text.Length > show.First + show.Last ? Join(text[..show.First]) + Dots + Join(text[^show.Last..]) : Dots;
            case JazminMaskShowKind.KeepFormat:
            {
                var at = Array.LastIndexOf(text, new Rune('@'));
                if (at > 0) return text[0] + new string('•', at - 1) + Join(text[at..]); // an email: its domain kept
                var keep = show.Last;
                var output = new string[text.Length];
                for (var i = text.Length - 1; i >= 0; i--)
                {
                    if (!IsWordChar(text[i])) output[i] = text[i].ToString();
                    else if (keep > 0)
                    {
                        output[i] = text[i].ToString();
                        keep--;
                    }
                    else output[i] = "•";
                }
                return string.Concat(output);
            }
            default:
                return null;
        }
    }

    /// <summary>The show rule as the owner directory keeps it.</summary>
    public static JsonNode ShowJson(JazminMaskShow show) => show.Kind switch
    {
        JazminMaskShowKind.None => "none",
        JazminMaskShowKind.Column => new JsonObject { ["column"] = show.ColumnName },
        JazminMaskShowKind.KeepFormat => new JsonObject { ["keepFormat"] = true, ["last"] = show.Last },
        JazminMaskShowKind.FirstAndLast => new JsonObject { ["first"] = show.First, ["last"] = show.Last },
        _ => new JsonObject { ["last"] = show.Last },
    };

    /// <summary>A show rule from the owner directory (written by either library).</summary>
    public static JazminMaskShow ShowFrom(JsonNode? json)
    {
        if (json is null || (json is JsonValue v && v.TryGetValue<string>(out var text) && text == "none")) return JazminMaskShow.None;
        if (json is not JsonObject o) throw new JazminFormatException("The owner directory's masked columns are malformed");
        if (o["column"] is { } column) return JazminMaskShow.FromColumn((string)column!);
        var last = (int?)o["last"];
        if (o["keepFormat"] is not null) return JazminMaskShow.KeepFormat(last ?? 4);
        if (o["first"] is { } first) return JazminMaskShow.FirstAndLast((int)first!, last ?? 0);
        return JazminMaskShow.LastOf(last ?? 0);
    }

    private static readonly HashSet<JazminType> ShownTypes =
        [JazminType.String, JazminType.Int, JazminType.Float, JazminType.Decimal, JazminType.DateTime, JazminType.Bool];

    /// <summary>
    /// A table's masks, checked: the columns that have a <see cref="JazminColumn.Mask"/>, and those a rewrite or an
    /// append keeps (<paramref name="kept"/>, owner directory entries, by column name). Returns the columns with the
    /// shown and unmasked columns added at the end (unless they are there), each mask, and the masked column groups.
    /// </summary>
    public static (JazminColumn[] Columns, List<MaskSpec> Masks, Dictionary<string, string[]> Groups) ForTable(JazminColumn[] columns, IEnumerable<JsonNode?> kept)
    {
        var given = columns.Where(c => c.Mask is not null).Select(c => (Column: c.Name, Mask: c.Mask!, Kept: (JsonObject?)null, Given: true)).ToList();
        foreach (var k in kept)
        {
            if (k is not JsonObject o || o["column"] is not JsonValue name || o["lock"] is not JsonValue lockId) throw new JazminFormatException("The owner directory's masked columns are malformed");
            if (given.Any(g => g.Column == (string)name!)) continue;
            given.Add(((string)name!, new JazminMask((string)lockId!) { Show = ShowFrom(o["show"]) }, o, false));
        }
        if (given.Count == 0) return (columns, [], new());
        var output = columns.ToList();
        var names = columns.Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        var groups = new Dictionary<string, string[]>(StringComparer.Ordinal);
        var masks = new List<MaskSpec>();
        foreach (var (name, mask, keptEntry, isGiven) in given)
        {
            var where = $"Column '{name}': mask";
            var column = output.FirstOrDefault(c => c.Name == name) ?? throw new JazminValidationException($"{where}: no column '{name}'");
            if (!ShownTypes.Contains(column.Type)) throw new JazminValidationException($"{where}: a {TypeNames.ToName(column.Type)} column can't be masked");
            if (string.IsNullOrEmpty(mask.Lock)) throw new JazminValidationException($"{where} needs the lock that opens it (one of Locks)");
            var show = mask.Show ?? JazminMaskShow.None;
            foreach (var (count, label) in new[] { (show.First, "First"), (show.Last, "Last") })
                if (count is < 0 or > 64) throw new JazminValidationException($"{where}: Show.{label} must be a whole number from 0 to 64");
            string? shown = null;
            if (show.Kind == JazminMaskShowKind.Column)
            {
                if (show.ColumnName is null || !names.Contains(show.ColumnName)) throw new JazminValidationException($"{where}: the shown column '{show.ColumnName}' is not a column");
                shown = show.ColumnName;
            }
            else if (show.Kind != JazminMaskShowKind.None)
            {
                var keptShown = (string?)keptEntry?["shown"];
                shown = keptShown ?? $"{name}_shown";
                if (names.Add(shown)) output.Add(new JazminColumn(shown, JazminType.String) { Description = $"What a masked '{name}' value shows" });
                else if (isGiven)
                    throw new JazminValidationException($"{where}: a column '{shown}' is there already; name the column the shown values are made in with JazminMaskShow.FromColumn, or rename it");
            }
            string? unmasked = null;
            var rows = isGiven ? mask.Rows?.ToJson() : keptEntry!["rows"]?.DeepClone();
            if (rows is not null || keptEntry?["unmasked"] is not null)
            {
                unmasked = (string?)keptEntry?["unmasked"] ?? $"{name}_unmasked";
                if (names.Add(unmasked)) output.Add(new JazminColumn(unmasked, column.Type) { Description = $"'{name}' in the rows that aren't masked" });
                else if (isGiven) throw new JazminValidationException($"{where}: a column '{unmasked}' is there already, for the rows that aren't masked: rename it");
            }
            var group = (string?)keptEntry?["group"] ?? GroupName(name);
            groups[group] = [name];
            // The shown column the writer makes and the unmasked column go with the masked one: a group of their own,
            // granted with it. A shown column the owner fills (FromColumn) stays where the owner put it.
            string[] made = [.. new[] { show.Kind == JazminMaskShowKind.Column ? null : shown, unmasked }.OfType<string>()];
            if (made.Length > 0) groups[OpenGroupName(group)] = made;
            masks.Add(new MaskSpec(name, group, mask.Lock, show, shown, unmasked, rows));
        }
        return ([.. output], masks, groups);
    }

    /// <summary>The masks as the owner directory keeps them (spec 7.6.8), for table <paramref name="table"/>: with each column's position and type.</summary>
    public static IEnumerable<JsonObject> OwnerEntries(IEnumerable<MaskSpec> masks, int table, JazminColumn[] columns) => masks.Select(m =>
    {
        var position = Array.FindIndex(columns, c => c.Name == m.Column);
        var entry = new JsonObject
        {
            ["group"] = m.Group, ["lock"] = m.Lock, ["table"] = table, ["position"] = position, ["column"] = m.Column,
            ["type"] = TypeNames.ToName(columns[position].Type),
        };
        if (m.Shown is not null) entry["shown"] = m.Shown;
        if (m.Unmasked is not null) entry["unmasked"] = m.Unmasked;
        entry["show"] = ShowJson(m.Show);
        if (m.Rows is not null) entry["rows"] = m.Rows.DeepClone();
        return entry;
    });

    /// <summary>The package's mask view settings as its JSON (spec 7.6.8).</summary>
    public static JsonObject PackageJson(IReadOnlyDictionary<string, JazminMaskView> masks)
    {
        var json = new JsonObject();
        foreach (var (column, view) in masks)
        {
            var where = $"package.masks.{column}";
            if (view is null) throw new JazminValidationException($"{where} must be given");
            var settings = new JsonObject();
            if (view.Reveal is { } reveal) settings["reveal"] = reveal == JazminMaskReveal.Column ? "column" : "value";
            if (view.Seconds is { } seconds) settings["seconds"] = CheckSeconds(seconds, $"{where}.seconds");
            if (view.WhenHidden is { } hidden) settings["whenHidden"] = hidden;
            if (view.IdleSeconds is { } idle) settings["idleSeconds"] = CheckSeconds(idle, $"{where}.idleSeconds");
            if (view.Export is { } export) settings["export"] = export;
            json[column] = settings;
        }
        return json;
    }

    private static int CheckSeconds(int value, string where) => value is >= 0 and <= 86400
        ? value : throw new JazminValidationException($"{where}: a whole number of seconds from 0 to 86400");

    /// <summary>The package's mask view settings, read leniently (a setting not understood is left out).</summary>
    public static IReadOnlyDictionary<string, JazminMaskView>? PackageFrom(JsonNode? json)
    {
        if (json is not JsonObject o) return null;
        var masks = new Dictionary<string, JazminMaskView>(StringComparer.Ordinal);
        foreach (var (column, node) in o)
        {
            if (node is not JsonObject s) continue;
            static int? Seconds(JsonNode? n) => n is JsonValue v && v.TryGetValue<int>(out var i) && i is >= 0 and <= 86400 ? i : null;
            masks[column] = new JazminMaskView
            {
                Reveal = (s["reveal"] as JsonValue)?.TryGetValue<string>(out var r) == true ? r switch { "column" => JazminMaskReveal.Column, "value" => JazminMaskReveal.Value, _ => null } : null,
                Seconds = Seconds(s["seconds"]),
                WhenHidden = s["whenHidden"] is JsonValue h && h.TryGetValue<bool>(out var b) ? b : null,
                IdleSeconds = Seconds(s["idleSeconds"]),
                Export = s["export"] is JsonValue e && e.TryGetValue<bool>(out var exports) ? exports : null,
            };
        }
        return masks;
    }
}

/// <summary>
/// A row's mask work, for the writer (spec 7.6.8): in tables that mask some rows, a row's value stays in the masked
/// column when the row matches the rows filter, else it moves to the unmasked column (a row with only an unmasked value
/// keeps it); then the shown values are made.
/// </summary>
internal sealed class RowMasker
{
    private readonly record struct Work(int Col, JazminType Type, string Name, JazminMaskShow Show, int Shown, int Unmasked, BoundFilter? Rows);

    private readonly Work[] _work;
    private readonly JazminColumn[] _columns;
    private readonly int[] _filterCols; // the columns the rows filters read, normalized for them
    private readonly object?[] _output;
    private readonly object?[] _normal;
    private readonly JsonSerializerOptions? _json;

    public RowMasker(IReadOnlyList<MaskSpec> masks, JazminColumn[] columns, JsonSerializerOptions? json)
    {
        _columns = columns;
        _json = json;
        int Index(string name) => Array.FindIndex(columns, c => c.Name == name);
        var read = new HashSet<int>();
        _work = masks.Select(m =>
        {
            var col = Index(m.Column);
            BoundFilter? rows = null;
            if (m.Rows is not null)
            {
                using var doc = JsonDocument.Parse(m.Rows.ToJsonString());
                rows = BoundFilter.Bind(JazminFilter.FromJson(doc.RootElement), columns);
                Collect(rows!, read);
            }
            return new Work(col, columns[col].Type, m.Column, m.Show, m.Shown is null || m.Show.Kind == JazminMaskShowKind.Column ? -1 : Index(m.Shown),
                m.Unmasked is null ? -1 : Index(m.Unmasked), rows);
        }).ToArray();
        _filterCols = [.. read.Order()];
        _output = new object?[columns.Length];
        _normal = new object?[columns.Length];
    }

    private static void Collect(BoundFilter node, HashSet<int> cols)
    {
        switch (node)
        {
            case BoundFilter.Leaf l: cols.Add(l.Col); break;
            case BoundFilter.Nested n: cols.Add(n.Col); break;
            case BoundFilter.Not n: Collect(n.Item, cols); break;
            case BoundFilter.And a: foreach (var item in a.Items) Collect(item, cols); break;
            case BoundFilter.Or o: foreach (var item in o.Items) Collect(item, cols); break;
        }
    }

    /// <summary>The row with its mask work done, in a buffer reused for the next row.</summary>
    public object?[] Apply(object?[] values)
    {
        Array.Copy(values, _output, _output.Length);
        foreach (var c in _filterCols) _normal[c] = Values.Normalize(_columns[c].Type, values[c], _columns[c].Name, _json);
        foreach (var m in _work)
        {
            if (m.Unmasked >= 0 && _output[m.Col] is { } value)
            {
                if (m.Rows is null || FilterEngine.Evaluate(m.Rows, _normal)) _output[m.Unmasked] = null;
                else
                {
                    _output[m.Unmasked] = value;
                    _output[m.Col] = null;
                }
            }
            if (m.Shown >= 0)
                _output[m.Shown] = _output[m.Col] is { } shown ? Masks.ShownText(m.Show, Masks.TextOf(m.Type, Values.Normalize(m.Type, shown, m.Name)!)) : null;
        }
        return _output;
    }
}
