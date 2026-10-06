import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, append, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

// columnArrays() (issue #19): column values as arrays for charts instead of an object per row. Numbers and dates in a
// Float64Array, bools in a Uint8Array, other types in plain arrays; nulls in a bitmap for the typed ones. Every value
// must equal what find() returns, in the Node and browser readers.

const { JazminBrowser } = globalThis;
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-arrays-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'at', type: 'datetime' },
  { name: 'amount', type: 'float' },
  { name: 'active', type: 'bool' },
  { name: 'label', type: 'string' },
  { name: 'price', type: 'decimal' },
];
const row = (i) => ({
  id: i,
  at: i % 11 === 0 ? null : new Date(Date.UTC(2025, 0, 1) + i * 3_600_000),
  amount: i % 13 === 0 ? null : i % 17 === 0 ? NaN : i / 4,
  active: i % 7 === 0 ? null : i % 2 === 0,
  label: i % 5 === 0 ? null : `L${i % 9}`,
  price: `${i}.50`,
});

function appendedFile() {
  const file = tmp('rows.jzm');
  write(file, Array.from({ length: 900 }, (_, i) => row(i)), { columns, sortedBy: ['id'], chunkRows: 64 });
  append(file, { insert: Array.from({ length: 100 }, (_, i) => row(900 + i)), delete: { id: { in: [3, 64, 500, 950] } } });
  return file;
}

const isNull = (bitmap, i) => bitmap !== undefined && (bitmap[i >> 3] & (1 << (i & 7))) !== 0;

/** The arrays, turned back into rows: what find() would return for those columns. */
function asRows({ rowCount, values, nulls }, select) {
  return Array.from({ length: rowCount }, (_, i) => Object.fromEntries(select.map((name) => {
    const column = columns.find((c) => c.name === name);
    let v = values[name][i];
    if (isNull(nulls[name], i)) v = null;
    else if (column.type === 'datetime') v = new Date(v);
    else if (column.type === 'bool') v = v === 1;
    return [name, v];
  })));
}

const QUERIES = [
  [null, {}],
  [{ amount: { gt: 50 } }, {}],
  [{ id: { gte: 100, lt: 400 } }, { offset: 30, limit: 120 }],
  [{ label: 'L3' }, { limit: 7 }],
  [null, { offset: 990 }],
  [null, { offset: 60, limit: 200 }], // starts inside the first chunk, crosses the deleted row 64 and chunk boundaries
];

test('columnArrays returns typed arrays equal to the rows find() returns', () => {
  const reader = open(appendedFile());
  try {
    const select = ['at', 'amount', 'active', 'label', 'price'];
    for (const [filter, options] of QUERIES) {
      const arrays = reader.columnArrays(filter, { select, ...options });
      assert.ok(arrays.values.at instanceof Float64Array && arrays.values.amount instanceof Float64Array);
      assert.ok(arrays.values.active instanceof Uint8Array);
      assert.ok(Array.isArray(arrays.values.label) && Array.isArray(arrays.values.price));
      assert.deepEqual(asRows(arrays, select), [...reader.find(filter, { select, ...options })], JSON.stringify([filter, options]));
    }
    const all = reader.columnArrays(null, { select: ['amount'] });
    assert.equal(all.rowCount, reader.rowCount);
    assert.ok(Number.isNaN(all.values.amount[0]) && isNull(all.nulls.amount, 0)); // id 0: null amount
    assert.equal(all.nulls.label, undefined); // plain arrays hold null themselves
    assert.deepEqual(Object.keys(reader.columnArrays({ id: 1 }).values), columns.map((c) => c.name)); // default: every column
  } finally {
    reader.close();
  }
});

test('columnArrays refuses unknown columns and integers a Float64Array cannot hold', () => {
  const file = tmp('big.jzm');
  write(file, [{ id: 1, big: 2n ** 60n }, { id: 2, big: 5n }], { columns: [{ name: 'id', type: 'int' }, { name: 'big', type: 'int' }] });
  const reader = open(file);
  try {
    assert.throws(() => reader.columnArrays(null, { select: ['nope'] }), /Unknown column 'nope'/);
    assert.throws(() => reader.columnArrays(null, { select: ['big'] }), /beyond ±2\^53/);
    assert.deepEqual([...reader.columnArrays({ id: 2 }, { select: ['big'] }).values.big], [5]);
  } finally {
    reader.close();
  }
});

test('columnArrays in an access-controlled file shows only what the key sees', async () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('access.jzm');
  write(file, Array.from({ length: 300 }, (_, i) => ({ ...row(i), label: `P${i % 3}` })), {
    columns, key: owner, chunkRows: 32,
    access: { partitionBy: 'label', columnGroups: { money: ['amount', 'price'] }, grants: [{ key: bob, rows: ['P1'], columns: ['*'] }] },
  });
  const reader = open(file, { key: bob });
  const ownerReader = open(file, { key: owner });
  try {
    const arrays = reader.columnArrays(null, { select: ['id', 'at'] });
    assert.deepEqual([...arrays.values.id], Array.from({ length: 100 }, (_, i) => i * 3 + 1));
    assert.throws(() => reader.columnArrays(null, { select: ['amount'] }), /Unknown column 'amount'/);
    // Filtered, and the owner's view: the values are the rows find() returns.
    const select = ['id', 'at', 'amount'];
    for (const [r, filter, options] of [[reader, { id: { gt: 100 } }, { limit: 40 }], [ownerReader, { amount: { gt: 20 } }, { offset: 5 }], [ownerReader, null, {}]]) {
      const names = r === reader ? ['id', 'at'] : select;
      assert.deepEqual(asRows(r.columnArrays(filter, { select: names, ...options }), names), [...r.find(filter, { select: names, ...options })]);
    }
    // The browser reader, with the access key: the same arrays.
    const browser = await JazminBrowser.open(new Blob([fs.readFileSync(file)]), { key: bob.export() });
    for (const filter of [null, { id: { gt: 100 } }]) {
      const expected = reader.columnArrays(filter, { select: ['id', 'at'] });
      const actual = await browser.columnArrays(filter, { select: ['id', 'at'] });
      assert.deepEqual([actual.rowCount, [...actual.values.id], [...actual.values.at]], [expected.rowCount, [...expected.values.id], [...expected.values.at]]);
    }
  } finally {
    reader.close();
    ownerReader.close();
  }
});

test('the browser reader returns the same arrays', async () => {
  const file = appendedFile();
  const reader = open(file);
  const browser = await JazminBrowser.open(new Blob([fs.readFileSync(file)]));
  try {
    const select = ['at', 'amount', 'active', 'label', 'price'];
    for (const [filter, options] of QUERIES) {
      const expected = reader.columnArrays(filter, { select, ...options });
      const actual = await browser.columnArrays(filter, { select, ...options });
      assert.equal(actual.rowCount, expected.rowCount);
      for (const name of select) {
        assert.equal(actual.values[name].constructor, expected.values[name].constructor, name);
        assert.deepEqual([...actual.values[name]], [...expected.values[name]], `${name} ${JSON.stringify([filter, options])}`);
        assert.deepEqual(actual.nulls[name] && [...actual.nulls[name]], expected.nulls[name] && [...expected.nulls[name]], name);
      }
    }
  } finally {
    reader.close();
  }
});
