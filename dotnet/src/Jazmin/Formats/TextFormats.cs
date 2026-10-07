using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using Jazmin.Query;
using Jazmin.Serialization;
using Formatting = Jazmin.Serialization.Formatting;

namespace Jazmin.Formats;

/// <summary>Rows in a format-neutral shape: column definitions plus values in column order.</summary>
public sealed record TabularData(IReadOnlyList<JazminColumn> Columns, IReadOnlyList<object?[]> Rows);

internal static class TextValues
{
    public static string ToText(JazminType type, object value) => value switch
    {
        DateTime dt => dt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        byte[] bytes => System.Convert.ToBase64String(bytes),
        JsonNode node => node.ToJsonString(),
        bool b => b ? "true" : "false",
        double d => d.ToString("R", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? "",
    };

    private static readonly Regex Int = new(@"^-?\d+$", RegexOptions.Compiled);
    private static readonly Regex Float = new(@"^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$", RegexOptions.Compiled);

    /// <summary>A column is int/float/bool only when every present value matches; otherwise string.</summary>
    public static TabularData FromText(IReadOnlyList<string> names, IReadOnlyList<string?[]> rows, bool inferTypes)
    {
        var inference = new TextColumnInference(names, inferTypes);
        foreach (var row in rows) inference.Add(row);
        var columns = inference.Columns();
        var values = rows.Select(row => ToValues(columns, row)).ToList();
        return new TabularData(columns, values);
    }

    /// <summary>A text record as values of <paramref name="columns"/> (positional; a missing field is null).</summary>
    public static object?[] ToValues(IReadOnlyList<JazminColumn> columns, string?[] row)
    {
        var values = new object?[columns.Count];
        for (var i = 0; i < values.Length; i++) values[i] = FromText(columns[i].Type, i < row.Length ? row[i] : null);
        return values;
    }

    /// <summary>The type a present text value is inferred as: int (fitting a long), float, bool or string.</summary>
    public static JazminType TypeOf(string v) =>
        Int.IsMatch(v) && long.TryParse(v, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _) ? JazminType.Int
        : Float.IsMatch(v) ? JazminType.Float
        : v.Equals("true", StringComparison.OrdinalIgnoreCase) || v.Equals("false", StringComparison.OrdinalIgnoreCase) ? JazminType.Bool
        : JazminType.String;

    /// <summary>A text value as a value of a column of <paramref name="type"/>, the reverse of <see cref="ToText"/>.</summary>
    public static object? FromText(JazminType type, string? text) => text is null ? null : type switch
    {
        JazminType.Int => long.Parse(text, CultureInfo.InvariantCulture),
        JazminType.Float => double.Parse(text, CultureInfo.InvariantCulture),
        JazminType.Bool => text.Equals("true", StringComparison.OrdinalIgnoreCase),
        JazminType.Binary => System.Convert.FromBase64String(text),
        JazminType.Json => JsonNode.Parse(text),
        _ => text, // strings, and dates and decimals, which the writer reads from their text
    };
}

/// <summary>
/// Infers column types from text records one at a time, so a file can be read without loading it. A column is
/// int/float/bool only when every present value matches; otherwise string.
/// </summary>
internal sealed class TextColumnInference(IReadOnlyList<string> names, bool inferTypes)
{
    private readonly List<string> _names = [.. names];
    private readonly List<JazminType?> _types = [.. new JazminType?[names.Count]];
    private readonly List<bool> _nullable = [.. new bool[names.Count]];

    public int Width => _names.Count;

    /// <summary>A column first seen after <paramref name="nullable"/> (some records came before it): XML rows name their columns.</summary>
    public void Grow(string name, bool nullable)
    {
        _names.Add(name);
        _types.Add(null);
        _nullable.Add(nullable);
    }

    public void Add(string?[] record)
    {
        for (var i = 0; i < _types.Count; i++)
        {
            var v = i < record.Length ? record[i] : null;
            if (v is null)
            {
                _nullable[i] = true;
                continue;
            }
            var type = _types[i];
            if (type == JazminType.String) continue; // a string column stays one
            var t = inferTypes ? TextValues.TypeOf(v) : JazminType.String;
            _types[i] = type is null || type == t ? t : (type, t) is (JazminType.Int, JazminType.Float) or (JazminType.Float, JazminType.Int) ? JazminType.Float : JazminType.String;
        }
    }

