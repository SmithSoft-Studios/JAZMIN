using System.Globalization;
using Jazmin.Format;

namespace Jazmin.Query;

/// <summary>A filter validated against a schema, with operands converted to key form.</summary>
internal abstract record BoundFilter
{
    public sealed record And(BoundFilter[] Items) : BoundFilter;

    public sealed record Or(BoundFilter[] Items) : BoundFilter;

    public sealed record Not(BoundFilter Item) : BoundFilter;

    /// <summary>
    /// A condition on a nested column's lists (any, all: <see cref="Inner"/> on each item) or object (match: on its fields).
    /// <see cref="Part"/> is what <see cref="Inner"/> is bound to: the object (its fields by position), or an item that is
    /// not an object (the item itself at position 0).
    /// </summary>
    public sealed record Nested(int Col, string Name, string Op, BoundFilter Inner, JazminColumn Part) : BoundFilter;

    public sealed record Leaf(int Col, string Name, JazminType Type, string Op, object? Value) : BoundFilter
    {
        /// <summary>For `in`: the listed keys as a hash set and in order (null for other operators).</summary>
        public InKeys? Keys { get; init; }
    }

    private static readonly HashSet<string> RangeOps = new() { "gt", "gte", "lt", "lte" };
    private static readonly HashSet<string> StringOps = new() { "contains", "icontains", "startsWith" };
    private static readonly HashSet<string> AllOps = new(RangeOps.Concat(StringOps)) { "eq", "ne", "in", "isNull", "any", "all", "match" };

