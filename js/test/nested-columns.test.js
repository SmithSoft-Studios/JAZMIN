// Nested columns (spec 5.4, reader feature 'nested-columns'): list and object columns whose items and fields are stored
// as columns of their own. Values read back are those written (every field present, null where it was missing), in
// the forms of their types; lookups and filtered scans give the same rows; a bad value refuses its row whole.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminWriter, append, compact, open, toCSV, toJSON, toXML, write } from '../src/index.js';
import { decodeColumnDefinitions, encodeColumnDefinitions } from '../src/catalog.js';
import { decodeColumnar } from '../src/columnar.js';
import { JazminError, JazminFormatError, JazminValidationError } from '../src/errors.js';
import { sections } from './fuzz-helpers.js';

const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'tier', type: 'string' },
  {
    name: 'staff', type: 'list', item: {
      type: 'object', fields: [
        { name: 'name', type: 'string' },
        { name: 'active', type: 'bool' },
        { name: 'score', type: 'float' },
        { name: 'pay', type: 'decimal' },
        { name: 'since', type: 'datetime' },
        { name: 'badge', type: 'int' },
        { name: 'photo', type: 'binary' },
        { name: 'extra', type: 'json' },
        { name: 'projects', type: 'list', item: { type: 'object', fields: [{ name: 'code', type: 'string' }, { name: 'hours', type: 'int' }] } },
        { name: 'tags', type: 'list', item: { type: 'string', nullable: false } },
      ],
    },
  },
  { name: 'head', type: 'object', fields: [{ name: 'street', type: 'string', nullable: false }, { name: 'city', type: 'string' }] },
  { name: 'grid', type: 'list', item: { type: 'list', item: { type: 'int' } } },
];

const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

/** A row, with every field present (as rows are read back). */
function make(i) {
  return {
    id: i,
    tier: i % 3 === 0 ? 'Gold' : 'Silver',
    staff: i % 7 === 0 ? null : i % 5 === 0 ? [] : Array.from({ length: 1 + (i % 4) }, (_, n) => (n === 2 ? null : {
      name: `E${i}-${n} ünï €`,
      active: (i + n) % 2 === 0,
      score: n === 3 ? NaN : (i * 10 + n) / 4,
      pay: n === 1 ? null : `${i}.${n}0`,
      since: day(i + n),
      badge: i === 11 && n === 0 ? 2n ** 60n : i * 100 + n,
      photo: n === 0 ? Buffer.from([i & 255, 0, 255]) : null,
      extra: n === 3 ? { i, list: [1, 'x'] } : null,
      projects: n === 1 ? null : Array.from({ length: (i + n) % 3 }, (_, k) => ({ code: `P${(i + k) % 9}`, hours: k === 1 ? null : k * 8 })),
      tags: i % 4 === 0 ? [] : ['a', `t${n}`],
    })),
    head: i % 3 === 0 ? null : { street: `${i} Main`, city: i % 2 === 0 ? 'Durban' : null },
    grid: i % 4 === 0 ? null : [[], [1, null, i], [null]],
  };
}

const rows = Array.from({ length: 150 }, (_, i) => make(i));
const file = write(null, rows, { columns, chunkRows: 32 });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-nested-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

test('every row reads back as written, with nulls and empty lists at every level', () => {
  const r = open(file);
  assert.deepEqual([...r.find()], rows);
  assert.deepEqual([...r.rows()], rows);
  assert.deepEqual(r.columns.find((c) => c.name === 'head'), {
    name: 'head', type: 'object', nullable: true,
    fields: [{ name: 'street', type: 'string', nullable: false }, { name: 'city', type: 'string', nullable: true }],
  });
  assert.deepEqual(r.columns.find((c) => c.name === 'grid').item, { name: 'item', type: 'list', nullable: true, item: { name: 'item', type: 'int', nullable: true } });
  r.close();
});

test('lookups and filtered scans give their rows whole', () => {
  const r = open(file);
  for (const row of rows) assert.deepEqual([...r.find({ id: row.id })], [row]);
  assert.deepEqual([...r.find({ id: { in: [40, 43] } })], [rows[40], rows[43]]);
  assert.deepEqual([...r.find({ tier: 'Gold', id: { gt: 100 } })], rows.filter((x) => x.tier === 'Gold' && x.id > 100));
  assert.deepEqual([...r.find({ staff: { isNull: true } })].map((x) => x.id), rows.filter((x) => x.staff === null).map((x) => x.id));
  assert.deepEqual([...r.find({ head: { isNull: false } })].length, rows.filter((x) => x.head !== null).length);
  assert.throws(() => [...r.find({ grid: { eq: 1 } })], JazminValidationError); // not ordered, as json
  r.close();
});

