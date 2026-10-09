using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jazmin.Format;

namespace Jazmin;

/// <summary>
/// A file to embed in a JAZMIN file (spec 6.8). Give <see cref="Content"/> (bytes) or
/// <see cref="FilePath"/> (a file on disk, read in blocks).
/// </summary>
public sealed class JazminFileInput
{
    public JazminFileInput(string path, byte[] content)
    {
        Path = path;
        Content = content ?? throw new ArgumentNullException(nameof(content));
    }

    private JazminFileInput(string path, string filePath)
    {
        Path = path;
        FilePath = filePath;
    }

    /// <summary>A file read from disk (block by block, so it is never fully in memory).</summary>
    public static JazminFileInput FromFile(string path, string filePath, IReadOnlyList<string>? groups = null, string? type = null) =>
        new(path, filePath) { Groups = groups, Type = type };

    /// <summary>A file read from disk, with what viewers may do with it.</summary>
    public static JazminFileInput FromFile(string path, string filePath, IReadOnlyList<string>? groups, string? type, JazminFileActions? actions) =>
        new(path, filePath) { Groups = groups, Type = type, Actions = actions };

    /// <summary>Relative path with '/' separators, e.g. "img/logo.png".</summary>
    public string Path { get; }

    public byte[]? Content { get; }

    public string? FilePath { get; }

    /// <summary>Media type (default: from the extension).</summary>
    public string? Type { get; init; }

    /// <summary>Groups that may see the file: null or ["*"] for everyone with a key, or partition / named file-group names.</summary>
    public IReadOnlyList<string>? Groups { get; init; }

    /// <summary>What viewers may do with the file (format 1.4): null allows everything.</summary>
    public JazminFileActions? Actions { get; init; }
}

/// <summary>An embedded file visible to the current key.</summary>
public sealed record JazminEmbeddedFile(string Path, string Type, long Size, string Sha256, IReadOnlyList<string>? Groups)
{
    /// <summary>What viewers may do with the file, when its writer set it (format 1.4); null allows everything.</summary>
    public JazminFileActions? Actions { get; init; }
}

/// <summary>
/// What viewers may do with an embedded file (spec 6.8, format 1.4). Each is allowed when null. These steer viewers
/// (the JAZMIN viewer, editor extensions): a key that sees a file can always read it with the library.
/// </summary>
public sealed record JazminFileActions
{
    /// <summary>Open (show) the file in a viewer.</summary>
    public bool? Open { get; init; }

    /// <summary>Save (download) the file as it is.</summary>
    public bool? Save { get; init; }

    /// <summary>Print the page.</summary>
    public bool? Print { get; init; }

    /// <summary>Save the page as PDF; false refuses it. <see cref="PdfSettings"/> allows it with those page settings.</summary>
    public bool? Pdf { get; init; }

    /// <summary>The page settings for the page's PDFs, over the package's (stored as pdf: { ... }).</summary>
    public JazminPdfSettings? PdfSettings { get; init; }

    /// <summary>Save the page as an image.</summary>
    public bool? Image { get; init; }
}

/// <summary>Page settings for a document's PDFs (spec 6.8): each optional, checked when written.</summary>
public sealed record JazminPdfSettings
{
    /// <summary>A0 to A6, Letter, Legal, Tabloid or Ledger (default A4).</summary>
    public string? Format { get; init; }

    public bool? Landscape { get; init; }

    public JazminPdfMargin? Margin { get; init; }

    /// <summary>0.1 to 2 (default 1).</summary>
    public double? Scale { get; init; }

    /// <summary>Print background colours and images (default true).</summary>
    public bool? PrintBackground { get; init; }

    /// <summary>The page's CSS @page size wins over <see cref="Format"/> (stored as preferCSSPageSize).</summary>
    public bool? PreferCssPageSize { get; init; }
}

/// <summary>Page margins: lengths such as "12mm", "1cm", "0.5in" or "20px".</summary>
public sealed record JazminPdfMargin
{
    public string? Top { get; init; }

    public string? Right { get; init; }

    public string? Bottom { get; init; }

    public string? Left { get; init; }
}

/// <summary>Settings for viewers that render a file's embedded website.</summary>
public sealed class JazminPackage
{
    public string? Entry { get; init; }

