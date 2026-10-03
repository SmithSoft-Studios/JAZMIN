# Findings: self-contained HTML documents (test round 1, 2 October 2026)

Tested on Windows 11 with Chrome, Edge 154 and Firefox 156. Every package was opened from disk
(`file://`), the same as a double-click, and driven automatically through each browser's
debugging protocol. Safari and mobile browsers were not available.

## Summary

| Area | Result | What it means for the feature |
|---|---|---|
| Browsers | Chrome, Edge and Firefox behave the same | One viewer for all desktop browsers |
| Rich content | Fonts, images, CSS backgrounds, audio, video (with seeking), workers and PDF.js all work | Templates can be full mini-websites |
| Built-in PDF viewer | Blocked inside the sandbox | Show PDFs with PDF.js; downloading them works |
| `eval` / `new Function` / WebAssembly | Blocked by our security policy | Templates must be precompiled; WebAssembly needs an opt-in |
| JavaScript modules | `import()` from a packaged file works. Relative imports between modules fail. Import maps work once the viewer rewrites them | Templates should be bundled (one file per entry) or use bare imports |
| Escape attempts | All blocked in all three browsers | The sandbox holds |
| Printing the whole page | Only the first screen prints, or rows are cut at page breaks | Printing must come from inside the template |
| Server-side PDF | Same template, unchanged: 8 correct pages in 0.7 s | Batch PDFs work from the same package |
| Online content | Works through an allow-list of web addresses, with integrity checks and offline fallback | Feasible, with rules |
| Size | Works up to about 300 MB of content. Memory is about 6× the content | Aim for ≤ 50 MB per file. Larger needs an installed viewer |
| Many rows | 1 million rows: 7 s and +2 GB memory | The data API must be query/chunk based, not "all rows" |

## 1. Browsers

All three browsers can open the page from disk, decrypt it (WebCrypto counts the page as
secure), and decompress it. Chrome, Edge and Firefox gave the same result for every check.
Firefox also passed the full statement test: 172 rows, plus the CSV, jsPDF and attachment
downloads.

## 2. What templates can use

**Works:**
- WOFF2 fonts and CSS `url()` backgrounds;
- WAV audio, including playback;
- WebM video, including seeking;
- web workers, created from packaged files;
- PDF.js 3.11, which rendered the stored PDF with its worker.

**Doesn't work:**
- **The browser's own PDF viewer** (`<iframe>` / `<embed>` of a PDF). Browsers refuse it inside sandboxes.
- **`eval`, `new Function` and runtime template compilers.** For example, `Handlebars.compile`
  fails. Precompiled templates are fine.
- **WebAssembly.** It could be allowed per package with `'wasm-unsafe-eval'`, which is a much
  smaller risk than allowing `eval`.
- **Modules that import each other by relative path** (`import './util.js'`). In-memory URLs
  have no folders, so relative paths can't be resolved.
  - Bare imports through an import map work once the viewer rewrites the map. This was tested
    with a one-step change to the bootstrap.
  - Dynamic `import(jazmin.asset('mod/x.js'))` works.

## 3. Security

Each of these was attempted from inside the template, and each was blocked in all three browsers:

- reading the viewer page or the key;
- navigating the main window;
- opening pop-ups;
- localStorage, IndexedDB and cookies;
- `fetch`, outside images, `sendBeacon` and form posts.

**One gap:** the template can navigate *its own frame* to an outside address. The viewer's
policy blocks the request before anything is sent, but the document is replaced by an error
page. The viewer should notice this and show the document again.

**Not tamper-proof:** the viewer code lives in the same HTML file, so anyone can edit it.
Integrity comes only from the encrypted, authenticated JAZMIN content inside. A future
access-controlled package should also have its owner signature checked by the viewer.

## 4. Printing

- **Printing the viewer page** (for example from the browser menu) prints the iframe as it
  looks on screen. That gives one page. Resizing the frame to its full height first gives
  every row, but the rows are sliced across pages, and the template's print rules are ignored.
- **`jazmin.print()`**, which calls `window.print()` inside the template, raised no error.
  Whether its print preview splits pages correctly **needs a manual check**: browsers can't
  show a print dialog when automated.
- **Server-side rendering is correct.** The template runs as a normal page and pages are laid
  out properly (8 pages, the header repeats, no rows cut).

