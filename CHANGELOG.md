# Changelog

Both libraries share a version number. File format versions are listed separately and
are specified in [docs/rfc](docs/rfc/draft-jazmin-format-03.md).

## Unreleased

### Fixed
- **Long `in` lists were slow: every row was compared with every listed value** (JS, the browser reader and .NET).
  20,000 values against 100,000 rows took 24 s in JS and 7.3 s in .NET. Rows are now checked against a hash set of
  the listed keys, and chunk statistics against the keys in order: the same count now takes 18 ms in JS, 44 ms in the
  browser reader and 36 ms in .NET.
  - **Also faster in .NET LINQ:** `ids.Contains(x.Id)` becomes an `in` condition.
  - **Same results:** decimals still compare by value (`7.5` equals `7.50`), -0 equals 0, and NaN and null in a list
    match nothing.

## 1.2.0 - 2026-10-08 (file format 1.0)

Choose memory or speed first, give a file (or a shared file) a new key without
rewriting it, query .NET files with LINQ the reader runs, and serve a file's
embedded files and documents from a server, with a new package for ASP.NET
Core. Typed and wide reads in .NET are several times faster.

- **Files:** still format 1.0. Version 1.1.0 reads and appends to files
  written by 1.2.0 (tested with the published package), except files written
  with the new, opt-in `compactIndexes`: those need 1.2.0 or later, and older
  readers refuse them, naming what they lack.
- **New package:** `Jazmin.AspNetCore` (NuGet), for ASP.NET Core endpoints.
- **Changed behaviour:** readers refuse a file whose own JSON repeats a name
  (neither library writes one); .NET `ToXml` declares UTF-8; new files with
  `sortedBy` have no index on their first sort column (see Fixed and Changed).
- **Still deprecated, removed in 2.0:** getting a key's secret with
  `toString()` (use `export()`), and the reader's clock option.

### Fixed
- **Viewer: a document's `jazmin.query(…, { orderBy })` sorted decimals as
  text.** `"99.00"` came after `"100.00"` in descending order, because
  decimals are exact strings. They are now compared by value, as the
  libraries compare them; other types sort as before.
- **Viewer: fonts, audio and video from a package's allowed origins were
  blocked.** A template could load scripts, styles, images and data from the
  origins its package settings allow (`allowedOrigins`), but not fonts or
  media: Google Fonts, for example, failed even with both of its origins
  listed. They now load from those origins, and still from no others.
  Packages without `allowedOrigins` are unchanged.
- **.NET: `Query<T>` with a condition gave wrong results on files that
  preserve references** (`PreserveReferencesHandling.Objects`). In those
  files a repeated object is stored once; later rows only refer to it and
  store no values of their own.
  - **Before:** the condition was checked against stored values, so rows
    that only referred to a matching object were missed (1 match instead
    of 3 in the test), and a referring row whose earlier row was filtered
    out failed with "A row refers to object ..., which no earlier row
    defines". `QueryAsync<T>` was affected too.
  - **Now:** for these files every row is read in order and the condition
    is checked on each object, as LINQ over the list does. Other files are
    unaffected.
