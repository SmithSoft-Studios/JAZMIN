import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminValidationError, append, beginAppend, open, openWriter, write } from '../src/index.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-tx-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'v', type: 'string' },
];
const NOW = Date.UTC(2026, 9, 1);
const base = (file, options = {}) => write(file, [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }], { columns, now: NOW, ...options });
const rowsOf = (file) => {
  const r = open(file);
  try {
    return { rows: [...r.rows()].map((x) => [x.id, x.v]), appendCount: r.appendCount };
  } finally {
    r.close();
  }
};
/** The same calls, one append() each: what a transaction or the writer must match. */
const sequential = (file, calls, options = {}) => {
  let counts = { inserted: 0, updated: 0, deleted: 0 };
  for (const [kind, arg] of calls) {
    const r = append(file, { ...options, now: NOW, [kind]: arg });
    counts = { inserted: counts.inserted + r.inserted, updated: counts.updated + r.updated, deleted: counts.deleted + r.deleted };
  }
  return counts;
};
const run = (tx, calls) => {
  for (const [kind, arg] of calls) tx[kind](arg);
};

// Calls that don't see each other's rows: one append writes what the calls would, one after another.
const CALLS = [
  ['insert', [{ id: 10, v: 'x' }, { id: 11, v: 'y' }]],
  ['delete', { id: 2 }],
  ['upsert', [{ id: 3, v: 'C' }, { id: 12, v: 'z' }]],
  ['insert', [{ id: 13, v: 'w' }]],
  ['delete', { v: 'a' }],
  ['upsert', [{ id: 1, v: 'A' }]], // deleted by the call before: added again, as an insert
];

test('a transaction commits its calls as one append, with the result of running them one after another', () => {
  const expected = tmp('seq.jzm');
  base(expected);
  const counts = sequential(expected, CALLS, { keyColumns: ['id'] });

  const file = tmp('tx.jzm');
  base(file);
  const tx = beginAppend(file, { keyColumns: ['id'], now: NOW });
  run(tx, CALLS);
  const result = tx.commit();
  const want = rowsOf(expected);
  assert.deepEqual(rowsOf(file), { rows: want.rows, appendCount: 1 });
  assert.deepEqual({ inserted: result.inserted, updated: result.updated, deleted: result.deleted }, counts);
  assert.equal(result.rowCount, want.rows.length);
  assert.equal(result.appendCount, 1);
});

test('a transaction writes the same bytes as one append() with the same rows: no new kind of file', () => {
  const a = tmp('a.jzm');
  const b = tmp('b.jzm');
  base(a);
  fs.copyFileSync(a, b); // a file id of its own each time a file is written
  append(a, { insert: [{ id: 10, v: 'x' }, { id: 11, v: 'y' }, { id: 12, v: 'z' }], delete: { id: 2 }, now: NOW });
  const tx = beginAppend(b, { now: NOW });
  tx.insert([{ id: 10, v: 'x' }]);
  tx.delete({ id: 2 });
  tx.insert([{ id: 11, v: 'y' }, { id: 12, v: 'z' }]);
  tx.commit();
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
});

test('a failing commit leaves the file byte for byte as it was, and ends the transaction', () => {
  const file = tmp('fail.jzm');
  base(file);
  const before = fs.readFileSync(file);
  const tx = beginAppend(file, { keyColumns: ['id'] });
  tx.insert([{ id: 10, v: 'x' }]);
  tx.delete({ id: 1 });
  tx.insert([{ id: 11, v: 42 }]); // not a string
  assert.throws(() => tx.commit(), JazminValidationError);
  assert.ok(fs.readFileSync(file).equals(before));
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.throws(() => tx.insert([{ id: 12, v: 'z' }]), /failed/);
  assert.throws(() => tx.commit(), /failed/);
});

test('rollback discards the calls; a finished transaction refuses more', () => {
  const file = tmp('rollback.jzm');
  base(file);
  const before = fs.readFileSync(file);
  const tx = beginAppend(file);
  tx.insert([{ id: 10, v: 'x' }]);
  tx.rollback();
  assert.ok(fs.readFileSync(file).equals(before));
  assert.throws(() => tx.insert([{ id: 11, v: 'y' }]), /rolled back/);
  assert.throws(() => tx.commit(), /rolled back/);

  const done = beginAppend(file);
  done.insert([{ id: 10, v: 'x' }]);
  done.commit();
  assert.throws(() => done.delete({ id: 1 }), /committed/);
  assert.throws(() => done.rollback(), /committed/);
});

