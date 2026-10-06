// Runnable versions of the JavaScript examples in docs/USER-GUIDE.md.
// Run: node examples/quickstart.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JAZMIN, JazminKey, JazminUnlockRequiredError, JazminWriter, append, compact, exportFile, fromCSV, issueUnlockToken, open, openAsync, toJSON, toXML, write, writeAsync,
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
linesReader.close();
clientsReader.close();

fs.rmSync(dir, { recursive: true, force: true });