    public static BoundFilter? Bind(JazminFilter? filter, IReadOnlyList<JazminColumn> columns)
    {
        if (filter is null) return null;
        var byName = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < columns.Count; i++)
            if (!columns[i].Name.StartsWith('\0')) byName[columns[i].Name] = i; // hidden columns' placeholders cannot be named (spec 7.6.6)
        return Bind(filter, columns, byName);
    }

    private static BoundFilter Bind(JazminFilter filter, IReadOnlyList<JazminColumn> columns, Dictionary<string, int> byName) => filter switch
    {
        JazminFilter.Group { Kind: "and" } g => new And(g.Items.Select(i => Bind(i, columns, byName)).ToArray()),
        JazminFilter.Group g => new Or(g.Items.Select(i => Bind(i, columns, byName)).ToArray()),
        JazminFilter.Negation n => new Not(Bind(n.Item, columns, byName)),
        JazminFilter.Condition c => BindLeaf(c, columns, byName),
        _ => throw JazminFilter.Invalid("unknown filter node"),
    };

    private static BoundFilter BindLeaf(JazminFilter.Condition c, IReadOnlyList<JazminColumn> columns, Dictionary<string, int> byName)
    {
        if (!byName.TryGetValue(c.Column, out var col)) throw JazminFilter.Invalid($"unknown column '{c.Column}'");
        if (!AllOps.Contains(c.Op)) throw JazminFilter.Invalid($"unknown operator '{c.Op}'");
        var column = columns[col];
        Leaf Make(string op, object? value) => new(col, column.Name, column.Type, op, value);

        if (c.Op is "any" or "all" or "match")
        {
            var isMatch = c.Op == "match";
            if (column.Type != (isMatch ? JazminType.Object : JazminType.List))
                throw JazminFilter.Invalid($"'{c.Op}' only applies to {(isMatch ? "object" : "list")} columns, and '{column.Name}' is a {TypeNames.ToName(column.Type)}");
            var part = isMatch ? column : column.Item!; // what the inner filter is about
            var inner = c.Value switch
            {
                JazminFilter f => f,
                System.Text.Json.JsonElement e when part.Type == JazminType.Object => JazminFilter.FromJson(e),
                System.Text.Json.JsonElement e => JazminFilter.ItemConditions(e),
                _ => throw JazminFilter.Invalid($"'{c.Op}' needs a filter"),
            };
            var bound = part.Type == JazminType.Object
                ? Bind(inner, part.Fields!, part.Fields!.Select((f, i) => (f.Name, i)).ToDictionary(x => x.Name, x => x.i, StringComparer.Ordinal))
                : Bind(inner, [part], new Dictionary<string, int>(StringComparer.Ordinal) { [JazminFilter.Itself] = 0 });
            return new Nested(col, column.Name, c.Op, bound, part);
        }

        if (c.Op == "isNull")
            return c.Value is bool b ? Make("isNull", b) : throw JazminFilter.Invalid("'isNull' needs true or false");
        if (c.Op is "eq" or "ne" && c.Value is null) return Make("isNull", c.Op == "eq"); // { "col": null }, for any type (spec 9.1)
        if (StringOps.Contains(c.Op))
        {
            if (column.Type != JazminType.String) throw JazminFilter.Invalid($"'{c.Op}' only applies to string columns");
            return c.Value is string s ? Make(c.Op, s) : throw JazminFilter.Invalid($"'{c.Op}' needs a string");
        }
        var allowed = RangeOps.Contains(c.Op) ? TypeNames.IsOrdered(column.Type) : TypeNames.IsEquatable(column.Type);
        if (!allowed) throw JazminFilter.Invalid($"'{c.Op}' is not supported on {TypeNames.ToName(column.Type)} column '{column.Name}'");
        if (c.Op == "in")
        {
            if (c.Value is not System.Collections.IEnumerable list || c.Value is string) throw JazminFilter.Invalid("'in' needs an array");
            var keys = list.Cast<object?>().Select(v => Coerce(column, v)).ToArray();
            return Make("in", keys) with { Keys = InKeys.Of(keys) };
        }
        var operand = Coerce(column, c.Value);
        if (operand is null)
        {
            return c.Op switch
            {
                "eq" => Make("isNull", true),
                "ne" => Make("isNull", false),
                _ => throw JazminFilter.Invalid($"'{c.Op}' cannot compare with null"),
            };
        }
        return Make(c.Op, operand);
    }

    /// <summary>Lenient conversion of operands (e.g. GraphQL/JSON strings) to the column's key form.</summary>
    private static object? Coerce(JazminColumn column, object? value)
    {
        if (value is null) return null;
        try
        {
            object? converted = column.Type switch
            {
                JazminType.Int => value switch
                {
                    string s => long.Parse(s, CultureInfo.InvariantCulture),
                    double d when d == Math.Floor(d) => (long)d,
                    _ => value,
                },
                JazminType.Float => value switch
                {
                    string s => double.Parse(s, CultureInfo.InvariantCulture),
                    float or long or int or decimal or short => Convert.ToDouble(value, CultureInfo.InvariantCulture),
                    _ => value,
                },
                JazminType.Bool => value is string s ? bool.Parse(s) : value,
                JazminType.Decimal => value switch // JSON numbers: as text, which decimals are read from
                {
                    long l => l.ToString(CultureInfo.InvariantCulture),
                    double d => d.ToString("R", CultureInfo.InvariantCulture),
                    _ => value,
                },
                JazminType.String => value is string ? value : Convert.ToString(value, CultureInfo.InvariantCulture),
                _ => value,
            };
            var normalized = Values.Normalize(column.Type, converted, column.Name);
            return normalized is null ? null : Values.ToKey(column.Type, normalized);
        }
        catch (FormatException)
        {
            throw JazminFilter.Invalid($"'{value}' is not a valid {TypeNames.ToName(column.Type)} for column '{column.Name}'");
        }
    }
}

/// <summary>
/// The fields of nested columns a filter reads, so only those are decoded to check it: the others are marked
/// <see cref="JazminColumn.Unread"/>, as LINQ marks the fields a query does not read (their streams are passed over).
/// </summary>
internal static class NestedReads
{
    /// <summary>Nested column <paramref name="column"/> (at <paramref name="col"/>) with only the fields <paramref name="filter"/> checks read.</summary>
    public static JazminColumn Checked(JazminColumn column, int col, BoundFilter filter) => Needs(column, Inners([filter], col));

    /// <summary>One definition read two ways (each a copy with fields marked unread, or the definition): a field is read when either reads it.</summary>
    public static JazminColumn Merge(JazminColumn a, JazminColumn b)
    {
        if (ReferenceEquals(a, b) || b.Unread) return a;
        if (a.Unread) return b;
        if (a is { Type: JazminType.List, Item: { } ai } && b.Item is { } bi)
        {
            var item = Merge(ai, bi);
            return ReferenceEquals(item, ai) ? a : ReferenceEquals(item, bi) ? b : new JazminColumn(a.Name, a.Type) { Nullable = a.Nullable, Item = item };
        }
        if (a is { Type: JazminType.Object, Fields: { } af } && b.Fields is { } bf)
        {
            var fields = new JazminColumn[af.Count];
            bool sameA = true, sameB = true;
            for (var i = 0; i < fields.Length; i++)
            {
                fields[i] = Merge(af[i], bf[i]);
                sameA &= ReferenceEquals(fields[i], af[i]);
                sameB &= ReferenceEquals(fields[i], bf[i]);
            }
            return sameA ? a : sameB ? b : new JazminColumn(a.Name, a.Type) { Nullable = a.Nullable, Fields = fields };
        }
        return a;
    }

