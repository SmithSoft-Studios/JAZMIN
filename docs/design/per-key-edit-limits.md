# Per-key limits on what a key may send back (#257)

Status: **design approved by the owner on 2026-10-20 (issue #257: all four decisions as recommended).** Not yet built. It changes what is written
in a file (a new grant member, a new `package` member and a new writer feature), so it is explained in plain words
first. The spec text is in [Appendix A](#appendix-a-proposed-spec-text-draft-not-normative) of this note, not in
`docs/rfc/draft-jazmin-format-03.md`, so that merging this note changes nothing normative. It moves into the spec only
after approval.

## The idea in plain words

A shared file's owner already decides what each key **sees**: which rows (partitions), which columns (column groups),
which stored files, and until when. What a key may **send back** through the file's document (a change file, spec
7.9) is set once for the whole file, by the document's `package.edit`. Every key that sees a row and a column can send
any change `package.edit` allows.

**The healthcare example (found while building Scout's starter packs).** A hospital shares one file with an `acks`
table: acknowledgements of critical lab results. A doctor's key and an infection-control key both see the rows of
their wards. `package.edit` lets the document set `ackAction` and `ackNote`. Only doctors should acknowledge a result
(`ackAction`); infection control may only add a note (`ackNote`). The page shows infection control no "Acknowledge"
button, but that is only the page. Someone with the infection-control key and `writeChanges` can still send an
acknowledgement, and `applyChanges` applies it, because nothing in the file says that key may not. Today owners work
around it with one file per role, which multiplies files.

**What this adds.** Each grant may carry a limit, `edit`, that **narrows** what `package.edit` allows for that key:
fewer columns, no adding, no deleting. It can never widen. The owner's `applyChanges` refuses a change outside the
sender's limit, the sender's `writeChanges` refuses to make it, and a viewer tells the person what their key may change
before they save.

```json
{ "key": "jza1-...", "rows": ["W1", "W2"], "edit": { "columns": ["ackNote"], "add": false, "delete": false } }
```

**What it can and cannot do.** The limit is enforced where changes are applied: by the owner's library. A key holder
can always *write* any change file they like; the limit decides whether the owner's software *applies* it. So the
limit is only as good as the software that applies change files, which is why much of this note is about old releases
("The safety question"). The short answer: with this design, **no published release applies a change file to a file
with limits**, and every published release can still **read** it.

## How it works (for developers)

### 1. Where the limit is stored, and why

The limit is stored in **two places**, as expiry already is (spec 7.7):

1. **The owner directory's grant** (spec 7.6.5, encrypted with the owner's secret): the copy `applyChanges` uses. The
   owner's software already finds the sender's grant there, so this is the authoritative copy.
2. **The key slot's sealed bundle** (spec 7.6.4, sealed for that key only): a copy for the key holder, so their
   `writeChanges` and their viewer know what they may send. No other key, and nobody without a key, can read it.

The owner never trusts the bundle copy. A key holder who edits their own copy of the file changes nothing that
matters: the owner applies with the owner directory's copy, from the owner's file.

**The member, exactly.** Both copies hold the same JSON value, member name `edit`:

```json
"edit": { "columns": ["ackNote"], "add": false, "delete": false }
```

| Member | Type | Absent means | Meaning |
|---|---|---|---|
| `columns` | array of distinct, non-empty column names | every column `package.edit` allows | the columns this key may set |
| `add` | `true` / `false` | as `package.edit.add` | whether this key may add rows |
| `delete` | `true` / `false` | as `package.edit.delete` | whether this key may delete rows |

- `edit: {}` narrows nothing: the key may do what the document allows (written for keys without a limit, below).
- `edit: { "columns": [], "add": false, "delete": false }`: the key may send nothing (a read-only key).
- Any other member, or a member of another type, makes the limit **malformed**: writers refuse it; readers treat the
  grant as "may send nothing" (fail closed) and the owner's grants list says so.
- The names are columns of the table the document edits (`edit.table`, else the first table).
- In the owner directory the member sits beside `rows`, `columns`, `files`, `label`, `expires`, `mode` and `share`:
  `{ "key": "jza1-...", "rows": [...], "columns": "*", "label": "...", "mode": "offline", "edit": { ... } }`.
- In the bundle it sits beside `expires`, `online`, `files`, `submission` and `masks`:
  `{ "header": "...", "partitions": {...}, "partitionNames": {...}, "columns": {...}, "submission": "...", "edit": { ... } }`.
- Writers write the members in the order `columns`, `add`, `delete`, and only those given, so two writers write the
  same bytes.

**When any grant has a limit, the document's settings move to `package.editByKey`.** When at least one grant of a
shared file has a limit that narrows something, writers:

- store the document's settings (the same object as today's `package.edit`: `table`, `key`, `columns`, `add`,
  `delete`) as **`package.editByKey`**, and leave `package.edit` out;
