# JAZMIN from disk (sample)

Pages that open `.jzm` files **straight from disk**: double-click an HTML file, with no web server, no Node and
nothing uploaded. See USER-GUIDE §24.4 for the details and measurements.

| Page | What it shows |
|---|---|
| `small-file.html` | A small file that opens **with no choosing**: the statement, named in `data.js` |
| `pick-file.html` | **Any file, any size**: you choose it, the page passes it to the viewer, which reads only what it needs |
| `viewer/index.html` | The viewer on its own: choose or drop a file in it |

## Run it

```bash
node examples/from-disk/make.mjs            # in js/; or: node examples/from-disk/make.mjs D:/somewhere
```

Then open `examples/from-disk/site/index.html` in Chrome, Edge or Firefox. The statement's password is `demo`. The
`site` folder needs nothing else: copy it to a USB stick or a shared drive and it still works.

## How it works

**The rule we work around.** A page opened from disk may not read other files on the computer by itself, not even a
file in its own folder. Chrome and Edge refuse it outright; Firefox allows it but reads the whole file. This is a
browser security rule, and no code in the page can get past it. A page on disk may still do two things:

1. **Read a file the person chooses** (or drops on it). The page gets a reference to the file on disk, not its
   contents, and can read any part of it.
2. **Load a script,** from any folder, as every page loads its JavaScript.

Each of the two ways below uses one of these.

**Any file, any size: the person chooses it** (`pick-file.html`). The person chooses the file, and the page hands the
reference to the viewer in its iframe:

```js
viewer.contentWindow.postMessage({ type: 'jazmin:open', file, name: file.name }, '*');
```

The viewer reads only the parts it needs, straight from disk. Opening a 201 MB file reads 0.07 MB, and finding one row
by id reads 0.15 MB more. The viewer tells the page how the file opened (`opened`, `locked` or `failed`) and nothing
else: the password is typed in the viewer, and the data stays there.

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
