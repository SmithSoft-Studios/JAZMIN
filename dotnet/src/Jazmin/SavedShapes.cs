using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Formats;

namespace Jazmin;

/// <summary>
/// An export shape saved in a file under a name (docs/design/saved-shapes.md), which viewers and tools offer by name. In
/// a shared file, each key that sees it (its <see cref="Groups"/>) must see every column it uses, or the write is
/// refused; readers list only the shapes their key can use.
/// </summary>
public sealed class JazminSavedShape
{
    public JazminSavedShape(string name, JsonObject shape)
    {
        Name = name;
        Shape = shape ?? throw new ArgumentNullException(nameof(shape));
    }

    /// <summary>1 to 200 characters, unique in the file.</summary>
    public string Name { get; }

    /// <summary>The export shape, as <see cref="JazminShape.FromJson"/> takes it (run a saved one with <see cref="JazminShape.FromFile"/>).</summary>
    public JsonObject Shape { get; }

    public string? Description { get; init; }

    /// <summary>Offered first (at most one default for each group).</summary>
    public bool IsDefault { get; init; }

    /// <summary>The table the shape reads (null: the file's first).</summary>
    public string? Table { get; init; }

    /// <summary>
    /// File groups whose keys see it: ["*"] (null: everyone) or partition / named file-group names. Read back by the
    /// owner and in files that aren't shared.
    /// </summary>
    public IReadOnlyList<string>? Groups { get; init; }
}

/// <summary>A saved shape, checked: its groups normalized and its shape copied.</summary>
internal sealed record SavedShape(string Name, string? Description, bool IsDefault, string? Table, List<string> Groups, JsonObject Shape)
{
    public JazminSavedShape ToPublic(bool withGroups) => new(Name, (JsonObject)Shape.DeepClone())
    {
        Description = Description, IsDefault = IsDefault, Table = Table, Groups = withGroups ? Groups.ToList() : null,
    };

    /// <summary>The directory entry (spec 6.8); no table for the file's first one, and groups only where files have them.</summary>
    public JsonObject ToJson(bool withGroups, string firstTable)
    {
        var json = new JsonObject { ["name"] = Name };
        if (!string.IsNullOrEmpty(Description)) json["description"] = Description;
        if (IsDefault) json["default"] = true;
        if (Table is not null && Table != firstTable) json["table"] = Table;
        if (withGroups) json["groups"] = new JsonArray(Groups.Select(g => (JsonNode?)g).ToArray());
        json["shape"] = Shape.DeepClone();
        return json;
    }
}

/// <summary>A table's columns by column group, for checking saved shapes.</summary>
internal sealed record ShapeTable(string Name, List<(string Group, IReadOnlyList<JazminColumn> Columns)> Groups)
{
    /// <summary>The table's columns as a reader sees them (the owner, or a single key).</summary>
    public static ShapeTable Of(JazminReader reader)
    {
        var columns = reader.Columns;
        if (reader.Access?.GroupColumns is not { } groups) return new(reader.TableName, [(EmbeddedFiles.Everyone, columns)]);
        var byName = columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
        return new(reader.TableName, groups.Select(g => (g.Key, (IReadOnlyList<JazminColumn>)g.Value.Select(n => byName[n]).ToList())).ToList());
    }
}

/// <summary>A key that would see saved shapes: who it is, its column groups (null: all) and the file groups it sees.</summary>
internal sealed record ShapeViewer(Func<string> Who, IReadOnlySet<string>? Columns, Func<string, bool> Sees);

/// <summary>Saved export shapes (spec 6.8): checked when written, read from the file directories.</summary>
internal static class SavedShapes
{
    public const int MaxShapes = 1000;
    private const int MaxName = 200;
    private const int MaxDescription = 2000;

