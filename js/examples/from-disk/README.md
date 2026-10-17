# JAZMIN from disk (sample)

> **What this shows:** a folder of pages that open `.jzm` files in a browser with no server, one feature per demo, each
> page saying at its top what it shows. **Features:** opening files from disk and the viewer in your own page (USER-GUIDE
> §24.4), with export shapes, several tables, documents and document pages, access keys, pages and locked files only
> some keys see, 2FA and locks with a key service, masked columns, newest-first reads and estimates, text orders, nested
> columns, and records written in the browser and sent back.

Pages that open `.jzm` files **straight from disk**: double-click an HTML file, with no web server, no Node and
nothing uploaded. See USER-GUIDE §24.4 for the details and measurements.

| Page | What it shows |
|---|---|
| `index.html` | Where to start: the two ways of opening files, and the demos |
| `small-file.html` | **A statement that opens by itself,** with no choosing: the file is named in `data.js`. Totals, spending by category, and a merchant search that says how long it took |
| `pick-file.html` | **Any file, any size:** a start page asks for the file (Browse, or drop it); once chosen, it opens in the viewer, which reads only what it needs. For the demo file, buttons above the viewer try filters; **Newest 20** reads the latest matches last first (`reverse: true`, USER-GUIDE §9.7) beside counting and reading the last page, both timed; **What will this read?** shows the browser reader's `estimate()` and `explain()` before the read, then the measured count and first 100 rows (§9.6) |
| `shapes.html` | **Export shapes:** a bar chart drawn from a shape saved in the file, in one call; the file's saved shapes with their JSON, XML, JSON Schema and the shape itself; a lab that checks a shape as you type and shows its output |
| `tables.html` | **Several tables:** a bank's clients and their transactions in one file. Pick a client: their spending and latest transactions come from a saved shape that links the two tables; all their transactions from the second table. **Query both tables:** four queries in JavaScript with `JazminBrowser.from` (arrow functions whose filters the file answers; joins, groups and sorts in memory), each shown as it runs with the same query in C# LINQ. Export every client, or open both tables in the viewer |
| `documents.html` | **Documents:** a report that saves itself as a PDF in one click, a task list that saves changes, a dashboard that needs the internet, and a **client file of four pages** shown by the viewer as tabs (USER-GUIDE §19.7). Each lists its own scripts and styles in `package.files`, so the viewer's Files tab shows only the files people want |
| `shared.html` | **One file, three people:** the same file opened with three access keys, side by side: each sees its own rows, columns, saved shapes, files and document tabs, with a line saying what. HR's key also sees a **Pay review 2027** tab (a page marked on a file of the `hr` group, §19.7) and a file **locked with a password** (§19.6), which it unlocks in the page (`reader.unlock()`) or in the viewer; the other keys see neither the tab nor the file's name. Each card opens its key's view in the viewer |
| `two-factor.html` | **A file that asks for a code:** an online access key, whose unlock token the sample key service (`dotnet/samples/Jazmin.KeyService`) gives out only after a code from an authenticator app. Set the app up by QR code, see the key alone refused, then open the file with a code. Step 4: **contracts locked with a lock that names the same service** (spec 6.8.2): the viewer's **Sign in at localhost:5080** gets the lock's token after a code. Needs the .NET 10 SDK to run the service; step 4 from disk needs Firefox (see below) |
| `sort-order.html` | **Text orders** (USER-GUIDE §16.1): the same 44 customers in plain order and in an order that ignores case and accents and puts numbers by value (`{ column: 'name', nocase: true, natural: true }`), side by side, with a search and Last first |
| `nested.html` | **Nested columns** (§4.2): 5,000 orders with their lines (a list of objects) and delivery (an object). Four questions with `any`, `all` and `match`, answered by the reader, against the same orders as JSON text read and checked in the page; both file sizes |
| `send-back.html` | **Records sent back** (§24.3, §15.6): the shared inspections file opened with an area manager's key; a form (and a photo, made at most 1,600 pixels wide) written into a `.jzm` in the browser with the key's submission key, checked, and offered for download; the owner's commands to file it with the filing-service sample |
| `masked.html` | **Masked columns:** a payroll opened with a clerk's access key: emails, bank accounts, ID numbers and the directors' salaries show masked (each as its rule lets it show) until the lock's password opens them; then each value reveals for a few seconds with a countdown. **Export:** CSV and JSON side by side, masked (`revealMasked: false`) and with revealed values, with timings; `id_number` stays masked in both (`package.masks`: `export: false`). Open it in the viewer with the key |
| `signatures.html` | **Who published a file** (USER-GUIDE §26): eight signed files in the viewer, whose bar shows the publisher, the document code and the signed facts. A certified payslip whose page asks for a web font and is shown without the internet; a locked payslip whose publisher shows before the password; a sole trader; a co-signature; a withdrawn document; one changed after signing; one signed with a key nobody certified; and the payslip in the released viewer. The files are signed under the **test root** of `spec/fixtures/publisher` and open in a **test build** of the viewer (`viewer-test/`, marked TEST): the released viewer trusts only SmithSoft's roots |
| `viewer/index.html` | The viewer on its own: choose or drop a file in it |

