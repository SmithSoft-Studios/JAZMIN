<p align="center"><img src="https://raw.githubusercontent.com/SmithSoft-Studios/JAZMIN/main/docs/images/jazmin-logo.png" alt="JAZMIN logo" width="200"></p>

# jazmin

**JAZMIN** is a compact, indexed, optionally encrypted file format for lists of records. This is the library for
Node.js 22+ and TypeScript. It reads and writes the same files as the .NET library (NuGet: `Jazmin`).

```bash
npm install jazmin
```

```js
import { JAZMIN, JazminKey, open, write } from 'jazmin';

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
- **Conversion:** lossless JSON round trip, plus CSV and XML.
- **Browser:** the read-only browser reader is `jazmin/browser`.

Full documentation, the format specification and the .NET library:
[github.com/SmithSoft-Studios/JAZMIN](https://github.com/SmithSoft-Studios/JAZMIN).

MIT licence.
