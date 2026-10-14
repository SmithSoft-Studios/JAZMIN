using System.Text.Json.Nodes;
using Jazmin.Format;
using Jazmin.Query;

namespace Jazmin;

/// <summary>One side of a link: a table (by name; "" for a file's single unnamed table) and its columns.</summary>
public sealed record JazminLinkSide(string Table, IReadOnlyList<string> Columns);

/// <summary>
/// A link between a file's tables (docs/design/table-links.md): the rows of <see cref="From"/> refer to a row of
/// <see cref="To"/> by equal values of their columns. Declared in the file's metadata under <c>jazmin.links</c>.
/// </summary>
public sealed record JazminLink(string Name, JazminLinkSide From, JazminLinkSide To);

/// <summary>
/// A link checked against the rows a key sees (<see cref="JazminReader.CheckLinks"/>): rows whose link finds nothing
/// (<see cref="Missing"/>; rows with an empty key are <see cref="Empty"/>), and target keys that repeat. Method "merge"
/// walked both tables side by side (both sorted by the link columns); "hash" held the target's keys.
/// </summary>
public sealed record JazminLinkCheck(
    string Name, JazminLinkSide From, JazminLinkSide To, long Rows, long Empty, long Missing, IReadOnlyList<object?[]> Examples,
    long DuplicateTargets, IReadOnlyList<object?[]> DuplicateExamples, string Method);

/// <summary>Links declared, read, checked and kept through table renames. The same as the JavaScript library's links.js.</summary>
internal static class Links
{
    public const string Key = "jazmin.links";

