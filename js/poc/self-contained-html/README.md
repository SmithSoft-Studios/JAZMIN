# Proof of concept: a document in one HTML file

> Superseded by the viewer (`js/viewer`, TASKS F-2), whose "Save as HTML" makes the same kind of file from any
> `.jzm`. This folder is kept as the record of the experiment and its findings.

One `statement.html` holds everything: an encrypted JAZMIN file with the template (HTML, CSS,
JavaScript, images, a PDF) and an encrypted JAZMIN file with the data. Double-click it, enter
the key, and it renders an interactive statement offline. It can print, export CSV and download
a PDF. Nothing is installed and nothing is downloaded.

```bash
cd js
node poc/self-contained-html/fetch-vendor.mjs   # optional: jsPDF for "Download PDF" (pinned, not committed)
node poc/self-contained-html/pack.mjs           # writes poc/self-contained-html/out/statement.html and prints a new key
```

Then double-click `out/statement.html`. Use `--key jzk1-...` to choose the key, or `--no-key` for
an unencrypted file.

## How it works

| Part | File | Role |
|---|---|---|
| Packer | `pack.mjs` | Writes the template folder into one JAZMIN file (`path`, `mime`, `content` columns) and the data into another, both with the same key, then embeds both into the viewer page |
| Browser reader | `jazmin-browser.js` | Reads and decrypts JAZMIN in the browser, using WebCrypto (AES-256-GCM, HKDF, PBKDF2) and the browser's built-in deflate. Plain script, no dependencies |
| Viewer | `viewer/viewer.html`, `viewer.js` | Asks for the key, decrypts in memory, starts the sandbox |
| Sandbox | `viewer/bootstrap.js` | Runs inside a sandboxed iframe. It turns each file into an in-memory URL, points the template's links at those URLs, renders the page and provides `window.jazmin` |
| Template | `template/` | An ordinary small website. It uses `jazmin.rows()`, `jazmin.metadata`, `jazmin.download()` and `jazmin.print()` |

Browsers do not let a page opened from disk read other files, so the JAZMIN bytes are embedded in
the page. The key is never given to the template: it receives only decrypted rows and files.

## Template rules

- Use relative paths (`img/logo.svg`, `about.html`). They are rewritten automatically in HTML
  attributes, `<style>` blocks, `style=""` attributes and CSS `url()`.
- Use plain scripts, not `type="module"`.
- Get data from `window.jazmin`, not `fetch()`. Network access is blocked.
- Browser storage is not available inside the sandbox.
- Links to other `.html` files in the package open inside the viewer.

## What was verified (Chrome and Edge on Windows, opened from `file://`)

`e2e-browser.mjs` drives the browser through its DevTools protocol:

```bash
node poc/self-contained-html/pack.mjs --key <key> --test-key --out poc/self-contained-html/out/statement-test.html
node poc/self-contained-html/e2e-browser.mjs poc/self-contained-html/out/statement-test.html [--browser edge] [--page about.html] [--screenshot shot.png]
node poc/self-contained-html/pack.mjs --key <key>
node poc/self-contained-html/e2e-browser.mjs poc/self-contained-html/out/statement.html --key <key>   # types the key into the form
```

- All 172 rows render. The logo (SVG) and the CSS background (PNG) load from the package.
- Export CSV, Download PDF (jsPDF) and the packaged `terms.pdf` all download.
- Navigation to `about.html` and back works.
- The right key opens the document. A wrong key, or a key with a typo, is refused with a clear message.
- Inside the sandbox, network requests and browser storage are blocked.
- No console errors.
- Opening takes about 12 ms. With a 20 MB file added, the page is 27.5 MB and opens in about 90 ms
  after the browser has loaded it.

`test/browser-reader.test.mjs` (part of `npm test`) checks that the browser reader returns
exactly what the Node library returns for the shared fixtures written by both languages.

Not verified yet: Firefox and Safari, the print dialog (it cannot be automated headless),
fonts, audio and video files, and mobile browsers.

## Limits of this approach

- **Size:** the whole package is loaded into memory, and it is about a third larger than the
  files themselves, because the bytes are embedded as text. That is fine for documents up to
  tens of MB, but not for very large files.
- **Video and audio** are held fully in memory, with no streaming.
- **PDFs inside the template** should be shown with PDF.js. Browsers' built-in PDF viewers
  generally do not run in sandboxed frames. Downloading them works.
- **Email:** many mail systems block `.html` attachments. Zip the file or share a link.
- **Keys:** this proof of concept supports master keys and passwords. Per-person access keys,
  time-limited keys and appended files need the rest of the reader ported to the browser.
  Brotli can't be used, because browsers can't decompress it.
- **Expiry in a browser** is weaker than in the libraries, because users can clear browser
  storage.
- **No copy protection after display:** anything shown can be saved or printed.

## Next steps (not started)

The browser reader reads format 1.0 files (Protocol Buffers catalog, columnar chunks) that are not
access-controlled and have not been appended to.

1. Port access keys (key slots, owner signature check) and appended files to the browser reader.
2. Use the format's embedded files (spec 6.8: blocks, per-key file groups) so the package is one
   file instead of two.
3. Firefox and Safari checks, plus fonts, video and audio in the template.
4. The same template rendered on the server through Puppeteer, for batch PDFs.