    public static SavedShape Normalize(JazminSavedShape s, string where)
    {
        ArgumentNullException.ThrowIfNull(s, where);
        if (string.IsNullOrWhiteSpace(s.Name) || s.Name.Length > MaxName) throw new JazminValidationException($"{where}: name must be text of 1 to {MaxName} characters");
        var label = $"Saved shape '{s.Name}'";
        if (s.Description is { Length: > MaxDescription }) throw new JazminValidationException($"{label}: description must be text of at most {MaxDescription} characters");
        if (s.Table is "") throw new JazminValidationException($"{label}: table must name a table");
        return new SavedShape(s.Name, string.IsNullOrEmpty(s.Description) ? null : s.Description, s.IsDefault, s.Table, Groups(s.Groups, label), (JsonObject)s.Shape.DeepClone());
    }

    /// <summary>The file groups whose keys see a shape: "*" (everyone) or names, as for embedded files.</summary>
    private static List<string> Groups(IReadOnlyList<string>? groups, string label)
    {
        if (groups is null) return [EmbeddedFiles.Everyone];
        if (groups.Count == 0) throw new JazminValidationException($"{label}: groups must be '*' or a non-empty array");
        var names = groups.Distinct(StringComparer.Ordinal).ToList();
        foreach (var g in names)
            if (string.IsNullOrEmpty(g) || g.Length > 256) throw new JazminValidationException($"{label}: invalid group name '{g}'");
        return names.Contains(EmbeddedFiles.Everyone) ? [EmbeddedFiles.Everyone] : names.Order(StringComparer.Ordinal).ToList();
    }

    public static List<SavedShape> NormalizeList(IReadOnlyList<JazminSavedShape>? list, string what = "shapes")
    {
        var shapes = (list ?? []).Select((s, n) => Normalize(s, $"{what}[{n}]")).ToList();
        CheckList(shapes);
        return shapes;
    }

