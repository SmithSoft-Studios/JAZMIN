import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminWriter, open, write, writeAsync } from '../src/index.js';
import { HELD, REGROUP_LIMITS } from '../src/writer.js';

// write({ regroup: true }) (issue #275): in an access-controlled file a chunk holds one partition, so rows of many
// partitions in turn make a chunk of nearly every row. With regroup the writer holds rows per partition (a bounded
// number) and writes a partition's rows together: stored rows are grouped by partition, each partition's rows in their
// input order. Mirrors dotnet/tests/Jazmin.Tests/WriteRegroupTests.cs.

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-write-regroup-')), name);
const owner = JazminKey.generate();
const durban = owner.createAccessKey();
const cape = owner.createAccessKey();
const head = owner.createAccessKey();
const CITIES = ['Durban', 'Cape Town', 'Johannesburg', 'Pretoria', 'Bloemfontein', 'Gqeberha', 'East London', 'Polokwane'];
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'city', type: 'string', nullable: false },
  { name: 'amount', type: 'int' },
  { name: 'note', type: 'string' },
];
const access = {
  partitionBy: 'city',
  columnGroups: { private: ['note'] },
  grants: [
    { key: durban, rows: ['Durban'], columns: ['*', 'private'] },
    { key: cape, rows: ['Cape Town'], columns: ['*'] },
    { key: head, rows: '*', columns: ['*', 'private'] },
  ],
};

/** `n` rows with the cities in a seeded random order (the same rows as the .NET tests). */
function cityRows(n, seed = 1) {
  let s = seed;
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) >> 16; // the high bits: the low ones repeat
  return Array.from({ length: n }, (_, i) => ({ id: i, city: CITIES[next() % CITIES.length], amount: next() % 100000, note: `note ${i}` }));
}

const ids = (rows) => rows.map((r) => r.id);
const sorted = (list) => [...list].sort((a, b) => a - b);

function readAll(file, key) {
  const reader = open(file, { key });
  try {
    return { rows: [...reader.rows()], chunks: reader.chunkCount, columns: reader.columns.map((c) => c.name) };
  } finally {
    reader.close();
  }
}

test('write regroup: interleaved partitions are stored a partition at a time, each in as few chunks as its rows need', () => {
  const rows = cityRows(800);
  const plain = tmp('interleaved.jzm');
  write(plain, rows, { columns, key: owner, access, chunkRows: 64 });
  const grouped = tmp('regrouped.jzm');
  write(grouped, rows, { columns, key: owner, access, chunkRows: 64, regroup: true });

  const before = readAll(plain, owner);
  assert.deepEqual(ids(before.rows), ids(rows)); // off by default: input order, as before
  assert.ok(before.chunks > 600, `${before.chunks} chunks`);

  const after = readAll(grouped, owner);
  const perCity = CITIES.map((c) => rows.filter((r) => r.city === c).length);
  assert.equal(after.chunks, perCity.reduce((n, k) => n + Math.ceil(k / 64), 0));
  assert.deepEqual(sorted(ids(after.rows)), ids(rows));
  for (const city of CITIES) { // each partition's rows in their input order
    assert.deepEqual(ids(after.rows.filter((r) => r.city === city)), ids(rows.filter((r) => r.city === city)), city);
  }
  assert.ok(fs.statSync(grouped).size * 4 < fs.statSync(plain).size, 'the regrouped file is much smaller');

  // advise() points at the option for the interleaved file, and has nothing to suggest for the regrouped one.
  const advice = (file) => {
    const reader = open(file, { key: owner });
    try {
      return reader.advise().suggestions;
    } finally {
      reader.close();
    }
  };
  assert.ok(advice(plain).some((s) => s.includes('write() with regroup: true')), advice(plain).join('\n'));
  assert.deepEqual(advice(grouped), []);
});

test('write regroup: each key sees exactly its partitions and column groups', () => {
  const rows = cityRows(800);
  const file = tmp('keys.jzm');
  write(file, rows, { columns, key: owner, access, chunkRows: 64, regroup: true });
  const expect = (city) => rows.filter((r) => city === undefined || r.city === city);

  const d = readAll(file, durban.export());
  assert.deepEqual(d.columns, ['id', 'city', 'amount', 'note']);
  assert.deepEqual(d.rows, expect('Durban'));
  const c = readAll(file, cape.export());
  assert.deepEqual(c.columns, ['id', 'city', 'amount']);
  assert.deepEqual(c.rows, expect('Cape Town').map(({ note, ...rest }) => rest));
  const h = readAll(file, head.export());
  assert.deepEqual(h.columns, ['id', 'city', 'amount', 'note']);
  assert.deepEqual(sorted(ids(h.rows)), ids(rows));
  for (const city of CITIES) assert.deepEqual(h.rows.filter((r) => r.city === city), expect(city), city);

  // Lookups by the owner's index find rows by their new row numbers.
  const reader = open(file, { key: owner });
  try {
    for (const id of [0, 399, 799]) assert.deepEqual([...reader.find({ id })], [rows[id]], `id ${id}`);
    assert.equal(reader.count({ city: 'Durban' }), expect('Durban').length);
  } finally {
    reader.close();
  }
});

