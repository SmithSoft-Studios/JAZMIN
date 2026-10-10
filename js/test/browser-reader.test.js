// The browser reader (js/browser/jazmin-browser.js, used by the viewer) returns exactly what this library returns, for
// the shared fixtures written by both libraries: every key, embedded files, several tables, appended files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, JazminKey, append, issueUnlockToken, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
const fixture = (name) => fs.readFileSync(path.join(dir, name));

/** Comparable form of a row value (inside lists and objects too: nested columns). */
const plain = (v) => (v instanceof Date ? v.toISOString() : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? `${v}n`
  : Array.isArray(v) ? v.map(plain)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const rowsOf = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));

async function browserRows(reader, filter) {
  const rows = [];
  for await (const row of reader.find(filter)) rows.push(row);
  return rowsOf(rows);
}

function nodeOptions(name, keyName) {
  if (keyName) {
    const options = { key: keys[keyName], accessState: false };
    if (keyName === 'carol') options.unlockToken = issueUnlockToken(path.join(dir, name), keys.key, JazminAccessKey.parse(keys.carol));
    return options;
  }
  if (name.endsWith('-key.jzm') || name.endsWith('-changes.jzm')) return { key: keys.key }; // change files: sealed with the file's key
  if (name.endsWith('-password.jzm')) return { password: keys.password };
  return {};
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jzm') && !f.includes('brotli'));
for (const name of files) {
  // A master key is refused for shared files in browsers (see below): those are read with access keys.
  const keyNames = !name.endsWith('-access.jzm') ? [null] : name.includes('many-partitions') ? ['bob', 'sally'] : ['bob', 'sally', 'carol', 'erin'];
  for (const keyName of keyNames) {
    test(`browser reader: ${name}${keyName ? ` with ${keyName}'s key` : ''} matches the library`, async () => {
      const options = nodeOptions(name, keyName);
      const expected = open(path.join(dir, name), options);
      // A Blob is read in slices, as a File from a file picker is.
      const reader = await JazminBrowser.open(new Blob([fixture(name)]), { key: options.key, password: options.password, unlockToken: options.unlockToken });
      try {
        assert.deepEqual(reader.tables, expected.tables);
        assert.deepEqual(reader.columns.map((c) => [c.name, c.type]), expected.columns.map((c) => [c.name, c.type]));
        assert.deepEqual(reader.metadata, expected.metadata);
        assert.equal(reader.rowCount, expected.rowCount);
        assert.equal(reader.hiddenRowCount, expected.hiddenRowCount);
        assert.deepEqual(await browserRows(reader), rowsOf([...expected.rows()]));
        assert.deepEqual(reader.package, expected.package);
        const list = await reader.files();
        assert.deepEqual(list.map((f) => [f.path, f.size, f.sha256, f.actions]), expected.files.map((f) => [f.path, f.size, f.sha256, f.actions]).sort());
        for (const f of list) assert.ok(Buffer.from(await reader.readFile(f.path)).equals(expected.readFile(f.path)), f.path);
        if (reader.tables.length > 1) {
          const other = await reader.openTable(reader.tables[1]);
          const expectedOther = expected.openTable(reader.tables[1]);
          assert.deepEqual(await browserRows(other), rowsOf([...expectedOther.rows()]));
          expectedOther.close();
        }
      } finally {
        expected.close();
      }
    });
  }
}

test('browser reader: filters give the same rows as the library', async () => {
  const reader = await JazminBrowser.open(fixture('js-plain.jzm'));
  const expected = open(path.join(dir, 'js-plain.jzm'));
  for (const filter of [
    { country: 'BW' }, { name: { icontains: 'johnson' } }, { score: { gt: 50 }, active: true }, { id: { gt: '9007199254740992' } },
    { balance: { gte: '100.5', lt: 200 } }, { joined: { gte: '2015-03-01T00:00:00.000Z', lt: '2015-03-05T00:00:00.000Z' } },
    { or: [{ country: null }, { name: { startsWith: 'Person 1' } }] }, { not: { country: { in: ['ZA', 'NA'] } } }, { country: { ne: 'ZA' } },
  ]) {
    assert.deepEqual(await browserRows(reader, filter), rowsOf([...expected.find(filter)]), JSON.stringify(filter));
  }
  assert.equal((await reader.query({ country: 'ZA' }, { offset: 2, limit: 3 })).rows.length, 3);
  assert.equal((await reader.query({ country: 'ZA' })).total, expected.count({ country: 'ZA' }));
  await assert.rejects(reader.query({ nope: 1 }), /unknown column 'nope'/);
  expected.close();
});