    public List<JazminColumn> Columns() =>
        _names.Select((name, i) => new JazminColumn(name, _types[i] ?? JazminType.String) { Nullable = _nullable[i] }).ToList();
}

/// <summary>JSON array-of-objects conversion (System.Text.Json; no third-party dependency).</summary>
public static class JsonFormat
{
    private static readonly JsonWriterOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly JsonWriterOptions Indented = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, Indented = true };

    /// <summary>Streams rows as a JSON array. int and decimal values are written exactly.</summary>
    public static void Write(Stream output, IReadOnlyList<JazminColumn> columns, IEnumerable<IReadOnlyDictionary<string, object?>> rows,
        Formatting formatting = Formatting.None, NullValueHandling nulls = NullValueHandling.Include)
    {
        using var w = new Utf8JsonWriter(output, WriterOptions(formatting));
        w.WriteStartArray();
        int[]? positions = null; // a query's rows: values read by position, not looked up by name (3 times faster on 300 columns)
        IReadOnlyList<JazminColumn>? positionsOf = null;
        foreach (var row in rows)
        {
            if (row is JazminRow r)
            {
                if (!ReferenceEquals(positionsOf, r.Columns)) (positions, positionsOf) = (Positions(columns, r), r.Columns);
                WriteRow(w, columns, r, positions!, nulls);
            }
            else
            {
                WriteRow(w, columns, row, nulls);
            }
            if (w.BytesPending > 65536) w.Flush();
        }
        w.WriteEndArray();
    }

    internal static JsonWriterOptions WriterOptions(Formatting formatting) => formatting == Formatting.Indented ? Indented : Compact;

    /// <summary>One row as a JSON object (also for <see cref="JazminJsonStream"/>).</summary>
    internal static void WriteRow(Utf8JsonWriter w, IReadOnlyList<JazminColumn> columns, IReadOnlyDictionary<string, object?> row, NullValueHandling nulls)
    {
        w.WriteStartObject();
        foreach (var c in columns)
        {
            row.TryGetValue(c.Name, out var value);
            if (value is null && nulls == NullValueHandling.Ignore) continue;
            w.WritePropertyName(c.Name);
            WriteValue(w, c.Type, value);
        }
        w.WriteEndObject();
    }

    /// <summary>One row of a query as a JSON object, its values read by position (see <see cref="Positions"/>), not looked up by name.</summary>
    internal static void WriteRow(Utf8JsonWriter w, IReadOnlyList<JazminColumn> columns, JazminRow row, int[] positions, NullValueHandling nulls)
    {
        w.WriteStartObject();
        for (var i = 0; i < columns.Count; i++)
        {
            var value = positions[i] >= 0 ? row.ValueAt(positions[i]) : null;
            if (value is null && nulls == NullValueHandling.Ignore) continue;
            w.WritePropertyName(columns[i].Name);
            WriteValue(w, columns[i].Type, value);
        }
        w.WriteEndObject();
    }

    /// <summary>
    /// Each column's position in a query's rows, worked out once from its first row; -1 where the row does not have the
    /// column (not selected, or another table's), which is written as null, as a lookup by name would find nothing.
    /// </summary>
    internal static int[] Positions(IReadOnlyList<JazminColumn> columns, JazminRow row)
    {
        var all = row.Columns;
        return columns.Select(c =>
        {
            if (!row.ContainsKey(c.Name)) return -1;
            for (var i = 0; i < all.Count; i++) if (ReferenceEquals(all[i], c) || all[i].Name == c.Name) return i;
            return -1;
        }).ToArray();
    }

    /// <summary>The columns a query's rows are written with: those it selects, in that order, or every visible one.</summary>
    internal static IReadOnlyList<JazminColumn> ColumnsOf(JazminReader reader, JazminQueryOptions? options) =>
        options?.Select is { } select
            ? select.Select(name => reader.Columns.FirstOrDefault(c => c.Name == name) ?? throw new JazminValidationException($"Unknown column '{name}'")).ToList()
            : reader.Columns;

