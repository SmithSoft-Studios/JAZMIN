// The browser reader with a key spanning many partitions (issue #258): a browser answers each read of a File or Blob on
// another process (about half a millisecond in Chrome, however small the read), so the reader reads the partitions'
// directories, statistics and the chunks a count needs in a few larger reads instead of one or more per partition, and
// gives the same results as the library's reader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JazminKey, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;

const PARTS = 40;
const customer = (i) => `C${String(i).padStart(3, '0')}`;
const owner = JazminKey.generate();
const all = owner.createAccessKey();
const one = owner.createAccessKey();
// 40 partitions of 50 rows, written grouped by customer: one chunk each.
const rows = Array.from({ length: 2000 }, (_, i) => ({ customer: customer(Math.floor(i / 50)), id: i, amount: String((i * 37) % 1000), kind: i % 7 === 0 ? 'cash' : 'eft' }));
const bytes = write(null, rows, {
  columns: [{ name: 'customer', type: 'string' }, { name: 'id', type: 'int' }, { name: 'amount', type: 'decimal' }, { name: 'kind', type: 'string' }],
  key: owner,
  access: { partitionBy: 'customer', grants: [{ key: all, rows: Array.from({ length: PARTS }, (_, i) => customer(i)) }, { key: one, rows: [customer(3)] }] },
});
const FILTER = { kind: 'cash', amount: { gt: 900 } };

/** A source that answers each read after a few milliseconds, as a disk or a browser's Blob does, and counts how many are waiting at once. */
function slowSource() {
  const source = {
    size: bytes.length, inFlight: 0, most: 0, reads: 0,
    async read(offset, length) {
      source.reads++;
      source.most = Math.max(source.most, ++source.inFlight);
      await new Promise((r) => setTimeout(r, 2));
      source.inFlight--;
      return bytes.subarray(offset, offset + length);
    },
  };
  return source;
}

test('opening with a key for many partitions reads their directories in a few reads', async () => {
  const source = slowSource();
  const table = await JazminBrowser.open(source, { key: all.export() });
  assert.equal(table.rowCount, 2000);
  assert.ok(source.reads < 10, `${source.reads} reads for ${PARTS} partitions`);
});

test('a count over many partitions reads their statistics and chunks in a few reads', async () => {
  const table = await JazminBrowser.open(bytes, { key: all.export() });
  const source = slowSource();
  const counted = await JazminBrowser.open(source, { key: all.export() });
  source.reads = 0;
  assert.equal(await counted.count(FILTER), await table.count(FILTER));
  assert.ok(source.reads < 10, `${source.reads} reads for ${PARTS} partitions' statistics and chunks`);
});

test('the same rows, in the same order, as the library reader, with either key', async () => {
  for (const key of [all, one]) {
    const reader = open(bytes, { key: key.export() });
    const expected = [...reader.find(FILTER)];
    const every = [...reader.find({})];
    const count = reader.count(FILTER);
    reader.close();
    const table = await JazminBrowser.open(slowSource(), { key: key.export() });
    assert.equal(await table.count(FILTER), count);
    assert.deepEqual((await table.query(FILTER, { limit: 10_000 })).rows, expected);
    assert.deepEqual((await table.query({}, { limit: 10_000 })).rows, every);
    assert.deepEqual((await table.query({}, { offset: 1234, limit: 7 })).rows, every.slice(1234, 1241));
  }
});

test('a damaged partition directory is still refused with a JAZMIN error', async () => {
  const table = await JazminBrowser.open(bytes, { key: all.export() });
  assert.ok(table.rowCount > 0);
  const source = slowSource();
  const read = source.read;
  let n = 0;
  // Every read after the first few comes back with one byte changed: some partition's section fails its checks.
  source.read = async (offset, length) => {
    const got = await read(offset, length);
    if (++n < 8 || length < 20) return got;
    const copy = new Uint8Array(got); // a copy (Buffer.slice would change the file itself)
    copy[copy.length - 1] ^= 0xff;
    return copy;
  };
  await assert.rejects(async () => {
    const t = await JazminBrowser.open(source, { key: all.export() });
    await t.count(FILTER);
  }, (error) => error instanceof JazminBrowser.JazminError);
});

test('a count stopped while sections are being read stops, and leaves nothing running', async () => {
  const table = await JazminBrowser.open(slowSource(), { key: all.export() });
  const stop = new AbortController();
  const counting = table.count(FILTER, { onProgress: (p) => p.done === 3 && stop.abort(), signal: stop.signal });
  await assert.rejects(counting, { name: 'AbortError' });
});
