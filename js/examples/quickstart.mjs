// Runnable versions of the JavaScript examples in docs/USER-GUIDE.md.
// Run: node examples/quickstart.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JAZMIN, JazminKey, JazminUnlockRequiredError, JazminWriter, append, compact, createFileHandler, exportFile, fromCSV, issueUnlockToken, open, openAsync,
  applyChanges, portableHtml, portableScript, rotateKey, toJSON, toXML, update, write, writeAsync, writeChanges,
} from '../src/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-examples-'));
const file = path.join(dir, 'customers.jzm');

// 1. JSON-like one-liners
const bytes = JAZMIN.stringify([{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }]);
console.log('1.', JAZMIN.parse(bytes));

// 2. Schema, indexes, metadata and encryption
const key = JazminKey.generate();
write(file, [
  { id: 1, name: 'Ann Johnson', country: 'ZA', balance: '1520.75', joined: new Date('2024-01-02') },
  { id: 2, name: 'Bob Smith', country: null, balance: '99.10', joined: new Date('2024-03-04') },
  { id: 3, name: 'Thabo Ndlovu', country: 'ZA', balance: '0.00', joined: new Date('2025-06-07') },
], {
  columns: [
    { name: 'id', type: 'int', nullable: false, index: 'sorted', description: 'Customer number' },
    { name: 'name', type: 'string', index: ['sorted', 'trigram'] },
    { name: 'country', type: 'string', index: 'sorted' },
    { name: 'balance', type: 'decimal' },
    { name: 'joined', type: 'datetime' },
  ],
  metadata: { source: 'crm', exportedBy: 'nightly-job' },
  key,
});

// 3. Query with the GraphQL-style filter language
const reader = open(file, { key: key.export() });
console.log('2.', reader.columns.map((c) => `${c.name}:${c.type}`).join(', '), reader.metadata);
for (const row of reader.find({ country: 'ZA', name: { icontains: 'ndlovu' } })) console.log('3.', row);
console.log('   plan:', reader.explain({ id: 3 }));

// 4. Export, paging
console.log('4.', toJSON(reader, { filter: { id: { gte: 2 } }, select: ['id', 'name'] }));
exportFile(reader, 'csv', path.join(dir, 'customers.csv'));
console.log('   page 2:', [...reader.rows({ offset: 1, limit: 1 })].map((r) => r.id));
reader.close();

// 5. Streaming writer for large data (constant memory)
const big = path.join(dir, 'big.jzm');
const writer = new JazminWriter(big, {
  columns: [{ name: 'id', type: 'int', nullable: false, index: 'sorted' }, { name: 'reading', type: 'float' }],
  codec: 'brotli',
});
for (let i = 0; i < 1_000_000; i++) writer.writeRow({ id: i, reading: Math.sin(i / 1000) });
writer.finish();
const bigReader = open(big);
console.log(`5. 1,000,000 rows in ${Math.round(fs.statSync(big).size / 1024)} KB;`, [...bigReader.find({ id: 765432 })][0]);
bigReader.close();

// 6. CSV in
const fromCsv = open(fromCSV('sku,qty\r\nA1,3\r\nB2,\r\n', null));
console.log('6.', fromCsv.columns.map((c) => `${c.name}:${c.type}`), [...fromCsv.rows()]);

// 7. Append small changes cheaply, then compact when you choose
const appended = append(file, {
  key,
  insert: [{ id: 4, name: 'Lerato Mokoena', country: 'ZA', balance: '12.00', joined: new Date('2026-01-05') }],
  delete: { id: 2 },
});
console.log('7.', appended);
console.log('   compacted:', compact(file, { key }));