test('browser reader: a master key is refused for every shared file, and one-key files still open with theirs', async () => {
  for (const name of files.filter((f) => f.endsWith('-access.jzm'))) {
    await assert.rejects(JazminBrowser.open(new Blob([fixture(name)]), { key: keys.key }), /A master key can't be used in a browser for a shared file/, name);
  }
  const keyFile = await JazminBrowser.open(new Blob([fixture('js-key.jzm')]), { key: keys.key });
  assert.ok(keyFile.rowCount > 0);
});

test('browser reader: plans queries as the library does, reading the same chunks (issue #10)', async () => {
  // explain({ analyze }) in both readers, each freshly opened: index lookups, statistics, scans and offsets.
  for (const [name, filter, options] of [
    ['js-paged-key.jzm', { id: 7 }, {}],
    ['js-paged-key.jzm', { country: 'NA' }, { select: ['id'] }],
    ['js-paged-key.jzm', { score: { gt: 50 } }, { select: ['id'] }],
    ['js-paged-key.jzm', null, { offset: 100, limit: 10 }],
    ['js-paged-key.jzm', { name: { contains: 'son' } }, {}],
    ['js-paged-key.jzm', { joined: { gte: '2015-03-01T00:00:00.000Z', lt: '2015-03-05T00:00:00.000Z' } }, {}],
    ['js-paged-key.jzm', { id: { gte: 100 }, active: true }, { offset: 70, limit: 20 }],
    ['js-access.jzm', { score: { gt: 50 } }, { select: ['id'] }],
    ['js-access.jzm', null, { offset: 100, limit: 10 }],
  ]) {
    const access = name.endsWith('-access.jzm');
    const libraryOptions = nodeOptions(name, access ? 'bob' : null);
    const library = open(path.join(dir, name), libraryOptions);
    const { ms: libraryMs, ...expected } = library.explain(filter, { analyze: true, ...options });
    library.close();
    const reader = await JazminBrowser.open(new Blob([fixture(name)]), { key: libraryOptions.key });
    const { ms, ...actual } = await reader.explain(filter, { analyze: true, ...options });
    // An access-controlled file's partition directories are read when the browser reader opens it, and when the
    // library first needs them: compare bytes only for the other files.
    if (access) delete expected.bytesRead, delete actual.bytesRead;
    assert.deepEqual(actual, expected, `${name} ${JSON.stringify(filter)} ${JSON.stringify(options)}`);
    assert.ok(ms >= 0 && libraryMs >= 0);
  }
});

test('browser reader: plans text searches as the library does, before and after an append (two index segments)', async () => {
  // 'often' in every other row (spread: scanned), 'seldom' in every 5,000th, 'early' in the first 6,000 (together).
  const row = (i) => ({ id: i, text: `n${i}${i % 2 ? '' : ' often'}${i % 5000 ? '' : ' seldom'}${i < 6000 ? ' early' : ''}` });
  const columns = [{ name: 'id', type: 'int', nullable: false, index: 'sorted' }, { name: 'text', type: 'string', index: 'trigram' }];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-text-')), 'text.jzm');
  write(file, Array.from({ length: 12_000 }, (_, i) => row(i)), { columns, chunkRows: 500 });
  const filters = [
    { text: { contains: 'often' } },
    { text: { contains: 'seldom' } },
    { text: { contains: 'early' } },
    { or: [{ text: { contains: 'often' } }, { text: { contains: 'seldom' } }] },
    { text: { icontains: 'Often' }, id: { in: [2, 4000, 11_001] } },
  ];
  for (const appended of [false, true]) {
    if (appended) append(file, { insert: Array.from({ length: 8000 }, (_, i) => row(12_000 + i)) });
    const library = open(file);
    const reader = await JazminBrowser.open(new Blob([fs.readFileSync(file)]));
    try {
      for (const filter of filters) {
        const { ms: libraryMs, ...expected } = library.explain(filter, { analyze: true });
        const { ms, ...actual } = await reader.explain(filter, { analyze: true });
        assert.deepEqual(actual, expected, `${appended} ${JSON.stringify(filter)}`);
      }
      assert.deepEqual(filters.slice(0, 3).map((f) => library.explain(f).strategy), ['scan', 'index', 'index'], `${appended}`);
    } finally {
      library.close();
    }
  }
});

test('browser reader: query({ total: false }) reads only the page, and count() matches the library', async () => {
  const reader = await JazminBrowser.open(new Blob([fixture('js-paged-key.jzm')]), { key: keys.key });
  const library = open(path.join(dir, 'js-paged-key.jzm'), { key: keys.key });
  const page = await reader.query({ country: 'ZA' }, { offset: 2, limit: 3, total: false });
  assert.deepEqual([Object.keys(page), page.rows.length], [['rows'], 3]);
  for (const filter of [{ country: 'ZA' }, { id: { gte: 100 } }, { score: { gt: 0 } }, { not: { country: 'NA' } }, { country: null }]) {
    assert.equal(await reader.count(filter), library.count(filter), JSON.stringify(filter));
  }
  // eq / ne null mean isNull, as in the library; an unknown selected column is an error.
  assert.deepEqual(await browserRows(reader, { country: { eq: null } }), rowsOf([...library.find({ country: { eq: null } })]));
  assert.deepEqual(await browserRows(reader, { country: { ne: null } }), rowsOf([...library.find({ country: { ne: null } })]));
  await assert.rejects(async () => {
    for await (const _ of reader.find(null, { select: ['nope'] }));
  }, /Unknown column 'nope' in select/);
  library.close();
});

test('browser reader: NaN never equals or orders against a value, as in the library', async () => {
  const bytes = write(null, [{ id: 1, score: 5 }, { id: 2, score: NaN }, { id: 3, score: 7 }, { id: 4, score: null }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'score', type: 'float' }],
  });
  const reader = await JazminBrowser.open(new Blob([bytes]));
  const library = open(bytes);
  for (const filter of [{ score: 5 }, { score: { ne: 5 } }, { score: { gte: 6 } }, { score: { lte: 6 } }, { score: { in: [5, 7] } }, { score: { gt: 0, lt: 10 } }]) {
    assert.deepEqual(await browserRows(reader, filter), rowsOf([...library.find(filter)]), JSON.stringify(filter));
    assert.equal(await reader.count(filter), library.count(filter), JSON.stringify(filter));
  }
});

