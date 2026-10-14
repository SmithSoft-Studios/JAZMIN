// These tests move the reader's clock on purpose: the option is obsolete for callers, still honoured until 2.0.
#pragma warning disable CS0618

using System.Text.Json;
using TotpAuthSharp;
using Xunit;

namespace Jazmin.KeyService.Tests;

/// <summary>
/// The service without the owner key: it issues tokens listed beforehand on a trusted machine
/// (<see cref="JazminFile.ListUnlockTokens"/>), so breaking into it can't read or forge any file.
/// </summary>
public sealed class StoredUnlockTokensTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-keyservice-stored-").FullName;
    private readonly ManualClock _clock = new(T0);
    private readonly InMemoryUserStore _users = new();
    private readonly JazminKey _owner = JazminKey.Generate();
    private readonly JazminAccessKey _online;
    private readonly JazminAccessKey _offline;
    private readonly string _path;
    private readonly string _fileId;
    private readonly string _tokensFile;
    private readonly KeyService _service;

    public StoredUnlockTokensTests()
    {
        _online = _owner.CreateAccessKey();
        _offline = _owner.CreateAccessKey();
        _path = Path.Combine(_dir, "statement.jzm");
        using (var writer = JazminWriter.Create(_path, [new("section", JazminType.String)], new JazminWriteOptions
        {
            Key = _owner,
            Now = T0,
            Access = new JazminAccessOptions
            {
                Grants =
                [
                    new JazminGrant(_online) { ExpiresIn = TimeSpan.FromHours(2), Mode = JazminGrantMode.Online, Label = "bob" },
                    new JazminGrant(_offline) { ExpiresIn = TimeSpan.FromDays(14), Label = "sally" },
                ],
            },
        }))
        {
            writer.WriteValues("A");
        }
        _fileId = JazminFile.Inspect(_path).FileId;

        // On a trusted machine, with the owner key: the file's online tokens, written for the service.
        var listed = JazminFile.ListUnlockTokens(_path, _owner);
        _tokensFile = Path.Combine(_dir, "tokens.json");
        File.WriteAllText(_tokensFile, JsonSerializer.Serialize(new
        {
            files = new[] { new { fileId = _fileId, tokens = listed.Select(t => new { keyId = t.KeyId, label = t.Label, expires = t.Expires, token = t.Token }) } },
        }));
        _service = new KeyService(_users, new StoredUnlockTokens(_tokensFile), _clock, new TotpSetupGenerator());
    }

    public void Dispose() => Directory.Delete(_dir, true);

    private sealed class ManualClock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private string Code() => new TotpGenerator(_clock).GenerateCode(_users.Find("bob")!.TotpSecret!);

    private void EnrolBob()
    {
        _service.RegisterAccessKey("bob", _online.Id);
        _service.BeginEnrolment("bob", "JAZMIN tests");
        Assert.True(_service.ConfirmEnrolment("bob", Code()));
        _clock.Now += TimeSpan.FromSeconds(30);
    }

    [Fact]
    public void AStoredToken_IsTheOwnerKeysToken_AndOpensTheFile()
    {
        EnrolBob();
        var result = _service.RequestUnlockToken("bob", _fileId, _online.Id, Code());

        Assert.Equal(UnlockStatus.Issued, result.Status);
        Assert.Equal(JazminFile.IssueUnlockToken(_path, _owner, _online.Id, _clock.Now), result.Token);
        using var reader = JazminReader.Open(_path, new JazminReadOptions { AccessKey = _online, UnlockToken = result.Token, Now = _clock.Now, CheckClockRollback = false });
        Assert.Single(reader.Rows());
    }

    [Fact]
    public void ExpiredGrant_UnknownFile_AndOfflineKey_GetNoToken()
    {
        EnrolBob();
        Assert.Equal(UnlockStatus.FileNotFound, _service.RequestUnlockToken("bob", "00000000000000000000000000000000", _online.Id, Code()).Status);
        _clock.Now += TimeSpan.FromSeconds(30);
        _service.RegisterAccessKey("bob", _offline.Id);
        Assert.Equal(UnlockStatus.NotOnlineGrant, _service.RequestUnlockToken("bob", _fileId, _offline.Id, Code()).Status);
        _clock.Now = T0.AddHours(3);
        Assert.Equal(UnlockStatus.Expired, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);
    }

    [Fact]
    public void TheSecondFactor_StillComesFirst()
    {
        EnrolBob();
        Assert.Equal(UnlockStatus.InvalidCode, _service.RequestUnlockToken("bob", _fileId, _online.Id, ((int.Parse(Code()) + 1) % 1_000_000).ToString("D6")).Status);
        Assert.Equal(UnlockStatus.KeyNotOwnedByUser, _service.RequestUnlockToken("bob", _fileId, _offline.Id, Code()).Status);
    }

    [Fact]
    public void AMissingOrBrokenTokensFile_IsReportedWhenTheServiceStarts()
    {
        Assert.Throws<FileNotFoundException>(() => new StoredUnlockTokens(Path.Combine(_dir, "none.json")));
        File.WriteAllText(_tokensFile, "{ not json");
        var error = Assert.Throws<InvalidOperationException>(() => new StoredUnlockTokens(_tokensFile));
        Assert.Contains("tokens.json", error.Message);
    }
}
