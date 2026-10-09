namespace Jazmin;

/// <summary>
/// Who may see what in an access-controlled file. A grant opens the listed partitions
/// (values of <see cref="JazminAccessOptions.PartitionBy"/>) and column groups; null means all.
/// </summary>
public sealed class JazminGrant(JazminAccessKey key)
{
    public JazminAccessKey Key { get; } = key ?? throw new ArgumentNullException(nameof(key));

    /// <summary>Partition names this key may see, or null for all (including partitions added later).</summary>
    public IReadOnlyList<string>? Rows { get; init; }

    /// <summary>Column group names this key may see ("*" is the default group), or null for all.</summary>
    public IReadOnlyList<string>? Columns { get; init; }

    public string? Label { get; init; }

    /// <summary>Absolute end of access (null: never expires). For calendar periods use e.g. now.AddYears(5).</summary>
    public DateTimeOffset? Expires { get; init; }

    /// <summary>End of access relative to when the file is written, e.g. TimeSpan.FromHours(2). Ignored when <see cref="Expires"/> is set.</summary>
    public TimeSpan? ExpiresIn { get; init; }

    /// <summary>Offline (default): enforced by the library. Online: opening also needs an unlock token from your key service.</summary>
    public JazminGrantMode Mode { get; init; } = JazminGrantMode.Offline;

    /// <summary>Extra file groups this key may see (embedded files), besides "*" and groups named like its partitions. ["*"] = all.</summary>
    public IReadOnlyList<string>? Files { get; init; }

    /// <summary>Internal: an online grant's server-held share, carried across rewrites so tokens stay valid.</summary>
    internal byte[]? Share { get; init; }
}

public enum JazminGrantMode
{
    /// <summary>Expiry enforced by the library (works without network access).</summary>
    Offline,

    /// <summary>Opening needs an unlock token that the owner's key service issues only before expiry.</summary>
    Online,
}

/// <summary>Where readers keep each expiring key's last-seen time (used to detect a clock set back).</summary>
public interface IJazminAccessStateStore
{
    string? Read(string name);

    void Write(string name, string text);
}

/// <summary>Keeps last-seen records as small files in a directory (default: the user's app-data folder).</summary>
public sealed class JazminDirectoryAccessStateStore(string directory) : IJazminAccessStateStore
{
    /// <summary>%LOCALAPPDATA%\Jazmin\access-state on Windows, ~/.jazmin/access-state elsewhere (same as the JavaScript library).</summary>
    public static string DefaultDirectory => OperatingSystem.IsWindows()
        ? Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Jazmin", "access-state")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".jazmin", "access-state");

    public string? Read(string name)
    {
        var path = Path.Combine(directory, name);
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }

    public void Write(string name, string text)
    {
        Directory.CreateDirectory(directory);
        var target = Path.Combine(directory, name);
        var temp = $"{target}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temp, text);
        File.Move(temp, target, overwrite: true);
    }
}

/// <summary>Makes a file access-controlled (requires the owner's <see cref="JazminKey"/>).</summary>
public sealed class JazminAccessOptions
{
    /// <summary>String or int column whose value names each row's partition, e.g. "section".</summary>
    public string? PartitionBy { get; set; }

    /// <summary>Named groups of columns, e.g. { "pii": ["salary", "idNumber"] }. Other columns form group "*".</summary>
    public Dictionary<string, string[]> ColumnGroups { get; set; } = new();

    public List<JazminGrant> Grants { get; set; } = new();
}

/// <summary>A grant as the owner sees it (no secrets).</summary>
public sealed record JazminGrantInfo(string KeyId, IReadOnlyList<string>? Rows, IReadOnlyList<string>? Columns, string? Label)
{
    public JazminGrantMode Mode { get; init; }

    public DateTimeOffset? Expires { get; init; }
}

/// <summary>Access-control details of an open file.</summary>
public sealed record JazminAccessInfo(
    bool IsOwner,
    string? PartitionBy,
    IReadOnlyList<string> ColumnGroups,
    IReadOnlyList<string> VisiblePartitions,
    IReadOnlyList<string> VisibleColumnGroups,
    IReadOnlyList<JazminGrantInfo>? Grants)
{
    /// <summary>Access keys: this key's id, as the owner's grants list it.</summary>
    public string? KeyId { get; init; }

    /// <summary>Access keys: whether opening needs an unlock token.</summary>
    public bool Online { get; init; }

    /// <summary>Access keys: when access ends (null: never).</summary>
    public DateTimeOffset? Expires { get; init; }

    /// <summary>Owner only: the columns of each column group ("*" holds the columns of no named group).</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>>? GroupColumns { get; init; }
}

/// <summary>What can be read without a key (see <see cref="JazminFile.Inspect"/>).</summary>
public sealed record JazminFileInfo(string FileId, string Version, bool Encrypted, bool PasswordProtected, bool AccessControlled, bool Appended);

/// <summary>An online grant's unlock token, for key services that store them.</summary>
public sealed record JazminUnlockTokenInfo(string KeyId, string? Label, DateTimeOffset? Expires, string Token);