    public string? Title { get; init; }

    /// <summary>https origins the rendered page may contact.</summary>
    public IReadOnlyList<string>? AllowedOrigins { get; init; }

    public bool? AllowWasm { get; init; }

    /// <summary>The document's page settings for PDFs (format 1.4).</summary>
    public JazminPdfSettings? Pdf { get; init; }

    /// <summary>What the document may change (format 1.4, spec 7.9).</summary>
    public JazminEditSettings? Edit { get; init; }
}

/// <summary>Validation, media types and the stored-content model for embedded files (spec 6.8).</summary>
internal static class EmbeddedFiles
{
    public const int BlockSize = 256 * 1024;
    public const string Everyone = "*";

    private static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html", [".htm"] = "text/html", [".css"] = "text/css", [".js"] = "text/javascript", [".mjs"] = "text/javascript",
        [".json"] = "application/json", [".txt"] = "text/plain", [".csv"] = "text/csv", [".xml"] = "application/xml", [".svg"] = "image/svg+xml",
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".gif"] = "image/gif", [".webp"] = "image/webp", [".ico"] = "image/x-icon",
        [".woff2"] = "font/woff2", [".woff"] = "font/woff", [".ttf"] = "font/ttf", [".otf"] = "font/otf", [".pdf"] = "application/pdf",
        [".mp4"] = "video/mp4", [".webm"] = "video/webm", [".mp3"] = "audio/mpeg", [".ogg"] = "audio/ogg", [".wav"] = "audio/wav", [".zip"] = "application/zip",
    };

    public static string MediaType(string path) => Mime.TryGetValue(System.IO.Path.GetExtension(path), out var type) ? type : "application/octet-stream";

    public static string ValidatePath(string? path)
    {
        if (string.IsNullOrEmpty(path) || path.Length > 1024) throw new JazminValidationException("A file path must be 1 to 1024 characters");
        if (path.Contains('\\') || path.Split('/').Any(s => s is "" or "." or ".."))
            throw new JazminValidationException($"Invalid file path '{path}': use relative paths with '/' and no empty, '.' or '..' segments");
        return path;
    }

    public static List<string> NormalizeGroups(IReadOnlyList<string>? groups, string path)
    {
        if (groups is null) return [Everyone];
        if (groups.Count == 0) throw new JazminValidationException($"File '{path}': groups must be null, [\"*\"] or a non-empty list");
        var names = groups.Distinct(StringComparer.Ordinal).ToList();
        foreach (var g in names)
            if (g.Length is 0 or > 256) throw new JazminValidationException($"File '{path}': invalid group name '{g}'");
        if (names.Contains(Everyone)) return [Everyone];
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>Validates package settings against the stored paths; returns the header JSON or null.</summary>
    public static JsonObject? PackageJson(JazminPackage? package, ICollection<string> paths)
    {
        if (package is null) return null;
        var json = new JsonObject();
        if (package.Entry is not null)
        {
            if (!paths.Contains(package.Entry)) throw new JazminValidationException($"package.entry '{package.Entry}' is not one of the stored files");
            json["entry"] = package.Entry;
        }
        if (package.Title is not null) json["title"] = package.Title;
        if (package.AllowedOrigins is not null)
        {
            var origins = new JsonArray();
            foreach (var o in package.AllowedOrigins)
            {
                if (!Uri.TryCreate(o, UriKind.Absolute, out var uri) || uri.Scheme != "https" || $"{uri.Scheme}://{uri.Authority}" != o)
                    throw new JazminValidationException($"package.allowedOrigins: '{o}' must be an https origin such as https://api.example.com");
                origins.Add(o);
            }
            json["allowedOrigins"] = origins;
        }
        if (package.AllowWasm is { } wasm) json["allowWasm"] = wasm;
        if (package.Pdf is { } pdf) json["pdf"] = PdfJson(pdf, "package.pdf");
        if (package.Edit is { } edit) json["edit"] = Changes.EditJson(edit);
        return json;
    }

    public static JazminPackage? PackageFrom(JsonNode? json) => json is not JsonObject o ? null : new JazminPackage
    {
        Entry = (string?)o["entry"],
        Title = (string?)o["title"],
        AllowedOrigins = o["allowedOrigins"] is JsonArray a ? a.Select(x => (string)x!).ToList() : null,
        AllowWasm = (bool?)o["allowWasm"],
        Pdf = o["pdf"] is JsonObject pdf ? PdfFrom(pdf, strict: false) : null,
        Edit = Changes.EditFrom(o["edit"]),
    };

    private static readonly string[] PdfFormats = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Letter", "Legal", "Tabloid", "Ledger"];
    private static readonly Regex CssLength = new(@"^(?:0|\d+(?:\.\d+)?(?:px|in|cm|mm))$", RegexOptions.CultureInvariant);
    private static readonly string[] Sides = ["top", "right", "bottom", "left"];

    /// <summary>Checks page settings and returns their JSON (spec 6.8); <paramref name="where"/> names them in errors.</summary>
    public static JsonObject PdfJson(JazminPdfSettings pdf, string where)
    {
        var json = new JsonObject();
        if (pdf.Format is { } format)
        {
            if (!PdfFormats.Contains(format, StringComparer.Ordinal))
                throw new JazminValidationException($"{where}.format: '{format}' is not one of {string.Join(", ", PdfFormats)}");
            json["format"] = format;
        }
        if (pdf.Landscape is { } landscape) json["landscape"] = landscape;
        if (pdf.Margin is { } margin)
        {
            var sides = new JsonObject();
            foreach (var (side, length) in new[] { ("top", margin.Top), ("right", margin.Right), ("bottom", margin.Bottom), ("left", margin.Left) })
            {
                if (length is null) continue;
                if (!CssLength.IsMatch(length))
                    throw new JazminValidationException($"{where}.margin.{side}: '{length}' must be a length such as 12mm, 1cm, 0.5in or 20px");
                sides[side] = length;
            }
            json["margin"] = sides;
        }
        if (pdf.Scale is { } scale)
        {
            if (!(scale >= 0.1 && scale <= 2)) throw new JazminValidationException($"{where}.scale must be a number from 0.1 to 2");
            json["scale"] = scale;
        }
        if (pdf.PrintBackground is { } background) json["printBackground"] = background;
        if (pdf.PreferCssPageSize is { } css) json["preferCSSPageSize"] = css;
        return json;
    }

    /// <summary>
    /// Page settings read from a file: strict, null when any is unknown or of the wrong type (a file's actions then
    /// allow PDFs with the viewer's own settings, as the JavaScript library); otherwise the ones this library knows.
    /// </summary>
    public static JazminPdfSettings? PdfFrom(JsonObject o, bool strict)
    {
        static bool? Flag(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;
        var bad = false;
        string? format = null;
        bool? landscape = null, background = null, css = null;
        double? scale = null;
        JazminPdfMargin? margin = null;
        foreach (var (name, value) in o)
        {
            switch (name)
            {
                case "format":
                    format = value is JsonValue fv && fv.TryGetValue<string>(out var f) && PdfFormats.Contains(f, StringComparer.Ordinal) ? f : null;
                    bad |= format is null;
                    break;
                case "landscape": landscape = Flag(value); bad |= landscape is null; break;
                case "printBackground": background = Flag(value); bad |= background is null; break;
                case "preferCSSPageSize": css = Flag(value); bad |= css is null; break;
                case "scale":
                    scale = value is JsonValue sv && sv.TryGetValue<double>(out var s) && s >= 0.1 && s <= 2 ? s : null;
                    bad |= scale is null;
                    break;
                case "margin":
                    if (value is not JsonObject m || m.Any(p => !Sides.Contains(p.Key) || p.Value is not JsonValue lv || !lv.TryGetValue<string>(out var l) || !CssLength.IsMatch(l)))
                    {
                        bad = true;
                        break;
                    }
                    margin = new JazminPdfMargin { Top = (string?)m["top"], Right = (string?)m["right"], Bottom = (string?)m["bottom"], Left = (string?)m["left"] };
                    break;
                default:
                    bad = true;
                    break;
            }
        }
        if (bad && strict) return null;
        return new JazminPdfSettings { Format = format, Landscape = landscape, Margin = margin, Scale = scale, PrintBackground = background, PreferCssPageSize = css };
    }

    /// <summary>Checks a file's actions and returns their JSON, or null when none is set (spec 6.8).</summary>
    public static JsonObject? ActionsJson(JazminFileActions? actions, string path)
    {
        if (actions is null) return null;
        var json = new JsonObject();
        if (actions.Open is { } open) json["open"] = open;
        if (actions.Save is { } save) json["save"] = save;
        if (actions.Print is { } print) json["print"] = print;
        if (actions.PdfSettings is { } settings)
        {
            if (actions.Pdf == false) throw new JazminValidationException($"File '{path}': actions.Pdf is false but PdfSettings are given");
            json["pdf"] = PdfJson(settings, $"File '{path}': actions.pdf");
        }
        else if (actions.Pdf is { } pdf) json["pdf"] = pdf;
        if (actions.Image is { } image) json["image"] = image;
        return json.Count > 0 ? json : null;
    }

    /// <summary>A file's actions as a reader takes them: the ones it knows, of the right types; null when none.</summary>
    public static JazminFileActions? ActionsFrom(JsonNode? json)
    {
        if (json is not JsonObject o) return null;
        static bool? Flag(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;
        bool? pdf = Flag(o["pdf"]);
        JazminPdfSettings? settings = null;
        if (o["pdf"] is JsonObject p)
        {
            settings = PdfFrom(p, strict: true);
            pdf = settings is null ? true : null; // settings it doesn't know: allowed, with the viewer's own
        }
        var actions = new JazminFileActions { Open = Flag(o["open"]), Save = Flag(o["save"]), Print = Flag(o["print"]), Pdf = pdf, PdfSettings = settings, Image = Flag(o["image"]) };
        return actions == new JazminFileActions() ? null : actions;
    }
}

/// <summary>A file to store: metadata, its SHA-256, and a block reader (from bytes, disk, or an older version).</summary>
internal sealed class FileSource
{
    public required string Path { get; init; }
    public required string Type { get; init; }
    public required List<string> Groups { get; init; }
    public JsonObject? Actions { get; init; }
    public required long Size { get; init; }
    public required string Sha256 { get; init; }
    public required Func<long, int, byte[]> Read { get; init; }

    public static FileSource From(JazminFileInput input)
    {
        var path = EmbeddedFiles.ValidatePath(input.Path);
        var type = input.Type ?? EmbeddedFiles.MediaType(path);
        var groups = EmbeddedFiles.NormalizeGroups(input.Groups, path);
        var actions = EmbeddedFiles.ActionsJson(input.Actions, path);
        if ((input.Content is null) == (input.FilePath is null)) throw new JazminValidationException($"File '{path}': supply exactly one of content or file");
        if (input.Content is { } bytes)
        {
            return new FileSource
            {
                Path = path, Type = type, Groups = groups, Actions = actions, Size = bytes.Length,
                Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                Read = (offset, length) => bytes.AsSpan((int)offset, length).ToArray(),
            };
        }
        var disk = input.FilePath!;
        string sha;
        long size;
        using (var stream = File.OpenRead(disk))
        {
            size = stream.Length;
            sha = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }
        return new FileSource
        {
            Path = path, Type = type, Groups = groups, Actions = actions, Size = size, Sha256 = sha,
            Read = (offset, length) =>
            {
                using var stream = File.OpenRead(disk);
                stream.Position = offset;
                var buffer = new byte[length];
                stream.ReadExactly(buffer);
                return buffer;
            },
        };
    }
}

/// <summary>A stored content (spec 6.8): one per distinct SHA-256, split into blocks.</summary>
internal sealed class StoredContent
{
    public required int Id { get; init; }
    public required long Size { get; init; }
    public required string Sha256 { get; init; }
    public int BlockSize { get; init; } = EmbeddedFiles.BlockSize;
    public byte[]? Key { get; init; }
    public required List<(long Offset, int Length, string? Digest)> Blocks { get; init; }

    public JsonObject ToJson()
    {
        var json = new JsonObject { ["id"] = Id, ["size"] = Size, ["sha256"] = Sha256, ["blockSize"] = BlockSize };
        if (Key is not null) json["key"] = Convert.ToBase64String(Key);
        json["blocks"] = new JsonArray(Blocks.Select(b =>
        {
            var block = new JsonObject { ["offset"] = b.Offset, ["length"] = b.Length };
            if (b.Digest is not null) block["digest"] = b.Digest;
            return (JsonNode?)block;
        }).ToArray());
        return json;
    }

    /// <summary>Parses an embedded-file directory read from a file (spec 6.8), checking its shape before it is used.</summary>
    public static JsonObject CheckDirectory(string text)
    {
        static bool Count(JsonNode? n, long max = long.MaxValue) => n is JsonValue v && v.TryGetValue<long>(out var x) && x >= 0 && x <= max;
        static bool Text(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out _);
        static bool Base64(JsonNode? n) => Text(n) && Convert.TryFromBase64String((string)n!, new byte[((string)n!).Length], out _);
        static bool Content(JsonNode? c)
        {
            if (c is not JsonObject o || !Count(o["id"], int.MaxValue) || !Count(o["size"]) || !Text(o["sha256"]) || o["blocks"] is not JsonArray blocks) return false;
            if (o["blockSize"] is { } bs && !(Count(bs, int.MaxValue) && (long)bs > 0)) return false;
            var blockSize = (long?)o["blockSize"] ?? EmbeddedFiles.BlockSize;
            return (o["key"] is null || Base64(o["key"]))
                && blocks.Count == ((long)o["size"]! + blockSize - 1) / blockSize
                && blocks.All(b => b is JsonObject bo && Count(bo["offset"]) && Count(bo["length"], int.MaxValue) && (bo["digest"] is null || Base64(bo["digest"])));
        }
        static bool Entry(JsonNode? f) => f is JsonObject o && Text(o["path"]) && Text(o["type"]) && Count(o["content"], int.MaxValue)
            && (o["groups"] is null || o["groups"] is JsonArray g && g.All(Text));

        var json = Values.ParseJson(text, "An embedded-file directory", uniqueNames: true) as JsonObject;
        if (json?["contents"] is not JsonArray contents || json["files"] is not JsonArray files || !contents.All(Content) || !files.All(Entry))
            throw new JazminFormatException("An embedded-file directory is malformed");
        return json;
    }

    public static StoredContent FromJson(JsonNode json) => new()
    {
        Id = (int)json["id"]!,
        Size = (long)json["size"]!,
        Sha256 = (string)json["sha256"]!,
        BlockSize = (int?)json["blockSize"] ?? EmbeddedFiles.BlockSize,
        Key = json["key"] is { } key ? Convert.FromBase64String((string)key!) : null,
        Blocks = json["blocks"]!.AsArray().Select(b => ((long)b!["offset"]!, (int)b["length"]!, (string?)b["digest"])).ToList(),
    };
}

/// <summary>A directory entry: path -> content id, with its groups where known, and its actions (as stored).</summary>
internal sealed record FileEntry(string Path, string Type, int Content, List<string>? Groups, JsonObject? Actions = null);

/// <summary>The files carried from one version of a file to the next (append / update).</summary>
internal sealed record FileState(List<FileEntry> Entries, List<StoredContent> Contents, int NextId, JsonObject? Package);

/// <summary>Read-only, seekable view of an embedded file; decodes one block at a time.</summary>
internal sealed class EmbeddedFileStream(JazminReader reader, StoredContent content) : Stream
{
    private long _position;
    private int _blockIndex = -1;
    private byte[] _block = [];

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => content.Size;

    public override long Position
    {
        get => _position;
        set => _position = value is >= 0 ? value : throw new ArgumentOutOfRangeException(nameof(value));
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        if (_position >= content.Size || buffer.Length == 0) return 0;
        var b = (int)(_position / content.BlockSize);
        if (b != _blockIndex)
        {
            _block = reader.FileBlock(content, b);
            _blockIndex = b;
        }
        var within = (int)(_position - (long)b * content.BlockSize);
        var n = Math.Min(buffer.Length, _block.Length - within);
        _block.AsSpan(within, n).CopyTo(buffer);
        _position += n;
        return n;
    }

    public override long Seek(long offset, SeekOrigin origin) => Position = origin switch
    {
        SeekOrigin.Begin => offset,
        SeekOrigin.Current => _position + offset,
        _ => content.Size + offset,
    };

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
