using System.Text.Json;
using TotpAuthSharp;
using Xunit;

namespace Jazmin.KeyService.Tests;

/// <summary>
/// Tokens for locked stored files (spec 6.8.1, 6.8.2): issued only after the second factor, only for a lock the user
/// was given, by the owner key or from tokens listed beforehand.
/// </summary>
public sealed class LockTokensTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-keyservice-locks-").FullName;
    private readonly ManualClock _clock = new(T0);
    private readonly JazminKey _owner = JazminKey.Generate();
    private readonly JazminAccessKey _reader;
    private readonly string _path;
    private readonly string _fileId;

    public LockTokensTests()
    {
        _reader = _owner.CreateAccessKey();
        _path = Path.Combine(_dir, "claim.jzm");
        using (var writer = JazminWriter.Create(_path, [new JazminColumn("id", JazminType.Int)], new JazminWriteOptions
        {
            Key = _owner,
            Access = new JazminAccessOptions { Grants = [new JazminGrant(_reader)] },
            Files =
            [
                new JazminFileInput("scan.png", "The scan"u8.ToArray()) { Lock = "medical" },
                new JazminFileInput("contract.pdf", "The contract"u8.ToArray()) { Lock = "contracts" },
            ],
            Locks = new Dictionary<string, JazminLockOptions?>
            {
                ["medical"] = new() { Online = true, KeyService = "https://keys.medicalaid.example/jazmin" },
                ["contracts"] = new() { Password = "pw", Iterations = 1000 },
            },
        }))
        {
            writer.WriteValues(1L);
        }
        _fileId = JazminFile.Inspect(_path).FileId;
    }

    public void Dispose() => Directory.Delete(_dir, true);

    private sealed class ManualClock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private (KeyService Service, InMemoryUserStore Users) Service(IUnlockTokens tokens)
    {
        var users = new InMemoryUserStore();
        var service = new KeyService(users, tokens, _clock, new TotpSetupGenerator());
        service.BeginEnrolment("thandi", "JAZMIN tests");
        Assert.True(service.ConfirmEnrolment("thandi", new TotpGenerator(_clock).GenerateCode(users.Find("thandi")!.TotpSecret!)));
        _clock.Now += TimeSpan.FromSeconds(30);
        return (service, users);
    }

    private string Code(InMemoryUserStore users) => new TotpGenerator(_clock).GenerateCode(users.Find("thandi")!.TotpSecret!);

    private string OpenScan(string token)
    {
        using var reader = JazminReader.Open(_path, new JazminReadOptions { AccessKey = _reader });
        reader.Unlock("medical", unlockToken: token);
        return System.Text.Encoding.UTF8.GetString(reader.ReadFile("scan.png"));
    }

    [Fact]
    public void ALockGivenToTheUser_GetsItsToken_AfterTheCode_AndTheTokenOpensTheFile()
    {
        var (service, users) = Service(new OwnerKeyUnlockTokens(new DirectoryFileCatalog(_dir), _owner));
        Assert.Equal(UnlockStatus.KeyNotOwnedByUser, service.RequestFileUnlockToken("thandi", _fileId, "medical", Code(users)).Status);
        _clock.Now += TimeSpan.FromSeconds(30);
        service.RegisterLock("thandi", _fileId, "medical");
        Assert.Equal(UnlockStatus.InvalidCode, service.RequestFileUnlockToken("thandi", _fileId, "medical", "000000").Status);
        var result = service.RequestFileUnlockToken("thandi", _fileId, "medical", Code(users));
        Assert.Equal(UnlockStatus.Issued, result.Status);
        Assert.Equal("The scan", OpenScan(result.Token!));
    }

    [Fact]
    public void APasswordLock_AnUnknownLock_AndAnUnknownFile_GetNoToken()
    {
        var (service, users) = Service(new OwnerKeyUnlockTokens(new DirectoryFileCatalog(_dir), _owner));
        foreach (var (file, lockId) in new[] { (_fileId, "contracts"), (_fileId, "nope"), (new string('0', 32), "medical") })
        {
            service.RegisterLock("thandi", file, lockId);
            var status = service.RequestFileUnlockToken("thandi", file, lockId, Code(users)).Status;
            Assert.Equal(file == _fileId ? UnlockStatus.NotOnlineGrant : UnlockStatus.FileNotFound, status);
            _clock.Now += TimeSpan.FromSeconds(30);
        }
    }

    [Fact]
    public void StoredLockTokens_AreTheOwnerKeysTokens_SoTheServiceNeedsNoOwnerKey()
    {
        // On a trusted machine, with the owner key: the file's lock tokens, written for the service.
        var listed = JazminFile.ListFileUnlockTokens(_path, _owner);
        Assert.Equal([("medical", "https://keys.medicalaid.example/jazmin")], listed.Select(t => (t.LockId, t.KeyService)));
        var tokensFile = Path.Combine(_dir, "tokens.json");
        File.WriteAllText(tokensFile, JsonSerializer.Serialize(new
        {
            files = new[] { new { fileId = _fileId, tokens = Array.Empty<object>(), locks = listed.Select(t => new { lockId = t.LockId, token = t.Token }) } },
        }));
        var (service, users) = Service(new StoredUnlockTokens(tokensFile));
        service.RegisterLock("thandi", _fileId, "medical");
        var result = service.RequestFileUnlockToken("thandi", _fileId, "medical", Code(users));
        Assert.Equal(UnlockStatus.Issued, result.Status);
        Assert.Equal(JazminFile.IssueFileUnlockToken(_path, _owner, "medical"), result.Token);
        Assert.Equal("The scan", OpenScan(result.Token!));
    }

    [Theory]
    [InlineData("https://viewer.example", "https://viewer.example", true)]
    [InlineData("https://other.example", "https://viewer.example", false)]
    [InlineData("null", "https://viewer.example", false)]
    [InlineData("null", "https://viewer.example,null", true)]
    public void TheSignInPage_PostsTheToken_OnlyToAViewerTheServiceAllows(string origin, string allowed, bool answered)
    {
        var page = SignInPage.Html(origin, allowed.Split(','));
        Assert.Equal(answered, page.Contains("postMessage", StringComparison.Ordinal));
        if (!answered) Assert.Contains("isn't one this service answers", page);
    }
}
