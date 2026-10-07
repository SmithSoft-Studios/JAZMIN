using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using Jazmin.Query;

namespace Jazmin.Formats;

/// <summary>
/// An export shape (docs/design/export-shapes.md): a JSON template that turns rows into nested JSON or XML,
/// for example one entry per client (its details taken once) with its transactions and totals. Every list is
/// a query on the file, so only the columns the shape uses are decoded, and filters use indexes and statistics.
/// The same shape gives the same output in the JavaScript library.
/// </summary>
public sealed class JazminShape
{
    private readonly JsonObject _shape;

    private JazminShape(JsonObject shape) => _shape = shape;

    /// <summary>Parses a shape from JSON text.</summary>
    public static JazminShape Parse(string json) =>
        JsonNode.Parse(json) is JsonObject shape ? new JazminShape(shape) : throw new JazminValidationException("Shape: must be an object");

    /// <summary>Uses a shape given as a JSON object (copied).</summary>
    public static JazminShape FromJson(JsonObject shape) => new((JsonObject)shape.DeepClone());

    /// <summary>Checks the shape against the columns this reader can see; throws naming the first mistake.</summary>
    public void Validate(JazminReader reader) => Compile(reader);

    /// <summary>The shape's output for these rows as JSON text.</summary>
    public string ToJson(JazminReader reader, JazminFilter? filter = null, bool indented = false)
    {
        using var stream = new MemoryStream();
        WriteJson(reader, stream, filter, indented);
        return Encoding.UTF8.GetString(stream.GetBuffer(), 0, (int)stream.Length);
    }

    /// <summary>Streams the shape's output as JSON (UTF-8).</summary>
    public void WriteJson(JazminReader reader, Stream output, JazminFilter? filter = null, bool indented = false)
    {
        var root = Compile(reader);
        using var sink = new JsonSink(output, indented);
        new Engine(reader, sink, BatchRows).Run(root, filter);
    }

    /// <summary>The shape's output for these rows as XML text.</summary>
    public string ToXml(JazminReader reader, JazminFilter? filter = null, string root = "export")
    {
        using var writer = new Utf8StringWriter();
        WriteXml(reader, writer, filter, root);
        return writer.ToString();
    }

    /// <summary>Streams the shape's output as XML: object members are elements, list items use <c>$xmlItem</c>.</summary>
    public void WriteXml(JazminReader reader, TextWriter output, JazminFilter? filter = null, string root = "export")
    {
        if (!XmlName.IsMatch(root)) throw new JazminValidationException($"'{root}' is not a valid XML element name");
        var compiled = Compile(reader);
        using var sink = new XmlSink(output, root);
        new Engine(reader, sink, BatchRows).Run(compiled, filter);
    }

    /// <summary>A JSON Schema (draft 2020-12) describing the shape's JSON output for this reader.</summary>
    public JsonObject ToJsonSchema(JazminReader reader)
    {
        var schema = Schema(Compile(reader), mayBeEmpty: true);
        var result = new JsonObject { ["$schema"] = "https://json-schema.org/draft/2020-12/schema" };
        foreach (var (key, value) in schema) result[key] = value?.DeepClone();
        return result;
    }

    // ---- compiled templates ------------------------------------------------------------------------

    private abstract class Node;

    private sealed class Col(JazminColumn column) : Node
    {
        public JazminColumn Column { get; } = column;
    }

    private sealed class Lit(JsonNode? value) : Node
    {
        public JsonNode? Value { get; } = value;
    }

    private sealed class Meta(string key) : Node
    {
        public string Key { get; } = key;
    }

    private sealed class Obj(List<(string Name, Node Node)> members) : Node
    {
        public List<(string Name, Node Node)> Members { get; } = members;
    }

    private sealed class Agg(string op, JazminColumn? column) : Node
    {
        public string Op { get; } = op;
        public JazminColumn? Column { get; } = column;
    }

    private sealed class ListNode : Node
    {
        public required Node Item { get; init; }
        public JazminFilter? Filter { get; init; }
        public JazminColumn[]? GroupBy { get; init; }
        public required List<(JazminColumn Column, bool Desc)> Sort { get; init; }
        public long Limit { get; init; } = long.MaxValue;
        public required string XmlItem { get; init; }
    }

    private static readonly HashSet<JazminType> Ordered = [JazminType.Bool, JazminType.Int, JazminType.Float, JazminType.String, JazminType.DateTime, JazminType.Decimal];
    private static readonly HashSet<JazminType> Groupable = Ordered;
    private static readonly HashSet<JazminType> Summable = [JazminType.Int, JazminType.Float, JazminType.Decimal];
    private static readonly HashSet<string> ListKeys = ["$rows", "$filter", "$groupBy", "$sort", "$limit", "$xmlItem"];
    private static readonly Regex XmlName = new(@"^[A-Za-z_][A-Za-z0-9_.-]*$", RegexOptions.Compiled);

