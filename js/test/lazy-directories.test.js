import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFormatError, JazminKey, append, exportString, open, write } from '../src/index.js';
import { APPEND_STATE, KEY_ROTATION, SOURCE } from '../src/reader.js';

// A file's chunk directories (one per partition and append) are read when a query first needs them, not when it is
// opened: opening a file after many appends costs the same as after none (issue #275).

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-lazy-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'name', type: 'string' },
];
const row = (id) => ({ id, name: `Name ${id}` });

/** A keyed file with three appends: four chunk directories. Returns { file, key, directories: [{ offset, length }] }. */
function appendedFile() {
  const file = tmp('t.jzm');
  const key = JazminKey.generate();
  write(file, Array.from({ length: 100 }, (_, i) => row(i)), { columns, key, chunkRows: 25 });
  for (let a = 0; a < 3; a++) append(file, { key, insert: [row(100 + a)] });
  const r = open(file, { key });
  try {
    const directories = r[KEY_ROTATION].sections.filter((s) => s.sectionId.startsWith('0/dir/'));
    return { file, key, directories };
  } finally {
    r.close();
  }
}

/** A byte source over a buffer that records the ranges read. */
function recordingSource(bytes) {
  const reads = [];
  return {
    reads,
    source: {
      [SOURCE]: true,
      size: bytes.length,
      read(position, length) {
        reads.push({ position, length });
        if (position < 0 || position + length > bytes.length) throw new JazminFormatError('Unexpected end of file');
        return bytes.subarray(position, position + length);
      },
      close() {},
    },
  };
}

const overlaps = (read, section) => read.position < section.offset + section.length && section.offset < read.position + read.length;
const readsOf = (reads, sections) => sections.filter((s) => reads.some((read) => overlaps(read, s))).map((s) => s.sectionId);

test('opening a file reads none of its chunk directories; the first query reads them', () => {
  const { file, key, directories } = appendedFile();
  assert.equal(directories.length, 4, 'the original rows and each append have a chunk directory');
  const { reads, source } = recordingSource(fs.readFileSync(file));
  const r = open(source, { key });
  try {
    assert.deepEqual(readsOf(reads, directories), [], 'open read a chunk directory');
    assert.equal(r.rowCount, 103);
    assert.equal(r.appendCount, 3);
    assert.equal(r.chunkCount, 7);
    assert.deepEqual(readsOf(reads, directories), [], 'rowCount, appendCount and chunkCount read a chunk directory');
    assert.deepEqual([...r.find({ id: { gte: 99 } })].map((x) => x.id), [99, 100, 101, 102]);
    assert.equal(readsOf(reads, directories).length, 4);
  } finally {
    r.close();
  }
});

test('a damaged chunk directory: the file opens, and the first query fails with a format error', () => {
  const { file, key, directories } = appendedFile();
  const bytes = fs.readFileSync(file);
  const last = directories.at(-1);
  bytes[last.offset + last.length - 1] ^= 0xff; // fails its CRC-32 check
  const r = open(bytes, { key });
  try {
    assert.equal(r.rowCount, 103);
    assert.throws(() => [...r.rows()], JazminFormatError);
    assert.throws(() => r.get(0), JazminFormatError);
  } finally {
    r.close();
  }
});

test('an unencrypted file with a damaged chunk directory opens; the first query fails', () => {
  const file = tmp('plain.jzm');
  write(file, Array.from({ length: 100 }, (_, i) => row(i)), { columns, chunkRows: 25 });
  const bytes = fs.readFileSync(file);
  const r0 = open(bytes);
  const [directory] = r0[APPEND_STATE].table.partitions[0].segments; // the one partition's chunk directory
  r0.close();
  bytes[directory.offset + directory.length - 1] ^= 0xff; // fails its CRC-32 check
  const r = open(bytes);
  try {
    assert.equal(r.rowCount, 100);
    assert.throws(() => r.count({ id: { gte: 50 } }), JazminFormatError);
  } finally {
    r.close();
  }
});

// ---- the browser reader (js/browser), which the viewer uses: the same, for files that aren't shared ----

/** The browser reader over a byte source that records the ranges read. */
async function browserReader(bytes, options) {
  await import('../browser/jazmin-browser.js');
  const reads = [];
  const source = { size: bytes.length, async read(position, length) { reads.push({ position, length }); return bytes.subarray(position, position + length); } };
  return { reads, reader: await globalThis.JazminBrowser.open(source, options) };
}

