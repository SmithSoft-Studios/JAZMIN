using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
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

    /// <summary>
    /// Nested columns given fields at the end of their objects (nullable ones, spec 5.4): their new definitions. Fields of
    /// .NET objects are added without it; it is for rows given as JSON or dictionaries.
    /// </summary>
    public IReadOnlyList<JazminColumn>? Columns { get; set; }

    public JazminCodec Codec { get; set; } = JazminCodec.Deflate;

    public int? CompressionLevel { get; set; }

    /// <summary>Embedded files to add (a path that exists is replaced).</summary>
    public IReadOnlyList<JazminFileInput> AddFiles { get; set; } = Array.Empty<JazminFileInput>();

    /// <summary>Paths of embedded files to remove.</summary>
    public IReadOnlyList<string> RemoveFiles { get; set; } = Array.Empty<string>();

    /// <summary>New package settings (default: keep the current ones).</summary>
    public JazminPackage? Package { get; set; }

    /// <summary>Saved export shapes to add (a name that exists is replaced).</summary>
    public IReadOnlyList<JazminSavedShape> AddShapes { get; set; } = Array.Empty<JazminSavedShape>();

    /// <summary>Names of saved export shapes to remove.</summary>
    public IReadOnlyList<string> RemoveShapes { get; set; } = Array.Empty<string>();

    public int ChunkRows { get; set; } = FormatConstants.DefaultChunkRows;

    /// <summary>Memory or speed first while the file is read and rewritten (default <see cref="JazminPriority.Balanced"/>).</summary>
    public JazminPriority Priority { get; set; }

    /// <summary>
    /// Sorted indexes with keys as differences (see <see cref="JazminWriteOptions.CompactIndexes"/>); null (the default)
    /// keeps the file's choice.
    /// </summary>
    public bool? CompactIndexes { get; set; }

    /// <summary>Clock used to drop expired grants (default: the system clock).</summary>
    public DateTimeOffset? Now { get; set; }

    /// <summary>The table the rows change in, by name (default: the first). The file's other tables are kept.</summary>
    public string? Table { get; set; }

    /// <summary>
    /// The indexes a column has afterwards, by column name (an empty list for none); columns not named keep theirs. The
    /// first SortedBy column keeps no sorted index: the sort order already finds its values. Re-sorted away from it, the
    /// old first sort column gets a sorted index, unless named here.
    /// </summary>
    public IReadOnlyDictionary<string, IReadOnlyList<JazminIndexKind>>? Indexes { get; set; }

    /// <summary>
    /// A new sort order (an empty list for none; null keeps the table's). Every row is put in it within a memory budget:
    /// <see cref="SortRunRows"/> rows at a time, more through temporary files locked with a key of their own.
    /// </summary>
    public IReadOnlyList<string>? SortedBy { get; set; }

    /// <summary>Rows sorted in memory at a time when re-sorting (default by <see cref="Priority"/>: 10,000, 25,000 or 100,000).</summary>
    public int? SortRunRows { get; set; }

    /// <summary>New tables, written after the others; a table with SortedBy gets its rows in that order (within the budget).</summary>
    public IReadOnlyList<JazminAddedTable> AddTables { get; set; } = [];

    /// <summary>Tables to leave out. Saved shapes and the document's edits that read one are refused, unless removed too.</summary>
    public IReadOnlyList<string> RemoveTables { get; set; } = [];

    /// <summary>Tables to rename, old name to new; saved shapes, the document's edits and links follow.</summary>
    public IReadOnlyDictionary<string, string> RenameTables { get; set; } = new Dictionary<string, string>();

    /// <summary>The links between tables, replacing the file's (an empty list for none); null keeps them, following renames.</summary>
    public IReadOnlyList<JazminLink>? Links { get; set; }

    /// <summary>
    /// Columns set on the rows <see cref="Where"/> matches, by column name. Rows whose sort columns change move to their
    /// place; a shared file's partition column can't be set (its rows would leave the partitions keys are granted).
    /// </summary>
    public IReadOnlyDictionary<string, object?>? Set { get; set; }

    /// <summary>The rows <see cref="Set"/> changes (<c>JazminFilter.And()</c> for every row); they go together.</summary>
    public JazminFilter? Where { get; set; }

    /// <summary>
    /// Other tables' changes, by table name, in the same rewrite (the options above change the main table,
    /// <see cref="Table"/>): for example a client's key changed in every table that refers to it.
    /// </summary>
    public IReadOnlyDictionary<string, JazminTableChanges>? Tables { get; set; }
}

/// <summary>One table's row changes in an update (<see cref="JazminUpdate.Tables"/>): as the update's own options change its main table.</summary>
public sealed class JazminTableChanges
{
    /// <summary>New rows.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Insert { get; set; } = Array.Empty<IReadOnlyDictionary<string, object?>>();

    /// <summary>Rows that replace existing rows with the same <see cref="KeyColumns"/>; unmatched rows are inserted.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Upsert { get; set; } = Array.Empty<IReadOnlyDictionary<string, object?>>();

    public IReadOnlyList<string>? KeyColumns { get; set; }

    /// <summary>Removes matching rows.</summary>
    public JazminFilter? Delete { get; set; }

    /// <summary>Columns set on the rows <see cref="Where"/> matches (see <see cref="JazminUpdate.Set"/>).</summary>
    public IReadOnlyDictionary<string, object?>? Set { get; set; }

    public JazminFilter? Where { get; set; }

    /// <summary>The indexes a column has afterwards (see <see cref="JazminUpdate.Indexes"/>).</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<JazminIndexKind>>? Indexes { get; set; }

    /// <summary>A new sort order (an empty list for none; null keeps the table's).</summary>
    public IReadOnlyList<string>? SortedBy { get; set; }

    /// <summary>Nested columns given fields at the end of their objects (see <see cref="JazminUpdate.Columns"/>).</summary>
    public IReadOnlyList<JazminColumn>? Columns { get; set; }

    /// <summary>Whether anything changes (empty lists don't).</summary>
    internal bool Any => Insert.Count > 0 || Upsert.Count > 0 || Delete is not null || Set is not null || Indexes is not null || SortedBy is not null || Columns is not null;

    /// <summary>The main table's changes, from the update's own options.</summary>
    internal static JazminTableChanges Of(JazminUpdate u) => new()
    {
        Insert = u.Insert, Upsert = u.Upsert, KeyColumns = u.KeyColumns, Delete = u.Delete, Set = u.Set, Where = u.Where,
        Indexes = u.Indexes, SortedBy = u.SortedBy, Columns = u.Columns,
    };
}

/// <summary>A table added to an existing file (<see cref="JazminUpdate.AddTables"/>): its definition and its rows, read once.</summary>
public sealed class JazminAddedTable(JazminTable table, IEnumerable<IReadOnlyDictionary<string, object?>> rows)
{
    public JazminTable Table { get; } = table ?? throw new ArgumentNullException(nameof(table));

    public IEnumerable<IReadOnlyDictionary<string, object?>> Rows { get; } = rows ?? [];
}

