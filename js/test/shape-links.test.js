// Export shapes that follow links between tables ($from / $on, docs/design/export-shapes.md section 7): the output is
// checked against the same nesting done by hand, with every way the links can be fetched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, open, shapeSchema, toJSON, toXML, write } from '../src/index.js';
import { SHAPE_LINK_BATCH, SHAPE_LINK_STATS, SHAPE_LINK_TABLE_ROWS } from '../src/shape.js';

const products = Array.from({ length: 12 }, (_, i) => ({ sku: `P${String(i).padStart(2, '0')}`, name: `Product ${i}`, price: `${10 + i}.50` }))
  .sort((a, b) => (a.sku < b.sku ? -1 : 1));
const customers = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Customer ${i + 1}`, country: ['ZA', 'NA', 'BW'][i % 3] }));
const orders = [];
const lines = [];
for (let id = 1; id <= 200; id++) {
  const customer = id === 7 ? null : 1 + ((id * 7) % 29); // customer 30 has no orders; order 7 has no customer
  orders.push({ id, customer_id: customer, placed: new Date(Date.UTC(2026, 0, 1) + ((id * 37) % 200) * 86_400_000), total: `${id * 3}.00` });
  const count = id % 5; // order 5, 10, ... has no lines
  for (let n = 1; n <= count; n++) {
    const sku = id % 11 === 0 && n === 1 ? 'GONE' : `P${String((id + n) % 12).padStart(2, '0')}`; // a line whose product is missing
    lines.push({ order_id: id, line: n, sku, amount: `${n}.25`, customer_id: customer });
  }
}
const tables = [
  { name: 'customers', sortedBy: ['id'], columns: [
    { name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'string' }, { name: 'country', type: 'string' }] },
  { name: 'products', sortedBy: ['sku'], columns: [
    { name: 'sku', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'price', type: 'decimal' }] },
  { name: 'orders', sortedBy: ['id'], chunkRows: 16, columns: [
    { name: 'id', type: 'int', nullable: false }, { name: 'customer_id', type: 'int', index: 'sorted' },
    { name: 'placed', type: 'datetime' }, { name: 'total', type: 'decimal' }] },
  { name: 'order_lines', sortedBy: ['order_id', 'line'], chunkRows: 32, columns: [
    { name: 'order_id', type: 'int', nullable: false }, { name: 'line', type: 'int', nullable: false },
    { name: 'sku', type: 'string' }, { name: 'amount', type: 'decimal' }, { name: 'customer_id', type: 'int' }] },
];
const file = write(null, { customers, products, orders, order_lines: lines }, { tables });

const shape = {
  $rows: {
    id: 'id',
    name: 'name',
    orders: {
      $from: 'orders', $on: { customer_id: 'id' }, $sort: ['placed', 'id'],
      $rows: {
        id: 'id', placed: 'placed', total: 'total',
        lines: {
          $from: 'order_lines', $on: { order_id: 'id' },
          $rows: { line: 'line', amount: 'amount', product: { $from: 'products', $on: { sku: 'sku' }, $one: { name: 'name', price: 'price' } } },
        },
        lineCount: { $from: 'order_lines', $on: { order_id: 'id' }, $one: { $count: true } },
        lineTotal: { $from: 'order_lines', $on: { order_id: 'id' }, $one: { $sum: 'amount' } },
      },
    },
  },
};

const iso = (d) => d.toISOString();
const productOf = (sku) => products.find((p) => p.sku === sku);
const linesOf = (o) => lines.filter((l) => l.order_id === o.id);
const expectedOrder = (o) => {
  const ls = linesOf(o);
  return {
    id: o.id,
    placed: iso(o.placed),
    total: Number(o.total),
    lines: ls.map((l) => {
      const p = productOf(l.sku);
      return { line: l.line, amount: Number(l.amount), product: p ? { name: p.name, price: Number(p.price) } : null };
    }),
    lineCount: ls.length ? ls.length : null,
    lineTotal: ls.length ? ls.reduce((s, l) => s + Number(l.amount), 0) : null,
  };
};
const expectedCustomer = (c) => ({
  id: c.id,
  name: c.name,
  orders: orders.filter((o) => o.customer_id === c.id).sort((a, b) => a.placed - b.placed || a.id - b.id).map(expectedOrder),
});

for (const [label, options] of [
  ['default', {}],
  ['tiny batches, every table queried', { [SHAPE_LINK_BATCH]: 3, [SHAPE_LINK_TABLE_ROWS]: 0 }],
  ['one parent per batch', { [SHAPE_LINK_BATCH]: 1, [SHAPE_LINK_TABLE_ROWS]: 0 }],
  ['every table held', { [SHAPE_LINK_TABLE_ROWS]: 1_000_000 }],
]) {
  test(`links (${label}): customers, their orders, lines and products, as by hand`, () => {
    const reader = open(file);
    assert.deepEqual(JSON.parse(toJSON(reader, { shape, ...options })), customers.map(expectedCustomer));
    assert.deepEqual(JSON.parse(toJSON(reader, { shape, filter: { id: { in: [3, 30] } }, ...options })), [3, 30].map((id) => expectedCustomer(customers[id - 1])));
  });
}

test('links: the same output with every reader priority', () => {
  const whole = toJSON(open(file), { shape, pretty: true });
  for (const priority of ['memory', 'speed']) assert.equal(toJSON(open(file, { priority }), { shape, pretty: true }), whole);
});

test('links in the root object follow the root set: one customer with the export filter', () => {
  const one = { customer: 'name', orders: { $from: 'orders', $on: { customer_id: 'id' }, $rows: 'id' }, spent: { $from: 'orders', $on: { customer_id: 'id' }, $one: { $sum: 'total' } } };
  const theirs = orders.filter((o) => o.customer_id === 4);
  assert.deepEqual(JSON.parse(toJSON(open(file), { shape: one, filter: { id: 4 } })),
    { customer: 'Customer 4', orders: theirs.map((o) => o.id), spent: theirs.reduce((s, o) => s + Number(o.total), 0) });
  assert.deepEqual(JSON.parse(toJSON(open(file), { shape: one, filter: { id: 30 } })), { customer: 'Customer 30', orders: [], spent: null });
});

test('links from another table, with $filter, $sort, $limit and $groupBy on the linked rows', () => {
  const reader = open(file, { table: 'orders' });
  const s = {
    $rows: {
      order: 'id',
      who: { $from: 'customers', $on: { id: 'customer_id' }, $one: 'name' },
      big: { $from: 'order_lines', $on: { order_id: 'id' }, $filter: { line: { gte: 2 } }, $sort: ['-line'], $limit: 2, $rows: 'line' },
      bySku: { $from: 'order_lines', $on: { order_id: 'id' }, $groupBy: 'sku', $sort: ['sku'], $rows: { sku: 'sku', n: { $count: true } } },
    },
    $filter: { id: { lte: 12 } },
  };
  const expected = orders.filter((o) => o.id <= 12).map((o) => {
    const ls = linesOf(o);
    const skus = [...new Set(ls.map((l) => l.sku))].sort();
    return {
      order: o.id,
      who: o.customer_id === null ? null : customers[o.customer_id - 1].name,
      big: ls.filter((l) => l.line >= 2).map((l) => l.line).sort((a, b) => b - a).slice(0, 2),
      bySku: skus.map((sku) => ({ sku, n: ls.filter((l) => l.sku === sku).length })),
    };
  });
  for (const options of [{}, { [SHAPE_LINK_BATCH]: 2, [SHAPE_LINK_TABLE_ROWS]: 0 }]) assert.deepEqual(JSON.parse(toJSON(reader, { shape: s, ...options })), expected);
});

test('links inside groups, links on two columns, and a table linked to itself', () => {
  const reader = open(file);
  const grouped = {
    $rows: { country: 'country', customers: { $rows: { id: 'id', orders: { $from: 'orders', $on: { customer_id: 'id' }, $one: { $count: true } } } } },
    $groupBy: 'country', $sort: ['country'],
  };
  const countOf = (c) => orders.filter((o) => o.customer_id === c.id).length || null;
  assert.deepEqual(JSON.parse(toJSON(reader, { shape: grouped })), ['BW', 'NA', 'ZA'].map((country) => ({
    country, customers: customers.filter((c) => c.country === country).map((c) => ({ id: c.id, orders: countOf(c) })),
  })));

  const twoColumns = { $rows: { id: 'id', lines: { $from: 'order_lines', $on: { order_id: 'id', customer_id: 'customer_id' }, $rows: 'line' } }, $filter: { id: { lte: 10 } } };
  assert.deepEqual(JSON.parse(toJSON(open(file, { table: 'orders' }), { shape: twoColumns })), orders.filter((o) => o.id <= 10).map((o) => ({
    id: o.id, lines: o.customer_id === null ? [] : linesOf(o).map((l) => l.line), // a null customer_id links nothing
  })));

  const staff = [{ id: 1, name: 'Ann', boss: null }, { id: 2, name: 'Bob', boss: 1 }, { id: 3, name: 'Cy', boss: 1 }, { id: 4, name: 'Di', boss: 2 }];
  const org = write(null, staff, { columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }, { name: 'boss', type: 'int' }] });
  const tree = { $rows: { name: 'name', reports: { $from: '', $on: { boss: 'id' }, $rows: { name: 'name', reports: { $from: '', $on: { boss: 'id' }, $rows: 'name' } } } }, $filter: { boss: null } };
  assert.deepEqual(JSON.parse(toJSON(open(org), { shape: tree })), [{ name: 'Ann', reports: [{ name: 'Bob', reports: ['Di'] }, { name: 'Cy', reports: [] }] }]);
});

test('links compare decimal keys by value', () => {
  const bytes = write(null, {
    prices: [{ code: 'a', price: '7.5' }, { code: 'b', price: '8.00' }, { code: 'c', price: null }],
    bands: [{ price: '7.50', band: 'low' }, { price: '8', band: 'mid' }, { price: '8.0', band: 'mid too' }],
  }, { tables: [
    { name: 'prices', columns: [{ name: 'code', type: 'string' }, { name: 'price', type: 'decimal' }] },
    { name: 'bands', columns: [{ name: 'price', type: 'decimal' }, { name: 'band', type: 'string' }] },
  ] });
  const s = { $rows: { code: 'code', bands: { $from: 'bands', $on: { price: 'price' }, $rows: 'band' } } };
  for (const options of [{}, { [SHAPE_LINK_TABLE_ROWS]: 0 }]) {
    assert.deepEqual(JSON.parse(toJSON(open(bytes), { shape: s, ...options })),
      [{ code: 'a', bands: ['low'] }, { code: 'b', bands: ['mid', 'mid too'] }, { code: 'c', bands: [] }]);
  }
});

test('links sorted like their parents are read in step, with every case', () => {
  // Parents with a null key and repeated keys; linked rows with a null key, rows no parent links (more than a stream
  // skips before it seeks), and a nested link whose parents repeat (asked again: a query of its own).
  const kids = [[null, 5], [1, 10], [1, 20], [2, 30], [3, 31]].map(([k, j]) => ({ k, j }));
  for (let k = 5; k < 9000; k++) kids.push({ k, j: k * 10 });
  kids.push({ k: 9000, j: 90000 }, { k: 9000, j: 90001 });
  const stepFile = write(null, {
    parents: [[null, 'n'], [1, 'a'], [1, 'b'], [2, 'c'], [4, 'd'], [9000, 'e']].map(([k, name]) => ({ k, name })),
    kids,
    grand: [[1, 10, 'x10'], [1, 20, 'x20'], [2, 30, 'x30'], [9000, 90000, 'y'], [9000, 90001, 'z']].map(([k, j, v]) => ({ k, j, v })),
  }, { tables: [
    { name: 'parents', sortedBy: ['k'], columns: [{ name: 'k', type: 'int' }, { name: 'name', type: 'string' }] },
    { name: 'kids', sortedBy: ['k', 'j'], chunkRows: 256, columns: [{ name: 'k', type: 'int' }, { name: 'j', type: 'int' }] },
    { name: 'grand', sortedBy: ['k', 'j'], columns: [{ name: 'k', type: 'int' }, { name: 'j', type: 'int' }, { name: 'v', type: 'string' }] },
  ] });
  const s = { $rows: {
    name: 'name',
    kids: { $from: 'kids', $on: { k: 'k' }, $rows: { j: 'j', g: { $from: 'grand', $on: { j: 'j', k: 'k' }, $rows: 'v' } } },
    later: { $from: 'kids', $on: { k: 'k' }, $filter: { j: { gte: 20 } }, $one: { $count: true } },
  } };
  const row = (name, kidsOf, later) => ({ name, kids: kidsOf, later });
  const ab = [{ j: 10, g: ['x10'] }, { j: 20, g: ['x20'] }];
  const e = row('e', [{ j: 90000, g: ['y'] }, { j: 90001, g: ['z'] }], 2);
  const all = [row('n', [], null), row('a', ab, 1), row('b', ab, 1), row('c', [{ j: 30, g: ['x30'] }], 1), row('d', [], null), e];
  const some = [row('a', ab, 1), row('b', ab, 1), e];
  const reader = open(stepFile);
  for (const [options, streams] of [
    [{ [SHAPE_LINK_TABLE_ROWS]: 0 }, 3], // every linked table queried, read in step
    [{ [SHAPE_LINK_TABLE_ROWS]: 0, [SHAPE_LINK_BATCH]: 2 }, 0], // the same in batches
    [{}, 0], // held
  ]) {
    const stats = {};
    assert.deepEqual(JSON.parse(toJSON(reader, { shape: s, ...options, [SHAPE_LINK_STATS]: stats })), all);
    assert.equal(stats.streams, streams);
    assert.deepEqual(JSON.parse(toJSON(reader, { shape: s, filter: { k: { in: [1, 9000] } }, ...options })), some);
  }
});

test('links are checked before any data is read', () => {
  const reader = open(file);
  const fails = (s, message) => assert.throws(() => toJSON(reader, { shape: s }), (e) => e instanceof JazminValidationError && e.message.includes(message), message);
  fails({ $rows: { o: { $from: 'nope', $on: { id: 'id' }, $rows: 'id' } } }, "unknown table 'nope'");
  fails({ $rows: { o: { $from: 'orders', $on: { customer: 'id' }, $rows: 'id' } } }, "unknown or hidden column 'customer' in table 'orders'");
  fails({ $rows: { o: { $from: 'orders', $on: { customer_id: 'idd' }, $rows: 'id' } } }, "unknown or hidden column 'idd'");
  fails({ $rows: { o: { $from: 'orders', $on: { customer_id: 'name' }, $rows: 'id' } } }, "links int column 'customer_id' to string column 'name'");
  fails({ $rows: { o: { $from: 'orders', $on: {}, $rows: 'id' } } }, '$on needs at least one');
  fails({ $rows: { o: { $from: 'orders', $rows: 'id' } } }, '$on needs at least one');
  fails({ $rows: { o: { $from: 'orders', $on: { customer_id: 'id' }, $rows: 'id', $one: 'id' } } }, 'one of $rows or $one');
  fails({ $rows: { o: { $from: 'orders', $on: { customer_id: 'id' }, $rows: 'nope' } } }, "unknown or hidden column 'nope' in table 'orders'");
  fails({ $rows: { o: { $from: 'orders', $on: { customer_id: 'id' }, $one: 'id', $sort: ['id'] } } }, "unknown option '$sort'");
});

test('a shared file: each linked table shows the key only its partitions and columns', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const shared = write(null, { customers, orders, order_lines: lines }, {
    key: owner,
    access: { grants: [{ key: bob, rows: ['3', '*'], columns: ['*'] }] },
    tables: [
      { name: 'customers', columns: tables[0].columns, partitionBy: 'id', columnGroups: { secret: ['country'] } },
      { name: 'orders', columns: tables[2].columns, partitionBy: 'customer_id' },
      { name: 'order_lines', columns: tables[3].columns }, // one partition, '*': granted
    ],
  });
  const view = open(shared, { key: bob.export() });
  const s = { $rows: { id: 'id', orders: { $from: 'orders', $on: { customer_id: 'id' }, $rows: { id: 'id', lines: { $from: 'order_lines', $on: { order_id: 'id' }, $rows: 'line' } } } } };
  const mine = orders.filter((o) => o.customer_id === 3);
  assert.deepEqual(JSON.parse(toJSON(view, { shape: s })), [{ id: 3, orders: mine.map((o) => ({ id: o.id, lines: linesOf(o).map((l) => l.line) })) }]);
  assert.throws(() => toJSON(view, { shape: { $rows: { c: 'country' } } }), /unknown or hidden column 'country'/);
  // The owner sees every customer's orders through the same shape
  assert.equal(JSON.parse(toJSON(open(shared, { key: owner }), { shape: s })).length, customers.length);
});

test('links in XML, and in the JSON Schema of a shape', () => {
  const reader = open(file);
  const s = { $rows: { id: 'id', orders: { $from: 'orders', $on: { customer_id: 'id' }, $rows: { id: 'id', first: { $from: 'order_lines', $on: { order_id: 'id' }, $one: 'sku' } }, $limit: 1, $xmlItem: 'order' } }, $filter: { id: 1 }, $xmlItem: 'customer' };
  const first = orders.filter((o) => o.customer_id === 1)[0];
  const sku = linesOf(first)[0]?.sku;
  assert.equal(toXML(reader, { shape: s }), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<export>',
    '  <customer>',
    '    <id>1</id>',
    '    <orders>',
    '      <order>',
    `        <id>${first.id}</id>`,
    ...(sku ? [`        <first>${sku}</first>`] : []),
    '      </order>',
    '    </orders>',
    '  </customer>',
    '</export>',
    '',
  ].join('\n'));

  const schema = shapeSchema(reader, shape);
  const order = schema.items.properties.orders.items;
  assert.equal(schema.items.properties.orders.type, 'array');
  assert.deepEqual(order.properties.lines.items.properties.product.type, ['object', 'null']);
  assert.deepEqual(order.properties.lineCount.type, ['integer', 'null']);
  assert.deepEqual(order.properties.total.type, ['number', 'null']);
});
