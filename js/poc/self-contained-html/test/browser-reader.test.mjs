// The browser reader must return exactly what the Node library returns for the shared fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { open } from '../../../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '../../../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(here, '../jazmin-browser.js'), 'utf8'));
const { JazminBrowser } = globalThis;

const canonical = (value) => {
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('hex')}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === 'bigint') return `big:${value}`;
  return value;
};
const canonicalRows = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, canonical(v)])));

const cases = [
  ['plain', {}, {}],
  ['key', { key: keys.key }, { key: keys.key }],
  ['password', { password: keys.password }, { password: keys.password }],
];

for (const lang of ['js', 'dotnet']) {
  for (const [kind, nodeOptions, browserOptions] of cases) {
    const file = path.join(fixtures, `${lang}-${kind}.jzm`);
    test(`browser reader: ${lang}-${kind}.jzm matches the Node library`, async (t) => {
      if (!fs.existsSync(file)) return t.skip('run the .NET tests to generate the dotnet-*.jzm fixtures');
      const node = open(file, nodeOptions);
      const expected = canonicalRows([...node.rows()]);
      const expectedColumns = node.columns.map((c) => c.name);
      node.close();

      const reader = await JazminBrowser.open(new Uint8Array(fs.readFileSync(file)), browserOptions);
      assert.deepEqual(reader.columns.map((c) => c.name), expectedColumns);
      assert.deepEqual(canonicalRows(await reader.rows()), expected);
      assert.equal(reader.rowCount, expected.length);
    });
  }
}

test('browser reader: wrong key, mistyped key and missing key are rejected', async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(fixtures, 'js-key.jzm')));
  const other = 'jzk1-' + Buffer.concat([Buffer.alloc(32, 7), (await import('node:crypto')).createHash('sha256').update(Buffer.alloc(32, 7)).digest().subarray(0, 4)]).toString('base64url');
  await assert.rejects(JazminBrowser.open(bytes, { key: other }), /Decryption failed/);
  await assert.rejects(JazminBrowser.open(bytes, { key: keys.key.slice(0, -2) + 'AA' }), /checksum|length/);
  await assert.rejects(JazminBrowser.open(bytes, {}), /encrypted/);
});

test('browser reader: unsupported features give a clear message', async () => {
  const read = (name, options) => JazminBrowser.open(new Uint8Array(fs.readFileSync(path.join(fixtures, name))), options);
  await assert.rejects(read('js-access.jzm', { key: keys.key }), /Access-controlled/);
  await assert.rejects(read('js-appended.jzm', {}), /Appended/);
  await assert.rejects(read('js-brotli.jzm', {}).then((r) => r.rows()), /Brotli/);
  await assert.rejects(read('js-key.jzm', { key: keys.bob }), /Access keys/);
  const draft = new Uint8Array(fs.readFileSync(path.join(fixtures, 'js-plain.jzm')));
  draft.set(Buffer.from('JZMN'), 0);
  await assert.rejects(JazminBrowser.open(draft, {}), /pre-release JAZMIN draft format/);
});

test('browser reader: a tampered byte is detected', async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(fixtures, 'js-key.jzm')));
  bytes[200] ^= 1;
  await assert.rejects(JazminBrowser.open(bytes, { key: keys.key }).then((r) => r.rows()), /CRC-32|Decryption failed/);
});