/// <summary>The keys for <see cref="JazminFile.RotateKey"/>: the file's key or password now, and the new one.</summary>
public sealed class JazminKeyRotation
{
    /// <summary>The file's key now (or <see cref="Password"/>).</summary>
    public JazminKey? Key { get; set; }

    public string? Password { get; set; }

    /// <summary>The new key (or <see cref="NewPassword"/>): only it opens the file afterwards.</summary>
    public JazminKey? NewKey { get; set; }

    public string? NewPassword { get; set; }

    /// <summary>PBKDF2 iterations for <see cref="NewPassword"/> (default 600,000).</summary>
    public int KdfIterations { get; set; } = FormatConstants.DefaultKdfIterations;
}

/// <summary>
/// What <see cref="JazminFile.RotateOwnerKey"/> did: the new owner key, and a new access key for each grant, in the
/// file's grant order. Hand each person their new key; online keys also need new unlock tokens.
/// </summary>
public sealed record JazminOwnerKeyRotation(JazminKey OwnerKey, IReadOnlyList<JazminReissuedKey> AccessKeys);

/// <summary>A grant's new access key: <see cref="PreviousKeyId"/> is the id of the key it replaces.</summary>
public sealed record JazminReissuedKey(string PreviousKeyId, JazminAccessKey Key, string? Label, JazminGrantMode Mode, DateTimeOffset? Expires);

/// <summary>What <see cref="JazminFile.RotateKey"/> did: the sections it encrypted again and the new file's size.</summary>
public sealed record JazminKeyRotationResult(int Sections, long Bytes);

public sealed record JazminUpdateResult(long RowCount, long Inserted, long Updated, long Deleted)
{
    /// <summary>Grants dropped because they had expired.</summary>
    public int ExpiredGrantsRemoved { get; init; }

    /// <summary>With <see cref="JazminUpdate.Tables"/>: each changed table's counts, by its name afterwards.</summary>
    public IReadOnlyDictionary<string, JazminUpdateResult>? Tables { get; init; }

    // Printed as before, with Tables only when given (logs and output stay the same for updates without it).
    private bool PrintMembers(StringBuilder builder)
    {
        builder.Append($"RowCount = {RowCount}, Inserted = {Inserted}, Updated = {Updated}, Deleted = {Deleted}, ExpiredGrantsRemoved = {ExpiredGrantsRemoved}");
        if (Tables is not null) builder.Append($", Tables = {{ {string.Join(", ", Tables.Select(t => $"{t.Key} = {t.Value}"))} }}");
        return true;
    }
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

    /// <summary>
    /// Nested columns given fields at the end of their objects (nullable ones, spec 5.4): their new definitions. Fields of
    /// .NET objects are added without it; it is for rows given as JSON or dictionaries.
    /// </summary>
    public IReadOnlyList<JazminColumn>? Columns { get; set; }

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

    /// <summary>Saved export shapes to add (a name that exists is replaced).</summary>
    public IReadOnlyList<JazminSavedShape> AddShapes { get; set; } = Array.Empty<JazminSavedShape>();

    /// <summary>Names of saved export shapes to remove.</summary>
    public IReadOnlyList<string> RemoveShapes { get; set; } = Array.Empty<string>();

    public int ChunkRows { get; set; } = FormatConstants.DefaultChunkRows;

    /// <summary>Compact automatically afterwards when a threshold is reached (null: never).</summary>
    public JazminAutoCompact? AutoCompact { get; set; }

    /// <summary>Memory or speed first while the file is read and rewritten (default <see cref="JazminPriority.Balanced"/>).</summary>
    public JazminPriority Priority { get; set; }

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

    /// <summary>
    /// Encrypts a file again under a new key or password without decoding its rows (TASKS S-2). Every section is
    /// decrypted and encrypted again as it is stored (still compressed), under a new master key, file id, salt and
    /// keyring, so only the new key or password opens the result, and the file keeps its layout. A file with appends is
    /// compacted first: its earlier versions, still under the old key, are dropped. Access-controlled files are not
    /// supported.
    /// </summary>
    public static JazminKeyRotationResult RotateKey(string path, JazminKeyRotation rotation) => WithLock(path, () => RotateUnlocked(path, rotation));

    /// <summary>
    /// A shared (access-controlled) file under a new owner key (default: generated), when the old one may have leaked.
    /// Every access key is replaced too, since each carries its owner's fingerprint (spec 7.6.6): each grant keeps its
    /// rows, columns, files, label, expiry and mode under a new access key. Online grants also get a new share, so they
    /// need new unlock tokens (<see cref="IssueUnlockToken(string, JazminKey, string, DateTimeOffset?)"/> with the new
    /// owner key). Expired grants are dropped. The file is rewritten with fresh secrets throughout, as
    /// <see cref="Update"/> does.
    /// </summary>
    public static JazminOwnerKeyRotation RotateOwnerKey(string path, JazminKey key, JazminKey? newKey = null, DateTimeOffset? now = null) => WithLock(path, () =>
    {
        var owner = newKey ?? JazminKey.Generate();
        var at = now ?? DateTimeOffset.UtcNow;
        var issued = new List<JazminReissuedKey>();
        List<JazminGrant> Regrant(List<JazminGrant> grants)
        {
            var next = new List<JazminGrant>();
            foreach (var g in grants)
            {
                var expires = g.Expires ?? (g.ExpiresIn is { } span ? at + span : null);
                if (expires <= at) continue; // expired: dropped, as Update drops it
                var accessKey = owner.CreateAccessKey();
                issued.Add(new JazminReissuedKey(g.Key.Id, accessKey, g.Label, g.Mode, expires));
                // No share: an online grant gets a new one, which the new owner key's unlock tokens use.
                next.Add(new JazminGrant(accessKey) { Rows = g.Rows, Columns = g.Columns, Files = g.Files, Label = g.Label, Expires = expires, Mode = g.Mode });
            }
            return next;
        }
        // The same instant for the grants checked here and those the writer drops.
        UpdateUnlocked(path, new JazminUpdate { Key = key, Now = at }, newOwner: (owner, Regrant));
        return new JazminOwnerKeyRotation(owner, issued);
    });

