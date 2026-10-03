# Design: JAZMIN format 1.0 (the first released format)

Status: **implemented** in both libraries (results in section 13; all six decisions in section 12). Specified in
[draft-jazmin-format-03](../rfc/draft-jazmin-format-03.md) and [`spec/jazmin.proto`](../../spec/jazmin.proto);
implementation in progress. Nothing has been released, so this is the one chance to change the format
without migrating anybody's files. The aims, in order:

1. **Follow industry practice** where a proven answer exists, so the format is unsurprising to
   reviewers and tools.
2. **Leave room to grow:** new encodings, codecs, types and features can be added later without
   breaking files or forcing a "2.0".
3. **Simplify:** one way to do each thing.
4. **Make the changes held back so far:**
   - binary catalogs (P-8);
   - per-key chunk directories (P-7);
   - hidden column names (S-6);
   - incremental appends (P-9);
   - tables (D-3).

## 1. Industry alignment

The choices below compare JAZMIN with the formats that store analytical data at scale:

- **File formats:** Apache Parquet, Apache ORC, Apache Arrow IPC and Lance.
- **Table formats:** Delta Lake and Apache Iceberg, which add features to existing data.
- **Encryption:** Parquet Modular Encryption.

| Topic | Industry practice | JAZMIN 1.0 |
|---|---|---|
| Magic | Parquet writes `PAR1`, and Arrow `ARROW1`, at **both ends** of the file | `JZM1` at both ends (section 3) |
| Footer metadata | A schema-defined binary encoding: Parquet uses Thrift, ORC and Lance use Protocol Buffers, Arrow uses FlatBuffers. Unknown fields are skipped, so metadata can grow | **Protocol Buffers wire format**, with the schema published as `jazmin.proto` (section 4) |
| Adding features | Delta Lake's *reader and writer features*: a file lists what a reader must support. An old reader refuses clearly instead of misreading | Required **reader and writer features**, replacing minor versions (section 5) |
| Column storage | Columns stored apart inside horizontal slices (Parquet *row groups*, ORC *stripes*) | Columnar chunks, as now. JAZMIN's *chunk* is Parquet's row group |
| Partitioning by value | Iceberg and Hive call it **partitioning** | Access groups by value are renamed **partitions** (section 6). The old name, "row group", means something else in Parquet |
| Statistics | Min, max and null count per column per slice; Parquet keeps its page index outside the footer so the footer stays small | The same, loaded lazily per column, with room for distinct counts and Bloom filters later (section 7) |
| Decimals | Parquet and Arrow `DECIMAL`: scaled integers, ordered | Exact text kept on read, but stored as a scaled integer and **ordered**. That allows statistics, range filters and indexes on money columns (section 8) |
| Timestamps | Arrow and Parquet declare a unit (ms, µs, ns) | A `unit` field, ms for now; µs and ns can come later as features (section 8) |
| Encryption | Parquet Modular Encryption: AES-GCM, with associated data binding each part to its file and position, and separate keys per column | The same principles, as now. JAZMIN adds per-partition keys, key slots, owner signatures and time-limited access (section 6) |
| Compression | Zstandard is the common default for columnar data | Deflate in 1.0, because it is built into .NET 10 and every Node version. Zstandard comes as a feature once both runtimes include it as standard (section 9) |
| Deletes and postings | Roaring bitmaps: Delta and Iceberg deletion vectors; Lucene, Druid and Pinot postings | Compact varint lists in 1.0, each with an encoding byte so Roaring can be added later (section 9) |

**Where JAZMIN goes beyond them,** and so where the advantage lies:
- **Access control:** partition and column access per key inside one file, with offline and online
  expiry. Parquet encryption is per column only.
- **Signed files:** only the owner can produce a file that readers accept.
- **Embedded files:** a viewer can render the stored files as a page that uses the file's data.
- **Export shapes:** nested JSON or XML straight from the file.
- **Statistics for access keys** (new in 1.0, section 6.2).

