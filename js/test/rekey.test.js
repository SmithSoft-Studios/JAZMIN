import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, compact, open, update, write } from '../src/index.js';

// Changing rows with set + where, and several tables in one rewrite (update(): tables): a client's key changed in every
// table that refers to it, rows moved to their place when a sort column changes, a shared file's partitions kept.

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-rekey-'));
const clientColumns = [{ name: 'clientId', type: 'string', nullable: false }, { name: 'name', type: 'string' }];
const txColumns = [{ name: 'clientId', type: 'string', nullable: false }, { name: 'amount', type: 'decimal' }, { name: 'status', type: 'string' }];
const clients = [{ clientId: 'C1', name: 'Ann' }, { clientId: 'C2', name: 'Ben' }, { clientId: 'C3', name: 'Cat' }];
const transactions = Array.from({ length: 30 }, (_, i) => ({ clientId: `C${Math.floor(i / 10) + 1}`, amount: `${i}.25`, status: 'open' }));
const link = { name: 'client', from: { table: 'transactions', columns: ['clientId'] }, to: { table: 'clients', columns: ['clientId'] } };
const rowsOf = (file, options) => {
  const r = open(file, options);
  try {
    return [...r.rows()];
  } finally {
    r.close();
  }
};
const statements = (options = {}) => {
  const file = path.join(temp(), 'statements.jzm');
  write(file, { clients, transactions }, {
    tables: [{ name: 'clients', columns: clientColumns, sortedBy: ['clientId'] }, { name: 'transactions', columns: txColumns, sortedBy: ['clientId'] }],
    links: [link], ...options,
  });
  return file;
};

test("a client's key changed in every table in one rewrite: rows move to their new place and the link still holds", () => {
  const file = statements();
  const result = update(file, {
    table: 'clients', set: { clientId: 'C9' }, where: { clientId: 'C1' },
    tables: { transactions: { set: { clientId: 'C9' }, where: { clientId: 'C1' } } },
    sortRunRows: 4, // more rows than this go through the sorter's temporary files (transactions); fewer are merged in (clients)
  });
  assert.deepEqual([result.rowCount, result.updated], [3, 1]);
  assert.deepEqual(result.tables, {
    clients: { rowCount: 3, inserted: 0, updated: 1, deleted: 0 },
    transactions: { rowCount: 30, inserted: 0, updated: 10, deleted: 0 },
  });
  assert.deepEqual(rowsOf(file).map((c) => c.clientId), ['C2', 'C3', 'C9']); // still in clientId order
  const tx = rowsOf(file, { table: 'transactions' });
  assert.deepEqual(tx.map((t) => t.clientId), [...Array(10).fill('C2'), ...Array(10).fill('C3'), ...Array(10).fill('C9')]);
  assert.deepEqual(tx.slice(20).map((t) => t.amount), transactions.slice(0, 10).map((t) => t.amount)); // equal keys keep their order
  const r = open(file);
  const [check] = r.checkLinks();
  assert.deepEqual([r.sortedBy, check.missing, check.method], [['clientId'], 0, 'merge']);
  r.close();
});

test('set on columns the order does not use keeps the order and merges inserts; deletes go first, upserts replace whole rows', () => {
  const file = statements();
  const result = update(file, {
    table: 'transactions',
    delete: { amount: '0.25' },
    upsert: [{ clientId: 'C1', amount: '1.25', status: 'paid by hand' }], keyColumns: ['clientId', 'amount'],
    insert: [{ clientId: 'C2', amount: '99.00', status: 'new' }],
    set: { status: 'closed' }, where: { clientId: 'C1' },
  });
  assert.deepEqual([result.rowCount, result.inserted, result.updated, result.deleted], [30, 1, 9, 1]); // 1 upserted + 8 set
  const tx = rowsOf(file, { table: 'transactions' });
  assert.deepEqual(tx.filter((t) => t.clientId === 'C1').map((t) => t.status), [...Array(8).fill('closed'), 'paid by hand']); // an upserted row goes after rows of equal sort value
  assert.deepEqual(tx.filter((t) => t.clientId === 'C2').map((t) => t.status), [...Array(10).fill('open'), 'new']);
  assert.deepEqual(tx.map((t) => t.clientId), [...tx.map((t) => t.clientId)].sort());
  assert.ok(!('tables' in result)); // only when tables was given

  // Every row (where: {}), in a file's single table, and through compact(), which takes the same options.
  const one = path.join(temp(), 'one.jzm');
  write(one, transactions, { columns: txColumns });
  compact(one, { set: { status: 'archived' }, where: {} });
  assert.ok(rowsOf(one).every((t) => t.status === 'archived'));
});

