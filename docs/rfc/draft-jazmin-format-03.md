```
Internet-Draft                                              JAZMIN Project
Intended status: Informational                              October 2026
                                                    draft-jazmin-format-03

        JAZMIN: Javascript Secure Zipped Multi Index Notation
                     File Format, Version 1.0
```

## Abstract

JAZMIN is a binary container for tabular records: rows with named, typed
columns, stored column by column in compressed chunks. A file combines a
self-describing schema, per-chunk statistics, secondary indexes, optional
authenticated encryption, per-key access to partitions and column groups,
append-only updates and embedded files, so that a reader can locate and
decode only the data a query needs. This document specifies version 1.0 of
the format: its byte layout, value encodings, catalog, indexes, key
hierarchy, filter language and conversion rules to and from JSON, CSV and
XML.

## Status of This Memo

This is a project draft, not an IETF standard. It is versioned with the
reference implementations in this repository (JavaScript and .NET) and is the
normative contract between them. Where this document and an implementation
disagree, the implementation has a bug. Earlier drafts (draft-01 and
draft-02, formats "1.0" to "1.3" with magic `JZMN`) described pre-release
formats that this version replaces; see Appendix B.

## Table of Contents

1.  Introduction
2.  Conventions and Terminology
3.  Design Goals
4.  File Layout
5.  Data Types and Value Encoding
6.  Catalog
7.  Encryption and Keys
8.  Indexes
9.  Filter Language
10. Conversion to JSON, CSV and XML
11. Reader and Writer Requirements
12. Features and Extensibility
13. Security Considerations
14. Media Type Registration
15. References
Appendix A. Worked Example
Appendix B. Change Log
Appendix C. Design Notes (informative)

---

## 1. Introduction

JSON is the default interchange format for records, but large JSON documents
must usually be parsed in full before a single record can be read. Each record
repeats every property name, and JSON has no native compression, indexing or
encryption. CSV is smaller but untyped, and XML is more verbose than JSON.

JAZMIN keeps JSON's ease of use while addressing these issues:

- **Small:** values are stored column by column inside chunks, with
  per-column encodings (delta, dictionary, bit maps, scaled decimals), and
  every section is compressed.
- **Fast to query:** a reader decodes only the chunks and columns a query
  needs. Per-chunk statistics, sorted indexes and trigram indexes let it skip
  everything that cannot match.
- **Optionally secure:** every section can be encrypted with AES-256-GCM
  under its own key. One owner key can issue access keys that each open only
  some partitions (rows grouped by a column's value) and column groups, for a
  limited time if required.
- **Convertible:** a file converts losslessly to and from JSON arrays of
  objects, and to and from CSV and XML by defined conventions.

Like a Parquet footer, the catalog (the header and the sections it points
to) is written *after* the data. A writer can therefore stream any number of
rows without knowing row counts, offsets or index contents in advance. A
fixed-size trailer at the end of the file points to the header.

## 2. Conventions and Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY" and "OPTIONAL" are to be interpreted as
described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in
all capitals.

- **Table:** a set of rows sharing one list of columns. A file holds one or
  more tables.
- **Row:** one record. Rows are numbered from 0 per table in write order (the
  *row id*).
- **Column:** a named, typed field shared by all rows of a table. Columns
  have a *position* (0-based) in the table's column list.
- **Column group:** a set of columns stored, and in access-controlled files
  locked, together. Files that are not access-controlled have one group,
  `*`.
- **Partition:** the rows of a table that share a value of the partition
  column (access-controlled files), or all rows of the table.
- **Chunk:** a run of consecutive rows of one partition, stored as one
  section per column group (a *chunk part*). Chunks are numbered per table in
  write order (the *ordinal*).
- **Section:** a unit of storage: a 16-byte envelope followed by a payload
  that may be compressed and encrypted (4.3).
- **Catalog:** the header and the sections that describe where the data is
  (6).
- **Key form:** the comparable representation of a value (5.2).

All multi-byte integers are little-endian. "varint" means unsigned LEB128.
"zigzag varint" means a signed integer mapped with ZigZag encoding,
`(n << 1) ^ (n >> 63)` for 64-bit values, and then written as a varint.
"big zigzag varint" is the same mapping applied to an integer of any size
(`n >= 0 ? 2n : -2n - 1`), written as a varint of as many bytes as needed.

**JSON texts.** Besides the values of `json` columns, a file holds JSON
texts that readers use themselves: metadata (6.6), column attributes (6.2),
package settings and file directories (6.8), key-slot bundles (7.6.4) and
the owner directory (7.6.5). A name MUST NOT appear twice in one object of
these texts, at any depth: [RFC8259] leaves the meaning of a repeated name
open, and readers that keep the first, keep the last or fail would read one
file differently. Readers MUST reject a file whose JSON texts repeat a name.
Names are compared after their escapes are decoded, and case matters
(`"Name"` and `"name"` differ). The values of `json` columns are application
data and are not subject to this rule.

## 3. Design Goals

In priority order:

1. correctness and interoperability between implementations;
2. fast selective reads with bounded memory;
3. small files;
4. optional confidentiality, integrity and per-key access;
5. room to grow without breaking files (12);
6. simple implementations without third-party runtime dependencies.

Non-goals: in-place updates (files are written once, and changed by
appending or by writing a new version, 11); arbitrary nested documents as
first-class columns (nested values are stored in `json` columns).

## 4. File Layout

```
+---------------------------+  offset 0
| Preamble (64 bytes)       |
+---------------------------+  offset 64
| Chunk parts               |
| Index sections            |
| Statistics sections       |
| Embedded-file sections    |
| Catalog sections          |
| Key slots      (access)   |
| Header                    |
| Signature      (access)   |
+---------------------------+
| Trailer (44 bytes)        |
+---------------------------+  end of file
```

Readers MUST locate every section only through the offsets recorded in the
trailer and the catalog. The order above is the reference writers' order;
only the trailer's position is fixed.

### 4.1. Preamble

| Offset | Size | Field          | Description                                                  |
|-------:|-----:|----------------|--------------------------------------------------------------|
| 0      | 4    | magic          | ASCII `JZM1` (0x4A 0x5A 0x4D 0x31)                            |
| 4      | 2    | flags          | bit 0 ENCRYPTED, bit 1 PASSWORD, bit 2 ACCESS (7.6), bit 3 APPENDED (11.2). Other bits MUST be 0; readers MUST reject files with unknown bits |
| 6      | 2    | reserved       | 0                                                            |
| 8      | 16   | file_id        | Random bytes, unique per file version; bound into every encrypted section (7.4) |
| 24     | 32   | salt           | Random when ENCRYPTED, otherwise zero                        |
| 56     | 4    | kdf_iterations | PBKDF2 iterations when PASSWORD is set, otherwise 0          |
| 60     | 4    | reserved       | 0                                                            |

A reader that finds the magic `JZMN` (0x4A 0x5A 0x4D 0x4E) has a file in a
pre-release draft format. It MUST refuse it, and SHOULD say so.

### 4.2. Trailer

| Offset | Size | Field             | Description                                              |
|-------:|-----:|-------------------|----------------------------------------------------------|
| 0      | 8    | header_offset     | Absolute offset of the header section                    |
| 8      | 4    | header_length     | Length of the header section (envelope included)         |
| 12     | 8    | keyslots_offset   | Access-controlled files: the key-slot list section (7.6.4); otherwise 0 |
| 20     | 4    | keyslots_length   | Its length, or 0                                         |
| 24     | 8    | signature_offset  | Access-controlled files: the signature section (7.6.4); otherwise 0 |
| 32     | 4    | signature_length  | Its length, or 0                                         |
| 36     | 4    | trailer_crc       | CRC-32 of trailer bytes 0..35                            |
| 40     | 4    | magic             | ASCII `JZM1`                                             |

A trailer is **valid** when its magic and CRC are correct, every section it
names lies after the preamble and before the trailer, and the section that
ends last (header or signature) ends exactly where the trailer begins. A file
without a valid trailer at its end is incomplete (for example, a writer
crashed) and readers MUST reject it, except as described in 11.2.

### 4.3. Section Envelope

Every section is stored as:

| Offset | Size | Field          | Description                                                   |
|-------:|-----:|----------------|---------------------------------------------------------------|
| 0      | 1    | codec          | 0 = none, 1 = Deflate (raw, [RFC1951]), 2 = Brotli ([RFC7932]); 3 is reserved for Zstandard (12) |
| 1      | 1    | flags          | bit 0 ENCRYPTED; other bits 0                                 |
| 2      | 2    | reserved       | 0                                                             |
| 4      | 4    | raw_length     | Length of the payload after decryption and decompression      |
| 8      | 4    | payload_length | Length of the stored payload that follows the envelope        |
| 12     | 4    | crc32          | CRC-32 (IEEE 802.3) of the stored payload bytes               |

The payload is produced by **raw → compress → encrypt**. The CRC is computed
over the stored payload, after encryption.

- Writers MUST store a section with codec 0 when compression does not make it
  smaller.
- Readers MUST verify, in order, the CRC, the authentication tag (if
  encrypted) and that the decompressed length equals `raw_length`.
- Sections are limited to 2^32 − 1 bytes, raw and stored.

### 4.4. Section Identifiers

Every section has an identifier (UTF-8 text). It is bound into the
section's encryption (7.4) and selects its key (7.3, 7.6.3). `<t>` is the
table number (0-based), `<p>` a partition's text form (`*` for the single
partition of a file that is not access-controlled, otherwise its id in
base64url without padding, 7.6.3), and `<g>` a column group name. The other
numbers can all be worked out from the catalog, so every reader of a section
knows its identifier without extra fields:

