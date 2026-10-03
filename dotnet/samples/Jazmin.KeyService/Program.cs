// Sample JAZMIN key service: issues unlock tokens for online grants, protected by 2FA (TotpAuthSharp).
//
// Configuration (environment variables or appsettings):
//   Jazmin__OwnerKey   the owner's master key (jzk1-...) - load it from your secret store in production
//   Jazmin__FilesDir   folder containing the .jzm files this service unlocks
//   Jazmin__Issuer     name shown in the authenticator app (default "JAZMIN")
//
// IMPORTANT: this sample identifies the user with the X-User-Id header to stay short. In production
// take the user id from your authentication (for example a validated JWT) - never trust it from the client.
using Jazmin;
using Jazmin.KeyService;
using TotpAuthSharp;
using TotpAuthSharp.Interface;

var builder = WebApplication.CreateBuilder(args);
var ownerKeyText = builder.Configuration["Jazmin:OwnerKey"]
    ?? throw new InvalidOperationException("Set Jazmin__OwnerKey to the owner's jzk1-... key");
var filesDir = builder.Configuration["Jazmin:FilesDir"] ?? Directory.GetCurrentDirectory();
var issuer = builder.Configuration["Jazmin:Issuer"] ?? "JAZMIN";

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IUserStore, InMemoryUserStore>();
builder.Services.AddSingleton<IFileCatalog>(new DirectoryFileCatalog(filesDir));
builder.Services.AddSingleton<ITotpSetupGenerator, TotpSetupGenerator>();
builder.Services.AddSingleton(sp => new KeyService(
    sp.GetRequiredService<IUserStore>(), sp.GetRequiredService<IFileCatalog>(), JazminKey.Parse(ownerKeyText),
    sp.GetRequiredService<TimeProvider>(), sp.GetRequiredService<ITotpSetupGenerator>()));

var app = builder.Build();

static string? UserId(HttpRequest request) => request.Headers["X-User-Id"].FirstOrDefault(); // replace with your authentication

// Admin: record which access key belongs to which user (protect this endpoint in production).
app.MapPost("/admin/access-keys", (RegisterRequest body, KeyService service) =>
{
    service.RegisterAccessKey(body.UserId, body.KeyId);
    return Results.NoContent();
});

// Admin: remove a user's authenticator so they can enrol a new device (check who is asking first; protect in production).
app.MapPost("/admin/2fa/reset", (ResetRequest body, KeyService service) =>
{
    service.ResetEnrolment(body.UserId);
    return Results.NoContent();
});

// Enrolment: show the QR code (data URI) / manual key, then confirm with the first code. Once confirmed, a new
// authenticator needs the admin reset above: otherwise anyone past the first factor could replace it.
app.MapPost("/2fa/setup", (HttpRequest request, KeyService service) =>
    UserId(request) is not { } user ? Results.Unauthorized()
    : service.BeginEnrolment(user, issuer) is { } setup ? Results.Ok(setup)
    : Results.Conflict("2FA is already set up. Ask an administrator to reset it to use a new device."));

app.MapPost("/2fa/confirm", (HttpRequest request, CodeRequest body, KeyService service) =>
    UserId(request) is not { } user ? Results.Unauthorized()
    : service.ConfirmEnrolment(user, body.Code) ? Results.NoContent()
    : Results.BadRequest("That code did not match. Check the device clock and try again."));

// Unlock: the client sends JazminUnlockRequiredException.FileId / KeyId plus the authenticator code.
app.MapPost("/unlock", (HttpRequest request, UnlockRequest body, KeyService service) =>
{
    if (UserId(request) is not { } user) return Results.Unauthorized();
    var result = service.RequestUnlockToken(user, body.FileId, body.KeyId, body.Code);
    return result.Status switch
    {
        UnlockStatus.Issued => Results.Ok(new { token = result.Token }),
        UnlockStatus.InvalidCode or UnlockStatus.NotEnrolled => Results.Unauthorized(),
        UnlockStatus.LockedOut => Results.Problem($"Too many wrong codes; try again after {result.RetryAfter:u}", statusCode: 429),
        UnlockStatus.KeyNotOwnedByUser => Results.Forbid(),
        UnlockStatus.FileNotFound or UnlockStatus.NotOnlineGrant => Results.NotFound(),
        UnlockStatus.Expired => Results.Problem("Access for this key has expired", statusCode: 410),
        _ => Results.StatusCode(500),
    };
});

app.Run();

public sealed record RegisterRequest(string UserId, string KeyId);

public sealed record ResetRequest(string UserId);

public sealed record CodeRequest(string Code);

public sealed record UnlockRequest(string FileId, string KeyId, string Code);