    /// <summary><paramref name="part"/> with only what <paramref name="inners"/> (filters of its fields, or of its item at position 0) read.</summary>
    private static JazminColumn Needs(JazminColumn part, List<BoundFilter> inners)
    {
        if (part.Type == JazminType.List)
        {
            var item = part.Item!;
            var read = item.Type == JazminType.Object ? Needs(item, inners) // filters of the items' fields
                : TypeNames.IsNested(item.Type) ? Needs(item, Inners(inners, 0)) // items that are lists: their conditions' filters
                : item;
            return ReferenceEquals(read, item) ? part : new JazminColumn(part.Name, part.Type) { Nullable = part.Nullable, Item = read };
        }
        var fields = part.Fields!;
        var trimmed = new JazminColumn[fields.Count];
        var same = true;
        for (var i = 0; i < fields.Count; i++)
        {
            var f = fields[i];
            trimmed[i] = !Reads(inners, i) ? new JazminColumn(f.Name, f.Type) { Nullable = f.Nullable, Item = f.Item, Fields = f.Fields, Unread = true }
                : TypeNames.IsNested(f.Type) ? Needs(f, Inners(inners, i))
                : f;
            same &= ReferenceEquals(trimmed[i], f);
        }
        return same ? part : new JazminColumn(part.Name, part.Type) { Nullable = part.Nullable, Fields = trimmed };
    }

    /// <summary>The filters of the any / all / match conditions on position <paramref name="col"/>, through and, or and not.</summary>
    private static List<BoundFilter> Inners(List<BoundFilter> filters, int col)
    {
        var found = new List<BoundFilter>();
        void Walk(BoundFilter f)
        {
            switch (f)
            {
                case BoundFilter.Nested n when n.Col == col: found.Add(n.Inner); break;
                case BoundFilter.Not not: Walk(not.Item); break;
                case BoundFilter.And and: foreach (var item in and.Items) Walk(item); break;
                case BoundFilter.Or or: foreach (var item in or.Items) Walk(item); break;
            }
        }
        foreach (var f in filters) Walk(f);
        return found;
    }

    /// <summary>Whether any condition of <paramref name="filters"/> is on position <paramref name="col"/>.</summary>
    private static bool Reads(List<BoundFilter> filters, int col)
    {
        static bool Walk(BoundFilter f, int col) => f switch
        {
            BoundFilter.Leaf l => l.Col == col,
            BoundFilter.Nested n => n.Col == col,
            BoundFilter.Not not => Walk(not.Item, col),
            BoundFilter.And and => and.Items.Any(item => Walk(item, col)),
            BoundFilter.Or or => or.Items.Any(item => Walk(item, col)),
            _ => false,
        };
        return filters.Exists(f => Walk(f, col));
    }
}

/// <summary>
/// An `in` list's keys as a hash set (to check rows) and in order (to check chunk statistics), so a long list costs about
/// as much as a short one. Null and NaN are left out: they equal nothing. Keys of one column type are equal exactly when
/// <see cref="Values.Compare"/> says so (decimal keys are normalized, -0 is folded into 0).
/// </summary>
internal sealed class InKeys
{
    private readonly HashSet<object> _set;
    private readonly object[] _sorted;

    private InKeys(HashSet<object> set)
    {
        _set = set;
        _sorted = [.. set];
        Array.Sort(_sorted, (a, b) => Values.Compare(a, b)!.Value);
        if (set.All(k => k is long)) Longs = set.Select(k => (long)k).ToHashSet();
    }

    /// <summary>The keys of an integer or date column, to check values as stored (no object per value).</summary>
    public HashSet<long>? Longs { get; }

    public static InKeys Of(IEnumerable<object?> keys) => new(keys.Where(k => k is not null && !Values.IsNaN(k)).Select(k => k!).ToHashSet());

    public bool Contains(object key) => _set.Contains(key);