- `<k>`: the position of a directory segment in its partition's list
  (0-based); the suffix `/<k>` is omitted for the first segment. A statistics
  block uses the number of its segment.
- `<n>` in `deletes/<n>`: the number of deleted row ids the section lists,
  which only grows until a compaction.
- `<d>`: the position of a delta in the header's `deltas` (0-based).
- `<s>`: the append number recorded with the section (`IndexRef.segment`,
  `FilesInfo.segment`); the suffix is omitted when it is 0.

| Section                          | Identifier                                  |
|----------------------------------|---------------------------------------------|
| Header                           | `header`                                    |
| Chunk part                       | `<t>/chunk/<ordinal>/<g>`                   |
| Chunk directory segment          | `<t>/dir/<p>[/<k>]`                          |
| Partition table                  | `<t>/partitions`                            |
| Statistics block *b* of a segment| `<t>/stats/<p>/<b>[/<k>]`                    |
| Column definitions               | `<t>/columns/<g>`                           |
| Deleted rows                     | `<t>/deletes/<n>`                           |
| Index (sorted directory, trigram)| `<t>/index/<column>/<kind>[/<s>]`            |
| Sorted index page *n*            | `<t>/index/<column>/sorted[/<s>]/page/<n>`   |
| Sorted index null postings       | `<t>/index/<column>/sorted[/<s>]/nulls`      |
| Append delta                     | `delta/<d>`                                 |
| Owner directory / owner catalog  | `owner` / `owner/catalog`                   |
| Chunk map / chunks appended since | `<t>/chunkmap` / `<t>/chunkmap/<s>` (7.6.5) |
| Embedded-file directory / block  | `files/dir[/<group>][/<s>]` / `file/<id>/<b>` (6.8) |
| Key-slot list / key-slot page *n* / signature | `keyslots` / `keyslots/<n>` / `signature` |

## 5. Data Types and Value Encoding

### 5.1. Types

| Type       | Meaning                                         | Value encoding (non-null)                                   |
|------------|-------------------------------------------------|-------------------------------------------------------------|
| `bool`     | true / false                                    | 1 byte: 0 or 1                                               |
| `int`      | signed 64-bit integer                           | zigzag varint                                                |
| `float`    | IEEE 754 binary64                               | 8 bytes                                                      |
| `decimal`  | exact decimal number                            | varint *scale*, then big zigzag varint *m*: the value is m × 10^−scale |
| `string`   | Unicode text                                    | varint length + UTF-8                                        |
| `datetime` | instant since 1970-01-01T00:00Z, in the column's unit (milliseconds in 1.0) | zigzag varint                    |
| `binary`   | bytes                                           | varint length + bytes                                        |
| `json`     | any JSON value (nested objects, arrays)         | varint length + UTF-8 JSON text [RFC8259]                    |
| `list`     | items of one type (5.4)                         | in streams of their own (5.4)                                |
| `object`   | named fields, each of its own type (5.4)        | in streams of their own (5.4)                                |

Notes:

- **Decimals** are written and read as text matching `-?\d+(\.\d+)?` (no
  exponent). The digits after the point give the scale: `12.50` is *m* = 1250,
  scale 2, and is read back as `12.50`. Text is canonical: leading zeros are
  removed and `-0`, `-0.0` and so on become `0`, `0.0`. Writers MUST reject a
  scale above 255 or more than 256 significant digits.
- **Datetimes** are UTC. Implementations MUST convert local times to UTC
  before encoding.
- **`json`** values MUST NOT be the JSON literal `null`, which is a null cell.
- **Lists and objects** need the reader feature `nested-columns` (12). Their
  items and fields have any type, lists and objects included, at most 64
  levels below the column.

### 5.2. Key Form and Ordering

To compare values, implementations convert them to *key form*:

- `datetime`: its integer.
- `float`: −0 becomes +0.
- `decimal`: (*m*, scale) reduced by removing trailing zeros of *m* while the
  scale is above 0, so `1.50` and `1.5` have the key form (15, 1).
- every other type: unchanged.

Ordering per type:

- `bool`: false < true.
- `int`, `datetime`: numeric order.
- `float`: numeric order. NaN is unordered: it is never equal to any value,
  is never indexed, and is excluded from statistics.
- `decimal`: numeric order of *m* × 10^−scale. Values are equal when their key
  forms are equal.
- `string`: ordinal order of UTF-16 code units (JavaScript `<`, .NET
  `string.CompareOrdinal`).

`binary`, `json`, `list` and `object` are not ordered and have no key form.

### 5.3. Chunk Encoding

A chunk part's raw payload stores one *stream* per column of its column group,
in position order:

```
payload = for each column, in position order:
            stream_length : varint
            stream        : stream_length bytes
```

`stream_length` lets a reader skip columns it does not need. A stream is:

```
stream = flags      : 1 byte
                      bits 0-3  encoding (table below)
                      bit 4     HAS_NULLS
                      bits 5-7  reserved, MUST be 0
         null_bitmap: ceil(row_count / 8) bytes, only when HAS_NULLS is set;
                      bit r (LSB first) set => row r is null
         body       : the values of the non-null rows, in row order
```

`row_count` is the chunk's row count from its directory (6.3).

| Id | Encoding | Column types | Body |
|---|---|---|---|
| 0 | plain | all | each value encoded as in 5.1 |
| 1 | delta | `int`, `datetime` | the first value as a zigzag varint, then each later value as the zigzag varint of (value − previous value) |
| 2 | dictionary | `string`, `decimal` | `k` (varint, at least 1), then `k` distinct entries encoded as in 5.1, then one varint index (< `k`) per value |
| 3 | bitmap | `bool` | `ceil(n / 8)` bytes, where `n` is the number of values; bit `i` (LSB first) is value `i` |
| 4 | scaled float | `float` | per value: one byte `s`. If `s` ≤ 22, a zigzag varint `m` with \|m\| ≤ 2^53 follows, and the value is `m / 10^s` computed as one IEEE 754 binary64 division. If `s` = 255, the 8-byte binary64 value follows. Other values of `s` are invalid |
| 5 | nested | `list`, `object` | the streams of the values' parts (5.4) |

Rules:

- Writers choose each stream's encoding. Readers MUST support every encoding
  in the table (nested, with the reader feature `nested-columns`). New
  encodings are added only through reader features (12).
- `list` and `object` columns use encoding 5, and no other column does.
- Writers MUST use delta only when every difference fits in a signed 64-bit
  integer, and scaled float with `s` ≤ 22 only when `m / 10^s` reproduces the
  value's bits exactly. −0, NaN and infinities use `s` = 255.
- Readers MUST reject: an unknown encoding or one not allowed for the column
  type; reserved flag bits that are set; a stream whose length does not match
  its contents; a dictionary index out of range; a payload with bytes left
  over.

Informative: the reference writers use delta for `int` and `datetime` when it
is smaller than plain, dictionary when at most half the values are distinct,
bitmap for `bool`, and scaled float when most values are short decimals.

### 5.4. Nested Columns

