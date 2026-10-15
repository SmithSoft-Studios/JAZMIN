import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, exportString, open, write } from '../src/index.js';

// Progress and stopping for long reads (issue #184): onProgress({ done, total, matches }) after each chunk read
// (chunks done and planned, matching rows so far), and an AbortSignal that stops the read before its next chunk,
// as the browser reader does. Without the options nothing changes.

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-progress-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'section', type: 'string', nullable: false, index: 'sorted' },
  { name: 'amount', type: 'float' },
];
const row = (id) => ({ id, section: `S${id % 10}`, amount: (id * 37) % 1000 });
const ROWS = 2000;

function plainFile() {
  const file = tmp('plain.jzm');
  write(file, Array.from({ length: ROWS }, (_, i) => row(i)), { columns, sortedBy: ['id'], chunkRows: 50 });
  return file;
}

/** Calls onProgress gets, checked as they come: done grows by whole chunks up to total, which never changes. */
function recorder() {
  const calls = [];
  const onProgress = (p) => {
    assert.deepEqual(Object.keys(p).sort(), ['done', 'matches', 'total']);
    const last = calls.at(-1);
    if (last) {
      assert.equal(p.total, last.total);
      assert.ok(p.done > last.done && p.matches >= last.matches);
    }
    assert.ok(p.done >= 1 && p.done <= p.total);
    calls.push({ ...p });
  };
  return { calls, onProgress };
}

const FILTERS = [
  ['a scan', { amount: { gt: 900 } }],
  ['an index', { section: 'S3' }],
  ['the sort order', { id: { gte: 1500 } }],
];

test('count and countAsync report each chunk, ending at the total with the count', async () => {
  const reader = open(plainFile());
  try {
    for (const [label, filter] of FILTERS) {
      const expected = reader.count(filter);
      for (const counter of [(o) => reader.count(filter, o), (o) => reader.countAsync(filter, o)]) {
        const { calls, onProgress } = recorder();
        assert.equal(await counter({ onProgress }), expected, label);
        if (calls.length === 0) continue; // answered without reading a chunk (an exact index count)
        assert.deepEqual(calls.at(-1), { done: calls[0].total, total: calls[0].total, matches: expected }, label);
      }
    }
    const { calls, onProgress } = recorder();
    reader.count({ amount: { gt: 900 } }, { onProgress });
    assert.equal(calls.length, ROWS / 50); // no statistics rule a chunk out: each is read and reported
  } finally {
    reader.close();
  }
});

test('find, findAsync, findBatchesAsync and columnArrays report each chunk, ending at the total with the rows', async () => {
  const reader = open(plainFile());
  try {
    for (const [label, filter] of FILTERS) {
      const expected = [...reader.find(filter)];
      const runs = [
        ['find', async (o) => [...reader.find(filter, o)]],
        ['findAsync', async (o) => { const rows = []; for await (const r of reader.findAsync(filter, o)) rows.push(r); return rows; }],
        ['findBatchesAsync', async (o) => { const rows = []; for await (const b of reader.findBatchesAsync(filter, o)) rows.push(...b); return rows; }],
        ['columnArrays', async (o) => Array.from({ length: reader.columnArrays(filter, o).rowCount })],
      ];
      for (const [name, run] of runs) {
        const { calls, onProgress } = recorder();
        const rows = await run({ onProgress });
        assert.equal(rows.length, expected.length, `${label}, ${name}`);
        if (name !== 'columnArrays') assert.deepEqual(rows, expected, `${label}, ${name}`);
        assert.ok(calls.length > 0, `${label}, ${name}`);
        assert.deepEqual(calls.at(-1), { done: calls[0].total, total: calls[0].total, matches: expected.length }, `${label}, ${name}`);
      }
    }
  } finally {
    reader.close();
  }
});

