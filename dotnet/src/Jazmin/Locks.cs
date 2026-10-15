using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Jazmin.Format;

namespace Jazmin;

/// <summary>What opens a lock of stored files (spec 6.8.1).</summary>
public enum JazminLockKind
{
    /// <summary>A password.</summary>
    Password,

    /// <summary>An unlock token from the file owner's key service (which can ask for 2FA first).</summary>
    Online,

    /// <summary>A password and an unlock token.</summary>
    Both,
}

/// <summary>
/// A lock of stored files in a shared file (spec 6.8.1): a password, an unlock token from the owner's key service
/// (<see cref="Online"/>), or both. One lock can cover several files: one unlock opens them all. The owner key opens
/// every lock.
/// </summary>
public sealed record JazminLockOptions
{
    public string? Password { get; init; }

    /// <summary>Opened with an unlock token (<see cref="JazminFile.IssueFileUnlockToken"/>).</summary>
    public bool Online { get; init; }

    /// <summary>PBKDF2 iterations for the password (1,000 to 10,000,000).</summary>
    public int Iterations { get; init; } = FormatConstants.DefaultKdfIterations;

    /// <summary>
    /// Online locks: this lock's own key service (spec 6.8.2), an https address, over the file's
    /// <see cref="JazminPackage.KeyService"/>. Null keeps the one the lock had; "" gives it back to the file's.
    /// </summary>
    public string? KeyService { get; init; }
}

/// <summary>A lock as a reader lists it: <see cref="Unlocked"/> once <see cref="JazminReader.Unlock"/> opened it (always for the owner).</summary>
/// <param name="Id">The lock's id.</param>
/// <param name="Kind">What opens it; null when the file doesn't say (a lock lost to an older library's append).</param>
/// <param name="Unlocked">Whether this reader has opened it (always for the owner).</param>
/// <param name="KeyService">Online kinds: where the unlock token comes from (spec 6.8.2): the lock's own key service, else the file's.</param>
public sealed record JazminLockInfo(string Id, JazminLockKind? Kind, bool Unlocked, string? KeyService = null);

/// <summary>A lock: its kind, salt and iteration count as directories list it; its key and secret where known (spec 6.8.1).</summary>
internal sealed record LockState(string Id, JazminLockKind Kind, byte[] Salt, int? Iterations, byte[] Key, byte[]? Secret, string? KeyService = null);

/// <summary>A lock as a file directory lists it: its content keys sealed (content id -> sealed key, base64).</summary>
internal sealed record DirectoryLock(string Id, JazminLockKind Kind, byte[] Salt, int? Iterations, Dictionary<string, string> Keys, string? KeyService = null);

/// <summary>Locked stored files (spec 6.8.1): a content's key sealed under a lock's key, from a password and/or a secret.</summary>
internal static class Locks
{
    /// <summary>The writer feature of a file with locks (spec 6.8.1, 12).</summary>
    public const string Feature = "file-locks";

    private const int SaltSize = 16;
    private const int SecretSize = 32;
    private const string TokenPrefix = "jzf1-";

    public static string KindText(JazminLockKind kind) => kind switch
    {
        JazminLockKind.Password => "password",
        JazminLockKind.Online => "online",
        _ => "both",
    };

    public static JazminLockKind? KindFrom(string? text) => text switch
    {
        "password" => JazminLockKind.Password,
        "online" => JazminLockKind.Online,
        "both" => JazminLockKind.Both,
        _ => null,
    };

    public static bool NeedsPassword(JazminLockKind kind) => kind != JazminLockKind.Online;

    public static bool NeedsSecret(JazminLockKind kind) => kind != JazminLockKind.Password;

    /// <summary>What a lock needs to open, in words.</summary>
    public static string Needs(JazminLockKind kind)
    {
        const string token = "an unlock token from the file owner's key service";
        return kind switch
        {
            JazminLockKind.Password => "its password",
            JazminLockKind.Online => token,
            _ => $"its password and {token}",
        };
    }

