# Tables in an existing file: adding them, and the links between them

Status: **proposal, awaiting the owner's decisions** (2026-10-14). Nothing here is built yet. No change to the file
format is needed.

## What there is today

- A file can hold several tables (USER-GUIDE 23): clients once, their transactions by client.
- **Tables are chosen when the file is written.** `update`, `append` and `compact` change rows of an existing table,
  and now its indexes and sort order, but cannot add, remove or rename a table. Adding one means writing a new file.
- **Links between tables are not stored anywhere in the file.** They exist only where they are used: in a saved export
  shape (`$from` with `$on: { clientId: 'clientId' }`), in a query's `join`, and, for access, in partition names that
  every table shares (a key granted client `C1` sees `C1`'s rows in every table partitioned by client).
- Scout's visual-builder plan (private) finds likely links from names and values and would keep the confirmed ones in
  `studio/relations.json` inside the file, readable only by the owner.

## What "re-linking" and "adding linked tables" could mean

1. **Add a table to an existing file** that links to one already there: for example `payments`, linked to `clients` by
   `clientId`, added to a statements file without rewriting it by hand. Also remove or rename a table.
2. **Declare links**, so every tool knows them: "transactions.clientId → clients.clientId, many to one". Then viewers
   can show a client's transactions from the client's row, Query Studio and GraphQL can offer `client.transactions`,
   and shapes can use a link by name.
3. **Re-link:** change a declared link (another column, another target table), or point a table at a replacement (a new
   `clients` table).
4. **Check and repair links:** rows whose link finds nothing (a transaction for a client that isn't there), listed, and
   fixed by deleting them or giving them the right value.
5. **Change key values everywhere at once:** client `C001` becomes `C900` in `clients` and in every table that links to
   it, in one rewrite.

Please confirm which of these you mean; the plan below covers all five, in the order they build on each other.

## The plan

**1. Add, remove and rename tables** (library, both languages; no format change):

```js
update('statements.jzm', { key,
  addTables: [{ name: 'payments', columns, sortedBy: ['clientId'], partitionBy: 'clientId', rows: paymentRows }],
  removeTables: ['old'],
  renameTables: { tx: 'transactions' },
});
```

- One rewrite; the new table's rows are streamed from any iterable (bounded memory), and its indexes and sort order
  are set as for a new file.
- **Shared files:** a new table partitioned by the same column uses the same partition names, so access follows: Bob,
  granted client `C1`, sees `C1`'s payments with no change to his grant. A table with no partition column has one
  partition `*`, visible only to grants that include `*` (as today, 23.3).
- Saved shapes that read a removed table are refused with their names, unless removed too; renaming a table renames it
  in saved shapes.

**2. Links declared in the file** (library: free, so every viewer reads the same):

```js
update('statements.jzm', { key, links: [
  { name: 'client', from: { table: 'transactions', columns: ['clientId'] }, to: { table: 'clients', columns: ['clientId'] } },
] });
reader.links;   // the declared links
```

- Stored in the file's metadata under a reserved name (`jazmin.links`), like change files' `jazmin.changes`: no format
  change, older readers simply don't use it. Names, tables and columns only; never values.
- Checked when written: both tables and columns exist, the types are equal, and the target columns are unique in their
  table (a sorted index or the sort order proves it cheaply).
- Shapes may then say `$link: 'client'` instead of repeating `$from`/`$on`.

**3. Check links** (library `checkLinks`, Scout's Check tab): for each link, how many rows find nothing, with the first
few keys; read from the indexes and the sort order where they exist, so it stays cheap on large tables.

**4. Repair and re-key** (library `update` across tables in one rewrite):

```js
update('statements.jzm', { key, tables: {
  clients: { upsert: [{ clientId: 'C900', name: 'Ann' }], delete: { clientId: 'C001' } },
  transactions: { set: { clientId: 'C900' }, where: { clientId: 'C001' } },
} });
```

Today each table needs its own rewrite; one rewrite for several tables keeps them consistent and halves the work.

**5. Scout** (Pro):
- **Add Table…** on a `.jzm`: the New File panel, with the source (CSV, JSON, XML, Excel), its columns, and **Links to**:
  pick a table and its key, with a preview of how many rows find their match before anything is written.
- The **relationship map** from the visual-builder plan, reading the file's declared links (and suggesting new ones as
  planned), with **Re-link…** and **Remove link**.
- **Check links** on the Check tab, with **Show the rows** and **Fix…** (delete them, or give them a value).

## Decisions for the owner

1. **Which meanings** (1 to 5 above) are wanted, and in what order. Recommendation: 1, then 2 and 3, then 5, then 4.
2. **Links in the file for everyone (free library), or Scout only?** Recommendation: in the file, because the free
   viewer can then show linked rows and every tool agrees; the map, the builder and the repair tools stay in Scout. The
   more restrictive choice is Scout only (`studio/relations.json`, owner-only), which the visual-builder plan already
   describes; links can move into the library later, never the reverse.
3. **Can a table be added by append** (no rewrite)? It is possible in the format (an append writes a new header), but
   adds work to every reader of appended files. Recommendation: by rewrite only, at first.

## Cost

Adding a table costs a rewrite of the file (about 1.8 s per million rows in either library, USER-GUIDE 16.1) plus
writing the new table. Declaring links costs nothing to readers. Checking a link reads the linking column of one table
and looks values up in the other's index: about a full read of one column.
