using System.Buffers;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Jazmin.Serialization;

namespace Jazmin.Formats;

/// <summary>The kinds of token a <see cref="JazminJsonReader"/> reads (as Newtonsoft's JsonToken).</summary>
public enum JazminJsonToken
{
    /// <summary>Before the first token, and after the last.</summary>
    None,
    StartObject,
    StartArray,
    PropertyName,
    /// <summary>A whole number: <see cref="JazminJsonReader.Value"/> is a <see cref="long"/>.</summary>
    Integer,
    /// <summary>A float (a <see cref="double"/>), or a decimal as its exact text (a <see cref="string"/>).</summary>
    Float,
    String,
    Boolean,
    Null,
    EndObject,
    EndArray,
    /// <summary>A datetime column's value, a UTC <see cref="DateTime"/> (in JSON text: ISO 8601).</summary>
    Date,
    /// <summary>A binary column's value, a <see cref="byte"/> array (in JSON text: base64).</summary>
    Bytes,
}

/// <summary>
/// Rows as a JSON token stream, read one token at a time (TASKS J-3), the way Newtonsoft's JsonReader is used:
/// <c>while (json.Read()) { ... json.TokenType, json.Value ... }</c>. The tokens are those of the JSON array of row
/// objects that <see cref="JsonFormat.Write"/> writes, values of json columns as nested tokens, but no JSON text is
/// written or parsed: values come straight from the file, as the query reads it. For a System.Text.Json pipeline,
/// which reads bytes, use <see cref="JazminJsonStream"/>.
/// </summary>
public sealed class JazminJsonReader : IDisposable
{
    private readonly IReadOnlyList<JazminColumn> _columns;
    private readonly IEnumerable<JazminRow> _rows;
    private readonly List<object> _path = new(); // row positions (int) and property names (string), outermost first
    private IEnumerator<bool>? _tokens;

    /// <summary>The rows <paramref name="filter"/> and <paramref name="options"/> select, as in <see cref="JazminReader.Find(JazminFilter?, JazminQueryOptions?)"/>.</summary>
    public JazminJsonReader(JazminReader reader, JazminFilter? filter = null, JazminQueryOptions? options = null)
    {
        _columns = JsonFormat.ColumnsOf(reader, options);
        _rows = reader.Find(filter, options);
    }

    public JazminJsonToken TokenType { get; private set; }

    /// <summary>The token's value: the property name, or the value (see <see cref="JazminJsonToken"/>); null for others.</summary>
    public object? Value { get; private set; }

    /// <summary>How deep the token is: 0 for the array of rows, 1 for a row object, 2 for its properties, and so on.</summary>
    public int Depth => _path.Count;

    /// <summary>Where the token is, as Newtonsoft writes it: <c>[3].amount</c>, <c>[3]['two words']</c>, <c>[3].extra.tags[0]</c>.</summary>
    public string Path
    {
        get
        {
            var text = new System.Text.StringBuilder();
            foreach (var part in _path)
            {
                if (part is int index) text.Append('[').Append(index).Append(']');
                else if (part is string name && IsIdentifier(name)) text.Append('.').Append(name);
                else text.Append("['").Append(((string)part).Replace("'", "\\'", StringComparison.Ordinal)).Append("']");
            }
            return text.Length > 0 && text[0] == '.' ? text.ToString(1, text.Length - 1) : text.ToString();
        }
    }

    /// <summary>Moves to the next token; false after the last.</summary>
    public bool Read()
    {
        _tokens ??= Tokens().GetEnumerator();
        if (_tokens.MoveNext()) return true;
        (TokenType, Value) = (JazminJsonToken.None, null);
        _path.Clear();
        return false;
    }

    /// <summary>Stops the query: what it holds is released.</summary>
    public void Dispose() => _tokens?.Dispose();

    private bool Set(JazminJsonToken type, object? value)
    {
        (TokenType, Value) = (type, value);
        return true;
    }

    private IEnumerable<bool> Tokens()
    {
        yield return Set(JazminJsonToken.StartArray, null);
        var position = 0;
        int[]? positions = null; // each column's position in the rows: values are read by position, not looked up by name
        foreach (var row in _rows)
        {
            positions ??= JsonFormat.Positions(_columns, row);
            _path.Add(position++);
            yield return Set(JazminJsonToken.StartObject, null);
            for (var c = 0; c < _columns.Count; c++)
            {
                var column = _columns[c];
                var value = positions[c] >= 0 ? row.ValueAt(positions[c]) : null;
                _path.Add(column.Name);
                yield return Set(JazminJsonToken.PropertyName, column.Name);
                if (Format.Nested.ForOutput(column, value) is JsonNode node)
                    foreach (var token in Node(node)) yield return token;
                else
                    yield return ColumnValue(column.Type, value);
                _path.RemoveAt(_path.Count - 1);
            }
            _path.RemoveAt(_path.Count - 1);
            yield return Set(JazminJsonToken.EndObject, null);
        }
        yield return Set(JazminJsonToken.EndArray, null);
    }