    private static JazminValidationException Fail(string path, string message) =>
        new($"Shape{(path.Length > 0 ? $" at {path}" : "")}: {message}");

    private static string Child(string path, string name) => path.Length > 0 ? $"{path}.{name}" : name;

    private static string TypeName(JazminType type) => TypeNames.ToName(type);

    private Node Compile(JazminReader reader)
    {
        var columns = reader.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);

        JazminColumn Column(JsonNode? name, string path, HashSet<JazminType>? allowed, string what)
        {
            if (name is not JsonValue v || !v.TryGetValue<string>(out var text)) throw Fail(path, $"{what} must name a column");
            if (!columns.TryGetValue(text, out var column)) throw Fail(path, $"unknown or hidden column '{text}'");
            if (allowed is not null && !allowed.Contains(column.Type)) throw Fail(path, $"{what} is not supported on {TypeName(column.Type)} column '{text}'");
            return column;
        }

        JazminFilter? FilterOf(JsonNode? filter, string path)
        {
            if (filter is null) return null;
            try
            {
                var parsed = JazminFilter.Parse(filter.ToJsonString());
                reader.Explain(parsed); // validates columns, operators and operands
                return parsed;
            }
            catch (JazminException e)
            {
                throw Fail(path, e.Message);
            }
        }

        Node Node(JsonNode? value, string path, bool inRow)
        {
            switch (value)
            {
                case null: return new Lit(null);
                case JsonValue v when v.GetValueKind() == JsonValueKind.String: return new Col(Column(v, path, null, "a value"));
                case JsonValue v: return new Lit(v.DeepClone());
                case JsonArray: throw Fail(path, "arrays are not templates; use { \"$rows\": ... } for a list");
            }
            var obj = (JsonObject)value;
            var keys = obj.Select(p => p.Key).ToList();
            var special = keys.Where(k => k.StartsWith('$')).ToList();
            if (special.Count == 0) return new Obj(obj.Select(p => (p.Key, Node(p.Value, Child(path, p.Key), inRow))).ToList());
            if (special.Count != keys.Count) throw Fail(path, $"'$' members cannot be mixed with other members ({string.Join(", ", keys)})");
            if (obj.ContainsKey("$rows"))
            {
                if (inRow) throw Fail(path, "a list inside a row list needs $groupBy on the outer list");
                foreach (var k in keys)
                    if (!ListKeys.Contains(k)) throw Fail(path, $"unknown list option '{k}'");
                JazminColumn[]? groupBy = null;
                if (obj.TryGetPropertyValue("$groupBy", out var g))
                {
                    var names = g is JsonArray a ? a.ToList() : [g];
                    groupBy = names.Select((n, i) => Column(n, Child(path, $"$groupBy[{i}]"), Groupable, "grouping")).ToArray();
                    if (groupBy.Length == 0) throw Fail(path, "$groupBy needs at least one column");
                }
                var sort = new List<(JazminColumn, bool)>();
                if (obj.TryGetPropertyValue("$sort", out var s))
                {
                    if (s is not JsonArray entries) throw Fail(Child(path, "$sort"), "must be an array of column names");
                    for (var i = 0; i < entries.Count; i++)
                    {
                        var text = entries[i] is JsonValue ev && ev.TryGetValue<string>(out var t) ? t : null;
                        var desc = text?.StartsWith('-') == true;
                        sort.Add((Column(desc ? JsonValue.Create(text![1..]) : entries[i], Child(path, $"$sort[{i}]"), Groupable, "sorting"), desc));
                    }
                }
                var limit = long.MaxValue;
                if (obj.TryGetPropertyValue("$limit", out var l))
                {
                    if (l is not JsonValue lv || lv.GetValueKind() != JsonValueKind.Number || !lv.TryGetValue<long>(out limit) || limit < 0)
                        throw Fail(Child(path, "$limit"), "must be a non-negative integer");
                }
                var xmlItem = "item";
                if (obj.TryGetPropertyValue("$xmlItem", out var x))
                {
                    if (x is not JsonValue xv || !xv.TryGetValue<string>(out var name) || !XmlName.IsMatch(name)) throw Fail(Child(path, "$xmlItem"), "must be a valid XML element name");
                    xmlItem = name;
                }
                return new ListNode
                {
                    Filter = FilterOf(obj["$filter"], Child(path, "$filter")),
                    GroupBy = groupBy,
                    Sort = sort,
                    Limit = limit,
                    XmlItem = xmlItem,
                    Item = Node(obj["$rows"], $"{(path.Length > 0 ? path : "shape")}[]", groupBy is null),
                };
            }
            if (keys.Count != 1) throw Fail(path, $"expected one '$' member, found {string.Join(", ", keys)}");
            var key = keys[0];
            var arg = obj[key];
            switch (key)
            {
                case "$value":
                    return new Lit(arg?.DeepClone());
                case "$meta":
                    if (arg is not JsonValue mv || !mv.TryGetValue<string>(out var metaKey)) throw Fail(path, "$meta must name a metadata member");
                    return new Meta(metaKey);
                case "$count":
                    if (inRow) throw Fail(path, "aggregates need a set of rows (use $groupBy on the list)");
                    if (arg is not JsonValue cv || cv.GetValueKind() != JsonValueKind.True) throw Fail(path, "$count takes true");
                    return new Agg("count", null);
                case "$sum" or "$min" or "$max":
                    if (inRow) throw Fail(path, "aggregates need a set of rows (use $groupBy on the list)");
                    return new Agg(key[1..], Column(arg, Child(path, key), key == "$sum" ? Summable : Ordered, key));
                default:
                    throw Fail(path, $"unknown operator '{key}'");
            }
        }

