// The golden shape cases (shape-output.test.js): every value type, escapes, literals, metadata, aggregates, groups,
// sorts, limits and empty results. The browser reader's shapes are checked against the same recorded output
// (browser-shapes.test.js).
export const columns = [
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
export const rows = Array.from({ length: 40 }, (_, i) => ({
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
export const jsonOnlyRows = rows.map((r, i) => ({ ...r, text: i % 11 === 1 ? 'control \u0001 \u001f' : r.text }));

const all = Object.fromEntries(columns.map((c) => [c.name, c.name]));
export const cases = {
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
export const metadata = { title: 'Golden "export" <test>' };
