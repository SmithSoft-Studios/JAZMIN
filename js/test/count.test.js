import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, append, open, write } from '../src/index.js';

// count() without reading what it doesn't need (issue #16): chunks whose statistics prove every row matches are
// counted by their row counts, without being read, and in the others only the filter's columns are decoded.
// Every count must equal the number of rows find() returns.

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-count-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'section', type: 'string', nullable: false },
  { name: 'score', type: 'float' },
  { name: 'note', type: 'string' },
];
const row = (id) => ({ id, section: `S${Math.floor(id / 100)}`, score: id % 7 === 0 ? NaN : id / 10, note: id % 5 ? `note ${id}` : null });
const FILTERS = [
  { id: { gte: 300 } },
  { id: { gte: 64, lt: 640 } },
  { section: 'S5' },
  { section: { in: ['S3', 'S4'] }, id: { lt: 450 } },
  { score: { gt: 20 } },
  { note: null },
  { not: { section: 'S1' } },
  { or: [{ section: 'S2' }, { id: { gte: 900 } }] },
  { id: 12345 },
  {},
];

/** Bytes read from files while `fn` runs, and its result. */
function measured(fn) {
  let bytes = 0;
  const readSync = fs.readSync;
  fs.readSync = (...args) => {
    const n = readSync.apply(fs, args);
    bytes += n;
    return n;
  };
  try {
    return { result: fn(), bytes };
  } finally {
    fs.readSync = readSync;
  }
}

function assertCountsMatch(reader, label) {
  for (const filter of FILTERS) assert.equal(reader.count(filter), [...reader.find(filter)].length, `${label}: ${JSON.stringify(filter)}`);
}

test('count equals the rows find returns, with appended and deleted rows', () => {
  const file = tmp('appended.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => row(i)), { columns, sortedBy: ['id'], chunkRows: 64 });
  append(file, { insert: Array.from({ length: 100 }, (_, i) => row(1000 + i)), delete: { id: { lt: 30 } } });
  append(file, { delete: { id: { in: [500, 501, 777, 1050] } } });
  const reader = open(file);
  try {
    assertCountsMatch(reader, 'appended');
    assert.equal(reader.count({ id: { gte: 0 } }), reader.rowCount);
  } finally {
    reader.close();
  }
});

test('count equals the rows find returns in access-controlled files, for the owner and an access key', () => {
  const key = JazminKey.generate();
  const bob = key.createAccessKey();
  const file = tmp('access.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => row(i)), {
    columns, key, chunkRows: 32, access: { partitionBy: 'section', grants: [{ key: bob, rows: ['S2', 'S5'], columns: '*' }] },
  });
  for (const [label, reader] of [['owner', open(file, { key })], ['access key', open(file, { key: bob })]]) {
    try {
      assertCountsMatch(reader, label);
      assert.equal(reader.count({ section: 'S5' }), 100, label);
    } finally {
      reader.close();
    }
  }
});

test('chunks every row of which matches are counted without reading them', () => {
  const file = tmp('plain.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => row(i)), { columns, sortedBy: ['id'], chunkRows: 64 });
  const reader = open(file);
  try {
    reader.count({ id: { gte: 0 } }); // loads the id statistics
    // Rows 64-639 are chunks 1-9 exactly.
    const whole = measured(() => reader.count({ id: { gte: 64, lt: 640 } }));
    assert.deepEqual([whole.result, whole.bytes], [576, 0]);
  } finally {
    reader.close();
  }
  // With partly matching chunks at both ends, only those two are read: less than find() reads.
  const filter = { id: { gte: 60, lt: 645 } };
  const counted = measured(() => {
    const r = open(file);
    try { return r.count(filter); } finally { r.close(); }
  });
  const found = measured(() => {
    const r = open(file);
    try { return [...r.find(filter)].length; } finally { r.close(); }
  });
  assert.equal(counted.result, found.result);
  assert.ok(counted.bytes < found.bytes / 3, `count read ${counted.bytes} bytes, find ${found.bytes}`);
});

test('a filter sorted indexes answer exactly is counted from the index alone', () => {
  const indexed = columns.map((c) => (c.name === 'section' || c.name === 'score' || c.name === 'note' ? { ...c, index: 'sorted' } : c));
  const file = tmp('indexed.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => row(i)), { columns: indexed, sortedBy: ['id'], chunkRows: 64 });
  append(file, { insert: Array.from({ length: 100 }, (_, i) => row(1000 + i)), delete: { section: 'S5', id: { lt: 520 } } });
  const reader = open(file);
  try {
    assertCountsMatch(reader, 'indexed');
    for (const filter of [
      { section: 'S5' }, { section: { in: ['S3', 'S10', null] } }, { section: { gte: 'S3', lt: 'S6' } }, { section: { startsWith: 'S1' } },
      { section: { ne: 'S2' } }, { note: null }, { note: { isNull: false } }, { score: 0 }, { score: { gte: 10, lt: 20 } }, { score: { gt: NaN } },
      { section: 'S5', score: { gt: 55 } },
    ]) assert.equal(reader.count(filter), [...reader.find(filter)].length, JSON.stringify(filter));
  } finally {
    reader.close();
  }
  // Index pages only: far less than the chunks find() reads.
  const filter = { section: { in: ['S2', 'S7'] } };
  const counted = measured(() => {
    const r = open(file);
    try { return r.count(filter); } finally { r.close(); }
  });
  const found = measured(() => {
    const r = open(file);
    try { return [...r.find(filter)].length; } finally { r.close(); }
  });
  assert.equal(counted.result, 200);
  assert.equal(counted.result, found.result);
  assert.ok(counted.bytes < found.bytes / 2, `count read ${counted.bytes} bytes, find ${found.bytes}`);
});
