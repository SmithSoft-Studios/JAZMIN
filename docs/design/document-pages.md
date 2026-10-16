# Document pages: several pages in one file, and the files they use kept out of sight

Status: **draft for the owner's review** (2026-10-16). Nothing is built yet. The questions are at the end.

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
  - `pdf`, page settings for that page's PDFs, over the package's `pdf`.
- **Print, PDF and image buttons follow the page file's `actions`**, which files already have per file and per file
  group (6.8). A print-layout page allows `print` and `pdf`; a list page sets them `false`, and the viewer shows no
  Print button on that tab. This uses the existing signed rules instead of a second copy of them.
- **`entry`** stays. It is the page that opens first, and it must be one of `pages`. Writers set it to the first page
  when it is left out. Viewers of releases 1.0 to 1.6 don't know `pages`, so they show `entry` alone, as today: the
  file still opens there.
- **`files`**: paths of stored files that belong to the document, or folders (a path ending in `/`). Viewers SHOULD
  NOT list them, or the pages, in lists of the file's files. Writers check that each path is a stored file (or that
  some stored file is in the folder). Viewers of releases 1.0 to 1.6 ignore it and list the files as they do today.
- **Shared files:** a page whose file a key can't see isn't shown to that key, and neither is its tab. One detail
  matters here: the package settings are in the file's header, which **every key reads**. So the paths and titles in
  `pages` and `files` are visible to every key, even for files a key can't open. A page whose very name must stay
  secret shouldn't be named there (see question 4).
- **Libraries:** JS `package.pages` and `package.files`; .NET `JazminPackage.Pages` (`JazminPage`) and
  `JazminPackage.Files`. Writers check them; append, update and compact keep them. Rewrites by releases 1.0 to 1.6 drop
  them (unknown members), and viewers then show `entry` and list every file: nothing is lost but the tabs.
- **Viewer and Scout:** Document tab with a tab per page, in order; each tab loads its page when first opened (so a
  page that is never opened costs nothing); an online-only tab, offline, shows the "needs to be online" note in that
  tab and waits for the network; Print and Save as PDF per tab from the page's actions.

No reader or writer feature is needed: every member is optional and ignored by readers that don't know it.

## Questions for the owner

1. **Release:** in 1.7.0 (which is otherwise ready, apart from the phone check), or in 1.8.0 so 1.7.0 can ship now?
   *Recommended: 1.8.0.* It touches the spec, both libraries, the browser reader, the viewer and Scout, plus samples.
2. **Print and PDF buttons per page from each page file's `actions`** (as above), or a copy of them in each `pages`
   entry? *Recommended: from the file's actions,* which already work per file group and are signed with the file.
3. **`files` with folders** (`"fonts/"` hides every file in that folder), or exact paths only? *Recommended: both,*
   so a document with many images or fonts lists one folder.
4. **Pages and files in shared files** whose names must stay secret from some keys: accept that names in the package
   settings are visible to every key (and say so in the spec), or also allow a page to be marked per file group
   (a `page` action in the group's directory, which only that group's keys read)? *Recommended: accept it for now and
   say so;* add the per-group marking later if a real file needs it.
5. **Hide the pages and `files` from the Files tab for the owner too?** *Recommended: hide them for everyone in
   viewers.* Tools that change the file (such as the library's `files` list) still list every file.