- write `edit` on **every** grant, in both copies (`{}` for a key without a limit);
- name the writer feature **`edit-limits`** in the header (spec 12).

When no grant narrows anything (the owner removed the last limit), writers store `package.edit` again and drop
`editByKey`, the `edit` members and the feature, so the file is exactly what it would have been without this feature.

The move is the safety mechanism (see "The safety question"): every published release looks for `package.edit`, finds
none, and so treats the document as one that takes no changes. It refuses to apply change files, and its viewers offer
no editing, rather than applying more than the owner meant. Writing `edit` on every grant lets 1.8 tell "this key has
no limit" (`{}`) from "an older release lost this key's limit" (no member): in an `editByKey` file a grant **without**
`edit` may send nothing.

For callers nothing moves: the owner still gives `package.edit`, and release 1.8 readers give the settings back as
`reader.package.edit` from whichever member is stored. The stored member name is a format detail.

**Why not elsewhere.** A column group can't express it: a group the key reads is also a group it may change. The
document page can't: it's only the page. `package.edit` can't: it is one setting for every key. The owner directory
alone would do for `applyChanges`, but the sender's viewer couldn't warn them; the bundle alone would be readable only
with each access key, and the owner would have to unseal every slot.

### 2. How it combines with `package.edit`: the intersection

For a sender with grant `g` on the table the document edits, the **effective** settings are:

```
columns = document.columns ∩ (g.edit.columns, or all) ∩ the columns of g's column groups in that table
add     = document.add    and (g.edit.add, or true)
delete  = document.delete and (g.edit.delete, or true)
```

where `document` is `package.edit` or `package.editByKey`, and, as today, rows only in `g`'s partitions. The owner's
**current** document settings and the grant's **current** limit apply when the change file is applied, not when it was
written, as `package.edit` already works (spec 7.9).

