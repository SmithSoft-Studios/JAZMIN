# Design: export shapes

Status: **implemented in JS and .NET** (TASKS J-6). This document is the reference for both
libraries: a shape must give the same output in each.

## 1. Goal

A JAZMIN file holds rows and columns. Consumers often want something else: nested JSON or XML,
such as one entry per client with its transactions, totals, or a few values taken once from a
large table. An **export shape** describes that output as a small JSON template.

- **Validated before any data is read.** A shape that names a column the file does not have,
  or that a key cannot see, is rejected with the path of the mistake.
- **"Take the first one."** Repeated details, such as a client's name on every transaction
  row, are written once: a column read in a set of rows takes the first row's value.
- **Streamed, bounded memory.** Each list is a query on the file. Only the columns the shape
  uses are decoded, and filters use indexes and chunk statistics.
- **Describable.** A shape can produce a standard JSON Schema (draft 2020-12) of its output,
  for whoever consumes the export.

Shapes are an export feature. They do not change the file format.

## 2. Example

Rows, one per transaction: `client`, `clientName`, `address`, `date`, `amount`.

```json
{
  "statement": { "$meta": "title" },
  "clients": {
    "$rows": {
      "id": "client",
      "name": "clientName",
      "address": "address",
      "balance": { "$sum": "amount" },
      "transactions": { "$rows": { "date": "date", "amount": "amount" }, "$sort": ["date"] }
    },
    "$groupBy": "client",
    "$xmlItem": "client"
  },
  "largest": { "$rows": { "client": "client", "amount": "amount" }, "$filter": { "amount": { "gt": 10000 } } },
  "total": { "$sum": "amount" },
  "count": { "$count": true }
}
```

Output (JSON):

```json
{
  "statement": "March statements",
  "clients": [
    { "id": "C1", "name": "ABC Corp", "address": "10 Test Street", "balance": 1250.5,
      "transactions": [ { "date": "2025-03-01T00:00:00.000Z", "amount": 1000 }, { "date": "2025-03-04T00:00:00.000Z", "amount": 250.5 } ] }
  ],
  "largest": [],
  "total": 1250.5,
  "count": 2
}
```

## 3. Template nodes

A template is evaluated in a **context**. A context is either a **set of rows** (the whole
file, a group, or the rows a filter selects) or **one row** (an item of a list without
`$groupBy`).

| Node | Meaning | Allowed in |
|---|---|---|
| `"column"` (a string) | The column's value. In a set, the first row's value (null if the set is empty). | both |
| number, `true`, `false`, `null` | That literal | both |
| `{ "$value": any JSON }` | That value, as given (use it for literal strings) | both |
| `{ "$meta": "key" }` | The file's metadata member, or null | both |
| object without `$` members | An object; members are evaluated in the same context, in order | both |
| `{ "$count": true }` | Number of rows in the set | set |
| `{ "$sum": "column" }` | Sum of non-null values (int, float, decimal); null if there are none | set |
| `{ "$min": "column" }`, `{ "$max": "column" }` | Smallest / largest non-null value (bool, int, float, string, datetime); null if none | set |
| `{ "$rows": template, ... }` | A list (below) | set |

Arrays are not templates (use `$rows`). Unknown `$` members, and `$` members combined with
other members, are errors.

**Lists.** `{ "$rows": template, "$filter"?, "$groupBy"?, "$sort"?, "$limit"?, "$xmlItem"? }`
evaluates in a set and produces an array:

- `$filter` (a filter, spec section 9) narrows the set. Filters of enclosing lists and groups
  apply too.
- Without `$groupBy`, there is one item per row, in file order. The item template is evaluated
  in one-row context, so it cannot contain `$rows` or aggregates.
- With `$groupBy` (a column name or an array of names; bool, int, float, string, datetime or
  decimal columns), there is one item per distinct key, in order of first appearance. The item
  template is evaluated in the group's set, so a column gives the group's first value, and
  aggregates and nested lists cover the group's rows.
- `$sort`: an array of column names, each optionally prefixed with `-` for descending. Items
  are ordered by those columns' values (for groups: the group's first values). Nulls sort
  first, as in spec section 5.3. Without `$sort`, file order is kept.
- `$limit`: at most this many items.
- `$xmlItem`: the XML element name of each item (default `item`).

## 4. Output

- **JSON:** values as in spec section 10 (int and decimal exact, datetime as ISO-8601 UTC
  text, binary as base64, non-finite floats as null). Sums of int are exact; sums of decimal
  are exact with the largest scale of the inputs.
- **XML:** the template's root object is the `<export>` element (the name is an option).
  Object members are child elements. A list is an element whose children are the items
  (`$xmlItem`). Null values are omitted. Member names that are not valid XML names are
  written as `<field name="...">`, as in the tabular XML export.
- **JSON Schema:** objects list every member as required, with no others allowed. A column
  value has the column's JSON type, plus null when the column is nullable or the value is
  read from a set that may be empty (the root). Floats also allow null (non-finite values).

## 5. How it runs (informative)

- The root is a set: the whole file (or the export's filter). Its first-row values and
  aggregates are computed in one pass that decodes only the columns they use (a pass for
  first values alone stops at the first row).
- A list without `$groupBy` is one query: `find(filter, { select: columns used })`.
- **Groups without nested lists.** A list with `$groupBy` whose items use only first values
  and aggregates is one pass. For each group it keeps the key, the first row's values and
  running aggregates, so memory grows with the number of groups, not rows.
- **Groups with nested lists** need the group's rows, so the item's nested lists are evaluated
  over those rows in memory.
  - When the file is sorted by the group columns (`sortedBy` starts with them), groups arrive
    one after another. One pass holds a single group's rows at a time.
  - Otherwise, a first pass finds the groups and their sizes. The groups' rows are then
    collected in batches of 100,000 rows (1,000,000 when the reader's priority is `speed`), one
    pass per batch, so memory stays bounded.
  - On 1M rows with 10,000 groups, a sorted file takes 1.9 s / 147 MB in Node and 1.6-1.8 s /
    69 MB in .NET. An unsorted one takes 9.1 s in Node and 9.4 s / 116-132 MB in .NET; with
    priority `speed`, 4.0 s / 559 MB and 5.3 s / 381 MB.
- **Writing (JS).** A template without lists is compiled, once per place in the output, into a
  function from a row (or a group's first values and aggregates) to its text: member names are
  escaped once, each column type has its own text function, and indentation is fixed by depth.
  A list's rows then cost one call each. `test/shape-output.test.js` keeps the output byte for
  byte the same as 1.2.0's.
  - Held rows keep only the columns the group's template reads (.NET copies them out of the
    decoded chunk, so a batch never keeps whole chunks alive).
- **Sorting.** `$sort` holds its list's items (or groups) before writing. Prefer file order
  (`sortedBy`) for very large lists.

## 6. API

| | JavaScript | .NET |
|---|---|---|
| Export | `toJSON(reader, { shape })`, `toXML(reader, { shape })`, `exportFile(reader, 'json' \| 'xml', path, { shape })` | `JazminShape.Parse(json)`; `shape.ToJson(reader)`, `shape.WriteJson(reader, stream)`, `shape.ToXml(reader)`, `shape.WriteXml(reader, textWriter)` |
| Validate | `compileShape(reader.columns, shape)` (throws) | `shape.Validate(reader)` (throws) |
| JSON Schema | `shapeSchema(reader, shape)` | `shape.ToJsonSchema(reader)` |
