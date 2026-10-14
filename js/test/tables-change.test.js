import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, compact, open, update, write } from '../src/index.js';

// Tables in an existing file (update(): addTables, removeTables, renameTables): one rewrite that keeps everything else;
// saved shapes and the document's edit settings follow a rename; nothing is left reading a table that is gone.

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-tables-change-'));
const clientColumns = [{ name: 'clientId', type: 'string', nullable: false }, { name: 'name', type: 'string' }];
const txColumns = [{ name: 'clientId', type: 'string', nullable: false }, { name: 'amount', type: 'decimal' }, { name: 'at', type: 'datetime' }];
const clients = [{ clientId: 'C1', name: 'Ann' }, { clientId: 'C2', name: 'Ben' }, { clientId: 'C3', name: 'Cat' }];
const transactions = Array.from({ length: 30 }, (_, i) => ({ clientId: `C${Math.floor(i / 10) + 1}`, amount: `${i}.25`, at: new Date(Date.UTC(2026, 0, 1 + i)) })); // by client, then date
const payments = Array.from({ length: 12 }, (_, i) => ({ clientId: `C${(i % 3) + 1}`, amount: `${100 - i}.00`, at: new Date(Date.UTC(2026, 1, 12 - i)) }));
const tablesOf = (file, options) => {
  const r = open(file, options);
  try {
    return Object.fromEntries(r.tables.map((t) => {
      const tr = t === r.table ? r : r.openTable(t);
      const out = [t, { rows: tr.rowCount, sortedBy: tr.sortedBy, columns: tr.columns.map((c) => c.name) }];
      if (tr !== r) tr.close();
      return out;
    }));
  } finally {
    r.close();
  }
};

test('a table added beside the others, its rows put in its order; the others kept as they were', () => {
  const file = path.join(temp(), 'statements.jzm');
  const key = JazminKey.generate();
  write(file, { clients, transactions }, {
    key, metadata: { title: 'Statements' },
    tables: [{ name: 'clients', columns: clientColumns, sortedBy: ['clientId'] }, { name: 'transactions', columns: txColumns, sortedBy: ['clientId', 'at'] }],
    files: [{ path: 'index.html', content: '<p>statements' }], package: { entry: 'index.html' },
    shapes: [{ name: 'Statement', table: 'clients', shape: { $rows: { name: 'name', lines: { $from: 'transactions', $on: { clientId: 'clientId' }, $rows: 'amount' } } } }],
  });
  update(file, { key, addTables: [{ name: 'payments', columns: txColumns, sortedBy: ['clientId', 'at'], rows: payments }], sortRunRows: 5 });
  const after = tablesOf(file, { key });
  assert.deepEqual(Object.keys(after), ['clients', 'transactions', 'payments']);
  assert.deepEqual([after.clients.rows, after.transactions.rows, after.payments.rows, after.payments.sortedBy], [3, 30, 12, ['clientId', 'at']]);
  const r = open(file, { key, table: 'payments' });
  const ordered = [...r.rows()].map((x) => `${x.clientId}|${x.at.toISOString()}`);
  assert.deepEqual(ordered, [...ordered].sort());
  assert.deepEqual([r.metadata, r.files.map((f) => f.path), r.shapes.map((s) => s.name)], [{ title: 'Statements' }, ['index.html'], ['Statement']]);
  r.close();
});