    internal static void WriteValue(Utf8JsonWriter w, JazminType type, object? value)
    {
        switch (value)
        {
            case null: w.WriteNullValue(); break;
            case bool b: w.WriteBooleanValue(b); break;
            case long l: w.WriteNumberValue(l); break;
            case double d when double.IsFinite(d): w.WriteNumberValue(d); break;
            case double: w.WriteNullValue(); break; // NaN/Infinity cannot be represented in JSON
            case string s when type == JazminType.Decimal: w.WriteRawValue(s); break;
            case string s: w.WriteStringValue(s); break;
            case DateTime: w.WriteStringValue(TextValues.ToText(type, value)); break;
            case byte[] bytes: w.WriteBase64StringValue(bytes); break;
            case JsonNode node: node.WriteTo(w); break;
            default: w.WriteStringValue(value.ToString()); break;
        }
    }

    /// <summary>Parses a JSON array of objects (or one object) and infers the schema.</summary>
    public static TabularData Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var items = doc.RootElement.ValueKind == JsonValueKind.Array
            ? doc.RootElement.EnumerateArray().ToList()
            : new List<JsonElement> { doc.RootElement };
        var columns = InferColumns(items);
        return new TabularData(columns, items.Select(item => ToValues(columns, item)).ToList());
    }

    /// <summary>
    /// Streams the objects of a JSON array file or a JSON Lines file (one object per line)
    /// without loading the whole file. Each element is independent and can be released after use.
    /// </summary>
    public static IEnumerable<JsonElement> ReadObjects(string path)
    {
        if (StartsWithArray(path))
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, FileOptions.SequentialScan);
            foreach (var element in JsonSerializer.DeserializeAsyncEnumerable<JsonElement>(stream).ToBlockingEnumerable())
                yield return element;
            yield break;
        }
        using var reader = new StreamReader(path, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        while (reader.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            using var doc = JsonDocument.Parse(line);
            yield return doc.RootElement.Clone();
        }
    }

    private static bool StartsWithArray(string path)
    {
        using var reader = new StreamReader(path, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        int ch;
        while ((ch = reader.Read()) >= 0)
            if (!char.IsWhiteSpace((char)ch)) return ch == '[';
        return false;
    }

    /// <summary>Infers columns from JSON objects in one pass (works on a stream of elements).</summary>
    internal static List<JazminColumn> InferColumns(IEnumerable<JsonElement> items)
    {
        var names = new List<string>();
        var types = new Dictionary<string, JazminType?>();
        var present = new Dictionary<string, long>();
        var nullable = new HashSet<string>();
        long count = 0;
        foreach (var item in items)
        {
            if (item.ValueKind != JsonValueKind.Object) throw new JazminValidationException($"JSON item {count} is not an object");
            foreach (var p in item.EnumerateObject())
            {
                if (!types.ContainsKey(p.Name))
                {
                    names.Add(p.Name);
                    types[p.Name] = null;
                    present[p.Name] = 0;
                    if (count > 0) nullable.Add(p.Name);
                }
                if (p.Value.ValueKind == JsonValueKind.Null)
                {
                    nullable.Add(p.Name);
                    continue;
                }
                present[p.Name]++;
                types[p.Name] = Merge(types[p.Name], TypeOf(p.Value));
            }
            count++;
        }
        return names.Select(name => new JazminColumn(name, types[name] ?? JazminType.String)
        {
            Nullable = nullable.Contains(name) || present[name] < count,
        }).ToList();
    }

    /// <summary>Converts one JSON object to values in column order.</summary>
    internal static object?[] ToValues(IReadOnlyList<JazminColumn> columns, JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object) throw new JazminValidationException("JSON item is not an object");
        var values = new object?[columns.Count];
        for (var i = 0; i < columns.Count; i++)
            values[i] = item.TryGetProperty(columns[i].Name, out var v) && v.ValueKind != JsonValueKind.Null ? Convert(columns[i].Type, v) : null;
        return values;
    }

    private static JazminType TypeOf(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.True or JsonValueKind.False => JazminType.Bool,
        JsonValueKind.Number => v.TryGetInt64(out _) ? JazminType.Int : JazminType.Float,
        JsonValueKind.String => JazminType.String,
        _ => JazminType.Json,
    };

    internal static JazminType Merge(JazminType? a, JazminType b) => (a, b) switch
    {
        (null, _) => b,
        _ when a == b => b,
        (JazminType.Int, JazminType.Float) or (JazminType.Float, JazminType.Int) => JazminType.Float,
        _ => JazminType.Json, // mixed types are preserved exactly as JSON
    };

    // Arms are cast to object: otherwise C# picks JsonNode as the common type via its implicit conversions.
    private static object? Convert(JazminType type, JsonElement v) => type switch
    {
        JazminType.Bool => (object)v.GetBoolean(),
        JazminType.Int => (object)v.GetInt64(),
        JazminType.Float => (object)v.GetDouble(),
        JazminType.String => (object?)v.GetString(),
        _ => (object?)JsonNode.Parse(v.GetRawText()),
    };
}

