// Export shapes in the browser reader (JazminBrowser.toJSON / toXML / exportBlob with { shape }, and shapeSchema): the
// same output as the library's, byte for byte. The golden cases (every value type, escapes, metadata, aggregates,
// groups, sorts, limits, empty results) are checked against the output recorded for the library; links between tables
// against the library's output for the same file, both for small linked tables (kept by key) and for one too large to
// keep (fetched per batch of parents).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { open, shapeSchema, toJSON, toXML, write } from '../src/index.js';
import { cases, columns, jsonOnlyRows, metadata, rows } from './shape-golden-cases.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../spec/fixtures');
const golden = JSON.parse(fs.readFileSync(path.join(here, 'shape-golden.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

test('shapes: the golden output, as JSON, pretty JSON, filtered, and as XML', async () => {
  const jsonReader = await JazminBrowser.open(write(null, jsonOnlyRows, { columns, metadata }));
  const xmlReader = await JazminBrowser.open(write(null, rows, { columns, metadata }));
  for (const [name, shape] of Object.entries(cases)) {
    assert.equal(await JazminBrowser.toJSON(jsonReader, { shape }), golden[`${name} | json`], `${name} | json`);
    assert.equal(await JazminBrowser.toJSON(jsonReader, { shape, pretty: true }), golden[`${name} | pretty`], `${name} | pretty`);
    assert.equal(await JazminBrowser.toJSON(jsonReader, { shape, filter: { country: { in: ['ZA', 'BW'] } } }), golden[`${name} | filtered json`], `${name} | filtered`);
    assert.equal(await JazminBrowser.toXML(xmlReader, { shape }), golden[`${name} | xml`], `${name} | xml`);
    assert.equal(await JazminBrowser.toXML(xmlReader, { shape, root: 'golden', filter: { country: 'NA' } }), golden[`${name} | xml root`], `${name} | xml root`);
  }
});

test('shapes: the JSON Schema of each golden case equals the library\'s', async () => {
  const bytes = write(null, jsonOnlyRows, { columns, metadata });
  const browser = await JazminBrowser.open(bytes);
  const library = open(bytes);
  for (const shape of Object.values(cases)) assert.deepEqual(await JazminBrowser.shapeSchema(browser, shape), shapeSchema(library, shape));
});

// Several tables linked by shapes, as in shape-links.test.js.
const products = Array.from({ length: 12 }, (_, i) => ({ sku: `P${String(i).padStart(2, '0')}`, name: `Product ${i}`, price: `${10 + i}.50` }));
const customers = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Customer ${i + 1}`, country: ['ZA', 'NA', 'BW'][i % 3], parent_id: i === 0 ? null : 1 + ((i * 5) % i) }));
const orders = [];
const lines = [];
for (let id = 1; id <= 200; id++) {
  const customer = id === 7 ? null : 1 + ((id * 7) % 29);
  orders.push({ id, customer_id: customer, placed: new Date(Date.UTC(2026, 0, 1) + ((id * 37) % 200) * 86_400_000), total: `${id * 3}.00` });
  for (let n = 1; n <= id % 5; n++) {
    lines.push({ order_id: id, line: n, sku: id % 11 === 0 && n === 1 ? 'GONE' : `P${String((id + n) % 12).padStart(2, '0')}`, amount: `${n}.25`, customer_id: customer });
  }
}
// Over the 100,000 rows a linked table is kept whole for: its rows are fetched per batch of parents.
const events = Array.from({ length: 120_000 }, (_, i) => ({ seq: i, customer_id: 1 + ((i * 13) % 30), kind: ['view', 'buy', 'call'][i % 3] }));
const linkFile = write(null, { customers, products, orders, order_lines: lines, events }, {
  tables: [
    { name: 'customers', sortedBy: ['id'], columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'string' }, { name: 'country', type: 'string' }, { name: 'parent_id', type: 'int' }] },
    { name: 'products', sortedBy: ['sku'], columns: [{ name: 'sku', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'price', type: 'decimal' }] },
    { name: 'orders', sortedBy: ['id'], chunkRows: 16, columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'customer_id', type: 'int', index: 'sorted' }, { name: 'placed', type: 'datetime' }, { name: 'total', type: 'decimal' }] },
    { name: 'order_lines', sortedBy: ['order_id', 'line'], chunkRows: 32, columns: [{ name: 'order_id', type: 'int', nullable: false }, { name: 'line', type: 'int', nullable: false }, { name: 'sku', type: 'string' }, { name: 'amount', type: 'decimal' }, { name: 'customer_id', type: 'int' }] },
    { name: 'events', columns: [{ name: 'seq', type: 'int', nullable: false }, { name: 'customer_id', type: 'int', index: 'sorted' }, { name: 'kind', type: 'string' }] },
  ],
});

const LINK_SHAPES = {
  'customers, their orders, lines and products': {
    $rows: {
      id: 'id', name: 'name',
      orders: {
        $from: 'orders', $on: { customer_id: 'id' }, $sort: ['placed', 'id'],
        $rows: {
          id: 'id', placed: 'placed', total: 'total',
          lines: { $from: 'order_lines', $on: { order_id: 'id' }, $rows: { line: 'line', amount: 'amount', product: { $from: 'products', $on: { sku: 'sku' }, $one: { name: 'name', price: 'price' } } } },
          lineCount: { $from: 'order_lines', $on: { order_id: 'id' }, $one: { $count: true } },
          lineTotal: { $from: 'order_lines', $on: { order_id: 'id' }, $one: { $sum: 'amount' } },
        },
      },
    },
  },
  'links in the root object': { customer: 'name', orders: { $from: 'orders', $on: { customer_id: 'id' }, $rows: { id: 'id', total: 'total' } } },
  'filter, sort, limit and groups on linked rows': {
    $rows: {
      id: 'id',
      big: { $from: 'orders', $on: { customer_id: 'id' }, $filter: { total: { gte: '300' } }, $sort: ['-total'], $limit: 2, $rows: { id: 'id', total: 'total' } },
      byMonth: { $from: 'order_lines', $on: { customer_id: 'id' }, $groupBy: 'sku', $sort: ['sku'], $rows: { sku: 'sku', n: { $count: true }, sum: { $sum: 'amount' } } },
    },
  },
  'links inside groups, on two columns, and to the same table': {
    byCountry: {
      $groupBy: 'country', $sort: ['country'],
      $rows: {
        country: 'country',
        customers: { $rows: { id: 'id', parent: { $from: 'customers', $on: { id: 'parent_id' }, $one: { name: 'name' } } } },
        orderCount: { $count: true },
      },
    },
    lines: { $from: 'order_lines', $on: { order_id: 'id', customer_id: 'id' }, $rows: { line: 'line' } },
  },
  'a linked table too large to keep (fetched per batch of parents)': {
    $rows: { id: 'id', events: { $from: 'events', $on: { customer_id: 'id' }, $filter: { kind: 'buy' }, $limit: 3, $sort: ['-seq'], $rows: { seq: 'seq', kind: 'kind' } }, eventCount: { $from: 'events', $on: { customer_id: 'id' }, $one: { $count: true } } },
  },
};

test('shapes across tables: the library\'s output, as JSON and XML, with an export filter', async () => {
  const browser = await JazminBrowser.open(linkFile, { table: 'customers' });
  const library = open(linkFile, { table: 'customers' });
  for (const [name, shape] of Object.entries(LINK_SHAPES)) {
    assert.equal(await JazminBrowser.toJSON(browser, { shape }), toJSON(library, { shape }), `${name} | json`);
    assert.equal(await JazminBrowser.toJSON(browser, { shape, pretty: true, filter: { country: 'NA' } }), toJSON(library, { shape, pretty: true, filter: { country: 'NA' } }), `${name} | filtered`);
    assert.equal(await JazminBrowser.toXML(browser, { shape }), toXML(library, { shape }), `${name} | xml`);
    assert.deepEqual(await JazminBrowser.shapeSchema(browser, shape), shapeSchema(library, shape), `${name} | schema`);
  }
  library.close();
});

test('shapes on the interop fixtures, written by either library', async () => {
  for (const file of ['js-key.jzm', 'dotnet-key.jzm', 'js-paged-key.jzm']) {
    const browser = await JazminBrowser.open(fs.readFileSync(path.join(fixtures, file)), { key: keys.key });
    assert.deepEqual(JSON.parse(await JazminBrowser.toJSON(browser, { shape: fixture('shape.json') })), fixture('shape-expected.json'), file);
  }
  for (const file of ['js-tables.jzm', 'dotnet-tables.jzm']) {
    const browser = await JazminBrowser.open(fs.readFileSync(path.join(fixtures, file)));
    assert.deepEqual(JSON.parse(await JazminBrowser.toJSON(browser, { shape: fixture('shape-links.json') })), fixture('shape-links-expected.json'), file);
  }
});

test('shapes say what is wrong, as the library does; CSV takes no shape; Stop ends a shaped export', async () => {
  const bytes = write(null, jsonOnlyRows, { columns, metadata });
  const browser = await JazminBrowser.open(bytes);
  const library = open(bytes);
  for (const shape of [
    { $rows: { x: 'nope' } },
    { a: { $rows: 'id', $groupBy: 'raw' } },
    { $rows: { id: 'id', inner: { $rows: 'id' } } },
    { total: { $sum: 'text' } },
    { $rows: 'id', $filter: { nope: 1 } },
    { l: { $from: 'missing', $on: { id: 'id' }, $rows: 'id' } },
    [1, 2],
  ]) {
    const expected = (() => {
      try {
        toJSON(library, { shape });
      } catch (error) {
        return error.message;
      }
      return null;
    })();
    await assert.rejects(JazminBrowser.toJSON(browser, { shape }), (error) => error instanceof JazminBrowser.JazminValidationError && error.message === expected, JSON.stringify(shape));
  }
  await assert.rejects(JazminBrowser.toCSV(browser, { shape: { $rows: 'id' } }), /Shapes export JSON or XML, not 'csv'/);
  await assert.rejects(JazminBrowser.toJSON(browser, { shape: { $rows: 'id' }, limit: 3 }), /use \$rows\/\$limit in the shape/);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(JazminBrowser.exportBlob(browser, 'json', { shape: { $rows: 'id' }, signal: stop.signal }), { name: 'AbortError' });
});

test('maxLength: an export stopped once it is long enough, as a preview', async () => {
  const bytes = write(null, jsonOnlyRows, { columns, metadata });
  const browser = await JazminBrowser.open(bytes);
  const whole = await JazminBrowser.toJSON(browser, { shape: cases['every column, one row each'], pretty: true });
  const preview = await JazminBrowser.toJSON(browser, { shape: cases['every column, one row each'], pretty: true, maxLength: 500 });
  assert.equal(preview, whole.slice(0, 500));
  assert.equal(await JazminBrowser.toCSV(browser, { maxLength: 100 }), (await JazminBrowser.toCSV(browser)).slice(0, 100));
  assert.equal(await JazminBrowser.toJSON(browser, { maxLength: 1e9 }), await JazminBrowser.toJSON(browser));
});

test('saved shapes: listed for the keys that can use them and run by name, as in the library, in files of both libraries', async () => {
  const { views } = fixture('saved-shapes.json');
  for (const writer of ['js', 'dotnet']) {
    // The browser refuses a shared file's owner key, so the shared file is read with access keys only.
    for (const [file, keyNames] of [[`${writer}-shapes-key.jzm`, ['key']], [`${writer}-shapes-access.jzm`, Object.keys(views).filter((k) => k !== 'key')]]) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(fixtures, file)));
      for (const keyName of keyNames) {
        const reader = await JazminBrowser.open(bytes, { key: keys[keyName] });
        const library = open(path.join(fixtures, file), { key: keys[keyName], accessState: false });
        try {
          const shapes = await reader.shapes();
          assert.deepEqual(shapes.map((s) => s.name), views[keyName], `${file} ${keyName}`);
          assert.deepEqual(shapes.map(({ groups, ...s }) => s), library.shapes.map(({ groups, ...s }) => s)); // groups: the owner's, known to the library
          for (const s of shapes) {
            assert.equal(await JazminBrowser.toJSON(reader, { shape: s.name, pretty: true }), toJSON(library, { shape: s.name, pretty: true }), `${file} ${keyName} ${s.name}`);
            assert.equal(await JazminBrowser.toXML(reader, { shape: s.name }), toXML(library, { shape: s.name }));
            assert.deepEqual(await JazminBrowser.shapeSchema(reader, s.name), shapeSchema(library, s.name));
          }
          await assert.rejects(JazminBrowser.toJSON(reader, { shape: 'Nope' }), { message: "No saved shape 'Nope' is visible with this key" });
        } finally {
          library.close();
        }
      }
    }
  }
});