test('a table renamed: saved shapes and the document follow; a table removed: what reads it must go too', () => {
  const file = path.join(temp(), 'statements.jzm');
  write(file, { clients, tx: transactions }, {
    tables: [{ name: 'clients', columns: clientColumns }, { name: 'tx', columns: txColumns }],
    files: [{ path: 'index.html', content: '<p>x' }],
    package: { entry: 'index.html', edit: { table: 'tx', key: ['clientId', 'at'], columns: ['amount'] } },
    shapes: [{ name: 'Lines', table: 'clients', shape: { $rows: { name: 'name', lines: { $from: 'tx', $on: { clientId: 'clientId' }, $rows: 'amount' } } } }],
  });
  update(file, { renameTables: { tx: 'transactions' } });
  const r = open(file);
  assert.deepEqual(r.tables, ['clients', 'transactions']);
  assert.equal(r.package.edit.table, 'transactions');
  assert.equal(r.shapes[0].shape.$rows.lines.$from, 'transactions');
  r.close();

  const refused = (options, pattern) => assert.throws(() => update(file, options), (e) => e instanceof JazminValidationError && pattern.test(e.message));
  refused({ removeTables: ['transactions'] }, /The document's edits change table 'transactions', which is being removed/);
  update(file, { package: { entry: 'index.html' } }); // the document no longer edits it
  refused({ removeTables: ['transactions'] }, /Saved shape 'Lines' reads table 'transactions', which is being removed: remove the shape too/);
  update(file, { removeTables: ['transactions'], removeShapes: ['Lines'] });
  assert.deepEqual(Object.keys(tablesOf(file)), ['clients']);

  refused({ removeTables: ['nope'] }, /removeTables: the file has no table 'nope'/);
  refused({ renameTables: { nope: 'x' } }, /renameTables: the file has no table 'nope'/);
  refused({ addTables: [{ name: 'clients', columns: clientColumns }] }, /Table 'clients' would be in the file twice/);
  refused({ removeTables: ['clients'] }, /A file needs at least one table/);
  refused({ insert: [{ clientId: 'C9' }], removeTables: ['clients'], addTables: [{ name: 'x', columns: clientColumns }] }, /Table 'clients' is being removed: its rows can't change too/);
  refused({ addTables: [{ name: 'p', columns: txColumns, partitionBy: 'clientId' }] }, /partitionBy and columnGroups apply to shared files/);
});

test("a file's single unnamed table is named before a table joins it; compact() takes the same options", () => {
  const file = path.join(temp(), 'one.jzm');
  write(file, clients, { columns: clientColumns });
  assert.throws(() => update(file, { addTables: [{ name: 'tx', columns: txColumns, rows: transactions }] }), /name it first \(renameTables: \{ '': 'clients' \}\)/);
  compact(file, { renameTables: { '': 'clients' }, addTables: [{ name: 'tx', columns: txColumns, rows: transactions }] });
  assert.deepEqual(Object.entries(tablesOf(file)).map(([n, t]) => [n, t.rows]), [['clients', 3], ['tx', 30]]);
});

test('a shared file: a table added with the same partition column is seen by each key for its own partitions', () => {
  const file = path.join(temp(), 'shared.jzm');
  const owner = JazminKey.generate();
  const ann = owner.createAccessKey();
  write(file, { clients, transactions }, {
    key: owner, access: { grants: [{ key: ann, rows: ['C1'] }] },
    tables: [{ name: 'clients', columns: clientColumns, partitionBy: 'clientId' }, { name: 'transactions', columns: txColumns, partitionBy: 'clientId' }],
  });
  update(file, { key: owner, addTables: [{ name: 'payments', columns: txColumns, partitionBy: 'clientId', rows: payments }] });
  const r = open(file, { key: ann, table: 'payments' });
  const seen = [...r.rows()];
  r.close();
  assert.equal(seen.length, 4); // payments: 12, one in three for C1
  assert.ok(seen.every((x) => x.clientId === 'C1'));
});

test('a shape or a document that reads "the first table" keeps reading it when the first table is renamed or removed', () => {
  const file = path.join(temp(), 'first.jzm');
  write(file, { clients, tx: transactions }, {
    tables: [{ name: 'clients', columns: clientColumns }, { name: 'tx', columns: txColumns }],
    files: [{ path: 'index.html', content: '<p>x' }],
    package: { entry: 'index.html', edit: { key: ['clientId'], columns: ['name'] } }, // no table: the first, clients
    shapes: [{ name: 'Names', shape: { $rows: 'name' } }], // no table: the first, clients
  });
  update(file, { renameTables: { clients: 'people' } });
  let r = open(file);
  assert.deepEqual([r.tables, r.package.edit.table, r.shapes[0].table ?? r.tables[0]], [['people', 'tx'], 'people', 'people']);
  r.close();
  assert.throws(() => update(file, { removeTables: ['people'] }), /The document's edits change table 'people', which is being removed/);
  update(file, { package: { entry: 'index.html' } });
  assert.throws(() => update(file, { removeTables: ['people'] }), /Saved shape 'Names' reads table 'people', which is being removed/);
});

