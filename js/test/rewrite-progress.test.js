import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compact, open, update, write } from '../src/index.js';

// Progress and stopping for rewrites (issue #184, part 3): write(), update() and compact() report
// { stage, done, total }: 'sort' (rows put into a new sort order, when the order changes), 'write' (rows written into
// the new file, after each chunk) and 'indexes' (indexes built at the end). A signal stops them at the next report;
// a stopped write leaves no file, and a stopped update or compact leaves the file as it was.

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-rewrite-progress-'));
const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'name', type: 'string', nullable: false, index: 'sorted' },
  { name: 'amount', type: 'float' },
];
const ROWS = 2000;
const rows = () => Array.from({ length: ROWS }, (_, id) => ({ id, name: `n${(id * 7919) % ROWS}`, amount: (id * 37) % 1000 }));
const stopped = (error) => error.name === 'AbortError';

/** Reports by stage, checked as they come: within a stage, done grows and total stays. */
function recorder(also) {
  const calls = [];
  const onProgress = (p) => {
    assert.deepEqual(Object.keys(p).sort(), ['done', 'stage', 'total']);
    assert.ok(['sort', 'write', 'indexes'].includes(p.stage), p.stage);
    const last = calls.findLast((c) => c.stage === p.stage);
    if (last) {
      assert.equal(p.total, last.total);
      assert.ok(p.done > last.done, `${p.stage}: ${p.done} after ${last.done}`);
    }
    calls.push({ ...p });
    also?.(p);
  };
  const stage = (name) => calls.filter((c) => c.stage === name);
  return { calls, onProgress, stage };
}

test('write() reports each chunk written, then each index', () => {
  const file = path.join(tmpDir(), 'w.jzm');
  const { onProgress, stage, calls } = recorder();
  write(file, rows(), { columns, chunkRows: 50, sortedBy: ['id'], onProgress });
  const written = stage('write');
  assert.equal(written.length, ROWS / 50);
  assert.deepEqual(written.at(-1), { stage: 'write', done: ROWS, total: ROWS });
  assert.deepEqual(stage('indexes').at(-1), { stage: 'indexes', done: 1, total: 1 });
  assert.ok(calls.indexOf(stage('indexes')[0]) > calls.indexOf(written.at(-1)), 'indexes come after the rows');
  // Rows from a generator: the total isn't known.
  const unknown = recorder();
  write(path.join(tmpDir(), 'g.jzm'), (function* gen() { yield* rows(); })(), { columns, chunkRows: 500, onProgress: unknown.onProgress });
  assert.deepEqual(unknown.stage('write').at(-1), { stage: 'write', done: ROWS, total: null });
});

test('update() that changes the sort order reports sorting, writing and indexes; the file is right', () => {
  const file = path.join(tmpDir(), 'u.jzm');
  write(file, rows(), { columns, chunkRows: 50, sortedBy: ['id'] });
  const { onProgress, stage } = recorder();
  update(file, { sortedBy: ['amount'], indexes: { id: ['sorted'] }, sortRunRows: 300, onProgress });
  assert.ok(stage('sort').length >= ROWS / 300, `${stage('sort').length} sort reports`);
  assert.deepEqual(stage('sort').at(-1), { stage: 'sort', done: ROWS, total: ROWS });
  assert.deepEqual(stage('write').at(-1), { stage: 'write', done: ROWS, total: ROWS });
  assert.deepEqual(stage('indexes').at(-1), { stage: 'indexes', done: 2, total: 2 });
  const reader = open(file);
  try {
    assert.deepEqual(reader.sortedBy, ['amount']);
    assert.equal(reader.rowCount, ROWS);
    assert.equal(reader.count({ name: 'n7' }), 1);
  } finally {
    reader.close();
  }
});

test('compact() reports writing; no sort stage when the order stays', () => {
  const file = path.join(tmpDir(), 'c.jzm');
  write(file, rows(), { columns, chunkRows: 50, sortedBy: ['id'] });
  const { onProgress, stage } = recorder();
  compact(file, { onProgress });
  assert.equal(stage('sort').length, 0);
  assert.deepEqual(stage('write').at(-1), { stage: 'write', done: ROWS, total: ROWS });
});

test('a signal stops a rewrite: update and compact leave the file as it was, write leaves no file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 's.jzm');
  write(file, rows(), { columns, chunkRows: 50, sortedBy: ['id'] });
  const before = fs.readFileSync(file);
  const sortDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('jazmin-sort-')).length;
  const sortDirsBefore = sortDirs();
  for (const [label, stopWhen, run] of [
    ['update, while sorting', (p) => p.stage === 'sort', (o) => update(file, { sortedBy: ['amount'], sortRunRows: 300, ...o })],
    ['update, while writing', (p) => p.stage === 'write', (o) => update(file, { sortedBy: ['amount'], sortRunRows: 300, ...o })],
    ['update, while indexing', (p) => p.stage === 'indexes', (o) => update(file, { indexes: { amount: ['sorted'] }, ...o })],
    // After the last report the new file is complete; a stop still keeps it from replacing the old one.
    ['update, after the last report', (p) => p.stage === 'indexes' && p.done === p.total, (o) => update(file, { indexes: { amount: ['sorted'] }, ...o })],
    ['compact', (p) => p.stage === 'write', (o) => compact(file, o)],
  ]) {
    const controller = new AbortController();
    const { onProgress } = recorder((p) => { if (stopWhen(p)) controller.abort(); });
    assert.throws(() => run({ onProgress, signal: controller.signal }), stopped, label);
    assert.ok(fs.readFileSync(file).equals(before), `${label}: the file is unchanged`);
    assert.deepEqual(fs.readdirSync(dir), ['s.jzm'], `${label}: no temporary file is left`);
  }
  assert.equal(sortDirs(), sortDirsBefore, 'no sort runs are left');
  // write: stopped part-way, the file it was writing is gone.
  const controller = new AbortController();
  const target = path.join(dir, 'new.jzm');
  const { onProgress } = recorder((p) => { if (p.done >= 500) controller.abort(); });
  assert.throws(() => write(target, rows(), { columns, chunkRows: 50, onProgress, signal: controller.signal }), stopped);
  assert.equal(fs.existsSync(target), false);
  // Aborted before the call: nothing is read or written.
  assert.throws(() => update(file, { sortedBy: ['amount'], signal: AbortSignal.abort() }), stopped);
  assert.throws(() => write(target, rows(), { columns, signal: AbortSignal.abort() }), stopped);
  assert.ok(fs.readFileSync(file).equals(before));
  assert.equal(fs.existsSync(target), false);
});
