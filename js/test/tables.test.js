// Several tables in one file (TASKS D-3, docs/design/several-tables.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, JazminWriter, append, compact, open, update, write } from '../src/index.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-tables-')), name);

/** Opens, runs `use` and closes (Windows cannot replace a file a reader still has open). */
function withReader(file, options, use) {
  const r = open(file, options);
  try {
    return use(r);
  } finally {
    r.close();
  }
}

const clientColumns = [
  { name: 'clientId', type: 'string', nullable: false },
  { name: 'name', type: 'string' },
  { name: 'address', type: 'string' },
];
const transactionColumns = [
  { name: 'clientId', type: 'string', nullable: false },
  { name: 'line', type: 'int', index: 'sorted' },
  { name: 'amount', type: 'decimal' },
];
const clientIds = ['C1', 'C2', 'C3'];
const clients = clientIds.map((id) => ({ clientId: id, name: `Client ${id}`, address: `${id} Long Street, Cape Town` }));
const transactions = clientIds.flatMap((id, c) => Array.from({ length: 50 }, (_, i) => ({ clientId: id, line: c * 50 + i, amount: `${i}.25` })));

const tables = (extra = {}) => [
  { name: 'clients', columns: clientColumns, sortedBy: ['clientId'], ...extra.clients },
  { name: 'transactions', columns: transactionColumns, sortedBy: ['clientId', 'line'], chunkRows: 20, ...extra.transactions },
];

function writeTables(target, options = {}, extra) {
  const writer = new JazminWriter(target, { tables: tables(extra), ...options });
  writer.writeRows(clients);
  writer.startTable('transactions');
  writer.writeRows(transactions);
  return writer.finish();
}

test('two tables are written one after the other and read by name', () => {
  const buf = writeTables(null);
  const first = open(buf);
  assert.deepEqual(first.tables, ['clients', 'transactions']);
  assert.equal(first.table, 'clients'); // the first table by default
  assert.deepEqual([...first.rows()], clients);

  const t = open(buf, { table: 'transactions' });
  assert.equal(t.table, 'transactions');
  assert.equal(t.rowCount, 150);
  assert.deepEqual(t.columns.map((c) => c.name), ['clientId', 'line', 'amount']);
  assert.deepEqual(t.indexes, [{ column: 'line', kind: 'sorted' }]);
  assert.deepEqual([...t.find({ line: 77 })], [transactions[77]]);
  assert.equal(t.explain({ line: 77 }).strategy, 'index');
  assert.equal(t.count({ clientId: 'C2' }), 50);
  assert.equal(t.chunkCount, 8); // 20-row chunks
  assert.throws(() => open(buf, { table: 'nope' }), /no table 'nope' \(tables: 'clients', 'transactions'\)/);
});

test('write() takes the rows of each table by name', () => {
  const buf = write(null, { clients, transactions }, { tables: tables() });
  assert.deepEqual(write(null, { transactions }, { tables: tables() }).length > 0, true); // clients written empty
  assert.equal(open(buf, { table: 'transactions' }).rowCount, 150);
  assert.deepEqual([...open(buf).rows()], clients);
  assert.throws(() => write(null, { clients, nope: [] }, { tables: tables() }), /no table 'nope'/);
  assert.throws(() => write(null, clients, { tables: tables() }), /rows by table name/);
});

test('table definitions are checked before anything is written', () => {
  const bad = (options, pattern) => assert.throws(() => new JazminWriter(null, options), (e) => e instanceof JazminValidationError && pattern.test(e.message));
  bad({ tables: [] }, /non-empty array/);
  bad({ tables: [{ columns: clientColumns }] }, /needs a name/);
  bad({ tables: [{ name: 'a', columns: clientColumns }, { name: 'a', columns: clientColumns }] }, /declared twice/);
  bad({ columns: clientColumns, tables: tables() }, /in each table/);
  bad({ tables: [{ name: 'a', columns: clientColumns, partitionBy: 'clientId' }] }, /need an access-controlled file/);
  bad({ tables: [{ name: 'a', columns: clientColumns, sortedBy: ['nope'] }] }, /unknown column 'nope'/);

  const writer = new JazminWriter(null, { tables: tables() });
  assert.throws(() => writer.startTable('nope'), /no table 'nope'/);
  writer.startTable('transactions');
  assert.throws(() => writer.startTable('transactions'), /already been written/);
  assert.throws(() => writer.writeRow(clients[0]), /unknown column 'name'/); // rows go to the current table
});

