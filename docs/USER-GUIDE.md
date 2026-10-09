# JAZMIN User Guide

**JAZMIN** (Javascript Secure Zipped Multi Index Notation) is a file format and
library for storing lists of records, the kind of data you would normally put
in a JSON array, a CSV file or a database export. A JAZMIN file is:

- **Small:** compressed, with column names stored once. Typically about 9×
  smaller than the same data as JSON.
- **Fast to search:** built-in indexes find matching records without loading
  the whole file.
- **Optionally encrypted:** every part is protected with AES-256 under one key
  or password.
- **Convertible:** it turns into JSON, CSV or XML and back, with one call.

Libraries are available for **JavaScript/TypeScript (Node.js)** and **.NET**.
They read and write exactly the same files.

> Every example in this guide is taken from code that runs:
> [js/examples/quickstart.mjs](../js/examples/quickstart.mjs),
> [js/examples/typescript/quickstart.ts](../js/examples/typescript/quickstart.ts) and
> [dotnet/samples/Jazmin.Samples/Program.cs](../dotnet/samples/Jazmin.Samples/Program.cs).

## Contents

1. [When to use JAZMIN (and when not to)](#1-when-to-use-jazmin-and-when-not-to)
2. [Installation](#2-installation)
3. [Core concepts](#3-core-concepts)
4. [JavaScript guide](#4-javascript-guide)
5. [TypeScript guide](#5-typescript-guide)
6. [.NET guide](#6-net-guide)
7. [Migrating from Newtonsoft.Json](#7-migrating-from-newtonsoftjson)
8. [Querying: filters, GraphQL and LINQ](#8-querying-filters-graphql-and-linq)
9. [Performance and benchmarks](#9-performance-and-benchmarks)
10. [Security guide](#10-security-guide)
11. [Converting to and from JSON, CSV and XML](#11-converting-to-and-from-json-csv-and-xml)
12. [Errors and troubleshooting](#12-errors-and-troubleshooting)
13. [Limits](#13-limits)
14. [Recipe: one large file, processed section by section](#14-recipe-one-large-file-processed-section-by-section)
15. [Access control: one file, many keys](#15-access-control-one-file-many-keys)
16. [Updating files](#16-updating-files)
17. [Appending: fast, frequent changes](#17-appending-fast-frequent-changes)
18. [Time-limited access](#18-time-limited-access)
19. [Embedded files](#19-embedded-files)
20. [Speed and memory: practical recipes](#20-speed-and-memory-practical-recipes)
21. [Export shapes: nested JSON and XML](#21-export-shapes-nested-json-and-xml)
22. [Async: servers and streaming sources](#22-async-servers-and-streaming-sources)
23. [Several tables in one file](#23-several-tables-in-one-file)
24. [The viewer: open .jzm files in a browser](#24-the-viewer-open-jzm-files-in-a-browser)
25. [The command-line tool](#25-the-command-line-tool)

---

## 1. When to use JAZMIN (and when not to)

**Use JAZMIN for:**

- large data exports, archives, caches and data handed between systems;
- **one large file processed a section at a time**, for example one PDF per client statement (see [section 14](#14-recipe-one-large-file-processed-section-by-section));
- files where you need one record, or a filtered subset, without loading everything;
- data that must be encrypted at rest;
- **one file shared by many people who may each see only part of it** (see [section 15](#15-access-control-one-file-many-keys));
- replacing a "JSON file + gzip + separate encryption step" pipeline with one format.

**Keep using JSON for:**

- small API request/response bodies that browsers or third parties read directly;
- configuration files and anything people edit by hand;
- payloads of a few hundred bytes (JAZMIN adds about 300 bytes of fixed overhead).

**Consider Parquet for** analytics that aggregate whole columns across billions
of rows.

## 2. Installation

**JavaScript / TypeScript** (Node.js 22 or later, no runtime dependencies):

```bash
npm install @smithsoft-studios/jazmin
```

```js
import { open, write } from '@smithsoft-studios/jazmin';
```

**.NET** (.NET 10, no third-party dependencies):

```bash
dotnet add package Jazmin
```

To use the code in this repository instead, run `npm install ../path/to/JSZMIN/js`,
or add `<ProjectReference Include="..\path\to\JSZMIN\dotnet\src\Jazmin\Jazmin.csproj" />`.

## 3. Core concepts

### 3.1 What is inside a file

```
Catalog ─┬─ header         : the table and its columns (name, type, nullable, description, attributes)
         ├─ metadata       : your own key/value information (source, owner, export date...)
         ├─ directories    : where each chunk is, with min/max statistics per column
         ├─ indexes        : sorted and trigram indexes for fast lookups
         └─ keyring        : extra secrets for unlocking sections (encrypted files only)
Data    ─── chunks of rows : stored column by column, typed, binary and compressed
```

The data is split into **chunks**, 4,096 rows each by default. Each chunk is
compressed, and optionally encrypted, separately. To read row 765,432 the
library opens only the chunk that contains it. Inside a chunk each column is
stored on its own, so a query decodes only the columns it uses. With a
filter, it decodes the filter's columns first. It decodes the columns it
returns only for chunks with matching rows, and makes their text, decimal,
json and binary values only for the matching rows.

The catalog is physically stored at the *end* of the file, so writers can
stream millions of rows without holding them in memory. It uses the Protocol
Buffers format ([`spec/jazmin.proto`](../spec/jazmin.proto)), so standard tools
can read a decrypted header.

### 3.2 Column types

| JAZMIN type | JavaScript value | .NET value | Notes |
|---|---|---|---|
| `bool` | `boolean` | `bool` | |
| `int` | `number` (or `bigint` beyond ±2^53) | `long` | 64-bit signed |
| `float` | `number` | `double` | 64-bit IEEE 754 |
| `decimal` | `string` such as `"1520.75"` | `string` in rows; `decimal` on your classes | Exact; never rounded. Compared by value: `12.5` equals `12.50` |
| `string` | `string` | `string` | UTF-8 |
| `datetime` | `Date` | `DateTime` (UTC) | Millisecond precision |
| `binary` | `Buffer` | `byte[]` | |
| `json` | any JSON value | `JsonNode` | For nested objects and arrays |
| `list` | array of its items | `List<T>`, `T[]` | Items of one type, stored as columns (nested columns: 4.2, 6.2). Needs JAZMIN 1.4 to read |
| `object` | object with every field | your classes | Named fields, each stored as a column (4.2, 6.2). Needs JAZMIN 1.4 to read |

Every column has a name, a type, `nullable` (default true), and an optional
`description` and `attributes` (a free-form object, for example
`{ "unit": "kPa" }`).

### 3.3 Indexes

| Index | Speeds up | Allowed on |
|---|---|---|
| `sorted` | `eq`, `in`, `gt`, `gte`, `lt`, `lte`, `startsWith`, `isNull` | bool, int, float, decimal, string, datetime |
| `trigram` | `contains`, `icontains` | string |

Indexes make the file somewhat larger (about 20–30% for three indexed
columns) and writing slower. Add them only to columns you search on.
Without indexes, the library still skips chunks whose min/max statistics
rule them out, for the fields inside nested columns too (8.1).

A `sorted` index is stored in pages of about 64 KiB. For a column with
millions of different account numbers, a lookup reads a small directory and
one page, rather than the whole index. A small index is a single page.

A `sorted` index on the first `sortedBy` column is not written: chunk
statistics already find its values.

**Compact indexes** (`compactIndexes: true`, .NET `CompactIndexes = true`)
store each key as its difference from the previous one (text: only the part
after what it shares with the previous key). Indexes on whole numbers and
dates become much smaller, and lookups are as fast or faster: there is less
to read and decompress.

```js
write('accounts.jzm', rows, { columns, compactIndexes: true });
update('accounts.jzm', { compactIndexes: false }); // back to what every reader reads
```

```csharp
using var writer = JazminWriter.Create(path, columns, new JazminWriteOptions { CompactIndexes = true });
JazminFile.Update(path, new JazminUpdate { CompactIndexes = false });
```

- **Who can read them:** JAZMIN 1.2 and later, in Node, .NET and the
  browser. Readers before 1.2 refuse such a file with a clear message that
  names the feature (`index-deltas`). Use them once every reader of your
  files is on 1.2.
- **Default:** off until 2.0, so new files stay readable by 1.0 and 1.1.
- **Appends** keep the file's choice; `update()` and `compact()` keep it
  unless you pass the option.
- **Measured** on 200,000 rows with indexes on an id, a code and a date: the
  file is 1.8 MB instead of 4.5 MB, and lookups took 5–16% less time. On the
  proposals benchmark (200,000 transactions, sorted by time) the indexes
  are 2.4 MB instead of 3.4 MB: a unique random reference code can't be
  stored in less space.

### 3.4 Encryption in one paragraph

You supply either a **key** or a **password**:

- **Key:** 32 random bytes, written as text like `jzk1-oBn_xyc...`. The
  text includes a checksum, so a mistyped key is reported as a typo rather
  than as wrong data.
- **Password:** turned into a key with PBKDF2, a deliberately slow
  password-to-key function.

The key unlocks the header. The header holds extra secrets which, *combined
with your key*, unlock each chunk and index with its own unique key.
Everything is authenticated, so any tampering is detected.

---

## 4. JavaScript guide

```js
import { JAZMIN, JazminKey, JazminWriter, open, write, toJSON, toCSV, exportFile, fromCSV } from '@smithsoft-studios/jazmin';
```

### 4.1 The JSON-like one-liners

```js
const bytes = JAZMIN.stringify([{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }]); // Buffer
const rows  = JAZMIN.parse(bytes);                                                 // [{ id: 1, name: 'Ann' }, ...]
```

The schema is inferred from the data:

- whole numbers become `int` and other numbers `float`;
- objects and arrays become `json`;
- a column becomes nullable if any row leaves it out.

### 4.2 Writing with a schema, indexes, metadata and encryption

```js
const key = JazminKey.generate();          // store key.export() in your secret manager

write('customers.jzm', customers, {
  columns: [
    { name: 'id',      type: 'int',      nullable: false, index: 'sorted', description: 'Customer number' },
    { name: 'name',    type: 'string',   index: ['sorted', 'trigram'] },
    { name: 'country', type: 'string',   index: 'sorted' },
    { name: 'balance', type: 'decimal' },
    { name: 'joined',  type: 'datetime' },
  ],
  metadata: { source: 'crm', exportedBy: 'nightly-job' },
  key,                                     // or: password: '...'
  codec: 'brotli',                         // 'deflate' (default), 'brotli' (smaller), 'none'
});
```

Pass `null` instead of a path to get a `Buffer` back. Rows are validated:

- a wrong type, a misspelt column name, or `null` in a non-nullable column
  throws a `JazminValidationError` that names the row and column;
- when writing to a path, a failed `write()` deletes the half-written file.

**Nested columns (opt-in).** A `list` column holds arrays of items of one
type (its `item`); an `object` column holds objects with named `fields`. Each
field is stored as a column is, instead of as JSON text: numbers as numbers,
and repeated text once per chunk. Lists and objects can hold each other, up
to 64 levels deep.

```js
write('companies.jzm', companies, {
  columns: [
    { name: 'id', type: 'int', nullable: false },
    {
      name: 'departments', type: 'list', item: {
        type: 'object', fields: [
          { name: 'name', type: 'string' },
          { name: 'budget', type: 'decimal' },
          { name: 'staff', type: 'list', item: { type: 'string', nullable: false } },
        ],
      },
    },
  ],
});
[...open('companies.jzm').find({ id: 1 })][0].departments;
// [{ name: 'Sales', budget: '1200.50', staff: ['Ann', 'Ben'] }, ...]
```

Measured on 5,000 companies, each with departments, employees and projects
(Node.js 24; peak memory of each step in its own process):

| | JSON columns | Nested columns |
|---|---|---|
| File size | 4.32 MB | 2.64 MB |
| Write | 1,327 ms | 604 ms |
| Read every company | 385 ms, 584 MB peak | 227 ms, 504 MB peak |
| A report over 6 nested fields | 495 ms | 345 ms |
| Open the file and read one company | 0.84 ms, 88 MB peak | 0.97 ms, 76 MB peak |

Good to know:

- **Values read back in the forms of their types:** `Date` for datetimes,
  `Buffer` for binary, text for decimals, `bigint` beyond ±2^53, and every
  field present (`null` when it was missing). JSON, CSV and XML output write
  them as JSON.
- **JSON from elsewhere can be written as it is:** fields also take ISO date
  text, decimals as numbers, binary as base64 text, and `"NaN"` /
  `"Infinity"` for floats.
- **A bad value refuses its row whole,** wherever it is, and the error names
  where: `Column 'departments[].budget': ...`. The rows before and after
  are written.
- **Objects can gain fields.** `append()` and `update()` take the grown
  definitions in `columns`, with new fields at the end of their objects
  (fields that may be null); rows written before read them as `null`:

  ```js
  append('companies.jzm', { insert: newRows, columns: [departmentsWithHeadcount] });
  ```

  Removing, renaming or retyping a field needs the file written again.
- Nested columns can't be indexed or sorted by. Filters check them with
  `any`, `all` and `match` (8.1).
- The browser reader and writer (section 24) and the viewer read and write
  them too. Files with nested columns need JAZMIN 1.4 or later; earlier
  versions refuse them, never misread them.

### 4.3 Reading and querying

```js
const reader = open('customers.jzm', { key: key.export() });   // reads only the header

reader.columns;     // [{ name: 'id', type: 'int', nullable: false, description: 'Customer number' }, ...]
reader.metadata;    // { source: 'crm', exportedBy: 'nightly-job' }
reader.rowCount;    // 3

for (const row of reader.find({ country: 'ZA', name: { icontains: 'ndlovu' } })) {
  console.log(row);  // { id: 3, name: 'Thabo Ndlovu', country: 'ZA', balance: '0.00', joined: 2025-06-07T00:00:00.000Z }
}

reader.get(1);                                      // row by position (many? sort them first: section 9.9)
reader.count({ country: 'ZA' });                    // 2 (reads as little as it can: section 9.10)
reader.columnArrays(null, { select: ['balance'] });  // { rowCount, values: { balance: Float64Array }, nulls } (section 9.11)
reader.explain({ id: 3 });                          // { strategy: 'index', candidateRows: 1 }
reader.explain({ id: 3 }, { analyze: true });       // ... plus rows, bytesRead, chunksRead, ... (section 9.6)
[...reader.rows({ offset: 1, limit: 1 })];          // paging
[...reader.find({ id: { gte: 2 } }, { select: ['id', 'name'] })];  // projection
reader.close();
```

`find()` and `rows()` are **generators**: rows are produced one at a time and
only one chunk is held in memory. Use `for...of` to stream, or `[...]` to
collect.

### 4.4 Streaming very large data

```js
const writer = new JazminWriter('big.jzm', {
  columns: [{ name: 'id', type: 'int', nullable: false, index: 'sorted' }, { name: 'reading', type: 'float' }],
  codec: 'brotli',
});
for (let i = 0; i < 1_000_000; i++) writer.writeRow({ id: i, reading: Math.sin(i / 1000) });
writer.finish();   // writes indexes, header and trailer - required

const r = open('big.jzm');
[...r.find({ id: 765432 })];  // reads one chunk, not one million rows
```

Memory while writing is one chunk plus the index lists.

### 4.5 Converting

```js
toJSON(reader, { pretty: true, omitNulls: true, filter: { country: 'ZA' }, select: ['id', 'name'] });
toCSV(reader);
toXML(reader);
exportFile(reader, 'csv', 'customers.csv');          // streams to disk

fromJSON(jsonText, 'customers.jzm', { indexes: { id: 'sorted' } });
fromCSV(csvText, 'customers.jzm', { inferTypes: true });
fromXML(xmlText, null);                              // -> Buffer
```

### 4.6 Errors

All errors extend `JazminError`:

| Error | Meaning |
|---|---|
| `JazminValidationError` | Bad data, schema, filter or options passed in by your code |
| `JazminKeyError` | Missing, mistyped or wrong key/password, or tampered encrypted data |
| `JazminFormatError` | Not a JAZMIN file, truncated, corrupted, or an unsupported version |

---

## 5. TypeScript guide

The package ships type definitions (`src/index.d.ts`), so no `@types`
package is needed.

```ts
import { JAZMIN, JazminKey, JazminKeyError, open, write, toCSV, type Filter, type JazminColumnInput } from '@smithsoft-studios/jazmin';

interface Customer { id: number; name: string; country: string | null; joined: Date; }

const columns: JazminColumnInput[] = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted', description: 'Customer number' },
  { name: 'name', type: 'string', index: ['sorted', 'trigram'] },
  { name: 'country', type: 'string', index: 'sorted' },
  { name: 'joined', type: 'datetime' },
];

const key = JazminKey.generate();
write('customers.jzm', customers as unknown as Record<string, unknown>[], { columns, key });

const reader = open('customers.jzm', { key: key.export() });
const where: Filter = { country: 'ZA', name: { icontains: 'john' } };   // type-checked filter
for (const row of reader.find(where, { select: ['id', 'name'] })) {
  const id = row.id as number;     // rows are Record<string, JazminValue>
}

try {
  open('customers.jzm', { key: JazminKey.generate() });
} catch (e) {
  if (e instanceof JazminKeyError) console.log('wrong key rejected');
}
```

To get typed rows, wrap the reader once:

```ts
function* typed<T>(rows: Iterable<Record<string, unknown>>): Generator<T> {
  for (const row of rows) yield row as T;
}
for (const c of typed<Customer>(reader.find({ country: 'ZA' }))) console.log(c.name);
```

---

## 6. .NET guide

```csharp
using Jazmin;
using Jazmin.Query;
using Jazmin.Serialization;
```

### 6.1 One-liners (the Newtonsoft way)

```csharp
byte[] bytes = JazminConvert.SerializeObject(customers);
List<Customer> back = JazminConvert.DeserializeObject<List<Customer>>(bytes)!;
Customer first     = JazminConvert.DeserializeObject<Customer>(bytes)!;      // first row
Customer[] array   = JazminConvert.DeserializeObject<Customer[]>(bytes)!;
List<JazminRow> raw = JazminConvert.DeserializeObject(bytes);               // untyped
```

These also work:

- serializing a `List<Dictionary<string, object?>>`;
- deserializing to `Dictionary<string, object?>`, `JsonObject` or `JazminRow`;
- records and immutable classes, which are matched through their constructor.

### 6.2 Shaping the schema with attributes

```csharp
public class Customer
{
    [JazminIndex]                                                     // sorted index
    public int Id { get; set; }

    [JazminIndex(JazminIndexKind.Sorted, JazminIndexKind.Trigram)]
    [Description("Full name")]                                        // System.ComponentModel
    public string Name { get; set; } = "";

    [JazminProperty("country_code", Description = "ISO 3166 alpha-2")]
    public string? Country { get; set; }

    public Tier Tier { get; set; }            // enums are stored as their names
    public decimal Balance { get; set; }      // exact
    public DateTime Joined { get; set; }
    public List<string> Tags { get; set; } = new();   // stored in a json column

    [JazminIgnore]                            // or System.Text.Json [JsonIgnore]
    public string? PasswordHash { get; set; }
}
```

How .NET property types map to columns:

| .NET property type | Column type |
|---|---|
| `bool` | `bool` |
| integer types | `int` |
| `float`, `double` | `float` |
| `decimal` | `decimal` |
| `string`, `char`, `Guid`, `TimeSpan`, `TimeOnly`, enums | `string` |
| `DateTime`, `DateTimeOffset`, `DateOnly` | `datetime` |
| `byte[]` | `binary` |
| anything else (lists, nested classes) | `json`, or `list` / `object` with nested columns (below) |

A `json` column is read straight from its stored UTF-8 into your property's
type, with no text or `JsonNode` in between. An untyped row gives a
`JsonNode`, made when you first read the value. On 200,000 orders whose
customer and items are `json` columns, a LINQ report takes 3.1 s and
allocates 965 MB (6.8 s and 1.6 GB in 1.2). Reading the same data from one
JSON file with System.Text.Json takes 4.4 s, or 2.8 s streamed.

`[JsonPropertyName]` from System.Text.Json is honoured too. Column names are
matched case-insensitively when reading, as Newtonsoft does.

**Nested columns (opt-in).** With `NestedColumns = true`, lists, arrays and
classes are stored as columns of their own fields (`list` and `object`
columns) instead of JSON text. Each field is then stored as a column is:
numbers as numbers, and repeated text once per chunk. Reading builds your
objects straight from the stored values, with no JSON in between.
`[JazminNested]` turns this on for one property, and `[JazminNested(false)]`
keeps a property as JSON when the setting is on.

```csharp
var settings = new JazminSerializerSettings { NestedColumns = true };
File.WriteAllBytes("companies.jzm", JazminConvert.SerializeObject(companies, settings));

// Reading needs no settings: the file says how each column is stored.
var back = JazminConvert.DeserializeObject<List<Company>>(File.ReadAllBytes("companies.jzm"));
```

Measured on 5,000 companies, each with departments, employees and projects
(.NET 10, medians of three runs):

| | JSON columns | Nested columns |
|---|---|---|
| File size | 4.03 MB | 2.48 MB |
| Write | 685 ms, 413 MB allocated | 330 ms, 91 MB |
| Read every company | 1,615 ms, 345 MB | 435 ms, 145 MB |
| LINQ report over 6 nested fields | 960 ms, 390 MB | 466 ms, 195 MB |
| Open the file and read one company | 0.58 ms, 238 KB | 0.65 ms, 207 KB |

Good to know:

- **Files with nested columns need JAZMIN 1.4 or later to read.** Earlier
  versions refuse them with an "unknown type" error; they never misread
  them. JavaScript, the browser and the viewer read and write them too
  (4.2). Files without nested columns are unchanged.
- **What can be nested:** arrays, `List<T>` and the interfaces a `List<T>`
  fits (`IList<T>`, `IReadOnlyList<T>`, `IEnumerable<T>` and so on), and
  classes with public properties, up to 64 levels deep. **What stays JSON:**
  other collections such as `HashSet<T>`, dictionaries, `object`, `JsonNode`
  and `JsonElement`, polymorphic types (`[JsonDerivedType]`), and a class
  inside itself, such as an `Employee` property of `Employee`.
  `[JazminNested]` on such a property is an error.
- **Dates inside nested columns are stored as `datetime` columns are:** UTC,
  to the millisecond. JSON output writes them as it writes `datetime`
  columns (`2026-01-02T00:00:00.000Z`).
- **Very small files can be slightly larger,** because each field has a few
  bytes of its own. Sample 17 stores 500 companies in 13.5 KB instead of
  33.5 KB.
- Nested columns and their fields can't be indexed or sorted by. Filters
  check them with `any`, `all` and `match` (8.1), and LINQ conditions on
  them become those filters (8.3).
- **A bad value refuses its row whole,** wherever it is (the error names it,
  as in `Column 'Departments[].Budget'`); the writer goes on with the next
  row, as with any other bad value.
- **Classes can gain members.** `JazminFile.Append` and `JazminFile.Update`
  add the new members of your nested objects as fields at the end; rows
  written before read them as `null` (or the member's default). For rows
  given as JSON, pass the grown definitions in `JazminAppend.Columns`.
  Removing, renaming or retyping a field needs the file written again. A
  member the file has no field for is never left out silently: writing it
  any other way is an error that names it.
- **LINQ reads only the nested fields a query uses,** at any depth (8.3):
  the report above reads 6 of 23 fields, and the others are passed over
  (384 -> 312 ms, 195 -> 130 MB allocated). Objects the query returns
  whole, passes to a method, compares or groups by are read whole.

### 6.3 Settings

```csharp
var settings = new JazminSerializerSettings
{
    Key = JazminKey.Parse(Environment.GetEnvironmentVariable("JAZMIN_KEY")!), // or Password = "..."
    Codec = JazminCodec.Brotli,
    ChunkRows = 4096,
    Metadata = new JsonObject { ["source"] = "crm" },
    Indexes = new() { ["Country"] = new[] { JazminIndexKind.Sorted } },   // extra indexes without attributes
    Formatting = Formatting.Indented,                    // JSON output
    NullValueHandling = NullValueHandling.Ignore,        // JSON output
    NamingStrategy = JazminNamingStrategy.CamelCase,     // FirstName -> firstName (also SnakeCase, KebabCase)
    Converters = [new MoneyConverter()],                 // your own types (below)
    DefaultValueHandling = DefaultValueHandling.IgnoreAndPopulate, // defaults stored as null, filled in again on reading
    PreserveReferencesHandling = PreserveReferencesHandling.Objects, // a repeated object is stored once ($id / $ref)
    NestedColumns = true,                                // lists and classes as columns of their fields (6.2)
};
new JazminSerializer(settings).Serialize("customers.jzm", customers);
```

Settings that change how types map to columns (naming, converters, default
values, references) are cached per settings instance. Create the settings
once and reuse them, as with Newtonsoft's settings.

**Custom converters** store a type of your own in a column (counterpart of
Newtonsoft's `JsonConverter`). Register them in `Converters`, or put
`[JazminConverter(typeof(...))]` on a property or on the type itself.

```csharp
public readonly record struct Money(long Cents, string Currency);

public sealed class MoneyConverter : JazminConverter<Money>
{
    public override JazminType ColumnType => JazminType.String;                 // how the column stores it
    public override object? Write(Money value) => $"{value.Cents} {value.Currency}";
    public override Money Read(object stored)
    {
        var parts = ((string)stored).Split(' ');
        return new Money(long.Parse(parts[0]), parts[1]);
    }
}
```

Filters and LINQ predicates on a converted property run in memory after
reading, because the file stores the converted form.

**Polymorphic types** are opt-in, with a closed list of types: list the
derived types on the base type with System.Text.Json's `[JsonDerivedType]`.
Each row records its type in a `$type` column (rename it with
`[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]`).

```csharp
[JsonDerivedType(typeof(Dog), "dog")]
[JsonDerivedType(typeof(Cat), "cat")]
public abstract class Animal { public string Name { get; set; } = ""; }

var animals = JazminConvert.DeserializeObject<List<Animal>>(bytes);  // Dog and Cat instances
```

Newtonsoft's `TypeNameHandling` writes .NET type names into the data and
loads whatever type the data names, which has been a source of serious
security bugs. JAZMIN only creates the types listed on the base type, and
refuses any other name.

### 6.4 Reading, LINQ and filters

```csharp
using var reader = JazminReader.Open("customers.jzm", new JazminReadOptions { Key = key });

// LINQ: translated to index lookups where possible, then checked exactly.
foreach (var c in reader.Query<Customer>(c => c.Country == "ZA" && c.Balance > 100m))
    Console.WriteLine(c.Name);

// Ordinary LINQ operators work on the streamed result.
var top = reader.Query<Customer>(c => c.Tier == Tier.Gold).OrderByDescending(c => c.Balance).Take(10).ToList();

// Or the whole query in the reader (section 8.3): the condition, Skip/Take and the count read only what they need.
var customers = reader.AsQueryable<Customer>();
var page = customers.Where(c => c.Country == "ZA").Skip(20).Take(10).ToList();
int gold = customers.Count(c => c.Tier == Tier.Gold);
var names = customers.Where(c => c.Balance > 100m).Select(c => new { c.Id, c.Name }).ToList(); // reads 3 columns

// Untyped rows with the filter builder ...
foreach (JazminRow row in reader.Find(JazminFilter.Eq("Country", "ZA") & JazminFilter.IContains("Name", "ndlovu")))
    Console.WriteLine($"{row.RowId}: {row["Name"]}");

// ... or the JSON filter language (identical to JavaScript and GraphQL "where").
reader.Find("""{ "Name": { "icontains": "ndlovu" } }""");

reader.Get(42);                                    // by row position
reader.Count(JazminFilter.Eq("Country", "ZA"));
reader.Explain(JazminFilter.Eq("Id", 3));          // JazminPlan { Strategy = index, CandidateRows = 1, ... }
reader.Explain(JazminFilter.Eq("Id", 3), analyze: true).Cost;   // rows, bytes read, ... (section 9.6)
reader.Rows(new JazminQueryOptions { Select = new[] { "Id", "Name" }, Offset = 100, Limit = 50 });   // paging + projection
```

### 6.5 Streaming writer and reader

```csharp
var columns = new[]
{
    new JazminColumn("id", JazminType.Int) { Nullable = false, Indexes = new[] { JazminIndexKind.Sorted } },
    new JazminColumn("reading", JazminType.Float) { Description = "Sensor reading", Attributes = new JsonObject { ["unit"] = "kPa" } },
};
using (var writer = JazminWriter.Create("big.jzm", columns, new JazminWriteOptions { Codec = JazminCodec.Brotli }))
{
    for (long i = 0; i < 1_000_000; i++) writer.WriteValues(i, Math.Sin(i / 1000.0));   // fastest
    // or writer.WriteRow(new Dictionary<string, object?> { ["id"] = i, ["reading"] = 0.5 });
}   // Dispose finishes the file (unless a row failed validation)

using var stream = File.OpenRead("customers.jzm");
foreach (var item in new JazminSerializer().DeserializeEnumerable<Customer>(stream))   // one row at a time
    Console.WriteLine(item.Name);
```

`JazminReader` and `JazminWriter` are not thread-safe. Use one reader per
thread; opening a reader is cheap.

---

## 7. Migrating from Newtonsoft.Json

| Newtonsoft.Json | JAZMIN | Notes |
|---|---|---|
| `JsonConvert.SerializeObject(list)` | `JazminConvert.SerializeObject(list)` | Returns `byte[]` (binary), not `string` |
| `JsonConvert.DeserializeObject<List<T>>(json)` | `JazminConvert.DeserializeObject<List<T>>(bytes)` | |
| `JsonConvert.DeserializeObject<T>(json)` | `JazminConvert.DeserializeObject<T>(bytes)` | First row |
| `JsonSerializer.Serialize(writer, value)` | `new JazminSerializer(settings).Serialize(stream, value)` | |
| `JsonSerializer.Deserialize<T>(reader)` | `serializer.Deserialize<T>(stream)` / `DeserializeEnumerable<T>(stream)` | Streaming |
| `JsonSerializerSettings` | `JazminSerializerSettings` | Plus key/password, codec, indexes, metadata |
| `Formatting.Indented` | `Formatting.Indented` | Applies to JSON output |
| `NullValueHandling.Ignore` | `NullValueHandling.Ignore` | Applies to JSON output |
| `[JsonProperty("name")]` | `[JazminProperty("name")]` | `[JsonPropertyName]` also works |
| `[JsonIgnore]` (Newtonsoft) | `[JazminIgnore]` | System.Text.Json `[JsonIgnore]` also works |
| reading a JSON file | `JazminConvert.FromJson(json)` once, then query the `.jzm` | |
| producing JSON for an API | `JazminConvert.ToJson(bytes, settings, filter)` | Uses System.Text.Json internally |
| `JObject` / `JToken` LINQ-to-JSON | `JazminRow`, `JsonNode` | No JToken-style DOM editing (see TASKS.md) |
| `JsonConverter` custom converters | `JazminConverter<T>` in `settings.Converters` or `[JazminConverter]` | See §6.3 |
| `[JsonConverter(typeof(X))]` | `[JazminConverter(typeof(X))]` | On a property or a type |
| `CamelCasePropertyNamesContractResolver` / `NamingStrategy` | `NamingStrategy = JazminNamingStrategy.CamelCase` | Also `SnakeCase`, `KebabCase`; explicit names stay |
| `DefaultValueHandling` | `DefaultValueHandling` | Same values; `Ignore` stores defaults as null |
| `TypeNameHandling` | `[JsonDerivedType]` on the base type | Opt-in and closed: data cannot name a type to load |
| `PreserveReferencesHandling.Objects` | `PreserveReferencesHandling.Objects` | `$id` / `$ref`, as Newtonsoft writes them |

**Suggested approach:**

1. Keep JSON at your API edges.
2. Use JAZMIN for files, caches, exports and data you query.
3. Change one data flow at a time, and use `ToJson` and `FromJson` where
   the two formats meet.

---

## 8. Querying: filters, GraphQL and LINQ

### 8.1 Filter language reference

The same JSON shape works in JavaScript, in .NET (`reader.Find(json)`) and
as a GraphQL `where` argument:

```json
{
  "country": "ZA",                                   // shorthand for { "eq": "ZA" }
  "age": { "gte": 18, "lt": 65 },                    // several operators = AND
  "or":  [ { "name": { "icontains": "smith" } }, { "vip": true } ],
  "not": { "status": { "in": ["closed", "void"] } },
  "email": null                                      // shorthand for { "isNull": true }
}
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`,
`icontains`, `startsWith` and `isNull`.

As in SQL, comparisons with a null cell are false, so `ne` does **not**
match nulls. String operands are converted to the column's type, so
`{"id": {"eq": "42"}}` works for an `int` column.

An `in` list can be long: it is checked with a hash set, so counting the
matches of 20,000 values among 100,000 rows takes 18 ms in JavaScript and
36 ms in .NET (where LINQ's `ids.Contains(x.Id)` becomes `in` too).

**Nested columns** (lists and objects, 4.2 and 6.2) take three more
operators, each with a filter of their own:

```json
{
  "lines": { "any": { "sku": "A", "qty": { "gt": 5 } } },  // a line with sku A and more than 5 (the same line)
  "steps": { "all": { "done": true } },                     // every step done (an empty list: yes)
  "head":  { "match": { "city": "Durban" } },               // the object's fields
  "tags":  { "any": "vip" }                                 // items that are not objects: the item itself
}
```

They nest: `{ "departments": { "any": { "employees": { "any": { "role":
"Lead" } } } } }`. A null list or object matches nothing. In .NET,
`JazminFilter.Any`, `All` and `Match` build the same filters
(`JazminFilter.Itself` names the item of a list of plain values).

A nested column the filter checks but the rows don't return (a `select`
without it, or `count`) is decoded with only the fields the filter reads.
Files also keep min/max statistics of the fields inside nested columns, so
`any` and `match` skip the chunks where no item can match. On 5,000
companies in Node.js, the names of those with an employee of a given id take
4.4 ms and 61 MB instead of 186 ms and 197 MB: 35-40 ms come from reading
only the filter's fields, the rest from skipped chunks. Statistics help
when a field's values are grouped by chunk, as ids or dates that grow with
the rows are. Where they're spread over every chunk, and for `all` and
`not`, every chunk is read.

### 8.2 GraphQL

JAZMIN does not depend on a GraphQL server. Instead, its filter objects
*are* GraphQL `where` inputs, so a resolver passes them straight through.

```graphql
input StringFilter { eq: String ne: String in: [String!] contains: String icontains: String startsWith: String isNull: Boolean }
input IntFilter    { eq: Int ne: Int gt: Int gte: Int lt: Int lte: Int in: [Int!] isNull: Boolean }
input CustomerWhere { id: IntFilter name: StringFilter country: StringFilter and: [CustomerWhere!] or: [CustomerWhere!] not: CustomerWhere }

type Customer { id: Int! name: String country: String balance: Float }
type Query {
  customers(where: CustomerWhere, limit: Int = 50, offset: Int = 0): [Customer!]!
  customerCount(where: CustomerWhere): Int!
  customersAfter(after: Int = 0, first: Int = 50, where: CustomerWhere): [Customer!]!
}
```

```js
// Resolvers (any GraphQL server: Apollo, Yoga, graphql-js...)

// The columns a query asks for, so only those are decoded. With fragments
// (`...`), every column: their fields are not listed at this level.
function columnsOf(info, reader) {
  const selections = info.fieldNodes[0].selectionSet?.selections ?? [];
  if (selections.some((s) => s.kind !== 'Field')) return undefined;
  const asked = new Set(selections.map((s) => s.name.value));
  return reader.columns.map((c) => c.name).filter((name) => asked.has(name));
}

const resolvers = {
  Query: {
    customers: (_, { where, limit, offset }, context, info) =>
      [...reader.find(where ?? null, { select: columnsOf(info, reader), limit, offset })],
    customerCount: (_, { where }) => reader.count(where ?? undefined),
    // Pages after a known id: in a file sorted by id, the chunks before it are skipped.
    customersAfter: (_, { after, first, where }, context, info) =>
      [...reader.find({ and: [where ?? {}, { id: { gt: after } }] }, { select: columnsOf(info, reader), limit: first })],
  },
};
```

- **Only the fields asked for are decoded.** A query for `{ id name }` reads
  two columns, however wide the file (`select`, section 9.5). Aliases and
  `__typename` work as usual.
- **Totals:** `count()` answers from chunk statistics where it can, without
  reading rows (section 9.10).
- **Deep pages:** in a file written with `sortedBy: ['id']`, a page after id
  190,000 of 200,000 read 3 of its 49 chunks. Unlike `offset` with a filter,
  this stays fast however deep, and pages don't shift when rows are added.
- **Shared files:** open the file with the caller's access key, and each
  query sees only that person's rows and columns. Fields for columns they
  can't see come back `null`.
- **.NET** (HotChocolate, GraphQL.NET): serialize the `where` argument to
  JSON and call `reader.Find(json, new JazminQueryOptions { Select = fields,
  Limit = limit })`, with the requested field names as `fields`; totals come
  from `reader.Count(JazminFilter.Parse(json))`.

### 8.3 LINQ support (.NET)

`reader.Query<T>(predicate)` always returns exactly what the predicate
selects. The library translates as much of the predicate as it can into an
index-aware filter, then runs your compiled predicate on each candidate
row. Translation therefore affects only speed, never results.

| Expression | Uses index / statistics |
|---|---|
| `==`, `!=`, `<`, `<=`, `>`, `>=` against constants or captured variables (bool, numbers, strings, enums, dates) | ✔ |
| `&&`, `\|\|`, `!` (on comparisons and the calls below) | ✔ |
| `x.Name.Contains("a")`, `x.Name.StartsWith("a")` | ✔ |
| `list.Contains(x.Country)` | ✔ |
| `x.IsActive` (bool property) | ✔ |
| Nested columns (6.2): `x.Lines.Any(l => ...)`, `x.Lines.All(l => ...)`, `x.Tags.Contains("vip")`, `x.Ship.City == "Durban"` | ✔ (as `any`, `all`, `match`: 8.1) |
| `decimal` comparisons, method calls, arithmetic (`x.Id % 7 == 0`) | ✘ (scanned, still correct) |

#### Whole queries: `AsQueryable<T>()`

`reader.AsQueryable<T>()` gives an `IQueryable<T>`. Write the query with the
usual LINQ operators; the reader runs as much of it as it can, so less of
the file is read and fewer objects are built. Results are always the ones
LINQ gives over a list of the same objects.

```csharp
using var reader = JazminReader.Open("orders.jzm");   // sortedBy: ["Id"]
var orders = reader.AsQueryable<Order>();

var page = orders.Where(o => o.Region == "ZA").Skip(40).Take(20).ToList(); // filter, offset and limit in the reader
int za = orders.Count(o => o.Region == "ZA");                               // no objects built
bool any = orders.Any(o => o.Customer == "C-1042");                         // an index lookup, with an index on Customer
var first = orders.OrderBy(o => o.Id).Take(10).ToList();                    // stored in that order: reads 10 rows
var lines = orders.Where(o => o.Paid).Select(o => new { o.Id, o.Amount });  // reads 3 columns
decimal total = orders.Where(o => o.Region == "NA").Sum(o => o.Amount);     // reads 2 columns
```

| Operator | What the reader does |
|---|---|
| `Where`, and the condition of `Count`, `Any`, `First`, `Single`, `Last` | Becomes a filter, as in `Query<T>`: indexes and chunk statistics, and parts it can't translate checked on each object |
| `Skip`, `Take` | The filter's offset and limit: whole chunks before the offset are skipped unread (when nothing is checked on each object) |
| `Count`, `LongCount`, `Any` | Answered without building objects, from indexes or chunk statistics where the filter allows |
| `OrderBy` / `ThenBy` along the file's `sortedBy` columns | Nothing to do: rows are stored in that order. Needs ascending keys of non-nullable columns; numbers, dates and bools as they are, strings with `StringComparer.Ordinal` |
| `Select`; `Sum`, `Average`, `Min`, `Max` with a selector | Only the columns they use are read |
| Everything from the first operator it can't do (`OrderByDescending`, `GroupBy`, `Join`, a `Where` after `Take`...) | Runs in memory on the rows read, as LINQ to Objects. The rows are read with only the columns the whole query uses (below) |

- **Only the columns a query uses are read,** wherever it uses them: in
  `Where`, `Select`, `SelectMany`, `GroupBy`, `Join`, nested queries, and
  through anonymous objects and groups. A `Join` with another table, or
  with the same one, reads only the columns used of each. Every column is
  read when the rows themselves may be used in ways the query doesn't show:
  - you receive them, or `ToList()` them before the rest of the query;
  - they're passed to a method, or formatted;
  - they're compared or sorted whole (`Distinct()`, a `GroupBy` key of
    whole rows), or cast;
  - a computed property is used.

  On 200,000 orders of 10 members, grouping by region and summing amounts
  takes 0.25 s and 57 MB instead of 1.1 s and 261 MB. A collection member
  (`List<Department>`) is one JSON column, read whole when the query uses it;
  as a nested column (6.2), only the fields the query reads of it are
  decoded, by the same rules: objects returned whole, passed to a method,
  compared or grouped by are read whole, and a computed property reads all
  of its object's fields.
- **Conditions on nested columns are checked as chunks are decoded.**
  `o.Lines.Any(l => l.Sku == "A" && l.Qty > 5)` becomes an `any` filter
  (8.1), `o.Ship.City == "Durban"` a `match`, and `o.Tags.Contains("vip")`
  an `any` on the item. Only matching rows' objects are built, and the
  column is decoded with only the fields the condition and the query read.
  On 5,000 companies, the names of those with an employee of a given id take
  3 ms and 1 MB instead of 25 ms and 23 MB, and the companies with a lead
  among the first employees of their Build department, returned whole, 4 ms
  and 2 MB instead of 167 ms and 143 MB. Both find their values in a few
  chunks (8.1); with values spread over every chunk, reading only the
  condition's fields still takes them to 13 ms and 91 ms. Parts the filter can't hold
  (a `decimal` comparison, a method call) are checked on each object, as
  elsewhere. `l != null &&` before an item's conditions is fine: a null item
  matches no item's filter. Where LINQ to Objects would throw on a null list
  or object, the row simply doesn't match. No settings are needed: the file
  says which columns are nested.
- **Queries are compiled once per shape.** The parts of a query that run in
  memory (operators after the reader's part, and conditions it can't check)
  are compiled the first time a query of that shape runs, then reused with
  each call's values: a lookup in a loop, `q.Where(c => c.Id == id)
  .Select(c => c.Name)`, takes 0.34 ms instead of 1.05 ms. The same holds
  for `reader.Query<T>(predicate)`. Nothing to set up: there's no compiled
  query to declare.
- **Sub-queries of other tables inside a lambda are read once.** For
  example, `customers.Select(c => orders.Where(o => o.CustomerId == c.Id)...)`
  would otherwise run a query for every customer:
  - when the condition pairs a member with a value of the outer row
    (`o.CustomerId == c.Id`), the table is read once and kept by that member,
    so each customer's orders are a lookup;
  - other sub-queries run as LINQ to Objects over their rows, read once.

  The first few outer rows still run their own queries, which use indexes. A
  table is read once only when that costs less, so a query for one customer
  reads no whole table. Tables of more than 1,000,000 rows (100,000 with
  priority `Memory`, 10,000,000 with `Speed`) keep a query per row. Results
  are those of LINQ to Objects. On 5,000 customers and 50,000 orders, the
  latest 5 orders of each customer, with their product and payment, take
  0.43 s instead of 64 s. The same code over in-memory lists takes 2.1 s,
  because each customer scans every order.
- **Typed rows read only the columns their type maps,** here and in
  `Query<T>` / `Rows<T>`: a class of 9 properties over a 300-column file
  decodes 9 columns.
- **Files that preserve references** (`PreserveReferencesHandling.Objects`)
  run the whole query in memory, because their rows refer to earlier rows.
- **Like the reader,** a query is not thread-safe, and is read while the
  reader is open. For async code, use `QueryAsync<T>`.

Measured on .NET 10 (200,000 rows x 300 columns, a type mapping 9 of them;
`Query<T>` in 1.1.0 followed by LINQ to Objects, against `AsQueryable`):

| Query | 1.1.0 | `AsQueryable` |
|---|---:|---:|
| Every row as objects | 3.2-3.7 s | 0.30 s |
| A condition and two columns (`Where` + `Select`) | 3.6 s | 0.35-0.37 s |
| `Count(condition)` | 3.3-3.9 s, 63 MB | 0.25 s, 56 MB |
| `Skip(150_000).Take(10)` | 2.5-2.7 s, 63 MB | 0.05 s, 35 MB |
| `OrderBy(o => o.Id).Take(10)` (file sorted by id) | 3.5 s, 100 MB | 0.05 s, 35 MB |
| `Sum(o => o.Qty)` | 3.2-3.4 s | 0.25 s |
| `First(o => o.Id == 123_456)` | 0.08-0.09 s | 0.07 s |

---

## 9. Performance and benchmarks

The tables show measured results on 200,000 customer records with 8 fields,
run on an Intel i7-12700H laptop under Windows 11. Each figure is the best of
3 runs after a warm-up run, which is applied to every contender alike.

Re-run on your own data with `npm run bench` (in `js/`) or
`dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks` (in `dotnet/`).
`npm run bench:proposals` shows what typical statement queries read (bytes,
rows and time per query); docs/CONTRIBUTING.md explains it.
`npm run bench:filing` measures filing the records phones send back
(section 15.6); the results are in `js/examples/filing-service/README.md`.

### 9.1 .NET 10 (vs Newtonsoft.Json 13.0.3 and System.Text.Json)

| Measure | Newtonsoft | System.Text.Json | **JAZMIN** |
|---|---:|---:|---:|
| File size | 30,529 KB | not measured | **1,297 KB** (deflate) / **838 KB** (brotli) |
| File size, gzipped JSON for comparison | 3,324 KB | | |
| File size with 3 indexes + AES-256 encryption | | | 2,235 KB |
| Find one record by id (open file → result) | 265 ms | 104 ms | **1.4 ms** (1.3 ms encrypted) |
| Filter `Country == "NA" && Age > 80` | 276 ms | | **13 ms** |
| Memory allocated for one lookup | 196 MB | | **1.1 MB** |
| Deserialize every record | 211 ms | 91 ms | **32 ms** |
| Serialize every record | 103 ms | 57 ms | **42 ms** (94 ms with 3 indexes) |

### 9.2 Node.js 24 (vs native JSON)

| Measure | JSON | **JAZMIN** |
|---|---:|---:|
| File size | 31,307 KB (gzip: 3,338 KB) | **1,292 KB** (deflate) / **838 KB** (brotli) |
| Find one record by id | 109 ms | **1.7 ms** (1.7 ms encrypted) |
| Read every record | 109 ms | **45 ms** |
| Write every record | 277 ms | **169 ms** (309 ms with 3 indexes) |
| Broad filter matching 1 row in 8, spread through the file | 116 ms | **13 ms** |
| Text search (`contains`) | 112 ms | **21 ms** |
| Memory to answer a lookup (`--expose-gc`) | 42 MB | **under 0.1 MB** |

On Node 26 (same day), JAZMIN takes 1.8 ms per lookup and 58 ms to read every
record; `JSON.parse` is about 10% faster there than on Node 24.

Measured on 5 October 2026, and re-run for 1.1.0 on 6 October: every figure
within 10%. Since 1.0.0, query planning (sections 9.7 and 9.8)
took lookups from 2.7 to 1.7 ms in Node and from 3.7 to 1.9 ms in .NET, and
the filter from 56 to 13 ms and from 40 to 13 ms. In 1.2.0, .NET readers of
files with the same columns share their compiled row code, which took the .NET
lookup from about 2.0 to 1.4 ms (issue #70).

**Checked again for 1.2.0** on 7 October, against 1.1.0 side by side on the
same machine, runs alternating (the machine was busier than on 5 October, so
both took longer than the tables show): Node unchanged within noise; .NET
lookups 2.6-2.7 ms (1.1.0) against 1.9 ms (1.2.0), the filter 15-17 ms
against 12-14 ms, the rest unchanged; file sizes identical. The memory for one
.NET lookup is 1.1 MB in both.

### 9.3 What the numbers mean

- **Size:** about 24× smaller than JSON and 61% smaller than *gzipped* JSON
  with deflate. With Brotli, 75% smaller than gzipped JSON. These numbers come
  from regular benchmark data; expect less on very varied data.
- **Finding specific records:** 55–139× faster than parsing JSON in .NET, and
  about 64× in Node.
- **Reading a whole file:** faster than `JSON.parse` and System.Text.Json.
- **Writing:** without indexes, faster than `JSON.stringify` in Node and
  than both .NET serializers. Indexes are built as the file is written:
  - **.NET, with 3 indexes:** a little faster than Newtonsoft, and about
    1.6× System.Text.Json.
  - **Node, with 3 indexes:** about 1.1× `JSON.stringify`.

  JAZMIN also compresses as it writes; the JSON serializers do not.
- **Indexes** are now the largest part of an indexed file, and smaller
  indexes are on the roadmap.

### 9.4 Wide tables: 1,000,000 rows × 300 columns

A table nobody can hold in memory as JSON: 300 million values, written and
read as streams on both sides. Each test ran in its own process. JSON was
read with each platform's streaming parser.

Re-run with `node bench/wide.js [rows] [columns]` (in `js/`), or
`dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks -- wide [rows] [columns]` (in `dotnet/`).

| Measure | JSON (Node) | **JAZMIN (Node)** | JSON (.NET 10, System.Text.Json) | **JAZMIN (.NET 10)** |
|---|---:|---:|---:|---:|
| File size | 6,346 MB (gzip 1,393 MB) | **643 MB** | 6,212 MB | **649 MB** |
| Open the file | — | **0.01 s**, 63 MB | — | **0.03 s**, 34 MB |
| Look up one id | 52.0 s, 291 MB | **0.03 s**, 76 MB | 24.1 s, 47 MB | **0.08 s**, 45 MB |
| Sum 3 of the 300 columns | 70.6 s, 293 MB | **3.4 s**, 121 MB | 35.5 s, 47 MB | **1.1 s**, 67 MB |
| Filter on 2 columns | 75.4 s, 293 MB | **3.4 s**, 134 MB | 33.5 s, 49 MB | **1.2 s**, 67 MB |
| Read every row | 100.2 s, 292 MB | **15.9 s**, 204 MB (98 MB¹) | 38.2 s, 47 MB | **10.4 s**, 64 MB |
| Write | 81.8 s, 251 MB | **69 s**, 338 MB² | 14.8 s, 48 MB | **11.3 s**, 144 MB |

Times include generating the rows, which both sides do in the same way.
Memory is the peak working set of the process doing that step. On this
machine, repeated runs of the same step vary by up to 20%, so the Node writes
were run back to back. ¹ With `node --max-semi-space-size=8` (see 20.5).
² With 2 worker threads (the default). On the main thread only
(`maxDegreeOfParallelism: 1`): 90 s, 319 MB. The Node writes were measured
again on 7 October 2026.

- **Reads:** they decode only the columns a query uses. Chunk statistics are
  loaded per column, on demand, so opening a file costs the same however
  many columns it has. In .NET, values stay in typed arrays until you read
  them, and chunks are decoded ahead on worker threads, within a memory
  budget.
- **Writes in .NET** encode, compress and encrypt chunks on worker threads.
  They are faster than System.Text.Json, which does not compress.
- **Node** keeps a chunk's values in typed buffers while writing, and
  compresses chunks on worker threads. It reuses its read buffers while
  reading. Most of the remaining read memory is
  garbage V8 has not yet collected: JAZMIN itself keeps about 11 MB alive
  during a full scan (see 20.5).
- **Still open:** with Node's default settings, writing uses about a third
  more memory than `JSON.stringify`, mostly garbage collected late. With
  `--max-old-space-size=64 --max-semi-space-size=2`, 200,000 of these rows
  are written in 123 MB (JSON: 108 MB). TASKS P-15.

### 9.5 Tuning

| Setting | Default | Change it when |
|---|---|---|
| `codec` | `deflate` | Use `brotli` for archives (smaller, slower to write), or `none` for already-compressed data |
| `chunkRows` | 4096 | Lower (e.g. 512) for many single-row lookups; higher for whole-file reads |
| `select` (query option) | every column | List only the columns you need. Only those, and the columns the filter uses, are decoded, on every kind of query: scans, index lookups and access-controlled files. In access-controlled files, a column group none of whose columns is needed is not read at all. A one-column read through an index took 45% of the time of reading every column |
| indexes | none | Add `sorted` to columns used in `eq` / range filters, and `trigram` to text searched with `contains`. A `sorted` index on the first `sortedBy` column is not written, because chunk statistics already find its values; readers never used it. Large sorted indexes are paged automatically |
| `compactIndexes` (JS) / `CompactIndexes` (.NET) | off | Turn on for much smaller indexes on whole numbers and dates, once every reader of the file is on 1.2 or later (3.3) |
| `kdfIterations` | 600,000 | Do not lower it in production. It only affects password-based files. Allowed: 1,000 to 10,000,000; readers refuse files outside that range |
| `maxDegreeOfParallelism` (JS) / `MaxDegreeOfParallelism` (.NET writer) | By `priority` (20.4). Balanced: JS up to 2 worker threads; .NET one thread per core, up to 16 | Set 1, or `priority` memory, for the lowest memory. Raise it in .NET for faster writes. In JS, more than 2 gains little, because preparing rows on the main thread is the limit. JS compaction of a shared file is the exception: 2 threads made it only about 5% faster than 1, for about 35 MB more (250,000 records); for other files they made it about twice as fast |

### 9.6 Seeing what a query reads

`explain(filter)` says how a query will run: through an index (with the
number of candidate rows), or as a scan (with the chunks its statistics skip).

With `analyze`, it also **runs the query** and reports what it actually read:

| Field | Meaning |
|---|---|
| `rows` | Rows returned |
| `bytesRead` | Bytes read from the file: chunks, index pages, statistics and directories |
| `chunksRead` | Chunks read and decoded |
| `indexPagesRead` | Index sections read: directories, pages and trigram indexes |
| `columnsDecoded` | Column streams decoded (one per column per chunk; a chunk without matching rows decodes only the filter's columns) |
| `ms` (.NET: `Elapsed`) | Time taken |

```js
const reader = open('statements.jzm', { key });
reader.explain({ account: 'ACC-100001' }, { analyze: true, limit: 50 });
// { strategy: 'scan', chunks: 49, chunksSkipped: 48, rows: 50,
//   bytesRead: 102806, chunksRead: 1, indexPagesRead: 0, columnsDecoded: 9, ms: 6.1 }
```

```csharp
using var reader = JazminReader.Open("statements.jzm", new() { Key = key });
var plan = reader.Explain(JazminFilter.Eq("account", "ACC-100001"), analyze: true, new() { Limit = 50 });
Console.WriteLine($"{plan.Strategy}: {plan.Cost!.Rows} rows, {plan.Cost.BytesRead} bytes, {plan.Cost.ChunksRead} chunks");
```

- **Use a freshly opened reader.** A reader keeps the indexes it has loaded
  and its last decoded chunk, and doesn't read them again. On a reused reader,
  `analyze` shows only what *that* query added.
- **What to look for.** A query that reads many chunks to return a few rows
  usually needs a better layout:
  - sort the file by the column you filter on (`sortedBy`);
  - use smaller chunks (`chunkRows`);
  - or add an index.

### 9.7 Paging

`offset` and `limit` page through results. A chunk that lies wholly before the
offset is **counted, not read**, as long as every row in it is known to match.
That holds:

- **with no filter:** every row matches;
- **when chunk statistics prove it:** for example a date range on the file's
  first `sortedBy` column, or a value that fills whole chunks;
- **in access-controlled files,** for a filter that names one partition
  (`{ account: 'ACC-1' }` when the file is partitioned by account).

So the last page costs about the same as the first:

```js
reader.rows({ offset: reader.rowCount - 50, limit: 50 });   // the newest 50 rows (in a file sorted by time)
reader.rows({ offset: 150000, limit: 50 });                 // a deep page
```

On 200,000 transactions (`npm run bench:proposals`):

| Query | 1.0.0 | Now |
|---|---:|---:|
| Deep page (offset 150,000) | 3,563 KB, 59 ms | 97 KB, 1.7 ms |
| Newest 50 | 4,709 KB, 78 ms | 82 KB, 1.5 ms |

- **Float columns:** a filter on a float column can't skip chunks this way.
  Its statistics leave out `NaN` values, so they can't prove that every row
  matches.
- **Filtered deep pages:** when a filter's matches are spread through many
  chunks, the reader has to read those chunks to count their matches.
  *Keyset paging* avoids that: remember the last row of a page and ask for the
  rows after it, for example `{ account, at: { gt: lastAt } }` with
  `limit: 50`.
- **The browser reader** pages the same way. Its `query()` counts chunks
  whose every row matches without reading them, and `{ total: false }` reads
  only the page.

### 9.8 How a query chooses between indexes and a scan

For each query the reader first works out which chunks a scan would have to
read. Chunk statistics, the file's sort order and, in access-controlled
files, the partition a filter names often leave only a few. Then it decides
whether indexes can do better:

- **Conditions on one column become one lookup.** For example,
  `{ at: { gte: monday, lt: tuesday } }` reads only the index pages for that
  day. Before 1.1, each bound read about half the index.
- **An index is used only when it reads less than the scan would.** The cost
  of a lookup comes from the index's directory, so it's known before any
  index page is read. Lookups of up to 8 KB are always made.
  - On a file sorted by account, a page of one account's rows after a time,
    `{ account, at: { gt: lastAt } }`, scans that account's one or two chunks
    instead of reading megabytes of the time index.
  - When a filter has several conditions, the cheapest lookups are used and
    the rest are checked row by row.
- **Text search uses its index only when the text is rare enough to help.**
  A trigram index lists, for each three-letter piece of text, the rows that
  contain it.
  - When even the rarest piece of the search text is in over a quarter of
    the rows a scan reads, spread across them, the reader scans instead.
    Those rows fall in almost every chunk, and checking each row is quicker.
  - Common text in rows that sit together (say, the first months of a log)
    still uses the index, which skips the chunks around them.
  - Only the rows of the pieces a search uses are read from the index,
    rarest piece first. Before 1.4 the whole index was decoded first.
- **Index results only narrow the scan.** Only chunks the scan would read are
  read, and in them only the rows the index names are checked, with the same
  fast column decoding as a scan.
- **A few rows of a chunk are decoded on their own** (Node, from 1.4). When an
  index names only a few rows of a chunk, or only a few of its rows match,
  just their values are decoded. The values between them are stepped over
  without being made.

`explain(filter)` shows the choice (`strategy: 'index'` or `'scan'`), and
`{ analyze: true }` shows what it read (section 9.6).

On 200,000 transactions sorted by account (`npm run bench:proposals`):

| Query | 1.0.0 | Now |
|---|---:|---:|
| A page of one account's rows after a time | 3,785 KB, 109 ms | 102 KB, 2.2 ms |
| One day across all accounts | 7,467 KB, 206 ms | 4,938 KB, 70 ms |

In .NET, the same changes took a lookup by id from 3.7 to 2.1 ms, and an
indexed filter from 40 to 12 ms.

### 9.9 Fetching many rows by position

`get(rowId)` reads the chunk that holds the row, and the reader keeps only
the last chunk it decoded. Fetching rows **in position order** reads each
chunk once. Fetching them in any other order can read the same chunk again
and again.

So when you hold a list of row positions, for example from your own pointer
table or a join between tables, sort it first:

```js
const ordered = [...rowIds].sort((a, b) => a - b);
const rows = ordered.map((id) => reader.get(id));    // one pass over the file
```

```csharp
var rows = rowIds.Order().Select(reader.Get).ToList();    // one pass over the file
```

On 200,000 transactions sorted by account, fetching the 549 rows of one day
(`npm run bench:proposals`):

| Order | Read | Time |
|---|---:|---:|
| Time order, as the rows came | 53,815 KB | 673 ms |
| Sorted by position first | 4,895 KB | 62 ms |

If you need the rows in the original order, sort a copy for fetching and look
the rows up by position afterwards. When the rows can be described by a
filter, `find()` is better still: it reads only the chunks that can match.

### 9.10 Counting

`count(filter)` returns the number of matching rows. It reads as little as
it can, in this order:

- **From an index alone.** When sorted indexes answer the filter exactly, the
  count is the number of rows the index names, and no rows are read. That
  holds for one condition (`eq`, `in`, a range or `isNull: true`), or range
  conditions on one column, on an indexed column. `startsWith` and text
  search still check rows.
- **Whole chunks by their row counts.** A chunk whose statistics prove every
  row matches is counted without being read. For example, a date range on
  the file's first `sortedBy` column reads only the chunks at either end.
- **Only the filter's columns** of the other chunks are decoded.

So a dashboard that counts rows per month, or per status, reads a fraction
of the file. On 200,000 transactions (`npm run bench:proposals`):

| Query | 1.0.0 | Now |
|---|---:|---:|
| 12 monthly counts over a year (file sorted by time) | 5,771 KB, 104 ms | 1,062 KB, 15 ms |
| One account's count (file sorted by time, `account` indexed) | 4,766 KB, 81 ms | 57 KB, 1.2 ms |

- **.NET** counts the same way. The 12 monthly counts took 81 ms in 1.0.0
  and 32 ms now. On 1,000,000 rows, they took 257 ms and now take 16 ms.
- **The browser reader** counts the same way, and `query()` uses it for
  `total`.
- **Access keys** don't use indexes (only the owner can read them), so they
  count from chunk statistics and the partitions a filter names.

### 9.11 Column arrays for charts

A chart needs a few columns of many rows. `find()` gives an object per row,
which costs about 160 bytes each. `columnArrays()` gives one array per column
instead:

```js
const { rowCount, values, nulls } = reader.columnArrays({ at: { gte: start } }, { select: ['at', 'amount'] });
values.at;       // Float64Array of milliseconds since 1970 (UTC)
values.amount;   // Float64Array
chart.draw(values.at, values.amount);
```

| Column type | Array |
|---|---|
| `int`, `float`, `datetime` | `Float64Array` (dates as milliseconds) |
| `bool` | `Uint8Array` (1 = true) |
| Other types | A plain array |

- **Nulls:** a plain array holds `null` itself. A typed array can't, so a
  null row holds `NaN` (0 for bools), and `nulls[column]` marks it. That
  bitmap exists only when the column has nulls. Bit `i & 7` of byte `i >> 3`
  is set for row `i`.
- **Integers beyond ±2⁵³** are refused, because a `Float64Array` can't hold
  them exactly. Use `find()` for those.
- **Options:** `select` picks the columns (default: every visible one), and
  `filter`, `offset` and `limit` work as in `find()`.

200,000 rows of a date and an amount, memory kept after the call:

| Reader | Row objects | `columnArrays()` |
|---|---:|---:|
| Node | 30.7 MB | **3.3 MB** |
| Browser reader | 34.8 MB | **3.8 MB** |

The raw arrays are 3.1 MB. On a phone, a dashboard showing 250,000 rows keeps
about 5 MB instead of 43 MB.

It is also faster than `find()`: values go from the decoded columns straight
into the arrays, with no object per row and no `Date` per date. One million
rows, two columns:

| Reader | A number and a float | A date and a float |
|---|---:|---:|
| Node | 121 ms | 135 ms |
| Browser reader | 300 ms | 305 ms |

---

### 9.12 Other formats, for reference: Parquet, Arrow, SQLite, MessagePack

How JAZMIN compares with formats built for other jobs, on the same 200,000
customers as sections 9.1 and 9.2. These are for reference: they show where
JAZMIN is strong, and what it can work towards.

| Format | What it's for | Library used |
|---|---|---|
| **Parquet** | Columnar files for analytics | Node: hyparquet and hyparquet-writer. .NET: Parquet.Net |
| **Arrow IPC** | Columns as they are in memory, shared without copying | apache-arrow; Apache.Arrow |
| **SQLite** | An embedded SQL database with B-tree indexes | node:sqlite; Microsoft.Data.Sqlite |
| **MessagePack** | Binary JSON: a whole document in one go | msgpackr; MessagePack-CSharp |

- **Same work for every format:** the same rows, written to a file and
  queried from that file. Each query opens the file, as JAZMIN's do. Every
  answer is checked against the expected one.
- **Each library is used as it documents, with its defaults:**
  - JAZMIN is deflate with 3 indexes (id, name trigram, country);
  - SQLite has the same id and country indexes;
  - Parquet and Arrow have no indexes; their queries read only the columns
    they need, and the Node Parquet reader skips row groups by their
    statistics.
- **Machine and timing:** the same laptop as sections 9.1 and 9.2, measured on
  9 October 2026 while about a third of it was busy with other work. Each cell
  is the best of 2 or 3 runs, each run the best of 3 after a warm-up.
  Compare across a row; the figures in 9.1 and 9.2 were measured on a quiet
  machine. Some rows were measured again later the same day, after changes
  of 1.4 (section 9.8), each as the best of 2 runs: the text search rows,
  and, on a quieter machine, Node's "Find one row by id" rows.
- **Memory:** each operation runs in a process of its own.
  - It runs first on a file of 1,000 rows, so the library's code is loaded and
    compiled.
  - Then it runs on the real file while the process's memory is sampled
    throughout (RSS in Node, the working set in .NET).
  - The figure is how far memory rises above where it was before: objects,
    buffers and native memory (SQLite's) alike. It is the lower of 2 runs.
- **Run them yourself:**
  - Node: `npm install` then `npm run bench` in `js/bench/formats`;
  - .NET: `dotnet run -c Release --project bench/Jazmin.FormatBenchmarks` in
    `dotnet/`.

  They are kept apart from the libraries, so neither package depends on
  these formats. The memory measurement adds a few minutes.

**Node.js 24:**

| Measure | JAZMIN | Parquet | Arrow IPC | SQLite | MessagePack |
|---|---:|---:|---:|---:|---:|
| File size | **2,227 KB** | 2,935 KB | 12,027 KB | 15,340 KB | 21,626 KB |
| Write every row | 483 ms | 551 ms | 633 ms | 456 ms | **124 ms** |
| Read every row (objects) | **109 ms** | 158 ms | 612 ms | 717 ms | 255 ms |
| Sum one column | 30.6 ms | 32.3 ms | **15.4 ms** | 29.8 ms | 265.8 ms |
| Find one row by id (open → row) | 1.9 ms | 82.5 ms | 7.3 ms | **0.7 ms** | 162.7 ms |
| Filter: country = NA, age > 80 | 23.9 ms | 77.2 ms | **14.6 ms** | 27.0 ms | 243.0 ms |
| Text search: name contains 'Ndlovu' | 16.6 ms | 17.3 ms | **15.8 ms** | 18.5 ms | 168.1 ms |

**.NET 10:**

| Measure | JAZMIN | Parquet | Arrow IPC | SQLite | MessagePack |
|---|---:|---:|---:|---:|---:|
| File size | **2,232 KB** | 3,659 KB | 13,980 KB | 15,340 KB | 11,872 KB |
| Write every row | 214 ms | 226 ms | 135 ms | 623 ms | **41 ms** |
| Read every row (objects) | **91 ms** | 264 ms | 671 ms | 320 ms | 107 ms |
| Sum one column | 31.4 ms | **5.9 ms** | 13.8 ms | 25.4 ms | 111.2 ms |
| Find one row by id (open → row) | 1.7 ms | 193.3 ms | 11.0 ms | **0.9 ms** | 89.5 ms |
| Filter: country = NA, age > 80 | 10.6 ms | 25.7 ms | **8.9 ms** | 22.6 ms | 95.7 ms |
| Text search: name contains 'Ndlovu' | 17.6 ms | 16.5 ms | **10.7 ms** | 21.1 ms | 50.5 ms |

**Memory, Node.js 24** (peak memory added):

| Measure | JAZMIN | Parquet | Arrow IPC | SQLite | MessagePack |
|---|---:|---:|---:|---:|---:|
| Write every row | 173.4 MB | 203.2 MB | 230.7 MB | **24.9 MB** | 44.7 MB |
| Read every row (objects) | **75.5 MB** | 114.1 MB | 102.2 MB | 282.5 MB | 153.8 MB |
| Sum one column | 11.1 MB | 35.1 MB | 12.9 MB | **1.9 MB** | 154.3 MB |
| Find one row by id (open → row) | 0.3 MB | 87.5 MB | 12.9 MB | **0.1 MB** | 151.2 MB |
| Filter: country = NA, age > 80 | 11.3 MB | 48.3 MB | 14.0 MB | **1.7 MB** | 150.9 MB |
| Text search: name contains 'Ndlovu' | 12.1 MB | 19.5 MB | 15.4 MB | **2.0 MB** | 151.9 MB |

**Memory, .NET 10** (peak memory added):

| Measure | JAZMIN | Parquet | Arrow IPC | SQLite | MessagePack |
|---|---:|---:|---:|---:|---:|
| Write every row | 72.7 MB | 58.0 MB | 48.0 MB | **18.2 MB** | 23.8 MB |
| Read every row (objects) | 58.7 MB | 94.4 MB | 72.0 MB | **14.3 MB** | 55.7 MB |
| Sum one column | 16.2 MB | 10.5 MB | 14.1 MB | **1.8 MB** | 56.1 MB |
| Find one row by id (open → row) | 6.3 MB | 84.5 MB | 13.8 MB | **0.1 MB** | 55.7 MB |
| Filter: country = NA, age > 80 | 26.1 MB | 27.4 MB | 15.4 MB | **1.8 MB** | 55.7 MB |
| Text search: name contains 'Ndlovu' | 33.7 MB | 33.7 MB | 23.6 MB | **1.8 MB** | 55.7 MB |

SQLite needs almost no memory for a query: it reads its file a page at a time
through a small cache, and returns a count or one row. Its reads of every row
are another matter in Node (282 MB, for its row objects).

**Where JAZMIN leads:**
- **Smallest file in both, with its 3 indexes:** Parquet's is a third to two
  thirds larger, with none. Arrow and SQLite files are 5-7 times larger, MessagePack's 5-10
  times.
- **Fastest to read every row**, in both, and in Node with the least memory
  (76 MB, against 102-283 MB).
- **Little memory for queries that use its indexes or statistics:** finding
  one row takes 0.3 MB in Node and 6.3 MB in .NET; Parquet and MessagePack take
  56-151 MB, reading the whole file or the column first.
- **Finding one row by id:** second only to SQLite's B-tree, and 3-110 times
  faster than the formats without an index.
- **The only one with keys, encryption and per-key access** (sections 10 and
  15).

**What it can work towards** (TASKS P-25):
- **Finding one row by id:** SQLite takes 0.7-1.1 ms. JAZMIN takes 1.7 ms in
  .NET and 1.9 ms in Node.
  - In 1.4 Node decodes only the row's values (section 9.8): 2.7 -> 1.9 ms
    side by side with the code before, and 1.15 -> 0.70 ms once Node has
    optimised the code, as fast as SQLite.
  - Most of what is left in Node is the library being compiled on its first
    calls. In .NET a lookup takes 0.6 ms once warm.
- **Sums and simple filters over a column:**
  - Arrow keeps its columns uncompressed, as they are in memory, and is up to
    about twice as fast here.
  - Parquet.Net reads one Snappy-compressed column in 5.9 ms where JAZMIN
    takes 31 ms.
  - JAZMIN decompresses deflate chunks to save space (memory first,
    section 20.4).
- **Text search for a common word:** an eighth of the names contain
  'Ndlovu'. Since 1.4 a search reads only the parts of the trigram index it
  needs, and scans when the word is in most rows (section 9.8).
  - Node: 35.0 -> 16.6 ms, beside Arrow's 15.8 ms.
  - .NET: 20.2 -> 17.6 ms; Arrow's scan of uncompressed columns takes
    10.7 ms. Opening the index still costs about 3 ms per query in .NET.
- **Writing:** MessagePack writes 4-5 times faster. It stores a document as it
  is, with no columns, compression or indexes to build.
- **Memory:**
  - The text search, since 1.4: 12 MB in Node (was 34 MB), less than
    Arrow's 15 MB; 34 MB in .NET (was 49 MB), against Arrow's 24 MB.
  - Writing in Node adds 173 MB, against 25 MB for SQLite and 45 MB for
    MessagePack.
  - In .NET, filters and sums use more than Arrow's (26 and 16 MB, against
    15 and 14 MB), most likely the reader's read-ahead and buffers.


**What is protected.** In an encrypted file, the data, column names and
types, metadata and indexes are all encrypted and authenticated. The
following remain visible:

- the file size and the size of each section;
- whether a password was used.

**Keys:**

- Generate keys with `JazminKey.generate()` / `JazminKey.Generate()`.
- Get the key's text with `export()` / `Export()` and store it in a secret
  manager such as Azure Key Vault, AWS Secrets Manager or HashiCorp Vault.
  Never store it next to the file or in source control.
- Until 2.0, `toString()` / `ToString()` gives the same secret text, so a key
  put into a log line or an error message leaks it. From 2.0 it won't: an
  access key will print only its id. Use `export()` wherever you mean to save
  or send a key.
- **If the key is lost, the data cannot be recovered.**
- The `jzk1-...` text contains a checksum, so a typo produces "Key checksum
  mismatch" rather than a confusing decryption failure.

**Passwords:** suitable for people. For services, prefer keys. PBKDF2
slows down guessing, but a weak password is still weak.

**Changing a file's key or password** (when a key may have leaked, or
someone who knew it leaves):

```js
rotateKey('statements.jzm', { key: oldKey, newKey: JazminKey.generate() });
rotateKey('statements.jzm', { password: 'old one', newPassword: 'new one' });
```

```csharp
JazminFile.RotateKey(path, new JazminKeyRotation { Key = oldKey, NewKey = JazminKey.Generate() });
```

- **Only the new key or password opens the file afterwards.** Nothing is
  shared with the old version: the master key, file id, salt and every
  section's key are new.
- **Fast, because rows are not decoded:** each section is decrypted and
  encrypted again as it is stored. On a 176 MB file (200,000 rows × 300
  columns) it took 0.7 s at 138 MB in Node and 0.7 s at 45 MB in .NET,
  against 33 s at about 450 MB and 14 s at 120 MB for a full rewrite.
- **A file with appends is compacted first,** so that its earlier versions,
  still under the old key, are not kept.
- **Keys and passwords can change places:** pass `newPassword` (and
  `kdfIterations`) for a key-encrypted file, or `newKey` for a
  password-encrypted one.
- **What it can't do:** undo a leak. Anyone who held the old key and a copy
  of the old file can still read that copy.
- **Shared (access-controlled) files** (section 15) use `rotateOwnerKey`,
  below.

**If a shared file's owner key leaks:** give the file a new owner key.

```js
const { ownerKey, accessKeys } = rotateOwnerKey('collect.jzm', { key: oldOwnerKey });
// Store ownerKey.export() in your secret manager. Then, for each person:
for (const k of accessKeys) send(k.label, k.key.export()); // k.previous is the id of the key it replaces
```

```csharp
var result = JazminFile.RotateOwnerKey(path, oldOwnerKey);
foreach (var k in result.AccessKeys) Send(k.Label, k.Key.Export()); // k.PreviousKeyId: the key it replaces
```

- **Everyone gets a new access key.** Each access key carries a stamp of
  the owner key that issued it, and readers check that stamp to catch
  forged files, so no old key can work with a new owner key. Each new key
  opens exactly what the old one did: the same rows, columns, embedded
  files, label, expiry and mode.
- **Online keys need new unlock tokens:** issue them with the new owner key
  (`issueUnlockToken` / `JazminFile.IssueUnlockToken`).
- **Expired grants are dropped,** as `update()` drops them.
- **The file is rewritten** with fresh secrets throughout, as `update()`
  does. Afterwards, neither the old owner key nor any old access key opens
  it.
- **If only one person's access key leaks,** you don't need this:
  `revokeAccess()` and `grantAccess()` replace just that key (section 15).

**Sharing one file with many people:** give each person an access key that opens only their rows and
columns. See [section 15](#15-access-control-one-file-many-keys).

**Keep a shared file's master key off web pages.** It reads everything,
changes the file, and gives and takes away access, and it can't be revoked.
- **Where it belongs:** servers and tools you control. Keep it in a secret
  manager.
- **Browsers:** they refuse it (section 24). For browsing, use a full-read
  access key.

**Tampering:** any change to an encrypted file is detected. This covers
editing bytes, swapping chunks, copying sections from another file, and
stripping encryption. Plain files have CRC checks, which catch accidental
damage only.

**Do not mix attacker-supplied text and secrets in one compressed and
encrypted file** if an attacker can see the file size. Compression can leak
information through size changes (see RFC §13). For such cases, use
`codec: 'none'`.

---

## 11. Converting to and from JSON, CSV and XML

| Direction | JavaScript | .NET |
|---|---|---|
| JSON → JAZMIN | `fromJSON(text, target, options)` | `JazminConvert.FromJson(json, settings)` |
| JAZMIN → JSON | `toJSON(reader, { filter, select, pretty, omitNulls })` | `JazminConvert.ToJson(bytes, settings, filter)` |
| CSV → JAZMIN | `fromCSV(text, target, { inferTypes })` | `JazminConvert.FromCsv(csv, settings, inferTypes)` |
| CSV file of any size → JAZMIN | `importCSVFile(path, target, { inferTypes, delimiter, columns })` | `JazminConvert.FromCsvFile(path, output, settings, inferTypes, delimiter, columns)` |
| XML file of any size → JAZMIN | `importXMLFile(path, target, { inferTypes, columns })` | `JazminConvert.FromXmlFile(path, output, settings, inferTypes, columns)` |
| JAZMIN → CSV | `toCSV(reader, options)` | `JazminConvert.ToCsv(bytes, settings, filter)` |
| XML → JAZMIN | `fromXML(text, target)` | `JazminConvert.FromXml(xml, settings)` |
| JAZMIN → XML | `toXML(reader, options)` | `JazminConvert.ToXml(bytes, settings, filter)` |
| Stream to file | `exportFile(reader, 'json' \| 'csv' \| 'xml', path, options)` | `JsonFormat.Write`, `CsvFormat.Write`, `XmlFormat.Write` |
| Nested JSON / XML (section 21) | `toJSON(reader, { shape })`, `toXML(reader, { shape })`, `exportFile(..., { shape })` | `JazminShape.Parse(json).ToJson(reader)`, `.ToXml(reader)`, `.WriteJson(reader, stream)` |

Conversion rules worth knowing:

- **JSON:** large integers and decimals are written exactly, even beyond
  JavaScript's 2^53 limit. Dates use ISO-8601 UTC format, and binary data
  is base64. Nested columns (`list`, `object`) are written as JSON arrays
  and objects, as `json` columns are.
- **CSV:** an empty field means *null*, while `""` means an *empty string*,
  so round trips keep the difference. Types are inferred unless you set
  `inferTypes: false`; turn inference off for codes with leading zeros
  such as `0042`.
- **XML:** the shape is `<jazmin><row><column>value</column></row></jazmin>`.
  Null values are left out. Column names that are not valid XML names are
  written as `<field name="...">`.

### 11.1 Large CSV and XML files

`importCSVFile` and `importXMLFile` (.NET `JazminConvert.FromCsvFile` and
`FromXmlFile`) read a file a block at a time, so its size doesn't matter.
They read it twice: first to work out the column types, as `fromCSV` and
`fromXML` do, then to write the rows. XML files are read as UTF-8 (or as a
byte order mark says), whatever their XML declaration says.

```js
import { importCSVFile } from '@smithsoft-studios/jazmin';

importCSVFile('transactions.csv', 'transactions.jzm', { indexes: { account: 'sorted' } });

// With the columns known (here, those of a file it was exported from), each value is read as its column's
// type and the file is read once. Every header name must be one of the columns.
importCSVFile('export.csv', 'back.jzm', { columns: reader.columns });
```

```csharp
JazminConvert.FromCsvFile("transactions.csv", "transactions.jzm");
JazminConvert.FromCsvFile("export.csv", "back.jzm", columns: reader.Columns);
JazminConvert.FromXmlFile("transactions.xml", "transactions.jzm");
```

In XML a column can first appear in a later row: it is then nullable, as
`fromXML` infers it. With `columns`, every element must name one of them.

A 1 GB file:

| Library | CSV (10 million rows) | XML (4.6 million rows) |
|---|---:|---:|
| .NET | 14 s, **63 MB** | 11 s, **65 MB** |
| Node, with `--max-old-space-size=64 --max-semi-space-size=2` | 44 s, **92 MB** | 48 s, **86 MB** |
| Node, without those flags (it collects garbage late) | 32 s, 316 MB | 41 s, 250 MB |

With `fromCSV` or `fromXML`, Node holds the text and then every row as an
object: a 200 MB file took 1.6 GB (CSV) and 1.3 GB (XML).

### 11.2 Rows as a JSON stream or JSON tokens (.NET)

For code that already consumes JSON, a query's rows can be read as JSON
without writing it to a file or a string first:

```csharp
using Jazmin.Formats;

// Bytes, written as they are read: for any System.Text.Json pipeline, or an HTTP response.
using var stream = new JazminJsonStream(reader, JazminFilter.Eq("account", "ACC-100001"), new() { Select = ["at", "amount"] });
await foreach (var line in JsonSerializer.DeserializeAsyncEnumerable<StatementLine>(stream)) { /* ... */ }
// ASP.NET: return Results.Stream(new JazminJsonStream(reader), "application/json");

// Tokens, one at a time, as Newtonsoft's JsonReader gives them: no JSON text is written or parsed.
using var json = new JazminJsonReader(reader);
while (json.Read())
{
    if (json.TokenType == JazminJsonToken.PropertyName) Console.Write($"{json.Path} = ");
    else if (json.Value is not null) Console.WriteLine(json.Value);
}
```

- **The JSON is that of `JazminConvert.ToJson`:** an array of row objects,
  the same bytes. `JazminJsonStream` takes `Formatting` and
  `NullValueHandling` as `ToJson` does.
- **Tokens:** `StartArray`, `StartObject`, `PropertyName`, `Integer` (a
  `long`), `Float` (a `double`, or a decimal as its exact text), `String`,
  `Boolean`, `Null`, `Date` (a UTC `DateTime`), `Bytes` (a `byte[]`),
  `EndObject` and `EndArray`. A `json` column's value comes as nested tokens.
  `Depth` and `Path` (`[3].amount`, `[3].extra.tags[0]`) are as in Newtonsoft.
- **Memory stays low however many rows the query returns:** the stream holds
  about 64 KiB of text at a time. 200,000 rows × 300 columns (1.3 GB of JSON
  from a 135 MB file): the stream 7.1 s at 63 MB, the token reader 4.8 s
  (120 million tokens) at 62 MB, and `DeserializeAsyncEnumerable` over the
  stream 13 s at 70 MB.

---

## 12. Errors and troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `This file is encrypted - supply a key or password` | Opened without a key | Pass `key` / `password` |
| `Key checksum mismatch - the key text is mistyped or corrupted` | Typo or truncated key text | Copy the key again |
| `Decryption failed - wrong key/password or the data was tampered with` | Wrong key, or modified file | Check the key; restore the file from backup |
| `A key was supplied but the file is not encrypted` | You expected an encrypted file but got a plain one | Investigate the source: this guards against a downgrade attack |
| `Missing trailer - file is truncated or incomplete` | Writer crashed, or the copy was cut short | Re-create or re-copy the file |
| `Section 'chunk/3' failed its CRC-32 check` | Disk or transfer corruption | Restore the file from backup |
| `Column 'age': expected an integer, got string` | Wrong value type | Fix the data or the column type |
| `Row 12: unknown column 'nme'` | Typo in a property name | Fix the name (or remove the extra property) |
| `Invalid filter: unknown column 'x'` | Filter names a column that does not exist, or one your access key cannot see | Check `reader.columns` |
| `This file uses a pre-release JAZMIN draft format` | Written by a JAZMIN version from before format 1.0 | Write it again from its source data |
| `This file needs the 'x' feature, which this JAZMIN reader does not support` | Written by a newer JAZMIN that uses a newer feature | Upgrade JAZMIN |

## 13. Limits

| Item | Limit |
|---|---|
| Section (chunk/index/header) size | 4 GiB each |
| Integers | 64-bit signed |
| Dates | Millisecond precision. .NET supports years 1–9999 |
| Nested columns | 64 levels of lists and objects within one another |
| Rows per file | 2^53 in JavaScript, 2^63 in .NET |
| Updates | By rewrite with atomic replace (section 16), or by append for frequent changes (section 17) |
| Concurrency | Readers and writers are single-threaded objects. Open one per thread |
| Browser | `@smithsoft-studios/jazmin/browser` (section 24) reads every file except Brotli-compressed ones, and writes files with one key, a password or none |
| Large JSON import | Streams with `importJSONFile` / `JazminConvert.FromJsonFile` at any size. `fromJSON` / `FromJson` (text in memory) are for small inputs |
| Large CSV and XML import | Streams with `importCSVFile` / `importXMLFile` (.NET `FromCsvFile` / `FromXmlFile`) at any size (section 11.1) |
| Partial-access keys | Yes, by partition and/or column group (section 15) |

## 14. Recipe: one large file, processed section by section

**The problem this solves.** A large JSON file (say 300 MB) holds many
sections, such as one per client statement. Each PDF needs only one section.
With JSON, every section means reading and parsing the *whole* file again.
That is slow and memory-hungry, and the usual workaround is to split the
JSON into thousands of small files.

**With JAZMIN:**

1. Convert the JSON once, streaming.
2. Open the result once. This reads only the header.
3. Ask for each section as you need it. Only the chunk(s) holding that section
   are read and decompressed.

### 14.1 Measured on a 271 MB statement file

The test file has 1.37 million lines in 5,000 sections, about 274 lines
each. You can re-run it with `node bench/sections.js 300 5000`.

| | Old: reload the JSON per section | **JAZMIN** |
|---|---:|---:|
| Time to get one section | 1.3 s | **0.3–0.4 ms** (p99: 3.4 ms) |
| All 5,000 sections | ≈ 1.8 hours | **1.5–2 s** |
| Peak memory of the process | 1,659 MB | **73–85 MB** (an idle Node process is ~50 MB) |
| One-off conversion | — | 9 s, 71 MB peak, file 23.6 MB |
| Pre-splitting into thousands of files | needed | **not needed** |

Peak memory is measured for the whole process, with Node's standard
`--max-old-space-size` and `--max-semi-space-size=2` flags. Without the
second flag, Node on a machine with plenty of RAM lets short-lived garbage
grow to about 150 MB before collecting it. That is harmless but makes memory
graphs look worse. For many PDF workers on one server, set both flags.

### 14.2 Compared with *streaming* JSON readers

Streaming JSON readers (Newtonsoft `JsonTextReader`, System.Text.Json
`DeserializeAsyncEnumerable`, or a streaming parser in Node) fix JSON's
*memory* problem, but not its *access* problem. To reach a section, they must
read from the start of the file to that section.

| Same 271 MB file | Streaming JSON | **JAZMIN** |
|---|---:|---:|
| Section near the start | 2–48 ms | **0.3–1.8 ms** |
| Section in the middle | 0.7–1.3 s | **0.3–1.8 ms** |
| Section at the end | 1.3–2.6 s | **0.3–1.8 ms** |
| All 5,000 sections, one at a time | ≈ 1.2–1.7 hours | **1.4–2.3 s** |
| Memory allocated per section (.NET) | up to 416 MB (STJ), 747 MB (Newtonsoft) | **≈ 3 MB** |
| Full sequential read, Node | 3.2 s | **1.3 s** |
| Full sequential read, .NET, raw rows | STJ 1.2 s, Newtonsoft 1.7 s | **0.9 s** |
| Full sequential read, .NET, into C# objects | STJ **1.2 s**, Newtonsoft 1.7 s | 1.4 s |

The only case where streaming JSON leads is reading *everything once* into
C# objects with System.Text.Json, by about 15%. Re-run with
`dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks -- streaming statements.json 5000`.

### 14.3 JavaScript

```js
import { importJSONFile, open } from '@smithsoft-studios/jazmin';

// Once (e.g. when the data arrives): streams the JSON, never loads it whole.
// Works with a JSON array or JSON Lines. Add `key` to encrypt.
importJSONFile('statements.json', 'statements.jzm', { indexes: { section: 'sorted' } });

// In the PDF worker: open once, then fetch sections on demand.
const reader = open('statements.jzm');
for (const sectionId of sectionIds) {
  const lines = [...reader.find({ section: sectionId })];   // only this section's rows
  await renderPdf(sectionId, lines);                         // e.g. Puppeteer page.setContent + page.pdf
}
reader.close();
```

To process **every** section in file order, stream the rows and group
consecutive ones. That needs no index and reads each chunk exactly once:

```js
function* bySection(rows, column) {
  let current;
  let batch = [];
  for (const row of rows) {
    if (batch.length && row[column] !== current) {
      yield [current, batch];
      batch = [];
    }
    current = row[column];
    batch.push(row);
  }
  if (batch.length) yield [current, batch];
}

for (const [sectionId, lines] of bySection(reader.rows(), 'section')) await renderPdf(sectionId, lines);
```

### 14.4 .NET

```csharp
// Once: streams the JSON (array or JSON Lines), never loads it whole.
JazminConvert.FromJsonFile("statements.json", "statements.jzm", new JazminSerializerSettings
{
    Indexes = new() { ["section"] = new[] { JazminIndexKind.Sorted } },
});

// In the worker: open once, fetch sections on demand.
using var reader = JazminReader.Open("statements.jzm");
foreach (var sectionId in sectionIds)
{
    List<StatementLine> lines = reader.Query<StatementLine>(l => l.Section == sectionId).ToList();
    await RenderPdfAsync(sectionId, lines);
}
```

### 14.5 Getting the best results

- **Declare the order:** pass `sortedBy: ['section']` (or `SortedBy`) when converting or writing. The reader
  then finds a section by binary search, and updates keep the order.
- **Keep each section's rows together.** Statement data usually already is.
  Then even *without* an index, chunk statistics take the reader straight to
  the right chunk. A `sorted` index on the section column makes lookups
  slightly faster, and still finds rows that are scattered through the file.
- **Open once per worker, not once per section.** Opening reads the header,
  which is cheap (3 ms here), but there is no need to repeat it.
- **One reader per thread or worker.** Readers are not thread-safe.
- **Encrypt for transport and storage** by adding `key` (or `Key`). In
  these tests, reading encrypted sections costs about the same as reading
  plain ones. Fetch the key from your secrets endpoint at start-up and pass
  the `jzk1-...` text straight to `JazminKey.parse` / `JazminKey.Parse`.
  Never log it.

## 15. Access control: one file, many keys

An access-controlled file has one **owner key** (`jzk1-...`) and any number of
**access keys** (`jza1-...`). Each access key sees only what it was granted:

- **Partitions:** all rows sharing a value of one column (`partitionBy`), for
  example one client's statement section.
- **Column groups:** named sets of columns, for example `pii: ['salary',
  'idNumber']`. All other columns are in the default group `*`.

| Who | Can read | Can write / update / grant |
|---|---|---|
| Owner key | everything, using indexes | yes, and is the only key that can |
| Access key | only its granted rows and columns; other rows are simply not returned | no |
| Any other key | nothing (*not granted* or *not signed by the owner of this key*) | no |

Every access-controlled file is **digitally signed by the owner**. An access
key cannot produce a file that verifies as the owner's, and readers reject
files whose signature or contents were changed.

### 15.1 JavaScript

```js
import { JazminKey, open, write, grantAccess, revokeAccess } from '@smithsoft-studios/jazmin';

const owner = JazminKey.generate();          // keep in your secret store; it controls the file
const bob = owner.createAccessKey();         // send bob.export() to Bob (e.g. via your secrets API)

write('statements.jzm', lines, {
  key: owner,
  sortedBy: ['section'],                     // keeps each section in one place (fast + small)
  access: {
    partitionBy: 'section',
    columnGroups: { pii: ['salary', 'idNumber'] },
    grants: [{ key: bob, rows: ['ACC000123'], columns: ['*'], label: 'Bob' }],
  },
});

const view = open('statements.jzm', { key: bobKeyText });   // jza1-... text works directly
view.columns;          // no salary / idNumber
[...view.rows()];      // only section ACC000123
view.hiddenRowCount;   // how many rows Bob may not see
view.access;           // { isOwner: false, visiblePartitions: ['ACC000123'], visibleColumnGroups: ['*'], ... }
// The owner's view also lists the grants and, in groupColumns, the columns of each column group:
// { '*': ['section', 'name', ...], pii: ['salary', 'idNumber'] }

grantAccess('statements.jzm', owner, carol, { rows: '*', columns: ['*', 'pii'], label: 'Auditor' });
revokeAccess('statements.jzm', owner, bob);  // Bob cannot open the new version
```

### 15.2 TypeScript

```ts
import { JazminKey, open, write, type AccessOptions } from '@smithsoft-studios/jazmin';

const owner = JazminKey.generate();
const bob = owner.createAccessKey();
const access: AccessOptions = {
  partitionBy: 'section',
  columnGroups: { money: ['amount'] },
  grants: [{ key: bob, rows: ['B'], columns: ['*'], label: 'Bob' }],
};
write('shared.jzm', [{ section: 'A', amount: 1 }, { section: 'B', amount: 2 }], { key: owner, sortedBy: ['section'], access });
const bobView = open('shared.jzm', { key: bob.export() });
console.log([...bobView.rows()], bobView.hiddenRowCount); // [ { section: 'B' } ] 1
```

### 15.3 .NET

```csharp
var owner = JazminKey.Generate();
var bob = owner.CreateAccessKey();                       // bob.Export() -> "jza1-..."

using (var writer = JazminWriter.Create("statements.jzm", columns, new JazminWriteOptions
{
    Key = owner,
    SortedBy = ["section"],
    Access = new JazminAccessOptions
    {
        PartitionBy = "section",
        ColumnGroups = new() { ["pii"] = ["salary", "idNumber"] },
        Grants = [new JazminGrant(bob) { Rows = ["ACC000123"], Columns = ["*"], Label = "Bob" }],
    },
}))
{
    foreach (var line in lines) writer.WriteValues(line.Section, line.Number, line.Salary, line.IdNumber);
}

using var view = JazminReader.Open("statements.jzm", new JazminReadOptions { AccessKey = JazminAccessKey.Parse(bobKeyText) });
var mine = view.Query<StatementLine>(l => l.Section == "ACC000123").ToList();   // hidden columns stay default
Console.WriteLine($"{view.RowCount} visible, {view.HiddenRowCount} hidden");

JazminFile.GrantAccess("statements.jzm", owner, new JazminGrant(carol) { Label = "Auditor" });   // Rows/Columns null = all
JazminFile.RevokeAccess("statements.jzm", owner, bob);
```

### 15.4 Performance (1.37M lines, 5,000 sections, one client key per section)

| | JavaScript | .NET |
|---|---:|---:|
| Write | 2.0 s | 1.2 s |
| Client: open file + read own section | 1.7 ms | 1.6 ms |
| Owner: open file + read one section | 2.1 ms | 1.8 ms |
| Owner: per section, file already open | 0.27 ms | 0.21 ms |

(`bench/access.js` grants one client key; the .NET benchmark grants 5,000.)

**Owner lookups by an index** (an id, a few values) read only the partitions
that hold the matching records. The file keeps a small chunk map for the
owner: which partition each chunk of records is in. So the time doesn't grow
with the number of partitions. Finding one record by id in a file of 250,000
records:

| Partitions | JavaScript | .NET |
|---:|---:|---:|
| 100 | 1.7 ms (4.9 ms without the map) | 3.1 ms (5.0 ms without) |
| 1,000 | 2.0 ms (49 ms without) | 2.7 ms (28 ms without) |

Files written before the map existed get one at their next compaction or
full rewrite; until then they read every partition's chunk directory.

**Appends** don't read the partitions either: a one-record append to the same
file takes about the same time with 1,000 partitions as with 100 (JavaScript
16 and 12 ms, .NET 23 and 14 ms; before, 57 and 16 ms, and 41 and 16 ms).

Opening reads only what the key needs: a short signed list of key-slot pages,
the one page that holds its slot, the header, and its own partitions' chunk
directories. So a client's open stays about the same however many keys the
file has: 1.4 ms in .NET with 1, 5,000 or 50,000 keys. The owner reads a
partition's directory the first time it reads that partition. The .NET
figures are steady-state; the first few calls in a new process include JIT
compilation.

### 15.5 Good to know

- **Keep each partition's rows together** (for example `sortedBy` the
  partition column). A chunk belongs to exactly one partition, so interleaved
  rows produce many tiny chunks. The partition column and the `sortedBy`
  columns must be in the default column group `*`, because every key needs
  them.
- **Revoking a key protects new versions only.** Every update writes fresh
  secrets, so a revoked key cannot open the new file. Copies of the old file
  that the person already has remain readable with their old key.
- **Hidden from key holders:** other partitions' rows, statistics and chunk
  directories, and the names and types of columns in groups they were not
  granted.
- **Not hidden from key holders:** the default group's column names and
  types, file metadata, how many partitions there are, and the size of each
  section. Do not put secrets in metadata or in the default group's column
  names.
- **Statistics:** scans skip chunks using their min/max statistics, as in
  ordinary files: a key's scans over its own partitions, and the owner's
  searches across all partitions.
- **Only the owner uses indexes**, because an index would reveal every
  partition's values. Access keys don't need them: their own rows are found
  directly.
- **Key delivery:** fetch the access key text from your secrets endpoint at
  start-up and pass it to `open` / `JazminAccessKey.Parse`. Never log it. The
  key's `id` (`bob.id`, `bob.Id`) is safe to log.

### 15.6 Sending records back to the owner

People in the field capture records, often offline, and the owner files them
into the shared file. Only the owner's key can change the shared file, so a
person sends their records back in a small file of their own:

- **The submission key:** each access key has one. It's sealed in that key's
  slot of the shared file, so a person gets it only by opening the shared file
  with their access key, plus the unlock token for an online grant
  (`reader.submissionKey`). The owner derives the same key from the owner key
  and the access key's id.
- **What a submitted file proves:** a file locked with that key was made by
  someone who opened the shared file with that access key. An access key that
  leaked, without the shared file, isn't enough to send anything.
- **Filing:** the owner checks that the sender still has a grant, opens the
  file with the sender's submission key, and appends its rows.
- **Safety:** the submission key opens nothing in the shared file. Neither
  the owner key nor the access key can be worked out from it.

```js
// The phone or field app (holds Bob's access key only): open the shared file, then send records back.
const key = open('shared.jzm', { key: bobKeyText }).submissionKey;    // in a browser: (await JazminBrowser.open(file, { key })).submissionKey
write(null, records, { columns, key });
// The filing service (holds the owner key), told the sender's key id with the upload:
accessKeyOf('shared.jzm', owner, keyId);                               // refuses a key with no grant
const sent = open(upload, { key: owner.submissionKey(keyId) });       // refuses a file made without the sender's key
append('shared.jzm', { key: owner, insert: [...sent.rows()].map((r) => ({ ...r, section: 'B' })) });
```

```csharp
var key = JazminReader.Open("shared.jzm", new JazminReadOptions { AccessKey = bob }).SubmissionKey;   // field app
JazminFile.AccessKeyOf("shared.jzm", owner, keyId);                                                  // filing service
using var sent = JazminReader.Open(upload, new JazminReadOptions { Key = owner.SubmissionKey(keyId) });
```

When filing:
- **Own rows only:** write each file's rows into the sender's own partition,
  whatever the file says, so a person can't file rows as someone else.
- **Records sent again:** give every record an id. A record whose id is
  already filed replaces the filed one, so corrections made on a phone reach
  the shared file.
  - **Last arrival wins:** if two people change the same record, the change
    that arrives last is kept.
  - **Who may change it:** anyone whose grant covers the record's partition.
    A change can't move a record to another partition.
  - **Send only what changed:** an empty value (`null`, not set, or `''`)
    leaves the field as it is, so a phone can't clear a field.
  - **Only what the sender can see:** columns the sender's grant doesn't
    cover are ignored, in new records too. So are columns the shared file
    doesn't have; the result names them (`ignoredColumns`).
  - **A file sent twice** changes nothing.
  - **The ready-made service** does this by default. Pass
    `onDuplicate: 'skip'` to keep the first version instead.
- **Revoked keys:** once a key is revoked, `accessKeyOf` no longer finds it,
  and its files are refused.
- **Keys that expire:** a file is filed only if it was both written and
  received before the key expired.
  - **Written:** `reader.writtenAt` comes from the phone's clock, which its
    owner can set to anything. So on its own it can't be trusted.
  - **Received:** your server's clock. This check is what actually stops a
    key that has expired.
  - **File each upload as it arrives:** the first write to the shared file
    after a key expires removes its grant. A file that arrived in time but is
    filed after that is refused as unknown.
- **Older shared files:** files written before submission keys existed have
  none (`submissionKey` is `null`) until the owner's next rewrite or
  `compact()`.

**Files with records** (photos, PDFs): a record can have several. The phone
embeds them in the file it sends, and lists each record's files in a `json`
column, `attachments` in the filing service:

```js
await JazminBrowser.write([
  { id: 'v-17', note: 'site visit', attachments: ['v-17/receipt.pdf', 'v-17/photo.jpg'] },
], { columns, key, files: [
  { path: 'v-17/receipt.pdf', content: receiptFile },
  { path: 'v-17/photo.jpg', content: photoFile },
] });
```

The filing service then:
- **Checks the list:** every file a record lists must be in the batch, and
  every file in the batch must be listed.
- **Checks the kind of file:** it reads each file's first bytes. Only PDF,
  JPEG, PNG and WebP are accepted by default; the name and type the phone
  gives are ignored.
- **Checks the size:** 10 MB per file and 50 MB per batch by default.
- **Stores each file** at a path it chooses,
  `attachments/<key id>/<sha256>.<ext>`. Only keys that see the record's
  partition can open it. Identical files are stored once.
- **Rewrites the list:** the record's `attachments` becomes
  `[{ path, name, type, size }]`, so a reader opens a file with
  `readFile(path)`.
- **When a record is changed:** to keep a file, leave its entry in the
  list, as it was read from the shared file. To add one, list its path in
  the batch. To remove one, leave it out. A file no record lists any more is
  removed from the shared file.

The design is in `docs/design/browser-writer.md`, and the spec's section 7.8
defines the key.

**Speed:** filing a batch takes about 20 to 25 ms, whether it holds 1 record or 50,
whether the shared file holds 10,000 records or 250,000, and with 1,000 people
about as with 100. The filing-service
README has the full figures.

**A ready-made filing service** is in `js/examples/filing-service`. Its
`fileBatch()` applies these rules, and `inbox.mjs` files every batch waiting in
a folder, then compacts the shared file. Run it on a schedule where the owner
key is kept. Writing these files in a browser is section 24.3.

## 16. Updating files

JAZMIN files are written once and **updated by rewriting**:

1. The file is streamed into a new version with your changes applied.
2. Indexes are rebuilt and the sort order is kept.
3. The new version replaces the original in one atomic step.

Readers never see a half-written file, and memory is bounded by the size of
your changes, not the size of the file. Measured: an update that inserted,
upserted and deleted a 274-row section of a 1.37M-row access-controlled file
took **3.0 s** with a **74 MB** process peak (Node.js).

| Change | JavaScript (`update`) | .NET (`JazminFile.Update`) |
|---|---|---|
| Add rows | `insert: [rows]` | `Insert = [rows]` |
| Replace rows with the same key (or add them) | `upsert: [rows], keyColumns: ['id']` | `Upsert = [rows], KeyColumns = ["id"]` |
| Remove rows | `delete: { status: 'void' }` | `Delete = JazminFilter.Eq("status", "void")` |
| Change metadata (merged) | `metadata: { ... }` | `Metadata = new JsonObject { ... }` |
| Access-controlled files | `grant`, `revoke` (or `grantAccess` / `revokeAccess`) | `Grant`, `Revoke` (or `GrantAccess` / `RevokeAccess`) |

```js
import { update } from '@smithsoft-studios/jazmin';

const result = update('statements.jzm', {
  key: owner,                                   // encrypted files need their key; access-controlled files need the OWNER key
  insert: [{ section: 'ACC000124', line: 0, amount: 10 }],
  upsert: [{ section: 'ACC000123', line: 4, amount: 99 }],
  keyColumns: ['section', 'line'],
  delete: { section: 'ACC000001' },
});
// { rowCount, inserted: 1, updated: 1, deleted: 274 }
```

```csharp
var result = JazminFile.Update("statements.jzm", new JazminUpdate
{
    Key = owner,
    Insert = [new Dictionary<string, object?> { ["section"] = "ACC000124", ["line"] = 0L, ["amount"] = 10.0 }],
    Upsert = [new Dictionary<string, object?> { ["section"] = "ACC000123", ["line"] = 4L, ["amount"] = 99.0 }],
    KeyColumns = ["section", "line"],
    Delete = JazminFilter.Eq("section", "ACC000001"),
});
```

Rules:

- **Sorted files stay sorted.** With `sortedBy`, new rows are merged into place.
  A row whose sort column changes moves to its new position.
- **Only the owner can update an access-controlled file.** An access key gets
  *"Only the file owner's master key can modify this file"*. Grants carry over
  unless revoked.
- **Encrypted and password files keep their protection.** Pass the same key
  or password; the PBKDF2 iteration count is kept.
- **If anything fails, the original file is untouched** and the temporary
  file is removed.
- **For frequent changes, use `append()`** (section 17). It is far cheaper
  than a rewrite and works while readers have the file open.
- **Readers that have the file open keep reading the version they opened,**
  on Windows too. They see the new version once they open the file again.
  - **On Windows,** a program that holds the file without allowing it to be
    renamed (some editors and backup tools do) still blocks a rewrite. You
    get a clear error, and the original file is untouched.
  - **JavaScript on Windows** replaces an open file in two quick steps,
    because Node has no single-step way: for an instant the file's name is
    missing, so a program opening it at that moment may not find it. .NET
    replaces it in one step.

## 17. Appending: fast, frequent changes

`update()` rewrites the whole file (section 16). For frequent changes, use
**`append()`** instead:

- Changes are added to the end of the file, and existing bytes are never
  touched.
- The cost depends on the size of the change, not the file.
- Readers that already have the file open keep working, on Windows too.

You decide when to tidy up with **`compact()`**, or let `autoCompact` do it at
a threshold you choose.

| | `update()` (rewrite) | `append()` | `compact()` |
|---|---|---|---|
| Cost | Whole file | Size of the change | Whole file |
| Change one section of the 1.37M-row file | 2.7 s | **63 ms** | — |
| Insert in the middle of a sorted file | Yes | No: appended rows must sort after existing rows | — |
| Deleted/replaced rows | Removed | Marked deleted (skipped by readers) | Removed |
| Revoke access, or narrow a grant | Yes (fresh secrets) | No | Yes (fresh secrets) |
| File size | Minimal | Grows with every append | Back to minimal |
| Works while readers have the file open | Yes: they keep the version they opened | **Yes** | Yes: they keep the version they opened |

### 17.1 JavaScript

```js
import { append, compact, open } from '@smithsoft-studios/jazmin';

const result = append('statements.jzm', {
  key: owner,                                     // the owner key for access-controlled files
  insert: newLines,                               // in a sortedBy file: must sort after existing rows
  upsert: corrections, keyColumns: ['section', 'line'],
  delete: { section: 'ACC000001' },
  autoCompact: { appends: 20, deletedRatio: 0.25 }, // optional: compact when either is reached
});
// { rowCount, inserted, updated, deleted, appendCount, deletedRowCount, compacted }

const r = open('statements.jzm', { key: owner });
r.appendCount;       // appends since the last full write
r.deletedRowCount;   // rows waiting to be removed by compact()
r.writtenAt;         // a Date: the last append, or when the file was written; by the writer's clock
r.close();

compact('statements.jzm', { key: owner });         // { rowCount, bytesBefore, bytesAfter }
compact('visits.jzm', { key: owner, regroup: true }); // access-controlled: each partition's rows together (17.4)
```

### 17.2 .NET

```csharp
var result = JazminFile.Append("statements.jzm", new JazminAppend
{
    Key = owner,
    Insert = newLines,
    Upsert = corrections, KeyColumns = ["section", "line"],
    Delete = JazminFilter.Eq("section", "ACC000001"),
    AutoCompact = new JazminAutoCompact(Appends: 20, DeletedRatio: 0.25),
});

using (var r = JazminReader.Open("statements.jzm", new JazminReadOptions { Key = owner }))
    Console.WriteLine($"{r.AppendCount} appends, {r.DeletedRowCount} deleted rows waiting, last written {r.WrittenAt}");

var compacted = JazminFile.Compact("statements.jzm", owner);   // RowCount, BytesBefore, BytesAfter
JazminFile.Compact("visits.jzm", owner, regroup: true);         // each partition's rows together (17.4)
```

### 17.3 Good to know

- **File growth.** Each append writes only what changed: the new rows, a
  chunk directory for each partition it added rows to, and a small new header.
  Key slots are written again only when grants or partitions change. On a file
  with 5,000 chunks that is under 1 KB per append, on top of the data.
  - **Many appends:** the header also lists every earlier append's
    directories, so what an append adds grows with the appends since the
    last compaction. In a test with one-row appends, the 600th append
    added 2.2 KB to an encrypted file, and 25 KB to an access-controlled
    file with 50 partitions.
  - **Deleted rows** keep their space until `compact()`.
  - **So pick an `autoCompact` threshold** that suits how often you append
    and delete. For example, `appends: 100` keeps both in check.
- **Crash safety.** If the process dies during an append, readers ignore the
  incomplete part and use the previous version (`reader.recovered` is
  `true`). The next append removes the incomplete part. A failed append, for
  example one with an invalid row, leaves the file exactly as it was.
- **One writer at a time.** `append`, `update` and `compact` take a lock file
  (`statements.jzm.lock`) while they work. A second writer gets *"Another
  writer is changing ..."*. If a writer process was killed, delete the stale
  lock file.
- **Readers see the version they opened.** Open a new reader to see the
  latest changes.
- **Revoking access** needs `compact()` or `update()`, because only a full
  rewrite re-locks the file with fresh secrets. New grants can be added with
  `append`, and existing ones widened.
- **Narrowing a grant** also needs `compact()` or `update()`. Narrowing means
  fewer partitions, column groups or file groups, a new or earlier expiry, or
  offline to online. An append keeps the file's secrets, and the key already
  holds them, so it could still read the new data. `append` refuses with
  *"The grant for … is narrower than before"*.

### 17.4 Regrouping partitions

In an access-controlled file, each append starts new chunks: a chunk holds
one partition's rows from one append. When many people sync small batches
all day, a person's rows end up in hundreds of small chunks. `compact()`
keeps the rows in file order, so it keeps those chunks too.

`compact({ key, regroup: true })` writes each partition's rows together
instead, in their file order. Each partition then spans as few chunks as its
rows need. `reader.advise()` suggests it when partitions are spread out
(section 25.1).

A simulated year of syncs, with 50 people, 3 syncs a day for 250 days, and
4 rows per sync (150,000 rows, 37,500 appends):

| | Compacted | Compacted with `regroup` |
|---|---:|---:|
| File | 7,241 KB, 37,500 chunks | 538 KB, 50 chunks |
| One person's rows (3,000) | 125 KB read, 23 ms | 10 KB read, 2 ms |
| One person's month | 58 KB read | 11 KB read |

- **The compaction itself** took 0.8 seconds.
- **Sort order:** regrouping needs a file without `sortedBy`, or one sorted
  by the partition column first (then rows are already grouped). Otherwise
  it would break the sort order, and it refuses.

## 18. Time-limited access

Give each access key its own access period, and choose per key how strictly it
is enforced:

| Mode | How it works | Works offline | Strength |
|---|---|---|---|
| **offline** (default) | The expiry is sealed and signed inside the key's slot. The library refuses after it, and also refuses if the clock looks wound back | Yes | Stops honest users and casual clock changes |
| **online** | Opening also needs an **unlock token** from your key service, which issues it only before the expiry | No (one request per open) | Nobody can open the file after expiry |

Example: user1 for 2 hours, user2 for 2 weeks (online), user3 for 5 years.

### 18.1 JavaScript / TypeScript

```js
import { JazminUnlockRequiredError, inspect, issueUnlockToken, open, write } from '@smithsoft-studios/jazmin';

write('statement.jzm', rows, {
  key: owner,
  access: {
    grants: [
      { key: user1, expiresIn: '2h', label: 'user1' },
      { key: user2, expiresIn: '14d', mode: 'online', label: 'user2' },
      { key: user3, expiresIn: '5y', label: 'user3' },          // or expires: '2031-10-01T00:00:00Z'
    ],
  },
});

// Client with an online key: ask your key service for a token when needed.
try {
  reader = open('statement.jzm', { key: user2Text });
} catch (e) {
  if (!(e instanceof JazminUnlockRequiredError)) throw e;
  const token = await myApi.unlockToken(e.fileId, e.keyId);   // your endpoint
  reader = open('statement.jzm', { key: user2Text, unlockToken: token });
}
reader.access.expires;   // '2026-10-15T08:00:00.000Z'

// Key service (holds the owner key, or tokens it stored with listUnlockTokens):
const token = issueUnlockToken('statement.jzm', owner, keyId);  // throws JazminAccessExpiredError after expiry
inspect('statement.jzm').fileId;                                // readable without any key
```

### 18.2 .NET

```csharp
new JazminAccessOptions
{
    Grants =
    [
        new JazminGrant(user1) { ExpiresIn = TimeSpan.FromHours(2), Label = "user1" },
        new JazminGrant(user2) { ExpiresIn = TimeSpan.FromDays(14), Mode = JazminGrantMode.Online, Label = "user2" },
        new JazminGrant(user3) { Expires = DateTimeOffset.UtcNow.AddYears(5), Label = "user3" },
    ],
};

try
{
    using var reader = JazminReader.Open(path, new JazminReadOptions { AccessKey = user2 });
}
catch (JazminUnlockRequiredException e)
{
    var token = await myApi.GetUnlockTokenAsync(e.FileId, e.KeyId);
    using var reader = JazminReader.Open(path, new JazminReadOptions { AccessKey = user2, UnlockToken = token });
}

// Key service:
var token = JazminFile.IssueUnlockToken(path, ownerKey, keyId);   // JazminAccessExpiredException after expiry
var all = JazminFile.ListUnlockTokens(path, ownerKey);            // KeyId, Label, Expires, Token
var fileId = JazminFile.Inspect(path).FileId;
```

### 18.3 How winding the clock back is caught (offline keys)

1. **The file's signed date.** If the clock reads earlier than when the file
   was written, the file is refused. That date is covered by the owner's
   signature, so it can't be edited.
2. **A last-seen record per user, file and key.** It is kept in
   `%LOCALAPPDATA%\Jazmin\access-state` (Windows) or `~/.jazmin/access-state`.
   If the clock reads earlier than the last access, the file is refused with
   *"Clock rollback detected"*. The record is protected with the access key,
   so editing it is detected. JavaScript and .NET share the same record.
   - JS `accessState: { dir }`, or .NET `AccessState = new JazminDirectoryAccessStateStore(dir)`,
     moves the record. A custom store can keep it in your own database.
   - JS `accessState: false`, or .NET `CheckClockRollback = false`, turns this
     check off. Your application decides this, not the end user.
3. **5 minutes of tolerance** in each check allows for ordinary clock
   differences.

**Why the record isn't kept in the file:**
- a user could replace the file with an older copy, which would reset the
  record;
- readers would need permission to write to a shared, signed file;
- files on read-only drives couldn't be updated at all.

Kept with the user, the record survives swapping copies of the file.

### 18.4 What it does and doesn't guarantee

- **Expired keys are cut off from new versions.**
  - A full update or compaction removes expired grants and re-locks the file
    with fresh secrets, so a lapsed key can't open any version written after
    its expiry.
  - An append removes their key slots too, but keeps the existing secrets, so
    run a compaction when you need the complete cut-off.
- **Offline expiry relies on the reader.** Someone who deletes their
  last-seen record and winds the clock back, or who runs modified software,
  can still open a copy they already have. Use online mode when that matters.
- **Online expiry stops keys that have no token yet.** After the expiry the
  key service issues no more tokens. A token obtained before the expiry still
  opens the copies of the file it was issued for, by anyone who sets the
  reader's clock option (`now`, .NET `Now`; deprecated, removed in 2.0)
  back or uses modified software,
  until the owner rewrites the file. For a complete cut-off, compact or
  update the file after the expiry, or revoke the key. A rewrite drops
  expired grants and re-locks the file.
- **The owner key is never time-limited.**

### 18.5 Adding 2FA to online access

Online grants already need an unlock token from your key service. You can make
that service require a code from an authenticator app before it issues a token,
so a stolen access key alone is not enough to open the file.

The sample in `dotnet/samples/Jazmin.KeyService` does this with TotpAuthSharp:
enrolment by QR code, replay protection (each code works once), and a lockout
after repeated wrong codes. See its README for the endpoints and the
production checklist.

| Access type | Needs | Works offline |
|---|---|---|
| Offline | Access key | Yes |
| Online | Access key + unlock token | No |
| Online + 2FA | Access key + unlock token, issued only after a valid code | No |

2FA is a rule in your key service, not in the file, so it doesn't apply to
offline grants.

## 19. Embedded files

A JAZMIN file can also store files: HTML, scripts, styles, fonts, images,
audio, video, PDFs, or any other bytes. Typical uses:

- invoices attached to statement data;
- a template that renders the data as a page;
- logos for each client.

Files that store none are unchanged.

- **Stored once.** Identical bytes are stored a single time, however many
  paths or groups refer to them. Adding the same path twice is an error.
- **Stored in blocks** of 256 KiB, so you can read part of a large file (for
  example to seek in a video) without loading it all.
- **Per key, in access-controlled files.** Each file lists the groups that may
  see it:

| File | `groups` | Seen by |
|---|---|---|
| `index.html` | default (`*`) | everyone with a key to the file |
| `appendix.html` | `['A', 'B']` | keys for partitions A or B |
| `img/logoD.png` | `['D']` | keys for partition D only |
| `docs/terms.pdf` | `['A', 'B', 'C', 'D']` | A, B, C and D |
| `img/template.svg` | `['template']` | keys granted `files: ['template']` |

A key never learns the names of files it cannot see.

### 19.1 JavaScript

```js
import { append, open, write } from '@smithsoft-studios/jazmin';

write('statements.jzm', rows, {
  key: owner,
  files: [
    { path: 'index.html', content: html, actions: { pdf: { format: 'A4', margin: { top: '15mm' } } } },
    { path: 'docs/terms.pdf', file: './terms.pdf', groups: ['A', 'B', 'C', 'D'] },
    { path: 'img/logoD.png', file: './logoD.png', groups: ['D'], actions: { save: false } },
  ],
  package: { entry: 'index.html', title: 'Statement', pdf: { format: 'A4' } },   // settings for viewers
  access: { partitionBy: 'client', grants: [{ key: clientD, rows: ['D'] }, { key: designer, rows: [], files: ['template'] }] },
});

const r = open('statements.jzm', { key: clientDText });
r.files;                                   // [{ path, type, size, sha256, actions? }] this key can see
r.readFile('img/logoD.png');               // Buffer (checked against its SHA-256)
r.readFileRange('docs/terms.pdf', 0, 1024);
r.openFile('docs/terms.pdf').pipe(res);    // a stream, block by block

append('statements.jzm', { key: owner, addFiles: [{ path: 'news.html', content: news }], removeFiles: ['old.html'] });
```

### 19.2 .NET

```csharp
using var writer = JazminWriter.Create("statements.jzm", columns, new JazminWriteOptions
{
    Key = owner,
    Files =
    [
        new JazminFileInput("index.html", htmlBytes)
        {
            Actions = new JazminFileActions { PdfSettings = new JazminPdfSettings { Format = "A4", Margin = new JazminPdfMargin { Top = "15mm" } } },
        },
        JazminFileInput.FromFile("docs/terms.pdf", "terms.pdf", groups: ["A", "B", "C", "D"]),
        new JazminFileInput("img/logoD.png", logoD) { Groups = ["D"], Actions = new JazminFileActions { Save = false } },
    ],
    Package = new JazminPackage { Entry = "index.html", Title = "Statement", Pdf = new JazminPdfSettings { Format = "A4" } },
});

using var reader = JazminReader.Open("statements.jzm", new JazminReadOptions { AccessKey = clientD });
foreach (var f in reader.Files) Console.WriteLine($"{f.Path} {f.Size} {f.Actions?.Save}");
byte[] logo = reader.ReadFile("img/logoD.png");
using Stream pdf = reader.OpenFile("docs/terms.pdf");   // seekable, decodes one block at a time

JazminFile.Append("statements.jzm", new JazminAppend { Key = owner, AddFiles = [new JazminFileInput("news.html", news)], RemoveFiles = ["old.html"] });
```

### 19.3 Good to know

- **Appends** keep existing files by reference. A replaced or removed file
  keeps its space until `compact()`.
- **`update()` and `compact()`** store the files again under fresh keys, and
  drop anything no longer referenced.
- **`package` settings** (entry page, title, allowed https origins, WebAssembly)
  are guidance for viewers. A viewer must treat stored files as untrusted
  content: see the proof of concept in
  `js/poc/self-contained-html` and its findings.
- **Already-compressed files** (JPEG, PNG, MP4, PDF) are stored as they are.
  Compressing them would not help.
- **What viewers may do with each file** (`actions`, format 1.4), set when
  the file is added. Each is allowed when left out:

| Action | Viewers offer | Example: `false` for |
|---|---|---|
| `open` | showing the file | a data file only the document reads |
| `save` | saving (downloading) the file as it is | a logo, a script |
| `print` | printing the page | an on-screen dashboard |
| `pdf` | saving the page as PDF; page settings instead of `true` set its page | a page that isn't print-ready |
| `image` | saving the page as an image | a long statement |

  - **They steer viewers, they don't lock the file.** Someone with a key that
    sees a file can always read it with the library. To keep a file from a
    key, use groups (above).
  - **Page settings** (`package.pdf` for the document, `actions.pdf` for one
    page): `format` (`A0`-`A6`, `Letter`, `Legal`, `Tabloid`, `Ledger`),
    `landscape`, `margin` (`{ top, right, bottom, left }`, such as `'12mm'`,
    `'0.5in'`), `scale` (0.1-2), `printBackground`, and `preferCSSPageSize`
    (the page's CSS `@page` size wins). A writer refuses anything else, so a
    file never holds settings a browser would reject.
  - **Older libraries** (1.0-1.3) read these files and ignore both settings,
    but drop them when they append to or update the file.

### 19.4 On a server: serving files and rendering PDFs

**Serving a file's embedded files** to browsers or apps, for example the
invoices, photos or videos stored with the records:

```js
import http from 'node:http';
import { open, serveFiles } from '@smithsoft-studios/jazmin';

const reader = open('claims.jzm', { key: accessKey });   // what this key can see is what is served
const files = serveFiles(reader, { prefix: '/files/' });
http.createServer((req, res) => files(req, res, () => { res.writeHead(404); res.end(); })).listen(8080);
// GET /files/claims/CL-0015/photo-1.png; Express: app.use(files)
```

- **Byte ranges** (`Range: bytes=…`, one range per request) are served
  from the blocks they fall in, so a video can be streamed and sought without
  reading the whole file. Whole files stream block by block.
- **Caching:** each file's ETag is its SHA-256, so an unchanged file is
  answered with 304.
- **Only what the key can see:** other files are 404, as if absent.
- **Pages and SVG are sandboxed:** they get the document's security policy
  (section 24.1) and a sandbox, so a file's page served from your site cannot
  act as your site (read its cookies, call its APIs). To show a document,
  open the `.jzm` in the viewer instead.
- **Your own server, interception or tests:** `createFileHandler(reader)`
  gives `handle(path, { method, range, ifNoneMatch })` →
  `{ status, headers, body, stream() }` without a server.

**Rendering a document to PDF.** `renderPdf` opens the file's document (its
package's entry page) in a browser you supply, gives it the viewer's
`window.jazmin` API (section 24.1), answered from the file, and prints it.
The same template therefore serves the viewer and batch PDFs.

```js
import { chromium } from 'playwright';                  // or: import puppeteer from 'puppeteer'
import { renderPdf } from '@smithsoft-studios/jazmin';

const browser = await chromium.launch();                  // or: await puppeteer.launch()
for (const account of accounts) {
  const pdf = await renderPdf({ file: `statements/${account}.jzm`, key, browser, pdf: { format: 'A4' } });
  fs.writeFileSync(`out/${account}.pdf`, pdf);
}
await browser.close();
```

- **The browser is yours:** a Playwright or Puppeteer browser (Chromium).
  The library itself still needs no packages.
- **When it prints:** when the document calls `jazmin.ready()`. For a page
  that never does, pass `waitFor: 'load'`. After `timeout` (30 s) it gives up
  with an error.
- **Locked down:** each document gets a browser context of its own (no
  cookies or storage shared). It can reach only its own files and its
  package's allowed origins: every other request, including to your
  internal network, is refused.
- **Downloads** the document makes (`jazmin.download`) come to
  `onDownload({ filename, type, bytes })`; what it passes to `jazmin.ready()`
  comes to `onReady(info)`.
- **Print mode:** the document sees `jazmin.mode === 'print'` (`'view'` in a
  viewer), so it can show every row and hide its buttons and filters.
- **One PDF per account from one file:** `filter` limits the rows the
  document sees (and tells it, as `jazmin.filter`):

```js
for (const account of ['A1', 'A2', 'A3']) {
  const pdf = await renderPdf({ file: 'statements.jzm', key, browser, filter: { account } });
  fs.writeFileSync(`out/${account}.pdf`, pdf);
}
```

- **Page settings,** each over the ones before: A4 with backgrounds;
  `pdfDefaults` (your paper size for documents that don't set one); the
  package's (`package.pdf`); the page's file's (`actions.pdf`); what the
  page set with `jazmin.setActions({ pdf })`; and `pdf` here. `renderPdf`
  renders a page whose file says `pdf: false`: you hold the key, and decide.
- **Settings from a page** (what it passes to `jazmin.savePdf`, say) are
  untrusted: pass them through `checkPageSettings(settings)` before using
  them as `pdf`. It returns a clean copy with only the page settings, or
  throws, so a page can't hand the browser other options.
- **An image instead:** `renderImage({ file, key, browser, viewport: { width:
  1200, height: 800 } })` gives a PNG of the whole page (`image: { type:
  'jpeg', quality: 80 }` for JPEG).
- **The document as one HTML file**, without a browser:
  `portableHtml('statement.jzm')` gives the viewer's "Save as HTML" page
  (section 24): the viewer with the `.jzm` inside, still encrypted, which
  asks for the key when opened.
- **Measured** with the test template (120 rows, 4 queries, an image, a file):
  about 0.3-0.5 s per PDF in Chrome, browser already running.

**ASP.NET Core** (the `Jazmin.AspNetCore` package) serves embedded files the
same way, from an endpoint:

```csharp
using Jazmin;
using Jazmin.AspNetCore;

// /docs/42/invoices/2026-03.pdf: that embedded file of statements/42.jzm, read with this person's access key.
app.MapJazminFiles("/docs/{id}", async context =>
{
    var id = (string)context.Request.RouteValues["id"]!;
    var key = await keys.AccessKeyFor(context.User, id);    // your lookup; null: 404
    return key is null ? null : new JazminFileSource($"statements/{id}.jzm", new JazminReadOptions { AccessKey = key });
}).RequireAuthorization();
```

- **Each request opens the file with the key** the resolver returns, so it
  is served only what that key can see (404 otherwise). A key that cannot
  open the file (wrong, expired, revoked) answers 403.
- **Byte ranges, HEAD and 304s** come from ASP.NET's own file handling,
  over a stream that decodes one 256 KiB block at a time.
- **Pages and SVG** get the same policy and sandbox as in JavaScript;
  `new JazminFilesOptions { Sandbox = false, Origin = "https://files.example.com" }`
  turns the sandbox off for files served from an origin of their own.
- **PDFs from .NET:** not built in. Render them with `renderPdf` from
  JavaScript (above).

### 19.5 Editable documents: changes made in the document

A document can let people change the rows it shows: change them, add some,
delete some (format 1.4). The template's author says what may change, in the
package:

```js
write('claims.jzm', claims, {
  key: owner, access: { partitionBy: 'region', grants },
  files: templateFiles,
  package: { entry: 'index.html', edit: { key: ['claim'], columns: ['status', 'note'], add: true, delete: false } },
});
```

- **`key`**: the columns that identify a row. **`columns`**: what a change may
  set. **`add`**, **`delete`**: whether rows may be added or deleted. Nothing
  else can be changed through the document.
- **Where the changes go:**
  - **A file of your own** (not shared), opened with its key: written into it.
  - **A shared file:** each person works on their own copy. Their changes go
    back to the owner in a **change file**, sealed with their submission key
    (section 15.6), and the owner applies it.

```js
// The person (in an app; viewers do this for the document): a change file, with the values they saw.
const mine = open('claims.jzm', { key: bobKeyText });
const change = writeChanges(mine, {
  update: [{ claim: 'C-104', status: 'approved', note: 'Photos checked' }],   // the key, and what changes
  add: [{ claim: 'C-900', status: 'open' }],
});
// The owner: applies it. The sender is found by their submission key.
const result = applyChanges('claims.jzm', change, { key: owner });
// { sender: 'bob's key id', updated: 1, added: 1, deleted: 0, conflicts: [], refused: [] }
```

```csharp
// .NET: the same change files, both ways.
Package = new JazminPackage { Entry = "index.html", Edit = new JazminEditSettings { Key = ["claim"], Columns = ["status", "note"], Add = true } };

using var mine = JazminReader.Open("claims.jzm", new JazminReadOptions { AccessKey = bob });
byte[] change = JazminFile.WriteChanges(mine, new JazminChanges
{
    Update = [new Dictionary<string, object?> { ["claim"] = "C-104", ["status"] = "approved" }],
});
var result = JazminFile.ApplyChanges("claims.jzm", change, new JazminApplyChangesOptions { Key = owner });
foreach (var c in result.Conflicts) Console.WriteLine($"{c.Kind}: {string.Join(", ", c.Key.Values)}");
```

- **Checked again when applied:** what the document allows *now* (the owner
  can narrow or withdraw `edit` at any time), and in a shared file the
  sender's grant: only its partitions and columns. An added row without its
  partition goes into the sender's one partition. Changes that aren't allowed
  are **refused**, with the reason.
- **Rows changed since the sender's copy are held:** a change file carries the
  values the sender saw. If the row has changed since (someone else's change
  applied first), the change is held as a **conflict** and reported with the
  value before, the value wanted and the value now. So are an added row whose
  key is already there and a change to a row that's gone. The owner decides:
  `applyChanges(file, change, { key: owner, overwrite: true })` applies them.
- **`dryRun: true`** shows what would happen without writing. **`keyId`**
  names the sender when you know it (otherwise each grant is tried), and
  **`receivedAt`** is when the change file arrived, checked against the
  sender's expiry as in section 15.6.

## 20. Speed and memory: practical recipes

The examples below use a statements file of transactions, sorted by account:

| Column | Type |
|---|---|
| `account` | string |
| `line` | int |
| `date` | datetime |
| `description` | string |
| `amount` | float |
| `balance` | float |
| ...many more | |

They show the patterns that keep reads fast and memory flat, whatever the
file size.

### 20.1 Write once, sorted

```js
import { JazminWriter } from '@smithsoft-studios/jazmin';

// Rows arrive from your database cursor one at a time; memory stays at one chunk.
const writer = new JazminWriter('statements.jzm', {
  columns: [
    { name: 'account', type: 'string', nullable: false },
    { name: 'line', type: 'int', nullable: false },
    { name: 'date', type: 'datetime' },
    { name: 'description', type: 'string', index: 'trigram' },  // for text search
    { name: 'amount', type: 'float' },
    { name: 'balance', type: 'float' },
  ],
  sortedBy: ['account', 'line'],   // lets lookups by account skip straight to the right chunks
  maxDegreeOfParallelism: 2,       // chunks compressed on 2 worker threads (the default); 1 = this thread only
});
for await (const row of cursor) writer.writeRow(row);
writer.finish();
```

```csharp
using var writer = JazminWriter.Create("statements.jzm", columns, new JazminWriteOptions
{
    SortedBy = ["account", "line"],
    MaxDegreeOfParallelism = 8,          // chunks compressed on 8 threads; 1 = calling thread only
});
await foreach (var line in repository.StreamLinesAsync())
    writer.WriteValues(line.Account, line.Line, line.Date, line.Description, line.Amount, line.Balance);
writer.Finish();
```

**Why sorted:** each chunk records the smallest and largest `account` it
contains. A query for one account reads only the one or two chunks that can
contain it. No index is needed, and the file opens in milliseconds.

### 20.2 Read one section, with only the columns you need

```js
import { open } from '@smithsoft-studios/jazmin';

const r = open('statements.jzm');
const lines = [...r.find(
  { account: 'ACC000123' },
  { select: ['date', 'description', 'amount'] },   // other columns are never decoded
)];
r.close();
```

```csharp
using var reader = JazminReader.Open("statements.jzm");
var lines = reader.Find(JazminFilter.Eq("account", "ACC000123"),
        new JazminQueryOptions { Select = ["date", "description", "amount"] })
    .Select(r => new { Date = (DateTime)r["date"]!, Text = (string?)r["description"], Amount = (double?)r["amount"] })
    .ToList();
```

Each column is stored separately inside a chunk. A
query decodes only the columns it filters on and the ones it selects. On a
300-column file, summing 3 columns is about 10× faster than reading
whole rows.

A selective filter is cheap even when it returns whole rows. The other
columns are decoded only for chunks with matching rows, and their text,
decimal, json and binary values only for the matching rows. In Node, when
only a few rows of a chunk match, only their values are decoded at all
(section 9.8). On 2.5M order
lines, returning every column of 2,474 lines for one product takes 344 ms
in Node and 231 ms in .NET.

### 20.3 Stream large results; don't collect them

```js
// Constant memory: one chunk at a time.
let total = 0;
for (const row of r.find({ account: { startsWith: 'ACC00' } }, { select: ['amount'] })) total += row.amount;
```

```csharp
// .NET: typed streaming, straight from the column arrays (no boxing, no row arrays).
var serializer = new JazminSerializer();
await using var stream = File.OpenRead("statements.jzm");
foreach (var line in serializer.DeserializeEnumerable<StatementLine>(stream))
    Process(line);                          // only the properties StatementLine has are decoded
```

`ToList()`, `[...rows]` and `DeserializeObject<List<T>>` hold everything in
memory. That is fine for thousands of rows, but stream instead for millions.

### 20.4 Choose memory or speed first (`priority`)

One setting decides what reading and writing favour where memory and speed
pull apart: how many threads work at once, and how far a scan decodes
ahead. The file written and the rows read are the same whichever you choose.

```js
// JavaScript: 'memory' | 'balanced' (the default) | 'speed'
const reader = open('statements.jzm', { priority: 'speed' });
const writer = new JazminWriter('statements.jzm', { columns, priority: 'memory' });
update('statements.jzm', { insert: rows, priority: 'speed' }); // append() too
```

```csharp
// .NET: JazminPriority.Memory | Balanced (the default) | Speed
using var reader = JazminReader.Open(path, new JazminReadOptions { Priority = JazminPriority.Speed });
using var writer = JazminWriter.Create(path, columns, new JazminWriteOptions { Priority = JazminPriority.Memory });
var settings = new JazminSerializerSettings { Priority = JazminPriority.Memory }; // JazminUpdate, JazminAppend too
```

| | `memory` | `balanced` (default) | `speed` |
|---|---|---|---|
| .NET reads | the calling thread only | up to 4 chunks decoded ahead, about 128 decoded columns in flight | up to 8 chunks ahead, about 1,024 columns in flight |
| .NET writes | the calling thread only | one thread per processor, up to 16 | as balanced: more threads did not write faster |
| Node writes | this thread only | up to 2 worker threads | as balanced: 4 threads were no faster than 2 |
| Node reads | this thread | this thread | the next chunks decompressed on worker threads while rows are built: up to 4, or 2 when a scan decodes more than a quarter of the columns |
| Export shapes over unsorted files (21.5) | batches of 100,000 rows | batches of 100,000 rows | batches of 1,000,000 rows: fewer passes over the file |
| Export shapes across tables (21.6) | linked tables of up to 10,000 rows held; otherwise batches of 2,500 parents | up to 100,000 rows held; batches of 10,000 | up to 1,000,000 rows held; batches of 20,000 |

Measured on 200,000 rows × 300 columns (20 cores; medians of 3 to 5 runs,
each in its own process, the modes taking turns; peak memory of the
process):

| | `memory` | `balanced` | `speed` |
|---|---:|---:|---:|
| .NET: sum 3 columns | 0.76 s, **49 MB** | 0.27 s, 54 MB | **0.19 s**, 65 MB |
| .NET: filter on 2 columns | 0.74 s, **49 MB** | 0.26 s, 54 MB | **0.19 s**, 65 MB |
| .NET: read every row | 2.33 s, 60 MB | 2.29 s, 60 MB | **2.10 s**, 95 MB |
| .NET: write | 11.2 s, **68 MB** | 4.3 s, 79 MB | 4.5 s, 82 MB |
| Node: sum 3 columns (`columnArrays`) | 0.66 s, **125 MB** | 0.66 s, 125 MB | **0.24 s**, 196 MB |
| Node: sum 3 columns (rows) | 0.67 s, **98 MB** | 0.67 s, 98 MB | **0.24 s**, 166 MB |
| Node: filter on 2 columns | 0.70 s, **96 MB** | 0.70 s, 96 MB | **0.23 s**, 162 MB |
| Node: read every row | 4.80 s, **226 MB** | 4.80 s, 226 MB | **4.34 s**, 256 MB |
| Node: write | 19.6 s, **233 MB** | 15.0 s, 257 MB | as balanced |

- **`memory`** suits small servers, and many files read or written at the
  same time: each reader's or writer's threads hold chunks of their own.
  Narrow .NET queries become about 3 times slower. Node reads already use
  only the main thread unless you choose `speed`.
- **`speed`** suits one big job on a machine with memory to spare. Queries
  of a few columns: Node about 2.8 times as fast, .NET about 30% faster.
  Full reads of wide tables: about 10% faster (they decode ahead too, for
  about 30 MB more). In Node, each chunk is decompressed whole even when a
  query needs 3 of its 300 columns, so that work is what the workers take
  over. Workers start from a scan's third chunk, so short scans and lookups
  never pay for them, and only for files with one column group (not
  access-controlled files).
- **Looking up rows by id** costs the same in every mode: it decodes one
  chunk.
- **A thread count you set yourself** (`maxDegreeOfParallelism`,
  `MaxDegreeOfParallelism`) wins over the priority.

```csharp
// The same as Priority = Memory for reads: decode on the calling thread only.
var lean = JazminReader.Open(path, new JazminReadOptions { MaxDegreeOfParallelism = 1 });
```

### 20.5 Keep Node.js memory low

JAZMIN keeps very little alive while it reads: about 11 MB for a full scan of
a 300-column file. Most of a Node process's memory is garbage the engine has
not yet collected. By default, V8 (Node's JavaScript engine) lets
short-lived objects pile up to about 64 MB before it collects them. On a
memory-constrained server, cap that with one Node option:

```bash
node --max-semi-space-size=8 render-statements.js
# or, for any way of starting Node:
NODE_OPTIONS=--max-semi-space-size=8 npm start
```

On the wide benchmark (1,000,000 rows × 300 columns), the option gave these
results, with no measurable slowdown:

| | Default | `--max-semi-space-size=8` |
|---|---:|---:|
| Read every row | 15.9 s, 204 MB | 16.1 s, **98 MB** |
| Sum 3 columns | 3.4 s, 121 MB | 3.2 s, 118 MB |
| Write | 87.1 s, 299 MB | 86.1 s, 302 MB |

Reads that create many objects gain the most. Writes do not gain, because
their memory is not short-lived garbage.

The setting applies to the whole process, so it also helps JSON parsing and
anything else your service does. Smaller values (1–4) collect so often
that full scans ran about 40% slower in our tests, so 8 is a good default.

### 20.6 Open once, query many times

```csharp
using var reader = JazminReader.Open("statements.jzm");   // header only: milliseconds, a few MB
foreach (var account in accountsToRender)
{
    var lines = reader.Find(JazminFilter.Eq("account", account)).ToList();
    await RenderPdfAsync(account, lines);
}
```

A reader is not thread-safe. Use one reader per thread, or open one per
request. Opening is cheap because the column statistics are only loaded for
the columns a query uses.

### 20.7 Look up by a second column

`sortedBy` makes one column fast to look up. For another column you search
by, such as a reference number in a file sorted by account, add a `sorted`
index:

```js
const writer = new JazminWriter('statements.jzm', {
  columns: [
    { name: 'account', type: 'string', nullable: false },
    { name: 'reference', type: 'string', index: 'sorted' },   // unique per line, millions of values
    { name: 'amount', type: 'float' },
  ],
  sortedBy: ['account'],
});
// ... writeRow ...
writer.finish();

const r = open('statements.jzm');
const [line] = r.find({ reference: 'TX-2025-000123456' });   // reads the index directory and one page
```

```csharp
var columns = new[]
{
    new JazminColumn("account", JazminType.String) { Nullable = false },
    new JazminColumn("reference", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
    new JazminColumn("amount", JazminType.Float),
};
using (var writer = JazminWriter.Create("statements.jzm", columns, new JazminWriteOptions { SortedBy = ["account"] }))
{
    // ... WriteValues ...
}
using var reader = JazminReader.Open("statements.jzm");
var line = reader.Find(JazminFilter.Eq("reference", "TX-2025-000123456")).FirstOrDefault();
```

An index over millions of values is stored in pages, so a
lookup reads only what it needs. These figures cover opening the file and
looking up one value, in Node:

| Rows (unique values) | Index in one piece (before format 1.0) | Index in pages |
|---|---:|---:|
| 1,000,000 | 149 ms, 189 MB, 7.6 MB read | **8.5 ms, 56 MB, 72 KB read** |
| 5,000,000 | 886 ms, 730 MB, 36 MB read | **10.6 ms, 58 MB, 110 KB read** |

Range queries (`gt`, `lt`...) and `startsWith` read only the pages they
span. Each reader keeps at most 8 decoded pages per index.

### 20.8 Memory checklist

| Do | Avoid |
|---|---|
| `sortedBy` on the column you look up by | Counting on an index there: statistics locate it, and the writers leave a `sorted` index on it out |
| `select` the columns you need | Reading whole rows of a wide table |
| Stream with `for…of`, `DeserializeEnumerable`, `await foreach` | `ToList()` / `[...rows]` on millions of rows |
| One reader per thread, reused | Opening the file for every row |
| `priority: 'memory'` (JS) / `Priority = JazminPriority.Memory` (.NET) on very small servers, or with many files open at once (20.4) | Many readers and writers each running their own threads on a 2-core container |
| Node: `--max-semi-space-size=8` on memory-limited servers | Judging memory by the default heap growth (mostly garbage awaiting collection) |

### 20.9 Measure on your own data

```bash
cd js && node bench/wide.js 1000000 300                      # rows, columns
cd dotnet && dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks -- wide 1000000 300
```

Each measurement runs in its own process and reports time and peak memory
(RSS) for JAZMIN and for streamed JSON. The files are kept so you can repeat
single steps.

---

## 21. Export shapes: nested JSON and XML

A JAZMIN file holds rows. Often you need something else: one entry per
client, with that client's transactions and totals. An **export shape** is a
small JSON template that describes the output you want. You can use the same
shape in JavaScript and .NET, and get the same result.

- **Checked up front.** A shape that names a column the file does not have,
  or that your key cannot see, is rejected before any data is read. The error
  says where the mistake is, for example
  `Shape at clients[].name: unknown or hidden column 'clientNme'`.
- **Repeated details are written once.** In a group of rows, a column gives
  the first row's value.
- **Memory stays low.** Each list is a query on the file. Only the columns
  the shape uses are decoded, and filters use indexes and statistics.

The full reference is [docs/design/export-shapes.md](design/export-shapes.md).

### 21.1 From flat rows to clients with their transactions

The file has one row per transaction:

| client | clientName | address | date | amount |
|---|---|---|---|---|
| C1 | ABC Corp | 10 Test Street | 2025-03-01 | 1000 |
| C2 | Test Ltd | 2 Test Place | 2025-03-02 | 20000 |
| C1 | ABC Corp | 10 Test Street | 2025-03-04 | 250.5 |

```js
import { open, toJSON, toXML, exportFile } from '@smithsoft-studios/jazmin';

const shape = {
  title: { $meta: 'title' },                       // a metadata member of the file
  clients: {
    $rows: {
      id: 'client',                                // a column: in a group, the first row's value
      name: 'clientName',
      address: 'address',
      balance: { $sum: 'amount' },                 // totals over the group's rows
      lines: { $count: true },
      transactions: { $rows: { date: 'date', amount: 'amount' }, $sort: ['date'], $xmlItem: 'transaction' },
    },
    $groupBy: 'client',                            // one entry per client
    $xmlItem: 'client',
  },
  total: { $sum: 'amount' },
};

const reader = open('statements.jzm');
console.log(toJSON(reader, { shape, pretty: true }));
exportFile(reader, 'xml', 'statements.xml', { shape });                         // streamed to disk
console.log(toJSON(reader, { shape, filter: { client: 'C1' } }));               // one client only
```

```csharp
using Jazmin.Formats;

var shape = JazminShape.Parse(File.ReadAllText("statement-shape.json"));       // the same JSON as above
using var reader = JazminReader.Open("statements.jzm");
shape.Validate(reader);                                                         // optional: fail early
Console.WriteLine(shape.ToJson(reader, indented: true));
using (var xml = File.CreateText("statements.xml")) shape.WriteXml(reader, xml); // streamed to disk
Console.WriteLine(shape.ToJson(reader, JazminFilter.Eq("client", "C1")));      // one client only
```

JSON output:

```json
{
  "title": "March statements",
  "clients": [
    { "id": "C1", "name": "ABC Corp", "address": "10 Test Street", "balance": 1250.5, "lines": 2,
      "transactions": [ { "date": "2025-03-01T00:00:00.000Z", "amount": 1000 },
                        { "date": "2025-03-04T00:00:00.000Z", "amount": 250.5 } ] },
    { "id": "C2", "name": "Test Ltd", "address": "2 Test Place", "balance": 20000, "lines": 1,
      "transactions": [ { "date": "2025-03-02T00:00:00.000Z", "amount": 20000 } ] }
  ],
  "total": 21250.5
}
```

XML output: members become elements, and list items use `$xmlItem`.

```xml
<export>
  <title>March statements</title>
  <clients>
    <client>
      <id>C1</id>
      <name>ABC Corp</name>
      ...
      <transactions>
        <transaction><date>2025-03-01T00:00:00.000Z</date><amount>1000</amount></transaction>
        ...
```

### 21.2 What a shape can contain

| In the shape | Gives | Where |
|---|---|---|
| `"column"` | The column's value. In a set of rows, the first row's value | anywhere |
| `12`, `true`, `null` | That literal | anywhere |
| `{ "$value": "text" }` | A constant, which can be any JSON (use it for literal text) | anywhere |
| `{ "$meta": "title" }` | A metadata member of the file | anywhere |
| `{ ... }` | A nested object | anywhere |
| `{ "$count": true }` | Number of rows | in a set |
| `{ "$sum": "c" }`, `{ "$min": "c" }`, `{ "$max": "c" }` | Total, smallest, largest (null if there are no values) | in a set |
| `{ "$rows": ... }` | A list | in a set |
| `{ "$from": "table", "$on": { ... }, "$rows": ... }` | A list of rows from another table, linked to this row (21.6) | anywhere |
| `{ "$from": "table", "$on": { ... }, "$one": ... }` | The linked rows as one set: their first values and totals (21.6) | anywhere |

A **set** is the whole file (or the export's `filter`), or a group of a
`$groupBy` list. Inside a list without `$groupBy`, each item is **one row**,
so aggregates and nested lists are not allowed there.

List options:

| Option | Meaning |
|---|---|
| `$filter` | Only rows matching this filter (section 8). The filters of enclosing lists and groups apply too |
| `$groupBy` | One item per distinct value (or combination, given an array of columns), in order of first appearance |
| `$sort` | For example `["-amount", "date"]` (`-` means descending; nulls come first) |
| `$limit` | At most this many items |
| `$xmlItem` | XML element name of each item (default `item`) |

Sums of `int` and `decimal` columns are exact, even beyond 2^53. A decimal
sum keeps the largest number of decimals among its inputs.

### 21.3 Typical shapes

**Statement header, plus lines.** Export one client's statement with a
filter. The header values come from the first line:

```json
{ "client": "client", "name": "clientName", "address": "address",
  "lines": { "$rows": { "date": "date", "description": "description", "amount": "amount" } },
  "balance": { "$sum": "amount" } }
```

```js
toJSON(reader, { shape, filter: { client: 'C1' } });
```

**Distinct values,** such as a list of countries:

```json
{ "countries": { "$rows": "country", "$groupBy": "country", "$sort": ["country"] } }
```

**Top N per group:**

```json
{ "$rows": { "client": "client", "largest": { "$rows": "amount", "$sort": ["-amount"], "$limit": 3 } },
  "$groupBy": "client" }
```

**Two levels of grouping,** for example totals per client and month (store
the month as its own column):

```json
{ "$rows": { "client": "client",
             "months": { "$rows": { "month": "month", "total": { "$sum": "amount" } }, "$groupBy": "month" } },
  "$groupBy": "client" }
```

### 21.4 Describe the output with JSON Schema

Give consumers a standard JSON Schema (draft 2020-12) of the export. It
lists each member's type, and whether it can be null, from the column
definitions:

```js
import { shapeSchema } from '@smithsoft-studios/jazmin';
fs.writeFileSync('statement.schema.json', JSON.stringify(shapeSchema(reader, shape), null, 2));
```

```csharp
File.WriteAllText("statement.schema.json", shape.ToJsonSchema(reader).ToJsonString(new() { WriteIndented = true }));
```

### 21.5 Keep large exports fast and small

- **Sort the file by the column you group by** (`sortedBy: ['client']`).
  Groups then arrive one after another, and one pass writes each group as
  soon as it is complete. That pass holds only one group's rows. On 1M
  transactions for 10,000 clients, with nested lines, the export takes
  1.9 s with a 147 MB peak in Node, and 1.6-1.8 s with a 69 MB peak in .NET.
- **Without that sort,** groups whose items use only first values and
  totals still take one pass, and memory grows with the number of groups.
  Groups with nested lists are collected in batches of 100,000 rows, one
  pass over the file per batch. The same 1M-row export then takes 9.1 s
  (about 330 MB peak) in Node, and 9.4 s (116-132 MB) in .NET.
  - **With `priority: 'speed'`** on the reader (section 20.4), a batch holds
    1,000,000 rows: 4.0 s (559 MB) in Node, 5.3 s (381 MB) in .NET.
  - Measured on 8 October 2026, on a machine busier than for the other
    figures in this guide.
- **`$sort` holds its list in memory before writing.** For very large lists,
  rely on the file's own order instead.
- **Stream to disk** with `exportFile` (JS) or `WriteJson` / `WriteXml`
  (.NET) instead of building a string.

### 21.6 Nest rows from other tables

In a file with several tables (section 23), a list can take its rows from
**another table**, linked to the row it is written for. One shape then
nests each customer's orders, each order's lines, and each line's product:

```json
{ "$rows": {
    "id": "id", "name": "name",
    "orders": { "$from": "orders", "$on": { "customer_id": "id" },
      "$rows": { "id": "id", "placed": "placed", "total": "total",
        "lines": { "$from": "order_lines", "$on": { "customer_id": "customer_id", "order_id": "id" },
          "$rows": { "line": "line", "quantity": "quantity", "amount": "amount",
            "product": { "$from": "products", "$on": { "sku": "sku" }, "$one": { "name": "name", "price": "price" } } } },
        "lineCount": { "$from": "order_lines", "$on": { "customer_id": "customer_id", "order_id": "id" }, "$one": { "$count": true } } } } } }
```

```js
const customers = open('shop.jzm');                       // the first table: customers
toJSON(customers, { shape, filter: { id: 4242 } });        // one customer, with all their details
exportFile(customers, 'json', 'shop.json', { shape });     // every customer, streamed to disk
```

```csharp
var shape = JazminShape.Parse(File.ReadAllText("customer-shape.json"));   // the same JSON as above
using var customers = JazminReader.Open("shop.jzm");
Console.WriteLine(shape.ToJson(customers, JazminFilter.Eq("id", 4242L))); // one customer
using (var output = File.Create("shop.json")) shape.WriteJson(customers, output);
```

| In the shape | Meaning |
|---|---|
| `$from` | The table the rows come from. Inside the list, column names are that table's |
| `$on` | Pairs `{ linked column: column of the row it is written for }`. Rows are linked when every pair is equal, as in filters: decimals by value, and a null links nothing. Paired columns have the same type |
| `$rows` | A list of the linked rows, in the linked table's order unless `$sort` says otherwise. `$filter` (the linked table's columns), `$groupBy`, `$sort`, `$limit` and `$xmlItem` work as on other lists. Unlike other lists, it is allowed in a one-row item: that is how a row's details nest |
| `$one` | The linked rows as one set: a column gives the first linked row's value, and totals cover all of them. `null` when nothing is linked (in XML, omitted) |

- **The export's `filter`** applies to the reader's own table, so the
  filter above picks the customer, and the links follow.
- **Only the columns the shape uses** are read from each table.
- **Shared files:** each linked table is read with the same key, so a key
  sees only its partitions and column groups in every table.
- **Checked up front,** as any shape: an unknown table, an unknown or hidden
  column, or paired columns of different types are named before any data is
  read.

**Keep linked exports fast and small: sort each linked table by its link.**
When a linked table is sorted by the columns of its link, and its parents
come in that order, the libraries read it once, front to back, in step with
its parents, and hold only the current parent's rows. The parents come in
that order when the parent table is sorted by the columns they pair with,
and their list has no `$sort`. For the shape above:

```js
tables: [
  { name: 'customers', columns: customerColumns, sortedBy: ['id'] },
  { name: 'products', columns: productColumns, sortedBy: ['sku'] },
  { name: 'orders', columns: orderColumns, sortedBy: ['customer_id', 'id'] },
  { name: 'order_lines', columns: lineColumns, sortedBy: ['customer_id', 'order_id', 'line'] },
]
```

The lines are linked on both `customer_id` and `order_id`. Orders arrive
sorted by `customer_id, id`, so lines sorted by `customer_id, order_id`
follow them.

- **Small linked tables,** such as products, are read once and kept by key:
  up to 10,000 rows with priority `memory`, 100,000 by default, and
  1,000,000 with `speed` (section 20.4).
- **Otherwise,** parents are written in batches (2,500 with `memory`, 10,000
  by default, 20,000 with `speed`). Each batch fetches its linked rows with
  one query per link. When those rows lie scattered, each batch reads about
  the whole linked table, so larger batches are faster and hold more rows.

Measured on 100,000 customers, 1,000,000 orders and 2,498,976 lines, with
the shape above (360 MB of JSON). Exporting the three tables one by one,
with the same columns, takes 2.6 s (70 MB) in .NET and 4.8 s (200 MB) in
Node.

| File | .NET | Node |
|---|---|---|
| Sorted by the links, as above | 4.5 s, 84 MB | 7.2 s, 220 MB |
| The same, one customer / 1,000 customers | 0.17 s / 0.44 s | 0.08 s / 0.13 s |
| Orders and lines in time order (batches), by default | 19 s, 238 MB | 27 s, 578 MB |
| The same with priority `memory` | 37 s, 100 MB | 64 s, 364 MB |

---

## 22. Async: servers and streaming sources

Every read and write API has an async form. Use it when:

- **A server handles other requests** while one of them scans a file (a PDF
  renderer, an API). The async forms never hold up the event loop (Node) or
  a request thread (.NET) for the length of a scan.
- **Rows come from an async source,** such as a database cursor, a message
  queue or a network stream. The async writers take them directly.

The results are exactly the same as the synchronous APIs: the same rows, in
the same order.

### 22.1 Reading

```js
import { openAsync } from '@smithsoft-studios/jazmin';

const reader = await openAsync('statements.jzm');            // header read with non-blocking reads
for await (const line of reader.findAsync({ account: 'ACC000123' }, { select: ['date', 'amount'] })) {
  await renderLine(line);                                     // other requests are served meanwhile
}

// Fastest: one array per chunk - the cost of async iteration is paid per chunk, not per row.
let total = 0;
for await (const lines of reader.findBatchesAsync({ amount: { gt: 0 } }, { select: ['amount'] })) {
  for (const line of lines) total += line.amount;
}
reader.close();
```

```csharp
using var reader = await JazminReader.OpenAsync("statements.jzm", cancellationToken: ct);
await foreach (var line in reader.FindAsync(JazminFilter.Eq("account", "ACC000123"), cancellationToken: ct))
    await RenderLineAsync(line);

await foreach (var item in reader.QueryAsync<StatementLine>(l => l.Amount > 0, cancellationToken: ct))
    Process(item);

var serializer = new JazminSerializer();
await using var stream = File.OpenRead("statements.jzm");
await foreach (var item in serializer.DeserializeAsyncEnumerable<StatementLine>(stream, ct))
    Process(item);
```

How it works:

- **JavaScript.** Chunks are read with non-blocking reads, two ahead of the
  decoding. Between chunks, the event loop runs timers and other requests.
  Decoding itself still runs on the main thread, one chunk at a time, which
  takes milliseconds.
- **.NET.** Rows are read and decoded on a thread-pool thread, 512 at a
  time, while you await. Your thread is free in the meantime. Nothing runs
  between batches, so you can use the same reader inside the loop, for
  example for a lookup. Cancellation stops the query between batches.

On a 300,000-row file, reading every row took 287 ms with `findAsync`,
against 252 ms with `find`. Summing two of 41 columns took 123 ms with
`findAsync` and 75 ms with `findBatchesAsync`, the same as `find` (78 ms).

Run one async query at a time per reader. To read in parallel, open the
file once per task, which is cheap.

### 22.2 Writing from async sources

```js
import { writeAsync, JazminWriter } from '@smithsoft-studios/jazmin';

// A database cursor, a stream... (columns are required: an async source cannot be read twice to infer them)
await writeAsync('statements.jzm', db.cursor('SELECT ...'), { columns, sortedBy: ['account'] });

// Or with a writer, mixing sources:
const writer = new JazminWriter('statements.jzm', { columns, sortedBy: ['account'] });
await writer.writeRowsAsync(firstSource);
await writer.writeRowsAsync(secondSource);
await writer.finishAsync();
```

```csharp
await using (var writer = JazminWriter.Create("statements.jzm", columns, new JazminWriteOptions { SortedBy = ["account"] }))
{
    await writer.WriteValuesAsync(ReadFromDatabaseAsync(ct), ct);   // IAsyncEnumerable<object?[]>
}                                                                  // DisposeAsync finishes the file

await new JazminSerializer().SerializeAsync(stream, repository.StreamLinesAsync(ct), ct);  // IAsyncEnumerable<T>
```

While chunks are being compressed on worker threads, the async writers
await them instead of blocking. Node also gets the event loop back after
every chunk, even when the rows come from a plain array.

## 23. Several tables in one file

A file can hold several tables, like the sheets of a workbook. Use this when
details repeat. In a statement file, for example, each client's name and
address would otherwise sit on every transaction row. With two tables,
`clients` holds those details once, and `transactions` refers to them by
`clientId`. The design is in
[docs/design/several-tables.md](design/several-tables.md).

### 23.1 Writing

Declare the tables, then write them one after another. Only the current
table's chunk is in memory, however many tables there are.

```js
import { JazminWriter, write } from '@smithsoft-studios/jazmin';

const writer = new JazminWriter('statements.jzm', {
  tables: [
    // Small chunks suit a table looked up by key: a lookup decodes one chunk.
    { name: 'clients', columns: clientColumns, sortedBy: ['clientId'], chunkRows: 256 },
    { name: 'transactions', columns: transactionColumns, sortedBy: ['clientId', 'date'], chunkRows: 1024 },
  ],
});
writer.writeRows(clients);              // rows go to the first table
writer.startTable('transactions');      // then to this one
writer.writeRows(transactions);
writer.finish();

// The same in one call, with the rows of each table by name:
write('statements.jzm', { clients, transactions }, { tables: [/* as above */] });
```

```csharp
using var writer = JazminWriter.Create("statements.jzm", new JazminWriteOptions
{
    Tables =
    [
        new JazminTable("clients", clientColumns) { SortedBy = ["clientId"], ChunkRows = 256 },
        new JazminTable("transactions", transactionColumns) { SortedBy = ["clientId", "date"], ChunkRows = 1024 },
    ],
});
foreach (var c in clients) writer.WriteRow(c);
writer.StartTable("transactions");
foreach (var t in transactions) writer.WriteRow(t);
writer.Finish();
```

- **Each table** has its own `columns` (with indexes), `sortedBy`,
  `chunkRows` and `chunkBytes`. In access-controlled files it also has its
  own `partitionBy` and `columnGroups`.
- **Shared by the file:** the key or password, codec, metadata, embedded
  files and grants.
- **Order:** the file lists the tables in the order you declared them.
  `startTable` can take them in any order, each once. A table you never start
  is written empty.

### 23.2 Reading

A reader shows one table: the first, unless you name another.
`openTable` reads another table of the same file without opening it again,
so it reuses the keys and checks already done.

```js
const clients = open('statements.jzm', { key });               // the first table
clients.tables;                                                 // ['clients', 'transactions']
const transactions = clients.openTable('transactions');        // or open(..., { key, table: 'transactions' })

const client = [...clients.find({ clientId: 'C00042' })][0];
const lines = [...transactions.find({ clientId: 'C00042' })];
transactions.close();
clients.close();                                                // the file closes with the last reader
```

```csharp
using var clients = JazminReader.Open("statements.jzm", new JazminReadOptions { Key = key });
using var transactions = clients.OpenTable("transactions");     // or Table = "transactions" in the options
var client = clients.Find(JazminFilter.Eq("clientId", "C00042")).Single();
var lines = transactions.Find(JazminFilter.Eq("clientId", "C00042")).ToList();
```

**With LINQ (.NET).** Each table has its own `AsQueryable<T>()` (section
8.3). Lambda (method) syntax and query syntax both work, and the reader runs
the filter, the columns and the order it can:

```csharp
var camel = new JazminSerializerSettings { NamingStrategy = JazminNamingStrategy.CamelCase }; // ClientId -> clientId
var clientRows = clients.AsQueryable<Client>(camel);
var transactionRows = transactions.AsQueryable<Transaction>(camel);

string name = clientRows.Where(c => c.ClientId == "C00042").Select(c => c.Name).Single();   // reads 2 columns
var amounts = (from t in transactionRows
               where t.ClientId == "C00042"
               select t.Amount).ToList();                                                    // the same in query syntax

// Two tables: filter each in its reader, then join the results in memory.
var ids = clientRows.Where(c => c.Name.StartsWith("A")).Select(c => c.ClientId).ToList();
var theirs = transactionRows.Where(t => ids.Contains(t.ClientId)).ToList();                 // an `in` filter
```

A LINQ `Join` or `GroupBy` across tables runs in memory, as LINQ to
Objects, and reads only the columns the query uses of each table. A
sub-query per row (`clients.Select(c => transactions.Where(t => t.ClientId
== c.ClientId)...)`) is read once (section 8.3). For nested
output (each client with their transactions), use an export shape with
`$from` (section 21.6): it reads each table once when they are sorted by the
link.

### 23.3 Access control across tables

Partition names and column-group names are shared by every table of a file.
A key granted client `C1` therefore sees `C1`'s rows in every table
partitioned by client: access follows the link.

```js
new JazminWriter('statements.jzm', {
  key: owner,
  access: { grants: [{ key: bob, rows: ['C1'] }] },
  tables: [
    { name: 'clients', columns: clientColumns, partitionBy: 'clientId', columnGroups: { contact: ['email', 'phone'] } },
    { name: 'transactions', columns: transactionColumns, partitionBy: 'clientId' },
    { name: 'rates', columns: rateColumns },     // no partitionBy: one partition, named '*'
  ],
});
```

A table without `partitionBy`, such as a lookup table of exchange rates, has
one partition named `*`. A grant of `rows: '*'` covers it; a grant of
`rows: ['C1']` does not. To share such a table, add `'*'` to the grant:
`rows: ['C1', '*']`.

### 23.4 Changing one table

`append`, `update` and `compact` take a `table` option (.NET: `Table`); the
default is the first table. Only that table's rows change.

- **An append** writes new sections for that table only. The other tables
  stay exactly as they are.
- **A full rewrite** (`update`, `compact`, granting or revoking) copies the
  other tables into the new version, because every new version gets fresh
  secrets.

```js
append('statements.jzm', { key, table: 'transactions', insert: newLines });
update('statements.jzm', { key, table: 'clients', upsert: [changedClient], keyColumns: ['clientId'] });
```

### 23.5 Is it worth it?

Measured on 20,000 clients with 11 detail columns and 300,000 transactions
(15 per client), on Node.js. Clients were in 256-row chunks and transactions
in 1,024-row chunks in both files.

| | Flat (details on every row) | Two tables |
|---|---|---|
| File size | 3.70 MB | **3.39 MB** (−8%) |
| Write | 1.28 s | **0.94 s** (−27%) |
| One client's statement (open, client, 15 lines) | 1.14 ms | **1.03 ms** with `openTable` |
| Read every transaction | 176 ms | **145 ms** (−18%) |

The size gain is modest because dictionary encoding already stores a chunk's
repeated values once. The bigger gains are elsewhere:

- each table is read without decoding the other's columns;
- a client's details are changed in one row;
- each table's chunk size can suit how it is read.

## 24. The viewer: open .jzm files in a browser

The viewer opens a `.jzm` file in a browser and shows its **document** (the
package's entry page, section 19), its **data** and its **files**. The file
is read on the person's own device: nothing is uploaded, and only the parts
needed are read from disk.

**Keys:**
- **Files with one key or a password** open with that key or password.
- **Shared files** (section 15) open only with an access key, plus its unlock
  token for online access. **The viewer and the browser reader refuse a
  shared file's master (owner) key.**
  - **Why:** that key controls the whole file, and a web page is the easiest
    place to steal a key from (browser extensions, injected scripts, whoever
    serves the page).
  - **To see everything in a browser,** the owner gives themselves a full-read
    access key: `grantAccess(file, owner, key, { rows: '*', columns: '*' })`.
    It reads every row and column but changes nothing, and it can be revoked.

It comes in three forms:

| Form | How | Good for |
|---|---|---|
| **Installed app** | Host `js/viewer` and `js/browser` side by side over HTTPS; people choose "Install". Chrome and Edge then open `.jzm` files with it, also offline | People who receive `.jzm` files often |
| **Hosted page** | The same folders on any web server; choose or drop a file | Anyone with a link |
| **One HTML file** | "Save as HTML" in the viewer: the viewer and the `.jzm` in one file, opened by double-click, offline | Sending a document to someone once. Best under about 50 MB; many mail systems block `.html` attachments |

Try it locally with `npm run viewer` (in `js/`). The saved HTML file still
asks for the key: the data inside it stays encrypted.

### 24.1 Templates: the document API

A package's entry page runs in a sandbox. It has no network access (except
the package's `allowedOrigins`), no access to browser storage, and never sees
the key. It reads the data through `window.jazmin`:

- **Allowed origins** are `https://` origins listed in the package settings,
  for example `package: { entry: 'index.html', allowedOrigins:
  ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] }`. From
  those, and only those, a template may load scripts, styles, images, fonts,
  audio and video, and make requests.
- **Each one is a trade-off:** whoever runs that site learns when the file is
  opened, a document that loads from it shows nothing of it offline, and a
  script from it runs with the data in view. Files a template needs are
  better stored in the package (section 19); a font is typically 20-100 KB.

```js
jazmin.metadata; jazmin.columns; jazmin.access; jazmin.rowCount;
const page = await jazmin.query({ country: 'ZA' }, { orderBy: '-amount', offset: 0, limit: 100, select: ['id', 'amount'] });
const total = await jazmin.count({ country: 'ZA' });
const all = jazmin.rows();                       // small data sets only (up to 20,000 rows)
img.src = jazmin.asset('img/logo.svg');          // an embedded file as an in-memory URL
const blob = await jazmin.file('terms.pdf');
jazmin.download('lines.csv', csvText, 'text/csv');
jazmin.print(); jazmin.navigate('about.html'); jazmin.ready({ rows: page.length });
```

Queries run in the viewer, which holds the reader and the key. Only the
requested page of rows crosses into the sandbox.

**Print-ready documents.** A page learns how it is shown, and what it may
offer, so one template works on screen and on paper:

```js
if (jazmin.mode === 'print') document.body.classList.add('print');   // 'view' in a viewer, 'print' in renderPdf
jazmin.filter;                                    // the rows a PDF was limited to, or null
jazmin.actions;                                   // { print, pdf, image }: what the viewer offers for this page
printButton.hidden = !jazmin.actions.print;       // show your own buttons by it
jazmin.setActions({ pdf: { landscape: true } });  // this page, while it is shown: off, back on, or page settings
pdfButton.onclick = () => jazmin.savePdf({ format: 'A5' });
```

- **`jazmin.actions`** combines the page's file settings (`actions`, section
  19.3), what the viewer can do, and the page's own `setActions`. The web
  viewer prints with the browser's dialog, which also saves as PDF;
  `renderPdf` offers nothing more (it is already printing).
- **`setActions`** turns actions off (or back on) and gives page settings.
  It can't allow what the page's file refuses. It lasts until another page
  is shown; that page starts from its own file's settings.
- **`print()` and `savePdf()`** throw when the action isn't allowed. In the
  web viewer `savePdf` opens the print dialog (the page's CSS `@page` sets
  the paper); viewers that render PDFs themselves use the page settings.

**Documents that change their data** (the package's `edit`, section 19.5):

```js
jazmin.edit;   // { table, key, columns, add, delete }, or null: nothing can be saved here
const result = await jazmin.saveChanges({
  update: [{ claim: 'C-104', status: 'approved' }],   // the key, and the columns that change
  add: [{ claim: 'C-900', status: 'open' }],
  delete: [{ claim: 'C-017' }],                       // the key only
});
// { saved: 'change-file', file: 'claims-changes-20261009101500.jzm', updated: 1, added: 1, deleted: 1 }
```

- **The viewer decides, not the page.** It checks the changes against `edit`
  (a change that isn't allowed rejects with the reason), shows the person
  what will change, and saves only when they confirm. Otherwise
  `saveChanges` rejects.
- **The web viewer** can't change a file on disk: it saves a change file.
  For a shared file the person sends it to the owner, who applies it
  (section 19.5); for a file of their own they apply it with the library
  (`applyChanges`).
- **In a PDF** (`renderPdf`), `jazmin.edit` is null and `saveChanges`
  rejects.

- Use relative paths (`img/logo.svg`, `about.html`), plain scripts rather
  than modules, and `window.jazmin` rather than `fetch()`.
- Links to other `.html` files in the package open inside the viewer.

### 24.2 Limits

- **Brotli sections cannot be read:** browsers have no Brotli decompressor.
  Write files meant for the viewer with deflate (the default).
- **Expiry is weaker in a browser.** The viewer refuses an expired key, and a
  clock set before the file's date, but it keeps no last-seen record.
  People can clear browser storage, so a record would not hold. Use online
  keys when expiry matters.
- **The document's files are held in memory** while it is shown. Data rows
  are read a chunk at a time.
- **Tested** in Chrome, Edge, Firefox and Safari (`npm run test:viewer`). CI
  runs Chrome and Firefox on Linux, and Safari on macOS. Safari in the iPhone
  simulator runs when asked (CONTRIBUTING, Phone check).
  - **Phones** (Safari on an iPhone, Chrome on Android) are checked by hand
    before each release. The results are in the release notes.
  - **Safari and "Save as HTML":** CI opens the saved copy in Safari from a
    web server, because Safari's automation can't open files from disk. The
    phone check covers opening it from disk.

For developers, the browser reader on its own is `@smithsoft-studios/jazmin/browser`
(`js/browser/jazmin-browser.js`). It is async and has no dependencies. It
reads every kind of file, and writes files with one key or a password
(section 24.3):

```js
const reader = await JazminBrowser.open(file, { key });   // a File, Blob or bytes
for await (const row of reader.find({ country: 'ZA' })) console.log(row);
const { rows } = await reader.query({ country: 'ZA' }, { offset: 50, limit: 50, total: false });
await reader.count({ country: 'ZA' });
await reader.columnArrays(null, { select: ['at', 'amount'] }); // arrays for charts (section 9.11)
reader.submissionKey;                                  // the key to send records back with (section 15.6)
await reader.explain({ id: 7 }, { analyze: true });    // as in the library (section 9.6)
const pdf = await reader.readFile('terms.pdf');
```

**It plans queries as the library does** (sections 9.7 and 9.8):

- **What it uses:** chunk statistics (of the fields inside nested columns
  too), a binary search on the file's first `sortedBy` column, and offsets
  that skip whole chunks. For files that aren't access-controlled, it also
  uses sorted and trigram indexes, with the same cost rules.
- **What it decodes:** a filter's columns first, nested ones with only the
  fields the filter reads when the rows don't return them; the columns it
  returns only for chunks with matching rows, and their text values only for
  those rows. On 5,000 companies with departments, employees and projects,
  finding those with an employee of a given id takes 7 ms and 66 MB instead
  of 411 ms and 197 MB; on 200,000 plain rows, returning 667 whole rows takes
  160 ms instead of 240 ms.
- **What that saves:** a query reads the same chunks it would in Node. For
  example, one account's page in a 9.7 MB file reads 85 KB rather than the
  whole file.
- **Access-controlled files:** only the owner may use their indexes, so the
  browser reader relies on statistics and the sort order there.

**Opening a file by URL.** `openUrl` reads a file straight from a web server or
object storage (S3, a CDN), using HTTP range requests. Only the parts a query
needs are downloaded:

```js
const reader = await JazminBrowser.openUrl('https://files.example.com/statements-2025.jzm', {
  key,                                         // as for open()
  headers: { Authorization: `Bearer ${token}` },  // sent with every request (optional)
});
```

- **How few requests:**
  - the first request fetches the end of the file, which holds the size (from
    `Content-Range`), the header and usually the directories;
  - later reads fetch 64 KiB blocks, kept in a small cache (`blockSize`
    changes the block size).
- **Measured:** on a 3 MB file of 200,000 rows, opening it and reading one
  account's first page took **3 requests and 256 KB**.
- **The server must support range requests.** A server that answers with the
  whole file still works, but downloads it all.
- **For another origin (CORS),** the server must allow the `Range` request
  header and expose `Content-Range`:
  `Access-Control-Allow-Headers: Range` and
  `Access-Control-Expose-Headers: Content-Range`.
- **Any other source:** `open()` also accepts any
  `{ size, read(offset, length) }` object, where `read` returns the bytes or a
  promise of them.


### 24.3 Writing files in the browser

The browser module also writes files: one table, with any embedded files
(photos, PDFs), locked with a key, a password, or nothing. It's made for
**sending records back** to the owner:
records a person captures, often offline, and sends later (section 15.6).
Writing happens on the device, so nothing is uploaded until the app sends the
file.

```js
const key = (await JazminBrowser.open(sharedFile, { key: accessKeyText })).submissionKey; // or a jzk1- key, or { password }
const writer = await JazminBrowser.createWriter({ columns, key });
await writer.writeRows(records);                                 // await each call
await writer.addFile({ path: 'r1/receipt.pdf', content: fileInput.files[0] });   // a File, Blob, bytes or text
const blob = await writer.finish();                              // a Blob: store it, then upload it when online
// or in one call:
const file = await JazminBrowser.write(records, { columns, key, files: [{ path: 'r1/photo.jpg', content: photoBlob }] });
```

- **Options:** as in the library's `write()`: `columns`, `key` or
  `password` (with `kdfIterations`), `metadata`, `codec` (`'deflate'` or
  `'none'`), `chunkRows`, `chunkBytes` and `files`.
- **Embedded files** (section 19): `addFile({ path, content, type, groups })`
  or the `files` option, as in the library.
  - **Content:** a `File` (from a file input or the camera), a `Blob`, a
    `Uint8Array`, an `ArrayBuffer` or text.
  - **Type:** when you leave it out, it comes from the path's extension, as in
    the library.
  - **Copies:** identical content is stored once, however many paths use it.
  - **Memory:** each file is read whole once, to hash it. The finished file
    is held in memory until you store it, so keep a batch's files to tens of
    megabytes.
  - **Records that use files:** list each record's files in a column. The
    filing service checks and stores them (section 15.6).
- **Not written in browsers:**
  - **Shared files.** Their master key stays off web pages (section 24).
  - **Indexes.** The owner's service adds them when it compacts the shared
    file.
  - **Also:** several tables, viewer package settings, `sortedBy` and Brotli.

  Each of these is refused with a message that says why.
- **The same file as the library:** given the same rows, options and random
  bytes, it writes exactly the bytes the library writes, and CI checks this.
  It uses only the browser's own encryption (`crypto.subtle`), randomness and
  compression (`CompressionStream`), and no other code.
- **Requirements:**
  - **Encryption** needs a secure page (`https://` or `localhost`).
  - **Compression** needs Chrome 103, Firefox 113 or Safari 16.4 or later.
    Elsewhere, pass `codec: 'none'`.

---

## 25. The command-line tool

The npm package includes `jazmin`, a command-line tool for looking into,
querying and converting files without writing code:

```bash
npx @smithsoft-studios/jazmin --help          # or, installed in a project: npx jazmin --help
```

| Command | What it does |
|---|---|
| `jazmin inspect <file>` | What the file holds, as JSON: format, encryption, tables, rows, chunks, sort order, columns, indexes, access and embedded files |
| `jazmin query <file> --filter '<json>' --select a,b --offset n --limit n --format jsonl\|json\|csv` | The matching rows, as JSON lines (the default), a JSON array or CSV |
| `jazmin explain <file> --filter '<json>' --analyze` | How the query runs and, with `--analyze`, what it read (section 9.6) |
| `jazmin advise <file> --column account` | Layout advice for lookups of a column (below) |
| `jazmin convert <input> <output>` | JSON, JSON Lines, CSV or XML to `.jzm` (`--sorted-by a,b`), or `.jzm` to JSON, CSV or XML (`--filter`) |
| `jazmin keygen [--access]` | A new key or, with `--access`, an access key issued from the owner key |

Every command takes `--help`. `--table <name>` picks a table in a file with
several.

**Keys** come from the environment, `JAZMIN_KEY`, `JAZMIN_PASSWORD` and
`JAZMIN_UNLOCK_TOKEN`, or from files (`--key-file`, `--password-file`,
`--unlock-token-file`). That way they don't end up in your shell history.
The tool never prints a key, except `keygen`:

```bash
export JAZMIN_KEY="$(cat owner.key)"
jazmin query statements.jzm --filter '{"account":"ACC-100250"}' --select at,amount --limit 20
jazmin convert statements.jzm march.csv --filter '{"at":{"gte":"2025-03-01","lt":"2025-04-01"}}'
```

**Exit codes:** 0 on success, 1 when the file or key is the problem (the
message says why), and 2 when the command line is wrong.

### 25.1 Layout advice

`jazmin advise` (`reader.advise({ columns })` in code) reads only the chunk
directories and statistics, not rows. It shows how the file's layout serves
lookups of the columns you name. On 200,000 transactions sorted by time,
looking up accounts:

```text
$ jazmin advise transactions-by-time.jzm --column account
200,000 rows in 49 chunks (about 4,082 rows, 96 KB each), sorted by at
account: one value's rows lie in about 49 chunk(s), about 4,708 KB to read (indexed)
- The rows of one 'account' value lie in about 49.0 of 49 chunks: a lookup reads about 4,708 KB. Writing the file with sortedBy: ["account","at"] would put them in about 2 chunks.
- One 'account' value has about 400 rows, and a chunk holds 4,096: chunkRows: 1024 would cut the chunk data a lookup reads to about 48 KB (files grow a little: smaller chunks compress slightly less well).
```

- **Following the first suggestion** cut an account page from 439 KB to
  101 KB, and an account count from 4,766 KB to 101 KB (section 9.6 shows how
  to measure this).
- **In access-controlled files,** the advice also lists each partition's
  chunks, and suggests `compact({ regroup: true })` when appends have spread
  a partition over more chunks than its rows need (section 17.4).
