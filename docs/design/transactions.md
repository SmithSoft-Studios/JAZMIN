# Batch writes and transactions: several calls as one append

Status: **built** in both libraries (GitHub #275). No change to the file format.

## Why

A user trying JAZMIN as an embedded store found that one `append()` of one row costs about 100 ms, and that an append
of many rows costs about the same. Almost all of it is the two flushes to disk every append makes (spec 11.2): the
data is flushed before the trailer is written, then the trailer is flushed. Both must stay: they are what make an
append all or nothing after a crash. So the way to more rows per second is fewer appends, and the user had built a
queue that merged callers into one append by hand. They asked for transactions over several calls, and for the
library to merge callers itself (group commit).

## What is added

- **A transaction** (`beginAppend(path, options)`, .NET `JazminFile.BeginAppend`): `insert(rows)`, `upsert(rows)`
  and `delete(filter)` collect calls in memory; `commit()` writes them as **one append** (one pair of flushes) and
  returns that append's result; `rollback()` discards them. Nothing is locked or opened until `commit()`. A finished
  transaction refuses further calls; so does one whose commit failed. In .NET, disposing without `Commit` rolls back.
- **A group writer** (`openWriter(path, options)`, .NET `JazminFile.OpenWriter`): each `insert` / `upsert` /
  `delete` returns a promise (a `Task`) of the result of the append that wrote it. A batch starts on the next turn of
  the event loop (.NET: at once, on one background task), or `maxDelay` ms after its first call, and takes calls up to
  `maxRows` rows (default 10,000). Calls made while a batch is written make the next batch. `flush()` writes what is
  waiting now; `close()` (.NET `DisposeAsync`) writes it and then refuses further calls.

## What a batch means: the calls one after another

Calls are written in **call order**, and each call's delete and upsert see the file as the earlier calls leave it. The
file afterwards is the one running the calls one at a time, each its own append, would give. The counts in the result
(`inserted`, `updated`, `deleted`) are the sums those appends would report.

One append can't always do that. It looks up the rows to delete and replace in the file as it was, so it can't see a
row an earlier call in the same batch adds. These are **clashes**:

- a `delete` whose filter matches a row an earlier call adds;
- an `upsert` with the key of a row an earlier call adds (by `insert` or by `upsert`);
- in a file with `sortedBy`, a call whose rows sort before rows an earlier call adds (in turn, its append would be
  refused as out of order).

A transaction refuses a clash at commit, naming the two calls: *"In this transaction, call 2 (delete) matches a row
that call 1 (insert) adds: … Commit the calls separately"*. Nothing is written. The group writer instead **splits the
batch** before the clashing call: the calls before it are one append, and the rest go on in the next, in order. Each
caller still gets the result of running their call in turn.

Not clashes: a delete before an insert (the delete can't match a row that isn't there yet), and an insert after an
upsert of the same key (the calls in turn keep both rows too). A delete of a row an earlier upsert replaced finds the
old row gone, as it would in turn. An upsert of a key an earlier call deleted adds the row and counts it as inserted.

Duplicate keys **inside one upsert call** behave as `append()` does with them: the last row for a key wins. An empty
key is a key like any other: it matches the rows with an empty key. Two upsert calls with the same key in one batch
are still a clash; merging them (the later call's row wins, as in turn) is a possible later improvement, which would
let the group writer batch callers that upsert one key.

**Masked columns.** The writer changes a row as it stores it in a table with masked columns (spec 7.6.8): it makes
the shown values, and moves a value outside the mask's rows to the unmasked column. A delete can then match the
stored row where it doesn't match the row the call gave, so in such a table any delete after a call that adds rows
is a clash.

## Errors

- **A transaction** is all or nothing: a commit that fails (a bad value, a clash, the file locked by another writer)
  leaves the file byte for byte as it was, as a failed `append()` does, and ends the transaction.
- **The group writer** gives each caller their own error. A batch that fails with a validation error (a bad value, a bad
  filter) is tried again in halves, in order, until the call at fault fails alone; the other calls are written. Other
  errors (the file locked by another writer, a full disk, a wrong key) fail every call in the batch.
- **Options** the group writer would write again with every batch are refused when it opens: `metadata`, `grant`,
  `addFiles`, `removeFiles`, `package`, `addShapes`, `removeShapes`, `locks`, `columns`. Use `append()` or a
  transaction for those. Rows given in the options (`insert`, `upsert`, `delete`) are refused by both: they are given
  with the calls.

## Not blocking the event loop (JavaScript)

The group writer awaits its two flushes (`fs.fsync`) instead of blocking on them, so a Node server keeps serving
while a batch waits for the disk (about 100 ms an append in the trial behind #275; about 2 ms on the disk the
figures in the User Guide were measured on). The bytes written and their order are the same as `append()`'s:
everything up to the trailer, a flush, the trailer, a flush. A test checks that the writer's file is byte for byte the
file `append()` writes for the same rows. The lock (`<file>.lock`) is held until the second flush is done. The rows
are still read and encoded synchronously; a batch is bounded by `maxRows`. `writeAsync` / `finishAsync` are unchanged.

In .NET the group writer's background task runs the append as `JazminFile.Append` does, on a thread-pool thread; it is
safe for concurrent callers.

## Why the format doesn't change

A batch is one ordinary append: the same sections, header and trailer `append()` writes, with its rows in call order
and its deleted rows listed as any append lists them. Tests in both libraries check that a transaction's file is byte
for byte the file one `append()` with the same rows writes. Every reader that reads appended files (every 1.x
release; the `*-appended*.jzm` fixtures) reads it. Nothing about transactions is stored: once committed, a batch can't
be told from an append.

## Cost

Measured with `node bench/group-commit.mjs` (in `js/`), 100 callers each adding one row to a 10,000-row file; see the
User Guide, section 17.7, and the pull request for the figures.
