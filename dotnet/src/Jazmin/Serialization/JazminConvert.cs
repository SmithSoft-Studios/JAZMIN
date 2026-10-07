using System.Collections;
using System.Text;
using System.Text.Json.Nodes;
using Jazmin.Formats;
using Jazmin.Query;

namespace Jazmin.Serialization;

/// <summary>
/// One-line conversions, shaped like Newtonsoft's JsonConvert:
/// <code>
/// byte[] bytes = JazminConvert.SerializeObject(people);
/// List&lt;Person&gt; back = JazminConvert.DeserializeObject&lt;List&lt;Person&gt;&gt;(bytes);
/// </code>
/// </summary>
public static class JazminConvert
{
    /// <summary>Serializes a collection (one row per item) or a single object (one row) to JAZMIN bytes.</summary>
    public static byte[] SerializeObject(object value, JazminSerializerSettings? settings = null)
    {
        using var stream = new MemoryStream();
        new JazminSerializer(settings).Serialize(stream, value);
        return stream.ToArray();
    }

    /// <summary>
    /// Deserializes JAZMIN bytes. <typeparamref name="T"/> may be a collection
    /// (List&lt;X&gt;, X[], IEnumerable&lt;X&gt;...) or a single type (returns the first row, or default).
    /// </summary>
    public static T? DeserializeObject<T>(byte[] data, JazminSerializerSettings? settings = null)
    {
        using var stream = new MemoryStream(data, writable: false);
        return new JazminSerializer(settings).Deserialize<T>(stream);
    }

    /// <summary>Untyped read: every row as a name/value dictionary.</summary>
    public static List<JazminRow> DeserializeObject(byte[] data, JazminSerializerSettings? settings = null) =>
        DeserializeObject<List<JazminRow>>(data, settings)!;

    // ---- Format conversion -------------------------------------------------------------

    /// <summary>JAZMIN -> JSON text (optionally filtered).</summary>
    public static string ToJson(byte[] data, JazminSerializerSettings? settings = null, JazminFilter? filter = null)
    {
        using var reader = JazminReader.Open(data, settings?.ToReadOptions());
        using var output = new MemoryStream();
        JsonFormat.Write(output, reader.Columns, reader.Find(filter), settings?.Formatting ?? Formatting.None,
            settings?.NullValueHandling ?? NullValueHandling.Include);
        return Encoding.UTF8.GetString(output.ToArray());
    }

    /// <summary>JSON text (array of objects) -> JAZMIN, inferring the schema.</summary>
    public static byte[] FromJson(string json, JazminSerializerSettings? settings = null) => Write(JsonFormat.Parse(json), settings);

    /// <summary>
    /// Converts a JSON file of any size (JSON array of objects, or JSON Lines) to a JAZMIN file
    /// without loading it. The input is read twice (schema, then rows) unless
    /// <paramref name="columns"/> is supplied. If the input fails part-way the output file is deleted.
    /// </summary>
    public static void FromJsonFile(string inputPath, string outputPath, JazminSerializerSettings? settings = null,
        IReadOnlyList<JazminColumn>? columns = null)
    {
        settings ??= new JazminSerializerSettings();
        columns ??= JsonFormat.InferColumns(JsonFormat.ReadObjects(inputPath));
        var writer = JazminWriter.Create(outputPath, settings.ApplyIndexes(columns), settings.ToWriteOptions());
        try
        {
            foreach (var item in JsonFormat.ReadObjects(inputPath)) writer.WriteValues(JsonFormat.ToValues(columns, item));
            writer.Finish();
        }
        catch
        {
            writer.Abort();
            File.Delete(outputPath);
            throw;
        }
    }

    public static string ToCsv(byte[] data, JazminSerializerSettings? settings = null, JazminFilter? filter = null)
    {
        using var reader = JazminReader.Open(data, settings?.ToReadOptions());
        var output = new StringWriter();
        CsvFormat.Write(output, reader.Columns, reader.Find(filter));
        return output.ToString();
    }

