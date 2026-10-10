// The browser reader's progress and Stop for long queries (the viewer shows them while it searches and counts):
// count(), query() and find() report { done, total, matches } chunk by chunk, and stop when their AbortSignal is aborted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { write } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;

// 20 chunks of 1,000 rows. Every 7th row has amount 7; the last 5 rows' notes say "the end". Chunk statistics can't rule
// out a chunk for either filter, so every chunk is read.
const bytes = write(null, Array.from({ length: 20000 }, (_, i) => ({
  id: i, amount: i % 7 === 0 ? 7 : (i % 100) + 10, note: i >= 19995 ? `the end ${i}` : `row ${i}`,
})), { chunkRows: 1000 });
const SEVENS = Math.ceil(20000 / 7);

test('count reports each chunk it reads, with the matches so far', async () => {
  const table = await JazminBrowser.open(bytes);
  const seen = [];
  assert.equal(await table.count({ amount: 7 }, { onProgress: (p) => seen.push({ ...p }) }), SEVENS);
  assert.deepEqual(seen.map((p) => p.done), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(seen.every((p) => p.total === 20));
  assert.ok(seen.every((p, i) => i === 0 || p.matches >= seen[i - 1].matches));
  assert.equal(seen.at(-1).matches, SEVENS);
  assert.equal(await table.count(null, { onProgress: () => assert.fail('no chunk is read to count every row') }), 20000);
});

test('query reports its search for a page, and counting the total after it', async () => {
  const table = await JazminBrowser.open(bytes);
  const seen = [];
  const { rows } = await table.query({ note: { contains: 'the end' } }, { limit: 50, total: false, onProgress: (p) => seen.push({ ...p }) });
  assert.deepEqual(rows.map((r) => r.id), [19995, 19996, 19997, 19998, 19999]);
  assert.deepEqual([seen.length, seen.at(-1)], [20, { done: 20, total: 20, matches: 5 }]);
  // A page found early stops reading: the rest of the file is read only to count.
  const early = [];
  const page = await table.query({ amount: 7 }, { limit: 10, onProgress: (p) => early.push({ ...p }) });
  assert.deepEqual([page.rows.length, page.total], [10, SEVENS]);
  assert.ok(early.length >= 20 && early.at(-1).done === 20);
  // find() takes them too.
  const found = [];
  for await (const row of table.find({ note: { contains: 'the end' } }, { onProgress: (p) => found.push(p.done) })) found.push(row.id);
  assert.equal(found.filter((x) => x >= 19995).length, 5);
});

test('an aborted signal stops count, query and find, before or part-way through', async () => {
  const table = await JazminBrowser.open(bytes);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(table.count({ amount: 7 }, { signal: stopped.signal }), { name: 'AbortError' });
  await assert.rejects(table.query({ amount: 7 }, { signal: stopped.signal }), { name: 'AbortError' });
  await assert.rejects(async () => { for await (const _ of table.find(null, { signal: stopped.signal })); }, { name: 'AbortError' }); // eslint-disable-line no-unused-vars
  // Part-way: no chunk is read after the signal is aborted.
  const stop = new AbortController();
  let calls = 0;
  await assert.rejects(table.count({ amount: 7 }, {
    signal: stop.signal,
    onProgress: (p) => {
      calls++;
      if (p.done === 3) stop.abort();
    },
  }), { name: 'AbortError' });
  assert.equal(calls, 3);
  const stopQuery = new AbortController();
  await assert.rejects(table.query({ note: { contains: 'the end' } }, {
    total: false, signal: stopQuery.signal, onProgress: (p) => p.done === 2 && stopQuery.abort(),
  }), { name: 'AbortError' });
});
