// These tests move the reader's clock on purpose: the option is obsolete for callers, still honoured until 2.0.
#pragma warning disable CS0618

using TotpAuthSharp;
using Xunit;

namespace Jazmin.KeyService.Tests;

public sealed class KeyServiceTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);
    private static readonly JazminColumn[] Columns = { new("section", JazminType.String), new("amount", JazminType.Float) };

    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-keyservice-").FullName;
    private readonly ManualClock _clock = new(T0);
    private readonly InMemoryUserStore _users = new();
    private readonly JazminKey _owner = JazminKey.Generate();
    private readonly JazminAccessKey _online;
    private readonly JazminAccessKey _offline;
    private readonly string _path;
    private readonly string _fileId;
    private readonly KeyService _service;

    public KeyServiceTests()
    {
        _online = _owner.CreateAccessKey();
        _offline = _owner.CreateAccessKey();
        _path = Path.Combine(_dir, "statement.jzm");
        using (var writer = JazminWriter.Create(_path, Columns, new JazminWriteOptions
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
            writer.WriteValues("A", 1.0);
            writer.WriteValues("B", 2.0);
        }
        _fileId = JazminFile.Inspect(_path).FileId;
        _service = new KeyService(_users, new DirectoryFileCatalog(_dir), _owner, _clock, new TotpSetupGenerator());
    }

    public void Dispose() => Directory.Delete(_dir, true);

    private sealed class ManualClock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    /// <summary>What the user's authenticator app shows right now.</summary>
    private string Code(string user = "bob") => new TotpGenerator(_clock).GenerateCode(_users.Find(user)!.TotpSecret!);

    private static string Wrong(string code) => ((int.Parse(code) + 1) % 1_000_000).ToString("D6");

    private void NextTimeStep() => _clock.Now += TimeSpan.FromSeconds(30);

    private void EnrolBob()
    {
        _service.RegisterAccessKey("bob", _online.Id);
        var setup = _service.BeginEnrolment("bob", "JAZMIN tests")!;
        Assert.StartsWith("data:image/", setup.QrCodeImage);
        Assert.False(string.IsNullOrEmpty(setup.ManualSetupKey));
        Assert.True(_service.ConfirmEnrolment("bob", Code()));
        NextTimeStep();
    }

    [Fact]
    public void FullFlow_CodeGivesToken_TokenOpensTheFile()
    {
        EnrolBob();
        var error = Assert.Throws<JazminUnlockRequiredException>(() =>
            JazminReader.Open(_path, new JazminReadOptions { AccessKey = _online, Now = _clock.Now, CheckClockRollback = false }));

        var result = _service.RequestUnlockToken("bob", error.FileId, error.KeyId, Code());

        Assert.Equal(UnlockStatus.Issued, result.Status);
        using var reader = JazminReader.Open(_path, new JazminReadOptions { AccessKey = _online, UnlockToken = result.Token, Now = _clock.Now, CheckClockRollback = false });
        Assert.Equal(2, reader.Rows().Count());
    }

    [Fact]
    public void NotEnrolled_OrNotConfirmed_IsRefused()
    {
        _service.RegisterAccessKey("bob", _online.Id);
        Assert.Equal(UnlockStatus.NotEnrolled, _service.RequestUnlockToken("bob", _fileId, _online.Id, "123456").Status);
        _service.BeginEnrolment("bob", "JAZMIN tests");
        Assert.Equal(UnlockStatus.NotEnrolled, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);
        Assert.Equal(UnlockStatus.NotEnrolled, _service.RequestUnlockToken("nobody", _fileId, _online.Id, "123456").Status);
    }

    [Fact]
    public void WrongCode_IsRefused()
    {
        EnrolBob();
        Assert.Equal(UnlockStatus.InvalidCode, _service.RequestUnlockToken("bob", _fileId, _online.Id, Wrong(Code())).Status);
        Assert.Equal(UnlockStatus.InvalidCode, _service.RequestUnlockToken("bob", _fileId, _online.Id, "not-a-code").Status);
    }

    [Fact]
    public void ACode_CannotBeUsedTwice()
    {
        EnrolBob();
        var code = Code();
        Assert.Equal(UnlockStatus.Issued, _service.RequestUnlockToken("bob", _fileId, _online.Id, code).Status);
        Assert.Equal(UnlockStatus.InvalidCode, _service.RequestUnlockToken("bob", _fileId, _online.Id, code).Status);
        NextTimeStep();
        Assert.Equal(UnlockStatus.Issued, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);
    }

    [Fact]
    public void RepeatedWrongCodes_LockTheUserOut_ForFiveMinutes()
    {
        EnrolBob();
        for (var i = 1; i < KeyService.MaxFailedAttempts; i++)
            Assert.Equal(UnlockStatus.InvalidCode, _service.RequestUnlockToken("bob", _fileId, _online.Id, Wrong(Code())).Status);
        var locked = _service.RequestUnlockToken("bob", _fileId, _online.Id, Wrong(Code()));
        Assert.Equal(UnlockStatus.LockedOut, locked.Status);
        Assert.Equal(_clock.Now + KeyService.LockoutPeriod, locked.RetryAfter);

        // Even a correct code is refused while locked out.
        Assert.Equal(UnlockStatus.LockedOut, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);

        _clock.Now += KeyService.LockoutPeriod + TimeSpan.FromSeconds(1);
        Assert.Equal(UnlockStatus.Issued, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);
    }

    [Fact]
    public void KeyThatIsNotTheUsers_IsRefused_EvenWithAValidCode()
    {
        EnrolBob();
        Assert.Equal(UnlockStatus.KeyNotOwnedByUser, _service.RequestUnlockToken("bob", _fileId, _offline.Id, Code()).Status);
    }

    [Fact]
    public void ExpiredGrant_GetsNoToken()
    {
        EnrolBob();
        _clock.Now = T0.AddHours(3);
        Assert.Equal(UnlockStatus.Expired, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);
    }

    [Fact]
    public void UnknownFile_AndOfflineGrant_GetNoToken()
    {
        EnrolBob();
        Assert.Equal(UnlockStatus.FileNotFound, _service.RequestUnlockToken("bob", "00000000000000000000000000000000", _online.Id, Code()).Status);
        NextTimeStep();
        _service.RegisterAccessKey("bob", _offline.Id);
        Assert.Equal(UnlockStatus.NotOnlineGrant, _service.RequestUnlockToken("bob", _fileId, _offline.Id, Code()).Status);
    }

    [Fact]
    public void ConfirmedAuthenticator_CannotBeReplaced_UntilAnAdminResetsIt()
    {
        EnrolBob();
        var secret = _users.Find("bob")!.TotpSecret;
        Assert.Null(_service.BeginEnrolment("bob", "JAZMIN tests")); // someone past the first factor cannot swap the authenticator
        Assert.Equal(secret, _users.Find("bob")!.TotpSecret);
        Assert.Equal(UnlockStatus.Issued, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);

        _service.ResetEnrolment("bob");
        NextTimeStep();
        Assert.NotNull(_service.BeginEnrolment("bob", "JAZMIN tests"));
        Assert.True(_service.ConfirmEnrolment("bob", Code()));
        Assert.NotEqual(secret, _users.Find("bob")!.TotpSecret);
    }

    [Fact]
    public void Confirming_IsRefusedWhileLockedOut()
    {
        _service.BeginEnrolment("bob", "JAZMIN tests");
        for (var i = 0; i < KeyService.MaxFailedAttempts; i++) Assert.False(_service.ConfirmEnrolment("bob", Wrong(Code())));
        Assert.False(_service.ConfirmEnrolment("bob", Code())); // the right code, but locked out
        _clock.Now += KeyService.LockoutPeriod + TimeSpan.FromSeconds(1);
        Assert.True(_service.ConfirmEnrolment("bob", Code()));
    }

    [Fact]
    public void Lockouts_GetLongerEachTime()
    {
        EnrolBob();
        for (var round = 0; round < 3; round++)
        {
            UnlockResult locked = null!;
            for (var i = 0; i < KeyService.MaxFailedAttempts; i++) locked = _service.RequestUnlockToken("bob", _fileId, _online.Id, Wrong(Code()));
            Assert.Equal(UnlockStatus.LockedOut, locked.Status);
            Assert.Equal(_clock.Now + KeyService.LockoutPeriod * (1 << round), locked.RetryAfter); // 5, 10, 20 minutes
            _clock.Now = locked.RetryAfter!.Value + TimeSpan.FromSeconds(1);
        }
        Assert.Equal(UnlockStatus.Issued, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);
    }

    [Fact]
    public void DamagedFileInTheFolder_DoesNotStopUnlocks()
    {
        File.WriteAllBytes(Path.Combine(_dir, "damaged.jzm"), new byte[10]);
        EnrolBob();
        Assert.Equal(UnlockStatus.Issued, _service.RequestUnlockToken("bob", _fileId, _online.Id, Code()).Status);
    }
}