Design: the viewer should send Ctrl+P and its own Print button to `jazmin.print()`, and keep
the resize as a fallback for printing from the browser menu.

## 5. Online content (allow-list)

The viewer's security policy can list trusted web addresses, and the template can then use them.

| Check | Result |
|---|---|
| JSON from an API that sends `Access-Control-Allow-Origin: *` | Works |
| JSON from a server without CORS headers | Fails. The sandbox has no real origin ("null"), so APIs must allow `*` or `null` |
| Images from any allowed address | Work, without special headers |
| CDN script with the correct integrity hash (SRI) | Loads |
| CDN script with a wrong integrity hash | Refused |
| Any address not on the list | Blocked |
| No internet | Online parts fail cleanly. The "online first, packaged copy second" fallback worked, and the document still opened in 10 ms |

Design:
- The allow-list should be part of the package's metadata, set by the owner. The viewer builds
  its security policy from it.
- Scripts from the internet should always carry integrity hashes.
- Note that online requests reveal that, and roughly where, a document was opened.

## 6. Size and memory (Chrome; whole-browser memory, baseline about 560 MB)

| Package content | HTML size | Ready after | Peak memory |
|---|---|---|---|
| 50 MB file | 67 MB | 0.8 s | 0.8 GB |
| 100 MB file | 133 MB | 1.5 s | 1.1 GB |
| 200 MB file | 267 MB | 3.1 s | 1.7 GB |
| 300 MB file | 400 MB | 4.5 s | 2.35 GB |
| 400 MB file | could not be built | — | — |
| 100,000 rows | 0.8 MB | 0.7 s | 0.8 GB |
| 1,000,000 rows | 7.6 MB | 7.0 s | 2.6 GB |

- **The ceiling is about 380 MB of content.** The embedded text would exceed JavaScript's
  maximum string length, which applies in browsers and Node alike.
- **Memory is about 6× the content.** It holds the embedded text, the bytes, the decrypted
  sections and the files given to the template.
- **Rows are expensive as objects.** One million rows compress to 7.6 MB, but cost 2 GB once
  every row is turned into an object and copied into the sandbox.

Design:
- Pass decrypted chunks to the sandbox as transferable buffers (no copy). Decode them there,
  on demand.
- Give templates a query/paging API instead of all rows.
- Release the embedded text once it has been decoded.
- Above about 50 MB, recommend the installed viewer (option C).

## 7. Browser reader speed

One million rows (5.7 MB file, encrypted), timed in Node:

| | Time |
|---|---|
| Node library, all rows | 0.6 s |
| Browser reader, all rows | 1.4 s |
| Browser reader, one chunk | 6 ms |

The browser reader is about 2.3× slower than the library. It can be sped up by:
- reading small integers without BigInt;
- caching derived keys;
- decoding into a reused buffer.

Reading by chunk is already cheap.

## 8. Server-side PDF (the Puppeteer path)

The same template and data were served to Chrome from the JAZMIN assets file through request
interception, under a made-up address (`https://package.local/`). Nothing was written to disk.

- The template ran unchanged; only a `jazmin` stub was injected.
- The PDF has 8 correctly broken pages.
- It took 0.7 s in total, including starting the browser.

## Manual checks still needed

1. Open `out/statement.html` by double-click and press **Print**. Check that the preview shows
   all transactions across pages, with no rows cut.
2. Safari on macOS, plus Chrome and Safari on a phone: does a downloaded HTML file open at all,
   and does decryption work?
3. Sending the file by email: is the `.html` attachment blocked?

## Recommended changes before building the feature

1. **Data API:** chunk- and query-based (`jazmin.query(filter, { offset, limit })`), with
   decoding inside the sandbox from transferred bytes.
2. **Printing:** send printing to the template frame (Ctrl+P and the Print button). Keep the
   resize fallback for printing from the browser menu.
3. **Package policy in signed metadata:**
   - allowed web addresses;
   - opt-in WebAssembly;
   - (not recommended) opt-in `eval`.
4. **Template build rules:** bundle the JavaScript (bare imports or one file); use precompiled
   templates; use PDF.js for PDFs.
5. **Viewer robustness:**
   - restore the document if the template navigates away;
   - release the embedded text after decoding;
   - give a clear message when a file is too large.
6. **Browser reader performance work**, before access keys are ported.
7. **Server-side rendering** as a first-class path: a `renderPdf(package, key)` helper that
   uses request interception.
