using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Jazmin.Format;
using Jazmin.Query;

namespace Jazmin;

/// <summary>Changes to apply with <see cref="JazminFile.Update"/>.</summary>
public sealed class JazminUpdate
{
    /// <summary>Required for encrypted files; for access-controlled files this must be the OWNER key.</summary>
    public JazminKey? Key { get; set; }

    public string? Password { get; set; }

    /// <summary>New rows.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Insert { get; set; } = Array.Empty<IReadOnlyDictionary<string, object?>>();

    /// <summary>Rows that replace existing rows with the same <see cref="KeyColumns"/>; unmatched rows are inserted.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Upsert { get; set; } = Array.Empty<IReadOnlyDictionary<string, object?>>();

    public IReadOnlyList<string>? KeyColumns { get; set; }

    /// <summary>Removes matching rows.</summary>
    public JazminFilter? Delete { get; set; }

    /// <summary>Merged into the existing metadata.</summary>
    public JsonObject? Metadata { get; set; }

    /// <summary>Access-controlled files: grants to add (replacing any existing grant for the same key).</summary>
    public List<JazminGrant> Grant { get; set; } = new();

    /// <summary>Access-controlled files: keys whose access is removed.</summary>
    public List<JazminAccessKey> Revoke { get; set; } = new();

    public JazminCodec Codec { get; set; } = JazminCodec.Deflate;

    public int? CompressionLevel { get; set; }

    /// <summary>Embedded files to add (a path that exists is replaced).</summary>
    public IReadOnlyList<JazminFileInput> AddFiles { get; set; } = Array.Empty<JazminFileInput>();

    /// <summary>Paths of embedded files to remove.</summary>
    public IReadOnlyList<string> RemoveFiles { get; set; } = Array.Empty<string>();

    /// <summary>New package settings (default: keep the current ones).</summary>
    public JazminPackage? Package { get; set; }

    public int ChunkRows { get; set; } = FormatConstants.DefaultChunkRows;

    /// <summary>Clock used to drop expired grants (default: the system clock).</summary>
    public DateTimeOffset? Now { get; set; }

    /// <summary>The table the rows change in, by name (default: the first). The file's other tables are kept.</summary>
    public string? Table { get; set; }
}

public sealed record JazminUpdateResult(long RowCount, long Inserted, long Updated, long Deleted)
{
    /// <summary>Grants dropped because they had expired.</summary>
    public int ExpiredGrantsRemoved { get; init; }
}

/// <summary>Changes to apply with <see cref="JazminFile.Append"/> (written at the end of the file).</summary>
public sealed class JazminAppend
{
    /// <summary>Required for encrypted files; for access-controlled files this must be the OWNER key.</summary>
    public JazminKey? Key { get; set; }

    public string? Password { get; set; }

    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Insert { get; set; } = Array.Empty<IReadOnlyDictionary<string, object?>>();

    /// <summary>Rows that replace existing rows with the same <see cref="KeyColumns"/> (the old rows are marked deleted).</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Upsert { get; set; } = Array.Empty<IReadOnlyDictionary<string, object?>>();

    public IReadOnlyList<string>? KeyColumns { get; set; }

    public JazminFilter? Delete { get; set; }

    public JsonObject? Metadata { get; set; }

    /// <summary>Access-controlled files: grants to add. Revoking needs <see cref="JazminFile.Compact(string, JazminKey, string, DateTimeOffset?)"/> or Update.</summary>
    public List<JazminGrant> Grant { get; set; } = new();

    public JazminCodec Codec { get; set; } = JazminCodec.Deflate;

    public int? CompressionLevel { get; set; }

    /// <summary>Embedded files to add (a path that exists is replaced; identical content is referenced, not stored again).</summary>
    public IReadOnlyList<JazminFileInput> AddFiles { get; set; } = Array.Empty<JazminFileInput>();

    /// <summary>Paths of embedded files to remove (their blocks are dropped by the next Compact).</summary>
    public IReadOnlyList<string> RemoveFiles { get; set; } = Array.Empty<string>();

    /// <summary>New package settings (default: keep the current ones).</summary>
    public JazminPackage? Package { get; set; }

    public int ChunkRows { get; set; } = FormatConstants.DefaultChunkRows;

    /// <summary>Compact automatically afterwards when a threshold is reached (null: never).</summary>
    public JazminAutoCompact? AutoCompact { get; set; }

    /// <summary>Clock used to drop expired grants (default: the system clock).</summary>
    public DateTimeOffset? Now { get; set; }

