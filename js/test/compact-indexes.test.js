// Compact sorted indexes (reader feature 'index-deltas', spec 8.1): pages with encoding 1 hold keys and first row ids
// as differences from the previous entry's. Written only when asked for; a reader without the feature refuses the file
// and names it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { INDEX_DELTAS, SUPPORTED_READER_FEATURES } from '../src/constants.js';
import { JazminFormatError, JazminValidationError, append, compact, open, update, write } from '../src/index.js';
import { SortedIndex, SortedIndexBuilder } from '../src/indexes.js';
import '../browser/jazmin-browser.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-compact-indexes-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const VALUES = {
  int: [0, 1, -1, 2, 7, 1000, -1000, 2 ** 31, -(2 ** 31), 2 ** 53 - 1, -(2 ** 53 - 1), 2n ** 53n, 2n ** 60n, -(2n ** 63n), 2n ** 63n - 1n, 123456789],
  datetime: [0, 1, -1, 86_400_000, Date.UTC(2026, 9, 7), Date.UTC(1900, 0, 1), 8.64e15, -8.64e15].map((ms) => new Date(ms)),
  string: ['', 'a', 'ab', 'abc', 'abd', 'b', 'TX00A1', 'TX00A2', 'TX00B', 'é', 'éa', 'ê', '日本', '日本語', '👋', '👋👋', 'z'.repeat(300)],
  float: [0, -0, 1.5, -1.5, 1e300, -1e-300, 0.1 + 0.2],
  decimal: ['0', '1.5', '-1.50', '123456789012345678901234567890.12', '0.001'],
  bool: [true, false],
};

test('pages with keys as differences decode to the same keys and row ids, for every indexable type', () => {
  for (const [type, values] of Object.entries(VALUES)) {
    for (const seed of [1, 2, 3]) {
      const rnd = random(seed);
      const plain = new SortedIndexBuilder(type);
      const compact = new SortedIndexBuilder(type);
      for (let row = 0; row < 3000; row++) {
        // Repeated values, nulls, and rows out of key order (several runs).
        const value = rnd() < 0.05 ? null : values[Math.floor(rnd() * values.length)];
        plain.add(row, value);
        compact.add(row, value);
      }
      const pageBytes = 200; // many small pages: each starts afresh
      const plainPages = [...plain.pages(pageBytes)];
      const compactPages = [...compact.pages(pageBytes, true)];
      assert.equal(compactPages.length, plainPages.length, `${type} ${seed}`);
      compactPages.forEach((page, i) => {
        assert.equal(page.raw[0], 1, 'encoding byte');
        assert.deepEqual(page.first, plainPages[i].first);
        assert.equal(page.count, plainPages[i].count);
        const expected = SortedIndex.decodePage(plainPages[i].raw, type);
        const actual = SortedIndex.decodePage(page.raw, type, true);
        assert.deepEqual(actual.postings, expected.postings, `${type} ${seed} page ${i}`);
        assert.deepEqual(actual.keys.map(String), expected.keys.map(String), `${type} ${seed} page ${i}`);
        assert.throws(() => SortedIndex.decodePage(page.raw, type), /encoding 1/); // not without the feature
      });
    }
  }
});

const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'code', type: 'string', index: 'sorted' },
  { name: 'at', type: 'datetime', index: 'sorted' },
  { name: 'amount', type: 'float' },
];
const row = (i) => ({ id: (i * 7919) % 50_021, code: i % 13 === 0 ? null : `TX${(i * 104729) % 99_991}`, at: new Date(Date.UTC(2026, 0, 1) + i * 60_000), amount: i / 8 });
const rowsOf = (n, from = 0) => Array.from({ length: n }, (_, i) => row(from + i));

/** Opens the file as a 1.x reader would: one that does not know 'index-deltas'. */
function openAsOldReader(file) {
  SUPPORTED_READER_FEATURES.delete(INDEX_DELTAS);
  try {
    open(file).close();
  } finally {
    SUPPORTED_READER_FEATURES.add(INDEX_DELTAS);
  }
}

const queries = [
  { id: 4242 },
  { id: { gte: 1000, lt: 1400 } },
  { id: { in: [1, 7919, 49_999, 77] } },
  { code: 'TX1234' },
  { code: { startsWith: 'TX99' } },
  { code: null },
  { at: { gte: new Date(Date.UTC(2026, 0, 2)), lt: new Date(Date.UTC(2026, 0, 2, 3)) } },
];
function results(file) {
  const r = open(file);
  try {
    return queries.map((q) => [...r.find(q)]);
  } finally {
    r.close();
  }
}

test('a file with compact indexes: the same rows, a smaller file, and refused by readers without the feature', () => {
  const plain = path.join(dir, 'plain.jzm');
  const compactFile = path.join(dir, 'compact.jzm');
  write(plain, rowsOf(6000), { columns });
  write(compactFile, rowsOf(6000), { columns, compactIndexes: true });
  assert.deepEqual(results(compactFile), results(plain));
  assert.ok(fs.statSync(compactFile).size < fs.statSync(plain).size);
  openAsOldReader(plain);
  assert.throws(() => openAsOldReader(compactFile), (e) => e instanceof JazminFormatError && e.message.includes("'index-deltas'"));

  // Without a sorted index the file does not use the feature, so it does not name it.
  const unindexed = path.join(dir, 'unindexed.jzm');
  write(unindexed, rowsOf(100), { columns: columns.map(({ index, ...c }) => c), compactIndexes: true }); // eslint-disable-line no-unused-vars
  openAsOldReader(unindexed);

  assert.throws(() => write(path.join(dir, 'bad.jzm'), rowsOf(1), { columns, compactIndexes: 'yes' }), JazminValidationError);
});

test('appends keep the file\'s index encoding; update and compact keep it unless told otherwise', () => {
  const compactFile = path.join(dir, 'grows-compact.jzm');
  const plain = path.join(dir, 'grows-plain.jzm');
  write(compactFile, rowsOf(3000), { columns, compactIndexes: true });
  write(plain, rowsOf(3000), { columns });
  append(compactFile, { insert: rowsOf(2000, 3000) });
  append(plain, { insert: rowsOf(2000, 3000) });
  assert.deepEqual(results(compactFile), results(plain));
  assert.throws(() => openAsOldReader(compactFile), /index-deltas/);
  openAsOldReader(plain);

  compact(compactFile); // keeps compact indexes
  assert.throws(() => openAsOldReader(compactFile), /index-deltas/);
  update(compactFile, { insert: rowsOf(10, 5000) }); // keeps them too
  assert.throws(() => openAsOldReader(compactFile), /index-deltas/);
  update(compactFile, { compactIndexes: false }); // back to what every reader reads
  openAsOldReader(compactFile);
  update(plain, { insert: rowsOf(10, 5000), compactIndexes: true });
  assert.throws(() => openAsOldReader(plain), /index-deltas/);
  assert.deepEqual(results(compactFile), results(plain));
});

test('the browser reader reads compact indexes as the library does', async () => {
  const file = path.join(dir, 'browser.jzm');
  write(file, rowsOf(6000), { columns, compactIndexes: true });
  const reader = await JazminBrowser.open(fs.readFileSync(file));
  const expected = results(file);
  for (let i = 0; i < queries.length; i++) {
    const rows = [];
    for await (const r of reader.find(queries[i])) rows.push(r);
    assert.deepEqual(rows, expected[i], JSON.stringify(queries[i]));
  }
});