test('the browser reader also opens without reading a chunk directory; the first query reads them', async () => {
  const { file, key, directories } = appendedFile();
  const { reads, reader: r } = await browserReader(fs.readFileSync(file), { key: key.export() });
  assert.deepEqual(readsOf(reads, directories), [], 'open read a chunk directory');
  assert.equal(r.rowCount, 103);
  assert.equal(r.hiddenRowCount, 0);
  assert.equal(await r.count(), 103);
  assert.deepEqual(readsOf(reads, directories), [], 'rowCount and count() read a chunk directory');
  const found = [];
  for await (const x of r.find({ id: { gte: 99 } })) found.push(x.id);
  assert.deepEqual(found, [99, 100, 101, 102]);
  assert.equal(readsOf(reads, directories).length, 4);
});

test('the browser reader: queries that start together read each chunk directory once', async () => {
  const { file, key, directories } = appendedFile();
  const bytes = fs.readFileSync(file);
  // Reads that cover a directory (statistics read together can span one too): two queries started together make as
  // many as one query alone.
  const timesRead = (reads) => directories.map((d) => reads.filter((read) => overlaps(read, d)).length);
  const one = await browserReader(bytes, { key: key.export() });
  assert.equal(await one.reader.count({ id: { gte: 50 } }), 53);
  const two = await browserReader(bytes, { key: key.export() });
  assert.deepEqual(await Promise.all([two.reader.count({ id: { gte: 50 } }), two.reader.count({ id: { gte: 50 } })]), [53, 53]);
  assert.deepEqual(timesRead(two.reads), timesRead(one.reads));
});

test('the browser reader: a damaged chunk directory opens, and every query fails with a format error', async () => {
  const { file, key, directories } = appendedFile();
  const bytes = Uint8Array.from(fs.readFileSync(file));
  const last = directories.at(-1);
  bytes[last.offset + last.length - 1] ^= 0xff; // fails its CRC-32 check
  const { reader: r } = await browserReader(bytes, { key: key.export() });
  assert.equal(r.rowCount, 103);
  const isFormatError = (e) => e instanceof globalThis.JazminBrowser.JazminFormatError;
  await assert.rejects(r.count({ id: { gte: 50 } }), isFormatError);
  await assert.rejects(r.count({ id: { gte: 50 } }), isFormatError, 'and again');
  await assert.rejects(r.query(null, { limit: 5 }), isFormatError);
  await assert.rejects(r.explain({ id: 5 }), isFormatError);

  const plainFile = tmp('plain.jzm');
  write(plainFile, Array.from({ length: 100 }, (_, i) => row(i)), { columns, chunkRows: 25 });
  const plain = fs.readFileSync(plainFile);
  const r0 = open(plain);
  const [directory] = r0[APPEND_STATE].table.partitions[0].segments;
  r0.close();
  plain[directory.offset + directory.length - 1] ^= 0xff;
  const { reader: p } = await browserReader(plain);
  assert.equal(p.rowCount, 100);
  await assert.rejects(async () => { for await (const x of p.find()) assert.ok(x); }, isFormatError);
});

/** Files of each kind the browser reads: appended, sorted with deletes, plain with deletes, and shared. */
function browserCases() {
  const cols = [
    { name: 'id', type: 'int', nullable: false, index: 'sorted' },
    { name: 'name', type: 'string' },
    { name: 'group', type: 'string', index: 'sorted' },
    { name: 'at', type: 'datetime' },
  ];
  const item = (id) => ({ id, name: `Name ${id}`, group: `G${id % 5}`, at: new Date(Date.UTC(2024, 0, 1 + (id % 300))) });
  const ids = (from, n) => Array.from({ length: n }, (_, i) => item(from + i));
  const key = JazminKey.generate();
  const cases = [];

  const appended = tmp('appended.jzm');
  write(appended, ids(0, 100), { columns: cols, key, chunkRows: 25 });
  for (let a = 0; a < 4; a++) append(appended, { key, insert: ids(100 + a * 5, 5) });
  cases.push({ name: 'appended', file: appended, key: key.export() });

  const sorted = tmp('sorted.jzm');
  write(sorted, ids(0, 100), { columns: cols, key, sortedBy: ['id'], chunkRows: 20 });
  append(sorted, { key, insert: ids(100, 10) });
  append(sorted, { key, delete: { id: { gte: 30, lt: 40 } } });
  append(sorted, { key, insert: ids(110, 3), delete: { id: 105 } });
  cases.push({ name: 'sorted, with deletes', file: sorted, key: key.export() });

  const plain = tmp('plain.jzm');
  write(plain, ids(0, 100), { columns: cols, chunkRows: 30 });
  append(plain, { insert: ids(100, 7), delete: { group: 'G3' } });
  append(plain, { insert: ids(107, 7) });
  cases.push({ name: 'plain, with deletes', file: plain, key: undefined });

  // Shared: browsers never take the owner's key; a full-read access key sees what the owner sees.
  const owner = JazminKey.generate();
  const full = owner.createAccessKey();
  const bob = owner.createAccessKey();
  const shared = tmp('shared.jzm');
  write(shared, ids(0, 100), {
    columns: cols, key: owner, chunkRows: 20,
    access: { partitionBy: 'group', grants: [{ key: full, rows: '*', columns: '*' }, { key: bob, rows: ['G1', 'G2'], columns: '*' }] },
  });
  append(shared, { key: owner, insert: ids(100, 10) });
  append(shared, { key: owner, delete: { id: { lt: 12 } } });
  cases.push({ name: 'shared, full-read access key', file: shared, key: full.export() });
  cases.push({ name: 'shared, access key', file: shared, key: bob.export() });
  return cases;
}