test('write regroup: a sortedBy must start with the partition column', () => {
  const rows = cityRows(20);
  assert.throws(() => write(tmp('by-id.jzm'), rows, { columns, key: owner, access, sortedBy: ['id'], regroup: true }),
    /regroup would break the sortedBy order \[id\]: it needs no sortedBy, or one that starts with the partition column 'city'/);
  // Sorted by the partition column first: rows already arrive grouped, and are written as given.
  const byCity = [...rows].sort((a, b) => (a.city < b.city ? -1 : a.city > b.city ? 1 : a.id - b.id));
  const file = tmp('by-city.jzm');
  write(file, byCity, { columns, key: owner, access, sortedBy: ['city', 'id'], regroup: true });
  assert.deepEqual(ids(readAll(file, owner).rows), ids(byCity));
});

test('write regroup: needs an access-controlled file with partitionBy, and true or false', () => {
  const rows = cityRows(5);
  assert.throws(() => write(tmp('plain.jzm'), rows, { columns, regroup: true }), /regroup applies to access-controlled files with partitionBy/);
  assert.throws(() => write(tmp('no-partitions.jzm'), rows, { columns, key: owner, access: { grants: [] }, regroup: true }),
    /regroup applies to access-controlled files with partitionBy/);
  assert.throws(() => write(tmp('yes.jzm'), rows, { columns, key: owner, access, regroup: 'yes' }), /regroup must be true or false/);
  const file = tmp('off.jzm');
  write(file, rows, { columns, regroup: false }); // false is the default, and allowed anywhere
  assert.deepEqual(ids(readAll(file).rows), ids(rows));
});

test('write regroup: the rows held stay within the limits, by rows and by bytes', () => {
  // Rows: at most 100 held.
  const file = tmp('rows-limit.jzm');
  const writer = new JazminWriter(file, { columns, key: owner, access, regroup: true, [REGROUP_LIMITS]: { rows: 100, bytes: 1e9 } });
  const rows = cityRows(3000);
  let most = 0;
  for (const row of rows) {
    writer.writeRow(row);
    most = Math.max(most, writer[HELD].rows);
    assert.ok(writer[HELD].rows < 100);
  }
  assert.ok(most >= 50, `held up to ${most} rows`);
  assert.equal(writer.rowCount, rows.length); // rows given, held ones included
  writer.finish();
  assert.deepEqual(sorted(ids(readAll(file, owner).rows)), ids(rows));

  // Bytes: wide rows, at most 20,000 estimated bytes held (about 19 rows of 1,000 characters).
  const wide = tmp('bytes-limit.jzm');
  const w = new JazminWriter(wide, { columns, key: owner, access, regroup: true, [REGROUP_LIMITS]: { rows: 1e9, bytes: 20000 } });
  for (const row of cityRows(500)) {
    w.writeRow({ ...row, note: 'x'.repeat(1000) });
    assert.ok(w[HELD].bytes < 20000);
    assert.ok(w[HELD].rows < 20);
  }
  w.finish();
  assert.equal(readAll(wide, owner).rows.length, 500);
});

test('write regroup: the default limits hold a streamed input to at most 65,536 rows', () => {
  // 100 partitions: 100 chunks of 4,096 rows would be more than the limit, so it is reached, and half is written out.
  const file = tmp('streamed.jzm');
  const writer = new JazminWriter(file, { columns, key: owner, access, regroup: true });
  function* generate() {
    let s = 7;
    for (let i = 0; i < 150000; i++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      yield { id: i, city: `P${(s >> 16) % 100}`, amount: i, note: `note ${i}` };
    }
  }
  let most = 0;
  for (const row of generate()) {
    writer.writeRow(row);
    most = Math.max(most, writer[HELD].rows);
  }
  assert.ok(most < 65536 && most > 60000, `held up to ${most} rows`);
  writer.finish();
  const { rows, chunks } = readAll(file, owner);
  assert.equal(rows.length, 150000);
  assert.deepEqual(sorted(ids(rows)), ids(rows.map((_, i) => ({ id: i }))));
  assert.ok(chunks < 600, `${chunks} chunks`); // as given: nearly a chunk a row
});