        return Node(_shape, "", inRow: false);
    }

    // ---- needs ---------------------------------------------------------------------------------------

    /// <summary>Columns (first values) and aggregates a set-context template uses directly (not inside its lists).</summary>
    private static (Dictionary<string, JazminColumn> Columns, List<Agg> Aggs) SetNeeds(Node node)
    {
        var columns = new Dictionary<string, JazminColumn>(StringComparer.Ordinal);
        var aggs = new List<Agg>();
        void Walk(Node n)
        {
            switch (n)
            {
                case Col c: columns[c.Column.Name] = c.Column; break;
                case Agg a: aggs.Add(a); break;
                case Obj o: foreach (var (_, m) in o.Members) Walk(m); break;
            }
        }
        Walk(node);
        return (columns, aggs);
    }

    private static void RowColumns(Node node, HashSet<string> names)
    {
        if (node is Col c) names.Add(c.Column.Name);
        else if (node is Obj o) foreach (var (_, m) in o.Members) RowColumns(m, names);
    }

    // ---- values --------------------------------------------------------------------------------------

    /// <summary>Orders two non-null values of one column type (decimals by value).</summary>
    private static int CompareValues(object a, object b, JazminType type) => (a, b) switch
    {
        (string x, string y) when type == JazminType.Decimal => Format.Decimals.CompareCanonical(x, y),
        (string x, string y) => string.CompareOrdinal(x, y),
        (long x, long y) => x.CompareTo(y),
        (double x, double y) => x.CompareTo(y),
        (DateTime x, DateTime y) => x.CompareTo(y),
        (bool x, bool y) => x.CompareTo(y),
        _ => throw new InvalidOperationException($"Cannot compare {a.GetType().Name} with {b.GetType().Name}"),
    };

    /// <summary>Sort comparison with nulls first (spec 5.3) and descending columns.</summary>
    private sealed class SortComparer(List<(JazminColumn Column, bool Desc)> sort) : IComparer<IReadOnlyDictionary<string, object?>>
    {
        public int Compare(IReadOnlyDictionary<string, object?>? a, IReadOnlyDictionary<string, object?>? b)
        {
            foreach (var (column, desc) in sort)
            {
                a!.TryGetValue(column.Name, out var x);
                b!.TryGetValue(column.Name, out var y);
                var c = x is null ? (y is null ? 0 : -1) : y is null ? 1 : CompareValues(x, y, column.Type);
                if (c != 0) return desc ? -c : c;
            }
            return 0;
        }
    }

    /// <summary>Running aggregate of one column (sum, min, max) or of rows (count).</summary>
    private sealed class Accumulator(Agg agg)
    {
        private long _count;
        private object? _value;
        private BigInteger _big;
        private bool _any;
        private int _scale; // decimal sums: digits after the point

        public void Add(IReadOnlyDictionary<string, object?> row)
        {
            if (agg.Op == "count")
            {
                _count++;
                return;
            }
            row.TryGetValue(agg.Column!.Name, out var v);
            if (v is null || v is double.NaN) return;
            if (agg.Op == "sum")
            {
                _any = true;
                switch (agg.Column.Type)
                {
                    case JazminType.Float: _value = (_value is double d ? d : 0) + (double)v; break;
                    case JazminType.Int: _big += (long)v; break;
                    default:
                        var text = (string)v;
                        var negative = text.StartsWith('-');
                        var parts = text.TrimStart('-').Split('.');
                        var fraction = parts.Length > 1 ? parts[1] : "";
                        var digits = BigInteger.Parse(parts[0] + fraction, CultureInfo.InvariantCulture);
                        if (negative) digits = -digits;
                        if (fraction.Length > _scale)
                        {
                            _big *= BigInteger.Pow(10, fraction.Length - _scale);
                            _scale = fraction.Length;
                        }
                        _big += digits * BigInteger.Pow(10, _scale - fraction.Length);
                        break;
                }
            }
            else if (_value is null || (agg.Op == "min" ? CompareValues(v, _value, agg.Column.Type) < 0 : CompareValues(v, _value, agg.Column.Type) > 0))
            {
                _value = v;
            }
        }

        public object? Result()
        {
            if (agg.Op == "count") return _count;
            if (agg.Op != "sum") return _value;
            if (!_any) return null;
            if (agg.Column!.Type == JazminType.Float) return _value;
            if (agg.Column.Type == JazminType.Int) return _big >= long.MinValue && _big <= long.MaxValue ? (long)_big : _big;
            var digits = BigInteger.Abs(_big).ToString(CultureInfo.InvariantCulture).PadLeft(_scale + 1, '0');
            var number = _scale > 0 ? $"{digits[..^_scale]}.{digits[^_scale..]}" : digits;
            return _big.Sign < 0 ? "-" + number : number;
        }
    }

    private static string KeyOf(IEnumerable<object?> values) => string.Join('\u0001', values.Select(v => v switch
    {
        null => "\u0000",
        DateTime d => "d" + d.Ticks.ToString(CultureInfo.InvariantCulture),
        double d => "number:" + (d == 0 ? "0" : d.ToString("R", CultureInfo.InvariantCulture)),
        long l => "number:" + l.ToString(CultureInfo.InvariantCulture),
        bool b => b ? "boolean:true" : "boolean:false",
        _ => "string:" + v,
    }));

    private static JazminFilter? And(JazminFilter? a, JazminFilter? b) => a is null ? b : b is null ? a : JazminFilter.And(a, b);

    // ---- evaluation ----------------------------------------------------------------------------------

    /// <summary>Rows held at a time when grouping an unsorted file with nested lists (tests use smaller batches).</summary>
    internal int BatchRows { get; set; } = 100_000;

    private static bool HasList(Node node) => node switch
    {
        ListNode => true,
        Obj o => o.Members.Any(m => HasList(m.Node)),
        _ => false,
    };

    /// <summary>Every column a template reads, including its lists' filters, groups and sorts (at any depth).</summary>
    private static void DeepColumns(Node node, HashSet<string> names)
    {
        switch (node)
        {
            case Col c: names.Add(c.Column.Name); break;
            case Agg { Column: { } column }: names.Add(column.Name); break;
            case Obj o: foreach (var (_, m) in o.Members) DeepColumns(m, names); break;
            case ListNode list:
                if (list.Filter is not null) FilterColumns(list.Filter, names);
                foreach (var c in list.GroupBy ?? []) names.Add(c.Name);
                foreach (var (c, _) in list.Sort) names.Add(c.Name);
                DeepColumns(list.Item, names);
                break;
        }
    }

    private static void FilterColumns(JazminFilter filter, HashSet<string> names)
    {
        switch (filter)
        {
            case JazminFilter.Condition c: names.Add(c.Column); break;
            case JazminFilter.Group g: foreach (var item in g.Items) FilterColumns(item, names); break;
            case JazminFilter.Negation n: FilterColumns(n.Item, names); break;
        }
    }

    /// <summary>
    /// Rows come from the file (a query: indexes, statistics, only the columns asked for) or, inside a group with
    /// nested lists, from that group's rows held in memory.
    /// </summary>
    private interface ISource
    {
        bool InMemory { get; }
        IEnumerable<IReadOnlyDictionary<string, object?>> Find(JazminFilter? filter, IReadOnlyCollection<string> names, long limit = long.MaxValue);
    }

    private sealed class FileSource(JazminReader reader) : ISource
    {
        public bool InMemory => false;

        public IEnumerable<IReadOnlyDictionary<string, object?>> Find(JazminFilter? filter, IReadOnlyCollection<string> names, long limit = long.MaxValue) =>
            reader.Find(filter, new JazminQueryOptions
            {
                Select = names.Count > 0 ? names.ToList() : [reader.Columns[0].Name],
                Limit = limit == long.MaxValue ? null : limit,
            });
    }

    /// <summary>The columns a group's held rows keep, in order, with their filters bound to that order.</summary>
    private sealed class Layout(JazminColumn[] columns)
    {
        public JazminColumn[] Columns { get; } = columns;
        public Dictionary<string, int> Index { get; } = columns.Select((c, i) => (c.Name, i)).ToDictionary(x => x.Name, x => x.i, StringComparer.Ordinal);
        public Dictionary<JazminFilter, BoundFilter?> Bound { get; } = new(ReferenceEqualityComparer.Instance);

        /// <summary>Copies the values a group needs: a held row must not keep its whole decoded chunk alive.</summary>
        public CompactRow Copy(IReadOnlyDictionary<string, object?> row)
        {
            var values = new object?[Columns.Length];
            for (var i = 0; i < values.Length; i++) values[i] = row[Columns[i].Name];
            return new CompactRow(this, values);
        }
    }

    /// <summary>A held row: just the values of its layout's columns.</summary>
    private sealed class CompactRow(Layout layout, object?[] values) : IReadOnlyDictionary<string, object?>
    {
        public object?[] Raw => values;
        public object? this[string key] => values[layout.Index[key]];
        public IEnumerable<string> Keys => layout.Columns.Select(c => c.Name);
        public IEnumerable<object?> Values => values;
        public int Count => values.Length;
        public bool ContainsKey(string key) => layout.Index.ContainsKey(key);

        public bool TryGetValue(string key, out object? value)
        {
            var found = layout.Index.TryGetValue(key, out var i);
            value = found ? values[i] : null;
            return found;
        }

        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() =>
            layout.Columns.Select((c, i) => KeyValuePair.Create(c.Name, values[i])).GetEnumerator();

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class MemorySource(List<CompactRow> rows, Layout layout) : ISource
    {
        public bool InMemory => true;
        public Layout Layout => layout;

        public IEnumerable<IReadOnlyDictionary<string, object?>> Find(JazminFilter? filter, IReadOnlyCollection<string> names, long limit = long.MaxValue)
        {
            BoundFilter? test = null;
            if (filter is not null && !layout.Bound.TryGetValue(filter, out test))
                layout.Bound[filter] = test = BoundFilter.Bind(filter, layout.Columns);
            long n = 0;
            foreach (var row in rows)
            {
                if (n >= limit) yield break;
                if (test is not null && !FilterEngine.Evaluate(test, row.Raw)) continue;
                n++;
                yield return row;
            }
        }
    }

    private sealed record Context(ISource? Source, JazminFilter? Filter, IReadOnlyDictionary<string, object?> Values, IReadOnlyDictionary<Agg, object?>? Aggs);

    private static readonly IReadOnlyDictionary<string, object?> NoValues = new Dictionary<string, object?>();

    private sealed class Engine(JazminReader reader, ISink sink, int batchRows)
    {
        private readonly JsonObject _metadata = reader.Metadata;
        private readonly IReadOnlyList<string> _sortedBy = reader.SortedBy ?? [];

        public void Run(Node root, JazminFilter? filter)
        {
            if (filter is not null) reader.Explain(filter); // validate before writing anything
            Emit(root, ScanSet(root, new FileSource(reader), filter));
            sink.End();
        }

        /// <summary>First values and aggregates of a set, from rows (first values alone stop at the first row).</summary>
        private static (IReadOnlyDictionary<string, object?> First, Dictionary<Agg, object?> Aggs) SetValues(Node node, IEnumerable<IReadOnlyDictionary<string, object?>> rows)
        {
            var (_, aggs) = SetNeeds(node);
            var accumulators = aggs.Select(a => (a, new Accumulator(a))).ToList();
            IReadOnlyDictionary<string, object?>? first = null;
            foreach (var row in rows)
            {
                first ??= row;
                if (accumulators.Count == 0) break;
                foreach (var (_, acc) in accumulators) acc.Add(row);
            }
            return (first ?? NoValues, accumulators.ToDictionary(x => x.a, x => x.Item2.Result()));
        }

        private static Context ScanSet(Node node, ISource source, JazminFilter? filter)
        {
            var (columns, aggs) = SetNeeds(node);
            if (columns.Count == 0 && aggs.Count == 0) return new Context(source, filter, NoValues, new Dictionary<Agg, object?>());
            var names = columns.Keys.Concat(aggs.Where(a => a.Column is not null).Select(a => a.Column!.Name)).ToHashSet(StringComparer.Ordinal);
            var (first, values) = SetValues(node, source.Find(filter, names, aggs.Count > 0 ? long.MaxValue : 1));
            return new Context(source, filter, first, values);
        }

        private void Emit(Node node, Context ctx)
        {
            switch (node)
            {
                case Col c:
                    ctx.Values.TryGetValue(c.Column.Name, out var value);
                    sink.Value(c.Column.Type, value);
                    break;
                case Lit l: sink.Literal(l.Value); break;
                case Meta m: sink.Literal(_metadata.TryGetPropertyValue(m.Key, out var meta) ? meta : null); break;
                case Agg a: sink.Value(a.Op == "count" ? JazminType.Int : a.Column!.Type, ctx.Aggs![a]); break;
                case Obj o:
                    sink.StartObject();
                    foreach (var (name, member) in o.Members)
                    {
                        sink.Key(name);
                        Emit(member, ctx);
                    }
                    sink.EndObject();
                    break;
                case ListNode list:
                    sink.StartArray(list.XmlItem);
                    if (list.GroupBy is null) EmitRows(list, ctx);
                    else EmitGroups(list, ctx);
                    sink.EndArray();
                    break;
            }
            sink.FlushIfLarge();
        }

        private void EmitRows(ListNode list, Context ctx)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            RowColumns(list.Item, names);
            foreach (var (column, _) in list.Sort) names.Add(column.Name);
            var filter = And(ctx.Filter, list.Filter);
            var rows = ctx.Source!.Find(filter, names, list.Sort.Count == 0 ? list.Limit : long.MaxValue);
            if (list.Sort.Count > 0)
                rows = rows.ToList().OrderBy(r => r, new SortComparer(list.Sort)).Take((int)Math.Min(list.Limit, int.MaxValue));
            foreach (var row in rows) Emit(list.Item, new Context(null, null, row, null));
        }

        /// <summary>Emits one group: its first values and aggregates, and nested lists over its rows (held in memory).</summary>
        private void EmitGroup(ListNode list, List<CompactRow> rows, Layout layout)
        {
            var (first, aggs) = SetValues(list.Item, rows);
            Emit(list.Item, new Context(new MemorySource(rows, layout), null, first, aggs));
        }

        /// <summary>The layout of held rows: the layout of the rows already in memory, or the columns read now.</summary>
        private Layout LayoutFor(ISource source, HashSet<string> deep) =>
            source is MemorySource { } memory && memory.Layout is { } held ? held
                : new Layout(reader.Columns.Where(c => deep.Contains(c.Name)).ToArray());

        private static string KeyOfRow(ListNode list, IReadOnlyDictionary<string, object?> row) =>
            KeyOf(list.GroupBy!.Select(c => row.TryGetValue(c.Name, out var v) ? v : null));

        private sealed class Group(IReadOnlyDictionary<string, object?> first, List<(Agg Agg, Accumulator Acc)> accumulators)
        {
            public IReadOnlyDictionary<string, object?> First { get; } = first;
            public List<(Agg Agg, Accumulator Acc)> Accumulators { get; } = accumulators;
            public long Count { get; set; }
            public List<CompactRow>? Rows { get; set; }
        }

        private void EmitGroups(ListNode list, Context ctx)
        {
            var filter = And(ctx.Filter, list.Filter);
            var source = ctx.Source!;
            // Rows sorted by the group columns arrive group by group: each group is written when the next begins.
            var prefix = _sortedBy.Take(list.GroupBy!.Length).ToHashSet(StringComparer.Ordinal);
            var contiguous = !source.InMemory && list.Sort.Count == 0 && list.GroupBy.All(c => prefix.Contains(c.Name));
            long written = 0;

            if (!HasList(list.Item))
            {
                // First values and aggregates only: one pass with running totals per group, rows are not kept.
                var (columns, aggs) = SetNeeds(list.Item);
                var names = list.GroupBy.Select(c => c.Name).Concat(columns.Keys).Concat(list.Sort.Select(s => s.Column.Name))
                    .Concat(aggs.Where(a => a.Column is not null).Select(a => a.Column!.Name)).ToHashSet(StringComparer.Ordinal);
                Group Start(IReadOnlyDictionary<string, object?> row) => new(row, aggs.Select(a => (a, new Accumulator(a))).ToList());
                void Write(Group g) => Emit(list.Item, new Context(null, null, g.First, g.Accumulators.ToDictionary(x => x.Agg, x => x.Acc.Result())));
                var groups = new Dictionary<string, Group>(StringComparer.Ordinal);
                var order = new List<Group>();
                Group? current = null;
                string? currentKey = null;
                foreach (var row in source.Find(filter, names))
                {
                    var key = KeyOfRow(list, row);
                    Group group;
                    if (contiguous)
                    {
                        if (key != currentKey)
                        {
                            if (current is not null)
                            {
                                Write(current);
                                if (++written >= list.Limit) return;
                            }
                            current = Start(row);
                            currentKey = key;
                        }
                        group = current!;
                    }
                    else if (!groups.TryGetValue(key, out group!))
                    {
                        groups[key] = group = Start(row);
                        order.Add(group);
                    }
                    foreach (var (_, acc) in group.Accumulators) acc.Add(row);
                }
                if (contiguous)
                {
                    if (current is not null && written < list.Limit) Write(current);
                    return;
                }
                IEnumerable<Group> all = list.Sort.Count > 0 ? order.OrderBy(g => g.First, new SortComparer(list.Sort)) : order;
                foreach (var group in all.Take((int)Math.Min(list.Limit, int.MaxValue))) Write(group);
                return;
            }

            // Nested lists: the group's rows are needed. Read every column the item uses, at any depth.
            var deep = new HashSet<string>(list.GroupBy.Select(c => c.Name), StringComparer.Ordinal);
            DeepColumns(list.Item, deep);
            foreach (var (column, _) in list.Sort) deep.Add(column.Name);
            var layout = LayoutFor(source, deep);
            if (contiguous)
            {
                // Sorted file: one pass, holding one group's rows at a time.
                var rows = new List<CompactRow>();
                string? currentKey = null;
                foreach (var row in source.Find(filter, deep))
                {
                    var key = KeyOfRow(list, row);
                    if (key != currentKey && rows.Count > 0)
                    {
                        EmitGroup(list, rows, layout);
                        if (++written >= list.Limit) return;
                        rows = new List<CompactRow>();
                    }
                    currentKey = key;
                    rows.Add(layout.Copy(row));
                }
                if (rows.Count > 0 && written < list.Limit) EmitGroup(list, rows, layout);
                return;
            }
            if (source.InMemory)
            {
                // Already in memory (a group of an outer list): bucket the rows by key.
                var buckets = new Dictionary<string, List<CompactRow>>(StringComparer.Ordinal);
                var inOrder = new List<List<CompactRow>>();
                foreach (CompactRow row in source.Find(filter, deep))
                {
                    var key = KeyOfRow(list, row);
                    if (!buckets.TryGetValue(key, out var bucket))
                    {
                        buckets[key] = bucket = new List<CompactRow>();
                        inOrder.Add(bucket);
                    }
                    bucket.Add(row);
                }
                IEnumerable<List<CompactRow>> all = list.Sort.Count > 0 ? inOrder.OrderBy(b => (IReadOnlyDictionary<string, object?>)b[0], new SortComparer(list.Sort)) : inOrder;
                foreach (var bucket in all.Take((int)Math.Min(list.Limit, int.MaxValue))) EmitGroup(list, bucket, layout);
                return;
            }
            // Unsorted file: find the groups (order, sizes), then collect their rows in batches of at most batchRows rows,
            // one pass per batch, so memory stays bounded however large the file is.
            var keyNames = list.GroupBy.Select(c => c.Name).Concat(list.Sort.Select(s => s.Column.Name)).ToHashSet(StringComparer.Ordinal);
            var found = new Dictionary<string, Group>(StringComparer.Ordinal);
            var foundOrder = new List<(string Key, Group Group)>();
            foreach (var row in source.Find(filter, keyNames))
            {
                var key = KeyOfRow(list, row);
                if (!found.TryGetValue(key, out var group))
                {
                    found[key] = group = new Group(row, []);
                    foundOrder.Add((key, group));
                }
                group.Count++;
            }
            IEnumerable<(string Key, Group Group)> ordered = foundOrder;
            if (list.Sort.Count > 0)
            {
                var comparer = new SortComparer(list.Sort);
                ordered = foundOrder.OrderBy(g => g.Group.First, comparer);
            }
            var selected = ordered.Take((int)Math.Min(list.Limit, int.MaxValue)).ToList();
            for (var start = 0; start < selected.Count;)
            {
                var batch = new Dictionary<string, Group>(StringComparer.Ordinal);
                var batchOrder = new List<Group>();
                long held = 0;
                for (; start < selected.Count && (batch.Count == 0 || held + selected[start].Group.Count <= batchRows); start++)
                {
                    var (key, group) = selected[start];
                    group.Rows = new List<CompactRow>();
                    batch[key] = group;
                    batchOrder.Add(group);
                    held += group.Count;
                }
                foreach (var row in source.Find(filter, deep))
                    if (batch.TryGetValue(KeyOfRow(list, row), out var group)) group.Rows!.Add(layout.Copy(row));
                foreach (var group in batchOrder)
                {
                    EmitGroup(list, group.Rows!, layout);
                    group.Rows = null;
                }
            }
        }
    }

    // ---- output sinks --------------------------------------------------------------------------------

    private interface ISink : IDisposable
    {
        void Key(string name);
        void StartObject();
        void EndObject();
        void StartArray(string item);
        void EndArray();
        void Value(JazminType type, object? value);
        void Literal(JsonNode? value);
        void FlushIfLarge();
        void End();
    }

    private sealed class JsonSink(Stream output, bool indented) : ISink
    {
        private readonly Utf8JsonWriter _w = new(output, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, Indented = indented });

        public void Key(string name) => _w.WritePropertyName(name);
        public void StartObject() => _w.WriteStartObject();
        public void EndObject() => _w.WriteEndObject();
        public void StartArray(string item) => _w.WriteStartArray();
        public void EndArray() => _w.WriteEndArray();

        public void Value(JazminType type, object? value)
        {
            if (value is BigInteger big) _w.WriteRawValue(big.ToString(CultureInfo.InvariantCulture));
            else JsonFormat.WriteValue(_w, type, value);
        }

        public void Literal(JsonNode? value)
        {
            if (value is null) _w.WriteNullValue();
            else value.WriteTo(_w);
        }

        public void FlushIfLarge()
        {
            if (_w.BytesPending > 65536) _w.Flush();
        }

        public void End() => _w.Flush();

        public void Dispose() => _w.Dispose();
    }

    private sealed class XmlSink : ISink
    {
        private readonly XmlWriter _w;
        private readonly string _root;
        private readonly Stack<string?> _items = new(); // per open element: item element name for list items
        private string? _pendingKey;

        public XmlSink(TextWriter output, string root)
        {
            _w = XmlWriter.Create(output, new XmlWriterSettings { Indent = true, IndentChars = "  ", Encoding = new UTF8Encoding(false) });
            _root = root;
            _w.WriteStartDocument();
        }

        private void Open()
        {
            var name = _items.Count == 0 ? _root : _pendingKey ?? _items.Peek() ?? "item";
            _pendingKey = null;
            if (XmlName.IsMatch(name) && !name.StartsWith("xml", StringComparison.OrdinalIgnoreCase))
            {
                _w.WriteStartElement(name);
            }
            else
            {
                _w.WriteStartElement("field");
                _w.WriteAttributeString("name", name);
            }
        }

        public void Key(string name) => _pendingKey = name;

        public void StartObject()
        {
            Open();
            _items.Push(null);
        }

        public void EndObject()
        {
            _items.Pop();
            _w.WriteEndElement();
        }

        public void StartArray(string item)
        {
            Open();
            _items.Push(item);
        }

        public void EndArray() => EndObject();

        public void Value(JazminType type, object? value)
        {
            if (value is null || value is double d && !double.IsFinite(d))
            {
                _pendingKey = null; // nulls are omitted
                return;
            }
            Open();
            _w.WriteString(value is BigInteger big ? big.ToString(CultureInfo.InvariantCulture) : TextValues.ToText(type, value));
            _w.WriteEndElement();
        }

        public void Literal(JsonNode? value)
        {
            if (value is null)
            {
                _pendingKey = null;
                return;
            }
            Open();
            _w.WriteString(value is JsonValue v && v.TryGetValue<string>(out var text) ? text : value.ToJsonString());
            _w.WriteEndElement();
        }

        public void FlushIfLarge() { }

        public void End()
        {
            _w.WriteEndDocument();
            _w.Flush();
        }

        public void Dispose() => _w.Dispose();
    }

    // ---- JSON Schema ---------------------------------------------------------------------------------

    private static JsonObject JsonType(JazminType type) => type switch
    {
        JazminType.Bool => new JsonObject { ["type"] = "boolean" },
        JazminType.Int => new JsonObject { ["type"] = "integer" },
        JazminType.Float or JazminType.Decimal => new JsonObject { ["type"] = "number" },
        JazminType.String => new JsonObject { ["type"] = "string" },
        JazminType.DateTime => new JsonObject { ["type"] = "string", ["format"] = "date-time" },
        JazminType.Binary => new JsonObject { ["type"] = "string", ["contentEncoding"] = "base64" },
        _ => new JsonObject(),
    };

    private static JsonObject Nullable(JsonObject schema)
    {
        if (schema["type"] is JsonValue t) schema["type"] = new JsonArray(t.GetValue<string>(), "null");
        return schema;
    }

    private static JsonObject Schema(Node node, bool mayBeEmpty) => node switch
    {
        Col c => c.Column.Nullable || mayBeEmpty || c.Column.Type == JazminType.Float ? Nullable(JsonType(c.Column.Type)) : JsonType(c.Column.Type),
        Lit l => new JsonObject { ["const"] = l.Value?.DeepClone() },
        Meta => new JsonObject(),
        Agg { Op: "count" } => new JsonObject { ["type"] = "integer", ["minimum"] = 0 },
        Agg a => Nullable(JsonType(a.Column!.Type)),
        Obj o => new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject(o.Members.Select(m => KeyValuePair.Create(m.Name, (JsonNode?)Schema(m.Node, mayBeEmpty)))),
            ["required"] = new JsonArray(o.Members.Select(m => (JsonNode?)JsonValue.Create(m.Name)).ToArray()),
            ["additionalProperties"] = false,
        },
        ListNode list => new JsonObject { ["type"] = "array", ["items"] = Schema(list.Item, false) },
        _ => throw new InvalidOperationException(),
    };
}