/** Comparable form of a result: Dates as text, typed arrays and Blobs as arrays and text, timings dropped. */
async function comparable(v) {
  if (v instanceof Date) return v.toISOString();
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (v instanceof Blob) return v.text();
  if (Array.isArray(v)) return Promise.all(v.map(comparable));
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'ms') out[k] = await comparable(x);
    return out;
  }
  return v;
}

test('the browser reader: each read API gives the same on a freshly opened reader as after a query, and as the library', async () => {
  await import('../browser/jazmin-browser.js');
  const { JazminBrowser } = globalThis;
  const all = async (iterable) => { const out = []; for await (const x of iterable) out.push(x); return out; };
  const filters = [null, { id: 57 }, { id: { gte: 90 } }, { group: 'G2' }, { name: { contains: '7' } }, { at: { lt: '2024-02-01T00:00:00.000Z' } }];
  // [what, browser call, library call]
  const calls = [
    ['rowCount', (r) => r.rowCount, (l) => l.rowCount],
    ['hiddenRowCount', (r) => r.hiddenRowCount, (l) => l.hiddenRowCount],
    ['toJSON (viewer export)', (r) => JazminBrowser.toJSON(r), (l) => exportString(l, 'json')],
    ['exportBlob csv (viewer export)', (r) => JazminBrowser.exportBlob(r, 'csv'), (l) => exportString(l, 'csv')],
  ];
  for (const f of filters) {
    const at = JSON.stringify(f);
    const page = { offset: 3, limit: 7, select: ['id', 'group'] };
    calls.push(
      [`find ${at}`, (r) => all(r.find(f)), (l) => [...l.find(f)]],
      [`find reverse ${at}`, (r) => all(r.find(f, { reverse: true })), (l) => [...l.find(f, { reverse: true })]],
      [`find page ${at}`, (r) => all(r.find(f, page)), (l) => [...l.find(f, page)]],
      [`query page (viewer) ${at}`, (r) => r.query(f, { offset: 2, limit: 10 }), (l) => ({ rows: [...l.find(f, { offset: 2, limit: 10 })], total: l.count(f) })],
      [`query last page ${at}`, (r) => r.query(f, { limit: 4, reverse: true, total: false }), (l) => ({ rows: [...l.find(f, { limit: 4, reverse: true })] })],
      [`count ${at}`, (r) => r.count(f), (l) => l.count(f)],
      [`columnArrays ${at}`, (r) => r.columnArrays(f, { select: ['id', 'at'] }), (l) => l.columnArrays(f, { select: ['id', 'at'] })],
      [`estimate ${at}`, (r) => r.estimate(f, { offset: 5 }), (l) => l.estimate(f, { offset: 5 })],
      [`explain ${at}`, (r) => r.explain(f), (l) => l.explain(f)],
    );
  }
  for (const c of browserCases()) {
    const bytes = fs.readFileSync(c.file);
    const library = open(c.file, { key: c.key });
    try {
      for (const [what, call, libraryCall] of calls) {
        const r = await JazminBrowser.open(bytes, { key: c.key });
        const first = await comparable(await call(r));
        await r.count({ id: { gte: 0 } }); // another query: directories, statistics and indexes are loaded
        assert.deepEqual(await comparable(await call(r)), first, `${c.name}: ${what}, after another query`);
        assert.deepEqual(first, await comparable(await libraryCall(library)), `${c.name}: ${what}, as the library`);
      }
      // What a first query reads and decodes, as the library's first query: for files that aren't shared (an access key
      // reads its own directories on opening, in both readers).
      for (const f of c.name.startsWith('shared') ? [] : filters) {
        const fresh = open(c.file, { key: c.key });
        const expected = await comparable(fresh.explain(f, { analyze: true }));
        fresh.close();
        const actual = await comparable(await (await JazminBrowser.open(bytes, { key: c.key })).explain(f, { analyze: true }));
        assert.deepEqual(actual, expected, `${c.name}: explain({ analyze }) ${JSON.stringify(f)}`);
      }
    } finally {
      library.close();
    }
  }
});
