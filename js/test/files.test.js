import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFormatError, JazminKey, JazminValidationError, append, checkPageSettings, compact, open, update, write } from '../src/index.js';
import { readActions } from '../src/files.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-files-'));
const columns = [{ name: 'id', type: 'int' }, { name: 'group', type: 'string' }];
const rows = ['A', 'B', 'C', 'D', 'E'].flatMap((g, k) => Array.from({ length: 20 }, (_, i) => ({ id: k * 100 + i, group: g })));
const big = crypto.randomBytes(700 * 1024); // 3 blocks, incompressible
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const streamToBuffer = async (s) => Buffer.concat(await s.toArray());

test('files round-trip: whole, by range, as a stream; metadata and media types', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'logo.png'), big);
  const key = JazminKey.generate();
  const file = path.join(dir, 'f.jzm');
  write(file, rows, {
    columns, key,
    files: [
      { path: 'index.html', content: '<h1>Hi</h1>' },
      { path: 'img/logo.png', file: path.join(dir, 'logo.png') },
      { path: 'empty.txt', content: '' },
      { path: 'data.bin', content: Buffer.from([1, 2, 3]), type: 'application/x-custom' },
    ],
    package: { entry: 'index.html', title: 'Demo', allowedOrigins: ['https://api.example.com'] },
  });
  const r = open(file, { key });
  assert.deepEqual(r.files.map((f) => [f.path, f.type, f.size]).sort(), [
    ['data.bin', 'application/x-custom', 3], ['empty.txt', 'text/plain', 0], ['img/logo.png', 'image/png', big.length], ['index.html', 'text/html', 11],
  ]);
  assert.equal(r.files.find((f) => f.path === 'img/logo.png').sha256, sha(big));
  assert.deepEqual(r.files[0].groups, ['*']);
  assert.equal(r.readFile('index.html').toString(), '<h1>Hi</h1>');
  assert.ok(r.readFile('img/logo.png').equals(big));
  assert.equal(r.readFile('empty.txt').length, 0);
  assert.ok(r.readFileRange('img/logo.png', 262_000, 263_000).equals(big.subarray(262_000, 263_000))); // across a block boundary
  assert.ok(r.readFileRange('img/logo.png', 600_000).equals(big.subarray(600_000)));
  assert.ok((await streamToBuffer(r.openFile('img/logo.png'))).equals(big));
  assert.deepEqual(r.package, { entry: 'index.html', title: 'Demo', allowedOrigins: ['https://api.example.com'] });
  assert.equal(r.rowCount, rows.length); // data unaffected
  assert.throws(() => r.readFile('missing.txt'), /No file 'missing.txt'/);
  r.close();
  assert.throws(() => open(file), /encrypted/);
});

test('identical content is stored once, whatever the paths; a path cannot be added twice', () => {
  const one = write(null, rows, { columns, files: [{ path: 'a.bin', content: big }] });
  const three = write(null, rows, { columns, files: [{ path: 'a.bin', content: big }, { path: 'copy/b.bin', content: big }, { path: 'c.bin', content: Buffer.from(big) }] });
  assert.ok(three.length - one.length < 1024, `${three.length - one.length} extra bytes`);
  const r = open(three);
  assert.ok(r.readFile('copy/b.bin').equals(big));
  assert.throws(() => write(null, rows, { columns, files: [{ path: 'x', content: 'a' }, { path: 'x', content: 'b' }] }), /added twice/);
});

