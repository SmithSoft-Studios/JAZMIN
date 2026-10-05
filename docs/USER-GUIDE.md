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
stored on its own, so a query decodes only the columns it uses.

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
rule them out.

A `sorted` index is stored in pages of about 64 KiB. For a column with
millions of different account numbers, a lookup reads a small directory and
one page, rather than the whole index. A small index is a single page.

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
const key = JazminKey.generate();          // store key.toString() in your secret manager

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

### 4.3 Reading and querying

```js
const reader = open('customers.jzm', { key: key.toString() });   // reads only the header

reader.columns;     // [{ name: 'id', type: 'int', nullable: false, description: 'Customer number' }, ...]
reader.metadata;    // { source: 'crm', exportedBy: 'nightly-job' }
reader.rowCount;    // 3

for (const row of reader.find({ country: 'ZA', name: { icontains: 'ndlovu' } })) {
  console.log(row);  // { id: 3, name: 'Thabo Ndlovu', country: 'ZA', balance: '0.00', joined: 2025-06-07T00:00:00.000Z }
}

reader.get(1);                                      // row by position (many? sort them first: section 9.9)
reader.count({ country: 'ZA' });                    // 2 (reads as little as it can: section 9.10)
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

const reader = open('customers.jzm', { key: key.toString() });
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
| anything else (lists, nested classes) | `json` |

`[JsonPropertyName]` from System.Text.Json is honoured too. Column names are
matched case-insensitively when reading, as Newtonsoft does.

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

### 8.2 GraphQL

JAZMIN does not depend on a GraphQL server. Instead, its filter objects
*are* GraphQL `where` inputs, so a resolver passes them straight through.

```graphql
input StringFilter { eq: String ne: String in: [String!] contains: String icontains: String startsWith: String isNull: Boolean }
input IntFilter    { eq: Int ne: Int gt: Int gte: Int lt: Int lte: Int in: [Int!] isNull: Boolean }
input CustomerWhere { id: IntFilter name: StringFilter country: StringFilter and: [CustomerWhere!] or: [CustomerWhere!] not: CustomerWhere }