test('a transaction holds no lock or file handle until commit', () => {
  const file = tmp('nolock.jzm');
  base(file);
  const tx = beginAppend(file);
  tx.insert([{ id: 10, v: 'x' }]);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  append(file, { insert: [{ id: 20, v: 'other' }] }); // another writer in between
  tx.commit();
  assert.deepEqual(rowsOf(file).rows.map(([id]) => id), [1, 2, 3, 20, 10]);
});

test('a transaction refuses a call that would see a row an earlier call adds, at commit', () => {
  for (const [calls, message] of [
    [[['insert', [{ id: 10, v: 'x' }]], ['delete', { id: 10 }]], /call 2 \(delete\) matches a row that call 1 \(insert\) adds/],
    [[['insert', [{ id: 10, v: 'x' }]], ['upsert', [{ id: 10, v: 'y' }]]], /call 2 \(upsert\) has the key of a row that call 1 \(insert\) adds/],
    [[['upsert', [{ id: 10, v: 'x' }]], ['upsert', [{ id: 10, v: 'y' }]]], /call 2 \(upsert\) has the key of a row that call 1 \(upsert\) adds/],
  ]) {
    const file = tmp('clash.jzm');
    base(file);
    const before = fs.readFileSync(file);
    const tx = beginAppend(file, { keyColumns: ['id'] });
    run(tx, calls);
    assert.throws(() => tx.commit(), (e) => e instanceof JazminValidationError && message.test(e.message), JSON.stringify(calls));
    assert.ok(fs.readFileSync(file).equals(before));
  }
  // Not clashes: a delete before the insert, and a later insert of a key an earlier upsert wrote.
  const file = tmp('fine.jzm');
  base(file);
  const tx = beginAppend(file, { keyColumns: ['id'] });
  tx.delete({ id: 10 });
  tx.insert([{ id: 10, v: 'x' }]);
  tx.upsert([{ id: 11, v: 'y' }]);
  tx.insert([{ id: 11, v: 'z' }]);
  tx.commit();
  assert.deepEqual(rowsOf(file).rows, [[1, 'a'], [2, 'b'], [3, 'c'], [10, 'x'], [11, 'y'], [11, 'z']]);
});

test('upserts in a transaction and the group writer: the last row for a key in a call wins; an empty key is a key', async () => {
  const nullable = [{ name: 'id', type: 'int', index: 'sorted' }, { name: 'v', type: 'string' }];
  const start = (name) => {
    const file = tmp(name);
    write(file, [{ id: null, v: 'n' }, { id: 1, v: 'a' }], { columns: nullable, now: NOW });
    return file;
  };
  const calls = [
    ['upsert', [{ id: 1, v: 'b' }, { id: null, v: 'm' }, { id: 1, v: 'c' }]], // one call: id 1 once, as 'c'
    ['insert', [{ id: 2, v: 'x' }]],
  ];
  const expected = start('seq.jzm');
  const counts = sequential(expected, calls, { keyColumns: ['id'] });
  const file = start('tx.jzm');
  const tx = beginAppend(file, { keyColumns: ['id'], now: NOW });
  run(tx, calls);
  const result = tx.commit();
  assert.deepEqual(rowsOf(file), { rows: rowsOf(expected).rows, appendCount: 1 });
  assert.deepEqual(rowsOf(file).rows, [[null, 'm'], [1, 'c'], [2, 'x']]);
  assert.deepEqual({ inserted: result.inserted, updated: result.updated, deleted: result.deleted }, counts);

  // A later call upserting the empty key of a row an earlier call adds would see that row: a clash, as for any key.
  const clash = beginAppend(start('clash.jzm'), { keyColumns: ['id'] });
  clash.insert([{ id: null, v: 'n2' }]);
  clash.upsert([{ id: null, v: 'm' }]);
  assert.throws(() => clash.commit(), /call 2 \(upsert\) has the key of a row that call 1 \(insert\) adds/);

  // The group writer splits there instead: the file is as the calls in turn leave it.
  const split = [['insert', [{ id: null, v: 'n2' }]], ['upsert', [{ id: null, v: 'm' }, { id: null, v: 'm2' }]]];
  const want = start('seq2.jzm');
  sequential(want, split, { keyColumns: ['id'] });
  const grouped = start('writer.jzm');
  const w = openWriter(grouped, { keyColumns: ['id'] });
  await Promise.all(split.map(([kind, arg]) => w[kind](arg)));
  await w.close();
  assert.deepEqual(rowsOf(grouped).rows, rowsOf(want).rows);
  assert.deepEqual(rowsOf(grouped).rows, [[1, 'a'], [null, 'm2']]);
});

