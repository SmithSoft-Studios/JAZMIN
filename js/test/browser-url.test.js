// The browser reader opening files by URL with HTTP range requests (issue #12), against a local server that counts
// requests. Node 22+ has fetch, as browsers do.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminKey, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
const files = new Map(); // URL path -> bytes
let requests = [];
let rangeSupport = true;
let exposeRange = true;
let server;
let base;

before(async () => {
  for (const name of ['js-paged-key.jzm', 'js-access.jzm', 'js-plain.jzm']) files.set(`/${name}`, fs.readFileSync(path.join(dir, name)));
  server = http.createServer((req, res) => {
    const bytes = files.get(req.url);
    requests.push(req.headers.range ?? 'whole file');
    if (!bytes) return res.writeHead(404).end();
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!rangeSupport || !range) return res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
    let start = range[1] === '' ? Math.max(0, bytes.length - Number(range[2])) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
    if (start > end) [start, end] = [end, end];
    const headers = { 'content-length': end - start + 1 };
    if (exposeRange) headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
    res.writeHead(206, headers).end(bytes.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A row as comparable text: bytes as base64, dates as ISO text, BigInts as text (as browser-reader.test.js). */
const textOf = (row) => JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
  v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? `${v}n` : v])));
const rowsOf = async (iterator) => {
  const rows = [];
  for await (const row of iterator) rows.push(textOf(row));
  return rows;
};
const libraryRows = (reader, filter, options) => [...reader.find(filter, options)].map(textOf);

test('open and the first page of a larger encrypted file take at most 4 requests', async () => {
  const key = JazminKey.generate();
  const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, account: `A${i % 50}`, note: `Transaction ${i} for account ${i % 50}` }));
  files.set('/big.jzm', write(null, rows, { key, columns: [{ name: 'id', type: 'int', index: 'sorted' }, { name: 'account', type: 'string' }, { name: 'note', type: 'string' }] }));
  requests = [];
  const reader = await JazminBrowser.openUrl(`${base}/big.jzm`, { key: key.toString() });
  const page = await rowsOf(reader.find(null, { limit: 50 }));
  assert.equal(page.length, 50);
  assert.ok(requests.length <= 4, `${requests.length} requests: ${requests.join(', ')}`);
  // A lookup through the id index reads a few more blocks, not the file.
  requests = [];
  assert.deepEqual(await rowsOf(reader.find({ id: 12_345 })), [textOf({ id: 12345, account: 'A45', note: 'Transaction 12345 for account 45' })]);
  assert.ok(requests.length <= 3, `${requests.length} requests: ${requests.join(', ')}`);
});

test('an encrypted fixture and an access-controlled one read by URL return what the library returns', async () => {
  const plain = open(path.join(dir, 'js-paged-key.jzm'), { key: keys.key });
  const byUrl = await JazminBrowser.openUrl(`${base}/js-paged-key.jzm`, { key: keys.key });
  for (const filter of [null, { country: 'ZA' }, { id: { gte: 100, lt: 120 } }, { name: { contains: 'son' } }]) {
    assert.deepEqual(await rowsOf(byUrl.find(filter)), libraryRows(plain, filter), JSON.stringify(filter));
  }
  plain.close();
  const asBob = open(path.join(dir, 'js-access.jzm'), { key: keys.bob, accessState: false });
  const bob = await JazminBrowser.openUrl(`${base}/js-access.jzm`, { key: keys.bob });
  assert.deepEqual(await rowsOf(bob.find(null)), libraryRows(asBob, null));
  asBob.close();
});

test('a server without range support, a large read, and a source object all work', async () => {
  const expected = libraryRows(open(path.join(dir, 'js-plain.jzm')), null);
  rangeSupport = false;
  try {
    requests = [];
    assert.deepEqual(await rowsOf((await JazminBrowser.openUrl(`${base}/js-plain.jzm`)).find(null)), expected);
    assert.equal(requests.length, 1); // the whole file, once
  } finally {
    rangeSupport = true;
  }
  // Blocks of 1 KiB: a chunk spans more blocks than the cache keeps, so it is fetched as one range.
  assert.deepEqual(await rowsOf((await JazminBrowser.openUrl(`${base}/js-plain.jzm`, { blockSize: 1024 })).find(null)), expected);
  const bytes = files.get('/js-plain.jzm');
  const source = { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) };
  assert.deepEqual(await rowsOf((await JazminBrowser.open(source)).find(null)), expected);
});

test('missing files and unreadable Content-Range headers fail with a JazminError', async () => {
  await assert.rejects(JazminBrowser.openUrl(`${base}/nope.jzm`), (e) => e instanceof JazminBrowser.JazminError && /HTTP 404/.test(e.message));
  exposeRange = false;
  try {
    await assert.rejects(JazminBrowser.openUrl(`${base}/js-plain.jzm`), /Content-Range/);
  } finally {
    exposeRange = true;
  }
  await assert.rejects(JazminBrowser.open({ size: 10, read: () => new Uint8Array(3) }), /wrong number of bytes|too small/);
});
