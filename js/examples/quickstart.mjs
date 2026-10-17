// Runnable versions of the JavaScript examples in docs/USER-GUIDE.md.
// Run: node examples/quickstart.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JAZMIN, JazminKey, JazminUnlockRequiredError, JazminWriter, append, compact, createFileHandler, exportFile, exportString, fromCSV, issueFileUnlockToken, issueUnlockToken,
  listFileUnlockTokens, open, openAsync,
  applyChanges, fileSubmission, from, portableHtml, portableScript, rotateKey, toJSON, toXML, update, verifyPublisher, write, writeAsync,
  writeChanges,
} from '../src/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-examples-'));
const file = path.join(dir, 'customers.jzm');

// 1. JSON-like one-liners: rows to bytes and back (USER-GUIDE 4.1).
const bytes = JAZMIN.stringify([{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }]);
console.log('1.', JAZMIN.parse(bytes));

// 2. Schema, indexes, metadata and encryption (USER-GUIDE 4.2).
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

// 3. Query with the GraphQL-style filter language, and see the plan (USER-GUIDE 8.1, 9.6).
const reader = open(file, { key: key.export() });
console.log('2.', reader.columns.map((c) => `${c.name}:${c.type}`).join(', '), reader.metadata);
for (const row of reader.find({ country: 'ZA', name: { icontains: 'ndlovu' } })) console.log('3.', row);
console.log('   plan:', reader.explain({ id: 3 }));

// 4. Export to JSON and CSV, and paging (USER-GUIDE 11, 9.7).
console.log('4.', toJSON(reader, { filter: { id: { gte: 2 } }, select: ['id', 'name'] }));
exportFile(reader, 'csv', path.join(dir, 'customers.csv'));
console.log('   page 2:', [...reader.rows({ offset: 1, limit: 1 })].map((r) => r.id));
reader.close();

// 5. Streaming writer for large data, in constant memory (USER-GUIDE 4.4).
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

// 6. CSV in: column types inferred (USER-GUIDE 11).
const fromCsv = open(fromCSV('sku,qty\r\nA1,3\r\nB2,\r\n', null));
console.log('6.', fromCsv.columns.map((c) => `${c.name}:${c.type}`), [...fromCsv.rows()]);

// 7. Append small changes cheaply, then compact when you choose (USER-GUIDE 17).
const appended = append(file, {
  key,
  insert: [{ id: 4, name: 'Lerato Mokoena', country: 'ZA', balance: '12.00', joined: new Date('2026-01-05') }],
  delete: { id: 2 },
});
console.log('7.', appended);
console.log('   compacted:', compact(file, { key }));

// 8. One file, many keys, each for a limited time (USER-GUIDE 15, 18): Bob for 2 hours (offline),
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

// 9. Export shapes (USER-GUIDE 21.1): nested JSON/XML from flat rows - one entry per client (details taken once), with totals.
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

// 10. Async (USER-GUIDE 22): rows from an async source (e.g. a database cursor), and non-blocking reads for servers.
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

// 20. Queries with arrow functions (USER-GUIDE 8.4): the where function is read into a filter the reader answers;
// the rest runs in memory, as LINQ does.
const accounts = open(branchesFile, { key: teller });
const capeTown = from(accounts).where((a) => a.branch === 'CPT').orderBy((a) => a.id).select((a) => a.id);
console.log('20.', capeTown.toArray(), capeTown.explain().filter);
accounts.close();
// 20. [ 1, 3 ] { branch: { eq: 'CPT' } }

// ---- Changing a file you already have (sections 21-25) -----------------------------------------------------------------

// 21. Does the file need compacting? (USER-GUIDE 17.5): storage() reads only the file's directories, never its rows.
const ledger = path.join(dir, 'ledger.jzm');
write(ledger, Array.from({ length: 1000 }, (_, i) => ({ id: i, status: 'open' })), { columns: [{ name: 'id', type: 'int' }, { name: 'status', type: 'string' }], sortedBy: ['id'] });
for (let i = 0; i < 3; i++) append(ledger, { delete: { id: { lt: (i + 1) * 100 } }, insert: [{ id: 1000 + i, status: 'new' }] });
const before21 = open(ledger);
const used = before21.storage();
before21.close();
compact(ledger);
const after21 = open(ledger);
console.log('21.', `${used.deletedRows} deleted rows, ${used.appendCount} appends, ${(used.unusedBytes / 1024).toFixed(1)} KB unused;`, 'compacted:', after21.storage().deletedRows, 'deleted rows');
after21.close();
// 21. 300 deleted rows, 3 appends, 0.7 KB unused; compacted: 0 deleted rows

