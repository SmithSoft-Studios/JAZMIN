using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Jazmin.Format;

/// <summary>Validated access options for a writer (spec section 7.6).</summary>
internal sealed partial class AccessConfig
{
    [GeneratedRegex("^[A-Za-z0-9_.-]{1,64}$")]
    private static partial Regex GroupName();

    public string? PartitionBy { get; private init; }
    public int PartitionCol { get; private init; } = -1;
    public List<(string Name, int[] Cols)> ColumnGroups { get; } = new();
    public List<NormalizedGrant> Grants { get; } = new();

    /// <summary>Grants left out because they had already expired.</summary>
    public int ExpiredGrants { get; private set; }

    /// <summary>A grant with its expiry resolved to an absolute time and, for online grants, its share.</summary>
    public sealed record NormalizedGrant(
        JazminAccessKey Key, IReadOnlyList<string>? Rows, IReadOnlyList<string>? Columns, string? Label,
        DateTimeOffset? Expires, JazminGrantMode Mode, byte[]? Share, IReadOnlyList<string>? Files = null);

    /// <summary>One table's partition column and column groups (spec 7.6.2).</summary>
    public static AccessConfig NormalizeTable(string? partitionBy, Dictionary<string, string[]> columnGroups, IReadOnlyList<JazminColumn> columns)
    {
        var partitionCol = -1;
        if (partitionBy is not null)
        {
            partitionCol = columns.ToList().FindIndex(c => c.Name == partitionBy);
            if (partitionCol < 0) throw new JazminValidationException($"PartitionBy: unknown column '{partitionBy}'");
            if (columns[partitionCol].Type is not (JazminType.String or JazminType.Int))
                throw new JazminValidationException("PartitionBy must be a string or int column");
        }
        var config = new AccessConfig { PartitionBy = partitionBy, PartitionCol = partitionCol };

        var assigned = new HashSet<int>();
        var named = new List<(string, int[])>();
        foreach (var (name, members) in columnGroups)
        {
            if (name == FormatConstants.DefaultColumnGroup || !GroupName().IsMatch(name))
                throw new JazminValidationException($"Invalid column group name '{name}'");
            if (members.Length == 0) throw new JazminValidationException($"Column group '{name}' needs at least one column");
            var cols = members.Select(m =>
            {
                var i = columns.ToList().FindIndex(c => c.Name == m);
                if (i < 0) throw new JazminValidationException($"Column group '{name}': unknown column '{m}'");
                if (!assigned.Add(i)) throw new JazminValidationException($"Column '{m}' is in two column groups");
                return i;
            }).Order().ToArray();
            named.Add((name, cols));
        }
        if (partitionCol >= 0 && assigned.Contains(partitionCol))
            throw new JazminValidationException($"The partition column '{partitionBy}' must stay in the default column group");
        var rest = Enumerable.Range(0, columns.Count).Where(i => !assigned.Contains(i)).ToArray();
        if (rest.Length > 0) config.ColumnGroups.Add((FormatConstants.DefaultColumnGroup, rest));
        config.ColumnGroups.AddRange(named);
        return config;
    }

    /// <summary>
    /// The file's grants. <paramref name="groupNames"/> are the column groups a grant may name (those of every table);
    /// grants that have already expired at <paramref name="now"/> are left out and counted.
    /// </summary>
    public static AccessConfig NormalizeGrants(IEnumerable<JazminGrant> grants, IReadOnlyCollection<string> groupNames, DateTimeOffset now)
    {
        var config = new AccessConfig();
        var seen = new HashSet<string>();
        foreach (var grant in grants)
        {
            if (grant.Columns is not null)
                foreach (var c in grant.Columns)
                    if (!groupNames.Contains(c)) throw new JazminValidationException($"Grant: unknown column group '{c}'");
            // A key's text in its standard form is as unique as its id, and needs no hashing when the key was parsed from it.
            if (!seen.Add(grant.Key.Export())) throw new JazminValidationException($"The same access key is granted twice ({grant.Key.Id})");
            var expires = grant.Expires ?? (grant.ExpiresIn is { } span ? now + span : null);
            if (expires is { } end && end <= now)
            {
                config.ExpiredGrants++;
                continue;
            }
            // An online grant's share is held by the owner's key service; it stays the same across versions.
            var share = grant.Mode == JazminGrantMode.Online ? grant.Share ?? RandomNumberGenerator.GetBytes(32) : null;
            config.Grants.Add(new NormalizedGrant(grant.Key, grant.Rows, grant.Columns, grant.Label, expires, grant.Mode, share, grant.Files));
        }
        return config;
    }
}