    /// <summary>The lock key L from its password and/or secret S.</summary>
    public static byte[] LockKey(string id, JazminLockKind kind, byte[] salt, int? iterations, string? password, byte[]? secret)
    {
        var fromPassword = NeedsPassword(kind) ? Crypto.DeriveFromPassword(password!, salt, iterations!.Value) : null;
        if (kind == JazminLockKind.Password) return fromPassword!;
        return Crypto.Hkdf(kind == JazminLockKind.Online ? secret : [.. fromPassword!, .. secret!], salt, $"JAZMIN/1/lock/{id}");
    }

    private static byte[] SealAad(string id, int contentId) => Encoding.UTF8.GetBytes($"JAZMIN/1/lock/{id}/{contentId}");

    public static byte[] Seal(LockState lockState, int contentId, byte[] contentKey) => Crypto.Encrypt(lockState.Key, contentKey, SealAad(lockState.Id, contentId));

    /// <summary>A content's key from its sealed form; throws <see cref="JazminKeyException"/> when the lock key is wrong.</summary>
    public static byte[] Open(byte[] lockKey, string id, int contentId, byte[] sealedKey) => Crypto.Decrypt(lockKey, sealedKey, SealAad(id, contentId));

    public static string EncodeToken(byte[] secret) => TokenPrefix + Base64Url.Encode([.. secret, .. SHA256.HashData(secret)[..4]]);

    public static byte[] ParseToken(string text)
    {
        if (text is null || !text.StartsWith(TokenPrefix, StringComparison.Ordinal)) throw new JazminKeyException($"A file unlock token starts with '{TokenPrefix}'");
        byte[] raw;
        try
        {
            raw = Base64Url.Decode(text[TokenPrefix.Length..]);
        }
        catch (FormatException)
        {
            throw new JazminKeyException("Unlock token is not valid base64url");
        }
        if (raw.Length != SecretSize + 4) throw new JazminKeyException("Unlock token has the wrong length");
        if (!SHA256.HashData(raw.AsSpan(0, SecretSize))[..4].AsSpan().SequenceEqual(raw.AsSpan(SecretSize)))
            throw new JazminKeyException("Unlock token checksum mismatch - the token is mistyped or corrupted");
        return raw[..SecretSize];
    }

    public static void CheckId(string id)
    {
        if (id is null || id.Length is < 1 or > 64) throw new JazminValidationException("A lock id is 1 to 64 characters");
    }

    /// <summary>Checks a lock's iteration count as read from a file: outside the limits it would take too long, or be too weak.</summary>
    public static void CheckIterations(string id, JazminLockKind kind, int? iterations)
    {
        if (NeedsPassword(kind) && iterations is not (>= FormatConstants.MinKdfIterations and <= FormatConstants.MaxKdfIterations))
            throw new JazminFormatException($"Lock '{id}' has an iteration count outside {FormatConstants.MinKdfIterations} to {FormatConstants.MaxKdfIterations}");
    }