// 22. Indexes and the sort order of an existing file (USER-GUIDE 16.1), in one rewrite that keeps everything else.
// Rows are put in a new order within a memory budget; the old first sort column gets an index, so lookups stay fast.
update(ledger, { indexes: { status: ['sorted', 'trigram'] }, sortedBy: ['status', 'id'] });
const relaid = open(ledger);
console.log('22.', relaid.sortedBy, relaid.indexes.map((ix) => `${ix.column}:${ix.kind}`));
relaid.close();
// 22. [ 'status', 'id' ] [ 'id:sorted', 'status:trigram' ]

// 23. Tables added, renamed and removed (USER-GUIDE 23.5): an added table's rows can be any iterable, read once.
const shop = path.join(dir, 'shop.jzm');
write(shop, [{ clientId: 'C1', name: 'Ann' }, { clientId: 'C2', name: 'Ben' }], {
  columns: [{ name: 'clientId', type: 'string', nullable: false }, { name: 'name', type: 'string' }], sortedBy: ['clientId'],
});
const orderColumns = [{ name: 'orderId', type: 'int' }, { name: 'clientId', type: 'string' }, { name: 'total', type: 'decimal' }];
update(shop, {
  renameTables: { '': 'clients' }, // a file's single table has no name until it is given one
  addTables: [
    { name: 'orders', columns: orderColumns, sortedBy: ['clientId', 'orderId'], rows: [{ orderId: 2, clientId: 'C2', total: '15.00' }, { orderId: 1, clientId: 'C1', total: '40.50' }, { orderId: 3, clientId: 'C1', total: '9.99' }] },
    { name: 'scratch', columns: [{ name: 'note', type: 'string' }], rows: [{ note: 'temporary' }] },
  ],
});
update(shop, { removeTables: ['scratch'] });
const tables23 = open(shop);
console.log('23.', tables23.tables);
tables23.close();
// 23. [ 'clients', 'orders' ]

// 24. Links between tables (USER-GUIDE 23.6): declared once, kept in the file (names only, never values), and checked
// against the rows. Both tables are sorted by the link, so they are walked side by side.
const orderClient = { name: 'client', from: { table: 'orders', columns: ['clientId'] }, to: { table: 'clients', columns: ['clientId'] } };
update(shop, { links: [orderClient] });
const linked24 = open(shop);
const [check24] = linked24.checkLinks();
console.log('24.', linked24.links.map((l) => l.name), `${check24.rows} rows checked, ${check24.missing} find nothing (${check24.method})`);
linked24.close();
// 24. [ 'client' ] 3 rows checked, 0 find nothing (merge)

// 25. A client's key changed in every table, in one rewrite (USER-GUIDE 23.7): set + where on the main table, and the
// same in `tables` for the others. Rows whose sort column changes move to their place; the link still holds.
const rekey = update(shop, {
  table: 'clients', set: { clientId: 'C9' }, where: { clientId: 'C1' },
  tables: { orders: { set: { clientId: 'C9' }, where: { clientId: 'C1' } } },
});
const after25 = open(shop);
const orders25 = after25.openTable('orders');
console.log('25.', rekey.tables.clients.updated, 'client and', rekey.tables.orders.updated, 'orders re-keyed;', [...orders25.rows()].map((o) => `${o.clientId}/${o.orderId}`), 'missing:', after25.checkLinks()[0].missing);
orders25.close();
after25.close();
// 25. 1 client and 2 orders re-keyed; [ 'C2/2', 'C9/1', 'C9/3' ] missing: 0

// 26. Which JAZMIN versions read a file (USER-GUIDE 3.2): the reader features it needs, here smaller indexes (opt-in).
// Empty for files every 1.x release reads.
const featured = path.join(dir, 'featured.jzm');
write(featured, Array.from({ length: 50 }, (_, i) => ({ id: i, city: i % 2 ? 'CPT' : 'JHB' })), {
  columns: [{ name: 'id', type: 'int' }, { name: 'city', type: 'string', index: 'sorted' }], compactIndexes: true,
});
const plain26 = open(ledger);
const featured26 = open(featured);
console.log('26.', plain26.readerFeatures, featured26.readerFeatures);
plain26.close();
featured26.close();
// 26. [] [ 'index-deltas' ]

