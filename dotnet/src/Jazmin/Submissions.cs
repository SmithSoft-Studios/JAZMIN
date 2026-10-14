using System.Globalization;
using System.Text.Json.Nodes;
using Jazmin.Query;

namespace Jazmin;

/// <summary>What <see cref="JazminFileSubmissionOptions.OnDuplicate"/> does with a record whose id is already filed.</summary>
public enum JazminOnDuplicate
{
    /// <summary>The record sent again changes the filed one (its values that aren't empty); the last to arrive wins.</summary>
    Replace,

    /// <summary>A filed record never changes; only the first row of a new id counts.</summary>
    Skip,
}

/// <summary>Options of <see cref="JazminFile.FileSubmission"/>.</summary>
public sealed class JazminFileSubmissionOptions
{
    /// <summary>The shared file's owner key.</summary>
    public JazminKey? Key { get; init; }

    /// <summary>The sender's access key id (the filing layout names each batch &lt;key id&gt;.&lt;anything&gt;.jzm).</summary>
    public string? KeyId { get; init; }

    /// <summary>When the batch arrived (default now), by the server's clock: checked against the grant's expiry.</summary>
    public DateTimeOffset? ReceivedAt { get; init; }

    /// <summary>The column that identifies a record (default "id"): a record sent again changes the filed one.</summary>
    public string IdColumn { get; init; } = "id";

    public JazminOnDuplicate OnDuplicate { get; init; } = JazminOnDuplicate.Replace;

    /// <summary>The json column listing each record's files (default "attachments").</summary>
    public string FilesColumn { get; init; } = "attachments";

    /// <summary>The kinds of file accepted (default all of <see cref="JazminFile.SubmissionFileTypes"/>).</summary>
    public IReadOnlyList<string>? FileTypes { get; init; }

    /// <summary>Largest file (default 10 MB).</summary>
    public long MaxFileBytes { get; init; } = 10 * 1024 * 1024;

    /// <summary>Largest total of a batch's files, identical files counted once (default 50 MB).</summary>
    public long MaxBatchFileBytes { get; init; } = 50 * 1024 * 1024;

    /// <summary>Check everything but the write: what would be filed.</summary>
    public bool DryRun { get; init; }
}

/// <summary>
/// What <see cref="JazminFile.FileSubmission"/> filed (or would, in a dry run): new records, records changed, rows that
/// changed nothing (a batch sent twice), files stored or newly shared, and the batch's columns not filed.
/// </summary>
public sealed record JazminSubmissionResult(string Sender, long Filed, long Updated, long Duplicates, int Files, IReadOnlyList<string> IgnoredColumns);

/// <summary>
/// Filing submissions (USER-GUIDE 15.6): records an access key holder sent back, locked with their submission key,
/// checked and filed into the shared file by its owner. The same rules as the JavaScript library's fileSubmission.
/// </summary>
internal static class Submissions
{
    private sealed record FileKind(string Name, string Ext, Func<byte[], bool> Test);

