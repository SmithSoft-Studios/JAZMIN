using System.Collections.Concurrent;
using TotpAuthSharp;
using TotpAuthSharp.Interface;

namespace Jazmin.KeyService;

/// <summary>What the service stores per user. Replace the in-memory store with your database.</summary>
public sealed class UserRecord
{
    public required string UserId { get; init; }

    /// <summary>The user's TOTP secret (Base32). Treat it like a password: encrypt it at rest, never log it.</summary>
    public string? TotpSecret { get; set; }

    public bool TotpConfirmed { get; set; }

    /// <summary>Time step of the last accepted code; codes from that step or earlier are rejected (replay protection).</summary>
    public long LastTimeStep { get; set; } = -1;

    /// <summary>Ids of the JAZMIN access keys issued to this user (<see cref="JazminAccessKey.Id"/>).</summary>
    public HashSet<string> AccessKeyIds { get; } = new(StringComparer.Ordinal);

    /// <summary>Wrong codes since the last accepted one; every <see cref="KeyService.MaxFailedAttempts"/> lock the user out for longer.</summary>
    public int FailedAttempts { get; set; }

    public DateTimeOffset? LockedUntil { get; set; }
}

public interface IUserStore
{
    UserRecord? Find(string userId);

    void Save(UserRecord user);
}

/// <summary>Demo store. Production code should use a database and encrypt <see cref="UserRecord.TotpSecret"/>.</summary>
public sealed class InMemoryUserStore : IUserStore
{
    private readonly Dictionary<string, UserRecord> _users = new(StringComparer.Ordinal);

    public UserRecord? Find(string userId)
    {
        lock (_users) return _users.GetValueOrDefault(userId);
    }

    public void Save(UserRecord user)
    {
        lock (_users) _users[user.UserId] = user;
    }
}

/// <summary>Finds a .jzm file by its file id (readable without a key, see <see cref="JazminFile.Inspect"/>).</summary>
public interface IFileCatalog
{
    string? FindPath(string fileId);
}

/// <summary>Looks files up in one folder, reading each file's id from its preamble (no key needed).</summary>
public sealed class DirectoryFileCatalog(string directory) : IFileCatalog
{
    public string? FindPath(string fileId) =>
        Directory.EnumerateFiles(directory, "*.jzm").FirstOrDefault(path => FileIdOf(path) == fileId);

    private static string? FileIdOf(string path)
    {
        try
        {
            return JazminFile.Inspect(path).FileId;
        }
        catch (Exception e) when (e is JazminException or IOException)
        {
            return null; // a damaged or unreadable file must not stop the others being found
        }
    }
}

public enum UnlockStatus
{
    Issued,
    NotEnrolled,
    InvalidCode,
    LockedOut,
    KeyNotOwnedByUser,
    FileNotFound,
    Expired,
    NotOnlineGrant,
}

public sealed record UnlockResult(UnlockStatus Status, string? Token = null, DateTimeOffset? RetryAfter = null);

public sealed record EnrolmentResult(string QrCodeImage, string ManualSetupKey);

/// <summary>
/// Issues JAZMIN unlock tokens for online grants, gated by a second factor: a code from the user's
/// authenticator app, checked with TotpAuthSharp. A token is issued only when the user has confirmed
/// 2FA, the code is valid and has not been used before, the access key belongs to the user, and the
/// grant has not expired. Repeated wrong codes lock the user out, for longer each time, because a
/// 6-digit code could otherwise be guessed.
/// </summary>
public sealed class KeyService(IUserStore users, IFileCatalog files, JazminKey ownerKey, TimeProvider clock, ITotpSetupGenerator setupGenerator)
{
    public const int MaxFailedAttempts = 5;

    /// <summary>The first lockout; each later one is twice as long, up to <see cref="MaxLockoutPeriod"/>.</summary>
    public static readonly TimeSpan LockoutPeriod = TimeSpan.FromMinutes(5);

    public static readonly TimeSpan MaxLockoutPeriod = TimeSpan.FromHours(24);

    /// <summary>Codes are accepted from the current 30-second step and the one either side, for clock drift.</summary>
    private const int ToleranceSeconds = 30;

    private readonly TotpValidator _validator = new(new TotpGenerator(clock));

    // Checking a code and recording the result happen under the user's lock, so parallel requests cannot reuse a
    // code or get past the lockout. With several service instances, make the store's update atomic instead.
    private readonly ConcurrentDictionary<string, object> _userLocks = new(StringComparer.Ordinal);

    private object LockFor(string userId) => _userLocks.GetOrAdd(userId, _ => new object());

    /// <summary>Owner/admin: records that an access key was issued to a user.</summary>
    public void RegisterAccessKey(string userId, string keyId)
    {
        var user = users.Find(userId) ?? new UserRecord { UserId = userId };
        user.AccessKeyIds.Add(keyId);
        users.Save(user);
    }