| Case | Writers (`write`, `update`, `append`, `grantAccess`) | `writeChanges` (sender) | `applyChanges` (owner) |
|---|---|---|---|
| Grant without `edit`, file without `editByKey` | as today | as today | as today: `package.edit` ∩ grant's rows and groups |
| Grant without `edit` in an `editByKey` file (an older release dropped it) | a rewrite keeps it so and the grants list reports it; the owner grants the key again | refuses: "This key's limits were lost: ask the file's owner to grant it again" | refuses every change: "this sender's limits were lost when an older release rewrote the file: grant the key again" |
| Grant narrower (`columns: ["ackNote"]`) | written | refuses `ackAction`: "Column 'ackAction' can't be changed with this key" | refuses the change: "column 'ackAction' can't be changed by this sender" (today's wording) |
| Grant tries to widen (a column the document doesn't allow, or `add: true` when the document has `add` false) | refused when the grant is given: "grant 2: edit can only narrow the document's: 'patient' isn't an editable column" / "… the document doesn't allow adding rows". A limit **carried** from before (the owner narrowed the document later) is kept and simply has no effect | the document's setting wins | the document's setting wins |
| Grant's limit names a column outside its column groups | refused when given: "grant 2: edit.columns: 'ackAction' isn't in a column group this key sees". Carried after the groups changed: kept, no effect | the key doesn't see the column: refused as today | refused as today ("column … can't be changed by this sender") |
| Table the grant can't see (no partition of the edited table granted, or the key columns in a group it lacks) | written: the limit is about changes, not reading | refuses as today ("No row … is visible", "The key column … isn't visible") | refuses as today (partition not granted) |
| `add: false` on the grant | written | refuses `add` lists: "This key can't add rows" | refuses each add: "this sender's grant doesn't allow adding rows" |
| `delete: false` on the grant | written | refuses `delete` lists: "This key can't delete rows" | refuses each delete: "this sender's grant doesn't allow deleting rows" |
| Read-only key (`columns: []`, no add, no delete) | written | refuses any change: "This key can't send changes to this document" | refuses each change with the reason for its operation |
| Malformed limit (unknown member, wrong type) | refused when given | as a read-only key | as a read-only key: "this sender's grant has a limit this library can't read"; the grants list marks it |
| The owner removes the document's edit settings | the limits stay in the grants (so they are back if the document is made editable again); `editByKey` goes | as today: "doesn't allow changes" | as today: refused |
| The owner key | limits don't apply: the owner changes the file directly | as today (owner refused) | n/a |
| A change outside the limit, with `overwrite: true` | n/a | n/a | still refused: `overwrite` releases held conflicts, never refusals |

Order of checks in `applyChanges`, for each change: the operation against the document, then against the grant's
limit, then the columns it sets against the effective columns, then partitions, then conflicts. So a change outside the
limit is **refused**, never held as a conflict.

### 3. How grants, `grantAccess`, `update`, `append` and compaction carry it

**What each API does with grant members today** (read in `js/src/update.js`, `js/src/append.js`, `js/src/rotate.js`,
`js/src/access.js`, `js/src/writer.js`, and `dotnet/src/Jazmin/JazminFile.cs`, `JazminWriter.cs`, `JazminAccess.cs`, on
`main`):

| API | JavaScript today | .NET today |
|---|---|---|
| Writers (`write`, every rewrite and append) | `normalizeGrants` keeps exactly `key, rows, columns, files, label, expires, mode, share`; `#ownerDirectoryText` and `#keySlots` write only those. **Any other member is dropped** | `JazminGrant` has exactly `Key, Rows, Columns, Label, Expires, ExpiresIn, Mode, Files, Share`; the owner directory and slots are written from it. Same |
| `update`, `compact` (no grants given) | `accessFor` keeps each grant as read (`...g`), then `normalizeGrants` drops unknown members | `AccessFor` builds a new `JazminGrant` per grant from the listed members |
| `update({ grant })`, `append({ grant })` | the new grant **replaces** the old one whole (`grants.set(id, g)`) | the same (`grants[grant.Key.Id] = grant`) |
| `grantAccess(path, owner, key, { rows, columns, label })` | passes only `rows`, `columns`, `label`: **re-granting an existing key drops its label if not given, its expiry, its online mode and its file groups.** Checked on `main`: a grant `{ rows: ['W1'], label: 'k', expires: 2099, mode: 'online', files: ['extra'] }` given `grantAccess(…, { rows: ['W1', 'W2'] })` became `{ rows: ['W1', 'W2'], mode: 'offline' }` | `GrantAccess(path, owner, JazminGrant)` replaces the grant with the caller's, which the caller fills in (every public member) |
| `append` narrowing | `checkAppendGrants` refuses fewer rows, columns or files, a new or earlier expiry, offline to online (they need fresh secrets) | `CheckAppendGrants`, the same |
| `rotateOwnerKey` | copies `rows, columns, files, label, expires, mode` to each new key | the same members |
| `revokeAccess` | removes the grant | the same |
| `reader.access.grants` / `JazminGrantInfo` | a fixed projection: `keyId, rows, columns, label, mode, expires, files` | the same |

**What each must do for `edit`:**

- **Writers** keep `edit` in both copies (normalized as in section 1) and store the document's settings as `edit` or
  `editByKey`, with or without the feature, as section 1 says, on every write: `write`, `update`, `compact`, `append`,
  `rotateOwnerKey`, `revokeAccess`.
- **A grant given again** (`update({ grant })`, `append({ grant })`, `grantAccess`) for a key that already has one:
  **`edit` not given keeps the existing limit.** Only `edit: null` (JS) or `Edit = JazminEditLimit.None` (.NET) removes
  it. This is the one place where the design deliberately doesn't follow today's "replace whole" rule: a dropped limit
  widens what a key may do, silently. (Today's `grantAccess` drop of expiry, mode and files is the same kind of
  widening; it is outside this task, see "Noticed, not changed".)
- **`grantAccess`** takes `edit` (JS: `{ rows, columns, label, edit }`; .NET: `JazminGrant.Edit`).
- **`append` may narrow or widen a limit.** Unlike rows and columns, a limit is not protected by secrets: the owner
  enforces it when applying, from the owner directory, so an append that writes the new owner directory and key slots
  is enough. `checkAppendGrants` must not count a narrower `edit` as narrowing.
- **Compaction and rotation** carry it; `rotateOwnerKey` copies it to the new key's grant.
- **Expired and revoked grants** go, with their limits, as today.
- A file **without** limits is written as today: `package.edit`, no `edit` members, no feature.

**APIs, as they would look:**

```js
write('acks.jzm', rows, { key: owner, files, package: { entry: 'index.html', edit: { key: ['ack'], columns: ['ackAction', 'ackNote'] } },
  access: { partitionBy: 'ward', grants: [
    { key: doctor, rows: ['W1', 'W2'] },
    { key: ipc, rows: ['W1', 'W2'], edit: { columns: ['ackNote'], add: false, delete: false } },
  ] } });
grantAccess('acks.jzm', owner, ipc, { rows: ['W1', 'W2', 'W3'] });          // keeps ipc's limit
grantAccess('acks.jzm', owner, ipc, { edit: null });                        // removes it
reader.access.grants;   // owner: [..., { keyId, rows, columns, mode, edit: { columns: ['ackNote'], add: false, delete: false } }]
reader.access.edit;     // the key holder: its own limit, as written (or undefined)
reader.edit;            // anyone: what this key may send now (the intersection), { table, key, columns, add, delete }, or null
```

```csharp
new JazminGrant(ipc) { Rows = ["W1", "W2"], Edit = new JazminEditLimit { Columns = ["ackNote"], Add = false, Delete = false } };
reader.Access.Grants[i].Edit;   // JazminEditLimit? (owner); reader.Access.Edit (key holder); reader.Edit: JazminEditSettings? (the intersection)
```

### 4. How `applyChanges`, `writeChanges` and the browser reader enforce it

- **`applyChanges`** (`js/src/changes.js`, `dotnet/src/Jazmin/Changes.cs`): takes the document's settings from
  `package.edit` or `package.editByKey`, reads the sender's grant from the owner directory (as now), works out the
  effective settings (section 2), and checks each change against them. The `mayWrite` test gains the limit's columns;
  two operation checks follow the document's. In an `editByKey` file, a sender whose grant has no `edit` has every change
  refused.
- **New `refused` reasons** (the same text in both libraries):
  - `"this sender's grant doesn't allow adding rows"`
  - `"this sender's grant doesn't allow deleting rows"`
  - `"column 'ackAction' can't be changed by this sender"` (today's wording: the limit is one more reason for it)
  - `"this sender's limits were lost when an older release rewrote the file: grant the key again"`
  - `"this sender's grant has a limit this library can't read"` (malformed)
- **`writeChanges`** (both libraries) and **`JazminBrowser.writeChanges`** check against `reader.edit` (the
  intersection) instead of `package.edit`, and list the effective columns in the change file's metadata `columns`.
  Messages: `"This key can't add rows"`, `"This key can't delete rows"`, `"Column 'ackAction' can't be changed with this
  key"`, `"This key can't send changes to this document"`, `"This key's limits were lost: ask the file's owner to grant
  it again"`. The change file format is unchanged (version 1).
- **The browser reader** reads the bundle's `edit` and `package.editByKey`, and gives `reader.edit` and
  `reader.access.edit` as the library does.
- **The web viewer** passes `reader.edit` (not the package's settings) to the page as `jazmin.edit`, so a page that
  draws its buttons from `jazmin.edit` hides what the key can't do. `saveChanges` rejects a change outside it with the
  messages above, **before** making the change file. The review dialog says, above the list of changes: "With your key
  you can change: ackNote. You can't add or delete rows." For a key whose limit was lost it says "Your key's limits were
  lost: ask the file's owner to grant it again" and offers no saving.
- **Older viewers** (1.4 to 1.7.1) find no `package.edit` in such a file: `jazmin.edit` is null, so the page offers no
  editing and `saveChanges` rejects ("This document can't save changes here"). The person reads the file as before but
  sends changes only from a 1.8 viewer.

### 5. What Scout and the owner's grants list show

- **`reader.access.grants` / `JazminGrantInfo`** gain `edit` (`JazminEditLimit? Edit`), as the file has it (no `edit`
  for a grant without a limit, also where the file stores `{}`), and `editLost: true` / `EditLost` for a grant of an
  `editByKey` file that has none (an older release rewrote the file).
- **Scout's Manage Access** (built outside this repository; this is what the libraries give it): beside each key's
  rows, columns, files and expiry, a "Can send back" line: "everything the document allows", "ackNote only; no adding,
  no deleting", or "nothing". Its editor offers only the columns the document allows that the key's column groups
  contain, and add or delete only when the document allows them, so it can't make a widening limit. A key with
  `editLost` shows a warning and "Grant again". When the owner sets the first limit, Scout says once: "With send-back
  limits, this file takes changes only through JAZMIN 1.8 or later: older viewers can still read it but can't send
  changes, and older libraries won't apply or modify it."

## The safety question: releases 1.0 to 1.7.1

**How it was researched.** The npm packages 1.0.0 to 1.7.1 were installed from npmjs.com; their `src/` is byte for
byte the `js/src` of tags `v1.0.0` to `v1.7.1`. The NuGet packages 1.4.0 to 1.7.1 name, in their `.nuspec`, exactly the
commits of those tags, so the .NET answers come from reading that tagged source. A scratch copy of today's library
(never committed) was patched to write the proposed `edit` member in both places, with, in turn: nothing more; a
writer feature; a reader feature; a new setting inside `package.edit`; and the settings moved to `package.editByKey`.
The infection-control key made a change file outside its limit (set `ackAction`, add a row, delete a row), and each
published npm release opened the file (library and browser reader), applied the change file (with and without
`dryRun`), and ran `update`, `append`, `compact` and `grantAccess` for another key; the scratch copy then read what was
left. The .NET packages could not be run here: the .NET SDK can't be downloaded in this environment.

**What old releases do (measured in JS; read in the .NET source):**

1. **Readers ignore an unknown bundle member** (spec 7.6.4 says MUST): every release 1.0.0 to 1.7.1 opened the file
   with the limited key, in the library and the browser reader.
2. **`applyChanges` (1.4 to 1.7.1, both libraries) can't see a grant's limit.** It takes the sender's grant from
   `reader.access.grants` / `JazminGrantInfo`, a fixed list of members. With the limit alone, JS 1.4.0, 1.5.0, 1.6.0,
   1.6.2, 1.7.0 and 1.7.1 each applied all three changes (`updated 1, added 1, deleted 1, refused 0`): the limit
   **fails open**.
3. **Every writer drops the limit.** JS and .NET 1.0.0 to 1.7.1 rebuild grants from a fixed list (section 3). In JS,
   every release's `applyChanges`, `update`, `append`, `compact` and `grantAccess` left the file without `edit` in the
   owner directory and the key slot. An append rewrites the owner directory because its text differs from the stored
   one (JS `#ownerDirectoryText`, .NET `OwnerDirectoryText`, both compare the text). One old write removes the limit for
   good, silently.
4. **Writer features are checked only from 1.7.0.** `checkWriterFeatures` (JS) and `CheckWriterFeatures` (.NET) refuse
   in `append`, `update` (so `compact`, `grantAccess`, `revokeAccess`, `rotateOwnerKey`) and `rotateKey`. JS 1.0 to
   1.6.2 define `SUPPORTED_WRITER_FEATURES` but never read it; .NET 1.0 to 1.6.2 have no check. `applyChanges` writes
   through `append`, so 1.7 refuses there too, but only **after** planning: a `dryRun` still reports the changes as if
   they would apply. Full rewrites in 1.0 to 1.6.2 drop the writer features (they copy them only when appending).
5. **Reader features are checked by every release.** JS 1.0.0 to 1.7.1 (library and browser reader) refused to open
   the file with any key, owner's included: "This file needs the '…' feature, which this JAZMIN reader does not
   support". .NET has the same check from 1.0.0 (`JazminReader`, `SupportedReaderFeatures`).
6. **A new setting inside `package.edit`:** JS 1.4.0 to 1.7.1 read the file, and every write refused it ("package.edit:
   unknown setting …"), but `applyChanges` with `dryRun` still reported the changes. **.NET would not refuse:** it copies
   the stored package as it is when appending (`ApplyChanges` included), and `EditFrom` ignores unknown members, so .NET
   1.4 to 1.6.2 would apply everything. Rejected for that reason.
7. **The settings moved to `package.editByKey`** (no `package.edit`): JS 1.4.0 to 1.7.1 `applyChanges` and its `dryRun`
   refused: "The file doesn't take changes: its document has no package.edit". .NET 1.4.0 to 1.7.1 `ApplyChanges` read
   `Package.Edit` from the `edit` member only (`EditFrom(o["edit"])`), so it refuses with the same message. Old readers
   give the key holder `package.edit` null, so old viewers offer no editing.

**What each release does with a file made by the recommended design** (`package.editByKey`, `edit` on every grant,
writer feature `edit-limits`):

| Release | Read (any key; library, browser reader, viewer) | `applyChanges` | `update`, `compact`, `grantAccess`, `append` |
|---|---|---|---|
| JS 1.0 to 1.3 | reads; no editing offered | doesn't exist | rewrites, dropping the limits and `editByKey`: the document then takes no changes (closed; measured) |
| JS 1.4 to 1.6.2 | reads; no editing offered | **refuses**, `dryRun` too (measured) | rewrites, dropping the limits and `editByKey`: closed (measured) |
| JS 1.7.0, 1.7.1 | reads; no editing offered | **refuses** (measured) | **refuses** (writer feature), file unchanged (measured) |
| .NET 1.0 to 1.3 | reads | doesn't exist | a full rewrite rebuilds the package from `JazminPackage`, which has no `edit` before 1.4: settings dropped, closed. An append copies the package as it is (keeps `editByKey`) and drops the limits: 1.8 refuses those keys until granted again (closed). By source |
| .NET 1.4 to 1.6.2 | reads; no editing offered | **refuses** (no `package.edit`). By source | full rewrite: `JazminPackage` has `Edit` from `edit` only, so `editByKey` is dropped: closed. Append: keeps `editByKey`, drops the limits: closed (1.8 refuses those keys). By source |
| .NET 1.7.0, 1.7.1 | reads; no editing offered | **refuses** | **refuses** (writer feature). By source |

So **no published release applies more than the owner meant**, and every one still reads the file. What an old release
can still do is lose the settings: a 1.0 to 1.6.2 rewrite leaves a document that takes no changes, or keys that may send
nothing. That is visible (the owner's 1.8 shows `editLost`, or the document is no longer editable) and is mended with
1.8, never a silent widening. One case stays the owner's own act: an owner who sets **new** document settings with an
old release (`update({ package: { edit } })`) makes an ordinary editable document without limits, as they asked; the
release notes say to set document settings of files with limits with 1.8.

### The options compared

| | 1. Writer feature only | 2. Reader feature | 3. 1.8 only, documented | **Recommended: settings in `package.editByKey` + writer feature + fail closed** |
|---|---|---|---|---|
| An old `applyChanges` applies too much | JS and .NET 1.4 to 1.6.2 | never (can't open) | 1.4 to 1.7.1, both | **never** |
| Old writes remove the limits | silently, 1.0 to 1.6.2 (both) | never | silently, every release | never silently: the document stops taking changes, or the keys are refused and flagged, until the owner mends it with 1.8 |
| Old readers still read the file | yes | **no: every key on 1.0 to 1.7.1 loses read access** (library, browser reader, a cached web viewer, older Scout builds) | yes | yes |
| Old viewers let people send changes | yes, outside the limit (then applied by old owners) | no | yes, outside the limit | no (they see a document that takes no changes) |
| Cost | one feature name | locks every existing reader out of the file until it upgrades | none, and the limit is unsafe | one feature name, the settings under another member name, `edit: {}` on grants without a limit |

**Recommendation: settings in `package.editByKey`, the writer feature `edit-limits`, and fail closed.** Moving the
document's settings is what makes every published release, in both libraries, treat the file as one that takes no
changes: no old `applyChanges` applies anything, and no old viewer offers a change it can't check. The writer feature is
the spec's own mechanism (as file locks and masked columns use it): it keeps 1.7 from rewriting the file and losing the
limits, and it tells future writers what they must keep. Writing `edit` on every grant, and refusing a grant without one,
turns what old appends do (drop the limits but keep the package as it is) into "may send nothing" rather than
"unlimited". A reader feature would also be safe, but costs every key holder on every older release their read access,
for a risk this design already removes. Option 1 alone leaves the JS and .NET 1.4 to 1.6.2 libraries applying
everything; option 3 leaves every release doing so.

**Cost to existing users:** none until an owner sets a limit. A file without limits is unchanged and works with every
release as today. Once an owner sets a limit on a file, that file takes changes only through 1.8 or later (viewers,
`writeChanges`, `applyChanges`), and is modified only by 1.8 or later; every release still reads it.

## Compatibility

- Format version stays 1.0. The new members are optional. **A file without limits is written as today** (`package.edit`,
  no `edit` members, no feature). Removing the last limit returns a file to that form.
- Older readers read such files; older writers refuse them or fail closed (above).
- Change files are unchanged (version 1). A change file made by any release since 1.4 can be applied by 1.8: it is
  checked against the sender's current limit. (Older viewers can't make one for a file with limits, since they see no
  editable document.)
- **Every existing fixture must still pass, unchanged:** `js-` and `dotnet-` `plain`, `brotli`, `key`, `password`,
  `access`, `appended`, `appended-access`, `many-partitions-access`, `nested`, `nested-grown`, `paged-key`,
  `paged-compact`, `files-key`, `files-access`, `document-key`, `edit-key`, `edit-changes` (applied to `edit-key`),
  `shapes-key`, `shapes-access`, `tables`, `tables-access`; `browser-plain`, `browser-key`, `browser-password`,
  `browser-files-key`; every file in `spec/fixtures/damaged/` (refused as now) and `spec/fixtures/publisher/` (as its
  `expected.json` says); and the JSON fixtures (`dataset.json`, `keys.json`, `nested.json`, `nested-filters.json`,
  `saved-shapes.json`, `shape.json`, `shape-expected.json`, `shape-links.json`, `shape-links-expected.json`,
  `sort-orders.json`).

## Test plan (for the build, after approval)

**New fixtures** (from a new `spec/fixtures/edit-limits.json`, written by `make-fixtures.js` and by the .NET interop
tests with `JAZMIN_WRITE_FIXTURES=1`; new test keys added to `keys.json`, made up and published on purpose):

- `js-edit-limits-access.jzm`, `dotnet-edit-limits-access.jzm`: the `acks` table, wards `W1` to `W3`; a doctor key
  without a limit, an infection-control key limited to `ackNote` (no add, no delete), a read-only key, and a key whose
  limit names a column the document no longer allows (carried).
- `js-edit-limits-changes.jzm`, `dotnet-edit-limits-changes.jzm`: the infection-control key's change file setting
  `ackAction` and `ackNote`, adding a row and deleting one, made by hand with the submission key (as a sender who
  bypasses `writeChanges` would).
- `js-edit-limits-lost.jzm`, `dotnet-edit-limits-lost.jzm`: the same file with `editByKey` but the infection-control
  grant without `edit` (what a .NET 1.0 to 1.6.2 append leaves), made by a test-only hook.

**Both libraries, and the browser reader where it applies**, read and apply each fixture written by either library,
with identical `refused` lists (operation, key and reason text) and identical rows afterwards:

- each row of the table in section 2, as a test of its own in `changes.test.js` and `ChangesTests.cs`;
- `writeChanges` refuses outside the limit (library and `JazminBrowser.writeChanges`), with the messages above;
- `reader.edit`, `reader.package.edit` (from either member), `reader.access.edit`, `reader.access.grants[i].edit` and
  `editLost`, in both libraries and the browser reader;
- carried by `update`, `compact`, `append` (narrowing and widening), `grantAccess` (kept when not given, removed with
  `null`), `rotateOwnerKey`, and `revokeAccess` of another key; gone with its grant on revoke and expiry;
- `editByKey`, `edit: {}` and the feature appear exactly when a limit narrows something, and go when the last one goes;
  a file written without limits has the same owner directory, key-slot members and package as one written by 1.7.1
  (checked by decoding them, since secrets are random);
- writers refuse widening and malformed limits with the messages above; readers treat a malformed one as read-only;
- the viewer (`npm run test:viewer`): `jazmin.edit` is the intersection; a page's save outside it is refused before a
  change file is made; the review dialog's line; the "limits were lost" message;
- fuzzing: the `edit` members of the owner directory and bundle, and `package.editByKey`, in the JSON mutations.

**The published packages** (`compat-previous.mjs` for npm, `compat-previous.cs` for NuGet), with the new fixtures:
1.7.1 reads every row the key may see (library and browser reader), gives no `package.edit`, refuses `applyChanges`
("doesn't take changes") and `update`, `append`, `compact` and `grantAccess` (naming `edit-limits`), and leaves the file
unchanged. The JS outcomes were measured above with the scratch copy; the build makes them permanent checks, and the
NuGet check is where the .NET answers above, read in the source, are first run.

**Measurements** (CLAUDE.md: memory first, then speed): the cost is a few bytes per grant and one more set lookup per
change in `applyChanges`. Before and after, several runs each, for time and peak memory: `applyChanges` of 10,000
changes; a key holder's open with 50,000 grants (the `P-16` benchmark); an `update` of a file with 5,000 grants. No
figure is given here: none has been measured.

## Implementation plan (each a pull request, after approval)

Estimates are rough working days for one person, with tests in both libraries; they are not measured.

1. **Spec**: Appendix A into `draft-jazmin-format-03.md` (sections 6.8, 7.6.4, 7.6.5, 7.9, 11.2, 12 and Appendix B);
   `edit-limits.json` and the fixture keys. *0.5 day.*
2. **JavaScript library**: the limit in `normalizeGrants`, the owner directory and the bundle; `editByKey` and the
   feature; carrying through `update`, `append`, `compact`, `grantAccess`, `rotateOwnerKey`; `checkAppendGrants`;
   `reader.edit`, `reader.access.edit`, the grants list; `writeChanges` and `applyChanges`; TypeScript types; fixtures;
   fuzzing. *2 to 3 days.*
3. **.NET library**: `JazminEditLimit`, `JazminGrant.Edit`, `JazminGrantInfo.Edit` and `EditLost`,
   `JazminAccessInfo.Edit`, `reader.Edit`; the same carrying and checks; `Changes.cs`; interop with the JS fixtures and
   its own. *2 to 3 days.*
4. **Browser reader and viewer**: the bundle member and `editByKey`, `reader.edit`, `JazminBrowser.writeChanges`,
   `jazmin.edit`, the review dialog and messages; `node scripts/build-browser.mjs`; viewer tests in every browser.
   *1 to 1.5 days.*
5. **Compatibility checks** with the published 1.7.1 (npm and NuGet) and npm 1.4.0; measurements before and after.
   *0.5 to 1 day.*
6. **Docs and examples**: `CHANGELOG.md` (Unreleased), `USER-GUIDE.md` 15.6 (what older releases do with such a file),
   `docs/TASKS.md`, a quickstart section in `js/examples/quickstart.mjs` and `dotnet/samples`, a `docs/SAMPLES.md` row.
   *0.5 to 1 day.*

About **7 to 10 days** in all. Steps 2 and 3 can go in either order; step 4 needs step 2.

## Decisions for the owner

1. **The safety option:** settings in `package.editByKey`, writer feature `edit-limits`, `edit` on every grant, fail
   closed; or option 1, 2 or 3? (Recommended: the first.)
2. **`grantAccess` keeps a limit not given** (`null` removes it), unlike today's "replace whole" for the other members?
   (Recommended: yes.)
3. **`append` may narrow a limit** (no re-lock needed, since the owner enforces it)? (Recommended: yes.)
4. **Names:** `edit` (grant member), `editByKey` (package member), `edit-limits` (writer feature), `JazminEditLimit`
   (.NET)?

## Noticed, not changed (outside this task)

- **`grantAccess` (JavaScript) drops a re-granted key's expiry, online mode, file groups and label** (checked on
  `main`, section 3): re-granting a key that expires, or is online, makes it never expire and offline. That widens
  access silently. Worth its own issue; this design does not repeat it for `edit`.
- **`applyChanges` with `dryRun` in 1.7.0 and 1.7.1** plans before the writer-feature check, so a dry run of a file the
  release can't modify reports the changes as if they would apply. 1.8 could check the features first.
- **Submissions** (`fileSubmission`, spec 7.8) are another way a key sends rows back. They are limited by the grant's
  partitions only, not by the document's settings or this limit. Out of scope here.

## Appendix A. Proposed spec text (draft, not normative)

> **DRAFT for #257: not part of the specification until the owner approves the design.** On approval this text goes
> into `docs/rfc/draft-jazmin-format-03.md` at the places named.

**6.8, package settings**: where the package's members are listed, after `edit`, add: "or, in a shared file whose
grants limit what keys send back, `editByKey` instead (7.9.1)".

**7.6.4, access bundle**: replace "plus `expires` / `online` (7.7), `files` (6.8), `submission` (7.8) and `masks`
(7.6.8)" with "plus `expires` / `online` (7.7), `files` (6.8), `submission` (7.8), `masks` (7.6.8) and `edit`
(7.9.1)".

**7.6.5, owner directory**: in the grant object, after `"mode": ...`, add `"edit": ...`, and after the list add
"(`edit`: 7.9.1)".

**7.9, Change Files**: after the description of `edit`'s members, add:

> In a shared file whose grants limit what keys may send back (7.9.1), the same object is stored as `editByKey`, and
> `edit` is absent. Everything this section says of `edit` then holds for `editByKey`.

and in "Applying a change file", after "MUST refuse changes `edit` doesn't allow (an operation, a column)", add: "or
that the sender's limit doesn't allow (7.9.1)".

**New 7.9.1, Limits per key:**

> A grant of a shared file MAY narrow what its key may send back. Its limit, `edit`, is a JSON object with the
> optional members `columns` (an array of distinct, non-empty names of columns of the table the document edits), `add`
> and `delete` (`true` or `false`). An absent member narrows nothing: `columns` means every column the document allows;
> `add` and `delete`, as the document has them. A limit MUST NOT have other members.
>
> - **Where:** the limit is in the grant in the owner directory (7.6.5) and, as the same JSON value, in the key's access
>   bundle (7.6.4). Software that applies change files MUST use the owner directory's; the bundle's tells the key
>   holder.
> - **The intersection:** a sender may set a column only if the document's settings, its limit and its grant's column
>   groups all allow it; may add rows only if the document and its limit allow it; and may delete rows likewise. All
>   three are taken at the time of applying. A limit can only narrow: when a grant is given, writers MUST refuse a limit
>   that names a column the document doesn't allow or that is outside the grant's column groups, or that allows adding
>   or deleting where the document doesn't. A limit kept from before that names more than the document now allows is
>   valid; the intersection applies.
> - **editByKey:** when at least one grant has a limit that narrows something, writers MUST store the document's
>   settings as `package.editByKey` and leave out `package.edit`, MUST write a limit on every grant in both places (`{}`
>   for a key without one), and MUST name the writer feature `edit-limits` (12). When no grant's limit narrows
>   anything, writers MUST store the settings as `package.edit` and leave out `editByKey`, the limits and the feature.
>   Writers MUST keep the limits when the document has no settings, and use `editByKey` again when it has them. (Readers
>   that don't know `editByKey` find no `edit`, and so treat the document as one that takes no changes.)
> - **Fail closed:** in a file with `editByKey`, a grant without a limit, or with a limit that isn't well formed, allows
>   nothing: software that applies change files MUST refuse each of its key's changes, and SHOULD say that the key needs
>   to be granted again. Readers SHOULD report such grants to the owner.
> - **Carrying:** appends, rewrites and key rotations MUST keep each grant's limit. A grant given again for the same key
>   without a limit keeps the one it had; software MAY offer a way to remove it. An append MAY narrow or widen a limit
>   (unlike the rest of a grant, 11.2): it writes the owner directory and the key slots again.
> - **Senders:** software that makes change files SHOULD refuse changes the key's limit doesn't allow, and viewers
>   SHOULD give the document only what the key may do.
> - **Refusals:** a change outside the limit is refused, never held; an overwrite does not apply it.

**11.2, Access-controlled files**: after "Writers MUST refuse to narrow a grant in an append.", add: "A grant's limit
(7.9.1) is not a narrowing in this sense."

**12, Features**: in "Defined since", add the writer feature `edit-limits` (7.9.1).

**Appendix B**: add:

> - **Since format 1.0, limits per key (7.9.1):** a grant's `edit`, in the owner directory and the access bundle; the
>   document's settings stored as `package.editByKey` in a file with limits; the writer feature `edit-limits`. Readers
>   of releases 1.0 to 1.7.1 read such files (they ignore the bundle member) and find no `edit`, so they treat the
>   document as one that takes no changes: their `applyChanges` refuses, and their viewers offer no editing. Releases
>   1.7.0 and 1.7.1 refuse to modify such files (the writer feature). Releases 1.0 to 1.6.2 rewrite them without the
>   limits and the settings, or (.NET, when appending) without the limits, which later releases then treat as keys that
>   may send nothing. Files without limits are unchanged.