test('a limit ends the read early; the last report says how far it got', () => {
  const reader = open(plainFile());
  try {
    const { calls, onProgress } = recorder();
    assert.equal([...reader.find({ amount: { gte: 0 } }, { limit: 120, onProgress })].length, 120);
    assert.equal(calls.at(-1).matches, 120);
    assert.ok(calls.at(-1).done < calls.at(-1).total);
  } finally {
    reader.close();
  }
});

test('a signal stops a read before its next chunk; one stopped before it starts reads nothing', async () => {
  const reader = open(plainFile());
  try {
    const stopped = (error) => error.name === 'AbortError';
    // Stopped from onProgress (as another part of a program would, between chunks): no further chunk is read.
    for (const name of ['count', 'countAsync', 'find', 'findAsync', 'columnArrays']) {
      const controller = new AbortController();
      let reports = 0;
      const onProgress = (p) => {
        reports++;
        if (p.done === 3) controller.abort();
      };
      const options = { signal: controller.signal, onProgress };
      const filter = { amount: { gt: 900 } };
      const run = {
        count: async () => reader.count(filter, options),
        countAsync: () => reader.countAsync(filter, options),
        find: async () => [...reader.find(filter, options)],
        findAsync: async () => { for await (const _ of reader.findAsync(filter, options)); }, // eslint-disable-line no-unused-vars
        columnArrays: async () => reader.columnArrays(filter, options),
      }[name];
      await assert.rejects(run, stopped, name);
      assert.equal(reports, 3, name);
    }
    // countAsync gives the event loop a turn between chunks, so a timer can stop it.
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    let reports = 0;
    await assert.rejects(reader.countAsync({ amount: { gt: 900 } }, { signal: controller.signal, onProgress: () => reports++ }), stopped);
    assert.ok(reports < ROWS / 50, `${reports} chunks before the stop`);
    // Aborted before the call: nothing is read.
    const signal = AbortSignal.abort();
    assert.throws(() => reader.count({ amount: { gt: 900 } }, { signal }), stopped);
    assert.throws(() => [...reader.find({ amount: { gt: 900 } }, { signal })], stopped);
    await assert.rejects(reader.countAsync({ amount: { gt: 900 } }, { signal }), stopped);
    // The reader still works afterwards.
    assert.equal(reader.count({ amount: { gt: 900 } }), [...reader.find({ amount: { gt: 900 } })].length);
  } finally {
    reader.close();
  }
});

test('progress in access-controlled files, for the owner and an access key', () => {
  const key = JazminKey.generate();
  const bob = key.createAccessKey();
  const file = tmp('access.jzm');
  write(file, Array.from({ length: ROWS }, (_, i) => row(i)), {
    columns, key, chunkRows: 50, access: { partitionBy: 'section', grants: [{ key: bob, rows: ['S2', 'S5'], columns: '*' }] },
  });
  for (const [label, reader] of [['owner', open(file, { key })], ['access key', open(file, { key: bob })]]) {
    try {
      const filter = { amount: { gt: 500 } };
      const expected = [...reader.find(filter)].length;
      for (const run of [(o) => reader.count(filter, o), (o) => [...reader.find(filter, o)].length]) {
        const { calls, onProgress } = recorder();
        assert.equal(run({ onProgress }), expected, label);
        assert.deepEqual(calls.at(-1), { done: calls[0].total, total: calls[0].total, matches: expected }, label);
      }
    } finally {
      reader.close();
    }
  }
});

test('exports report progress and stop too', () => {
  const reader = open(plainFile());
  try {
    const filter = { amount: { gt: 900 } };
    const expected = reader.count(filter);
    const { calls, onProgress } = recorder();
    const csv = exportString(reader, 'csv', { filter, onProgress });
    assert.equal(csv.trim().split(/\r?\n/).length, expected + 1); // a header and the rows
    assert.deepEqual(calls.at(-1), { done: ROWS / 50, total: ROWS / 50, matches: expected });
    assert.throws(() => exportString(reader, 'json', { filter, signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
  } finally {
    reader.close();
  }
});
