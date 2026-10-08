import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminKey, JazminValidationError, compileShape, exportFile, open, shapeSchema, toCSV, toJSON, toXML, write,
} from '../src/index.js';
import { SHAPE_BATCH_ROWS } from '../src/shape.js';

const columns = [
  { name: 'client', type: 'string' },
  { name: 'clientName', type: 'string' },
  { name: 'address', type: 'string' },
  { name: 'date', type: 'datetime' },
  { name: 'amount', type: 'float' },
  { name: 'fee', type: 'decimal' },
  { name: 'units', type: 'int' },
];
const day = (d) => new Date(Date.UTC(2025, 2, d));
const rows = [
  { client: 'C1', clientName: 'ABC Corp', address: '10 Test Street', date: day(4), amount: 250.5, fee: '1.25', units: 9007199254740991 },
  { client: 'C2', clientName: 'Test', address: '2 Test Place', date: day(2), amount: 20000, fee: '0.10', units: 1 },
  { client: 'C1', clientName: 'ABC Corp', address: '10 Test Street', date: day(1), amount: 1000, fee: '2', units: 1 },
  { client: null, clientName: null, address: null, date: null, amount: null, fee: null, units: null },
];
const reader = (options = {}) => open(write(null, rows, { columns, metadata: { title: 'March statements' }, ...options }));

const statement = {
  statement: { $meta: 'title' },
  clients: {
    $rows: {
      id: 'client',
      name: 'clientName',
      balance: { $sum: 'amount' },
      fees: { $sum: 'fee' },
      transactions: { $rows: { date: 'date', amount: 'amount' }, $sort: ['date'], $xmlItem: 'transaction' },
    },
    $groupBy: 'client',
    $filter: { client: { isNull: false } },
    $xmlItem: 'client',
  },
  largest: { $rows: { client: 'client', amount: 'amount' }, $filter: { amount: { gt: 10000 } } },
  total: { $sum: 'amount' },
  count: { $count: true },
  units: { $sum: 'units' },
  latest: { $max: 'date' },
  firstName: 'clientName',
  label: { $value: 'v1' },
  version: 2,
};

const expected = {
  statement: 'March statements',
  clients: [
    { id: 'C1', name: 'ABC Corp', balance: 1250.5, fees: 3.25, transactions: [{ date: '2025-03-01T00:00:00.000Z', amount: 1000 }, { date: '2025-03-04T00:00:00.000Z', amount: 250.5 }] },
    { id: 'C2', name: 'Test', balance: 20000, fees: 0.1, transactions: [{ date: '2025-03-02T00:00:00.000Z', amount: 20000 }] },
  ],
  largest: [{ client: 'C2', amount: 20000 }],
  total: 21250.5,
  count: 4,
  units: 9007199254740993, // exact in the JSON text (beyond 2^53); compared as text below
  latest: '2025-03-04T00:00:00.000Z',
  firstName: 'ABC Corp',
  label: 'v1',
  version: 2,
};

test('a shape nests, groups (first value), totals and filters', () => {
  const text = toJSON(reader(), { shape: statement });
  assert.match(text, /"units":9007199254740993/); // int sums are exact
  assert.match(text, /"fees":0\.10/); // decimal sums keep their scale
  assert.deepEqual(JSON.parse(text), expected);
  assert.deepEqual(JSON.parse(toJSON(reader(), { shape: statement, pretty: true })), expected);
});

test('XML output: members are elements, lists use $xmlItem, nulls are omitted', () => {
  const xml = toXML(reader(), { shape: { title: { $meta: 'title' }, clients: statement.clients, nothing: { $value: null } } });
  assert.equal(xml, `<?xml version="1.0" encoding="UTF-8"?>
<export>
  <title>March statements</title>
  <clients>
    <client>
      <id>C1</id>
      <name>ABC Corp</name>
      <balance>1250.5</balance>
      <fees>3.25</fees>
      <transactions>
        <transaction>
          <date>2025-03-01T00:00:00.000Z</date>
          <amount>1000</amount>
        </transaction>
        <transaction>
          <date>2025-03-04T00:00:00.000Z</date>
          <amount>250.5</amount>
        </transaction>
      </transactions>
    </client>
    <client>
      <id>C2</id>
      <name>Test</name>
      <balance>20000</balance>
      <fees>0.10</fees>
      <transactions>
        <transaction>
          <date>2025-03-02T00:00:00.000Z</date>
          <amount>20000</amount>
        </transaction>
      </transactions>
    </client>
  </clients>
</export>
`);
  assert.match(toXML(reader(), { shape: { $rows: { 'a b': 'client' }, $limit: 1 }, root: 'list' }), /<list>\n {2}<item>\n {4}<field name="a b">C1<\/field>/);
});

