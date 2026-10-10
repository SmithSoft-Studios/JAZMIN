# JAZMIN from disk (sample)

Pages that open `.jzm` files **straight from disk**: double-click an HTML file, with no web server, no Node and
nothing uploaded. See USER-GUIDE §24.4 for the details and measurements.

| Page | What it shows |
|---|---|
| `index.html` | Where to start: the two ways, and why they are fast |
| `small-file.html` | **A statement that opens by itself,** with no choosing: the file is named in `data.js`. Totals, spending by category, and a merchant search that says how long it took |
| `pick-file.html` | **Any file, any size:** a start page asks for the file (Browse, or drop it); once chosen, it opens in the viewer, which reads only what it needs. For the demo file, buttons above the viewer try filters |
| `viewer/index.html` | The viewer on its own: choose or drop a file in it |

## Run it

```bash
node examples/from-disk/make.mjs                  # in js/: about 7 seconds
node examples/from-disk/make.mjs D:/somewhere --rows 5000000    # another folder, a bigger demo file
```

Then open `examples/from-disk/site/index.html` in Chrome, Edge or Firefox. The password is `demo`. The `site` folder
needs nothing else: copy it to a USB stick or a shared drive and it still works.

## The demo data

Card transactions that look like real ones (`demo-data.mjs`): merchants, categories and amounts that fit them, a
salary on the 25th of each month. The same every time.

| File | What it holds | How it is written |
|---|---|---|
| `data/statement.jzm` (2 KB) and `statement.jzm.js` | One account, January to March 2026: 138 transactions, with the holder, period and opening balance in its metadata | Locked with the password |
| `data/transactions.jzm` (22 MB) | 1,000,000 transactions across 500 accounts, through 2026 (`--rows` for more or fewer) | Locked with the password, **sorted by date**, with **indexes on account, merchant (with text search), category and amount** |

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
- **The password never goes in the page or in `data.js`.** The person types it.
- **Paths** in `data.js` are relative to the page, or a `file:///` address such as `file:///C:/Reports/statement.jzm.js`.