/// <summary>
/// Secrets of one version of a file (every rewrite generates new ones; spec 7.6.3). Only Header and Owner are
/// random; partition and column-group secrets are derived from Owner, so the owner's key slot stays tiny however
/// many partitions there are. Access keys receive only their groups' derived secrets.
/// </summary>
internal sealed class FileSecrets
{
    private readonly byte[] _salt;
    private readonly Dictionary<string, byte[]> _columnSecrets = new(StringComparer.Ordinal);

    public FileSecrets(byte[] salt, byte[]? header = null, byte[]? owner = null)
    {
        _salt = salt;
        Header = header ?? RandomNumberGenerator.GetBytes(32);
        Owner = owner ?? RandomNumberGenerator.GetBytes(32);
        IdKey = Crypto.Hkdf(Owner, salt, "JAZMIN/1/partition-id");
    }

    public byte[] Header { get; }
    public byte[] Owner { get; }
    public byte[] IdKey { get; }

    private readonly List<string> _names = new();
    private readonly HashSet<string> _known = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _ids = new(StringComparer.Ordinal); // name -> id, worked out once
    private Dictionary<string, string>? _byId; // id -> name of every recorded partition, made when first needed

    /// <summary>Names of the partitions present in the file, in the order they were recorded.</summary>
    public IReadOnlyList<string> Names => _names;

    /// <summary>Partition id -> name, for partitions present in the file (in order of first appearance).</summary>
    public Dictionary<string, string> PartitionNames => _byId ??= _names.ToDictionary(PartitionId, n => n, StringComparer.Ordinal);

    /// <summary>Opaque, owner-keyed id (base64url of 12 bytes) of a partition or file-group name: an HMAC, worked out once.</summary>
    public string PartitionId(string name)
    {
        if (!_ids.TryGetValue(name, out var id)) _ids[name] = id = AccessCrypto.GroupId(IdKey, name);
        return id;
    }

    /// <summary>Records partitions already in the file. Their ids are worked out only when needed: an append rarely needs them all.</summary>
    public void RecordPartitions(IEnumerable<string> names)
    {
        foreach (var name in names) Record(name);
    }

    /// <summary>Records a partition name and returns its id.</summary>
    public string AddPartition(string name)
    {
        Record(name);
        return PartitionId(name);
    }

    private void Record(string name)
    {
        if (!_known.Add(name)) return;
        _names.Add(name);
        _byId?.TryAdd(PartitionId(name), name);
    }

    private readonly Dictionary<string, byte[]> _partitionSecrets = new(StringComparer.Ordinal); // derived once per partition

    public byte[] PartitionSecret(string id)
    {
        if (!_partitionSecrets.TryGetValue(id, out var secret)) _partitionSecrets[id] = secret = Crypto.Hkdf(Owner, _salt, $"JAZMIN/1/partition/{id}");
        return secret;
    }

    /// <summary>Secret of a file group (embedded files, spec 6.8): opens that group's file directory.</summary>
    public byte[] FileGroupSecret(string id) => Crypto.Hkdf(Owner, _salt, $"JAZMIN/1/file-group/{id}");

    public byte[] ColumnSecret(string name)
    {
        if (!_columnSecrets.TryGetValue(name, out var secret))
            _columnSecrets[name] = secret = Crypto.Hkdf(Owner, _salt, $"JAZMIN/1/column-group/{name}");
        return secret;
    }
}

/// <summary>Parsed key-slot page (binary; slots found by binary search).</summary>
internal sealed record KeySlots(ArraySegment<byte> Raw, int Count, int TableAt, int BlobsAt, int SignedLength);

internal static class AccessCrypto
{
    public const int PublicKeySize = FormatConstants.PublicKeySize;
    private const int SlotIdSize = 8;
    private const int SlotEntrySize = SlotIdSize + 8; // id | offset u32 | length u32
    private const uint OnlineSlot = 0x80000000; // high bit of a slot's length: opening it also needs an unlock token
    private static readonly byte[] SignatureLabel = "JAZMIN/1/signature"u8.ToArray();