test('write regroup: writeAsync with an async source, and the row numbers in errors are the input order', async () => {
  const rows = cityRows(800);
  async function* source() {
    for (const row of rows) yield row;
  }
  const file = tmp('async.jzm');
  await writeAsync(file, source(), { columns, key: owner, access, chunkRows: 64, regroup: true });
  const { rows: read, chunks } = readAll(file, owner);
  assert.equal(chunks, CITIES.reduce((n, c) => n + Math.ceil(rows.filter((r) => r.city === c).length / 64), 0));
  for (const city of CITIES) assert.deepEqual(read.filter((r) => r.city === city), rows.filter((r) => r.city === city), city);

  const bad = rows.slice(0, 10).map((r, i) => (i === 7 ? { ...r, colour: 'red' } : r));
  assert.throws(() => write(tmp('bad.jzm'), bad, { columns, key: owner, access, regroup: true }), /Row 7: unknown column 'colour'/);
  const missing = rows.slice(0, 10).map((r, i) => (i === 6 ? { ...r, id: null } : r));
  assert.throws(() => write(tmp('null.jzm'), missing, { columns, key: owner, access, regroup: true }), /Row 6: column 'id' is not nullable/);
});

test('write regroup: writeAsync stores the same chunks and rows as write (rows held are written before the open chunk)', async () => {
  // A limit writes a partition's rows into a chunk that stays open: the rows of it held afterwards join that chunk.
  async function* source(list) {
    for (const row of list) yield row;
  }
  const options = { columns, key: owner, access, chunkRows: 1000, regroup: true, [REGROUP_LIMITS]: { rows: 100 } };
  const durbanOnly = cityRows(150).map((r) => ({ ...r, city: 'Durban' }));
  for (const [name, rows] of [['one partition', durbanOnly], ['many', [...durbanOnly, ...cityRows(300).map((r) => ({ ...r, id: r.id + 150 }))]]]) {
    const sync = tmp('sync.jzm');
    write(sync, rows, options);
    const expected = readAll(sync, owner);
    if (rows === durbanOnly) assert.equal(expected.chunks, 1);
    for (const given of [rows, source(rows)]) {
      const file = tmp('async.jzm');
      await writeAsync(file, given, options);
      const { rows: read, chunks } = readAll(file, owner);
      assert.equal(chunks, expected.chunks, name);
      assert.deepEqual(read, expected.rows, name);
    }
  }
});

test('write regroup: tables with partitionBy are regrouped, the others written as given', () => {
  const rows = cityRows(300);
  const totals = CITIES.map((city) => ({ city, people: rows.filter((r) => r.city === city).length }));
  const file = tmp('tables.jzm');
  write(file, { people: rows, totals }, {
    key: owner, access: { grants: access.grants }, chunkRows: 64, regroup: true,
    tables: [
      { name: 'people', columns, partitionBy: 'city', columnGroups: { private: ['note'] } },
      { name: 'totals', columns: [{ name: 'city', type: 'string' }, { name: 'people', type: 'int' }] },
    ],
  });
  const reader = open(file, { key: owner });
  try {
    assert.equal(reader.chunkCount, CITIES.reduce((n, c) => n + Math.ceil(rows.filter((r) => r.city === c).length / 64), 0));
    assert.deepEqual(sorted(ids([...reader.rows()])), ids(rows));
    const other = reader.openTable('totals');
    assert.deepEqual([...other.rows()], totals);
    other.close();
  } finally {
    reader.close();
  }
});

test('write regroup: nested, json, binary and large int values are held and written as given', () => {
  const nestedColumns = [
    { name: 'id', type: 'int' }, { name: 'city', type: 'string' },
    { name: 'tags', type: 'list', item: { type: 'string' } }, { name: 'extra', type: 'json' },
    { name: 'blob', type: 'binary' }, { name: 'big', type: 'int' },
  ];
  const rows = cityRows(400).map((r) => ({ id: r.id, city: r.city, tags: [r.city, `t${r.id % 3}`], extra: { n: r.id }, blob: Buffer.from([r.id & 255, 7]), big: 2n ** 60n + BigInt(r.id) }));
  const file = tmp('nested.jzm');
  write(file, rows, { columns: nestedColumns, key: owner, access: { partitionBy: 'city', grants: [] }, chunkRows: 32, regroup: true });
  const read = readAll(file, owner).rows;
  for (const city of CITIES) assert.deepEqual(read.filter((r) => r.city === city), rows.filter((r) => r.city === city), city);
});

