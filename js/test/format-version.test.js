// Format 1.0 (docs/rfc/draft-jazmin-format-03.md): decimals, partitions, empty files, hidden column names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, append, open, write } from '../src/index.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-format-')), name);
const money = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'amount', type: 'decimal', index: 'sorted' },
];

test('decimals are ordered by value in filters, statistics and indexes', () => {
  // Text order would put "10.5" before "9"; value order puts it after. 12.5 and 12.50 are the same value.
  const amounts = ['9', '10.5', '-2', '12.50', '100', '0.001', '-0.5'];
  const rows = amounts.map((amount, id) => ({ id, amount }));
  const r = open(write(null, rows, { columns: money, chunkRows: 2 }));
  const found = (filter) => [...r.find(filter)].map((x) => x.amount);
  assert.deepEqual(found({ amount: { gt: '9.99' } }), ['10.5', '12.50', '100']);
  assert.deepEqual(found({ amount: '12.5' }), ['12.50']);
  assert.deepEqual(found({ amount: { lt: 0 } }), ['-2', '-0.5']);
  assert.equal(r.explain({ amount: '12.5' }).strategy, 'index');

  // Without the index, chunk statistics (min/max by value) still skip chunks.
  const scan = open(write(null, rows, { columns: [money[0], { name: 'amount', type: 'decimal' }], chunkRows: 2 }));
  assert.deepEqual(scan.explain({ amount: { gte: '100' } }), { strategy: 'scan', chunks: 4, chunksSkipped: 3 });
  assert.deepEqual([...scan.find({ amount: { gte: '100' } })].map((x) => x.amount), ['100']);
});

test('an empty file keeps its indexes for later appends', () => {
  const file = tmp('empty.jzm');
  write(file, [], { columns: money });
  append(file, { insert: Array.from({ length: 50 }, (_, id) => ({ id, amount: `${id}.25` })) });
  const r = open(file);
  assert.deepEqual(r.indexes, [{ column: 'amount', kind: 'sorted' }]);
  assert.deepEqual(r.explain({ amount: '7.25' }), { strategy: 'index', candidateRows: 1 });
  r.close();
});

test('many partitions use a partition table, appends write deltas, and the owner reads only what it needs', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const columns = [{ name: 'section', type: 'string', nullable: false }, { name: 'n', type: 'int' }];
  const rows = (from, to) => Array.from({ length: to - from }, (_, k) => ({ section: `S${String(Math.floor((from + k) / 3)).padStart(3, '0')}`, n: from + k }));
  const file = tmp('partitions.jzm');
  write(file, rows(0, 300), { columns, key: owner, access: { partitionBy: 'section', grants: [{ key: bob, rows: ['S007', 'S120'] }] } });
  append(file, { key: owner, insert: rows(300, 363) });
  append(file, { key: owner, insert: [{ section: 'S007', n: 1000 }] });

  let r = open(file, { key: owner });
  assert.equal(r.rowCount, 364);
  assert.deepEqual([...r.find({ section: 'S007' })].map((x) => x.n), [21, 22, 23, 1000]);
  assert.equal(r.access.visiblePartitions.length, 121);
  assert.equal([...r.rows()].length, 364);
  r.close();
  r = open(file, { key: bob, accessState: false });
  assert.deepEqual([...r.access.visiblePartitions].sort(), ['S007', 'S120']);
  assert.deepEqual([...r.rows()].map((x) => x.n), [21, 22, 23, 360, 361, 362, 1000]);
  r.close();
});

test('hidden column names are not readable with an access key', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const buf = write(null, [{ id: 1, salary: '100.00' }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'salary', type: 'decimal' }],
    key: owner,
    access: { columnGroups: { pii: ['salary'] }, grants: [{ key: bob, columns: ['*'] }] },
  });
  const r = open(buf, { key: bob, accessState: false });
  assert.deepEqual(r.columns.map((c) => c.name), ['id']);
  assert.throws(() => [...r.find({ salary: { gt: 0 } })], /unknown column 'salary'/);
  assert.equal(buf.includes('salary'), false);
});

test("an access key's scans skip chunks of its partitions using statistics", () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const rows = Array.from({ length: 400 }, (_, i) => ({ branch: i < 200 ? 'A' : 'B', n: i }));
  const buf = write(null, rows, {
    columns: [{ name: 'branch', type: 'string' }, { name: 'n', type: 'int' }],
    chunkRows: 20,
    key: owner,
    access: { partitionBy: 'branch', grants: [{ key: bob, rows: ['B'], columns: '*' }] },
  });
  const r = open(buf, { key: bob, accessState: false });
  assert.deepEqual(r.explain({ n: { gte: 390 } }), { strategy: 'scan', chunks: 10, chunksSkipped: 9 });
  assert.deepEqual([...r.find({ n: { gte: 390 } })].map((x) => x.n), [390, 391, 392, 393, 394, 395, 396, 397, 398, 399]);
});

test('key slots are in pages: each key reads the signed page list and its own page only', () => {
  const owner = JazminKey.generate();
  const keys = Array.from({ length: 300 }, () => owner.createAccessKey());
  const rows = Array.from({ length: 300 }, (_, i) => ({ branch: `B${i}`, n: i }));
  const buf = write(null, rows, {
    columns: [{ name: 'branch', type: 'string' }, { name: 'n', type: 'int' }],
    key: owner,
    access: { partitionBy: 'branch', grants: keys.map((key, i) => ({ key, rows: [`B${i}`], columns: '*' })) },
  });
  for (const i of [0, 17, 150, 299]) {
    const r = open(buf, { key: keys[i], accessState: false });
    assert.deepEqual([...r.rows()], [{ branch: `B${i}`, n: i }]);
    r.close();
  }
  assert.equal(open(buf, { key: owner }).rowCount, 300);
  assert.throws(() => open(buf, { key: JazminKey.generate().createAccessKey(), accessState: false }), /not signed by the owner/);

  // A changed byte in another key's page does not stop this key; a changed byte in its own page is detected.
  const trailer = buf.subarray(buf.length - 44);
  const listAt = Number(trailer.readBigUInt64LE(12)); // the key-slot list: stored uncompressed, after its 16-byte envelope
  const list = buf.subarray(listAt + 16, listAt + trailer.readUInt32LE(20));
  const pages = list.readUInt32LE(0);
  assert.ok(pages > 5, `${pages} pages`);
  const pageAt = Number(list.readBigUInt64LE(4 + 8)); // first page
  const tampered = Buffer.from(buf);
  tampered[pageAt + 40] ^= 1;
  let failures = 0;
  for (const key of keys) {
    try {
      open(tampered, { key, accessState: false }).close();
    } catch (error) {
      assert.match(error.message, /does not match the owner's signature/);
      failures++;
    }
  }
  assert.ok(failures > 0 && failures < keys.length, `${failures} keys refused`);
});
