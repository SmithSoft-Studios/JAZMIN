import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, JazminWriter, append, open, openAsync, write, writeAsync } from '../src/index.js';

const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'account', type: 'string', index: 'sorted' },
  { name: 'note', type: 'string', index: 'trigram' },
  { name: 'amount', type: 'float' },
  { name: 'when', type: 'datetime' },
];
const rows = Array.from({ length: 3000 }, (_, i) => ({
  id: i,
  account: `ACC${String((i * 7919) % 300).padStart(3, '0')}`,
  note: i % 5 === 0 ? null : `payment ${i} ${['rent', 'fuel', 'salary'][i % 3]}`,
  amount: (i % 1000) / 4,
  when: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000),
}));
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-async-')), name);
const collect = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};
const queries = [
  [null, undefined],
  [{ id: { gte: 1200, lt: 1300 } }, undefined], // chunk statistics (sorted by id)
  [{ account: 'ACC042' }, { select: ['id', 'amount'] }], // sorted index
  [{ note: { icontains: 'FUEL 12' } }, undefined], // trigram index
  [{ amount: { gt: 240 }, note: { isNull: false } }, { limit: 25, offset: 10 }], // scan with a filter
  [null, { select: ['when'], limit: 7 }],
];

test('findAsync returns exactly what find returns', async () => {
  const file = tmp('a.jzm');
  write(file, rows, { columns, sortedBy: ['id'], chunkRows: 100 });
  const r = open(file);
  for (const [filter, options] of queries) {
    assert.deepEqual(await collect(r.findAsync(filter, options)), [...r.find(filter, options)], JSON.stringify(filter));
  }
  assert.deepEqual(await collect(r.rowsAsync()), [...r.rows()]);
  for (const [filter, options] of queries) {
    const batches = await collect(r.findBatchesAsync(filter, options));
    assert.ok(batches.every((b) => Array.isArray(b) && b.length > 0));
    assert.deepEqual(batches.flat(), [...r.find(filter, options)], JSON.stringify(filter));
  }
  r.close();
});

test('findAsync reads chunks with non-blocking reads and lets other work run', async () => {
  const file = tmp('b.jzm');
  write(file, rows, { columns, sortedBy: ['id'], chunkRows: 100 });
  const r = open(file);
  const chunks = Math.ceil(rows.length / 100);
  const originalSync = fs.readSync;
  const originalRead = fs.read;
  let syncReads = 0;
  let asyncReads = 0;
  fs.readSync = (...args) => {
    syncReads++;
    return originalSync(...args);
  };
  fs.read = (...args) => {
    asyncReads++;
    return originalRead(...args);
  };
  let turns = 0;
  let spinning = true;
  const spin = () => {
    turns++;
    if (spinning) setImmediate(spin);
  };
  setImmediate(spin);
  try {
    const all = await collect(r.findAsync({ amount: { gte: 0 } }));
    assert.equal(all.length, rows.length);
  } finally {
    spinning = false;
    fs.readSync = originalSync;
    fs.read = originalRead;
  }
  assert.ok(asyncReads >= chunks, `chunk reads were asynchronous (${asyncReads})`);
  assert.ok(syncReads <= 2, `only small metadata sections were read synchronously (${syncReads})`);
  assert.ok(turns >= chunks / 2, `the event loop ran between chunks (${turns} turns for ${chunks} chunks)`);
  r.close();
});

test('findAsync: early exit, encrypted and access-controlled files, appended files, buffers', async () => {
  const key = JazminKey.generate();
  const file = tmp('c.jzm');
  write(file, rows.slice(0, 2000), { columns, key, sortedBy: ['id'], chunkRows: 100 });
  append(file, { key, insert: rows.slice(2000), delete: { id: { lt: 50 } }, chunkRows: 100 });
  const r = open(file, { key });
  let n = 0;
  for await (const row of r.findAsync({ id: { gte: 100 } })) {
    assert.ok(row.id >= 100);
    if (++n === 5) break; // stops the scan and drops what was read ahead
  }
  for (const [filter, options] of queries) {
    assert.deepEqual(await collect(r.findAsync(filter, options)), [...r.find(filter, options)], JSON.stringify(filter));
  }
  r.close();

  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const access = { partitionBy: 'account', grants: [{ key: bob, rows: ['ACC001', 'ACC002'], columns: '*' }] };
  const accessFile = tmp('d.jzm');
  write(accessFile, [...rows].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.id - b.id)), { columns, key: owner, access });
  const asBob = open(accessFile, { key: bob });
  assert.deepEqual(await collect(asBob.rowsAsync()), [...asBob.rows()]);
  assert.deepEqual(await collect(asBob.findAsync({ amount: { gt: 100 } })), [...asBob.find({ amount: { gt: 100 } })]);
  asBob.close();

  const inMemory = open(write(null, rows, { columns, chunkRows: 500 }));
  assert.deepEqual(await collect(inMemory.findAsync({ account: 'ACC007' })), [...inMemory.find({ account: 'ACC007' })]);
});

test('openAsync opens files like open, and reports errors', async () => {
  const key = JazminKey.generate();
  const file = tmp('e.jzm');
  write(file, rows, { columns, key, metadata: { title: 'Async' } });
  const r = await openAsync(file, { key });
  assert.deepEqual(r.metadata, { title: 'Async' });
  assert.deepEqual(await collect(r.findAsync({ account: 'ACC010' })), [...open(file, { key }).find({ account: 'ACC010' })]);
  r.close();
  await assert.rejects(openAsync(file), /encrypted/);
  await assert.rejects(openAsync(path.join(path.dirname(file), 'missing.jzm')), { code: 'ENOENT' });
  const notJazmin = tmp('x.jzm');
  fs.writeFileSync(notJazmin, 'x'.repeat(200));
  await assert.rejects(openAsync(notJazmin), /Not a JAZMIN file/);
  fs.rmSync(notJazmin); // the file is closed again: it can be deleted (Windows refuses open files)
  assert.equal((await openAsync(write(null, rows, { columns }))).rowCount, rows.length);
});

test('writeAsync and writeRowsAsync take async iterables and match write()', async () => {
  async function* cursor() {
    for (const row of rows) {
      if (row.id % 500 === 0) await new Promise((resolve) => setImmediate(resolve)); // a slow source
      yield row;
    }
  }
  const options = { columns, sortedBy: ['id'], chunkRows: 100, maxDegreeOfParallelism: 2 };
  const fromAsync = await writeAsync(null, cursor(), options);
  assert.deepEqual([...open(fromAsync).rows()], [...open(write(null, rows, options)).rows()]);
  await assert.rejects(writeAsync(null, cursor(), {}), JazminValidationError);
  assert.equal(open(await writeAsync(null, rows.slice(0, 10))).rowCount, 10); // sync iterables: schema inferred

  const file = tmp('w.jzm');
  const writer = new JazminWriter(file, options);
  let turns = 0;
  let spinning = true;
  const spin = () => {
    turns++;
    if (spinning) setImmediate(spin);
  };
  setImmediate(spin);
  await writer.writeRowsAsync(rows); // a plain array: still yields between chunks
  await writer.finishAsync();
  spinning = false;
  assert.ok(turns >= 10, `the event loop ran while writing (${turns})`);
  assert.equal(open(file).rowCount, rows.length);
});
