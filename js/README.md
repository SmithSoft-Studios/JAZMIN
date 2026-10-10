<p align="center"><img src="https://raw.githubusercontent.com/SmithSoft-Studios/JAZMIN/main/docs/images/jazmin-logo.png" alt="JAZMIN logo" width="200"></p>

# @smithsoft-studios/jazmin

**JAZMIN** is a compact, indexed, optionally encrypted file format for lists of records. This is the library for
Node.js 22+ and TypeScript. It reads and writes the same files as the .NET library (NuGet: `Jazmin`).

```bash
npm install @smithsoft-studios/jazmin
```

```js
import { JAZMIN, JazminKey, open, write } from '@smithsoft-studios/jazmin';

// One-liners, like JSON
const bytes = JAZMIN.stringify([{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }]);
console.log(JAZMIN.parse(bytes));

// A file with indexes and encryption
const key = JazminKey.generate(); // store it safely, e.g. in a secrets vault
write('customers.jzm', customers, {
  columns: [
    { name: 'id', type: 'int', nullable: false, index: 'sorted' },
    { name: 'name', type: 'string', index: 'trigram' },
    { name: 'country', type: 'string', index: 'sorted' },
  ],
  key,
});

// Read only what a query needs: the index pages and the chunks holding matches
const reader = open('customers.jzm', { key });
for (const c of reader.find({ country: 'ZA', name: { icontains: 'smith' } })) console.log(c);
reader.close();
```

## What it does

- **Small files:** about 24× smaller than JSON, and 61% smaller than gzipped JSON.
- **Fast lookups with little memory:** a query reads the index and the matching chunks, not the whole file.
- **Encryption:** AES-256-GCM on every section, with tamper detection.
- **Access control:** one file, many keys. Each access key sees only its rows and columns, and keys can expire.
- **Several tables per file,** embedded files, and append-only updates.
- **Lists and objects as columns** (opt-in `list` and `object` column types): smaller and faster to read than JSON
  text, with filters inside them (`any`, `all`, `match`).
- **Conversion:** lossless JSON round trip, plus CSV and XML; large CSV and XML files are imported without loading them.
- **Memory or speed first:** one `priority` setting; opt-in compact indexes for much smaller index files.
- **Key changes:** `rotateKey()` gives a file a new key or password without rewriting its rows; `rotateOwnerKey()` re-keys a shared file.
- **On a server:** `serveFiles()` serves a file's embedded files (byte ranges, per key), and `renderPdf()` and
  `renderImage()` print its document, with the page settings the file asks for, using a Playwright or Puppeteer
  browser you supply. `portableHtml()` makes one HTML file that opens the file anywhere.
- **Editable documents:** a document can let people change, add and delete rows. Their changes travel as small change
  files (`writeChanges()`), which the owner applies (`applyChanges()`), with conflicts held back.
- **Browser:** `@smithsoft-studios/jazmin/browser` reads every kind of file, and writes files with one key, a
  password or none, with embedded files (photos, PDFs). Pages opened from disk open small files made into scripts
  (`portableScript()`, `jazmin script`) with `openScript()`.
- **Sending records back:** people in the field send records from a phone, often offline, in a small file locked with
  their submission key, which they get only by opening the shared file. The owner files them; a ready-made filing
  service is in the repository.

Full documentation, the format specification and the .NET library:
[github.com/SmithSoft-Studios/JAZMIN](https://github.com/SmithSoft-Studios/JAZMIN).

MIT licence. JAZMIN™ is a trademark of SmithSoft Pty Ltd. The MIT licence covers the code, not the name: please don't
call another product or service JAZMIN, or use the JAZMIN logo for one.
