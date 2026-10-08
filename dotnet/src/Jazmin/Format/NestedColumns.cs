using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Formats;
using Jazmin.Serialization;

namespace Jazmin.Format;

/// <summary>
/// List and object columns stored as columns (spec 5.4, reader feature 'nested-columns'). A nested column is one stream
/// of its chunk, with encoding 5: after its flags and null bitmap, an object holds one stream per field and a list a
/// stream of lengths and one of items, each in the ordinary stream format and encodings, so a field nobody reads is
/// skipped and repeated text is stored once per chunk.
/// </summary>
internal static class Nested
{
    public const byte Encoding = 5;

    /// <summary>
    /// A buffer for a column, or for a field or the items of one (<paramref name="path"/>: where it is, for messages, as
    /// in "lines[].sku"): nested ones split their values further.
    /// </summary>
    public static ColumnBuffer Buffer(JazminColumn column, JazminSerializerSettings? settings, string? path = null) =>
        TypeNames.IsNested(column.Type) ? new NestedColumn(column, settings, path ?? column.Name) : ColumnBuffer.For(column.Type);

    /// <summary>A field's or item's value in normalized form (spec 5.1), from JSON or from a .NET value.</summary>
    public static object? Normalize(JazminColumn column, object? value, string path, JazminSerializerSettings? settings)
    {
        if (value is null || value is JsonValue v && v.GetValueKind() == JsonValueKind.Null) return null;
        if (value is JsonElement element) value = element.ValueKind == JsonValueKind.Null ? null : JsonSerializer.SerializeToNode(element);
        if (value is null) return null;
        if (TypeNames.IsNested(column.Type)) return value; // split by its own buffer
        if (column.Type != JazminType.Json && value is JsonValue json) value = FromJson(json, column.Type, path);
        else if (value is not JsonNode) value = Stored(value);
        return Values.Normalize(column.Type, value, path, settings?.EffectiveJsonOptions);
    }

    /// <summary>A .NET value as the serializer stores it (enums and the like as text).</summary>
    private static object Stored(object value) => value switch
    {
        Enum e => e.ToString(),
        char c => c.ToString(),
        Guid g => g.ToString(),
        TimeSpan ts => ts.ToString("c", CultureInfo.InvariantCulture),
        TimeOnly t => t.ToString("O", CultureInfo.InvariantCulture),
        _ => value,
    };

    /// <summary>A JSON scalar as the value of a column type.</summary>
    private static object FromJson(JsonValue value, JazminType type, string path)
    {
        var kind = value.GetValueKind();
        string Text() => value.TryGetValue<string>(out var s) ? s : JsonSerializer.Deserialize<string>(value.ToJsonString())!;
        string Number() => value.ToJsonString();
        try
        {
            return (type, kind) switch
            {
                (JazminType.Bool, JsonValueKind.True) => true,
                (JazminType.Bool, JsonValueKind.False) => false,
                (JazminType.Int, JsonValueKind.Number) => long.Parse(Number(), NumberStyles.Integer, CultureInfo.InvariantCulture),
                (JazminType.Float, JsonValueKind.Number) => double.Parse(Number(), NumberStyles.Float, CultureInfo.InvariantCulture),
                (JazminType.Decimal, JsonValueKind.Number) => Number(),
                (JazminType.Decimal or JazminType.String or JazminType.DateTime, JsonValueKind.String) => Text(),
                (JazminType.DateTime, JsonValueKind.Number) => long.Parse(Number(), NumberStyles.Integer, CultureInfo.InvariantCulture),
                (JazminType.Binary, JsonValueKind.String) => Convert.FromBase64String(Text()),
                _ => throw new JazminValidationException($"Column '{path}': expected a {TypeNames.ToName(type)}, got JSON {kind.ToString().ToLowerInvariant()}"),
            };
        }
        catch (Exception e) when (e is FormatException or OverflowException)
        {
            throw new JazminValidationException($"Column '{path}': '{value.ToJsonString()}' is not a valid {TypeNames.ToName(type)}", e);
        }
    }

