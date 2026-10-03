# JAZMIN security review package

This page is for the people reviewing JAZMIN's security (TASKS S-4). It
sets out what to review, what JAZMIN is meant to protect against, and where
each protection lives in the code. It also gives the results of our own
review.

- **Format specification:** [draft-03](rfc/draft-jazmin-format-03.md):
  §7 (encryption and keys) and §13 (security considerations) are normative.
- **Implementations:** JavaScript (`js/src`, Node.js 22+) and .NET
  (`dotnet/src/Jazmin`, .NET 10). They must read and write each other's
  files byte for byte; the shared fixtures in `spec/fixtures` prove it.
- **Sample key service:** `dotnet/samples/Jazmin.KeyService` issues unlock
  tokens behind TOTP two-factor authentication. It is an example of an
  online-grant service, not a product.

## 1. What to review

| Area | Spec | JavaScript | .NET |
|---|---|---|---|
| Algorithms, key text, password keys | §7.1–7.3 | `keys.js` | `Format/Crypto.cs`, `JazminKey.cs` |
| Section encryption and associated data | §7.4–7.5 | `section.js`, `keys.js` (`encrypt`, `decrypt`) | `Format/SectionCodec.cs`, `Format/Crypto.cs` |
| Owner and access keys, signing key | §7.6.1 | `keys.js` (`ownerSigning`, `JazminAccessKey`) | `JazminAccessKey.cs` (`OwnerSigning`) |
| Secrets, partition ids, section keys | §7.6.2–7.6.3 | `access.js` (`FileSecrets`, `partKey`) | `Format/Access.cs` (`FileSecrets`, `AccessCrypto`) |
| Key slots, pages, signature | §7.6.4 | `access.js` (`sealSlot`, `unsealSlot`, `buildKeySlotPages`, `verifyOwner`) | `Format/Access.cs` (same names) |
| What a key holder may read | §7.6.5–7.6.6 | `reader.js` (`#openAccess`, `#read`, `#openColumns`) | `JazminReader.cs` (`OpenAccess`, `ReadSection`, `OpenColumns`) |
| Fresh secrets on rewrite, appends | §7.6.7, §11 | `writer.js`, `update.js`, `append.js` | `JazminWriter.cs`, `JazminFile.cs` |
| Time-limited access | §7.7 | `expiry.js`, `online.js` | `Format/Access.cs` (`ExpiryCheck`, `UnlockTokens`) |
| Damaged and hostile files | §13 (resource exhaustion) | `section.js`, decoders | `Format/SectionCodec.cs`, decoders |

Out of scope: the browser proof of concept (`js/poc`), benchmarks, and the
hosting of a real key service.

## 2. What JAZMIN protects

A JAZMIN file holds a table and, optionally, embedded files. It can be
protected in three ways:

1. **Plain:** no secrecy. A CRC-32 per section detects accidental damage
   only.
2. **Key or password:** every section is encrypted with AES-256-GCM under a
   key unique to that section, derived with HKDF from the master key (or
   PBKDF2 from a password).
3. **Access-controlled:** one *owner key* writes the file and issues *access
   keys*. Each access key opens only the partitions (row groups) and column
   groups it was granted. The owner signs the file (ECDSA P-256), so readers
   accept only files the owner produced. Grants can expire: *offline* expiry
   is checked by the reader, and *online* grants need an unlock token from the
   owner's key service.

### Security goals

| Goal | Holds against |
|---|---|
| **G1 Confidentiality:** without a key, no values, column names (restricted groups) or embedded files can be read | anyone holding the file |
| **G2 Integrity:** a changed, swapped, moved or replayed section is detected in encrypted files | anyone who can change the file |
| **G3 Authenticity:** an access-controlled file that readers accept was produced by the owner key | access-key holders and anyone else |
| **G4 Least privilege:** an access key reads only what it was granted: rows of its partitions, columns of its groups, its file groups; it cannot derive other secrets | access-key holders |
| **G5 Revocation:** a revoked key cannot read a new version of the file | revoked key holders |
| **G6 Expiry:** an expired offline key is refused by a correct reader; an expired online key cannot get an unlock token | key holders after expiry |
| **G7 Safe failure:** a damaged or hostile file fails with a JAZMIN error, without a crash, hang or runaway memory use | anyone who can supply a file |

### Not goals (documented limits, spec §13 and §7.7)