## Run it

```bash
node examples/from-disk/make.mjs                  # in js/: about 7 seconds
node examples/from-disk/make.mjs D:/somewhere --rows 5000000    # another folder, a bigger demo file
```

Then open `examples/from-disk/site/index.html` in Chrome, Edge or Firefox. Each page says at its top what it shows and
which feature, with its USER-GUIDE section. The password is `demo` (the demo pages fill
it in). The `site` folder needs nothing else: copy it to a USB stick or a shared drive and it still works.

## The demo data

Card transactions that look like real ones (`demo-data.mjs`): merchants, categories and amounts that fit them, a
salary on the 25th of each month. The same every time.

| File | What it holds | How it is written |
|---|---|---|
| `data/statement.jzm` (3 KB) and `statement.jzm.js` | One account, January to March 2026: 138 transactions, with the holder, period and opening balance in its metadata, and four saved shapes | Locked with the password |
| `data/transactions.jzm` (22 MB) | 1,000,000 transactions across 500 accounts, through 2026 (`--rows` for more or fewer), and three saved shapes | Locked with the password, **sorted by date**, with **indexes on account, merchant (with text search), category and amount** |
| `data/bank.jzm` (180 KB) and `.js` | Two tables: 250 clients (sorted by id, a text index on name) and their 26,328 transactions (sorted by client and date), with three saved shapes, one linking the tables | Locked with the password |
| `data/report.jzm` (11 KB) and `.js` | Two tables: six months of sales for five branches, and each branch's target, which the page reads by name (`jazmin.query({}, { table: 'targets' })`) and links to the sales. A page that draws the report (`documents/report`) with a small PDF writer beside it (`pdf.js`), A4 page settings, and a saved shape. Its CSS and scripts are its own files (`package.files`) | Open to anyone |
| `data/tasks.jzm` (6 KB) and `.js` | Seven tasks, and a page that edits them (`documents/tasks`); the package says which columns may change, and lists the page's own files | Locked with the password |
| `data/dashboard.jzm` (6 KB) and `.js` | The sales again, and a dashboard (`documents/dashboard`) that loads the Inter font from Google Fonts, and Chart.js (an exact version, with its `integrity` hash) and icons from jsDelivr. The package lists those sites (`allowedOrigins`) and says it needs to be online (`online: 'required'`): the viewer says so, and offline waits for the network. Without the charts the page shows a table. Its own files in `package.files` | Open to anyone; needs to be online |
| `data/client-file.jzm` (191 KB) and `.js` | The bank's clients and transactions again (a text index on name, a sorted one on segment), with a document of four pages (`documents/client-file`): **Clients** (table `clients`) and **Transactions** (table `transactions`), both without Print (`actions: { print: false }`); **Summary**, Chart.js from jsDelivr pinned with its `integrity` hash, `online: 'required'` on that page only, a table without it; **Statement**, a quarter's statement laid out for A4 (`pdf: { format: 'A4' }`) with Print and Save as PDF. `app.js` and `app.css` in `package.files`: the Files tab has nothing left to list, so the viewer hides it | Locked with the password |
| `data/shared.jzm` (13 KB) and `.js` | 30 staff in three branches: rows by branch, pay in a column group, files and saved shapes for groups, three access keys (`data/shared-keys.js`, for this demo only). The Handbook is the document's page (`package.pages`); `hr/pay-review.html` (`documents/shared`) is a page marked on its file (`page: { title: 'Pay review 2027', order: 1 }`) in the `hr` group, and reads `hr/increases-2027.csv`, locked by the `pay-review` lock (password `review 2027`, in `data/shared-keys.js`): `jazmin.file()` gives it once the lock is open | Access keys; a lock's password |
| `data/signatures/` | Seven signed files from `spec/fixtures/publisher` (each with its `.js`), and `keys.js` with the co-signed file's key, for this demo only | Signed under the test root; one with a password, one with a key |
| `data/payroll-masked.jzm` (9 KB) and `.js` | October's payroll for 40 staff in four branches. `email` (format kept), `account` (format kept, last 4), `id_number` (first 2 and last 2) and `salary` (only the directors' rows, `rows: { grade: 'Director' }`) are masked, under one password lock; `package.masks` says how viewers show revealed values, and `export: false` for `id_number`. One access key and the lock's password in `data/masked-keys.js`, for this demo only | An access key, and a lock's password |
| `data/remco.jzm` (3 KB) and `.js` | Eight executives' pay, for a remuneration committee. One **online** access key (`data/two-factor-keys.js`, for this demo only), and its unlock token in `key-service/tokens.json` for the sample key service, listed with the owner key (`listUnlockTokens`) so the service never holds it | An online access key |
| `data/contracts.jzm` (5 KB) and `.js` | The executives' contracts: rows with their terms, and three contracts locked by the `contracts` lock, `{ online: true, keyService: 'http://localhost:5080/jazmin/unlock' }`. The lock's token is in `key-service/tokens.json` too (`locks`, from `listFileUnlockTokens`) | An (offline) access key; the lock's token from the key service |
| `data/customers.jzm` and `data/customers-plain.jzm` (3 KB each) and `.js` | 44 business customers: lower-case surname prefixes (du, le, van), accented names, numbered shops. Written in sign-up order, then put in order with `update()`: `[{ column: 'name', nocase: true, natural: true }]`, and plain `['name']`. A text index on name | Open to anyone |
| `data/orders.jzm` (88 KB) and `data/orders-json.jzm` (131 KB), and `.js` | 5,000 orders, July to September 2026, with 16,438 lines: `lines` (a list of objects: sku, product, qty, price) and `delivery` (an object: method, city) as nested columns, and the same as `json` columns. Sorted by date, a sorted index on branch | Open to anyone |
| `data/inspections.jzm` (5 KB) and `.js` | 36 store inspections in three branches, with an `attachments` column for the files sent with records; two area managers' access keys (`data/inspection-keys.js`, for this demo only). `filing/owner.key` is its owner key, FOR THIS DEMO ONLY, and `filing/inbox/` where saved batches go | Access keys |