test('files without embedded files are unchanged; paths and package settings are validated', () => {
  const plain = open(write(null, rows, { columns }));
  assert.deepEqual(plain.files, []);
  assert.equal(plain.package, undefined);
  for (const bad of ['../x', '/abs', 'a//b', 'a\\b', './x', '']) {
    assert.throws(() => write(null, rows, { columns, files: [{ path: bad, content: 'x' }] }), JazminValidationError, bad);
  }
  assert.throws(() => write(null, rows, { columns, files: [{ path: 'a', content: 'x' }], package: { entry: 'b' } }), /not one of the stored files/);
  // The document's page settings for PDFs: checked when written, kept as given.
  const withPdf = (pdf) => write(null, rows, { columns, files: [{ path: 'a', content: 'x' }], package: { entry: 'a', pdf } });
  assert.deepEqual(open(withPdf({ format: 'Letter', landscape: true, margin: { top: '12mm', left: '0.5in' }, scale: 0.9, printBackground: false })).package.pdf,
    { format: 'Letter', landscape: true, margin: { top: '12mm', left: '0.5in' }, scale: 0.9, printBackground: false });
  assert.throws(() => withPdf({ format: 'B5' }), /package\.pdf\.format: 'B5' is not one of A0/);
  assert.throws(() => withPdf({ landscape: 'yes' }), /package\.pdf\.landscape must be true or false/);
  assert.throws(() => withPdf({ margin: { top: '12' } }), /a length such as 12mm/);
  assert.throws(() => withPdf({ margin: { inside: '1cm' } }), /unknown side 'inside'/);
  assert.throws(() => withPdf({ scale: 3 }), /from 0\.1 to 2/);
  assert.throws(() => withPdf({ colour: true }), /unknown setting 'colour'/);
  assert.throws(() => withPdf([]), /package\.pdf must be an object/);
  assert.throws(() => write(null, rows, { columns, files: [{ path: 'a', content: 'x' }], package: { allowedOrigins: ['http://x.com'] } }), /https origin/);
  assert.throws(() => write(null, rows, { columns, files: [{ path: 'a', content: 'x' }], package: { allowedOrigins: ['https://x.com/path'] } }), /https origin/);
});

/** The example from the design: shared, partly shared and group-only files. */
function accessFile() {
  const owner = JazminKey.generate();
  const keys = Object.fromEntries(['a', 'b', 'd', 'e', 'all', 'tpl'].map((n) => [n, owner.createAccessKey()]));
  const shared = crypto.randomBytes(5000);
  const buf = write(null, rows, {
    columns, key: owner, sortedBy: ['group', 'id'],
    files: [
      { path: 'index.html', content: '<main>everyone</main>' },
      { path: 'appendix.html', content: 'A and B', groups: ['A', 'B'] },
      { path: 'img/logoD.png', content: 'D only', groups: ['D'] },
      { path: 'docs/terms.pdf', content: shared, groups: ['A', 'B', 'C', 'D'] },
      { path: 'docs/terms-copy.pdf', content: shared, groups: ['template'] }, // same bytes: stored once
    ],
    access: {
      partitionBy: 'group',
      grants: [
        { key: keys.a, rows: ['A'] }, { key: keys.b, rows: ['B'] }, { key: keys.d, rows: ['D'] },
        { key: keys.e, rows: ['E'] }, { key: keys.all, rows: '*' }, { key: keys.tpl, rows: ['C'], files: ['template'] },
      ],
    },
  });
  return { owner, keys, shared, buf };
}

const visible = (buf, key) => {
  const r = open(buf, { key: key.toString(), accessState: false });
  const list = r.files.map((f) => f.path).sort();
  r.close();
  return list;
};

