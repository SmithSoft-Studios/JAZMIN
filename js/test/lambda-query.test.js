// Queries with arrow functions (docs/design/js-queries.md): the filters read from functions never leave out a row the
// function keeps, are exactly the function where they say so, and queries give what plain JavaScript gives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JazminValidationError, from, open, write } from '../src/index.js';
import { columnsRead, translate } from '../src/lambda.js';
import { CASES, city, columns, rows } from './lambda-cases.js';

const reader = open(write(null, rows, { columns, sortedBy: ['id'], chunkRows: 40 }));
const all = [...reader.rows()];
const ids = (list) => list.map((r) => r.id);

test('a filter read from a function lets through every row it keeps, and exactly those when it says so', () => {
  for (const [f, values] of CASES) {
    const kept = ids(all.filter((r) => { try { return Boolean(f(r, values)); } catch { return false; } }));
    const t = translate(f, values, reader.columns);
    if (!t.filter) continue;
    const through = new Set(ids([...reader.find(t.filter)]));
    for (const id of kept) assert.ok(through.has(id), `${f}: row ${id} kept by the function but not let through by ${JSON.stringify(t.filter)}`);
    if (t.exact) assert.deepEqual([...through].sort((a, b) => a - b), kept, `${f}: said exact, but ${JSON.stringify(t.filter)} differs`);
  }
});

test('where gives what the function gives over every row, in file order, whether translated or not', () => {
  for (const [f, values] of CASES) {
    const expected = ids(all.filter((r) => { try { return Boolean(f(r, values)); } catch { return false; } }));
    let actual;
    try {
      actual = ids(from(reader).where(f, values).toArray());
    } catch (error) {
      // A function that throws on some row throws here too, unless the filter left that row out first.
      assert.ok(all.some((r) => { try { f(r, values); return false; } catch { return true; } }), `${f}: ${error.message}`);
      continue;
    }
    assert.deepEqual(actual, expected, String(f));
    assert.equal(from(reader).where(f, values).count(), expected.length, `count: ${f}`);
  }
});

test('what is read: the filter, the columns the functions name, the file order, offset and limit', () => {
  const q = from(reader).where((t) => t.city === 'Durban').select((t) => ({ id: t.id, n: t.n }));
  assert.deepEqual(q.explain(), { filter: { city: { eq: 'Durban' } }, exact: true, columns: ['id', 'city', 'n'].filter((c) => c !== 'city'), offset: 0, limit: null, fileOrder: false, inMemory: ['select'], notes: [] });
  // The file is sorted by id: no sort; skip and take go to the reader.
  const page = from(reader).where((t) => t.n > 0).orderBy((t) => t.id).skip(10).take(5).select((t) => t.id);
  assert.deepEqual(page.explain(), { filter: { n: { gt: 0 } }, exact: true, columns: ['id'], offset: 10, limit: 5, fileOrder: true, inMemory: ['select'], notes: [] });
  assert.deepEqual(page.toArray(), ids(all.filter((r) => r.n > 0)).slice(10, 15));
  // A function not read exactly runs on each row first; skip and take then run here.
  const loose = from(reader).where((t) => t.amount >= 100).skip(2).take(3);
  const plan = loose.explain();
  assert.deepEqual([plan.exact, plan.offset, plan.limit, plan.inMemory], [false, 0, null, ['where', 'skip', 'take']]);
  assert.deepEqual(ids(loose.toArray()), ids(all.filter((r) => r.amount >= 100)).slice(2, 5));
  // Outside values: used when passed, named in the notes when not.
  assert.deepEqual(from(reader).where((t) => t.city === city).explain().notes, ['city: a value from outside the function; pass it as the second argument to use it here']);
  assert.deepEqual(from(reader).where((t, $) => t.city === $.city, { city }).explain().filter, { city: { eq: 'Durban' } });
  // A function that passes the row on reads every column.
  assert.equal(from(reader).where((t) => JSON.stringify(t).length > 0).select((t) => t.id).explain().columns.length, columns.length);
  assert.deepEqual([...columnsRead((t) => t.a + t['b'])], ['a', 'b']); // eslint-disable-line dot-notation
  assert.equal(columnsRead((t) => `${t.a}`), '*'); // code inside a template is not looked into: every column
  assert.equal(columnsRead(Math.max), '*');
});

