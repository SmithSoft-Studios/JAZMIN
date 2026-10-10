// Queries with arrow functions in the browser reader (JazminBrowser.from): the same plans and answers as the library's
// (lambda-query.test.js), awaited; in-memory groups and matches answer at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { from, open, write } from '../src/index.js';
import { CASES, columns, rows } from './lambda-cases.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const bytes = write(null, rows, { columns, sortedBy: ['id'], chunkRows: 40 });
const library = open(bytes);
const ids = (list) => list.map((r) => r.id);

test('where: the same filter, plan and rows as the library, for every case', async () => {
  const reader = await JazminBrowser.open(bytes);
  for (const [f, values] of CASES) {
    const q = from(library).where(f, values);
    const b = JazminBrowser.from(reader).where(f, values);
    assert.deepEqual(b.explain(), q.explain(), String(f));
    let expected;
    try {
      expected = ids(q.toArray());
    } catch (error) {
      await assert.rejects(b.toArray(), { message: error.message }, String(f));
      continue;
    }
    assert.deepEqual(ids(await b.toArray()), expected, String(f));
    assert.equal(await b.count(), expected.length, `count: ${f}`);
  }
});

test('ordering, paging, joins, groups and aggregates as the library gives them', async () => {
  const reader = await JazminBrowser.open(bytes);
  const queries = [
    (s) => s.where((t) => t.amount !== null).orderByDescending((t) => t.amount).thenBy((t) => t.id).select((t) => [t.amount, t.id]),
    (s) => s.where((t) => t.n > 0).orderBy((t) => t.id).skip(10).take(5).select((t) => t.id),
    (s) => s.where((t) => t.amount >= 100).skip(2).take(3).select((t) => t.id),
    (s) => s.groupBy((t) => t.city, (key, g) => ({ key, rows: g.count(), n: g.sum((t) => t.n), top: g.max((t) => t.amount) })),
    (s) => s.where((t) => t.n === 2).join([{ name: 'Durban', province: 'KZN' }, { name: 'Pretoria', province: 'GP' }], (t) => t.city, (c) => c.name, (t, c) => `${t.id}:${c.province}`),
    (s, other) => s.where((t) => t.id < 40).join(other.where((t) => t.n > 0), (t) => t.n, (u) => u.n, (t, u) => [t.id, u.id]).take(25),
    (s, other) => s.where((t) => t.id < 10).groupJoin(other, (t) => t.city, (u) => u.city, (t, us) => [t.id, us.count()]),
  ];
  for (const make of queries) {
    const expected = make(from(library), from(library)).toArray();
    assert.deepEqual(await make(JazminBrowser.from(reader), JazminBrowser.from(reader)).toArray(), expected, String(make));
  }
  const b = JazminBrowser.from(reader);
  assert.deepEqual(
    [await b.sum((t) => t.n), await b.average((t) => t.n), await b.min((t) => t.amount), (await b.max((t) => t.joined)).getTime(), (await b.first((t) => t.n === 3)).id,
      await b.firstOrDefault((t) => t.n === 99), await b.any((t) => t.n === 3)],
    [from(library).sum((t) => t.n), from(library).average((t) => t.n), from(library).min((t) => t.amount), from(library).max((t) => t.joined).getTime(),
      from(library).first((t) => t.n === 3).id, null, true],
  );
  // Rows in memory answer at once, as in the library.
  assert.deepEqual(JazminBrowser.from([3, 1, 2]).orderBy((x) => x).toArray(), [1, 2, 3]);
  await assert.rejects(b.first((t) => t.n === 99), { message: 'Query: first() found no rows' });
});
