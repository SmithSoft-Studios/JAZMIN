using System.Collections;
using System.Globalization;
using System.Text.Json.Nodes;
using Jazmin.Query;

namespace Jazmin;

/// <summary>
/// What a file's document may change (spec 7.9): rows of one table, by their key. Set it in
/// <see cref="JazminPackage.Edit"/>; nothing else can be changed through the document.
/// </summary>
public sealed record JazminEditSettings
{
    /// <summary>The table (default: the file's first).</summary>
    public string? Table { get; init; }

    /// <summary>The columns that identify a row: string, int, decimal, datetime or bool.</summary>
    public IReadOnlyList<string> Key { get; init; } = [];

    /// <summary>The columns a change may set (not the key's).</summary>
    public IReadOnlyList<string> Columns { get; init; } = [];

    /// <summary>Whether rows may be added.</summary>
    public bool Add { get; init; }

    /// <summary>Whether rows may be deleted.</summary>
    public bool Delete { get; init; }
}

/// <summary>Changes to a file's rows, each row by its key, once per call (<see cref="JazminFile.WriteChanges"/>).</summary>
public sealed class JazminChanges
{
    /// <summary>The key, and the columns that change.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Update { get; init; } = [];

    /// <summary>The key, and the columns set (the others are left empty).</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Add { get; init; } = [];

    /// <summary>The key only.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Delete { get; init; } = [];
}

/// <summary>A column of a held change: the value the sender saw, the one they want, and the one there now.</summary>
public sealed record JazminChangedColumn(string Name, object? Before, object? Wanted, object? Now);

/// <summary>
/// A change held, not applied: Kind "changed" (a value differs from what the sender saw), "exists" (an added key is
/// there) or "missing" (the row is gone).
/// </summary>
public sealed record JazminChangeConflict(string Op, IReadOnlyDictionary<string, object?> Key, string Kind, IReadOnlyList<JazminChangedColumn>? Columns);

/// <summary>A change never applied: what the document or the sender's grant doesn't allow.</summary>
public sealed record JazminChangeRefusal(string Op, IReadOnlyDictionary<string, object?> Key, string Reason);

/// <summary>What <see cref="JazminFile.ApplyChanges"/> did (or would do, in a dry run).</summary>
public sealed record JazminChangesResult(
    string? Sender, bool FileChanged, long Updated, long Added, long Deleted,
    IReadOnlyList<JazminChangeConflict> Conflicts, IReadOnlyList<JazminChangeRefusal> Refused);

/// <summary>Options of <see cref="JazminFile.ApplyChanges"/>.</summary>
public sealed class JazminApplyChangesOptions
{
    /// <summary>The file's key: a shared file's owner key.</summary>
    public JazminKey? Key { get; init; }

    public string? Password { get; init; }

    /// <summary>A shared file: the sender's access key id, when known (otherwise each grant is tried).</summary>
    public string? KeyId { get; init; }

    /// <summary>Apply rows changed since the sender's copy too.</summary>
    public bool Overwrite { get; init; }

    /// <summary>Everything but the write: what would happen.</summary>
    public bool DryRun { get; init; }

    /// <summary>When the change file arrived (default now): checked against the sender's grant's expiry.</summary>
    public DateTimeOffset? ReceivedAt { get; init; }
}

/// <summary>Change files (spec 7.9): made from an open file, applied by its owner or key holder.</summary>
internal static class Changes
{
    private const int Version = 1;
    private const string Op = "jazmin.op";
    private const string Set = "jazmin.set";
    private const string Before = "jazmin.before.";
    private const string Meta = "jazmin.changes";
    private static readonly string[] Ops = ["add", "update", "delete"];
    private static readonly HashSet<JazminType> KeyTypes = [JazminType.String, JazminType.Int, JazminType.Decimal, JazminType.DateTime, JazminType.Bool];
    private const int FindBatch = 500;

    // ---- package.edit: its shape, and its columns against the table -------------------------------------------