    /// <summary>Whether one of the keys lies within [min, max]; an absent bound is open.</summary>
    public bool AnyBetween(object? min, object? max)
    {
        int lo = 0, hi = _sorted.Length;
        if (min is not null)
        {
            while (lo < hi)
            {
                var mid = (lo + hi) >>> 1;
                if (Values.Compare(_sorted[mid], min) < 0) lo = mid + 1;
                else hi = mid;
            }
        }
        return lo < _sorted.Length && (max is null || Values.Compare(_sorted[lo], max) <= 0);
    }
}

/// <summary>Evaluation, index planning and chunk pruning for bound filters.</summary>
internal static class FilterEngine
{
    /// <summary>Whether a row matches. Called for every row a query checks, so it allocates nothing (no lambdas).</summary>
    public static bool Evaluate(BoundFilter node, object?[] row)
    {
        switch (node)
        {
            case BoundFilter.Leaf l: return EvaluateLeaf(l, row[l.Col]);
            case BoundFilter.Nested n: return EvaluateNested(n, row[n.Col]);
            case BoundFilter.And a:
                foreach (var item in a.Items)
                    if (!Evaluate(item, row)) return false;
                return true;
            case BoundFilter.Or o:
                foreach (var item in o.Items)
                    if (Evaluate(item, row)) return true;
                return false;
            case BoundFilter.Not n: return !Evaluate(n.Item, row);
            default: return false;
        }
    }

    /// <summary>
    /// Whether row <paramref name="r"/> of a decoded chunk matches, read from its typed columns: integers and dates are
    /// compared as stored, without an object per value.
    /// </summary>
    public static bool Evaluate(BoundFilter node, DecodedColumn?[] columns, int r)
    {
        switch (node)
        {
            case BoundFilter.Leaf l:
                var column = columns[l.Col]!;
                if (l.Op == "isNull") return column.IsNull(r) == (bool)l.Value!;
                if (column is LongValues longs && !longs.IsNull(r) && LongLeaf(l, longs.Values[r]) is { } match) return match;
                return EvaluateLeaf(l, column.Get(r));
            case BoundFilter.Nested n:
                return columns[n.Col] is NestedValues nested ? EvaluateNested(n, nested.Root, r) : EvaluateNested(n, columns[n.Col]!.Get(r));
            case BoundFilter.And a:
                foreach (var item in a.Items)
                    if (!Evaluate(item, columns, r)) return false;
                return true;
            case BoundFilter.Or o:
                foreach (var item in o.Items)
                    if (Evaluate(item, columns, r)) return true;
                return false;
            case BoundFilter.Not n: return !Evaluate(n.Item, columns, r);
            default: return false;
        }
    }

    // ---- nested columns (spec 5.4, 9.2): any and all on a list's items, match on an object's fields ----

    private static readonly object Present = new(); // a nested value that is there (for isNull)

    /// <summary>A nested column's condition on a value as an untyped row holds it (JSON).</summary>
    private static bool EvaluateNested(BoundFilter.Nested n, object? value)
    {
        if (value is not System.Text.Json.Nodes.JsonNode node) return false; // a null list or object matches nothing
        if (n.Op == "match") return node is System.Text.Json.Nodes.JsonObject fields && Evaluate(n.Inner, FieldValues(n.Part, fields));
        if (node is not System.Text.Json.Nodes.JsonArray items) return false;
        foreach (var item in items)
        {
            var matched = n.Part.Type == JazminType.Object
                ? item is System.Text.Json.Nodes.JsonObject fields && Evaluate(n.Inner, FieldValues(n.Part, fields)) // a null object has no field that matches
                : Evaluate(n.Inner, [Stored(n.Part, item)]);
            if (matched == (n.Op == "any")) return matched;
        }
        return n.Op == "all";
    }

    private static object?[] FieldValues(JazminColumn part, System.Text.Json.Nodes.JsonObject fields) =>
        [.. part.Fields!.Select(f => Stored(f, fields[f.Name]))];

    /// <summary>A field's or item's JSON in the form conditions compare (lists and objects stay JSON).</summary>
    private static object? Stored(JazminColumn c, System.Text.Json.Nodes.JsonNode? node) =>
        node is null ? null : TypeNames.IsNested(c.Type) || c.Type == JazminType.Json ? node : Format.Nested.Normalize(c, node, c.Name, null);

