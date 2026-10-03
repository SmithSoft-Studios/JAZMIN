```
Internet-Draft                                              JAZMIN Project
Intended status: Informational                              October 2026
                                                    draft-jazmin-format-02

        JAZMIN: Javascript Secure Zipped Multi Index Notation
                     File Format, Version 1.3
```

> **Superseded** by [draft-jazmin-format-03](draft-jazmin-format-03.md) (format 1.0, the first released format). This draft describes the pre-release formats that the libraries implement until format 1.0 lands.

## Abstract

JAZMIN is a binary container for tabular records (rows with named, typed
columns). It combines a self-describing schema, per-chunk compression,
secondary indexes and optional authenticated encryption in a single file, so
that a reader can locate and decode only the rows a query needs. This
document specifies version 1.3 of the format: its byte layout, value
encodings, index structures, key hierarchy, filter language and conversion
rules to and from JSON, CSV and XML. Version 1.1 adds access-controlled files,
in which one owner key issues access keys that each open only some rows and
columns. It also adds the `sortedBy` header member and rules for updating
files. Version 1.2 adds append-only updates (11.2) and time-limited access
(7.7). Version 1.3 adds the columnar chunk layout (5.4), embedded files
(6.8) and paged sorted indexes (8.3).

## Status of This Memo

This is a project draft, not an IETF standard. It is versioned with the
reference implementations in this repository (JavaScript and .NET) and is the
normative contract between them. Where this document and an implementation
disagree, the implementation has a bug.

## Table of Contents

1.  Introduction
2.  Conventions and Terminology
3.  Design Goals and Non-Goals
4.  File Layout
5.  Data Types and Value Encoding
6.  Header
7.  Encryption and Key Hierarchy
8.  Indexes
9.  Filter Language
10. Conversion to JSON, CSV and XML
11. Reader and Writer Requirements
12. Versioning and Extensibility
13. Security Considerations
14. Media Type Registration
15. References
Appendix A. Worked Example
Appendix B. Change Log
Appendix C. Design Notes on Access Control (informative)

---

## 1. Introduction

JSON is the default interchange format for records, but large JSON documents
must usually be parsed in full before a single record can be read. Each record
repeats every property name, and JSON has no native compression, indexing or
encryption. CSV is smaller but untyped. XML is typed only through external
schemas and is more verbose than JSON.

JAZMIN keeps JSON's ease of use while addressing these issues:

- **Small:** values are stored in a compact binary form, column names appear
  once, and every chunk is compressed (Deflate or Brotli).
- **Fast to query:** rows are stored in independently readable chunks. Sorted
  and trigram indexes, plus per-chunk statistics, let a reader skip
  everything that cannot match.
- **Optionally secure:** every section can be encrypted with AES-256-GCM under
  a per-section key derived from one master key or password.
- **Convertible:** a JAZMIN file converts losslessly to and from JSON arrays of
  objects. Conversion to and from CSV and XML follows defined conventions.

Logically a file has two parts, as in the original design sketch:

```
Header  { header details (format version, columns), metadata, multi indexes }
Data    [ rows x columns ]
```

Physically the header is written *after* the data, like a ZIP central
directory or a Parquet footer. A writer can therefore stream any number of
rows without knowing the final row count, offsets or index contents in
advance. A fixed-size trailer at the end of the file points to the header.

## 2. Conventions and Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY" and "OPTIONAL" are to be interpreted as
described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in
all capitals.

- **Row:** one record. Rows are numbered from 0 in write order (the *row id*).
- **Column:** a named, typed field shared by all rows.
- **Chunk:** a contiguous run of rows stored as one section.
- **Section:** a unit of storage: a 16-byte envelope followed by a payload that
  may be compressed and/or encrypted.
- **Key form:** the comparable representation of a value, used for ordering
  and equality (Section 5.3).

All multi-byte integers are little-endian. "varint" means unsigned LEB128,
and "zigzag varint" means a signed 64-bit integer mapped with ZigZag encoding,
`(n << 1) ^ (n >> 63)`, and then written as a varint.

## 3. Design Goals and Non-Goals

Goals, in priority order: correctness and interoperability; small size; fast
selective reads with bounded memory; optional confidentiality and integrity;
simple implementation (each reference implementation is a few thousand
lines with no third-party runtime dependencies).

Non-goals for version 1:

- **In-place updates.** Files are written once. To change data, write a new file.
- **Arbitrary nested documents as first-class columns.** Nested values are
  stored in `json` columns, which can be filtered only by `isNull`.
- **Columnar analytics.** Whole-column aggregation is the domain of Apache
  Parquet/ORC. Version 1.3 adds a columnar chunk layout (5.4), which keeps the
  row-group design but stores each column's values together inside a chunk.

## 4. File Layout

```
+-----------------------+  offset 0
| Preamble (64 bytes)   |
+-----------------------+  offset 64
| Chunk section 0       |
| Chunk section 1       |
| ...                   |
| Index section(s)      |
| Header section        |
+-----------------------+
| Trailer (24 bytes)    |
+-----------------------+  end of file
```

Chunk sections MUST appear in row order. Writers SHOULD place index sections
after all chunk sections and the header section last, but readers MUST locate
every section only through the offsets recorded in the header.

### 4.1. Preamble

| Offset | Size | Field           | Description                                                                 |
|-------:|-----:|-----------------|-----------------------------------------------------------------------------|
| 0      | 4    | magic           | ASCII `JZMN` (0x4A 0x5A 0x4D 0x4E)                                          |
| 4      | 1    | version_major   | 1. Readers MUST reject other major versions.                                |
| 5      | 1    | version_minor   | 0, or 1 for access-controlled files (7.6). Readers MUST accept any minor version of a supported major version. |
| 6      | 2    | flags           | bit 0 ENCRYPTED, bit 1 PASSWORD, bit 2 ACCESS (7.6), bit 3 APPENDED (11.2). Other bits MUST be 0 when writing; readers MUST reject files with unknown flag bits |
| 8      | 16   | file_id         | Random bytes, unique per file; bound into every encrypted section (7.4)     |
| 24     | 32   | salt            | Random when ENCRYPTED, otherwise zero                                       |
| 56     | 4    | kdf_iterations  | PBKDF2 iterations when PASSWORD is set, otherwise 0                         |
| 60     | 4    | reserved        | 0                                                                           |

### 4.2. Trailer

| Offset (from trailer start) | Size | Field          | Description                                        |
|---------------------------:|-----:|----------------|----------------------------------------------------|
| 0                          | 8    | header_offset  | Absolute offset of the header section              |
| 8                          | 4    | header_length  | Total length of the header section (envelope + payload) |
| 12                         | 4    | keyslots_length | Access-controlled files: length of the key-slot section, which immediately precedes the header section (7.6.4). Otherwise 0 |
| 16                         | 4    | trailer_crc    | CRC-32 of trailer bytes 0..15                      |
| 20                         | 4    | magic          | ASCII `JZMN`                                       |