    /// <summary>A value of a column (or field, or item) as JSON: what an untyped row shows of a nested column.</summary>
    public static JsonNode? ToJson(JazminType type, object? value) => value switch
    {
        null => null,
        JsonNode node => node,
        string text when type == JazminType.Decimal => JsonNode.Parse(text), // as a number, every digit kept
        byte[] bytes => JsonValue.Create(Convert.ToBase64String(bytes)),
        DateTime => JsonValue.Create(TextValues.ToText(type, value)),
        long l => JsonValue.Create(l),
        double d => double.IsFinite(d) ? JsonValue.Create(d) : JsonValue.Create(TextValues.ToText(type, d)),
        bool b => JsonValue.Create(b),
        string s => JsonValue.Create(s),
        _ => JsonValue.Create(value.ToString()),
    };

    /// <summary>
    /// A nested column's JSON (what an untyped row holds) as a .NET object: lists and arrays item by item, objects through
    /// the serializer's map of their type (so its names, naming strategy included, find the fields), scalars as JSON does.
    /// </summary>
    public static object? FromJson(JsonNode? node, Type target, JazminSerializerSettings? settings)
    {
        if (node is null) return null;
        var t = Nullable.GetUnderlyingType(target) ?? target;
        if (t == typeof(object) || typeof(JsonNode).IsAssignableFrom(t)) return node;
        if (node is JsonArray array && (t.IsArray || t.IsGenericType) && (t.IsArray ? t.GetElementType() : t.GetGenericArguments()[0]) is { } element
            && (t.IsArray || t.IsAssignableFrom(typeof(List<>).MakeGenericType(element))))
        {
            if (t.IsArray)
            {
                var items = Array.CreateInstance(element, array.Count);
                for (var i = 0; i < array.Count; i++) items.SetValue(FromJson(array[i], element, settings), i);
                return items;
            }
            var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(element), array.Count)!;
            foreach (var item in array) list.Add(FromJson(item, element, settings));
            return list;
        }
        if (node is JsonObject obj && MapOf(t, settings) is { } map)
        {
            var values = new Dictionary<string, object?>(obj.Count, StringComparer.Ordinal);
            foreach (var (name, value) in obj)
            {
                if (map.MemberType(name) is not { } memberType) continue;
                values[name] = value is JsonObject or JsonArray ? FromJson(value, memberType, settings) : value;
            }
            return map.FromRow(values, settings);
        }
        return TypeMap.Convert(node, target, settings);
    }

    private static readonly PerSettings<Type, TypeMap?> Maps = new();

    /// <summary>The serializer's map of a .NET type used as a nested object (null when there is none).</summary>
    public static TypeMap? MapOf(Type type, JazminSerializerSettings? settings) => Maps.For(settings).GetOrAdd(type, static (t, s) =>
    {
        try
        {
            return TypeMap.For(t, s);
        }
        catch (JazminValidationException)
        {
            return null;
        }
    }, settings);
}

/// <summary>
/// Values cached per settings, as <see cref="TypeMap.For"/> caches maps: shared by all settings that do not change how
/// types map, otherwise kept with that settings instance (and dropped with it).
/// </summary>
internal sealed class PerSettings<TKey, TValue> where TKey : notnull
{
    private readonly ConcurrentDictionary<TKey, TValue> _plain = new();
    private readonly ConditionalWeakTable<JazminSerializerSettings, ConcurrentDictionary<TKey, TValue>> _shaped = new();

    public ConcurrentDictionary<TKey, TValue> For(JazminSerializerSettings? settings) =>
        settings is null || !settings.ShapesContract ? _plain : _shaped.GetValue(settings, static _ => new());
}

/// <summary>A list or object column (or field, or list of items) being written: values are split as they are added.</summary>
internal sealed class NestedColumn : ColumnBuffer
{
    private readonly JazminColumn _column;
    private readonly string _path; // for messages: "lines", "lines[]", "lines[].sku"
    private readonly string? _itemPath;
    private readonly string[]? _fieldPaths;
    private readonly JazminSerializerSettings? _settings;
    private readonly LongColumn? _lengths; // lists: the length of each list that is not null
    private readonly ColumnBuffer? _items;
    private readonly JazminColumn[]? _fieldColumns;
    private readonly ColumnBuffer[]? _fields;
    private readonly Dictionary<string, int>? _fieldIndex;
    private readonly ByteWriter _scratch = new(1024); // the parent's scratch holds this column's body while it is encoded
    private readonly ConcurrentDictionary<Type, Func<object, object?>[]> _getters = new();
    private long _bytes;