    /// <summary>A nested column's condition on a decoded part (<paramref name="node"/>, entry <paramref name="entry"/>), from its typed values.</summary>
    private static bool EvaluateNested(BoundFilter.Nested n, NestedNode node, int entry)
    {
        if (node.IsNull(entry)) return false;
        var k = node.Rank(entry);
        if (n.Op == "match") return EvaluateFields(n.Inner, node, k);
        var items = node.Items!;
        for (var i = node.ItemsFrom(k); i < node.ItemsTo(k); i++)
        {
            var matched = n.Part.Type == JazminType.Object
                ? !items.IsNull(i) && EvaluateFields(n.Inner, items, items.Rank(i))
                : EvaluateItem(n.Inner, items, i);
            if (matched == (n.Op == "any")) return matched;
        }
        return n.Op == "all";
    }

    /// <summary>A filter of an object's fields: <paramref name="obj"/>'s fields at its <paramref name="k"/>-th object that is not null.</summary>
    private static bool EvaluateFields(BoundFilter f, NestedNode obj, int k)
    {
        switch (f)
        {
            case BoundFilter.Leaf l: return EvaluateLeaf(l, obj.Fields![l.Col] is { } field ? ValueAt(field, k) : null);
            case BoundFilter.Nested n: return obj.Fields![n.Col] is { } part && EvaluateNested(n, part, k);
            case BoundFilter.And a:
                foreach (var item in a.Items)
                    if (!EvaluateFields(item, obj, k)) return false;
                return true;
            case BoundFilter.Or o:
                foreach (var item in o.Items)
                    if (EvaluateFields(item, obj, k)) return true;
                return false;
            case BoundFilter.Not not: return !EvaluateFields(not.Item, obj, k);
            default: return false;
        }
    }

    /// <summary>A condition on a list item that is not an object: the item itself is position 0.</summary>
    private static bool EvaluateItem(BoundFilter f, NestedNode items, int i)
    {
        switch (f)
        {
            case BoundFilter.Leaf l: return EvaluateLeaf(l, ValueAt(items, i));
            case BoundFilter.Nested n: return EvaluateNested(n, items, i);
            case BoundFilter.And a:
                foreach (var item in a.Items)
                    if (!EvaluateItem(item, items, i)) return false;
                return true;
            case BoundFilter.Or o:
                foreach (var item in o.Items)
                    if (EvaluateItem(item, items, i)) return true;
                return false;
            case BoundFilter.Not not: return !EvaluateItem(not.Item, items, i);
            default: return false;
        }
    }

    private static object? ValueAt(NestedNode part, int entry) =>
        part.Leaf is { } leaf ? leaf.Get(entry - part.Base) : part.IsNull(entry) ? null : Present;

    /// <summary>An integer or date (as stored) against the leaf's operand; null when the leaf compares otherwise.</summary>
    private static bool? LongLeaf(BoundFilter.Leaf leaf, long value) => leaf.Op switch
    {
        "in" when leaf.Keys!.Longs is { } keys => keys.Contains(value),
        "eq" when leaf.Value is long x => value == x,
        "ne" when leaf.Value is long x => value != x,
        "gt" when leaf.Value is long x => value > x,
        "gte" when leaf.Value is long x => value >= x,
        "lt" when leaf.Value is long x => value < x,
        "lte" when leaf.Value is long x => value <= x,
        _ => null,
    };

    private static bool EvaluateLeaf(BoundFilter.Leaf leaf, object? value)
    {
        if (leaf.Op == "isNull") return (value is null) == (bool)leaf.Value!;
        if (value is null) return false; // comparisons with null are false
        switch (leaf.Op)
        {
            case "contains": return ((string)value).Contains((string)leaf.Value!, StringComparison.Ordinal);
            case "icontains": return ((string)value).Contains((string)leaf.Value!, StringComparison.OrdinalIgnoreCase);
            case "startsWith": return ((string)value).StartsWith((string)leaf.Value!, StringComparison.Ordinal);
        }
        var key = Values.ToKey(leaf.Type, value);
        return leaf.Op switch
        {
            "eq" => Values.Compare(key, leaf.Value!) == 0,
            "ne" => Values.Compare(key, leaf.Value!) != 0,
            "in" => leaf.Keys!.Contains(key),
            "gt" => Values.Compare(key, leaf.Value!) > 0,
            "gte" => Values.Compare(key, leaf.Value!) >= 0,
            "lt" => Values.Compare(key, leaf.Value!) < 0,
            "lte" => Values.Compare(key, leaf.Value!) <= 0,
            _ => false,
        };
    }