    public static JsonObject EditJson(JazminEditSettings edit)
    {
        static JsonArray Names(IReadOnlyList<string>? names, string what)
        {
            if (names is null || names.Any(string.IsNullOrEmpty)) throw new JazminValidationException($"package.edit.{what} must be a list of column names");
            if (names.Distinct(StringComparer.Ordinal).Count() != names.Count) throw new JazminValidationException($"package.edit.{what} names a column twice");
            return new JsonArray(names.Select(n => (JsonNode?)n).ToArray());
        }
        var json = new JsonObject();
        if (edit.Table is not null) json["table"] = edit.Table;
        json["key"] = Names(edit.Key, "key");
        if (edit.Key.Count == 0) throw new JazminValidationException("package.edit.key: give the column (or columns) that identify a row");
        json["columns"] = Names(edit.Columns, "columns");
        foreach (var c in edit.Columns)
            if (edit.Key.Contains(c, StringComparer.Ordinal)) throw new JazminValidationException($"package.edit.columns: '{c}' is a key column, which changes can't alter");
        if (edit.Add) json["add"] = true;
        if (edit.Delete) json["delete"] = true;
        if (edit.Columns.Count == 0 && !edit.Add && !edit.Delete) throw new JazminValidationException("package.edit allows nothing: give columns, add or delete");
        return json;
    }

