import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, append, open, write } from '../src/index.js';

// Reading last first (reverse: true): the rows find() gives, in the other order, with offset and limit counted from the
// end, whatever the read uses (a scan, chunk statistics, an index, a shared file's partitions, the async reader).

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-reverse-'));
const columns = [
  { name: 'id', type: 'int' }, { name: 'at', type: 'datetime' }, { name: 'account', type: 'string', index: ['sorted'] },
  { name: 'amount', type: 'float' }, { name: 'branch', type: 'string' },
];
const T0 = Date.UTC(2026, 0, 1);
const rows = Array.from({ length: 5000 }, (_, i) => ({
  id: i, at: new Date(T0 + i * 3600_000), account: `A${i % 37}`, amount: (i * 7919) % 1000, branch: ['north', 'south', 'east'][i % 3],
}));
const ids = (list) => list.map((r) => r.id);
const backwards = (reader, filter, options = {}) => {
  const all = ids([...reader.find(filter, { select: options.select })]).reverse();
  return all.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? Infinity));
};

const cases = [
  ['every row', null, {}],
  ['the newest 50', null, { limit: 50 }],
  ['a page further back', null, { offset: 1234, limit: 100 }],
  ['an offset past whole chunks', null, { offset: 4100 }],
  ['a date range (chunk statistics)', { at: { gte: new Date(T0 + 1000 * 3600_000), lt: new Date(T0 + 1500 * 3600_000) } }, { limit: 75 }],
  ['an index lookup', { account: 'A5' }, { offset: 3, limit: 40 }],
  ['a scan filter', { amount: { gt: 900 } }, { offset: 10, limit: 200 }],
  ['a filter and a selection', { branch: 'east' }, { select: ['id', 'amount'], limit: 30 }],
  ['nothing matches', { account: 'nope' }, {}],
];

test('reverse: true gives find()\'s rows last first, with offset and limit from the end', () => {
  const r = open(write(null, rows, { columns, sortedBy: ['at'], chunkRows: 256 }));
  for (const [label, filter, options] of cases) {
    assert.deepEqual(ids([...r.find(filter, { ...options, reverse: true })]), backwards(r, filter, options), label);
  }
  assert.deepEqual(ids([...r.rows({ reverse: true, limit: 3 })]), [4999, 4998, 4997], 'rows() takes it too');
  assert.deepEqual(Object.keys([...r.find({ branch: 'east' }, { select: ['id', 'amount'], reverse: true, limit: 1 })][0]), ['id', 'amount']);
  assert.throws(() => [...r.rows({ reverse: 'yes' })], /reverse must be true or false/);
  r.close();
});

test('reverse reading skips deleted rows and reads an appended file and a shared file the same way', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ledger.jzm');
  write(file, rows, { columns, sortedBy: ['at'], chunkRows: 256 });
  append(file, {
    insert: [{ id: 5000, at: new Date(T0 + 5000 * 3600_000), account: 'A1', amount: 1, branch: 'north' }],
    delete: { id: { in: [4999, 4500, 17] } },
  });
  const r = open(file);
  for (const [label, filter, options] of cases) assert.deepEqual(ids([...r.find(filter, { ...options, reverse: true })]), backwards(r, filter, options), `appended: ${label}`);
  assert.deepEqual(ids([...r.rows({ reverse: true, limit: 2 })]), [5000, 4998]);
  r.close();

  const owner = JazminKey.generate();
  const north = owner.createAccessKey();
  const shared = path.join(dir, 'shared.jzm');
  const byBranch = [...rows].sort((x, y) => (x.branch < y.branch ? -1 : x.branch > y.branch ? 1 : x.id - y.id));
  write(shared, byBranch, {
    columns, key: owner, sortedBy: ['branch', 'at'], chunkRows: 256,
    access: { partitionBy: 'branch', grants: [{ key: north, rows: ['north', 'east'] }] },
  });
  for (const key of [owner, north]) {
    const s = open(fs.readFileSync(shared), { key: key.toString(), accessState: false });
    for (const [label, filter, options] of cases) assert.deepEqual(ids([...s.find(filter, { ...options, reverse: true })]), backwards(s, filter, options), `shared: ${label}`);
    s.close();
  }
});

test('findAsync and findBatchesAsync read last first too, reading ahead in that order', async () => {
  const file = path.join(tmpDir(), 'ledger.jzm');
  write(file, rows, { columns, sortedBy: ['at'], chunkRows: 256 });
  const r = open(file);
  for (const [label, filter, options] of cases) {
    const got = [];
    for await (const row of r.findAsync(filter, { ...options, reverse: true })) got.push(row.id);
    assert.deepEqual(got, backwards(r, filter, options), `findAsync: ${label}`);
    const batched = [];
    for await (const batch of r.findBatchesAsync(filter, { ...options, reverse: true })) batched.push(...ids(batch));
    assert.deepEqual(batched, got, `findBatchesAsync: ${label}`);
  }
  // Progress counts the chunks read last first.
  const seen = [];
  [...r.find(null, { reverse: true, limit: 600, onProgress: (p) => seen.push(p.done) })];
  assert.deepEqual(seen.at(-1), 3, 'three chunks of 256 rows hold the newest 600');
  r.close();
});

test("the query API's reverse(): the reader reads last first right after the filters, or after the file's own order", async () => {
  const { from } = await import('../src/index.js');
  const r = open(write(null, rows, { columns, sortedBy: ['at'], chunkRows: 256 }));
  const newest = from(r).where((t) => t.branch === 'east').reverse().take(5);
  assert.deepEqual(newest.toArray().map((t) => t.id), backwards(r, { branch: 'east' }, { limit: 5 }));
  assert.equal(newest.explain().reverse, true);
  assert.deepEqual(newest.explain().inMemory, []);
  const ordered = from(r).orderBy((t) => t.at).reverse().skip(10).take(3);
  assert.deepEqual(ordered.toArray().map((t) => t.id), [4989, 4988, 4987]);
  assert.equal(ordered.explain().reverse, true);
  // Elsewhere it reverses in memory, as LINQ does.
  const later = from(r).where((t) => t.id < 10).select((t) => t.id).reverse();
  assert.deepEqual(later.toArray(), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(later.explain().inMemory, ['select', 'reverse']);
  r.close();
});

test('exports take reverse too: the newest rows as JSON, CSV or XML', async () => {
  const { toCSV, toJSON } = await import('../src/index.js');
  const r = open(write(null, rows, { columns, sortedBy: ['at'], chunkRows: 256 }));
  assert.deepEqual(JSON.parse(toJSON(r, { reverse: true, limit: 3, select: ['id'] })), [{ id: 4999 }, { id: 4998 }, { id: 4997 }]);
  assert.equal(toCSV(r, { filter: { account: 'A5' }, reverse: true, limit: 2, select: ['id'] }), `id\r\n${backwards(r, { account: 'A5' }, { limit: 2 }).join('\r\n')}\r\n`);
  assert.throws(() => toJSON(r, { shape: { $rows: { id: 'id' } }, reverse: true }), /instead of select, limit, offset or reverse/);
  r.close();
});