    /// <summary>A column value's token, as <see cref="JsonFormat"/> writes the value.</summary>
    private bool ColumnValue(JazminType type, object? value) => value switch
    {
        null => Set(JazminJsonToken.Null, null),
        bool b => Set(JazminJsonToken.Boolean, b),
        long l => Set(JazminJsonToken.Integer, l),
        double d when double.IsFinite(d) => Set(JazminJsonToken.Float, d),
        double => Set(JazminJsonToken.Null, null), // NaN and infinities have no JSON form
        string s when type == JazminType.Decimal => Set(JazminJsonToken.Float, s),
        string s => Set(JazminJsonToken.String, s),
        DateTime dt => Set(JazminJsonToken.Date, dt.ToUniversalTime()),
        byte[] bytes => Set(JazminJsonToken.Bytes, bytes),
        _ => Set(JazminJsonToken.String, value.ToString()),
    };

    /// <summary>The tokens of a json column's value.</summary>
    private IEnumerable<bool> Node(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                yield return Set(JazminJsonToken.StartObject, null);
                foreach (var (name, child) in obj)
                {
                    _path.Add(name);
                    yield return Set(JazminJsonToken.PropertyName, name);
                    foreach (var token in Node(child)) yield return token;
                    _path.RemoveAt(_path.Count - 1);
                }
                yield return Set(JazminJsonToken.EndObject, null);
                break;
            case JsonArray array:
                yield return Set(JazminJsonToken.StartArray, null);
                for (var i = 0; i < array.Count; i++)
                {
                    _path.Add(i);
                    foreach (var token in Node(array[i])) yield return token;
                    _path.RemoveAt(_path.Count - 1);
                }
                yield return Set(JazminJsonToken.EndArray, null);
                break;
            case null:
                yield return Set(JazminJsonToken.Null, null);
                break;
            default:
                var value = node.AsValue();
                yield return value.GetValueKind() switch
                {
                    JsonValueKind.String => Set(JazminJsonToken.String, value.GetValue<string>()),
                    JsonValueKind.Number when value.TryGetValue<long>(out var l) => Set(JazminJsonToken.Integer, l),
                    JsonValueKind.Number => Set(JazminJsonToken.Float, value.GetValue<double>()),
                    JsonValueKind.True => Set(JazminJsonToken.Boolean, true),
                    JsonValueKind.False => Set(JazminJsonToken.Boolean, false),
                    _ => Set(JazminJsonToken.Null, null),
                };
                break;
        }
    }

    private static bool IsIdentifier(string name) =>
        name.Length > 0 && (char.IsLetter(name[0]) || name[0] == '_') && name.All(c => char.IsLetterOrDigit(c) || c == '_');
}

/// <summary>
/// Rows as a stream of JSON text (UTF-8), written as it is read (TASKS J-3): the JSON array of row objects that
/// <see cref="JsonFormat.Write"/> writes, byte for byte, for any System.Text.Json pipeline (Utf8JsonReader,
/// JsonSerializer.DeserializeAsyncEnumerable, JsonDocument) or an HTTP response. It holds about 64 KiB of text at a
/// time, however many rows the query returns.
/// </summary>
public sealed class JazminJsonStream : Stream
{
    private const int BufferSize = 64 * 1024;
    private readonly IReadOnlyList<JazminColumn> _columns;
    private readonly IEnumerator<JazminRow> _rows;
    private readonly ArrayBufferWriter<byte> _buffer = new(BufferSize);
    private readonly Utf8JsonWriter _writer;
    private readonly NullValueHandling _nulls;
    private int[]? _positions; // each column's position in the rows (from the first row)
    private int _read; // bytes of the buffer already handed out
    private bool _started;
    private bool _ended;

    /// <summary>The rows <paramref name="filter"/> and <paramref name="options"/> select, as in <see cref="JazminReader.Find(JazminFilter?, JazminQueryOptions?)"/>.</summary>
    public JazminJsonStream(JazminReader reader, JazminFilter? filter = null, JazminQueryOptions? options = null,
        Formatting formatting = Formatting.None, NullValueHandling nulls = NullValueHandling.Include)
    {
        _columns = JsonFormat.ColumnsOf(reader, options);
        _rows = reader.Find(filter, options).GetEnumerator();
        _writer = new Utf8JsonWriter(_buffer, JsonFormat.WriterOptions(formatting));
        _nulls = nulls;
    }

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> destination)
    {
        if (destination.IsEmpty) return 0;
        if (_read == _buffer.WrittenCount)
        {
            _buffer.ResetWrittenCount();
            _read = 0;
            Fill();
        }
        var available = _buffer.WrittenSpan[_read..];
        var n = Math.Min(available.Length, destination.Length);
        available[..n].CopyTo(destination);
        _read += n;
        return n;
    }

    /// <summary>The rows are read from the file as the text is needed: synchronously, as the query reads them.</summary>
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(Read(buffer.Span));
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    /// <summary>Writes rows until about <see cref="BufferSize"/> bytes of text are ready, or the last.</summary>
    private void Fill()
    {
        if (_ended) return;
        if (!_started)
        {
            _writer.WriteStartArray();
            _started = true;
        }
        while (_writer.BytesPending < BufferSize)
        {
            if (!_rows.MoveNext())
            {
                _writer.WriteEndArray();
                _ended = true;
                break;
            }
            var row = _rows.Current;
            JsonFormat.WriteRow(_writer, _columns, row, _positions ??= JsonFormat.Positions(_columns, row), _nulls);
        }
        _writer.Flush();
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _rows.Dispose();
            _writer.Dispose();
        }
        base.Dispose(disposing);
    }
}