A file without a valid trailer is incomplete, for example because a writer
crashed. Readers MUST reject it.

### 4.3. Section Envelope

Every chunk, index and header is stored as a section:

| Offset | Size | Field          | Description                                                         |
|-------:|-----:|----------------|---------------------------------------------------------------------|
| 0      | 1    | codec          | 0 = none, 1 = Deflate (raw, RFC 1951), 2 = Brotli (RFC 7932)        |
| 1      | 1    | flags          | bit 0 ENCRYPTED                                                     |
| 2      | 2    | reserved       | 0                                                                   |
| 4      | 4    | raw_length     | Length of the payload after decryption and decompression            |
| 8      | 4    | payload_length | Length of the stored payload that follows the envelope              |
| 12     | 4    | crc32          | CRC-32 (IEEE 802.3) of the stored payload bytes                     |

The payload is produced by this pipeline: **raw → compress → encrypt**.
Encryption is applied only when the section's ENCRYPTED flag is set. The CRC
is computed over the stored payload, after encryption.

- Writers MUST store a section with codec 0 when compression does not make it
  smaller.
- Readers MUST verify, in order, the CRC, the authentication tag (if
  encrypted) and that the decompressed length equals `raw_length`.
- Sections are limited to 2^32 − 1 bytes, raw and stored.

Compression MUST happen before encryption, because ciphertext does not
compress.

## 5. Data Types and Value Encoding

### 5.1. Types

| Type       | Meaning                                         | Binary encoding (non-null)                         | Ordered | Equality |
|------------|-------------------------------------------------|----------------------------------------------------|:-------:|:--------:|
| `bool`     | true / false                                    | 1 byte: 0 or 1                                     | yes     | yes      |
| `int`      | signed 64-bit integer                           | zigzag varint                                      | yes     | yes      |
| `float`    | IEEE 754 binary64                               | 8 bytes                                            | yes     | yes      |
| `decimal`  | exact decimal, text matching `-?\d+(\.\d+)?`    | varint length + UTF-8                              | no      | yes (textual) |
| `string`   | Unicode text                                    | varint length + UTF-8                              | yes     | yes      |
| `datetime` | instant, milliseconds since 1970-01-01T00:00Z   | zigzag varint                                      | yes     | yes      |
| `binary`   | bytes                                           | varint length + bytes                              | no      | no       |
| `json`     | any JSON value (nested objects, arrays)         | varint length + UTF-8 JSON text [RFC8259]          | no      | no       |

Notes:

- `decimal` values are compared as text, so `1.5` and `1.50` are different
  values. Writers MUST NOT use exponent notation.
- `datetime` has millisecond precision. Implementations MUST convert local
  times to UTC before encoding.
- `json` values MUST NOT be the JSON literal `null`; that is a null cell.

### 5.2. Row Encoding (layout "row")

A chunk payload is the concatenation of its rows. Each row is:

```
null_bitmap : ceil(column_count / 8) bytes; bit i (LSB first) set => column i is null
values      : for each non-null column in column order, its encoding from 5.1
```

The number of rows in a chunk comes from the header. A reader MUST reject a
chunk with bytes left over after its last row.

### 5.3. Key Form and Ordering

To compare values, implementations convert them to *key form*:

- datetime becomes its millisecond integer.
- float −0 becomes +0.
- Every other type is unchanged.

Ordering per type:

- `bool`: false < true.
- `int` and `datetime`: numeric order.
- `float`: numeric order. NaN is unordered: it is never equal to any value,
  is never indexed, and is excluded from statistics.
- `string`: ordinal order of UTF-16 code units. This matches JavaScript `<`
  and .NET `string.CompareOrdinal`.

### 5.4. Column Encoding (layout "columnar", version 1.3)

With `"layout": "columnar"` in the header, a chunk payload (or, in an
access-controlled file, a chunk part) stores one *stream* per column, for the
same columns and in the same order that the row layout would use:

```
payload = for each column, in order:
            stream_length : varuint
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
         body       : the values of the non-null rows, in row order, using the encoding
```

`row_count` is the chunk's row count from the header. Without HAS_NULLS,
every row has a value.

| Id | Encoding | Column types | Body |
|---|---|---|---|
| 0 | plain | all | each value encoded as in 5.1 |
| 1 | delta | `int`, `datetime` | the first value as a zigzag varint, then each later value as the zigzag varint of (value − previous value). `datetime` uses its millisecond key form. |
| 2 | dictionary | `string`, `decimal` | `k` (varuint, at least 1), then `k` distinct entries (varuint length + UTF-8), then one varuint index (< `k`) per value |
| 3 | bitmap | `bool` | `ceil(n / 8)` bytes, where `n` is the number of values; bit `i` (LSB first) is value `i` |
| 4 | scaled decimal | `float` | per value: one scale byte `s`. If `s` ≤ 22, a zigzag varint `m` with \|m\| ≤ 2^53 follows, and the value is `m / 10^s` computed as one IEEE 754 binary64 division. If `s` = 255, the 8-byte binary64 value follows. Other scales are invalid. |

Rules:

- Writers choose the encoding of each stream. Readers MUST support every
  encoding in the table.
- Writers MUST use delta only when every difference fits in a signed 64-bit
  integer.
- Writers MUST use scale `s` ≤ 22 only when `m / 10^s` gives exactly the
  value's bits. Because `m` and `10^s` are then exact binary64 numbers, the
  single division is correctly rounded, so every conforming implementation
  computes the same value. −0, NaN and infinities use scale 255.
- Readers MUST reject:
  - an unknown encoding, or one not allowed for the column type;
  - reserved flag bits that are set;
  - a stream whose length does not match its contents;
  - a dictionary index that is out of range;
  - a payload with bytes left over after its last stream.
- A file using this layout MUST set `version_minor` to at least 3 and
  `version` to at least `"1.3"`. Readers that do not support the layout reject
  it, as 12 requires.

Informative: the reference writers use delta for `int` and `datetime` when it
is smaller than plain, dictionary when at most half the values are distinct,
bitmap for `bool`, and scaled decimal for `float` when most values are short
decimals. Grouping a column's values together lets the compressor find far
more repetition. On the benchmark data in the user guide, the payload
compresses to about half the size of gzipped JSON.

## 6. Header

The header section's raw payload is a UTF-8 JSON object [RFC8259]:

```json
{
  "format": "JAZMIN",
  "version": "1.0",
  "layout": "row",
  "created": "2026-10-01T06:00:00.000Z",
  "rowCount": 3,
  "columns": [
    { "name": "id", "type": "int", "nullable": false, "description": "Customer number" },
    { "name": "name", "type": "string", "nullable": true, "attributes": { "maxLength": 80 } }
  ],
  "metadata": { "source": "crm" },
  "chunks": [
    { "offset": 64, "length": 211, "rowStart": 0, "rowCount": 3,
      "stats": [ { "nulls": 0, "min": "1", "max": "3" }, { "nulls": 1, "min": "Ann", "max": "Bob" } ] }
  ],
  "indexes": [ { "column": "id", "kind": "sorted", "offset": 275, "length": 40 } ],
  "keyring": { "data": "<base64 32 bytes>", "index": "<base64 32 bytes>" }
}
```

### 6.1. Columns

- `name` (REQUIRED, unique, non-empty)
- `type` (REQUIRED, Section 5.1)
- `nullable` (default true)
- `description` (OPTIONAL)
- `attributes` (OPTIONAL, a free-form JSON object for extra details such as
  units, display format or maximum length)

Writers MUST reject a null value in a column whose `nullable` is false.

### 6.2. Metadata

`metadata` is a free-form JSON object for application data (source system,
export time, owner and so on). In an encrypted file it is encrypted with the
rest of the header.

### 6.3. Chunk Directory and Statistics

Each chunk entry gives the section's absolute `offset` and total `length`,
the id of its first row (`rowStart`) and its `rowCount`. Chunks MUST be
contiguous: chunk *n + 1* starts at `rowStart + rowCount` of chunk *n*.

`stats` is an array aligned with `columns`. Each entry is `null` or an object:

- `nulls` (REQUIRED): the number of null cells in the chunk.
- `min` / `max` (OPTIONAL, ordered types only), encoded as follows:
  - `int`: a decimal string. This preserves 64-bit precision in JSON.
  - `datetime`: milliseconds as a JSON number.
  - `float`: a JSON number. Omitted if either bound is not finite.
  - `bool`: a JSON boolean.
  - `string`: `min` MAY be truncated to its first 64 UTF-16 code units,
    because a prefix is still a valid lower bound. `max` MUST be omitted when
    it is longer than 64 code units, because a truncated value is not an
    upper bound.

A reader MAY skip a chunk only when its statistics prove that no row can
match (Section 9.4). A missing bound means "unbounded".

**Statistics sections (version 1.3).** A file in the columnar layout MAY keep
statistics out of the header. Then no chunk entry has `stats`, and the header
has:

```json
"statistics": { "sections": [ { "column": 0, "offset": 0, "length": 0 } ], "segment": 2 }
```

- There is one section per column, with section id `stats/<column index>`,
  followed by `/<segment>` when `segment` is present (set by appends, 11.2).
- Each section is a UTF-8 JSON array with one entry per chunk, in chunk
  order. Each entry is the same object, or `null`, that `stats[column]` would
  hold.
- In encrypted files, sections use the `data` keyring group (7.3).
- Readers SHOULD load only the sections of the columns a query filters or
  sorts on. Opening a file then costs the same however many columns it has.
- Readers MUST reject a section whose length differs from the number of
  chunks.

The reference writers use statistics sections for every columnar file that
is not access-controlled. Access-controlled files have no statistics.

### 6.4. Index Directory

Each entry names a `column`, a `kind` (`sorted`, `sorted-paged` or
`trigram`) and the section `offset` and `length`. For `sorted-paged` the
section is the page directory (8.3). A column MAY have several kinds of index. Readers MUST
ignore index kinds they do not support and fall back to scanning.

### 6.5. Keyring

`keyring` is present only in encrypted files. It maps a group name to a
32-byte random secret, base64-encoded. Version 1 defines two groups: `data`
(chunks) and `index` (indexes). Version 1.3 adds `files` (file directories,
6.8), which writers include only when the file stores files. See Section 7.

### 6.6. Unknown Members

Readers MUST ignore header members they do not recognise. Writers MUST NOT
give a different meaning to a member defined here.

### 6.7. Sort Order

`sortedBy` (OPTIONAL) is an array of column names. It declares that rows are
in non-decreasing order of those columns, compared as in 5.3 with nulls
first. Writers MUST reject rows that break the declared order. Readers MAY use
the declaration, for example to binary-search chunk statistics of the leading
column, or to skip loading an index on that column because the statistics
already locate matches exactly.

### 6.8. Embedded Files (version 1.3)

A file MAY also store other files, such as HTML, scripts, styles, fonts,
images, audio, video and PDFs. A file that stores none has no `files` member,
no file sections and no `files` keyring group, and is otherwise unchanged.

**Header member:**

```json
"files": {
  "directories": [ { "group": "*", "offset": 0, "length": 0, "digest": "…" } ],
  "nextContent": 3,
  "segment": 2,
  "package": { "entry": "index.html", "title": "…", "allowedOrigins": ["https://api.example.com"], "allowWasm": false }
}
```

- `directories` lists the *file directory* sections. In files that are not
  access-controlled there is exactly one, with group `*`. In access-controlled
  files there is one per file group, with `group` set to the group id (7.6.3)
  and `digest` set to the base64 SHA-256 of the whole section.
- `nextContent` is the next unused content id. Writers MUST NOT reuse a content
  id within a file, so block section ids stay unique across appends.
- `segment` is present when the directories were written by an append (11.2).
- `package` (optional) holds settings for viewers that render the files as a
  page: the entry path (which MUST be a stored path), a title, the https
  origins the page may contact, and whether WebAssembly is allowed. Viewers
  MUST treat stored files as untrusted content, and SHOULD derive the page's
  security policy from these settings only.

**File directory** (UTF-8 JSON; section id `files/dir`, or
`files/dir/<group id>` in access-controlled files, followed by `/<segment>`
when `segment` is present):

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
  `.` or `..` segments or backslashes. A directory MUST NOT list a path twice.
- `type` is a media type. `content` refers to an entry of `contents`.
- `groups` (single-key and plain files only) lists the groups that may see the
  file: `*` for everyone, or group names. Access-controlled directories omit it,
  so a key does not learn the names of other groups.
- **Stored once:** within one version of a file, writers MUST store identical
  bytes (the same `sha256`) as a single content, however many paths or groups
  refer to it.
- A content's bytes are split into blocks of `blockSize` bytes (the last may
  be shorter). Block `b` is the section `file/<id>/<b>`, encoded as in 4.3
  (compressed when that helps). An empty file has no blocks.
- `key` (encrypted files only) is the content's random 32-byte key `K`. Block
  `b` is encrypted with `HKDF-SHA256(ikm = K, salt = preamble.salt,
  info = "JAZMIN/1/file/<id>/<b>")`. Unencrypted files omit `key`.
- `digest` (access-controlled files only) is the base64 SHA-256 of the block's
  whole section. Readers MUST verify it.