    /// <summary>Name of the partition a value belongs to (null -> "").</summary>
    public static string PartitionName(object? value) => value switch
    {
        null => "",
        long l => l.ToString(CultureInfo.InvariantCulture),
        string s => s,
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "",
    };

    public static string GroupId(byte[] idKey, string name) =>
        Base64Url.Encode(HMACSHA256.HashData(idKey, Encoding.UTF8.GetBytes(name))[..12]);

    public static byte[] HeaderKey(byte[] headerSecret, byte[] salt) => Crypto.Hkdf(headerSecret, salt, "JAZMIN/1/header");

    public static byte[] OwnerDirectoryKey(byte[] ownerSecret, byte[] salt) => Crypto.Hkdf(ownerSecret, salt, "JAZMIN/1/owner");

    /// <summary>Key of a section derived from one secret: HKDF(secret, salt, "JAZMIN/1/" + section id) (spec 7.6.3).</summary>
    public static byte[] SectionKey(byte[] secret, byte[] salt, string sectionId) => Crypto.Hkdf(secret, salt, $"JAZMIN/1/{sectionId}");

    /// <summary>Chunk parts and statistics: locked by both the partition's and the column group's secrets.</summary>
    public static byte[] PartKey(byte[] partitionSecret, byte[] columnSecret, byte[] salt, string sectionId) =>
        Crypto.Hkdf([.. partitionSecret, .. columnSecret], salt, $"JAZMIN/1/{sectionId}");

    /// <summary>SHA-256 of a whole section (spec 7.6.5).</summary>
    public static byte[] Digest(ReadOnlySpan<byte> section) => SHA256.HashData(section);

    /// <summary>Digest as base64 text (embedded-file directories are JSON).</summary>
    public static string DigestText(ReadOnlySpan<byte> section) => Convert.ToBase64String(SHA256.HashData(section));

    private static byte[] SlotAad(byte[] fileId, ReadOnlySpan<byte> id) => [.. fileId, .. id];

    /// <summary>Key that seals a slot: from the key's secret, plus the server-held share for online grants.</summary>
    private static byte[] SlotKek(ReadOnlySpan<byte> secret, byte[]? share, byte[] salt) =>
        share is null ? Crypto.Hkdf(secret, salt, "JAZMIN/1/slot") : Crypto.Hkdf([.. secret, .. share], salt, "JAZMIN/1/slot");

    /// <summary>Seals a bundle for the holder of <paramref name="secret"/> (and, for online grants, of <paramref name="share"/>).</summary>
    public static (byte[] Id, byte[] Sealed, bool Online) SealSlot(ReadOnlySpan<byte> secret, byte[] salt, byte[] fileId, JsonObject bundle, byte[]? share = null)
    {
        var id = OwnerSigning.SlotId(secret);
        return (id, Crypto.Encrypt(SlotKek(secret, share, salt), Encoding.UTF8.GetBytes(bundle.ToJsonString()), SlotAad(fileId, id)), share is not null);
    }

    /// <summary>
    /// The bundle sealed for this secret, or null when the file has no slot for it. An online slot also
    /// needs <paramref name="share"/> (from an unlock token); without it JazminUnlockRequiredException is thrown.
    /// </summary>
    public static JsonObject? UnsealSlot(KeySlots keySlots, ReadOnlySpan<byte> secret, byte[] salt, byte[] fileId, byte[]? share = null)
    {
        var id = OwnerSigning.SlotId(secret);
        int lo = 0, hi = keySlots.Count - 1;
        while (lo <= hi)
        {
            var mid = (lo + hi) >>> 1;
            var at = keySlots.TableAt + mid * SlotEntrySize;
            var c = keySlots.Raw.AsSpan(at, SlotIdSize).SequenceCompareTo(id);
            if (c == 0)
            {
                var start = (long)keySlots.BlobsAt + BinaryPrimitives.ReadUInt32LittleEndian(keySlots.Raw.AsSpan(at + SlotIdSize, 4));
                var rawLength = BinaryPrimitives.ReadUInt32LittleEndian(keySlots.Raw.AsSpan(at + SlotIdSize + 4, 4));
                var online = (rawLength & OnlineSlot) != 0;
                var length = rawLength & ~OnlineSlot;
                if (start + length > keySlots.SignedLength) throw new JazminFormatException("Key slot points outside its page");
                if (online && share is null)
                {
                    throw new JazminUnlockRequiredException("This key needs an unlock token from the file owner's key service",
                        Convert.ToHexString(fileId).ToLowerInvariant(), Convert.ToHexString(id).ToLowerInvariant());
                }
                try
                {
                    var plain = Crypto.Decrypt(SlotKek(secret, online ? share : null, salt), keySlots.Raw.AsSpan((int)start, (int)length), SlotAad(fileId, id));
                    return Values.ParseJson(Encoding.UTF8.GetString(plain), "A key slot", uniqueNames: true) as JsonObject
                        ?? throw new JazminFormatException("A key slot is not a JSON object");
                }
                catch (JazminKeyException) when (online)
                {
                    throw new JazminKeyException("The unlock token is not valid for this key and file");
                }
            }
            if (c < 0) lo = mid + 1;
            else hi = mid - 1;
        }
        return null;
    }