    /// <summary>package.edit as read from a file (null when it isn't well formed: such a document allows nothing).</summary>
    public static JazminEditSettings? EditFrom(JsonNode? node)
    {
        if (node is not JsonObject o || o["key"] is not JsonArray key || key.Count == 0 || key.Any(k => k is not JsonValue v || !v.TryGetValue<string>(out _))) return null;
        var columns = o["columns"] is JsonArray c && c.All(x => x is JsonValue v && v.TryGetValue<string>(out _)) ? c.Select(x => (string)x!).ToList() : [];
        static bool Flag(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;
        return new JazminEditSettings
        {
            Table = o["table"] is JsonValue t && t.TryGetValue<string>(out var table) ? table : null,
            Key = key.Select(k => (string)k!).ToList(),
            Columns = columns,
            Add = Flag(o["add"]),
            Delete = Flag(o["delete"]),
        };
    }

    /// <summary>Checks package.edit against the tables written (a table this writer doesn't know was checked before).</summary>
    public static void CheckEdit(JsonNode edit, IReadOnlyList<(string Name, IReadOnlyList<JazminColumn> Columns, string? PartitionBy)> tables, bool partial)
    {
        var settings = EditFrom(edit)!;
        var table = settings.Table is null ? tables[0] : tables.FirstOrDefault(t => t.Name == settings.Table);
        if (table.Columns is null)
        {
            if (partial) return;
            throw new JazminValidationException($"package.edit.table: the file has no table '{settings.Table}'");
        }
        var byName = table.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
        foreach (var k in settings.Key)
        {
            if (!byName.TryGetValue(k, out var c)) throw new JazminValidationException($"package.edit.key: no column '{k}'");
            if (!KeyTypes.Contains(c.Type)) throw new JazminValidationException($"package.edit.key: '{k}' is a {TypeName(c.Type)} column; keys are string, int, decimal, datetime or bool columns");
        }
        foreach (var n in settings.Columns)
            if (!byName.ContainsKey(n)) throw new JazminValidationException($"package.edit.columns: no column '{n}'");
        if (settings.Add)
        {
            var set = settings.Key.Concat(settings.Columns).Append(table.PartitionBy ?? "").ToHashSet(StringComparer.Ordinal);
            foreach (var c in table.Columns)
                if (!c.Nullable && !set.Contains(c.Name)) throw new JazminValidationException($"package.edit.add: column '{c.Name}' can't be empty, so added rows must set it: list it in columns");
        }
    }

    private static string TypeName(JazminType type) => type.ToString().ToLowerInvariant() is "datetime" ? "datetime" : type.ToString().ToLowerInvariant();

    // ---- keys and values ---------------------------------------------------------------------------------------

    private static string KeyText(IReadOnlyDictionary<string, object?> row, IReadOnlyList<string> key) =>
        string.Join('\u001f', key.Select(k => row.TryGetValue(k, out var v) ? Canonical(v) : "\u0000"));

    private static string Canonical(object? v) => v switch
    {
        null => "\u0000",
        DateTime d => d.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
        DateTimeOffset d => d.UtcDateTime.ToString("O", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString() ?? "",
    };

    private static string Show(IReadOnlyDictionary<string, object?> row, IReadOnlyList<string> key) =>
        string.Join(", ", key.Select(k => $"{k} {Canonical(row.TryGetValue(k, out var v) ? v : null)}"));

    private static IReadOnlyDictionary<string, object?> KeyOf(IReadOnlyDictionary<string, object?> row, IReadOnlyList<string> key) =>
        key.ToDictionary(k => k, k => row.TryGetValue(k, out var v) ? v : null, StringComparer.Ordinal);

    /// <summary>Whether two values read from files are the same (any type: dates, bytes, JSON, lists, objects).</summary>
    internal static bool Same(object? a, object? b)
    {
        if (a is null || b is null) return a is null && b is null;
        if (a is byte[] x && b is byte[] y) return x.AsSpan().SequenceEqual(y);
        if (a is JsonNode na && b is JsonNode nb) return JsonNode.DeepEquals(na, nb);
        if (a is IDictionary da && b is IDictionary db)
            return da.Count == db.Count && da.Keys.Cast<object>().All(k => db.Contains(k) && Same(da[k], db[k]));
        if (a is IEnumerable ea && b is IEnumerable eb && a is not string && b is not string)
        {
            var la = ea.Cast<object?>().ToList();
            var lb = eb.Cast<object?>().ToList();
            return la.Count == lb.Count && la.Zip(lb).All(p => Same(p.First, p.Second));
        }
        if (a is DateTime ta && b is DateTime tb) return ta.ToUniversalTime() == tb.ToUniversalTime();
        return Equals(a, b);
    }

    private static JazminFilter KeyFilter(IReadOnlyList<string> key, IEnumerable<IReadOnlyDictionary<string, object?>> rows)
    {
        var list = rows.ToList();
        return key.Count == 1
            ? JazminFilter.In(key[0], list.Select(r => r[key[0]]).ToArray())
            : JazminFilter.Or(list.Select(r => JazminFilter.And(key.Select(k => JazminFilter.Eq(k, r[k])).ToArray())).ToArray());
    }

    /// <summary>Rows by key, read in batches by the key columns.</summary>
    private static Dictionary<string, JazminRow> FindByKeys(JazminReader reader, IReadOnlyList<string> key, IEnumerable<IReadOnlyDictionary<string, object?>> rows)
    {
        var found = new Dictionary<string, JazminRow>(StringComparer.Ordinal);
        var unique = rows.GroupBy(r => KeyText(r, key), StringComparer.Ordinal).Select(g => g.First()).ToList();
        for (var i = 0; i < unique.Count; i += FindBatch)
            foreach (var row in reader.Find(KeyFilter(key, unique.Skip(i).Take(FindBatch))))
                found[KeyText(row, key)] = row;
        return found;
    }

    private static JazminColumn Definition(JazminColumn c, string? name = null, bool? nullable = null) => new(name ?? c.Name, c.Type)
    {
        Nullable = nullable ?? c.Nullable,
        Item = c.Item is null ? null : Definition(c.Item),
        Fields = c.Fields?.Select(f => Definition(f)).ToList(),
    };

    private static bool SameType(JazminColumn a, JazminColumn b) =>
        a.Type == b.Type && (a.Item is null) == (b.Item is null) && (a.Item is null || (a.Item.Nullable == b.Item!.Nullable && SameType(a.Item, b.Item)))
        && (a.Fields is null) == (b.Fields is null)
        && (a.Fields is null || (a.Fields.Count == b.Fields!.Count && a.Fields.Zip(b.Fields).All(p => p.First.Name == p.Second.Name && p.First.Nullable == p.Second.Nullable && SameType(p.First, p.Second))));

    private static JazminReader TableReader(JazminReader reader, JazminEditSettings edit)
    {
        var name = edit.Table ?? reader.Tables[0];
        return reader.TableName == name ? reader : reader.OpenTable(name);
    }

    // ---- writing a change file -----------------------------------------------------------------------------------

    private sealed record Change(string Op, IReadOnlyDictionary<string, object?> Key, Dictionary<string, object?> Values);

    private static List<Change> ChangeList(JazminChanges changes, JazminEditSettings edit, HashSet<string> editable)
    {
        var output = new List<Change>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var op in Ops)
        {
            var list = op switch { "add" => changes.Add, "update" => changes.Update, _ => changes.Delete };
            if (list.Count > 0 && op == "add" && !edit.Add) throw new JazminValidationException("This document doesn't allow adding rows");
            if (list.Count > 0 && op == "delete" && !edit.Delete) throw new JazminValidationException("This document doesn't allow deleting rows");
            foreach (var row in list)
            {
                foreach (var k in edit.Key)
                    if (!row.TryGetValue(k, out var v) || v is null) throw new JazminValidationException($"Changes: a row to {op} without its key column '{k}'");
                var key = KeyOf(row, edit.Key);
                var values = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var (name, value) in row)
                {
                    if (edit.Key.Contains(name, StringComparer.Ordinal)) continue;
                    if (op == "delete") throw new JazminValidationException($"Changes: give the rows to delete by their key only ('{name}' isn't a key column)");
                    if (!editable.Contains(name)) throw new JazminValidationException($"Column '{name}' can't be changed through this document");
                    values[name] = value;
                }
                if (op == "update" && values.Count == 0) throw new JazminValidationException($"Changes: the update of {Show(key, edit.Key)} changes nothing");
                if (!seen.Add(KeyText(key, edit.Key))) throw new JazminValidationException($"Changes: {Show(key, edit.Key)} appears twice: one change per row");
                output.Add(new Change(op, key, values));
            }
        }
        if (output.Count == 0) throw new JazminValidationException("No changes to save");
        return output;
    }