- **Shape is visible:** file and section sizes, the number of partitions
  and key slots, restricted groups' names and column counts, user metadata,
  and the default column group's columns.
- **Compression before encryption** can leak data to an attacker who can
  inject chosen data next to a secret and watch sizes (CRIME/BREACH). Codec
  0 avoids it.
- **Plain files have no integrity** against deliberate changes.
- **Offline expiry is advisory** against someone who controls their
  machine: they can delete the last-seen record or use a modified reader.
- **Revocation does not reach old copies:** a copy of an old version still
  opens with a revoked key.
- **Owner key compromise** exposes everything and allows forging files.

## 3. Key hierarchy

```
master key (32 random bytes, "jzk1-…")        password ──PBKDF2-HMAC-SHA256──┐
  │                                                                           ▼
  ├─ key/password files: header key = HKDF(master, salt, "JAZMIN/1/header")
  │                      section key = HKDF(master, keyring[group], "JAZMIN/1/" + section id)
  │
  └─ access-controlled files (master = owner key):
       signing key d = HKDF(owner, "", "JAZMIN/1/owner-signing", 48 bytes) mod (n−1) + 1
       per version: H (header secret), O (owner secret), 32 random bytes each
         partition id  = HMAC(HKDF(O, salt, "JAZMIN/1/partition-id"), name)[0..11]
         P(id)         = HKDF(O, salt, "JAZMIN/1/partition/" + id)
         C(g)          = HKDF(O, salt, "JAZMIN/1/column-group/" + g)
         chunk part    = HKDF(P(p) ‖ C(g), salt, "JAZMIN/1/" + section id)
       key slot of key s: AES-GCM(HKDF(s [‖ share], salt, "JAZMIN/1/slot"), aad = file id ‖ slot id)
         owner bundle  { H, O }        access bundle { H, P(granted…), C(granted…), expires, online, files }
       signature over "JAZMIN/1/signature" ‖ file id ‖ SHA-256(key-slot list) ‖ SHA-256(header)
```

