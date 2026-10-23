import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminError, JazminFormatError, JazminKey, JazminValidationError, append, inspect, open, write } from '../src/index.js';
import { crc32 } from '../src/binary.js';
import { decodeChunkDirectory, decodeHeader } from '../src/catalog.js';
import { decodeSection } from '../src/section.js';
import { KEY_ROTATION } from '../src/reader.js';

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
    assert.equal(64 + result.bytes + result.unusedBytes + result.publisherBytes + 44, fs.statSync(file).size, name);
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
  assert.deepEqual(Object.keys(verifyOf(good, { key })), ['checkedBy', 'sections', 'bytes', 'unusedBytes', 'publisherBytes']);
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
  assert.equal(64 + result.bytes + result.unusedBytes + result.publisherBytes + 44, fs.statSync(file).size);
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

test('a change only the authentication tag catches, in a section verify() decodes to find others, is a format error', () => {
  const key = JazminKey.generate();
  const good = write(null, rows(3000), { key, columns, chunkRows: 500 });
  const reader = open(good, { key });
  const directory = reader[KEY_ROTATION].sections.find((s) => s.sectionId.endsWith('/sorted')); // a sorted index's directory
  reader.close();
  const bad = Buffer.from(good);
  bad[directory.offset + 16 + 20] ^= 1; // in the encrypted payload
  const body = bad.subarray(directory.offset + 16, directory.offset + directory.length);
  bad.writeUInt32LE(crc32(body), directory.offset + 12); // the CRC made right again: only the tag can tell
  assert.throws(() => verifyOf(new Uint8Array(bad), { key }), (error) => error instanceof JazminFormatError && /modified/.test(error.message));
});

test('a shared file with locked embedded files verifies whole with the owner key, the locks left closed', () => {
  const owner = JazminKey.generate();
  const good = write(null, rows(200), {
    key: owner, columns, access: { partitionBy: 'city', grants: [] },
    files: [{ path: 'contract.pdf', content: Buffer.alloc(300 * 1024, 7), lock: 'contracts' }, { path: 'readme.txt', content: 'open' }],
    locks: { contracts: { password: 'correct horse', iterations: 1000 } },
  });
  const result = verifyOf(good, { key: owner });
  assert.deepEqual([result.checkedBy, result.unusedBytes], ['signature', 0]);
  const bad = Buffer.from(good);
  bad[Math.floor(good.length / 2)] ^= 1; // the locked 300 KB contract is most of the file
  assert.throws(() => verifyOf(new Uint8Array(bad), { key: owner }), JazminError);
});

/** The file with its trailer's CRC made right again after a change to trailer bytes 0-35, as someone changing a file would. */
const withTrailerCrc = (bytes) => {
  const t = bytes.length - 44;
  bytes.writeUInt32LE(crc32(bytes.subarray(t, t + 36)), t + 36);
  return bytes;
};
const FLAG_PASSWORD = 2;
const FLAG_APPENDED = 8;