    /// <summary>What the owner signs: the key-slot list section (which holds each page's digest) and the header section.</summary>
    private static byte[] SignatureMessage(byte[] fileId, ReadOnlySpan<byte> keySlotsSection, ReadOnlySpan<byte> headerSection) =>
        [.. SignatureLabel, .. fileId, .. SHA256.HashData(keySlotsSection), .. SHA256.HashData(headerSection)];

    /// <summary>Target raw size of a key-slot page (spec 7.6.4): a key holder reads the page list and one page.</summary>
    public const int KeySlotPageBytes = 16 * 1024;
    private const int PageEntrySize = SlotIdSize + 8 + 4 + 32; // first slot id | offset u64 | length u32 | SHA-256 of the page section

    /// <summary>
    /// The key slots in pages of about <paramref name="pageBytes"/> raw bytes, sorted by slot id (spec 7.6.4). Each page:
    /// u32 count | count x (id(8) | offset u32 | length u32), sorted by id | sealed bundles.
    /// </summary>
    public static List<(byte[] FirstId, byte[] Raw)> BuildKeySlotPages(List<(byte[] Id, byte[] Sealed, bool Online)> slots, int pageBytes = KeySlotPageBytes)
    {
        var sorted = slots.OrderBy(s => s.Id, Comparer<byte[]>.Create((a, b) => a.AsSpan().SequenceCompareTo(b))).ToList();
        for (var i = 1; i < sorted.Count; i++)
            if (sorted[i].Id.AsSpan().SequenceEqual(sorted[i - 1].Id)) throw new JazminValidationException("Two keys share a slot id");
        var pages = new List<(byte[], byte[])>();
        var page = new List<(byte[] Id, byte[] Sealed, bool Online)>();
        var size = 4;
        foreach (var slot in sorted)
        {
            var bytes = SlotEntrySize + slot.Sealed.Length;
            if (page.Count > 0 && size + bytes > pageBytes)
            {
                pages.Add((page[0].Id, KeySlotPage(page)));
                page = new();
                size = 4;
            }
            page.Add(slot);
            size += bytes;
        }
        if (page.Count > 0) pages.Add((page[0].Id, KeySlotPage(page)));
        return pages;
    }

    private static byte[] KeySlotPage(List<(byte[] Id, byte[] Sealed, bool Online)> sorted)
    {
        var raw = new byte[4 + sorted.Count * SlotEntrySize + sorted.Sum(s => s.Sealed.Length)];
        BinaryPrimitives.WriteUInt32LittleEndian(raw, (uint)sorted.Count);
        const int tableAt = 4;
        var blobAt = tableAt + sorted.Count * SlotEntrySize;
        var offset = 0;
        for (var i = 0; i < sorted.Count; i++)
        {
            var at = tableAt + i * SlotEntrySize;
            sorted[i].Id.CopyTo(raw, at);
            BinaryPrimitives.WriteUInt32LittleEndian(raw.AsSpan(at + SlotIdSize), (uint)offset);
            BinaryPrimitives.WriteUInt32LittleEndian(raw.AsSpan(at + SlotIdSize + 4), (uint)sorted[i].Sealed.Length | (sorted[i].Online ? OnlineSlot : 0));
            sorted[i].Sealed.CopyTo(raw, blobAt + offset);
            offset += sorted[i].Sealed.Length;
        }
        return raw;
    }