// 27. Records sent back from the field, filed by the library's rules (USER-GUIDE 15.6): the phone locks its records
// with Ann's submission key (she gets it by opening the shared file); the owner's service files them. A dry run first.
const fieldOwner = JazminKey.generate();
const ann = fieldOwner.createAccessKey();
const field = path.join(dir, 'field.jzm');
const fieldColumns = [{ name: 'id', type: 'string', nullable: false }, { name: 'inspector', type: 'string' }, { name: 'note', type: 'string' }];
write(field, [{ id: 'r1', inspector: 'ann', note: 'roof ok' }], {
  columns: fieldColumns, key: fieldOwner, access: { partitionBy: 'inspector', grants: [{ key: ann, rows: ['ann'], label: 'Ann' }] },
});
const annView = open(field, { key: ann });
const batchFile = path.join(dir, 'batch.jzm');
write(batchFile, [{ id: 'r1', note: 'roof leaks' }, { id: 'r2', note: 'gate broken' }], { columns: fieldColumns, key: annView.submissionKey });
annView.close();
const upload = fs.readFileSync(batchFile);
const check27 = fileSubmission(field, upload, { key: fieldOwner, keyId: ann.id, dryRun: true });
const filed27 = fileSubmission(field, upload, { key: fieldOwner, keyId: ann.id });
console.log('27.', `dry run: ${check27.filed} new, ${check27.updated} changed;`, `filed: ${filed27.filed} new, ${filed27.updated} changed`);
// 27. dry run: 1 new, 1 changed; filed: 1 new, 1 changed

// 28. The owner's list of grants (USER-GUIDE 15.1), with each key's extra file groups, so a tool can change a grant
// without losing them: a new grant for a key replaces the old one whole.
const docsOwner = JazminKey.generate();
const reviewer = docsOwner.createAccessKey();
const contracts = path.join(dir, 'contracts.jzm');
write(contracts, [{ id: 1 }], {
  columns: [{ name: 'id', type: 'int' }], key: docsOwner,
  files: [{ path: 'contracts/lease.txt', content: 'The lease', groups: ['legal'] }],
  access: { grants: [{ key: reviewer, files: ['legal'], label: 'Reviewer' }] },
});
const asOwner = open(contracts, { key: docsOwner });
console.log('28.', asOwner.access.grants.map((g) => `${g.label}: files ${JSON.stringify(g.files)}`));
asOwner.close();
// 28. [ 'Reviewer: files ["legal"]' ]

// 29. Stored files locked (USER-GUIDE 19.6): a key that sees them lists them, and opens one only with its password; an
// online lock opens with the token the owner's key service hands out after its own checks (2FA, say).
const claimOwner = JazminKey.generate();
const claimant = claimOwner.createAccessKey();
const claim = path.join(dir, 'claim.jzm');
write(claim, [{ id: 1 }], {
  columns: [{ name: 'id', type: 'int' }], key: claimOwner, access: { grants: [{ key: claimant }] },
  files: [{ path: 'contract.pdf', content: 'The contract', lock: 'contracts' }, { path: 'scan.png', content: 'The scan', lock: 'medical' }],
  locks: { contracts: { password: 'correct horse battery staple' }, medical: { online: true } },
});
const claimView = open(claim, { key: claimant });
let refused29;
try {
  claimView.readFile('contract.pdf');
} catch (error) {
  refused29 = `${error.name} (${error.kind})`;
}
claimView.unlock('contracts', { password: 'correct horse battery staple' });
claimView.unlock('medical', { unlockToken: issueFileUnlockToken(claim, claimOwner, 'medical') }); // from the key service
console.log('29.', refused29, '->', claimView.readFile('contract.pdf').toString(), '/', claimView.readFile('scan.png').toString());
claimView.close();
// 29. JazminFileLockedError (password) -> The contract / The scan

// 30. The newest rows first (USER-GUIDE 9.7): a file sorted by time, read from its end as fast as from its start.
const journalRows = Array.from({ length: 10000 }, (_, i) => ({ id: i, at: new Date(Date.UTC(2026, 0, 1) + i * 60000), account: `A${i % 50}` }));
const journal = open(write(null, journalRows, {
  columns: [{ name: 'id', type: 'int' }, { name: 'at', type: 'datetime' }, { name: 'account', type: 'string', index: ['sorted'] }], sortedBy: ['at'],
}));
console.log('30.', [...journal.find({ account: 'A7' }, { reverse: true, limit: 3 })].map((t) => t.id), from(journal).reverse().first().id);
journal.close();
// 30. [ 9957, 9907, 9857 ] 9999

