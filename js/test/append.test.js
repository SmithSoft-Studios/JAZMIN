import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminKey, JazminKeyError, JazminValidationError, append, compact, open, update, write,
} from '../src/index.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-append-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'section', type: 'string', index: ['sorted', 'trigram'] },
  { name: 'amount', type: 'float' },
];
const row = (id, section = `S${Math.floor(id / 10)}`) => ({ id, section, amount: id * 1.5 });
const ids = (file, options, filter) => {
  const r = open(file, options);
  try {
    return [...r.find(filter ?? null)].map((x) => x.id);
  } finally {
    r.close();
  }
};
/** Bytes 4-5 hold the flags, which an append updates; everything else must be untouched. */
const samePrefix = (before, after) => before.subarray(0, 4).equals(after.subarray(0, 4)) && before.subarray(6).equals(after.subarray(6, before.length));

test('append adds rows without changing existing bytes; indexes cover old and new rows', () => {
  const file = tmp('a.jzm');
  write(file, Array.from({ length: 50 }, (_, i) => row(i)), { columns, chunkRows: 16 });
  const before = fs.readFileSync(file);
  const result = append(file, { insert: [row(50), row(51, 'Special')] });
  assert.deepEqual(result, { rowCount: 52, inserted: 2, updated: 0, deleted: 0, appendCount: 1, deletedRowCount: 0, expiredGrantsRemoved: 0, compacted: false });
  assert.ok(samePrefix(before, fs.readFileSync(file)), 'existing bytes must not change');

  const r = open(file);
  assert.equal(r.appendCount, 1);
  assert.deepEqual([...r.rows()].map((x) => x.id), Array.from({ length: 52 }, (_, i) => i));
  assert.deepEqual(r.explain({ id: 51 }), { strategy: 'index', candidateRows: 1 });
  assert.deepEqual([...r.find({ section: { contains: 'Special' } })].map((x) => x.id), [51]);
  assert.deepEqual([...r.find({ section: 'S1' })].map((x) => x.id), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  r.close();
});

test('writtenAt: when the file was created, then when it was last appended to', () => {
  const file = tmp('written.jzm');
  const writtenAt = () => {
    const r = open(file);
    try {
      return r.writtenAt;
    } finally {
      r.close();
    }
  };
  write(file, [row(1)], { columns, now: Date.UTC(2026, 0, 1) });
  assert.deepEqual(writtenAt(), new Date(Date.UTC(2026, 0, 1)));
  append(file, { insert: [row(2)], now: Date.UTC(2026, 0, 2, 12) });
  assert.deepEqual(writtenAt(), new Date(Date.UTC(2026, 0, 2, 12)));
});

test('append results match the file: row, append and deleted-row counts', () => {
  const owner = JazminKey.generate();
  for (const [name, options] of [['plain', {}], ['shared', { key: owner, access: { partitionBy: 'section', grants: [{ key: owner.createAccessKey(), rows: ['S1'] }] } }]]) {
    const file = tmp(`results-${name}.jzm`);
    write(file, Array.from({ length: 30 }, (_, i) => row(i)), { columns, ...options });
    const key = options.key;
    for (const change of [
      { insert: [row(30), row(31)] },
      { delete: { section: 'S1' } },
      { upsert: [{ ...row(5), amount: -1 }, { ...row(40), section: 'S2' }], keyColumns: ['id'] },
      { insert: [row(5), row(5)] }, // the same id twice more
      { upsert: [{ ...row(5), amount: -2 }], keyColumns: ['id'] }, // replaces all three rows of id 5
      { delete: { section: 'S1' }, insert: [row(50, 'S1')] }, // nothing left to delete in S1
    ]) {
      const result = append(file, { key, ...change });
      const r = open(file, { key });
      try {
        assert.deepEqual([result.rowCount, result.appendCount, result.deletedRowCount], [r.rowCount, r.appendCount, r.deletedRowCount], `${name} ${JSON.stringify(change)}`);
      } finally {
        r.close();
      }
    }
  }
});

test('delete and upsert are recorded as deletions; reads skip them everywhere', () => {
  const file = tmp('d.jzm');
  write(file, Array.from({ length: 30 }, (_, i) => row(i)), { columns, chunkRows: 8 });
  const result = append(file, {
    delete: { section: 'S0' },
    upsert: [{ id: 15, section: 'S1', amount: 999 }, { id: 99, section: 'S9', amount: 1 }],
    keyColumns: ['id'],
  });
  assert.deepEqual(result, { rowCount: 21, inserted: 1, updated: 1, deleted: 10, appendCount: 1, deletedRowCount: 11, expiredGrantsRemoved: 0, compacted: false });
  const r = open(file);
  assert.equal(r.rowCount, 21);
  assert.equal(r.deletedRowCount, 11);
  assert.deepEqual([...r.find({ id: 15 })].map((x) => x.amount), [999]);
  assert.equal(r.count({ section: 'S0' }), 0);
  assert.throws(() => r.get(3), /was deleted/);
  assert.equal(r.get(30).id, 15); // the replacement row was appended
  r.close();
});

test('sorted files: appends must come after existing rows; a failed append leaves the file byte-identical', () => {
  const file = tmp('s.jzm');
  write(file, Array.from({ length: 20 }, (_, i) => row(i)), { columns, sortedBy: ['id'], chunkRows: 8 });
  append(file, { insert: [row(20), row(21)] });
  const before = fs.readFileSync(file);
  assert.throws(() => append(file, { insert: [row(5)] }), /must sort after the existing rows/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['s.jzm']); // no lock file left behind
  assert.deepEqual(ids(file, {}, { id: { gte: 19 } }), [19, 20, 21]);
});

test('an interrupted append is ignored by readers and cleaned up by the next append', () => {
  const file = tmp('crash.jzm');
  write(file, Array.from({ length: 20 }, (_, i) => row(i)), { columns });
  append(file, { insert: [row(20)] });
  // Simulate a crash part-way through the next append: bytes after the last trailer.
  fs.appendFileSync(file, Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(300, 7), Buffer.from('JZMN')]));
  const r = open(file);
  assert.equal(r.recovered, true);
  assert.equal(r.rowCount, 21);
  r.close();
  append(file, { insert: [row(21)] });
  const after = open(file);
  assert.equal(after.recovered, false);
  assert.deepEqual([...after.rows()].map((x) => x.id).slice(-2), [20, 21]);
  after.close();
});

