# Research summary: data formats, storage engines, compression and cryptography

This note records what we looked at before designing JAZMIN, and which
decisions each finding led to. The normative specification is
[rfc/draft-jazmin-format-03.md](rfc/draft-jazmin-format-03.md) (format 1.0).

## 1. Text interchange formats

| Format | Strengths | Weaknesses for large data | What JAZMIN takes |
|---|---|---|---|
| **JSON** (RFC 8259) | Universal, self-describing, nested data, fast native parsers (V8 `JSON.parse`, System.Text.Json) | Repeats every property name in every record; no types beyond number/string/bool/null; numbers lose precision beyond 2^53 in JS; usually parsed whole; no compression, index or encryption | Lossless JSON round trip; JSON-shaped filter language; `json` column type for nested values |
| **XML** | Schemas (XSD), namespaces, mature tooling | Even more verbose than JSON; entity-expansion attacks; typing needs an external schema | Canonical tabular XML export/import; DTDs disabled on import |
| **CSV** (RFC 4180) | Compact for flat tables; opens in Excel | Untyped; ambiguous nulls; quoting dialects; no nesting | Row-oriented data section; header-once idea; `""` vs empty for empty-string vs null |

## 2. Streaming JSON readers (Newtonsoft.Json and peers)

Newtonsoft's `JsonTextReader` and System.Text.Json's `Utf8JsonReader` read
token by token, so memory can stay low. However:

- A reader still has to scan from the start to reach record *n*. There is no
  random access.
- A query still touches every byte of the file.
- Splitting files into pages (JSON Lines, chunked files) helps, but each tool
  invents its own scheme. There is still no index, schema or encryption.

**Decision:** keep the familiar API shape (`JazminConvert.SerializeObject` /
`DeserializeObject<T>`, `JazminSerializer`, settings, `[JazminProperty]` /
`[JazminIgnore]`, `Formatting`, `NullValueHandling`). Underneath, store data
in independently addressable chunks plus indexes, so a lookup needs neither a
full scan nor a full parse.

## 3. Binary formats and database storage engines

| System | Relevant idea | Adopted? |
|---|---|---|
| **MongoDB / BSON** | Binary, typed values with length prefixes, so a reader can skip fields; WiredTiger compresses blocks (snappy/zstd) and keeps B-tree indexes separate from data | Typed binary values, block compression, separate indexes: **yes**. BSON repeats field names per document: **no** |
| **SQLite** | Single file, pages, B-trees, random access | Single-file random access: **yes**. Mutable pages and transactions: **no** (write-once, for simplicity) |
| **Apache Parquet / ORC** | Columnar row groups, footer metadata, min/max statistics, page compression | Footer-located header, chunk statistics, chunk compression and the columnar layout: **yes** (format 1.0 stores every chunk column by column) |
| **Apache Avro** | Schema in the file header, compact row encoding, sync markers | Schema in file, compact row encoding: **yes** |
| **MessagePack / CBOR** (RFC 8949) | Compact self-describing binary values | Varint/zigzag style: **yes**. Per-value type tags: **no** (the schema gives the types) |
| **ZIP** | Central directory at the end, per-entry compression | "Directory at the end" for streaming writes: **yes**. ZIP itself as a container: **no**, because ZipCrypto/AES-ZIP encryption is weak or non-standard and ZIP has no index or row model |

## 4. Compression

| Codec | Ratio | Speed | Availability | Decision |
|---|---|---|---|---|
| Deflate (RFC 1951) | Good | Fast | Everywhere: Node zlib, .NET, browser `CompressionStream` | **Default** |
| Brotli (RFC 7932) | 10–20% better than Deflate on text-like data | Slower to compress | Node zlib, .NET `BrotliEncoder`, browsers (decode) | **Supported** (codec 2) |
| Zstandard (RFC 8878) | Close to Brotli, much faster | Very fast | Not built into .NET; recent in Node | **Reserved** (codec 3) |

Findings:

- **Compress, then encrypt.** Ciphertext looks random and does not compress.
  Encrypting first wastes all the gain.
- **Encryption does not make files smaller.** Any request to "use
  cryptography to reduce size" is really a request for compression. In
  JAZMIN, encryption adds a fixed 28 bytes per section (nonce and tag).
- **Compression helps most when similar values sit together.** Row
  encoding plus Deflate already reached gzip-of-JSON size or better. The
  columnar layout (the only layout since format 1.0) compresses further.
- **Side channel.** If an attacker can mix chosen data with secrets in one
  compressed and encrypted section, the ciphertext length can leak the
  secret (the CRIME and BREACH attacks). This is documented in RFC
  section 13.

## 5. Cryptography

| Need | Choice | Why |
|---|---|---|
| Confidentiality and integrity | AES-256-GCM | NIST standard, authenticated, hardware-accelerated, native in WebCrypto, Node and .NET |
| One key to unlock many sections | HKDF-SHA256 key hierarchy | A master key opens the header. The header's keyring secrets combine with the master key to give a unique key per section, as requested |
| Password-based files | PBKDF2-HMAC-SHA256, 600k iterations | Native in all three runtimes. Argon2/scrypt are stronger but not native in .NET or browsers |
| Typo-safe key text | `jzk1-` + base64url(key ‖ 4-byte SHA-256 checksum) | Detects a mistyped key before decryption. The `jzk1` version prefix allows future key formats |
| Tamper and reorder protection | AAD = file id + envelope + section id | Sections cannot be swapped, moved or transplanted between files |

We rejected inventing a cipher or custom key scheme. Security comes from
standard, reviewed primitives combined in a documented way.

## 6. Honest positioning

- **JAZMIN wins:**
  - size (≈9× smaller than JSON, smaller than gzipped JSON with Brotli);
  - point lookups and selective queries on large files (≈6–15× faster, ≈10×
    less memory);
  - built-in encryption at near-zero cost;
  - one file that converts to and from JSON, CSV and XML.
- **JAZMIN does not (yet) win:**
  - **Whole-file loads.** V8's native `JSON.parse` and System.Text.Json are
    faster at loading everything into memory.
  - **Tiny payloads.** There is about 300 bytes of fixed overhead.
  - **Analytics.** Parquet's columnar layout is better for whole-column
    aggregation.
  - **Human readability.** JSON is text and JAZMIN is not.
- **Do not use JAZMIN for:**
  - API request/response bodies that browsers or other teams consume directly;
  - configuration files;
  - anything humans edit by hand.

The benchmark numbers are in [USER-GUIDE.md](USER-GUIDE.md#9-performance-and-benchmarks).