// 8. One file, many keys, each for a limited time: Bob for 2 hours (offline),
//    Sally for 14 days (online - she also needs an unlock token from your key service).
const owner = JazminKey.generate();
const bob = owner.createAccessKey();
const sally = owner.createAccessKey();
const shared = path.join(dir, 'statements.jzm');
write(shared, [{ section: 'A', amount: 1 }, { section: 'B', amount: 2 }], {
  key: owner,
  sortedBy: ['section'],
  access: {
    partitionBy: 'section',
    grants: [
      { key: bob, rows: ['B'], expiresIn: '2h', label: 'Bob' },
      { key: sally, rows: ['A'], expiresIn: '14d', mode: 'online', label: 'Sally' },
    ],
  },
});
// accessState: false only stops this example writing a last-seen record; leave it on in real apps.
const bobView = open(shared, { key: bob.export(), accessState: false });
console.log('8. Bob:', [...bobView.rows()], 'until', bobView.access.expires);
bobView.close();
try {
  open(shared, { key: sally.export(), accessState: false });
} catch (e) {
  if (!(e instanceof JazminUnlockRequiredError)) throw e;
  const token = issueUnlockToken(shared, owner, e.keyId); // normally your key service does this, after 2FA
  const sallyView = open(shared, { key: sally.export(), unlockToken: token, accessState: false });
  console.log('   Sally:', [...sallyView.rows()], 'until', sallyView.access.expires);
  sallyView.close();
}

// 9. Export shapes: nested JSON/XML from flat rows - one entry per client (details taken once), with totals.
const statements = open(write(null, [
  { client: 'C1', name: 'ABC Corp', date: new Date('2025-03-01'), amount: 1000 },
  { client: 'C2', name: 'Test Ltd', date: new Date('2025-03-02'), amount: 20000 },
  { client: 'C1', name: 'ABC Corp', date: new Date('2025-03-04'), amount: 250.5 },
]));
const shape = {
  clients: {
    $rows: { id: 'client', name: 'name', balance: { $sum: 'amount' }, lines: { $rows: { date: 'date', amount: 'amount' } } },
    $groupBy: 'client',
    $xmlItem: 'client',
  },
  total: { $sum: 'amount' },
};
console.log('9.', toJSON(statements, { shape }));
console.log(toXML(statements, { shape })); // <export><clients><client><id>C1</id>...

// 10. Async: rows from an async source (e.g. a database cursor), and non-blocking reads for servers.
async function* cursor() {
  for (let i = 0; i < 1000; i++) yield { id: i, amount: i / 4 };
}
const asyncFile = path.join(dir, 'async.jzm');
await writeAsync(asyncFile, cursor(), { columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'amount', type: 'float' }], sortedBy: ['id'] });
const asyncReader = await openAsync(asyncFile);
let asyncTotal = 0;
for await (const batch of asyncReader.findBatchesAsync({ id: { gte: 500 } })) for (const row of batch) asyncTotal += row.amount;
for await (const row of asyncReader.findAsync({ id: 7 })) console.log('10.', asyncTotal, row);
asyncReader.close();

// 11. Several tables: client details once, transactions by client (USER-GUIDE section 23).
const tablesFile = path.join(dir, 'tables.jzm');
write(tablesFile, {
  clients: [{ clientId: 'C1', name: 'Acme', address: '1 Long Street' }, { clientId: 'C2', name: 'Bolt', address: '2 Main Road' }],
  transactions: [{ clientId: 'C1', amount: 10 }, { clientId: 'C1', amount: 5 }, { clientId: 'C2', amount: 7 }],
}, {
  tables: [
    { name: 'clients', columns: [{ name: 'clientId', type: 'string' }, { name: 'name', type: 'string' }, { name: 'address', type: 'string' }], sortedBy: ['clientId'] },
    { name: 'transactions', columns: [{ name: 'clientId', type: 'string' }, { name: 'amount', type: 'float' }], sortedBy: ['clientId'] },
  ],
});
const clientsReader = open(tablesFile);
const linesReader = clientsReader.openTable('transactions'); // same open file, no second open
console.log('11.', clientsReader.tables, [...clientsReader.find({ clientId: 'C1' })][0].name, [...linesReader.find({ clientId: 'C1' })].length, 'lines');
// Each client with their transactions, nested by an export shape that links the tables (USER-GUIDE 21.6).
// Both tables are sorted by clientId, so each is read once.
const linked = { $rows: {
  id: 'clientId', name: 'name',
  transactions: { $from: 'transactions', $on: { clientId: 'clientId' }, $rows: 'amount' },
  total: { $from: 'transactions', $on: { clientId: 'clientId' }, $one: { $sum: 'amount' } },
} };
console.log('   ', toJSON(clientsReader, { shape: linked })); // [{"id":"C1","name":"Acme","transactions":[10,5],"total":15},...]
linesReader.close();
clientsReader.close();

