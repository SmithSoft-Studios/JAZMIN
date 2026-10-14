# Locked embedded files: a second password or 2FA for stored files

Status: **proposal, awaiting the owner's decisions** (2026-10-14). Nothing here is built yet. It changes the file
format (an addition older readers handle gracefully, see "Compatibility"), so it is explained in plain words first.

## The idea in plain words

A JAZMIN file can store other files inside it: PDFs, photos, contracts. Today, whoever can open a part of the file
with their key can also open the stored files that part allows. If a key leaks, its stored files leak with it.

A **locked file** needs one more thing before its contents open:

- **a password** (separate from the key), or
- **a 2FA check with a key service** (the person signs in with an authenticator code, and the service hands back a
  one-time unlock), or both.

Someone with a leaked key then sees that the file exists (its name, type and size) but cannot open it without the
password or the 2FA check.

**What it can and cannot do.** It decides who can **open** a locked file at all. It cannot stop someone who has
opened it from keeping a copy: once the bytes are on their screen, a determined person can save or photograph them.
"View but not save" stays what it is today, a request viewers follow (the file's `actions`), not a guarantee. The lock
is the guarantee; the actions are the courtesy.

## How it works (for developers)

Each stored file is encrypted with its own random 32-byte key `K` (spec 6.8). Today `K` sits in the file directory, so
any key that opens the directory has it. A locked file keeps `K` out of the directory:

- **Password lock:** `K` is stored encrypted (AES-256-GCM) with a key made from the password: PBKDF2-SHA256 with
  600,000 iterations (the same as file passwords, 7.3) and a salt of its own. The library tries the password and, if
  it is right, gets `K`.
- **Online (2FA) lock:** `K` is stored encrypted with a key made from a random secret `S` (32 bytes) kept by the owner
  (in the owner directory, as online grants keep their `share`, 7.7) and given to the owner's key service. The service
  hands `S` out as a **file unlock token** only after its own checks: sign-in, 2FA, the person's grant, an audit
  record. This reuses the key service the library already has a sample of (`dotnet/samples/Jazmin.KeyService`,
  which does 2FA with authenticator codes).
- **Both:** the key is made from both the password and `S`.
- **Locks are named and shared:** one lock (say `contracts`) can cover several files, so one password or one 2FA check
  opens them all. Each lock has an id; a file names its lock.

A sketch of the directory entry (JSON, as in 6.8):

```json
"contents": [ {
  "id": 4, "size": 182044, "sha256": "<hex>", "blockSize": 262144,
  "lock": "contracts",
  "blocks": [ { "offset": 0, "length": 0, "digest": "<base64>" } ]
} ],
"locks": [ {
  "id": "contracts", "kind": "password", "salt": "<base64>", "iterations": 600000,
  "keys": { "4": "<K for content 4, encrypted with the password's key, base64>" }
} ]
```

**The API, as it would look:**

```js
write('claim.jzm', rows, { key, files: [{ path: 'contract.pdf', content: pdf, lock: 'contracts' }],
  locks: { contracts: { password: 'correct horse battery staple' } } });          // or { online: true }
reader.files;                                       // [{ path: 'contract.pdf', ..., locked: { id: 'contracts', kind: 'password' } }]
reader.readFile('contract.pdf');                    // throws "contract.pdf is locked: give its password"
reader.unlock('contracts', { password: '…' });     // or { unlockToken: 'jzf1-…' } from the key service
reader.readFile('contract.pdf');                    // the bytes
issueFileUnlockToken('claim.jzm', ownerKey, 'contracts');   // the key service, after its own 2FA check
```

The same in .NET (`JazminFileInput.Lock`, `JazminWriteOptions.Locks`, `reader.Unlock`, `JazminFile.IssueFileUnlockToken`).

**In the viewers:** the web viewer and Scout show a padlock beside a locked file, and **Unlock…** asks for the password
or starts the 2FA check with the key service the file names (an https origin in the package's settings, so a viewer
only ever contacts a service the file's owner chose). An unlock lasts while the file is open.

## Decisions for the owner

1. **Can the owner key open locked files without the password?** (the main choice)
   - **Yes (recommended):** the owner directory keeps a copy of each lock's key, readable only with the owner key. The
     owner can always open, change the password, re-lock, and rewrite the file (`update`, `compact`) normally. A leaked
     **access** key still opens nothing locked. Most real leaks are access keys, which are handed to many people; the
     owner key stays on the owner's server.
   - **No:** nobody without the password or 2FA can open, not even the owner. Strongest, but a forgotten password loses
     the file for good, and rewrites must copy locked files untouched (so they keep their key across versions).
   - For a file locked with a **key or password only** (not shared), the file's key is the owner key, so "yes" means
     the lock adds nothing against that key leaking. A shared file is where locks protect most.
2. **One password for everyone, or one per person?** One per lock is simplest. Per person (each grant gets its own
   password for a lock) suits "only Sam opens Sam's contract", at the cost of one encrypted copy of the key per person.
   Recommendation: one per lock first; per person later if needed.
3. **Are locked files' names visible?** Recommendation: yes (name, type and size, so viewers can show the padlock and
   people know what to ask for). Hiding them is possible by moving the entry itself into the lock, but then nobody knows
   the file exists until it is unlocked.
4. **Free or paid?** Recommendation: the lock itself (password and online) in the free libraries and the free web
   viewer, because a file must open the same everywhere; the hosted key service with 2FA, audit and a dashboard is the
   paid product (the suite's key service), and Scout's lock editor is Pro.

## Compatibility

- Format version stays 1.0. The new members are optional; files without locks are unchanged.
- **Older readers (1.0 to 1.5)** read the rows and every unlocked file as before. A locked file is listed, and opening
  it fails with "Embedded content … has no key", so nothing is ever shown wrongly. No reader feature is added, because
  that would make older readers refuse the whole file. To be checked against the published 1.5.0 of both libraries.
- Appends keep locks as they are. Rewrites keep them (with owner escrow they re-encrypt as now; without it, locked
  files are copied untouched).
- `rotateKey` (a new key without decoding rows) leaves locks as they are; changing a lock's password re-encrypts only
  the lock's keys, not the files.

## Threats and limits

- **Guessing the password offline:** whoever has the file and a key can try passwords as fast as PBKDF2 allows (600,000
  iterations: about 3 tries a second per core). Long passphrases are the defence; the online lock has no offline guessing
  at all, because `S` is not in the file.
- **Key service compromise:** whoever controls the service can hand out `S`. The service needs its own hardening (the
  suite's key service plan).
- **After unlocking:** see "What it can and cannot do" above.
- **Audit:** online locks give a record of who unlocked what and when (the service's log); password locks give none.

## Plan, once decided (each a PR, tests and profiling as usual)

1. Spec text (RFC section 6.8.1 "Locked files"), test vectors, and the compatibility check with published 1.5.0.
2. Password locks in both libraries: write, list, unlock, read; appends and rewrites; rotation; fuzzing of the new
   directory members.
3. Online locks: the owner's secret, `issueFileUnlockToken` (both libraries), the key service sample with 2FA.
4. The web viewer and Scout: padlock, Unlock…, the key-service check; Scout's lock editor (add, change, remove a lock).
5. Docs, wiki, benchmarks (the cost is one PBKDF2 per unlock, about 0.3 s by design; reading is unchanged).