test('access-controlled files: each key sees exactly its groups\' files', () => {
  const { owner, keys, shared, buf } = accessFile();
  assert.deepEqual(visible(buf, keys.a), ['appendix.html', 'docs/terms.pdf', 'index.html']);
  assert.deepEqual(visible(buf, keys.b), ['appendix.html', 'docs/terms.pdf', 'index.html']);
  assert.deepEqual(visible(buf, keys.d), ['docs/terms.pdf', 'img/logoD.png', 'index.html']);
  assert.deepEqual(visible(buf, keys.e), ['index.html']); // other groups' file names stay hidden
  assert.deepEqual(visible(buf, keys.all), ['appendix.html', 'docs/terms.pdf', 'img/logoD.png', 'index.html']);
  assert.deepEqual(visible(buf, keys.tpl), ['docs/terms-copy.pdf', 'docs/terms.pdf', 'index.html']);

  const d = open(buf, { key: keys.d.toString(), accessState: false });
  assert.equal(d.readFile('img/logoD.png').toString(), 'D only');
  assert.ok(d.readFile('docs/terms.pdf').equals(shared));
  assert.throws(() => d.readFile('appendix.html'), /No file 'appendix.html'/);
  assert.equal(d.files.find((f) => f.path === 'index.html').groups, undefined); // keys do not learn other groups' names

  const o = open(buf, { key: owner });
  const groups = Object.fromEntries(o.files.map((f) => [f.path, f.groups]));
  assert.deepEqual(groups, {
    'appendix.html': ['A', 'B'], 'docs/terms-copy.pdf': ['template'], 'docs/terms.pdf': ['A', 'B', 'C', 'D'],
    'img/logoD.png': ['D'], 'index.html': ['*'],
  });
  assert.ok(o.readFile('docs/terms-copy.pdf').equals(shared));
});

test('a changed byte in a stored file is detected', () => {
  const key = JazminKey.generate();
  const buf = Buffer.from(write(null, rows, { columns, key, files: [{ path: 'a.bin', content: big }] }));
  buf[64 + 16 + 100] ^= 1; // files given to write() are stored first: this is inside the first block's payload
  const r = open(buf, { key });
  assert.throws(() => r.readFile('a.bin'), (e) => e instanceof JazminFormatError || /Decryption failed/.test(e.message));
});

test('append adds, replaces and removes files; content is reused; compact drops what is no longer used', () => {
  const file = path.join(tmpDir(), 'f.jzm');
  const key = JazminKey.generate();
  write(file, rows, { columns, key, files: [{ path: 'keep.txt', content: 'keep' }, { path: 'big.bin', content: big }, { path: 'old.txt', content: 'v1' }] });
  const before = fs.statSync(file).size;
  append(file, { key, addFiles: [{ path: 'big-copy.bin', content: big }, { path: 'old.txt', content: 'v2' }], removeFiles: ['keep.txt'] });
  assert.ok(fs.statSync(file).size - before < 10_000, 'an identical file is referenced, not stored again');
  let r = open(file, { key });
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['big-copy.bin', 'big.bin', 'old.txt']);
  assert.equal(r.readFile('old.txt').toString(), 'v2');
  assert.ok(r.readFile('big-copy.bin').equals(big));
  r.close();
  assert.throws(() => append(file, { key, removeFiles: ['nope'] }), /no file 'nope'/);

  append(file, { key, removeFiles: ['big.bin', 'big-copy.bin'] });
  const grown = fs.statSync(file).size;
  compact(file, { key });
  assert.ok(fs.statSync(file).size < grown - big.length / 2, 'compaction dropped the unreferenced content');
  r = open(file, { key });
  assert.deepEqual(r.files.map((f) => [f.path, r.readFile(f.path).toString()]), [['old.txt', 'v2']]);
  assert.equal(r.rowCount, rows.length);
  r.close();
});

