import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminError, JazminFormatError, JazminKey, JazminValidationError, append, inspect, open, write } from '../src/index.js';

// reader.verify(): checks every section of the file's current version, not only those a query reads (issue #275:
// a byte changed in an index no query used went unnoticed). Shared files: each section's SHA-256 against the owner's
// signature; files with a key or password: each section's CRC-32 and authentication tag; plain files: CRC-32 only.

const fixtures = path.resolve(import.meta.dirname, '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-verify-'));

const verifyOf = (source, options) => {
  const reader = open(source, options);
  try {
    return reader.verify();
  } finally {
    reader.close();
  }
};

const optionsFor = (file) => {
  const facts = inspect(file);
  return !facts.encrypted ? {} : facts.passwordProtected ? { password: keys.password } : { key: keys.key };
};

test('every fixture verifies; the bytes checked and the unused bytes make up the file', () => {
  for (const name of fs.readdirSync(fixtures).filter((n) => n.endsWith('.jzm'))) {
    const file = path.join(fixtures, name);
    const facts = inspect(file);
    const result = verifyOf(file, optionsFor(file));
    assert.equal(result.checkedBy, facts.accessControlled ? 'signature' : facts.encrypted ? 'encryption' : 'checksum', name);
    assert.ok(result.sections > 0, name);
    assert.equal(64 + result.bytes + result.unusedBytes + 44, fs.statSync(file).size, name);
    if (!facts.appended) assert.equal(result.unusedBytes, 0, `${name}: written in full, so every byte is checked`);
  }
});

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, name: `name ${i * 7919 % 1000} ${i % 37}`, city: ['Durban', 'Cape Town', 'Pretoria'][i % 3], amountCents: i * 977 % 50000,
  note: `note ${i} `.repeat(1 + (i % 5)),
}));
const columns = [
  { name: 'id', type: 'int', index: 'sorted' }, { name: 'name', type: 'string', index: 'trigram' },
  { name: 'city', type: 'string', index: 'sorted' }, { name: 'amountCents', type: 'int', index: 'sorted' },
  { name: 'note', type: 'string' },
];

/** Flips bytes across the whole file (every byte of the preamble and trailer, a stride elsewhere): each is caught. */
function assertEveryFlipCaught(good, options, { tries = 600, fileId = true } = {}) {
  const positions = new Set();
  for (let p = 0; p < 64; p++) if (fileId || p < 8 || p >= 24) positions.add(p);
  for (let p = good.length - 44; p < good.length; p++) positions.add(p);
  const step = Math.max(1, Math.floor((good.length - 108) / tries));
  for (let p = 64 + (good.length % step); p < good.length - 44; p += step) positions.add(p);
  const silent = [];
  for (const p of positions) {
    const bad = Buffer.from(good);
    bad[p] ^= 0xff;
    try {
      verifyOf(new Uint8Array(bad), options);
      silent.push(p);
    } catch (error) {
      assert.ok(error instanceof JazminError, `byte ${p}: ${error}`);
    }
  }
  assert.deepEqual(silent, [], `bytes changed without verify() noticing (of ${positions.size} tried)`);
}

test('a changed byte anywhere in an encrypted file is caught, also in indexes no query reads', () => {
  const key = JazminKey.generate();
  const good = write(null, rows(3000), { key, columns, chunkRows: 500 });
  assert.deepEqual(Object.keys(verifyOf(good, { key })), ['checkedBy', 'sections', 'bytes', 'unusedBytes']);
  assertEveryFlipCaught(good, { key });
});

test('a changed byte anywhere in a shared file is caught with the owner key; an access key is refused', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const good = write(null, rows(1500), {
    key: owner, columns: [...columns.slice(0, 4), { name: 'note', type: 'string', group: 'private' }], chunkRows: 300,
    access: { partitionBy: 'city', grants: [{ key: bob, rows: ['Durban'], columns: [] }] },
  });
  assert.equal(verifyOf(good, { key: owner }).checkedBy, 'signature');
  assertEveryFlipCaught(good, { key: owner }, { tries: 400 });
  assert.throws(() => verifyOf(good, { key: bob }), JazminValidationError);
});

test('a plain file is checked by its checksums: accidental damage anywhere is caught', () => {
  const good = write(null, rows(1500), { columns, chunkRows: 500 });
  assert.equal(verifyOf(good).checkedBy, 'checksum');
  // Nothing in a plain file depends on its file id (preamble bytes 8-23): only encryption or a signature binds it.
  assertEveryFlipCaught(good, {}, { tries: 400, fileId: false });
});

test('an appended file: the current version is checked whole, the bytes it replaced are counted as unused', () => {
  const file = path.join(temp(), 'appended.jzm');
  const key = JazminKey.generate();
  write(file, rows(1000), { key, columns, chunkRows: 400 });
  append(file, { key, insert: rows(10).map((r) => ({ ...r, id: r.id + 5000 })) });
  append(file, { key, delete: { id: { lt: 50 } } });
  const result = verifyOf(file, { key });
  assert.ok(result.unusedBytes > 0);
  assert.equal(64 + result.bytes + result.unusedBytes + 44, fs.statSync(file).size);
  const good = fs.readFileSync(file);
  // The last append's header ends the file, just before its trailer: a change there is caught.
  const inHeader = Buffer.from(good);
  inHeader[good.length - 44 - 20] ^= 1;
  assert.throws(() => verifyOf(new Uint8Array(inHeader), { key }), JazminError);
  // A damaged last trailer makes readers fall back to the version before it (an interrupted append): verify() says so.
  const inTrailer = Buffer.from(good);
  inTrailer[good.length - 10] ^= 1;
  assert.throws(() => verifyOf(new Uint8Array(inTrailer), { key }), JazminFormatError);
});

test('a closed reader refuses verify()', () => {
  const reader = open(write(null, rows(10), { columns }));
  reader.close();
  assert.throws(() => reader.verify(), JazminValidationError);
});
