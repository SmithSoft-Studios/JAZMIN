# Design: embedded files and the JAZMIN viewer

Status: **implemented** (decisions in section 10). Format 1.0 renamed row groups to *partitions*
(`partitionBy`) and moved the file directories' references into the Protocol Buffers header
([format-1.0.md](format-1.0.md)); the version numbers below refer to the pre-release drafts.
Based on the proof of concept and its findings
(`js/poc/self-contained-html/FINDINGS.md`) and the manual checks: printing works, Android
Chrome works, and email blocks `.html` attachments.

## 1. Goal and scope

A JAZMIN file can optionally carry **files**: HTML, CSS, JavaScript, fonts, images, audio,
video, PDFs and any other bytes. Each key sees only the files it is allowed. A **viewer** can
then render those files as a mini website that uses the file's data. The website can be
interactive, and it can print, export and download. The same package can be rendered on a
server to produce PDFs in batches.

**Data stays the main purpose.** Embedded files are an add-on:

- A file without embedded files is **byte-for-byte unchanged**. It gets no new header members,
  sections, flags or cost.
- Readers that predate embedded files can still open files that have them, and read the data
  normally. They just don't see the embedded files.
- The data APIs don't change. The new APIs are separate and additive.
- Library work on embedded files must not slow down data reading or writing.

**Not in scope:** copy protection after display, Brotli in browsers, `eval` in templates, and
Safari/iOS (not yet tested).

## 2. Building blocks

| # | Part | Where | Depends on |
|---|---|---|---|
| A | Embedded files in the format (version 1.3) | RFC, JS and .NET libraries | — |
| B | Access per key for embedded files | RFC, both libraries | A |
| C | Browser reader (full) | `jazmin/browser` | A, B |
| D | Viewer: installable web app, plus "export as HTML" | `viewer/` | C |
| E | Server-side rendering helpers | JS and .NET | A |
| F | `jazmin` CLI: `pack`, `export-html`, `files` | `js/bin` | A, D |

A and E are useful on their own, for example to attach invoices to statement data or to
render PDFs on a server. B, C and D bring the offline viewing experience.

## 3. Format: embedded files (version 1.3)

### 3.1 What a writer adds

Only when there is at least one file:

- **Header member `files`.** It points to the *file directory* section(s), and holds the
  package settings (3.4).
- **File directory section.** A JSON list of the files: path, media type, size, SHA-256 hash,
  groups, the content key, and where the file's blocks are. It is compressed, encrypted, and
  covered by the owner signature like every other section.
- **File block sections.** Each file is split into **blocks of up to 256 KiB**. A reader can
  then read part of a file (for video seeking or range requests), keep memory bounded, and
  stream large files. Each block uses the normal section envelope, CRC and encryption. Blocks
  that don't compress are stored as they are, which the format already does.

Section ids:

| Section | id |
|---|---|
| File directory | `files/dir` (access-controlled files: `files/dir/<group id>`) |
| Block *b* of stored content *n* | `file/<n>/<b>` |

**Identical content is stored once.** Two paths with the same SHA-256 share one stored copy.

### 3.2 Keys

- **Each stored content gets its own random 32-byte content key** `K(n)`. Its blocks are
  encrypted with `HKDF(K(n), salt, "JAZMIN/1/" || section id)`. `K(n)` is written only inside
  the file directory entries that list the file.
- **Key- or password-encrypted files:** there is a single directory, `files/dir`. The keyring
  gains a `files` group, and the directory key is
  `HKDF(master, keyring.files, "JAZMIN/1/files/dir")`. Older readers ignore keyring groups
  they don't use.
- **Access-controlled files:** there is one directory per file group. See section 4.

This keeps one stored copy of a file, however many groups may see it.

### 3.3 Compatibility rules

- No new preamble flag, because readers reject unknown flags. The `files` header member is
  enough, and older readers ignore unknown members (RFC 6.6).
- `version_minor` becomes 3 only when files are present. Otherwise a writer keeps the version
  it would have written anyway.
- **Append** (version 1.2) can add, replace and remove files. It writes a new directory
  segment that replaces the previous one. **Compaction** drops files that are no longer
  referenced.

### 3.4 Package settings (signed, in the header)