test('sorted files: a call whose rows sort before an earlier call\'s is refused, as running them in turn would be', () => {
  const file = tmp('sorted.jzm');
  base(file, { sortedBy: ['id'] });
  const tx = beginAppend(file);
  tx.insert([{ id: 20, v: 'x' }]);
  tx.insert([{ id: 10, v: 'y' }]);
  assert.throws(() => tx.commit(), /call 2 \(insert\) has rows that sort before those call 1 \(insert\) adds/);
  const ok = beginAppend(file);
  ok.insert([{ id: 11, v: 'y' }, { id: 10, v: 'x' }]); // within one call: sorted, as append() does
  ok.insert([{ id: 20, v: 'z' }]);
  ok.commit();
  assert.deepEqual(rowsOf(file).rows.map(([id]) => id), [1, 2, 3, 10, 11, 20]);
});

test('beginAppend refuses rows in its options, and upsert without keyColumns when it is called', () => {
  const file = tmp('options.jzm');
  base(file);
  for (const name of ['insert', 'upsert', 'delete']) assert.throws(() => beginAppend(file, { [name]: [] }), new RegExp(name));
  const tx = beginAppend(file);
  assert.throws(() => tx.upsert([{ id: 1, v: 'x' }]), /keyColumns/);
  assert.throws(() => tx.insert({ id: 1, v: 'x' }), /array/);
  assert.throws(() => tx.delete(null), /filter/);
});

test('the group writer merges calls into one append; each call resolves with that append\'s result', async () => {
  const file = tmp('writer.jzm');
  base(file);
  const w = openWriter(file, { now: NOW });
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => w.insert([{ id: 100 + i, v: `r${i}` }])));
  await w.close();
  assert.equal(new Set(results).size, 1);
  assert.equal(results[0].inserted, 50);
  assert.equal(results[0].appendCount, 1);
  const { rows, appendCount } = rowsOf(file);
  assert.equal(appendCount, 1);
  assert.deepEqual(rows.slice(3).map(([id]) => id), Array.from({ length: 50 }, (_, i) => 100 + i));
});

test('the group writer splits a batch where a call would see an earlier call\'s row: the file is as the calls in turn leave it', async () => {
  const calls = [
    ['insert', [{ id: 10, v: 'x' }]],
    ['delete', { id: 10 }], // sees the row above: a new append
    ['insert', [{ id: 11, v: 'y' }]],
    ['upsert', [{ id: 11, v: 'Y' }]], // sees the row above: another
    ['insert', [{ id: 12, v: 'z' }]],
  ];
  const expected = tmp('seq.jzm');
  base(expected);
  sequential(expected, calls, { keyColumns: ['id'] });
  const file = tmp('split.jzm');
  base(file);
  const w = openWriter(file, { keyColumns: ['id'] });
  const results = await Promise.all(calls.map(([kind, arg]) => w[kind](arg)));
  await w.close();
  assert.deepEqual(rowsOf(file), { rows: rowsOf(expected).rows, appendCount: 3 });
  assert.deepEqual(results.map((r) => r.appendCount), [1, 2, 2, 3, 3]);
});