test('JSON, CSV and XML output write nested values in the forms of their types', () => {
  const small = write(null, [
    { id: 1, staff: [{ name: 'A', pay: '12.50', since: day(1), badge: 2n ** 60n, score: Infinity, photo: Buffer.from([1, 2]), extra: { k: [1] }, tags: ['x'] }] },
    { id: 2, head: { street: 'S', city: null }, grid: [[1], []] },
  ], { columns });
  const r = open(small);
  const json = JSON.parse(toJSON(r));
  assert.equal(toJSON(r).includes('"pay":12.50'), true); // decimals exactly, as numbers
  assert.equal(toJSON(r).includes(`"badge":${2n ** 60n}`), true);
  assert.deepEqual(json[0].staff[0], {
    name: 'A', active: null, score: null, pay: 12.5, since: '2026-01-02T00:00:00.000Z', badge: 2 ** 60, photo: 'AQI=', extra: { k: [1] }, projects: null, tags: ['x'],
  });
  assert.deepEqual(json[1], { id: 2, tier: null, staff: null, head: { street: 'S', city: null }, grid: [[1], []] });
  assert.match(toCSV(r), /"\{""street"":""S"",""city"":null\}"/);
  assert.match(toXML(r), /<head>\{&quot;street&quot;:&quot;S&quot;,&quot;city&quot;:null\}<\/head>/);
  r.close();
});

test('values are taken in JSON forms too: base64 binary, ISO dates, decimal numbers, non-finite floats as text', () => {
  const r = open(write(null, [{ id: 1, staff: [{ photo: 'AQI=', since: '2026-01-02T00:00:00Z', pay: 3.25, score: '-Infinity', badge: 5 }] }], { columns }));
  const [person] = [...r.find()][0].staff;
  assert.deepEqual([person.photo, person.since, person.pay, person.score, person.badge], [Buffer.from([1, 2]), day(1), '3.25', -Infinity, 5]);
  r.close();
});

test('a bad value deep inside refuses its row whole: the rows before and after are written, nothing of it', () => {
  const lines = [{ name: 'id', type: 'int', nullable: false }, { name: 'lines', type: 'list', item: { type: 'object', fields: [{ name: 'sku', type: 'string' }, { name: 'qty', type: 'int' }] } }];
  const target = path.join(scratch, 'refused.jzm');
  const good = [{ id: 1, lines: [{ sku: 'a', qty: 1 }] }, { id: 4, lines: [{ sku: 'e', qty: 5 }] }];
  const errors = [];
  function* source() {
    yield good[0];
    yield { id: 2, lines: [{ sku: 'b', qty: 1 }, { sku: 'c', qty: 'many' }] };
    yield { id: 3, lines: [{ sku: 'd', colour: 'red' }] };
    yield { id: 5, lines: { sku: 'f' } };
    yield good[1];
  }
  const jw = new JazminWriter(target, { columns: lines });
  for (const row of source()) {
    try {
      jw.writeRow(row);
    } catch (e) {
      errors.push(e.message);
    }
  }
  jw.finish();
  assert.deepEqual(errors, [
    "Column 'lines[].qty': expected an integer, got string",
    "Column 'lines[]': 'colour' is not one of its fields",
    "Column 'lines': expected a list (an array), got object",
  ]);
  const r = open(target);
  assert.deepEqual([...r.find()], good);
  r.close();
});

test('definitions are checked: items, fields, names, indexes, depth, sorting', () => {
  const bad = (column, pattern, options = {}) => assert.throws(() => write(null, [], { columns: [column], ...options }), pattern);
  bad({ name: 'l', type: 'list' }, /Column 'l': a list needs an item/);
  bad({ name: 'o', type: 'object', fields: [] }, /Column 'o': an object needs at least one field/);
  bad({ name: 'o', type: 'object', fields: [{ name: 'a', type: 'int' }, { name: 'a', type: 'int' }] }, /duplicate field 'a'/);
  bad({ name: 's', type: 'string', item: { type: 'int' } }, /only lists have an item/);
  bad({ name: 'l', type: 'list', item: { type: 'string', index: 'sorted' } }, /Column 'l\[\]': items and fields cannot be indexed/);
  bad({ name: 'l', type: 'list', item: { type: 'int' }, index: 'sorted' }, /a sorted index is not supported on list/);
  bad({ name: 'o', type: 'object', fields: [{ name: 'x', type: 'nope' }] }, /Column 'o.x' has unknown type 'nope'/);
  bad({ name: 'l', type: 'list', item: { type: 'int' } }, /sortedBy: a list column cannot be sorted/, { sortedBy: ['l'] });
  const deep = (n) => (n === 0 ? { type: 'int' } : { type: 'list', item: deep(n - 1) });
  write(null, [{ x: null }], { columns: [{ name: 'x', ...deep(64) }] });
  bad({ name: 'x', ...deep(65) }, /nested more than 64 levels deep/);
  // A file is never read so deep that reading it could exhaust the stack.
  const nest = (n) => (n === 0 ? { position: 0, name: 'item', type: 'int' } : { position: 0, name: 'item', type: 'list', item: nest(n - 1) });
  assert.throws(() => decodeColumnDefinitions(encodeColumnDefinitions([{ ...nest(200), name: 'x' }])), JazminFormatError);
  assert.throws(() => decodeColumnDefinitions(encodeColumnDefinitions([{ position: 0, name: 'x', type: 'list' }])), /invalid structure/);
});

