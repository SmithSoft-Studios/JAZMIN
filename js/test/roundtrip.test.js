import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminFormatError, JazminKey, JazminKeyError, JazminValidationError, JazminWriter, inferSchema, open, write,
} from '../src/index.js';
import { crc32 } from '../src/binary.js';
import { decodeHeader, encodeHeader } from '../src/catalog.js';
import { MAGIC, TRAILER_SIZE } from '../src/constants.js';
import { decodeSection, encodeSection } from '../src/section.js';

const columns = [
  { name: 'id', type: 'int', nullable: false, description: 'Primary key' },
  { name: 'name', type: 'string' },
  { name: 'active', type: 'bool' },
  { name: 'score', type: 'float' },
  { name: 'balance', type: 'decimal' },
  { name: 'joined', type: 'datetime' },
  { name: 'avatar', type: 'binary' },
  { name: 'tags', type: 'json' },
];

const sample = [
  {
    id: 1, name: 'Ann', active: true, score: 9.5, balance: '1234.50', joined: new Date('2024-01-02T03:04:05.678Z'),
    avatar: Buffer.from([1, 2, 3]), tags: ['a', { b: 1 }],
  },
  { id: 2, name: null, active: false, score: -0.25, balance: '-0.01', joined: null, avatar: null, tags: null },
  { id: 2n ** 62n, name: 'Zoë 👋', active: null, score: null, balance: null, joined: new Date(0), avatar: Buffer.alloc(0), tags: {} },
];

function tmp(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-')), name);
}

test('every data type round-trips through an in-memory file', () => {
  const buf = write(null, sample, { columns, metadata: { source: 'test' } });
  const reader = open(buf);
  assert.equal(reader.rowCount, 3);
  assert.deepEqual(reader.metadata, { source: 'test' });
  assert.equal(reader.columns[0].description, 'Primary key');
  assert.deepEqual([...reader.rows()], sample.map((r) => ({ ...r, avatar: r.avatar && Buffer.from(r.avatar) })));
});

test('rows spread over many chunks are read back in order, and get() is random access', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `n${i}` }));
  const file = tmp('many.jzm');
  write(file, rows, { chunkRows: 64 });
  const reader = open(file);
  assert.equal(reader.chunkCount, Math.ceil(1000 / 64));
  assert.deepEqual([...reader.rows()], rows);
  assert.deepEqual(reader.get(777), { id: 777, name: 'n777' });
  reader.close();
});

test('an empty file is valid', () => {
  const reader = open(write(null, [], { columns: [{ name: 'x', type: 'int' }] }));
  assert.equal(reader.rowCount, 0);
  assert.deepEqual([...reader.rows()], []);
});

test('compression makes repetitive data much smaller than JSON', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, country: i % 3 ? 'South Africa' : 'Namibia', amount: i * 1.5 }));
  const json = Buffer.byteLength(JSON.stringify(rows));
  for (const codec of ['deflate', 'brotli']) {
    const size = write(null, rows, { codec }).length;
    assert.ok(size < json / 4, `${codec}: ${size} bytes vs JSON ${json}`);
  }
  assert.deepEqual([...open(write(null, rows, { codec: 'none' })).rows()], rows);
});

test('schema inference', () => {
  const schema = inferSchema([{ a: 1, b: 'x', c: 1 }, { a: 2.5, c: null, d: [1] }]);
  assert.deepEqual(schema, [
    { name: 'a', type: 'float', nullable: false },
    { name: 'b', type: 'string', nullable: true },
    { name: 'c', type: 'int', nullable: true },
    { name: 'd', type: 'json', nullable: true },
  ]);
});

test('writer validates rows against the schema', () => {
  const w = new JazminWriter(null, { columns });
  assert.throws(() => w.writeRow({ id: 'x' }), JazminValidationError);
  assert.throws(() => w.writeRow({ id: 1, nme: 'typo' }), /unknown column 'nme'/);
  assert.throws(() => w.writeRow({ name: 'no id' }), /not nullable/);
  assert.throws(() => w.writeRow({ id: 1, balance: '1e5' }), /decimal/);
});

test('encrypted with a key: readable only with that key', () => {
  const key = JazminKey.generate();
  const buf = write(null, sample, { columns, key, metadata: { owner: 'secret-team' } });
  assert.ok(!buf.includes(Buffer.from('secret-team')), 'metadata must not appear in plaintext');
  assert.ok(!buf.includes(Buffer.from('Ann')), 'data must not appear in plaintext');

  const reader = open(buf, { key: key.toString() });
  assert.ok(reader.encrypted);
  assert.equal([...reader.rows()].length, 3);
  assert.throws(() => open(buf), JazminKeyError);
  assert.throws(() => open(buf, { key: JazminKey.generate() }), JazminKeyError);
});

