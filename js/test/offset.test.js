import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, append, open, write } from '../src/index.js';

// Paging with offset (issue #8): chunks whose every row matches and lies before the offset are counted, not read.
// Every page must equal the same slice of the full result.

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-offset-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'section', type: 'string', nullable: false },
  { name: 'score', type: 'float' },
];
const row = (id) => ({ id, section: `S${Math.floor(id / 100)}`, score: id % 7 === 0 ? NaN : id / 10 });
const CHUNK = 64;
const OFFSETS = [0, 1, 29, 33, 34, 63, 64, 65, 100, 128, 500, 543, 960, 1000, 1030, 1060, 1065, 5000];

/** 1,000 rows sorted by id in chunks of 64, then 100 appended, and some deleted by appends (also in the middle). */
function appendedFile() {
  const file = tmp('appended.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => row(i)), { columns, sortedBy: ['id'], chunkRows: CHUNK });
  append(file, { insert: Array.from({ length: 100 }, (_, i) => row(1000 + i)), delete: { id: { lt: 30 } } });
  append(file, { delete: { id: { in: [500, 501, 777, 1050] } } });
  return file;
}

function assertPagesMatch(reader, filter, label) {
  const all = [...reader.find(filter)];
  for (const offset of OFFSETS) {
    assert.deepEqual([...reader.find(filter, { offset, limit: 9 })], all.slice(offset, offset + 9), `${label}, offset ${offset}`);
  }
}

test('pages equal slices of the full result, with appended and deleted rows', () => {
  const reader = open(appendedFile());
  try {
    for (const [filter, label] of [
      [null, 'no filter'],
      [{ id: { gte: 300 } }, 'leading sort range'],
      [{ section: 'S5' }, 'statistics prove whole chunks'],
      [{ score: { gt: 20 } }, 'float column (never whole: NaN is not in statistics)'],
      [{ not: { section: 'S1' } }, 'not'],
      [{ or: [{ section: 'S2' }, { id: { gte: 900 } }] }, 'or'],
      [{ section: { in: ['S3', 'S4'] }, id: { lt: 450 } }, 'in and range'],
    ]) assertPagesMatch(reader, filter, label);
    assert.deepEqual([...reader.rows({ offset: 1, limit: 3, select: ['id'] })], [{ id: 31 }, { id: 32 }, { id: 33 }]);
  } finally {
    reader.close();
  }
});

test('a deep page and the last rows read only the chunks they return', () => {
  const file = tmp('plain.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => row(i)), { columns, sortedBy: ['id'], chunkRows: CHUNK });
  const reader = open(file);
  try {
    // Rows 600-604 lie in one chunk (576-639); 990-999 in the last one.
    assert.equal(reader.explain(null, { analyze: true, offset: 600, limit: 5 }).chunksRead, 1);
    assert.equal(reader.explain(null, { analyze: true, offset: 990, limit: 50 }).chunksRead, 1);
    // A filter whose statistics prove whole chunks skips them too. S5 is rows 500-599: chunk 7 (448-511) also holds
    // S4 rows, so it is read to count its 12 S5 rows; chunk 8 (512-575) is all S5 and is skipped; the page (rows
    // 580-584) is in chunk 9.
    const page = reader.explain({ section: 'S5' }, { analyze: true, offset: 80, limit: 5 });
    assert.deepEqual([page.rows, page.chunksRead], [5, 2]);
    assert.deepEqual([...reader.find({ section: 'S5' }, { offset: 80, limit: 5, select: ['id'] })].map((r) => r.id), [580, 581, 582, 583, 584]);
    // A page ending on a chunk boundary does not read the next chunk.
    assert.equal(reader.explain(null, { analyze: true, offset: 0, limit: 64 }).chunksRead, 1);
  } finally {
    reader.close();
  }
});

test('access-controlled files skip whole chunks of a pinned partition', () => {
  const key = JazminKey.generate();
  const file = tmp('access.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => row(i)), { columns, key, chunkRows: 32, access: { partitionBy: 'section' } });
  const reader = open(file, { key });
  try {
    const all = [...reader.find({ section: 'S5' })];
    assert.equal(all.length, 100);
    const page = reader.explain({ section: 'S5' }, { analyze: true, offset: 40, limit: 10 });
    assert.deepEqual([page.rows, page.chunksRead], [10, 1]); // S5's chunks hold 32, 32, 32 and 4 rows
    assert.deepEqual([...reader.find({ section: 'S5' }, { offset: 40, limit: 10 })], all.slice(40, 50));
    // `in` names several partitions holding different values: correct, but not skipped by partition.
    const both = [...reader.find({ section: { in: ['S5', 'S6'] } })];
    assert.deepEqual([...reader.find({ section: { in: ['S5', 'S6'] } }, { offset: 120, limit: 10 })], both.slice(120, 130));
    assertPagesMatch(reader, { section: 'S7', id: { gte: 720 } }, 'pinned partition and a range');
  } finally {
    reader.close();
  }
});