type Query { customers(where: CustomerWhere, limit: Int = 50, offset: Int = 0): [Customer!]! }
```

```js
// Resolver (any GraphQL server: Apollo, Yoga, graphql-js...)
const resolvers = {
  Query: {
    customers: (_, { where, limit, offset }) =>
      [...reader.find(where ?? null, { limit, offset })],
  },
};
```

In .NET with HotChocolate or GraphQL.NET, serialize the `where` argument to
JSON and call `reader.Find(json, ...)`.

### 8.3 LINQ support (.NET)

`reader.Query<T>(predicate)` always returns exactly what the predicate
selects. The library translates as much of the predicate as it can into an
index-aware filter, then runs your compiled predicate on each candidate
row. Translation therefore affects only speed, never results.

| Expression | Uses index / statistics |
|---|---|
| `==`, `!=`, `<`, `<=`, `>`, `>=` against constants or captured variables (bool, numbers, strings, enums, dates) | ✔ |
| `&&`, `\|\|`, `!` (on comparisons) | ✔ |
| `x.Name.Contains("a")`, `x.Name.StartsWith("a")` | ✔ |
| `list.Contains(x.Country)` | ✔ |
| `x.IsActive` (bool property) | ✔ |
| `decimal` comparisons, method calls, arithmetic (`x.Id % 7 == 0`) | ✘ (scanned, still correct) |

---

## 9. Performance and benchmarks

The tables show measured results on 200,000 customer records with 8 fields,
run on an Intel i7-12700H laptop under Windows 11. Each figure is the best of
3 runs after a warm-up run, which is applied to every contender alike.

Re-run on your own data with `npm run bench` (in `js/`) or
`dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks` (in `dotnet/`).
`npm run bench:proposals` shows what typical statement queries read (bytes,
rows and time per query); docs/CONTRIBUTING.md explains it.

### 9.1 .NET 10 (vs Newtonsoft.Json 13.0.3 and System.Text.Json)

| Measure | Newtonsoft | System.Text.Json | **JAZMIN** |
|---|---:|---:|---:|
| File size | 30,529 KB | not measured | **1,297 KB** (deflate) / **838 KB** (brotli) |
| File size, gzipped JSON for comparison | 3,324 KB | | |
| File size with 3 indexes + AES-256 encryption | | | 2,235 KB |
| Find one record by id (open file → result) | 264 ms | 101 ms | **3.7 ms** (3.8 ms encrypted) |
| Filter `Country == "NA" && Age > 80` | 273 ms | | **40 ms** |
| Memory allocated for one lookup | 196 MB | | **2.5 MB** |
| Deserialize every record | 221 ms | 95 ms | **33 ms** |
| Serialize every record | 118 ms | 62 ms | **42 ms** (186 ms with 3 indexes) |

### 9.2 Node.js 24 (vs native JSON)

| Measure | JSON | **JAZMIN** |
|---|---:|---:|
| File size | 31,307 KB (gzip: 3,338 KB) | **1,292 KB** (deflate) / **838 KB** (brotli) |
| Find one record by id | 108 ms | **2.7 ms** (2.8 ms encrypted) |
| Read every record | 107 ms | **51 ms** |
| Write every record | 275 ms | **199 ms** (389 ms with 3 indexes) |
| Broad filter matching 1 row in 8, spread through the file | 111 ms | **56 ms** |
| Text search (`contains`) | 112 ms | **69 ms** |

On Node 26 (same day), JAZMIN takes 3.0 ms per lookup and 57 ms to read every
record; `JSON.parse` is about 15% faster there than on Node 24.

### 9.3 What the numbers mean

- **Size:** about 24× smaller than JSON and 61% smaller than *gzipped* JSON
  with deflate. With Brotli, 75% smaller than gzipped JSON. These numbers come
  from regular benchmark data; expect less on very varied data.
- **Finding specific records:** 27–71× faster than parsing JSON in .NET, and
  about 40× in Node.
- **Reading a whole file:** faster than `JSON.parse` and System.Text.Json.
- **Writing:** faster than `JSON.stringify` in Node, and faster than both .NET
  serializers without indexes. Indexes are built as the file is written: with
  3 indexes, a .NET write takes about 1.6× Newtonsoft and 3× System.Text.Json.
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
| Write | 83.2 s, 245 MB | **66.2 s**, 307 MB² | 14.8 s, 48 MB | **11.3 s**, 144 MB |

Times include generating the rows, which both sides do in the same way.
Memory is the peak working set of the process doing that step. On this
machine, repeated runs of the same step vary by up to 20%, so the Node writes
were run back to back. ¹ With `node --max-semi-space-size=8` (see 20.5).
² With 2 worker threads (the default). On the main thread only
(`maxDegreeOfParallelism: 1`): 86.2 s, 298 MB.

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
- **Still open:** writing in Node uses about 25% more memory than
  `JSON.stringify` (TASKS P-15).

### 9.5 Tuning

| Setting | Default | Change it when |
|---|---|---|
| `codec` | `deflate` | Use `brotli` for archives (smaller, slower to write), or `none` for already-compressed data |
| `chunkRows` | 4096 | Lower (e.g. 512) for many single-row lookups; higher for whole-file reads |
| `select` (query option) | every column | List only the columns you need. Only those, and the columns the filter uses, are decoded, on every kind of query: scans, index lookups and access-controlled files. In access-controlled files, a column group none of whose columns is needed is not read at all. A one-column read through an index took 45% of the time of reading every column |
| indexes | none | Add `sorted` to columns used in `eq` / range filters, and `trigram` to text searched with `contains`. Skip `sorted` on the first `sortedBy` column: chunk statistics already find its values. Large sorted indexes are paged automatically |
| `kdfIterations` | 600,000 | Do not lower it in production. It only affects password-based files. Allowed: 1,000 to 10,000,000; readers refuse files outside that range |
| `maxDegreeOfParallelism` (JS) / `MaxDegreeOfParallelism` (.NET writer) | JS: up to 2 worker threads; .NET: one thread per core, up to 16 | Set 1 for the lowest memory. Raise it in .NET for faster writes. In JS, more than 2 gains little, because preparing rows on the main thread is the limit |

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
| `columnsDecoded` | Column streams decoded (one per column per chunk) |
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
- **Index results only narrow the scan.** Only chunks the scan would read are
  read, and in them only the rows the index names are checked, with the same
  fast column decoding as a scan.

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

- **.NET** counts the same way. The 12 monthly counts took 82 ms in 1.0.0
  and 27 ms now. On 1,000,000 rows, they took 323 ms and now take 25 ms.
- **The browser reader** counts the same way, and `query()` uses it for
  `total`.
- **Access keys** don't use indexes (only the owner can read them), so they
  count from chunk statistics and the partitions a filter names.

---

## 10. Security guide

**What is protected.** In an encrypted file, the data, column names and
types, metadata and indexes are all encrypted and authenticated. The
following remain visible:

- the file size and the size of each section;
- whether a password was used.

**Keys:**

- Generate keys with `JazminKey.generate()` / `JazminKey.Generate()`.
- Store the text form in a secret manager such as Azure Key Vault, AWS
  Secrets Manager or HashiCorp Vault. Never store it next to the file or in
  source control.
- **If the key is lost, the data cannot be recovered.**
- The `jzk1-...` text contains a checksum, so a typo produces "Key checksum
  mismatch" rather than a confusing decryption failure.

**Passwords:** suitable for people. For services, prefer keys. PBKDF2
slows down guessing, but a weak password is still weak.

**Sharing one file with many people:** give each person an access key that opens only their rows and
columns. See [section 15](#15-access-control-one-file-many-keys).

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
| JAZMIN → CSV | `toCSV(reader, options)` | `JazminConvert.ToCsv(bytes, settings, filter)` |
| XML → JAZMIN | `fromXML(text, target)` | `JazminConvert.FromXml(xml, settings)` |
| JAZMIN → XML | `toXML(reader, options)` | `JazminConvert.ToXml(bytes, settings, filter)` |
| Stream to file | `exportFile(reader, 'json' \| 'csv' \| 'xml', path, options)` | `JsonFormat.Write`, `CsvFormat.Write`, `XmlFormat.Write` |
| Nested JSON / XML (section 21) | `toJSON(reader, { shape })`, `toXML(reader, { shape })`, `exportFile(..., { shape })` | `JazminShape.Parse(json).ToJson(reader)`, `.ToXml(reader)`, `.WriteJson(reader, stream)` |

Conversion rules worth knowing:

- **JSON:** large integers and decimals are written exactly, even beyond
  JavaScript's 2^53 limit. Dates use ISO-8601 UTC format, and binary data
  is base64.
- **CSV:** an empty field means *null*, while `""` means an *empty string*,
  so round trips keep the difference. Types are inferred unless you set
  `inferTypes: false`; turn inference off for codes with leading zeros
  such as `0042`.
- **XML:** the shape is `<jazmin><row><column>value</column></row></jazmin>`.
  Null values are left out. Column names that are not valid XML names are
  written as `<field name="...">`.

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
| Rows per file | 2^53 in JavaScript, 2^63 in .NET |
| Updates | By rewrite with atomic replace (section 16), or by append for frequent changes (section 17) |
| Concurrency | Readers and writers are single-threaded objects. Open one per thread |
| Browser | Not yet supported (uses Node `fs`, `zlib`, `crypto`). See TASKS.md B-1 |
| Large JSON import | Streams with `importJSONFile` / `JazminConvert.FromJsonFile` at any size. `fromJSON` / `FromJson` (text in memory) are for small inputs |
| Large CSV/XML import | Currently loads the whole input text into memory. See TASKS.md C-2 |
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
const bob = owner.createAccessKey();         // send bob.toString() to Bob (e.g. via your secrets API)

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
const bobView = open('shared.jzm', { key: bob.toString() });
console.log([...bobView.rows()], bobView.hiddenRowCount); // [ { section: 'B' } ] 1
```