test("the main table's changes can be given in tables; others are copied as they are", () => {
  const file = statements();
  const result = update(file, { tables: { clients: { set: { name: 'Benjamin' }, where: { clientId: 'C2' } } } });
  assert.deepEqual(result.tables, { clients: { rowCount: 3, inserted: 0, updated: 1, deleted: 0 } });
  assert.deepEqual(rowsOf(file).map((c) => c.name), ['Ann', 'Benjamin', 'Cat']);
  assert.deepEqual(rowsOf(file, { table: 'transactions' }), transactions);
});

test('changes that would go wrong are refused before anything is written', () => {
  const file = statements();
  const before = fs.readFileSync(file);
  const refused = (options, pattern) => assert.throws(() => update(file, options), (e) => e instanceof JazminValidationError && pattern.test(e.message));
  refused({ set: { name: 'x' } }, /set and where go together/);
  refused({ where: { clientId: 'C1' } }, /set and where go together/);
  refused({ set: {}, where: {} }, /set: \{ column: value, \.\.\. \}/);
  refused({ set: { nope: 1 }, where: {} }, /table 'clients': set: unknown column 'nope'/);
  refused({ set: { clientId: 5 }, where: {} }, /table 'clients': set: Column 'clientId': expected a string, got number/);
  refused({ set: { clientId: null }, where: {} }, /table 'clients': set: column 'clientId' can't be empty/);
  refused({ set: { name: undefined }, where: {} }, /table 'clients': set: column 'name' has no value \(null empties it\)/);
  refused({ tables: { nope: { set: { x: 1 }, where: {} } } }, /tables: the file has no table 'nope'/);
  refused({ tables: [] }, /tables: \{ tableName:/);
  refused({ insert: [{ clientId: 'C4' }], tables: { clients: { delete: { clientId: 'C1' } } } }, /give table 'clients''s changes either in tables or with the other options/);
  refused({ removeTables: ['transactions'], links: [], tables: { transactions: { set: { status: 'x' }, where: {} } } }, /Table 'transactions' is being removed/);
  assert.deepEqual(fs.readFileSync(file), before);
  update(file, { insert: [], tables: { clients: { set: { name: 'Ann' }, where: { clientId: 'C1' } } } }); // empty lists change nothing
});

test("a shared file: the partition column can't be set; other columns can, and each key still sees its own rows", () => {
  const file = path.join(temp(), 'shared.jzm');
  const owner = JazminKey.generate();
  const ann = owner.createAccessKey();
  write(file, { clients, transactions }, {
    key: owner, access: { grants: [{ key: ann, rows: ['C1'] }] },
    tables: [{ name: 'clients', columns: clientColumns, partitionBy: 'clientId' }, { name: 'transactions', columns: txColumns, partitionBy: 'clientId' }],
  });
  assert.throws(() => update(file, { key: owner, tables: { transactions: { set: { clientId: 'C9' }, where: { clientId: 'C1' } } } }),
    /table 'transactions': set changes the partition column 'clientId': the rows would leave the partitions keys are granted/);
  update(file, { key: owner, tables: { transactions: { set: { status: 'paid' }, where: { clientId: 'C1' } } } });
  const seen = rowsOf(file, { key: ann, table: 'transactions' });
  assert.deepEqual([seen.length, seen.every((t) => t.clientId === 'C1' && t.status === 'paid')], [10, true]);
});
