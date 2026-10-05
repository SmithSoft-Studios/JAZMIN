# Changelog

Both libraries share a version number. File format versions are listed separately and
are specified in [docs/rfc](docs/rfc/draft-jazmin-format-03.md).

## Unreleased

### Fixed
- **Browser reader: NaN no longer matches filters on float columns.**
  - **The bug:** a row whose float value was `NaN` matched `eq`, `in`,
    `gte` and `lte` conditions on any value. `{ score: 5 }` returned it,
    and `count()` counted it. The library has never matched it.
  - **Now:** the browser reader compares as the library does. NaN matches
    no comparison except `ne`.
- **Parallel JS writes stop their worker threads gracefully.**
  - **The change:** a finished or aborted write used to terminate its
    compression workers straight away, sometimes mid-compression. Each worker
    now finishes what it was given and then ends; one that doesn't stop
    within 10 seconds is still terminated.
  - **Why:** forced termination is the likely cause of an intermittent Node 26
    crash on Windows in CI (`Assertion failed: init_done_ && "close before
    init"`). It didn't reproduce locally, so CI will confirm the fix.

### Changed
- **Writing indexes is faster (TASKS P-5).** On the benchmark, a write with
  3 indexes went from 164 to 94 ms in .NET, now faster than Newtonsoft's
  103 ms, and from 343 to 309 ms in Node.
  - **Sorted index builder:** no list per key, and no lookups while keys
    arrive in order (ids, a sorted column). In .NET its entries stay off the
    large object heap, which had forced a full garbage collection on every
    write with a unique-key index.
  - **.NET:** index pages are compressed in parallel.
  - **Output:** index pages are byte-for-byte the same as before.