The indexes and the sort order are what make it fast: a filter on those columns reads only the rows it returns, and
counts its matches without reading them. Measured in Chrome, on the 1,000,000 transactions:

| Try button (pick-file.html) | Filter | Matches | Rows and total shown in |
|---|---|---|---|
| (opening the file) | password `demo` | 1,000,000 rows | 190 ms |
| One account | `{ "account": "ACC-1042" }` | 2,053 | 32 ms |
| Spends over R 20,000 | `{ "amount": { "lt": "-20000" } }` | 3,763 | 27 ms |
| Travel in March | `{ "category": "Travel", "date": { "gte": "2026-03-01T00:00:00Z", "lt": "2026-04-01T00:00:00Z" } }` | 2,703 | 79 ms |
| Salaries | `{ "category": "Income" }` | 6,000 | 10 ms |
| Coffee shops | `{ "merchant": { "icontains": "coffee" } }` (text search) | 63,535 | 0.56 s |

A filter on a column with no index, and outside the sort order (such as `city`), reads every row: the viewer shows its
first page at once and counts the rest while the rows show, with progress and Stop.

## The demos

Measured in Chrome on an ordinary laptop, from disk:

| Demo | What it shows | How fast |
|---|---|---|
| Export shapes (`shapes.html`) | The chart's labels and values from the saved shape *Chart data*: `JSON.parse(await JazminBrowser.toJSON(reader, { shape: 'Chart data' }))`. The four saved shapes, each as JSON, XML, its JSON Schema, or the shape; the lab | The statement opens in 100-160 ms; each shape's output in 10-50 ms |
| The same, with 1,000,000 rows (`pick-file.html`, `data/transactions.jzm`) | The viewer's Export ▾ lists the file's three saved shapes | *Accounts* 1.5 s, *Cities* and *Spending by category* 2.3 s, under the viewer's progress overlay |
| Several tables (`tables.html`) | One client's spending and latest transactions through the saved linked shape (limited to them by a filter), then all their transactions from the second table; four queries across both tables, next to their LINQ | Opens in about 130 ms; a client's linked shape 100-150 ms, their transactions 3-10 ms (sorted by client: a binary search); each query 20-75 ms |
| Documents (`documents.html`) | The report draws itself from `jazmin.rows()`, and each branch's target from its second table, with `jazmin.query({}, { table: 'targets' })`. **Save as PDF** makes an A4 PDF in the report's page and downloads it, with no print dialog: `pdf.js`, stored in the file beside the page, draws the same report in the standard Helvetica fonts (text you can select and search, 3.8 KB), and `jazmin.download()` saves it. Print uses the browser's dialog. The task list saves a change file through the viewer, which shows what will change first | Opens at once; the PDF in 57–70 ms (Chrome, three runs) |
| A file that asks for a code (`two-factor.html`) | The key alone is refused (`JazminUnlockRequiredError`, with the file's and the key's ids); a wrong code, or a code used already, gets no token; a fresh code does | The key service checks the code and gives the token in about 15 ms; the file then opens in about 14 ms |
| Masked columns (`masked.html`) | The key alone sees what the rules show (`a•••••••••••@harbourco.co.za`, `•••• ••• 5526`, `80••••89`, `••••`); `reader.unlock('payroll', { password })` adds the values. An export gives each masked column as one column: before the lock opens both exports are the same; after, the revealed one has the values (and is smaller: 4.3 KB against 5.8 KB, since each • is 3 bytes in UTF-8) | Opens in 6-7 ms; the lock opens in 83-90 ms (the password's key derivation); each 40-row export in 3-13 ms (the first JSON one 17-19 ms). Chrome, four runs |
| One file, three people (`shared.html`) | Three access keys: the Cape Town manager sees Cape Town with pay; the Johannesburg team lead sees Johannesburg without pay (the pay columns can't be decrypted, and their names aren't known); HR sees everything, plus the HR files, the *Pay by branch* shape, the *Pay review 2027* tab and the locked increases, which the lock's password opens | Each key opens the file in 4-14 ms; the lock opens in 82-87 ms (the password's key derivation) |
| Newest 20 (`pick-file.html`, 1,000,000 rows) | The newest 20 matches, counted then the last page read, against `reverse: true`: the same rows | One account 511-796 ms against 14-20 ms; spends over R 20,000 578-778 ms against 23-33 ms; coffee shops (text search) 2.5-2.65 s against 125-133 ms; no filter 2-3 ms both ways |
| What will this read? (`pick-file.html`) | `explain()` before the read, beside `estimate()`: one account, an index with 2,053 candidate rows, counted with no chunk read; coffee shops, 63,535 candidates whose count reads all 245 chunks | `explain()` 0.1-15 ms (131 ms for the text search); the count 6-15 ms with an index, 707-750 ms for the text search |
| Text orders (`sort-order.html`) | Bakery 7 before Bakery 21, Fresh Market 2, 10, 12, du Plessis among the Ds and Éclair among the Es, against plain order | Both files open in 8-13 ms and read in 3-4 ms |
| Nested columns (`nested.html`) | Four questions inside the orders (`any`, `all`, `match`, and `any` with a text search), the same matches both ways; 88 KB against 131 KB (33% smaller) | 4-9 ms against 17-28 ms for the JSON file read and checked in the page |
| Send a record back (`send-back.html`) | An inspection written in the browser with the submission key, opened again with it to check; `inbox.mjs` files it (`filed: 1, files: 1`) and the page shows it after `jazmin script` | The shared file opens in 10-45 ms; the file is written in 14-15 ms (1.3 KB), 20-21 ms with an 86 KB photo |

