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

## 7. Links between tables

In a file with several tables, a list can take its rows from **another table**, linked to the
row (or set) it is written for, so one shape nests a customer, their orders, each order's lines
and each line's product.

```json
{ "$rows": {
    "id": "id", "name": "name",
    "orders": { "$from": "orders", "$on": { "customer_id": "id" }, "$sort": ["placed"],
      "$rows": { "id": "id", "placed": "placed", "total": "total",
        "lines": { "$from": "order_lines", "$on": { "order_id": "id" },
          "$rows": { "line": "line", "amount": "amount",
            "product": { "$from": "products", "$on": { "sku": "sku" }, "$one": { "name": "name", "price": "price" } } } },
        "lineCount": { "$from": "order_lines", "$on": { "order_id": "id" }, "$one": { "$count": true } } } } } }
```

- **`$from`** names a table of the file. Inside the list, column names are that table's.
- **`$on`** pairs the linked table's columns with the columns of the row the list is written
  for: `{ "customer_id": "id" }` takes the orders whose `customer_id` equals the customer's
  `id`. Several pairs must all be equal. Paired columns have the same type (bool, int, float,
  string, datetime or decimal). Values are equal as in filters: decimals by value, NaN and null
  equal to nothing, so a null on either side links no rows.
- **`$rows`** (with the list options `$filter`, `$groupBy`, `$sort`, `$limit`, `$xmlItem`) is a
  list of the linked rows, in the linked table's file order unless sorted. `$filter` uses the
  linked table's columns. Unlike other lists, a linked list is allowed in a one-row item: it is
  how a row's details nest.
- **`$one`** (with `$filter`) is the linked rows as one set: its template is evaluated in that
  set, so a column gives the first linked row's value, and aggregates and lists cover all of
  them. It is `null` (in XML, omitted) when no row is linked. Typical uses: the one product of a
  line, or an order's count and total of lines.
- The **parent's context** carries on: a link in the root uses the root set's first values, so
  `toJSON(customers, { shape, filter: { id: 42 } })` with links in the root object exports one
  customer with their orders. The export's `filter` applies to the reader's own table only.
- **Shared files:** each linked table is read with the same key, so partitions and column groups
  apply in every table; a hidden column is an error when the shape is checked, as elsewhere.
- **Validation** names the place of a mistake: an unknown table, an unknown or hidden column of
  the linked table or of the parent, types that differ, an empty `$on`, or both `$rows` and `$one`.

**How it runs (informative).** Each link takes one of three paths, chosen once per list:

- **Small linked tables** (up to 10,000 rows with priority `memory`, 100,000 by default,
  1,000,000 with `speed`) are read once and kept by key: a product looked up for every order
  line costs a map lookup.
- **In step with the parents (a merge).** When every link of a list's items follows the sort
  order, each linked table is read once, front to back, alongside its parents, holding only the
  current parent's rows. "Follows the sort order" means:
  - the linked table's `sortedBy` starts with the linked columns (in any order of `$on`);
  - the parents arrive sorted by the columns they pair with: the reader's table in file order
    (no `$sort`), or the rows of a link that is itself read in step (no `$sort` or `$groupBy`);
  - the linked columns are not floats (NaN has no place in the order).

  Nested links must follow it too (a held table's rows come in their parents' order, so links
  under it must be held as well), otherwise the list uses batches. A parent whose key comes
  before the last one asked for (repeated parents with links under them) gets its rows with a
  query of its own, so the result never depends on the path. When a pass skips more than 2,048
  rows to reach the next parent (a filtered export), it starts again at that parent's key, and
  chunk statistics skip the rows between.
- **In batches of parents** otherwise: 2,500 parents with priority `memory`, 10,000 by default,
  20,000 with `speed`. For each batch, each link is fetched once for all the batch's parents
  (and recursively for their linked rows): one query with an `in` condition on the linked
  columns, plus the link's `$filter`. When the linked rows lie scattered, each batch reads about
  the whole linked table, so larger batches mean fewer passes and more rows held.
- A link written for a group, or for the root, is fetched for that one parent.

Measured on 100,000 customers, 1,000,000 orders and 2,498,976 lines (customers, their orders,
lines and each line's product; 360 MB of JSON). The tables exported one by one with the same
columns take 2.6 s / 70 MB in .NET and 4.8 s / 200 MB in Node.

| Layout | .NET | Node |
|---|---|---|
| Sorted by the links: orders by `customer_id, id`, lines by `customer_id, order_id, line`, linked on both columns | 4.5 s / 84 MB | 7.2 s / 220 MB |
| The same, one customer / 1,000 customers | 0.17 s / 0.44 s | 0.08 s / 0.13 s |
| Orders and lines in time order (batches), by default | 19 s / 238 MB | 27 s / 578 MB |
| The same with priority `memory` | 37 s / 100 MB | 64 s / 364 MB |

So when a file is written for nested exports, sort each linked table by its link to the parent
table, with the parent's own sort columns first.

## 6. API

| | JavaScript | .NET |
|---|---|---|
| Export | `toJSON(reader, { shape })`, `toXML(reader, { shape })`, `exportFile(reader, 'json' \| 'xml', path, { shape })` | `JazminShape.Parse(json)`; `shape.ToJson(reader)`, `shape.WriteJson(reader, stream)`, `shape.ToXml(reader)`, `shape.WriteXml(reader, textWriter)` |
| Validate | `compileShape(reader.columns, shape)` (throws) | `shape.Validate(reader)` (throws) |
| JSON Schema | `shapeSchema(reader, shape)` | `shape.ToJsonSchema(reader)` |
