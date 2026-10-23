# Samples and demos: where each feature is shown

Every feature of the JAZMIN format has a working example. This page says where. Numbers in the code columns are the
numbered sections of the two quickstarts, each printing what it shows:

- **JS:** [`js/examples/quickstart.mjs`](../js/examples/quickstart.mjs) (`node examples/quickstart.mjs` in `js/`)
- **.NET:** [`dotnet/samples/Jazmin.Samples/Program.cs`](../dotnet/samples/Jazmin.Samples/Program.cs)
  (`dotnet run --project dotnet/samples/Jazmin.Samples -c Release`)
- **Demo:** a page of the demo gallery, [`js/examples/from-disk`](../js/examples/from-disk) (`node examples/from-disk/make.mjs`
  in `js/`, then open `examples/from-disk/site/index.html`). Each page says at the top what it shows.

A feature added later gets a row here, a quickstart section in both languages, and a demo when people see it in a
viewer.

## Reading and writing

| Feature (USER-GUIDE) | JS | .NET | Demo |
|---|---|---|---|
| JSON-like one-liners (4.1, 6.1) | 1 | 1 | |
| A schema, indexes, metadata, encryption (4.2, 3.3, 3.4) | 2 | 2 | `pick-file.html` (1,000,000 rows, indexed, password) |
| Filters, and what a query reads (8.1, 9.6) | 3 | 3 | `pick-file.html` (Try buttons, `explain()`) |
| LINQ the reader runs (8.3) | | 2, 12, 16 | |
| Queries with arrow functions (8.4) | 20 | | `tables.html` |
| Exports to JSON, CSV and XML; paging (11, 9.7) | 4, 6 | 5 | the viewer's Export menu |
| Rows as a JSON stream (11.2) | | 14 | |
| Newtonsoft-style settings (6.3) | | 11 | |
| Streaming writer for large data (4.4, 6.5) | 5 | 4 | |
| Async sources and reads (22) | 10 | 9 | |
| Memory or speed first; smaller indexes (20.4) | 12 | 12 | |
| Nested columns (4.2, 6.2) | 15 | 17 | `nested.html` |
| Column arrays for charts (9.11) | 42 | | `small-file.html` |
| Newest rows first, `reverse: true` (9.7) | 30 | 31 | `pick-file.html` (Newest 20) |
| What a read will cost, `estimate()` (9.6) | 35 | 36 | `pick-file.html` (What will this read?) |
| Progress and Stop on long reads (22.1) | 33 | 34 | the viewer's busy display (`pick-file.html`) |
| Readers kept open: `changed()`, `refresh()`, a reader cache (20.10) | 48 | 48 | |
| Text orders: ignoring case, numbers by value (16.1) | 31 | 32 | `sort-order.html` |
| Which versions read a file (3.2) | 26 | 27 | |

## Changing files

| Feature (USER-GUIDE) | JS | .NET | Demo |
|---|---|---|---|
| Append, then compact (17) | 7 | 6 | |
| Batch writes and transactions: one append for many calls (17.7) | 46 | 46 | |
| Does the file need compacting? `storage()` (17.5) | 21 | 22 | |
| Has the file changed? `verify()` (17.6) | 45 | 45 | |
| Regrouping partitions (17.4) | 41 | 42 | |
| Changing indexes and the sort order (16.1) | 22 | 23 | |
| Progress for a rewrite (16.1) | 34 | 35 | |
| A new key without rewriting the rows (10) | 13 | 13 | |

## Several tables and export shapes

| Feature (USER-GUIDE) | JS | .NET | Demo |
|---|---|---|---|
| Several tables in one file (23) | 11 | 10 | `tables.html` |
| Adding, renaming and removing tables (23.5) | 23 | 24 | |
| Links between tables (23.6) | 24 | 25 | `tables.html` |
| A key changed in every table (23.7) | 25 | 26 | |
| Export shapes: nested JSON and XML (21.1) | 9 | 8 | `shapes.html` |
| Shapes across tables (21.6) | | 15 | `tables.html` |
| Shapes saved in the file (21.7) | 19 | 21 | `shapes.html`, `shared.html` |

## Access, keys and locks

| Feature (USER-GUIDE) | JS | .NET | Demo |
|---|---|---|---|
| One file, many keys: rows, column groups, file groups (15) | 8 | 7 | `shared.html` |
| Keys that expire; online keys with 2FA (18, 18.5) | 8 | 7 | `two-factor.html` (with the sample key service) |
| The owner's list of grants (15.1) | 28 | 29 | |
| Records sent back from the field (15.6) | 27 | 28 | `send-back.html`; [`js/examples/filing-service`](../js/examples/filing-service) |
| Different keys, different changes: limits per key (19.5) | 44 | 44 | |
| Rows of many partitions in turn, grouped as they are written: `regroup` (15.5) | 47 | 47 | |
| Writing a file in the browser (24.3) | | | `send-back.html` |
| Masked columns (15.7) | 32 | 33 | `masked.html` |
| Masking and unmasking later (15.7) | 40 | 41 | |
| Locked stored files (19.6) | 29 | 30 | `shared.html` (HR's locked file) |
| Locks with a key service, and the viewer's Sign in (19.6) | 39 | 40 | `two-factor.html` (step 4) |

## Stored files and documents

| Feature (USER-GUIDE) | JS | .NET | Demo |
|---|---|---|---|
| Stored files, served by path (19, 19.4) | 14 | | |
| What viewers may do with a file; `list: false`; actions by file group (19.3) | 16, 36 | 18, 37 | `documents.html` |
| A print-ready document and its PDFs (19.3) | 16 | 18 | `documents.html` (report) |
| An editable document and change files (19.5) | 17 | 19 | `documents.html` (tasks) |
| A document that needs the internet (24.1) | 37 | 38 | `documents.html` (dashboard, the client file's Summary) |
| Document pages as tabs, the document's own files (19.7) | 38 | 39 | `documents.html` (client file) |
| A page only some keys see (19.7) | 38 | 39 | `shared.html` (HR's Pay review tab) |
| A small file that opens itself from disk (24.4) | 18 | 20 | `small-file.html` |

## Publisher signatures

| Feature (USER-GUIDE) | JS | .NET | Demo |
|---|---|---|---|
| Who published a file, and that it hasn't changed (26) | 43 | 43 | `signatures.html` (a test build of the viewer, marked TEST); the signed test files in [`spec/fixtures/publisher`](../spec/fixtures/publisher), each with its expected result; `jazmin verify <file>` from the command line (25, 26.1) |

## Elsewhere

- **TypeScript:** [`js/examples/typescript`](../js/examples/typescript).
- **The browser reader in .NET (Blazor):** [`dotnet/samples/Jazmin.Blazor`](../dotnet/samples/Jazmin.Blazor).
- **A key service with 2FA:** [`dotnet/samples/Jazmin.KeyService`](../dotnet/samples/Jazmin.KeyService).
- **The command-line tool:** USER-GUIDE section 25.
- **Benchmarks:** `js/bench` and `dotnet/bench` (USER-GUIDE section 9).
