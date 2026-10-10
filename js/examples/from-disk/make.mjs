// Builds the from-disk sample (README.md): a folder you can copy anywhere and open by double-clicking index.html, with
// no web server and no Node. It holds the pages, the viewer, the browser reader, and a small statement locked with a
// password, both as it is (statement.jzm) and made into a script (statement.jzm.js).
// Run: node examples/from-disk/make.mjs [folder]      (default: examples/from-disk/site)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableScript, write } from '../../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../..');
const site = path.resolve(process.argv[2] ?? path.join(here, 'site'));

// The pages, and beside them the viewer and the browser reader, as the npm package has them
// (node_modules/@smithsoft-studios/jazmin/viewer and .../browser).
fs.cpSync(path.join(here, 'pages'), site, { recursive: true });
fs.mkdirSync(path.join(site, 'viewer'), { recursive: true });
for (const file of ['index.html', 'viewer.js', 'viewer.css', 'sandbox.js']) fs.copyFileSync(path.join(js, 'viewer', file), path.join(site, 'viewer', file));
fs.mkdirSync(path.join(site, 'browser'), { recursive: true });
fs.copyFileSync(path.join(js, 'browser/jazmin-browser.js'), path.join(site, 'browser/jazmin-browser.js'));

// A small statement, locked with a password. Write yours with the library (Node or .NET) as usual.
const statement = path.join(site, 'data/statement.jzm');
fs.mkdirSync(path.dirname(statement), { recursive: true });
write(statement, [
  { date: new Date('2026-09-01'), description: 'Opening balance', amount: '1520.75' },
  { date: new Date('2026-09-03'), description: 'Groceries', amount: '-412.30' },
  { date: new Date('2026-09-05'), description: 'Salary', amount: '18500.00' },
  { date: new Date('2026-09-08'), description: 'Electricity', amount: '-950.00' },
  { date: new Date('2026-09-12'), description: 'Fuel', amount: '-720.45' },
  { date: new Date('2026-09-18'), description: 'Insurance', amount: '-1310.00' },
  { date: new Date('2026-09-24'), description: 'Interest', amount: '12.40' },
  { date: new Date('2026-09-30'), description: 'Closing balance', amount: '16640.40' },
], {
  columns: [{ name: 'date', type: 'datetime' }, { name: 'description', type: 'string' }, { name: 'amount', type: 'decimal' }],
  password: 'demo',
});

// The same file made into a script, which a page on disk can load (the same as `jazmin script data/statement.jzm`).
fs.writeFileSync(`${statement}.js`, portableScript(statement));

console.log(`Made ${site}\nOpen ${path.join(site, 'index.html')} in a browser. The statement's password is "demo".`);
