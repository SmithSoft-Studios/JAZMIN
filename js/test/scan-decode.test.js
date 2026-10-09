// Filtered scans decode the filter's columns first, and the other columns only for chunks with matching rows (text,
// decimals, json and binary made only for those rows). The rows returned must be exactly those that filtering every
// row in memory gives, for every column type, with nulls, index candidates and deleted rows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { append, open, write } from '../src/index.js';
import { compileFilter } from '../src/filter.js';

const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'name', type: 'string', index: 'sorted' }, // repeats: written as a dictionary
  { name: 'note', type: 'string' }, // all different: written plain
  { name: 'amount', type: 'decimal' },
  { name: 'doc', type: 'json' },
  { name: 'blob', type: 'binary' },
  { name: 'score', type: 'float' },
  { name: 'flag', type: 'bool' },
  { name: 'at', type: 'datetime' },
];
const rows = Array.from({ length: 300 }, (_, i) => ({
  id: i,
  name: i % 7 === 0 ? null : `name ${i % 13}`,
  note: i % 5 === 0 ? null : `note ${i} ${'x'.repeat(i % 9)}`,
  amount: i % 6 === 0 ? null : `${i}.${String(i % 100).padStart(2, '0')}`,
  doc: i % 4 === 0 ? null : { i, tags: [i % 3] },
  blob: i % 8 === 0 ? null : Buffer.from([i & 255, 7]),
  score: i % 9 === 0 ? null : i / 3,
  flag: i % 2 === 0,
  at: i % 10 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
}));
const file = write(null, rows, { columns, chunkRows: 32 });

const filters = [
  { id: { in: [3, 50, 299, 1000] } },
  { name: 'name 4' }, // index candidates
  { amount: { gt: '100' } },
  { at: { in: [new Date(Date.UTC(2026, 0, 1) + 7 * 3_600_000), new Date(Date.UTC(2026, 0, 1) + 211 * 3_600_000)] } },
  { or: [{ score: { lt: 5 } }, { doc: { isNull: true } }] },
  { not: { flag: true } },
  { note: { contains: 'xxxxxxx' } },
  { and: [{ id: { gte: 40, lt: 200 } }, { id: { ne: 77 } }, { blob: { isNull: false } }] },
];

test('a filtered scan returns what filtering every row in memory gives, for every column type', () => {
  const reader = open(file);
  const all = [...reader.find(null)];
  for (const filter of filters) {
    const expected = all.filter(compileFilter(filter, reader.columns));
    assert.deepEqual([...reader.find(filter)], expected, JSON.stringify(filter));
    const select = ['note', 'amount', 'doc', 'blob'];
    assert.deepEqual([...reader.find(filter, { select })], expected.map((r) => Object.fromEntries(select.map((c) => [c, r[c]]))), JSON.stringify(filter));
    assert.deepEqual([...reader.find(filter, { offset: 2, limit: 3 })], expected.slice(2, 5), JSON.stringify(filter));
  }
  reader.close();
});

test('rows deleted by an append are left out of a filtered scan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-scan-'));
  const changed = path.join(dir, 'rows.jzm');
  write(changed, rows, { columns, chunkRows: 32, sortedBy: ['id'] });
  append(changed, { upsert: [{ ...rows[299], note: 'changed' }], keyColumns: ['id'], delete: { id: 50 } });
  const reader = open(changed);
  const all = [...reader.find(null)];
  assert.equal(all.length, 299);
  assert.equal(all.at(-1).note, 'changed');
  for (const filter of filters) assert.deepEqual([...reader.find(filter)], all.filter(compileFilter(filter, reader.columns)), JSON.stringify(filter));
  reader.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a chunk without matching rows decodes only the filter\'s columns', () => {
  const reader = open(file);
  const cost = reader.explain({ note: { contains: 'note 33 ' } }, { analyze: true }); // one row, in chunk 1 of 10
  assert.equal(cost.rows, 1);
  assert.equal(cost.chunksRead, 10);
  assert.equal(cost.columnsDecoded, 10 + 8); // the note column of every chunk, and the other 8 of the one that matches
  reader.close();
});

test('column arrays of a filtered scan hold what the rows hold, when few rows of a chunk match or many do', () => {
  const reader = open(file);
  const all = [...reader.find(null)];
  const select = ['id', 'note', 'amount', 'score', 'flag', 'at'];
  for (const filter of filters) {
    // The same rows in a file of their own, read whole: the arrays a filtered scan must give.
    const expected = all.filter(compileFilter(filter, reader.columns)).slice(1, 9);
    const own = open(write(null, expected, { columns }));
    const want = own.columnArrays(null, { select });
    own.close();
    const got = reader.columnArrays(filter, { select, offset: 1, limit: 8 });
    assert.deepEqual(got, want, JSON.stringify(filter));
  }
  reader.close();
});