test('files carry what viewers may do with them (actions): checked when written, kept by append, update and compact', () => {
  const file = path.join(tmpDir(), 'f.jzm');
  const key = JazminKey.generate();
  const pdf = { format: 'A5', landscape: true, margin: { top: '1cm' }, preferCSSPageSize: true };
  write(file, rows, {
    columns, key,
    files: [
      { path: 'index.html', content: '<p>statement</p>', actions: { pdf, image: false } },
      { path: 'data.csv', content: 'a,b', actions: { open: false, save: false } },
      { path: 'plain.txt', content: 'p' },
    ],
  });
  const actionsOf = (r) => Object.fromEntries(r.files.map((f) => [f.path, f.actions]));
  let r = open(file, { key });
  assert.deepEqual(actionsOf(r), { 'index.html': { pdf, image: false }, 'data.csv': { open: false, save: false }, 'plain.txt': undefined });
  r.files.find((f) => f.path === 'index.html').actions.pdf.format = 'A0'; // a copy
  assert.equal(r.files.find((f) => f.path === 'index.html').actions.pdf.format, 'A5');
  r.close();

  append(file, { key, addFiles: [{ path: 'more.txt', content: 'm', actions: { print: false } }] });
  update(file, { key, removeFiles: ['plain.txt'] });
  compact(file, { key });
  r = open(file, { key });
  assert.deepEqual(actionsOf(r), { 'index.html': { pdf, image: false }, 'data.csv': { open: false, save: false }, 'more.txt': { print: false } });
  r.close();

  const withActions = (actions) => write(null, rows, { columns, files: [{ path: 'a.html', content: 'x', actions }] });
  assert.deepEqual(open(withActions({ pdf: false, print: true })).files[0].actions, { pdf: false, print: true });
  assert.equal(open(withActions({})).files[0].actions, undefined);
  assert.throws(() => withActions({ download: true }), /File 'a\.html': actions: unknown action 'download'/);
  assert.throws(() => withActions({ save: 'no' }), /actions\.save must be true or false/);
  assert.throws(() => withActions({ pdf: { format: 'B5' } }), /actions\.pdf\.format: 'B5' is not one of/);
  assert.throws(() => withActions({ pdf: null }), /actions\.pdf must be an object/);
  assert.throws(() => withActions([]), /actions must be an object/);
});

test('checkPageSettings: a clean copy of page settings, nothing a browser would take besides', () => {
  const given = { format: 'A5', margin: { top: '1cm' }, landscape: true };
  const checked = checkPageSettings(given);
  assert.deepEqual(checked, given);
  checked.margin.top = '2cm';
  assert.equal(given.margin.top, '1cm'); // a copy
  assert.throws(() => checkPageSettings({ format: 'A4', path: 'C:/Windows/x.pdf' }), /Page settings: unknown setting 'path'/);
  assert.throws(() => checkPageSettings({ scale: 9 }), /Page settings\.scale/);
  assert.throws(() => checkPageSettings(null), /Page settings must be an object/);
});

test('readers take the actions they know: later ones, and wrong types, are left out', () => {
  assert.deepEqual(readActions({ open: false, save: 'no', future: true, pdf: { format: 'A4' } }), { open: false, pdf: { format: 'A4' } });
  assert.deepEqual(readActions({ pdf: { format: 'A4', bleed: '3mm' } }), { pdf: true }); // settings it doesn't know: allowed, with its own
  assert.equal(readActions({ later: 1 }), undefined);
  assert.equal(readActions('print'), undefined);
});

test('update and compact keep files and their groups in access-controlled files', () => {
  const { owner, keys, buf } = accessFile();
  const file = path.join(tmpDir(), 'f.jzm');
  fs.writeFileSync(file, buf);
  update(file, { key: owner, addFiles: [{ path: 'news.html', content: 'B news', groups: ['B'] }], removeFiles: ['docs/terms-copy.pdf'] });
  assert.deepEqual(visible(fs.readFileSync(file), keys.b), ['appendix.html', 'docs/terms.pdf', 'index.html', 'news.html']);
  assert.deepEqual(visible(fs.readFileSync(file), keys.tpl), ['docs/terms.pdf', 'index.html']);
  compact(file, { key: owner });
  assert.deepEqual(visible(fs.readFileSync(file), keys.d), ['docs/terms.pdf', 'img/logoD.png', 'index.html']);
  append(file, { key: owner, addFiles: [{ path: 'd2.txt', content: 'more D', groups: ['D'] }] });
  const d = open(fs.readFileSync(file), { key: keys.d.toString(), accessState: false });
  assert.equal(d.readFile('d2.txt').toString(), 'more D');
  assert.equal(d.readFile('img/logoD.png').toString(), 'D only');
});
