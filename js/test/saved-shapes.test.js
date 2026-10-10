import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminKey, JazminValidationError, JazminWriter, append, compact, grantAccess, open, rotateKey, rotateOwnerKey, shapeSchema,
  toJSON, toXML, update, write,
} from '../src/index.js';
import { directoryShapes, shapeFits } from '../src/saved-shapes.js';

// Saved export shapes (docs/design/saved-shapes.md): kept in the file directories, listed only for keys that can use them.

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-shapes-'));
const columns = [
  { name: 'id', type: 'int' }, { name: 'account', type: 'string' }, { name: 'amount', type: 'float' },
  { name: 'balance', type: 'float' }, { name: 'region', type: 'string' },
];
const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, account: `A${i % 4}`, amount: i * 1.5, balance: 1000 - i, region: i % 2 ? 'ZA' : 'NA' }));
const totals = { $groupBy: 'account', $sort: ['account'], $rows: { account: 'account', total: { $sum: 'amount' }, count: { $count: true } } };
const balances = { $rows: { id: 'id', balance: 'balance' }, $limit: 3 };
const names = (reader) => reader.shapes.map((s) => s.name);
const refused = (fn, message) => assert.throws(fn, (e) => e instanceof JazminValidationError && message.test(e.message), String(message));

/** Bob sees region ZA and not the money group; Sally sees everything and the named file group 'finance'. */
function sharedFile(file, shapes, extra = {}) {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const sally = owner.createAccessKey();
  write(file, rows, {
    columns, key: owner, ...extra,
    access: {
      partitionBy: 'region', columnGroups: { money: ['balance'] },
      grants: [{ key: bob, rows: ['ZA'], columns: ['*'], label: 'Bob' }, { key: sally, rows: '*', columns: '*', files: ['finance'], label: 'Sally' }],
    },
    shapes,
  });
  return { owner, bob, sally };
}

test('a saved shape is listed by name and exports what the shape itself exports, as JSON, XML and its schema', () => {
  const file = path.join(tmpDir(), 'plain.jzm');
  write(file, rows, {
    columns,
    shapes: [{ name: 'Totals', shape: totals, default: true, description: 'Per account' }, { name: 'Balances', shape: balances }],
  });
  const r = open(file);
  assert.deepEqual(r.shapes, [
    { name: 'Balances', groups: ['*'], shape: balances },
    { name: 'Totals', description: 'Per account', default: true, groups: ['*'], shape: totals },
  ]);
  assert.equal(toJSON(r, { shape: 'Totals' }), toJSON(r, { shape: totals }));
  assert.equal(toJSON(r, { shape: 'Totals', pretty: true, filter: { amount: { gt: 20 } } }), toJSON(r, { shape: totals, pretty: true, filter: { amount: { gt: 20 } } }));
  assert.equal(toXML(r, { shape: 'Balances', root: 'balances' }), toXML(r, { shape: balances, root: 'balances' }));
  assert.deepEqual(shapeSchema(r, 'Totals'), shapeSchema(r, totals));
  refused(() => toJSON(r, { shape: 'Nope' }), /^No saved shape 'Nope' is visible with this key$/);
  r.shapes[0].shape.$limit = 99; // a copy: the reader's list does not change
  assert.equal(r.shapes[0].shape.$limit, 3);
  r.close();
});