    public static byte[] Write(JazminReader source, JazminChanges changes, JazminKey? key, string? password)
    {
        var edit = source.Package?.Edit ?? throw new JazminValidationException("This file's document doesn't allow changes (it has no package.edit)");
        JazminKey? sealKey = null;
        string? sealPassword = null;
        if (source.Access is { } access)
        {
            if (access.IsOwner) throw new JazminValidationException("A shared file's owner changes it directly (Update, Append), not with a change file");
            sealKey = source.SubmissionKey ?? throw new JazminValidationException("This shared file has no submission keys yet (written before they existed): its owner adds them with any rewrite");
        }
        else if (source.IsEncrypted)
        {
            if (key is null && password is null) throw new JazminValidationException("Give the key or password the file opens with, to seal its changes with");
            (sealKey, sealPassword) = (key, key is null ? password : null);
        }
        var reader = TableReader(source, edit);
        try
        {
            var columns = reader.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
            foreach (var k in edit.Key)
                if (!columns.ContainsKey(k)) throw new JazminValidationException($"The key column '{k}' isn't visible with this key");
            var editable = edit.Columns.Where(columns.ContainsKey).ToList();
            var list = ChangeList(changes, edit, editable.ToHashSet(StringComparer.Ordinal));
            var current = FindByKeys(reader, edit.Key, list.Select(c => c.Key));
            var rows = new List<Dictionary<string, object?>>();
            foreach (var (op, k, values) in list)
            {
                current.TryGetValue(KeyText(k, edit.Key), out var now);
                if (op == "add" && now is not null) throw new JazminValidationException($"A row with {Show(k, edit.Key)} is already there: change it instead");
                if (op != "add" && now is null) throw new JazminValidationException($"No row with {Show(k, edit.Key)} is visible with this key");
                var row = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    [Op] = op,
                    [Set] = op == "delete" ? null : new JsonArray(values.Keys.Select(n => (JsonNode?)n).ToArray()),
                };
                foreach (var (name, value) in k) row[name] = value;
                foreach (var n in editable)
                {
                    row[n] = values.TryGetValue(n, out var v) ? v : null;
                    row[Before + n] = op == "delete" || (op == "update" && values.ContainsKey(n)) ? now![n] : null;
                }
                rows.Add(row);
            }
            var definitions = new List<JazminColumn> { new(Op, JazminType.String) { Nullable = false }, new(Set, JazminType.Json) };
            definitions.AddRange(edit.Key.Select(k => Definition(columns[k])));
            definitions.AddRange(editable.Select(n => Definition(columns[n], nullable: true)));
            definitions.AddRange(editable.Select(n => Definition(columns[n], Before + n, nullable: true)));
            var metadata = new JsonObject
            {
                [Meta] = new JsonObject
                {
                    ["version"] = Version,
                    ["file"] = source.FileId,
                    ["table"] = reader.TableName,
                    ["key"] = new JsonArray(edit.Key.Select(k => (JsonNode?)k).ToArray()),
                    ["columns"] = new JsonArray(editable.Select(n => (JsonNode?)n).ToArray()),
                    ["sender"] = source.Access?.KeyId,
                    ["based"] = new JsonObject
                    {
                        ["writtenAt"] = source.WrittenAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
                        ["appendCount"] = source.AppendCount,
                    },
                },
            };
            var stream = new MemoryStream();
            using (var writer = new JazminWriter(stream, definitions, new JazminWriteOptions { Key = sealKey, Password = sealPassword, Metadata = metadata }, leaveOpen: true))
                foreach (var row in rows) writer.WriteRow(row);
            return stream.ToArray();
        }
        finally
        {
            if (!ReferenceEquals(reader, source)) reader.Dispose();
        }
    }

    // ---- applying a change file ------------------------------------------------------------------------------------

    private static (JazminReader Reader, JazminGrantInfo? Grant) OpenChangeFile(JazminReader target, byte[] change, JazminApplyChangesOptions options)
    {
        if (target.Access is null)
        {
            try
            {
                return (JazminReader.Open(change, new JazminReadOptions { Key = options.Key, Password = options.Password }), null);
            }
            catch (JazminKeyException)
            {
                throw new JazminValidationException("The change file doesn't open with this file's key: it was made for another file");
            }
        }
        var owner = options.Key ?? throw new JazminValidationException("A shared file's changes are applied with its owner key");
        var grants = target.Access.Grants ?? [];
        var candidates = options.KeyId is null ? grants : grants.Where(g => g.KeyId == options.KeyId).ToList();
        if (options.KeyId is not null && candidates.Count == 0) throw new JazminValidationException($"Key {options.KeyId} has no grant in this file: unknown or revoked");
        foreach (var grant in candidates)
        {
            JazminReader reader;
            try
            {
                reader = JazminReader.Open(change, new JazminReadOptions { Key = owner.SubmissionKey(grant.KeyId) });
            }
            catch (JazminKeyException)
            {
                continue;
            }
            if (grant.Expires is { } expires)
            {
                var received = options.ReceivedAt ?? DateTimeOffset.UtcNow;
                var problem = received > expires ? $"it arrived at {received:O}, after the key's access expired at {expires:O}"
                    : reader.WrittenAt > expires ? $"it was written at {reader.WrittenAt:O}, after the key's access expired at {expires:O}" : null;
                if (problem is not null)
                {
                    reader.Dispose();
                    throw new JazminValidationException($"Key {grant.KeyId}'s change file can't be applied: {problem}");
                }
            }
            return (reader, grant);
        }
        throw new JazminValidationException("The change file doesn't open with the submission key of any key granted this file: it was made by a revoked key, for another file, or changed");
    }

    public static JazminChangesResult Apply(string path, byte[] change, JazminApplyChangesOptions options)
    {
        JazminEditSettings edit;
        string tableName;
        bool severalTables;
        (List<Dictionary<string, object?>> Upsert, List<IReadOnlyDictionary<string, object?>> Remove, JazminChangesResult Result) plan;
        using (var target = JazminReader.Open(path, new JazminReadOptions { Key = options.Key, Password = options.Password }))
        {
            if (target.Access is { IsOwner: false }) throw new JazminValidationException("A shared file's changes are applied with its owner key");
            edit = target.Package?.Edit ?? throw new JazminValidationException("The file doesn't take changes: its document has no package.edit");
            severalTables = target.Tables.Count > 1;
            var table = TableReader(target, edit);
            tableName = table.TableName;
            try
            {
                var (reader, grant) = OpenChangeFile(target, change, options);
                using (reader) plan = Plan(target, table, reader, grant, edit, options.Overwrite);
            }
            finally
            {
                if (!ReferenceEquals(table, target)) table.Dispose();
            }
        }
        var (upsert, remove, result) = plan;
        if (!options.DryRun && (upsert.Count > 0 || remove.Count > 0))
        {
            JazminFile.Append(path, new JazminAppend
            {
                Key = options.Key,
                Password = options.Password,
                Table = severalTables ? tableName : null,
                Upsert = upsert,
                KeyColumns = upsert.Count > 0 ? edit.Key : null,
                Delete = remove.Count > 0 ? KeyFilter(edit.Key, remove) : null,
            });
        }
        return result;
    }

    private static (List<Dictionary<string, object?>>, List<IReadOnlyDictionary<string, object?>>, JazminChangesResult) Plan(
        JazminReader target, JazminReader table, JazminReader changes, JazminGrantInfo? grant, JazminEditSettings edit, bool overwrite)
    {
        var meta = changes.Metadata[Meta] as JsonObject;
        if (meta is null || (int?)meta["version"] != Version) throw new JazminValidationException("This is not a change file (version 1)");
        var metaKey = meta["key"] is JsonArray mk ? mk.Select(k => (string?)k).ToList() : [];
        if ((string?)meta["table"] != table.TableName || !metaKey.SequenceEqual(edit.Key))
            throw new JazminValidationException($"The change file is for table '{meta["table"]}' by [{string.Join(", ", metaKey)}]; this file's document changes '{table.TableName}' by [{string.Join(", ", edit.Key)}]");
        var columns = table.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
        var changeColumns = changes.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
        foreach (var (name, c) in changeColumns)
        {
            if (name is Op or Set) continue;
            var baseName = name.StartsWith(Before, StringComparison.Ordinal) ? name[Before.Length..] : name;
            if (!columns.TryGetValue(baseName, out var mine)) throw new JazminValidationException($"The change file has a column '{baseName}' this file doesn't have");
            if (!SameType(mine, c)) throw new JazminValidationException($"Column '{baseName}' is {TypeName(c.Type)} in the change file, {TypeName(mine.Type)} in this file");
        }

        var partitionBy = target.Access?.PartitionBy;
        var own = grant?.Rows is { } rows ? rows.ToHashSet(StringComparer.Ordinal) : null;
        var covered = grant?.Columns is { } groups ? groups.SelectMany(g => target.Access!.GroupColumns!.TryGetValue(g, out var cs) ? cs : []).ToHashSet(StringComparer.Ordinal) : null;
        bool MayWrite(string name) => edit.Columns.Contains(name, StringComparer.Ordinal) && changeColumns.ContainsKey(name) && (covered is null || covered.Contains(name));
        bool OwnsPartition(IReadOnlyDictionary<string, object?> row) => partitionBy is null || own is null || own.Contains(Canonical(row[partitionBy]));

        var list = changes.Rows().Select(r => (IReadOnlyDictionary<string, object?>)r).ToList();
        var current = FindByKeys(table, edit.Key, list);
        var state = current.ToDictionary(p => p.Key, p => (Dictionary<string, object?>?)new Dictionary<string, object?>(p.Value, StringComparer.Ordinal), StringComparer.Ordinal);
        var touched = new List<string>();
        var conflicts = new List<JazminChangeConflict>();
        var refused = new List<JazminChangeRefusal>();
        long updated = 0, added = 0, deleted = 0;

        foreach (var row in list)
        {
            var op = row[Op] as string ?? "";
            var key = KeyOf(row, edit.Key);
            var text = KeyText(row, edit.Key);
            void Refuse(string reason) => refused.Add(new JazminChangeRefusal(op, key, reason));
            if (!Ops.Contains(op)) { Refuse($"unknown operation '{op}'"); continue; }
            if (edit.Key.Any(k => row[k] is null)) { Refuse("no key"); continue; }
            if (op == "add" && !edit.Add) { Refuse("the document doesn't allow adding rows"); continue; }
            if (op == "delete" && !edit.Delete) { Refuse("the document doesn't allow deleting rows"); continue; }
            List<string>? set = op == "delete" ? [] : row[Set] is JsonArray a && a.All(x => x is JsonValue v && v.TryGetValue<string>(out _)) ? a.Select(x => (string)x!).ToList() : null;
            if (set is null) { Refuse("no list of the columns it sets"); continue; }
            var notAllowed = set.FirstOrDefault(n => !MayWrite(n));
            if (notAllowed is not null) { Refuse($"column '{notAllowed}' can't be changed by this sender"); continue; }
            state.TryGetValue(text, out var now);
            if (now is not null && !OwnsPartition(now)) { Refuse($"the row is in partition '{Canonical(now[partitionBy!])}', which this sender isn't granted"); continue; }
            if (partitionBy is not null && set.Contains(partitionBy) && own is not null && !own.Contains(Canonical(row[partitionBy]))) { Refuse($"partition '{Canonical(row[partitionBy])}' isn't granted to this sender"); continue; }
            List<JazminChangedColumn> ChangedSince(IEnumerable<string> names) => names
                .Where(n => !Same(now![n], row[Before + n]))
                .Select(n => new JazminChangedColumn(n, row[Before + n], op == "delete" ? null : row[n], now![n])).ToList();

            if (op == "update" || (op == "add" && now is not null))
            {
                if (now is null) { conflicts.Add(new JazminChangeConflict(op, key, "missing", null)); continue; }
                if (op == "add")
                {
                    if (!overwrite) { conflicts.Add(new JazminChangeConflict(op, key, "exists", null)); continue; }
                }
                else
                {
                    var changed = ChangedSince(set);
                    if (changed.Count > 0 && !overwrite) { conflicts.Add(new JazminChangeConflict(op, key, "changed", changed)); continue; }
                }
                var next = new Dictionary<string, object?>(now, StringComparer.Ordinal);
                foreach (var n in set) next[n] = row[n];
                state[text] = next;
                touched.Add(text);
                updated++;
            }
            else if (op == "add")
            {
                var next = table.Columns.ToDictionary(c => c.Name, _ => (object?)null, StringComparer.Ordinal);
                foreach (var (k, v) in key) next[k] = v;
                foreach (var n in set) next[n] = row[n];
                if (partitionBy is not null && !set.Contains(partitionBy))
                {
                    if (own is { Count: 1 } && columns[partitionBy].Type == JazminType.String) next[partitionBy] = own.First(); // a grant of one partition
                    else { Refuse($"an added row must name its partition ({partitionBy})"); continue; }
                }
                if (!OwnsPartition(next)) { Refuse($"partition '{Canonical(next[partitionBy!])}' isn't granted to this sender"); continue; }
                var empty = table.Columns.FirstOrDefault(c => !c.Nullable && next[c.Name] is null);
                if (empty is not null) { Refuse($"column '{empty.Name}' can't be empty"); continue; }
                state[text] = next;
                touched.Add(text);
                added++;
            }
            else
            {
                if (now is null) { conflicts.Add(new JazminChangeConflict(op, key, "missing", null)); continue; }
                var changed = ChangedSince(edit.Columns.Where(n => changeColumns.ContainsKey(Before + n)));
                if (changed.Count > 0 && !overwrite) { conflicts.Add(new JazminChangeConflict(op, key, "changed", changed)); continue; }
                state[text] = null;
                touched.Add(text);
                deleted++;
            }
        }

        var upsert = new List<Dictionary<string, object?>>();
        var remove = new List<IReadOnlyDictionary<string, object?>>();
        foreach (var text in touched.Distinct(StringComparer.Ordinal))
        {
            if (state.TryGetValue(text, out var final) && final is not null) upsert.Add(final);
            else if (current.TryGetValue(text, out var was)) remove.Add(was);
        }
        var result = new JazminChangesResult(grant?.KeyId, (string?)meta["file"] != target.FileId, updated, added, deleted, conflicts, refused);
        return (upsert, remove, result);
    }
}