    private static JazminKeyRotationResult RotateUnlocked(string path, JazminKeyRotation rotation)
    {
        if ((rotation.NewKey is null) == (rotation.NewPassword is null)) throw new JazminValidationException("Supply either NewKey or NewPassword");
        if (rotation.NewPassword is not null && rotation.KdfIterations is < FormatConstants.MinKdfIterations or > FormatConstants.MaxKdfIterations)
            throw new JazminValidationException($"KdfIterations must be from {FormatConstants.MinKdfIterations} to {FormatConstants.MaxKdfIterations}");
        var salt = RandomNumberGenerator.GetBytes(FormatConstants.SaltSize);
        var master = rotation.NewPassword is not null ? Crypto.DeriveFromPassword(rotation.NewPassword, salt, rotation.KdfIterations) : rotation.NewKey!.ToBytes();

        var readOptions = new JazminReadOptions { Key = rotation.Key, Password = rotation.Password };
        var reader = JazminReader.Open(path, readOptions);
        JazminReader.KeyRotationPlan plan;
        try
        {
            plan = reader.KeyRotation();
            if ((plan.Flags & FormatConstants.FlagAppended) != 0 || plan.Recovered)
            {
                // Earlier versions are still in the file, under the old key: compact first, which writes only the current one.
                reader.Dispose();
                UpdateUnlocked(path, new JazminUpdate { Key = rotation.Key, Password = rotation.Password });
                reader = JazminReader.Open(path, readOptions);
                plan = reader.KeyRotation();
            }
        }
        catch
        {
            reader.Dispose();
            throw;
        }

        var sections = plan.Sections.OrderBy(s => s.Offset).ToList();
        // Every byte between the preamble and the header must belong to a listed section: anything else would be lost.
        long at = FormatConstants.PreambleSize;
        for (var i = 0; i <= sections.Count; i++)
        {
            var offset = i < sections.Count ? sections[i].Offset : plan.HeaderRef.Offset;
            if (offset != at)
            {
                reader.Dispose();
                throw new JazminFormatException($"Bytes {at} to {offset} belong to no section this reader knows: the key was not rotated");
            }
            if (i < sections.Count) at += sections[i].Length;
        }

        var fileId = RandomNumberGenerator.GetBytes(FormatConstants.FileIdSize);
        var keys = new KeySchedule(master, salt) { Keyring = (plan.Header.Keyring ?? []).ToDictionary(k => k.Key, _ => RandomNumberGenerator.GetBytes(32)) };
        var temp = $"{path}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant()}.tmp";
        long bytes;
        try
        {
            using (var source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16))
            using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16))
            {
                var preamble = new byte[FormatConstants.PreambleSize];
                FormatConstants.Magic.CopyTo(preamble.AsSpan());
                BinaryPrimitives.WriteUInt16LittleEndian(preamble.AsSpan(FormatConstants.FlagsOffset),
                    (ushort)(FormatConstants.FlagEncrypted | (rotation.NewPassword is not null ? FormatConstants.FlagPassword : 0)));
                fileId.CopyTo(preamble, 8);
                salt.CopyTo(preamble, 24);
                BinaryPrimitives.WriteUInt32LittleEndian(preamble.AsSpan(56), rotation.NewPassword is not null ? (uint)rotation.KdfIterations : 0);
                output.Write(preamble);

                var buffer = Array.Empty<byte>(); // one section at a time
                foreach (var s in sections)
                {
                    if (buffer.Length < s.Length) buffer = new byte[(int)Math.Min(int.MaxValue, s.Length * 5L / 4)];
                    source.Position = s.Offset;
                    source.ReadExactly(buffer, 0, s.Length);
                    var next = s.ContentKey is not null ? Crypto.Hkdf(s.ContentKey, salt, $"JAZMIN/1/{s.SectionId}") : keys.SectionKey(s.Group!, s.SectionId);
                    output.Write(SectionCodec.Reencrypt(buffer.AsSpan(0, s.Length), s.Key, plan.FileId, s.SectionId, next, fileId));
                }

                source.Position = plan.HeaderRef.Offset;
                var codec = (JazminCodec)source.ReadByte();
                plan.Header.Keyring = keys.Keyring;
                plan.Header.Modified = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var headerSection = SectionCodec.Encode(Catalog.EncodeHeader(plan.Header), Enum.IsDefined(codec) ? codec : JazminCodec.Deflate, null,
                    keys.HeaderKey, fileId, FormatConstants.HeaderSectionId);
                var headerOffset = output.Position;
                output.Write(headerSection);
                output.Flush(flushToDisk: true); // data first: a trailer must never point at data that is not on disk yet
                var trailer = new byte[FormatConstants.TrailerSize];
                BinaryPrimitives.WriteUInt64LittleEndian(trailer, (ulong)headerOffset);
                BinaryPrimitives.WriteUInt32LittleEndian(trailer.AsSpan(8), (uint)headerSection.Length);
                BinaryPrimitives.WriteUInt32LittleEndian(trailer.AsSpan(36), Crc32.Compute(trailer.AsSpan(0, 36)));
                FormatConstants.Magic.CopyTo(trailer.AsSpan(40));
                output.Write(trailer);
                output.Flush(flushToDisk: true);
                bytes = output.Length;
            }
            reader.Dispose();
            ReplaceFile(temp, path);
        }
        catch
        {
            reader.Dispose();
            File.Delete(temp);
            throw;
        }
        return new JazminKeyRotationResult(sections.Count + 1, bytes);
    }

    // newOwner (RotateOwnerKey): the new owner key, and the grants it writes instead of the file's.
    private static JazminUpdateResult UpdateUnlocked(string path, JazminUpdate update, bool regroup = false,
        (JazminKey Key, Func<List<JazminGrant>, List<JazminGrant>> Grants)? newOwner = null)
    {
        ArgumentNullException.ThrowIfNull(update);

        var temp = $"{path}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant()}.tmp";
        var reader = JazminReader.Open(path, new JazminReadOptions { Key = update.Key, Password = update.Password, Table = update.Table, Priority = update.Priority });
        var readers = new List<JazminReader> { reader }; // in a file with several tables, one per table, in file order
        JazminWriter? writer = null;
        var sorters = new List<RowSorter>(); // rows put in a new sort order within a memory budget, disposed at the end
        try
        {
            var ownerGrants = reader.OwnerGrants;
            if (ownerGrants is null && reader.Access is not null) throw new JazminKeyException("Only the file owner's master key can modify this file");
            if (ownerGrants is null && (update.Grant.Count > 0 || update.Revoke.Count > 0))
                throw new JazminValidationException("Grant/Revoke apply only to access-controlled files");
            if (ownerGrants is null && newOwner is not null)
                throw new JazminValidationException("The file is not access-controlled: use RotateKey to change its key");
            if (reader.Tables.Count > 1)
            {
                readers.Clear();
                foreach (var name in reader.Tables)
                    readers.Add(name == reader.TableName ? reader : reader.OpenTable(name));
            }

            // The tables afterwards: those kept (renamed as asked), then those added.
            var plan = PlanTables(reader.Tables, update, ownerGrants is not null);
            var kept = readers.Where(r => !plan.Removed.Contains(r.TableName)).ToList();
            string FinalName(string name) => plan.Names.TryGetValue(name, out var to) ? to : name;

            // Each table's changes: the main table's from the update's own options, others' from Tables (one rewrite for them all).
            var changes = new Dictionary<string, JazminTableChanges>(StringComparer.Ordinal) { [reader.TableName] = JazminTableChanges.Of(update) };
            foreach (var (name, given) in update.Tables ?? new Dictionary<string, JazminTableChanges>())
            {
                if (!readers.Any(r => r.TableName == name)) throw new JazminValidationException($"Tables: the file has no table '{name}'");
                if (given is null) throw new JazminValidationException($"Tables: '{name}' needs its changes");
                if (name == reader.TableName && changes[name].Any)
                    throw new JazminValidationException($"Tables: give table '{name}''s changes either in Tables or with the update's other options, not both");
                changes[name] = given;
            }
            foreach (var (name, c) in changes)
                if (plan.Removed.Contains(name) && c.Any) throw new JazminValidationException($"Table '{name}' is being removed: its rows can't change too");
            var rewrites = new Dictionary<JazminReader, TableRewrite>(ReferenceEqualityComparer.Instance);
            foreach (var r in kept)
                if (changes.TryGetValue(r.TableName, out var c))
                    rewrites[r] = new TableRewrite(r, c, ownerGrants is null ? null : r.AccessLayout.PartitionBy, regroup && r == reader, update, sorters);

            // The other tables of the file are copied as they are: a new version has fresh secrets throughout (spec 7.6.7).
            var access = ownerGrants is null ? null : AccessFor(reader, ownerGrants, update);
            if (access is not null && newOwner is { } change) access.Grants = change.Grants(access.Grants);
            // Named tables (several, or one with a name) are written as tables, which keeps their names.
            var named = kept.Count + update.AddTables.Count > 1 || kept.Any(r => FinalName(r.TableName).Length > 0) || update.AddTables.Count > 0;
            var main = named ? null : rewrites[reader]; // not named: the file's one table, the main one
            var options = new JazminWriteOptions
            {
                Key = newOwner?.Key ?? update.Key,
                Password = update.Password,
                KdfIterations = reader.KdfIterations ?? FormatConstants.DefaultKdfIterations,
                Metadata = MergeMetadata(reader.Metadata, update.Metadata),
                SortedBy = main?.Target,
                Codec = update.Codec,
                CompressionLevel = update.CompressionLevel,
                ChunkRows = update.ChunkRows,
                Package = PackageAfter(update.Package ?? reader.Package, plan),
                Links = update.Links ?? (reader.Links.Count > 0 ? Links.After(reader.Links, plan.Removed, plan.Names) : null),
                Shapes = SavedShapes.Kept(reader.FileState()?.Shapes ?? [], update.AddShapes, update.RemoveShapes)
                    .Select(s => ShapeAfter(s.ToPublic(withGroups: true), plan)).Concat(update.AddShapes).ToList(),
                Access = access is null ? null : named ? new JazminAccessOptions { Grants = access.Grants } : access,
                Now = update.Now, // expired grants are dropped; the new version's fresh secrets lock them out
                Priority = update.Priority,
                CompactIndexes = update.CompactIndexes ?? reader.CompactIndexes,
                Tables = named
                    ? kept.Select(r => rewrites.TryGetValue(r, out var w) ? TableFor(r, w.Columns, w.Target, FinalName(r.TableName)) : TableFor(r, null, r.SortedBy, FinalName(r.TableName)))
                        .Concat(update.AddTables.Select(a => a.Table)).ToList()
                    : null,
            };
            writer = named ? JazminWriter.Create(temp, options) : JazminWriter.Create(temp, main!.Columns, options);
            foreach (var source in CarriedFiles(reader, update)) writer.AddSource(source);
            foreach (var file in update.AddFiles) writer.AddFile(file);

            var result = new JazminUpdateResult(0, 0, 0, 0);
            var tableResults = new Dictionary<string, JazminUpdateResult>(StringComparer.Ordinal);
            var first = true;
            foreach (var r in kept)
            {
                if (!first) writer.StartTable(FinalName(r.TableName));
                first = false;
                if (rewrites.TryGetValue(r, out var rewrite))
                {
                    var done = rewrite.Write(writer);
                    tableResults[FinalName(r.TableName)] = done;
                    if (r == reader) result = done;
                }
                else
                {
                    foreach (var row in r.Rows()) writer.WriteValues(row.RawValues);
                }
            }
            // Added tables: their rows as given, or put in their SortedBy's order within the memory budget.
            foreach (var added in update.AddTables)
            {
                if (!first) writer.StartTable(added.Table.Name);
                first = false;
                var addedShape = new RowShape(added.Table.Columns.ToList());
                if (added.Table.SortedBy is not { Count: > 0 } addedOrder)
                {
                    foreach (var row in added.Rows) writer.WriteValues(addedShape.ValuesOf(row));
                    continue;
                }
                var orderCols = addedOrder.Select(addedShape.Ordinal).ToArray();
                var sorter = new RowSorter(added.Table.Columns, values => addedShape.KeyTuple(values, orderCols), update.SortRunRows ?? RowSorter.RunRows(update.Priority), update.Codec);
                sorters.Add(sorter);
                foreach (var row in added.Rows) sorter.Add(addedShape.ValuesOf(row));
                foreach (var values in sorter.Rows()) writer.WriteValues(values);
                sorter.Dispose();
            }

            foreach (var r in readers) r.Dispose();
            foreach (var s in sorters) s.Dispose();
            writer.Finish();
            ReplaceFile(temp, path);
            return result with { ExpiredGrantsRemoved = writer.ExpiredGrants, Tables = update.Tables is null ? null : tableResults };
        }
        catch
        {
            writer?.Abort();
            foreach (var r in readers) r.Dispose();
            foreach (var s in sorters) s.Dispose();
            File.Delete(temp);
            throw;
        }
    }

    /// <summary>
    /// One table's changes, planned: its columns and sort order afterwards, and <see cref="Write"/>, which writes its rows
    /// with the changes applied. Deletes go first, upserted rows replace whole rows, Set changes the rest Where matches.
    /// </summary>
    private sealed class TableRewrite
    {
        private readonly JazminReader _reader;
        private readonly JazminTableChanges _changes;
        private readonly bool _regroup;
        private readonly string _name;
        private readonly bool _resortAsked;
        private readonly bool _setsOrder;
        private readonly JazminFilter? _whereFilter;
        private readonly JazminUpdate _update;
        private readonly List<RowSorter> _sorters;
        private readonly RowShape _shape;
        private readonly int[] _keyCols;
        private readonly int[]? _sortCols;
        private readonly Dictionary<string, (object?[] Values, bool Matched)> _pending = new(StringComparer.Ordinal);
        private readonly BoundFilter? _delete;
        private readonly BoundFilter? _where;
        private readonly int[] _setCols = [];
        private readonly object?[] _setValues = [];

        public IReadOnlyList<JazminColumn> Columns { get; }

        public IReadOnlyList<string>? Target { get; }

        public TableRewrite(JazminReader reader, JazminTableChanges changes, string? partitionBy, bool regroup, JazminUpdate update, List<RowSorter> sorters)
        {
            (_reader, _changes, _regroup, _update, _sorters) = (reader, changes, regroup, update, sorters);
            var name = _name = reader.TableName.Length > 0 ? $"Table '{reader.TableName}'" : "The table";
            if (changes.Upsert.Count > 0 && (changes.KeyColumns is null || changes.KeyColumns.Count == 0))
                throw new JazminValidationException("Upsert needs KeyColumns, e.g. KeyColumns = [\"id\"]");
            if ((changes.Set is null) != (changes.Where is null))
                throw new JazminValidationException($"{name}: Set and Where go together: Set = {{ [column] = value }}, Where = a filter (JazminFilter.And() for every row)");
            if (changes.Set is { Count: 0 }) throw new JazminValidationException($"{name}: Set needs a column to set");

            // The sort order afterwards: the table's, or a new one (SortedBy; empty for none).
            Target = changes.SortedBy is null ? reader.SortedBy : changes.SortedBy.Count == 0 ? null : changes.SortedBy;
            var resortAsked = !(Target ?? []).SequenceEqual(reader.SortedBy ?? [], StringComparer.Ordinal);
            if (regroup && partitionBy is null) throw new JazminValidationException("Regroup applies to access-controlled files with PartitionBy");
            if (regroup && Target is { } order && order[0] != partitionBy)
                throw new JazminValidationException($"Regroup would break the SortedBy order [{string.Join(", ", order)}]: it needs no SortedBy, " +
                    $"or one that starts with the partition column '{partitionBy}' (then rows are already grouped)");

            _shape = new RowShape(WithIndexes(ColumnsWithIndexes(reader), changes.Indexes, reader.SortedBy, Target, resortAsked));
            foreach (var n in Target ?? []) _shape.Ordinal(n); // an unknown sort column is refused before anything is written
            _keyCols = changes.KeyColumns?.Select(_shape.Ordinal).ToArray() ?? [];
            _sortCols = reader.SortedBy?.Select(_shape.Ordinal).ToArray();
            foreach (var row in changes.Upsert)
            {
                var values = _shape.ValuesOf(row);
                _pending[_shape.KeyText(values, _keyCols)] = (values, false);
            }
            _delete = BoundFilter.Bind(changes.Delete, reader.Columns);

            // Set: its columns exist; in a shared file the partition column stays (its rows would leave the partitions
            // keys are granted). Rows whose sort columns are set move: they go through the sorter, as a new order would.
            if (changes.Set is { } set)
            {
                foreach (var column in set.Keys)
                {
                    if (!_shape.Columns.Any(c => c.Name == column)) throw new JazminValidationException($"{name}: Set: unknown column '{column}'");
                    if (column == partitionBy)
                        throw new JazminValidationException($"{name}: Set changes the partition column '{partitionBy}': the rows would leave the partitions keys are granted");
                }
                _setCols = set.Keys.Select(_shape.Ordinal).ToArray();
                _setValues = _shape.ValuesOf(set);
                _where = BoundFilter.Bind(changes.Where, reader.Columns);
            }
            // Rows whose sort columns are set move. When few match (up to the sort budget) they are found first, by the
            // file's indexes, held, and merged in at their new place as the table streams; more go through the sorter.
            _resortAsked = resortAsked;
            _setsOrder = Target is not null && changes.Set is not null && changes.Set.Keys.Any(Target.Contains);
            _whereFilter = changes.Where;
            Columns = Grown(_shape.Columns, changes.Insert.Concat(changes.Upsert).Select(_shape.ValuesOf).Append(_setValues).Where(v => v.Length > 0).ToList(), changes.Columns);
        }

        /// <summary>Writes the table's rows with the changes applied.</summary>
        public JazminUpdateResult Write(JazminWriter writer)
        {
            long inserted, updated = 0, deleted = 0;
            List<object?[]>? moved = null; // the rows whose sort columns are set, changed, when few enough to hold
            // Counted first (by the indexes, or the filter's columns only), so too many are never gathered.
            if (_setsOrder && !_resortAsked && !_regroup && _reader.Count(_whereFilter) <= (_update.SortRunRows ?? RowSorter.RunRows(_update.Priority)))
            {
                moved = [];
                foreach (var row in _reader.Find(_whereFilter))
                {
                    var values = row.RawValues;
                    if ((_pending.Count > 0 && _pending.ContainsKey(_shape.KeyText(values, _keyCols))) || (_delete is not null && FilterEngine.Evaluate(_delete, values)))
                        continue; // upserted or deleted instead
                    var copy = (object?[])values.Clone();
                    foreach (var i in _setCols) copy[i] = _setValues[i];
                    moved.Add(copy);
                }
            }
            var resort = _resortAsked || (_setsOrder && moved is null);
            RowSorter? sorter = null;
            if (resort && Target is not null)
            {
                var targetCols = Target.Select(_shape.Ordinal).ToArray();
                sorter = new RowSorter(Columns, values => _shape.KeyTuple(values, targetCols), _update.SortRunRows ?? RowSorter.RunRows(_update.Priority), _update.Codec);
                _sorters.Add(sorter);
            }
            void Emit(object?[] values)
            {
                if (sorter is not null) sorter.Add(values);
                else writer.WriteValues(values);
            }
            object?[] Changed(object?[] values)
            {
                if (_where is null || !FilterEngine.Evaluate(_where, values)) return values;
                updated++;
                var copy = (object?[])values.Clone();
                foreach (var i in _setCols) copy[i] = _setValues[i];
                return copy;
            }
            if (_sortCols is not null && !resort)
            {
                // Upserted rows are re-inserted at their sorted position (their sort key may change),
                // so the whole change set merges into the stream in one pass.
                var incoming = _changes.Insert.Select(_shape.ValuesOf).Concat(_pending.Values.Select(p => p.Values)).Concat(moved ?? [])
                    .Select(v => (Values: v, Key: _shape.KeyTuple(v, _sortCols)))
                    .OrderBy(x => x.Key, Comparer<object?[]>.Create(SortKeys.Compare))
                    .ToList();
                var next = 0;
                var movedOut = 0;
                foreach (var row in _reader.Rows())
                {
                    var values = row.RawValues;
                    var rowKey = _shape.KeyTuple(values, _sortCols);
                    while (next < incoming.Count && SortKeys.Compare(incoming[next].Key, rowKey) < 0) writer.WriteValues(incoming[next++].Values);
                    var key = _pending.Count > 0 ? _shape.KeyText(values, _keyCols) : null;
                    if (key is not null && _pending.TryGetValue(key, out var hit))
                    {
                        if (hit.Matched) deleted++; // duplicate key rows collapse into the single upserted row
                        else updated++;
                        _pending[key] = (hit.Values, true);
                    }
                    else if (_delete is not null && FilterEngine.Evaluate(_delete, values)) deleted++;
                    else if (moved is not null && FilterEngine.Evaluate(_where!, values))
                    {
                        updated++; // written at its new place, from incoming
                        movedOut++;
                    }
                    else writer.WriteValues(Changed(values)); // the writer copies into its own buffer
                }
                while (next < incoming.Count) writer.WriteValues(incoming[next++].Values);
                // Every row taken out was one gathered, or a row would be lost or doubled (nothing is written then).
                if (moved is not null && movedOut != moved.Count)
                    throw new InvalidOperationException($"{_name}: {moved.Count} rows to move were found, but {movedOut} were taken out");
            }
            else
            {
                foreach (var row in _regroup ? _reader.RowsByPartition() : _reader.Rows())
                {
                    var values = row.RawValues;
                    var key = _pending.Count > 0 ? _shape.KeyText(values, _keyCols) : null;
                    if (key is not null && _pending.TryGetValue(key, out var hit))
                    {
                        if (hit.Matched)
                        {
                            deleted++;
                            continue;
                        }
                        _pending[key] = (hit.Values, true);
                        updated++;
                        Emit(hit.Values);
                    }
                    else if (_delete is not null && FilterEngine.Evaluate(_delete, values)) deleted++;
                    else Emit(Changed(values)); // the writer copies into its own buffer; the sorter keeps the row's own array
                }
                foreach (var row in _changes.Insert) Emit(_shape.ValuesOf(row));
                foreach (var (values, matched) in _pending.Values)
                    if (!matched) Emit(values);
                if (sorter is not null)
                {
                    foreach (var values in sorter.Rows()) writer.WriteValues(values);
                    sorter.Dispose(); // its temporary files go now, not after every table
                }
            }
            inserted = _changes.Insert.Count + _pending.Values.Count(p => !p.Matched);
            return new JazminUpdateResult(writer.RowCount, inserted, updated, deleted);
        }
    }

    /// <summary>Which tables a rewrite keeps, removes, renames and adds, checked; the file's first table by name.</summary>
    private sealed record TablePlan(HashSet<string> Removed, Dictionary<string, string> Names, string First)
    {
        public bool Changed => Removed.Count > 0 || Names.Count > 0;
    }

    private static TablePlan PlanTables(IReadOnlyList<string> existing, JazminUpdate update, bool shared)
    {
        var removed = new HashSet<string>(update.RemoveTables, StringComparer.Ordinal);
        foreach (var name in removed)
            if (!existing.Contains(name)) throw new JazminValidationException($"RemoveTables: the file has no table '{name}'");
        var names = new Dictionary<string, string>(update.RenameTables, StringComparer.Ordinal);
        foreach (var (from, to) in names)
        {
            if (!existing.Contains(from)) throw new JazminValidationException($"RenameTables: the file has no table '{from}'");
            if (removed.Contains(from)) throw new JazminValidationException($"RenameTables: table '{from}' is being removed");
            if (string.IsNullOrEmpty(to)) throw new JazminValidationException($"RenameTables: '{from}' needs a non-empty new name");
        }
        var after = existing.Where(n => !removed.Contains(n)).Select(n => names.TryGetValue(n, out var to) ? to : n).ToList();
        foreach (var added in update.AddTables)
        {
            if (string.IsNullOrEmpty(added.Table.Name)) throw new JazminValidationException("AddTables: each table needs a name");
            if (!shared && (added.Table.PartitionBy is not null || added.Table.ColumnGroups.Count > 0))
                throw new JazminValidationException($"AddTables: '{added.Table.Name}': PartitionBy and ColumnGroups apply to shared files");
            after.Add(added.Table.Name);
        }
        if (after.Count == 0) throw new JazminValidationException("A file needs at least one table: add one, or keep one");
        if (update.AddTables.Count > 0 && after.Contains(""))
            throw new JazminValidationException("The file's table has no name: name it first (RenameTables = { [\"\"] = \"clients\" })");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var n in after)
            if (!seen.Add(n)) throw new JazminValidationException($"Table '{n}' would be in the file twice");
        return new TablePlan(removed, names, existing[0]);
    }

    /// <summary>A shape's tables: its own (none named: the file's first) and every <c>$from</c>.</summary>
    private static HashSet<string> ShapeTables(JazminSavedShape shape, string first)
    {
        var names = new HashSet<string>(StringComparer.Ordinal) { shape.Table ?? first };
        void Walk(JsonNode? node)
        {
            if (node is JsonArray array) foreach (var item in array) Walk(item);
            else if (node is JsonObject obj)
                foreach (var (key, value) in obj)
                {
                    if (key == "$from" && value is JsonValue v && v.TryGetValue<string>(out var table)) names.Add(table);
                    else Walk(value);
                }
        }
        Walk(shape.Shape);
        return names;
    }

    /// <summary>A saved shape after tables are renamed (named explicitly: the first table may change); refused when it reads a removed one.</summary>
    private static JazminSavedShape ShapeAfter(JazminSavedShape shape, TablePlan plan)
    {
        if (!plan.Changed) return shape;
        foreach (var table in ShapeTables(shape, plan.First))
            if (plan.Removed.Contains(table))
                throw new JazminValidationException($"Saved shape '{shape.Name}' reads table '{table}', which is being removed: remove the shape too (RemoveShapes)");
        string Rename(string n) => plan.Names.TryGetValue(n, out var to) ? to : n;
        JsonNode? Renamed(JsonNode? node) => node switch
        {
            JsonArray array => new JsonArray(array.Select(Renamed).ToArray()),
            JsonObject obj => new JsonObject(obj.Select(p => KeyValuePair.Create(p.Key,
                p.Key == "$from" && p.Value is JsonValue v && v.TryGetValue<string>(out var t) ? (JsonNode?)Rename(t) : Renamed(p.Value)))),
            _ => node?.DeepClone(),
        };
        return new JazminSavedShape(shape.Name, (JsonObject)Renamed(shape.Shape)!)
        {
            Description = shape.Description, IsDefault = shape.IsDefault, Table = Rename(shape.Table ?? plan.First), Groups = shape.Groups,
        };
    }

    /// <summary>The package after tables are renamed or removed: its edit table follows a rename, and can't be removed.</summary>
    private static JazminPackage? PackageAfter(JazminPackage? package, TablePlan plan)
    {
        if (!plan.Changed || package?.Edit is not { } edit) return package;
        var table = edit.Table ?? plan.First; // none named: the file's first, which may be another table afterwards
        if (plan.Removed.Contains(table)) throw new JazminValidationException($"The document's edits change table '{table}', which is being removed: change Package.Edit first");
        return new JazminPackage
        {
            Entry = package.Entry, Title = package.Title, AllowedOrigins = package.AllowedOrigins, AllowWasm = package.AllowWasm, Pdf = package.Pdf,
            Edit = edit with { Table = plan.Names.TryGetValue(table, out var to) ? to : table },
        };
    }

    /// <summary>
    /// Columns with the indexes <paramref name="indexes"/> gives them; columns not named keep theirs. The old first sort
    /// column found its values by the order, with no index of its own: re-sorted away from it, it gets a sorted index,
    /// so lookups on it stay fast, unless <paramref name="indexes"/> names it.
    /// </summary>
    private static List<JazminColumn> WithIndexes(List<JazminColumn> columns, IReadOnlyDictionary<string, IReadOnlyList<JazminIndexKind>>? indexes,
        IReadOnlyList<string>? sortedBy, IReadOnlyList<string>? target, bool resort)
    {
        foreach (var name in indexes?.Keys ?? [])
            if (!columns.Any(c => c.Name == name)) throw new JazminValidationException($"Indexes: unknown column '{name}'");
        var was = sortedBy?.FirstOrDefault();
        return columns.Select(c =>
        {
            if (indexes is not null && indexes.TryGetValue(c.Name, out var kinds))
            {
                foreach (var kind in kinds)
                    if (!TypeNames.Supports(kind, c.Type))
                        throw new JazminValidationException($"Column '{c.Name}': a {TypeNames.IndexName(kind)} index is not supported on {TypeNames.ToName(c.Type)}");
                return c.With(kinds.Distinct().ToArray());
            }
            if (resort && c.Name == was && target?.FirstOrDefault() != was && TypeNames.Supports(JazminIndexKind.Sorted, c.Type) && !c.Indexes.Contains(JazminIndexKind.Sorted))
                return c.With([.. c.Indexes, JazminIndexKind.Sorted]);
            return c;
        }).ToList();
    }

    /// <summary>
    /// The table's columns, with nested columns grown to hold the rows to be written (spec 5.4): the definitions given
    /// (checked: fields added at the end, nullable), then the members of .NET objects the definitions lack.
    /// </summary>
    private static IReadOnlyList<JazminColumn> Grown(IReadOnlyList<JazminColumn> columns, IReadOnlyList<object?[]> rows, IReadOnlyList<JazminColumn>? given)
    {
        var grown = columns.ToArray();
        foreach (var definition in given ?? [])
        {
            var i = Array.FindIndex(grown, c => c.Name == definition.Name);
            if (i < 0) throw new JazminValidationException($"Columns: unknown column '{definition.Name}'");
            if (!TypeNames.IsNested(grown[i].Type)) throw new JazminValidationException($"Columns: '{definition.Name}' is not a list or object column; only those can be given fields");
            TypeNames.Validate([definition]);
            if (Nested.NotGrown(grown[i], definition, definition.Name) is { } why) throw new JazminValidationException(why);
            grown[i] = definition.Indexes.Count == grown[i].Indexes.Count ? definition : definition.With(grown[i].Indexes);
        }
        for (var i = 0; i < grown.Length; i++)
        {
            if (!TypeNames.IsNested(grown[i].Type)) continue;
            var seen = new HashSet<Type>();
            foreach (var row in rows)
                if (row[i] is { } value && seen.Add(value.GetType())) grown[i] = Nested.GrowFor(grown[i], value);
        }
        return grown;
    }

    /// <summary>A table of the file as writer options for a rewrite: its columns with their indexes, sort order and layout.</summary>
    private static JazminTable TableFor(JazminReader reader) => TableFor(reader, null);

    private static JazminTable TableFor(JazminReader reader, IReadOnlyList<JazminColumn>? columns) => TableFor(reader, columns, reader.SortedBy, reader.TableName);

    private static JazminTable TableFor(JazminReader reader, IReadOnlyList<JazminColumn>? columns, IReadOnlyList<string>? sortedBy, string name)
    {
        var (partitionBy, groups) = reader.AccessLayout;
        return new JazminTable(name, columns ?? ColumnsWithIndexes(reader))
        {
            SortedBy = sortedBy,
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

    /// <summary>
    /// A change file (spec 7.9) for changes to <paramref name="source"/>, an open file whose document allows them
    /// (<see cref="JazminPackage.Edit"/>): checked as far as the sender can (what the document allows, rows this key
    /// sees), with the earlier values taken from <paramref name="source"/>. Sealed with a shared file's submission key;
    /// give a file that isn't shared its <paramref name="key"/> or <paramref name="password"/>.
    /// </summary>
    public static byte[] WriteChanges(JazminReader source, JazminChanges changes, JazminKey? key = null, string? password = null) =>
        Changes.Write(source, changes, key, password);

    /// <summary>
    /// Applies a change file to the file at <paramref name="path"/>, as its document allows changes now. A shared file
    /// is changed with its owner key; the sender is the grant whose submission key opens the change file, and may change
    /// only that grant's rows and columns. Rows changed since the sender's copy are held as conflicts unless
    /// <see cref="JazminApplyChangesOptions.Overwrite"/>; refused changes are reported. One append writes the rest.
    /// </summary>
    public static JazminChangesResult ApplyChanges(string path, byte[] change, JazminApplyChangesOptions options) =>
        Changes.Apply(path, change, options);

    /// <summary>The kinds of file <see cref="FileSubmission"/> accepts unless told otherwise: PDF, JPEG, PNG and WebP.</summary>
    public static IReadOnlyList<string> SubmissionFileTypes => Submissions.FileTypes;

    /// <summary>
    /// Files a submission - records an access key holder sent back, locked with their submission key, with any files -
    /// into the shared file at <paramref name="path"/>, with its owner key, by the filing rules (USER-GUIDE 15.6): the
    /// sender's grant and expiry, partitions and columns; records sent again; files checked by their first bytes and
    /// size. One append. Throws <see cref="JazminSubmissionRejectedException"/> for a batch that must not be filed;
    /// other errors (the file busy, a full disk) mean try again later.
    /// </summary>
    public static JazminSubmissionResult FileSubmission(string path, byte[] batch, JazminFileSubmissionOptions options) =>
        Submissions.File(path, batch, options);

    private static JazminAppendResult AppendUnlocked(string path, JazminAppend append)
    {
        ArgumentNullException.ThrowIfNull(append);
        if (append.Upsert.Count > 0 && (append.KeyColumns is null || append.KeyColumns.Count == 0))
            throw new JazminValidationException("Upsert needs KeyColumns, e.g. KeyColumns = [\"id\"]");

        var reader = JazminReader.Open(path, new JazminReadOptions { Key = append.Key, Password = append.Password, Table = append.Table, Priority = append.Priority });
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
            var columns = Grown(shape.Columns, incoming, append.Columns);
            var sortedBy = reader.SortedBy;
            if (sortedBy is not null)
            {
                var sortCols = sortedBy.Select(shape.Ordinal).ToArray();
                incoming = incoming.Select(v => (Values: v, Key: shape.KeyTuple(v, sortCols)))
                    .OrderBy(x => x.Key, Comparer<object?[]>.Create(SortKeys.Compare)).Select(x => x.Values).ToList();
            }
            var accessOptions = ownerGrants is null ? null : AccessFor(reader, ownerGrants, new JazminUpdate { Grant = append.Grant });
            var files = AppendFiles(state.Files, append);
            // Saved shapes are checked against every table they read: the file's other tables are as it has them.
            var shapeTables = (files?.Shapes is { Count: > 0 } || append.AddShapes.Count > 0) && reader.Tables.Count > 1
                ? reader.Tables.Select(name =>
                {
                    if (name == reader.TableName) return null;
                    using var other = reader.OpenTable(name);
                    return ShapeTable.Of(other);
                }).ToList()
                : null;
            var metadata = reader.Metadata;
            var (rowCountBefore, appendCountBefore) = (reader.RowCount, reader.AppendCount);
            reader.Dispose();

            writer = JazminWriter.Continue(path, columns, new JazminWriteOptions
            {
                Grown = columns.Where((c, i) => !ReferenceEquals(c, shape.Columns[i])).Select(c => c.Name).ToHashSet(StringComparer.Ordinal),
                Key = append.Key,
                Metadata = MergeMetadata(metadata, append.Metadata),
                SortedBy = sortedBy,
                Codec = append.Codec,
                CompressionLevel = append.CompressionLevel,
                ChunkRows = append.ChunkRows,
                Access = accessOptions,
                Priority = append.Priority,
                Now = append.Now, // expired grants lose their key slots (full lock-out needs Compact/Update)
                Files = append.AddFiles,
                Package = append.Package,
                Shapes = append.AddShapes,
            }, state with { Deleted = allDeleted, Files = files, ShapeTables = shapeTables });
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
                Now = append.Now, Table = append.Table, Priority = append.Priority,
            });
            return result with { RowCount = compacted.RowCount, AppendCount = 0, DeletedRowCount = 0, Compacted = true };
        }
        return result;
    }

    /// <summary>Files an append keeps (referenced, not rewritten): every file except removed or replaced ones; and the saved shapes.</summary>
    private static FileState? AppendFiles(FileState? state, JazminAppend append)
    {
        if (state is null && append.AddFiles.Count == 0 && append.AddShapes.Count == 0)
        {
            if (append.RemoveFiles.Count > 0) throw new JazminValidationException($"RemoveFiles: no file '{append.RemoveFiles[0]}'");
            if (append.RemoveShapes.Count > 0) throw new JazminValidationException($"RemoveShapes: no saved shape '{append.RemoveShapes[0]}'");
            return null;
        }
        var entries = (state?.Entries ?? []).ToDictionary(e => e.Path, StringComparer.Ordinal);
        foreach (var p in append.RemoveFiles)
            if (!entries.Remove(p)) throw new JazminValidationException($"RemoveFiles: no file '{p}'");
        foreach (var f in append.AddFiles) entries.Remove(f.Path);
        return new FileState(entries.Values.ToList(), state?.Contents ?? [], state?.NextId ?? 0, state?.Package,
            SavedShapes.Kept(state?.Shapes ?? [], append.AddShapes, append.RemoveShapes));
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
            Path = e.Path, Type = e.Type, Groups = e.Groups ?? [EmbeddedFiles.Everyone], Actions = e.Actions, Size = contents[e.Content].Size, Sha256 = contents[e.Content].Sha256,
            Read = (offset, length) => reader.ReadFileRange(e.Path, offset, offset + length),
        }).ToList();
    }

    /// <summary>
    /// Atomically replaces <paramref name="path"/> with <paramref name="temp"/>: readers never see a half-written
    /// file. Readers that have the file open keep reading the version they opened.
    /// </summary>
    private static void ReplaceFile(string temp, string path)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temp, File.GetUnixFileMode(path)); // the new version keeps the file's permissions
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException)
        {
            // Windows refuses to replace an open file; readers allow it to be renamed, so it is replaced around them.
            if (!OperatingSystem.IsWindows()) throw;
            if (WindowsFiles.TryPosixReplace(temp, path) || WindowsFiles.TryReplaceInTwoSteps(temp, path)) return;
            throw new JazminException($"Cannot replace {path}: another program has it open and doesn't allow it to be renamed. "
                + "Close that program and retry, or use JazminFile.Append, which works while the file is open.", e);
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

    // The longest text V8 holds (Chrome, Edge, Node): a larger file can't be loaded as a script there.
    private const long MaxScriptText = 536_870_888 - 1024;

    /// <summary>
    /// The file as a script, for pages opened from disk: they can't read a file beside them, but they can load a script,
    /// and the browser reader's <c>JazminBrowser.openScript()</c> opens it. The script registers the file, as base64,
    /// under the script's own address, so a page can load several. The file inside is the file as it is (still
    /// encrypted), and the page holds all of it in memory: for small files. The JavaScript library's
    /// <c>portableScript</c> writes the same text. <paramref name="name"/> defaults to the file's name.
    /// </summary>
    public static string PortableScript(string path, string? name = null) => PortableScript(File.ReadAllBytes(path), name ?? Path.GetFileName(path));

    /// <summary>A file's bytes as a script (see the overload that takes a path).</summary>
    public static string PortableScript(byte[] file, string name = "file.jzm")
    {
        ArgumentNullException.ThrowIfNull(file);
        if (file.Length < FormatConstants.PreambleSize || !file.AsSpan(0, 4).SequenceEqual(FormatConstants.Magic))
            throw new JazminValidationException("PortableScript: not a JAZMIN file");
        var base64Length = ((long)file.Length + 2) / 3 * 4;
        if (base64Length > MaxScriptText)
            throw new JazminValidationException($"PortableScript: {name} is {Math.Round(file.Length / 1048576.0).ToString(CultureInfo.InvariantCulture)} MB, too large to load as a script in Chrome or Edge (at most about 380 MB, and best under about 20 MB): open it from a picked file instead");
        var quoted = JavaScriptString(name);
        var head = "/* A JAZMIN file as a script, for pages opened from disk: JazminBrowser.openScript() opens it. */\n"
            + "(function (scripts, script) { scripts[script ? script.src : " + quoted + "] = { name: " + quoted + ", data: \"";
        const string tail = "\" }; })(globalThis.JazminScripts = globalThis.JazminScripts || {}, typeof document === \"undefined\" ? null : document.currentScript);\n";
        // One allocation: the base64 is written straight into the script's text.
        return string.Create(head.Length + (int)base64Length + tail.Length, (head, file), static (span, s) =>
        {
            s.head.CopyTo(span);
            Convert.TryToBase64Chars(s.file, span[s.head.Length..], out var written);
            tail.CopyTo(span[(s.head.Length + written)..]);
        });
    }

    /// <summary>Text quoted as JavaScript's JSON.stringify quotes it, so both libraries write the same script.</summary>
    private static string JavaScriptString(string text)
    {
        var quoted = new StringBuilder(text.Length + 2).Append('"');
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            switch (c)
            {
                case '"': quoted.Append("\\\""); break;
                case '\\': quoted.Append("\\\\"); break;
                case '\b': quoted.Append("\\b"); break;
                case '\f': quoted.Append("\\f"); break;
                case '\n': quoted.Append("\\n"); break;
                case '\r': quoted.Append("\\r"); break;
                case '\t': quoted.Append("\\t"); break;
                default:
                    var lone = char.IsHighSurrogate(c) ? i + 1 == text.Length || !char.IsLowSurrogate(text[i + 1])
                        : char.IsLowSurrogate(c) && (i == 0 || !char.IsHighSurrogate(text[i - 1]));
                    if (c < ' ' || lone) quoted.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else quoted.Append(c);
                    break;
            }
        }
        return quoted.Append('"').ToString();
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

    private static List<JazminColumn> ColumnsWithIndexes(JazminReader reader) =>
        reader.Columns.Select(c => c.With(reader.Indexes.Where(i => i.Column == c.Name).Select(i => i.Kind).ToArray())).ToList();

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