test('readers opened before an append keep reading the version they opened', () => {
  const file = tmp('live.jzm');
  write(file, Array.from({ length: 20 }, (_, i) => row(i)), { columns });
  const early = open(file);
  append(file, { insert: [row(20)], delete: { id: 0 } });
  assert.equal(early.rowCount, 20);
  assert.deepEqual([...early.rows()].map((x) => x.id)[0], 0);
  early.close();
});

test('encrypted and password files can be appended with their key', () => {
  const key = JazminKey.generate();
  const file = tmp('k.jzm');
  write(file, [row(1)], { columns, key });
  append(file, { key, insert: [row(2)] });
  assert.deepEqual(ids(file, { key }), [1, 2]);
  assert.throws(() => append(file, { key: JazminKey.generate(), insert: [row(3)] }), JazminKeyError);

  const pw = tmp('p.jzm');
  write(pw, [row(1)], { columns, password: 'pw', kdfIterations: 1000 });
  append(pw, { password: 'pw', insert: [row(2)], delete: { id: 1 } });
  assert.deepEqual(ids(pw, { password: 'pw' }), [2]);
});

test('access-controlled: owner appends, grants carry over, new grants allowed, revoke needs compaction', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const carol = owner.createAccessKey();
  const file = tmp('acl.jzm');
  write(file, [row(1, 'A'), row(2, 'B')], {
    columns, key: owner, sortedBy: ['section'],
    access: { partitionBy: 'section', grants: [{ key: bob, rows: ['A', 'C'], label: 'Bob' }] },
  });
  append(file, { key: owner, insert: [row(3, 'C')], grant: [{ key: carol, rows: '*', label: 'Carol' }] });
  assert.deepEqual(ids(file, { key: bob }), [1, 3]); // group C is new, and Bob was granted it
  assert.deepEqual(ids(file, { key: carol }), [1, 2, 3]);
  assert.throws(() => append(file, { key: bob, insert: [row(4, 'D')] }), /Only the file owner/);
  assert.throws(() => append(file, { key: owner, revoke: [bob] }), /compact\(\) or update\(\)/);

  append(file, { key: owner, delete: { id: 1 } });
  const r = open(file, { key: bob });
  assert.deepEqual([...r.rows()].map((x) => x.id), [3]);
  assert.equal(r.deletedRowCount, 1);
  r.close();
});