test('browser reader: count() takes exact index answers without reading rows, as the library does (issue #16)', async () => {
  const columns = [
    { name: 'id', type: 'int', nullable: false, index: 'sorted' },
    { name: 'section', type: 'string', nullable: false, index: 'sorted' },
    { name: 'score', type: 'float', index: 'sorted' },
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-browser-count-')), 'indexed.jzm');
  write(file, Array.from({ length: 1000 }, (_, i) => ({ id: i, section: `S${Math.floor(i / 100)}`, score: i % 7 === 0 ? NaN : i / 10 })), { columns, sortedBy: ['id'], chunkRows: 64 });
  append(file, { delete: { section: 'S5', id: { lt: 520 } } });
  const bytes = fs.readFileSync(file);
  let read = 0;
  class CountingBlob extends Blob {
    slice(start = 0, end = this.size, type) {
      read += Math.max(0, Math.min(end, this.size) - start);
      return super.slice(start, end, type);
    }
  }
  const reader = await JazminBrowser.open(new CountingBlob([bytes]));
  const library = open(file);
  for (const filter of [
    { section: 'S5' }, { section: { in: ['S3', 'S10', null] } }, { section: { gte: 'S3', lt: 'S6' } }, { section: { startsWith: 'S1' } },
    { section: { ne: 'S2' } }, { score: 0 }, { score: { gte: 10, lt: 20 } }, { score: { gt: NaN } }, { section: 'S5', score: { gt: 55 } },
  ]) assert.equal(await reader.count(filter), library.count(filter), JSON.stringify(filter));
  library.close();
  const filter = { section: { in: ['S2', 'S7'] } };
  const counter = await JazminBrowser.open(new CountingBlob([bytes]));
  read = 0;
  assert.equal(await counter.count(filter), 200);
  const counted = read;
  const finder = await JazminBrowser.open(new CountingBlob([bytes]));
  read = 0;
  assert.equal((await browserRows(finder, filter)).length, 200);
  assert.ok(counted < read / 2, `count read ${counted} bytes, find ${read}`);
});

test('browser reader: keys are checked, and an online key asks for its unlock token', async () => {
  const { JazminKeyError, JazminUnlockRequiredError } = JazminBrowser;
  await assert.rejects(JazminBrowser.open(fixture('js-key.jzm')), JazminKeyError);
  await assert.rejects(JazminBrowser.open(fixture('js-key.jzm'), { key: `${keys.key.slice(0, -2)}xx` }), /checksum|wrong length/);
  await assert.rejects(JazminBrowser.open(fixture('js-plain.jzm'), { key: keys.key }), /not encrypted/);
  await assert.rejects(JazminBrowser.open(fixture('js-access.jzm'), { key: JazminKey.generate().toString() }), /A master key can't be used in a browser/);
  await assert.rejects(JazminBrowser.open(fixture('js-access.jzm'), { key: JazminKey.generate().createAccessKey().toString() }), /not signed by the owner/);
  const error = await JazminBrowser.open(fixture('js-access.jzm'), { key: keys.carol }).catch((e) => e);
  assert.ok(error instanceof JazminUnlockRequiredError);
  assert.match(error.keyId, /^[0-9a-f]{16}$/);
  await assert.rejects(JazminBrowser.open(fixture('js-brotli.jzm')), /Brotli/);
});

test('browser reader: damaged files fail with a JazminError', async () => {
  const damaged = path.join(dir, 'damaged');
  for (const name of fs.readdirSync(damaged)) {
    try {
      const reader = await JazminBrowser.open(fs.readFileSync(path.join(damaged, name)));
      for await (const row of reader.find()) assert.ok(row);
      for (const f of await reader.files()) await reader.readFile(f.path);
    } catch (error) {
      assert.ok(error instanceof JazminBrowser.JazminError, `${name}: ${error.stack}`);
    }
  }
});

test('the browser reader reads integers and dates at the edges of a safe number exactly, as the library does', async () => {
  // Varints of up to 7 bytes (49 bits) are read as numbers, longer ones as BigInts; delta sums switch at ±2^53.
  const ints = [0, 1, -1, 2 ** 49 - 1, 2 ** 49, 2 ** 49 + 1, -(2 ** 49), 2 ** 53 - 1, -(2 ** 53 - 1), 2n ** 53n, -(2n ** 53n), 2n ** 60n,
    -(2n ** 63n), 2n ** 63n - 1n, 123456789, -987654321];
  const dates = [new Date(-8.64e15), new Date(8.64e15), new Date(0), new Date(Date.UTC(2026, 9, 7))];
  const rows = ints.map((n, i) => ({ id: i, n, at: dates[i % dates.length] }));
  const sorted = [...rows].sort((a, b) => (BigInt(a.n) < BigInt(b.n) ? -1 : BigInt(a.n) > BigInt(b.n) ? 1 : 0));
  const columns = [{ name: 'id', type: 'int' }, { name: 'n', type: 'int' }, { name: 'at', type: 'datetime' }];
  for (const [name, data, options] of [['plain', rows, {}], ['sorted by n (delta)', sorted, { sortedBy: ['n'] }]]) {
    const bytes = write(null, data, { columns, ...options });
    const expected = [...open(bytes).rows()];
    const reader = await JazminBrowser.open(new Blob([bytes]));
    assert.deepEqual(await browserRows(reader), rowsOf(expected), name);
    const arrays = await reader.columnArrays(null, { select: ['at'] });
    assert.deepEqual([...arrays.values.at], expected.map((r) => r.at.getTime()), name);
  }
});

test('browser reader: filters on nested columns select the rows nested-filters.json lists, from either writer', async (t) => {
  const filters = JSON.parse(fs.readFileSync(path.join(dir, 'nested-filters.json'), 'utf8'));
  for (const name of ['js-nested.jzm', 'dotnet-nested.jzm']) {
    if (!fs.existsSync(path.join(dir, name))) {
      t.diagnostic(`${name} not written yet`);
      continue;
    }
    const reader = await JazminBrowser.open(new Blob([fixture(name)]));
    for (const { filter, ids } of filters) {
      const found = [];
      for await (const row of reader.find(filter)) found.push(row.id);
      assert.deepEqual(found, ids, `${name}: ${JSON.stringify(filter)}`);
      const selected = []; // the filter's nested columns decoded with only the fields it reads
      for await (const row of reader.find(filter, { select: ['id'] })) selected.push(row.id);
      assert.deepEqual(selected, ids);
      assert.equal(await reader.count(filter), ids.length);
    }
  }
});

test('browser reader: filters on nested columns skip, read and decode as the library does', async () => {
  // Values that grow with the id, so each chunk of 32 rows holds its own range of them (10 chunks).
  const columns = [
    { name: 'id', type: 'int', nullable: false },
    {
      name: 'staff', type: 'list', item: {
        type: 'object', fields: [
          { name: 'name', type: 'string' }, { name: 'badge', type: 'int' }, { name: 'bio', type: 'string' },
          { name: 'tags', type: 'list', item: { type: 'string' } },
        ],
      },
    },
    { name: 'head', type: 'object', fields: [{ name: 'city', type: 'string' }, { name: 'zip', type: 'string' }] },
  ];
  const rows = Array.from({ length: 320 }, (_, i) => ({
    id: i,
    staff: i % 9 === 0 ? null : [{ name: `S${i}`, badge: i, bio: `bio ${i}`, tags: ['a', `t${i % 3}`] }, { name: `T${i}`, badge: i + 1, bio: null, tags: [] }],
    head: i % 7 === 0 ? null : { city: `C${Math.floor(i / 32)}`, zip: `${1000 + i}` },
  }));
  const bytes = write(null, rows, { columns, chunkRows: 32 });
  for (const [filter, options] of [
    [{ staff: { any: { badge: 100 } } }, { select: ['id'] }],
    [{ staff: { any: { badge: { gt: 300 }, name: { lt: 'T' } } } }, {}],
    [{ staff: { all: { tags: { any: 'a' } } } }, { select: ['id', 'head'] }],
    [{ head: { match: { city: 'C5' } } }, { select: ['id'] }],
    [{ or: [{ staff: { any: { badge: 5 } } }, { head: { match: { zip: '1300' } } }] }, { select: ['id'] }],
    [{ not: { staff: { any: { bio: null } } } }, { select: ['id'] }],
  ]) {
    const library = open(bytes);
    const { ms: libraryMs, ...expected } = library.explain(filter, { analyze: true, ...options });
    const reader = await JazminBrowser.open(new Blob([bytes]));
    const { ms, ...actual } = await reader.explain(filter, { analyze: true, ...options });
    assert.deepEqual(actual, expected, JSON.stringify(filter));
    assert.ok(ms >= 0 && libraryMs >= 0);
    const found = [];
    for await (const row of reader.find(filter, options)) found.push(row);
    assert.deepEqual(rowsOf(found), rowsOf([...library.find(filter, options)]), JSON.stringify(filter));
    assert.equal(await reader.count(filter), library.count(filter));
    library.close();
  }
});

test('browser reader: filtered reads return what the library returns, when few rows of a chunk match or many do', async () => {
  // Every column type, chunks of 128 rows; filters matching a row or two per chunk (by index candidates and by scan),
  // and many.
  const columns = [
    { name: 'id', type: 'int', nullable: false },
    { name: 'name', type: 'string', index: 'sorted' },
    { name: 'note', type: 'string' },
    { name: 'amount', type: 'decimal' },
    { name: 'doc', type: 'json' },
    { name: 'blob', type: 'binary' },
    { name: 'score', type: 'float' },
    { name: 'flag', type: 'bool' },
    { name: 'at', type: 'datetime' },
    { name: 'tags', type: 'list', item: { type: 'string' } },
    { name: 'code', type: 'string', index: 'sorted' }, // 1 row in 97
  ];
  const rows = Array.from({ length: 600 }, (_, i) => ({
    id: i,
    name: i % 7 === 0 ? null : `name ${i % 13}`,
    note: i % 5 === 0 ? null : `note ${i} ${'x'.repeat(i % 9)}`,
    amount: i % 6 === 0 ? null : `${i}.${String(i % 100).padStart(2, '0')}`,
    doc: i % 4 === 0 ? null : { i },
    blob: i % 8 === 0 ? null : Buffer.from([i & 255, 7]),
    score: i % 9 === 0 ? null : i / 3,
    flag: i % 2 === 0,
    at: i % 10 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
    tags: i % 11 === 0 ? null : [`t${i % 4}`, `u${i}`],
    code: `c${i % 97}`,
  }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-few-')), 'rows.jzm');
  write(file, rows, { columns, chunkRows: 128 });
  append(file, { delete: { id: 102 } });
  const filters = [
    { id: { in: [3, 33, 50, 299] } }, { code: 'c5' }, { code: { in: ['c5', 'c9'] }, flag: true }, { name: 'name 4' },
    { amount: { gt: '100' } }, { note: { contains: 'xxxxxxx' } }, { not: { flag: true } },
  ];
  const library = open(file);
  const reader = await JazminBrowser.open(new Blob([fs.readFileSync(file)]));
  try {
    for (const filter of filters) {
      const label = JSON.stringify(filter);
      assert.deepEqual(await browserRows(reader, filter), rowsOf([...library.find(filter)]), label);
      for (const options of [{ select: ['note', 'tags', 'at'], limit: 1000 }, { offset: 1, limit: 3 }]) {
        const page = await reader.query(filter, { ...options, total: false });
        assert.deepEqual(rowsOf(page.rows), rowsOf([...library.find(filter, options)]), `${label} ${JSON.stringify(options)}`);
      }
      const select = ['id', 'note', 'amount', 'score', 'flag', 'at'];
      const arrays = await reader.columnArrays(filter, { select, offset: 1, limit: 8 });
      const want = library.columnArrays(filter, { select, offset: 1, limit: 8 });
      assert.deepEqual(plain(arrays), plain(want), `${label} column arrays`);
    }
  } finally {
    library.close();
  }
});

test("a sorted text index whose smallest key is the empty text answers lookups in the browser too", async () => {
  const texts = ['', 'a', null, 'b', '', 'ab', 'z'];
  const rows = Array.from({ length: 700 }, (_, i) => ({ seq: i, text: texts[i % texts.length] }));
  const bytes = write(null, rows, { columns: [{ name: 'seq', type: 'int' }, { name: 'text', type: 'string', index: 'sorted' }], sortedBy: ['seq'] });
  const reader = await globalThis.JazminBrowser.open(bytes);
  assert.equal((await reader.query({ text: 'a' }, { limit: 1000 })).total, rows.filter((x) => x.text === 'a').length);
  assert.equal(await reader.count({ text: '' }), rows.filter((x) => x.text === '').length);
});
