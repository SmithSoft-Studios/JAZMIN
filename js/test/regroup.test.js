import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, append, compact, open, write } from '../src/index.js';

// compact({ regroup: true }) (issue #17): appends from many people leave one chunk per append; regrouping writes each
// partition's rows together, in their file order, so each partition spans as few chunks as its rows need.

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-regroup-')), name);
const owner = JazminKey.generate();
const bob = owner.createAccessKey();
const people = ['P1', 'P2', 'P3', 'P4', 'P5'];
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'person', type: 'string', nullable: false },
  { name: 'value', type: 'float' },
];
const syncRows = (round, person) => Array.from({ length: 3 }, (_, k) => ({ id: round * 100 + people.indexOf(person) * 10 + k, person, value: round + k / 10 }));

/** 10 rounds of syncs from 5 people, one append each, and a delete: 50 chunks. */
function appendedFile(options = {}) {
  const file = tmp('synced.jzm');
  write(file, syncRows(0, 'P1'), { columns, key: owner, access: { partitionBy: 'person', grants: [{ key: bob, rows: ['P2', 'P4'], columns: '*' }] }, ...options });
  for (let round = 0; round < 10; round++) {
    for (const person of people) if (round || person !== 'P1') append(file, { key: owner, insert: syncRows(round, person) });
  }
  append(file, { key: owner, delete: { id: { in: [101, 523] } } });
  return file;
}

const ids = (rows) => rows.map((r) => r.id);

test('regrouping puts each partition in as few chunks as its rows need, in file order', () => {
  const file = appendedFile();
  const before = open(file, { key: owner });
  const byPerson = Object.fromEntries(people.map((p) => [p, ids([...before.find({ person: p })])]));
  const all = ids([...before.rows()]).sort((a, b) => a - b);
  assert.equal(before.chunkCount, 50);
  before.close();

  compact(file, { key: owner });
  const compacted = open(file, { key: owner });
  assert.equal(compacted.chunkCount, 50); // compacting alone keeps one chunk per append
  compacted.close();

  compact(file, { key: owner, regroup: true });
  const after = open(file, { key: owner });
  try {
    assert.equal(after.chunkCount, people.length);
    for (const p of people) assert.deepEqual(ids([...after.find({ person: p })]), byPerson[p], p);
    assert.deepEqual(ids([...after.rows()]).sort((a, b) => a - b), all);
    assert.equal(after.count({ id: 101 }), 0); // deleted rows stay deleted
  } finally {
    after.close();
  }
  const asBob = open(file, { key: bob });
  try {
    assert.deepEqual(ids([...asBob.rows()]).sort((a, b) => a - b), [...byPerson.P2, ...byPerson.P4].sort((a, b) => a - b));
  } finally {
    asBob.close();
  }
});

test('a partition with more rows than chunkRows spans ceil(rows / chunkRows) chunks', () => {
  const file = appendedFile();
  compact(file, { key: owner, regroup: true, chunkRows: 8 });
  const reader = open(file, { key: owner });
  try {
    const rows = people.map((p) => reader.count({ person: p })); // 30 each, less the deleted ones
    assert.equal(reader.chunkCount, rows.reduce((n, r) => n + Math.ceil(r / 8), 0));
  } finally {
    reader.close();
  }
});

test('regroup needs a partitioned file whose sort order allows it', () => {
  const plain = tmp('plain.jzm');
  write(plain, [{ id: 1, person: 'P1', value: 1 }], { columns });
  assert.throws(() => compact(plain, { regroup: true }), /regroup applies to access-controlled files with partitionBy/);
  const byTime = tmp('by-id.jzm');
  write(byTime, [{ id: 1, person: 'P1', value: 1 }], { columns, sortedBy: ['id'], key: owner, access: { partitionBy: 'person' } });
  assert.throws(() => compact(byTime, { key: owner, regroup: true }), /sortedBy/);
  // Sorted by the partition column first: already grouped, and allowed.
  const byPerson = tmp('by-person.jzm');
  write(byPerson, [{ id: 2, person: 'P1', value: 1 }, { id: 1, person: 'P2', value: 1 }], { columns, sortedBy: ['person', 'id'], key: owner, access: { partitionBy: 'person' } });
  compact(byPerson, { key: owner, regroup: true });
  const reader = open(byPerson, { key: owner });
  assert.deepEqual(ids([...reader.rows()]), [2, 1]);
  reader.close();
});

test('advise() suggests regrouping spread-out partitions, and no longer after it', () => {
  const file = appendedFile();
  const before = open(file, { key: owner });
  const advice = before.advise();
  before.close();
  assert.ok(advice.suggestions.some((s) => s.startsWith('5 of 5 partitions are spread through the file') && s.endsWith("compact({ regroup: true }) puts each partition's rows together.")), advice.suggestions.join('\n'));
  compact(file, { key: owner, regroup: true });
  const after = open(file, { key: owner });
  assert.deepEqual(after.advise().suggestions, []);
  after.close();
});
