import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFormatError, JazminKey, append, compact, open, update, write } from '../src/index.js';
import { ByteWriter } from '../src/binary.js';
import { ENCODING, columnBuffer, decodeColumnar, encodeColumnBuffers, encodeColumnar } from '../src/columnar.js';
import { MAGIC } from '../src/constants.js';
import { compileFilter } from '../src/filter.js';

const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'big', type: 'int' },
  { name: 'flag', type: 'bool' },
  { name: 'amount', type: 'float' },
  { name: 'price', type: 'decimal' },
  { name: 'country', type: 'string' },
  { name: 'note', type: 'string' },
  { name: 'when', type: 'datetime' },
  { name: 'blob', type: 'binary' },
  { name: 'tags', type: 'json' },
];

const floats = [0, -0, 1.5, 12.34, -0.01, 0.1 + 0.2, 1e300, -1e-300, NaN, Infinity, -Infinity, 123456789.123, 2 ** 53];
const rows = Array.from({ length: 700 }, (_, i) => ({
  id: i,
  big: i % 50 === 0 ? null : i % 7 === 0 ? 2n ** 63n - 1n : i % 11 === 0 ? -(2n ** 63n) : i * 1000,
  flag: i % 9 === 0 ? null : i % 3 === 0,
  amount: i % 13 === 0 ? null : floats[i % floats.length],
  price: i % 4 === 0 ? null : (i % 5 === 0 ? '-0.05' : `${i}.10`),
  country: ['ZA', 'NA', 'BW'][i % 3],
  note: i % 6 === 0 ? null : `note ${i} 👋 é`,
  when: i % 8 === 0 ? null : new Date(Date.UTC(2020, 0, 1) + i * 60_000),
  blob: i % 5 === 0 ? null : Buffer.from([i & 255, 1, 2]),
  tags: i % 10 === 0 ? null : { i, list: ['a', i] },
}));

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-col-')), name);
const plainRows = (r) => [...r.rows()];

test('every type and edge value round-trips exactly', () => {
  const col = open(write(null, rows, { columns, chunkRows: 256 }));
  const fromColumnar = plainRows(col);
  assert.deepEqual(fromColumnar, rows); // strict: -0 and 0 differ, NaN equals NaN
  assert.ok(Object.is(fromColumnar[1].amount, -0));
  assert.ok(Number.isNaN(fromColumnar[8].amount));
  assert.equal(fromColumnar[5].amount, 0.1 + 0.2);
  assert.equal(fromColumnar[7].big, 2n ** 63n - 1n);
  assert.equal(fromColumnar[11].big, -(2n ** 63n));
  assert.equal(fromColumnar[1].note, 'note 1 👋 é');
  for (let i = 0; i < rows.length; i += 97) assert.deepEqual(col.get(i), rows[i]);
});

