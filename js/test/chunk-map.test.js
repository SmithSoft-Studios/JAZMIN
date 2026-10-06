import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, append, compact, open, write } from '../src/index.js';
import { CHUNK_MAP } from '../src/writer.js';

// The owner's chunk map (spec 7.6.5): in a shared file, an owner's index lookup reads only the chunk directories of the
// partitions holding its rows, not every partition's. Files without a map (written before it) read as before.
// Mirrors ChunkMapTests in the .NET tests.

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-chunkmap-')), name);
const PEOPLE = 40;
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'person', type: 'string', nullable: false },
  { name: 'code', type: 'string', index: 'sorted' },
  { name: 'amount', type: 'float' },
];
const person = (p) => `P${String(p).padStart(2, '0')}`;
const row = (i, p = Math.floor(i / 100) % PEOPLE) => ({ id: i, person: person(p), code: `C${i % 500}`, amount: i / 4 });
const owner = JazminKey.generate();
const access = { partitionBy: 'person', grants: [{ key: owner.createAccessKey(), rows: [person(0)] }] };
const byId = (a, b) => a.id - b.id;

/** A shared file of 40 people, then appends: rows for existing and new people, deletes and upserts. */
function sharedFile(options = {}) {
  const file = tmp('shared.jzm');
  write(file, Array.from({ length: 4000 }, (_, i) => row(i)), { columns, key: owner, access, chunkRows: 64, ...options });
  append(file, { key: owner, insert: Array.from({ length: 300 }, (_, i) => row(4000 + i, i % 3)) });
  append(file, { key: owner, delete: { code: 'C7' }, upsert: [{ ...row(15), amount: -1 }, row(9000, 99)], keyColumns: ['id'] });
  return file;
}

/** What the reader finds when every partition is loaded first (the way without a map). */
function expected(file, filter) {
  const reader = open(file, { key: owner });
  try {
    reader.count(); // loads every partition
    return [...reader.find(filter)].sort(byId);
  } finally {
    reader.close();
  }
}

const FILTERS = [
  { id: 17 }, { id: { in: [3, 3999, 4150, 9000, 15, 7, 123456] } }, { code: 'C42' }, { code: { in: ['C1', 'C499'] } },
  { code: 'C42', amount: { gt: 10 } }, { id: { gte: 4290, lt: 4310 } },
];

test('chunk map: owner lookups find the same rows as reading every partition, with the map and without', () => {
  for (const [name, options] of [['with the map', {}], ['without (an older file)', { [CHUNK_MAP]: false }]]) {
    const file = sharedFile(options);
    for (const filter of FILTERS) {
      const want = expected(file, filter);
      const reader = open(file, { key: owner });
      try {
        assert.deepEqual([...reader.find(filter)].sort(byId), want, `${name} ${JSON.stringify(filter)}`);
      } finally {
        reader.close();
      }
      const counting = open(file, { key: owner });
      try {
        assert.equal(counting.count(filter), want.length, `${name} count ${JSON.stringify(filter)}`);
      } finally {
        counting.close();
      }
    }
    // get(rowId): every row id, each on a fresh reader for some, so each loads its own partition.
    const all = open(file, { key: owner });
    const rows = [...all.rows()];
    all.close();
    for (const rowId of [0, 1, 63, 64, 3999, 4000, 4299, 4300]) {
      const reader = open(file, { key: owner });
      try {
        const physical = reader.get(rowId);
        assert.ok(rows.some((r) => r.id === physical.id), `${name} get(${rowId})`);
      } catch (error) {
        assert.match(error.message, /deleted/, `${name} get(${rowId})`); // the old version of an upserted row
      } finally {
        reader.close();
      }
    }
  }
});

test('chunk map: an id lookup reads one partition\'s directory, not all forty', () => {
  const bytes = (file) => {
    const reader = open(file, { key: owner });
    try {
      return reader.explain({ id: 1717 }, { analyze: true }).bytesRead;
    } finally {
      reader.close();
    }
  };
  const withMap = bytes(sharedFile());
  const without = bytes(sharedFile({ [CHUNK_MAP]: false }));
  assert.ok(withMap < without * 0.6, `with the map ${withMap} bytes, without ${without}`);
});

test('chunk map: compaction writes one, and later appends extend it', () => {
  const file = sharedFile({ [CHUNK_MAP]: false });
  const bytes = () => {
    const reader = open(file, { key: owner });
    try {
      return reader.explain({ id: 1717 }, { analyze: true }).bytesRead;
    } finally {
      reader.close();
    }
  };
  const before = bytes();
  compact(file, { key: owner, regroup: true });
  append(file, { key: owner, insert: [row(5000, 5), row(5001, 120)] });
  assert.ok(bytes() < before * 0.6, 'compaction wrote a map, and the append kept it');
  for (const filter of [...FILTERS, { id: { in: [5000, 5001] } }]) {
    const reader = open(file, { key: owner });
    try {
      assert.deepEqual([...reader.find(filter)].sort(byId), expected(file, filter), JSON.stringify(filter));
    } finally {
      reader.close();
    }
  }
});

test('chunk map: each table of a file with several has its own', () => {
  const file = tmp('tables.jzm');
  const other = [{ name: 'ref', type: 'int', nullable: false, index: 'sorted' }, { name: 'person', type: 'string', nullable: false }];
  write(file, {
    first: Array.from({ length: 2000 }, (_, i) => row(i)),
    second: Array.from({ length: 1000 }, (_, i) => ({ ref: i, person: person(Math.floor(i / 50)) })),
  }, {
    key: owner,
    access: { grants: [{ key: owner.createAccessKey(), rows: [person(0)] }] },
    tables: [{ name: 'first', columns, partitionBy: 'person' }, { name: 'second', columns: other, partitionBy: 'person' }],
    chunkRows: 64,
  });
  append(file, { key: owner, table: 'second', insert: [{ ref: 5000, person: person(77) }] });
  const first = open(file, { key: owner });
  const second = first.openTable('second');
  try {
    assert.deepEqual([...first.find({ id: 1234 })].map((r) => r.person), [person(12)]);
    assert.deepEqual([...second.find({ ref: { in: [999, 5000] } })].map((r) => r.person).sort(), [person(19), person(77)]);
  } finally {
    second.close();
    first.close();
  }
});

test('chunk map: an append to a sorted shared file checks the order against the last row, with the map and without', () => {
  for (const options of [{}, { [CHUNK_MAP]: false }]) {
    const file = tmp('sorted.jzm');
    write(file, Array.from({ length: 1000 }, (_, i) => row(i)), { columns, key: owner, access, chunkRows: 64, sortedBy: ['id'], ...options });
    append(file, { key: owner, insert: [row(1000, 3), row(1001, 5)] }); // after the last row: in order
    assert.throws(() => append(file, { key: owner, insert: [row(500, 1)] }), /must sort after the existing rows/);
    const reader = open(file, { key: owner });
    try {
      assert.equal(reader.rowCount, 1002);
    } finally {
      reader.close();
    }
  }
});