    public NestedColumn(JazminColumn column, JazminSerializerSettings? settings, string path)
    {
        _column = column;
        _path = path;
        _settings = settings;
        if (column.Type == JazminType.List)
        {
            _lengths = new LongColumn(JazminType.Int, withStats: false);
            _itemPath = path + "[]";
            _items = Nested.Buffer(column.Item!, settings, _itemPath);
        }
        else
        {
            _fieldColumns = [.. column.Fields!];
            _fieldPaths = [.. _fieldColumns.Select(f => $"{path}.{f.Name}")];
            _fields = [.. _fieldColumns.Select((f, i) => Nested.Buffer(f, settings, _fieldPaths[i]))];
            _fieldIndex = _fieldColumns.Select((f, i) => (f.Name, i)).ToDictionary(x => x.Name, x => x.i, StringComparer.Ordinal);
        }
    }

    /// <summary>The approximate bytes added since the last call (chunks are capped by size).</summary>
    public long TakeBytes()
    {
        var bytes = _bytes;
        _bytes = 0;
        return bytes;
    }

    private void Add(ColumnBuffer buffer, JazminColumn column, object? raw, string path)
    {
        var value = Nested.Normalize(column, raw, path, _settings);
        if (value is null && !column.Nullable) throw new JazminValidationException($"Column '{path}' is not nullable");
        buffer.Add(value);
        _bytes += buffer is NestedColumn nested ? nested.TakeBytes() : value switch
        {
            null => 0,
            string s => s.Length + 1,
            byte[] b => b.Length + 2,
            _ => 5,
        };
    }

    protected override void AddValue(object value)
    {
        if (_lengths is not null) AddList(value);
        else AddObject(value);
    }

    private void AddList(object value)
    {
        if (value is string or JsonObject or IDictionary || value is JsonValue || value is not IEnumerable items)
            throw new JazminValidationException($"Column '{_path}': expected a list, got {value.GetType().Name}");
        long n = 0;
        foreach (var item in items)
        {
            Add(_items!, _column.Item!, item, _itemPath!);
            n++;
        }
        _lengths!.AddLong(n);
    }

    private void AddObject(object value)
    {
        var fields = _fieldColumns!;
        switch (value)
        {
            case JsonObject json:
                foreach (var (name, _) in json)
                    if (!_fieldIndex!.ContainsKey(name)) throw new JazminValidationException($"Column '{_path}': '{name}' is not one of its fields");
                for (var i = 0; i < fields.Length; i++) Add(_fields![i], fields[i], json[fields[i].Name], _fieldPaths![i]);
                return;
            case JsonNode:
                throw new JazminValidationException($"Column '{_path}': expected an object, got JSON {((JsonNode)value).GetValueKind().ToString().ToLowerInvariant()}");
            case IDictionary<string, object?> map:
                foreach (var name in map.Keys)
                    if (!_fieldIndex!.ContainsKey(name)) throw new JazminValidationException($"Column '{_path}': '{name}' is not one of its fields");
                for (var i = 0; i < fields.Length; i++) Add(_fields![i], fields[i], map.TryGetValue(fields[i].Name, out var v) ? v : null, _fieldPaths![i]);
                return;
            default:
                var getters = _getters.GetOrAdd(value.GetType(), Getters);
                for (var i = 0; i < fields.Length; i++) Add(_fields![i], fields[i], getters[i](value), _fieldPaths![i]);
                return;
        }
    }

    /// <summary>For a .NET type, the stored value of each field: its member of that name, as the serializer maps it.</summary>
    private Func<object, object?>[] Getters(Type type)
    {
        var map = Nested.MapOf(type, _settings) ?? throw new JazminValidationException($"Column '{_path}': {type.Name} cannot be stored as an object");
        return [.. _fieldColumns!.Select(f => map.StoredGetter(f.Name, _settings)
            ?? throw new JazminValidationException($"Column '{_path}': {type.Name} has no member for field '{f.Name}'"))];
    }

    protected override byte EncodeBody(ByteWriter body)
    {
        if (_lengths is not null)
        {
            _lengths.Encode(body, _scratch);
            _items!.Encode(body, _scratch);
        }
        else
        {
            foreach (var field in _fields!) field.Encode(body, _scratch);
        }
        return Nested.Encoding;
    }

    public override ColumnStats Stats() => new() { Nulls = NullCount };

    protected override void ResetValues()
    {
        _lengths?.Reset();
        _items?.Reset();
        if (_fields is not null)
            foreach (var field in _fields) field.Reset();
    }
}