// 12. Memory or speed first (USER-GUIDE 20.4), and smaller indexes, opt-in (readers from 1.2.0 read them).
const ordersFile = path.join(dir, 'orders.jzm');
write(ordersFile, Array.from({ length: 5000 }, (_, i) => ({ id: i, customer: `C${i % 250}`, amount: (i % 97) / 4 })), {
  columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'customer', type: 'string', index: 'sorted' }, { name: 'amount', type: 'float' }],
  sortedBy: ['id'],
  compactIndexes: true,
  priority: 'memory', // 'memory', 'balanced' (the default) or 'speed'
});
const orders = open(ordersFile, { priority: 'speed' }); // reads ahead on worker threads
console.log('12.', orders.count({ customer: 'C7' }), 'orders for C7');
orders.close();

// 13. A new key for a file, without rewriting its rows: when a key may have leaked (USER-GUIDE 10).
const newKey = JazminKey.generate();
const rotation = rotateKey(file, { key: key.export(), newKey: newKey.export() });
const rekeyed = open(file, { key: newKey.export() });
console.log('13.', rotation.sections, 'sections encrypted again;', rekeyed.rowCount, 'rows open with the new key');
rekeyed.close();

// 14. A file's embedded files, served by path: byte ranges, ETags, only what the key can see (USER-GUIDE 19.4).
// On a web server: http.createServer(serveFiles(reader, { prefix: '/files/' })).
const docsFile = path.join(dir, 'docs.jzm');
write(docsFile, [{ n: 1 }], { files: [{ path: 'invoices/march.txt', content: 'Invoice: R 1,250.00' }] });
const docs = open(docsFile);
const part = createFileHandler(docs)('invoices/march.txt', { range: 'bytes=0-6' });
console.log('14.', part.status, JSON.stringify(part.body.toString()), part.headers['content-range']);
docs.close();

// 15. Nested columns (USER-GUIDE 4.2): a list of objects stored as columns of their fields, not as JSON text.
// Opt-in; such a file needs JAZMIN 1.4 or later to read.
const companiesFile = path.join(dir, 'companies.jzm');
write(companiesFile, [
  { id: 1, name: 'Acme', departments: [{ name: 'Sales', budget: '1200.50', staff: ['Ann', 'Ben'] }, { name: 'Build', budget: '800', staff: [] }] },
  { id: 2, name: 'Bolt', departments: null },
], {
  columns: [
    { name: 'id', type: 'int', nullable: false },
    { name: 'name', type: 'string' },
    {
      name: 'departments', type: 'list', item: {
        type: 'object', fields: [
          { name: 'name', type: 'string' },
          { name: 'budget', type: 'decimal' },
          { name: 'staff', type: 'list', item: { type: 'string', nullable: false } },
        ],
      },
    },
  ],
});
const companies = open(companiesFile);
console.log('15.', [...companies.find({ id: 1 })][0].departments); // [{ name: 'Sales', budget: '1200.50', staff: ['Ann', 'Ben'] }, ...]
console.log('   ', toJSON(companies, { filter: { departments: { isNull: true } } })); // [{"id":2,"name":"Bolt","departments":null}]
// any / all on a list's items, match on an object's fields (USER-GUIDE 8.1): a department with Ben on its staff.
console.log('   ', [...companies.find({ departments: { any: { staff: { any: 'Ben' } } } })].map((r) => r.name)); // ['Acme']
companies.close();

// 16. A print-ready document (USER-GUIDE 19.3): what viewers may do with each file, and page settings for its PDFs,
// which renderPdf uses (USER-GUIDE 19.4). portableHtml makes the viewer's one-file copy, without a browser.
const statementFile = path.join(dir, 'statement.jzm');
write(statementFile, [{ account: 'A1', amount: '12.50' }], {
  files: [
    { path: 'index.html', content: '<h1>Statement</h1>', actions: { pdf: { format: 'A4', margin: { top: '15mm' } } } },
    { path: 'data.csv', content: 'account,amount\nA1,12.50\n', actions: { open: false, save: false } }, // the page reads it; viewers don't offer it
  ],
  package: { entry: 'index.html', title: 'Statement', pdf: { format: 'A4', landscape: false } },
});
const statement = open(statementFile);
console.log('16.', statement.files.map((f) => `${f.path} ${JSON.stringify(f.actions)}`).join('; '));
statement.close();
console.log('   ', `portableHtml: ${Math.round(portableHtml(statementFile).length / 1024)} KB, opens offline and asks for the key`);

