// What a filter means on a full scan (spec 9): and / or / not nested in each other, empty and / or, in, contains,
// nulls (SQL-style: a comparison with null is false, `not` of it true) and list any / all, object match. Each filter is
// checked against the same condition written in plain JavaScript: find, count and compileFilter in this library, and
// find and count in the browser reader. No column has an index, so every row is checked by the filter itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, write } from '../src/index.js';
import { compileFilter } from '../src/filter.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;

const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'name', type: 'string' },
  { name: 'tier', type: 'string' },
  { name: 'score', type: 'int' },
  { name: 'tags', type: 'list', item: { type: 'string' } },
  { name: 'staff', type: 'list', item: { type: 'object', fields: [{ name: 'name', type: 'string' }, { name: 'pay', type: 'int' }] } },
  { name: 'head', type: 'object', fields: [{ name: 'city', type: 'string' }, { name: 'zip', type: 'int' }] },
];

const rows = Array.from({ length: 240 }, (_, i) => ({
  id: i,
  name: i % 11 === 0 ? null : `N${i}${i % 3 === 0 ? ' Smith' : ''}`,
  tier: i % 13 === 0 ? null : ['a', 'b', 'c', 'd'][i % 4],
  score: i % 17 === 0 ? null : i % 50,
  tags: i % 9 === 0 ? null : i % 10 === 0 ? [] : [`t${i % 5}`, i % 6 === 0 ? null : `u${i % 3}`],
  staff: i % 8 === 0 ? null : i % 12 === 0 ? [] : [{ name: `E${i % 4}`, pay: i % 7 === 0 ? null : i % 30 }, ...(i % 5 === 0 ? [null] : [{ name: null, pay: i % 9 }])],
  head: i % 6 === 0 ? null : { city: i % 2 ? 'Durban' : null, zip: i % 100 },
}));

const isNull = (v) => v === null || v === undefined;
/** A condition on a value that may be null: false for null (comparisons with null are false). */
const on = (v, test_) => !isNull(v) && test_(v);

const CASES = [
  [{}, () => true],
  [{ and: [] }, () => true],
  [{ or: [] }, () => false],
  [{ not: { or: [] } }, () => true],
  [{ not: { and: [] } }, () => false],
  [{ and: [{ tier: 'a' }, { score: { gte: 10 } }, { name: { contains: 'Smith' } }] },
    (r) => r.tier === 'a' && on(r.score, (s) => s >= 10) && on(r.name, (n) => n.includes('Smith'))],
  [{ or: [{ tier: 'a' }, { score: null }, { name: { contains: 'Smith' } }, { id: { lt: 3 } }] },
    (r) => r.tier === 'a' || r.score === null || on(r.name, (n) => n.includes('Smith')) || r.id < 3],
  [{ not: { and: [{ tier: 'b' }, { or: [{ score: { lt: 20 } }, { name: null }] }] } },
    (r) => !(r.tier === 'b' && (on(r.score, (s) => s < 20) || r.name === null))],
  [{ or: [{ and: [{ tier: { in: ['a', 'c', null] } }, { not: { score: { in: [1, 2, 3, null] } } }] }, { not: { or: [{ tier: { ne: null } }, { id: { gt: 100 } }] } }] },
    (r) => (['a', 'c'].includes(r.tier) && !on(r.score, (s) => [1, 2, 3].includes(s))) || !(r.tier !== null || r.id > 100)],
  [{ tier: { in: [null] } }, () => false],
  [{ not: { tier: { in: [null] } } }, () => true],
  [{ tier: { ne: 'a' } }, (r) => on(r.tier, (t) => t !== 'a')],
  [{ not: { tier: 'a' } }, (r) => r.tier !== 'a'],
  [{ name: { contains: 'Smith' }, tier: { in: ['b', 'd'] }, score: { gt: 5, lte: 40 } },
    (r) => on(r.name, (n) => n.includes('Smith')) && ['b', 'd'].includes(r.tier) && on(r.score, (s) => s > 5 && s <= 40)],
  [{ name: { icontains: 'smith' }, not: { name: { startsWith: 'N1' } } },
    (r) => on(r.name, (n) => n.toLowerCase().includes('smith')) && !n1(r)],
  [{ name: { isNull: true }, or: [{ score: { isNull: false } }, { tier: null }] }, (r) => r.name === null && (r.score !== null || r.tier === null)],
  [{ tags: { any: 't1' } }, (r) => on(r.tags, (t) => t.includes('t1'))],
  [{ tags: { any: null } }, (r) => on(r.tags, (t) => t.some(isNull))],
  [{ tags: { all: { ne: null } } }, (r) => on(r.tags, (t) => t.every((x) => !isNull(x)))],
  [{ not: { tags: { any: { in: ['t0', 'u2'] } } } }, (r) => !on(r.tags, (t) => t.some((x) => x === 't0' || x === 'u2'))],
  [{ or: [{ tags: { any: { startsWith: 'u' } } }, { tags: { any: 't3' } }] },(r) => on(r.tags, (t) => t.some((x) => on(x, (v) => v.startsWith('u') || v === 't3')))],
  [{ staff: { any: { name: 'E1', pay: { gte: 10 } } } }, (r) => on(r.staff, (s) => s.some((e) => on(e, (x) => x.name === 'E1' && on(x.pay, (p) => p >= 10))))],
  [{ staff: { any: { or: [{ name: null }, { not: { pay: { lt: 20 } } }] } } },
    (r) => on(r.staff, (s) => s.some((e) => on(e, (x) => x.name === null || !on(x.pay, (p) => p < 20))))],
  [{ staff: { all: { pay: { isNull: false } } } }, (r) => on(r.staff, (s) => s.every((e) => on(e, (x) => x.pay !== null)))],
  [{ head: { match: { city: 'Durban', zip: { in: [1, 3, 5, 55] } } } }, (r) => on(r.head, (h) => h.city === 'Durban' && [1, 3, 5, 55].includes(h.zip))],
  [{ or: [{ head: { match: { not: { city: null } } } }, { and: [{ head: null }, { staff: { any: { name: { contains: '2' } } } }] }] },
    (r) => on(r.head, (h) => h.city !== null) || (r.head === null && on(r.staff, (s) => s.some((e) => on(e, (x) => on(x.name, (n) => n.includes('2'))))))],
];

function n1(r) {
  return on(r.name, (n) => n.startsWith('N1'));
}

const file = write(null, rows, { columns, chunkRows: 32 });
const ids = (list) => list.map((r) => r.id);

test('filters on a full scan select the rows their conditions describe (find, count, compileFilter)', () => {
  const reader = open(file);
  try {
    const predicate = (filter) => compileFilter(filter, reader.columns);
    for (const [filter, expected] of CASES) {
      const label = JSON.stringify(filter);
      const want = ids(rows.filter(expected));
      assert.deepEqual(ids([...reader.find(filter)]), want, label);
      assert.equal(reader.count(filter), want.length, label);
      assert.deepEqual(ids(rows.filter(predicate(filter))), want, label);
    }
  } finally {
    reader.close();
  }
});

test('browser reader: filters on a full scan select the same rows (find, count)', async () => {
  const reader = await JazminBrowser.open(new Blob([file]));
  for (const [filter, expected] of CASES) {
    const label = JSON.stringify(filter);
    const want = ids(rows.filter(expected));
    const found = [];
    for await (const row of reader.find(filter)) found.push(row);
    assert.deepEqual(found.map((r) => Number(r.id)), want, label);
    assert.equal(await reader.count(filter), want.length, label);
  }
});
