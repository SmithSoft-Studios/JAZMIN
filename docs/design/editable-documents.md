# Editable documents (1.4)

A file's document (its package's pages, spec 6.8) can let people change the data it shows: change rows, add rows,
delete rows. The changes reach the file in one of two ways:

- **A file of your own** (not shared), opened with its key: the viewer writes them into the file once you confirm.
- **A shared file** (or one hosted for others): each person works on their own copy, so their viewer writes a small
  **change file**, sealed with their submission key (spec 7.8). They send it to the owner, whose library applies it
  with `applyChanges`, checking every change again.

Decided by the user (2026-10-09): in 1.4; change, add and delete; a row changed since the sender's copy is held for
the owner (reported, applied only with an explicit overwrite).

## 1. The template opts in: `package.edit`

```json
"edit": { "table": "claims", "key": ["claim"], "columns": ["status", "note"], "add": true, "delete": false }
```

- `table`: the table changed (default: the file's first table).
- `key`: the columns that identify a row (one or more; string, int, decimal, datetime or bool). Changes can't alter
  them.
- `columns`: the columns a change may set. Not the key columns. Added rows set the key columns and these; other
  columns are left empty (null).
- `add`, `delete`: whether rows may be added or deleted (default false).

Writers check it: the table and columns exist, the key's types, at least one of `columns`, `add` or `delete`. Nothing
else can be changed through a document, and the owner's current `edit` is what `applyChanges` checks against: an
owner can narrow or withdraw it at any time.

## 2. The page: `jazmin.edit` and `jazmin.saveChanges`

```js
jazmin.edit;   // { table, key, columns, add, delete }, or null: this document or viewer can't save changes
await jazmin.saveChanges({
  update: [{ claim: 'C-104', status: 'approved', note: 'Photos checked' }],   // the key, and the columns that change
  add:    [{ claim: 'C-900', status: 'open' }],
  delete: [{ claim: 'C-017' }],                                           // the key only
});
// resolves { saved: 'file' | 'change-file', updated, added, deleted }; rejects when the person declines or a change
// isn't allowed (the message says which and why)
```

- The viewer, not the page, decides: it checks the changes against `edit`, shows the person what will change, and asks.
- A key appears once per call.
- `renderPdf` (print mode) has no `edit`: `jazmin.edit` is null and `saveChanges` rejects.
- The web viewer can't write a file on disk: it offers the change file as a download. JAZMIN Scout writes an own file
  directly, and a shared file's changes as a change file.

## 3. Change files

A JAZMIN file (format 1.0 features, plus nested columns when the table has them) with one table, `changes`:

| Column | Type | |
|---|---|---|
| `jazmin.op` | string | `update`, `add` or `delete` |
| `jazmin.set` | json | the columns an update or add sets (a value set to null is still set) |
| each key column | as in the file | |
| each editable column | as in the file, nullable | the value wanted |
| `jazmin.before.<column>` for each editable column | as in the file, nullable | the value the sender saw (update: the columns set; delete: all) |

Metadata `jazmin.changes`: `{ version: 1, file, table, key, columns, sender, based: { writtenAt, appendCount } }`:
`file` is the file id the changes were made on (a rewrite changes it, so it is not checked; the result says when it
differs); `sender` is the access key id (null for files that aren't shared).

Sealed with: the sender's submission key (shared files); the file's own key or password (files that aren't shared);
nothing for files that aren't encrypted.

## 4. `applyChanges(path, change, { key | password, keyId, overwrite, dryRun, receivedAt })`

1. Opens the file (a shared file with its owner key) and reads its current `edit`; none: refused.
2. A shared file: finds the sender (the grant whose submission key opens the change file, or `keyId`), and checks its
   grant as the filing service does: it exists (not revoked), and the change file was written and received before
   the grant expires.
3. The change file must name the same table and key columns, with the same column types.
4. Each change, in order (several for one key apply in turn):
   - **refused** (never applied): an operation `edit` doesn't allow; a column it doesn't allow, or the sender's grant
     doesn't cover; a row in a partition the sender isn't granted, or moved into one; an added row without its key or
     partition (a grant of one partition fills it in).
   - **conflict** (held; applied with `overwrite: true`): `changed`, a column set or a row deleted whose value now
     differs from what the sender saw; `exists`, an added key already there; `missing`, a row updated or deleted that
     is no longer there (nothing to overwrite).
   - otherwise applied.
5. One `append` writes it all (upserts and deletes by the key), unless `dryRun`.

Returns `{ sender, fileChanged, updated, added, deleted, conflicts: [{ op, key, kind, columns: [{ name, before,
wanted, now }] }], refused: [{ op, key, reason }] }`.

`writeChanges(source, changes, { key | password })` makes a change file from an open file: it checks the changes as
far as the sender can (allowed, visible rows, types) and takes the earlier values from the sender's copy. Viewers use
it (the browser reader has the same), and so can apps.

## 5. Where it is built

1. JavaScript library: `edit` checked by writers; `writeChanges`, `applyChanges`; `reader.fileId`,
   `reader.access.keyId`. Spec 6.8 and 7.9.
2. Browser and viewers: `JazminBrowser.writeChanges`; the sandbox's `jazmin.edit` / `saveChanges`; the web viewer's
   review and download.
3. .NET: `JazminPackage.Edit`, `JazminFile.WriteChanges`, `JazminFile.ApplyChanges`; change files read across the
   libraries (fixtures).
4. JAZMIN Scout: Save Changes (own files directly, shared files as change files) and Apply Change File.