/// <summary>
/// A decoded part of a nested column: a scalar stream, or a list or object over its entries. Only entries [Lo, Hi) may
/// have been decoded (a lookup reads one row's slice of each stream).
/// </summary>
internal sealed class NestedNode
{
    public required JazminColumn Column { get; init; }

    /// <summary>A scalar stream; entry e is its value e - <see cref="Base"/>.</summary>
    public DecodedColumn? Leaf { get; init; }

    public int Base { get; init; }

    /// <summary>Lists and objects: the null bitmap over all their entries.</summary>
    public byte[]? Nulls { get; init; }

    public int Lo { get; init; }

    /// <summary>Entry e (Lo &lt;= e &lt;= Hi): its index among the entries that are not null (null: none is null).</summary>
    public int[]? Ranks { get; init; }

    /// <summary>Lists: the items of the c-th list that is not null are Starts[c - ChildLo] to Starts[c - ChildLo + 1].</summary>
    public int[]? Starts { get; init; }

    public int ChildLo { get; init; }

    public NestedNode? Items { get; init; }

    public NestedNode[]? Fields { get; init; }

    public bool IsNull(int entry) => Nulls is not null && (Nulls[entry >> 3] & (1 << (entry & 7))) != 0;

    public int Rank(int entry) => Ranks is null ? entry : Ranks[entry - Lo];

    public int ItemsFrom(int child) => Starts![child - ChildLo];

    public int ItemsTo(int child) => Starts![child - ChildLo + 1];
}

/// <summary>
/// A nested column of a decoded chunk, decoded with the chunk (whose bytes are then reused, so no copy is kept): for a
/// few rows (a lookup), only their slice of each stream; otherwise every row, with only the rows a query returns
/// (<c>wanted</c>) making their text. An untyped row shows a value as JSON; a typed read builds .NET objects straight
/// from the streams.
/// </summary>
internal sealed class NestedValues : DecodedColumn
{
    private readonly JazminColumn _column;
    private readonly int _rows;
    private readonly int _ordinal;
    private byte[]? _raw; // the chunk, while decoding
    private int _end;
    private JsonNode?[]? _json;
    private (Type Target, JazminSerializerSettings? Settings, Func<NestedNode, int, JazminSerializerSettings?, object?> Build)? _builder;

    /// <summary>The column's streams are raw[at..end).</summary>
    public NestedValues(JazminColumn column, int rows, byte[]? nulls, byte[] raw, int at, int end, bool[]? wanted, int ordinal) : base(nulls)
    {
        (_column, _rows, _ordinal, _raw, _end) = (column, rows, ordinal, raw, end);
        var (lo, hi, mask) = Span(wanted, rows);
        Root = Nest(column, rows, NullBits, lo, hi, mask, ref at);
        if (at != end) throw Bad("bytes left over");
        _raw = null;
    }

    private JazminFormatException Bad(string what) => new($"Chunk {_ordinal}: column '{_column.Name}': {what}");

    internal NestedNode Root { get; }

    /// <summary>The entries to decode: the span of the wanted ones when it is short (no mask needed), else all (with the mask).</summary>
    private static (int Lo, int Hi, bool[]? Mask) Span(bool[]? wanted, int entries)
    {
        if (wanted is null) return (0, entries, null);
        var lo = Array.IndexOf(wanted, true);
        if (lo < 0) return (0, 0, null);
        var hi = Array.LastIndexOf(wanted, true) + 1;
        return (hi - lo) * 4 <= entries ? (lo, hi, null) : (0, entries, wanted);
    }

    private static bool Bit(byte[] bits, int i) => (bits[i >> 3] & (1 << (i & 7))) != 0;