A `list` or `object` column stores the parts of its values in streams of
their own, so a reader decodes only the fields a query uses, and repeated
text is stored once per chunk. Its definition (6.2) gives the type of a
list's items (`item`) or an object's fields (`fields`: at least one, in
position order, with unique names). A file with such a column MUST list the
reader feature `nested-columns` (12).

The column's stream uses encoding 5. After its flags and null bitmap (5.3),
its body holds *child streams*. Each is in the stream format of 5.3
(`stream_length`, flags, null bitmap, body), but counts *entries* instead of
rows:

```
object body = for each field, in position order:
                stream_length : varint
                stream        : one entry per non-null object
list body   = stream_length : varint
              lengths       : an int stream, one entry per non-null list
              stream_length : varint
              items         : one entry per item: sum(lengths) entries
```

- The column's entries are the chunk's rows. A field's entries are its
  object's non-null entries, in order. A list's items are the items of its
  non-null lists, in order: the first list's items, then the next list's.
- The lengths stream uses plain or delta encoding, with HAS_NULLS clear.
  Each length is a list's number of items (0 or more).
- A child stream for a list or object uses encoding 5 again. Any other child
  stream uses the encodings of its type (5.3).
- An item or field that is not `required` may be null; its stream's null
  bitmap says which.
- **Fields added later.** An object's body MAY end before its last fields:
  their streams are missing, and each of its entries has null for them.
  This is how a file gains fields when rows are appended (11.2): chunks
  written before keep their bytes, and the definition in the catalog gains
  the fields. Writers add fields only at the end of an object, and only
  fields that are not `required`; they never remove, rename, reorder or
  change fields of a file they append to (a rewrite can). Readers MUST
  reject a missing stream of a `required` field.

Example: a column `staff`, a list of objects {`name`: string, `tags`: list of
string}, with three rows: `[{"name":"A","tags":["x"]},{"name":null,"tags":[]}]`,
null, and `[]`:

```
staff  : flags 0x15 (encoding 5, HAS_NULLS), nulls 0b010
  lengths : flags 0x00, 2, 0            (rows 0 and 2)
  items   : flags 0x05                  (2 objects, none null)
    name  : flags 0x10, nulls 0b10, "A"
    tags  : flags 0x05                  (2 lists, none null)
      lengths : flags 0x00, 1, 0
      items   : flags 0x00, "x"
```

As bytes, with each stream's length first (a chunk part holding only this
column): `17 15 02 03 00 04 00 10 05 04 10 02 01 41 09 05 03 00 02 00 03 00 01
78`.

In addition to 5.3 (and the missing fields above), readers MUST reject: a lengths stream with HAS_NULLS set
or a negative length; lengths whose sum exceeds 2^31 − 1; a definition nested
more than 64 levels below its column (6.2); a list without an item, an object
without fields, or either on another type.

Informative: the reference libraries store list and object members this way
only when asked to (a setting, or a per-member attribute); otherwise such
members are `json` columns. A lookup of one row decodes only that row's
slice of each stream.

## 6. Catalog

The header and the catalog sections are messages of the schema
`spec/jazmin.proto`, encoded with the Protocol Buffers wire format [PROTOBUF].
Readers MUST ignore fields they do not recognise. Writers MUST NOT give a
different meaning to a field defined there. Repeated numeric fields are
packed. In the descriptions below, a list "as differences" holds its first
value as is and every later value as the difference from the previous one.

### 6.1. Header

The header section (`header`) holds a `Header` message:

- `reader_features` and `writer_features` (12).
- `created`, and `modified` / `append_count` for appended files (11.2).
- `metadata`: a free-form JSON object, as text, for application data. In an
  encrypted file it is encrypted with the rest of the header.
- `tables`: at least one `Table` (6.2).
- `keyring`: the secrets of a file encrypted with a key or password (7.3).
- `files`: embedded files (6.8).
- `access`: access-controlled files (7.6).
- `deltas`: the append deltas (11.2), oldest first.

A reader opening a file reads the trailer, the header and, for a key holder
of an access-controlled file, the key slots and signature (7.6). Everything
else is read when a query needs it.

### 6.2. Tables and Columns

A `Table` has a `name`, its `column_count`, its column groups, `sorted_by`
(6.7), `partition_by` (7.6.2), its row, deleted-row and chunk counts, its
partitions (6.3), its indexes (8) and its deleted rows (11.2).

- **Columns** have a `position`, a unique non-empty `name`, a `type`,
  `required` (nulls not allowed), an optional `description` and optional
  `attributes` (a JSON object as text, for units, display formats and so on),
  and for `datetime` a `unit`.
- **Lists and objects** (5.4) also have their `item` or their `fields`, which
  are `Column` messages too. A field's `position` is its index among its
  object's fields; `required` says whether an item or field may never be
  null. Items and fields have no indexes.
- **Column groups** list every column exactly once. The default group `*`
  comes first. Files that are not access-controlled have only `*`, listing
  every column. In access-controlled files, restricted groups list only
  their `column_count` and a `definitions` section (7.6.5).
- Writers MUST reject a null value in a `required` column and values that do
  not match the column type.

A file MAY hold several tables. A reader that exposes one table at a time
MUST let the caller choose the table by name and SHOULD default to the first.

### 6.3. Partitions and Chunk Directories

A table's **partitions** are listed in the header (`partitions`), in a
`PartitionTable` section (`partition_table`), or both. A writer MAY use the
section when there are many partitions, and the reference writers do so
above 64. A table without a partition column has exactly one partition: in a
file that is not access-controlled its id is empty, and in an
access-controlled file it is the partition named `*`, with an id derived like
any other (7.6.3). Readers combine the lists and then apply the deltas
(11.2).

Partition table entries are sorted by id. Writers SHOULD encode each
`Partition`'s `id` field first, so that a reader can find its own partitions
in a large table without decoding the others. A reader needs only the
partitions it reads: a key holder its own, and the owner those its query
selects.

Each partition lists its **chunk directory segments**, oldest first. A
segment is a `ChunkDirectory` section (`<t>/dir/<p>[/<k>]`) describing some
of the partition's chunks, in ascending ordinal order:

- `ordinals`, `row_starts` (the first row id of each chunk), both as
  differences, and `row_counts`;
- for each chunk, one part per column group, in group order: `part_offsets`
  (as differences, across the whole segment) and `part_lengths`, and in
  access-controlled files `part_digests` (32 bytes per part);
- `statistics`: the segment's statistics blocks (6.4).

Rules:

- Within a table, ordinals are unique and numbered from 0 with no gaps. A
  chunk's rows are `row_start` to `row_start + row_count − 1`. Chunks of all
  partitions together cover the table's row ids exactly once, in ordinal
  order.
- Readers MUST reject a segment whose lists have inconsistent lengths, and
  parts that lie outside the file.

### 6.4. Statistics

Each directory segment lists **statistics blocks**. A block covers some
columns (`columns`, by position) for every chunk of the segment and points to
a `Statistics` section holding, per covered column, one entry per chunk:

- `null_counts`: the number of null cells;
- `min` and `max`: bounds in key form (6.5), or empty when unbounded.

Bounds are present only for ordered types. A float bound is omitted when it
is not finite. A string `min` MAY be truncated to its first 64 UTF-16 code
units (without splitting a surrogate pair), because a prefix is still a lower
bound. A string `max` MUST be omitted when it is longer than 64 code units.

- In access-controlled files, a block MUST cover columns of one column group
  only, and is locked like that group's chunk parts (7.6.3).
- Statistics are optional: a segment MAY list no blocks, or blocks for some
  columns only. Readers treat missing statistics as unknown.
- Readers MUST reject a block whose lists do not have one entry per chunk of
  the segment.
- A reader MAY skip a chunk only when statistics prove no row can match
  (9.4).

Informative: the reference writers write one block per column for tables
with one partition, so a query loads only the statistics of the columns it
filters on; and one block per partition and column group in
access-controlled files, which keeps the number of sections small with many
partitions.

### 6.5. Key-Form Bytes

Statistics bounds and sorted-index keys store key forms as bytes:

| Type       | Bytes                                                          |
|------------|----------------------------------------------------------------|
| `bool`     | 1 byte: 0 or 1                                                 |
| `int`, `datetime` | zigzag varint                                           |
| `float`    | 8 bytes binary64 (finite values only)                          |
| `decimal`  | varint scale, then big zigzag varint *m*, of the reduced key form |
| `string`   | UTF-8 (in index pages: varint length + UTF-8, as in 5.1)       |

### 6.6. Metadata

