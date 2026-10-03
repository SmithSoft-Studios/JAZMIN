// The browser reader (js/browser/jazmin-browser.js, used by the viewer) returns exactly what this library returns, for
// the shared fixtures written by both libraries: every key, embedded files, several tables, appended files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, JazminKey, issueUnlockToken, open } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
const fixture = (name) => fs.readFileSync(path.join(dir, name));

/** Comparable form of a row value. */
const plain = (v) => (v instanceof Date ? v.toISOString() : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? `${v}n` : v);
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
  if (name.endsWith('-key.jzm')) return { key: keys.key };
  if (name.endsWith('-password.jzm')) return { password: keys.password };
  return {};
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jzm') && !f.includes('brotli'));
for (const name of files) {
  const keyNames = !name.endsWith('-access.jzm') ? [null] : name.includes('many-partitions') ? ['key', 'bob', 'sally'] : ['key', 'bob', 'sally', 'carol', 'erin'];
  for (const keyName of keyNames) {
    test(`browser reader: ${name}${keyName ? ` with the ${keyName === 'key' ? 'owner' : keyName} key` : ''} matches the library`, async () => {
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
        assert.deepEqual(list.map((f) => [f.path, f.size, f.sha256]), expected.files.map((f) => [f.path, f.size, f.sha256]).sort());
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

test('browser reader: keys are checked, and an online key asks for its unlock token', async () => {
  const { JazminKeyError, JazminUnlockRequiredError } = JazminBrowser;
  await assert.rejects(JazminBrowser.open(fixture('js-key.jzm')), JazminKeyError);
  await assert.rejects(JazminBrowser.open(fixture('js-key.jzm'), { key: `${keys.key.slice(0, -2)}xx` }), /checksum|wrong length/);
  await assert.rejects(JazminBrowser.open(fixture('js-plain.jzm'), { key: keys.key }), /not encrypted/);
  await assert.rejects(JazminBrowser.open(fixture('js-access.jzm'), { key: JazminKey.generate().toString() }), /not signed by the owner of this key/);
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
