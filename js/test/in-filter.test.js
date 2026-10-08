// `in` conditions are checked with a hash set of the listed keys (and chunk statistics with the keys in order), so a
// long list costs about as much as a short one. Equality is the same as `eq`: decimals by value, -0 equal to 0, NaN
// equal to nothing, numeric strings converted to the column's type, null in the list ignored.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const BEYOND = 9007199254740993n; // 2^53 + 1: an int a Number cannot hold

const rows = Array.from({ length: 3000 }, (_, i) => ({
  id: i,
  big: i % 10 === 0 ? BEYOND + BigInt(i) : i,
  ratio: i % 97 === 0 ? NaN : i % 11 === 0 ? -0 : i / 4,
  price: i % 13 === 0 ? null : `${i % 50}.${i % 2 === 0 ? '50' : '5'}`, // 7.50 and 7.5: one value
  code: i % 17 === 0 ? null : `C${i % 300}`,
  flag: i % 3 === 0,
  at: new Date(Date.UTC(2026, 0, 1) + (i % 400) * 3_600_000),
}));
const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'big', type: 'int' },
  { name: 'ratio', type: 'float' },
  { name: 'price', type: 'decimal' },
  { name: 'code', type: 'string' },
  { name: 'flag', type: 'bool' },
  { name: 'at', type: 'datetime' },
];
const files = {
  scanned: write(null, rows, { columns, chunkRows: 256 }),
  indexed: write(null, rows, {
    columns: columns.map((c) => (c.name === 'id' ? c : { ...c, index: 'sorted' })),
    chunkRows: 256,
  }),
  sorted: write(null, [...rows].sort((a, b) => (a.code ?? '') < (b.code ?? '') ? -1 : (a.code ?? '') > (b.code ?? '') ? 1 : a.id - b.id), {
    columns, chunkRows: 64, sortedBy: ['code', 'id'],
  }),
};

const cents = (p) => Math.round(Number(p) * 100);
const cases = [
  [{ id: { in: [5, '7', 2999, 5000] } }, (r) => [5, 7, 2999].includes(r.id)],
  [{ big: { in: [BEYOND + 20n, '9007199254741023', 31] } }, (r) => [BEYOND + 20n, BEYOND + 30n, 31].includes(r.big)],
  [{ ratio: { in: [NaN, 0, 2.5] } }, (r) => !Number.isNaN(r.ratio) && (r.ratio === 0 || r.ratio === 2.5)],
  [{ price: { in: ['7.5', '8.50', null] } }, (r) => r.price !== null && [750, 850].includes(cents(r.price))],
  [{ code: { in: ['C1', 'C2', 'nope'] } }, (r) => r.code === 'C1' || r.code === 'C2'],
  [{ flag: { in: [true] } }, (r) => r.flag],
  [{ at: { in: ['2026-01-01T05:00:00Z', new Date(Date.UTC(2026, 0, 2))] } }, (r) => [Date.UTC(2026, 0, 1, 5), Date.UTC(2026, 0, 2)].includes(r.at.getTime())],
  [{ code: { in: [] } }, () => false],
  [{ not: { code: { in: ['C1'] } } }, (r) => r.code !== 'C1'],
  [{ code: { in: ['C3', 'C4'] }, flag: false }, (r) => (r.code === 'C3' || r.code === 'C4') && !r.flag],
];
const idsOf = (list) => list.map((r) => r.id).sort((a, b) => a - b);

for (const [name, bytes] of Object.entries(files)) {
  test(`in (${name}): the same rows as checking each listed value, in the library and the browser reader`, async () => {
    const reader = open(bytes);
    const browser = await JazminBrowser.open(bytes);
    for (const [filter, predicate] of cases) {
      const expected = idsOf(rows.filter(predicate));
      assert.deepEqual(idsOf([...reader.find(filter)]), expected, `library ${JSON.stringify(filter, (k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
      assert.equal(reader.count(filter), expected.length);
      const found = [];
      for await (const row of browser.find(filter)) found.push(row);
      assert.deepEqual(idsOf(found), expected, `browser ${JSON.stringify(filter, (k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
      assert.equal(await browser.count(filter), expected.length);
    }
  });
}

test('in: chunk statistics skip the chunks holding none of the listed values', () => {
  const reader = open(files.sorted);
  const { chunks, chunksSkipped } = reader.explain({ code: { in: ['C10', 'C11'] } });
  assert.ok(chunksSkipped >= chunks - 3, `${chunksSkipped} of ${chunks} skipped`);
});

test('in: a long list costs about as much as a short one (100,000 rows, 20,000 values)', async () => {
  const many = write(null, Array.from({ length: 100_000 }, (_, i) => ({ id: i, code: `K${(i * 7919) % 100_000}` })), {
    columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'code', type: 'string' }],
  });
  const values = Array.from({ length: 20_000 }, (_, i) => `K${i * 5}`);
  const reader = open(many);
  let start = performance.now();
  assert.equal(reader.count({ code: { in: values } }), 20_000);
  const ms = performance.now() - start;
  assert.ok(ms < 3000, `library: ${Math.round(ms)} ms (comparing each row with each value took tens of seconds)`);

  const browser = await JazminBrowser.open(many);
  start = performance.now();
  assert.equal(await browser.count({ code: { in: values } }), 20_000);
  const browserMs = performance.now() - start;
  assert.ok(browserMs < 5000, `browser reader: ${Math.round(browserMs)} ms`);
});