`metadata` is a free-form JSON object for application data (source system,
export time, owner and so on).

### 6.7. Sort Order

`sorted_by` lists column names. It declares that a table's rows are in
non-decreasing order of those columns, compared as in 5.2 with nulls first.
Writers MUST reject rows that break the declared order. Readers MAY rely on
it, for example to binary-search the statistics of the leading column, and
writers SHOULD NOT build a sorted index on the leading column, because
statistics already locate its values.

### 6.8. Embedded Files

A file MAY also store other files: HTML, scripts, styles, fonts, images,
audio, video, PDFs and so on. The header's `files` lists the **file
directory** sections (`directories`, each with a `group`), the next unused
content id (`next_content`), viewer settings (`package`, a JSON object as
text) and `segment` when an append wrote the directories.

- In files that are not access-controlled there is one directory, with group
  `*`. In access-controlled files there is one per file group, with `group`
  set to the group id (7.6.3).
- `package` holds the entry path (which MUST be a stored path), a title, the
  https origins the page may contact, and whether WebAssembly is allowed.
  Viewers MUST treat stored files as untrusted content and SHOULD derive the
  page's security policy from these settings only.
- Writers MUST NOT reuse a content id within a file, so block section ids
  stay unique across appends.

**File directory** (UTF-8 JSON; section id `files/dir`, or `files/dir/<group
id>` in access-controlled files, followed by `/<s>` when written by append
*s*):

```json
{
  "files": [ { "path": "img/logo.png", "type": "image/png", "content": 0, "groups": ["*"] } ],
  "contents": [ {
    "id": 0, "size": 3150, "sha256": "<hex>", "blockSize": 262144, "key": "<base64>",
    "blocks": [ { "offset": 0, "length": 0, "digest": "<base64>" } ]
  } ]
}
```

- `path` is relative, separated by `/`, 1 to 1024 characters, without empty,
  `.` or `..` segments or backslashes. A directory MUST NOT list a path
  twice.
- `type` is a media type. `content` refers to an entry of `contents`.
- `groups` (files that are not access-controlled) lists the groups that may
  see the file: `*` for everyone, or group names. Access-controlled
  directories omit it, so a key does not learn the names of other groups.
- **Stored once:** within one version of a file, writers MUST store identical
  bytes (the same `sha256`) as a single content, however many paths or groups
  refer to it.
- A content's bytes are split into blocks of `blockSize` bytes (the last may
  be shorter). Block `b` is the section `file/<id>/<b>` (compressed when that
  helps). An empty file has no blocks.
- `key` (encrypted files only) is the content's random 32-byte key `K`. Block
  `b` is encrypted with `HKDF-SHA256(ikm = K, salt = preamble.salt,
  info = "JAZMIN/1/file/<id>/<b>")`.
- `digest` (access-controlled files only) is the base64 SHA-256 of the
  block's whole section. Readers MUST verify it.
- Readers MUST check `sha256` when they read a whole file.

Directory keys: none (not encrypted); `HKDF-SHA256(ikm = master, salt =
keyring.files, info = "JAZMIN/1/" || section_id)` (key or password); and in
access-controlled files `HKDF-SHA256(ikm = F(id), salt = preamble.salt, info
= "JAZMIN/1/" || section_id)`, where `F(id) = HKDF-SHA256(ikm = O, salt =
preamble.salt, info = "JAZMIN/1/file-group/" || id)`.

In access-controlled files, file groups use the partition id derivation
(7.6.3) on the group's name, and the owner directory lists `fileGroups`. A
grant MAY carry `files`: `*` or a list of extra file-group names. A key sees a
file group when its name is `*`, is in the grant's `files`, is one of the
grant's partitions, or the grant has `partitions: "*"` and the name is a
partition present in the file. The access bundle carries `files`: the ids of
the groups the key sees, mapped to base64 `F(id)`. A reader opens every
directory it has a secret for and merges the entries by path.

An append writes new directory sections (with `segment`) listing every
remaining file; files it keeps refer to their existing contents. A full
rewrite stores the files again under fresh keys and keeps only referenced
contents.

## 7. Encryption and Keys

### 7.1. Algorithms

| Purpose                        | Algorithm                                                  |
|--------------------------------|------------------------------------------------------------|
| Authenticated encryption       | AES-256-GCM, 96-bit random nonce, 128-bit tag [NIST SP 800-38D] |
| Key derivation from a key      | HKDF-SHA256 [RFC5869]                                       |
| Key derivation from a password | PBKDF2-HMAC-SHA256 [RFC8018]                                |
| Owner signatures               | ECDSA P-256 with SHA-256 [FIPS 186-5]                       |
| Integrity of plaintext files   | CRC-32 (detects accidental corruption only)                 |

All of these are available natively in browsers (WebCrypto), Node.js and
.NET. No custom cryptography is used. An encrypted section's stored payload
is `nonce (12) || ciphertext || tag (16)`.

### 7.2. Master Key

The master key is 32 random bytes. Its text form is:

```
"jzk1-" || base64url_nopad( key || SHA-256(key)[0..3] )
```

The 4-byte checksum lets software detect a mistyped or truncated key before
attempting decryption. Implementations MUST verify it when parsing.

Alternatively the master key is derived from a password:
`master = PBKDF2-HMAC-SHA256(UTF-8(password), salt, kdf_iterations, 32)`. The
PASSWORD flag is set and `kdf_iterations` is recorded in the preamble.
Writers SHOULD use at least 600,000 iterations and MUST NOT use fewer than
1,000. Readers MUST honour the recorded value, MUST refuse a value below
1,000, and MAY refuse a value above a limit of their own, before deriving
the key: a hostile file could otherwise tie up the reader for hours. The
reference implementations write and read at most 10,000,000.

### 7.3. Keys of Files Encrypted With a Key or Password

```
header_key  = HKDF-SHA256(ikm = master, salt = preamble.salt,  info = "JAZMIN/1/header")
section_key = HKDF-SHA256(ikm = master, salt = keyring[group], info = "JAZMIN/1/" || section_id)
```

The header carries the keyring: three 32-byte random secrets. The `index`
group locks index sections, `files` the embedded-file directories (present
only when the file stores files), and `data` every other section. Each
section's key depends on both the master key and a keyring secret, so every
section has a unique key.

### 7.4. Associated Data

Every encrypted section uses this associated data:

```
AAD = file_id (16 bytes) || envelope bytes 0..7 || UTF-8(section_id)
```

This binds each ciphertext to its file, codec, length and identity. Moving,
swapping or copying sections, or changing the codec byte, makes
authentication fail.

### 7.5. Rules

- In an encrypted file, every section except the key slots and the signature
  MUST be encrypted. A reader MUST reject an unencrypted section where
  encryption is required, which prevents downgrade attacks.
- A reader given a key or password for a file that is not encrypted MUST
  fail rather than silently read plaintext.
- Nonces MUST come from a cryptographically secure random generator. Because
  every section key is unique, random 96-bit nonces are safe.
- Writing a new version of a file MUST use a new `file_id` and salt. Appends
  keep them (11.2).

### 7.6. Access-Controlled Files

An access-controlled file lets one **owner key** issue any number of **access
keys**. Each access key opens only the partitions and column groups it was
granted, and only the owner key can produce a file that readers accept. Such
a file sets the flags ENCRYPTED and ACCESS. PASSWORD MUST NOT be set, and
`kdf_iterations` is 0.

#### 7.6.1. Keys

- **Owner key:** a master key as in 7.2 (`jzk1-...`).
- **Owner signing key** (ECDSA P-256), derived deterministically:

  ```
  d = (OS2IP(HKDF-SHA256(ikm = owner key, salt = "", info = "JAZMIN/1/owner-signing", L = 48)) mod (n - 1)) + 1
  Q = d * G                       (65-byte uncompressed point 0x04 || X || Y)
  fingerprint = SHA-256(Q)[0..7]
  ```

  Here `n` is the order of P-256.
- **Access key text:**
  `"jza1-" || base64url_nopad( secret(32) || fingerprint(8) || SHA-256(secret || fingerprint)[0..3] )`.
  `secret` is 32 random bytes chosen by the owner. Readers MUST verify the
  checksum.
- **Slot id:** `SHA-256("JAZMIN/1/slot-id" || s)[0..7]`, where `s` is the
  owner key bytes or the access key's secret.

#### 7.6.2. Partitions and Column Groups