    /// <summary>
    /// The writer's locks: those the file keeps, changed by those given (null removes one: its files stay, unlocked). A
    /// changed lock gets a new salt and key; an online one keeps its secret, so issued tokens still work.
    /// </summary>
    public static (Dictionary<string, LockState> Locks, HashSet<string> Removed) ForWriter(IReadOnlyDictionary<string, JazminLockOptions?>? given, IEnumerable<LockState>? kept)
    {
        var locks = (kept ?? []).ToDictionary(l => l.Id, StringComparer.Ordinal);
        var removed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (id, options) in given ?? new Dictionary<string, JazminLockOptions?>())
        {
            CheckId(id);
            if (options is null)
            {
                if (!locks.Remove(id)) throw new JazminValidationException($"Locks: no lock '{id}' to remove");
                removed.Add(id);
                continue;
            }
            var where = $"Lock '{id}'";
            if (options.Password is { Length: 0 }) throw new JazminValidationException($"{where}: the password must be a non-empty string");
            if (options.Password is null && !options.Online) throw new JazminValidationException($"{where}: give a Password, Online = true, or both");
            if (options.Password is not null && options.Iterations is < FormatConstants.MinKdfIterations or > FormatConstants.MaxKdfIterations)
                throw new JazminValidationException($"{where}: Iterations must be from {FormatConstants.MinKdfIterations} to {FormatConstants.MaxKdfIterations}");
            if (options.KeyService is { Length: > 0 } && !options.Online) throw new JazminValidationException($"{where}: KeyService is for online locks (Online = true)");
            var kind = options.Password is not null && options.Online ? JazminLockKind.Both : options.Online ? JazminLockKind.Online : JazminLockKind.Password;
            // Its own key service (spec 6.8.2): as given ("": none, the file's), else the one it had.
            var service = !NeedsSecret(kind) || options.KeyService is "" ? null
                : options.KeyService is { } address ? EmbeddedFiles.CheckKeyService(address, $"{where}: KeyService") : locks.GetValueOrDefault(id)?.KeyService;
            var secret = NeedsSecret(kind) ? locks.GetValueOrDefault(id)?.Secret ?? RandomNumberGenerator.GetBytes(SecretSize) : null;
            var salt = RandomNumberGenerator.GetBytes(SaltSize);
            int? iterations = NeedsPassword(kind) ? options.Iterations : null;
            locks[id] = new LockState(id, kind, salt, iterations, LockKey(id, kind, salt, iterations, options.Password, secret), secret, service);
            removed.Remove(id);
        }
        return (locks, removed);
    }

    /// <summary>Locks as the owner directory keeps them, sorted by id.</summary>
    public static JsonArray OwnerList(IEnumerable<LockState> locks) => new(locks.OrderBy(l => l.Id, StringComparer.Ordinal).Select(l =>
    {
        var json = new JsonObject { ["id"] = l.Id, ["kind"] = KindText(l.Kind), ["salt"] = Convert.ToBase64String(l.Salt) };
        if (l.Iterations is { } iterations) json["iterations"] = iterations;
        json["key"] = Convert.ToBase64String(l.Key);
        if (l.Secret is not null) json["secret"] = Convert.ToBase64String(l.Secret);
        if (l.KeyService is not null) json["keyService"] = l.KeyService;
        return (JsonNode?)json;
    }).ToArray());

    /// <summary>A lock as a file directory lists it, with its contents' keys sealed.</summary>
    public static JsonObject DirectoryEntry(LockState l, JsonObject keys)
    {
        var json = new JsonObject { ["id"] = l.Id, ["kind"] = KindText(l.Kind), ["salt"] = Convert.ToBase64String(l.Salt) };
        if (l.Iterations is { } iterations) json["iterations"] = iterations;
        json["keys"] = keys;
        if (l.KeyService is not null) json["keyService"] = l.KeyService;
        return json;
    }

    /// <summary>The owner directory's locks, read.</summary>
    public static Dictionary<string, LockState> ReadOwner(JsonNode? list)
    {
        var locks = new Dictionary<string, LockState>(StringComparer.Ordinal);
        if (list is null) return locks;
        static void Ok(bool test)
        {
            if (!test) throw new JazminFormatException("The owner directory's locks are malformed");
        }
        Ok(list is JsonArray);
        foreach (var node in list.AsArray())
        {
            Ok(node is JsonObject o && o["id"] is JsonValue && o["salt"] is JsonValue && o["key"] is JsonValue);
            var kind = KindFrom((string?)node!["kind"]);
            Ok(kind is not null && (!NeedsSecret(kind.Value) || node["secret"] is JsonValue));
            try
            {
                var key = Convert.FromBase64String((string)node["key"]!);
                Ok(key.Length == 32);
                var id = (string)node["id"]!;
                locks[id] = new LockState(id, kind!.Value, Convert.FromBase64String((string)node["salt"]!), (int?)node["iterations"], key,
                    NeedsSecret(kind.Value) ? Convert.FromBase64String((string)node["secret"]!) : null,
                    EmbeddedFiles.KeyServiceAddress(node["keyService"]));
            }
            catch (Exception e) when (e is FormatException or InvalidOperationException)
            {
                throw new JazminFormatException("The owner directory's locks are malformed", e);
            }
        }
        return locks;
    }
}