    /// <summary>
    /// The page list (section <c>keyslots</c>, the one the owner signs): u32 count | count x (first slot id(8) | offset u64 |
    /// length u32 | SHA-256(page section)(32)), sorted by first slot id.
    /// </summary>
    public static byte[] BuildKeySlotList(IReadOnlyList<(byte[] FirstId, long Offset, int Length, byte[] Digest)> pages)
    {
        var list = new byte[4 + pages.Count * PageEntrySize];
        BinaryPrimitives.WriteUInt32LittleEndian(list, (uint)pages.Count);
        for (var i = 0; i < pages.Count; i++)
        {
            var at = 4 + i * PageEntrySize;
            pages[i].FirstId.CopyTo(list, at);
            BinaryPrimitives.WriteUInt64LittleEndian(list.AsSpan(at + SlotIdSize), (ulong)pages[i].Offset);
            BinaryPrimitives.WriteUInt32LittleEndian(list.AsSpan(at + SlotIdSize + 8), (uint)pages[i].Length);
            pages[i].Digest.CopyTo(list, at + SlotIdSize + 12);
        }
        return list;
    }

    /// <summary>The page of a key-slot list that can hold slot <paramref name="id"/> (the last page whose first id is &lt;= id), or null.</summary>
    public static (int Index, long Offset, int Length, byte[] Digest)? FindKeySlotPage(ReadOnlySpan<byte> list, ReadOnlySpan<byte> id)
    {
        if (list.Length < 4) throw new JazminFormatException("Key-slot list is truncated");
        var count = BinaryPrimitives.ReadUInt32LittleEndian(list);
        if (list.Length != 4 + (long)count * PageEntrySize) throw new JazminFormatException("Key-slot list has the wrong length");
        int lo = 0, hi = (int)count;
        while (lo < hi)
        {
            var mid = (lo + hi) >>> 1;
            if (list.Slice(4 + mid * PageEntrySize, SlotIdSize).SequenceCompareTo(id) <= 0) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) return null; // below the first page: no slot
        var at = 4 + (lo - 1) * PageEntrySize;
        var offset = BinaryPrimitives.ReadUInt64LittleEndian(list[(at + SlotIdSize)..]);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(list[(at + SlotIdSize + 8)..]);
        if (offset > long.MaxValue || length > int.MaxValue) throw new JazminFormatException("Key-slot page is out of range");
        return (lo - 1, (long)offset, (int)length, list.Slice(at + SlotIdSize + 12, 32).ToArray());
    }

    /// <summary>Parses a key-slot page (see <see cref="BuildKeySlotPages"/>).</summary>
    public static KeySlots ParseKeySlots(ArraySegment<byte> raw)
    {
        if (raw.Count < 4) throw new JazminFormatException("Key-slot page is truncated");
        var count = BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(0, 4));
        const int tableAt = 4;
        var blobsAt = tableAt + (long)count * SlotEntrySize;
        if (blobsAt > raw.Count) throw new JazminFormatException("Key-slot page is truncated");
        return new KeySlots(raw, (int)count, tableAt, (int)blobsAt, raw.Count);
    }

    /// <summary>Signature section payload (spec 7.6.4): owner public key (65) | ECDSA P-256 signature (64, r||s).</summary>
    public static byte[] BuildSignature(ReadOnlySpan<byte> ownerKey, byte[] fileId, ReadOnlySpan<byte> keySlotsSection, ReadOnlySpan<byte> headerSection) =>
        [.. OwnerSigning.Derive(ownerKey).PublicKey, .. OwnerSigning.Sign(ownerKey, SignatureMessage(fileId, keySlotsSection, headerSection))];

    /// <summary>
    /// Checks the key slots and header were signed by the owner who issued the key (spec 7.6.6):
    /// an owner key must match the signing public key; an access key must match its fingerprint.
    /// </summary>
    public static void VerifyOwner(byte[] signature, byte[] fileId, ReadOnlySpan<byte> keySlotsSection, ReadOnlySpan<byte> headerSection,
        JazminKey? ownerKey, JazminAccessKey? accessKey)
    {
        if (signature.Length != PublicKeySize + FormatConstants.SignatureSize) throw new JazminFormatException("Signature section has the wrong length");
        var owner = signature[..PublicKeySize];
        var expected = accessKey is not null
            ? OwnerSigning.Fingerprint(owner).AsSpan().SequenceEqual(accessKey.OwnerFingerprint)
            : owner.AsSpan().SequenceEqual(OwnerSigning.Derive(ownerKey!.Bytes).PublicKey);
        if (!expected) throw new JazminKeyException("This file was not signed by the owner of this key");
        if (!OwnerSigning.Verify(owner, SignatureMessage(fileId, keySlotsSection, headerSection), signature[PublicKeySize..]))
            throw new JazminFormatException("The file's owner signature is invalid - the file was modified");
    }
}