// 31. Text kept ignoring case and accents, with numbers by value (USER-GUIDE 16.1): update puts the rows in that order.
const names = path.join(dir, 'names.jzm');
write(names, ['file10', 'File2', 'émile', 'file1', 'Apple'].map((name) => ({ name })), { columns: [{ name: 'name', type: 'string' }] });
update(names, { sortedBy: [{ column: 'name', nocase: true, natural: true }] });
const namesReader = open(names);
console.log('31.', [...namesReader.rows()].map((r) => r.name), namesReader.sort);
namesReader.close();
// 31. [ 'Apple', 'émile', 'file1', 'File2', 'file10' ] [ { column: 'name', nocase: true, natural: true } ]

// 32. A masked column (USER-GUIDE 15.7): a key granted it sees what the owner lets it show, until it unlocks the column.
// Exports give it as one column, as viewers show it: masked unless asked for its revealed values (revealMasked).
const payOwner = JazminKey.generate();
const payClerk = payOwner.createAccessKey();
const pay = write(null, [{ id: 1, name: 'Thandi', account: '4821 0393 7712 4821' }], {
  columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }, { name: 'account', type: 'string', mask: { lock: 'pay', show: { keepFormat: true, last: 4 } } }],
  key: payOwner, access: { grants: [{ key: payClerk }] }, locks: { pay: { password: 'correct horse battery staple' } },
});
const payView = open(pay, { key: payClerk });
const before32 = [...payView.rows()][0];
payView.unlock('pay', { password: 'correct horse battery staple' });
console.log('32.', before32, '->', [...payView.rows()][0].account);
const masked32 = exportString(payView, 'csv', { revealMasked: false }); // as it shows, even once unlocked
const revealed32 = exportString(payView, 'csv', { revealMasked: ['account'] }); // or true: every unlocked column
console.log('    export:', JSON.stringify(masked32), '->', JSON.stringify(revealed32));
payView.close();
// 32. { id: 1, name: 'Thandi', account_shown: '•••• •••• •••• 4821' } -> 4821 0393 7712 4821
//     export: "id,name,account\r\n1,Thandi,•••• •••• •••• 4821\r\n" -> "id,name,account\r\n1,Thandi,4821 0393 7712 4821\r\n"

// 33. Progress and Stop on a long read (USER-GUIDE 22.1): onProgress is called after each chunk with the chunks read,
// the chunks planned and the matches so far; an AbortSignal stops the read before its next chunk. A stopped read throws
// (or rejects with) the signal's reason, an AbortError. Here Stop is pressed part-way, from onProgress.
const visits = path.join(dir, 'visits.jzm');
const visitCities = ['Durban', 'Cape Town', 'Pretoria', 'Polokwane'];
write(visits, Array.from({ length: 100_000 }, (_, i) => ({
  id: i, customer: `C${String((Math.floor(i / 100) * 37) % 1000).padStart(3, '0')}`, city: visitCities[i % 4], amount: i % 1000,
})), {
  columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'customer', type: 'string', index: 'sorted' }, { name: 'city', type: 'string' }, { name: 'amount', type: 'int' }],
});
const visitsReader = open(visits);
let last33;
const durban33 = visitsReader.count({ city: 'Durban' }, { onProgress: (p) => { last33 = p; } });
const stop33 = new AbortController();
let stopped33;
try {
  visitsReader.count({ city: 'Durban' }, { signal: stop33.signal, onProgress: ({ done }) => { if (done === 3) stop33.abort(); } });
} catch (error) {
  stopped33 = error.name;
}
const stopAsync33 = new AbortController(); // stopButton.onclick = () => stopAsync33.abort();
let stoppedAsync33;
try {
  await visitsReader.countAsync({ city: 'Durban' }, { signal: stopAsync33.signal, onProgress: ({ done }) => { if (done === 5) stopAsync33.abort(); } });
} catch (error) {
  stoppedAsync33 = error.name;
}
visitsReader.close();
console.log('33.', `${durban33} in Durban, ${last33.done} of ${last33.total} chunks read;`, `stopped after 3: ${stopped33};`, `countAsync stopped after 5: ${stoppedAsync33}`);
// 33. 25000 in Durban, 25 of 25 chunks read; stopped after 3: AbortError; countAsync stopped after 5: AbortError

