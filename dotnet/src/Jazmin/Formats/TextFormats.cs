using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
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
        var columns = new List<JazminColumn>();
        for (var i = 0; i < names.Count; i++)
        {
            string? type = null;
            var nullable = false;
            foreach (var row in rows)
            {
                var v = i < row.Length ? row[i] : null;
                if (v is null)
                {
                    nullable = true;
                    continue;
                }
                var t = !inferTypes ? "string"
                    : Int.IsMatch(v) && long.TryParse(v, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _) ? "int"
                    : Float.IsMatch(v) ? "float"
                    : v.Equals("true", StringComparison.OrdinalIgnoreCase) || v.Equals("false", StringComparison.OrdinalIgnoreCase) ? "bool"
                    : "string";
                type = type is null || type == t ? t : (type, t) is ("int", "float") or ("float", "int") ? "float" : "string";
            }
            columns.Add(new JazminColumn(names[i], TypeNames.Parse(type ?? "string")) { Nullable = nullable });
        }
        var values = rows.Select(row => columns.Select((c, i) => Convert(c.Type, i < row.Length ? row[i] : null)).ToArray()).ToList();
        return new TabularData(columns, values);
    }

    private static object? Convert(JazminType type, string? text) => text is null ? null : type switch
    {
        JazminType.Int => long.Parse(text, CultureInfo.InvariantCulture),
        JazminType.Float => double.Parse(text, CultureInfo.InvariantCulture),
        JazminType.Bool => text.Equals("true", StringComparison.OrdinalIgnoreCase),
        _ => text,
    };
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
        using var w = new Utf8JsonWriter(output, formatting == Formatting.Indented ? Indented : Compact);
        w.WriteStartArray();
        foreach (var row in rows)
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
            if (w.BytesPending > 65536) w.Flush();
        }
        w.WriteEndArray();
    }

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
        var records = ParseRecords(text.TrimStart('﻿'), delimiter);
        if (records.Count == 0) throw new JazminValidationException("CSV has no header row");
        var names = records[0].Select((h, i) => h ?? $"column{i + 1}").ToList();
        var data = records.Skip(1).ToList();
        for (var n = 0; n < data.Count; n++)
            if (data[n].Length > names.Count) throw new JazminValidationException($"CSV line {n + 2} has more fields than the header");
        return TextValues.FromText(names, data, inferTypes);
    }

    private static List<string?[]> ParseRecords(string text, char delimiter)
    {
        var records = new List<string?[]>();
        var record = new List<string?>();
        var field = new StringBuilder();
        bool quoted = false, inQuotes = false;
        void EndField()
        {
            record.Add(quoted || field.Length > 0 ? field.ToString() : null);
            field.Clear();
            quoted = false;
        }
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (inQuotes)
            {
                if (ch == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"')
                    {
                        field.Append('"');
                        i++;
                    }
                    else inQuotes = false;
                }
                else field.Append(ch);
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
                records.Add(record.ToArray());
                record.Clear();
                if (ch == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
            }
            else field.Append(ch);
        }
        if (inQuotes) throw new JazminValidationException("CSV ends inside a quoted field");
        if (field.Length > 0 || quoted || record.Count > 0)
        {
            EndField();
            records.Add(record.ToArray());
        }
        return records;
    }
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
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        var records = new List<Dictionary<int, string>>();
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { IgnoreComments = true, DtdProcessing = DtdProcessing.Prohibit });
        reader.MoveToContent();
        if (reader.IsEmptyElement) return TextValues.FromText(names, new List<string?[]>(), inferTypes);
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
            records.Add(record);
        }
        var rows = records.Select(r => names.Select((_, i) => r.TryGetValue(i, out var v) ? v : null).ToArray()).ToList();
        return TextValues.FromText(names, rows, inferTypes);
    }
}