    /// <summary>The table the rows change in, by name (default: the first). The file's other tables are kept.</summary>
    public string? Table { get; set; }
}

/// <summary>Compact when deleted rows reach this share of all rows, or after this many appends.</summary>
public sealed record JazminAutoCompact(double? DeletedRatio = null, int? Appends = null);

public sealed record JazminAppendResult(long RowCount, long Inserted, long Updated, long Deleted, int AppendCount, long DeletedRowCount, bool Compacted)
{
    /// <summary>Grants that lost their key slots because they had expired.</summary>
    public int ExpiredGrantsRemoved { get; init; }
}

public sealed record JazminCompactResult(long RowCount, long BytesBefore, long BytesAfter)
{
    public int ExpiredGrantsRemoved { get; init; }
}

/// <summary>Operations that modify existing files (spec section 11.1).</summary>
public static class JazminFile
{
    /// <summary>
    /// Applies changes by streaming the file into a new version and atomically replacing it.
    /// Memory is bounded by the change set, not the file. Indexes, sort order, metadata and
    /// access grants carry over; every new version gets fresh secrets, so revoked keys cannot read it.
    /// </summary>
    public static JazminUpdateResult Update(string path, JazminUpdate update) => WithLock(path, () => UpdateUnlocked(path, update));

    private static JazminUpdateResult UpdateUnlocked(string path, JazminUpdate update, bool regroup = false)
    {
        ArgumentNullException.ThrowIfNull(update);
        if (update.Upsert.Count > 0 && (update.KeyColumns is null || update.KeyColumns.Count == 0))
            throw new JazminValidationException("Upsert needs KeyColumns, e.g. KeyColumns = [\"id\"]");

        var temp = $"{path}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant()}.tmp";
        var reader = JazminReader.Open(path, new JazminReadOptions { Key = update.Key, Password = update.Password, Table = update.Table });
        var readers = new List<JazminReader> { reader }; // in a file with several tables, one per table, in file order
        JazminWriter? writer = null;
        try
        {
            var ownerGrants = reader.OwnerGrants;
            if (ownerGrants is null && reader.Access is not null) throw new JazminKeyException("Only the file owner's master key can modify this file");
            if (ownerGrants is null && (update.Grant.Count > 0 || update.Revoke.Count > 0))
                throw new JazminValidationException("Grant/Revoke apply only to access-controlled files");
            if (reader.Tables.Count > 1)
            {
                readers.Clear();
                foreach (var name in reader.Tables)
                    readers.Add(name == reader.TableName ? reader : reader.OpenTable(name));
            }

            var partitionBy = ownerGrants is null ? null : reader.AccessLayout.PartitionBy;
            if (regroup && partitionBy is null) throw new JazminValidationException("Regroup applies to access-controlled files with PartitionBy");
            if (regroup && reader.SortedBy is { } order && order[0] != partitionBy)
                throw new JazminValidationException($"Regroup would break the file's SortedBy order [{string.Join(", ", order)}]: it needs no SortedBy, " +
                    $"or one that starts with the partition column '{partitionBy}' (then rows are already grouped)");

            var shape = new RowShape(ColumnsWithIndexes(reader));
            var columns = shape.Columns;
            var keyCols = update.KeyColumns?.Select(shape.Ordinal).ToArray() ?? Array.Empty<int>();
            var sortedBy = reader.SortedBy;
            var sortCols = sortedBy?.Select(shape.Ordinal).ToArray();
            object?[] ValuesOf(IReadOnlyDictionary<string, object?> row) => shape.ValuesOf(row);
            object?[] KeyTuple(object?[] values, int[] cols) => shape.KeyTuple(values, cols);
            string KeyText(object?[] values) => shape.KeyText(values, keyCols);

            var pending = new Dictionary<string, (object?[] Values, bool Matched)>(StringComparer.Ordinal);
            foreach (var row in update.Upsert)
            {
                var values = ValuesOf(row);
                pending[KeyText(values)] = (values, false);
            }
            var deletePlan = BoundFilter.Bind(update.Delete, reader.Columns);

            // The other tables of the file are copied as they are: a new version has fresh secrets throughout (spec 7.6.7).
            var access = ownerGrants is null ? null : AccessFor(reader, ownerGrants, update);
            var several = readers.Count > 1;
            var options = new JazminWriteOptions
            {
                Key = update.Key,
                Password = update.Password,
                KdfIterations = reader.KdfIterations ?? FormatConstants.DefaultKdfIterations,
                Metadata = MergeMetadata(reader.Metadata, update.Metadata),
                SortedBy = several ? null : sortedBy,
                Codec = update.Codec,
                CompressionLevel = update.CompressionLevel,
                ChunkRows = update.ChunkRows,
                Package = update.Package ?? reader.Package,
                Access = access is null ? null : several ? new JazminAccessOptions { Grants = access.Grants } : access,
                Now = update.Now, // expired grants are dropped; the new version's fresh secrets lock them out
                Tables = several ? readers.Select(TableFor).ToList() : null,
            };
            writer = several ? JazminWriter.Create(temp, options) : JazminWriter.Create(temp, columns, options);
            foreach (var source in CarriedFiles(reader, update)) writer.AddSource(source);
            foreach (var file in update.AddFiles) writer.AddFile(file);

            long inserted = 0, updated = 0, deleted = 0, rowCount = 0;
            foreach (var r in readers)
            {
                if (r != readers[0]) writer.StartTable(r.TableName);
                if (r == reader)
                {
                    WriteChanged();
                    rowCount = writer.RowCount;
                }
                else
                {
                    foreach (var row in r.Rows()) writer.WriteValues(row.RawValues);
                }
            }

            foreach (var r in readers) r.Dispose();
            writer.Finish();
            ReplaceFile(temp, path);
            return new JazminUpdateResult(rowCount, inserted, updated, deleted) { ExpiredGrantsRemoved = writer.ExpiredGrants };

            void WriteChanged()
            {
                if (sortCols is not null)
                {
                    // Upserted rows are re-inserted at their sorted position (their sort key may change),
                    // so the whole change set merges into the stream in one pass.
                    var incoming = update.Insert.Select(ValuesOf).Concat(pending.Values.Select(p => p.Values))
                        .Select(v => (Values: v, Key: KeyTuple(v, sortCols)))
                        .OrderBy(x => x.Key, Comparer<object?[]>.Create(SortKeys.Compare))
                        .ToList();
                    var next = 0;
                    foreach (var row in reader.Rows())
                    {
                        var values = row.RawValues;
                        var rowKey = KeyTuple(values, sortCols);
                        while (next < incoming.Count && SortKeys.Compare(incoming[next].Key, rowKey) < 0) writer.WriteValues(incoming[next++].Values);
                        var key = pending.Count > 0 ? KeyText(values) : null;
                        if (key is not null && pending.TryGetValue(key, out var hit))
                        {
                            if (hit.Matched) deleted++; // duplicate key rows collapse into the single upserted row
                            else updated++;
                            pending[key] = (hit.Values, true);
                        }
                        else if (deletePlan is not null && FilterEngine.Evaluate(deletePlan, values)) deleted++;
                        else writer.WriteValues(values); // the writer copies into its own buffer
                    }
                    while (next < incoming.Count) writer.WriteValues(incoming[next++].Values);
                }
                else
                {
                    foreach (var row in regroup ? reader.RowsByPartition() : reader.Rows())
                    {
                        var values = row.RawValues;
                        var key = pending.Count > 0 ? KeyText(values) : null;
                        if (key is not null && pending.TryGetValue(key, out var hit))
                        {
                            if (hit.Matched)
                            {
                                deleted++;
                                continue;
                            }
                            pending[key] = (hit.Values, true);
                            updated++;
                            writer.WriteValues(hit.Values);
                        }
                        else if (deletePlan is not null && FilterEngine.Evaluate(deletePlan, values)) deleted++;
                        else writer.WriteValues(values); // the writer copies into its own buffer
                    }
                    foreach (var row in update.Insert) writer.WriteValues(ValuesOf(row));
                    foreach (var (values, matched) in pending.Values)
                        if (!matched) writer.WriteValues(values);
                }
                inserted = update.Insert.Count + pending.Values.Count(p => !p.Matched);
            }
        }
        catch
        {
            writer?.Abort();
            foreach (var r in readers) r.Dispose();
            File.Delete(temp);
            throw;
        }
    }