### 15.3 .NET

```csharp
var owner = JazminKey.Generate();
var bob = owner.CreateAccessKey();                       // bob.ToString() -> "jza1-..."

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
- **On Windows, a rewrite cannot replace a file that another process has
  open.** You get a clear error, and the original file is untouched. Close
  readers first, or use `append()`.

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
| Works while readers have the file open (Windows) | No, fails with a clear error | **Yes** | No, fails with a clear error |

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
r.close();

compact('statements.jzm', { key: owner });         // { rowCount, bytesBefore, bytesAfter }
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
    Console.WriteLine($"{r.AppendCount} appends, {r.DeletedRowCount} deleted rows waiting");

var compacted = JazminFile.Compact("statements.jzm", owner);   // RowCount, BytesBefore, BytesAfter
```

### 17.3 Good to know

- **File growth.** Each append writes only what changed: the new rows, a
  chunk directory for each partition it added rows to, and a small new header.
  Key slots are written again only when grants or partitions change. On a file
  with 5,000 chunks that is under 1 KB per append, on top of the data. Deleted
  rows keep their space until `compact()`. Pick an `autoCompact` threshold
  that suits how often you append and delete.
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
  reader's clock option (`now`, .NET `Now`) back or uses modified software,
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
    { path: 'index.html', content: html },
    { path: 'docs/terms.pdf', file: './terms.pdf', groups: ['A', 'B', 'C', 'D'] },
    { path: 'img/logoD.png', file: './logoD.png', groups: ['D'] },
  ],
  package: { entry: 'index.html', title: 'Statement' },        // settings for viewers
  access: { partitionBy: 'client', grants: [{ key: clientD, rows: ['D'] }, { key: designer, rows: [], files: ['template'] }] },
});