- **`count()` reads as little as it can (#16),** in both libraries and the
  browser reader (USER-GUIDE §9.10).
  - **From an index alone:** when sorted indexes answer the filter exactly
    (one condition, or a range on one column), no rows are read.
  - **Whole chunks:** chunks whose statistics prove every row matches are
    counted by their row counts, without being read.
  - **Fewer columns:** elsewhere only the filter's columns are decoded.
    Before, `count()` ran a full `find()`.
  - **Measured:** 12 monthly counts over a year went from 5,771 KB read in
    104 ms to 1,062 KB in 15 ms, and one account's count in a time-sorted
    file from 4,766 KB in 81 ms to 57 KB in 1.2 ms.
  - **Also:** the last decoded chunk is reused by the next query whenever it
    holds the columns that query needs. Before, reuse needed the exact same
    column set.
- **Paging reads only what the page needs (#8).** Chunks wholly before the
  `offset` are counted by their row counts instead of being read and decoded
  (USER-GUIDE §9.7).
  - **When:** with no filter; when chunk statistics prove every row matches;
    or, in access-controlled files, when the filter names one partition.
  - **Measured:** a deep page went from 3,563 KB to 97 KB read (59 ms to
    1.7 ms), and the newest 50 rows from 4,709 KB to 82 KB.
  - **Limits:** a page that ends on a chunk boundary no longer reads the next
    chunk.
  - **.NET:** it no longer reads chunks ahead of a limited query's need. A
    filtered, limited query reads ahead gradually.
  - **Browser reader:** it pages without a filter the same way, and `query()`
    without a filter returns `total` from the row count.

- **The browser reader plans queries like the library (#10).**
  - **What it uses:** chunk statistics, binary search on the leading sort
    column, offsets that skip whole chunks, and sorted and trigram indexes (in
    files that aren't access-controlled), with the same cost rules.
  - **Measured:** a lookup by id in a 9.7 MB file went from reading the whole
    file (4,895 KB, 303 ms) to 150 KB (14 ms), and the last account's page
    went from 4,895 KB to 85 KB. That's the same as Node.
  - **API:** `query(filter, { total: false })` reads only the page. `count()`
    counts chunks whose every row matches without reading them.
    `explain(filter, { analyze: true })` reports what a query read, as in the
    library. Only the filter's and selected columns are decoded.
  - **Alignment:** `{ eq: null }` / `{ ne: null }` mean "is null" / "is not
    null", as in the libraries. An unknown `select` column is an error.
  - **Viewer:** template queries no longer count every match to page.
- **Query planning (#7):** queries choose between indexes and a scan by what
  each reads (USER-GUIDE §9.8).
  - **One lookup per column:** range conditions on one column make one bounded
    index lookup, instead of one lookup per bound.
  - **Index only when cheaper:** an index lookup is made only when it reads
    less than scanning the chunks the filter leaves. Its cost is estimated from
    the index directory before any page is read, and lookups up to 8 KB are
    always made. Text-search indexes load only when used.
  - **Index results narrow the scan:** only the chunks a scan would read are
    read, and only the candidate rows in them are checked, with the scan's
    column decoding.
  - **Measured:** a keyset page within an account went from 3,785 KB / 109 ms
    to 102 KB / 2.2 ms (.NET: 99 to 2.3 ms). One day across all accounts went
    from 7,467 KB / 206 ms to 4,938 KB / 70 ms (.NET: 148 to 32 ms).
  - **.NET main benchmark:** a lookup by id went from 3.7 to 2.1 ms, and an
    indexed filter from 40 to 12 ms, allocating 1.1 MB instead of 2.5 MB.
- **Only the columns a query uses are decoded (#11).**
  - **Now everywhere:** index lookups and access-controlled reads now decode
    only the columns the filter uses and those `select` returns, as scans
    already did. In access-controlled files, a column group none of whose
    columns is needed is not read at all.
  - **No rows built up front:** in JS, a decoded chunk is kept as columns, and
    rows are built only for the rows a query looks at. That saves time, and the
    memory of a decoded chunk.
  - **Measured, one column through an index:** JS 75.6 to 33.7 ms; .NET 66.3
    to 29.3 ms.
  - **Measured, one column of an access-controlled file:** JS 128 to 70 ms;
    .NET 95 to 71 ms. The rest of that time is decrypting and decompressing
    each chunk part, which holds every column (#23 would split them).

### Added
- **`compact({ regroup: true })` (#17):** each partition's rows are written
  together in an access-controlled file (.NET:
  `JazminFile.Compact(path, owner, regroup: true)`).
  - **Why:** appends from many people leave one chunk per append, and plain
    compaction keeps them.
  - **Measured:** on a simulated year of syncs (50 people, 37,500
    appends), the file went from 7,241 KB to 538 KB. One person's rows went
    from 125 KB read to 10 KB (USER-GUIDE §17.4).
  - **Limits:** it needs a file without `sortedBy`, or sorted by the
    partition column first.
  - **Advice:** `advise()` now suggests it, and spots spread-out partitions
    by where their chunks lie. Before, it compared chunk sizes, which missed
    files where every chunk is small, and it suggested plain `compact()`,
    which doesn't merge them.
- **The viewer is tested in Safari (#9).** `npm run test:viewer` drives
  Safari through `safaridriver`, built into macOS, and CI runs its checks on
  macOS beside Chrome and Firefox on Linux.
  - **Phones:** CONTRIBUTING has a phone check for each release, on an
    iPhone and an Android phone.
  - **One difference:** Safari's automation can't open files from disk, so in
    Safari CI opens the "Save as HTML" copy from a web server. The phone
    check covers opening it from disk.
- **User guide: fetching many rows by position (#27).** Section 9.9 shows
  why to sort row positions before calling `get()`. On the benchmark,
  fetching one day's 549 rows in time order read 53,815 KB in 673 ms; sorted
  by position first, 4,895 KB in 62 ms.
- **The `jazmin` command-line tool (#15):** commands `inspect`, `query`
  (JSON lines, JSON or CSV), `explain --analyze`, `advise`, `convert` and
  `keygen`, installed with the npm package (USER-GUIDE §25).
  - **Keys** come from the environment or files, and are never printed except
    by `keygen`.
- **Layout advice (#14):** `reader.advise({ columns })` and `jazmin advise`
  read only directories and statistics.
  - **What they report:** how many chunks the rows of one value lie in, and
    what a lookup costs.
  - **What they suggest:** a `sortedBy` or `chunkRows` that would make those
    lookups read less, and partitions `compact({ regroup: true })` would merge.
  - **On the benchmark's time-sorted file,** they recommend sorting by
    account, then time, for account lookups.
- **Open files by URL in the browser (#12):** `JazminBrowser.openUrl(url, {
  key, headers })` reads a file from a web server or object storage with HTTP
  range requests (USER-GUIDE §24).
  - **What's downloaded:** only the parts a query needs. On a 3 MB file,
    opening it and reading one account's page took 3 requests and 256 KB.
  - **Any source:** `open()` also accepts any `{ size, read(offset, length) }`
    object.
- **`explain(filter, { analyze: true })` (#6):** runs a query and reports
  what it read (USER-GUIDE §9.6): rows, bytes, chunks, index pages and column
  streams decoded, plus the time. In .NET it's
  `Explain(filter, analyze: true, options)`, with the result in
  `JazminPlan.Cost`. Both libraries report the same numbers for the same file
  and query, except where .NET's read-ahead reads more (#8). A plain
  `explain(filter)` is unchanged.
- **Query cost benchmark (#5):** `npm run bench:proposals` measures the rows,
  bytes read and time of 25 queries on 200,000 seeded transactions.
  - **What it covers:** lookups, account pages, keyset and date-range pages,
    deep pages, one-column sums, access-controlled reads, `get()` by position,
    and the browser reader.
  - **CI check:** fails when a query reads more than 10% more bytes than the
    recorded baseline, or returns different rows (docs/CONTRIBUTING.md,
    "Measuring what a query reads").

## 1.0.0 - 2026-10-04 (file format 1.0)

The first published release.

### Changed
- **File format 1.0** ([design note](docs/design/format-1.0.md),
  [spec draft-03](docs/rfc/draft-jazmin-format-03.md),
  [`spec/jazmin.proto`](spec/jazmin.proto)). Files written by earlier
  pre-release versions are refused with *"This file uses a pre-release JAZMIN
  draft format. Write it again from its source data."*
  - **Catalog in Protocol Buffers:** the header, chunk directories, statistics,
    partition tables and index directories are Protocol Buffers messages,
    encoded and decoded by a small built-in codec (no new dependency).
  - **Columnar only:** every chunk stores one stream per column. The row
    layout and its options (`layout`, `JazminLayout`) are gone.
  - **Features instead of minor versions:** the header lists reader and writer
    features (none in 1.0). A reader refuses a file that needs a feature it
    does not know, naming it.
  - **Partitions:** `rowGroupBy` is now `partitionBy`, and `visibleRowGroups`
    is now `visiblePartitions` (.NET: `PartitionBy`, `VisiblePartitions`).
    Grants keep `rows`.
  - **Per-partition chunk directories (P-7):** a key holder reads only the key
    slots, the header and its own partitions' directories. The owner reads a
    partition's directory when it first needs it.
  - **Statistics for access keys:** scans with an access key skip chunks of
    its partitions, as in ordinary files.
  - **Hidden column names (S-6):** the names and types of a restricted column
    group are locked with that group's secret. A filter on a column a key
    cannot see reports an unknown column.
  - **Incremental appends (P-9):** an append writes its new chunks, a
    directory segment per partition it changed and a small header. Key slots
    are rewritten only when grants or partitions change.
  - **Ordered decimals:** decimals are stored as a scale and an integer,
    compared by value (12.5 equals 12.50), and can be indexed, used in range
    filters, `$min` / `$max` and `$sort`.
  - **One sorted index kind,** in pages of about 64 KiB; a small index is one
    page. Index, postings and deleted-rows sections start with an encoding
    byte.
  - **Tables:** the header holds a list of tables. The libraries write and
    read one; the multi-table API is D-3.
  - **Signature section:** the owner signature has its own section, so key
    slots can be reused by appends.
  - **Key slots in pages (P-16):** a key holder reads a short signed list of
    pages and the one page that holds its slot, so its open does not grow with
    the number of keys (.NET: 1.4 ms with 1, 5,000 or 50,000 keys; it was
    12.6 ms with 5,000).
  - Measured against the previous format (JS, Node 24):

    | | Before | 1.0 |
    |---|---:|---:|
    | Open a file with 10,000 chunks | 2.7 ms | 0.95 ms |
    | Access key: open, 5,000 partitions | 5.0 ms | 1.1 ms |
    | Owner: open + read one section, 5,000 partitions | 8.7 ms, 276 MB peak | 1.4 ms, 80 MB peak |
    | Single-key file: open + read one section | 1.27 ms, 91 MB peak | 1.12 ms, 74 MB peak |
    | Bytes added by an append, 5,000 chunks | 114–236 KB | 0.4–1 KB |
    | Access-controlled file, 5,000 partitions | 9.5 MB | 11.5 MB (statistics, which the old format did not have) |

    In .NET, a file with 10,000 chunks opens in 1.4 ms (was 6.2 ms) and an
    access key opens a 5,000-partition file in 1.4 ms (was 8.0 ms).
- **A new file without rows still lists its indexes,** so later appends and
  updates keep them (both libraries).
- **Supported platforms: .NET 10 and Node.js 22 or later.** .NET 8 support
  ends in November 2026 and Node.js 20 reached end of life in April 2026.
  Nothing has been released yet, so no users are affected.
  - The .NET library, tests, samples and benchmarks now build only for
    `net10.0`.
  - CI tests Node 22, 24 and 26. A separate, non-blocking job runs the .NET
    tests on the next .NET release while it is a preview.
- **Fixed: parallel JS writes hung on Node 26.** Node 26 no longer lets
  `Buffer.allocUnsafe` memory be handed between threads. Workers now hand
  over only the buffers Node allows and copy the rest. If a reply still
  cannot be sent, they copy it instead of failing silently.

### Added
- **Packages ready to publish (R-1).**
  - **Names:** npm `@smithsoft-studios/jazmin` and NuGet `Jazmin`. npm refuses the plain
    name `jazmin` as too close to the `jasmine` package.
  - **Contents:** the npm and NuGet packages now include a README, the MIT
    licence and repository links. The NuGet package has the JAZMIN icon, and
    .NET debugging symbols come as a `.snupkg`.
  - **CI check:** every pull request installs each packed package into an
    empty project and runs the samples there.
  - **Release workflow:** a version tag publishes both packages, after
    approval (docs/CONTRIBUTING.md, "Releasing").
- **The JAZMIN viewer (F-2):** open `.jzm` files in a browser
  (USER-GUIDE §24). Nothing is uploaded, and files are read in slices.
  - **Three forms:** an installable app (Chrome and Edge open `.jzm` files
    with it, also offline), a hosted page, and "Save as HTML" (the viewer and
    the file in one HTML file).
  - **What it shows:** the package's document, the data (filters, paging,
    tables) and the embedded files.
  - **Keys:** master keys, passwords, owner keys, and access keys, with an
    unlock token for online keys.
  - **Documents** run in a sandbox with the `window.jazmin` API. Queries run in
    the viewer, so the key never reaches the template.
  - **Browser reader:** `@smithsoft-studios/jazmin/browser` (`js/browser/jazmin-browser.js`) is
    read-only and has no dependencies. It reads every fixture except Brotli
    ones, with the same results as the library.
  - **Tested** in Chrome, Edge and Firefox (`npm run test:viewer`; CI runs
    Chrome and Firefox).
- **.NET serializer: Newtonsoft-style options (J-4, J-5)** in
  `JazminSerializerSettings` (USER-GUIDE §6.3, §7):
  - **Custom converters:** `JazminConverter<T>` in `Converters`, or
    `[JazminConverter(typeof(...))]` on a property or a type (counterpart of
    `JsonConverter`).
  - **Naming strategies:** `NamingStrategy = JazminNamingStrategy.CamelCase`
    (also `SnakeCase`, `KebabCase`). Names given with `[JazminProperty]` or
    `[JsonPropertyName]` stay as written.
  - **`DefaultValueHandling`:** `Ignore` stores default values as null,
    `Populate` fills them in when reading, and `IgnoreAndPopulate` does both.
    A default is the property's `[DefaultValue]`, or the type's default.
  - **Polymorphic types,** opt-in with System.Text.Json's `[JsonDerivedType]`
    on the base type. A `$type` column records each row's type, and only the
    listed types are ever created: unlike Newtonsoft's `TypeNameHandling`, the
    data cannot name a type to load.
  - **`PreserveReferencesHandling.Objects`:** an object that appears more than
    once is stored once (`$id` / `$ref`, as Newtonsoft writes them), and
    reading gives back the same instance. Inside json columns, System.Text.Json
    preserves references within each value.
  - LINQ predicates on converted properties, or with defaults stored as null,
    run in memory after reading. Maps that depend on settings are cached per
    settings instance.
- **Several tables in one file (D-3),** like the sheets of a workbook
  ([design](docs/design/several-tables.md), USER-GUIDE §23). No format
  change: format 1.0 already holds a list of tables.
  - **Writing:** declare the tables (`tables` / .NET `Tables` with
    `JazminTable`), then write them one after another with `startTable` /
    `StartTable`. JS `write()` takes rows by table name. Each table has its
    own columns, sort order, chunk size and, in access-controlled files,
    partitions and column groups. Keys, grants and metadata are file-wide.
  - **Reading:** the `table` option (.NET `Table`) picks a table by name; the
    first is the default. `tables` / `Tables` lists the names, and
    `openTable` / `OpenTable` reads another table of the same open file,
    reusing its keys and checks.
  - **Access follows the link:** partition and column-group names are shared
    by every table, so a key granted client `C1` sees `C1` in each table.
  - **Changing one table:** `append`, `update` and `compact` take a `table`
    option; a full rewrite copies the other tables.
  - On a statement file (20,000 clients, 300,000 transactions), two tables
    were 8% smaller, wrote 27% faster, read every transaction 18% faster and
    served one client's statement 10% faster than one flat table.
  - Interop fixtures `*-tables.jzm` and `*-tables-access.jzm`.
- **Columnar layout:** each chunk stores one stream per column, with
  per-type encodings:
  - delta for integers and dates;
  - a dictionary for repeated text;
  - bit-packed booleans;
  - floats stored as exact scaled decimals.

  On the benchmark data, files are 61% smaller than gzipped JSON (deflate),
  and both reads and writes are faster. Readers can skip columns that a query
  does not select. Spec section 5.4.
- **Async APIs (J-1):** the same results as the synchronous APIs, without
  holding up a server.
  - **JS:** `openAsync`; `findAsync` / `rowsAsync`, which read chunks with
    non-blocking reads, two ahead, and give the event loop back between
    chunks; `findBatchesAsync`, which yields one array per chunk and runs as
    fast as `find`; `writeAsync`, `writeRowsAsync` and `finishAsync`, which
    take async iterables and wait for compression workers without blocking.
  - **.NET:** `JazminReader.OpenAsync`; `FindAsync` / `RowsAsync` /
    `QueryAsync<T>` / `RowsAsync<T>` (`IAsyncEnumerable`), which decode on a
    thread-pool thread in batches of 512 while you await; `JazminWriter`
    `WriteValuesAsync` / `WriteRowsAsync` / `FinishAsync` and
    `IAsyncDisposable`; `JazminSerializer` `DeserializeAsync`,
    `DeserializeAsyncEnumerable` and `SerializeAsync` (from an
    `IAsyncEnumerable`).
  - Guide section 22.
- **Export shapes (no format change):** a JSON template turns rows into
  nested JSON or XML, for example one entry per client (details taken once)
  with its transactions and totals.
  - Nodes: columns (in a set, the first row's value), literals, `$value`,
    `$meta`, nested objects, and `$rows` lists with `$filter`, `$groupBy`,
    `$sort`, `$limit` and `$xmlItem`.
  - Aggregates `$count`, `$sum`, `$min` and `$max`; `int` and `decimal` sums
    are exact.
  - Shapes are validated against the columns a key can see before any data
    is read.
  - Every list is a query on the file: only the columns used are decoded, and
    groups stream when the file is sorted by them.
  - JSON Schema of the output: JS `shapeSchema`, .NET `ToJsonSchema`.
  - API: JS `toJSON`/`toXML`/`exportFile` with `{ shape }` and
    `compileShape`; .NET `JazminShape`.
  - Guide section 21; `docs/design/export-shapes.md`; shared fixture
    `spec/fixtures/shape.json`.
- **Sorted indexes in pages (spec 8.1):**
  - A sorted index is stored as pages of about 64 KiB plus a small directory,
    so a lookup reads one page instead of the whole index.
  - Range and `startsWith` queries read only the pages they span. Readers
    keep at most 8 decoded pages per index.
  - On 5M unique values, opening a file and looking up one value takes
    10.6 ms / 58 MB, against 886 ms / 730 MB with the index in one piece.
  - Indexes are declared as before.
  - Interop fixtures `js-paged-key.jzm` / `dotnet-paged-key.jzm`.
- **Embedded files:** store HTML, scripts, fonts, images, video,
  PDFs or any bytes alongside the data (spec 6.8).
  - Identical content is stored once.
  - Files are stored in 256 KiB blocks, so readers can read ranges or stream.
  - Each stored content has its own random key.
  - In access-controlled files, each file lists the groups that may see it:
    everyone, several groups, or one. Grants can add named file groups
    (`files`), and keys never learn the names of files they cannot see.
  - API: JS `files` / `addFile` / `readFile` / `readFileRange` / `openFile`;
    .NET `Files` / `AddFile` / `ReadFile` / `ReadFileRange` / `OpenFile` (a
    seekable stream).
  - `package` settings for viewers.
  - `append` / `update` take `addFiles` / `removeFiles`, and compaction drops
    unreferenced content.

### Performance
- **Columnar reads decode only the columns a query uses** (filter and select),
  in both libraries. On a 1M-row × 300-column file, a 2-condition filter went
  from 17.1 s to 5.4 s (Node), and summing 3 columns in .NET went from about
  the full-read time to 5.8 s.
- **New wide benchmark** (`bench/wide.js`, `-- wide` in .NET): 1M rows ×
  200–450 columns against streamed JSON.
- **Column statistics are stored outside the header:** loaded only for the
  columns a query filters on. Opening a 1M-row × 300-column file now takes
  0.01–0.03 s and 34–63 MB, whatever the column count (spec 6.4).
- **.NET writes run in parallel:** chunks are encoded, compressed and
  encrypted on worker threads and written in order
  (`JazminWriteOptions.MaxDegreeOfParallelism`, default up to 16; 1 = calling
  thread only). Columns are buffered in typed arrays and buffers are pooled.
  Wide write: 52.9 s → 11.3 s (System.Text.Json: 14.8 s); garbage collections
  per write dropped from 282 to about 5.
- **.NET reads decode into typed column arrays** (no boxing until a value is
  read), decode chunks ahead on worker threads within a memory budget
  (`JazminReadOptions.MaxDegreeOfParallelism`, default up to 4), and
  `DeserializeEnumerable<T>` builds objects straight from the column arrays.
  On the wide file: lookup 0.69 s → 0.08 s, sum of 3 columns 5.8 s → 1.1 s,
  read every row 16.7 s → 10.4 s; peak read memory 220–640 MB → 45–67 MB.
- **JavaScript reads and writes use less memory:**
  - reads reuse one file buffer across chunks and decompress straight into a
    buffer of the known size (no 16 KB pieces joined into a second copy);
  - full scans of columnar files build each row object only when it is
    consumed;
  - the columnar writer keeps a chunk's values in typed buffers (numbers in a
    `Float64Array`, strings as a dictionary) rather than JS arrays; files are
    byte-for-byte the same as before.

  On 100,000 rows × 300 columns: summing 3 columns 437 ms / 123 MB →
  319 ms / 94 MB; a 2-condition filter 454 ms / 120 MB → 334 ms / 90 MB; read
  every row 1.73 s → 1.62 s; write about 5% faster, with memory on par with
  `JSON.stringify`.
- **Guide:** how to keep Node.js memory low (`--max-semi-space-size=8`, §20.5).
- **JavaScript writes compress chunks on worker threads**
  (`maxDegreeOfParallelism`, default up to 2; 1 = main thread only; also
  accepted by `append`, `update` and `compact`).
  - The API stays synchronous.
  - Workers start only from the third chunk, so small files never pay for
    them.
  - Workers hand every buffer back to the main thread, so memory stays
    bounded.

  On 1M rows × 300 columns, writing takes 66 s against 86 s on one thread
  and 83 s for `JSON.stringify`, at 307 MB.

No file format change. Files written are byte-for-byte the same as before.
- **.NET:** reading a whole file into objects (`DeserializeObject<List<T>>`,
  `DeserializeEnumerable<T>`) decodes each chunk straight into your objects,
  with no boxing and no per-row arrays. It is about 2× faster than
  System.Text.Json on the benchmark (58 ms vs 116 ms on .NET 8).
  - Booleans and small integers no longer allocate when decoded.
  - Repeated short strings (codes, statuses, categories) share one instance.
- **JavaScript:**
  - Full scans decode chunks straight into row objects, and string decoding is
    faster: reading every row takes 96 ms, against 109 ms for `JSON.parse`
    (before: 176 ms).
  - Rows are built with one object shape.
- **Both:** trigram indexes build without temporary strings, so writing with
  3 indexes is about 45% faster in JavaScript and 25% faster in .NET.
- **Benchmarks** now run a warm-up first, for every contender alike.

### Fixed
- **Faster JS reads after a full garbage collection.** Every full collection
  made V8 discard the JS reader's optimised decoding code, so the next read
  ran slowly. Lookups in the benchmark took 3.6–8.7 ms, slowest on Node 26.
  They now take 2.7–3.0 ms, and full reads, filters and text searches are
  13–25% faster.
  - **Who gains:** the benchmark collects garbage before every run, so it
    shows the gain on every read. In a long-running process, it applies to the
    first reads after each full collection. Reads between collections were
    already fast.
- **Damaged files fail with a JAZMIN error** (found by fuzzing the readers,
  S-5). Before, a damaged file could fail with a raw `SyntaxError`,
  `TypeError`, `RangeError`, zlib error or `JsonException`. In .NET it could
  also run out of memory. Both readers now raise `JazminFormatError` /
  `JazminFormatException` for:
  - bad JSON in a json column, metadata, column attributes, embedded-file
    directories and package settings;
  - catalog fields with the wrong wire type, and out-of-range dates;
  - corrupt compressed data;
  - counts larger than their data could hold (postings, index pages, trigram
    indexes, a chunk's rows, the table's chunks and columns);
  - malformed embedded-file directories, and blocks of the wrong length.
- **A damaged length can no longer reserve gigabytes:** a section's declared
  decompressed size used to size its buffer up front (up to 4 GB). Buffers
  above 64 MiB now grow as the data arrives, and decompression stops at the
  declared size.
- **.NET typed reads** (`Rows<T>`, `Query<T>`, `DeserializeObject<T>`) raise
  `JazminValidationException` when converting a value to the property's type
  fails, for example text into a `Guid`. Before, they raised
  `InvalidCastException` or `FormatException`. The original exception is the
  inner exception.
- New fuzzers: `js/scripts/fuzz.js`, and `FuzzTests.LongRun` in .NET; see
  [CONTRIBUTING](docs/CONTRIBUTING.md#fuzzing-the-readers).
  `spec/fixtures/damaged/` keeps the damaged files that once failed with the
  wrong error.

### Security
From the internal security review (S-4,
[review package](docs/SECURITY-REVIEW.md)):
- **Appends can no longer narrow a grant.** An append keeps the file's
  secrets, so a narrowed key could still read the appended data. `append`
  now refuses with *"The grant for … is narrower than before"*. Use `update`
  or `compact`, which re-lock the file.
- **Readers refuse more hostile input** (spec 7.2, 7.6.4, 7.6.5):
  - password iteration counts outside 1,000 to 10,000,000 (writers keep to
    the same range);
  - key-slot and signature sections that are compressed or encrypted;
  - in access-controlled files, sections listed without a digest;
  - in encrypted files, embedded content without a key;
  - JavaScript: an unreadable expiry date, which now counts as expired.
- **The owner directory is stored uncompressed,** so its size does not hint
  at the grants and names it holds.
- `update` and `compact` keep the file's permissions on Linux and macOS.
- The signing-key cache no longer holds owner keys (JavaScript) and stays
  small (.NET).
- .NET: a filter can no longer name a hidden column's placeholder.
- **Sample key service:**
  - a confirmed authenticator can be replaced only after an admin reset;
  - code checks are serialised per user;
  - lockouts double each time, up to a day;
  - confirming respects the lockout;
  - codes are accepted within ±30 s;
  - a damaged file in the folder no longer breaks unlocks.
- **Docs:** online expiry, and what every key holder can see (spec 13).

## 0.3.0 - 2026-10-02 (file format 1.2)

### Added
- **Append-only updates:** JS `append()`, .NET `JazminFile.Append`. These
  support insert, upsert, delete, metadata and grants.
  - Changes are written after the existing data; existing bytes are never
    modified, so open readers keep working.
  - Cost depends on the size of the change (63 ms against 2.7 s for a full
    rewrite on a 1.37M-row file).
  - Deleted and replaced rows are recorded in a deletes section.
  - Each append adds an index segment, and readers combine the segments.
- **Compaction:** JS `compact()`, .NET `JazminFile.Compact`, with an optional
  `autoCompact` threshold on appends.
- **Crash recovery:** after an interrupted append, readers use the last
  complete version (`recovered`), and the next append cleans up the leftover
  bytes. A failed append leaves the file byte-for-byte unchanged.
- **One writer at a time:** `append`, `update` and `compact` share a
  `<path>.lock` lock file.
- **Reader properties:** `appendCount`, `deletedRowCount`, `recovered`.
- **Time-limited access:** grants take `expires` / `expiresIn` (JS `'2h'`,
  `'14d'`, `'5y'`; .NET `Expires` / `ExpiresIn`) and a mode.
  - **Offline:** the expiry is sealed and signed in the key's slot. Readers
    refuse after it, refuse a clock earlier than the signed file date, and
    detect a clock set back using a per-user, HMAC-protected last-seen record
    (shared by JS and .NET).
  - **Online:** the slot also needs an unlock token (`jzu1-...`) from the
    owner's key service. Tools: `issueUnlockToken` / `IssueUnlockToken`,
    `listUnlockTokens` / `ListUnlockTokens`, `inspect` / `Inspect` (file id
    without a key).
  - Updates, appends and compactions drop expired grants
    (`expiredGrantsRemoved`).
  - New errors: `JazminAccessExpiredError` / `Exception` and
    `JazminUnlockRequiredError` / `Exception` (with `fileId`, `keyId`).
- **Sample key service with 2FA** (`dotnet/samples/Jazmin.KeyService`, .NET 10):
  issues unlock tokens only after a valid authenticator code (TotpAuthSharp),
  with replay protection and lockout. CI now also installs .NET 10.

### Changed
- The .NET library now builds for both .NET 8 and .NET 10; each app uses the
  build that matches its runtime. .NET 8 support ends in November 2026.
  On .NET 10, reads and writes are faster, but deflate files are up to 9%
  bigger (a different zlib engine); `CompressionLevel = 9` restores the .NET 8
  size at the cost of slower writes. See guide §9.1.
- .NET readers open files in a mode that lets appends proceed while they are
  open.
- On Windows, a full rewrite of a file that another process has open now
  fails with a clear error. Before, it gave a raw `EPERM` / access-denied
  error. The original file is untouched either way.

### Fixed
- The JS writer's `now` option now also sets the file's `created` and
  `modified` dates.
- JS `JazminReader.close()` could be called twice, and the second call threw
  `EBADF`. That error could hide the real error in failure paths.

## 0.2.0 - 2026-10-02 (file format 1.1)

### Added
- **Access-controlled files:** one owner key issues access keys (`jza1-...`). Each
  access key sees only its granted row groups and/or column groups. Files are
  signed by the owner, and only the owner key can update them or grant access.
  JS: `access` writer option, `createAccessKey`, `grantAccess`, `revokeAccess`.
  .NET: `JazminAccessOptions`, `JazminGrant`, `CreateAccessKey`, `JazminFile.GrantAccess` / `RevokeAccess`.
- **Updates:** insert, upsert by key columns, delete by filter, and metadata
  changes, written as a new version that atomically replaces the file.
  JS `update()`, .NET `JazminFile.Update`.
- **`sortedBy`:** the writer enforces row order; readers binary-search
  chunks; updates keep the order.
- **Streaming JSON import** of any size, from a JSON array or JSON Lines:
  JS `importJSONFile` / `readJsonObjects`, .NET `JazminConvert.FromJsonFile`.
- .NET `JazminWriter.Abort()`.
- Benchmarks: section-by-section workload (Node), streaming JSON comparison
  (Node, .NET), access control at scale (Node, .NET).
- CI on Ubuntu and Windows with Node 20 and 24, checking interop both ways.

### Changed
- **Faster reads:**
  - the index on the leading `sortedBy` column is no longer loaded;
  - binary search over sorted chunks;
  - .NET: compiled object materializer, exact LINQ translation without
    compiling the predicate, and faster header parsing;
  - faster CRC-32.
- The JS reader `rowCount` counts only the rows the key can see
  (`hiddenRowCount` gives the rest).
- Readers reject files with unknown preamble flags.
- .NET tests write `dotnet-*.jzm` interop files to a temp folder unless
  `JAZMIN_WRITE_FIXTURES=1` is set.

### Fixed
- .NET LINQ: `Query<T>(l => l.Section == x)` failed with "unknown column" when
  the file's column differed in case (for example `section`).
- .NET LINQ: range comparisons on enums, and culture-sensitive
  `StartsWith(string)`, could be translated in ways that dropped rows that
  should have matched.

## 0.1.0 - 2026-10-01 (file format 1.0)

- First release: format specification, JavaScript/TypeScript and .NET
  libraries, JSON/CSV/XML conversion, indexes, AES-256-GCM encryption,
  Newtonsoft-style .NET API, interop fixtures, benchmarks and user guide.