    /// <summary>A list's or object's children, for its entries [lo, hi) of <paramref name="entries"/> (bitmap: its nulls).</summary>
    private NestedNode Nest(JazminColumn c, int entries, byte[]? bitmap, int lo, int hi, bool[]? mask, ref int at)
    {
        int[]? ranks = null;
        int present = entries, childLo = lo, childHi = hi;
        var childMask = mask;
        if (bitmap is not null)
        {
            ranks = new int[hi - lo + 1];
            var k = 0;
            for (var e = 0; e < lo; e++) if (!Bit(bitmap, e)) k++;
            for (var e = lo; e <= hi; e++)
            {
                ranks[e - lo] = k;
                if (e < hi && !Bit(bitmap, e)) k++;
            }
            present = k;
            for (var e = hi; e < entries; e++) if (!Bit(bitmap, e)) present++;
            (childLo, childHi) = (ranks[0], ranks[hi - lo]);
            if (mask is not null)
            {
                childMask = new bool[present];
                for (int e = 0, r = 0; e < entries; e++)
                {
                    if (Bit(bitmap, e)) continue;
                    childMask[r++] = mask[e];
                }
            }
        }
        if (c.Type == JazminType.List)
        {
            // The lengths of every list that is not null place the items (with a mask, every list is in [childLo, childHi)).
            var end = Limit(at);
            var starts = ColumnarRange.Starts(_raw!, at, end, present, childLo, childHi, _ordinal, out var total);
            at = end;
            if (total > (long)(_end - at) * 8 + 8) throw Bad("list items do not match their size");
            bool[]? itemMask = null;
            if (childMask is not null)
            {
                itemMask = new bool[total];
                for (var i = 0; i < present; i++)
                    if (childMask[i]) Array.Fill(itemMask, true, starts[i], starts[i + 1] - starts[i]);
            }
            var items = Entry(c.Item!, total, starts[0], starts[^1], itemMask, ref at);
            return new NestedNode { Column = c, Nulls = bitmap, Lo = lo, Ranks = ranks, Starts = starts, ChildLo = childLo, Items = items };
        }
        var fields = new NestedNode[c.Fields!.Count];
        for (var i = 0; i < fields.Length; i++) fields[i] = Entry(c.Fields[i], present, childLo, childHi, childMask, ref at);
        return new NestedNode { Column = c, Nulls = bitmap, Lo = lo, Ranks = ranks, ChildLo = childLo, Fields = fields };
    }

    /// <summary>Where the stream that starts at <paramref name="at"/> ends.</summary>
    private int Limit(int at)
    {
        var reader = new ByteReader(_raw!, at, _end);
        var length = reader.VarUInt();
        if (length < 1 || length > (ulong)reader.Remaining) throw Bad("invalid stream length");
        return reader.Position + (int)length;
    }

    /// <summary>One stream (length, flags, nulls, body) over <paramref name="entries"/> entries, for [lo, hi).</summary>
    private NestedNode Entry(JazminColumn c, int entries, int lo, int hi, bool[]? mask, ref int at)
    {
        var end = Limit(at);
        if (entries > (long)(end - at) * 8 + 8) throw Bad($"field '{c.Name}': entry count does not match its size");
        var full = lo == 0 && hi == entries;
        if (!TypeNames.IsNested(c.Type))
        {
            var leaf = full ? Columnar.DecodeTyped(_raw!, end, [c.Type], entries, _ordinal, rows: mask, offset: at)[0]!
                : ColumnarRange.Decode(_raw!, at, end, c.Type, entries, lo, hi, _ordinal);
            at = end;
            return new NestedNode { Column = c, Leaf = leaf, Base = full ? 0 : lo };
        }
        var reader = new ByteReader(_raw!, at, end);
        reader.VarUInt();
        var flags = reader.Byte();
        if ((flags & 0x0f) != Nested.Encoding || (flags & 0xe0) != 0) throw Bad($"field '{c.Name}' has an invalid encoding");
        byte[]? bitmap = (flags & 0x10) != 0 ? reader.Bytes((entries + 7) >> 3).ToArray() : null;
        var inner = reader.Position;
        var node = Nest(c, entries, bitmap, lo, hi, mask, ref inner);
        if (inner != end) throw Bad($"field '{c.Name}': stream length does not match its contents");
        at = end;
        return node;
    }

    /// <summary>An untyped row's value: JSON, made once per row.</summary>
    protected override object Box(int row) => (_json ??= new JsonNode?[_rows])[row] ??= Json(Root, row) ?? throw Bad("a value that is not null has no content");

    internal static JsonNode? Json(NestedNode node, int entry)
    {
        if (node.Leaf is { } leaf) return Nested.ToJson(node.Column.Type, leaf.Get(entry - node.Base));
        if (node.IsNull(entry)) return null;
        var k = node.Rank(entry);
        if (node.Items is { } items)
        {
            var array = new JsonArray();
            for (var i = node.ItemsFrom(k); i < node.ItemsTo(k); i++) array.Add(Json(items, i));
            return array;
        }
        var obj = new JsonObject();
        foreach (var field in node.Fields!) obj[field.Column.Name] = Json(field, k);
        return obj;
    }

