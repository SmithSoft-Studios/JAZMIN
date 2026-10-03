import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteReader, ByteWriter, crc32, crc32Bytewise, crc32Sliced } from '../src/binary.js';

test('varUint round-trips small, large and BigInt values', () => {
  const values = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 49, Number.MAX_SAFE_INTEGER, 2n ** 63n, 2n ** 64n - 1n];
  const w = new ByteWriter(4);
  for (const v of values) w.varUint(v);
  const r = new ByteReader(w.toBuffer());
  for (const v of values) {
    const expected = typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    assert.equal(r.varUint(), expected);
  }
  assert.ok(r.eof);
});

test('varInt uses ZigZag and covers the full int64 range', () => {
  const values = [0, -1, 1, -64, 64, -(2 ** 40), 2 ** 52 - 1, -(2 ** 53) + 1, -(2n ** 63n), 2n ** 63n - 1n];
  const w = new ByteWriter();
  for (const v of values) w.varInt(v);
  const r = new ByteReader(w.toBuffer());
  for (const v of values) assert.equal(r.varInt(), v);
});

test('small negative numbers encode in one byte', () => {
  const w = new ByteWriter();
  w.varInt(-1);
  assert.deepEqual([...w.toBuffer()], [1]);
});

test('strings round-trip as UTF-8', () => {
  const w = new ByteWriter();
  w.string('héllo 👋');
  assert.equal(new ByteReader(w.toBuffer()).string(), 'héllo 👋');
});

test('reading past the end throws', () => {
  assert.throws(() => new ByteReader(Buffer.from([0x80])).varUint(), /Unexpected end/);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('fast CRC-32 implementations match the byte-wise reference on all lengths and alignments', () => {
  const data = Buffer.from(Array.from({ length: 1100 }, (_, i) => (i * 7919 + 13) & 0xff));
  for (let start = 0; start < 9; start++) {
    for (let length = 0; length < 1000; length += 13) {
      const slice = data.subarray(start, start + length);
      const expected = crc32Bytewise(slice);
      assert.equal(crc32Sliced(slice), expected);
      assert.equal(crc32(slice), expected);
    }
  }
});