test('the group writer: a bad call fails alone, the others are written in order', async () => {
  const file = tmp('errors.jzm');
  base(file);
  const w = openWriter(file);
  const calls = Array.from({ length: 20 }, (_, i) => w.insert([{ id: 100 + i, v: i === 7 || i === 13 ? i : `r${i}` }]));
  const settled = await Promise.allSettled(calls);
  await w.close();
  assert.deepEqual(settled.map((s) => s.status), settled.map((_, i) => (i === 7 || i === 13 ? 'rejected' : 'fulfilled')));
  assert.ok(settled[7].reason instanceof JazminValidationError);
  assert.match(settled[7].reason.message, /expected a string/);
  const ids = rowsOf(file).rows.slice(3).map(([id]) => id);
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => 100 + i).filter((id) => id !== 107 && id !== 113));
});

test('the group writer: an error that is not about the calls fails the whole batch', async () => {
  const file = tmp('locked.jzm');
  base(file);
  fs.writeFileSync(`${file}.lock`, '');
  const w = openWriter(file);
  const settled = await Promise.allSettled([w.insert([{ id: 10, v: 'x' }]), w.insert([{ id: 11, v: 'y' }])]);
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected']);
  assert.match(settled[0].reason.message, /Another writer/);
  fs.rmSync(`${file}.lock`);
  await w.close();
});

test('the group writer: maxRows bounds a batch; calls made during a write make the next batch; flush and close wait', async () => {
  const file = tmp('batches.jzm');
  base(file);
  const w = openWriter(file, { maxRows: 10 });
  const first = Array.from({ length: 25 }, (_, i) => w.insert([{ id: 100 + i, v: 'x' }]));
  await w.flush();
  const late = w.insert([{ id: 200, v: 'late' }]);
  await w.close();
  const appends = (await Promise.all(first)).map((r) => r.appendCount);
  assert.deepEqual([...new Set(appends)], [1, 2, 3]);
  assert.equal((await late).appendCount, 4);
  await assert.rejects(w.insert([{ id: 300, v: 'closed' }]), /closed/);
  assert.equal(rowsOf(file).rows.length, 29);
});