// 17. An editable document (USER-GUIDE 19.5): the package says what may change; a change file carries the values the
// person saw, so a row someone else changed in the meantime is held for the owner instead of overwritten.
const tasksFile = path.join(dir, 'tasks.jzm');
write(tasksFile, [{ id: 1, task: 'Call the client', owner: null }, { id: 2, task: 'Send the quote', owner: null }], {
  columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'task', type: 'string' }, { name: 'owner', type: 'string' }],
  files: [{ path: 'index.html', content: '<h1>Tasks</h1>' }],
  package: { entry: 'index.html', edit: { key: ['id'], columns: ['owner'] } },
});
const seen = open(tasksFile);
const change = writeChanges(seen, { update: [{ id: 1, owner: 'Ann' }, { id: 2, owner: 'Ann' }] }); // as a viewer makes it
seen.close();
update(tasksFile, { upsert: [{ id: 2, task: 'Send the quote', owner: 'Ben' }], keyColumns: ['id'] }); // someone else, meanwhile
const applied = applyChanges(tasksFile, change);
console.log('17.', applied.updated, 'updated;', applied.conflicts.map((c) => `task ${c.key.id} held: ${c.columns.map((x) => `${x.name} is now ${x.now}`).join(', ')}`).join('; '));
// 17. 1 updated; task 2 held: owner is now Ben

// 18. A small file a page opened from disk shows with no choosing (USER-GUIDE 24.4): the file made into a script, which
// the page opens with JazminBrowser.openScript('statement.jzm.js', { password }). The file inside stays as it is, still
// encrypted. A whole sample: examples/from-disk.
const scriptFile = path.join(dir, 'statement.jzm.js');
fs.writeFileSync(scriptFile, portableScript(statementFile)); // or, on the command line: jazmin script statement.jzm
console.log('18.', `${path.basename(scriptFile)}: ${(fs.statSync(scriptFile).size / 1024).toFixed(1)} KB, for a ${(fs.statSync(statementFile).size / 1024).toFixed(1)} KB file`);

// 19. Export shapes saved in the file (USER-GUIDE 21.7), offered by name. In a shared file each key sees only the shapes
// it can use: 'Balances' is for the finance group, and every key that sees it must see the balance column.
const branchesFile = path.join(dir, 'branches.jzm');
const bankOwner = JazminKey.generate();
const teller = bankOwner.createAccessKey();
write(branchesFile, [{ id: 1, branch: 'CPT', balance: '1520.75' }, { id: 2, branch: 'JHB', balance: '99.10' }, { id: 3, branch: 'CPT', balance: '0.00' }], {
  columns: [{ name: 'id', type: 'int' }, { name: 'branch', type: 'string' }, { name: 'balance', type: 'decimal' }],
  key: bankOwner,
  access: { columnGroups: { money: ['balance'] }, grants: [{ key: teller, columns: ['*'], label: 'Teller' }] },
  shapes: [
    { name: 'Accounts per branch', default: true, shape: { $groupBy: 'branch', $sort: ['branch'], $rows: { branch: 'branch', accounts: { $count: true } } } },
    { name: 'Balances', groups: ['finance'], shape: { $rows: { id: 'id', balance: 'balance' } } },
  ],
});
const asTeller = open(branchesFile, { key: teller });
console.log('19.', asTeller.shapes.map((s) => s.name), toJSON(asTeller, { shape: 'Accounts per branch' }));
asTeller.close();
// 19. [ 'Accounts per branch' ] [{"branch":"CPT","accounts":2},{"branch":"JHB","accounts":1}]

fs.rmSync(dir, { recursive: true, force: true });