// 34. Progress for a rewrite (USER-GUIDE 16.1): update() and compact() report { stage, done, total } in up to three
// stages: 'sort' (only when the order changes), 'write' (after each chunk) and 'indexes' (at the end). A signal stops it
// at its next report and leaves the file as it was. Here, the last report of each stage.
const stages34 = new Map();
update(visits, { sortedBy: ['city', 'id'], onProgress: (p) => stages34.set(p.stage, `${p.stage} ${p.done}/${p.total}`) });
console.log('34.', [...stages34.values()]);
// 34. [ 'sort 100000/100000', 'write 100000/100000', 'indexes 1/1' ]

// 35. What a read would cost, before it runs (USER-GUIDE 9.6): estimate() reads no rows, only the chunk directories,
// statistics and indexes. find() reads at most chunks/rows; count() reads countChunks (0 when an index answers it).
const planned = open(visits);
const costOf = (filter) => { const e = planned.estimate(filter); return `find ${e.chunks} chunks/${e.rows} rows, count ${e.countChunks} chunks`; };
console.log('35.', `customer (indexed): ${costOf({ customer: 'C074' })};`, `amount (no index): ${costOf({ amount: 500 })}`);
// 35. customer (indexed): find 4 chunks/100 rows, count 0 chunks; amount (no index): find 25 chunks/100000 rows, count 25 chunks

// 36. What viewers offer for each stored file (USER-GUIDE 19.3): list: false keeps a page's script out of viewers' lists
// of the file's files, and in a shared file groupActions gives each file group its own actions: here HR may download
// the payslips and staff may only view them. The owner sees each group's actions.
const payOwner36 = JazminKey.generate();
const hr36 = payOwner36.createAccessKey();
const staff36 = payOwner36.createAccessKey();
const payslips = path.join(dir, 'payslips.jzm');
write(payslips, [{ id: 1 }], {
  columns: [{ name: 'id', type: 'int' }], key: payOwner36,
  files: [
    { path: 'index.html', content: '<h1>Payslips</h1><script src="app.js"></script>' },
    { path: 'app.js', content: 'jazmin.query({});', actions: { list: false } },
    { path: 'payslips.pdf', content: 'Payslips, March', groups: ['hr', 'staff'], groupActions: { hr: { save: true }, staff: { save: false } } },
  ],
  package: { entry: 'index.html' },
  access: { grants: [{ key: hr36, files: ['hr'], label: 'HR' }, { key: staff36, files: ['staff'], label: 'Staff' }] },
});
for (const [label, accessKey] of [['HR', hr36], ['Staff', staff36]]) {
  const view = open(payslips, { key: accessKey });
  console.log(label === 'HR' ? '36.' : '   ', `${label}:`, view.files.map((f) => `${f.path} ${JSON.stringify(f.actions ?? {})}`).join(', '));
  view.close();
}
const payslipsOwner = open(payslips, { key: payOwner36 });
console.log('    owner:', payslipsOwner.files.find((f) => f.path === 'payslips.pdf').groupActions);
payslipsOwner.close();
// 36. HR: app.js {"list":false}, index.html {}, payslips.pdf {"save":true}
//     Staff: app.js {"list":false}, index.html {}, payslips.pdf {"save":false}
//     owner: { hr: { save: true }, staff: { save: false } }

// 37. A document that needs the internet (USER-GUIDE 24.1): online: 'required' when it doesn't work offline (a chart
// library from a CDN), 'optional' when it works with less (a font that falls back). It needs allowedOrigins, the only
// sites its pages may load from. Viewers then say it needs to be online, and offline show a message instead.
const sales = open(write(null, [{ month: 'Jan', sales: 120 }, { month: 'Feb', sales: 135 }], {
  files: [{ path: 'index.html', content: '<canvas id="chart"></canvas><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.6"></script>' }],
  package: { entry: 'index.html', online: 'required', allowedOrigins: ['https://cdn.jsdelivr.net'] },
}));
console.log('37.', JSON.stringify(sales.package));
sales.close();
// 37. {"entry":"index.html","allowedOrigins":["https://cdn.jsdelivr.net"],"online":"required"}