Every section's associated data is `file id ‖ envelope bytes 0..7 ‖ section
id`. Each key holder verifies the signature, then the digest of every
section it reads against the signed catalog.

## 4. Threat scenarios to test

1. **File thief, no key:** recover any value, restricted column name or
   embedded file from an encrypted or access-controlled file.
2. **Tamperer:** change, reorder, truncate, swap sections between files or
   versions, or turn an encrypted section into a plain one, so that a reader
   returns altered data without an error.
3. **Curious access-key holder:** read another partition's rows or
   statistics, a restricted group's columns or names, indexes, the owner
   directory, another file group's files. Also forge or extend its own
   grant.
4. **Forger:** produce an access-controlled file that readers accept as the
   owner's without the owner key (for example by reusing a signature, or
   swapping a key-slot page).
5. **Revoked or expired key holder:** read a newer version, or keep opening
   after expiry, beyond the documented limits.
6. **Hostile file author:** make a reader crash, hang or exhaust memory.
   Fuzzing (S-5) covers damaged plain files; hostile *encrypted* files are
   worth a look too.
7. **Key service attacker** (sample): get an unlock token without the second
   factor, after expiry, or by replaying a code.

## 5. Evidence we already have

- **Interop fixtures** written by each library and read by the other,
  including key, password, access-controlled, appended and embedded-file
  files (`spec/fixtures`, `interop.test.js`, `InteropTests`).
- **Security behaviour tests:**
  - JavaScript: `access.test.js` (isolation, tampering, wrong owner),
    `expiry.test.js` (offline checks, clock rollback, online tokens),
    `keys.test.js` (checksums, HKDF vectors, AES-GCM tampering),
    `format-version.test.js` (hidden column names, signed key-slot pages).
  - .NET: `AccessTests`, `ExpiryTests`, `CoreTests`, `FormatVersionTests`.
  - Key service: `Jazmin.KeyService.Tests`.
- **Fuzzing (S-5):** both readers, damaged files and decoder inputs; see
  [CONTRIBUTING](CONTRIBUTING.md#fuzzing-the-readers).

Run everything with `npm test` (in `js/`) and `dotnet test` (in `dotnet/`).

## 6. Questions for reviewers

1. The owner's ECDSA key is derived deterministically from the owner key
   (HKDF output reduced mod n−1). Is the bias acceptable, and is deriving a
   signing key from the same secret that encrypts acceptable?
2. Random 96-bit AES-GCM nonces rely on every section key being unique. Are
   there paths where one key encrypts many sections (for example key slots
   or appends)?
3. Truncations: partition ids are 96 bits and slot ids 64 bits. Is a slot-id
   collision between two keys of one file harmful?
4. Appends reuse the key-slot pages and owner directory when grants do not
   change (P-9). Can an append be crafted that a narrowed or revoked grant
   still reads? (Our review found that narrowing could, so appends now refuse
   it: R2 below.)
5. Is the signature's coverage (key-slot list and header digests, then
   section digests down the tree) complete for every section a key holder
   reads?
6. Error messages: do they give an oracle (for example "wrong key" versus
   "tampered") that matters?

## 7. Internal review results

Our own review of both implementations against this package (October 2026).
Severity: **High** breaks a security goal; **Medium** weakens one under
conditions; **Low** is defence in depth; **Info** needs no change.

Two reviews were run, one per implementation. Both confirmed that every
derivation, the associated data, the key text formats, the signature message
and the randomness sources match the spec.

| # | Severity | Finding | Status |
|---|---|---|---|
| R1 | High (sample) | Key service: anyone past the first login step could replace a user's authenticator, making the second factor useless | **Fixed:** setup refused once 2FA is confirmed; an admin reset is needed |
| R2 | Medium | An append could narrow a grant (fewer rows or columns, an expiry, online mode), but the key kept the secrets that open the new data | **Fixed** in both libraries: appends refuse to narrow a grant (spec 11.2) |
| R3 | Medium (sample) | Key service: parallel requests could race the lockout and replay checks; lockouts reset; confirming a code was not rate-limited | **Fixed:** per-user lock, lockouts double up to a day, confirm respects the lockout, codes accepted within ±30 s |
| R4 | Medium (sample) | Key service holds the owner key, so a break-in exposes every file | **Documented** (sample README): give the service the grants' shares instead |
| R5 | Medium | Expiry can be bypassed with the stock library: the reader's `now` / `Now` option sets the clock back. A token saved before expiry keeps working until a rewrite | **Open:** needs a public API change (decision D1 below). Guide corrected |
| R6 | Low | A file's password iteration count was used unchecked (a hostile file could stall a reader for hours) | **Fixed:** 1,000 to 10,000,000 (spec 7.2) |
| R7 | Low | Key-slot and signature sections were decoded with any codec before being checked | **Fixed:** they must be stored as is (spec 7.6.4) |
| R8 | Low | Digests were checked when present but not required; an encrypted file's embedded content without a key was read as plain | **Fixed:** both refused (spec 7.6.5) |
| R9 | Low | Key objects print their full secret text (`toString`); the signing-key cache kept owner keys | **Partly fixed:** caches no longer hold owner keys (JS) and are bounded (.NET). `toString` needs a public API change (decision D2) |
| R10 | Low | `update` / `compact` dropped the file's permissions on POSIX | **Fixed** in both libraries |
| R11 | Low | The owner directory (grants and names) was compressed before encryption, so its size could leak (CRIME-style) | **Fixed:** stored uncompressed (spec 7.6.5) |
| R12 | Info | .NET: a filter could name a hidden column's placeholder (no data leaked) | **Fixed** |
| R13 | Info | Rollback of an appended file by truncation; deleted row ids and package settings visible to every key holder; slot ids link a key holder across files; 64-bit owner fingerprint for shared keys | **Documented** in spec 13 |
| R14 | Info | .NET derives the owner's public key with its own big-integer curve arithmetic (variable time; runs once per key) | **Open:** question for reviewers; it conflicts with the "no custom cryptography" rule |
| R15 | Info | JS: an unreadable expiry date passed the check; lenient base64url in key text; online share length unchecked | **Partly fixed:** expiry fails closed. The rest is harmless: checksums are still verified |

Regression tests: `security.test.js`, `SecurityTests`, the append tests
(`an append may widen a grant but not narrow it`) and the key service tests.

### Decisions for the owner

- **D1:** remove the reader's clock option, which closes R5. JavaScript `now`
  and .NET `Now` would become internal (tests only). This is a breaking API
  change; the library is not published yet.
- **D2:** make key `toString()` print only the key id, and add an explicit
  `export()` for the secret text (R9). This breaks code that saves keys with
  `toString()`.