/// <summary>RFC 4180 CSV. An unquoted empty field is null; a quoted empty field ("") is an empty string.</summary>
public static class CsvFormat
{
    public static void Write(TextWriter output, IReadOnlyList<JazminColumn> columns, IEnumerable<IReadOnlyDictionary<string, object?>> rows, char delimiter = ',')
    {
        output.Write(string.Join(delimiter, columns.Select(c => Quote(c.Name, delimiter))));
        output.Write("\r\n");
        foreach (var row in rows)
        {
            for (var i = 0; i < columns.Count; i++)
            {
                if (i > 0) output.Write(delimiter);
                row.TryGetValue(columns[i].Name, out var value);
                if (value is not null) output.Write(Quote(TextValues.ToText(columns[i].Type, value), delimiter));
            }
            output.Write("\r\n");
        }
    }

    private static string Quote(string text, char delimiter) =>
        text.Length == 0 || text.IndexOfAny(new[] { '"', '\r', '\n', delimiter }) >= 0 || text.Trim() != text
            ? $"\"{text.Replace("\"", "\"\"")}\""
            : text;

    public static TabularData Parse(string text, char delimiter = ',', bool inferTypes = true)
    {
        var records = ReadRecords(new StringReader(text.TrimStart('\uFEFF')), delimiter).ToList();
        if (records.Count == 0) throw new JazminValidationException("CSV has no header row");
        var names = HeaderNames(records[0]);
        var data = records.Skip(1).ToList();
        for (var n = 0; n < data.Count; n++) CheckFields(data[n], names, n);
        return TextValues.FromText(names, data, inferTypes);
    }

    /// <summary>Column names from a CSV header record (an empty name becomes column1, column2, ...).</summary>
    internal static List<string> HeaderNames(string?[] header) => header.Select((h, i) => h ?? $"column{i + 1}").ToList();

    /// <summary>Throws when a data record (<paramref name="n"/>, from 0) has more fields than the header.</summary>
    internal static void CheckFields(string?[] record, IReadOnlyList<string> names, long n)
    {
        if (record.Length > names.Count) throw new JazminValidationException($"CSV line {n + 2} has more fields than the header");
    }

    /// <summary>
    /// The records of CSV text (RFC 4180), read from <paramref name="reader"/> a buffer at a time: a file of any size
    /// is never loaded. Fields are strings, or null for an unquoted empty field.
    /// </summary>
    public static IEnumerable<string?[]> ReadRecords(TextReader reader, char delimiter = ',')
    {
        var buffer = new char[1 << 16];
        int length = 0, at = 0;
        var record = new List<string?>();
        var field = new StringBuilder();
        bool quoted = false, inQuotes = false;
        while (true)
        {
            if (at == length)
            {
                length = reader.Read(buffer, 0, buffer.Length);
                at = 0;
                if (length == 0) break;
            }
            var ch = buffer[at++];
            if (inQuotes)
            {
                if (ch != '"') field.Append(ch);
                else if (Peek() == '"')
                {
                    field.Append('"');
                    at++;
                }
                else inQuotes = false;
                continue;
            }
            if (ch == '"' && field.Length == 0 && !quoted)
            {
                inQuotes = true;
                quoted = true;
            }
            else if (ch == delimiter) EndField();
            else if (ch is '\r' or '\n')
            {
                EndField();
                yield return record.ToArray();
                record.Clear();
                if (ch == '\r' && Peek() == '\n') at++;
            }
            else field.Append(ch);
        }
        if (inQuotes) throw new JazminValidationException("CSV ends inside a quoted field");
        if (field.Length > 0 || quoted || record.Count > 0)
        {
            EndField();
            yield return record.ToArray();
        }

        // The next character without taking it (reading the next buffer if needed), or -1 at the end.
        int Peek()
        {
            if (at == length)
            {
                length = reader.Read(buffer, 0, buffer.Length);
                at = 0;
                if (length == 0) return -1;
            }
            return buffer[at];
        }

        void EndField()
        {
            record.Add(quoted || field.Length > 0 ? field.ToString() : null);
            field.Clear();
            quoted = false;
        }
    }
}