- **Partitions.** If a table's `partition_by` names a column (of type
  `string` or `int`, in the default column group), each row belongs to the
  partition named by that value's text form: decimal digits for `int`, the
  empty string for null. Otherwise the table has one partition. **A chunk
  MUST contain rows of one partition only**, so writers start a new chunk
  when the partition changes, and SHOULD receive rows grouped by partition.
- **Column groups.** Groups are named (`[A-Za-z0-9_.-]{1,64}`). Columns not
  listed in a named group form the default group `*`, which comes first. The
  partition column and the `sorted_by` columns MUST be in the default group.
- Partition names and column-group names are shared by all tables of a file:
  a grant of partition `C1` covers `C1` in every table.

#### 7.6.3. Secrets

Each version of a file has two fresh random 32-byte secrets, `H` (header) and
`O` (owner). Everything else is derived from them, with the preamble salt:

| Purpose                     | Derivation |
|-----------------------------|------------|
| Partition id                | `HMAC-SHA256(HKDF(O, salt, "JAZMIN/1/partition-id"), UTF-8(name))[0..11]` |
| Partition secret `P(id)`    | `HKDF(O, salt, "JAZMIN/1/partition/" \|\| base64url(id))` |
| Column group secret `C(g)`  | `HKDF(O, salt, "JAZMIN/1/column-group/" \|\| g)` |

Section keys (`HKDF(ikm, salt, info)` with `info = "JAZMIN/1/" || section_id`
unless stated):

| Sections | ikm |
|---|---|
| Header | `H`, with `info = "JAZMIN/1/header"` |
| Partition table, append deltas, deleted rows | `H` |
| Chunk directory segments of partition *p* | `P(p)` |
| Chunk parts, and statistics blocks, of partition *p* and column group *g* | `P(p) \|\| C(g)` |
| Column definitions of group *g* | `C(g)` |
| Indexes, index pages, owner catalog, chunk map | `O` |
| Owner directory | `O`, with `info = "JAZMIN/1/owner"` |

So:
- opening a chunk part or its statistics needs both its partition's secret
  and its column group's secret;
- an access key receives only the secrets it was granted, from which `O` and
  every other secret cannot be computed;
- partition ids are keyed by `O`, so they reveal nothing about names.

#### 7.6.4. Key Slots and Signature

**Key slots** are kept in **pages**, so that a key holder reads and checks
only the page that holds its slot, however many keys the file has. The slots,
sorted by slot id (ids unique), are split into consecutive pages. Each page is
a section `keyslots/<n>` (n = 0, 1, ...), unencrypted, codec 0, whose raw
payload is:

```
slot count      u32
slot table      count x { slot id (8) | offset u32 | length u32 }, sorted by id;
                the high bit of length marks an online slot (7.7)
sealed slots    offsets are relative to the first sealed slot
```

The **key-slot list** (`keyslots`, unencrypted, codec 0), which the trailer
names, lists the pages:

```
page count      u32
pages           count x { first slot id (8) | offset u64 | length u32 | SHA-256 of the page section (32) },
                sorted by first slot id
```

A key's slot can only be in the last page whose first slot id is not greater
than the key's slot id. Writers choose the page size; the reference writers
aim at about 16 KiB of raw payload per page. Readers MUST refuse a key-slot
list, key-slot page or signature section that is encrypted or uses a codec
other than 0.

A sealed slot is `nonce || AES-256-GCM(key = HKDF(s, salt, "JAZMIN/1/slot"),
aad = file_id || slot id) || tag` over a UTF-8 JSON bundle, where `s` is the
key the slot belongs to:

- **Owner bundle:** `{ "header": b64(H), "owner": b64(O) }`
- **Access bundle:** `{ "header": b64(H), "partitions": { id: b64(P(id)) },
  "partitionNames": { id: name }, "columns": { g: b64(C(g)) } }` (ids in
  base64url), plus `expires` / `online` (7.7), `files` (6.8) and
  `submission` (7.8). Readers MUST ignore bundle fields they don't know.

A grant of all rows (`rows: "*"`) covers every partition present in that
version of the file.

**Signature section** (`signature`): unencrypted, codec 0. Its raw payload is
the owner public key `Q` (65 bytes) followed by an ECDSA P-256 / SHA-256
signature (64 bytes, r || s) over:

```
"JAZMIN/1/signature" || file_id || SHA-256(key-slot list section bytes) || SHA-256(header section bytes)
```

The key-slot list holds every page's digest, and every other section's digest
is in the header or in a section the header's digests cover, so the signature
covers the whole file.

#### 7.6.5. Catalog Differences

- Every `SectionRef` carries the section's SHA-256 (`digest`), and every
  chunk directory segment carries its parts' digests. Readers MUST verify
  each section they read against its digest, and MUST refuse a reference
  without one. In encrypted files, readers MUST also refuse an embedded
  content without a `key` (6.8).
- The owner directory SHOULD be stored with codec 0: its size would
  otherwise hint at the secrets and names it holds (13).
- The header's restricted column groups list only their name,
  `column_count` and `definitions`. A key holder decrypts the definitions of
  the groups it was granted, so it does not learn the names or types of
  other groups' columns.
- Indexes are listed in the owner catalog (`AccessInfo.owner_catalog`),
  not in the table, because they describe every partition and their column
  names could reveal restricted columns. Only the owner uses indexes.
- **Chunk map.** A table's entry in the owner catalog MAY reference a
  chunk map: for every chunk ordinal, its row count and its partition (a
  `ChunkMap` message). A chunk's first row id is the sum of the earlier
  chunks' row counts. With it, the owner finds the partition holding a row
  an index names and reads only that partition's chunk directory, instead
  of every partition's. Only the owner reads it (key `O`), because it
  reveals every partition's size.
  - **Sections:** a full write writes the table's whole map as section
    `<t>/chunkmap` (`chunk_map`). An append keeps it, and writes the chunks
    appended since the full write, the earlier appends' and its own, as
    `<t>/chunkmap/<s>` (`chunk_map_appended`, with `chunk_map_segment` =
    *s*). So a reader reads at most two map sections, and an append writes
    only the appended chunks, not the whole map.
  - **Writers** that write one MUST cover every chunk of the table. An
    append to a file without one, or with one that does not cover its
    chunks, writes none.
  - **Readers** join the two sections, and MUST ignore a map whose chunk
    count or total row count differs from the table's. A map only says
    where to look: readers MUST check the chunk directories they then read
    against it, and on any difference read every partition's directory
    instead.
  - **Files without a map** remain valid; readers then read every
    partition's chunk directory, as before.
- The owner directory (`owner`, UTF-8 JSON) holds `{ "partitions": [names],
  "fileGroups": [names], "grants": [ { "key": "jza1-...", "rows": "*" |
  [partition names], "columns": "*" | [names], "files": ..., "label": "...", "expires":
  ..., "mode": ..., "share": ... } ] }`. Only the owner reads it.

#### 7.6.6. Reading

1. Read the signature section. With an owner key, `Q` MUST equal the key's
   derived public key. With an access key, `fingerprint(Q)` MUST equal the
   key's fingerprint. Otherwise fail with "not signed by the owner of this
   key".
2. Verify the signature. If it fails, raise a format error.
3. Find the page that can hold the key's slot in the key-slot list (binary
   search), read it and verify it against its digest; then find the slot in
   the page (binary search). If there is none, fail with "not granted".
   Unseal it (7.7) and decrypt the header.
4. For each table, find the key's partitions (their ids are in the bundle)
   in the header's partitions and the partition table (6.3), and add the
   segments that deltas list for them. Read only their directory segments,
   and the definitions of the granted column groups. The owner reads a
   partition's directory segments when a query needs that partition; with a
   chunk map (7.6.5), an index lookup needs only the partitions holding the
   rows it names.
5. Apply what the key may see. Readers MUST NOT return other partitions'
   rows or other groups' columns, and SHOULD report how many rows are
   hidden. A filter or projection naming a column the key cannot see MUST
   fail as if the column did not exist.

#### 7.6.7. Authority

- Only the owner key can create or modify an access-controlled file that
  readers accept. Writers MUST reject a grant whose fingerprint does not
  match the owner key.
- Every new version (11.1) MUST use a fresh `file_id`, salt, `H` and `O`.
  Revoked keys therefore cannot read new versions.

### 7.7. Time-Limited Access