test('the group writer waits maxDelay for more calls before writing', async () => {
  const file = tmp('delay.jzm');
  base(file);
  const w = openWriter(file, { maxDelay: 30 });
  const a = w.insert([{ id: 10, v: 'x' }]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = w.insert([{ id: 11, v: 'y' }]);
  assert.equal((await a).appendCount, 1);
  assert.equal((await b).appendCount, 1);
  await w.close();
});

test('openWriter refuses options that would be written again by every batch', async () => {
  const file = tmp('refuse.jzm');
  base(file);
  for (const name of ['insert', 'upsert', 'delete', 'metadata', 'grant', 'addFiles', 'removeFiles', 'package', 'addShapes', 'removeShapes', 'locks', 'columns']) {
    assert.throws(() => openWriter(file, { [name]: [] }), (e) => e instanceof JazminValidationError && e.message.includes(name), name);
  }
  assert.throws(() => openWriter(file, { maxRows: 0 }), /maxRows/);
  assert.throws(() => openWriter(file, { maxDelay: -1 }), /maxDelay/);
  const w = openWriter(file);
  await assert.rejects(w.upsert([{ id: 1, v: 'x' }]), /keyColumns/);
  await assert.rejects(w.insert({ id: 1, v: 'x' }), /array/);
  await w.close();
});

test('the group writer writes the same bytes as one append() with the same rows (flushes awaited, same order)', async () => {
  const a = tmp('a.jzm');
  const b = tmp('b.jzm');
  base(a);
  fs.copyFileSync(a, b);
  append(a, { insert: [{ id: 10, v: 'x' }, { id: 11, v: 'y' }, { id: 12, v: 'z' }], now: NOW });
  const w = openWriter(b, { now: NOW });
  await Promise.all([w.insert([{ id: 10, v: 'x' }]), w.insert([{ id: 11, v: 'y' }]), w.insert([{ id: 12, v: 'z' }])]);
  await w.close();
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
});

test('transactions and the group writer on encrypted and access-controlled files, with the key', async () => {
  const { JazminKey } = await import('../src/index.js');
  const owner = JazminKey.generate();
  const reader = owner.createAccessKey();
  for (const [name, options] of [['key', { key: owner }], ['shared', { key: owner, access: { partitionBy: 'v', grants: [{ key: reader, rows: ['a'] }] } }]]) {
    const file = tmp(`${name}.jzm`);
    base(file, options);
    const tx = beginAppend(file, { key: owner, keyColumns: ['id'] });
    tx.upsert([{ id: 1, v: 'a2' }]);
    tx.insert([{ id: 10, v: 'a' }]);
    tx.commit();
    const w = openWriter(file, { key: owner });
    await Promise.all([w.insert([{ id: 11, v: 'a' }]), w.delete({ id: 2 })]);
    await w.close();
    const r = open(file, { key: owner });
    assert.deepEqual([...r.rows()].map((x) => [x.id, x.v]), [[3, 'c'], [1, 'a2'], [10, 'a'], [11, 'a']], name);
    assert.equal(r.appendCount, 2);
    r.close();
  }
});

test('masked columns: a delete after a call that adds rows is a clash, since the writer changes rows as it stores them', async () => {
  const { JazminKey } = await import('../src/index.js');
  const owner = JazminKey.generate();
  const staff = [{ id: 1, dept: 'A', salary: '52000.00' }, { id: 2, dept: 'A', salary: '61000.50' }];
  const maskedColumns = [{ name: 'id', type: 'int' }, { name: 'dept', type: 'string' }, { name: 'salary', type: 'decimal', mask: { lock: 'hr', rows: { id: { gte: 2 } } } }];
  const start = (name) => {
    const file = tmp(name);
    write(file, staff, { columns: maskedColumns, key: owner, access: { partitionBy: 'dept', grants: [] }, locks: { hr: { online: true } } });
    return file;
  };
  const show = (file) => {
    const r = open(file, { key: owner });
    try {
      return [...r.rows()].map((x) => JSON.stringify(x));
    } finally {
      r.close();
    }
  };
  // Row 0 is outside the mask's rows, so the writer stores its salary in salary_unmasked, where the delete looks.
  const calls = [['insert', [{ id: 0, dept: 'A', salary: '70000.00' }]], ['delete', { salary_unmasked: { gte: '60000' } }]];
  const expected = start('seq.jzm');
  for (const [kind, arg] of calls) append(expected, { key: owner, [kind]: arg });
  assert.equal(show(expected).length, 2, 'run in turn, the delete removes the inserted row');

  const tx = beginAppend(start('tx.jzm'), { key: owner });
  run(tx, calls);
  assert.throws(() => tx.commit(), /call 2 \(delete\) may match a row that call 1 \(insert\) adds/);

  const grouped = start('writer.jzm');
  const w = openWriter(grouped, { key: owner });
  await Promise.all(calls.map(([kind, arg]) => w[kind](arg)));
  await w.close();
  assert.deepEqual(show(grouped), show(expected));
});

test('several deletes in one transaction: each row counts once, for the first call that deletes it', () => {
  const dated = [{ name: 'id', type: 'int' }, { name: 'at', type: 'datetime' }];
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: i, at: new Date(Date.UTC(2026, 0, i + 1)) }));
  const calls = [
    ['delete', { at: { lt: new Date(Date.UTC(2026, 0, 3)) } }],
    ['upsert', [{ id: 1, at: new Date(Date.UTC(2027, 0, 1)) }, { id: 4, at: new Date(Date.UTC(2027, 0, 2)) }]],
    ['delete', { at: { lte: new Date(Date.UTC(2026, 0, 5)) } }],
  ];
  const expected = tmp('seq.jzm');
  write(expected, rows, { columns: dated, now: NOW });
  const counts = sequential(expected, calls, { keyColumns: ['id'] });
  const file = tmp('tx.jzm');
  write(file, rows, { columns: dated, now: NOW });
  const tx = beginAppend(file, { keyColumns: ['id'] });
  run(tx, calls);
  const result = tx.commit();
  assert.deepEqual({ inserted: result.inserted, updated: result.updated, deleted: result.deleted }, counts);
  const ids = (f) => {
    const r = open(f);
    try {
      return [...r.rows()].map((x) => [x.id, x.at.toISOString()]);
    } finally {
      r.close();
    }
  };
  assert.deepEqual(ids(file), ids(expected));
});
