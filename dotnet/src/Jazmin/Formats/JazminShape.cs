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

    /// <summary>
    /// A shape saved in the file under <paramref name="name"/> that this key can use (<see cref="JazminReader.Shapes"/>).
    /// It reads the table it was saved for, whichever table the reader given to it reads.
    /// </summary>
    public static JazminShape FromFile(JazminReader reader, string name)
    {
        ArgumentNullException.ThrowIfNull(reader);
        var saved = reader.Shapes.FirstOrDefault(s => s.Name == name) ?? throw new JazminValidationException($"No saved shape '{name}' is visible with this key");
        return new JazminShape(saved.Shape) { Table = saved.Table ?? reader.Tables[0] };
    }

    /// <summary>The table a saved shape reads (<see cref="FromFile"/>); null: the table of the reader it runs on.</summary>
    public string? Table { get; private init; }

    /// <summary>A saved shape's own table, opened for one call when the reader reads another (dispose it after); else null.</summary>
    private JazminReader? OwnTable(JazminReader reader) => Table is null || Table == reader.TableName ? null : reader.OpenTable(Table);

    /// <summary>Checks the shape against the columns this reader can see; throws naming the first mistake.</summary>
    public void Validate(JazminReader reader)
    {
        using var own = OwnTable(reader);
        reader = own ?? reader;
        using var tables = new TableReaders(reader);
        Compile(reader, tables);
    }

    /// <summary>Checks a shape against tables' columns, before any reader exists (saved shapes): it reads <paramref name="table"/>.</summary>
    internal static void Check(JsonObject shape, string table, Func<string, IReadOnlyList<JazminColumn>?> columnsOf) =>
        new JazminShape(shape).Compile(name => columnsOf(name ?? table));

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
        using var own = OwnTable(reader);
        reader = own ?? reader;
        using var tables = new TableReaders(reader);
        var root = Compile(reader, tables);
        using var sink = new JsonSink(output, indented);
        var engine = NewEngine(reader, sink, tables);
        engine.Run(root, filter);
        LinkStreams = engine.Streams;
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
        using var own = OwnTable(reader);
        reader = own ?? reader;
        using var tables = new TableReaders(reader);
        var compiled = Compile(reader, tables);
        using var sink = new XmlSink(output, root);
        var engine = NewEngine(reader, sink, tables);
        engine.Run(compiled, filter);
        LinkStreams = engine.Streams;
    }

    /// <summary>A JSON Schema (draft 2020-12) describing the shape's JSON output for this reader.</summary>
    public JsonObject ToJsonSchema(JazminReader reader)
    {
        using var own = OwnTable(reader);
        reader = own ?? reader;
        JsonObject schema;
        using (var tables = new TableReaders(reader)) schema = Schema(Compile(reader, tables), mayBeEmpty: true);
        var result = new JsonObject { ["$schema"] = "https://json-schema.org/draft/2020-12/schema" };
        foreach (var (key, value) in schema) result[key] = value?.DeepClone();
        return result;
    }

    // ---- compiled templates ------------------------------------------------------------------------

    private abstract class Node
    {
        /// <summary>What the node uses as a set (see SetNeeds), worked out once: a $one writes it for every parent.</summary>
        public (Dictionary<string, JazminColumn> Columns, List<Agg> Aggs)? Needs { get; set; }
    }

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

    private class ListNode : Node
    {
        public required Node Item { get; init; }
        public JazminFilter? Filter { get; init; }
        public JazminColumn[]? GroupBy { get; init; }
        public required List<(JazminColumn Column, bool Desc)> Sort { get; init; }
        public long Limit { get; init; } = long.MaxValue;
        public required string XmlItem { get; init; }

        /// <summary>The links the item's rows are the parents of (worked out once).</summary>
        public List<LinkNode>? ItemLinks { get; set; }

        /// <summary>Parents per batch of linked rows (worked out once).</summary>
        public int? LinkBatch { get; set; }

        /// <summary>The columns the item's rows read (worked out once).</summary>
        public HashSet<string>? RowNames { get; set; }

        /// <summary>Whether the item has lists, which read its rows again (worked out once).</summary>
        public bool? ItemHasList { get; set; }
    }

    /// <summary>
    /// A link to another table (docs/design/export-shapes.md section 7): a list of the linked rows, or (One) the linked
    /// rows as one set. Its template's columns are the linked table's. The run state is one export's.
    /// </summary>
    private sealed class LinkNode : ListNode
    {
        public required string Table { get; init; }
        public required IReadOnlyList<JazminColumn> Columns { get; init; }
        public required List<(JazminColumn Child, JazminColumn Parent)> On { get; init; }
        public JazminFilter? Where { get; init; }
        public bool One { get; init; }

        public JazminReader? Reader { get; set; }
        public Layout? Layout { get; set; }
        public List<string>? Select { get; set; }
        public List<LinkNode>? Nested { get; set; }
        public Dictionary<object, List<CompactRow>>? Held { get; set; }
        public Dictionary<object, List<CompactRow>> Cache { get; } = new();

        /// <summary>Scratch for a batch: the keys asked for (with a parent each) and the linked rows to follow further.</summary>
        public Dictionary<object, IReadOnlyDictionary<string, object?>> Want { get; } = new();
        public List<CompactRow> Children { get; } = [];

        /// <summary>While the link is read in step with its parents (see EmitRows): that pass, otherwise null.</summary>
        public LinkStream? Stream { get; set; }
    }

    /// <summary>
    /// A link read in step with its parents: its table is sorted by the linked columns and the parents arrive in that
    /// order, so one forward pass over the table finds every parent's rows, and only one parent's rows are held.
    /// </summary>
    private sealed class LinkStream(int[] order)
    {
        /// <summary>The linked columns in the table's sort order (positions in On): how keys are ordered.</summary>
        public int[] Order { get; } = order;
        public IEnumerator<IReadOnlyDictionary<string, object?>>? Rows { get; set; }
        public CompactRow? Next { get; set; } // read, not yet given to a parent
        public object? NextKey { get; set; }
        public object? LastKey { get; set; } // the key last asked for, and its rows (parents with equal keys)
        public List<CompactRow>? Last { get; set; }
    }

    /// <summary>The file's tables a shape links to, opened once (they share the reader's open file and key).</summary>
    private sealed class TableReaders(JazminReader reader) : IDisposable
    {
        private readonly Dictionary<string, JazminReader> _open = new(StringComparer.Ordinal);

        public JazminReader? Open(string name)
        {
            if (!reader.Tables.Contains(name)) return null;
            if (name == reader.TableName) return reader;
            if (!_open.TryGetValue(name, out var table)) _open[name] = table = reader.OpenTable(name);
            return table;
        }

        public void Dispose()
        {
            foreach (var table in _open.Values) table.Dispose();
            _open.Clear();
        }
    }

    /// <summary>A link key of several columns: equal when every part is.</summary>
    private sealed class CompositeKey(object[] parts) : IEquatable<CompositeKey>
    {
        private readonly object[] _parts = parts;

        public object Part(int i) => _parts[i];

        public bool Equals(CompositeKey? other) => other is not null && _parts.SequenceEqual(other._parts);

        public override bool Equals(object? obj) => Equals(obj as CompositeKey);

        public override int GetHashCode()
        {
            var hash = new HashCode();
            foreach (var part in _parts) hash.Add(part);
            return hash.ToHashCode();
        }
    }

    private static readonly HashSet<JazminType> Ordered = [JazminType.Bool, JazminType.Int, JazminType.Float, JazminType.String, JazminType.DateTime, JazminType.Decimal];
    private static readonly HashSet<JazminType> Groupable = Ordered;
    private static readonly HashSet<JazminType> Summable = [JazminType.Int, JazminType.Float, JazminType.Decimal];
    private static readonly HashSet<string> ListKeys = ["$rows", "$filter", "$groupBy", "$sort", "$limit", "$xmlItem"];
    private static readonly HashSet<string> LinkKeys = ["$from", "$on", .. ListKeys];
    private static readonly HashSet<string> OneKeys = ["$from", "$on", "$one", "$filter"];
    private static readonly Regex XmlName = new(@"^[A-Za-z_][A-Za-z0-9_.-]*$", RegexOptions.Compiled);

    private static JazminValidationException Fail(string path, string message) =>
        new($"Shape{(path.Length > 0 ? $" at {path}" : "")}: {message}");

    private static string Child(string path, string name) => path.Length > 0 ? $"{path}.{name}" : name;

    private static string TypeName(JazminType type) => TypeNames.ToName(type);

    /// <summary>A table's columns for compiling: the reader's (Table null), or a linked table's (<c>$from</c>).</summary>
    private sealed record Scope(string? Table, Dictionary<string, JazminColumn> Columns, IReadOnlyList<JazminColumn> List);

    private Node Compile(JazminReader reader, TableReaders tables) => Compile(name => name is null ? reader.Columns : tables.Open(name)?.Columns);

    /// <summary>Compiles against tables' columns: <c>columnsOf(null)</c> gives the columns of the table the shape reads.</summary>
    private Node Compile(Func<string?, IReadOnlyList<JazminColumn>?> columnsOf)
    {
        Scope ScopeOf(string? table, IReadOnlyList<JazminColumn> columns) => new(table, columns.ToDictionary(c => c.Name, StringComparer.Ordinal), columns);

        JazminColumn Column(Scope scope, JsonNode? name, string path, HashSet<JazminType>? allowed, string what)
        {
            if (name is not JsonValue v || !v.TryGetValue<string>(out var text)) throw Fail(path, $"{what} must name a column");
            if (!scope.Columns.TryGetValue(text, out var column))
                throw Fail(path, $"unknown or hidden column '{text}'{(scope.Table is null ? "" : $" in table '{scope.Table}'")}");
            if (allowed is not null && !allowed.Contains(column.Type)) throw Fail(path, $"{what} is not supported on {TypeName(column.Type)} column '{text}'");
            return column;
        }

        JazminFilter? FilterOf(Scope scope, JsonNode? filter, string path)
        {
            if (filter is null) return null;
            try
            {
                var parsed = JazminFilter.Parse(filter.ToJsonString());
                BoundFilter.Bind(parsed, scope.List); // validates columns, operators and operands
                return parsed;
            }
            catch (JazminException e)
            {
                throw Fail(path, e.Message);
            }
        }

        (JazminColumn[]? GroupBy, List<(JazminColumn, bool)> Sort, long Limit, string XmlItem) ListOptions(Scope scope, JsonObject obj, string path)
        {
            JazminColumn[]? groupBy = null;
            if (obj.TryGetPropertyValue("$groupBy", out var g))
            {
                var names = g is JsonArray a ? a.ToList() : [g];
                groupBy = names.Select((n, i) => Column(scope, n, Child(path, $"$groupBy[{i}]"), Groupable, "grouping")).ToArray();
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
                    sort.Add((Column(scope, desc ? JsonValue.Create(text![1..]) : entries[i], Child(path, $"$sort[{i}]"), Groupable, "sorting"), desc));
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
            return (groupBy, sort, limit, xmlItem);
        }

        // A link to another table (section 7): a list of the linked rows ($rows), or the linked rows as one set ($one).
        LinkNode Link(Scope scope, JsonObject obj, string path, List<string> keys)
        {
            var one = obj.ContainsKey("$one");
            if (one == obj.ContainsKey("$rows")) throw Fail(path, "a link needs one of $rows or $one");
            foreach (var k in keys)
                if (!(one ? OneKeys : LinkKeys).Contains(k)) throw Fail(path, $"unknown option '{k}' {(one ? "with $one" : "in a linked list")}");
            if (obj["$from"] is not JsonValue fv || !fv.TryGetValue<string>(out var table)) throw Fail(Child(path, "$from"), "$from must name a table");
            var linkedColumns = columnsOf(table) ?? throw Fail(Child(path, "$from"), $"unknown table '{table}'");
            var linked = ScopeOf(table, linkedColumns);
            if (obj["$on"] is not JsonObject on || on.Count == 0)
                throw Fail(Child(path, "$on"), "$on needs at least one column pair, such as { \"customer_id\": \"id\" }");
            var pairs = new List<(JazminColumn, JazminColumn)>();
            foreach (var (childName, parentName) in on)
            {
                var where = Child(path, $"$on.{childName}");
                var c = Column(linked, JsonValue.Create(childName), where, Groupable, "a link");
                var p = Column(scope, parentName, where, Groupable, "a link");
                if (c.Type != p.Type)
                    throw Fail(where, $"$on links {TypeName(c.Type)} column '{c.Name}' to {TypeName(p.Type)} column '{p.Name}': the types must match");
                pairs.Add((c, p));
            }
            var filter = FilterOf(linked, obj["$filter"], Child(path, "$filter"));
            if (one)
            {
                return new LinkNode
                {
                    Table = table, Columns = linkedColumns, On = pairs, Where = filter, One = true,
                    Sort = [], XmlItem = "item",
                    Item = Node(linked, obj["$one"], Child(path.Length > 0 ? path : "shape", "$one"), inRow: false),
                };
            }
            var (groupBy, sort, limit, xmlItem) = ListOptions(linked, obj, path);
            return new LinkNode
            {
                Table = table, Columns = linkedColumns, On = pairs, Where = filter,
                GroupBy = groupBy, Sort = sort, Limit = limit, XmlItem = xmlItem,
                Item = Node(linked, obj["$rows"], $"{(path.Length > 0 ? path : "shape")}[]", groupBy is null),
            };
        }

        Node Node(Scope scope, JsonNode? value, string path, bool inRow)
        {
            switch (value)
            {
                case null: return new Lit(null);
                case JsonValue v when v.GetValueKind() == JsonValueKind.String: return new Col(Column(scope, v, path, null, "a value"));
                case JsonValue v: return new Lit(v.DeepClone());
                case JsonArray: throw Fail(path, "arrays are not templates; use { \"$rows\": ... } for a list");
            }
            var obj = (JsonObject)value;
            var keys = obj.Select(p => p.Key).ToList();
            var special = keys.Where(k => k.StartsWith('$')).ToList();
            if (special.Count == 0) return new Obj(obj.Select(p => (p.Key, Node(scope, p.Value, Child(path, p.Key), inRow))).ToList());
            if (special.Count != keys.Count) throw Fail(path, $"'$' members cannot be mixed with other members ({string.Join(", ", keys)})");
            if (obj.ContainsKey("$from")) return Link(scope, obj, path, keys); // allowed in a row: how a row's details nest
            if (obj.ContainsKey("$rows"))
            {
                if (inRow) throw Fail(path, "a list inside a row list needs $groupBy on the outer list");
                foreach (var k in keys)
                    if (!ListKeys.Contains(k)) throw Fail(path, $"unknown list option '{k}'");
                var (groupBy, sort, limit, xmlItem) = ListOptions(scope, obj, path);
                return new ListNode
                {
                    Filter = FilterOf(scope, obj["$filter"], Child(path, "$filter")),
                    GroupBy = groupBy,
                    Sort = sort,
                    Limit = limit,
                    XmlItem = xmlItem,
                    Item = Node(scope, obj["$rows"], $"{(path.Length > 0 ? path : "shape")}[]", groupBy is null),
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
                    return new Agg(key[1..], Column(scope, arg, Child(path, key), key == "$sum" ? Summable : Ordered, key));
                default:
                    throw Fail(path, $"unknown operator '{key}'");
            }
        }

        return Node(ScopeOf(null, columnsOf(null) ?? throw Fail("", "the table it reads is not in the file")), _shape, "", inRow: false);
    }

    // ---- needs ---------------------------------------------------------------------------------------

    /// <summary>Columns (first values) and aggregates a set-context template uses directly (not inside its lists).</summary>
    private static (Dictionary<string, JazminColumn> Columns, List<Agg> Aggs) SetNeeds(Node node) => node.Needs ??= FindSetNeeds(node);

    private static (Dictionary<string, JazminColumn> Columns, List<Agg> Aggs) FindSetNeeds(Node node)
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
                case LinkNode link: foreach (var (_, parent) in link.On) columns[parent.Name] = parent; break; // the set's first values link
            }
        }
        Walk(node);
        return (columns, aggs);
    }

    private static void RowColumns(Node node, HashSet<string> names)
    {
        if (node is Col c) names.Add(c.Column.Name);
        else if (node is Obj o) foreach (var (_, m) in o.Members) RowColumns(m, names);
        else if (node is LinkNode link) foreach (var (_, parent) in link.On) names.Add(parent.Name);
    }

    /// <summary>
    /// The links a template's rows are the parents of: in its objects and in its lists of the same rows, not inside
    /// other links (those are the linked rows' own, fetched with them).
    /// </summary>
    private static List<LinkNode> LinksIn(Node node, List<LinkNode>? found = null)
    {
        found ??= [];
        switch (node)
        {
            case LinkNode link: found.Add(link); break;
            case Obj o: foreach (var (_, m) in o.Members) LinksIn(m, found); break;
            case ListNode list: LinksIn(list.Item, found); break;
        }
        return found;
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

    /// <summary>
    /// Rows held at a time when grouping an unsorted file with nested lists: each batch is one pass over the file. Null
    /// chooses by the reader's priority: <see cref="JazminPriority.Speed"/> takes larger batches (fewer passes, more
    /// memory); smaller ones than the default saved little memory for several times the time. Tests set it.
    /// </summary>
    internal int? BatchRows { get; set; }

    private int BatchRowsFor(JazminReader reader) => BatchRows ?? (reader.Priority == JazminPriority.Speed ? 1_000_000 : 100_000);

    /// <summary>
    /// Links: parents written per batch (their linked rows fetched together). Null: by priority, and by whether every link
    /// follows the tables' sort order (then small batches each read just their own chunks; otherwise each batch reads
    /// about the whole linked table, so larger batches mean fewer passes). Tests set it.
    /// </summary>
    internal int? LinkBatch { get; set; }

    /// <summary>Links: the largest linked table read once and kept by key. Null: by priority. Tests set it.</summary>
    internal int? LinkTableRows { get; set; }

    /// <summary>Linked tables the last export read in step with their parents (tests check the path taken).</summary>
    internal int LinkStreams { get; private set; }

    private Engine NewEngine(JazminReader reader, ISink sink, TableReaders tables) => new(reader, sink, BatchRowsFor(reader), tables, LinkBatch,
        LinkTableRows ?? reader.Priority switch { JazminPriority.Memory => 10_000, JazminPriority.Speed => 1_000_000, _ => 100_000 });

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
            case LinkNode link: foreach (var (_, parent) in link.On) names.Add(parent.Name); break; // the linked rows are read with the link
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
            if (filter is null && limit >= rows.Count) return rows; // all of them (per parent: no iterator)
            BoundFilter? test = null;
            if (filter is not null && !layout.Bound.TryGetValue(filter, out test))
                layout.Bound[filter] = test = BoundFilter.Bind(filter, layout.Columns);
            return Matches(test, limit);
        }

        private IEnumerable<IReadOnlyDictionary<string, object?>> Matches(BoundFilter? test, long limit)
        {
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

    private readonly record struct Context(ISource? Source, JazminFilter? Filter, IReadOnlyDictionary<string, object?> Values, IReadOnlyDictionary<Agg, object?>? Aggs);

    private static readonly IReadOnlyDictionary<string, object?> NoValues = new Dictionary<string, object?>();
    private static readonly IReadOnlyDictionary<Agg, object?> NoAggs = new Dictionary<Agg, object?>();

    private sealed class Engine(JazminReader reader, ISink sink, int batchRows, TableReaders tables, int? linkBatch, int tableRows)
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
        private static (IReadOnlyDictionary<string, object?> First, IReadOnlyDictionary<Agg, object?> Aggs) SetValues(Node node, IEnumerable<IReadOnlyDictionary<string, object?>> rows)
        {
            var (_, aggs) = SetNeeds(node);
            if (aggs.Count == 0)
            {
                if (rows is IReadOnlyList<IReadOnlyDictionary<string, object?>> held) return (held.Count > 0 ? held[0] : NoValues, NoAggs);
                foreach (var row in rows) return (row, NoAggs);
                return (NoValues, NoAggs);
            }
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
            if (columns.Count == 0 && aggs.Count == 0) return new Context(source, filter, NoValues, NoAggs);
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
                    sink.Value(c.Column.Type, Format.Nested.ForOutput(c.Column, value));
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
                case LinkNode link: EmitLink(link, ctx); break;
                case ListNode list:
                    sink.StartArray(list.XmlItem);
                    if (list.GroupBy is null) EmitRows(list, ctx);
                    else EmitGroups(list, ctx);
                    sink.EndArray();
                    break;
            }
            sink.FlushIfLarge();
        }

        // ---- links between tables (section 7) ----

        // While a batch of parents is written (_batching > 0), the rows linked to them stay in each link's cache; they
        // are released when the batch is done. A link written on its own (for the root or a group) is a batch of one.
        private int _batching;
        private static readonly List<CompactRow> NoRows = [];

        /// <summary>A value's identity as a link key (as in filters: decimals by value), or null: null and NaN link nothing.</summary>
        private static object? KeyFor(JazminType type, object? value)
        {
            if (value is null) return null;
            var key = Format.Values.ToKey(type, value);
            return Format.Values.IsNaN(key) ? null : key;
        }

        private static object? LinkKey(List<(JazminColumn Child, JazminColumn Parent)> on, IReadOnlyDictionary<string, object?> values, bool child)
        {
            JazminColumn ColumnOf(int i) => child ? on[i].Child : on[i].Parent;
            object? ValueOf(int i) => values.TryGetValue(ColumnOf(i).Name, out var v) ? v : null;
            if (on.Count == 1) return KeyFor(ColumnOf(0).Type, ValueOf(0));
            var parts = new object[on.Count];
            for (var i = 0; i < parts.Length; i++)
            {
                if (KeyFor(ColumnOf(i).Type, ValueOf(i)) is not { } key) return null;
                parts[i] = key;
            }
            return new CompositeKey(parts);
        }

        private static void Add(Dictionary<object, List<CompactRow>> map, object key, CompactRow row)
        {
            if (map.TryGetValue(key, out var rows)) rows.Add(row);
            else map[key] = [row];
        }

        /// <summary>Readies a link once: its table's reader, the columns read, and (a small table) every row, kept by key.</summary>
        private void Prepare(LinkNode link)
        {
            if (link.Reader is null) Open(link); // called per parent: the closures below would be made on every call
        }

        private void Open(LinkNode link)
        {
            link.Reader = tables.Open(link.Table)!;
            var names = new HashSet<string>(link.On.Select(p => p.Child.Name), StringComparer.Ordinal);
            DeepColumns(link.Item, names);
            foreach (var c in link.GroupBy ?? []) names.Add(c.Name);
            foreach (var (c, _) in link.Sort) names.Add(c.Name);
            link.Layout = new Layout(link.Columns.Where(c => names.Contains(c.Name)).ToArray());
            link.Select = link.Layout.Columns.Select(c => c.Name).ToList();
            link.Nested = LinksIn(link.Item);
            if (link.Reader.RowCount > tableRows) return;
            link.Held = new Dictionary<object, List<CompactRow>>();
            foreach (var row in link.Reader.Find(link.Where, new JazminQueryOptions { Select = link.Select }))
                if (LinkKey(link.On, row, child: true) is { } key) Add(link.Held, key, link.Layout.Copy(row));
        }

        /// <summary>
        /// Whether these links follow the sort order of their parents and of their own tables: each linked table is sorted
        /// by the linked columns, and the parents arrive in that order (<paramref name="parentSorted"/>: the parents'
        /// table order, or empty when it is not known). Then a batch's linked rows lie together.
        /// </summary>
        private bool Aligned(List<LinkNode> links, IReadOnlyList<string> parentSorted) => links.All(link =>
        {
            Prepare(link);
            var sorted = link.Reader!.SortedBy ?? [];
            IReadOnlyList<string> nestedOrder = link.Sort.Count > 0 || link.GroupBy is not null ? [] : sorted;
            if (link.Held is not null) return Aligned(link.Nested!, []); // held: looked up in the parents' order
            for (var i = 0; i < link.On.Count; i++)
            {
                var pair = link.On.FirstOrDefault(p => i < sorted.Count && p.Child.Name == sorted[i]);
                if (pair.Child is null || pair.Child.Type == JazminType.Float || i >= parentSorted.Count || parentSorted[i] != pair.Parent.Name) return false;
            }
            return Aligned(link.Nested!, nestedOrder);
        });

        /// <summary>
        /// Parents per batch, or null to read the links in step with the parents instead (every link follows the tables'
        /// sort order). A batch's linked rows are found with one query per link, which reads about the whole linked table
        /// when the rows lie scattered: larger batches mean fewer passes, and more rows held.
        /// </summary>
        private int? LinkBatchFor(ListNode list, ISource source, List<LinkNode> links)
        {
            if (linkBatch is { } fixedSize) return fixedSize;
            if (list.LinkBatch is { } known) return known == 0 ? null : known;
            IReadOnlyList<string> parentOrder = source.InMemory || list.Sort.Count > 0 ? [] : _sortedBy;
            list.LinkBatch = Aligned(links, parentOrder) ? 0 : reader.Priority switch
            {
                JazminPriority.Memory => 2_500,
                JazminPriority.Speed => 20_000,
                _ => 10_000,
            };
            return list.LinkBatch == 0 ? null : list.LinkBatch;
        }

        // ---- links read in step with their parents ----

        // Rows skipped before a stream looks for its next key with a query instead (parents far apart: a filtered export).
        private const int SeekAfter = 2_048;

        /// <summary>Linked tables read in step with their parents (counted for tests).</summary>
        public int Streams { get; private set; }

        private void StartStreams(List<LinkNode> links)
        {
            foreach (var link in links)
            {
                if (link.Held is null)
                {
                    Streams++;
                    var sorted = link.Reader!.SortedBy!;
                    link.Stream = new LinkStream(Enumerable.Range(0, link.On.Count).Select(i => link.On.FindIndex(p => p.Child.Name == sorted[i])).ToArray());
                }
                StartStreams(link.Nested!);
            }
        }

        private static void StopStreams(List<LinkNode> links)
        {
            foreach (var link in links)
            {
                link.Stream?.Rows?.Dispose();
                link.Stream = null;
                StopStreams(link.Nested!);
            }
        }

        /// <summary>Keys in the linked table's order: by the linked columns in its sort order.</summary>
        private static int CompareKeys(LinkStream stream, object a, object b)
        {
            if (stream.Order.Length == 1) return Format.Values.Compare(a, b) ?? 0;
            var (x, y) = ((CompositeKey)a, (CompositeKey)b);
            foreach (var i in stream.Order)
            {
                var c = Format.Values.Compare(x.Part(i), y.Part(i)) ?? 0;
                if (c != 0) return c;
            }
            return 0;
        }

        private static object Leading(LinkStream stream, object key) => stream.Order.Length == 1 ? key : ((CompositeKey)key).Part(stream.Order[0]);

        /// <summary>(Re)starts a stream's pass at a parent: the rows from its leading linked value on (statistics skip the rest).</summary>
        private static void Seek(LinkNode link, LinkStream stream, IReadOnlyDictionary<string, object?> parent)
        {
            stream.Rows?.Dispose();
            var (child, parentColumn) = link.On[stream.Order[0]];
            parent.TryGetValue(parentColumn.Name, out var from); // not null: the parent has a key
            stream.Rows = link.Reader!.Find(And(JazminFilter.Gte(child.Name, from!), link.Where), new JazminQueryOptions { Select = link.Select }).GetEnumerator();
            stream.Next = null;
        }

        /// <summary>
        /// A streamed link's rows for one parent: read on from where the last parent's ended. Parents out of order (equal
        /// parents apart, or a nested link under one) still get their rows, with a query of their own.
        /// </summary>
        private List<CompactRow> StreamRows(LinkNode link, LinkStream stream, object key, IReadOnlyDictionary<string, object?> parent)
        {
            if (stream.LastKey is { } last)
            {
                var order = CompareKeys(stream, key, last);
                if (order == 0) return stream.Last!;
                if (order < 0)
                {
                    if (!link.Cache.ContainsKey(key)) Prefetch(link, [parent]);
                    return link.Cache[key];
                }
            }
            if (stream.Rows is null) Seek(link, stream, parent);
            List<CompactRow>? rows = null;
            var skipped = 0;
            while (true)
            {
                if (stream.Next is null)
                {
                    if (!stream.Rows!.MoveNext()) break;
                    stream.Next = link.Layout!.Copy(stream.Rows.Current);
                    stream.NextKey = LinkKey(link.On, stream.Next, child: true);
                }
                var order = stream.NextKey is { } next ? CompareKeys(stream, next, key) : -1; // a null key links nothing
                if (order > 0) break;
                if (order == 0) (rows ??= []).Add(stream.Next);
                else if (++skipped > SeekAfter && stream.NextKey is { } behind
                         && (Format.Values.Compare(Leading(stream, behind), Leading(stream, key)) ?? 0) < 0)
                {
                    Seek(link, stream, parent); // far behind: skip ahead with the table's statistics
                    skipped = 0;
                    continue;
                }
                stream.Next = null;
            }
            stream.LastKey = key;
            return stream.Last = rows ?? NoRows;
        }

        /// <summary>
        /// Fetches the rows linked to these parents (one query: `in` conditions on the linked columns, and the link's
        /// filter), or takes them from a held table, then the linked rows' own links, recursively. Kept in each cache.
        /// </summary>
        private void Prefetch(LinkNode link, IEnumerable<IReadOnlyDictionary<string, object?>> parents)
        {
            Prepare(link);
            if (link.Held is not null && link.Nested!.Count == 0) return; // looked up directly when written
            var want = link.Want;
            foreach (var values in parents)
                if (LinkKey(link.On, values, child: false) is { } key && !link.Cache.ContainsKey(key)) want.TryAdd(key, values);
            if (want.Count == 0) return;
            if (link.Held is null)
            {
                var where = JazminFilter.And(link.On.Select(p => JazminFilter.In(p.Child.Name,
                    want.Values.Select(v => v.TryGetValue(p.Parent.Name, out var x) ? x : null).ToArray())).ToArray());
                foreach (var row in link.Reader!.Find(And(where, link.Where), new JazminQueryOptions { Select = link.Select }))
                {
                    // Several columns: their in-conditions together select a superset.
                    var copy = link.Layout!.Copy(row);
                    if (LinkKey(link.On, copy, child: true) is { } key && want.ContainsKey(key)) Add(link.Cache, key, copy);
                }
            }
            var children = link.Children;
            foreach (var key in want.Keys)
            {
                if (!link.Cache.TryGetValue(key, out var rows)) link.Cache[key] = rows = link.Held?.GetValueOrDefault(key) ?? NoRows;
                if (link.Nested!.Count > 0) children.AddRange(rows);
            }
            want.Clear();
            foreach (var nested in link.Nested!) Prefetch(nested, children);
            children.Clear();
        }

        /// <summary>The rows linked to one parent: fetched with its batch, or now (with their own links).</summary>
        private List<CompactRow> LinkedRows(LinkNode link, IReadOnlyDictionary<string, object?> values)
        {
            Prepare(link);
            if (LinkKey(link.On, values, child: false) is not { } key) return NoRows;
            if (link.Held is not null && link.Nested!.Count == 0) return link.Held.GetValueOrDefault(key) ?? NoRows;
            if (link.Stream is { } stream) return StreamRows(link, stream, key, values);
            if (!link.Cache.ContainsKey(key)) Prefetch(link, [values]);
            return link.Cache[key];
        }

        private static void Release(List<LinkNode> links)
        {
            foreach (var link in links)
            {
                if (link.Cache.Count > 0) link.Cache.Clear();
                Release(link.Nested!);
            }
        }

        private void EmitLink(LinkNode link, Context ctx)
        {
            var top = _batching == 0;
            if (top) _batching++;
            try
            {
                var rows = LinkedRows(link, ctx.Values);
                var lists = link.ItemHasList ??= HasList(link.Item);
                var linked = new Context(link.One && !lists ? null : new MemorySource(rows, link.Layout!), null, NoValues, null);
                if (link.One)
                {
                    if (rows.Count == 0) sink.Literal(null);
                    else
                    {
                        var (first, aggs) = SetValues(link.Item, rows);
                        Emit(link.Item, linked with { Values = first, Aggs = aggs });
                    }
                }
                else
                {
                    sink.StartArray(link.XmlItem);
                    if (link.GroupBy is null) EmitRows(link, linked);
                    else EmitGroups(link, linked);
                    sink.EndArray();
                }
            }
            finally
            {
                if (top)
                {
                    Release([link]);
                    _batching--;
                }
            }
        }

        private void EmitRows(ListNode list, Context ctx)
        {
            var names = list.RowNames;
            if (names is null)
            {
                names = new HashSet<string>(StringComparer.Ordinal);
                RowColumns(list.Item, names);
                foreach (var (column, _) in list.Sort) names.Add(column.Name);
                list.RowNames = names;
            }
            var filter = And(ctx.Filter, list.Filter);
            var rows = ctx.Source!.Find(filter, names, list.Sort.Count == 0 ? list.Limit : long.MaxValue);
            if (list.Sort.Count > 0)
                rows = rows.ToList().OrderBy(r => r, new SortComparer(list.Sort)).Take((int)Math.Min(list.Limit, int.MaxValue));
            var links = list.ItemLinks ??= LinksIn(list.Item);
            if (links.Count > 0 && _batching == 0 && LinkBatchFor(list, ctx.Source!, links) is null)
            {
                // Every link follows the tables' sort order: each linked table is read once, in step with the rows.
                StartStreams(links);
                _batching++;
                try
                {
                    foreach (var row in rows)
                    {
                        Emit(list.Item, new Context(null, null, row, null));
                        Release(links); // rows a parent fetched for itself (out of order, or under a held link)
                    }
                }
                finally
                {
                    _batching--;
                    StopStreams(links);
                }
                return;
            }
            if (links.Count > 0 && _batching == 0)
            {
                // Rows with links: written in batches, each batch's linked rows fetched together (one query per link).
                var size = LinkBatchFor(list, ctx.Source!, links)!.Value;
                _batching++;
                try
                {
                    var batch = new List<IReadOnlyDictionary<string, object?>>();
                    void Flush()
                    {
                        foreach (var link in links) Prefetch(link, batch);
                        foreach (var row in batch) Emit(list.Item, new Context(null, null, row, null));
                        Release(links);
                        batch.Clear();
                    }
                    foreach (var row in rows)
                    {
                        batch.Add(row);
                        if (batch.Count >= size) Flush();
                    }
                    if (batch.Count > 0) Flush();
                }
                finally
                {
                    _batching--;
                }
                return;
            }
            if (rows is IReadOnlyList<IReadOnlyDictionary<string, object?>> held)
            {
                for (var i = 0; i < held.Count; i++) Emit(list.Item, new Context(null, null, held[i], null)); // no enumerator per parent
                return;
            }
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

        /// <summary>
        /// A row's group key: for one grouping column its value, made canonical (no string per row: 1M rows grouped
        /// in ten passes built ten million); for several, their joined text. Equal keys are one group either way.
        /// </summary>
        private static object KeyOfRow(ListNode list, IReadOnlyDictionary<string, object?> row)
        {
            if (list.GroupBy!.Length == 1) return KeyValue(row.TryGetValue(list.GroupBy[0].Name, out var v) ? v : null);
            return KeyOf(list.GroupBy.Select(c => row.TryGetValue(c.Name, out var x) ? x : null));
        }

        private static readonly object NullKey = new();
        private static readonly object ZeroKey = 0.0;
        private static readonly object NaNKey = double.NaN;

        /// <summary>As KeyOf for one value: null alone, -0 with 0, every NaN together; others by their own equality.</summary>
        private static object KeyValue(object? v) => v switch
        {
            null => NullKey,
            double d when d == 0 => ZeroKey,
            double d when double.IsNaN(d) => NaNKey,
            _ => v,
        };

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
                var groups = new Dictionary<object, Group>();
                var order = new List<Group>();
                Group? current = null;
                object? currentKey = null;
                foreach (var row in source.Find(filter, names))
                {
                    var key = KeyOfRow(list, row);
                    Group group;
                    if (contiguous)
                    {
                        if (!Equals(key, currentKey))
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
                object? currentKey = null;
                foreach (var row in source.Find(filter, deep))
                {
                    var key = KeyOfRow(list, row);
                    if (!Equals(key, currentKey) && rows.Count > 0)
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
                var buckets = new Dictionary<object, List<CompactRow>>();
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
            var found = new Dictionary<object, Group>();
            var foundOrder = new List<(object Key, Group Group)>();
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
            IEnumerable<(object Key, Group Group)> ordered = foundOrder;
            if (list.Sort.Count > 0)
            {
                var comparer = new SortComparer(list.Sort);
                ordered = foundOrder.OrderBy(g => g.Group.First, comparer);
            }
            var selected = ordered.Take((int)Math.Min(list.Limit, int.MaxValue)).ToList();
            for (var start = 0; start < selected.Count;)
            {
                var batch = new Dictionary<object, Group>();
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
        LinkNode { One: true } link => Nullable(Schema(link.Item, false)),
        ListNode list => new JsonObject { ["type"] = "array", ["items"] = Schema(list.Item, false) },
        _ => throw new InvalidOperationException(),
    };
}