test('an append may widen a grant but not narrow it: narrowing needs a rewrite with fresh secrets', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('narrow.jzm');
  write(file, [row(1, 'A'), row(2, 'B')], {
    columns, key: owner, sortedBy: ['section'],
    access: { partitionBy: 'section', grants: [{ key: bob, rows: ['A'] }] },
  });
  append(file, { key: owner, insert: [row(3, 'C')], grant: [{ key: bob, rows: ['A', 'C'] }] }); // wider
  assert.deepEqual(ids(file, { key: bob }), [1, 3]);
  for (const narrower of [{ rows: ['C'] }, { rows: ['A', 'C'], expiresIn: '1d' }, { rows: ['A', 'C'], mode: 'online' }]) {
    assert.throws(() => append(file, { key: owner, insert: [row(4, 'C')], grant: [{ key: bob, ...narrower }] }), /narrower than before.*update\(\) or compact\(\)/);
  }
  update(file, { key: owner, grant: [{ key: bob, rows: ['C'] }] }); // a rewrite re-locks the file
  assert.deepEqual(ids(file, { key: bob }), [3]);
});

test('compact removes deleted rows and superseded data, and resets the append count', () => {
  const file = tmp('c.jzm');
  write(file, Array.from({ length: 200 }, (_, i) => row(i)), { columns, chunkRows: 32 });
  for (let n = 0; n < 5; n++) append(file, { insert: [row(200 + n)], delete: { id: { lt: (n + 1) * 20 } } });
  const before = open(file);
  const live = [...before.rows()].map((x) => x.id);
  assert.equal(before.appendCount, 5);
  before.close();

  const result = compact(file);
  assert.ok(result.bytesAfter < result.bytesBefore, `${result.bytesAfter} < ${result.bytesBefore}`);
  const r = open(file);
  assert.equal(r.appendCount, 0);
  assert.equal(r.deletedRowCount, 0);
  assert.deepEqual([...r.rows()].map((x) => x.id), live);
  assert.equal(r.explain({ id: 150 }).strategy, 'index');
  r.close();
});

test('autoCompact compacts when a threshold is reached', () => {
  const file = tmp('auto.jzm');
  write(file, Array.from({ length: 10 }, (_, i) => row(i)), { columns });
  assert.equal(append(file, { insert: [row(10)], autoCompact: { appends: 2 } }).compacted, false);
  const second = append(file, { insert: [row(11)], autoCompact: { appends: 2 } });
  assert.equal(second.compacted, true);
  assert.equal(second.rowCount, 12);
  assert.equal(append(file, { delete: { id: { lt: 5 } }, autoCompact: { deletedRatio: 0.25 } }).compacted, true);
  assert.equal(open(file).rowCount, 7);
});

test('one writer at a time: a held lock blocks append, update and compact', () => {
  const file = tmp('lock.jzm');
  write(file, [row(1)], { columns });
  fs.writeFileSync(`${file}.lock`, '');
  assert.throws(() => append(file, { insert: [row(2)] }), /Another writer/);
  assert.throws(() => update(file, { insert: [row(2)] }), /Another writer/);
  assert.throws(() => compact(file), /Another writer/);
  fs.rmSync(`${file}.lock`);
  append(file, { insert: [row(2)] });
  assert.deepEqual(ids(file), [1, 2]);
});

test('upsert needs keyColumns', () => {
  const file = tmp('v.jzm');
  write(file, [row(1)], { columns });
  assert.throws(() => append(file, { upsert: [row(1)] }), JazminValidationError);
});

test('a full update or compaction while readers have the file open replaces it, on Windows too (W-1)', () => {
  const file = tmp('rename.jzm');
  write(file, Array.from({ length: 20 }, (_, i) => row(i)), { columns });
  const early = open(file);
  update(file, { insert: [row(20)] });
  const middle = open(file);
  append(file, { insert: [row(21)] });
  compact(file);
  // Each open reader still reads the version it opened, rows included.
  assert.deepEqual([early.rowCount, [...early.rows()].length], [20, 20]);
  assert.deepEqual([middle.rowCount, [...middle.rows()].length], [21, 21]);
  early.close();
  middle.close();
  assert.equal(ids(file).length, 22);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['rename.jzm']); // no temporary or old versions left
});

test('on Windows, a file another program holds without allowing renames is left as it was', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const file = tmp('held.jzm');
  write(file, Array.from({ length: 20 }, (_, i) => row(i)), { columns });
  const before = fs.readFileSync(file);
  // PowerShell holds the file open for reading, sharing reads only (no renames or deletes).
  const command = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); 'held'; [Console]::In.ReadLine() | Out-Null; $f.Close()`;
  const holder = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await once(holder.stdout, 'data');
    assert.throws(() => update(file, { insert: [row(20)] }), /another program has it open and doesn't allow it to be renamed/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['held.jzm']); // temporary file removed
  } finally {
    holder.stdin.end();
    await once(holder, 'exit');
  }
  update(file, { insert: [row(20)] }); // once it is closed
  assert.equal(ids(file).length, 21);
});