```json
"files": {
  "directory": [ { "group": "<group id, or * in key files>", "offset": 0, "length": 0, "digest": "…" } ],
  "package": {
    "entry": "index.html",
    "title": "Account statement",
    "allowedOrigins": ["https://api.example.com"],
    "allowWasm": false
  }
}
```

- `package` is optional. Without it the files are plain attachments, which the viewer lists
  for download.
- `allowedOrigins` and `allowWasm` are set by the owner and protected by the owner signature
  (access-controlled files) or by encryption (key files). The viewer builds its security
  policy only from these settings, never from the page.
- There is deliberately no `allowEval`.

## 4. Access per key

**Each file lists the groups that may see it.** Some files are for everyone, some are shared by
several groups, and some belong to one group only:

| File | `groups` | Seen by keys for |
|---|---|---|
| `index.html`, `app.js`, `style.css` | `["*"]` (the default) | everyone: A, B, C and D |
| `appendix.html` | `["A", "B"]` | A and B |
| `img/logoD.png` | `["D"]` | D only |
| `docs/terms.pdf` | `["A", "B", "C", "D"]` | A, B, C and D (but not a future group E) |

- **Group names share the row-group namespace.** A file in group `B` is visible to keys
  granted rows `B`, so a client's own files follow their data automatically.
- **Extra named groups.** Grants gain an optional `files` list, for example
  `files: ["template", "managers"]`. A key sees a file when any of the file's groups is one of
  its row groups, one of its `files` groups, or `*`.
- **`*` means anyone holding a key to the file.** It does not mean "without a key": encrypted
  files have no unencrypted parts.
- **Secrets:** `F(id) = HKDF(O, salt, "JAZMIN/1/file-group/" || id)`. The group id is the same
  HMAC id used for row groups. The access bundle gains `"files": { id: b64(F(id)) }`. Older
  readers ignore the extra member.
- **One directory section per group** (`files/dir/<group id>`), encrypted with `F(id)`. It
  lists the files that group may see, with their content keys (3.2).
  - A shared file appears in several directories but is stored once.
  - A key reads only its own groups' directories, so it never learns other groups' file names
    or how many files they have. This also closes the equivalent of backlog item S-6 for files.
  - A key that belongs to several groups merges its directories by path.
- **The owner sees everything**, as with data.

## 5. Library APIs (additive)

**JavaScript**

```js
write('statement.jzm', rows, {
  key: owner,
  files: [
    { path: 'index.html', content: html },                    // type from the extension
    { path: 'docs/invoice-42.pdf', file: './invoice-42.pdf', groups: ['ACC001'] },
    { path: 'appendix.html', content: appendix, groups: ['A', 'B'] },
  ],
  package: { entry: 'index.html', allowedOrigins: [] },
  access: { rowGroupBy: 'account', grants: [{ key: bob, rows: ['ACC001'], files: ['template'] }] },
});
writer.addFile(path, content, { type, groups });              // streaming writer

reader.files;                         // [{ path, type, size, sha256, groups }] visible to this key
reader.readFile(path);                // Buffer
reader.openFile(path);                // readable stream, block by block
reader.readFileRange(path, start, end);
append(path, { key, addFiles: [...], removeFiles: ['old.pdf'] });
```

**.NET**: `JazminWriteOptions.Files`, `writer.AddFile(path, Stream, type, groups)`,
`reader.Files`, `reader.OpenFile(path)` (a seekable read-only `Stream`, reading block by
block), and `JazminAppend.AddFiles` / `RemoveFiles`.

Data APIs are unchanged.

## 6. Browser reader (C)

- A full port of the reader:
  - key, password and access keys, with owner signature checks;
  - appended files;
  - time-limited keys (offline checks; the last-seen record lives in browser storage, which
    is weaker);
  - unlock tokens supplied by the app;
  - embedded files and block reads.
- **Speed work from the findings:**
  - integers without BigInt where possible;
  - cache derived keys;
  - decode chunks on demand.
- Ships as `jazmin/browser`: a plain-script build plus an ES module build, both with no
  dependencies.
- Writers get a `browserCompatible: true` option, which refuses Brotli and warns about
  sections larger than the browser limits.

## 7. Viewer (D)

**Status:** built (TASKS F-2): `js/viewer`, with the browser reader `js/browser/jazmin-browser.js` (USER-GUIDE §24).