    /// <summary>A row's value as a .NET object of <paramref name="target"/> (a list, an object, or anything JSON can be read into).</summary>
    public object? Read(int row, Type target, JazminSerializerSettings? settings)
    {
        if (IsNull(row)) return null;
        if (_builder is not { } b || b.Target != target || !ReferenceEquals(b.Settings, settings))
            _builder = b = (target, settings, NestedBuilder.For(_column, target, settings));
        return b.Build(Root, row, settings);
    }

    public override void ReadPlain(int row, ByteReader reader, StringPool? strings) => throw new InvalidOperationException("Nested columns have no plain values");
}

/// <summary>
/// Builds .NET objects from a decoded nested column: one compiled function per structure and type, reading the typed
/// values directly (no JSON, no dictionary per object). Types it cannot build that way (constructors with parameters,
/// converters, populated defaults) go through JSON and the serializer's map.
/// </summary>
internal static class NestedBuilder
{
    private delegate object? Builder(NestedNode node, int entry, JazminSerializerSettings? settings);

    private static readonly PerSettings<(string Shape, Type Target), Func<NestedNode, int, JazminSerializerSettings?, object?>> Cache = new();

    public static Func<NestedNode, int, JazminSerializerSettings?, object?> For(JazminColumn column, Type target, JazminSerializerSettings? settings) =>
        Cache.For(settings).GetOrAdd((TypeNames.Describe(column), target), static (key, a) => Build(a.Column, key.Target, a.Settings), (Column: column, Settings: settings));

    private static Func<NestedNode, int, JazminSerializerSettings?, object?> Build(JazminColumn column, Type target, JazminSerializerSettings? settings)
    {
        var t = Nullable.GetUnderlyingType(target) ?? target;
        if (column.Type == JazminType.List && ElementType(t) is { } element)
        {
            var item = ItemReader(column.Item!, element, settings);
            var make = typeof(NestedBuilder).GetMethod(nameof(ListOf), BindingFlags.NonPublic | BindingFlags.Static)!.MakeGenericMethod(element)
                .CreateDelegate<Func<NestedNode, int, Func<NestedNode, int, JazminSerializerSettings?, object?>, JazminSerializerSettings?, bool, object>>();
            var array = t.IsArray;
            return (node, entry, s) => node.IsNull(entry) ? null : make(node, entry, item, s, array);
        }
        if (column.Type == JazminType.Object && CompileObject(column, t, settings) is { } compiled) return compiled;
        return (node, entry, s) => node.IsNull(entry) ? null : Nested.FromJson(NestedValues.Json(node, entry), target, s);
    }

    /// <summary>A list's items as List&lt;T&gt; (or T[]).</summary>
    private static object ListOf<T>(NestedNode node, int entry, Func<NestedNode, int, JazminSerializerSettings?, object?> item, JazminSerializerSettings? settings, bool array)
    {
        var k = node.Rank(entry);
        var (from, to) = (node.ItemsFrom(k), node.ItemsTo(k));
        var items = node.Items!;
        if (array)
        {
            var result = new T[to - from];
            for (var i = from; i < to; i++) result[i - from] = (T)item(items, i, settings)!;
            return result;
        }
        var list = new List<T>(to - from);
        for (var i = from; i < to; i++) list.Add((T)item(items, i, settings)!);
        return list;
    }

    /// <summary>Reads the items of a list: scalars through a compiled read, lists and objects through their builder.</summary>
    private static Func<NestedNode, int, JazminSerializerSettings?, object?> ItemReader(JazminColumn item, Type element, JazminSerializerSettings? settings)
    {
        if (TypeNames.IsNested(item.Type)) return For(item, element, settings);
        var node = Expression.Parameter(typeof(NestedNode), "node");
        var entry = Expression.Parameter(typeof(int), "entry");
        var s = Expression.Parameter(typeof(JazminSerializerSettings), "settings");
        var read = LeafRead(node, entry, item.Type, element, s);
        return Expression.Lambda<Func<NestedNode, int, JazminSerializerSettings?, object?>>(Expression.Convert(read, typeof(object)), node, entry, s).Compile();
    }

