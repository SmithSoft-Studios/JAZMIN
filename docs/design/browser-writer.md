# Design: an official browser writer (issue #13)

Status: **proposal for review**, 5 October 2026. Nothing is built yet.

## 1. Why

- **Today:** browsers can read `.jzm` files (`@smithsoft-studios/jazmin/browser`)
  but not write them.
- **Hosted Collect** writes files in the browser with an unofficial bundle. That
  bundle is the Node library packed for browsers, with a patched helper library
  inside.
- **The risk:** that is unreviewed encryption code running in people's browsers.
  We don't know which encryption implementation the bundle ends up using, or
  whether the patch changed it.

**Goal:** one official, reviewed, dependency-free browser writer. Its files are
exactly the files the Node library writes, and hosted Collect can replace the
bundle with it.

## 2. What the writer needs from the platform

| The Node writer uses | In a browser | Notes |
|---|---|---|
| Random bytes (`crypto.randomBytes`) | `crypto.getRandomValues` | Built in, cryptographically secure |
| AES-256-GCM | WebCrypto `AES-GCM` | Same layout: nonce, ciphertext, 16-byte tag |
| HKDF, HMAC, SHA-256 | WebCrypto | WebCrypto is async-only (see 4.2) |
| PBKDF2 (password files) | WebCrypto `PBKDF2` | |
| ECDSA P-256 signatures (owner) | WebCrypto `ECDSA` | Same raw `r‖s` signature format |
| Deriving the owner's signing key from the master key | **No direct equivalent** | See risk 7.1 |
| Deflate (`zlib`) | `CompressionStream('deflate-raw')` | Chrome 103, Firefox 113, Safari 16.4 and later |
| Brotli | Not available | The browser writer writes deflate only |
| Worker threads, files on disk | Not needed | Output is a `Blob`; the app saves or uploads it |

Everything except one step is built into every current browser. **No
third-party crypto code is needed**, which is the main security win over the
current bundle.

## 3. Options

1. **Keep the unofficial bundle.** It works today, but its crypto comes from
   whatever the bundler substituted for `node:crypto`, and nobody has reviewed
   it. Not recommended.
2. **A separate browser writer**, written from scratch like the browser reader.
   The writer is the most complex part of the library (key slots, signatures,
   partitions, indexes). A second copy would drift from the first, and every
   format change would be made twice. Not recommended.
3. **One writer for both (recommended).** The writer's logic (encoding,
   statistics, indexes, catalog, key slots) stays in one place. Only the
   platform parts become replaceable *providers*: randomness, hashing,
   encryption, compression and signing. Node keeps today's providers, with the
   same speed and the same output. The browser gets WebCrypto and
   `CompressionStream` providers. This is backlog item B-1.

## 4. How option 3 fits the code

### 4.1 Separating the platform parts

`writer.js` and the modules it uses import `node:crypto`, `node:fs`,
`node:os`, `node:zlib` and `node:worker_threads` directly. The work:

- **Move the Node imports behind small provider modules:**
  - `random(n)`
  - `sha256`, `hmac` and `hkdf`
  - `seal(raw, key, aad)`: compress, then AES-GCM
  - `sign(message)`
- **Separate where the output goes:** the writer already writes to memory when
  given `null` instead of a path. The browser writer always does that and
  returns a `Blob`.
- **Unchanged:** the format code (`columnar`, `stats`, `indexes`, `catalog`,
  `proto`, `types`, `schema`). It already uses no Node APIs.

### 4.2 Async in the browser

WebCrypto and `CompressionStream` only work asynchronously. The Node writer is
synchronous: `write(path, rows)` returns when the file is complete. So the
writer has two stages:

- **Build** each section's bytes as rows arrive (synchronous, shared code).
- **Seal** sections (compress, encrypt, sign) and write them in order:
  synchronously in Node, asynchronously in the browser.

The browser API is async:

```js
const writer = await JazminBrowser.createWriter({ columns, key });
await writer.writeRows(rows);          // seals each chunk as it fills
const blob = await writer.finish();    // indexes, catalog, header, signature
```

Key derivation (HMAC/HKDF) happens many times while writing. To keep the build
stage synchronous, it can use a small built-in SHA-256, about 120 lines, checked
against the published test vectors (FIPS 180-4, RFC 4231, RFC 5869) and against
Node in CI. AES-GCM, PBKDF2 and signing always use WebCrypto. We never write our
own encryption.