test('preamble flags and trailer fields no checksum covers must hold values the format allows', () => {
  const key = JazminKey.generate();
  const owner = JazminKey.generate();
  const keyFile = write(null, rows(300), { key, columns, chunkRows: 100 });
  const plainFile = write(null, rows(300), { columns, chunkRows: 100 });
  const sharedFile = write(null, rows(300), { key: owner, columns, chunkRows: 100, access: { partitionBy: 'city', grants: [] } });
  const refused = (bytes, options, what) => assert.throws(() => verifyOf(new Uint8Array(bytes), options), JazminFormatError, what);

  // PASSWORD (spec 4.1, 7.6) only on an encrypted file that isn't shared, with an iteration count readers accept. (A key
  // file given the flag and a valid count can't be told from a password file opened with its derived key: not covered.)
  for (const [file, options, name, counts] of [[keyFile, { key }, 'key', [0]], [plainFile, {}, 'plain', [0, 1000]], [sharedFile, { key: owner }, 'shared', [0, 1000]]]) {
    for (const iterations of counts) {
      const bad = Buffer.from(file);
      bad.writeUInt16LE(bad.readUInt16LE(4) | FLAG_PASSWORD, 4);
      bad.writeUInt32LE(iterations, 56);
      refused(bad, options, `${name} file with PASSWORD and ${iterations} iterations`);
    }
  }
  // Trailer bytes 12-35 locate the key-slot list and signature of a shared file; in other files they are 0.
  for (const at of [12, 20, 24, 32]) {
    const bad = Buffer.from(keyFile);
    bad[bad.length - 44 + at] = 1;
    refused(withTrailerCrc(bad), { key }, `trailer byte ${at}`);
  }
  // The reserved bytes of the shared file's signature section (its envelope bytes 2-3, in no checksum or signature).
  const signatureAt = Number(sharedFile.readBigUInt64LE(sharedFile.length - 44 + 24));
  const badEnvelope = Buffer.from(sharedFile);
  badEnvelope[signatureAt + 2] = 1;
  refused(badEnvelope, { key: owner }, 'signature envelope byte 2');

  // An appended file has the APPENDED flag (11.2). A file never appended to may have it: an append cut short leaves it.
  const file = path.join(temp(), 'appended.jzm');
  write(file, rows(300), { key, columns, chunkRows: 100 });
  append(file, { key, insert: rows(5).map((r) => ({ ...r, id: r.id + 5000 })) });
  const cleared = fs.readFileSync(file);
  cleared.writeUInt16LE(cleared.readUInt16LE(4) & ~FLAG_APPENDED, 4);
  refused(cleared, { key }, 'appended file without APPENDED');
  const flagged = Buffer.from(keyFile);
  flagged.writeUInt16LE(flagged.readUInt16LE(4) | FLAG_APPENDED, 4);
  assert.equal(verifyOf(new Uint8Array(flagged), { key }).unusedBytes, 0);
});

test('a section length beyond the end of the file is refused before anything is read or allocated for it', () => {
  // A plain file whose chunk directory (no tag) gives the last chunk's part a length of 2,000,000,000, every CRC right:
  // spec/fixtures/damaged/verify-section-length.jzm, shared with the .NET tests.
  const bad = fs.readFileSync(path.join(fixtures, 'damaged', 'verify-section-length.jzm'));
  const reader = open(new Uint8Array(bad));
  try {
    assert.equal([...reader.find({ id: { lt: 3 } })].length, 2, 'the file opens and answers queries');
    const before = process.memoryUsage().arrayBuffers;
    assert.throws(() => reader.verify(), JazminFormatError);
    assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 2 ** 20, 'no buffer was sized from the length');
  } finally {
    reader.close();
  }
});

test('signed files: the publisher signature block is counted apart; bytes added around it, or a damaged block, are a change', () => {
  const dir = path.join(fixtures, 'publisher');
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const changed = new Set(['changed-gap.jzm', 'changed-extra-byte.jzm', 'invalid-block-crc.jzm', 'invalid-block-reserved.jzm']);
  const skipped = new Set(['changed-byte.jzm', 'changed-trailing-byte.jzm']); // a section, or the trailer: covered above
  for (const fixture of expected.fixtures) {
    if (skipped.has(fixture.file)) continue;
    const file = path.join(dir, fixture.file);
    const k = fixture.keys ?? {};
    const options = k.password ? { password: k.password } : k.key ? { key: k.key } : k.ownerKey ? { key: k.ownerKey } : {};
    if (changed.has(fixture.file)) {
      assert.throws(() => verifyOf(file, options), JazminFormatError, fixture.file);
      continue;
    }
    const result = verifyOf(file, options);
    assert.equal(64 + result.bytes + result.unusedBytes + result.publisherBytes + 44, fs.statSync(file).size, fixture.file);
    if (fixture.file === 'appended.jzm') {
      assert.equal(result.publisherBytes, 0, 'the block is before the header the append replaced: an earlier version');
      assert.ok(result.unusedBytes > 0);
    } else {
      assert.equal(result.unusedBytes, 0, fixture.file);
      assert.equal(result.publisherBytes > 0, fixture.file !== 'unsigned.jzm', fixture.file);
    }
  }
});

