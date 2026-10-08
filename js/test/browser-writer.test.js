import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, JazminKey, JazminWriter, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

// The browser writer (issue #13, docs/design/browser-writer.md): files with one key, a password or no key, written
// with the browser's own crypto and compression. With the same rows, options and random bytes it must write exactly
// the bytes the library writes, which the library's tests and reviews cover.

const { JazminBrowser } = globalThis;
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));

const columns = [
  { name: 'id', type: 'int', nullable: false, description: 'Row number' },
  { name: 'big', type: 'int' },
  { name: 'at', type: 'datetime' },
  { name: 'amount', type: 'float' },
  { name: 'price', type: 'decimal' },
  { name: 'label', type: 'string', attributes: { unit: 'none', note: 'ünïcode' } },
  { name: 'ok', type: 'bool' },
  { name: 'blob', type: 'binary' },
  { name: 'extra', type: 'json' },
];
const row = (i) => ({
  id: i,
  big: i % 9 === 0 ? null : i % 4 === 0 ? 2n ** 60n + BigInt(i) : -i * 1000,
  at: i % 13 === 0 ? null : new Date(Date.UTC(2025, 0, 1) + i * 3_600_000),
  amount: i % 11 === 0 ? null : i % 17 === 0 ? NaN : i % 19 === 0 ? -0 : i / 8,
  price: i % 7 === 0 ? null : i % 5 === 0 ? `${'9'.repeat(40)}.${i}` : `${i}.${i % 100}`,
  label: i % 6 === 0 ? null : i % 3 === 0 ? `€ ${i} 😀` : i % 29 === 0 ? `${'x'.repeat(70)}${i}` : `L${i % 4}`,
  ok: i % 8 === 0 ? null : i % 2 === 0,
  blob: i % 10 === 0 ? null : Uint8Array.from([i & 255, 1, 2]),
  extra: i % 12 === 0 ? null : { i, tags: ['a', i % 2 === 0] },
});
const rows = Array.from({ length: 300 }, (_, i) => row(i));
const metadata = { source: 'browser-writer.test', note: 'grüße' };
const now = Date.UTC(2026, 9, 5, 12);

/** A seeded stream of bytes (mulberry32), so both writers can be given the same random bytes. */
function seededBytes(seed) {
  let a = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out[i] = (t ^ (t >>> 14)) & 0xff;
    }
    return out;
  };
}

/** Runs fn with both random generators (Node's and the browser's) drawing from the same seeded stream. */
async function withRandom(seed, fn) {
  const take = seededBytes(seed);
  const nodeRandom = crypto.randomBytes;
  const webRandom = globalThis.crypto.getRandomValues;
  crypto.randomBytes = (n) => Buffer.from(take(n));
  globalThis.crypto.getRandomValues = (array) => {
    array.set(take(array.length));
    return array;
  };
  try {
    return await fn();
  } finally {
    crypto.randomBytes = nodeRandom;
    globalThis.crypto.getRandomValues = webRandom;
  }
}

const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());

const LOCKS = [['no key', {}], ['a key', { key: keys.key }], ['a password', { password: 'pass wörd', kdfIterations: 1000 }]];
const SHAPES = [['chunks of 64 rows', rows, { chunkRows: 64 }], ['chunks capped at 2,000 bytes', rows, { chunkBytes: 2000 }], ['no rows', [], {}]];

for (const [lockName, lock] of LOCKS) {
  for (const codec of ['none', 'deflate']) {
    test(`browser writer: the same bytes as the library, ${lockName}, codec ${codec}`, async () => {
      for (const [shapeName, data, shape] of SHAPES) {
        const options = { columns, metadata, now, codec, ...lock, ...shape };
        const expected = await withRandom(7, () => write(null, data, { ...options, maxDegreeOfParallelism: 1 }));
        const actual = await withRandom(7, async () => bytesOf(await JazminBrowser.write(data, options)));
        assert.ok(actual.equals(expected), `${shapeName}: ${actual.length} bytes, the library wrote ${expected.length}`);
      }
    });
  }
}