/// <summary>
/// Collects XML text that declares UTF-8, the encoding it is saved and sent in (as the JavaScript library declares).
/// An XmlWriter declares its TextWriter's encoding, and a plain StringWriter's is UTF-16: saved as UTF-8, that text is
/// refused by readers that trust the declaration.
/// </summary>
internal sealed class Utf8StringWriter() : StringWriter(CultureInfo.InvariantCulture)
{
    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    public override Encoding Encoding => Utf8;
}

/// <summary>
/// Canonical tabular XML: &lt;jazmin&gt;&lt;row&gt;&lt;name&gt;Ann&lt;/name&gt;&lt;/row&gt;&lt;/jazmin&gt;.
/// Nulls are omitted; names that are not valid XML names use &lt;field name="..."&gt;.
/// </summary>
public static class XmlFormat
{
    private static readonly Regex XmlName = new(@"^[A-Za-z_][A-Za-z0-9_.-]*$", RegexOptions.Compiled);

    public static void Write(TextWriter output, IReadOnlyList<JazminColumn> columns, IEnumerable<IReadOnlyDictionary<string, object?>> rows)
    {
        using var w = XmlWriter.Create(output, new XmlWriterSettings { Indent = true, IndentChars = "  ", Encoding = new UTF8Encoding(false) });
        w.WriteStartDocument();
        w.WriteStartElement("jazmin");
        foreach (var row in rows)
        {
            w.WriteStartElement("row");
            foreach (var c in columns)
            {
                if (!row.TryGetValue(c.Name, out var value) || value is null) continue;
                if (XmlName.IsMatch(c.Name) && !c.Name.StartsWith("xml", StringComparison.OrdinalIgnoreCase))
                {
                    w.WriteStartElement(c.Name);
                }
                else
                {
                    w.WriteStartElement("field");
                    w.WriteAttributeString("name", c.Name);
                }
                w.WriteString(TextValues.ToText(c.Type, value));
                w.WriteEndElement();
            }
            w.WriteEndElement();
        }
        w.WriteEndElement();
        w.WriteEndDocument();
    }

    public static TabularData Parse(string xml, bool inferTypes = true)
    {
        var names = new List<string>();
        using var reader = XmlReader.Create(new StringReader(xml), ReaderSettings);
        var records = ReadRows(reader, names).ToList();
        var rows = records.Select(r => Record(r, names.Count)).ToList();
        return TextValues.FromText(names, rows, inferTypes);
    }

    internal static readonly XmlReaderSettings ReaderSettings = new() { IgnoreComments = true, DtdProcessing = DtdProcessing.Prohibit };

    /// <summary>A row (column position to text) as a positional record over the first <paramref name="width"/> columns.</summary>
    internal static string?[] Record(Dictionary<int, string> row, int width)
    {
        var record = new string?[width];
        foreach (var (i, text) in row) record[i] = text;
        return record;
    }

    /// <summary>
    /// The rows of canonical tabular XML, read from <paramref name="reader"/> as it goes (a file of any size is never
    /// loaded): each a map from column position to its text. <paramref name="names"/> fills with the columns in order
    /// of appearance.
    /// </summary>
    public static IEnumerable<Dictionary<int, string>> ReadRows(XmlReader reader, List<string> names)
    {
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        reader.MoveToContent();
        if (reader.IsEmptyElement) yield break;
        reader.ReadStartElement(); // root
        while (reader.MoveToContent() == XmlNodeType.Element)
        {
            var record = new Dictionary<int, string>();
            if (reader.IsEmptyElement)
            {
                reader.Read();
            }
            else
            {
                reader.ReadStartElement(); // row
                while (reader.MoveToContent() == XmlNodeType.Element)
                {
                    var name = reader.LocalName == "field" && reader.GetAttribute("name") is { } attr ? attr : reader.LocalName;
                    var value = reader.ReadElementContentAsString();
                    if (!index.TryGetValue(name, out var i))
                    {
                        index[name] = i = names.Count;
                        names.Add(name);
                    }
                    record[i] = value;
                }
                reader.ReadEndElement();
            }
            yield return record;
        }
    }
}