test('a shape that does not fit the file is refused when written, naming the shape and the mistake', () => {
  const tryWrite = (shapes, extra = {}) => () => write(null, rows, { columns, shapes, ...extra });
  refused(tryWrite([{ name: 'X', shape: { $rows: { a: 'nope' } } }]), /^Saved shape 'X': Shape at shape\[\]\.a: unknown or hidden column 'nope'$/);
  refused(tryWrite([{ name: 'X', shape: totals, table: 'other' }]), /^Saved shape 'X': unknown table 'other'$/);
  refused(tryWrite([{ name: 'X', shape: totals }, { name: 'X', shape: balances }]), /^Saved shape 'X' is given twice$/);
  refused(tryWrite([{ name: 'X', shape: totals, default: true }, { name: 'Y', shape: balances, default: true }]), /^Saved shapes 'X' and 'Y' are both the default for everyone$/);
  refused(tryWrite([{ name: 'X', shape: [1] }]), /^Saved shape 'X': the shape must be an object$/);
  refused(tryWrite([{ name: '', shape: totals }]), /^shapes\[0\]: name must be text of 1 to 200 characters$/);
  refused(tryWrite([{ name: 'X', shape: totals, colour: 'red' }]), /^shapes\[0\]: unknown member 'colour'/);
  refused(tryWrite([{ name: 'X', shape: totals, groups: [] }]), /^Saved shape 'X': groups must be '\*' or a non-empty array$/);
  refused(tryWrite({ name: 'X' }), /^shapes must be an array$/);
  const dir = tmpDir(); // refused before anything is written: no file is left
  refused(() => write(path.join(dir, 'bad.jzm'), rows, { columns, shapes: [{ name: 'X', shape: { $rows: 'nope' } }] }), /^Saved shape 'X'/);
  assert.deepEqual(fs.readdirSync(dir), []);
  // Different groups may each have their own default.
  const key = JazminKey.generate();
  assert.ok(write(null, rows, { columns, key, shapes: [{ name: 'X', shape: totals, default: true, groups: ['a'] }, { name: 'Y', shape: balances, default: true, groups: ['b'] }] }));
});

test('saved shapes are encrypted with the directories: their text is not in the file', () => {
  const dir = tmpDir();
  const key = JazminKey.generate();
  write(path.join(dir, 'key.jzm'), rows, { columns, key, shapes: [{ name: 'Quarterly balances', shape: balances }] });
  sharedFile(path.join(dir, 'shared.jzm'), [{ name: 'Quarterly balances', shape: balances, groups: ['finance'] }]);
  for (const name of ['key.jzm', 'shared.jzm']) {
    const bytes = fs.readFileSync(path.join(dir, name));
    assert.equal(bytes.includes('Quarterly'), false, name);
    assert.equal(bytes.includes('balance'), false, name);
  }
  assert.deepEqual(names(open(path.join(dir, 'key.jzm'), { key })), ['Quarterly balances']);
});

test('shared files: each key sees only the shapes of its groups that it can use', () => {
  const file = path.join(tmpDir(), 'shared.jzm');
  const { owner, bob, sally } = sharedFile(file, [
    { name: 'Totals', shape: totals },
    { name: 'Balances', shape: balances, groups: ['finance'] },
    { name: 'South', shape: { $rows: 'id', $limit: 2 }, groups: ['ZA'] },
    { name: 'North', shape: { $rows: 'id', $limit: 2 }, groups: ['NA'], default: true },
  ]);
  const o = open(file, { key: owner });
  assert.deepEqual(o.shapes.map((s) => [s.name, s.groups]), [['Balances', ['finance']], ['North', ['NA']], ['South', ['ZA']], ['Totals', ['*']]]);
  const b = open(file, { key: bob });
  assert.deepEqual(b.shapes.map((s) => [s.name, s.groups]), [['South', undefined], ['Totals', undefined]]);
  refused(() => toJSON(b, { shape: 'Balances' }), /^No saved shape 'Balances' is visible with this key$/);
  assert.equal(toJSON(b, { shape: 'South' }), '[1,3]'); // Bob's rows only
  const s = open(file, { key: sally });
  assert.deepEqual(names(s), ['Balances', 'North', 'South', 'Totals']); // rows '*': every partition's group
  assert.equal(toJSON(s, { shape: 'Balances' }), toJSON(o, { shape: 'Balances' }));
  for (const r of [o, b, s]) r.close();
});

