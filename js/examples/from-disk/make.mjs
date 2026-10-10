// Builds the from-disk sample (README.md): a folder you can copy anywhere and open by double-clicking index.html, with
// no web server and no Node. It holds the pages, the viewer, the browser reader, and two files of demo card
// transactions (demo-data.mjs), both locked with the password "demo":
// - data/statement.jzm: one account's statement for three months, also made into a script (statement.jzm.js), which
//   small-file.html opens with no choosing;
// - data/transactions.jzm: many accounts' transactions for a year (1,000,000 by default), sorted by date, with indexes
//   on the columns people filter by, for pick-file.html.
// Run: node examples/from-disk/make.mjs [folder] [--rows n]
//      (default folder: examples/from-disk/site; --rows: transactions in transactions.jzm, 0 for none)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { portableScript, write } from '../../src/index.js';
import { statement, transactions } from './demo-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { rows: { type: 'string', default: '1000000' } } });
const site = path.resolve(positionals[0] ?? path.join(here, 'site'));
const rows = Number(values.rows);
if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('--rows must be a whole number');

// The pages, and beside them the viewer and the browser reader, as the npm package has them
// (node_modules/@smithsoft-studios/jazmin/viewer and .../browser).
fs.cpSync(path.join(here, 'pages'), site, { recursive: true });
fs.mkdirSync(path.join(site, 'viewer'), { recursive: true });
for (const file of ['index.html', 'viewer.js', 'viewer.css', 'sandbox.js']) fs.copyFileSync(path.join(js, 'viewer', file), path.join(site, 'viewer', file));
fs.mkdirSync(path.join(site, 'browser'), { recursive: true });
fs.copyFileSync(path.join(js, 'browser/jazmin-browser.js'), path.join(site, 'browser/jazmin-browser.js'));
fs.mkdirSync(path.join(site, 'data'), { recursive: true });

// One account's statement: small, so a page can open it with no choosing, as a script.
const file = path.join(site, 'data/statement.jzm');
const { rows: statementRows, openingBalance } = statement();
write(file, statementRows, {
  columns: [{ name: 'date', type: 'datetime' }, { name: 'merchant', type: 'string' }, { name: 'category', type: 'string' }, { name: 'amount', type: 'decimal' }],
  metadata: { holder: 'Demo Customer', account: 'ACC-1042', period: 'January to March 2026', currency: 'ZAR', openingBalance },
  password: 'demo',
});
fs.writeFileSync(`${file}.js`, portableScript(file)); // the same as `jazmin script data/statement.jzm`

// Many accounts' transactions: written in date order (sortedBy), with indexes on the columns people filter by, so those
// filters read only what they need.
if (rows) {
  const big = path.join(site, 'data/transactions.jzm');
  const started = Date.now();
  process.stdout.write(`Writing ${rows.toLocaleString('en-US')} transactions... `);
  write(big, transactions(rows), {
    columns: [
      { name: 'date', type: 'datetime' }, { name: 'account', type: 'string' }, { name: 'merchant', type: 'string' },
      { name: 'category', type: 'string' }, { name: 'city', type: 'string' }, { name: 'amount', type: 'decimal' },
    ],
    sortedBy: ['date'],
    indexes: { account: 'sorted', merchant: ['sorted', 'trigram'], category: 'sorted', amount: 'sorted' },
    metadata: { title: 'Card transactions, 2026 (demo data)', currency: 'ZAR' },
    password: 'demo',
  });
  console.log(`${(fs.statSync(big).size / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

console.log(`Made ${site}\nOpen ${path.join(site, 'index.html')} in a browser. The password is "demo".`);