- Readers MUST check `sha256` when they read a whole file.

**Keys of the directories:**

| File | Directory key |
|---|---|
| Not encrypted | none |
| Key or password (7.2) | `HKDF-SHA256(ikm = master, salt = keyring.files, info = "JAZMIN/1/" \|\| section_id)` |
| Access-controlled (7.6) | `HKDF-SHA256(ikm = F(id), salt = preamble.salt, info = "JAZMIN/1/" \|\| section_id)`, where `F(id) = HKDF-SHA256(ikm = O, salt = preamble.salt, info = "JAZMIN/1/file-group/" \|\| id)` |

**Access-controlled files:**

- File groups use the row-group id derivation (7.6.3) on the group's name.
- The owner directory gains `fileGroups`: the names of the file groups written.
- A grant MAY carry `files`: `*` or a list of extra file-group names.
- An access key sees a file group when:
  - its name is `*`;
  - it is in the grant's `files`;
  - it is one of the grant's row groups;
  - or the grant has `rows: "*"` and the name is a row group present in the
    file.
- The access bundle (7.6.4) gains `files`, which maps the ids of the groups
  the key sees to base64 `F(id)`. The owner derives `F` from `O`.
- A reader opens every directory it has a secret for, and merges the entries
  by path. The same path in two groups is the same file.

**Changes:**

- **An append** (11.2) writes new directory sections (with `segment`) that
  list every remaining file. Files it keeps refer to their existing contents.
  The blocks of removed or replaced files remain in the file until
  compaction.
- **A full rewrite** (11.1) stores the files again, under fresh keys, and
  keeps only the contents that are still referenced.

A file that stores files MUST set `version_minor` to at least 3.

## 7. Encryption and Key Hierarchy

### 7.1. Algorithms

| Purpose                       | Algorithm                                     |
|-------------------------------|-----------------------------------------------|
| Authenticated encryption      | AES-256-GCM, 96-bit random nonce, 128-bit tag [NIST SP 800-38D] |
| Key derivation from a key     | HKDF-SHA256 [RFC5869]                          |
| Key derivation from a password| PBKDF2-HMAC-SHA256 [RFC8018]                   |
| Integrity of plaintext files  | CRC-32 (detects accidental corruption only)    |

All of these are available natively in browsers (WebCrypto), Node.js and
.NET. No custom cryptography is used.

### 7.2. Master Key

The master key is 32 random bytes. Its text form is:

```
"jzk1-" || base64url_nopad( key || SHA-256(key)[0..3] )
```

That is 5 + 48 characters. The 4-byte checksum lets software detect a
mistyped or truncated key *before* attempting decryption and report a clear
error. Implementations MUST verify the checksum when parsing.

Alternatively, the master key is derived from a password:
`master = PBKDF2-HMAC-SHA256(UTF-8(password), salt, kdf_iterations, 32)`.
The PASSWORD flag is set and `kdf_iterations` is recorded in the preamble.

- Writers SHOULD use at least 600,000 iterations (OWASP 2023 guidance).
- Writers MUST NOT use fewer than 1,000.
- Readers MUST honour the recorded value.

### 7.3. Derived Keys

```
header_key  = HKDF-SHA256(ikm = master, salt = preamble.salt,     info = "JAZMIN/1/header")
section_key = HKDF-SHA256(ikm = master, salt = keyring[group],     info = "JAZMIN/1/" || section_id)
```

Section identifiers (UTF-8):

| Section                | section_id                   | group   |
|------------------------|------------------------------|---------|
| Header                 | `header`                     | —       |
| Chunk *n*              | `chunk/<n>` (decimal)        | `data`  |
| Index                  | `index/<column>/<kind>`      | `index` |
| Paged index page *n*   | `index/<column>/sorted-paged/page/<n>` | `index` |
| Paged index nulls      | `index/<column>/sorted-paged/nulls`    | `index` |

The master key opens the header, and the header carries the keyring secrets.
Each section's key is derived from *both* the master key and a keyring
secret, so every section has a unique key. Holding the secrets without the
master key is not enough to decrypt anything.

The keyring groups also give a forward-compatible place for future
per-group access control (Section 12).

### 7.4. Associated Data

Every encrypted section uses this associated data (AAD):

```
AAD = file_id (16 bytes) || envelope bytes 0..7 || UTF-8(section_id)
```

This binds each ciphertext to its file, its codec and length, and its
position. Moving, swapping or copying sections between files, or changing the
codec byte, causes authentication to fail.

### 7.5. Rules

- In an encrypted file, every section MUST be encrypted. A reader MUST reject
  an unencrypted section in a file whose preamble says ENCRYPTED. This
  prevents downgrade attacks.
- A reader that is given a key or password for a file that is not encrypted
  MUST fail rather than silently read plaintext.
- Nonces MUST come from a cryptographically secure random generator. Because
  every section key is unique, random 96-bit nonces are safe.
- Writing a file again MUST use a new `file_id` and `salt`.

### 7.6. Access-Controlled Files (version 1.1)

An access-controlled file lets one **owner key** issue any number of **access
keys**. Each access key opens only the row groups and column groups it was
granted, and only the owner key can produce a file that readers accept.

Such a file sets the preamble flags ENCRYPTED and ACCESS, and sets
`version_minor` to 1. PASSWORD MUST NOT be set, and `kdf_iterations` is 0.

#### 7.6.1. Keys

- **Owner key:** a master key as defined in 7.2 (`jzk1-...`).
- **Owner signing key** (ECDSA P-256), derived deterministically from the
  owner key:

  ```
  d = (OS2IP(HKDF-SHA256(ikm = owner key, salt = "", info = "JAZMIN/1/owner-signing", L = 48)) mod (n - 1)) + 1
  Q = d * G                       (65-byte uncompressed point 0x04 || X || Y)
  fingerprint = SHA-256(Q)[0..7]
  ```

  Here `n` is the order of P-256. Implementations SHOULD compute `Q` without
  relying on platform-specific key import behaviour.
- **Access key text:**

  ```
  "jza1-" || base64url_nopad( secret(32) || fingerprint(8) || SHA-256(secret || fingerprint)[0..3] )
  ```

  `secret` is 32 random bytes chosen by the owner. Readers MUST verify the
  checksum.
- **Slot id:** `SHA-256("JAZMIN/1/slot-id" || s)[0..7]`, where `s` is the owner
  key bytes or the access key's secret.

#### 7.6.2. Groups

- **Row groups.** If `access.rowGroupBy` names a column (which MUST be of type
  `string` or `int`), each row belongs to the group named by that value's text
  form: decimal digits for `int`, and the empty string for null. Without
  `rowGroupBy`, every row is in group `*`. **A chunk MUST contain rows of a
  single row group**, so writers start a new chunk whenever the group changes.
  Writers SHOULD therefore receive rows grouped (for example `sortedBy` the
  group column).
