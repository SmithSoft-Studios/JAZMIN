// Sample JAZMIN key service: issues unlock tokens for online grants, protected by 2FA (TotpAuthSharp).
//
// Configuration (environment variables or appsettings):
//   Jazmin__TokensFile      the online grants' unlock tokens, listed on a trusted machine (JazminFile.ListUnlockTokens):
//                           the service then never holds the owner key. Or, shorter to set up:
//   Jazmin__OwnerKey        the owner's master key (jzk1-...) - load it from your secret store in production
//   Jazmin__FilesDir        folder containing the .jzm files the owner key unlocks
//   Jazmin__Issuer          name shown in the authenticator app (default "JAZMIN")
//   Jazmin__AllowedOrigins  web pages that may call the service, and viewers the lock sign-in page answers, comma
//                           separated (none by default; "null" for a viewer opened from disk, only for demos)
//
// IMPORTANT: this sample identifies the user with the X-User-Id header to stay short. In production
// take the user id from your authentication (for example a validated JWT) - never trust it from the client.
using Jazmin;
using Jazmin.KeyService;
using TotpAuthSharp;
using TotpAuthSharp.Interface;

var builder = WebApplication.CreateBuilder(args);
var tokensFile = builder.Configuration["Jazmin:TokensFile"];
var issuer = builder.Configuration["Jazmin:Issuer"] ?? "JAZMIN";
var origins = (builder.Configuration["Jazmin:AllowedOrigins"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
IUnlockTokens tokens = tokensFile is not null
    ? new StoredUnlockTokens(tokensFile)
    : new OwnerKeyUnlockTokens(
        new DirectoryFileCatalog(builder.Configuration["Jazmin:FilesDir"] ?? Directory.GetCurrentDirectory()),
        JazminKey.Parse(builder.Configuration["Jazmin:OwnerKey"]
            ?? throw new InvalidOperationException("Set Jazmin__TokensFile to the listed unlock tokens, or Jazmin__OwnerKey to the owner's jzk1-... key")));

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IUserStore, InMemoryUserStore>();
builder.Services.AddSingleton<IUnlockTokens>(tokens);
builder.Services.AddSingleton<ITotpSetupGenerator, TotpSetupGenerator>();
builder.Services.AddSingleton(sp => new KeyService(
    sp.GetRequiredService<IUserStore>(), sp.GetRequiredService<IUnlockTokens>(),
    sp.GetRequiredService<TimeProvider>(), sp.GetRequiredService<ITotpSetupGenerator>()));
// A page that asks for the code calls the service from the browser: only the origins configured may. A page opened
// from disk has the origin "null" - allow it only for a demo on your own computer.
if (origins.Length > 0)
{
    builder.Services.AddCors(cors => cors.AddDefaultPolicy(policy => policy.WithOrigins(origins).WithHeaders("Content-Type", "X-User-Id").WithMethods("POST")));
}

var app = builder.Build();
if (origins.Length > 0) app.UseCors();

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

// Admin: record which locks of stored files a user may open (spec 6.8.1; protect this endpoint in production).
app.MapPost("/admin/locks", (LockRequest body, KeyService service) =>
{
    service.RegisterLock(body.UserId, body.FileId, body.LockId);
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

// A viewer's sign-in window for a locked file (spec 6.8.2): the person signs in and gives a code; the page posts the token
// to the viewer. It is never shown in a frame, so another page can't dress it up.
app.MapGet("/jazmin/unlock", (HttpContext context, string? origin) =>
{
    context.Response.Headers.XFrameOptions = "DENY";
    context.Response.Headers.ContentSecurityPolicy = "frame-ancestors 'none'";
    return Results.Content(SignInPage.Html(origin ?? "", origins), "text/html; charset=utf-8");
});

// The page's request: a lock's token, after the code, for a lock the user was given.
app.MapPost("/unlock-lock", (HttpRequest request, LockUnlockRequest body, KeyService service) =>
{
    if (UserId(request) is not { } user) return Results.Unauthorized();
    var result = service.RequestFileUnlockToken(user, body.FileId, body.LockId, body.Code);
    return result.Status switch
    {
        UnlockStatus.Issued => Results.Ok(new { token = result.Token }),
        UnlockStatus.InvalidCode or UnlockStatus.NotEnrolled => Results.Unauthorized(),
        UnlockStatus.LockedOut => Results.Problem($"Too many wrong codes; try again after {result.RetryAfter:u}", statusCode: 429),
        UnlockStatus.KeyNotOwnedByUser => Results.Forbid(),
        _ => Results.NotFound(),
    };
});

app.Run();

public sealed record RegisterRequest(string UserId, string KeyId);

public sealed record ResetRequest(string UserId);

public sealed record CodeRequest(string Code);

public sealed record UnlockRequest(string FileId, string KeyId, string Code);

public sealed record LockRequest(string UserId, string FileId, string LockId);

public sealed record LockUnlockRequest(string FileId, string LockId, string Code);