## How it works

**The rule we work around.** A page opened from disk may not read other files on the computer by itself, not even a
file in its own folder. Chrome and Edge refuse it outright; Firefox allows it but reads the whole file. This is a
browser security rule, and no code in the page can get past it. A page on disk may still do two things:

1. **Read a file the person chooses** (or drops on it). The page gets a reference to the file on disk, not its
   contents, and can read any part of it.
2. **Load a script,** from any folder, as every page loads its JavaScript.

Each of the two ways below uses one of these.

**Any file, any size: the person chooses it** (`pick-file.html`). The page starts by asking for the file: a drop area,
and a text box that shows the chosen file's name beside a Browse button. (The box can't take a typed path: browsers
open only files the person chooses or drops.) Once a file is chosen, the page shows the viewer and hands it the
reference:

```js
viewer.contentWindow.postMessage({ type: 'jazmin:open', file, name: file.name }, '*');
```

The viewer reads only the parts it needs, straight from disk. Opening a 201 MB file reads 0.07 MB, and finding one row
by id reads 0.15 MB more. The viewer tells the page how the file opened (`opened`, `locked` or `failed`) and nothing
else: the password is typed in the viewer, and the data stays there. On `failed` (not a JAZMIN file, say), the page
asks for a file again, with the reason; "Open another file" goes back to it too.