test('groups: sorted files stream group by group, with the same result as unsorted files', () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ k: i % 7 === 0 ? null : `K${i % 40}`, n: i, v: i % 3 === 0 ? null : i / 2 }));
  const cols = [{ name: 'k', type: 'string' }, { name: 'n', type: 'int' }, { name: 'v', type: 'float' }];
  const shape = {
    $rows: { k: 'k', first: 'n', count: { $count: true }, total: { $sum: 'v' }, low: { $min: 'v' }, top: { $rows: 'n', $sort: ['-n'], $limit: 2 } },
    $groupBy: 'k',
    $sort: ['k'],
  };
  const unsorted = JSON.parse(toJSON(open(write(null, many, { columns: cols, chunkRows: 100 })), { shape }));
  const sortedRows = [...many].sort((a, b) => (a.k === b.k ? a.n - b.n : a.k === null ? -1 : b.k === null ? 1 : a.k < b.k ? -1 : 1));
  const sorted = open(write(null, sortedRows, { columns: cols, chunkRows: 100, sortedBy: ['k', 'n'] }));
  assert.deepEqual(JSON.parse(toJSON(sorted, { shape: { ...shape, $sort: undefined } })), unsorted);
  assert.equal(unsorted.length, 41);
  assert.equal(unsorted[0].k, null); // nulls sort first
  assert.deepEqual(unsorted[0].top, [2996, 2989]);
  const k5 = unsorted.find((g) => g.k === 'K5');
  const members = many.filter((r) => r.k === 'K5');
  assert.equal(k5.count, members.length);
  assert.equal(k5.first, members[0].n);
  assert.equal(k5.total, members.reduce((s, r) => s + (r.v ?? 0), 0));
  assert.equal(k5.low, Math.min(...members.filter((r) => r.v !== null).map((r) => r.v)));
  // Unsorted files with nested lists collect groups in batches: the result does not depend on the batch size.
  const nested = { ...shape, $rows: { ...shape.$rows, all: { $rows: { n: 'n', v: 'v' }, $filter: { v: { gt: 100 } } } } };
  const unsortedFile = open(write(null, many, { columns: cols, chunkRows: 100 }));
  const whole = toJSON(unsortedFile, { shape: nested });
  assert.equal(toJSON(unsortedFile, { shape: nested, [SHAPE_BATCH_ROWS]: 50 }), whole);
  assert.equal(toJSON(unsortedFile, { shape: nested, [SHAPE_BATCH_ROWS]: 1 }), whole);
  assert.equal(toJSON(open(write(null, many, { columns: cols, chunkRows: 100 }), { priority: 'speed' }), { shape: nested }), whole);
  assert.equal(toJSON(sorted, { shape: { ...nested, $sort: undefined } }), whole);
  assert.equal(JSON.parse(whole)[5].all.length, many.filter((r) => r.k === JSON.parse(whole)[5].k && r.v > 100).length);
  // $limit on groups, also when streaming a sorted file.
  assert.equal(JSON.parse(toJSON(sorted, { shape: { $rows: 'k', $groupBy: 'k', $limit: 3 } })).length, 3);
});

test('groups by several columns, by dates and numbers, and nested groups', () => {
  const shape = {
    $rows: {
      client: 'client',
      byDay: { $rows: { date: 'date', units: { $sum: 'units' }, n: { $count: true } }, $groupBy: ['date', 'units'], $sort: ['-date'] },
    },
    $groupBy: 'client',
    $limit: 2,
  };
  assert.deepEqual(JSON.parse(toJSON(reader(), { shape })), [
    { client: 'C1', byDay: [{ date: '2025-03-04T00:00:00.000Z', units: 9007199254740991, n: 1 }, { date: '2025-03-01T00:00:00.000Z', units: 1, n: 1 }] },
    { client: 'C2', byDay: [{ date: '2025-03-02T00:00:00.000Z', units: 1, n: 1 }] },
  ]);
  // The null group's nested list selects the rows whose key is null.
  const nulls = JSON.parse(toJSON(reader(), { shape: { $rows: { c: 'client', n: { $rows: 'units' } }, $groupBy: 'client', $sort: ['client'] } }));
  assert.deepEqual(nulls[0], { c: null, n: [null] });
});

test('empty sets: count 0, other aggregates and first values null; root filter and root lists', () => {
  const shape = { n: { $count: true }, total: { $sum: 'amount' }, top: { $max: 'amount' }, name: 'clientName', list: { $rows: 'client' } };
  assert.deepEqual(JSON.parse(toJSON(reader(), { shape, filter: { amount: { gt: 1e9 } } })), { n: 0, total: null, top: null, name: null, list: [] });
  assert.deepEqual(JSON.parse(toJSON(reader(), { shape: { $rows: 'client', $filter: { client: { startsWith: 'C' } } } })), ['C1', 'C2', 'C1']);
  assert.deepEqual(JSON.parse(toJSON(reader(), { shape, filter: { client: 'C2' } })), { n: 1, total: 20000, top: 20000, name: 'Test', list: ['C2'] });
});

