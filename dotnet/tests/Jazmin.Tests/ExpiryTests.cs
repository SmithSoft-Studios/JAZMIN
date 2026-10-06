// These tests move the reader's clock on purpose: the option is obsolete for callers, still honoured until 2.0.
#pragma warning disable CS0618

using Xunit;

namespace Jazmin.Tests;

public sealed class ExpiryTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero); // when the file is written
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-expiry-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private sealed class MemoryStore : IJazminAccessStateStore
    {
        public Dictionary<string, string> Records { get; } = new();
        public string? Read(string name) => Records.GetValueOrDefault(name);
        public void Write(string name, string text) => Records[name] = text;
    }

    private static readonly JazminColumn[] Columns = { new("section", JazminType.String), new("amount", JazminType.Float) };

    private sealed record Scenario(JazminKey Owner, JazminAccessKey User1, JazminAccessKey User2, JazminAccessKey User3, string File);

    /// <summary>The scenario from the requirement: user1 2 hours, user2 2 weeks (online), user3 5 years.</summary>
    private Scenario Create(string name = "statement.jzm")
    {
        var owner = JazminKey.Generate();
        var (user1, user2, user3) = (owner.CreateAccessKey(), owner.CreateAccessKey(), owner.CreateAccessKey());
        var path = Path.Combine(_dir, name);
        using (var writer = JazminWriter.Create(path, Columns, new JazminWriteOptions
        {
            Key = owner,
            Now = T0,
            Access = new JazminAccessOptions
            {
                Grants =
                [
                    new JazminGrant(user1) { ExpiresIn = TimeSpan.FromHours(2), Label = "user1" },
                    new JazminGrant(user2) { ExpiresIn = TimeSpan.FromDays(14), Mode = JazminGrantMode.Online, Label = "user2" },
                    new JazminGrant(user3) { Expires = T0.AddYears(5), Label = "user3" },
                ],
            },
        }))
        {
            writer.WriteValues("A", 1.0);
            writer.WriteValues("B", 2.0);
        }
        return new Scenario(owner, user1, user2, user3, path);
    }

    private static int Read(string path, JazminReadOptions options)
    {
        using var r = JazminReader.Open(path, options);
        return r.Rows().Count();
    }

    [Fact]
    public void OfflineKeys_OpenUntilTheyExpire()
    {
        var s = Create();
        Assert.Equal(2, Read(s.File, new() { AccessKey = s.User1, Now = T0.AddHours(1), AccessState = new MemoryStore() }));
        var error = Assert.Throws<JazminAccessExpiredException>(() => Read(s.File, new() { AccessKey = s.User1, Now = T0.AddHours(3), AccessState = new MemoryStore() }));
        Assert.Contains("expired at 2026-10-01T10:00:00.000Z", error.Message);
        Assert.Equal(2, Read(s.File, new() { AccessKey = s.User3, Now = T0.AddYears(4), AccessState = new MemoryStore() }));
        Assert.Throws<JazminAccessExpiredException>(() => Read(s.File, new() { AccessKey = s.User3, Now = T0.AddYears(5).AddDays(1), AccessState = new MemoryStore() }));
        using var r = JazminReader.Open(s.File, new() { AccessKey = s.User3, Now = T0, AccessState = new MemoryStore() });
        Assert.False(r.Access!.Online);
        Assert.Equal(T0.AddYears(5), r.Access.Expires);
    }

    [Fact]
    public void ClockCannotBeEarlierThanTheSignedFileDate()
    {
        var s = Create();
        var error = Assert.Throws<JazminAccessExpiredException>(() => Read(s.File, new() { AccessKey = s.User3, Now = T0.AddDays(-1), AccessState = new MemoryStore() }));
        Assert.Contains("earlier than when this file was written", error.Message);
        Assert.Equal(2, Read(s.File, new() { AccessKey = s.User3, Now = T0.AddMinutes(-1), AccessState = new MemoryStore() }));
    }

    [Fact]
    public void ClockRollback_AndTamperedRecord_AreDetected()
    {
        var s = Create();
        var state = new MemoryStore();
        Assert.Equal(2, Read(s.File, new() { AccessKey = s.User1, Now = T0.AddMinutes(100), AccessState = state }));
        Assert.Contains("Clock rollback detected",
            Assert.Throws<JazminAccessExpiredException>(() => Read(s.File, new() { AccessKey = s.User1, Now = T0.AddMinutes(30), AccessState = state })).Message);
        Assert.Equal(2, Read(s.File, new() { AccessKey = s.User1, Now = T0.AddMinutes(97), AccessState = state }));

        var (name, text) = state.Records.Single();
        state.Records[name] = text.Replace(T0.AddMinutes(100).ToUnixTimeMilliseconds().ToString(), T0.ToUnixTimeMilliseconds().ToString());
        Assert.Contains("access record for this file was modified",
            Assert.Throws<JazminAccessExpiredException>(() => Read(s.File, new() { AccessKey = s.User1, Now = T0.AddMinutes(30), AccessState = state })).Message);
        Assert.Equal(2, Read(s.File, new() { AccessKey = s.User1, Now = T0.AddMinutes(30), CheckClockRollback = false }));
    }

    [Fact]
    public void DirectoryStore_KeepsOneRecordPerFileAndKey()
    {
        var s = Create();
        var dir = Path.Combine(_dir, "state");
        Read(s.File, new() { AccessKey = s.User1, Now = T0.AddHours(1), AccessState = new JazminDirectoryAccessStateStore(dir) });
        Assert.Equal(new[] { $"{JazminFile.Inspect(s.File).FileId}.{s.User1.Id}.json" }, Directory.GetFiles(dir).Select(Path.GetFileName));
    }

    [Fact]
    public void OnlineKeys_NeedAnUnlockToken_IssuedOnlyUntilExpiry()
    {
        var s = Create();
        var required = Assert.Throws<JazminUnlockRequiredException>(() => JazminReader.Open(s.File, new() { AccessKey = s.User2, Now = T0 }));
        Assert.Equal(JazminFile.Inspect(s.File).FileId, required.FileId);
        Assert.Equal(s.User2.Id, required.KeyId);

        var token = JazminFile.IssueUnlockToken(s.File, s.Owner, required.KeyId, T0.AddDays(1));
        Assert.Equal(2, Read(s.File, new() { AccessKey = s.User2, UnlockToken = token, Now = T0.AddDays(1), AccessState = new MemoryStore() }));
        Assert.Throws<JazminAccessExpiredException>(() => JazminFile.IssueUnlockToken(s.File, s.Owner, s.User2.Id, T0.AddDays(15)));
        Assert.Throws<JazminValidationException>(() => JazminFile.IssueUnlockToken(s.File, s.Owner, s.User3.Id));
        Assert.Throws<JazminAccessExpiredException>(() => Read(s.File, new() { AccessKey = s.User2, UnlockToken = token, Now = T0.AddDays(15), AccessState = new MemoryStore() }));

        var other = Create("other.jzm");
        var wrong = JazminFile.IssueUnlockToken(other.File, other.Owner, other.User2.Id, T0);
        Assert.Contains("unlock token is not valid", Assert.Throws<JazminKeyException>(() =>
            JazminReader.Open(s.File, new() { AccessKey = s.User2, UnlockToken = wrong, Now = T0 })).Message);
        var listed = Assert.Single(JazminFile.ListUnlockTokens(s.File, s.Owner));
        Assert.Equal(new JazminUnlockTokenInfo(s.User2.Id, "user2", T0.AddDays(14), token), listed);
    }

    [Fact]
    public void OwnerIsNeverLimited_AndSeesGrantDetails()
    {
        var s = Create();
        Assert.Equal(2, Read(s.File, new() { Key = s.Owner, Now = new DateTimeOffset(2040, 1, 1, 0, 0, 0, TimeSpan.Zero) }));
        using var r = JazminReader.Open(s.File, new() { Key = s.Owner });
        Assert.Equal(
            new[] { ("user1", JazminGrantMode.Offline, (DateTimeOffset?)T0.AddHours(2)), ("user2", JazminGrantMode.Online, T0.AddDays(14)), ("user3", JazminGrantMode.Offline, T0.AddYears(5)) },
            r.Access!.Grants!.Select(g => (g.Label!, g.Mode, g.Expires)));
    }

    [Fact]
    public void UpdatesAndAppends_DropExpiredGrants_OnlineTokensSurviveRewrites()
    {
        var s = Create();
        var token = JazminFile.IssueUnlockToken(s.File, s.Owner, s.User2.Id, T0);
        var updated = JazminFile.Update(s.File, new JazminUpdate
        {
            Key = s.Owner, Now = T0.AddHours(3),
            Insert = [new Dictionary<string, object?> { ["section"] = "C", ["amount"] = 3.0 }],
        });
        Assert.Equal(1, updated.ExpiredGrantsRemoved);
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(s.File, new() { AccessKey = s.User1, Now = T0.AddHours(1), CheckClockRollback = false }));
        Assert.Equal(3, Read(s.File, new() { AccessKey = s.User2, UnlockToken = token, Now = T0.AddHours(4), AccessState = new MemoryStore() }));

        var appended = JazminFile.Append(s.File, new JazminAppend
        {
            Key = s.Owner, Now = T0.AddDays(15),
            Insert = [new Dictionary<string, object?> { ["section"] = "D", ["amount"] = 4.0 }],
        });
        Assert.Equal(1, appended.ExpiredGrantsRemoved);
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(s.File, new() { AccessKey = s.User2, UnlockToken = token, Now = T0.AddDays(1), CheckClockRollback = false }));
        Assert.Equal(4, Read(s.File, new() { AccessKey = s.User3, Now = T0.AddDays(16), AccessState = new MemoryStore() }));
    }
}