- **Column groups.** `access.columnGroups` maps names (matching
  `[A-Za-z0-9_.-]{1,64}`) to lists of columns. Columns not listed form the
  default group `*`, which is listed first, or omitted when it would be
  empty. Each column belongs to exactly one group.

#### 7.6.3. Secrets

Each version of a file has two fresh random 32-byte secrets: `H` (header) and
`O` (owner). Everything else is derived from them, using the preamble salt:

| Purpose | Derivation |
|---|---|
| Row group id | `base64url_nopad(HMAC-SHA256(HKDF(O, salt, "JAZMIN/1/group-id"), UTF-8(name))[0..11])` |
| Row group secret `G(id)` | `HKDF(O, salt, "JAZMIN/1/row-group/" \|\| id)` |
| Column group secret `C(name)` | `HKDF(O, salt, "JAZMIN/1/column-group/" \|\| name)` |
| Header key | `HKDF(H, salt, "JAZMIN/1/header")` |
| Owner directory key | `HKDF(O, salt, "JAZMIN/1/owner")` |
| Index key | `HKDF(O, salt, "JAZMIN/1/" \|\| section_id)` |
| Chunk part key | `HKDF(G(id) \|\| C(name), salt, "JAZMIN/1/" \|\| section_id)` |

These properties follow:
- Opening a chunk part needs *both* its row group's secret and its column
  group's secret.
- An access key receives only the derived secrets it was granted, from which
  `O` and all other secrets cannot be computed.
- Row group ids are keyed by `O`, so they reveal nothing about group names.

#### 7.6.4. Layout

```
[preamble][chunk parts ...][index sections][owner directory][key slots][header][trailer]
```

**Chunk parts.** Each chunk is stored as one section per column group, with
section id `chunk/<n>/<column group>`. The rows are encoded as in 5.2, but
using only that group's columns (in schema order) with their own null bitmap.

**Header.** It is encrypted with the header key and differs from 6 as
follows:

```json
"chunks":  [ { "offset": 64, "length": 240, "rowStart": 0, "rowCount": 274, "rowGroup": "Qm9i...",
               "parts": [ { "columnGroup": "*", "offset": 64, "length": 180, "digest": "<b64 SHA-256>" },
                          { "columnGroup": "pii", "offset": 244, "length": 60, "digest": "..." } ] } ],
"indexes": [ { "column": "id", "kind": "sorted", "offset": 9000, "length": 300, "digest": "..." } ],
"access":  { "rowGroupBy": "section", "columnGroups": { "*": ["section", "line"], "pii": ["salary"] },
             "ownerDirectory": { "offset": 9300, "length": 900, "digest": "..." } }
```

Chunk entries carry no statistics, because they would reveal other groups'
values. There is no `keyring`. A `digest` is the base64 SHA-256 of the
section's bytes, envelope included.

**Owner directory.** It is encrypted with the owner directory key and holds
`{ "rowGroups": [names], "grants": [ { "key": "jza1-...", "rows": "*" | [names],
"columns": "*" | [names], "label": "..." } ] }`. Only the owner reads it.

**Key-slot section.** It is unencrypted, and SHOULD use codec 0 (sealed slots
are incompressible). It sits immediately before the header section, and its
length is stored in trailer bytes 12..15. Its raw payload is binary, so a
reader can find its slot by binary search:

```
owner public key Q         65 bytes
slot count                 u32
slot table                 count x { slot id (8) | offset u32 | length u32 }, sorted ascending by id, ids unique
sealed slots               offsets are relative to the first sealed slot
signature                  64 bytes, ECDSA P-256 / SHA-256, r || s
```

A sealed slot is computed as:

```
AES-256-GCM(key = HKDF(s, salt, "JAZMIN/1/slot"), aad = file_id || slot id)
```

over a UTF-8 JSON bundle (nonce || ciphertext || tag), where `s` is the key
the slot belongs to:

- **Owner bundle:** `{ "header": b64(H), "owner": b64(O) }`
- **Access bundle:** `{ "header": b64(H), "rows": { id: b64(G(id)) }, "rowNames": { id: name }, "columns": { name: b64(C(name)) } }`

A grant of rows `"*"` covers every row group present in that version of the
file.

**Signature.** Computed over:

```
"JAZMIN/1/signature" || file_id || SHA-256(key-slot payload before the signature) || SHA-256(header section bytes)
```

Because the header lists every other section's digest, the signature covers
the whole file.

#### 7.6.5. Reading

1. Check the signer. With an owner key, `Q` MUST equal the key's derived
   public key. With an access key, `fingerprint(Q)` MUST equal the key's
   fingerprint. Otherwise fail with "not signed by the owner of this key".
2. Verify the signature. If it fails, raise a format error.
3. Find the key's slot by binary search. If there is no slot, fail with "not
   granted".
4. Unseal the slot and decrypt the header.
5. Every chunk part, index and owner directory section read afterwards MUST
   match its digest.
6. Apply what the key may see:
   - Visible rows are those in granted row groups. Visible columns are those
     in granted column groups.
   - Readers MUST NOT return other rows or columns, and SHOULD report how many
     rows are hidden.
   - A filter or projection naming a hidden column MUST fail.
   - Indexes describe every group, so only the owner may use them.
7. Readers MAY use the row-group names a key knows as exact statistics for the
   `rowGroupBy` column. An `eq`/`in` filter on that column is resolved by
   computing or looking up group ids, without scanning chunk statistics.

#### 7.6.6. Authority

- Only the owner key can create or modify an access-controlled file that
  readers accept. Writers MUST reject a grant whose fingerprint does not match
  the owner key.
- Every new version of a file MUST use a fresh `file_id`, salt, `H` and `O`.
  Revoked keys therefore cannot read new versions, even if their holders kept
  old derived secrets.

### 7.7. Time-Limited Access (version 1.2)

A grant in an access-controlled file MAY carry an expiry and a mode.

**Grant data.** These live in the owner directory, and the access bundle
carries the parts the key holder needs:

| Member | Owner directory grant | Access bundle |
|---|---|---|
| `expires` | ISO-8601 UTC time | same |
| `mode` | `"offline"` (default) or `"online"` | `"online": true` for online grants |
| `share` | base64 32-byte random share (online only) | never present |

Writers MUST omit grants whose expiry is not after the time of writing. A
full rewrite also re-locks the file with fresh secrets (7.6.6). Appends MUST
drop expired grants from the key slots, but they reuse the secrets.

**Offline grants (library-enforced).** When a reader opens a file with an
access key whose bundle has `expires`, it MUST refuse if any of these holds:

1. the current time is after `expires`;
2. the current time is more than 5 minutes earlier than the file's signed
   `modified` (or `created`) time;