    public static byte[] FromCsv(string csv, JazminSerializerSettings? settings = null, bool inferTypes = true) =>
        Write(CsvFormat.Parse(csv, inferTypes: inferTypes), settings);

    /// <summary>
    /// Converts a CSV file of any size to a JAZMIN file without loading it: the file is read twice, a buffer at a time
    /// (column types as <see cref="FromCsv"/> infers them, then rows). With <paramref name="columns"/>, every header
    /// name must be one of them, each value is read as its column's type, and the file is read once. If the input
    /// fails part-way the output file is deleted.
    /// </summary>
    public static void FromCsvFile(string inputPath, string outputPath, JazminSerializerSettings? settings = null, bool inferTypes = true,
        char delimiter = ',', IReadOnlyList<JazminColumn>? columns = null)
    {
        settings ??= new JazminSerializerSettings();
        IEnumerable<string?[]> Records()
        {
            using var reader = new StreamReader(inputPath, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, 1 << 16);
            foreach (var record in CsvFormat.ReadRecords(reader, delimiter)) yield return record;
        }
        if (columns is null)
        {
            List<string>? names = null;
            TextColumnInference? inference = null;
            long n = 0;
            foreach (var record in Records())
            {
                if (names is null)
                {
                    names = CsvFormat.HeaderNames(record);
                    inference = new TextColumnInference(names, inferTypes);
                    continue;
                }
                CsvFormat.CheckFields(record, names, n++);
                inference!.Add(record);
            }
            columns = inference?.Columns() ?? throw new JazminValidationException("CSV has no header row");
        }
        var writer = JazminWriter.Create(outputPath, settings.ApplyIndexes(columns), settings.ToWriteOptions());
        try
        {
            JazminColumn[]? order = null;
            List<string>? header = null;
            long n = 0;
            foreach (var record in Records())
            {
                if (header is null)
                {
                    header = CsvFormat.HeaderNames(record);
                    order = header.Select(name => columns.FirstOrDefault(c => c.Name == name)
                        ?? throw new JazminValidationException($"CSV column '{name}' is not one of the columns given")).ToArray();
                    continue;
                }
                CsvFormat.CheckFields(record, header, n++);
                writer.WriteValues(ToColumnOrder(columns, order!, record));
            }
            if (header is null) throw new JazminValidationException("CSV has no header row");
            writer.Finish();
        }
        catch
        {
            writer.Abort();
            File.Delete(outputPath);
            throw;
        }
    }

    /// <summary>A CSV record (in the header's order) as values in the order of <paramref name="columns"/>.</summary>
    private static object?[] ToColumnOrder(IReadOnlyList<JazminColumn> columns, JazminColumn[] order, string?[] record)
    {
        var values = new object?[columns.Count];
        for (var i = 0; i < order.Length && i < record.Length; i++)
        {
            var at = IndexOf(columns, order[i]);
            values[at] = TextValues.FromText(order[i].Type, record[i]);
        }
        return values;
    }

    private static int IndexOf(IReadOnlyList<JazminColumn> columns, JazminColumn column)
    {
        for (var i = 0; i < columns.Count; i++) if (ReferenceEquals(columns[i], column)) return i;
        return -1;
    }

    public static string ToXml(byte[] data, JazminSerializerSettings? settings = null, JazminFilter? filter = null)
    {
        using var reader = JazminReader.Open(data, settings?.ToReadOptions());
        var output = new Utf8StringWriter();
        XmlFormat.Write(output, reader.Columns, reader.Find(filter));
        return output.ToString();
    }

    public static byte[] FromXml(string xml, JazminSerializerSettings? settings = null, bool inferTypes = true) =>
        Write(XmlFormat.Parse(xml, inferTypes), settings);