    /// <summary>
    /// Starts (or, before it is confirmed, restarts) authenticator enrolment: returns the QR code and the manual setup key.
    /// Returns null once 2FA is confirmed: otherwise anyone past the first factor could replace the user's authenticator.
    /// To move to a new device, an administrator calls <see cref="ResetEnrolment"/> after checking who is asking.
    /// </summary>
    public EnrolmentResult? BeginEnrolment(string userId, string issuer)
    {
        lock (LockFor(userId))
        {
            var user = users.Find(userId) ?? new UserRecord { UserId = userId };
            if (user.TotpConfirmed) return null;
            user.TotpSecret = TotpSecret.Generate();
            user.LastTimeStep = -1;
            users.Save(user);
            var setup = setupGenerator.Generate(issuer, userId, user.TotpSecret);
            return new EnrolmentResult(setup.QrCodeImage, setup.ManualSetupKey);
        }
    }

    /// <summary>Owner/admin: removes a user's authenticator so they can enrol a new one (for example after losing a phone).</summary>
    public void ResetEnrolment(string userId)
    {
        lock (LockFor(userId))
        {
            if (users.Find(userId) is not { } user) return;
            user.TotpSecret = null;
            user.TotpConfirmed = false;
            user.LastTimeStep = -1;
            users.Save(user);
        }
    }

    /// <summary>Turns 2FA on once the user proves their authenticator app produces valid codes.</summary>
    public bool ConfirmEnrolment(string userId, string code)
    {
        lock (LockFor(userId))
        {
            var user = users.Find(userId);
            if (user?.TotpSecret is null || user.TotpConfirmed) return false;
            if (user.LockedUntil is { } until && until > clock.GetUtcNow()) return false;
            if (!TryAcceptCode(user, code)) return false;
            user.TotpConfirmed = true;
            users.Save(user);
            return true;
        }
    }

    /// <summary>
    /// Called by a client that got <see cref="JazminUnlockRequiredException"/>: it sends the exception's
    /// FileId and KeyId plus the current code from the user's authenticator app.
    /// </summary>
    public UnlockResult RequestUnlockToken(string userId, string fileId, string keyId, string code)
    {
        var now = clock.GetUtcNow();
        UserRecord user;
        lock (LockFor(userId))
        {
            if (users.Find(userId) is not { TotpConfirmed: true, TotpSecret: not null } found) return new UnlockResult(UnlockStatus.NotEnrolled);
            user = found;
            if (user.LockedUntil is { } until && until > now) return new UnlockResult(UnlockStatus.LockedOut, RetryAfter: until);
            if (!TryAcceptCode(user, code))
            {
                return user.LockedUntil is { } lockedUntil && lockedUntil > now
                    ? new UnlockResult(UnlockStatus.LockedOut, RetryAfter: lockedUntil)
                    : new UnlockResult(UnlockStatus.InvalidCode);
            }
        }

        // Only after the second factor passed: is this the user's key, and is the grant still valid?
        if (!user.AccessKeyIds.Contains(keyId)) return new UnlockResult(UnlockStatus.KeyNotOwnedByUser);
        var path = files.FindPath(fileId);
        if (path is null) return new UnlockResult(UnlockStatus.FileNotFound);
        try
        {
            return new UnlockResult(UnlockStatus.Issued, JazminFile.IssueUnlockToken(path, ownerKey, keyId, now));
        }
        catch (JazminAccessExpiredException)
        {
            return new UnlockResult(UnlockStatus.Expired);
        }
        catch (JazminValidationException)
        {
            // No grant for this key in this file, or the grant is offline (needs no token).
            return new UnlockResult(UnlockStatus.NotOnlineGrant);
        }
        catch (Exception e) when (e is JazminFormatException or JazminKeyException)
        {
            return new UnlockResult(UnlockStatus.FileNotFound); // damaged, or not this owner's file
        }
    }

    /// <summary>Validates a code with replay protection, counting failures toward a lockout (call under the user's lock).</summary>
    private bool TryAcceptCode(UserRecord user, string code)
    {
        var accepted = int.TryParse(code.Replace(" ", ""), out var value)
            && _validator.TryValidate(user.TotpSecret!, value, out var timeStep, ToleranceSeconds)
            && timeStep > user.LastTimeStep
            && Accept(user, timeStep);
        if (!accepted)
        {
            user.FailedAttempts++;
            if (user.FailedAttempts % MaxFailedAttempts == 0)
            {
                // 5 minutes, then 10, 20, ... up to a day: guessing a 6-digit code stays impractical.
                var lockouts = user.FailedAttempts / MaxFailedAttempts;
                var period = TimeSpan.FromTicks(Math.Min(LockoutPeriod.Ticks << Math.Min(lockouts - 1, 20), MaxLockoutPeriod.Ticks));
                user.LockedUntil = clock.GetUtcNow() + period;
            }
            users.Save(user);
        }
        return accepted;
    }

    private bool Accept(UserRecord user, long timeStep)
    {
        user.LastTimeStep = timeStep;
        user.FailedAttempts = 0;
        user.LockedUntil = null;
        users.Save(user);
        return true;
    }
}