The Try buttons are listed in `data.js` (`demos`) for the demo file's name. Each sends the viewer a filter, as typing it
in its Filter box does:

```js
viewer.contentWindow.postMessage({ type: 'jazmin:filter', filter: { account: 'ACC-1042' } }, '*');
```

This way names nothing in advance, so it suits files that change or that people keep themselves. `small-file.html`
below is the other way: the file is named in `data.js` and opens with no choosing.

**A small file, with no choosing: the file as a script** (`small-file.html`). Because a page may load a script, we put
the file inside one. `statement.jzm.js` holds the file's bytes written as text (base64, the usual way to carry bytes
in text), with one line of code that puts that text into a list on the page:

```js
(function (scripts, script) { scripts[script ? script.src : "statement.jzm"] = { name: "statement.jzm", data: "SlpNMQ..." }; })(...);
```

The page calls `JazminBrowser.openScript(data.file, { password })`. It adds the script to the page, waits for it to
run, takes the text from the list, turns it back into the file's bytes, lets the text go and opens the bytes. The
file inside is the `.jzm` as it is, so it stays locked until the password is given.

**A key service's sign-in window, from disk** (`two-factor.html`, step 4). The viewer opens the service's sign-in page
in a window, which posts the lock's token back to the viewer. Firefox gives a page opened from disk the origin `null`,
which works (allow `null` in `Jazmin__AllowedOrigins`, for a demo on your own computer). Chrome and Edge give it the
origin `file://`, which a window can't post a message to, so the sample service refuses that viewer. In those
browsers, serve the folder: `node examples/from-disk/serve.mjs` (in `js/`, on `http://127.0.0.1:8417`, never the
`filing/` folder with the demo owner key), and start the service with that origin allowed too, as step 1 shows. Every
other page works from disk.

**A script's file in the viewer** (`documents.html`, `tables.html`). `JazminBrowser.scriptBytes(url)` gives the file
inside a script, still locked, and the page hands it to the viewer, as `pick-file.html` hands it a chosen file:

```js
const bytes = await JazminBrowser.scriptBytes(data.report);
viewer.contentWindow.postMessage({ type: 'jazmin:open', file: new Blob([bytes]), name: 'report.jzm' }, '*');
```

## Make your own

Write the `.jzm` with the library as usual, then make it into a script, again whenever the data changes:

| Where | How |
|---|---|
| Command line | `jazmin script statement.jzm` (writes `statement.jzm.js` beside it) |
| Node | `fs.writeFileSync('statement.jzm.js', portableScript('statement.jzm'))` |
| .NET | `File.WriteAllText("statement.jzm.js", JazminFile.PortableScript("statement.jzm"))` |

Copy the viewer and the browser reader from the npm package (`node_modules/@smithsoft-studios/jazmin/viewer` and
`.../browser`), as `make.mjs` does.

## Good to know

- **Which way?** For files up to about 20 MB that a page should open by itself, use a script. For larger files, or
  files people choose, pass the chosen file to the viewer.
- **Memory:** a page holds the whole of a script's file, about 60 to 110 MB for a 21 MB file. A chosen file is read in
  pieces, about 20 to 30 MB for a file of any size.
- **A `.jzm.js` is code, and the page runs it.** Load only scripts you made, or trust.
- **The password never goes in the page or in `data.js`.** The person types it. The demo pages fill in `demo`,
  `shared.html` reads its keys and the HR lock's password from `data/shared-keys.js`, `masked.html` its key and lock
  password from `data/masked-keys.js`, `two-factor.html` its keys from `data/two-factor-keys.js` and `send-back.html`
  the area managers' keys from `data/inspection-keys.js`, for this demo only: a real page holds no password and no
  key. `filing/owner.key` is the inspections file's owner key, there only so you can try the owner's side.
- **Paths** in `data.js` are relative to the page, or a `file:///` address such as `file:///C:/Reports/statement.jzm.js`.
