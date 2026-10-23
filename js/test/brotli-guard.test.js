// Brotli and CVE-2026-111497: Node.js releases before 22.23.4, 24.22.1 and 26.12.1 (and every 23.x, 25.x and 20.x or
// older) have an out-of-bounds write in their Brotli decoder. A file from someone else can hold Brotli sections built to
// reach it, so on those releases the library refuses to decompress Brotli, and change files and submissions, which
// untrusted people write and JAZMIN never writes with Brotli, are refused if they use it, whatever the release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminError, JazminFormatError, JazminKey, JazminValidationError, applyChanges, fileSubmission, open, write, writeChanges } from '../src/index.js';
import { checkBrotliDecoder } from '../src/section.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-brotli-'));

test('the Brotli decoder is refused on Node.js releases without the CVE-2026-111497 fix, unless the fix is declared backported', () => {
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '27.0.0', '28.1.0']) {
    assert.doesNotThrow(() => checkBrotliDecoder(version, {}), version);
  }
  for (const version of ['22.23.3', '22.0.0', '24.22.0', '24.0.0', '26.12.0', '23.11.1', '25.9.0', '20.19.5', '18.20.4']) {
    assert.throws(() => checkBrotliDecoder(version, {}), (error) => error instanceof JazminValidationError
      && /CVE-2026-111497/.test(error.message) && /22\.23\.4, 24\.22\.1 or 26\.12\.1/.test(error.message) && error.message.includes(version), version);
  }
  // A build with the fix backported (some Linux distributions keep the version number): the owner says so.
  assert.doesNotThrow(() => checkBrotliDecoder('22.11.0', { JAZMIN_ALLOW_BROTLI: '1' }));
  assert.throws(() => checkBrotliDecoder('22.11.0', { JAZMIN_ALLOW_BROTLI: 'yes' }), JazminValidationError);
});

test('a file written with Brotli reads as before on a release with the fix (this one)', () => {
  checkBrotliDecoder(); // the release running these tests has the fix
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, note: `note ${i % 7}` }));
  const reader = open(write(null, rows, { codec: 'brotli' }));
  try {
    assert.deepEqual([...reader.rows()], rows);
  } finally {
    reader.close();
  }
});

const columns = [{ name: 'claim', type: 'string', nullable: false }, { name: 'status', type: 'string' }];
const doc = { path: 'index.html', content: '<p>claims</p>' };

/** The same file written again with Brotli: its rows, columns and metadata as they are. */
function withBrotli(file, options) {
  const reader = open(file, options);
  try {
    return write(null, [...reader.rows()], { columns: reader.columns, metadata: reader.metadata, codec: 'brotli', ...options });
  } finally {
    reader.close();
  }
}

test('applyChanges refuses a change file with Brotli sections, before decompressing any', () => {
  const file = path.join(tmp(), 'claims.jzm');
  const key = JazminKey.generate();
  write(file, [{ claim: 'C-1', status: 'open' }], { columns, key, files: [doc], package: { entry: 'index.html', edit: { key: ['claim'], columns: ['status'] } } });
  const source = open(file, { key });
  const change = writeChanges(source, { update: [{ claim: 'C-1', status: 'paid' }] }, { key });
  source.close();
  const brotli = withBrotli(change, { key });
  assert.throws(() => applyChanges(file, brotli, { key, dryRun: true }), (error) => error instanceof JazminFormatError && /Brotli/.test(error.message));
  assert.equal(applyChanges(file, change, { key }).updated, 1); // the change file as JAZMIN writes it (deflate)
});

test('fileSubmission refuses a batch with Brotli sections', () => {
  const dir = tmp();
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const visits = [{ name: 'id', type: 'string', nullable: false }, { name: 'person', type: 'string' }, { name: 'note', type: 'string' }];
  const shared = path.join(dir, 'shared.jzm');
  write(shared, [{ id: 'seed', person: 'P1', note: 'first' }], {
    columns: visits, key: owner, access: { partitionBy: 'person', grants: [{ key: bob, rows: ['P1'], columns: '*' }] },
  });
  // Enough rows that compressing pays: a section that doesn't get smaller is stored as is, whatever the codec.
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, person: 'P1', note: 'a visit to the site, all well '.repeat(4) }));
  const batch = (codec) => write(null, rows, { columns: visits, key: owner.submissionKey(bob.id), codec });
  const brotli = batch('brotli');
  assert.ok(brotli.includes(Buffer.from([2, 1, 0, 0])), 'the batch has a Brotli section (codec 2, encrypted)');
  assert.throws(() => fileSubmission(shared, brotli, { key: owner, keyId: bob.id, dryRun: true }), (error) => error instanceof JazminError && /Brotli/.test(error.message));
  assert.equal(fileSubmission(shared, batch('deflate'), { key: owner, keyId: bob.id }).filed, 200);
});