    /// <summary>
    /// Whether the rows sorted indexes return for this filter are exactly its matches, so Count can take their number
    /// without checking rows: one condition, or range conditions on one column, answered by the same key comparison rows
    /// are checked with. Prefixes and text search are answered with a superset; NaN compares unlike other values.
    /// </summary>
    public static bool AnsweredExactly(BoundFilter node)
    {
        BoundFilter.Leaf[] leaves = node switch
        {
            BoundFilter.Leaf leaf => [leaf],
            BoundFilter.And a when a.Items.All(i => i is BoundFilter.Leaf) => a.Items.Cast<BoundFilter.Leaf>().ToArray(),
            _ => [],
        };
        if (leaves.Length == 0 || leaves.Any(l => l.Op is not ("eq" or "in" or "isNull" or "gt" or "gte" or "lt" or "lte") || !IsOrdered(l.Type) || HasNaN(l))) return false;
        return leaves.Length == 1 || leaves.All(l => l.Op is "gt" or "gte" or "lt" or "lte" && l.Col == leaves[0].Col);
    }

    private static bool IsOrdered(JazminType type) =>
        type is JazminType.Bool or JazminType.Int or JazminType.Float or JazminType.Decimal or JazminType.String or JazminType.DateTime;

    private static bool HasNaN(BoundFilter.Leaf leaf) =>
        leaf.Value is object?[] values ? values.Any(v => v is not null && Values.IsNaN(v)) : leaf.Value is not null && Values.IsNaN(leaf.Value);

    /// <summary>
    /// Uses indexes to compute a sorted superset of matching row ids, or null when indexes cannot narrow the search (the
    /// caller must scan).
    /// </summary>
    public static long[]? Candidates(BoundFilter node, IIndexProvider indexes) => IndexPlan(node, indexes)?.Rows();

    /// <summary>
    /// How indexes can narrow a filter: (Cost, Rows), where Cost is the bytes of index data the lookups still have to
    /// read (estimated from index directories: nothing is read yet) and Rows returns a sorted superset of the matching
    /// row ids; or null when indexes cannot narrow it. Within an AND, range conditions on one column become one bounded
    /// lookup, lookups are taken cheapest first, and those that would push the cost over <paramref name="budget"/>
    /// bytes are left out (the filter is still checked on every row read).
    /// </summary>
    public static (long Cost, Func<long[]> Rows)? IndexPlan(BoundFilter node, IIndexProvider indexes, long budget = long.MaxValue)
    {
        switch (node)
        {
            case BoundFilter.And a:
            {
                var parts = new List<(long Cost, Func<long[]> Rows)>();
                var ranges = new Dictionary<string, IndexLookup.Range>(StringComparer.Ordinal); // column -> merged range lookup
                foreach (var item in a.Items)
                {
                    if (item is BoundFilter.Leaf { Op: "gt" or "gte" or "lt" or "lte" } leaf && !Values.IsNaN(leaf.Value!))
                        ranges[leaf.Name] = MergeRange(ranges.GetValueOrDefault(leaf.Name), leaf);
                    else if (IndexPlan(item, indexes, budget) is { } part) parts.Add(part);
                }
                foreach (var (name, range) in ranges)
                    if (LookupPlan(name, "sorted", range, indexes, budget) is { } part) parts.Add(part);
                var chosen = new List<Func<long[]>>();
                long cost = 0;
                foreach (var part in parts.OrderBy(p => p.Cost))
                {
                    if (cost + part.Cost > budget) break;
                    chosen.Add(part.Rows);
                    cost += part.Cost;
                }
                if (chosen.Count == 0) return null;
                return (cost, () =>
                {
                    var result = chosen[0]();
                    for (var i = 1; i < chosen.Count && result.Length > 0; i++) result = RowSet.Intersect(result, chosen[i]());
                    return result;
                });
            }
            case BoundFilter.Or o:
            {
                var parts = new List<Func<long[]>>();
                long cost = 0;
                foreach (var item in o.Items)
                {
                    if (IndexPlan(item, indexes, budget) is not { } part) return null; // a branch no index narrows: every row may match
                    parts.Add(part.Rows);
                    cost += part.Cost;
                }
                return cost > budget ? null : (cost, () => RowSet.Union(parts.Select(p => p()).ToList()));
            }
            case BoundFilter.Leaf leaf:
                return LeafLookup(leaf) is { } lookup ? LookupPlan(leaf.Name, lookup.Kind, lookup.Lookup, indexes, budget) : null;
            default:
                return null;
        }
    }