### 4.3 What a browser can write, in phases

| Phase | Writes | Needs |
|---|---|---|
| 1 | New files: plain, with a key, or with a password; several tables; embedded files | Providers, the async seal stage, deflate |
| 2 | Appends to an existing file (an offline outbox) | Reading the file's tail with the browser reader, then appending |
| 3 | Access-controlled files | The owner key in the browser (see 5.4): admin tools only |

## 5. Safety rules

1. **Platform crypto only:** WebCrypto for AES-GCM, PBKDF2 and ECDSA.
   - **No fallbacks:** if `crypto.subtle` or `crypto.getRandomValues` is
     missing (for example on plain `http://`), writing fails with a clear
     error. There is never a fallback to `Math.random` or JavaScript AES.
2. **Nonces:** a fresh random 12-byte nonce per section, as today. Each section
   also has its own derived key, so a nonce repeat is not a realistic risk.
3. **Keys stay in memory:**
   - The writer never stores a key in `localStorage`, cookies or URLs.
   - For an offline outbox, the app can keep a **non-extractable** WebCrypto
     key in IndexedDB. Scripts can use such a key, but can't read its bytes.
   - The writer derives section keys from it and drops raw bytes when done.
     JavaScript can't guarantee memory is wiped, and the guide will say so.
4. **No owner keys on phones:** the owner key can read and change everything.
   Field devices should write their own files with a per-user key or password.
   The server, which holds the owner key, folds them into the access-controlled
   file during its rebuild, as Collect's server already rebuilds today. Phase 3
   is only for admin pages, and its API will warn about this.
5. **Strict CSP:** the writer works under
   `Content-Security-Policy: script-src 'self'`. It uses no `eval` or
   `new Function` (the reader's fast path uses generated code, and already
   falls back without it).
6. **Supply chain:**
   - **Dependencies:** none.
   - **Publishing:** shipped in the same npm package, with provenance.
   - **CDN use:** a published SRI hash (`integrity="sha384-..."`), so a
     changed file is refused.
7. **Review:** the browser writer, reader and viewer join the scope of the
   external security review (S-4). Today the browser proof of concept is
   listed as out of scope.

## 6. Testing

- **Byte-for-byte equality:** with randomness replaced by a seeded source in
  tests, the browser writer and the Node writer must produce identical bytes for
  the same rows and options. That is the strongest possible check that the
  browser writes exactly what the reviewed library writes.
- **Interop:** every file the browser writer makes is read back by the Node and
  .NET libraries in CI. Fixtures are added to `spec/fixtures`.
- **Real browsers:** the viewer CI jobs (Chrome, Firefox, Safari) also write a
  file in the browser and read it back.
- **Fuzzing:** the readers' fuzzers run over browser-written files too.

## 7. Risks

1. **The owner's signing key:** the format derives it from the master key with a
   curve calculation. WebCrypto can't do that calculation directly.
   - **Options:** import the private key as PKCS#8 without its public part (some
     browsers fill it in, others may refuse), or compute the public point.
   - **Precedent:** .NET already computes it in its own code, which is review
     finding R14.
   - **Scope:** this only matters for phase 3. Phases 1 and 2 don't sign.
2. **Memory:** sealing is async, so the writer may hold one chunk's raw bytes
   while sealing. That is about the same as the Node writer today.
3. **Speed:** WebCrypto and `CompressionStream` calls have per-call overhead.
   Chunks are large (4,096 rows), so this should be small. We'll measure it.
4. **Old browsers:** Safari before 16.4 has no `deflate-raw`. Writing fails
   with a clear message there; files could be written without compression as a
   fallback, but are larger.

## 8. Size

| Work | Size |
|---|---|
| Providers and the async seal stage, Node unchanged | M |
| Browser providers, `createWriter`, phase 1 | M |
| Tests: byte equality, interop, browsers in CI | S–M |
| Phase 2 (appends) | M |
| Phase 3 (access-controlled, signing) | M, after risk 7.1 is settled |
| Security review of the browser code | External |

## 9. Questions for the owner

1. **What does hosted Collect write in the browser today?**
   - New files, or appends?
   - With which key: a per-user key, a password, or the owner key?
   - Where is the unofficial bundle's source, so we can see what it patched?
2. **Does any browser page need to write access-controlled files** (phase 3)?
   Or can the server always do that?
3. **Is Safari 16.4 (2023) as the oldest supported version acceptable?**
