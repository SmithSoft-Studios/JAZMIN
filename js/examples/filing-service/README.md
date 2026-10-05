# Filing service (reference sample)

People in the field capture records, often offline, and send them back as
small `.jzm` files written in the browser. Each one is locked with the
person's **submission key**, which they get only by opening the shared file
with their access key. This service holds the shared file's owner
(master) key. It checks each batch and files it into the shared file. Phones
and web pages never hold the owner key.

See USER-GUIDE §15.6 and `docs/design/browser-writer.md` for the design.

| File | What it does |
|---|---|
| `filing.mjs` | `fileBatch()`: the rules for filing one batch |
| `inbox.mjs` | `processInbox()`: files every batch waiting in an inbox folder, then compacts. Also a command line. |

## Run it

**File each batch as it arrives.** Call `fileBatch()` from whatever receives
the uploads, after sign-in and a size limit:

```js
import { RejectedBatch, fileBatch } from './filing.mjs';

// keyId: the sender's access key id, sent with the upload (the phone knows it, for example bob.id); body: the batch
try {
  const result = fileBatch('shared.jzm', process.env.JAZMIN_KEY, { keyId, batch: body }); // { filed, updated, duplicates, files }
  // reply 200 with the result
} catch (error) {
  if (error instanceof RejectedBatch) { /* reply 422 with error.message, so the phone can show why */ }
  else { /* for example the shared file is busy: save the batch to the inbox, and reply 202 */ }
}
```

Why at once: for keys that expire, a batch is filed only if it arrived before
the expiry. The first write to the shared file after the expiry removes the
key's grant, and a batch filed after that is refused as unknown.

**The inbox runner** files the batches that couldn't be filed at once:

```bash
JAZMIN_KEY="$(cat owner.key)" node inbox.mjs shared.jzm inbox/
# or: node inbox.mjs --key-file owner.key shared.jzm inbox/
```

1. **Saving:** save each batch as `inbox/<access key id>.<anything>.jzm`, as
   a new file. Its modified time counts as when the batch arrived, so never
   copy a time the phone sends.
2. **Filing:** each run files the batches, oldest name first.
   - **Filed batches** move to `inbox/filed/`.
   - **Rejected batches** move to `inbox/rejected/`, each with a `.txt` file
     giving the reason.
3. **Report:** the run prints what it did, as JSON.
4. **Compacting:** once the shared file has 50 appends, the run compacts it.
   It regroups too when the sort order allows, so each person's rows are
   stored together (USER-GUIDE §17.4).

Run it often, or on a schedule: cron, a systemd timer, Task Scheduler, or a
cloud timer function. Only one run at a time: a second run finds the shared
file locked and stops, and the next run carries on.

## The rules (`fileBatch`)

| Check | Rejected when |
|---|---|
| The sender | The key id has no grant in the shared file: unknown, or revoked |
| Expiry | The key expires, and the batch was written (by the phone's clock) or arrived (by the server's clock) after it. The phone's clock can be set to anything, so the arrival time is the check that counts. |
| Proof | The batch doesn't open with that key's submission key: it was made without opening the shared file (a leaked key alone isn't enough), or it was changed |
| Columns | A column isn't in the shared file, or has another type |
| Partition | A row names a partition the key isn't granted. With a grant of one partition, rows are simply put in it. |
| Changing a record | A row whose `id` is already filed replaces the filed record (see below). Rejected when the record is in a partition the key isn't granted, or the change would move it to another partition. |
| Files listed | A row lists a file the batch doesn't hold, or the batch holds a file no row lists |
| Kind of file | A file's first bytes don't show an allowed kind: PDF, JPEG, PNG or WebP by default. The name and type the phone gives are ignored. |
| File size | A file is over 10 MB, or the batch's files are over 50 MB together (identical files count once) |

## Files with records

A record can have several files: photos, PDFs. The phone embeds them in the
batch and lists each record's files in the `attachments` column, a `json`
column of the shared file:

```js
{ id: 'v-17', note: 'site visit', attachments: ['v-17/receipt.pdf', 'v-17/photo.jpg'] }
```

When the record is filed:
- **Where each file goes:** `attachments/<key id>/<sha256>.<ext>`, a path the
  service chooses. Nothing the phone names becomes a path.
- **Who can open it:** the keys that see the record's partition, and the owner.
- **Copies:** identical files are stored once.
- **The record's list** becomes `[{ path, name, type, size }]`. `name` is the
  name the phone gave, for display.

**When a record is changed**, its list says which files it keeps:
- **To keep a file:** leave its entry (`{ path, ... }`, as read from the shared
  file) in the list. A record can keep only files it already lists.
- **To add one:** list its path in the batch, as for a new record.
- **To remove one:** leave it out. A file no record lists any more is removed
  from the shared file.

The rows and their files go into the shared file in one append, so a run that
stops halfway leaves neither.

## Changing records

A record sent again, with an `id` that's already filed, replaces the filed
record. This is how corrections made on a phone reach the shared file.

- **Last arrival wins:** if two people change the same record, the change
  that arrives last is kept, without a warning. Within one batch, the last
  row with that `id` counts.
- **Who may change it:** anyone whose key's grant covers the record's
  partition. A change can't move a record to another partition.
- **Hidden columns are kept:** only the columns the batch has and the
  sender's grant covers change. A key that can't see a column can't change
  it, even by sending it.
- **Nothing changed:** a row identical to the filed record, such as a batch
  sent twice, changes nothing and counts as a duplicate.
- **To keep the first version instead:** pass `onDuplicate: 'skip'`. A
  record sent again is then skipped, as a duplicate. Pass it to `fileBatch()` in
  your upload handler, and to `processInbox()` for the runner.

## Options

Pass them to `fileBatch()` in your upload handler, and to `processInbox()`
for the runner:

| Option | Default | |
|---|---|---|
| `filesColumn` | `'attachments'` | The column that lists a row's files. Leave it out of the shared file to refuse every file. |
| `fileTypes` | all of `FILE_KINDS` | The kinds accepted. Add a kind to `FILE_KINDS` in `filing.mjs`, with a test of its first bytes. |
| `maxFileBytes` | 10 MB | Per file |
| `maxBatchFileBytes` | 50 MB | All of a batch's files |
| `idColumn` | `'id'` | The column that tells records apart |
| `onDuplicate` | `'replace'` | `'replace'`: a record sent again replaces the filed one. `'skip'`: it is skipped. |
| `receivedAt` | now | When the batch arrived, by the server's clock. The inbox runner uses each file's modified time. |

## Keeping the owner key safe

- **Where the key lives:** keep it in a secret manager (Azure Key Vault, AWS
  Secrets Manager, HashiCorp Vault). Have the platform hand it to the job as
  `JAZMIN_KEY`, or as a file that only the job can read.
- **Where it doesn't:** never in source control, never next to the shared
  file, never in a web page or on a phone.
- **Who runs it:** run the service on machines you control. Whoever runs it
  can read all the data.
- **Uploads:** limit their size and rate, a little above
  `maxBatchFileBytes`. A batch can't be forged, but the endpoint can still be
  flooded.
- **Files people send:** a PDF can carry scripts, and an image can be crafted
  to attack a viewer. The kind check stops files disguised as another kind,
  not harmful content. Open them as you'd open any upload, and scan them first
  if your policy asks for it.