// 38. Document pages (USER-GUIDE 19.7): viewers show each page as a tab, in order. One reads the clients table, one
// needs the internet, one has only Print and PDF buttons. package.files names the pages' own files (a folder ends in
// '/'), which viewers keep out of the Files tab. The package is in the header every key reads, so a page only some
// keys may know of is marked on its file instead: only the directors see the Board pack tab, or that the file exists.
const bankOwner38 = JazminKey.generate();
const director = bankOwner38.createAccessKey();
const clerk = bankOwner38.createAccessKey();
const bank = path.join(dir, 'bank.jzm');
write(bank, { clients: [{ clientId: 'C1', name: 'Acme' }], transactions: [{ clientId: 'C1', amount: '10.00' }] }, {
  tables: [
    { name: 'clients', columns: [{ name: 'clientId', type: 'string' }, { name: 'name', type: 'string' }] },
    { name: 'transactions', columns: [{ name: 'clientId', type: 'string' }, { name: 'amount', type: 'decimal' }] },
  ],
  key: bankOwner38,
  access: { grants: [{ key: director, files: ['directors'], label: 'Director' }, { key: clerk, label: 'Clerk' }] },
  files: [
    { path: 'clients.html', content: '<h1>Clients</h1>' },
    { path: 'summary.html', content: '<h1>Summary</h1>' },
    { path: 'statement.html', content: '<h1>Statement</h1>' },
    { path: 'assets/app.js', content: 'jazmin.query({});' },
    { path: 'assets/style.css', content: 'h1 { color: navy }' },
    { path: 'board.html', content: '<h1>Board pack</h1>', groups: ['directors'], page: { title: 'Board pack', order: 1 } },
  ],
  package: {
    pages: [ // entry is left out: it is the first page, the one older viewers show
      { path: 'clients.html', title: 'Clients', table: 'clients' },
      { path: 'summary.html', title: 'Summary', online: 'required' }, // the other tabs still work offline
      { path: 'statement.html', title: 'Statement', actions: { image: false } },
    ],
    files: ['assets/'],
    allowedOrigins: ['https://cdn.jsdelivr.net'],
  },
});
for (const [label, accessKey] of [['Director', director], ['Clerk', clerk]]) {
  const view = open(bank, { key: accessKey });
  const tabs = [...view.package.pages.map((p) => p.title), ...view.files.filter((f) => f.page).map((f) => `${f.page.title} (${f.path})`)];
  console.log(label === 'Director' ? '38.' : '   ', label, tabs);
  view.close();
}
// 38. Director [ 'Clients', 'Summary', 'Statement', 'Board pack (board.html)' ]
//     Clerk [ 'Clients', 'Summary', 'Statement' ]

// 39. Locks and key services (USER-GUIDE 19.6): package.keyService names the service that gives out the file's online
// locks' tokens, and a lock can name its own, so the medical aid signs its own people in (with its own 2FA) and holds
// only its lock's token. A service that stores tokens instead of the owner key lists them with listFileUnlockTokens.
const clinic = JazminKey.generate();
const patient = clinic.createAccessKey();
const visit39 = path.join(dir, 'visit.jzm');
write(visit39, [{ id: 1 }], {
  columns: [{ name: 'id', type: 'int' }], key: clinic, access: { grants: [{ key: patient }] },
  files: [{ path: 'scan.png', content: 'The scan', lock: 'medical' }, { path: 'invoice.pdf', content: 'The invoice', lock: 'billing' }],
  locks: { medical: { online: true, keyService: 'https://keys.medicalaid.example' }, billing: { online: true } },
  package: { keyService: 'https://keys.clinic.example' },
});
const patientView = open(visit39, { key: patient });
console.log('39.', patientView.locks.map((l) => `${l.id}: ${l.keyService}`).join(', '));
patientView.unlock('medical', { unlockToken: issueFileUnlockToken(visit39, clinic, 'medical') }); // the medical aid's service
const billingToken = listFileUnlockTokens(visit39, clinic).find((t) => t.lockId === 'billing').token; // the clinic's service
patientView.unlock('billing', { unlockToken: billingToken });
console.log('   ', patientView.readFile('scan.png').toString(), '/', patientView.readFile('invoice.pdf').toString());
patientView.close();
// 39. billing: https://keys.clinic.example/, medical: https://keys.medicalaid.example/
//     The scan / The invoice