/// <summary>Text form of an online grant's share: "jzu1-" + base64url(share(32) || SHA-256(share)[0..3]).</summary>
internal static class UnlockTokens
{
    private const string Prefix = "jzu1-";

    public static string Encode(byte[] share) => Prefix + Base64Url.Encode([.. share, .. SHA256.HashData(share)[..4]]);

    public static byte[] Parse(string text)
    {
        if (text is null || !text.StartsWith(Prefix, StringComparison.Ordinal)) throw new JazminKeyException($"Unlock token must start with '{Prefix}'");
        byte[] raw;
        try
        {
            raw = Base64Url.Decode(text[Prefix.Length..]);
        }
        catch (FormatException)
        {
            throw new JazminKeyException("Unlock token is not valid base64url");
        }
        if (raw.Length != 36) throw new JazminKeyException("Unlock token has the wrong length");
        if (!SHA256.HashData(raw.AsSpan(0, 32))[..4].AsSpan().SequenceEqual(raw.AsSpan(32)))
            throw new JazminKeyException("Unlock token checksum mismatch - the token is mistyped or corrupted");
        return raw[..32];
    }
}

/// <summary>
/// Enforces an expiring grant when a file is opened: not after expiry; the clock not earlier than when
/// the (signed) file was written; and not earlier than this key's last access on this machine. The
/// last-seen record is per user (not in the file, which could be swapped for an older copy) and is
/// HMAC-protected with the access key. Record format is identical to the JavaScript library's.
/// </summary>
internal static class ExpiryCheck
{
    public static readonly TimeSpan Tolerance = TimeSpan.FromMinutes(5);

    public static void Enforce(DateTimeOffset expires, DateTimeOffset writtenAt, DateTimeOffset now, byte[] fileId, string keyId,
        ReadOnlySpan<byte> secret, IJazminAccessStateStore? store)
    {
        static string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        if (now > expires) throw new JazminAccessExpiredException($"Access for this key expired at {Iso(expires)}");
        if (now < writtenAt - Tolerance)
            throw new JazminAccessExpiredException($"The system clock ({Iso(now)}) is earlier than when this file was written ({Iso(writtenAt)}) - check the clock");
        if (store is null) return;

        var name = $"{Convert.ToHexString(fileId).ToLowerInvariant()}.{keyId}.json";
        var macKey = Crypto.Hkdf(secret, fileId, "JAZMIN/1/last-seen");
        string Mac(long t) => Convert.ToHexString(HMACSHA256.HashData(macKey, Encoding.UTF8.GetBytes(t.ToString(CultureInfo.InvariantCulture)))).ToLowerInvariant();
        var nowMs = now.ToUnixTimeMilliseconds();
        long lastSeen = 0;
        if (store.Read(name) is { } text)
        {
            long? recorded = null;
            string? mac = null;
            try
            {
                var record = JsonNode.Parse(text);
                recorded = (long?)record?["lastSeen"];
                mac = (string?)record?["mac"];
            }
            catch (Exception e) when (e is System.Text.Json.JsonException or InvalidOperationException or FormatException)
            {
            }
            if (recorded is null || mac != Mac(recorded.Value))
                throw new JazminAccessExpiredException("The access record for this file was modified - access refused");
            lastSeen = recorded.Value;
        }
        if (nowMs < lastSeen - (long)Tolerance.TotalMilliseconds)
        {
            throw new JazminAccessExpiredException($"Clock rollback detected: the system clock ({Iso(now)}) is earlier than this key's last access "
                + $"({Iso(DateTimeOffset.FromUnixTimeMilliseconds(lastSeen))})");
        }
        if (nowMs > lastSeen) store.Write(name, new JsonObject { ["lastSeen"] = nowMs, ["mac"] = Mac(nowMs) }.ToJsonString());
    }
}