    /// <summary>A table of the file as writer options for a rewrite: its columns with their indexes, sort order and layout.</summary>
    private static JazminTable TableFor(JazminReader reader)
    {
        var (partitionBy, groups) = reader.AccessLayout;
        return new JazminTable(reader.TableName, ColumnsWithIndexes(reader))
        {
            SortedBy = reader.SortedBy,
            PartitionBy = partitionBy,
            ColumnGroups = groups.Where(g => g.Name != FormatConstants.DefaultColumnGroup).ToDictionary(g => g.Name, g => g.Columns.ToArray()),
        };
    }

    /// <summary>
    /// Applies changes by appending them to the end of the file instead of rewriting it (spec 11.2).
    /// Existing bytes are never modified, so open readers keep working, and the cost is proportional
    /// to the change, not the file. Deleted and replaced rows are recorded as deletions;
    /// <see cref="Compact(string, JazminKey, string, DateTimeOffset?)"/> removes them and the superseded headers. In a file with SortedBy, appended
    /// rows must sort after the existing rows (use <see cref="Update"/> to insert in the middle).
    /// </summary>
    public static JazminAppendResult Append(string path, JazminAppend append) => WithLock(path, () => AppendUnlocked(path, append));

    private static JazminAppendResult AppendUnlocked(string path, JazminAppend append)
    {
        ArgumentNullException.ThrowIfNull(append);
        if (append.Upsert.Count > 0 && (append.KeyColumns is null || append.KeyColumns.Count == 0))
            throw new JazminValidationException("Upsert needs KeyColumns, e.g. KeyColumns = [\"id\"]");

        var reader = JazminReader.Open(path, new JazminReadOptions { Key = append.Key, Password = append.Password, Table = append.Table });
        JazminWriter? writer = null;
        JazminAppendResult result;
        try
        {
            var ownerGrants = reader.OwnerGrants;
            if (ownerGrants is null && reader.Access is not null) throw new JazminKeyException("Only the file owner's master key can modify this file");
            if (ownerGrants is null && append.Grant.Count > 0) throw new JazminValidationException("Grant applies only to access-controlled files");
            if (ownerGrants is not null) CheckAppendGrants(ownerGrants, append.Grant, append.Now ?? DateTimeOffset.UtcNow);

            var shape = new RowShape(ColumnsWithIndexes(reader));
            var keyCols = append.KeyColumns?.Select(shape.Ordinal).ToArray() ?? Array.Empty<int>();

            // Rows to remove: matches of the delete filter, and existing rows replaced by an upsert.
            var removed = new HashSet<long>();
            if (append.Delete is not null)
                foreach (var row in reader.RowsWithIds(append.Delete)) removed.Add(row.RowId);
            long updated = 0;
            if (append.Upsert.Count > 0)
            {
                var pending = append.Upsert.Select(r => shape.KeyText(shape.ValuesOf(r), keyCols)).ToHashSet(StringComparer.Ordinal);
                // A single key column can use its index (or chunk statistics) instead of a full scan.
                var filter = keyCols.Length == 1
                    ? JazminFilter.In(shape.Columns[keyCols[0]].Name, append.Upsert.Select(r => r.GetValueOrDefault(shape.Columns[keyCols[0]].Name)).Where(v => v is not null).ToArray())
                    : null;
                var matched = new HashSet<string>(StringComparer.Ordinal);
                foreach (var row in reader.RowsWithIds(filter))
                {
                    var key = shape.KeyText(row.RawValues, keyCols);
                    if (!pending.Contains(key)) continue;
                    removed.Add(row.RowId);
                    matched.Add(key);
                }
                updated = matched.Count;
            }
            var deletedNow = removed.Count - updated;

            var state = reader.AppendState();
            var allDeleted = state.Deleted.Concat(removed).Distinct().Order().ToArray();
            var incoming = append.Insert.Concat(append.Upsert).Select(shape.ValuesOf).ToList();
            var sortedBy = reader.SortedBy;
            if (sortedBy is not null)
            {
                var sortCols = sortedBy.Select(shape.Ordinal).ToArray();
                incoming = incoming.Select(v => (Values: v, Key: shape.KeyTuple(v, sortCols)))
                    .OrderBy(x => x.Key, Comparer<object?[]>.Create(SortKeys.Compare)).Select(x => x.Values).ToList();
            }
            var accessOptions = ownerGrants is null ? null : AccessFor(reader, ownerGrants, new JazminUpdate { Grant = append.Grant });
            var metadata = reader.Metadata;
            var (rowCountBefore, appendCountBefore) = (reader.RowCount, reader.AppendCount);
            reader.Dispose();

            writer = JazminWriter.Continue(path, shape.Columns, new JazminWriteOptions
            {
                Key = append.Key,
                Metadata = MergeMetadata(metadata, append.Metadata),
                SortedBy = sortedBy,
                Codec = append.Codec,
                CompressionLevel = append.CompressionLevel,
                ChunkRows = append.ChunkRows,
                Access = accessOptions,
                Now = append.Now, // expired grants lose their key slots (full lock-out needs Compact/Update)
                Files = append.AddFiles,
                Package = append.Package,
            }, state with { Deleted = allDeleted, Files = AppendFiles(state.Files, append) });
            try
            {
                foreach (var values in incoming) writer.WriteValues(values);
            }
            catch (JazminValidationException e) when (sortedBy is not null && e.Message.Contains("out of order"))
            {
                throw new JazminValidationException($"{e.Message}. Appended rows must sort after the existing rows; use JazminFile.Update to insert them in the middle");
            }
            writer.Finish();

            // The new version's counts follow from the change: no need to open the file again.
            result = new JazminAppendResult(rowCountBefore - removed.Count + incoming.Count, append.Insert.Count + append.Upsert.Count - updated, updated, deletedNow,
                appendCountBefore + 1, allDeleted.Length, false) { ExpiredGrantsRemoved = writer.ExpiredGrants };
        }
        catch
        {
            writer?.Abort();
            reader.Dispose();
            throw;
        }

        if (append.AutoCompact is { } auto && ShouldCompact(result, auto))
        {
            var compacted = UpdateUnlocked(path, new JazminUpdate
            {
                Key = append.Key, Password = append.Password, Codec = append.Codec, CompressionLevel = append.CompressionLevel, ChunkRows = append.ChunkRows,
                Now = append.Now, Table = append.Table,
            });
            return result with { RowCount = compacted.RowCount, AppendCount = 0, DeletedRowCount = 0, Compacted = true };
        }
        return result;
    }