test('decimal $min, $max and $sort compare by value, not as text', () => {
  const r = open(write(null, [{ fee: '9' }, { fee: '10.5' }, { fee: '-2' }], { columns: [{ name: 'fee', type: 'decimal' }] }));
  const shape = { lo: { $min: 'fee' }, hi: { $max: 'fee' }, list: { $rows: 'fee', $sort: ['-fee'] } };
  assert.deepEqual(JSON.parse(toJSON(r, { shape })), { lo: -2, hi: 10.5, list: [10.5, 9, -2] });
});

test('shapes are validated before any data is read', () => {
  const r = reader();
  const bad = [
    [{ a: 'nope' }, /Shape at a: unknown or hidden column 'nope'/],
    [{ a: { $rows: { b: { $rows: 'client' } } } }, /Shape at a\[\]\.b: a list inside a row list needs \$groupBy/],
    [{ a: { $rows: { s: { $sum: 'amount' } } } }, /aggregates need a set of rows/],
    [{ a: { $sum: 'client' } }, /\$sum is not supported on string column 'client'/],
    [{ a: ['client'] }, /arrays are not templates/],
    [{ a: { $rows: 'client', $filter: { zz: 1 } } }, /Shape at a\.\$filter: .*unknown column 'zz'/],
    [{ a: { $rows: 'client', $sort: 'date' } }, /\$sort: must be an array/],
    [{ a: { $rows: 'client', $limit: -1 } }, /\$limit: must be a non-negative integer/],
    [{ a: { $rows: 'client', $groupBy: [] } }, /needs at least one column/],
    [{ a: { $rows: 'client', $xmlItem: '1x' } }, /valid XML element name/],
    [{ a: { $rows: 'client', $other: 1 } }, /unknown list option '\$other'/],
    [{ a: { $count: true, b: 1 } }, /cannot be mixed/],
    [{ a: { $avg: 'amount' } }, /unknown operator '\$avg'/],
    [{ a: { $count: 1 } }, /\$count takes true/],
    [[], /must be an object/],
  ];
  for (const [shape, message] of bad) {
    assert.throws(() => compileShape(r.columns, shape), (e) => e instanceof JazminValidationError && message.test(e.message), JSON.stringify(shape));
  }
  assert.throws(() => toCSV(r, { shape: { a: 'client' } }), /Shapes export JSON or XML/);
  assert.throws(() => toJSON(r, { shape: { a: 'client' }, select: ['client'] }), /use \$rows\/\$limit in the shape/);
});

test('an access key cannot export columns it cannot see', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const access = { partitionBy: 'client', columnGroups: { money: ['amount', 'fee'] }, grants: [{ key: bob, rows: ['C1'], columns: ['*'] }] }; // '*': the default group, not 'money'
  const file = write(null, rows, { columns, key: owner, access });
  const asBob = open(file, { key: bob });
  assert.deepEqual(JSON.parse(toJSON(asBob, { shape: { n: { $count: true }, names: { $rows: 'clientName' } } })), { n: 2, names: ['ABC Corp', 'ABC Corp'] });
  assert.throws(() => toJSON(asBob, { shape: { total: { $sum: 'amount' } } }), /unknown or hidden column 'amount'/);
});

test('JSON Schema of a shape', () => {
  const schema = shapeSchema(reader(), statement);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.required, Object.keys(statement));
  assert.equal(schema.additionalProperties, false);
  const client = schema.properties.clients.items;
  assert.deepEqual(client.properties.id, { type: ['string', 'null'] });
  assert.deepEqual(client.properties.balance, { type: ['number', 'null'] });
  assert.deepEqual(client.properties.transactions.items.properties.date, { type: ['string', 'null'], format: 'date-time' });
  assert.deepEqual(schema.properties.count, { type: 'integer', minimum: 0 });
  assert.deepEqual(schema.properties.label, { const: 'v1' });
  assert.deepEqual(schema.properties.statement, {});
  const strict = open(write(null, [{ id: 1 }], { columns: [{ name: 'id', type: 'int', nullable: false }] }));
  assert.deepEqual(shapeSchema(strict, { ids: { $rows: 'id' }, first: 'id' }).properties, {
    ids: { type: 'array', items: { type: 'integer' } },
    first: { type: ['integer', 'null'] }, // the root set may be empty
  });
});

test('exportFile streams a shaped export of a large file', () => {
  const many = Array.from({ length: 50_000 }, (_, i) => ({ g: `G${i % 100}`, n: i }));
  const r = open(write(null, many, { columns: [{ name: 'g', type: 'string' }, { name: 'n', type: 'int' }] }));
  const shape = { groups: { $rows: { g: 'g', n: { $count: true }, sum: { $sum: 'n' } }, $groupBy: 'g' }, rows: { $rows: { n: 'n' } } };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-shape-')), 'out.json');
  exportFile(r, 'json', file, { shape });
  const out = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(out.groups.length, 100);
  assert.equal(out.groups[3].sum, many.filter((x) => x.g === 'G3').reduce((s, x) => s + x.n, 0));
  assert.equal(out.rows.length, 50_000);
  assert.deepEqual(out, JSON.parse(toJSON(r, { shape })));
});