test('tables can be written in any order, and a table never started is written empty', () => {
  const writer = new JazminWriter(null, { tables: [...tables(), { name: 'notes', columns: [{ name: 'text', type: 'string' }] }] });
  writer.startTable('transactions');
  writer.writeRows(transactions);
  const buf = writer.finish();
  assert.deepEqual(open(buf).tables, ['clients', 'transactions', 'notes']); // the declared order
  assert.equal(open(buf).rowCount, 0);
  assert.equal(open(buf, { table: 'transactions' }).rowCount, 150);
  assert.deepEqual(open(buf, { table: 'notes' }).columns.map((c) => c.name), ['text']);
});

test('encrypted with a key: each table is locked with its own section keys', () => {
  const key = JazminKey.generate();
  const buf = writeTables(null, { key });
  assert.deepEqual([...open(buf, { key, table: 'transactions' }).find({ line: 3 })], [transactions[3]]);
  assert.equal(buf.includes('Long Street'), false);
});

test('access follows the partitions: a key granted C1 sees C1 in every table; a lookup table needs "*"', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const carol = owner.createAccessKey();
  const rates = { name: 'rates', columns: [{ name: 'currency', type: 'string' }, { name: 'rate', type: 'float' }] };
  const writer = new JazminWriter(null, {
    key: owner,
    access: { grants: [{ key: bob, rows: ['C1'], columns: '*' }, { key: carol, rows: ['C2', '*'], columns: '*' }] },
    tables: [
      ...tables({ clients: { partitionBy: 'clientId', columnGroups: { contact: ['address'] } }, transactions: { partitionBy: 'clientId' } }),
      rates,
    ],
  });
  writer.writeRows(clients);
  writer.startTable('transactions');
  writer.writeRows(transactions);
  writer.startTable('rates');
  writer.writeRows([{ currency: 'USD', rate: 18.2 }]);
  const buf = writer.finish();

  const read = (key, table) => [...open(buf, { key, table, accessState: false }).rows()];
  assert.deepEqual(read(bob, 'clients'), [clients[0]]);
  assert.deepEqual(new Set(read(bob, 'transactions').map((t) => t.clientId)), new Set(['C1']));
  assert.deepEqual(read(bob, 'rates'), []); // not granted '*'
  assert.deepEqual(read(carol, 'clients').map((c) => c.clientId), ['C2']);
  assert.deepEqual(read(carol, 'clients')[0].address, clients[1].address); // the contact group of the clients table
  assert.deepEqual(read(carol, 'rates'), [{ currency: 'USD', rate: 18.2 }]);
  assert.equal(open(buf, { key: owner, table: 'transactions' }).rowCount, 150);
  assert.deepEqual(open(buf, { key: owner, table: 'transactions' }).indexes, [{ column: 'line', kind: 'sorted' }]);
});

test('openTable reads another table of the same open file, sharing its keys and checks', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('shared.jzm');
  writeTables(file, { key: owner, access: { grants: [{ key: bob, rows: ['C2'] }] } }, {
    clients: { partitionBy: 'clientId' }, transactions: { partitionBy: 'clientId' },
  });
  const clientsReader = open(file, { key: bob, accessState: false });
  const transactionsReader = clientsReader.openTable('transactions');
  assert.equal(transactionsReader.table, 'transactions');
  assert.throws(() => clientsReader.openTable('nope'), /no table 'nope'/);
  clientsReader.close(); // the file stays open for the other reader
  assert.equal(transactionsReader.rowCount, 50);
  const third = transactionsReader.openTable('clients');
  assert.deepEqual(third.get(1), clients[1]);
  transactionsReader.close();
  update(file, { key: owner, metadata: { v: 1 } }); // replaced; `third` keeps the version it opened
  assert.deepEqual(third.get(1), clients[1]); // `third` still holds the file
  third.close();
  assert.throws(() => third.openTable('transactions'), /closed/);
});

