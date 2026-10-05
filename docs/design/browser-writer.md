# Design: keys in browsers, and an official browser writer (issue #13)

Status: **agreed with the owner on 5 October 2026**. Being built in steps (section 8).

## 1. Decisions

1. **A master key never goes into a browser for a shared file.**
   - **Shared file:** an access-controlled file, where each access key sees only
     its rows and columns.
   - **Who writes it:** a small filing service that the data owner runs. It
     keeps the master key in a vault.
   - **Phones and web pages** hold only access keys.
2. **The official browser writer writes one-key and password files only.** A
   phone uses it for the records it sends back. It refuses master-key work on shared
   files.
3. **The viewer and the browser reader refuse a master key for a shared
   file.** To browse everything, the owner gives themselves a full-read access
   key: it reads every row and column, but changes nothing.
   - **One-key files still open with their key:** that key is the file's only
     key.
4. **Offline capture is supported:**
   - phones save records in an outbox and send them when online;
   - the filing service adds them to the shared file.

**Why:** the master key can read everything, change the file, and give or take
away anyone's access, and it can't be revoked. A browser page is the easiest
place to steal a key from: extensions, injected scripts, whoever serves the
page, or malware reading browser storage. A stolen access key is limited to its
own rows and can be locked out. A stolen master key can't.

## 2. Kinds of file, and who can write

| Kind of file | Who can read | Who can write | In a browser |
|---|---|---|---|
| **Shared** (access-controlled) | Master key: everything. Each access key: its granted rows and columns | Only the master key | Read with access keys. Never written. |
| **One key** | Whoever has the key | Whoever has the key: it's the file's only key | Read and written with that key |
| **Password** | Whoever knows the password | Same | Read and written |
| **Unencrypted** | Anyone | Anyone | Read and written |

A `jzk1-` key is either the only key of a one-key file, or the master (owner)
key of a shared file. The rules depend on the kind of file, not on how the key
looks.

## 3. How field capture works

```
Phone (holds an access key)              Filing service (holds the master key, in a vault)
  capture ─► batch: a one-key .jzm,      check the sender ─► append to the shared file
            .jzm, locked with the        and the fields      compact and regroup now and then
            submission key (section 4)
          ─► send when online ──────────►
Readers (access keys) ◄── read the shared file in the browser ◄── storage holds only encrypted data
```

- **Batches:** each batch is a small `.jzm` file, made with the official
  browser writer. It's compressed and checked against the fields before it
  leaves the phone.
- **Sending:** the upload is named with the sender's access key id. That id is
  public, and safe to log.
- **Filing:**
  1. The service finds that person's access key in the shared file's grant list.
  2. It derives their submission key and opens the batch. A batch that doesn't open
     was not made with that key, so it's refused.
  3. It writes the rows into **that person's own partition**, whatever the
     batch says. A person can't file rows as someone else.
  4. It appends them to the shared file, with `compact({ regroup: true })` now
     and then.
- **Revoking:** once a key is revoked, the owner removes its grant, and the
  service refuses its batches.
- **Duplicates:** each record carries an id, so a batch sent twice isn't filed
  twice.
- **iPhone storage:** Safari clears a website's saved data after about 7 days
  without use, unless the app is installed to the home screen. Install it, and
  sync often.

## 4. The submission key

Agreed on 5 October 2026: a file sent back must show that the sender opened the
shared file, not just that someone holds a (possibly leaked) access key. So
each access key's **submission key** comes from the owner and is delivered
inside the shared file:

```
submission key = HKDF-SHA256(ikm = owner key, salt = empty, info = "JAZMIN/1/submission/" + access key id, length = 32)
```

- **Delivery:** the writer seals it into that access key's slot of the shared
  file, as the bundle field `submission`.
- **Who has it:** the holder, only after opening the shared file with their
  access key (plus the unlock token for an online grant). The owner derives
  it from the owner key and the key id, and needs no storage.
- **Proof:** a file locked with it was made by someone who opened the shared
  file with that key. A leaked access key without the file can't make one.
  - **What still gets through:** a thief who also has a copy of the file.
    Against that, use online keys (unlock tokens from your key service, behind
    sign-in) and keep the shared file behind sign-in.
- **Stable:** it never changes, so files made offline stay valid across
  rewrites and compaction. Revoking a key removes its grant, and the filing
  service then refuses its files.
- **What it can't do:** it opens nothing in the shared file. Neither the
  owner key nor the access key can be worked out from it.
- **Older shared files:** they have no `submission` field until the owner's
  next rewrite. Readers that don't know the field ignore it.
- **Format:** it is defined in the spec's section 7.8. It's a key and an
  optional bundle field, not a change to the file format.

API:
- **Holder:** `reader.submissionKey` (JS, .NET `SubmissionKey`, and the
  browser reader as key text), after opening the shared file.