test('ordering, paging, joins, groups and the aggregates give what plain JavaScript gives', () => {
  const byAmount = from(reader).where((t) => t.amount !== null).orderByDescending((t) => t.amount).thenBy((t) => t.id).select((t) => [t.amount, t.id]).toArray();
  // Decimal text sorts by its exact value: 100.000000000000000001 > 100 > 99.999999999999999999, which numbers can't tell apart.
  const exact = (text) => BigInt(text.replace(/^(-?)(\d+)(?:\.(\d+))?$/, (_, sign, whole, part = '') => `${sign}${whole}${part.padEnd(20, '0')}`));
  const expected = all.filter((r) => r.amount !== null).sort((a, b) => (exact(b.amount) > exact(a.amount) ? 1 : exact(b.amount) < exact(a.amount) ? -1 : a.id - b.id)).map((r) => [r.amount, r.id]);
  assert.deepEqual(byAmount, expected);
  const cityRows = [{ name: 'Durban', province: 'KZN' }, { name: 'Cape Town', province: 'WC' }, { name: 'Pretoria', province: 'GP' }];
  const joined = from(reader).where((t) => t.n === 2).join(cityRows, (t) => t.city, (c) => c.name, (t, c) => `${t.id}:${c.province}`).toArray();
  assert.deepEqual(joined, all.filter((r) => r.n === 2).flatMap((r) => cityRows.filter((c) => c.name === r.city).map((c) => `${r.id}:${c.province}`)));
  const perCity = from(reader).groupBy((t) => t.city, (key, g) => ({ key, rows: g.count(), n: g.sum((t) => t.n), top: g.max((t) => t.amount) })).toArray();
  const groups = new Map();
  for (const r of all) groups.set(r.city, [...(groups.get(r.city) ?? []), r]);
  assert.deepEqual(perCity, [...groups].map(([key, list]) => ({
    key, rows: list.length, n: list.reduce((s, r) => s + (r.n ?? 0), 0), top: list.map((r) => r.amount).filter((a) => a !== null).sort((a, b) => Number(b) - Number(a))[0] ?? null,
  })));
  const groupJoined = from(cityRows).groupJoin(from(reader), (c) => c.name, (t) => t.city, (c, ts) => [c.name, ts.count()]).toArray();
  assert.deepEqual(groupJoined, cityRows.map((c) => [c.name, all.filter((r) => r.city === c.name).length]));
  const plainGroups = from(reader).where((t) => t.id < 12).groupBy((t) => t.active).toArray();
  assert.deepEqual(plainGroups.map((g) => [g.key, ids(g.toArray())]), [[null, [0, 4, 8]], [false, [1, 2, 5, 7, 10, 11]], [true, [3, 6, 9]]]);
  // Joins and groups by dates and big integers, as values.
  assert.equal(from([{ d: new Date(5) }, { d: new Date(5) }]).groupBy((x) => x.d).count(), 1);
  assert.equal(from([{ k: 5n }]).join([{ k: 5 }], (a) => a.k, (b) => b.k, () => 1).count(), 1);
  assert.equal(from(reader).sum((t) => t.n), all.reduce((s, r) => s + (r.n ?? 0), 0));
  assert.equal(from(reader).average((t) => t.n), all.filter((r) => r.n !== null).reduce((s, r) => s + r.n, 0) / all.filter((r) => r.n !== null).length);
  assert.equal(from(reader).min((t) => t.amount), '-25000.00');
  assert.equal(from(reader).max((t) => t.joined).getTime(), Math.max(...all.filter((r) => r.joined).map((r) => r.joined.getTime())));
  assert.deepEqual([from(reader).first((t) => t.n === 3).id, from(reader).firstOrDefault((t) => t.n === 99), from(reader).any((t) => t.n === 3), from(reader).any((t) => t.n === 99)],
    [all.find((r) => r.n === 3).id, null, true, false]);
  assert.deepEqual([from([]).sum(), from([]).average(), from([]).min()], [0, null, null]);
});

test('mistakes are named', () => {
  const refused = (f, message) => assert.throws(f, (e) => e instanceof JazminValidationError && message.test(e.message));
  refused(() => from(42), /^Query: from\(\) takes a reader, or something iterable/);
  refused(() => from(reader).where('city'), /^Query: where must be a function$/);
  refused(() => from(reader).take(-1), /^Query: take must be a non-negative integer$/);
  refused(() => from(reader).thenBy((t) => t.id), /^Query: thenBy follows orderBy or orderByDescending$/);
  refused(() => from(reader).first((t) => t.n === 99), /^Query: first\(\) found no rows$/);
});