test('typed column buffers encode the same bytes as the reference encoder', () => {
  const types = ['int', 'int', 'bool', 'float', 'decimal', 'string', 'string', 'datetime', 'binary', 'json', 'string', 'string', 'int', 'int'];
  const value = (j, i, n) => {
    switch (j) {
      case 0: return i * 3;
      case 1: return i % 50 === 0 ? null : i === Math.floor(n / 2) ? 2n ** 63n - 1n : i * 1000; // a BigInt mid-chunk
      case 2: return i % 9 === 0 ? null : i % 3 === 0;
      case 3: return i % 13 === 0 ? null : floats[i % floats.length];
      case 4: return i % 4 === 0 ? null : `${i % 7}.10`;
      case 5: return ['ZA', 'NA', 'BW'][i % 3];
      case 6: return i % 6 === 0 ? null : `note ${i} 👋 é`;
      case 7: return i % 8 === 0 ? null : Date.UTC(2020, 0, 1) + i * 60_000;
      case 8: return i % 5 === 0 ? null : Buffer.from([i & 255, 1, 2]);
      case 9: return i % 10 === 0 ? null : JSON.stringify({ i });
      case 10: return null; // all null
      case 11: return `v${i % Math.ceil(n / 2)}`; // exactly half distinct: dictionary just qualifies
      case 12: return i % 2 ? 2 ** 60 : -5; // a large plain number
      default: return i === 3 ? null : i; // one early null in a long chunk: the bitmap is still full length
    }
  };
  for (const maxRows of [1, 2, 7, 64, 256, 1000]) {
    const buffers = types.map((t) => columnBuffer(t, maxRows));
    for (const n of [maxRows, Math.max(1, maxRows - 1), maxRows]) { // buffers are reused across chunks
      const columnValues = types.map((_, j) => Array.from({ length: n }, (_, i) => value(j, i, n)));
      for (let i = 0; i < n; i++) types.forEach((_, j) => (columnValues[j][i] === null ? buffers[j].addNull() : buffers[j].add(columnValues[j][i])));
      const expected = Buffer.from(encodeColumnar(types, columnValues, n));
      assert.deepEqual(Buffer.from(encodeColumnBuffers(buffers)), expected, `maxRows ${maxRows}, ${n} rows`);
    }
  }
});

test('files are small on repetitive data and start with the format 1.0 magic', () => {
  const data = Array.from({ length: 20_000 }, (_, i) => ({ id: i, country: ['ZA', 'NA'][i % 2], amount: (i % 1000) / 100, when: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000) }));
  const cols = [{ name: 'id', type: 'int' }, { name: 'country', type: 'string' }, { name: 'amount', type: 'float' }, { name: 'when', type: 'datetime' }];
  const file = write(null, data, { columns: cols });
  const json = Buffer.byteLength(JSON.stringify(data));
  assert.ok(file.length < json * 0.1, `${file.length} vs ${json} bytes of JSON`);
  assert.ok(file.subarray(0, 4).equals(MAGIC));
  assert.throws(() => write(null, data, { columns: cols, layout: 'row' }), /'row' layout no longer exists/);
});

test('select reads only the chosen columns, with the same values', () => {
  const r = open(write(null, rows, { columns }));
  const all = plainRows(r);
  assert.deepEqual([...r.rows({ select: ['note', 'id'] })], all.map((x) => ({ note: x.note, id: x.id })));
  assert.deepEqual([...r.find({ country: 'NA' }, { select: ['id'] })].map((x) => x.id), all.filter((x) => x.country === 'NA').map((x) => x.id));
});

test('filters (decoding only the columns they use) return exactly the matching rows', () => {
  const col = open(write(null, rows, { columns, chunkRows: 128 }));
  const all = plainRows(col);
  const expected = (filter, { select, offset = 0, limit = Infinity }) => all
    .filter(compileFilter(filter, columns))
    .slice(offset, offset + limit)
    .map((x) => (select ? Object.fromEntries(select.map((name) => [name, x[name]])) : x));
  const filters = [
    { country: 'NA' },
    { country: 'ZA', flag: true },
    { or: [{ amount: { gt: 100 } }, { note: null }] },
    { not: { country: { in: ['ZA', 'BW'] } } },
    { when: { gte: new Date(Date.UTC(2020, 0, 1, 5)) }, price: { isNull: false } },
    { note: { icontains: 'NOTE 1' } },
  ];
  for (const filter of filters) {
    for (const options of [{}, { select: ['id', 'tags'] }, { offset: 3, limit: 7 }, { select: ['note'], limit: 2 }]) {
      assert.deepEqual([...col.find(filter, options)], expected(filter, options), JSON.stringify({ filter, options }));
    }
  }
});