- **Owner:** `ownerKey.submissionKey(keyId)` (.NET `SubmissionKey(keyId)`).
- **Grant check:** `accessKeyOf(path, ownerKey, keyId)` finds the key in the
  grant list.

## 5. The browser writer

**What it writes:**
- One table: columns of any type, rows and metadata.
- Embedded files (added 5 October 2026): photos and PDFs captured with the
  records, several per record, from a `File`, `Blob`, bytes or text.
- Locking: a key, a password, or none.
- Compression: deflate or none.

It refuses an access-controlled file. Not written: indexes, several tables,
viewer package settings, `sortedBy` and appends. The filing service adds
indexes when it compacts the shared file.

```js
const writer = await JazminBrowser.createWriter({ columns, key: reader.submissionKey });
await writer.writeRows(records);
const blob = await writer.finish();    // upload it as the batch
```

**How it's built:** the same way as the browser reader, as a standalone part of
`js/browser/jazmin-browser.js`.
- **Why standalone:** browsers' built-in crypto (WebCrypto) is async-only, while
  the Node writer is synchronous and tuned for speed. Sharing code would mean
  reworking it.
- **Why it stays simple:** without shared files there are no key slots or
  signatures, so the writer is small.
- **What it uses:** WebCrypto for AES-256-GCM, HKDF, HMAC, SHA-256 and PBKDF2,
  and `CompressionStream('deflate-raw')` for compression. Nothing else, no
  third-party code, and no curve code.
- **How we know it matches:** CI checks that it writes exactly what the Node
  writer writes. The Node and .NET libraries also read back every file it makes.

## 6. Safety rules

1. **Platform crypto only:**
   - **Randomness:** `crypto.getRandomValues`.
   - **Encryption and hashing:** `crypto.subtle`.
   - **No fallbacks:** without them, for example on plain `http://`, writing
     fails with a clear error. There's never a fallback to `Math.random` or
     JavaScript AES.
2. **Nonces:** a fresh random 12-byte nonce for every section, which has its own
   derived key, as in the libraries.
3. **No keys in storage:**
   - The writer never puts a key in `localStorage`, cookies or URLs.
   - An app that keeps a person's access key for offline use should keep it on
     that device only, preferably in an app installed to the home screen.
4. **Master keys:**
   - **Writer:** refuses access-controlled files.
   - **Viewer and browser reader:** refuse a master key for a shared file.
5. **Strict CSP:** works under `Content-Security-Policy: script-src 'self'`. No
   `eval` or `new Function`.
6. **Supply chain:** no dependencies, shipped in the npm package with
   provenance, and a published SRI hash for CDN use.
7. **Review:** the browser writer, reader and viewer join the external security
   review (S-4).

## 7. Testing

- **The same bytes as Node:** with the same rows, options and random bytes, the
  browser writer and the Node writer produce identical files. This is checked
  in Node's own WebCrypto, with and without compression.
- **Interop:** the Node and .NET libraries read every file it writes. Wrong keys
  and passwords are refused.
- **Real browsers:** the viewer jobs in CI also write a file in Chrome, Firefox
  and Safari and read it back. So does the iPhone simulator, when run.
- **Refusals:** a shared file is refused by the writer, and a master key for a
  shared file by the viewer and the browser reader.

## 8. Steps

| Step | What | Size |
|---|---|---|
| 1 ✅ | The viewer and browser reader refuse a master key for a shared file (#48) | S |
| 2 ✅ | Submission key: spec, JS, .NET, browser; `accessKeyOf` (#49, then sealed in the key slot) | S |
| 3 ✅ | The browser writer (section 5), with its tests | M |
| 4 ✅ | A reference filing service (Node sample, `js/examples/filing-service`): master key from a secret, batches checked and appended, regroup | S–M |
| 5 ✅ | Files with records: the browser writer embeds files; the filing service checks each record's list, the kind of file (first bytes) and sizes, and stores them at paths it chooses, for the record's partition | M |

## 9. What the hosted Collect demo showed (for the record)

- **How it works:** hosted Collect writes the shared file in the owner's
  browser, with the master key. It uses an unofficial build of the 1.0.0
  library in which Node's modules were swapped for @noble crypto, fflate and the
  npm `buffer` package.
- **What's sound:**
  - the swaps use the browser's secure randomness;
  - the @noble libraries are publicly audited;
  - the library itself wasn't changed.
- **The weak points:**
  - **The master key** is kept in the browser's `localStorage` by default.
  - **The zlib replacement** checks the size limit only after decompressing
    everything, so a malformed file can use a lot of memory before it's
    refused.
  - **No tests** compare the swapped modules with Node's own.
- **Browser support:** a browser's built-in crypto can derive the master key's
  signing key in Chrome and Edge, but not in Firefox or Safari (tested 5 October
  2026). That gap no longer matters, because browsers don't sign shared files.
- **Status:** hosted Collect remains a demo. Customer deployments use the
  filing service.
