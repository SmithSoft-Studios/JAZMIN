import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, open, write } from '../src/index.js';

const countries = ['ZA', 'NA', 'BW', 'ZW'];
const rows = Array.from({ length: 2000 }, (_, i) => ({
  id: i,
  name: `Customer ${i} ${i % 7 === 0 ? 'Johnson' : 'Smith'}`,
  country: i % 50 === 0 ? null : countries[i % 4],
  age: 18 + (i % 60),
  joined: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000),
}));

const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'name', type: 'string', index: 'trigram' },
  { name: 'country', type: 'string', index: 'sorted' },
  { name: 'age', type: 'int' },
  { name: 'joined', type: 'datetime', index: 'sorted' },
];

const plain = write(null, rows, { columns, chunkRows: 100 });
const encrypted = (() => {
  const key = JazminKey.generate();
  return { key, buf: write(null, rows, { columns, chunkRows: 100, key }) };
})();

function expectSame(reader, filter, predicate, options) {
  const expected = rows.filter(predicate);
  const actual = [...reader.find(filter, options)];
  assert.equal(actual.length, expected.length, JSON.stringify(filter));
  assert.deepEqual(actual.map((r) => r.id), expected.map((r) => r.id));
}

for (const [label, open_] of [
  ['plain', () => open(plain)],
  ['encrypted', () => open(encrypted.buf, { key: encrypted.key })],
]) {
  test(`${label}: indexed equality, in, range and prefix match a full scan`, () => {
    const r = open_();
    expectSame(r, { country: 'ZA' }, (x) => x.country === 'ZA');
    expectSame(r, { country: { in: ['NA', 'BW'] } }, (x) => ['NA', 'BW'].includes(x.country));
    expectSame(r, { id: { gte: 100, lt: 120 } }, (x) => x.id >= 100 && x.id < 120);
    expectSame(r, { country: { startsWith: 'Z' } }, (x) => x.country?.startsWith('Z'));
    expectSame(r, { country: null }, (x) => x.country === null);
    expectSame(r, { joined: { gt: '2024-01-01T00:00:00Z' } }, (x) => x.joined > new Date('2024-01-01T00:00:00Z'));
  });

  test(`${label}: trigram index answers contains / icontains`, () => {
    const r = open_();
    expectSame(r, { name: { contains: 'Johnson' } }, (x) => x.name.includes('Johnson'));
    expectSame(r, { name: { icontains: 'JOHNSON' } }, (x) => x.name.toLowerCase().includes('johnson'));
    expectSame(r, { name: { contains: 'johnson' } }, () => false); // case-sensitive
    expectSame(r, { name: { contains: 'Zzz' } }, () => false);
    assert.equal(r.explain({ name: { contains: 'Johnson' } }).strategy, 'index');
  });

  test(`${label}: and / or / not combine indexed and unindexed conditions`, () => {
    const r = open_();
    expectSame(r, { country: 'ZA', age: { gt: 70 } }, (x) => x.country === 'ZA' && x.age > 70);
    expectSame(r, { or: [{ country: 'BW' }, { id: { lt: 5 } }] }, (x) => x.country === 'BW' || x.id < 5);
    expectSame(r, { or: [{ country: 'BW' }, { age: 18 }] }, (x) => x.country === 'BW' || x.age === 18);
    expectSame(r, { not: { country: 'ZA' } }, (x) => x.country !== 'ZA');
    expectSame(r, { age: { ne: 18 } }, (x) => x.age !== 18);
  });
}

test('index use avoids reading unrelated chunks', () => {
  const r = open(plain);
  assert.deepEqual(r.explain({ id: 1234 }), { strategy: 'index', candidateRows: 1 });
  assert.deepEqual([...r.find({ id: 1234 })].map((x) => x.id), [1234]);
});

test('chunk statistics skip chunks for unindexed range filters', () => {
  const sortedAge = write(null, rows.map((x) => ({ id: x.id, age: x.id })), { chunkRows: 100 });
  const plan = open(sortedAge).explain({ age: { gte: 1950 } });
  assert.equal(plan.strategy, 'scan');
  assert.equal(plan.chunksSkipped, 19);
});

test('select, limit and offset', () => {
  const r = open(plain);
  const page = [...r.find({ country: 'ZA' }, { select: ['id', 'country'], offset: 2, limit: 3 })];
  const expected = rows.filter((x) => x.country === 'ZA').slice(2, 5).map(({ id, country }) => ({ id, country }));
  assert.deepEqual(page, expected);
  assert.equal(r.count({ country: 'ZA' }), rows.filter((x) => x.country === 'ZA').length);
});

test('filters are validated', () => {
  const r = open(plain);
  assert.throws(() => [...r.find({ nope: 1 })], /unknown column/);
  assert.throws(() => [...r.find({ age: { like: 1 } })], /unknown operator/);
  assert.throws(() => [...r.find({ age: { contains: '1' } })], JazminValidationError);
});

test('GraphQL-style string operands are coerced to the column type', () => {
  const r = open(plain);
  assert.deepEqual([...r.find({ id: { eq: '42' } })].map((x) => x.id), [42]);
});

test('sorted files: binary-searched chunk ranges return exactly what a full scan does', () => {
  // Duplicate keys span chunk boundaries (7 rows per key, 5 rows per chunk).
  const sortedRows = Array.from({ length: 700 }, (_, i) => ({ k: Math.floor(i / 7), s: `v${String(Math.floor(i / 7)).padStart(3, '0')}`, i }));
  const file = write(null, sortedRows, { sortedBy: ['k'], chunkRows: 5 });
  const r = open(file);
  const cases = [
    [{ k: 50 }, (x) => x.k === 50],
    [{ k: { gte: 10, lt: 13 } }, (x) => x.k >= 10 && x.k < 13],
    [{ k: { gt: 98 } }, (x) => x.k > 98],
    [{ k: { lte: 0 } }, (x) => x.k <= 0],
    [{ k: { gt: 5, lt: 5 } }, () => false],
    [{ k: 1000 }, () => false],
    [{ k: { gte: 3 }, i: { lt: 30 } }, (x) => x.k >= 3 && x.i < 30],
    [{ or: [{ k: 1 }, { k: 99 }] }, (x) => x.k === 1 || x.k === 99],
  ];
  for (const [filter, predicate] of cases) {
    assert.deepEqual([...r.find(filter)].map((x) => x.i), sortedRows.filter(predicate).map((x) => x.i), JSON.stringify(filter));
  }
  assert.equal(r.explain({ k: 50 }).chunksSkipped, r.chunkCount - 2);
});
