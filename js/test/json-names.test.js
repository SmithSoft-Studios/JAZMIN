// The JSON a reader uses itself (metadata, column attributes, package settings, file directories, key slots, the owner
// directory) must not repeat a name in one object (spec 2): JSON.parse would keep the last value, .NET rejects it, and
// both libraries must read a file the same way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminFormatError, open } from '../src/index.js';
import { parseJsonText } from '../src/binary.js';
import '../browser/jazmin-browser.js';

const damaged = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures/damaged');

test('a name repeated in one object is rejected, at any depth, after escapes are decoded', () => {
  const rejected = [
    '{"name":"a","name":"b"}',
    '{"a":{"b":{"c":1,"c":2}}}',
    '{"files":[{"path":"x","path":"y"}]}',
    '{"a":1,"\\u0061":2}',
    '{"é":1,"\\u00e9":2}',
    '{"a\\"b":1,"a\\"b":2}',
    '[1,{"x":[],"y":{},"x":null}]',
  ];
  for (const text of rejected) {
    assert.throws(() => parseJsonText(text, 'Metadata', true), (e) => e instanceof JazminFormatError && /appears twice/.test(e.message), text);
    assert.doesNotThrow(() => parseJsonText(text, 'A json value'), text); // json column values are not checked
  }
  const accepted = [
    '{"a":{"id":1},"b":{"id":2}}',
    '{"id":1,"child":{"id":2}}',
    '{"files":[{"path":"x"},{"path":"y"}]}',
    '{"Name":"a","name":"b"}',
    '{"a":"\\"a\\":1,\\"a\\"","b":["a","a"],"c":{}}',
    '{}', '[]', '"text"', '12', 'null',
  ];
  for (const text of accepted) assert.deepEqual(parseJsonText(text, 'Metadata', true), JSON.parse(text), text);
});

test('files whose directory or package settings repeat a name fail with a JazminFormatError, in both readers', async () => {
  const cases = [
    ['file-directory-duplicate-name.jzm', (r) => r.files, async (r) => r.files()],
    ['package-duplicate-name.jzm', (r) => r.package, async (r) => r.package],
  ];
  for (const [name, read, readInBrowser] of cases) {
    const bytes = fs.readFileSync(path.join(damaged, name));
    assert.throws(() => {
      const r = open(bytes);
      try {
        read(r);
      } finally {
        r.close();
      }
    }, (e) => e instanceof JazminFormatError && /appears twice/.test(e.message), name);
    await assert.rejects(async () => readInBrowser(await JazminBrowser.open(bytes)),
      (e) => e instanceof JazminBrowser.JazminFormatError && /appears twice/.test(e.message), name);
  }
});