- **JS: writes with Node heap options ran up to 20% slower in 1.1.0.** The
  fix for parallel writes under `node -e` gave the compression workers the
  process's Node options explicitly, and passed that way, heap options such
  as `--max-old-space-size` slowed them. Workers again inherit the options
  as they are, unless code given on the command line must be left out.
  - **With the guide's server options** (`--max-old-space-size=64
    --max-semi-space-size=2`), a wide write (200,000 rows x 300 columns)
    went back from 23.3 to 19.8 s; its peak memory is 123 MB again, as in
    1.0.0 (98 MB in 1.1.0).
  - **Without Node options:** no change.
- **JS: a column named `__proto__` is read as an ordinary field (#68).** In
  JavaScript, assigning to `__proto__` sets an object's prototype instead of
  adding a field.
  - **Before:** the column was missing from rows read (`rows`, `find`,
    `get`), from `columnArrays()`, and from CSV and XML imports; a CSV
    import with that header failed. A hostile file with a `json` column of
    that name could make its value each row's prototype, so rows seemed to
    have fields the file doesn't declare. No code ran, and nothing outside
    the row objects changed.
  - **Now:** that name becomes a field like any other, in the library and
    the browser reader. Other column names are unaffected, and reading is
    as fast as before.
  - **Not affected:** .NET.
- **Some damaged files failed with a .NET or JavaScript error instead of a
  JAZMIN error.** The first long fuzz run found three causes in .NET; one of
  them was in JS too. Each now fails with `JazminFormatException` /
  `JazminFormatError`, and `spec/fixtures/damaged/` holds files that showed
  them, so both test suites keep checking.
  - **A name repeated in one object of the reader's own JSON:** the
    metadata, column attributes, package settings, an embedded-file
    directory, a key slot or the owner directory. Neither library writes
    such JSON, so only damaged or hand-made files are affected.
    - **Before:** .NET threw `ArgumentException` when the object was first
      used; JS kept the last value, as `JSON.parse` does.
    - **Now:** both libraries and the browser reader reject the file, as
      the spec now says (section 2). `{"id":1,"id":2}` is rejected; the same
      name in different objects or at different levels is not.
    - **Cost:** checked once per file. A 177 KB owner directory (1,000
      grants) takes about 0.5 ms more to read in JS.
    - **Not checked:** values of `json` columns, your own data. Checking
      them would make them about 1.5 times slower to read in .NET.
  - **A dictionary column whose size didn't fit its stream:**
    `OverflowException` or `IndexOutOfRangeException` in .NET, `RangeError`
    in JS.
  - **.NET: an index directory whose offsets added up past the largest
    number:** `OverflowException`.
  - **Not affected:** files the libraries wrote, and the speed of reading
    them.
- **Security notes: what package scanners report (SECURITY.md).** Why the
  reader generates code (`new Function`), and why that is safe; the one
  environment variable the library reads; file access; and the one URL in
  the package, which is never fetched. A new test checks that column names
  built to break out of the generated code never run.
- **.NET: XML text from `ToXml` declares UTF-8.** `JazminConvert.ToXml` and
  `JazminShape.ToXml` declared `encoding="utf-16"`, the encoding of a .NET
  string in memory.
  - **Before:** saved as UTF-8, as `File.WriteAllText` and web responses
    save it, the file was refused by readers that trust the declaration,
    such as `XmlDocument.Load`.
  - **Now:** the text declares `utf-8`, as the JavaScript library's does.
  - **Unchanged:** the XML itself, and XML written to a stream or
    `TextWriter`, which declares that writer's encoding.

### Changed
- **.NET: JSON exports of wide tables are about 3 times faster.**
  `JazminConvert.ToJson` and `JsonFormat.Write` looked up every value by
  column name, one column after another; they now read a query's values by
  position. 200,000 rows x 300 columns: 24.4 s -> 7.4 s, with the same
  bytes and memory.
- **.NET: typed rows read only the columns their type maps.** `Query<T>`,
  `Rows<T>` and `AsQueryable<T>` decoded every column of the file, and built
  each object from a row of boxed values; they now decode the type's columns
  only and build objects straight from the decoded columns, as
  `DeserializeEnumerable` does. Same objects.
  - **200,000 rows x 300 columns, a type mapping 9:** every row 3.2-3.7 s
    -> 0.31 s; `Query<T>(condition).Count()` 3.3-3.9 s -> 0.38 s.
  - **500,000 rows, a type mapping every column:** 0.31-0.41 s -> 0.21 s,
    at the same memory.
- **.NET: reading a wide row's values by name is up to 5 times faster.**
  `row["name"]` (and `TryGetValue`, `ContainsKey`, `Get<T>`, `GetDecimal`)
  checked the row's column names one at a time. The rows of a query now
  share a name lookup, built the first time a value is read by name; rows of
  8 columns or fewer still check each name, which is faster for so few.
  - **200,000 rows x 300 columns, every value by name:** 15.1 s -> 3.1 s
    (by position: 2.6 s). Three values near the end of each row: 2.2-2.5 s
    -> 2.0 s, the time to walk the rows.
  - **Memory:** each row object is 8 bytes smaller; the lookup is one per
    query.
  - **Unchanged:** names match exactly, as before, and reading by position
    or into typed objects.
- **Files with `sortedBy` are smaller: no `sorted` index on the leading sort
  column.** Readers find that column's values from chunk statistics, and
  have never used such an index; the spec already said writers should not
  build it (6.7). Both writers now leave it out (TASKS P-13).
  - **Proposals benchmark** (200,000 transactions, sorted by time, four
    sorted indexes): the file is 8.0 MB instead of 9.2 MB, its indexes
    3.4 MB instead of 4.6 MB.
  - **Unchanged:** query results and bytes read (the benchmark's check
    passes); a `trigram` index on that column is still written.
  - **Compatible both ways:** 1.1.0 reads these files, and appends to them,
    with the same results, and these libraries append to files that still
    have the index (checked against the published 1.1.0).
  - **`reader.indexes`** no longer lists that index for new files.
- **JS: trigram indexes are built faster.** Grams of ASCII text are keyed as
  small integers, which V8 looks up fastest, and the builder remembers the
  grams of up to 4,096 values (a value seen again only adds its row): the
  index is byte for byte the same.
  - **Building alone, 200,000 values:** repeated names 70.7 -> 37.0 ms;
    unique e-mail addresses 122.6 -> 95.8 ms; text with non-ASCII
    characters 107.4 -> 93.0 ms.
  - **The benchmark's write with 3 indexes:** 354 -> 281 ms (2.08 -> 1.70
    times a write without indexes; TASKS P-5 aims for 1.5).
- **JS: writing decimals is faster.**
  Format 1.0 stores a decimal as a scale and an integer, and the writer
  worked each value out with BigInt arithmetic two or three times (its
  canonical text, its encoding, the chunk statistics): a write of 300 mixed
  columns became 41% slower. Decimals of up to 15 digits now take a path
  without BigInt that gives the same text, bytes and statistics (checked
  against the BigInt path on random values); longer ones keep it.
  - **Wide write** (200,000 rows × 300 columns): 18.5 -> 14.4 s. With
    1,000,000 rows: 69 s, against 81.8 s for `JSON.stringify`.
- **.NET: opening a file to read a few rows is about 1.5 times faster (#70).**
  On the benchmark, finding one record by id (open the file, look it up)
  went from about 2.0 to 1.4 ms, and from 2.0 to 1.3 ms encrypted.
  - **Why:** the code that turns a row into an object is compiled while the
    program runs. It was kept for one reader only, so every file opened
    compiled it again: most of a lookup's time, plus clean-up work later.
  - **Now:** it is reused by every reader of a file with the same columns
    (names, types and order). A file whose columns differ gets its own.
  - **Reading whole files:** each call saves one compile, and calls without
    settings no longer miss the cache (each made its own default settings).
  - **Unchanged:** each read still converts with its own settings, a reader
    reused for many lookups is as fast as before, and memory use is the same.
  - **Safer with threads:** the whole-file cache keeps a file's columns and
    their code in one record, so a reader on another thread can't pair one
    with the other.
- **Windows: `update()` and `compact()` work while readers have the file open
  (JS and .NET, TASKS W-1).** Before, they failed with "Windows does not
  allow replacing an open file".
  - **Now:** readers that have the file open keep reading the version they
    opened, as on Linux and macOS, and see the new one when they open the
    file again.
  - **How:** readers already open files so that they may be renamed. .NET
    replaces the file in one step (a POSIX-style rename), or where that isn't
    supported, in two: the open file is moved aside, the new version takes
    its place, and the old one is deleted. JS uses the two steps, since Node
    has no single-step way, so for an instant the file's name is missing.
  - **Still refused:** a program that holds the file without allowing it to
    be renamed (some editors and backup tools). The error now says so, and
    the file is left as it was.
- **`columnArrays()` is faster and leaner (JS and the browser reader).**
  Values go from the decoded columns straight into the arrays: no object per
  row, no `Date` per date, and a full read hands over each chunk's rows at
  once. One million rows, two columns:
  - **Node:** two number columns 170 -> 121 ms; a date and a number 218 ->
    135 ms, with peak memory 201 -> about 150 MB.
  - **Browser reader:** 790 -> 300 ms, and 930-990 -> 305 ms with a date
    (peak memory 241-272 -> about 170 MB).
- **Browser reader: integers are read with numbers, as the library reads
  them.** Every integer, length and count went through BigInt arithmetic.
  Reading every row of one million: 1.33-1.37 s -> 0.80 s, peak memory
  about 232 -> 164 MB. Values beyond ±2^53 are still BigInts.
- **.NET writer: less clean-up work per write.** Spare column buffers are
  kept in a queue instead of a `ConcurrentBag`, which held a `ThreadLocal`
  that was never disposed (one per partition, per write). About 3% on the
  write loop.

### Added
- **.NET: a new package, `Jazmin.AspNetCore`: `app.MapJazminFiles(pattern,
  resolver)` serves a file's embedded files from an ASP.NET Core endpoint.**
  The resolver picks the file and key per request (from route values and the
  user): only what that key can see is served (404 otherwise; 403 for a key
  that cannot open the file). Byte ranges, HEAD and 304s (ETags are the
  SHA-256) come from ASP.NET over a stream that decodes a block at a time;
  pages and SVG get the viewer's document policy and a sandbox. A separate
  package, so apps without ASP.NET keep a `Jazmin` without it.
- **JS: serving a file's embedded files, and its document as a PDF (TASKS
  F-3).**
  - **`serveFiles(reader, { prefix })`**, a Node request handler (http,
    Express), and **`createFileHandler(reader)`** for request interception:
    only the files the key can see, one byte range per request (from the
    blocks it falls in), ETags from each file's SHA-256, and pages and SVG
    served with the document's security policy and a sandbox, so a stored
    page cannot act as your site.
  - **`renderPdf({ file, key, browser })`** prints the file's document in a
    Playwright or Puppeteer browser you supply, with the viewer's
    `window.jazmin` API answered from the file: one template serves the
    viewer and PDFs (a test renders the viewer's test template and gets the
    same answers). Each document gets a browser context of its own and can
    reach only its files and allowed origins. About 0.3-0.5 s per PDF.
  - **The library still has no dependencies.** Its tests use
    `playwright-core` and `puppeteer-core` (development only, no browser
    download: the installed Chrome or Edge).
- **.NET: LINQ queries that run in the reader: `reader.AsQueryable<T>()`
  (TASKS J-2).** Write the query with the usual LINQ operators; the reader
  does as much of it as it can, and the rest runs in memory. Results are
  always those LINQ gives over a list.
  - **In the reader:** `Where` (and the condition of `Count`, `Any`,
    `First`, `Single`, `Last`) becomes a filter that uses indexes and chunk
    statistics, as in `Query<T>`; `Skip`/`Take` its offset and limit;
    `Count`/`LongCount`/`Any` are answered without building objects;
    `OrderBy`/`ThenBy` along the file's `sortedBy` columns cost nothing.
    A `Select`, or `Sum`/`Average`/`Min`/`Max` with a selector, reads only
    the columns it uses.
  - **200,000 rows x 300 columns, a type mapping 9 of them** (`Query<T>`
    1.1.0 with LINQ to Objects -> `AsQueryable`): a page at row 150,000
    2.5-2.7 s -> 0.05 s (63 -> 35 MB); `OrderBy(id).Take(10)` on a file
    sorted by id 3.5 s -> 0.05 s (100 -> 35 MB); `Count(condition)`
    3.3-3.9 s -> 0.25 s; a condition and two columns 3.6 s -> 0.35 s.
  - **Files that preserve references** (`PreserveReferencesHandling.Objects`)
    run the whole query in memory: their rows refer to earlier rows.
- **A new owner key for a shared file: `rotateOwnerKey()` /
  `JazminFile.RotateOwnerKey`**, for when the owner key may have leaked.
  - **Every access key is replaced:** each one carries a stamp of the owner
    key that issued it, and readers check it, so none can survive the
    change. Each new key opens exactly what the old one did: rows, columns,
    embedded files, label, expiry and mode. The result lists them with the
    id of the key each replaces, to hand out.
  - **Online keys need new unlock tokens,** issued with the new owner key.
    Expired grants are dropped.
  - **The file is rewritten** with fresh secrets. Neither the old owner key
    nor any old access key opens it afterwards.
  - **Checked across libraries:** each library reads the other's re-keyed
    shared file with the new keys, every key seeing what it saw before.
- **.NET: rows as a JSON stream or JSON tokens (TASKS J-3).** For code that
  already consumes JSON (user guide 11.2):
  - **`JazminJsonStream`:** a query's rows as UTF-8 JSON, written as it is
    read, for any System.Text.Json pipeline or an HTTP response. It gives
    the same bytes as `JazminConvert.ToJson`, holding about 64 KiB at a
    time.
  - **`JazminJsonReader`:** the same rows as tokens, one at a time, as
    Newtonsoft's `JsonReader` gives them (`Read`, `TokenType`, `Value`,
    `Depth`, `Path`), with no JSON text written or parsed. `json` columns
    come as nested tokens.
  - **200,000 rows x 300 columns** (1.3 GB of JSON): the stream 7.1 s at
    63 MB, the tokens 4.8 s at 62 MB.
  - **No new dependency:** Newtonsoft.Json is not needed.
- **Change a file's key or password: `rotateKey()` / `JazminFile.RotateKey`
  (TASKS S-2).** The file is encrypted again under a new key or password,
  and only the new one opens it: its master key, file id, salt and every
  section's key are new.
  - **Rows are not decoded:** each section is decrypted and encrypted again
    as it is stored, so the file keeps its layout. A 176 MB file of 200,000
    rows x 300 columns: 0.7 s at 138 MB in Node (a full rewrite: 33 s,
    about 450 MB), 0.7 s at 45 MB in .NET (14 s, 120 MB).
  - **Files with appends** are compacted first, so their earlier versions,
    still under the old key, are not kept.
  - **Keys and passwords can change places.**
  - **Shared (access-controlled) files:** see `rotateOwnerKey` below.
  - **Checked across libraries:** each library reads the files the other
    rotated, with the same rows and embedded files.
- **Compact indexes, opt-in: `compactIndexes` (.NET `CompactIndexes`).**
  Sorted indexes store each key as its difference from the previous one
  (text: only the part after what it shares with the previous key), and
  each entry's first row id the same way. Part of TASKS P-13.
  - **Smaller files:** 200,000 rows indexed on an id, a code and a date:
    1.8 MB instead of 4.5 MB. The time-sorted proposals benchmark file:
    7.0 MB instead of 8.0 MB (its indexes 2.4 MB instead of 3.4 MB).
  - **Lookups as fast or faster** (5-16% less time in Node, 4-14% in .NET):
    pages are cut where they would be without the option, so a lookup
    decodes as many entries, and there is less to read and decompress.
  - **A new format feature,** `index-deltas` (spec 8.1). Readers before 1.2
    refuse such files with a message that names it, so the option is off
    by default until 2.0. Appends keep a file's choice; `update` and
    `compact` keep it unless told otherwise.
  - **Checked across libraries:** fixtures written by each
    (`js-paged-compact.jzm`, `dotnet-paged-compact.jzm`) are read by the
    other and by the browser reader; the published 1.1.0 refuses them.
- **Choose memory or speed first: the `priority` setting.** `'memory'`,
  `'balanced'` (the default, as before) or `'speed'` (.NET:
  `JazminPriority`), on reads and writes, updates and appends, and .NET's
  `JazminSerializerSettings`. It sets how many threads work at once and how
  far a scan decodes ahead. The file written and the rows read are the same
  whichever is chosen, and an explicit `maxDegreeOfParallelism` still wins.
  Measured on 200,000 rows x 300 columns (user guide 20.4):
  - **`memory`:** everything on the calling thread. .NET queries of a few
    columns use 49 MB instead of 54 MB but take about 3 times as long; .NET
    writes 68 MB instead of 79 MB (11.2 s instead of 4.3 s); Node writes
    233 MB instead of 257 MB (19.6 s instead of 15.0 s).
  - **`speed`:** .NET reads decode up to 8 chunks ahead instead of 4, and up
    to 1,024 columns in flight instead of 128. Queries of a few columns:
    0.19 s instead of 0.27 s (65 MB instead of 54 MB). Reading every row of
    a 300-column table: 2.10 s instead of 2.29 s (95 MB instead of 60 MB).
    Writes are as balanced in both libraries, because more threads did not
    write faster.
  - **`speed` in Node reads:** scans decompress (and decrypt) the next
    chunks on worker threads while rows are built (TASKS P-4): up to 4, or
    2 when a scan decodes more than a quarter of the columns. Queries of 3
    columns: 0.24 s instead of 0.66 s (196 MB instead of 125 MB); reading
    every row: 4.34 s instead of 4.80 s (256 MB instead of 226 MB). Workers
    start from a scan's third chunk; files with one column group only.
- **Large XML files are imported without loading them (TASKS C-2):**
  `importXMLFile(path, target, options)` and `JazminConvert.FromXmlFile`, as
  CSV below.
  - **A 1 GB XML file (4.6 million rows):** .NET 11 s at 65 MB peak memory;
    Node 48 s at 86 MB (with the same flags). `fromXML` took 1.3 GB for a
    200 MB file.
  - **JavaScript:** a reader of the canonical XML shape that takes bytes a
    block at a time; `fromXML` uses it, and gives the same rows as before
    (checked against the previous parser on 50,000 random documents, whole
    and in pieces). Tags without attributes are read from the bytes.
  - **.NET:** `XmlFormat.ReadRows(XmlReader)`, which `Parse` uses. A file is
    read as UTF-8 (or as a byte order mark says): `ToXml` returns a string
    whose declaration says UTF-16, and a reader trusting it refuses the
    UTF-8 file such a string is usually saved as.
- **Large CSV files are imported without loading them (TASKS C-2):**
  `importCSVFile(path, target, options)` and `JazminConvert.FromCsvFile`.
  - **How:** the file is read twice, a block at a time: once to work out the
    column types (as `fromCSV` does), then to write the rows. With `columns`
    given, each value is read as its column's type (a CSV export imports back
    exactly) and the file is read once.
  - **A 1 GB CSV file (10 million rows):** .NET 14 s at 63 MB peak memory;
    Node 44 s at 92 MB (with `--max-old-space-size=64
    --max-semi-space-size=2`). `fromCSV` took 1.6 GB for a 200 MB file.
  - **Also:** `readCsvRecords(path)` / `CsvFormat.ReadRecords(reader)` give a
    file's records one at a time; `fromCSV` / `FromCsv` read the same records
    as before (checked against the previous parser on random input).
- **.NET profiling tools (`dotnet/profiling`).** `ProfDrive` runs one path
  at a time (lookup, lookup on a reused reader, read all, write) with no
  forced garbage collection between runs, so a CPU trace shows the library's
  own work; `analyze.js` summarizes a trace. The README explains how to
  record one.
- **The benchmark's `streaming` mode** says how to run it when no data file
  is given, instead of crashing.
- **User guide: GraphQL resolvers that decode only the fields a query asks
  for** (section 8.2), with totals from `count()` and pages after a known id.
  The example was checked with graphql-js: aliases, `__typename` and
  fragments (which read every column) give the right results.

## 1.1.0 - 2026-10-06 (file format 1.0)

People in the field can now send records back from a phone (#13), and the
owner of a shared file finds records without reading every person's part.
Queries read less, and appends to shared files stay fast with many people.

- **Upgrade if you write decimals from JavaScript:** 1.0.0 could damage
  decimals of more than about 20 digits (see Fixed).
- **Files:** still format 1.0. Version 1.0.0 opens files written by 1.1.0
  (tested with the published packages); the new owner-only parts are skipped.
- **Changed behaviour:** browsers refuse a shared file's master key (see
  Changed).
- **Deprecated, removed in 2.0:** getting a key's secret text with
  `toString()` (use `export()`), and the reader's clock option (see
  Deprecated).

### Fixed
- **JS: parallel writes hung in code run with `node -e` or `node -p`.**
  - **The bug:** worker threads take the process's Node options, so they ran
    the command-line code instead of their own file. That code wrote again
    and started more workers, until the writer gave up two minutes later
    with an error. Scripts in files were not affected.
  - **Now:** the workers get the process's options without the code given on
    the command line (`-e`, `-p`, `--eval`, `--print`, `--input-type`).
- **JS writer: long decimals could be written damaged (data loss).** A
  decimal's integer part is written as a variable-length number. For values
  with more than about 20 significant digits, the 1.0.0 JS writer could
  drop the end of it without any error.
  - **Statistics (from about 33 digits):** a chunk's min/max bounds could
    not be read, so a range query such as `{ d: { lt: '1000' } }` failed with
    "Unexpected end of data". The Node and browser readers were affected.
  - **The rows themselves (longer values):** depending on where a value fell
    in the write buffer, the stored data was damaged. A file with 80-digit
    decimals could not be read back ("Varint too long").
  - **Fix:** the writer makes room for the whole number. Values up to the
    format's 256-digit maximum are tested: rows, statistics, sorted indexes,
    filters, encryption, the browser reader, and .NET reading the files.
  - **Not affected:** the .NET writer and the readers.
  - **What to do:** open any file written with JS 1.0.0 that holds such
    decimals. If it reads, `compact()` it with this version, which writes its
    statistics again. If it doesn't, write it again from its source data.
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
- **Appends to shared files no longer slow down with the number of people
  (JS and .NET).** A one-record append to a file with 1,000 partitions: JS
  57 -> 16 ms, .NET 41 -> 23 ms; with 100: JS 16 -> 12 ms, .NET 16 -> 14 ms.
  - **No chunk directories read:** an append read every partition's. It
    needs only the partition list, and, in a sorted table, the last chunk's
    partition, which the chunk map names.
  - **Each person's key handled once:** an append parsed every grant's key
    three or four times, checking its checksum and working out its id each
    time (two hashes). Keys from the owner directory, which the owner key
    authenticates, are parsed once without the checksum; a key's id and
    text are kept once worked out; ids are not needed at all when the
    append changes no grants.
  - **Partition ids worked out when needed:** each is a keyed hash, and an
    append rarely needs them all.
- **Owner lookups in shared files no longer read every partition (JS and
  .NET; a new optional part of the format, spec 7.6.5).** The file keeps a
  chunk map for the owner: which partition each chunk of records is in. An
  owner's index lookup reads only the partitions holding its records.
  - **Finding one record by id, 250,000 records:** 1,000 partitions, JS 49
    -> 2.0 ms and .NET 28 -> 2.7 ms; 100 partitions, JS 4.9 -> 1.7 ms and
    .NET 5.0 -> 3.1 ms. `get(rowId)` uses the map too.
  - **The map is written whole by a full write or compaction.** An append
    writes only the chunks appended since, so a batch grows the file by a
    few hundred bytes, not the whole map.
  - **Only the owner reads it** (it reveals every partition's size). Readers
    check the chunk directories against it, and read every partition when
    they differ.
  - **Older files** get a map at their next compaction or full rewrite;
    until then they read as before. Readers that don't know the map ignore
    it.
  - **Lookups the index answers** were limited to index lookups of under
    8 KB. The limit now grows with the number of partitions (8 KB each),
    since the alternative reads a section per partition: an id lookup in a
    large file now skips every partition's statistics, as intended.
- **Faster owner lookups and appends in shared files (JS and .NET).**
  - **Lookups through a small index match** (an id, a few values) no longer
    read the statistics of every partition: the index already narrows the
    rows to check. With 100 partitions, finding one record by id read 218
    sections in JS; it now reads 12 times from disk.
  - **Appends work out their result** (row, append and deleted-row counts)
    instead of opening the file again. A one-record append to a shared file
    with 100 partitions: JS 15.6 -> 13.3 ms, .NET 15.9 -> 14.4 ms.
  - **JS reads an owner's many small catalog sections in a few reads**
    (chunk directories, statistics: one per partition), when there are 16 or
    more close together.
  - The filing service files a batch in about 30 ms, down from about 40.
- **Faster, leaner index building for rows that arrive almost in order (JS and
  .NET).** Sorted indexes are built from ascending runs, merged when the
  index is written. Before, one row out of order switched the builder to a
  lookup table of every key. Compaction that regroups partitions, and
  appends after the rest, are the common cases.
  - **.NET:** compacting a 250,000-record shared file peaks at 68 MB
    instead of 81 MB, and takes 680 ms instead of 739 ms.
  - **Unchanged:** keys in no particular order still use the table; the
    index bytes are identical (checked against the reference builder).
- **Fewer disk writes (JS):** sections up to 256 KB are written in batches of
  up to 1 MB, instead of up to 8 KB in batches of 64 KB. Each write is a
  system call, slow with real-time scanning on Windows. Compacting a
  250,000-record shared file went from about 600 to 565 ms.
- **The filing service compacts on one thread:** in a shared file, 2 worker
  threads made compaction about 5% faster for about 35 MB more.
- **The filing benchmark measures memory on one run.** It measured the peak
  over six runs in one process, so it reported 318 MB for a compaction that
  peaks at 148 MB (115 MB on one thread).
- **Browsers refuse a shared file's master key (#13).** The viewer and the
  browser reader no longer open an access-controlled file with its master
  (owner) key.
  - **The message:** it says to use an access key, and how to create a
    full-read one (`grantAccess(file, owner, key, { rows: '*', columns: '*' })`).
  - **The viewer** also clears the key box after refusing, so the master key
    isn't left in the page.
  - **Unchanged:** one-key and password files open as before. The Node and
    .NET libraries still take master keys, on servers and in tools.
  - **Breaking:** pages that opened shared files with the master key must
    switch to an access key. See `docs/design/browser-writer.md`.
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
- **A reference filing service (#13),** in `js/examples/filing-service`.
  - **`fileBatch()`** files the records a phone sends back into the shared
    file.
    - **Refused:** unknown or revoked keys; batches that don't open
      with the sender's submission key; columns the shared file doesn't have, or
      has with another type; rows for another person's partition.
    - **Records sent again (#55):** a row whose id is already filed
      changes the filed record; the last to arrive wins. Allowed for anyone
      whose grant covers the record's partition. A change can't move a record
      to another partition. Only non-empty values change a field, so a phone
      sends just what changed. A row that changes nothing (a batch sent
      twice) counts as a duplicate.
    - **Columns:** a sender writes only the columns its grant covers, in new
      records too. Columns the shared file doesn't have are ignored, not
      rejected; the result names them (`ignoredColumns`).
    - **One read per batch:** the shared file is opened once for the grant,
      the records and the files (about 2 ms faster per batch). A record keeps, adds or drops files through its list; files
      no record lists any more are removed. `onDuplicate: 'skip'` keeps the
      first version instead.
    - **Keys that expire:** a batch is filed only if it was written (by the
      phone's clock) and received (by the server's clock, `receivedAt`)
      before the expiry. The first write after the expiry removes the grant,
      so the README shows filing each upload as it arrives. The inbox runner
      takes each batch's arrival time from its file's modified time.
    - **Files with records:** each row lists its files (photos, PDFs) in an
      `attachments` column. Refused: files a row lists that the batch doesn't
      hold, files no row lists, files whose first bytes aren't PDF, JPEG, PNG
      or WebP, and files over 10 MB (50 MB per batch). Each file is stored at
      `attachments/<key id>/<sha256>.<ext>`, for the keys that see the row's
      partition, and the row's list becomes `[{ path, name, type, size }]`.
  - **A benchmark, `npm run bench:filing`:** filing costs about 40 ms per
    batch at 10,000 to 250,000 records (the README has the figures).
  - **`inbox.mjs`** files every batch in a folder on a schedule, then compacts
    and regroups.
  - **The owner key** comes from a secret, never a page or a phone.
- **Writing files in the browser (#13).** `JazminBrowser.createWriter(options)`
  and `JazminBrowser.write(rows, options)` write files with one key, a
  password or no key, and return a `Blob` (USER-GUIDE §24.3). They're made for
  sending records back: records captured on a phone and sent to the owner
  later.
  - **What it uses:** only the browser's own encryption, randomness and
    compression, and no other code.
  - **The same file as the library:** given the same rows, options and random
    bytes, it writes exactly the library's bytes. Tests check this with and
    without a key or password, and with and without compression.
  - **Embedded files:** `writer.addFile({ path, content })` or the `files`
    option, with a `File`, `Blob`, bytes or text. Several files per record,
    and identical content stored once.
  - **Read by both libraries:** the new fixtures `browser-plain.jzm`,
    `browser-key.jzm`, `browser-password.jzm` and `browser-files-key.jzm` are
    read in the Node and .NET interop tests. The viewer CI jobs write a file
    with two attachments in each browser, which the library then reads.
  - **Refused:** shared files (their master key stays off web pages),
    indexes, several tables, viewer package settings, `sortedBy` and Brotli.
- **Which columns each column group holds: `access.groupColumns`** (owner
  only; .NET `Access.GroupColumns`). The filing service uses it to keep the
  columns a sender can't see when they change a record.
- **When a file was written: `reader.writtenAt`** (.NET `WrittenAt`, and in
  the browser reader). It is the last append or, without one, when the file
  was written, by the writer's clock. The filing service uses it to refuse
  batches written after a key expired.
- **Submission keys (#13, spec 7.8).** A person sends records back to the
  owner in a small file locked with their submission key.
  - **Where the key comes from:** the writer seals it into that person's key
    slot of the shared file. So a file locked with it shows the sender opened
    the shared file with their access key; a leaked access key alone isn't
    enough. The owner derives the same key.
  - **JavaScript:** `reader.submissionKey`, `ownerKey.submissionKey(keyId)`,
    and `accessKeyOf(path, ownerKey, keyId)` to check a sender's grant.
  - **.NET:** `reader.SubmissionKey`, `ownerKey.SubmissionKey(keyId)` and
    `JazminFile.AccessKeyOf`.
  - **Browser:** `reader.submissionKey`, as key text.
  - **Older shared files** get the key at the owner's next rewrite. Readers
    that don't know the new key-slot field ignore it.
- **`columnArrays()` for charts (#19),** in the library and the browser
  reader (USER-GUIDE §9.11).
  - **What it returns:** column values as arrays instead of an object per
    row: numbers and dates in a `Float64Array`, bools in a `Uint8Array`,
    other types in plain arrays. A null bitmap covers the typed arrays.
  - **Measured:** 200,000 rows of a date and an amount keep 3.3 MB instead
    of 30.7 MB (Node), and 3.8 MB instead of 34.8 MB (browser reader), in the
    same time.
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
- **The viewer is tested in the iPhone simulator, on demand (#9).**
  `npm run test:viewer -- --browser ios` drives Safari in the iOS simulator.
  A CI workflow runs it only when asked: from the Actions tab, with
  `gh workflow run`, or with the `ios-simulator` label on a pull request.
  All 12 checks pass on iOS 18.7.
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

### Deprecated
Both are removed in 2.0 (docs/SECURITY-REVIEW.md, D1 and D2); they still work
in 1.x.
- **Getting a key's secret text with `toString()` (JS and .NET).** Use the
  new **`export()`** (.NET `Export()`) on `JazminKey` and `JazminAccessKey`.
  - **Why:** a key put into a log line or an error message prints its full
    secret.
  - **From 2.0:** `toString()` won't print the secret; an access key prints
    only its id. Code that saves or sends keys with `toString()` would then
    store the id instead, so switch to `export()` now.
  - **Warnings:** JS editors strike through `key.toString()` (TypeScript
    typings). .NET can't flag it: `ToString()` overrides `object.ToString`.
- **The reader's clock option: JS `now`, .NET `JazminReadOptions.Now`.**
  - **Why:** setting it back lets an expired key open the file.
  - **From 2.0:** expiry is checked against the system clock only.
  - **Warnings:** .NET reports `CS0618` (obsolete) where it's used; JS
    editors strike it through.

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