3. the current time is more than 5 minutes earlier than the last time this key
   opened this file on this device.

For check 3, readers SHOULD keep a per-user record named
`<file_id hex>.<key id hex>.json`, containing
`{ "lastSeen": <epoch ms>, "mac": <hex> }`, where:

```
mac = HMAC-SHA256(HKDF(access secret, salt = file_id, info = "JAZMIN/1/last-seen"), decimal lastSeen)
```

Readers MUST refuse when the record's MAC does not verify, and update
`lastSeen` when the clock is later. The record is kept with the user, not in
the file: a file can be replaced with an older copy, and is often read-only
or shared.

**Online grants (key-service-enforced).** The slot is sealed with:

```
KEK = HKDF(access secret || share, salt, "JAZMIN/1/slot")
```

and the high bit of its slot-table length is set. A reader therefore cannot
open the slot without the share, which the owner's key service provides as an
**unlock token**:

```
"jzu1-" || base64url_nopad(share || SHA-256(share)[0..3])
```

A key service SHOULD issue a token only before the grant's expiry, and MAY
apply any other policy (authentication, auditing, IP restrictions). To
request a token, a client needs only:
- the file id, which can be read from the preamble without a key; and
- its key id (`SHA-256("JAZMIN/1/slot-id" || secret)[0..7]`, hex).

Readers MUST also apply the offline checks to online grants that carry
`expires`. Shares stay the same across updates and appends of a file, so
stored tokens remain valid until the grant is revoked or expires.

**Limits.** Offline expiry is enforced by readers. Someone who controls their
machine can delete the last-seen record or use a modified reader. Online
expiry prevents new opens after expiry, but not the use of data or tokens
already obtained. No scheme can withdraw data a reader has already decrypted.

## 8. Indexes

Postings are lists of ascending row ids, written as
`varint count, varint first, varint delta...`.

### 8.1. Sorted Index (`sorted`)

Allowed for ordered types (`bool`, `int`, `float`, `string`, `datetime`).
The raw payload is:

```
varint entry_count
repeat entry_count (ascending by key, Section 5.3; keys unique):
    value     (encoding from 5.1)
    postings
postings for null cells
```

NaN floats are not indexed.

The index answers `eq`, `in`, `gt`, `gte`, `lt`, `lte` and `isNull: true` by
binary search, and `startsWith` on strings by a prefix range scan.

### 8.2. Trigram Index (`trigram`)

Allowed for `string`.

- Each value is lower-cased using ASCII-only folding: `A`–`Z` become `a`–`z`,
  and every other code unit is unchanged. This keeps the index byte-identical
  across implementations.
- The folded value is then split into its distinct overlapping 3-code-unit
  substrings.

The raw payload is:

```
varint gram_count
repeat gram_count (ascending, ordinal):
    3 x uint16 code units
    postings
```

To answer `contains` or `icontains` with text *t*, the reader intersects the
postings of all trigrams of *t*. The result is a superset of the matches, and
the reader MUST then evaluate the real condition on each candidate row. The
index cannot help (and the reader falls back to scanning) in two cases:

- *t* is shorter than 3 code units;
- an `icontains` search where *t* contains non-ASCII characters.

### 8.3. Paged Sorted Index (`sorted-paged`, version 1.3)

A sorted index over many distinct values can be large: about 37 MB for
5 million unique strings. Read whole, it makes a single lookup cost the
index's full size in time and memory. A paged sorted index answers the same
queries as `sorted` (8.1), but splits the entries into pages, each its own
section, with a small directory in front. A lookup reads the directory and
then only the pages it needs.

The entries are those of 8.1 (ascending keys, each with its postings), cut
into pages in order. Each page section's raw payload is:

```
varint entry_count
repeat entry_count: value, postings     (as in 8.1)
```

The postings of null cells, if any, are a separate section (`nulls`) holding
one postings list. The directory is the section named in the header entry:

```
byte   flags                  bit 0: digests present; other bits 0
varint page_count
repeat page_count (pages in key order):
    value  first_key          the page's smallest key (encoding from 5.1)
    varint entry_count
    varint offset             absolute position of the page section
    varint length
    string digest             only when flags bit 0 is set
varint nulls_offset           0 and length 0 when there are no null cells
varint nulls_length
string nulls_digest           only when flags bit 0 is set ("" when no nulls)
```

- **Digests.** Access-controlled files (7.6) set flags bit 0. Each `digest`
  is the base64 SHA-256 of the section, as in 7.6. The header holds the
  directory's digest, and the directory holds the digests of the pages and
  the `nulls` section, so the owner's signature covers every page. Readers
  MUST check each one, as in 7.6.5 step 5.
- **Where a key is.** A key *v* can only be on the last page whose
  `first_key` is less than or equal to *v*.
- **Range queries.** `gt` and `gte` read that page and every later page;
  `lt` and `lte` read every page up to and including it.
- **Prefix lookups.** `startsWith` reads from that page on, while the next
  page's `first_key` still starts with the prefix.
- **Checks.** Readers MUST check that a page holds `entry_count` entries, and
  MUST reject unknown flag bits.
- **When writers page.** A writer MAY store any sorted index this way. The
  reference writers do so when the whole index would exceed 256 KiB, in pages
  of about 64 KiB of raw entries. Readers that do not support `sorted-paged`
  ignore it (6.4) and scan.

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

| Operator      | Types                       | Meaning                                         |
|---------------|-----------------------------|-------------------------------------------------|
| `eq`, `ne`    | ordered types, `decimal`    | equal / not equal                               |
| `gt` `gte` `lt` `lte` | ordered types       | comparison (Section 5.3)                        |
| `in`          | ordered types, `decimal`    | equal to any element of an array                |
| `contains`    | `string`                    | case-sensitive substring                        |
| `icontains`   | `string`                    | case-insensitive substring                      |
| `startsWith`  | `string`                    | case-sensitive prefix                           |
| `isNull`      | all                         | `true`: cell is null; `false`: cell is not null |

Operands are converted to the column type. For example, `"42"` is accepted
for an `int` column, and an ISO-8601 string for a `datetime` column. An
unknown column, an unknown operator or an operator that is invalid for the
column type MUST be reported as an error.

### 9.3. Null Semantics

As in SQL, every operator except `isNull` is false when the cell is null. In
particular, `ne` does not match nulls. To include nulls, combine it with
`isNull`.

### 9.4. Evaluation Strategy (informative)

1. **Index planning.** For an AND, intersect the candidate sets of every
   condition that has a usable index. For an OR, take the union, but only if
   *every* branch has a usable index. NOT and `ne` produce no candidates. If
   candidates exist, read only the chunks that contain them.
2. **Chunk pruning.** Without candidates, skip any chunk whose statistics prove
   no row can match.