test('append, update and compact change one table and keep the others', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('statements.jzm');
  writeTables(file, { key: owner, access: { grants: [{ key: bob, rows: ['C1', 'C4'] }] } }, {
    clients: { partitionBy: 'clientId' }, transactions: { partitionBy: 'clientId' },
  });
  append(file, { key: owner, table: 'transactions', insert: [{ clientId: 'C4', line: 1000, amount: '9.99' }], delete: { line: { lt: 10 } } });
  append(file, { key: owner, table: 'clients', insert: [{ clientId: 'C4', name: 'Client C4', address: 'Durban' }] });

  const transactionsOf = { key: owner, table: 'transactions' };
  withReader(file, transactionsOf, (t) => {
    assert.equal(t.rowCount, 141);
    assert.equal(t.appendCount, 2);
    assert.deepEqual([...t.find({ line: 1000 })].map((x) => x.amount), ['9.99']); // the appended index segment
  });
  withReader(file, { key: owner }, (c) => assert.equal(c.rowCount, 4));
  withReader(file, { key: bob, accessState: false }, (c) => assert.deepEqual([...c.rows()].map((x) => x.clientId), ['C1', 'C4']));
  withReader(file, { key: bob, table: 'transactions', accessState: false }, (t) => {
    assert.deepEqual(new Set([...t.rows()].map((x) => x.clientId)), new Set(['C1', 'C4']));
  });

  const result = update(file, { key: owner, table: 'clients', upsert: [{ clientId: 'C1', name: 'Renamed', address: 'x' }], keyColumns: ['clientId'] });
  assert.equal(result.rowCount, 4);
  assert.equal(result.updated, 1);
  withReader(file, { key: owner }, (c) => assert.equal(c.get(0).name, 'Renamed'));
  withReader(file, transactionsOf, (t) => {
    assert.equal(t.rowCount, 141); // copied into the new version
    assert.equal(t.appendCount, 0);
  });

  compact(file, transactionsOf);
  withReader(file, transactionsOf, (t) => {
    assert.deepEqual(t.tables, ['clients', 'transactions']);
    assert.equal([...t.find({ line: 1000 })].length, 1);
  });
  update(file, { key: owner, revoke: [bob] });
  assert.throws(() => open(file, { key: bob, table: 'transactions', accessState: false }), /not been granted/);
});

test('a normalized file (clients once, transactions by id) is smaller than the flat one', () => {
  // A statement file: 2,000 clients with their details, 10 transactions each (mirrored in the .NET TablesTests).
  const detailColumns = ['name', 'address', 'city', 'email', 'phone', 'taxNumber'].map((name) => ({ name, type: 'string' }));
  const people = Array.from({ length: 2000 }, (_, c) => ({
    clientId: `C${String(c).padStart(5, '0')}`, name: `Client ${c} Trading (Pty) Ltd`, address: `${c % 997} Long Street, Unit ${c % 50}`,
    city: ['Cape Town', 'Durban', 'Johannesburg', 'Pretoria'][c % 4], email: `accounts${c}@client${c}.co.za`,
    phone: `+27 21 ${String((c * 7919) % 10_000_000).padStart(7, '0')}`, taxNumber: String(4_000_000_000 + c * 13),
  }));
  const lines = people.flatMap((p, c) => Array.from({ length: 10 }, (_, i) => ({ clientId: p.clientId, line: c * 10 + i, amount: `${(c * 31 + i * 17) % 10_000}.${i}0` })));
  const flat = write(null, lines.map((l) => ({ ...l, ...people[l.line / 10 | 0] })), {
    columns: [...transactionColumns, ...detailColumns], sortedBy: ['clientId', 'line'],
  });
  const normalized = write(null, { clients: people, transactions: lines }, {
    tables: [
      { name: 'clients', columns: [clientColumns[0], ...detailColumns], sortedBy: ['clientId'] },
      { name: 'transactions', columns: transactionColumns, sortedBy: ['clientId', 'line'] },
    ],
  });
  // Dictionary encoding already stores a chunk's repeated values once, so the saving is modest.
  assert.ok(normalized.length < flat.length * 0.99, `normalized ${normalized.length} bytes, flat ${flat.length}`);
});