## 2. What stays

- **Sections:** the 16-byte envelope, compress-then-encrypt, CRC-32, AES-256-GCM and the
  associated data.
- **Columnar chunks:** the column streams and their encodings: plain, delta, dictionary, bitmap and
  scaled float.
- **Keys:** the key formats (`jzk1-`, `jza1-`, `jzu1-`), HKDF and PBKDF2, ECDSA P-256 owner
  signing, key slots, and time-limited and online access. P-256 is built into .NET, Node and
  browsers; Ed25519 is not built into .NET.
- **Indexes and filters:** the trigram index, the filter language, the export rules and embedded
  files.
- **Library APIs:** all of them are kept. The only renames are listed in section 10.

## 3. File layout and magic

```
[preamble: "JZM1", flags, file_id, salt, kdf] [data, index, statistics, file sections ...]
[catalog sections] [key slots] [signature] [header] [trailer: offsets, CRC, "JZM1"]
```

- **The magic `JZM1` is at both ends.** Draft files (magic `JZMN`) are refused with: *"This file
  uses a pre-release JAZMIN draft format. Write it again from its source data."*
- **The trailer records the offsets and lengths** of the header, the key slots and the signature.
  They no longer need to sit next to each other, so appends can reuse unchanged sections (6.5).

## 4. Catalog in Protocol Buffers

**The header and catalog sections are Protocol Buffers messages**, defined in a `jazmin.proto`
published with the spec. The catalog sections are the chunk directories, statistics blocks and
append deltas.

- **No dependency:** both libraries encode and decode the wire format with a small built-in codec
  (varints, zigzag, length-delimited fields). Any standard Protocol Buffers tool can still read a
  decrypted header, which helps debugging and other languages (L-1).
- **Forward compatible:** readers skip fields they don't know. New *optional* information, such as
  more statistics or new settings, never needs a version change.
- **Fast:** chunk directories become packed varint arrays, with no JSON objects per chunk.
  - **Target (P-8):** parse at least 3× faster than today's JSON at 10,000 chunks.
  - Opening a 300-column file stays at 0.01–0.03 s.
- **JSON only where users write JSON:** user metadata, column `attributes` and `package` settings
  stay as JSON text inside their fields, because they are free-form by design.

## 5. Features instead of minor versions

The header lists **reader features** and **writer features**, as Delta Lake does:
- A reader that meets an unknown *reader feature* refuses with a clear message naming it, for
  example *"needs the 'zstd' feature"*. Without the list, it would misread the data.
- A writer, including one that appends, must support every *writer feature* in the file.
- Features cover what changes how bytes must be read: codecs, column encodings, value types and
  units, posting encodings.
- **1.0 starts with an empty list.** Each later addition gets a feature name. A file only lists the
  features it actually uses, so files that use none stay readable by every 1.0 reader.

## 6. Partitions and access control

**Terminology.** Today's "row groups" (rows grouped by a column's value for access control) become
**partitions** (`partitionBy`), the term Iceberg and Hive use. *Chunks* keep their name.

### 6.1 Per-key chunk directories (P-7)

- **Each partition has its own chunk directory**, encrypted with that partition's secret. It
  carries its chunks' locations, digests and statistics.
- **The header has a partition table sorted by id.** Each entry gives the id and the location and
  digest of the partition's directory. Readers binary-search it, as they do the key slots.
- **What a key holder reads:** the key slots, the header and its own partitions' directories only.
- **Target:** a client's open under 3 ms at 5,000 partitions (today 7–10 ms).

### 6.2 Statistics for access keys (new)

Each partition's statistics are encrypted with the same pair of secrets that locks its data:
the partition's and the column group's. A key holder sees statistics only for data it can read,
so its scans skip chunks like those of ordinary files. Today access-controlled files have no
statistics.

### 6.3 Hidden column names (S-6)

- **A restricted column group's column definitions move into a section** encrypted with that
  group's secret.
