import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, JazminKey, accessKeyOf, open, write } from '../src/index.js';
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
  }
});

test('browser writer: an outbox batch written in the browser opens with the key the owner derives', async () => {
  const shared = path.join(fixtures, 'js-access.jzm');
  const outboxKey = await JazminBrowser.outboxKey(keys.bob);
  const batch = await bytesOf(await JazminBrowser.write([{ id: 1, note: 'captured offline' }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'note', type: 'string' }], key: outboxKey,
  }));
  const sender = accessKeyOf(shared, keys.key, JazminAccessKey.parse(keys.bob).id);
  assert.deepEqual([...open(batch, { key: sender.outboxKey() }).rows()], [{ id: 1, note: 'captured offline' }]);
  assert.throws(() => open(batch, { key: JazminAccessKey.parse(keys.sally).outboxKey() }), /key/i);
});

test('browser writer: refuses what browsers must not or cannot write', async () => {
  const one = [{ name: 'id', type: 'int' }];
  const refuses = (options, pattern) => assert.rejects(JazminBrowser.createWriter({ columns: one, ...options }), pattern);
  await refuses({ key: keys.key, access: { partitionBy: 'id' } }, /master key must stay off web pages/);
  await refuses({ key: keys.bob }, /An access key can't write a file: write an outbox file/);
  await refuses({ tables: [] }, /Several tables/);
  await refuses({ files: [] }, /Embedded files/);
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
