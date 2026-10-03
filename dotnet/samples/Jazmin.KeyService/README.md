# Jazmin.KeyService — unlock tokens with 2FA

A sample ASP.NET service that issues JAZMIN **unlock tokens** for **online**
grants, only after the user enters a valid code from an authenticator app
(Google/Microsoft Authenticator and others). Codes are checked with
[TotpAuthSharp](https://www.nuget.org/packages/TotpAuthSharp).

Requires the .NET 10 SDK, like the JAZMIN library itself.

## Flow

1. **Owner/admin** creates the file with an online grant and records which user
   holds that access key: `POST /admin/access-keys {userId, keyId}`.
2. **User enrols once:** `POST /2fa/setup` returns a QR code (data URI) and a
   manual key. They scan it, then `POST /2fa/confirm {code}`. Once confirmed,
   `/2fa/setup` answers 409: a new device needs an administrator to reset the
   old one (`POST /admin/2fa/reset {userId}`). Otherwise anyone who got past
   the first login step could replace the user's authenticator.
3. **User opens the file:** the library throws `JazminUnlockRequiredException`
   with `FileId` and `KeyId`. The client sends those plus the current code to
   `POST /unlock` and gets a token, then opens the file with `UnlockToken = token`.

## What the service checks before issuing a token

| Check | Result if it fails |
|---|---|
| User has confirmed 2FA | 401 |
| Code is valid and has not been used before (replay protection) | 401 |
| Fewer than 5 wrong codes in a row; otherwise locked out for 5 minutes, then 10, 20 and so on, up to a day | 429 |
| The access key belongs to this user | 403 |
| The file exists and the key has an online grant | 404 |
| The grant has not expired | 410 |

## Run it

```bash
export Jazmin__OwnerKey="jzk1-..."      # from your secret store - never commit it
export Jazmin__FilesDir="/data/statements"
dotnet run --project dotnet/samples/Jazmin.KeyService
```

## Before using this in production

- **Identity:** the sample reads the user from the `X-User-Id` header to stay
  short. Use your real authentication (for example a validated JWT); never
  trust a user id sent by the client.
- **Protect** `/admin/access-keys` and `/admin/2fa/reset`. Reset an
  authenticator only after checking who is asking.
- **Several instances:** the service checks and records codes under a lock
  per user, which covers one process. With more than one instance, make the
  store's check-and-update atomic, for example with a row version.
- **Keep the owner key off this service if you can.** It only needs each
  online grant's share. On a trusted machine,
  `JazminFile.ListUnlockTokens(path, ownerKey)` lists the tokens; store them
  encrypted where the service can read them. This sample loads the owner key
  to stay short, but a service holding it can read and forge every file if it
  is broken into.
- **Storage:** replace `InMemoryUserStore` with a database, and encrypt the
  TOTP secrets at rest.
- **HTTPS only.** Tokens and codes must never travel in plain text or be logged.

## Limits

2FA proves *who is asking* before a token is issued. It is not part of the file
format, so it cannot protect **offline** grants, and it cannot take back data
someone already opened. Tests: `dotnet/tests/Jazmin.KeyService.Tests`.
