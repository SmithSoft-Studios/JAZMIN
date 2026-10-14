import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminKeyError, JazminValidationError, append, compact, open, update, write } from '../src/index.js';
import { RowSorter } from '../src/sort-rows.js';

// Changing an existing file's indexes and sort order (update() and compact(): indexes, sortedBy). Everything else in the
// file is kept; a new sort order is applied within a memory budget, through temporary files locked with a key of their
// own when the rows don't fit.

// A temp folder of this test file's own: other test files, run beside it, re-sort through jazmin-sort-* folders too, and
// these tests count and open them (os.tmpdir() reads TMPDIR, TEMP and TMP each time).
const ownTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-layout-tests-'));
process.env.TMPDIR = ownTemp;
process.env.TEMP = ownTemp;
process.env.TMP = ownTemp;
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-layout-'));
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'customer', type: 'string' },
  { name: 'city', type: 'string', index: 'sorted' },
  { name: 'amount', type: 'decimal' },
  { name: 'at', type: 'datetime' },
];
const row = (i) => ({ id: i, customer: `C${String(i % 37).padStart(3, '0')}`, city: ['Durban', 'Cape Town', 'Pretoria'][i % 3], amount: `${(i * 7) % 1000}.50`, at: new Date(Date.UTC(2026, 0, 1) + i * 60_000) });
const rows = (n) => Array.from({ length: n }, (_, i) => row(i));
const indexesOf = (file, options) => {
  const r = open(file, options);
  try {
    return r.indexes.map((ix) => `${ix.column}:${ix.kind}`).sort();
  } finally {
    r.close();
  }
};
const read = (file, options, filter) => {
  const r = open(file, options);
  try {
    return { rows: [...r.find(filter ?? null)], sortedBy: r.sortedBy, metadata: r.metadata, files: r.files.map((f) => f.path) };
  } finally {
    r.close();
  }
};

test('indexes added, changed and removed; queries answer the same; the rest of the file is kept', () => {
  const file = path.join(temp(), 'orders.jzm');
  const key = JazminKey.generate();
  write(file, rows(3000), { columns, key, sortedBy: ['id'], metadata: { title: 'Orders' }, files: [{ path: 'index.html', content: '<p>orders' }], package: { entry: 'index.html' } });
  const before = read(file, { key }, { customer: 'C005' });

  update(file, { key, indexes: { customer: ['sorted', 'trigram'], city: [] } });
  assert.deepEqual(indexesOf(file, { key }), ['customer:sorted', 'customer:trigram']); // id is the sort order: no index needed
  const after = read(file, { key }, { customer: 'C005' });
  assert.deepEqual([after.rows, after.sortedBy, after.metadata, after.files], [before.rows, ['id'], { title: 'Orders' }, ['index.html']]);
  const r = open(file, { key });
  assert.equal([...r.find({ customer: { contains: '036' } })].length, [...rows(3000)].filter((x) => x.customer.includes('036')).length);
  r.close();

  // A change: the city gets a text-search index instead; compact() takes the same option.
  compact(file, { key, indexes: { city: 'trigram', customer: 'sorted' } });
  assert.deepEqual(indexesOf(file, { key }), ['city:trigram', 'customer:sorted']);

  const invalid = (options, pattern) => assert.throws(() => update(file, { key, ...options }), (e) => e instanceof JazminValidationError && pattern.test(e.message));
  invalid({ indexes: { nope: ['sorted'] } }, /indexes: unknown column 'nope'/);
  invalid({ indexes: { amount: ['trigram'] } }, /a trigram index is not supported on decimal/);
  invalid({ indexes: { id: ['hash'] } }, /unknown index kind 'hash'/);
  invalid({ indexes: ['id'] }, /indexes: \{ column/);
  assert.deepEqual(indexesOf(file, { key }), ['city:trigram', 'customer:sorted']); // refused: unchanged
});

test('a new sort order: in memory or through temporary runs, the same rows in the same order, equal keys as they were', () => {
  const dir = temp();
  const key = JazminKey.generate();
  const source = rows(5000).reverse(); // ids descending, so the new order differs from the file's
  const expected = [...source].sort((a, b) => (a.customer < b.customer ? -1 : a.customer > b.customer ? 1 : 0) || (a.at - b.at)).map((x) => x.id);
  for (const runRows of [100_000, 400]) {
    const file = path.join(dir, `orders-${runRows}.jzm`);
    write(file, source, { columns, key });
    const sortDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('jazmin-sort-')).length;
    const dirsBefore = sortDirs();
    update(file, { key, sortedBy: ['customer', 'at'], sortRunRows: runRows });
    assert.equal(sortDirs(), dirsBefore, 'the temporary runs are deleted');
    const after = read(file, { key });
    assert.deepEqual(after.sortedBy, ['customer', 'at']);
    assert.deepEqual(after.rows.map((x) => x.id), expected, `runRows ${runRows}`);
    // A sorted file: a range on the leading column reads only its chunks, and appends must keep the order.
    assert.throws(() => append(file, { key, insert: [{ ...row(1), customer: 'A000' }] }), /order|sort/i);
  }

  // Equal keys keep the order they were in (stable), across runs too.
  const file = path.join(dir, 'stable.jzm');
  write(file, rows(2000), { columns, key });
  update(file, { key, sortedBy: ['city'], sortRunRows: 300 });
  const byCity = read(file, { key }).rows;
  for (const city of ['Cape Town', 'Durban', 'Pretoria']) {
    const ids = byCity.filter((x) => x.city === city).map((x) => x.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), city);
  }

  // No order: rows stay where they are, and appends may go anywhere.
  update(file, { key, sortedBy: null });
  const unsorted = read(file, { key });
  assert.deepEqual([unsorted.sortedBy, unsorted.rows.map((x) => x.id)], [undefined, byCity.map((x) => x.id)]);
  append(file, { key, insert: [row(-1)] });
  assert.throws(() => update(file, { key, sortedBy: ['nope'] }), /sortedBy: unknown column 'nope'/);
  assert.throws(() => update(file, { key, sortedBy: 'id' }), /sortedBy must be an array of column names/);
});