test('chunk statistics (loaded per column, when a query needs them) skip chunks', () => {
  const data = Array.from({ length: 5000 }, (_, i) => ({ id: i, country: ['ZA', 'NA'][i % 2], amount: i / 4 }));
  const cols = [{ name: 'id', type: 'int' }, { name: 'country', type: 'string' }, { name: 'amount', type: 'float' }];
  const col = open(write(null, data, { columns: cols, sortedBy: ['id'], chunkRows: 100 }));
  const cases = [
    [{ id: 4321 }, 49],
    [{ id: { gte: 4900 } }, 49],
    [{ amount: { lt: 10 } }, 49], // amount < 10: rows 0-39, all in chunk 0
    [{ country: 'ZA', id: { lt: 300 } }, 47],
  ];
  for (const [filter, skipped] of cases) {
    assert.deepEqual(col.explain(filter), { strategy: 'scan', chunks: 50, chunksSkipped: skipped }, JSON.stringify(filter));
    assert.deepEqual([...col.find(filter)], data.filter(compileFilter(filter, cols)));
  }
});

test('encrypted and access-controlled columnar files read back per key', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const data = rows.map((r) => ({ ...r, group: r.id < 350 ? 'A' : 'B' }));
  const cols = [...columns, { name: 'group', type: 'string' }];
  const file = write(null, data, {
    columns: cols, key: owner, sortedBy: ['group', 'id'],
    access: { partitionBy: 'group', columnGroups: { money: ['amount', 'price'] }, grants: [{ key: bob, rows: ['B'], columns: ['*'] }] },
  });
  const bobView = plainRows(open(file, { key: bob.toString(), accessState: false }));
  assert.equal(bobView.length, 350);
  assert.equal(bobView[0].id, 350);
  assert.equal('amount' in bobView[0], false);
  assert.deepEqual(plainRows(open(file, { key: owner })), data);
});

test('append, compact and update keep every value', () => {
  const file = tmp('col.jzm');
  write(file, rows.slice(0, 300), { columns });
  append(file, { insert: rows.slice(300, 400), delete: { id: { lt: 10 } } });
  let r = open(file);
  assert.deepEqual(plainRows(r), rows.slice(10, 400));
  r.close();
  compact(file, {});
  r = open(file);
  assert.deepEqual(plainRows(r), rows.slice(10, 400));
  r.close();
  assert.throws(() => update(file, { layout: 'row' }), /'row' layout no longer exists/);
  update(file, { insert: rows.slice(400, 410) });
  r = open(file);
  assert.deepEqual(plainRows(r), rows.slice(10, 410));
  r.close();
});

test('malformed column streams are rejected', () => {
  const good = encodeColumnar(['string'], [['a', 'a', 'a', 'b']], 4);
  assert.deepEqual(decodeColumnar(good, ['string'], 4, 0), [['a', 'a', 'a', 'b']]);
  const stream = (flags, body) => {
    const w = new ByteWriter();
    w.varUint(1 + body.length);
    w.byte(flags);
    w.bytes(Buffer.from(body));
    return w.toBuffer();
  };
  assert.throws(() => decodeColumnar(stream(9, []), ['int'], 0, 0), JazminFormatError); // unknown encoding
  assert.throws(() => decodeColumnar(stream(ENCODING.dictionary, []), ['int'], 0, 0), /not valid for a int/);
  assert.throws(() => decodeColumnar(stream(0x20, []), ['int'], 0, 0), /reserved/);
  assert.throws(() => decodeColumnar(stream(ENCODING.dictionary, [1, 1, 0x61, 3]), ['string'], 1, 0), /out of range/);
  assert.throws(() => decodeColumnar(Buffer.concat([good, Buffer.from([0])]), ['string'], 4, 0), JazminFormatError);
  assert.throws(() => decodeColumnar(stream(ENCODING.plain, [2]), ['int'], 2, 0), JazminFormatError); // too short
  // A dictionary of 2³² entries: more than the stream holds, and more than an array can (a RangeError before).
  const huge = [0x80, 0x80, 0x80, 0x80, 0x10, 1, 0x61, 0];
  assert.throws(() => decodeColumnar(stream(ENCODING.dictionary, huge), ['string'], 1, 0), /invalid dictionary size/);
});
