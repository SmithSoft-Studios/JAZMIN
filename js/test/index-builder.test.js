import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteWriter } from '../src/binary.js';
import { POSTINGS_ENCODING } from '../src/constants.js';
import { SortedIndexBuilder, writePostings } from '../src/indexes.js';
import { encodeBound } from '../src/stats.js';
import { compareKeys, encodeValue, keyId, normalizeValue, toKey } from '../src/types.js';

// The sorted index builder (TASKS P-5) must write exactly the pages it always has: the same keys in the same order,
// with the same postings, whatever order rows arrive in. Compared with the 1.0 builder, kept here as the reference.
// Mirrors IndexBuilderTests in the .NET tests.

class ReferenceBuilder {
  constructor(type) {
    this.type = type;
    this.entries = new Map();
  }

  add(rowId, value) {
    if (value === null) return;
    const key = toKey(this.type, value);
    if (Number.isNaN(key)) return;
    const id = keyId(key);
    let entry = this.entries.get(id);
    if (!entry) this.entries.set(id, (entry = { key, ids: [] }));
    entry.ids.push(rowId);
  }

  pages(pageBytes) {
    const sorted = [...this.entries.values()].sort((a, b) => compareKeys(a.key, b.key));
    const pages = [];
    const body = new ByteWriter(1024);
    let first;
    let count = 0;
    const flush = () => {
      const raw = new ByteWriter(body.length + 11);
      raw.byte(POSTINGS_ENCODING);
      raw.varUint(count);
      raw.bytes(body.buf.subarray(0, body.length));
      pages.push({ first: encodeBound(this.type, first), count, raw: raw.toBuffer() });
      body.length = 0;
      count = 0;
    };
    for (const { key, ids } of sorted) {
      if (count === 0) first = key;
      encodeValue(body, this.type, key);
      writePostings(body, ids);
      count++;
      if (body.length >= pageBytes) flush();
    }
    if (count > 0) flush();
    return pages;
  }
}

function seeded(seed) {
  let a = seed;
  return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const N = 20_000;
const random = seeded(7);
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo));
const CASES = {
  'int': ['int', () => Array.from({ length: N }, () => int(-50_000, 50_000))],
  'int sorted': ['int', () => Array.from({ length: N }, (_, i) => i)],
  'int repeated': ['int', () => Array.from({ length: N }, (_, i) => (i % 9 === 0 ? null : i % 7))],
  'int big': ['int', () => Array.from({ length: N }, () => BigInt(int(0, 1000)) * 10n ** 15n + BigInt(int(0, 9)))],
  'float': ['float', () => Array.from({ length: N }, (_, i) => (i % 50 === 0 ? NaN : i % 51 === 0 ? -0 : i % 52 === 0 ? 0 : Math.round(random() * 100_000 - 50_000) / 100))],
  'string': ['string', () => Array.from({ length: N }, () => Array.from({ length: int(0, 6) }, () => ['a', 'B', 'z', 'é', '中', '😀'][int(0, 6)]).join(''))],
  'string sorted': ['string', () => Array.from({ length: N }, (_, i) => `ACC-${String(i).padStart(6, '0')}`)],
  'datetime': ['datetime', () => Array.from({ length: N }, () => new Date(Date.UTC(2025, 0, 1) + int(0, 500_000) * 60_000))],
  'bool': ['bool', () => Array.from({ length: N }, (_, i) => (i % 5 === 0 ? null : random() < 0.5))],
  'decimal': ['decimal', () => Array.from({ length: N }, () => (int(0, 2000) / 100).toFixed(random() < 0.5 ? 2 : 3))],
  // Almost in order (sorted runs, merged when the pages are written): rows appended after the rest, partitions
  // regrouped, the same keys in several runs, and the run count around the limit where the builder uses a table.
  'string, appended rows': ['string', () => [...Array.from({ length: N }, (_, i) => `r${String(i).padStart(6, '0')}`), 'r000005', 'r000010', 'a', 'zz']],
  'string, regrouped': ['string', () => Array.from({ length: 30 }, (_, b) => Array.from({ length: 500 }, (_, i) => `r${String(((b * 7) % 30) * 500 + i).padStart(6, '0')}`)).flat()],
  'int, keys repeated across runs': ['int', () => Array.from({ length: 20 }, () => Array.from({ length: 300 }, (_, i) => Math.floor(i / 3))).flat()],
  ...Object.fromEntries([31, 32, 33, 40].map((runs) => [`int, ${runs} runs`, ['int', () => Array.from({ length: runs }, (_, r) => Array.from({ length: 100 }, (_, i) => (i * runs + r) % 2500)).flat()]])),
  'decimal forms, almost in order': ['decimal', () => Array.from({ length: N }, (_, i) => (Math.floor(i / 2) / 100).toFixed(i % 3 === 0 ? 2 : 3)).concat(['1.5', '1.50', '1.500', '0.10', '0.1'])],
  'decimal forms in runs': ['decimal', () => Array.from({ length: 5 }, (_, r) => Array.from({ length: 400 }, (_, i) => (i / 100).toFixed(2 + ((i + r) % 3)))).flat()],
};

for (const [name, [type, make]] of Object.entries(CASES)) {
  test(`index builder: pages equal the reference builder's (${name})`, () => {
    const values = make().map((v) => (v === null ? null : normalizeValue(type, v, 'x')));
    const builder = new SortedIndexBuilder(type);
    const reference = new ReferenceBuilder(type);
    const nulls = [];
    values.forEach((v, row) => {
      builder.add(row, v);
      reference.add(row, v);
      if (v === null) nulls.push(row);
    });
    for (const pageBytes of [64, 4096, 1 << 20]) {
      const expected = reference.pages(pageBytes);
      const actual = [...builder.pages(pageBytes)];
      assert.equal(actual.length, expected.length, `${pageBytes}`);
      actual.forEach((page, i) => {
        assert.deepEqual(Buffer.from(page.first), Buffer.from(expected[i].first), `page ${i} first`);
        assert.equal(page.count, expected[i].count, `page ${i} count`);
        assert.ok(Buffer.from(page.raw).equals(Buffer.from(expected[i].raw)), `page ${i} bytes (${pageBytes})`);
      });
    }
    assert.deepEqual(builder.nulls, nulls);
  });
}
