using System.Globalization;
using Jazmin.Format;

namespace Jazmin.Query;

/// <summary>A filter validated against a schema, with operands converted to key form.</summary>
internal abstract record BoundFilter
{
    public sealed record And(BoundFilter[] Items) : BoundFilter;

    public sealed record Or(BoundFilter[] Items) : BoundFilter;

    public sealed record Not(BoundFilter Item) : BoundFilter;

    public sealed record Leaf(int Col, string Name, JazminType Type, string Op, object? Value) : BoundFilter;

    private static readonly HashSet<string> RangeOps = new() { "gt", "gte", "lt", "lte" };
    private static readonly HashSet<string> StringOps = new() { "contains", "icontains", "startsWith" };
    private static readonly HashSet<string> AllOps = new(RangeOps.Concat(StringOps)) { "eq", "ne", "in", "isNull" };

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

        if (c.Op == "isNull")
            return c.Value is bool b ? Make("isNull", b) : throw JazminFilter.Invalid("'isNull' needs true or false");
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
            return Make("in", list.Cast<object?>().Select(v => Coerce(column, v)).ToArray());
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

/// <summary>Evaluation, index planning and chunk pruning for bound filters.</summary>
internal static class FilterEngine
{
    public static bool Evaluate(BoundFilter node, object?[] row) => node switch
    {
        BoundFilter.And a => a.Items.All(i => Evaluate(i, row)),
        BoundFilter.Or o => o.Items.Any(i => Evaluate(i, row)),
        BoundFilter.Not n => !Evaluate(n.Item, row),
        BoundFilter.Leaf l => EvaluateLeaf(l, row[l.Col]),
        _ => false,
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
            "in" => ((object?[])leaf.Value!).Any(v => v is not null && Values.Compare(key, v) == 0),
            "gt" => Values.Compare(key, leaf.Value!) > 0,
            "gte" => Values.Compare(key, leaf.Value!) >= 0,
            "lt" => Values.Compare(key, leaf.Value!) < 0,
            "lte" => Values.Compare(key, leaf.Value!) <= 0,
            _ => false,
        };
    }

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

    /// <summary>MayMatch with a chunk's statistics given by column position (null: unknown).</summary>
    public static bool MayMatch(BoundFilter node, Func<int, ColumnStats?> statOf, int rowCount) => node switch
    {
        BoundFilter.And a => a.Items.All(i => MayMatch(i, statOf, rowCount)),
        BoundFilter.Or o => o.Items.Any(i => MayMatch(i, statOf, rowCount)),
        BoundFilter.Leaf l => LeafMayMatch(l, statOf(l.Col), rowCount),
        _ => true,
    };

    private static bool LeafMayMatch(BoundFilter.Leaf leaf, ColumnStats? stat, int rowCount)
    {
        if (stat is null) return true;
        if (leaf.Op == "isNull") return (bool)leaf.Value! ? stat.Nulls > 0 : stat.Nulls < rowCount;
        if (stat.Nulls == rowCount) return false;
        var (min, max) = (stat.Min, stat.Max);
        bool InRange(object v) => (min is null || Values.Compare(v, min) >= 0) && (max is null || Values.Compare(v, max) <= 0);
        return leaf.Op switch
        {
            "eq" => InRange(leaf.Value!),
            "in" => ((object?[])leaf.Value!).Any(v => v is not null && InRange(v)),
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
            "in" => Values.Compare(min, max) == 0 && ((object?[])leaf.Value!).Any(v => v is not null && Values.Compare(min, v) == 0),
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
