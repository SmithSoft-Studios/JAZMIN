// The browser reader's openScript(): a .jzm made into a script (portableScript), loaded with a <script> element as a
// page opened from disk can, then opened from memory. Here a small stand-in page runs the scripts; the viewer's
// browser test (scripts/viewer-e2e.mjs) does the same in real browsers, from disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { open, portableScript } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));

/** A page at `baseURI` whose <script> elements load `files` (address -> script text), as a browser would: run, then load. */
function page(baseURI, files) {
  const loaded = [];
  globalThis.document = {
    baseURI,
    currentScript: null,
    createElement: () => ({ remove() { this.removed = true; } }),
    head: {
      append(script) {
        loaded.push(script.src);
        setTimeout(() => {
          if (files[script.src] === undefined) return script.onerror();
          document.currentScript = script;
          try { vm.runInThisContext(files[script.src]); } finally { document.currentScript = null; }
          script.onload();
        }, 1);
      },
    },
  };
  return loaded;
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.JazminScripts;
});

test('openScript loads a file made into a script, by a path relative to the page or a file:/// address', async () => {
  const loaded = page('file:///C:/pages/report/index.html', {
    'file:///C:/data/js-key.jzm.js': portableScript(path.join(fixtures, 'js-key.jzm')),
    'file:///C:/pages/report/js-plain.jzm.js': portableScript(path.join(fixtures, 'js-plain.jzm')),
  });
  const library = open(path.join(fixtures, 'js-key.jzm'), { key: keys.key });
  const table = await JazminBrowser.openScript('../../data/js-key.jzm.js', { key: keys.key });
  assert.equal(table.rowCount, library.rowCount);
  const bytesAsArrays = (row) => ({ ...row, blob: row.blob && new Uint8Array(row.blob) }); // the library gives Buffers
  assert.deepEqual((await table.query({ id: 7 }, { total: false })).rows.map(bytesAsArrays), [...library.find({ id: 7 })].map(bytesAsArrays));
  // Several files on one page: each is registered under its own address.
  const plain = await JazminBrowser.openScript('file:///C:/pages/report/js-plain.jzm.js');
  assert.equal(plain.rowCount, open(path.join(fixtures, 'js-plain.jzm')).rowCount);
  assert.deepEqual(loaded, ['file:///C:/data/js-key.jzm.js', 'file:///C:/pages/report/js-plain.jzm.js']);
  // Once opened, the text is let go: the reader keeps the bytes.
  assert.deepEqual(Object.keys(globalThis.JazminScripts), []);
});

test('scriptBytes gives the file inside a script as it is (still encrypted), to hand to the viewer', async () => {
  page('file:///C:/pages/index.html', { 'file:///C:/data/js-key.jzm.js': portableScript(path.join(fixtures, 'js-key.jzm')) });
  const bytes = await JazminBrowser.scriptBytes('../data/js-key.jzm.js');
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(Buffer.from(bytes).equals(fs.readFileSync(path.join(fixtures, 'js-key.jzm'))));
});

test('openScript uses a script the page already loaded, and loads one again after it was opened', async () => {
  const script = portableScript(path.join(fixtures, 'js-plain.jzm'));
  const loaded = page('file:///C:/pages/index.html', { 'file:///C:/pages/js-plain.jzm.js': script });
  document.currentScript = { src: 'file:///C:/pages/js-plain.jzm.js' }; // <script src="js-plain.jzm.js"> in the page
  vm.runInThisContext(script);
  document.currentScript = null;
  assert.equal((await JazminBrowser.openScript('js-plain.jzm.js')).rowCount, open(path.join(fixtures, 'js-plain.jzm')).rowCount);
  assert.deepEqual(loaded, []);
  await JazminBrowser.openScript('./js-plain.jzm.js');
  assert.deepEqual(loaded, ['file:///C:/pages/js-plain.jzm.js']);
});

test('openScript says what is wrong: no such script, a script that is not a file, the wrong key, no page', async () => {
  page('file:///C:/pages/index.html', {
    'file:///C:/pages/other.js': 'globalThis.somethingElse = 1;',
    'file:///C:/pages/js-key.jzm.js': portableScript(path.join(fixtures, 'js-key.jzm')),
  });
  await assert.rejects(JazminBrowser.openScript('missing.jzm.js'), (e) => e instanceof JazminBrowser.JazminError && /Could not load missing\.jzm\.js/.test(e.message));
  await assert.rejects(JazminBrowser.openScript('other.js'), (e) => e instanceof JazminBrowser.JazminFormatError && /other\.js is not a JAZMIN file made into a script/.test(e.message));
  await assert.rejects(JazminBrowser.openScript('js-key.jzm.js', { password: 'wrong' }), JazminBrowser.JazminKeyError);
  delete globalThis.document;
  await assert.rejects(JazminBrowser.openScript('js-key.jzm.js'), /openScript\(\) loads a script into a page/);
});