    /// <summary>The index lookup a condition can use, or null ('ne' cannot be answered efficiently from an index).</summary>
    private static (string Kind, IndexLookup Lookup)? LeafLookup(BoundFilter.Leaf leaf) => leaf.Op switch
    {
        "contains" or "icontains" => ("trigram", new IndexLookup.Contains((string)leaf.Value!, leaf.Op == "icontains")),
        "eq" => ("sorted", new IndexLookup.Eq(leaf.Value!)),
        "in" => ("sorted", new IndexLookup.In(((object?[])leaf.Value!).Where(v => v is not null).Select(v => v!).ToArray())),
        "startsWith" => ("sorted", new IndexLookup.Prefix((string)leaf.Value!)),
        "isNull" when (bool)leaf.Value! => ("sorted", new IndexLookup.Nulls()),
        "gt" or "gte" => ("sorted", new IndexLookup.Range(leaf.Value, leaf.Op == "gte", null, false)),
        "lt" or "lte" => ("sorted", new IndexLookup.Range(null, false, leaf.Value, leaf.Op == "lte")),
        _ => null,
    };

    private static (long Cost, Func<long[]> Rows)? LookupPlan(string column, string kind, IndexLookup lookup, IIndexProvider indexes, long budget)
    {
        var index = indexes.Index(column, kind);
        return index?.Cost(lookup) is { } cost && cost <= budget ? (cost, () => index.Rows(lookup)) : null;
    }

    /// <summary>Range conditions of an AND on one column, merged into one bounded lookup (the tightest bounds win).</summary>
    private static IndexLookup.Range MergeRange(IndexLookup.Range? range, BoundFilter.Leaf leaf)
    {
        var merged = range ?? new IndexLookup.Range(null, false, null, false);
        var value = leaf.Value!;
        if (leaf.Op is "gt" or "gte")
        {
            var inclusive = leaf.Op == "gte";
            if (merged.Low is null || Values.Compare(value, merged.Low) > 0 || (Values.Compare(value, merged.Low) == 0 && !inclusive))
                merged = merged with { Low = value, LowInclusive = inclusive };
        }
        else
        {
            var inclusive = leaf.Op == "lte";
            if (merged.High is null || Values.Compare(value, merged.High) < 0 || (Values.Compare(value, merged.High) == 0 && !inclusive))
                merged = merged with { High = value, HighInclusive = inclusive };
        }
        return merged;
    }

    /// <summary>False when chunk statistics prove no row in the chunk can match.</summary>
    public static bool MayMatch(BoundFilter node, ColumnStats?[] stats, int rowCount) => MayMatch(node, c => stats[c], rowCount);

    /// <summary>
    /// MayMatch with a chunk's statistics given by column position (null: unknown), and with <paramref name="leafOf"/>, a
    /// nested column's leaves' statistics by column position and path (field positions, as "1,0").
    /// </summary>
    public static bool MayMatch(BoundFilter node, Func<int, ColumnStats?> statOf, int rowCount, Func<int, string, ColumnStats?>? leafOf = null) => node switch
    {
        BoundFilter.And a => a.Items.All(i => MayMatch(i, statOf, rowCount, leafOf)),
        BoundFilter.Or o => o.Items.Any(i => MayMatch(i, statOf, rowCount, leafOf)),
        BoundFilter.Leaf l => LeafMayMatch(l, statOf(l.Col), rowCount),
        // A chunk whose lists or objects are all null matches no any, all or match on them.
        BoundFilter.Nested n => (statOf(n.Col) is not { } s || s.Nulls < rowCount) && (leafOf is null || NestedMayMatch(n, path => leafOf(n.Col, path), "")),
        _ => true,
    };

    /// <summary>
    /// Whether a nested column's condition may match in a chunk, from the statistics of the leaves its filter reads (spec
    /// 6.4): `any` and `match` need an item or object that may match each condition. `all` may always match (an empty
    /// list does).
    /// </summary>
    private static bool NestedMayMatch(BoundFilter.Nested n, Func<string, ColumnStats?> leafOf, string path) =>
        n.Op == "all" || PartMayMatch(n.Inner, n.Part, leafOf, path);