    /// <summary>Files an append keeps (referenced, not rewritten): every file except removed or replaced ones.</summary>
    private static FileState? AppendFiles(FileState? state, JazminAppend append)
    {
        if (state is null && append.AddFiles.Count == 0)
        {
            if (append.RemoveFiles.Count > 0) throw new JazminValidationException($"RemoveFiles: no file '{append.RemoveFiles[0]}'");
            return null;
        }
        var entries = (state?.Entries ?? []).ToDictionary(e => e.Path, StringComparer.Ordinal);
        foreach (var p in append.RemoveFiles)
            if (!entries.Remove(p)) throw new JazminValidationException($"RemoveFiles: no file '{p}'");
        foreach (var f in append.AddFiles) entries.Remove(f.Path);
        return new FileState(entries.Values.ToList(), state?.Contents ?? [], state?.NextId ?? 0, state?.Package);
    }

    /// <summary>The files a rewrite keeps, read block by block from the old version while the new one is written.</summary>
    private static IEnumerable<FileSource> CarriedFiles(JazminReader reader, JazminUpdate update)
    {
        var state = reader.FileState();
        var existing = (state?.Entries ?? []).ToDictionary(e => e.Path, StringComparer.Ordinal);
        foreach (var p in update.RemoveFiles)
            if (!existing.ContainsKey(p)) throw new JazminValidationException($"RemoveFiles: no file '{p}'");
        var dropped = update.RemoveFiles.Concat(update.AddFiles.Select(f => f.Path)).ToHashSet(StringComparer.Ordinal);
        var contents = (state?.Contents ?? []).ToDictionary(c => c.Id);
        return existing.Values.Where(e => !dropped.Contains(e.Path)).Select(e => new FileSource
        {
            Path = e.Path, Type = e.Type, Groups = e.Groups ?? [EmbeddedFiles.Everyone], Size = contents[e.Content].Size, Sha256 = contents[e.Content].Sha256,
            Read = (offset, length) => reader.ReadFileRange(e.Path, offset, offset + length),
        }).ToList();
    }

