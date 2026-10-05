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
| `inbox.mjs` | `processInbox()`: files every batch in an inbox folder, then compacts. Also a command line for a schedule. |

## Run it

```bash
JAZMIN_KEY="$(cat owner.key)" node inbox.mjs shared.jzm inbox/
# or: node inbox.mjs --key-file owner.key shared.jzm inbox/
```

1. **Uploads:** whatever receives them saves each batch as
   `inbox/<access key id>.<anything>.jzm`. The phone knows its key id, for
   example `bob.id`.
2. **Filing:** each run files the batches, oldest name first.
   - **Filed batches** move to `inbox/filed/`.
   - **Rejected batches** move to `inbox/rejected/`, each with a `.txt` file
     giving the reason.
3. **Report:** the run prints what it did, as JSON.
4. **Compacting:** once the shared file has 50 appends, the run compacts it.
   It regroups too when the sort order allows, so each person's rows are
   stored together (USER-GUIDE §17.4).

Run it on a schedule: cron, a systemd timer, Task Scheduler, or a cloud timer
function. Only one run at a time: a second run finds the shared file locked
and stops, and the next run carries on.

## The rules (`fileBatch`)

| Check | Rejected when |
|---|---|
| The sender | The key id has no grant in the shared file: unknown, or revoked |
| Expiry | The grant has expired |
| Proof | The batch doesn't open with that key's submission key: it was made without opening the shared file (a leaked key alone isn't enough), or it was changed |
| Columns | A column isn't in the shared file, or has another type |
| Partition | A row names a partition the key isn't granted. With a grant of one partition, rows are simply put in it. |
| Duplicates | Not a rejection: rows whose `id` is already filed are skipped, so a batch sent twice is filed once |

## Keeping the owner key safe

- **Where the key lives:** keep it in a secret manager (Azure Key Vault, AWS
  Secrets Manager, HashiCorp Vault). Have the platform hand it to the job as
  `JAZMIN_KEY`, or as a file that only the job can read.
- **Where it doesn't:** never in source control, never next to the shared
  file, never in a web page or on a phone.
- **Who runs it:** run the service on machines you control. Whoever runs it
  can read all the data.
- **Uploads:** limit their size and rate. A batch can't be forged, but the
  endpoint can still be flooded.
