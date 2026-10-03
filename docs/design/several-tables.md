# Several tables in one file (D-3)

Format 1.0 already holds a list of tables (spec 6.2), each with its own
columns, partitions, statistics, indexes and deleted rows. This note
describes the API that writes and reads more than one. It needs no format
change.

## Why

A statement file repeats each client's details on every transaction row.
With two tables, `clients` holds those details once, and `transactions`
refers to them by `clientId`. Partition names are shared by every table of
a file (spec 7.6.2), so an access key granted client `C1` sees `C1`'s rows
in both tables: access follows the link.

## Writing: declare the tables, then fill them one after another

The writer gets every table's definition up front, so it can check names,
columns, sort orders, partition columns and grants before writing anything.
The rows are then written one table at a time, like sheets added to a
workbook. Only the current table's chunk is held in memory, so memory use
does not grow with the number of tables.

```js
const writer = new JazminWriter('statements.jzm', {
  key: owner,
  access: { grants: [{ key: bob, rows: ['C1'] }] },
  tables: [
    { name: 'clients', columns: clientColumns, sortedBy: ['clientId'], partitionBy: 'clientId' },
    { name: 'transactions', columns: transactionColumns, sortedBy: ['clientId', 'date'], partitionBy: 'clientId' },
  ],
});
for (const c of clients) writer.writeRow(c);      // rows go to the first table
writer.startTable('transactions');
for (const t of transactions) writer.writeRow(t);
writer.finish();
```

```csharp
using var writer = new JazminWriter(stream, new JazminWriteOptions
{
    Key = owner,
    Access = new JazminAccessOptions { Grants = [new JazminGrant(bob) { Rows = ["C1"] }] },
    Tables =
    [
        new JazminTable("clients", clientColumns) { SortedBy = ["clientId"], PartitionBy = "clientId" },
        new JazminTable("transactions", transactionColumns) { SortedBy = ["clientId", "date"], PartitionBy = "clientId" },
    ],
});
foreach (var c in clients) writer.WriteRow(c);
writer.StartTable("transactions");
foreach (var t in transactions) writer.WriteRow(t);
writer.Finish();
```

- **What belongs to a table:** `name`, `columns` (with their indexes),
  `sortedBy`, `chunkRows`, `chunkBytes`, and in access-controlled files
  `partitionBy` and `columnGroups`.
- **What belongs to the file:** the key or password, codec, metadata,
  embedded files, and grants. A grant's `rows` names partitions and its
  `columns` names column groups of any table. Both apply to every table that
  has them.
- **Order:** tables are listed in the file in the order they are declared.
  `startTable` may take them in any order, each once; a table that is never
  started is written empty.
- **Names:** with `tables`, every table needs a unique, non-empty name. The
  single-table options (`columns`, `sortedBy`, `access.partitionBy`, ...)
  keep working as before, and cannot be combined with `tables`.
- **A table without `partitionBy`** in an access-controlled file has one
  partition, named `*`. A grant of `rows: '*'` covers it; a grant of
  `rows: ['C1']` does not. Add `'*'` to a grant's list to share such a
  lookup table, for example `rows: ['C1', '*']`.

## Reading: choose a table

```js
const transactions = open('statements.jzm', { key, table: 'transactions' });
transactions.tables; // ['clients', 'transactions']
transactions.table;  // 'transactions'
```

```csharp
using var transactions = JazminReader.Open(path, new JazminReadOptions { Key = key, Table = "transactions" });
// transactions.Tables, transactions.TableName
```

The spec requires a reader to let the caller choose a table by name, and
recommends defaulting to the first. A reader shows one table. `openTable`
(.NET `OpenTable`) reads another table of the same open file. The new reader
shares the open file, the keys and the checks already made (signature, key
slot, expiry), so it opens faster than a second `open`. The file is closed
with the last of its readers. In .NET, the readers of one stream take turns
reading it.

## Changing a file

- `append`, `update` and `compact` take a `table` option (default: the first
  table). Only that table's rows change.
- An **append** writes new sections for that table only; the other tables'
  catalog entries are carried as they are.
- A **full rewrite** (`update`, `compact`, grant, revoke) copies the other
  tables row by row into the new version, because a new version needs fresh
  secrets throughout (spec 7.6.7).

## Not in this step

- **Export shapes across tables** (a client's details next to its
  transactions in one shape) would pair with this; for now, read the two
  tables and combine them (USER-GUIDE).
- **Declared foreign keys:** the link is a convention between column names.
  It is not stored in the file.

## Results

Measured on a statement file with 20,000 clients (11 detail columns) and
300,000 transactions (15 per client), on Node.js. Clients were in 256-row
chunks and transactions in 1,024-row chunks in both files.

| | Flat | Two tables |
|---|---|---|
| File size | 3.70 MB | 3.39 MB (−8%) |
| Write | 1.28 s | 0.94 s (−27%) |
| One client's statement | 1.14 ms | 1.17 ms (two opens), 1.03 ms (`openTable`) |
| Read every transaction | 176 ms | 145 ms (−18%) |

Dictionary encoding already stores a chunk's repeated values once, so the
size gain is modest. Chunk size matters most for lookups by key. With the
default 1 MiB chunk limit, wide client rows put about 3,400 clients in a
chunk, and finding one client took 3 ms. With 256-row chunks it took 0.3 ms.
The guide recommends small chunks for lookup tables.

## Tests

- Writing and reading two tables in both libraries, including indexes,
  statistics, appends, updates and compaction of one table.
- Access: a key granted one partition sees that partition in each table, and
  a lookup table only when granted `*`.
- Interop fixtures written by each library (`*-tables.jzm`,
  `*-tables-access.jzm`).
- A normalized file smaller than the flat one on repeated client details
  (the acceptance test in TASKS).
