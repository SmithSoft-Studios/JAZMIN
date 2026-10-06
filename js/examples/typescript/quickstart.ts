// TypeScript quick start - type-checked by `npm run typecheck`, and run by CI (`node examples/typescript/quickstart.ts`).
import { JAZMIN, JazminKey, JazminKeyError, accessKeyOf, append, compact, importJSONFile, open, toCSV, update, write, type Filter, type JazminColumnInput } from '@smithsoft-studios/jazmin';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-ts-'))); // the files below are written to a scratch folder

interface Customer {
  id: number;
  name: string;
  country: string | null;
  joined: Date;
}

const customers: Customer[] = [
  { id: 1, name: 'Ann Johnson', country: 'ZA', joined: new Date('2024-01-02') },
  { id: 2, name: 'Bob Smith', country: null, joined: new Date('2024-03-04') },
];

const columns: JazminColumnInput[] = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted', description: 'Customer number' },
  { name: 'name', type: 'string', index: ['sorted', 'trigram'] },
  { name: 'country', type: 'string', index: 'sorted' },
  { name: 'joined', type: 'datetime' },
];

// 1. Write an encrypted file with indexes.
const key = JazminKey.generate();
write('customers.jzm', customers as unknown as Record<string, unknown>[], { columns, key, metadata: { source: 'crm' } });

// 2. Query it - only matching chunks are decrypted and decoded.
const reader = open('customers.jzm', { key: key.toString() });
const where: Filter = { country: 'ZA', name: { icontains: 'john' } };
for (const row of reader.find(where, { select: ['id', 'name'] })) {
  const id = row.id as number;
  console.log(id, row.name);
}
console.log(reader.explain(where)); // { strategy: 'index', candidateRows: 1 }
const { values } = reader.columnArrays(null, { select: ['joined'] }); // arrays for charts
const joined = values.joined as Float64Array; // milliseconds since 1970
console.log(joined.length);

// 3. Export to CSV, then read back with the JSON-like API.
console.log(toCSV(reader, { filter: { id: { gte: 1 } } }));
reader.close();

const bytes: Buffer = JAZMIN.stringify([{ a: 1 }, { a: 2 }]);
const rows = JAZMIN.parse(bytes);
console.log(rows.length);

try {
  open('customers.jzm', { key: JazminKey.generate() });
} catch (e) {
  if (e instanceof JazminKeyError) console.log('wrong key rejected');
}

// 4. Convert a large JSON file without loading it, then read one section.
fs.writeFileSync('lines.json', JSON.stringify([{ section: 'A', amount: 1 }, { section: 'B', amount: 2 }]));
importJSONFile('lines.json', 'lines.jzm', { indexes: { section: 'sorted' } });
const lines = open('lines.jzm');
console.log([...lines.find({ section: 'B' })]);
lines.close();

// 5. One file, many keys: Bob sees only section B, and never the amount column.
const owner = JazminKey.generate();
const bob = owner.createAccessKey();
write('shared.jzm', [{ section: 'A', amount: 1 }, { section: 'B', amount: 2 }], {
  key: owner,
  sortedBy: ['section'],
  access: { partitionBy: 'section', columnGroups: { money: ['amount'] }, grants: [{ key: bob, rows: ['B'], columns: ['*'], label: 'Bob' }] },
});
const bobView = open('shared.jzm', { key: bob.toString() });
console.log([...bobView.rows()], bobView.hiddenRowCount); // [ { section: 'B' } ] 1
bobView.close();

// Bob sends records back, locked with the submission key he gets by opening the shared file; the owner derives it too.
const bobsView = open('shared.jzm', { key: bob.toString() });
const bobsKey = bobsView.submissionKey!;
bobsView.close(); // an open reader keeps a file from being replaced (update, compact) on Windows
write('bob-records.jzm', [{ section: 'B', amount: 4 }], { columns: [{ name: 'section', type: 'string' }, { name: 'amount', type: 'int' }], key: bobsKey });
accessKeyOf('shared.jzm', owner, bob.id); // the owner checks Bob still has a grant
const received = open('bob-records.jzm', { key: owner.submissionKey(bob.id) });
console.log([...received.rows()]); // [ { section: 'B', amount: 4 } ]
received.close();