test('shared files: a shape is refused when a key that would see it cannot see a column it uses, also when granted later', () => {
  const dir = tmpDir();
  refused(() => sharedFile(path.join(dir, 'a.jzm'), [{ name: 'Balances', shape: balances }]),
    /^Saved shape 'Balances' doesn't fit access key [0-9a-f]+ \(Bob\), which sees it \(a shape for everyone\): Shape at shape\[\]\.balance: unknown or hidden column 'balance'$/);
  refused(() => sharedFile(path.join(dir, 'b.jzm'), [{ name: 'Balances', shape: balances, groups: ['ZA'] }]),
    /^Saved shape 'Balances' doesn't fit access key [0-9a-f]+ \(Bob\), which sees it \(file group 'ZA'\)/);
  assert.equal(fs.existsSync(path.join(dir, 'a.jzm')), false); // nothing left behind

  const file = path.join(dir, 'shared.jzm');
  const { owner, bob } = sharedFile(file, [{ name: 'Balances', shape: balances, groups: ['finance'] }, { name: 'North balances', shape: balances, groups: ['NA'] }]);
  const before = fs.readFileSync(file);
  const bobFinance = { key: bob, rows: ['ZA'], columns: ['*'], files: ['finance'], label: 'Bob' };
  refused(() => update(file, { key: owner, grant: [bobFinance] }), /doesn't fit access key [0-9a-f]+ \(Bob\), which sees it \(file group 'finance'\)/);
  refused(() => append(file, { key: owner, grant: [bobFinance] }), /\(Bob\), which sees it \(file group 'finance'\)/);
  // More rows: Bob's key would see the shapes of partition NA.
  refused(() => grantAccess(file, owner, bob, { rows: ['NA', 'ZA'], columns: ['*'] }), /^Saved shape 'North balances' doesn't fit access key [0-9a-f]+, which sees it \(file group 'NA'\)/);
  assert.ok(fs.readFileSync(file).equals(before));
  // Seeing the columns too is fine.
  update(file, { key: owner, grant: [{ ...bobFinance, columns: '*' }] });
  assert.deepEqual(names(open(file, { key: bob })), ['Balances']);
});

test('append, update, compaction and key rotation keep saved shapes; update and append add, replace and remove them', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'f.jzm');
  const key = JazminKey.generate();
  write(file, rows, { columns, key, shapes: [{ name: 'Totals', shape: totals }, { name: 'Balances', shape: balances }] });
  append(file, { key, insert: [{ id: 40, account: 'A0', amount: 1, balance: 1, region: 'ZA' }] });
  assert.deepEqual(names(open(file, { key })), ['Balances', 'Totals']);
  append(file, { key, addShapes: [{ name: 'Ids', shape: { $rows: 'id', $limit: 2 } }], removeShapes: ['Balances'] });
  assert.deepEqual(names(open(file, { key })), ['Ids', 'Totals']);
  update(file, { key, addShapes: [{ name: 'Ids', shape: { $rows: 'id', $limit: 1 }, description: 'Replaced' }] });
  let r = open(file, { key });
  assert.equal(toJSON(r, { shape: 'Ids' }), '[0]');
  assert.equal(r.shapes.find((s) => s.name === 'Ids').description, 'Replaced');
  r.close();
  compact(file, { key });
  const newKey = JazminKey.generate();
  rotateKey(file, { key, newKey });
  r = open(file, { key: newKey });
  assert.deepEqual(names(r), ['Ids', 'Totals']);
  assert.equal(toJSON(r, { shape: 'Totals' }), toJSON(r, { shape: totals }));
  r.close();
  refused(() => update(file, { key: newKey, removeShapes: ['Gone'] }), /^removeShapes: no saved shape 'Gone'$/);
  refused(() => append(file, { key: newKey, removeShapes: ['Gone'] }), /^removeShapes: no saved shape 'Gone'$/);
  update(file, { key: newKey, removeShapes: ['Ids', 'Totals'] });
  assert.deepEqual(open(file, { key: newKey }).shapes, []);
  // A file without files or shapes gets its first shape by append.
  const plain = path.join(dir, 'plain.jzm');
  write(plain, rows, { columns });
  append(plain, { addShapes: [{ name: 'Totals', shape: totals }] });
  assert.deepEqual(names(open(plain)), ['Totals']);
  refused(() => append(plain, { addShapes: [{ name: 'Bad', shape: { $rows: 'nope' } }] }), /^Saved shape 'Bad': Shape at shape\[\]: unknown or hidden column 'nope'$/);
});

test('shared files: compaction and a new owner key keep saved shapes for the same groups', () => {
  const file = path.join(tmpDir(), 'shared.jzm');
  const { owner } = sharedFile(file, [{ name: 'Totals', shape: totals }, { name: 'Balances', shape: balances, groups: ['finance'] }]);
  compact(file, { key: owner });
  const { ownerKey, accessKeys } = rotateOwnerKey(file, { key: owner });
  assert.deepEqual(open(file, { key: ownerKey }).shapes.map((s) => [s.name, s.groups]), [['Balances', ['finance']], ['Totals', ['*']]]);
  assert.deepEqual(accessKeys.map((k) => [k.label, names(open(file, { key: k.key }))]), [['Bob', ['Totals']], ['Sally', ['Balances', 'Totals']]]);
});

test('several tables: a shape reads its own table, links to others, and is checked against them', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'tables.jzm');
  const tables = [
    { name: 'clients', columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }] },
    { name: 'tx', columns: [{ name: 'client', type: 'int' }, { name: 'amount', type: 'float' }] },
  ];
  const withTx = { $rows: { name: 'name', tx: { $from: 'tx', $on: { client: 'id' }, $rows: 'amount' } } };
  const w = new JazminWriter(file, {
    tables,
    shapes: [{ name: 'Clients', shape: withTx, table: 'clients' }, { name: 'Amounts', table: 'tx', shape: { $rows: 'amount' } }],
  });
  w.writeRows([{ id: 1, name: 'Ann' }, { id: 2, name: 'Ben' }]);
  w.startTable('tx');
  w.writeRows([{ client: 1, amount: 5 }, { client: 2, amount: 7 }, { client: 1, amount: 9 }]);
  w.finish();
  let r = open(file);
  assert.deepEqual(r.shapes.map((s) => [s.name, s.table]), [['Amounts', 'tx'], ['Clients', undefined]]); // the first table needs no name
  assert.equal(toJSON(r, { shape: 'Clients' }), '[{"name":"Ann","tx":[5,9]},{"name":"Ben","tx":[7]}]');
  assert.equal(toJSON(r, { shape: 'Amounts' }), '[5,7,9]'); // read from its own table
  const tx = open(file, { table: 'tx' });
  assert.equal(toJSON(tx, { shape: 'Clients' }), toJSON(r, { shape: 'Clients' }));
  tx.close();
  r.close();
  append(file, { table: 'tx', insert: [{ client: 2, amount: 1 }], addShapes: [{ name: 'Big', table: 'tx', shape: { $rows: 'amount', $filter: { amount: { gt: 6 } } } }] });
  r = open(file);
  assert.equal(toJSON(r, { shape: 'Clients' }), '[{"name":"Ann","tx":[5,9]},{"name":"Ben","tx":[7,1]}]');
  assert.equal(toJSON(r, { shape: 'Big' }), '[7,9]');
  r.close();
  refused(() => append(file, { table: 'tx', insert: [], addShapes: [{ name: 'Bad', shape: { $rows: { x: { $from: 'tx', $on: { nope: 'id' }, $rows: 'amount' } } } }] }),
    /^Saved shape 'Bad': Shape at shape\[\]\.x\.\$on\.nope: unknown or hidden column 'nope' in table 'tx'$/);
  update(file, { table: 'tx', addShapes: [{ name: 'Count', table: 'tx', shape: { $count: true } }] });
  assert.deepEqual(names(open(file)), ['Amounts', 'Big', 'Clients', 'Count']);
  // A file's first shape, added by an append to another table, is checked against the tables it links.
  const fresh = path.join(dir, 'fresh.jzm');
  write(fresh, { clients: [{ id: 1, name: 'Ann' }], tx: [{ client: 1, amount: 5 }] }, { tables });
  append(fresh, { table: 'tx', insert: [{ client: 1, amount: 6 }], addShapes: [{ name: 'Clients', shape: withTx }] });
  assert.equal(toJSON(open(fresh), { shape: 'Clients' }), '[{"name":"Ann","tx":[5,6]}]');
});

test('readers leave out saved shapes they cannot use or do not understand', () => {
  const columnsOf = (name) => ({ t: [{ name: 'id', type: 'int' }] })[name];
  assert.equal(shapeFits({ name: 'a', shape: { $rows: 'id' } }, 't', columnsOf), true);
  assert.equal(shapeFits({ name: 'a', shape: { $rows: 'secret' } }, 't', columnsOf), false);
  assert.equal(shapeFits({ name: 'a', table: 'gone', shape: { $rows: 'id' } }, 't', columnsOf), false);
  assert.deepEqual(directoryShapes({ files: [], contents: [] }), []);
  assert.deepEqual(directoryShapes({ shapes: 'x' }), []);
  const ok = { name: 'a', shape: {} };
  assert.deepEqual(directoryShapes({ shapes: [ok, null, { name: '', shape: {} }, { name: 'b', shape: [] }, { name: 'c', shape: {}, default: 'yes' }, { name: 'd', shape: {}, groups: [1] }] }), [ok]);
});