    /// <summary>
    /// Converts an XML file of the canonical shape (as <see cref="ToXml"/> writes it) of any size to a JAZMIN file without
    /// loading it: the file is read twice as it goes (column types as <see cref="FromXml"/> infers them, then rows). With
    /// <paramref name="columns"/>, the file is read once, each value is read as its column's type, and every element must
    /// name one of the columns. If the input fails part-way the output file is deleted.
    /// </summary>
    public static void FromXmlFile(string inputPath, string outputPath, JazminSerializerSettings? settings = null, bool inferTypes = true,
        IReadOnlyList<JazminColumn>? columns = null)
    {
        settings ??= new JazminSerializerSettings();
        IEnumerable<Dictionary<int, string>> Rows(List<string> names)
        {
            // Read as text, UTF-8 unless a byte order mark says otherwise (as the JavaScript importer reads it): the XML
            // declaration's encoding is not used. Text from ToXml before 1.1.1 declares UTF-16 (a .NET string's encoding)
            // but is usually saved as UTF-8, which a reader that trusts the declaration refuses.
            using var text = new StreamReader(inputPath, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, 1 << 16);
            using var reader = System.Xml.XmlReader.Create(text, XmlFormat.ReaderSettings);
            foreach (var row in XmlFormat.ReadRows(reader, names)) yield return row;
        }
        var byName = columns is not null;
        if (columns is null)
        {
            var names = new List<string>();
            var inference = new TextColumnInference([], inferTypes);
            long rows = 0;
            foreach (var row in Rows(names))
            {
                while (inference.Width < names.Count) inference.Grow(names[inference.Width], rows > 0); // earlier rows lacked it
                inference.Add(XmlFormat.Record(row, names.Count));
                rows++;
            }
            columns = inference.Columns();
        }
        var writer = JazminWriter.Create(outputPath, settings.ApplyIndexes(columns), settings.ToWriteOptions());
        try
        {
            var names = new List<string>();
            var order = new List<int>(); // a name's position -> its column's
            foreach (var row in Rows(names))
            {
                while (order.Count < names.Count)
                {
                    var name = names[order.Count];
                    var at = byName ? IndexOfName(columns, name) : order.Count;
                    if (at < 0) throw new JazminValidationException($"XML element '{name}' is not one of the columns given");
                    order.Add(at);
                }
                var values = new object?[columns.Count];
                foreach (var (i, text) in row) values[order[i]] = TextValues.FromText(columns[order[i]].Type, text);
                writer.WriteValues(values);
            }
            writer.Finish();
        }
        catch
        {
            writer.Abort();
            File.Delete(outputPath);
            throw;
        }
    }

    private static int IndexOfName(IReadOnlyList<JazminColumn> columns, string name)
    {
        for (var i = 0; i < columns.Count; i++) if (columns[i].Name == name) return i;
        return -1;
    }

    internal static byte[] Write(TabularData data, JazminSerializerSettings? settings)
    {
        settings ??= new JazminSerializerSettings();
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, settings.ApplyIndexes(data.Columns), settings.ToWriteOptions(), leaveOpen: true))
        {
            foreach (var row in data.Rows) writer.WriteValues(row);
            writer.Finish();
        }
        return stream.ToArray();
    }
}

/// <summary>
/// Stream-based serializer, shaped like Newtonsoft's JsonSerializer. Deserialization of a
/// collection can stream (<see cref="DeserializeEnumerable{T}(Stream)"/>) so large files never load fully.
/// </summary>
public sealed class JazminSerializer(JazminSerializerSettings? settings = null)
{
    private readonly JazminSerializerSettings _settings = settings ?? new JazminSerializerSettings();

