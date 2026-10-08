// Shape output, byte for byte: every value type, escapes, literals, metadata, aggregates, groups, sorts, limits and
// empty results, as JSON, pretty JSON and XML. The expected output (shape-golden.json) was recorded with JAZMIN 1.2.0
// before the shape writer was compiled; any change to it is a change to the export format. To record it again on
// purpose: JAZMIN_WRITE_GOLDEN=1 node --test test/shape-output.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { open, toJSON, toXML, write } from '../src/index.js';

const goldenPath = fileURLToPath(new URL('./shape-golden.json', import.meta.url));

const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'big', type: 'int' },
  { name: 'flag', type: 'bool' },
  { name: 'ratio', type: 'float' },
  { name: 'price', type: 'decimal' },
  { name: 'text', type: 'string' },
  { name: 'country', type: 'string' },
  { name: 'at', type: 'datetime' },
  { name: 'raw', type: 'binary' },
  { name: 'extra', type: 'json' },
];
const TEXTS = ['plain', 'quote " and \\ backslash', 'line\nbreak\ttab', 'unicode é ü 中文 😀', 'separators    ', '', '<tag> & "amp"'];
const RATIOS = [0.1, -0, 1e21, 2.5e-7, NaN, Infinity, -Infinity, 123456.789, null];
const rows = Array.from({ length: 40 }, (_, i) => ({
  id: i,
  big: i % 7 === 0 ? 9007199254740993n + BigInt(i) : i % 5 === 0 ? null : -i * 1000,
  flag: i % 4 === 0 ? null : i % 3 === 0,
  ratio: RATIOS[i % RATIOS.length],
  price: i % 6 === 0 ? null : `${(i * 37) % 100}.${String(i % 100).padStart(2, '0')}`,
  text: i % 9 === 8 ? null : TEXTS[i % TEXTS.length],
  country: ['ZA', 'NA', 'BW'][i % 3],
  at: i % 8 === 0 ? null : new Date(Date.UTC(2025, i % 12, 1 + (i % 27), i % 24, i % 60, 0, i * 7)),
  raw: i % 5 === 0 ? null : Buffer.from([i, 255 - i, 0, 1]),
  extra: i % 10 === 0 ? null : { n: i, s: TEXTS[(i + 1) % TEXTS.length], list: [1, 'two', null, { deep: [true, false] }] },
}));
// The control characters below are valid JSON (escaped) but not XML 1.0: kept to the JSON cases.
const jsonOnlyRows = rows.map((r, i) => ({ ...r, text: i % 11 === 1 ? 'control \u0001 \u001f' : r.text }));

const all = Object.fromEntries(columns.map((c) => [c.name, c.name]));
const cases = {
  'every column, one row each': { $rows: all },
  'every column, sorted and limited': { $rows: all, $sort: ['-price', 'id'], $limit: 7 },
  'distinct values': { countries: { $rows: 'country', $groupBy: 'country', $sort: ['country'] } },
  'groups with aggregates and nested lists': {
    title: { $meta: 'title' },
    missing: { $meta: 'nope' },
    literals: { s: { $value: 'text "quoted"' }, n: 42, f: 1.5, t: true, nil: null, obj: { $value: { a: [1, { b: 'c' }] } } },
    empty: {},
    byCountry: {
      $rows: {
        country: 'country',
        count: { $count: true },
        sumBig: { $sum: 'big' },
        sumRatio: { $sum: 'ratio' },
        sumPrice: { $sum: 'price' },
        minPrice: { $min: 'price' },
        maxAt: { $max: 'at' },
        minText: { $min: 'text' },
        firstExtra: 'extra',
        detail: { first: { id: 'id', raw: 'raw' }, nothing: {} },
        lines: { $rows: { id: 'id', at: 'at', flag: 'flag', ratio: 'ratio' }, $sort: ['-at'], $limit: 3 },
        flagged: { $rows: { id: 'id' }, $filter: { flag: true } },
        byFlag: { $rows: { flag: 'flag', n: { $count: true }, ids: { $rows: 'id' } }, $groupBy: 'flag', $sort: ['flag'] },
      },
      $groupBy: 'country',
      $sort: ['-country'],
    },
    total: { $sum: 'price' },
    count: { $count: true },
  },
  'nothing matches': { none: { $rows: all, $filter: { id: { lt: 0 } } }, groups: { $rows: { c: 'country', n: { $count: true } }, $groupBy: 'country', $filter: { id: { lt: 0 } } }, first: 'text', sum: { $sum: 'ratio' } },
  'odd member names (XML)': { $rows: { 'two words': 'country', xmlish: 'id', '1digit': 'flag', 'ok-name.v2': 'price' }, $xmlItem: 'entry' },
};

function outputs(source) {
  const reader = open(write(null, source, { columns, metadata: { title: 'Golden "export" <test>' } }));
  const result = {};
  for (const [name, shape] of Object.entries(cases)) {
    result[`${name} | json`] = toJSON(reader, { shape });
    result[`${name} | pretty`] = toJSON(reader, { shape, pretty: true });
    result[`${name} | filtered json`] = toJSON(reader, { shape, filter: { country: { in: ['ZA', 'BW'] } } });
  }
  return result;
}

function xmlOutputs() {
  const reader = open(write(null, rows, { columns, metadata: { title: 'Golden "export" <test>' } }));
  const result = {};
  for (const [name, shape] of Object.entries(cases)) {
    result[`${name} | xml`] = toXML(reader, { shape });
    result[`${name} | xml root`] = toXML(reader, { shape, root: 'golden', filter: { country: 'NA' } });
  }
  return result;
}

const actual = { ...outputs(jsonOnlyRows), ...xmlOutputs() };
if (process.env.JAZMIN_WRITE_GOLDEN) fs.writeFileSync(goldenPath, `${JSON.stringify(actual, null, 1)}\n`);
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

for (const key of Object.keys(golden)) {
  test(`shape output is unchanged: ${key}`, () => {
    assert.equal(actual[key], golden[key]);
  });
}

test('the golden cases are all still run', () => {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(golden).sort());
});