### 7.1 How files reach people

| Form | Good for | Notes |
|---|---|---|
| **`.jzm` + installed viewer** (recommended) | Email attachments, shared drives | The viewer is an installable web app (PWA). On Chrome and Edge desktop it registers as the handler for `.jzm`, so double-clicking a `.jzm` opens it. It works offline once installed. On Android, open the file from the viewer. |
| **Hosted viewer page** | Anyone with a link | Choose or drop a `.jzm`; nothing is uploaded |
| **Self-contained `.html`** (export) | Downloads, intranet links | Double-click, no install. Blocked by many email systems. About 380 MB ceiling; best under 50 MB |
| **Desktop viewer** (later) | Very large files, video-heavy packages | WebView2/Electron, with true partial reads |

The installed and hosted viewers read the `.jzm` **partially**: only the sections needed are
read from disk. That removes the self-contained HTML's memory and size limits.

### 7.2 Template API (`window.jazmin`, version 1)

```js
jazmin.metadata; jazmin.columns; jazmin.access;           // what this key may see
await jazmin.query(filter, { select, orderBy, offset, limit });  // a page of rows
await jazmin.count(filter);
jazmin.asset(path); await jazmin.file(path);                // in-memory URL / Blob
jazmin.download(name, content, type); jazmin.print(); jazmin.navigate(path);
jazmin.online;                                              // true when allowed origins are reachable
jazmin.ready(info);
```

- **Queries run in the viewer**, which holds the reader, the key and the indexes. Only the
  requested page of rows crosses into the sandbox. This fixes the 1-million-row memory problem.
- `jazmin.rows()` stays available for small data sets, with a size limit.

### 7.3 Viewer rules (from the findings)

- The template runs in a sandboxed iframe: scripts, dialogs and downloads only.
- The security policy is built from the signed package settings. Allowed origins are the only
  network access, and scripts loaded from them should carry integrity hashes.
- **Printing:** Ctrl+P and the Print button go to the template frame. Resizing to full height
  is the fallback when printing from the browser menu.
- Import maps are rewritten. Templates must bundle their JavaScript and use precompiled
  templates. PDFs are shown with PDF.js.
- If the template navigates away, the viewer restores it.
- The self-contained export releases the embedded text after decoding.
- Files without `package` settings are listed as attachments with download buttons.

## 8. Server-side rendering (E)

- **JS:** `createFileHandler(reader)` returns `(path) => { status, type, body }` for request
  interception, and `renderPdf({ file, key, entry, browser })` uses a browser you supply
  (Puppeteer or Playwright). No new dependencies.
- **.NET:** ASP.NET `app.MapJazminFiles("/docs/{id}", resolver)`, with range requests served
  from blocks, plus a PuppeteerSharp/Playwright sample.
- Templates receive the same `window.jazmin` API, so one template serves both the viewer and
  batch PDFs.

## 9. Delivery plan

| Step | Content | Format change | Release |
|---|---|---|---|
| 1 | RFC 1.3 text; JS and .NET write/read of files (key/password files); interop fixtures | Yes (minor) | 0.4.0 |
| 2 | Access per key for files; append and compact of files | Yes (minor) | 0.4.0 |
| 3 | Server-side helpers (JS and .NET) and the statement sample | No | 0.4.x |
| 4 | Browser reader (full port and speed work) | No | 0.5.0 |
| 5 | Viewer: installable web app with `.jzm` handling, hosted page, HTML export, API v1 | No | 0.5.0 |
| 6 | CLI `pack` / `export-html` / `files` | No | 0.5.x |
| 7 | Desktop viewer; Safari/iOS | No | later |

Each step is test-first, adds interop fixtures where the format is involved, and stays
covered by the existing data tests, so data behaviour is protected.

## 10. Decisions (2 October 2026)

1. **Name:** "files" (`files`, `addFile`, `readFile`). Agreed.
2. **File access:** each file lists the groups that may see it. A file can be for everyone
   (`*`), shared by several groups, or for one group only. Group names follow row groups, and
   grants can add named groups (section 4).
3. **Viewer:** the installable web app is the main viewer, with HTML export as a secondary
   option. Agreed.
4. **Order:** steps 1–3 first (format, libraries, server-side), then the viewer.