// 6. Owner-only update: rows are merged in sorted order and Bob's grant carries over.
const result = update('shared.jzm', { key: owner, insert: [{ section: 'B', amount: 3 }] });
console.log(result); // { rowCount: 3, inserted: 1, updated: 0, deleted: 0 }

// 6b. Frequent small changes: append (cost depends on the change, not the file), compact when you choose.
const appended = append('shared.jzm', { key: owner, insert: [{ section: 'C', amount: 4 }], delete: { section: 'A' } });
console.log(appended.appendCount, appended.deletedRowCount); // 1 1
const { bytesBefore, bytesAfter } = compact('shared.jzm', { key: owner });
console.log(bytesBefore, '->', bytesAfter);

// 7. Time-limited access: offline (enforced by the library) or online (needs your key service).
import { JazminUnlockRequiredError, issueUnlockToken } from '@smithsoft-studios/jazmin';
const shortTerm = owner.createAccessKey();
const viaService = owner.createAccessKey();
write('timed.jzm', [{ section: 'A', amount: 1 }], {
  key: owner,
  access: {
    grants: [
      { key: shortTerm, expiresIn: '2h', label: 'user1' },
      { key: viaService, expiresIn: '14d', mode: 'online', label: 'user2' },
    ],
  },
});
try {
  open('timed.jzm', { key: viaService });
} catch (e) {
  if (e instanceof JazminUnlockRequiredError) {
    const token = issueUnlockToken('timed.jzm', owner, e.keyId); // normally done by your key service
    const timed = open('timed.jzm', { key: viaService, unlockToken: token });
    console.log(timed.access?.expires, [...timed.rows()].length);
    timed.close();
  }
}

// 8. Export shapes: nested output from flat rows, validated against the file's columns.
import { shapeSchema, toJSON, type ExportShape } from '@smithsoft-studios/jazmin';
const shape: ExportShape = {
  sections: { $rows: { section: 'section', total: { $sum: 'amount' }, lines: { $rows: 'amount', $sort: ['-amount'] } }, $groupBy: 'section' },
  count: { $count: true },
};
const shaped = open('shared.jzm', { key: owner });
console.log(toJSON(shaped, { shape, pretty: true }), shapeSchema(shaped, shape));
shaped.close();

// 9. Async: non-blocking reads (a server keeps serving other requests during long scans) and async row sources.
import { openAsync, writeAsync } from '@smithsoft-studios/jazmin';
async function asyncExample(): Promise<void> {
  async function* cursor() {
    for (let i = 0; i < 1000; i++) yield { id: i, amount: i / 4 }; // e.g. rows from a database cursor
  }
  await writeAsync('async.jzm', cursor(), { columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'amount', type: 'float' }], sortedBy: ['id'] });
  const r = await openAsync('async.jzm');
  let total = 0;
  for await (const rows of r.findBatchesAsync({ id: { gte: 500 } })) for (const row of rows) total += row.amount as number;
  for await (const row of r.findAsync({ id: 7 })) console.log(row);
  console.log(total);
  r.close();
}
await asyncExample();

// 10. Several tables in one file: declared up front, written one after another, read by name.
import { JazminWriter, type TableDefinition } from '@smithsoft-studios/jazmin';
const tables: TableDefinition[] = [
  { name: 'clients', columns: [{ name: 'clientId', type: 'string' }, { name: 'name', type: 'string' }], sortedBy: ['clientId'], chunkRows: 256 },
  { name: 'transactions', columns: [{ name: 'clientId', type: 'string' }, { name: 'amount', type: 'float' }], sortedBy: ['clientId'] },
];
const tablesWriter = new JazminWriter('tables.jzm', { tables });
tablesWriter.writeRow({ clientId: 'C1', name: 'Acme' });
tablesWriter.startTable('transactions');
tablesWriter.writeRow({ clientId: 'C1', amount: 10 });
tablesWriter.finish();
const clientsOnly = open('tables.jzm');
const tableLines = clientsOnly.openTable('transactions');
console.log(clientsOnly.tables, tableLines.table, tableLines.rowCount);
tableLines.close();
clientsOnly.close();