test('encrypted with a password', () => {
  const buf = write(null, sample, { columns, password: 'correct horse', kdfIterations: 1000 });
  assert.equal(open(buf, { password: 'correct horse' }).get(0).name, 'Ann');
  assert.throws(() => open(buf, { password: 'wrong' }), JazminKeyError);
});

test('supplying a key for an unencrypted file is an error (no silent downgrade)', () => {
  const buf = write(null, sample, { columns });
  assert.throws(() => open(buf, { key: JazminKey.generate() }), /not encrypted/);
});

test('corruption is detected', () => {
  const buf = Buffer.from(write(null, sample, { columns }));
  assert.throws(() => open(buf.subarray(0, buf.length - 3)), JazminFormatError);
  const damaged = Buffer.from(buf);
  damaged[80] ^= 0xff; // inside the first chunk payload
  assert.throws(() => [...open(damaged).rows()], JazminFormatError);
  const notJazmin = Buffer.from(buf);
  notJazmin[0] = 0;
  assert.throws(() => open(notJazmin), /bad magic/);
});

test('full scans (direct chunk decoding) return exactly what row-by-row reads return', () => {
  const many = Array.from({ length: 9000 }, (_, i) => ({ ...sample[i % 3], id: i }));
  const key = JazminKey.generate();
  for (const options of [{}, { key }]) {
    const buf = Buffer.from(write(null, many, { columns, ...options }));
    const r = open(buf, options);
    const viaGet = Array.from({ length: r.rowCount }, (_, i) => r.get(i));
    assert.deepEqual([...r.rows()], viaGet);
    assert.deepEqual([...r.rows({ select: ['tags', 'id'] })], viaGet.map((row) => ({ tags: row.tags, id: row.id })));
    assert.deepEqual([...r.rows({ limit: 5 })], viaGet.slice(0, 5));
    assert.deepEqual([...r.rows({ offset: 2, limit: 3 })], viaGet.slice(2, 5)); // offset uses the general path
    assert.deepEqual(Object.keys([...r.rows({ select: ['tags', 'id'] })][0]), ['tags', 'id']);
    r.close();
  }
});

test('a file that needs an unknown reader feature is refused, not misread', () => {
  // Rewrites the (unencrypted) header with a reader feature this library does not know, and a fresh trailer.
  const buf = Buffer.from(write(null, sample, { columns }));
  const trailer = buf.subarray(buf.length - TRAILER_SIZE);
  const headerOffset = Number(trailer.readBigUInt64LE(0));
  const header = decodeHeader(decodeSection(buf.subarray(headerOffset, headerOffset + trailer.readUInt32LE(8)), { sectionId: 'header' }));
  header.readerFeatures = ['pages'];
  const section = encodeSection(encodeHeader(header), { sectionId: 'header' });
  const newTrailer = Buffer.alloc(TRAILER_SIZE);
  newTrailer.writeBigUInt64LE(BigInt(headerOffset), 0);
  newTrailer.writeUInt32LE(section.length, 8);
  newTrailer.writeUInt32LE(crc32(newTrailer.subarray(0, 36)), 36);
  MAGIC.copy(newTrailer, 40);
  const changed = Buffer.concat([buf.subarray(0, headerOffset), section, newTrailer]);
  assert.throws(() => open(changed), /needs the 'pages' feature/);
});

test('files in a pre-release draft format are refused with a clear message', () => {
  const buf = Buffer.from(write(null, sample, { columns }));
  buf.write('JZMN', 0, 'ascii');
  assert.throws(() => open(buf), /pre-release JAZMIN draft format/);
});

test('swapping two encrypted chunks is detected', () => {
  const key = JazminKey.generate();
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: i }));
  // No compression, so both chunks have identical length and swapping keeps every offset valid.
  const buf = Buffer.from(write(null, rows, { key, chunkRows: 2, codec: 'none' }));
  const first = 64;
  const len = buf.readUInt32LE(first + 8) + 16;
  const a = Buffer.from(buf.subarray(first, first + len));
  const b = Buffer.from(buf.subarray(first + len, first + 2 * len));
  assert.equal(a.length, b.length);
  b.copy(buf, first);
  a.copy(buf, first + len);
  assert.throws(() => [...open(buf, { key }).rows()], JazminKeyError);
});