// 40. Masking and unmasking later (USER-GUIDE 15.7): an update with the owner key masks a column that wasn't masked and
// unmasks one that was. Nobody gains access: the clerk saw the phone number and now sees its last 4 digits; the salary
// was masked and is now plain.
const hrOwner40 = JazminKey.generate();
const clerk40 = hrOwner40.createAccessKey();
const staffFile = path.join(dir, 'staff.jzm');
write(staffFile, [{ id: 1, name: 'Thandi', phone: '082 555 0199', salary: '42000.00' }], {
  columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }, { name: 'phone', type: 'string' }, { name: 'salary', type: 'decimal', mask: { lock: 'hr' } }],
  key: hrOwner40, access: { grants: [{ key: clerk40 }] }, locks: { hr: { password: 'correct horse battery staple' } },
});
const asClerk = () => {
  const view = open(staffFile, { key: clerk40 });
  const seen40 = [[...view.rows()][0], view.masked.map((m) => m.column)];
  view.close();
  return seen40;
};
const before40 = asClerk();
update(staffFile, { key: hrOwner40, masks: { phone: { lock: 'hr', show: { last: 4 } }, salary: null } });
console.log('40.', ...before40, '->', ...asClerk());
// 40. { id: 1, name: 'Thandi', phone: '082 555 0199' } [ 'salary' ] -> { id: 1, name: 'Thandi', salary: '42000.00', phone_shown: '••••0199' } [ 'phone' ]

// 41. Regrouping partitions (USER-GUIDE 17.4): in a shared file each append starts new chunks, one per person it adds
// rows for, so many small syncs leave each person's rows in many small chunks. compact() keeps them;
// compact({ regroup: true }) writes each person's rows together.
const syncOwner = JazminKey.generate();
const syncs = path.join(dir, 'syncs.jzm');
write(syncs, [{ person: 'ann', visit: 0 }, { person: 'ben', visit: 0 }], {
  columns: [{ name: 'person', type: 'string' }, { name: 'visit', type: 'int' }], key: syncOwner,
  access: { partitionBy: 'person', grants: [{ key: syncOwner.createAccessKey(), rows: ['ann'] }, { key: syncOwner.createAccessKey(), rows: ['ben'] }] },
});
for (let day = 1; day <= 5; day++) append(syncs, { key: syncOwner, insert: [{ person: 'ann', visit: day }, { person: 'ben', visit: day }] });
const chunks41 = () => {
  const view = open(syncs, { key: syncOwner });
  const { chunks } = view.storage().tables[0];
  view.close();
  return chunks;
};
const appended41 = chunks41();
compact(syncs, { key: syncOwner });
const compacted41 = chunks41();
compact(syncs, { key: syncOwner, regroup: true });
console.log('41.', `${appended41} chunks after 5 syncs; compacted: ${compacted41}; regrouped: ${chunks41()}`);
// 41. 12 chunks after 5 syncs; compacted: 12; regrouped: 2

// 42. Column arrays for charts (USER-GUIDE 9.11): one array per column instead of an object per row, far less memory.
// Numbers and dates come as Float64Array (dates in milliseconds), bools as Uint8Array, other types as plain arrays.
const chartReader = open(visits);
const { rowCount, values } = chartReader.columnArrays({ customer: 'C074' }, { select: ['id', 'amount'] });
console.log('42.', rowCount, 'rows;', values.amount.constructor.name, [...values.amount.slice(0, 3)], 'total', values.amount.reduce((a, b) => a + b, 0));
chartReader.close();
// 42. 100 rows; Float64Array [ 201, 205, 209 ] total 24950

// 43. Publisher signatures (USER-GUIDE 26): who published a file, that it hasn't changed, and the facts signed with it.
// A file written here has no publisher signature: 'none'. The repository's test files are signed under a test root no
// release trusts, so they show as 'signed', with no name or facts, until SmithSoft's root is built in (1.8.0).
const signedTestFile = new URL('../../spec/fixtures/publisher/signed-plain.jzm', import.meta.url);
const signed43 = fs.existsSync(signedTestFile) ? verifyPublisher(new Uint8Array(fs.readFileSync(signedTestFile))) : null;
console.log('43.', verifyPublisher(file).status, ...(signed43 ? [signed43.status, signed43.name] : []));
// 43. none signed null

fs.rmSync(dir, { recursive: true, force: true });