A grant MAY carry an expiry and a mode. These live in the owner directory;
the access bundle carries `expires` and, for online grants, `online: true`.
The owner directory also keeps an online grant's `share` (base64, 32 random
bytes), which never goes into the bundle. Writers MUST omit grants whose
expiry is not after the time of writing.

**Offline grants (library-enforced).** When a reader opens a file with an
access key whose bundle has `expires`, it MUST refuse if any of these holds:

1. the current time is after `expires`;
2. the current time is more than 5 minutes earlier than the header's
   `modified` (or `created`) time;
3. the current time is more than 5 minutes earlier than the last time this
   key opened this file on this device.

For check 3, readers SHOULD keep a per-user record named `<file_id
hex>.<key id hex>.json`, containing `{ "lastSeen": <epoch ms>, "mac": <hex>
}`, where `mac = HMAC-SHA256(HKDF(access secret, salt = file_id, info =
"JAZMIN/1/last-seen"), decimal lastSeen)`. Readers MUST refuse when the MAC
does not verify, and update `lastSeen` when the clock is later.

**Online grants (key-service-enforced).** The slot is sealed with `KEK =
HKDF(access secret || share, salt, "JAZMIN/1/slot")` and marked online in the
slot table. A reader cannot open it without the share, which the owner's key
service provides as an **unlock token**:
`"jzu1-" || base64url_nopad(share || SHA-256(share)[0..3])`. To request one, a
client needs only the file id (from the preamble) and its key id. A key
service SHOULD issue tokens only before the grant's expiry and MAY apply any
other policy (authentication, 2FA, auditing). Readers MUST also apply the
offline checks to online grants that carry `expires`. Shares stay the same
across appends and rewrites, so stored tokens remain valid until the grant is
revoked or expires.

**Limits.** Offline expiry is enforced by readers: someone who controls their
machine can delete the last-seen record or use a modified reader. Online
expiry prevents new opens after expiry, but not the use of data already
obtained.

### 7.8. Submission Keys

An access key's holder can send files back to the owner, for example
records captured offline, without holding any key that opens the owner's
shared file. Such a file is an ordinary file encrypted with a key (7.3). Its
master key is the holder's **submission key**:

```
submission key = HKDF-SHA256(ikm = owner key, salt = "", info = "JAZMIN/1/submission/" || key id, L = 32)
```

Here `key id` is the access key's slot id (7.6.1) in lowercase hexadecimal
(16 characters).

- **Writers** SHOULD put it, base64, in each access bundle as `submission`
  (7.6.4).
- **The holder** gets it only by opening the shared file with the access key
  (and, for an online grant, its unlock token). The owner derives it.
- **The guarantee:** a file locked with it was made by someone who opened the
  shared file with that key. An access key alone, without the file, is not
  enough.
- **Readers** that don't know the field ignore it. Files written before it
  have none, until the owner's next rewrite.

The submission key opens nothing in the shared file. Neither the owner key nor
the access key can be worked out from it.

Software that files submitted files into a shared file:
- SHOULD identify the sender by the access key's slot id and open the file
  with that key's submission key;
- SHOULD refuse a file that does not open with it;
- SHOULD write the rows only into the partitions granted to that key;
- SHOULD refuse the files of revoked or expired keys.

Test vector: for the owner key `00 01 02 ... 1f` and the key id
`0001020304050607`, the submission key is
`457ac056dd344efb467cdc8a574b1469c328daafd2f09fe14782cd2818ecf29e`.

## 8. Indexes

**Postings** are lists of ascending row ids, written as `varint count,
varint first, varint delta...`. Every index section and page, and the
deleted-rows section, starts with one **encoding byte**: 0 for the encodings
in this document. Other values are reserved for reader features (12), and
readers MUST reject them otherwise.

### 8.1. Sorted Index (`sorted`)

Allowed for ordered types (`bool`, `int`, `float`, `decimal`, `string`,
`datetime`). The index's entries are its distinct key forms in ascending
order (5.2), each with its postings; NaN floats are not indexed. The entries
are cut into **pages**, each its own section, with an `IndexDirectory`
section in front:

- **Page payload:** encoding byte (0), varint entry count, then per entry the
  key (6.5, strings with their length) and its postings.
- **Directory:** each page's `first_keys`, `entry_counts`, `page_offsets` (as
  differences), `page_lengths` and, in access-controlled files,
  `page_digests`; and `nulls`, a section holding the encoding byte and the
  postings of null cells (absent when there are none).

**Page payload, encoding 1** (reader feature `index-deltas`, 12): as
encoding 0, with keys and first row ids as differences from the previous
entry's. Each page decodes on its own:

- **`int` and `datetime` keys:** the page's first key is a zigzag varint, as
  in encoding 0; each later key is a varint of its difference from the
  previous key (at least 1, as keys ascend).