const r = open('statements.jzm', { key: clientDText });
r.files;                                   // [{ path, type, size, sha256 }] this key can see
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
        new JazminFileInput("index.html", htmlBytes),
        JazminFileInput.FromFile("docs/terms.pdf", "terms.pdf", groups: ["A", "B", "C", "D"]),
        new JazminFileInput("img/logoD.png", logoD) { Groups = ["D"] },
    ],
    Package = new JazminPackage { Entry = "index.html", Title = "Statement" },
});

using var reader = JazminReader.Open("statements.jzm", new JazminReadOptions { AccessKey = clientD });
foreach (var f in reader.Files) Console.WriteLine($"{f.Path} {f.Size}");
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

### 20.4 Tune parallel reading (.NET)

```csharp
// Default: up to 4 chunks are decoded ahead on worker threads while you consume rows.
var fast = JazminReader.Open(path);

// Lowest memory: decode on the calling thread only.
var lean = JazminReader.Open(path, new JazminReadOptions { MaxDegreeOfParallelism = 1 });
```

Read-ahead is also capped at about 128 decoded columns in flight. A 3-column
query gets the full read-ahead (about 3× faster on the wide benchmark). A
full read of a 300-column file stays sequential, at its lowest memory, where
read-ahead would only add memory for little gain.

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
| `sortedBy` on the column you look up by | An index on that same column (statistics already locate it) |
| `select` the columns you need | Reading whole rows of a wide table |
| Stream with `for…of`, `DeserializeEnumerable`, `await foreach` | `ToList()` / `[...rows]` on millions of rows |
| One reader per thread, reused | Opening the file for every row |
| Writer parallelism 1 on very small servers (`maxDegreeOfParallelism: 1` in JS, `MaxDegreeOfParallelism = 1` in .NET) | Leaving the .NET writer at 16 threads on a 2-core container |
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
  2.3 s in Node, and 1.8 s with a 66 MB peak in .NET.
- **Without that sort,** groups whose items use only first values and
  totals still take one pass, and memory grows with the number of groups.
  Groups with nested lists are collected in batches of about 100,000 rows,
  one pass per batch. The same 1M-row export then takes 8.7 s in Node, and
  5.6 s with a 153 MB peak in .NET.
- **`$sort` holds its list in memory before writing.** For very large lists,
  rely on the file's own order instead.
- **Stream to disk** with `exportFile` (JS) or `WriteJson` / `WriteXml`
  (.NET) instead of building a string.

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
needed are read from disk. Keys work as in the libraries: a master key, a
password, an owner key, or an access key (with its unlock token for online
access).

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
  runs Chrome and Firefox on Linux, and Safari on macOS.
  - **Phones** (Safari on an iPhone, Chrome on Android) are checked by hand
    before each release. The results are in the release notes.
  - **Safari and "Save as HTML":** CI opens the saved copy in Safari from a
    web server, because Safari's automation can't open files from disk. The
    phone check covers opening it from disk.

For developers, the browser reader on its own is `@smithsoft-studios/jazmin/browser`
(`js/browser/jazmin-browser.js`). It is read-only, async and has no
dependencies:

```js
const reader = await JazminBrowser.open(file, { key });   // a File, Blob or bytes
for await (const row of reader.find({ country: 'ZA' })) console.log(row);
const { rows } = await reader.query({ country: 'ZA' }, { offset: 50, limit: 50, total: false });
await reader.count({ country: 'ZA' });
await reader.explain({ id: 7 }, { analyze: true });    // as in the library (section 9.6)
const pdf = await reader.readFile('terms.pdf');
```

**It plans queries as the library does** (sections 9.7 and 9.8):

- **What it uses:** chunk statistics, a binary search on the file's first
  `sortedBy` column, and offsets that skip whole chunks. For files that aren't
  access-controlled, it also uses sorted and trigram indexes, with the same
  cost rules.
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
  chunks, and suggests `compact()` when appends have spread a partition over
  more chunks than its rows need.