    /// <summary>A scalar field's value for an entry of its parent's children (null as the member type's default).</summary>
    private static Expression LeafRead(Expression node, Expression entry, JazminType type, Type target, ParameterExpression settings)
    {
        var leaf = Expression.Property(node, nameof(NestedNode.Leaf));
        var index = Expression.Subtract(entry, Expression.Property(node, nameof(NestedNode.Base)));
        var holder = type switch
        {
            JazminType.Int or JazminType.DateTime => typeof(LongValues),
            JazminType.Float => typeof(DoubleValues),
            JazminType.Bool => typeof(BoolValues),
            JazminType.String or JazminType.Decimal => typeof(StringValues),
            JazminType.Json => typeof(JsonValues),
            _ => typeof(BlobValues),
        };
        var t = Nullable.GetUnderlyingType(target) ?? target;
        Expression value;
        if (type == JazminType.Json) value = Expression.Convert(Expression.Call(leaf, typeof(DecodedColumn).GetMethod(nameof(DecodedColumn.Get))!, index), typeof(JsonNode));
        else
        {
            value = Expression.ArrayIndex(Expression.Property(Expression.Convert(leaf, holder), "Values"), index);
            if (type == JazminType.DateTime) value = Expression.Call(typeof(Values).GetMethod(nameof(Values.FromEpochMs))!, value);
            else if (type == JazminType.Binary) value = Expression.Convert(value, typeof(byte[]));
        }
        var converted = type == JazminType.Decimal && t == typeof(decimal)
            ? Expression.Convert(Expression.Call(typeof(NestedBuilder).GetMethod(nameof(ToDecimal), BindingFlags.NonPublic | BindingFlags.Static)!, value, settings), target)
            : TypeMap.TypedConvert(value, type, target, settings);
        var isNull = Expression.Call(leaf, nameof(DecodedColumn.IsNull), null, index);
        return Expression.Condition(isNull, Expression.Default(target), converted);
    }

    /// <summary>An object's builder, compiled: new T(), then each member from its field. Null when the type needs more.</summary>
    private static Func<NestedNode, int, JazminSerializerSettings?, object?>? CompileObject(JazminColumn column, Type t, JazminSerializerSettings? settings)
    {
        if (t.GetConstructor(Type.EmptyTypes) is not { } ctor || Nested.MapOf(t, settings) is not { } map || !map.PlainMembers) return null;
        var node = Expression.Parameter(typeof(NestedNode), "node");
        var entry = Expression.Parameter(typeof(int), "entry");
        var s = Expression.Parameter(typeof(JazminSerializerSettings), "settings");
        var item = Expression.Variable(t, "item");
        var k = Expression.Variable(typeof(int), "k");
        var body = new List<Expression>
        {
            Expression.Assign(k, Expression.Call(node, typeof(NestedNode).GetMethod(nameof(NestedNode.Rank))!, entry)),
            Expression.Assign(item, Expression.New(ctor)),
        };
        var fields = column.Fields!;
        for (var i = 0; i < fields.Count; i++)
        {
            if (map.MemberProperty(fields[i].Name) is not { CanWrite: true } property || property.SetMethod?.IsPublic != true) continue;
            var field = Expression.ArrayIndex(Expression.Property(node, nameof(NestedNode.Fields)), Expression.Constant(i));
            var value = TypeNames.IsNested(fields[i].Type)
                ? Expression.Convert(Expression.Invoke(Expression.Constant(For(fields[i], property.PropertyType, settings)), field, k, s), property.PropertyType)
                : LeafRead(field, k, fields[i].Type, property.PropertyType, s);
            body.Add(Expression.Assign(Expression.Property(item, property), value));
        }
        body.Add(Expression.Convert(item, typeof(object)));
        var block = Expression.Block(typeof(object), [item, k], body);
        var whenNull = Expression.Call(node, typeof(NestedNode).GetMethod(nameof(NestedNode.IsNull))!, entry);
        return Expression.Lambda<Func<NestedNode, int, JazminSerializerSettings?, object?>>(
            Expression.Condition(whenNull, Expression.Constant(null, typeof(object)), block), node, entry, s).Compile();
    }

    /// <summary>A stored decimal as a .NET decimal; one it cannot hold fails as for other members.</summary>
    private static decimal ToDecimal(string text, JazminSerializerSettings? settings) =>
        decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out var value) ? value : (decimal)TypeMap.Convert(text, typeof(decimal), settings)!;

    private static Type? ElementType(Type t)
    {
        if (t.IsArray) return t.GetArrayRank() == 1 ? t.GetElementType() : null;
        if (!t.IsGenericType || t.GetGenericArguments().Length != 1) return null;
        var element = t.GetGenericArguments()[0];
        return t.IsAssignableFrom(typeof(List<>).MakeGenericType(element)) ? element : null;
    }
}