    /// <summary>A filter of <paramref name="part"/> (its fields by position, or the item itself at 0) at <paramref name="path"/>.</summary>
    private static bool PartMayMatch(BoundFilter f, JazminColumn part, Func<string, ColumnStats?> leafOf, string path) => f switch
    {
        BoundFilter.And a => a.Items.All(i => PartMayMatch(i, part, leafOf, path)),
        BoundFilter.Or o => o.Items.Any(i => PartMayMatch(i, part, leafOf, path)),
        BoundFilter.Leaf l => leafOf(Step(part, l.Col, path)) is not { } stat || LeafMayMatch(l, stat, stat.Count),
        BoundFilter.Nested inner => NestedMayMatch(inner, leafOf, Step(part, inner.Col, path)),
        _ => true,
    };

    /// <summary>The path of an object's field (one step more), or of a list's item (the same path).</summary>
    private static string Step(JazminColumn part, int col, string path) =>
        part.Type != JazminType.Object ? path : path.Length == 0 ? col.ToString(CultureInfo.InvariantCulture) : string.Concat(path, ",", col.ToString(CultureInfo.InvariantCulture));

    private static bool LeafMayMatch(BoundFilter.Leaf leaf, ColumnStats? stat, long rowCount)
    {
        if (stat is null) return true;
        if (leaf.Op == "isNull") return (bool)leaf.Value! ? stat.Nulls > 0 : stat.Nulls < rowCount;
        if (stat.Nulls == rowCount) return false;
        var (min, max) = (stat.Min, stat.Max);
        bool InRange(object v) => (min is null || Values.Compare(v, min) >= 0) && (max is null || Values.Compare(v, max) <= 0);
        return leaf.Op switch
        {
            "eq" => InRange(leaf.Value!),
            "in" => leaf.Keys!.AnyBetween(min, max),
            "gt" => max is null || Values.Compare(max, leaf.Value!) > 0,
            "gte" => max is null || Values.Compare(max, leaf.Value!) >= 0,
            "lt" => min is null || Values.Compare(min, leaf.Value!) < 0,
            "lte" => min is null || Values.Compare(min, leaf.Value!) <= 0,
            _ => true,
        };
    }

    /// <summary>
    /// True when chunk statistics prove that every row of the chunk matches (the counterpart of MayMatch): such a
    /// chunk can be counted by its row count, for example to skip it whole for an offset.
    /// </summary>
    public static bool MustMatch(BoundFilter node, Func<int, ColumnStats?> statOf, int rowCount) => node switch
    {
        BoundFilter.And a => a.Items.All(i => MustMatch(i, statOf, rowCount)),
        BoundFilter.Or o => o.Items.Any(i => MustMatch(i, statOf, rowCount)),
        BoundFilter.Not n => !MayMatch(n.Item, statOf, rowCount),
        BoundFilter.Leaf l => LeafMustMatch(l, statOf(l.Col), rowCount),
        _ => false,
    };

    private static bool LeafMustMatch(BoundFilter.Leaf leaf, ColumnStats? stat, int rowCount)
    {
        // Float statistics leave NaN values out, so they cannot prove that every row matches.
        if (stat is null || leaf.Type == JazminType.Float) return false;
        if (leaf.Op == "isNull") return (bool)leaf.Value! ? stat.Nulls == rowCount : stat.Nulls == 0;
        // A string minimum may be a prefix of the real one: still a lower bound. A maximum is exact or absent.
        var (min, max) = (stat.Min, stat.Max);
        if (stat.Nulls != 0 || min is null || max is null) return false;
        return leaf.Op switch
        {
            "eq" => Values.Compare(min, leaf.Value!) == 0 && Values.Compare(max, leaf.Value!) == 0,
            "ne" => Values.Compare(max, leaf.Value!) < 0 || Values.Compare(min, leaf.Value!) > 0,
            "in" => Values.Compare(min, max) == 0 && leaf.Keys!.Contains(min),
            "gt" => Values.Compare(min, leaf.Value!) > 0,
            "gte" => Values.Compare(min, leaf.Value!) >= 0,
            "lt" => Values.Compare(max, leaf.Value!) < 0,
            "lte" => Values.Compare(max, leaf.Value!) <= 0,
            _ => false, // string searches: statistics cannot prove a match
        };
    }
}

internal interface IIndexProvider
{
    /// <summary>The column's index of this kind ("sorted" or "trigram"), or null when there is none this reader may use.</summary>
    IIndex? Index(string column, string kind);
}