    /// <summary>Links as given, checked for their shape.</summary>
    public static List<JazminLink> Normalize(IEnumerable<JazminLink>? links)
    {
        var list = new List<JazminLink>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var link in links ?? [])
        {
            if (link is null || string.IsNullOrEmpty(link.Name)) throw new JazminValidationException("Each link needs a name");
            if (!seen.Add(link.Name)) throw new JazminValidationException($"Link '{link.Name}' is declared twice");
            foreach (var (what, side) in new[] { ("from", link.From), ("to", link.To) })
            {
                if (side is null || side.Table is null) throw new JazminValidationException($"Link '{link.Name}': {what} needs a table and columns");
                if (side.Columns is null || side.Columns.Count == 0 || side.Columns.Any(string.IsNullOrEmpty))
                    throw new JazminValidationException($"Link '{link.Name}': {what}.columns: a non-empty list of column names");
            }
            if (link.From.Columns.Count != link.To.Columns.Count) throw new JazminValidationException($"Link '{link.Name}': from and to need as many columns");
            list.Add(link with { From = link.From with { Columns = link.From.Columns.ToArray() }, To = link.To with { Columns = link.To.Columns.ToArray() } });
        }
        return list;
    }

    /// <summary>The links a file's metadata declares; a malformed list reads as none.</summary>
    public static IReadOnlyList<JazminLink> Read(JsonObject metadata)
    {
        if (metadata[Key] is not JsonArray array) return [];
        static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        static JazminLinkSide? Side(JsonNode? node)
        {
            if (node is not JsonObject o || o["columns"] is not JsonArray columns) return null;
            var names = columns.Select(Text).ToArray();
            return names.Any(n => n is null) ? null : new JazminLinkSide(Text(o["table"]) ?? "", names!);
        }
        var links = new List<JazminLink>();
        foreach (var node in array)
        {
            if (node is not JsonObject entry) return [];
            var name = Text(entry["name"]);
            var from = Side(entry["from"]);
            var to = Side(entry["to"]);
            if (name is null || from is null || to is null) return [];
            links.Add(new JazminLink(name, from, to));
        }
        try
        {
            return Normalize(links);
        }
        catch (JazminValidationException)
        {
            return [];
        }
    }

    /// <summary>The links as metadata JSON, in the order and shape the JavaScript library writes.</summary>
    public static JsonArray ToJson(IEnumerable<JazminLink> links) => new(links.Select(l => (JsonNode?)new JsonObject
    {
        ["name"] = l.Name,
        ["from"] = new JsonObject { ["table"] = l.From.Table, ["columns"] = new JsonArray(l.From.Columns.Select(c => (JsonNode?)c).ToArray()) },
        ["to"] = new JsonObject { ["table"] = l.To.Table, ["columns"] = new JsonArray(l.To.Columns.Select(c => (JsonNode?)c).ToArray()) },
    }).ToArray());

    /// <summary>Checks links against the tables: each table and column exists, and types are equal.</summary>
    public static List<JazminLink> CheckDefinitions(List<JazminLink> links, IReadOnlyDictionary<string, JazminColumn[]> tables)
    {
        foreach (var link in links)
        {
            foreach (var (what, side) in new[] { ("from", link.From), ("to", link.To) })
            {
                if (!tables.TryGetValue(side.Table, out var columns)) throw new JazminValidationException($"Link '{link.Name}': {what} table '{side.Table}' isn't in the file");
                foreach (var c in side.Columns)
                    if (!columns.Any(x => x.Name == c)) throw new JazminValidationException($"Link '{link.Name}': table '{side.Table}' has no column '{c}'");
            }
            for (var i = 0; i < link.From.Columns.Count; i++)
            {
                var a = tables[link.From.Table].First(x => x.Name == link.From.Columns[i]);
                var b = tables[link.To.Table].First(x => x.Name == link.To.Columns[i]);
                if (a.Type != b.Type)
                    throw new JazminValidationException($"Link '{link.Name}': {link.From.Table}.{a.Name} is {TypeNames.ToName(a.Type)} but {link.To.Table}.{b.Name} is {TypeNames.ToName(b.Type)}");
            }
        }
        return links;
    }

    /// <summary>Links after tables are renamed; a link that uses a removed table is refused.</summary>
    public static List<JazminLink> After(IReadOnlyList<JazminLink> links, HashSet<string> removed, IReadOnlyDictionary<string, string> renamed) => links.Select(link =>
    {
        foreach (var side in new[] { link.From, link.To })
            if (removed.Contains(side.Table)) throw new JazminValidationException($"Link '{link.Name}' uses table '{side.Table}', which is being removed: change the links too (Links)");
        string Rename(string t) => renamed.TryGetValue(t, out var to) ? to : t;
        return link with { From = link.From with { Table = Rename(link.From.Table) }, To = link.To with { Table = Rename(link.To.Table) } };
    }).ToList();

    /// <summary>Each link checked against the rows <paramref name="reader"/>'s key sees (only the link columns are read).</summary>
    public static IReadOnlyList<JazminLinkCheck> Check(JazminReader reader, IReadOnlyList<JazminLink> links, int limit)
    {
        var results = new List<JazminLinkCheck>();
        foreach (var link in links)
        {
            // A reader for each side (cheap: they share the open file), so a link within one table reads it twice safely.
            using var from = reader.OpenTable(link.From.Table);
            using var to = reader.OpenTable(link.To.Table);
            var fromTypes = link.From.Columns.Select(c => from.Columns.First(x => x.Name == c).Type).ToArray();
            var toTypes = link.To.Columns.Select(c => to.Columns.First(x => x.Name == c).Type).ToArray();
            object?[] KeyOf(JazminRow row, IReadOnlyList<string> cols, JazminType[] types)
            {
                var key = new object?[cols.Count];
                for (var i = 0; i < key.Length; i++)
                {
                    var v = Values.Normalize(types[i], row[cols[i]], cols[i]);
                    key[i] = v is null ? null : Values.ToKey(types[i], v);
                }
                return key;
            }
            long rows = 0, empty = 0, missing = 0, duplicates = 0;
            var examples = new List<object?[]>();
            var duplicateExamples = new List<object?[]>();
            // Examples as the rows hold them (not as keys: dates as dates, decimals as their text).
            object?[] ValuesOf(JazminRow row, IReadOnlyList<string> cols) => cols.Select(c => row[c]).ToArray();
            void Missing(JazminRow row) { missing++; if (examples.Count < limit) examples.Add(ValuesOf(row, link.From.Columns)); }
            void Duplicate(JazminRow row) { duplicates++; if (duplicateExamples.Count < limit) duplicateExamples.Add(ValuesOf(row, link.To.Columns)); }
            bool Prefix(IReadOnlyList<string>? sorted, IReadOnlyList<string> cols) => sorted is not null && sorted.Count >= cols.Count && cols.Select((c, i) => sorted[i] == c).All(x => x);
            var fromRows = from.Rows(new JazminQueryOptions { Select = link.From.Columns.ToArray() });
            var toRows = to.Rows(new JazminQueryOptions { Select = link.To.Columns.ToArray() });
            string method;
            if (Prefix(from.SortedBy, link.From.Columns) && Prefix(to.SortedBy, link.To.Columns))
            {
                // Both in link order: one pass over each, side by side.
                method = "merge";
                using var targets = toRows.GetEnumerator();
                var target = targets.MoveNext() ? KeyOf(targets.Current, link.To.Columns, toTypes) : null;
                object?[]? repeated = null; // the last target key counted as repeating
                void Advance()
                {
                    var before = target;
                    target = targets.MoveNext() ? KeyOf(targets.Current, link.To.Columns, toTypes) : null;
                    if (target is not null && SortKeys.Compare(target, before!) == 0 && !(repeated is not null && SortKeys.Compare(repeated, target) == 0))
                    {
                        Duplicate(targets.Current);
                        repeated = target;
                    }
                }
                foreach (var row in fromRows)
                {
                    rows++;
                    var key = KeyOf(row, link.From.Columns, fromTypes);
                    if (key.Any(v => v is null))
                    {
                        empty++;
                        continue;
                    }
                    while (target is not null && SortKeys.Compare(target, key) < 0) Advance();
                    if (target is null || SortKeys.Compare(target, key) != 0) Missing(row);
                }
                while (target is not null) Advance(); // the rest of the targets, for repeats
            }
            else
            {
                method = "hash";
                var keys = new HashSet<object?[]>(KeyEquality.Instance);
                var repeatedKeys = new HashSet<object?[]>(KeyEquality.Instance);
                foreach (var row in toRows)
                {
                    var key = KeyOf(row, link.To.Columns, toTypes);
                    if (!keys.Add(key) && repeatedKeys.Add(key)) Duplicate(row);
                }
                foreach (var row in fromRows)
                {
                    rows++;
                    var key = KeyOf(row, link.From.Columns, fromTypes);
                    if (key.Any(v => v is null)) empty++;
                    else if (!keys.Contains(key)) Missing(row);
                }
            }
            results.Add(new JazminLinkCheck(link.Name, link.From, link.To, rows, empty, missing, examples, duplicates, duplicateExamples, method));
        }
        return results;
    }

    /// <summary>Keys (<see cref="Values.ToKey"/>: numbers, text, normalized decimals) equal value by value.</summary>
    private sealed class KeyEquality : IEqualityComparer<object?[]>
    {
        public static readonly KeyEquality Instance = new();

        public bool Equals(object?[]? a, object?[]? b)
        {
            if (a is null || b is null || a.Length != b.Length) return a is null && b is null;
            for (var i = 0; i < a.Length; i++)
                if (!object.Equals(a[i], b[i])) return false;
            return true;
        }

        public int GetHashCode(object?[] key)
        {
            var hash = new HashCode();
            foreach (var part in key) hash.Add(part);
            return hash.ToHashCode();
        }
    }
}