// Nested columns (spec 5.4): lists and objects, with nulls and empty lists at every level; the same bytes, read alike.
const nestedColumns = [
  { name: 'id', type: 'int', nullable: false },
  {
    name: 'lines', type: 'list', item: {
      type: 'object', fields: [
        { name: 'sku', type: 'string' }, { name: 'qty', type: 'int' }, { name: 'price', type: 'decimal' }, { name: 'at', type: 'datetime' },
        { name: 'ok', type: 'bool' }, { name: 'weight', type: 'float' }, { name: 'blob', type: 'binary' }, { name: 'extra', type: 'json' },
        { name: 'tags', type: 'list', item: { type: 'string', nullable: false } },
      ],
    },
  },
  { name: 'head', type: 'object', fields: [{ name: 'city', type: 'string' }, { name: 'grid', type: 'list', item: { type: 'list', item: { type: 'int' } } }] },
];
const nestedRow = (i) => ({
  id: i,
  lines: i % 7 === 0 ? null : i % 5 === 0 ? [] : Array.from({ length: 1 + (i % 3) }, (_, n) => (n === 1 && i % 2 ? null : {
    sku: n === 2 ? null : `S${i % 11}-${n}`, qty: i % 4 === 0 ? 2n ** 60n : i * 10 + n, price: `${i}.${n}5`, at: new Date(Date.UTC(2025, 0, 1) + i * 60_000),
    ok: n === 0, weight: i % 9 === 0 ? NaN : i / 4, blob: n === 0 ? Uint8Array.from([i & 255, n]) : null, extra: n === 2 ? { i } : null, tags: i % 6 === 0 ? [] : ['a', `t${n}`],
  })),
  head: i % 4 === 0 ? null : { city: i % 3 === 0 ? null : `C${i % 5}`, grid: i % 8 === 0 ? null : [[], [i, null]] },
});
const nestedRows = Array.from({ length: 200 }, (_, i) => nestedRow(i));