3. **Exact check.** Always evaluate the full filter on each row that is read.

Indexes and statistics are optimisations only: results MUST equal those of a
full scan.

## 10. Conversion to JSON, CSV and XML

### 10.1. JSON

A file corresponds to a JSON array of objects, one per row, with members in
column order.

| Type       | JSON representation                                               |
|------------|-------------------------------------------------------------------|
| `int`      | number (exact digits, even beyond 2^53)                          |
| `decimal`  | number (exact digits)                                            |
| `float`    | number; NaN/±Infinity become `null`                              |
| `datetime` | string `YYYY-MM-DDTHH:mm:ss.sssZ`                                |
| `binary`   | base64 string                                                     |
| `json`     | the nested value                                                  |

Null cells are written as `null`, or omitted when the caller requests that.

When importing JSON without a schema:

- A column's type is the type of its non-null values. Integers become `int`
  and other numbers `float`; `int` mixed with `float` becomes `float`.
- Strings become `string`. Datetime detection is optional.
- Booleans become `bool`. Objects and arrays become `json`.
- Any other mix of types becomes `json`, which preserves the values exactly.
- A column is nullable if any row omits it or holds null.

### 10.2. CSV

Follows [RFC4180]. The first record is the header.

- An **unquoted empty field is null**; a **quoted empty field (`""`) is an
  empty string**. This makes the null/empty distinction survive a round trip.
- Values use the text forms from 10.1 (JSON text for `json` columns).
- On import, a column becomes `int`, `float` or `bool` only if every
  non-null value matches that type; otherwise it is `string`.
- Type inference can be turned off, for example to keep leading zeros.

### 10.3. XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<jazmin>
  <row><id>1</id><name>Ann</name></row>
  <row><id>2</id><field name="first name">Bob</field></row>
</jazmin>
```

- Null cells are omitted.
- A column whose name is not a valid XML name, or that starts with `xml`, is
  written as `<field name="...">`.
- Values that contain characters forbidden by XML 1.0 cannot be exported.
  Writers MUST report an error rather than corrupt the output.
- Import infers types as for CSV.

## 11. Reader and Writer Requirements

Writers:

- MUST validate every value against its column type and nullability, and MUST
  reject rows that name unknown columns.
- MUST write a complete trailer only after every other section has been
  written. An interrupted write therefore never yields a file that a reader
  will accept.
- SHOULD bound memory to one chunk of rows plus the index build state.
  Defaults: 4096 rows or 1 MiB of raw data per chunk, whichever comes first.

Readers:

- MUST read only the preamble, trailer and header when opening.
- MUST load chunks and indexes on demand.
- MUST verify integrity as described in Section 4.3.
- MUST treat every length and offset as untrusted. Values that fall outside
  the file MUST produce a format error, never a crash or an over-read.

### 11.1. Updating Files

Files are never modified in place. An update:

1. reads the current version;
2. applies the changes (inserts, upserts by key columns, deletes by filter,
   metadata changes and, for access-controlled files, grants and
   revocations);
3. writes a complete new version to a temporary file in the same directory;
4. atomically renames it over the original.

Readers therefore see either the old file or the new file, never a mix.

- If the header declares `sortedBy`, the new version MUST keep that order.
  Rows whose sort key changes move to their new position.
- Indexes and metadata carry over unless explicitly changed.
- Updating an access-controlled file MUST require the owner key. The new
  version re-issues the remaining grants from the owner directory with fresh
  secrets (7.6.6).

### 11.2. Appending to Files (version 1.2)

An append adds changes to the end of a file without modifying any existing
byte, apart from the preamble flags. Its cost is proportional to the size of
the change. Readers that opened the file earlier keep reading the version they
opened.

**Layout.** The new content is written after the current trailer:

```
[previous version ... header][trailer] [new chunks][new index segments][deletes]
  ([owner directory][key slots])        [header][trailer]