- **The header lists the default group's columns,** plus each restricted group's name.
- **The partition column and `sortedBy` columns must be in the default group,** because every key
  needs them.

### 6.4 Signature

The signature moves into its own small section. It covers the key slots, the header and, through
digests, everything else, as today.

### 6.5 Incremental appends (P-9)

- **An append writes only what changed:**
  - new chunk directories for the partitions it touched;
  - an *append delta* section listing them and the new deletes;
  - a new header pointing to the base catalog and the deltas.
- **Key slots are reused** unless grants change.
- **Target:** under 10 KB of overhead per append at 5,000 chunks (today about 300 KB).

## 7. Tables and statistics

**Tables (D-3).** Every file has a list of tables, and today's files have one. Each table has its
own columns, column groups, partitioning, sort order, chunks, statistics, indexes and deletes.

- **Partition and column-group names are shared across the file.** A key for partition `C1` sees
  `C1` in every table, which is what lets access follow a foreign-key link.
- **The multi-table API comes later.** The format and readers handle the list from 1.0.

**Statistics blocks.**
- **What a block holds:** min, max and null count, as key forms. There is room for distinct counts
  and Bloom filters later.
- **Which columns share a block:** the writer chooses, and the directory says which columns each
  block covers.
- **The reference writers' defaults:**
  - files with one partition: one block per column, which is what keeps wide files fast today;
  - access-controlled files: one block per partition and column group, which keeps the number of
    sections small with thousands of partitions.

## 8. Types

The eight types stay, with two improvements that are hard to add later:

- **`decimal` becomes ordered.**
  - **Storage:** each value is a scale and an integer, so `12.50` is stored as 1250 with scale 2.
    The exact text comes back on read.
  - **Comparison:** values compare numerically, so `1.5` equals `1.50`, as in SQL, Parquet and
    .NET. Today the comparison is textual.
  - **Gains:** statistics, range filters (`gt`, `lt`), sorted indexes and `$min` / `$max` work on
    money columns. Today they don't. Storage is smaller too.
- **`datetime` gets a `unit` field.** It is `ms` in 1.0, as today. Microsecond and nanosecond units
  can come later as reader features. .NET's `DateTime` has 100 ns precision.

## 9. Ready for later (features, no format break)

| Later addition | Industry precedent | Why later |
|---|---|---|
| Zstandard codec | The common default for Parquet and ORC | Built into .NET 11 (`ZstandardStream`); experimental in Node since 22.15. Add it when both are standard on our targets |
| Bit-packed and run-length encodings (dictionary ids, small integers, booleans) | Parquet's RLE hybrid and `DELTA_BINARY_PACKED` | Faster decoding (SIMD-friendly) and smaller files, as a decode-speed project of its own |
| Byte-stream-split for floats | Parquet `BYTE_STREAM_SPLIT` | Better float compression |
| Roaring bitmaps for deletes and index postings | Delta and Iceberg deletion vectors; Lucene | Smaller, faster indexes (P-13) |
| Bloom filters | Parquet split-block Bloom filters | Fast "not in this chunk" checks for high-cardinality columns |
| Microsecond and nanosecond timestamps | Arrow and Parquet timestamp units | .NET precision |
| Export to Arrow IPC and Parquet | — | DuckDB, Polars, pandas and Spark could read JAZMIN data directly (interop) |

## 10. API changes (unreleased, so done once)

- **JS:** `access.rowGroupBy` becomes `access.partitionBy`.
- **.NET:** `RowGroupBy` becomes `PartitionBy`.
- **Reader properties:** `visibleRowGroups` becomes `visiblePartitions`.
- **The guide, samples and key service** are updated with them.
- **Nothing else in the APIs changes.**

## 11. Order of work

