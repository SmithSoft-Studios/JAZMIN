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

Without the owner key (better): on a trusted machine, list each file's unlock tokens with the owner key
(`listUnlockTokens(path, ownerKey)` in JavaScript, `JazminFile.ListUnlockTokens` in .NET) into a tokens file, and give
the service only that file. Broken into, it can't read or forge any file: a token opens nothing without its access key.

```json
{ "files": [ { "fileId": "961c…", "tokens": [ { "keyId": "18e4…", "label": "Thandi", "expires": "2026-11-13T22:24:46Z", "token": "jzu1-…" } ] } ] }
```

```bash
export Jazmin__TokensFile="/secure/jazmin-tokens.json"
dotnet run --project dotnet/samples/Jazmin.KeyService
```

With the owner key (shorter to set up):

```bash
export Jazmin__OwnerKey="jzk1-..."      # from your secret store - never commit it
export Jazmin__FilesDir="/data/statements"
dotnet run --project dotnet/samples/Jazmin.KeyService
```

A web page that asks for the code calls the service from the browser: list its origin in `Jazmin__AllowedOrigins`
(comma separated; none by default). `js/examples/from-disk/two-factor.html` is such a page: `make.mjs` writes its file,
its demo key and `site/key-service/tokens.json`, and the page shows the command to start the service. A page opened
from disk has the origin `null`: allow that only for a demo on your own computer.

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

## Locked files: the viewer's sign-in window

A stored file can be **locked** (JAZMIN 1.7, spec 6.8.1) with a lock that opens with a token from this service
(`online: true`). When the file or the lock names the service (`keyService`, spec 6.8.2), the web viewer's
**Unlock…** shows **Sign in at …**: it opens `GET /jazmin/unlock` in a window of its own, with the file id, the lock id
and the viewer's origin. The person gives their user and the code from their authenticator app; the page asks
`POST /unlock-lock` and posts the token back to the viewer, which opens the file. No key, password or file content
reaches the service.

1. **Owner/admin** gives a person a lock: `POST /admin/locks {userId, fileId, lockId}`.
2. The person **enrols** as above (`/2fa/setup`, `/2fa/confirm`).
3. **The viewer** names its origin; the page answers only origins in `Jazmin__AllowedOrigins` (`null` for a viewer
   opened from disk: demos on your own computer only).

Checks before a lock's token is issued: the user has 2FA and the code is right (the same lockouts as above), the lock
was given to the user (403), and the file and online lock exist (404). With a tokens file instead of the owner key, list
the locks' tokens with `JazminFile.ListFileUnlockTokens(path, ownerKey)` into each file's `locks`:
`{ "fileId": "…", "tokens": [ … ], "locks": [ { "lockId": "medical", "token": "jzf1-…" } ] }`.

One owner can name a different service per lock (for attachments locked for several providers): each runs its own
copy of this service and holds only its own locks' tokens. For development, a service on `http://localhost` (or
`127.0.0.1`, `[::1]`) is allowed; anywhere else it must be https.

## Limits

2FA proves *who is asking* before a token is issued. It is not part of the file
format, so it cannot protect **offline** grants, and it cannot take back data
someone already opened. Tests: `dotnet/tests/Jazmin.KeyService.Tests`.