```

The previous header and trailer become unused bytes, which a compaction
removes. The new header is complete. It lists every chunk, old and new, with
the offsets unchanged, so a reader only ever reads the last header.

**Header members (1.2):**

- `appendCount`: the number of appends since the file was last written in
  full.
- `modified`: the time of the last append. (`created` keeps its original
  value.)
- `indexes[].segment`: the index section built by append *n* covers only the
  rows that append added. Its section id is `index/<column>/<kind>/<n>`.
  Readers MUST combine every segment of a column and kind, by union of their
  results. `sorted` and `sorted-paged` segments of one column are segments of
  the same sorted index. The pages of a paged segment carry the segment
  before the part: `index/<column>/sorted-paged/<n>/page/<p>`.
- `deletes`: `{ offset, length, segment, count, digest? }` points to the
  section `deletes/<n>`. Its payload is the complete sorted list of deleted
  row ids (postings encoding, 8). Readers MUST NOT return deleted rows, and
  row counts exclude them. The section is encrypted with:
  - the `data` keyring group (single-key files); or
  - `HKDF(H, salt, "JAZMIN/1/deletes/<n>")` (access-controlled files), so
    that every key holder can read it.

**Flag.** The writer sets preamble flag bit 3, APPENDED, before writing
anything else. Readers that do not support version 1.2 then reject the file
(4.1), rather than returning deleted rows or missing index segments.

**Row ids and order.** Appended rows continue the row numbering, and chunk
ordinals continue as well. In a file that declares `sortedBy`, appended rows
MUST sort at or after the last existing row. Inserting elsewhere requires a
full rewrite (11.1). Upserts are recorded as the deletion of the old row
plus an appended new row.

**Access-controlled files.** Only the owner key may append. The secrets `H`
and `O` are reused, because existing sections must stay readable. The owner
directory and key slots are rewritten and the file is re-signed:
- new grants are allowed;
- **revoking a key requires a full rewrite**, because only a rewrite issues
  fresh secrets (7.6.6).

**Durability and recovery.** Writers MUST flush the new sections to stable
storage before writing the new trailer, and flush again afterwards.

If an append is interrupted, the file ends with bytes that are not a valid
trailer. A reader of an appended file then scans backwards for the most
recent valid trailer: its magic and CRC are correct, and its header section
ends exactly where it begins. The reader then uses that version. The next
append MUST truncate the file to the end of that trailer before writing.
A writer that abandons an append MUST restore the previous length and flags.

**Concurrency (informative).** The reference implementations allow one writer
at a time, enforced with a lock file named `<path>.lock`. Readers are never
blocked.

**Compaction.** A compaction is a full rewrite (11.1) with no changes. It:
- drops deleted rows and unused bytes;
- merges index segments;
- for access-controlled files, re-locks with fresh secrets.

The result has `appendCount` 0, and the APPENDED flag is clear.

## 12. Versioning and Extensibility

- **Major** version changes are not backward compatible. Readers MUST reject
  unknown major versions.
- **Minor** versions MAY add header members, codecs, index kinds, keyring
  groups or layouts. A reader MUST NOT fail on an unknown header member. A
  reader MAY fail on an unknown codec, layout or required feature, and MUST
  then report what is unsupported.

Reserved for future minor versions:

- Codec 3: Zstandard [RFC8878].
- Per-grant chunk directories and encrypted column definitions for access-controlled files (Appendix C).

## 13. Security Considerations

- **Confidentiality covers content, not shape.** In an encrypted file, the
  following stay visible:
  - the total file size;
  - the number of sections and the size of each one;
  - whether a password was used, and the KDF iteration count.

  Row counts can be roughly inferred from these. Writers that must hide
  sizes SHOULD pad values or use fixed chunk sizes.
- **Compression side channels.** Compressing before encrypting can leak
  information when an attacker can inject chosen data into the same section
  as a secret and then observe the ciphertext length (the CRIME/BREACH
  attacks). Applications that mix attacker-controlled data with secrets in
  one file SHOULD use codec 0 for those columns' files.
- **Integrity of plaintext files.** CRC-32 detects accidental corruption, not
  malicious changes. Use encryption, or an external signature, when
  tampering matters.
- **Key management.** The master key or password is the only secret. Lose it
  and the data is unrecoverable. Store keys in a secret manager, never next
  to the file.
- **Password strength.** PBKDF2 slows guessing but cannot protect a weak
  password. Prefer random master keys for machine-to-machine use.
- **Resource exhaustion.** Readers MUST bound memory by `raw_length` and MUST
  NOT trust declared lengths that exceed the file size.
- **XML.** XML importers MUST disable DTD processing (to prevent entity
  expansion attacks).
- **Access control hides values, not shape.** Every holder of a key for an
  access-controlled file can see the following:
  - column names and types;
  - user metadata (do not store secrets there);
  - the number of chunks and their sizes per (opaque) row group;
  - the number of key slots, which is roughly the number of keys issued.
- **Revocation applies to new versions only.** Someone who holds a copy of an
  old version and a revoked key can still read what that key was granted in
  that copy.
- **The signature proves who produced a file, not who saw it.** Anyone can
  copy data they are allowed to see into a file of their own; that file
  simply will not verify as the owner's.
- **Compromise of an access key** exposes only the groups it was granted.
  Compromise of the owner key exposes everything and allows forging files, so
  protect it like a signing key.

## 14. Media Type Registration

- Type name: `application`
- Subtype name: `vnd.jazmin`
- Required parameters: none
- Optional parameters: `version` (e.g. `1.0`)
- Encoding considerations: binary
- File extension: `.jzm`
- Magic number: `4A 5A 4D 4E` ("JZMN") at offset 0, and again in the last 4 bytes
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
- [XML 1.0] Extensible Markup Language (XML) 1.0 (Fifth Edition), W3C.

## Appendix A. Worked Example

Writing the rows `{id: 1, name: "Ann"}` and `{id: 2, name: null}` with
columns `id:int` and `name:string`:

```
Chunk 0 raw payload (before compression):
  00            row 0 null bitmap (no nulls)
  02            id = 1   (zigzag 1 -> 2)
  03 41 6E 6E   name = "Ann" (length 3, UTF-8)
  02            row 1 null bitmap (bit 1 set: name is null)
  04            id = 2   (zigzag 2 -> 4)
```

That is 8 bytes of row data (hex `00 02 03 41 6E 6E 02 04`), compared with
44 bytes for the equivalent compact JSON. Because 8 bytes cannot be compressed
further, the writer stores the chunk with codec 0. The complete file is 357
bytes, because the preamble, header and trailer add a fixed overhead of
roughly 300 bytes. JAZMIN is therefore not intended for tiny payloads.

The shared interoperability fixtures in `spec/fixtures/` contain complete
files (plain, Brotli, key-encrypted and password-encrypted) written by both
reference implementations.

## Appendix B. Change Log

- **draft-01:** first complete specification, matching reference implementations v0.1.0.
- **draft-01 (rev. 2):** added Appendix C, a proposal for partial-access keys. No change to the version 1.0 format.
- **draft-02 (format 1.1):**
  - access-controlled files (7.6): owner and access keys, row and column
    groups, owner signature, binary key slots and owner directory;
  - the `sortedBy` header member (6.7) and the update rules (11.1);
  - readers must reject unknown preamble flags;
  - trailer bytes 12..15 now hold the key-slot length;
  - Appendix C now records the design notes.
- **draft-02 (format 1.2):** append-only updates (11.2):
  - index segments, the deletes section, and the `appendCount` and `modified`
    members;
  - the APPENDED flag;
  - trailer recovery after an interrupted append;
  - compaction;
  - time-limited access (7.7): grant expiry, offline clock checks, online
    unlock tokens, and the online bit in the key-slot table.
- **draft-02 (format 1.3):** the columnar chunk layout (5.4), with plain,
  delta, dictionary, bitmap and scaled-decimal column encodings; statistics
  sections loaded per column (6.3); embedded
  files (6.8), with per-group file directories, content stored once, block
  reads and package settings for viewers; paged sorted indexes (8.3).

## Appendix C. Design Notes on Access Control (informative)

Section 7.6 implements the partial-access design first proposed in draft-01.
These are the decisions that shaped it, with the measurements behind them:
1.37M rows in 5,000 row groups, one access key per group.

- **Derived group secrets.** The first design stored a random secret per row
  group in the owner's slot. That slot was 477 KB, and every reader had to
  parse it. Deriving `G` and `C` from `O` keeps the owner slot at about 100
  bytes, whatever the number of groups.
- **Binary, sorted slot table.** With one JSON slot list, opening the file
  with any key took 33 ms. That time grew linearly with the number of keys,
  because every reader parsed every slot. Binary search over a sorted table,
  with only the matching slot decrypted, reduced it to 7–10 ms
  (JavaScript/.NET), independent of the number of keys.
- **Owner directory.** Grants (which contain access keys) and the list of group
  names are needed only by the owner, for example to re-issue grants when
  updating. Keeping them out of the key slots means readers never pay for
  them.
- **Group lookup by id.** An `eq` filter on the row-group column is answered
  by computing the group id from the value. The owner therefore does not load
  the directory to find one section (27 ms down to 9 ms).

Possible future work:

- **Per-grant chunk directories.** The header still lists every chunk. With
  5,000 groups, the header is about 1 MB of JSON, roughly 5 ms of the 7–10 ms
  open. Moving each group's chunk entries into its own encrypted directory
  would make an access key's open time depend only on its own data.
- **Hiding column names.** Column names are visible to every key holder. A
  column group's column definitions could be moved into that group's own
  encrypted section.

