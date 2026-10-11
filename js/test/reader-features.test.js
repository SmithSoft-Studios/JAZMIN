import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect, open } from '../src/index.js';
import '../browser/jazmin-browser.js';

// reader.readerFeatures (spec 3.2), in the library and the browser reader: what each interop fixture needs, from both
// libraries: compact indexes ('index-deltas') and nested columns ('nested-columns'); none for the rest.

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const expected = (name) => [...(name.includes('paged-compact') ? ['index-deltas'] : []), ...(name.includes('nested') ? ['nested-columns'] : [])];

function options(file) {
  const facts = inspect(file);
  if (facts.accessControlled) return { key: keys.bob, accessState: false };
  if (facts.passwordProtected) return { password: keys.password };
  return facts.encrypted ? { key: keys.key } : {};
}

test('readerFeatures: what each fixture needs, in the library and the browser reader', async () => {
  const names = fs.readdirSync(fixtures).filter((f) => f.endsWith('.jzm'));
  assert.ok(names.length >= 40);
  for (const name of names) {
    const file = path.join(fixtures, name);
    const reader = open(file, options(file));
    assert.deepEqual(reader.readerFeatures, expected(name), name);
    reader.readerFeatures.push('changed'); // a copy: the reader's own list stays as the file says
    assert.deepEqual(reader.readerFeatures, expected(name), name);
    reader.close();
    if (name.includes('brotli')) continue; // browsers have no Brotli
    const { key, password } = options(file);
    const browser = await globalThis.JazminBrowser.open(new Blob([fs.readFileSync(file)]), { ...(key ? { key } : {}), ...(password ? { password } : {}) });
    assert.deepEqual(browser.readerFeatures, expected(name), `${name} (browser reader)`);
  }
});