| Step | Content |
|---|---|
| 1 | Spec rewrite (`draft-jazmin-format-03`, "JAZMIN format 1.0") and `jazmin.proto` |
| 2 | Container: `JZM1`, trailer, Protocol Buffers catalog, features, tables, statistics blocks, one sorted index kind, ordered decimals; the row layout and draft paths removed; new fixtures from both libraries |
| 3 | Access control: partitions, per-partition directories, statistics for access keys, column definitions per group, signature section |
| 4 | Incremental appends |
| 5 | Benchmarks against the targets, and guide updates |

Each step is a PR with tests in both libraries and interop fixtures written by each.

## 12. Decisions to confirm

1. **Protocol Buffers wire format** for the header and catalog, with a published `.proto` and no
   library dependency (section 4).
2. **Reader and writer features** instead of minor versions (section 5).
3. **Magic `JZM1` at both ends;** draft files are refused with a clear message (section 3).
4. **"Row groups" renamed to partitions** in the spec and APIs (sections 6 and 10).
5. **Ordered decimals** compared numerically, with the exact text kept (section 8).
6. **Partition and `sortedBy` columns in the default column group,** and partition and column-group
   names shared across tables (sections 6.3 and 7).

## 13. Results

Measured against the previous (draft) format on the same machine, Node 24 and .NET 10, steady
state. The scenarios mirror the targets above; `bench/access.js` and `-- access` in .NET cover
the statement workload.

| | Before | 1.0 | Target |
|---|---:|---:|---|
| Open, 10,000 chunks (JS / .NET) | 2.7 / 6.2 ms | 0.95 / 1.4 ms | ≥ 3× faster parsing ✓ |
| Access key open, 5,000 partitions, one grant (JS / .NET) | 5.0 / 8.0 ms | 1.1 / 1.4 ms | < 3 ms ✓ |
| Access key open, 5,000 partitions, 5,000 / 50,000 grants (.NET) | 12.6 ms / — | 1.4 / 1.5 ms | < 2 ms at 50,000 (P-16) ✓ |
| Bytes added by an append, 5,000 chunks (plain / access) | 114 / 236 KB | 0.4 / 1 KB | < 10 KB ✓ |
| Single-key file: open + read one section (JS) | 1.27 ms, 91 MB | 1.12 ms, 74 MB | no regression ✓ |
| Owner: open + read one section, 5,000 partitions (JS) | 8.7 ms, 276 MB | 1.4 ms, 80 MB | — |
| Owner: per section, file already open (JS / .NET) | 0.18 / 0.10 ms | 0.21 / 0.20 ms | see below |
| Access-controlled file, 5,000 partitions of 274 rows | 9.5 MB | 11.5 MB | see below |

**Decisions made while implementing:**

- **Partitions are listed as they are needed.** A key holder scans the partition table for its
  own entries without decoding the others (writers put each entry's id first; the table is stored
  uncompressed). The owner decodes the table once when it keeps looking up partitions.
- **Chunk details are kept in arrays, and statistics per column,** loaded only for the columns a
  query filters on. This is most of the gain at 10,000 chunks, and it keeps memory flat on wide
  files.
- **Statistics for every partition, including single-chunk ones.** The owner often searches the
  whole data set, and statistics let those searches skip chunks. They cost about 300 bytes per
  partition: on the benchmark file (5,000 partitions of 274 rows) 11.5 MB against 9.5 MB before
  1.0, which had no statistics in access-controlled files. Leaving them out of single-chunk
  partitions (statistics are optional in the spec) would bring it to 9.9 MB.
- **Key slots in pages (P-16).** The slots are split into pages of about 16 KiB, each its own
  section, under a key-slot list that the owner signs and that holds each page's digest. A key
  holder reads the list and one page, so its open no longer grows with the number of keys.
- **Section ids use numbers every reader can work out** (a segment's position, the number of
  deleted rows, a delta's position), so no extra catalog fields are needed (spec 4.4).

**Still open:**

- **Owner lookups in an already open file** read a partition's directory the first time they read
  that partition: 0.21 ms instead of 0.18 ms (JS), 0.20 instead of 0.10 ms (.NET).