- **`string` keys:** varint *shared*, varint *rest*, then *rest* bytes. The
  key's UTF-8 bytes are the first *shared* bytes of the previous key's,
  followed by those (*shared* is 0 for the page's first key).
- **Keys of other types:** as in encoding 0.
- **Postings:** varint count (at least 1); the first row id as a zigzag
  varint of its difference from the previous entry's first row id (from 0
  for the page's first entry); then varint deltas, as in encoding 0.

A file with a page in encoding 1 lists `index-deltas` in `reader_features`.
Readers MUST reject encoding 1 in a file that does not.

A key *v* can only be on the last page whose first key is at most *v*. `eq`
and `in` read that page; `gt` and `gte` read it and every later page; `lt`
and `lte` read every page up to it; `startsWith` reads from the prefix's page
while the next page's first key still starts with the prefix. Readers MUST
check that a page holds `entry_count` entries.

Informative: the reference writers cut pages of about 64 KiB of raw entries,
so a small index is one page. They cut encoding 1 pages where encoding 0
pages would be cut, so a lookup decodes as many entries, and write encoding
1 only when asked to, until a major version makes it the default.

### 8.2. Trigram Index (`trigram`)

Allowed for `string`. Each value is lower-cased with ASCII-only folding
(`A`–`Z` become `a`–`z`; every other code unit is unchanged), which keeps the
index identical across implementations, and split into its distinct
overlapping 3-code-unit substrings. The payload is:

```
encoding byte (0)
varint gram_count
repeat gram_count (ascending, ordinal):
    3 x uint16 code units
    postings
```

To answer `contains` or `icontains` with text *t*, the reader intersects the
postings of all trigrams of *t*. The result is a superset of the matches, and
the reader MUST then evaluate the real condition on each candidate. The index
cannot help when *t* is shorter than 3 code units, or for `icontains` when
*t* contains non-ASCII characters.

### 8.3. Index Segments

An index entry (`IndexRef`) names the `column`, the `kind`, the `section` and
the `segment`: 0 for an index written with the file, *s* for the index of the
rows added by append *s*. Readers MUST combine every segment of a column and
kind by the union of their results.

## 9. Filter Language

### 9.1. Syntax

A filter is a JSON object, deliberately the same shape as common GraphQL
`where` input types:

```json
{ "country": "ZA",
  "age": { "gte": 18, "lt": 65 },
  "or": [ { "name": { "icontains": "smith" } }, { "vip": true } ],
  "not": { "status": { "in": ["closed", "void"] } } }
```

- Members of one object are combined with AND.
- `and` / `or` take arrays of filters; `not` takes one filter.
- `{ "col": value }` is shorthand for `{ "col": { "eq": value } }`.
- `{ "col": null }` means `isNull: true`.

### 9.2. Operators

| Operator              | Types              | Meaning                                         |
|-----------------------|--------------------|-------------------------------------------------|
| `eq`, `ne`, `in`      | ordered types      | equal / not equal / equal to any element of an array |
| `gt` `gte` `lt` `lte` | ordered types      | comparison (5.2)                                |
| `contains`            | `string`           | case-sensitive substring                        |
| `icontains`           | `string`           | case-insensitive substring                      |
| `startsWith`          | `string`           | case-sensitive prefix                           |
| `isNull`              | all                | `true`: cell is null; `false`: cell is not null |

Operands are converted to the column type: `"42"` is accepted for an `int`
column, an ISO-8601 string for a `datetime` column, and a number or decimal
text for a `decimal` column. An unknown column, an unknown operator, or an
operator invalid for the column type MUST be reported as an error.

### 9.3. Null Semantics

As in SQL, every operator except `isNull` is false when the cell is null. In
particular, `ne` does not match nulls; to include them, combine it with
`isNull`.

### 9.4. Evaluation Strategy (informative)

1. **Index planning.** For an AND, intersect the candidates of every
   condition with a usable index. For an OR, take the union, but only if
   every branch has a usable index. NOT and `ne` produce no candidates.
2. **Chunk pruning.** Without candidates, skip any chunk whose statistics
   prove no row can match.
3. **Exact check.** Always evaluate the full filter on each row read.

Indexes and statistics are optimisations only: results MUST equal those of a
full scan.

## 10. Conversion to JSON, CSV and XML

### 10.1. JSON

A table corresponds to a JSON array of objects, one per row, with members in
column order.

| Type       | JSON representation                                 |
|------------|-----------------------------------------------------|
| `int`      | number (exact digits, even beyond 2^53)             |
| `decimal`  | number, with the value's canonical text (5.1)       |
| `float`    | number; NaN and ±Infinity become `null`             |
| `datetime` | string `YYYY-MM-DDTHH:mm:ss.sssZ`                   |
| `binary`   | base64 string                                       |
| `json`     | the nested value                                    |
| `list`     | array of its items                                  |
| `object`   | object with every field, in position order          |

The items and fields of lists and objects use the forms of their types, and
a null item or field is `null`.

Null cells are written as `null`, or omitted when the caller asks. When
importing JSON without a schema: integers become `int` and other numbers
`float` (`int` mixed with `float` becomes `float`); strings become `string`
(datetime detection is optional); booleans become `bool`; objects and arrays
become `json`; any other mix becomes `json`. A column is nullable if any row
omits it or holds null.

### 10.2. CSV

Follows [RFC4180]; the first record is the header. An **unquoted empty field
is null**; a **quoted empty field (`""`) is an empty string**. Values use the
text forms from 10.1 (JSON text for `json` columns). On import, a column
becomes `int`, `float` or `bool` only if every non-null value matches;
otherwise it is `string`. Type inference can be turned off, for example to
keep leading zeros.

### 10.3. XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<jazmin>
  <row><id>1</id><name>Ann</name></row>
  <row><id>2</id><field name="first name">Bob</field></row>
</jazmin>
```

Null cells are omitted. A column whose name is not a valid XML name, or that
starts with `xml`, is written as `<field name="...">`. Values with characters
forbidden by XML 1.0 cannot be exported: writers MUST report an error rather
than corrupt the output. Import infers types as for CSV, and importers MUST
disable DTD processing.

## 11. Reader and Writer Requirements

Writers:

- MUST validate every value against its column type and `required`, and MUST
  reject rows that name unknown columns.
- MUST write the trailer only after every other section, so an interrupted
  write never yields a file that readers accept.
- SHOULD bound memory to one chunk of rows plus the index build state. The
  reference defaults are 4,096 rows or 1 MiB of raw data per chunk.

Readers:

- MUST read only the trailer, the header and, for access-controlled files,
  the key slots, signature, partition table and the key's own directories
  when opening, and everything else on demand.
- MUST verify integrity as described in 4.3 and 7.6.5.
- MUST treat every length, offset and count as untrusted. Values outside the
  file or inconsistent with each other MUST produce a format error, never a
  crash or an over-read, and memory MUST be bounded by `raw_length`.

### 11.1. Updating Files

Files are never modified in place, except by appending (11.2). An update
reads the current version, applies the changes (inserts, upserts by key
columns, deletes by filter, metadata, grants and revocations), writes a
complete new version to a temporary file in the same directory, and
atomically renames it over the original. Readers see the old file or the new
one, never a mix.

- A table declaring `sorted_by` MUST keep that order.
- Indexes and metadata carry over unless explicitly changed.
- Updating an access-controlled file requires the owner key, and re-issues
  the remaining grants with fresh secrets (7.6.7).

### 11.2. Appending to Files

An append adds changes after the current trailer without modifying any
existing byte except the preamble flags. Its cost is proportional to the
change. Readers that opened the file earlier keep reading the version they
opened.

**What an append writes**, after the previous trailer:

1. the new chunk parts;
2. for each partition that received rows, a new directory segment
   (`<t>/dir/<p>/<k>`, 4.4) with its statistics blocks;
3. for each index, a segment covering the new rows (8.3);
4. the complete sorted list of deleted row ids (`<t>/deletes/<n>`, encoding
   byte then postings), when rows were deleted;
5. a delta section (`delta/<d>`, a `Delta` message) listing the new segments
   and new partitions, when the table's partitions are in a partition table,
   when the file already has deltas, or when listing them in the header would
   exceed the writer's limit; otherwise the new segments are listed in the
   header;
6. in access-controlled files: when the file has a chunk map, a section of
   the chunks appended since its last full write (7.6.5); a new owner
   catalog; and new key-slot pages, key-slot list and owner directory only
   when grants or partitions changed;
7. a new header with `append_count` = *s*, `modified`, the updated counts,
   indexes, deletes and the deltas; the signature (access-controlled files);
   and a new trailer.

The previous header and trailer become unused bytes, which a compaction
removes.

An append MAY give objects of nested columns new fields at their end (5.4):
the new header (or, for a restricted column group, a new definitions
section) holds the grown definitions, and the chunks written before have no
streams for those fields. No other change to the columns is allowed.

**Deleted rows.** Readers MUST NOT return rows in the table's deletes, and
row counts exclude them. Upserts are a deletion plus an appended row.

**Row ids and order.** Appended rows continue the table's row ids and chunk
ordinals. In a table declaring `sorted_by`, appended rows MUST sort at or
after the last existing row; inserting elsewhere needs a full rewrite.

**Flag.** The writer sets the APPENDED flag before writing anything else.

**Access-controlled files.** Only the owner key may append. `H` and `O` are
reused, because existing sections must stay readable. New grants are allowed,
and so is widening an existing one. **Revoking a key requires a full
rewrite** (7.6.7), and so does narrowing a grant: fewer partitions, column
groups or file groups, a new or earlier expiry, or offline to online. A key
keeps the secrets it already received, so after such an append it could
still read the new data. Writers MUST refuse to narrow a grant in an append.
Appends MUST drop expired grants from the key slots.

**Durability and recovery.** Writers MUST flush the new sections to stable
storage before writing the new trailer, and flush again afterwards. If an
append is interrupted, the file ends with bytes that are not a valid trailer.
A reader of a file with the APPENDED flag then scans backwards for the most
recent valid trailer (4.2) and uses that version. The next append MUST
truncate the file to the end of that trailer first. A writer that abandons
an append MUST restore the previous length and flags.

**Concurrency (informative).** The reference implementations allow one
writer at a time, enforced with a lock file named `<path>.lock`. Readers are
never blocked.

**Compaction** is a full rewrite with no changes. It drops deleted rows and
unused bytes, merges segments, and re-locks access-controlled files with
fresh secrets. The result has `append_count` 0 and the APPENDED flag clear.

## 12. Features and Extensibility

- **Optional information** is added as new catalog fields (6). Readers ignore
  fields they do not know, so such additions need no version change.
- **Anything a reader must understand** to read correctly, such as a codec,
  a column encoding, a value type or unit, an index encoding or a new kind of
  section, is announced by a **reader feature**. Its name goes in the header's
  `reader_features` when, and only when, the file uses it. A reader that
  finds an unknown reader feature MUST refuse the file and SHOULD name the
  feature.
- **Anything a writer must preserve** when appending to or rewriting a file
  is announced by a **writer feature** (`writer_features`). A writer MUST
  refuse to modify a file with a writer feature it does not support.
  Reader features are also writer features.
- Feature names are lowercase ASCII letters, digits and `-`. Format 1.0
  defined none. Defined since: the reader features `index-deltas` (8.1) and
  `nested-columns` (5.4). A file that uses none has empty lists.
- The magic `JZM1` changes only if the container itself changes
  incompatibly.

Reserved names (informative): `zstd` (codec 3, [RFC8878]), `bitpacked`
(bit-packed and run-length column encodings), `byte-stream-split` (float
encoding), `roaring` (Roaring bitmap postings and deletes), `bloom-filter`
(statistics extension), `datetime-us` and `datetime-ns` (time units).

## 13. Security Considerations

- **Confidentiality covers content, not shape.** In an encrypted file the
  total size, the number and sizes of sections, whether a password was used
  and the KDF iteration count stay visible; row counts can be roughly
  inferred. Writers that must hide sizes SHOULD use fixed chunk sizes.
- **Compression side channels.** Compressing before encrypting can leak
  information when an attacker can inject chosen data into the same section
  as a secret and observe ciphertext lengths (CRIME/BREACH). Applications
  that mix attacker-controlled data with secrets in one section SHOULD use
  codec 0.
- **Integrity of plaintext files.** CRC-32 detects accidental corruption, not
  malicious changes. Use encryption or an external signature when tampering
  matters.
- **Key management.** The master key, password or owner key is the only
  secret; lose it and the data is unrecoverable. Store keys in a secret
  manager, never next to the file. PBKDF2 slows guessing but cannot protect a
  weak password.
- **Resource exhaustion.** Readers MUST bound memory by `raw_length` and
  MUST NOT trust declared lengths or counts, list lengths (5.4) included.
- **Access control hides values and restricted column names, not shape.**
  Every key holder can see: the default column group's columns; the names and
  column counts of restricted groups; user metadata (do not store secrets
  there); the number of partitions (as opaque ids) and of key slots; and the
  sizes of sections. A key holder sees statistics only of partitions and
  column groups it was granted.
- **Revocation applies to new versions only.** A copy of an old version and
  a revoked key still give what that key was granted in that copy.
- **The signature proves who produced a file, not who saw it.** Anyone can
  copy data they may see into a file of their own; it will not verify as the
  owner's.
- **Compromise of an access key** exposes only what it was granted.
  Compromise of the owner key exposes everything and allows forging files, so
  protect it like a signing key. A key service that issues unlock tokens
  (7.7) needs only the grants' shares, not the owner key.
- **More that every key holder can see:** the ids of deleted rows in every
  partition (they are locked with `H`), and the package settings, including
  the entry path and title (6.8). Slot ids do not depend on the file, so
  someone holding several files can tell which share a key holder.
- **An appended file can be rolled back.** Cutting a file at the trailer of
  an earlier version gives that version, which the owner did sign, so readers
  accept it. Applications that need the latest version should record
  `append_count` or the file length elsewhere.
- **Shared access keys.** The owner fingerprint is 64 bits. Holders of the
  same access key rely on it to reject files not signed by the owner, so a
  forged file costs a second preimage of about 2^64 work.

## 14. Media Type Registration

- Type name: `application`
- Subtype name: `vnd.jazmin`
- Required parameters: none
- Encoding considerations: binary
- File extension: `.jzm`
- Magic number: `4A 5A 4D 31` ("JZM1") at offset 0 and in the last 4 bytes
- Security considerations: Section 13

## 15. References

- [RFC2119] Key words for use in RFCs to Indicate Requirement Levels.
- [RFC8174] Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- [RFC8259] The JavaScript Object Notation (JSON) Data Interchange Format.
- [RFC4180] Common Format and MIME Type for CSV Files.
- [RFC1951] DEFLATE Compressed Data Format Specification.
- [RFC7932] Brotli Compressed Data Format.
- [RFC8878] Zstandard Compression and the application/zstd Media Type.
- [RFC5869] HMAC-based Extract-and-Expand Key Derivation Function (HKDF).
- [RFC8018] PKCS #5: Password-Based Cryptography Specification Version 2.1.
- [NIST SP 800-38D] Recommendation for Block Cipher Modes of Operation: GCM.
- [FIPS 186-5] Digital Signature Standard (DSS).
- [PROTOBUF] Protocol Buffers: Encoding (protobuf.dev/programming-guides/encoding).
- [XML 1.0] Extensible Markup Language (XML) 1.0 (Fifth Edition), W3C.

## Appendix A. Worked Example

Writing the rows `{id: 1, name: "Ann"}` and `{id: 2, name: null}` to a table
with columns `id: int` and `name: string` gives one chunk with one part
(column group `*`). Its raw payload is:

```
03              stream length 3: column id
  00            flags: plain, no nulls
  02 04         1 and 2 as zigzag varints
06              stream length 6: column name
  10            flags: plain, HAS_NULLS
  02            null bitmap: row 1 is null
  03 41 6E 6E   "Ann" (length 3, UTF-8)
```

That is 11 bytes, against 44 bytes for the equivalent compact JSON. Because
so little data cannot be compressed, the writer stores it with codec 0. The
preamble, catalog and trailer add a fixed overhead of a few hundred bytes, so
JAZMIN is not intended for tiny payloads.

The shared interoperability fixtures in `spec/fixtures/` contain complete
files (plain, Brotli, key, password, access-controlled, appended, paged
indexes, embedded files) written by both reference implementations.

## Appendix B. Change Log

- **draft-01, draft-02 (pre-release formats "1.0" to "1.3", magic `JZMN`):**
  row and columnar chunk layouts, JSON header, access-controlled files with
  row groups, appends, time-limited access, embedded files, paged indexes.
- **draft-03 (format 1.0, the first released format, magic `JZM1`):**
  - one chunk layout (columnar); the row layout is removed;
  - the catalog uses the Protocol Buffers wire format (`spec/jazmin.proto`),
    with binary chunk directories and statistics blocks;
  - reader and writer features replace minor versions (12);
  - tables: a file holds one or more tables;
  - "row groups" are now **partitions**; each partition has its own chunk
    directory, and access keys read only their own;
  - statistics for access-controlled files, locked like the data;
  - restricted column groups' definitions are encrypted;
  - the signature has its own section, and the trailer names the key slots
    and signature, so appends can reuse unchanged sections;
  - appends write only the directory segments of the partitions they change
    (and a delta for large partition tables);
  - `decimal` is an ordered type, stored as a scale and an integer, compared
    numerically;
  - one sorted index kind (paged), and an encoding byte on every index,
    deletes and postings section;
  - section identifiers use numbers every reader can work out from the
    catalog (4.4); statistics are optional (6.4); a table without a
    partition column in an access-controlled file has one partition named
    `*`;
  - key slots are kept in pages under a signed list, so a key holder's open
    does not grow with the number of keys (7.6.4);
  - after the internal security review: limits on password iterations
    (7.2), key-slot and signature sections only as stored (7.6.4), digests
    required (7.6.5), appends may not narrow grants (11.2), and more in
    Security Considerations (13).
- **Since format 1.0, without changing the format:** submission keys (7.8),
  carried in a new optional field of the access bundle (7.6.4).
- **Since format 1.0, new optional fields:** the owner's chunk map (7.6.5),
  sections referenced from `TableIndexes.chunk_map` and
  `chunk_map_appended` in the owner catalog. Readers that don't know them
  ignore them, as Protocol Buffers readers do with unknown fields.
- **Since format 1.0, a reader feature:** `index-deltas` (8.1), sorted
  index pages (encoding 1) whose keys and first row ids are differences from
  the previous entry's. Readers that do not know it refuse such files,
  naming it, as 12 requires.
- **Since format 1.0, a reader feature:** `nested-columns` (5.4), the
  `list` and `object` column types, stored as streams of their parts
  (encoding 5) and defined by the new `Column` fields `fields` and `item`.
  Readers that do not know it refuse such files (those of releases 1.0 to
  1.3 report the unknown column type).
- **Since format 1.0, a rule writers already kept:** no name twice in one
  object of the JSON texts readers use themselves (2). Readers reject such a
  file; before, one library kept the last value and the other failed.

## Appendix C. Design Notes (informative)

Measurements behind the access-control design (1.37 million rows in 5,000
partitions, one access key per partition):

- **Derived secrets.** Storing a random secret per partition in the owner's
  slot made it 477 KB. Deriving `P` and `C` from `O` keeps it at about 100
  bytes whatever the number of partitions.
- **Binary, sorted slot table.** With one JSON slot list, opening the file
  took 33 ms and grew with the number of keys. A binary search over a sorted
  table, decrypting only the matching slot, reduced it to 7–10 ms
  independent of the number of keys.
- **Owner directory.** Grants (which contain access keys) and partition
  names are needed only by the owner, so readers never pay for them.
- **Per-partition directories.** In the draft formats the header listed
  every chunk: about 1 MB of JSON at 5,000 partitions, roughly 5 ms of the
  open. Each partition now has its own directory, so an access key's open
  depends only on its own data.

The catalog's encoding follows the practice of other columnar formats
(Parquet uses Thrift, ORC and Lance use Protocol Buffers, Arrow uses
FlatBuffers): a schema-defined encoding whose readers skip unknown fields,
so optional information can be added without breaking files. Reader and
writer features follow Delta Lake's table features.