test('browser writer: nested columns, the same bytes as the library, and both readers read them', async () => {
  for (const [lockName, lock] of LOCKS) {
    for (const codec of ['none', 'deflate']) {
      for (const shape of [{ chunkRows: 64 }, { chunkBytes: 2000 }]) {
        const options = { columns: nestedColumns, metadata, now, codec, ...lock, ...shape };
        const expected = await withRandom(7, () => write(null, nestedRows, { ...options, maxDegreeOfParallelism: 1 }));
        const actual = await withRandom(7, async () => bytesOf(await JazminBrowser.write(nestedRows, options)));
        assert.ok(actual.equals(expected), `${lockName}, codec ${codec}, ${JSON.stringify(shape)}: ${actual.length} bytes, the library wrote ${expected.length}`);
      }
    }
  }
  // Both readers read the browser's file as the rows written (binary as base64, dates as text, to compare).
  const plain = (v) => (v instanceof Date ? v.toISOString() : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? `${v}n`
    : Array.isArray(v) ? v.map(plain) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
  const bytes = await bytesOf(await JazminBrowser.write(nestedRows, { columns: nestedColumns, chunkRows: 64 }));
  assert.deepEqual(plain([...open(bytes).rows()]), plain(nestedRows));
  const browser = await JazminBrowser.open(new Blob([bytes]));
  const browserRows = [];
  for await (const row of browser.find()) browserRows.push(row);
  assert.deepEqual(plain(browserRows), plain(nestedRows));
  await assert.rejects(JazminBrowser.write([{ id: 1, lines: [{ sku: 5 }] }], { columns: nestedColumns }), /Column 'lines\[\]\.sku': expected a string/);
});

// Embedded files: several per file, identical content stored once, a file of several blocks, an empty one, groups,
// and files added between rows. The library gets the bytes; the browser gets a Blob, a File, a string and an ArrayBuffer.
const photo = Uint8Array.from({ length: 600_000 }, (_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : (i * 31 + 7) & 255)); // three blocks
const attachments = [
  ['r1/receipt.pdf', Buffer.from('%PDF-1.7 receipt'), (b) => new Blob([b])],
  ['r1/photo.jpg', Buffer.from(photo), (b) => new File([b], 'photo.jpg')],
  ['r2/same-photo.jpg', Buffer.from(photo), (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length)], // stored once
  ['empty.txt', Buffer.alloc(0), () => ''],
  ['notes/grüße.txt', Buffer.from('grüße'), () => 'grüße', { type: 'text/x-note', groups: ['P2', 'P1'] }],
];
const libraryFiles = attachments.map(([path, bytes, , extra]) => ({ path, content: bytes, ...extra }));
const browserFiles = attachments.map(([path, bytes, asBrowser, extra]) => ({ path, content: asBrowser(bytes), ...extra }));

test('browser writer: embedded files, the same bytes as the library', async () => {
  for (const [lockName, lock] of LOCKS) {
    for (const codec of ['none', 'deflate']) {
      const options = { columns, metadata, now, codec, chunkRows: 64, ...lock };
      const expected = await withRandom(9, () => {
        const writer = new JazminWriter(null, { ...options, files: libraryFiles.slice(0, 2), maxDegreeOfParallelism: 1 });
        writer.writeRows(rows.slice(0, 100));
        for (const f of libraryFiles.slice(2, 4)) writer.addFile(f);
        writer.addFile(libraryFiles[4].path, libraryFiles[4].content, libraryFiles[4]);
        writer.writeRows(rows.slice(100));
        return writer.finish();
      });
      const actual = await withRandom(9, async () => {
        const writer = await JazminBrowser.createWriter({ ...options, files: browserFiles.slice(0, 2) });
        await writer.writeRows(rows.slice(0, 100));
        for (const f of browserFiles.slice(2, 4)) await writer.addFile(f);
        await writer.addFile(browserFiles[4].path, browserFiles[4].content, browserFiles[4]);
        await writer.writeRows(rows.slice(100));
        return bytesOf(await writer.finish());
      });
      assert.ok(actual.equals(expected), `${lockName}, codec ${codec}: ${actual.length} bytes, the library wrote ${expected.length}`);
    }
  }
});

test('browser writer: both readers read the embedded files it writes', async () => {
  for (const [lockName, lock] of LOCKS) {
    const bytes = await bytesOf(await JazminBrowser.write(rows, { columns, ...lock, files: browserFiles }));
    const reader = open(bytes, lock);
    assert.deepEqual(reader.files.map((f) => [f.path, f.type, f.size]).sort(), [
      ['empty.txt', 'text/plain', 0], ['notes/grüße.txt', 'text/x-note', 7], ['r1/photo.jpg', 'image/jpeg', 600_000],
      ['r1/receipt.pdf', 'application/pdf', 16], ['r2/same-photo.jpg', 'image/jpeg', 600_000],
    ], lockName);
    for (const [path, content] of attachments) assert.ok(reader.readFile(path).equals(content), `${lockName}: ${path}`);
    assert.equal(reader.rowCount, rows.length);
    reader.close();
    const browser = await JazminBrowser.open(new Blob([bytes]), lock);
    assert.ok(Buffer.from(await browser.readFile('r1/photo.jpg')).equals(Buffer.from(photo)), lockName);
    // Identical content is stored once: the file is about one photo bigger than the rows alone.
    const rowsOnly = (await JazminBrowser.write(rows, { columns, ...lock })).size;
    assert.ok(bytes.length - rowsOnly < photo.length * 1.05, `${lockName}: ${bytes.length - rowsOnly} bytes of files`);
  }
});

test('browser writer: the library reads what it writes, and refuses a wrong key or password', async () => {
  const expected = [...open(write(null, rows, { columns })).rows()];
  for (const [lockName, lock] of LOCKS) {
    const bytes = await bytesOf(await JazminBrowser.write(rows, { columns, metadata, chunkRows: 50, ...lock }));
    const reader = open(bytes, lock);
    assert.deepEqual([...reader.rows()], expected, lockName);
    assert.deepEqual(reader.metadata, metadata, lockName);
    assert.deepEqual(reader.columns.map((c) => [c.name, c.type, c.nullable, c.description]), columns.map((c) => [c.name, c.type, c.nullable !== false, c.description]));
    assert.equal(reader.count({ amount: { gt: 20 } }), [...open(write(null, rows, { columns })).find({ amount: { gt: 20 } })].length, lockName);
    reader.close();
    if (lock.key) assert.throws(() => open(bytes, { key: JazminKey.generate() }), /key/i);
    if (lock.password) assert.throws(() => open(bytes, { password: 'wrong' }), /password|key/i);
    // ... and the browser reader too.
    const browser = await JazminBrowser.open(new Blob([bytes]), lock);
    assert.equal(browser.rowCount, rows.length);
    assert.deepEqual(browser.writtenAt, open(bytes, lock).writtenAt, lockName);
  }
});

test('browser writer: a file sent back with the submission key opens with the key the owner derives', async () => {
  const owner = JazminKey.parse(keys.key);
  const bob = JazminAccessKey.parse(keys.bob);
  const shared = write(null, [{ id: 0, person: 'P1' }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }], key: owner, access: { partitionBy: 'person', grants: [{ key: bob, rows: ['P1'] }] },
  });
  const { submissionKey } = await JazminBrowser.open(new Blob([shared]), { key: keys.bob });
  const batch = await bytesOf(await JazminBrowser.write([{ id: 1, person: 'P1' }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }], key: submissionKey,
  }));
  assert.deepEqual([...open(batch, { key: owner.submissionKey(bob.id) }).rows()], [{ id: 1, person: 'P1' }]);
  assert.throws(() => open(batch, { key: owner.submissionKey(JazminAccessKey.parse(keys.sally).id) }), /key/i);
});

