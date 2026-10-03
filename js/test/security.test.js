// Fixes from the internal security review (TASKS S-4, docs/SECURITY-REVIEW.md section 7).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFormatError, JazminKey, JazminValidationError, open, update, write } from '../src/index.js';

const columns = [{ name: 'id', type: 'int' }, { name: 'branch', type: 'string' }];
const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, branch: i < 5 ? 'A' : 'B' }));

test('a password file asking for too few or too many iterations is refused before deriving the key', () => {
  const buf = write(null, rows, { columns, password: 'pw', kdfIterations: 1000 });
  for (const iterations of [0, 999, 10_000_001, 0xffffffff]) {
    const changed = Buffer.from(buf);
    changed.writeUInt32LE(iterations, 56); // preamble: kdf_iterations
    assert.throws(() => open(changed, { password: 'pw' }), (e) => e instanceof JazminFormatError && /password iterations/.test(e.message));
  }
  assert.throws(() => write(null, rows, { columns, password: 'pw', kdfIterations: 10_000_001 }), JazminValidationError);
});

test('the signature and key-slot sections must be stored uncompressed and unencrypted', () => {
  const owner = JazminKey.generate();
  const buf = write(null, rows, { columns, key: owner, access: { partitionBy: 'branch', grants: [] } });
  const trailer = buf.subarray(buf.length - 44);
  const changed = (at) => {
    const copy = Buffer.from(buf);
    copy[at] = 2; // codec: brotli
    return copy;
  };
  assert.throws(() => open(changed(Number(trailer.readBigUInt64LE(24))), { key: owner }), /'signature' must be stored as is/);
  assert.throws(() => open(changed(Number(trailer.readBigUInt64LE(12))), { key: owner }), JazminFormatError); // the key-slot list is signed
});

test('a rewrite keeps the file permissions', { skip: process.platform === 'win32' && 'POSIX permissions' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-security-')), 'p.jzm');
  write(file, rows, { columns });
  fs.chmodSync(file, 0o600);
  update(file, { insert: [{ id: 10, branch: 'C' }] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