test('write regroup: at the limit the partitions holding the most go first; ties: the first held, counted from when held again', () => {
  // Limit 4 rows: B [1, 3] at row 3; C [2, 4] at row 5; A [0, 7] before D (2 each) at row 7; D [5, 6] at row 9; then
  // E [8, 11] before B [9, 10] (2 each: B, written before, is held again after E); B at the end. The same in .NET.
  const cities = ['A', 'B', 'C', 'B', 'C', 'D', 'D', 'A', 'E', 'B', 'B', 'E'];
  const rows = cities.map((city, id) => ({ id, city, amount: id, note: null }));
  const file = tmp('order.jzm');
  write(file, rows, { columns, key: owner, access, chunkRows: 100, regroup: true, [REGROUP_LIMITS]: { rows: 4 } });
  const { rows: read, chunks } = readAll(file, owner);
  assert.deepEqual(ids(read), [1, 3, 2, 4, 0, 7, 5, 6, 8, 11, 9, 10]);
  assert.equal(chunks, 6);
});

test('write regroup: a nested value counts toward chunkBytes the same, held or not', () => {
  // A row: id 5 + city 'Durban' 7 + tags 5 + 3 + nums 3 x 5 = 35 estimated bytes, so a chunk of 100 takes 3 rows.
  const nestedColumns = [
    { name: 'id', type: 'int' }, { name: 'city', type: 'string' },
    { name: 'tags', type: 'list', item: { type: 'string' } }, { name: 'nums', type: 'list', item: { type: 'int' } },
  ];
  const rows = Array.from({ length: 30 }, (_, id) => ({ id, city: 'Durban', tags: ['abcd', 'ef'], nums: [1, 2, 3] }));
  for (const regroup of [false, true]) {
    const file = tmp(`nested-bytes-${regroup}.jzm`);
    write(file, rows, { columns: nestedColumns, key: owner, access: { partitionBy: 'city', grants: [] }, chunkBytes: 100, regroup });
    const { rows: read, chunks } = readAll(file, owner);
    assert.equal(chunks, 10, `regroup ${regroup}`); // the same in .NET (WriteRegroupTests.cs)
    assert.deepEqual(ids(read), ids(rows));
  }
});

test('write regroup: json values are stored as JSON.stringify gives them, as without regroup (toJSON, functions)', () => {
  class Money {
    constructor(cents) {
      this.cents = cents;
    }

    toJSON() {
      return (this.cents / 100).toFixed(2);
    }
  }
  const jsonColumns = [
    { name: 'id', type: 'int' }, { name: 'city', type: 'string' }, { name: 'extra', type: 'json' },
    { name: 'line', type: 'object', fields: [{ name: 'price', type: 'json' }] },
  ];
  const rows = cityRows(200).map((r) => ({
    id: r.id, city: r.city, extra: { price: new Money(r.id), note: () => 'left out' }, line: { price: new Money(r.id + 1) },
  }));
  const options = { columns: jsonColumns, key: owner, access: { partitionBy: 'city', grants: [] }, chunkRows: 16 };
  const plain = tmp('json-plain.jzm');
  write(plain, rows, options);
  const grouped = tmp('json-regrouped.jzm');
  write(grouped, rows, { ...options, regroup: true });
  const before = readAll(plain, owner).rows;
  const after = readAll(grouped, owner).rows;
  assert.deepEqual(before[0], { id: 0, city: rows[0].city, extra: { price: '0.00' }, line: { price: '0.01' } });
  for (const city of CITIES) assert.deepEqual(after.filter((r) => r.city === city), before.filter((r) => r.city === city), city);
});

test('write regroup: a row held keeps the values given, though the caller reuses a buffer or list for the next row', () => {
  const reuseColumns = [
    { name: 'id', type: 'int' }, { name: 'city', type: 'string' }, { name: 'blob', type: 'binary' },
    { name: 'tags', type: 'list', item: { type: 'string' } }, { name: 'extra', type: 'json' },
  ];
  const file = tmp('reused.jzm');
  const writer = new JazminWriter(file, { columns: reuseColumns, key: owner, access: { partitionBy: 'city', grants: [] }, regroup: true });
  const blob = Buffer.alloc(2);
  const tags = [];
  const extra = {};
  const rows = cityRows(300);
  for (const r of rows) {
    blob[0] = r.id & 255;
    blob[1] = 7;
    tags.length = 0;
    tags.push(r.city, `t${r.id}`);
    extra.n = r.id;
    writer.writeRow({ id: r.id, city: r.city, blob, tags, extra });
  }
  writer.finish();
  const read = readAll(file, owner).rows;
  assert.equal(read.length, rows.length);
  for (const r of read) {
    assert.deepEqual([...r.blob], [r.id & 255, 7], `row ${r.id}`);
    assert.deepEqual(r.tags, [r.city, `t${r.id}`], `row ${r.id}`);
    assert.deepEqual(r.extra, { n: r.id }, `row ${r.id}`);
  }
});