test('browser writer: refuses what browsers must not or cannot write', async () => {
  const one = [{ name: 'id', type: 'int' }];
  const refuses = (options, pattern) => assert.rejects(JazminBrowser.createWriter({ columns: one, ...options }), pattern);
  await refuses({ key: keys.key, access: { partitionBy: 'id' } }, /master key must stay off web pages/);
  await refuses({ key: keys.bob }, /An access key can't write a file: lock what you send back with your submission key/);
  await refuses({ tables: [] }, /Several tables/);
  await refuses({ package: { title: 'x' } }, /package settings/);
  await refuses({ files: {} }, /files must be an array/);
  await refuses({ files: [{ path: '../x.pdf', content: 'a' }] }, /Invalid file path/);
  await refuses({ files: [{ path: 'a.pdf', file: 'C:/a.pdf' }] }, /browsers have no file paths/);
  await refuses({ files: [{ path: 'a.pdf', content: 42 }] }, /content must be a Blob/);
  await refuses({ files: [{ path: 'a.pdf', content: 'a' }, { path: 'a.pdf', content: 'b' }] }, /File 'a.pdf' is added twice/);
  await refuses({ sortedBy: ['id'] }, /sortedBy/);
  await refuses({ codec: 'brotli' }, /Brotli/);
  await refuses({ level: 9 }, /level/);
  await refuses({ nope: 1 }, /Unknown option 'nope'/);
  await refuses({ key: keys.key, password: 'x' }, /either key or password/);
  await refuses({ password: 'x', kdfIterations: 10 }, /kdfIterations/);
  await assert.rejects(JazminBrowser.createWriter({ columns: [{ name: 'id', type: 'int', index: 'sorted' }] }), /indexes are not written in browsers/);
  const writer = await JazminBrowser.createWriter({ columns: [{ name: 'id', type: 'int', nullable: false }] });
  await assert.rejects(writer.writeRow({ id: null }), /not nullable/);
  await assert.rejects(writer.writeRow({ id: 1, other: 2 }), /unknown column 'other'/);
  await assert.rejects(writer.writeRow({ id: 1.5 }), /expected an integer/);
  const pending = writer.writeRows([{ id: 1 }, { id: 2 }]);
  await assert.rejects(writer.writeRow({ id: 3 }), /Await the previous call/);
  await pending;
  assert.equal(open(await bytesOf(await writer.finish())).rowCount, 2);
  await assert.rejects(writer.writeRow({ id: 4 }), /already finished/);
});