/** The offset of a compressed (deflate) chunk part in a plain file: a section no query has read when it opens. */
function compressedChunkPart(file) {
  const t = file.length - 44;
  const fileId = file.subarray(8, 24);
  const at = Number(file.readBigUInt64LE(t));
  const header = decodeHeader(decodeSection(file.subarray(at, at + file.readUInt32LE(t + 8)), { fileId, sectionId: 'header' }));
  const table = header.tables[0];
  const ref = table.partitions[0].segments[0];
  const directory = decodeChunkDirectory(decodeSection(file.subarray(ref.offset, ref.offset + ref.length), { fileId, sectionId: '0/dir/*' }), table.columnGroups.length);
  const part = directory.chunks.flatMap((c) => c.parts).find((p) => file[p.offset] === 1);
  assert.ok(part, 'a deflate-compressed chunk part');
  return part.offset;
}

test('verify({ quick: true }): a plain file\'s sections by their checksums and envelopes, without decompressing them', () => {
  const good = write(null, rows(1500), { columns, chunkRows: 500 });
  const full = verifyOf(new Uint8Array(good));
  assert.deepEqual(verifyOf(new Uint8Array(good), { }), full);
  const reader = open(new Uint8Array(good));
  try {
    assert.deepEqual(reader.verify({ quick: true }), full, 'the same sections and bytes');
    assert.throws(() => reader.verify({ quick: 'yes' }), JazminValidationError);
  } finally {
    reader.close();
  }
  const quick = (bytes) => {
    const r = open(new Uint8Array(bytes));
    try {
      return r.verify({ quick: true });
    } finally {
      r.close();
    }
  };
  const part = compressedChunkPart(good);
  // Caught by both: a changed payload byte (its CRC-32), an unknown codec.
  const payload = Buffer.from(good);
  payload[part + 20] ^= 1;
  assert.throws(() => quick(payload), JazminFormatError);
  const codec = Buffer.from(good);
  codec[part] = 7;
  assert.throws(() => quick(codec), JazminFormatError);
  // Caught only by the full check: the decompressed length in the envelope, which no CRC-32 covers. A query reading
  // the section would refuse it too.
  const rawLength = Buffer.from(good);
  rawLength.writeUInt32LE(rawLength.readUInt32LE(part + 4) + 1, part + 4);
  assert.throws(() => verifyOf(new Uint8Array(rawLength)), JazminFormatError);
  assert.deepEqual(quick(rawLength), full);
});

test('verify({ quick: true }) on an encrypted file is the full check: the tag covers the envelope too', () => {
  const key = JazminKey.generate();
  const good = write(null, rows(1500), { key, columns, chunkRows: 500 });
  const reader = open(new Uint8Array(good), { key });
  const section = reader[KEY_ROTATION].sections.find((s) => s.sectionId.includes('/chunk/'));
  try {
    assert.deepEqual(reader.verify({ quick: true }), reader.verify());
  } finally {
    reader.close();
  }
  const rawLength = Buffer.from(good);
  rawLength.writeUInt32LE(rawLength.readUInt32LE(section.offset + 4) + 1, section.offset + 4);
  const r = open(new Uint8Array(rawLength), { key });
  try {
    assert.throws(() => r.verify({ quick: true }), JazminFormatError);
  } finally {
    r.close();
  }
});

test('a closed reader refuses verify()', () => {
  const reader = open(write(null, rows(10), { columns }));
  reader.close();
  assert.throws(() => reader.verify(), JazminValidationError);
});
