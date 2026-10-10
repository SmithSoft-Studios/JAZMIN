# Saved export shapes (TASKS J-9)

Status: approved 2026-10-10 (TASKS J-9). Builds on export shapes ([export-shapes.md](export-shapes.md)).

## What people get

- **A file carries named export shapes,** each with a description, the table it reads and, optionally, marked as the
  default. Viewers and tools offer them by name: the viewer's "Export as Monthly totals",
  `jazmin query data.jzm --shape "Monthly totals"`, `toJSON(reader, { shape: 'Monthly totals' })`.
- **Each key sees only the shapes it can use.** A key never sees a shape that uses a column it can't see, in any
  table the shape links: such shapes are not listed at all.
- **Different people can have different shapes.** In a shared file, a shape is saved for file groups (7.6.3), and only
  keys that see one of those groups see it.
- **Saving checks every key that will see the shape.** A shape that uses a column one of them can't see is refused,
  naming the key and the column. Shapes typed on the spot (the viewer's shape box) are checked the same way, against
  the current key.

## Where they are stored

In the **file directory** (spec 6.8), as an optional member beside `files` and `contents`:

```json
{
  "files": [],
  "contents": [],
  "shapes": [
    { "name": "Monthly totals", "description": "Spending per account and month", "default": true, "groups": ["*"],
      "shape": { "accounts": { "$groupBy": "account", "$rows": { "account": "account", "total": { "$sum": "amount" } } } } },
    { "name": "Fees", "table": "fees", "groups": ["*"], "shape": { "$rows": { "date": "date", "fee": "amount" } } }
  ]
}
```

- **Files that are not shared** (one key, a password, or none) have one directory, group `*`: everyone who can open
  the file sees every shape, as they see every column.
- **Shared files** have one directory per file group, encrypted for that group alone (`F(id)`). A shape saved for a
  group is written in that group's directory, so only keys that see the group can read it.
- **Why not beside the document settings (`package`):** every key of a shared file reads `package`. A shape there that
  names a restricted column would reveal the column's name, which the format keeps secret (restricted column groups'
  definitions are encrypted, S-6).
- `name` (1 to 200 characters) is unique within a file; `description` has at most 2,000 characters; at most one shape
  is the default for each group, and a file keeps at most 1,000 shapes.
- `table` names the table the shape reads; left out, the file's first table (so a writer leaves it out for that one).
- `groups`, as for files, is written in directories of files that are not shared; shared files' directories leave it
  out, so a key does not learn other groups' names.
- A file with shapes and no embedded files has a directory with empty `files` and `contents`.

## Checks

- **Writing** (the owner, or the single key or password): each shape must compile against the file's tables (the rules
  of export-shapes.md). In a shared file, for each group a shape is saved for, every grant that sees that group must see
  every column the shape uses, in every table; otherwise the write is refused:
  `Shape 'Monthly totals' uses column 'balance', which access key 3f2a9c… (group ZA) can't see`.
- **Granting later:** granting a key a group whose shapes use columns that key can't see is refused the same way, so
  a shape's text never reaches a key that can't use all of it. The owner saves the shape for a narrower group, or
  widens the grant.
- **Reading:** a reader lists the shapes of the directories its key opens that compile against its own columns, and
  leaves out any that don't (a second guard).

## API

| Where | Writing | Reading |
|---|---|---|
| Node | `write(…, { shapes: [{ name, shape, description, default, table, groups }] })`; `update` and `append` take `addShapes` (a name that exists is replaced) and `removeShapes` (names) | `reader.shapes` → `[{ name, description, default, table, groups, shape }]`; `toJSON(reader, { shape: 'name' })`, `shapeSchema(reader, 'name')` |
| .NET | `JazminWriteOptions.Shapes`; `JazminUpdate` and `JazminAppend`: `AddShapes`, `RemoveShapes` | `reader.Shapes`; `JazminShape.FromFile(reader, "name")` |
| Browser reader | | `reader.shapes`; `toJSON(reader, { shape: 'name' })` |
| CLI | | `jazmin inspect` lists them; `jazmin query … --shape "name"` (or `--shape-file shape.json`), JSON or XML |
| Viewer | | Export ▾ lists the file's shapes (the default first): "Export as …" JSON or XML; the shape box can start from one |

A saved shape runs on its own table, whichever table the reader was opened on; a filter applies to that table's rows.

The viewer doesn't write files: shapes are saved with the libraries or the CLI.

## Compatibility

- **Older readers** (1.0 to 1.4) ignore the new member and read the file as before: to be tested with the published
  npm and NuGet 1.4.0 (npm 1.4.0 reads plain, single-key and shared files with shapes, 2026-10-10). No reader feature
  is needed.
- **Older writers** that append to, update or compact such a file leave the shapes out, as 1.3 leaves out 1.4's
  document settings: documented, and rewriting with the new version keeps them.

## Tests

Both libraries write and read shapes, plain and shared (Bob and Sally see different shapes, and none they can't use);
refused saves and grants; interop fixtures each library reads from the other; the published 1.4.0 packages read the
files; the browser reader; the viewer's Export menu in the browser tests.
