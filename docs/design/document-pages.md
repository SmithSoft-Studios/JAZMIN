# Document pages: several pages in one file, and the files they use kept out of sight

Status: **decided** (owner, 2026-10-16): in 1.7.0; buttons from each page file's actions, which a page entry may
override and the page's code may turn off and on; hidden files by path or folder; pages may also be marked in a file
group's directory, so only that group's keys see them. **Specified:** spec 6.8.

## The idea in plain words

Today a file has at most one document: `package.entry` names one HTML page, and the viewer shows it on its Document
tab. Every other stored file is listed on the Files tab, including the page's own scripts, styles and fonts, unless
each one is marked `list: false`.

With **pages**, the package settings describe the document as a set of pages, in order, each with its own options:

- **Customers**: a list of the clients, read from the `clients` table.
- **Transactions**: the transactions, read from the `transactions` table.
- **Summary**: totals across both tables, with charts that need the internet.
- **Statement**: a print layout, with Print and Save as PDF.

The viewer shows them as tabs within the Document tab, in that order. Each page is an ordinary stored HTML page that
reads the data itself (`jazmin.query`, `jazmin.count`, with `table`, as documents already can). Offline, the
**Summary** tab says it needs to be online and the others work: one page that needs the internet no longer keeps the
whole document from opening.

The package settings also list the document's **own files** (scripts, styles, fonts, images the pages load). Only the
writer knows which files those are, so the writer names them. Viewers leave them, and the pages themselves, out of the
Files tab. They are still ordinary stored files: the pages load them as before, and a key that sees a file can read it.

## How it works (for developers)

Two new optional members of the package settings (spec 6.8):

```json
{
  "entry": "customers.html",
  "pages": [
    { "path": "customers.html", "title": "Customers", "table": "clients" },
    { "path": "transactions.html", "title": "Transactions", "table": "transactions" },
    { "path": "summary.html", "title": "Summary", "online": "required" },
    { "path": "statement.html", "title": "Statement", "pdf": { "format": "A4" } }
  ],
  "files": ["app.js", "style.css", "fonts/"],
  "allowedOrigins": ["https://cdn.jsdelivr.net"]
}
```

- **`pages`**: an ordered list. Each page has a `path` (a stored file, as `entry` is), a `title` (the tab's name),
  and optionally:
  - `online` (`"required"` or `"optional"`), which overrides the package's `online` for that page;
  - `table`, the table `jazmin.query` and `jazmin.count` read when the page names none (else the first table);
  - `pdf`, page settings for that page's PDFs, over the package's `pdf`;
  - `actions` (`print`, `pdf`, `image`), over the page file's own.
- **Print, PDF and image buttons follow the page file's `actions`**, which files already have per file and per file
  group (6.8), unless the page entry gives its own. A print-layout page allows `print` and `pdf`; a list page sets
  them `false`, and the viewer shows no Print button on that tab. The page's code can turn an allowed button off and
  back on while it is shown (`jazmin.setActions`, as today), never on when it isn't allowed.
- **`entry`** stays. It is the page that opens first, and it must be one of `pages`. Writers set it to the first page
  when it is left out. Viewers of releases 1.0 to 1.6 don't know `pages`, so they show `entry` alone, as today: the
  file still opens there.
- **`files`**: paths of stored files that belong to the document, or folders (a path ending in `/`). Viewers SHOULD
  NOT list them, or the pages, in lists of the file's files. Writers check that each path is a stored file (or that
  some stored file is in the folder). Viewers of releases 1.0 to 1.6 ignore it and list the files as they do today.
- **Shared files:** a page whose file a key can't see isn't shown to that key, and neither is its tab. The package
  settings are in the file's header, which **every key reads**, so the paths and titles in `pages` and `files` are
  visible to every key, even for files a key can't open. A page whose name only some keys may see is marked instead
  in its file group's directory, which only that group's keys read: the file's entry there gets `page`, with the
  same members as a `pages` entry (no `path`) and `order`, its place among the tabs. Tabs are in this order: the
  package's `pages` as listed, then directory pages by `order`, then by path. A file the document uses that only
  some keys see is kept out of lists with `list: false` in that group's directory, as today.
- **Libraries:** JS `package.pages` and `package.files`; .NET `JazminPackage.Pages` (`JazminPage`) and
  `JazminPackage.Files`. Writers check them; append, update and compact keep them. Rewrites by releases 1.0 to 1.6 drop
  them (unknown members), and viewers then show `entry` and list every file: nothing is lost but the tabs.
- **Viewer and Scout:** Document tab with a tab per page, in order; each tab loads its page when first opened (so a
  page that is never opened costs nothing); an online-only tab, offline, shows the "needs to be online" note in that
  tab and waits for the network; Print and Save as PDF per tab from the page's actions.

No reader or writer feature is needed: every member is optional and ignored by readers that don't know it.

## Decisions (owner, 2026-10-16)

1. **Release:** 1.7.0.
2. **Buttons:** from each page file's `actions`; a `pages` entry (or directory `page`) may override them; the page's
   code may turn allowed ones off and on (`jazmin.setActions`).
3. **`files`:** exact paths and folders (a path ending in `/`).
4. **Shared files:** pages can also be marked per file group (`page` in the group's directory), so only that group's
   keys see their names.
5. **Owner view** (default taken): viewers hide pages and `files` from the Files tab for every key, the owner
   included; the libraries' `files` lists still give every file, each with its `page` when it has one.