    /// <summary>Names unique, at most one default in each group, at most <see cref="MaxShapes"/>.</summary>
    public static void CheckList(IReadOnlyCollection<SavedShape> shapes)
    {
        if (shapes.Count > MaxShapes) throw new JazminValidationException($"A file keeps at most {MaxShapes} saved shapes");
        var names = new HashSet<string>(StringComparer.Ordinal);
        var defaults = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var s in shapes)
        {
            if (!names.Add(s.Name)) throw new JazminValidationException($"Saved shape '{s.Name}' is given twice");
            if (!s.IsDefault) continue;
            foreach (var g in s.Groups)
            {
                if (defaults.TryGetValue(g, out var other))
                    throw new JazminValidationException($"Saved shapes '{other}' and '{s.Name}' are both the default for {(g == EmbeddedFiles.Everyone ? "everyone" : $"group '{g}'")}");
                defaults[g] = s.Name;
            }
        }
    }

    /// <summary>
    /// Checks saved shapes against the file's tables (the first table first) and, in shared files, against the columns of
    /// every key that sees them. Throws naming the shape, the key and the mistake.
    /// </summary>
    public static void Check(IReadOnlyCollection<SavedShape> shapes, IReadOnlyList<ShapeTable> tables, IReadOnlyList<ShapeViewer>? viewers = null)
    {
        if (shapes.Count == 0) return;
        var byName = tables.ToDictionary(t => t.Name, StringComparer.Ordinal);
        void Fit(SavedShape s, IReadOnlySet<string>? visible)
        {
            IReadOnlyList<JazminColumn>? ColumnsOf(string name) => byName.TryGetValue(name, out var t)
                ? t.Groups.Where(g => visible is null || visible.Contains(g.Group)).SelectMany(g => g.Columns).ToList()
                : null;
            JazminShape.Check(s.Shape, s.Table ?? tables[0].Name, ColumnsOf);
        }
        var seen = new Dictionary<string, string?>(StringComparer.Ordinal); // shape and column groups -> the mistake: keys with the same columns are checked once
        foreach (var s in shapes)
        {
            if (s.Table is not null && !byName.ContainsKey(s.Table)) throw new JazminValidationException($"Saved shape '{s.Name}': unknown table '{s.Table}'");
            try
            {
                Fit(s, null);
            }
            catch (JazminValidationException e)
            {
                throw new JazminValidationException($"Saved shape '{s.Name}': {e.Message}");
            }
            foreach (var v in viewers ?? [])
            {
                var group = s.Groups.FirstOrDefault(v.Sees);
                if (group is null) continue;
                var id = $"{s.Name}\0{(v.Columns is null ? "*" : string.Join('\u0001', v.Columns.Order(StringComparer.Ordinal)))}";
                if (!seen.TryGetValue(id, out var mistake))
                {
                    try
                    {
                        Fit(s, v.Columns);
                        mistake = null;
                    }
                    catch (JazminValidationException e)
                    {
                        mistake = e.Message;
                    }
                    seen[id] = mistake;
                }
                if (mistake is not null)
                {
                    var why = group == EmbeddedFiles.Everyone ? "a shape for everyone" : $"file group '{group}'";
                    throw new JazminValidationException($"Saved shape '{s.Name}' doesn't fit access key {v.Who()}, which sees it ({why}): {mistake}");
                }
            }
        }
    }

    /// <summary>A file directory's saved shapes (spec 6.8): its well-formed entries. Readers ignore others, as other members.</summary>
    public static IEnumerable<(SavedShape Shape, bool HasGroups)> FromDirectory(JsonObject directory)
    {
        if (directory["shapes"] is not JsonArray list) yield break;
        static bool Text(JsonNode? n, out string text)
        {
            text = "";
            return n is JsonValue v && v.GetValueKind() == JsonValueKind.String && v.TryGetValue(out text!);
        }
        foreach (var node in list)
        {
            if (node is not JsonObject o || !Text(o["name"], out var name) || name.Length == 0 || o["shape"] is not JsonObject shape) continue;
            string? description = null, table = null;
            if (o.ContainsKey("description") && !Text(o["description"], out description!)) continue;
            if (o.ContainsKey("table") && !Text(o["table"], out table!)) continue;
            var isDefault = false;
            if (o.ContainsKey("default"))
            {
                if (o["default"] is not JsonValue d || d.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False)) continue;
                isDefault = d.GetValue<bool>();
            }
            List<string>? groups = null;
            if (o.ContainsKey("groups"))
            {
                if (o["groups"] is not JsonArray g) continue;
                groups = new List<string>();
                foreach (var item in g)
                {
                    if (!Text(item, out var text)) break;
                    groups.Add(text);
                }
                if (groups.Count != g.Count) continue;
            }
            yield return (new SavedShape(name, string.IsNullOrEmpty(description) ? null : description, isDefault, table, groups ?? [], (JsonObject)shape.DeepClone()), groups is not null);
        }
    }

    /// <summary>Does the shape fit the columns this reader sees, in every table it reads?</summary>
    public static bool Fits(SavedShape s, string firstTable, Func<string, IReadOnlyList<JazminColumn>?> columnsOf)
    {
        try
        {
            JazminShape.Check(s.Shape, s.Table ?? firstTable, columnsOf);
            return true;
        }
        catch (Exception e) when (e is JazminException or InvalidOperationException or FormatException or ArgumentException)
        {
            return false; // a shape this key can't use, or one this library doesn't understand
        }
    }

    /// <summary>The saved shapes a change keeps: the file's, less those removed by name or given again.</summary>
    public static List<SavedShape> Kept(IReadOnlyList<SavedShape> existing, IReadOnlyList<JazminSavedShape> add, IReadOnlyList<string> remove)
    {
        var kept = existing.ToDictionary(s => s.Name, StringComparer.Ordinal);
        foreach (var name in remove)
            if (!kept.Remove(name)) throw new JazminValidationException($"RemoveShapes: no saved shape '{name}'");
        foreach (var s in add) kept.Remove(s.Name);
        return kept.Values.ToList();
    }
}