test('the file names the reader feature only when it has nested columns', () => {
  const plain = write(null, [{ id: 1 }], { columns: [{ name: 'id', type: 'int' }] });
  assert.equal(plain.includes(Buffer.from('nested-columns')), false);
  // The header is compressed in the default codec: write uncompressed to find the name.
  const nested = write(null, rows.slice(0, 3), { columns, codec: 'none' });
  assert.equal(nested.includes(Buffer.from('nested-columns')), true);
});

test('appending and compacting keep nested values', () => {
  const target = path.join(scratch, 'appended.jzm');
  fs.writeFileSync(target, write(null, rows.slice(0, 100), { columns, chunkRows: 32 }));
  append(target, { insert: rows.slice(100) });
  append(target, { delete: { id: { lt: 10 } } });
  compact(target);
  const r = open(target);
  assert.deepEqual([...r.find()], rows.slice(10));
  assert.equal(r.columns.find((c) => c.name === 'staff').type, 'list');
  r.close();
});

test('an access-controlled file gives a key its partitions, nested columns in a locked group included', () => {
  const owner = JazminKey.generate();
  const gold = owner.createAccessKey();
  const bytes = write(null, rows, {
    columns, key: owner, chunkRows: 32,
    access: { partitionBy: 'tier', columnGroups: { people: ['staff'] }, grants: [{ key: gold, rows: ['Gold'], columns: '*' }] },
  });
  const r = open(bytes, { key: gold });
  assert.deepEqual([...r.find()], rows.filter((x) => x.tier === 'Gold'));
  r.close();
});

test('damaged nested streams fail with a JAZMIN error', () => {
  const plain = write(null, rows.slice(0, 16), { columns, chunkRows: 16, codec: 'none' });
  const r = open(plain);
  const types = r.columns.map((c) => (c.type === 'list' || c.type === 'object' ? c : c.type));
  r.close();
  // The chunk is the first section; its payload follows a 16-byte envelope (codec none).
  const [first] = sections(plain);
  const payload = plain.subarray(first.at + 16, first.at + 16 + first.length);
  assert.deepEqual(decodeColumnar(payload, types, 16, 0, null)[2], rows.slice(0, 16).map((x) => x.staff));
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let decoded = 0;
  let failed = 0;
  for (let n = 0; n < 3000; n++) {
    let damaged = Buffer.from(payload);
    for (let k = 1 + Math.floor(next() * 3); k > 0; k--) damaged[Math.floor(next() * damaged.length)] = Math.floor(next() * 256);
    if (n % 10 === 0) damaged = damaged.subarray(0, Math.floor(next() * damaged.length));
    const wanted = n % 3 === 0 ? null : Uint8Array.from({ length: 16 }, (_, i) => (i === n % 16 ? 1 : 0));
    try {
      decodeColumnar(damaged, types, 16, 0, null, false, wanted);
      decoded++;
    } catch (e) {
      assert.ok(e instanceof JazminError, `${e.name}: ${e.message}`);
      failed++;
    }
  }
  assert.ok(decoded > 100 && failed > 100, `${decoded} decoded, ${failed} failed`);
});

test("the viewer shows nested values as JSON, large integers and binary data included", async () => {
  const { default: vm } = await import('node:vm');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('../viewer/viewer.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  const cell = (value) => {');
  const end = source.indexOf('\n  };\n', start);
  const typeStart = source.indexOf('  const typeName = (c) => {');
  const typeEnd = source.indexOf('\n  };\n', typeStart);
  const { cell, typeName } = vm.runInNewContext(`${source.slice(start, end + 5)}\n${source.slice(typeStart, typeEnd + 5)}\n({ cell, typeName })`, { Uint8Array, Date, JSON, String });
  assert.equal(cell([{ n: 2n ** 60n, b: new Uint8Array(3), at: new Date(0), x: null }]), `[{"n":"${2n ** 60n}","b":"3 bytes","at":"1970-01-01T00:00:00.000Z","x":null}]`);
  assert.equal(typeName(open(file).columns.find((c) => c.name === 'head')), 'object{street: string, city: string?}');
});