    private static readonly Dictionary<string, FileKind> Kinds = new(StringComparer.Ordinal)
    {
        ["application/pdf"] = new("PDF", ".pdf", b => StartsWith(b, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])), // %PDF-
        ["image/jpeg"] = new("JPEG", ".jpg", b => StartsWith(b, 0, [0xff, 0xd8, 0xff])),
        ["image/png"] = new("PNG", ".png", b => StartsWith(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        ["image/webp"] = new("WebP", ".webp", b => StartsWith(b, 0, [0x52, 0x49, 0x46, 0x46]) && StartsWith(b, 8, [0x57, 0x45, 0x42, 0x50])), // RIFF....WEBP
    };

    public static readonly IReadOnlyList<string> FileTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

    private static bool StartsWith(byte[] bytes, int at, ReadOnlySpan<byte> magic) =>
        bytes.Length >= at + magic.Length && bytes.AsSpan(at, magic.Length).SequenceEqual(magic);

    private static JazminSubmissionRejectedException Rejected(string message) => new(message);

    /// <summary>Empty values leave a filed field as it is.</summary>
    private static bool IsEmpty(object? value) => value is null || value is string { Length: 0 };

    private static string Text(object? v) => v switch
    {
        null => "null",
        DateTime d => d.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString() ?? "",
    };

    private sealed record BatchFile(byte[] Bytes, string Type, string Sha256);

    private sealed record Plan(
        List<Dictionary<string, object?>> Inserts, List<Dictionary<string, object?>> Upsert, List<JazminFileInput> AddFiles,
        List<string> RemoveFiles, int Rows, List<string> IgnoredColumns);

    public static JazminSubmissionResult File(string path, byte[] batch, JazminFileSubmissionOptions options)
    {
        ArgumentNullException.ThrowIfNull(batch);
        ArgumentNullException.ThrowIfNull(options);
        var owner = options.Key ?? throw new JazminValidationException("FileSubmission needs the shared file's owner key");
        var fileTypes = options.FileTypes ?? FileTypes;
        foreach (var type in fileTypes)
            if (!Kinds.ContainsKey(type)) throw new JazminValidationException($"Unknown file type '{type}': one of {string.Join(", ", FileTypes)}");
        if (!Enum.IsDefined(options.OnDuplicate)) throw new JazminValidationException($"OnDuplicate must be Replace or Skip, not {options.OnDuplicate}");
        var keyId = options.KeyId;
        if (keyId is null || keyId.Length != 16 || !keyId.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
            throw Rejected($"'{keyId}' is not an access key id");

        Plan plan;
        using (var shared = JazminReader.Open(path, new JazminReadOptions { Key = owner }))
        {
            if (shared.Access is null) throw new JazminValidationException("Submissions are filed into a shared file (one with access keys)");
            if (!shared.Access.IsOwner) throw new JazminValidationException("Submissions are filed with the shared file's owner key, not an access key");
            plan = PlanBatch(shared, owner, keyId, batch, options, fileTypes);
        }
        if (!options.DryRun && (plan.Inserts.Count > 0 || plan.Upsert.Count > 0))
        {
            try
            {
                JazminFile.Append(path, new JazminAppend
                {
                    Key = owner,
                    Insert = plan.Inserts,
                    Upsert = plan.Upsert,
                    KeyColumns = plan.Upsert.Count > 0 ? [options.IdColumn] : null,
                    AddFiles = plan.AddFiles,
                    RemoveFiles = plan.RemoveFiles,
                });
            }
            catch (JazminValidationException error)
            {
                throw Rejected($"The batch's rows don't fit the shared file: {error.Message}");
            }
        }
        return new JazminSubmissionResult(keyId, plan.Inserts.Count, plan.Upsert.Count, plan.Rows - plan.Inserts.Count - plan.Upsert.Count, plan.AddFiles.Count, plan.IgnoredColumns);
    }

    /// <summary>What a batch changes, worked out from one open reader of the shared file (owner key).</summary>
    private static Plan PlanBatch(JazminReader shared, JazminKey owner, string keyId, byte[] batch, JazminFileSubmissionOptions options, IReadOnlyList<string> fileTypes)
    {
        var idColumn = options.IdColumn;
        var filesColumn = options.FilesColumn;
        var replace = options.OnDuplicate == JazminOnDuplicate.Replace;
        var access = shared.Access!;
        var grant = (access.Grants ?? []).FirstOrDefault(g => g.KeyId == keyId)
            ?? throw Rejected($"Key {keyId} has no grant in this file: unknown or revoked");
        var expires = grant.Expires;
        if (expires is { } until)
        {
            var arrived = options.ReceivedAt ?? DateTimeOffset.UtcNow;
            if (arrived > until) throw Rejected($"The batch arrived at {Iso(arrived)}, after key {keyId}'s access expired at {Iso(until)}");
        }
        var columns = shared.Columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
        var partitionBy = access.PartitionBy;
        var covered = grant.Columns is { } groups
            ? groups.SelectMany(g => access.GroupColumns is not null && access.GroupColumns.TryGetValue(g, out var cs) ? cs : []).ToHashSet(StringComparer.Ordinal)
            : null;
        var storedFiles = shared.Files.ToDictionary(f => f.Path, StringComparer.Ordinal);

        // The batch: only the columns the sender may write are read.
        var writable = new List<string>();
        var ignoredColumns = new List<string>();
        List<Dictionary<string, object?>> rows;
        Dictionary<string, BatchFile> files;
        bool withFiles;
        try
        {
            using var reader = JazminReader.Open(batch, new JazminReadOptions { Key = owner.SubmissionKey(keyId) });
            if (expires is { } ends && reader.WrittenAt > ends)
                throw Rejected($"The batch was written at {Iso(reader.WrittenAt)}, after key {keyId}'s access expired at {Iso(ends)}");
            foreach (var c in reader.Columns)
            {
                if (!columns.TryGetValue(c.Name, out var known) || (covered is not null && !covered.Contains(c.Name)))
                {
                    ignoredColumns.Add(c.Name); // not in the shared file, or not the sender's to write
                    continue;
                }
                if (known.Type != c.Type) throw Rejected($"Column '{c.Name}' is {TypeName(c.Type)} in the batch, {TypeName(known.Type)} in the shared file");
                writable.Add(c.Name);
            }
            if (writable.Count == 0) throw Rejected($"The batch has no column key {keyId} may write");
            withFiles = columns.TryGetValue(filesColumn, out var fc) && fc.Type == JazminType.Json && writable.Contains(filesColumn);
            rows = reader.Rows(new JazminQueryOptions { Select = writable })
                .Select(r => writable.ToDictionary(n => n, n => r[n], StringComparer.Ordinal)).ToList();
            files = BatchFiles(reader, withFiles ? rows.Select(r => r[filesColumn]) : [], filesColumn, fileTypes, options);
        }
        catch (JazminSubmissionRejectedException)
        {
            throw;
        }
        catch (JazminKeyException)
        {
            throw Rejected($"The batch doesn't open with key {keyId}'s submission key: it was made without it, or changed");
        }
        catch (JazminException error)
        {
            throw Rejected($"The batch is not a readable .jzm file: {error.Message}");
        }

        // Records already filed, by id: whole when they may be changed.
        var hasId = writable.Contains(idColumn);
        string? IdOf(Dictionary<string, object?> row) => hasId && !IsEmpty(row[idColumn]) ? Text(row[idColumn]) : null;
        var filed = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
        var ids = hasId ? rows.Select(r => r[idColumn]).Where(v => !IsEmpty(v)).DistinctBy(Text).ToArray() : [];
        if (ids.Length > 0)
        {
            var found = shared.Find(JazminFilter.In(idColumn, ids), replace ? null : new JazminQueryOptions { Select = [idColumn] });
            foreach (var r in found) filed[Text(r[idColumn])] = new Dictionary<string, object?>(r, StringComparer.Ordinal);
        }

        // Partitions: the sender's own, or one it's granted; a change without one keeps the record's.
        var own = grant.Rows; // partition names (null: every partition)
        if (partitionBy is not null)
        {
            var forced = own is { Count: 1 } && columns[partitionBy].Type == JazminType.String ? own[0] : null;
            foreach (var row in rows)
            {
                var id = IdOf(row);
                var before = id is null ? null : filed.GetValueOrDefault(id);
                if (forced is not null) row[partitionBy] = forced;
                else if (IsEmpty(row.GetValueOrDefault(partitionBy)) && before is not null) row[partitionBy] = before[partitionBy];
                if (own is not null && !own.Contains(Text(row.GetValueOrDefault(partitionBy))))
                    throw Rejected($"A row is for partition '{Text(row.GetValueOrDefault(partitionBy))}', which key {keyId} isn't granted");
            }
        }

        // A row's files, at paths chosen here, seen by the keys that see the row's partition. Entries it keeps
        // ({ path, ... }) must be files the filed record lists.
        var addFiles = new Dictionary<string, (byte[] Content, string Type, HashSet<string> Groups)>(StringComparer.Ordinal);
        void Attach(Dictionary<string, object?> row, object? filedList)
        {
            if (row[filesColumn] is not JsonArray list) return;
            var group = partitionBy is null ? "*" : Text(row[partitionBy]);
            var kept = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
            foreach (var e in ListOf(filedList)) if (PathOf(e) is { } p) kept[p] = e!;
            var entries = new Dictionary<string, JsonNode>(StringComparer.Ordinal); // path in the shared file -> entry
            foreach (var item in list)
            {
                if (item is not JsonValue v || !v.TryGetValue<string>(out var batchPath))
                {
                    var keptPath = PathOf(item)!;
                    if (!kept.TryGetValue(keptPath, out var entry)) throw Rejected($"Record '{Text(row.GetValueOrDefault(idColumn))}' lists '{keptPath}', which isn't one of its files");
                    entries[keptPath] = entry.DeepClone();
                    continue;
                }
                var f = files[batchPath];
                var path = $"attachments/{keyId}/{f.Sha256}{Kinds[f.Type].Ext}";
                if (!addFiles.TryGetValue(path, out var add))
                {
                    var known = storedFiles.TryGetValue(path, out var stored) ? stored.Groups ?? ["*"] : [];
                    add = (f.Bytes, f.Type, new HashSet<string>(known, StringComparer.Ordinal));
                    addFiles[path] = add;
                }
                add.Groups.Add(group);
                entries[path] = new JsonObject { ["path"] = path, ["name"] = batchPath.Split('/')[^1], ["type"] = f.Type, ["size"] = f.Bytes.Length };
            }
            row[filesColumn] = new JsonArray(entries.Values.ToArray());
        }

        // Rows by record, in batch order; rows without an id are always new records.
        var byId = new Dictionary<string, List<Dictionary<string, object?>>>(StringComparer.Ordinal);
        var order = new List<object>(); // a row (no id) or an id
        foreach (var row in rows)
        {
            var id = IdOf(row);
            if (id is null) order.Add(row);
            else if (byId.TryGetValue(id, out var same)) same.Add(row);
            else
            {
                byId[id] = [row];
                order.Add(id);
            }
        }
        // Applies a row's values that aren't empty.
        Dictionary<string, object?> Merge(Dictionary<string, object?> target, Dictionary<string, object?> row)
        {
            foreach (var name in writable) if (!IsEmpty(row[name])) target[name] = row[name];
            return target;
        }
        var inserts = new List<Dictionary<string, object?>>();
        var updates = new List<(Dictionary<string, object?> Before, Dictionary<string, object?> After)>();
        foreach (var entry in order)
        {
            if (entry is Dictionary<string, object?> loose)
            {
                inserts.Add(loose);
                continue;
            }
            var id = (string)entry;
            var list = byId[id];
            if (!filed.TryGetValue(id, out var before))
            {
                inserts.Add(replace ? list.Skip(1).Aggregate(list[0], Merge) : list[0]); // a new record: later rows fill it in
                continue;
            }
            if (!replace) continue;
            if (partitionBy is not null)
            {
                var was = Text(before[partitionBy]);
                if (own is not null && !own.Contains(was)) throw Rejected($"Record '{id}' is in partition '{was}', which key {keyId} isn't granted");
                var moved = list.FirstOrDefault(r => Text(r[partitionBy]) != was);
                if (moved is not null) throw Rejected($"Record '{id}' is in partition '{was}': a change can't move it to '{Text(moved[partitionBy])}'");
            }
            var after = list.Aggregate(new Dictionary<string, object?>(before, StringComparer.Ordinal), Merge);
            if (withFiles && !ReferenceEquals(after[filesColumn], before[filesColumn])) Attach(after, before[filesColumn]);
            if (!Changes.Same(after, before)) updates.Add((before, after));
        }
        if (withFiles) foreach (var row in inserts) Attach(row, null);

        // Files a changed record no longer lists are removed, unless another record still lists them.
        // (A shared file with no files column has none to drop.)
        var dropped = updates.SelectMany(u => ListOf(u.Before.GetValueOrDefault(filesColumn)).Select(PathOf)).OfType<string>().ToHashSet(StringComparer.Ordinal);
        foreach (var r in inserts.Concat(updates.Select(u => u.After)))
            foreach (var e in ListOf(r.GetValueOrDefault(filesColumn))) if (PathOf(e) is { } p) dropped.Remove(p);
        if (dropped.Count > 0)
        {
            var changed = updates.Select(u => Text(u.After[idColumn])).ToHashSet(StringComparer.Ordinal);
            foreach (var r in shared.Rows(new JazminQueryOptions { Select = [idColumn, filesColumn] }))
                if (!changed.Contains(Text(r[idColumn])))
                    foreach (var e in ListOf(r[filesColumn])) if (PathOf(e) is { } p) dropped.Remove(p);
        }

        bool Unchanged(string path, HashSet<string> groups) =>
            storedFiles.TryGetValue(path, out var stored) && (stored.Groups ?? ["*"]) is var known && known.Count == groups.Count && known.All(groups.Contains);
        return new Plan(
            inserts,
            updates.Select(u => u.After).ToList(),
            addFiles.Where(p => !Unchanged(p.Key, p.Value.Groups))
                .Select(p => new JazminFileInput(p.Key, p.Value.Content) { Type = p.Value.Type, Groups = p.Value.Groups.Contains("*") ? null : p.Value.Groups.ToList() }).ToList(),
            dropped.Where(storedFiles.ContainsKey).ToList(),
            rows.Count,
            ignoredColumns);
    }

    private static IEnumerable<JsonNode?> ListOf(object? list) => list is JsonArray a ? a : [];

    private static string? PathOf(JsonNode? entry) =>
        entry is JsonObject o && o["path"] is JsonValue v && v.TryGetValue<string>(out var path) ? path : null;

    private static string Iso(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static string TypeName(JazminType type) => type.ToString().ToLowerInvariant();

    /// <summary>
    /// The files of a batch, checked: <paramref name="lists"/> holds each row's list (paths in the batch, and entries
    /// kept). Returns path -> the bytes, the kind their first bytes show, and their SHA-256.
    /// </summary>
    private static Dictionary<string, BatchFile> BatchFiles(JazminReader reader, IEnumerable<object?> lists, string filesColumn, IReadOnlyList<string> fileTypes, JazminFileSubmissionOptions options)
    {
        var listed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var list in lists)
        {
            if (list is null) continue;
            if (list is not JsonArray items || items.Any(p => !(p is JsonValue v && v.TryGetValue<string>(out _)) && PathOf(p) is null))
                throw Rejected($"Column '{filesColumn}' must list the paths of the row's files");
            foreach (var p in items) if (p is JsonValue v && v.TryGetValue<string>(out var s)) listed.Add(s); // entries kept from the filed record are checked later
        }
        var held = reader.Files.ToDictionary(f => f.Path, StringComparer.Ordinal);
        foreach (var p in listed) if (!held.ContainsKey(p)) throw Rejected($"A row lists the file '{p}', which the batch doesn't hold");
        var sizes = new Dictionary<string, long>(StringComparer.Ordinal); // sha256 -> size: identical files count once
        foreach (var f in held.Values)
        {
            if (!listed.Contains(f.Path)) throw Rejected($"The batch holds the file '{f.Path}', which no row lists");
            if (f.Size > options.MaxFileBytes) throw Rejected($"The file '{f.Path}' has {f.Size} bytes; the limit is {options.MaxFileBytes}");
            sizes[f.Sha256] = f.Size;
        }
        var total = sizes.Values.Sum();
        if (total > options.MaxBatchFileBytes) throw Rejected($"The batch's files have {total} bytes; the limit is {options.MaxBatchFileBytes}");
        var files = new Dictionary<string, BatchFile>(StringComparer.Ordinal);
        foreach (var f in held.Values)
        {
            var bytes = reader.ReadFile(f.Path); // checked against its SHA-256
            var type = fileTypes.FirstOrDefault(t => Kinds[t].Test(bytes));
            if (type is null)
            {
                var names = fileTypes.Select(t => Kinds[t].Name).ToList();
                var kinds = names.Count > 1 ? $"{string.Join(", ", names.Take(names.Count - 1))} or {names[^1]}" : names.FirstOrDefault() ?? "";
                throw Rejected($"The file '{f.Path}' is not a {kinds} file");
            }
            files[f.Path] = new BatchFile(bytes, type, f.Sha256);
        }
        return files;
    }
}