    public void Serialize(Stream stream, object value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value is IEnumerable<KeyValuePair<string, object?>>)
        {
            WriteUntyped(stream, new[] { value }); // a single dictionary is one row
        }
        else if (value is IEnumerable items and not string and not byte[] and not IDictionary)
        {
            var elementType = ElementType(value.GetType()) ?? typeof(object);
            if (IsUntyped(elementType)) WriteUntyped(stream, items.Cast<object>());
            else Serialize(stream, items.Cast<object>(), elementType);
        }
        else
        {
            Serialize(stream, new[] { value }, value.GetType());
        }
    }

    public void Serialize<T>(Stream stream, IEnumerable<T> items) => Serialize(stream, items.Cast<object>(), typeof(T));

    public void Serialize(string path, object value)
    {
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
        Serialize(stream, value);
    }

    private void Serialize(Stream stream, IEnumerable<object> items, Type type)
    {
        var map = TypeMap.For(type, _settings);
        var references = map.PreservesReferences ? new ReferenceTracker() : null;
        using var writer = new JazminWriter(stream, _settings.ApplyIndexes(map.Columns), _settings.ToWriteOptions(), leaveOpen: true);
        foreach (var item in items) writer.WriteValues(map.ToValues(item, _settings, references));
        writer.Finish();
    }

    /// <summary>Rows given as dictionaries (e.g. Dictionary&lt;string, object?&gt;, JazminRow): schema inferred from values.</summary>
    private void WriteUntyped(Stream stream, IEnumerable<object> items)
    {
        var rows = items.Select(i => i as IEnumerable<KeyValuePair<string, object?>>
            ?? throw new JazminValidationException($"Cannot serialize item of type {i.GetType().Name}")).Select(r => r.ToList()).ToList();
        var names = new List<string>();
        var types = new Dictionary<string, JazminType?>();
        var nullable = new HashSet<string>();
        foreach (var row in rows)
        {
            foreach (var (name, value) in row)
            {
                if (!types.ContainsKey(name))
                {
                    names.Add(name);
                    types[name] = null;
                }
                if (value is null) nullable.Add(name);
                else types[name] = JsonFormat.Merge(types[name], ClrType(value));
            }
        }
        foreach (var name in names)
            if (rows.Any(r => r.All(p => p.Key != name))) nullable.Add(name);
        var columns = names.Select(n => new JazminColumn(n, types[n] ?? JazminType.String) { Nullable = nullable.Contains(n) }).ToList();
        var values = rows.Select(r => columns.Select(c =>
        {
            var value = r.FirstOrDefault(p => p.Key == c.Name).Value;
            return value is not null && c.Type == JazminType.Float && value is not double ? Convert.ToDouble(value) : value;
        }).ToArray()).ToList();
        var bytes = JazminConvert.Write(new TabularData(columns, values), _settings);
        stream.Write(bytes);
    }

    private static JazminType ClrType(object value) => value switch
    {
        bool => JazminType.Bool,
        sbyte or byte or short or ushort or int or uint or long => JazminType.Int,
        float or double => JazminType.Float,
        decimal => JazminType.Decimal,
        string => JazminType.String,
        DateTime or DateTimeOffset or DateOnly => JazminType.DateTime,
        byte[] => JazminType.Binary,
        _ => JazminType.Json,
    };

    public T? Deserialize<T>(Stream stream)
    {
        var target = typeof(T);
        var elementType = target == typeof(string) ? null : ElementType(target);
        if (elementType is null)
        {
            using var reader = JazminReader.Open(stream, _settings.ToReadOptions(), leaveOpen: true);
            var first = reader.Rows().FirstOrDefault();
            return first is null ? default : (T)Materialize(first, target, new ReferenceResolver());
        }
        var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(elementType))!;
        using (var reader = JazminReader.Open(stream, _settings.ToReadOptions(), leaveOpen: true))
        {
            var direct = DirectRows(reader, elementType);
            var references = new ReferenceResolver();
            if (direct is not null) foreach (var item in direct) list.Add(item);
            else foreach (var row in reader.Rows()) list.Add(Materialize(row, elementType, references));
        }
        if (target.IsArray)
        {
            var array = Array.CreateInstance(elementType, list.Count);
            list.CopyTo(array, 0);
            return (T)(object)array;
        }
        return (T)list;
    }

    public T? Deserialize<T>(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Deserialize<T>(stream);
    }

    /// <summary>Deserialize for async code: the file is read and decoded on a thread-pool thread.</summary>
    public Task<T?> DeserializeAsync<T>(Stream stream, CancellationToken cancellationToken = default) =>
        Task.Run(() => Deserialize<T>(stream), cancellationToken);

    /// <summary>
    /// DeserializeEnumerable for async code: items are decoded on a thread-pool thread, a batch at a time, while you
    /// await. The stream must stay open during enumeration.
    /// </summary>
    public IAsyncEnumerable<T> DeserializeAsyncEnumerable<T>(Stream stream, CancellationToken cancellationToken = default) =>
        AsyncRows.Of(DeserializeEnumerable<T>(stream), cancellationToken);

    /// <summary>Serializes items from an async source (a database cursor), awaiting rather than blocking while chunks are compressed.</summary>
    public async Task SerializeAsync<T>(Stream stream, IAsyncEnumerable<T> items, CancellationToken cancellationToken = default)
    {
        var map = TypeMap.For(typeof(T), _settings);
        var references = map.PreservesReferences ? new ReferenceTracker() : null;
        await using var writer = new JazminWriter(stream, _settings.ApplyIndexes(map.Columns), _settings.ToWriteOptions(), leaveOpen: true);
        await foreach (var item in items.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            await writer.WaitForWorkersAsync().ConfigureAwait(false);
            writer.WriteValues(map.ToValues(item!, _settings, references));
        }
        await writer.FinishAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Streams items one at a time; the stream is read lazily and must stay open during enumeration.</summary>
    public IEnumerable<T> DeserializeEnumerable<T>(Stream stream)
    {
        using var reader = JazminReader.Open(stream, _settings.ToReadOptions(), leaveOpen: true);
        var direct = DirectRows(reader, typeof(T));
        if (direct is not null)
        {
            foreach (var item in direct) yield return (T)item;
            yield break;
        }
        var references = new ReferenceResolver();
        foreach (var row in reader.Rows()) yield return (T)Materialize(row, typeof(T), references);
    }

    /// <summary>The direct decode path for plain objects (null for rows, dictionaries, JSON or access-controlled files).</summary>
    private IEnumerable<object>? DirectRows(JazminReader reader, Type type)
    {
        if (type == typeof(JazminRow) || type == typeof(object) || type == typeof(JsonObject)
            || typeof(System.Collections.IDictionary).IsAssignableFrom(type)
            || (type.IsGenericType && type.GetGenericTypeDefinition() is var g
                && (g == typeof(Dictionary<,>) || g == typeof(IDictionary<,>) || g == typeof(IReadOnlyDictionary<,>))))
            return null;
        var map = TypeMap.For(type, _settings);
        return reader.DirectColumnRows(map.ColumnReader, _settings);
    }

    private object Materialize(JazminRow row, Type type, ReferenceResolver references)
    {
        if (type == typeof(JazminRow) || type == typeof(object)) return row;
        if (type == typeof(Dictionary<string, object?>) || type == typeof(IDictionary<string, object?>) || type == typeof(IReadOnlyDictionary<string, object?>))
            return row.ToDictionary(p => p.Key, p => p.Value);
        if (type == typeof(JsonObject))
            return new JsonObject(row.Select(p => new KeyValuePair<string, JsonNode?>(p.Key, ToNode(p.Value))));
        return TypeMap.For(type, _settings).FromRow(row, _settings, references);
    }

    private static JsonNode? ToNode(object? value) => value switch
    {
        null => null,
        JsonNode node => node.DeepClone(),
        DateTime dt => JsonValue.Create(dt),
        byte[] bytes => JsonValue.Create(Convert.ToBase64String(bytes)),
        bool b => JsonValue.Create(b),
        long l => JsonValue.Create(l),
        double d => JsonValue.Create(d),
        string s => JsonValue.Create(s),
        _ => JsonValue.Create(value.ToString()),
    };

    private static bool IsUntyped(Type t) =>
        t == typeof(object) || typeof(IEnumerable<KeyValuePair<string, object?>>).IsAssignableFrom(t);

    private static Type? ElementType(Type type)
    {
        if (type.IsArray) return type.GetElementType();
        if (type == typeof(string) || type == typeof(byte[])) return null;
        if (typeof(IEnumerable<KeyValuePair<string, object?>>).IsAssignableFrom(type) && !type.IsGenericType) return null; // JazminRow-like
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IEnumerable<>)) return type.GetGenericArguments()[0];
        if (type == typeof(Dictionary<string, object?>) || type == typeof(JsonObject)) return null;
        return type.GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))?.GetGenericArguments()[0];
    }
}
