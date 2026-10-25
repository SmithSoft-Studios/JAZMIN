// verify() in the browser reader: checks every section of the file's current version, as the library's verify() does,
// so the viewer can say when a file is damaged (also in parts no query reads). Plain files and files with a key or a
// password; a shared file needs its owner key, which browsers never hold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminKey, append, inspect, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));

const optionsFor = (file) => {
  const facts = inspect(file);
  return !facts.encrypted ? {} : facts.passwordProtected ? { password: keys.password } : { key: keys.key };
};

/** The library's verify() result, or the error it throws. */
const libraryVerify = (bytes, options, verifyOptions) => {
  let reader;
  try {
    reader = open(new Uint8Array(bytes), options);
  } catch {
    return { opens: false };
  }
  try {
    return { opens: true, result: reader.verify(verifyOptions) };
  } catch (error) {
    return { opens: true, error };
  } finally {
    reader.close();
  }
};

/** The browser reader's verify() result, or the error it throws (a Blob, read in slices as a File is). */
const browserVerify = async (bytes, options, verifyOptions) => {
  let reader;
  try {
    reader = await JazminBrowser.open(new Blob([bytes]), options);
  } catch {
    return { opens: false };
  }
  try {
    return { opens: true, result: await reader.verify(verifyOptions) };
  } catch (error) {
    return { opens: true, error };
  }
};

test('browser verify(): every plain, key and password fixture gives what the library gives, quick or not', async () => {
  const names = fs.readdirSync(fixtures).filter((n) => n.endsWith('.jzm') && !n.includes('brotli'));
  let checked = 0;
  for (const name of names) {
    const file = path.join(fixtures, name);
    if (inspect(file).accessControlled) continue;
    const bytes = fs.readFileSync(file);
    for (const quick of [false, true]) {
      const library = libraryVerify(bytes, optionsFor(file), { quick });
      const browser = await browserVerify(bytes, optionsFor(file), { quick });
      assert.ok(library.result, `${name}: the library verifies it`);
      assert.deepEqual(browser.result, library.result, `${name} quick=${quick}`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `fixtures checked: ${checked}`);
});

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, name: `name ${i * 7919 % 1000} ${i % 37}`, city: ['Durban', 'Cape Town', 'Pretoria'][i % 3], amountCents: i * 977 % 50000,
}));
const columns = [
  { name: 'id', type: 'int', index: 'sorted' }, { name: 'name', type: 'string', index: 'trigram' },
  { name: 'city', type: 'string', index: 'sorted' }, { name: 'amountCents', type: 'int' },
];

/** Flips bytes across the file: wherever the library's verify() catches the change, so does the browser's, and the reverse. */
async function assertSameVerdicts(good, options, tries) {
  const positions = new Set();
  for (let p = 0; p < 64; p++) positions.add(p);
  for (let p = good.length - 44; p < good.length; p++) positions.add(p);
  const step = Math.max(1, Math.floor((good.length - 108) / tries));
  for (let p = 64 + (good.length % step); p < good.length - 44; p += step) positions.add(p);
  const differ = [];
  let caught = 0;
  for (const p of positions) {
    const bad = Buffer.from(good);
    bad[p] ^= 0xff;
    const library = libraryVerify(bad, options);
    if (!library.opens) continue; // a change open() refuses: the viewer shows that error instead
    const browser = await browserVerify(bad, options);
    if (!browser.opens) continue;
    const verdict = (r) => (r.error ? 'caught' : 'passed');
    if (verdict(library) !== verdict(browser)) differ.push({ p, library: library.error?.message ?? 'passed', browser: browser.error?.message ?? 'passed' });
    if (browser.error) {
      caught++;
      assert.ok(browser.error instanceof JazminBrowser.JazminFormatError, `byte ${p}: ${browser.error}`);
    }
  }
  assert.deepEqual(differ, [], 'bytes the two readers judge differently');
  assert.ok(caught > tries / 4, `changes caught: ${caught}`);
}

test('browser verify(): a changed byte in a plain file is judged as the library judges it', async () => {
  const good = write(null, rows(1200), { columns, chunkRows: 300 });
  await assertSameVerdicts(good, {}, 300);
});

test('browser verify(): a changed byte in a file with a key is judged as the library judges it', async () => {
  const key = JazminKey.generate();
  const good = write(null, rows(1200), { key, columns, chunkRows: 300 });
  await assertSameVerdicts(good, { key: key.toString() }, 300);
});

test('browser verify(): an appended file counts the bytes its appends replaced; a damaged last trailer is refused', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-browser-verify-')), 'appended.jzm');
  const key = JazminKey.generate();
  write(file, rows(600), { key, columns, chunkRows: 200 });
  append(file, { key, insert: rows(10).map((r) => ({ ...r, id: r.id + 5000 })) });
  append(file, { key, delete: { id: { lt: 50 } } });
  const good = fs.readFileSync(file);
  const library = libraryVerify(good, { key });
  const browser = await browserVerify(good, { key: key.toString() });
  assert.ok(browser.result.unusedBytes > 0);
  assert.deepEqual(browser.result, library.result);
  // The last trailer damaged: readers open the version before it, and verify() says the file is damaged.
  const bad = Buffer.from(good);
  bad[good.length - 10] ^= 1;
  const cut = await browserVerify(bad, { key: key.toString() });
  assert.ok(cut.error instanceof JazminBrowser.JazminFormatError, String(cut.error));
});

test('browser verify(): a section length beyond the end of the file is refused', async () => {
  const bad = fs.readFileSync(path.join(fixtures, 'damaged', 'verify-section-length.jzm'));
  const { error } = await browserVerify(bad, {});
  assert.ok(error instanceof JazminBrowser.JazminFormatError, String(error));
  assert.match(error.message, /outside the file/);
});

test('browser verify(): a shared file is refused (it needs its owner key); quick must be true or false', async () => {
  const shared = await JazminBrowser.open(new Blob([fs.readFileSync(path.join(fixtures, 'js-access.jzm'))]), { key: keys.bob });
  await assert.rejects(shared.verify(), JazminBrowser.JazminValidationError);
  const plain = await JazminBrowser.open(new Blob([fs.readFileSync(path.join(fixtures, 'js-plain.jzm'))]));
  await assert.rejects(plain.verify({ quick: 'yes' }), JazminBrowser.JazminValidationError);
});