    /// <summary>
    /// Atomically replaces <paramref name="path"/> with <paramref name="temp"/>: readers never see a half-written
    /// file. Windows does not allow replacing a file that another process has open; that case gets a clear error.
    /// </summary>
    private static void ReplaceFile(string temp, string path)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temp, File.GetUnixFileMode(path)); // the new version keeps the file's permissions
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception e) when (OperatingSystem.IsWindows() && e is UnauthorizedAccessException or IOException)
        {
            throw new JazminException($"Cannot replace {path}: another process has it open, and Windows does not allow replacing an open file. "
                + "Close its readers and retry, or use JazminFile.Append, which works while the file is open.", e);
        }
    }

    private static bool ShouldCompact(JazminAppendResult result, JazminAutoCompact auto)
    {
        if (auto.Appends is { } appends && result.AppendCount >= appends) return true;
        var physical = result.RowCount + result.DeletedRowCount;
        return auto.DeletedRatio is { } ratio && physical > 0 && (double)result.DeletedRowCount / physical >= ratio;
    }

    /// <summary>
    /// Rewrites the file in full: removes deleted rows and superseded data, merges index segments and
    /// (for access-controlled files) re-locks it with fresh secrets. Same as an update with no changes.
    /// </summary>
    public static JazminCompactResult Compact(string path, JazminKey? key = null, string? password = null, DateTimeOffset? now = null) =>
        Compact(path, key, password, now, regroup: false);

    /// <summary>
    /// Compacts an access-controlled file, and with <paramref name="regroup"/> writes each partition's rows together (in
    /// their file order): appends from many people leave one chunk per append, and after regrouping each partition spans
    /// as few chunks as its rows need. Regrouping needs a file without SortedBy, or one sorted by the partition column
    /// first. Owner key required.
    /// </summary>
    public static JazminCompactResult Compact(string path, JazminKey key, bool regroup, DateTimeOffset? now = null) =>
        Compact(path, key, null, now, regroup);

    private static JazminCompactResult Compact(string path, JazminKey? key, string? password, DateTimeOffset? now, bool regroup) => WithLock(path, () =>
    {
        var before = new FileInfo(path).Length;
        var result = UpdateUnlocked(path, new JazminUpdate { Key = key, Password = password, Now = now }, regroup);
        return new JazminCompactResult(result.RowCount, before, new FileInfo(path).Length) { ExpiredGrantsRemoved = result.ExpiredGrantsRemoved };
    });

    /// <summary>
    /// Key service: the unlock token for an online grant, if it exists and has not expired at <paramref name="now"/>.
    /// Owner key required. <paramref name="keyId"/> is the access key's <see cref="JazminAccessKey.Id"/>.
    /// </summary>
    public static string IssueUnlockToken(string path, JazminKey ownerKey, string keyId, DateTimeOffset? now = null)
    {
        var grant = OwnerGrantList(path, ownerKey).FirstOrDefault(g => JazminAccessKey.FromOwnerDirectory((string)g!["key"]!).Id == keyId)
            ?? throw new JazminValidationException($"Key {keyId} has no grant in this file");
        if ((string?)grant["mode"] != "online") throw new JazminValidationException($"Key {keyId} is an offline grant - it needs no unlock token");
        if (grant["expires"] is { } expires && (now ?? DateTimeOffset.UtcNow) > DateTimeOffset.Parse((string)expires!, CultureInfo.InvariantCulture))
            throw new JazminAccessExpiredException($"Access for key {keyId} expired at {(string)expires!}");
        return UnlockTokens.Encode(Convert.FromBase64String((string)grant["share"]!));
    }

    /// <summary>
    /// The access key a shared file grants, found in its grant list by <paramref name="keyId"/>
    /// (<see cref="JazminAccessKey.Id"/>): for example to check the grant of the person who sent a file back (spec 7.8).
    /// Owner key required.
    /// </summary>
    public static JazminAccessKey AccessKeyOf(string path, JazminKey ownerKey, string keyId)
    {
        var grant = OwnerGrantList(path, ownerKey, "Access keys are listed only in access-controlled files, and only for the owner key")
            .FirstOrDefault(g => JazminAccessKey.FromOwnerDirectory((string)g!["key"]!).Id == keyId)
            ?? throw new JazminValidationException($"Key {keyId} has no grant in this file");
        return JazminAccessKey.FromOwnerDirectory((string)grant["key"]!);
    }

    /// <summary>Key service: every online grant's unlock token, for services that store them.</summary>
    public static IReadOnlyList<JazminUnlockTokenInfo> ListUnlockTokens(string path, JazminKey ownerKey) =>
        OwnerGrantList(path, ownerKey)
            .Where(g => (string?)g!["mode"] == "online" && g["share"] is not null)
            .Select(g => new JazminUnlockTokenInfo(
                JazminAccessKey.FromOwnerDirectory((string)g!["key"]!).Id,
                (string?)g["label"],
                g["expires"] is { } e ? DateTimeOffset.Parse((string)e!, CultureInfo.InvariantCulture) : null,
                UnlockTokens.Encode(Convert.FromBase64String((string)g["share"]!))))
            .ToList();

    /// <summary>What can be read without a key: the file id (send it with a key id to your key service) and its features.</summary>
    public static JazminFileInfo Inspect(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var preamble = new byte[FormatConstants.PreambleSize];
        var complete = stream.Read(preamble) == preamble.Length;
        if (complete && preamble.AsSpan(0, 4).SequenceEqual(FormatConstants.DraftMagic))
            throw new JazminFormatException("This file uses a pre-release JAZMIN draft format. Write it again from its source data.");
        if (!complete || !preamble.AsSpan(0, 4).SequenceEqual(FormatConstants.Magic)) throw new JazminFormatException("Not a JAZMIN file (bad magic)");
        var flags = System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(preamble.AsSpan(FormatConstants.FlagsOffset));
        return new JazminFileInfo(
            Convert.ToHexString(preamble, 8, 16).ToLowerInvariant(),
            "1.0", // the magic names the major version; later additions are reader/writer features
            (flags & FormatConstants.FlagEncrypted) != 0,
            (flags & FormatConstants.FlagPassword) != 0,
            (flags & FormatConstants.FlagAccess) != 0,
            (flags & FormatConstants.FlagAppended) != 0);
    }

    private static JsonArray OwnerGrantList(string path, JazminKey ownerKey, string need = "Unlock tokens exist only for access-controlled files, and need the owner key")
    {
        using var reader = JazminReader.Open(path, new JazminReadOptions { Key = ownerKey });
        return reader.OwnerGrants ?? throw new JazminValidationException(need);
    }

    /// <summary>
    /// Runs <paramref name="action"/> while holding "&lt;path&gt;.lock", so only one writer (append,
    /// update or compact) works on a file at a time. Readers are never blocked.
    /// </summary>
    private static T WithLock<T>(string path, Func<T> action)
    {
        var lockPath = path + ".lock";
        FileStream lockFile;
        try
        {
            lockFile = new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
        }
        catch (IOException) when (File.Exists(lockPath))
        {
            throw new JazminException($"Another writer is changing {path} (lock file {lockPath} exists; delete it if no writer is running)");
        }
        using (lockFile) return action();
    }

    private static List<JazminColumn> ColumnsWithIndexes(JazminReader reader) => reader.Columns.Select(c => new JazminColumn(c.Name, c.Type)
    {
        Nullable = c.Nullable,
        Description = c.Description,
        Attributes = c.Attributes,
        Indexes = reader.Indexes.Where(i => i.Column == c.Name).Select(i => i.Kind).ToArray(),
    }).ToList();

    /// <summary>Column positions, value arrays and comparable keys for rows of one file.</summary>
    private sealed class RowShape(List<JazminColumn> columns)
    {
        private readonly Dictionary<string, int> _ordinals =
            columns.Select((c, i) => (c.Name, i)).ToDictionary(x => x.Name, x => x.i, StringComparer.Ordinal);

        public List<JazminColumn> Columns { get; } = columns;

        public int Ordinal(string name) => _ordinals.TryGetValue(name, out var i) ? i : throw new JazminValidationException($"Unknown column '{name}'");

        public object?[] ValuesOf(IReadOnlyDictionary<string, object?> row)
        {
            var values = new object?[Columns.Count];
            foreach (var (name, value) in row) values[Ordinal(name)] = value;
            return values;
        }

        public object?[] KeyTuple(object?[] values, int[] cols) => cols.Select(i =>
        {
            var v = Values.Normalize(Columns[i].Type, values[i], Columns[i].Name);
            return v is null ? null : Values.ToKey(Columns[i].Type, v);
        }).ToArray();

        public string KeyText(object?[] values, int[] cols) => string.Join('\u001f', KeyTuple(values, cols).Select(k => k switch
        {
            null => "\u0000",
            string s => "s" + s,
            double d => "d" + d.ToString("R", CultureInfo.InvariantCulture),
            IFormattable f => "n" + f.ToString(null, CultureInfo.InvariantCulture),
            _ => "o" + k,
        }));
    }

    /// <summary>Owner only: lets the grant's key see its partitions / column groups (rewrites the file).</summary>
    public static JazminUpdateResult GrantAccess(string path, JazminKey ownerKey, JazminGrant grant) =>
        Update(path, new JazminUpdate { Key = ownerKey, Grant = [grant] });

    /// <summary>Owner only: removes a key's access. The new file version uses fresh secrets throughout.</summary>
    public static JazminUpdateResult RevokeAccess(string path, JazminKey ownerKey, JazminAccessKey accessKey) =>
        Update(path, new JazminUpdate { Key = ownerKey, Revoke = [accessKey] });

    private static JsonObject MergeMetadata(JsonObject existing, JsonObject? changes)
    {
        if (changes is null) return existing;
        foreach (var (name, value) in changes) existing[name] = value?.DeepClone();
        return existing;
    }

    /// <summary>
    /// Grants an append may make. An append keeps the file's secrets, so a key keeps whatever it could already open:
    /// new grants and wider ones are fine, but narrowing an existing grant (fewer rows, columns or files, a new or
    /// earlier expiry, offline to online) needs Update or Compact, which re-lock the file with fresh secrets.
    /// </summary>
    internal static void CheckAppendGrants(JsonArray ownerGrants, IReadOnlyList<JazminGrant> grants, DateTimeOffset now)
    {
        // Rows and columns: null means all. Files: null means none, "*" all.
        static bool Covers(IReadOnlyList<string>? wider, IReadOnlyList<string>? narrower) =>
            wider is null || (narrower is not null && narrower.All(wider.Contains));
        static bool FilesCover(IReadOnlyList<string>? wider, IReadOnlyList<string>? narrower) =>
            narrower is null || narrower.Count == 0 || (wider is not null && (wider.Contains("*") || (!narrower.Contains("*") && narrower.All(wider.Contains))));
        if (grants.Count == 0) return;
        var before = ownerGrants.ToDictionary(n => JazminAccessKey.FromOwnerDirectory((string)n!["key"]!).Id, n => n!);
        foreach (var grant in grants)
        {
            if (!before.TryGetValue(grant.Key.Id, out var old)) continue;
            var expires = grant.Expires ?? (grant.ExpiresIn is { } span ? now + span : null);
            DateTimeOffset? oldExpires = old["expires"] is { } e ? DateTimeOffset.Parse((string)e!, CultureInfo.InvariantCulture) : null;
            var oldFiles = old["files"] switch
            {
                JsonArray list => list.Select(f => (string)f!).ToList(),
                JsonValue all => [(string)all!],
                _ => null,
            };
            var narrower = !Covers(grant.Rows, JazminReader.ListOrAll(old["rows"])) || !Covers(grant.Columns, JazminReader.ListOrAll(old["columns"]))
                || !FilesCover(grant.Files, oldFiles)
                || (expires is { } end && (oldExpires is null || end < oldExpires))
                || (grant.Mode == JazminGrantMode.Online && (string?)old["mode"] != "online");
            if (narrower)
                throw new JazminValidationException($"The grant for {grant.Key.Id} is narrower than before. An append keeps the file's secrets, so that key could still read new data: use Update or Compact, which re-lock the file");
        }
    }

    internal static JazminAccessOptions AccessFor(JazminReader reader, JsonArray ownerGrants, JazminUpdate update)
    {
        var (partitionBy, columnGroups) = reader.AccessLayout;
        // With no grants or revokes, the file's grants are kept as they are: no key ids needed (each is a hash, and a file
        // can grant thousands of keys). Otherwise grants are matched by id.
        var byId = update.Revoke.Count > 0 || update.Grant.Count > 0;
        var revoked = update.Revoke.Select(k => k.Id).ToHashSet();
        var grants = new Dictionary<string, JazminGrant>();
        var n = 0;
        foreach (var node in ownerGrants)
        {
            var key = JazminAccessKey.FromOwnerDirectory((string)node!["key"]!);
            if (byId && revoked.Contains(key.Id)) continue;
            grants[byId ? key.Id : (n++).ToString(CultureInfo.InvariantCulture)] = new JazminGrant(key)
            {
                Rows = JazminReader.ListOrAll(node["rows"]),
                Columns = JazminReader.ListOrAll(node["columns"]),
                Label = (string?)node["label"],
                Expires = node["expires"] is { } expires ? DateTimeOffset.Parse((string)expires!, CultureInfo.InvariantCulture) : null,
                Mode = (string?)node["mode"] == "online" ? JazminGrantMode.Online : JazminGrantMode.Offline,
                Share = node["share"] is { } share ? Convert.FromBase64String((string)share!) : null,
                Files = node["files"] switch
                {
                    JsonArray list => list.Select(f => (string)f!).ToList(),
                    JsonValue all => [(string)all!],
                    _ => null,
                },
            };
        }
        foreach (var grant in update.Grant) grants[grant.Key.Id] = grant; // re-granting replaces the previous grant
        return new JazminAccessOptions
        {
            PartitionBy = partitionBy,
            ColumnGroups = columnGroups.Where(g => g.Name != FormatConstants.DefaultColumnGroup)
                .ToDictionary(g => g.Name, g => g.Columns.ToArray()),
            Grants = grants.Values.ToList(),
        };
    }
}