test('the temporary runs are JAZMIN files locked with a key made for them, never readable without it', () => {
  const sorter = new RowSorter(columns, ['customer'], { runRows: 50 });
  try {
    for (const r of rows(200)) sorter.add(r);
    assert.equal(sorter.runs, 4);
    const dir = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('jazmin-sort-')).map((n) => path.join(os.tmpdir(), n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const run = path.join(dir, fs.readdirSync(dir)[0]);
    assert.throws(() => open(run), JazminKeyError);
    assert.ok(!fs.readFileSync(run).includes(Buffer.from('Cape Town')), 'no row text in the clear');
    const sorted = [...sorter.rows()].map((x) => x.customer);
    assert.deepEqual(sorted, [...sorted].sort());
  } finally {
    sorter.close();
  }
});

test('sort order and indexes change with other changes in one rewrite; other tables and shared files keep theirs', () => {
  const dir = temp();
  const key = JazminKey.generate();
  const file = path.join(dir, 'shop.jzm');
  write(file, { orders: rows(500), lines: rows(50) }, {
    key,
    tables: [{ name: 'orders', columns, sortedBy: ['id'] }, { name: 'lines', columns, sortedBy: ['id'] }],
  });
  const result = update(file, { key, table: 'orders', sortedBy: ['amount', 'id'], indexes: { customer: 'sorted', amount: 'sorted' }, delete: { id: { lt: 100 } }, insert: [row(9000)], sortRunRows: 64 });
  assert.deepEqual([result.deleted, result.inserted, result.rowCount], [100, 1, 401]);
  const orders = open(file, { key, table: 'orders' });
  const amounts = [...orders.rows()].map((x) => Number(x.amount));
  assert.deepEqual([orders.sortedBy, amounts.length], [['amount', 'id'], 401]);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => a - b));
  // The new first sort column needs no sorted index (the order finds its values); the id column, no longer sorted, keeps its own.
  assert.deepEqual(orders.indexes.map((ix) => ix.column).sort(), ['city', 'customer', 'id']);
  const lines = orders.openTable('lines');
  assert.deepEqual([lines.sortedBy, lines.rowCount, lines.indexes.map((ix) => ix.column).sort()], [['id'], 50, ['city']]);
  lines.close();
  orders.close();

  // A shared file: the grants, partitions and each key's view are kept.
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const shared = path.join(dir, 'shared.jzm');
  write(shared, rows(900), { columns, key: owner, access: { partitionBy: 'city', grants: [{ key: bob, rows: ['Durban'] }] } });
  update(shared, { key: owner, sortedBy: ['city', 'amount'], indexes: { customer: 'trigram' }, sortRunRows: 100 });
  const bobs = open(shared, { key: bob });
  const seen = [...bobs.rows()];
  assert.equal(seen.length, 300);
  assert.ok(seen.every((x) => x.city === 'Durban'));
  assert.deepEqual(bobs.sortedBy, ['city', 'amount']);
  bobs.close();
  assert.ok(indexesOf(shared, { key: owner }).includes('customer:trigram'));
});
