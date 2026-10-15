import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFileLockedError, JazminKey, JazminKeyError, append, compact, issueFileUnlockToken, open, update, write } from '../src/index.js';
import { crc32 } from '../src/binary.js';
import { decodeHeader, encodeHeader } from '../src/catalog.js';
import { MAGIC, TRAILER_SIZE } from '../src/constants.js';
import { decodeSection, encodeSection } from '../src/section.js';

// Locked stored files (spec 6.8.1): a password, an unlock token from the owner's key service, or both.

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-locks-'));
const columns = [{ name: 'id', type: 'int' }, { name: 'group', type: 'string' }];
const rows = ['A', 'B'].flatMap((g, k) => Array.from({ length: 10 }, (_, i) => ({ id: k * 100 + i, group: g })));
const contract = crypto.randomBytes(300 * 1024); // two blocks
const ITERATIONS = 1000; // the lowest allowed: tests stay quick

function locked() {
  const owner = JazminKey.generate();
  const keys = { a: owner.createAccessKey(), b: owner.createAccessKey() };
  const file = path.join(tmpDir(), 'claim.jzm');
  write(file, rows, {
    columns, key: owner, sortedBy: ['group', 'id'],
    access: { partitionBy: 'group', grants: [{ key: keys.a, rows: ['A'] }, { key: keys.b, rows: '*' }] },
    files: [
      { path: 'contract.pdf', content: contract, groups: ['A', 'B'], lock: 'contracts' },
      { path: 'terms.pdf', content: 'terms', groups: ['A', 'B'], lock: 'contracts' },
      { path: 'scan.png', content: 'medical scan', groups: ['B'], lock: 'medical' },
      { path: 'both.txt', content: 'both kinds', groups: ['A'], lock: 'vault' },
      { path: 'readme.txt', content: 'open to all', groups: ['A', 'B'] },
    ],
    locks: {
      contracts: { password: 'correct horse', iterations: ITERATIONS },
      medical: { online: true },
      vault: { password: 'vault pass', online: true, iterations: ITERATIONS },
    },
  });
  return { owner, keys, file };
}

const asKey = (file, key) => open(fs.readFileSync(file), { key: key.toString(), accessState: false });

test('a locked file is listed with its lock, and opens only after unlocking', () => {
  const { keys, file, owner } = locked();
  const r = asKey(file, keys.a);
  assert.deepEqual(r.files.map((f) => [f.path, f.lock]).sort(), [
    ['both.txt', { id: 'vault', kind: 'both', unlocked: false }],
    ['contract.pdf', { id: 'contracts', kind: 'password', unlocked: false }],
    ['readme.txt', undefined],
    ['terms.pdf', { id: 'contracts', kind: 'password', unlocked: false }],
  ]);
  assert.deepEqual(r.locks, [{ id: 'contracts', kind: 'password', unlocked: false }, { id: 'vault', kind: 'both', unlocked: false }], 'a sees group A only: not the medical lock');
  assert.equal(r.readFile('readme.txt').toString(), 'open to all');
  assert.throws(() => r.readFile('contract.pdf'), (e) => {
    assert.ok(e instanceof JazminFileLockedError && e instanceof JazminKeyError);
    assert.match(e.message, /File 'contract.pdf' is locked \(lock 'contracts'\): unlock it with its password/);
    assert.deepEqual([e.path, e.lock, e.kind], ['contract.pdf', 'contracts', 'password']);
    return true;
  });
  assert.throws(() => r.readFileRange('terms.pdf', 0, 2), JazminFileLockedError);
  assert.throws(() => r.openFile('terms.pdf'), JazminFileLockedError);

  assert.throws(() => r.unlock('contracts', { password: 'wrong' }), /Wrong password for lock 'contracts'/);
  assert.throws(() => r.unlock('nope', { password: 'x' }), /No lock 'nope' is visible with this key/);
  assert.throws(() => r.unlock('contracts', {}), /Lock 'contracts' needs its password/);
  r.unlock('contracts', { password: 'correct horse' });
  assert.ok(r.readFile('contract.pdf').equals(contract));
  assert.equal(r.readFile('terms.pdf').toString(), 'terms', 'one unlock opens every file of the lock');
  assert.deepEqual(r.files.find((f) => f.path === 'terms.pdf').lock, { id: 'contracts', kind: 'password', unlocked: true });
  assert.throws(() => r.readFile('both.txt'), /unlock it with its password and an unlock token from the file owner's key service/);

  // Both: the password and the token, each wrong one refused.
  const token = issueFileUnlockToken(file, owner, 'vault');
  assert.match(token, /^jzf1-/);
  assert.throws(() => r.unlock('vault', { password: 'vault pass' }), /Lock 'vault' needs its password and an unlock token/);
  assert.throws(() => r.unlock('vault', { password: 'nope', unlockToken: token }), /Wrong password or unlock token for lock 'vault'/);
  assert.throws(() => r.unlock('vault', { password: 'vault pass', unlockToken: issueFileUnlockToken(file, owner, 'medical') }), /Wrong password or unlock token/);
  r.unlock('vault', { password: 'vault pass', unlockToken: token });
  assert.equal(r.readFile('both.txt').toString(), 'both kinds');
  r.close();
});

test('an online lock opens with the unlock token the key service issues; the owner opens every lock', () => {
  const { keys, file, owner } = locked();
  const r = asKey(file, keys.b);
  assert.deepEqual(r.locks.map((l) => l.id), ['contracts', 'medical', 'vault'], 'b sees every group');
  assert.throws(() => r.readFile('scan.png'), /unlock it with an unlock token from the file owner's key service/);
  assert.throws(() => r.unlock('medical', { password: 'x' }), /Lock 'medical' needs an unlock token/);
  assert.throws(() => r.unlock('medical', { unlockToken: 'jzf1-AAAA' }), /Unlock token has the wrong length/);
  assert.throws(() => r.unlock('medical', { unlockToken: issueFileUnlockToken(file, owner, 'vault') }), /Wrong unlock token for lock 'medical'/);
  r.unlock('medical', { unlockToken: issueFileUnlockToken(file, owner, 'medical') });
  assert.equal(r.readFile('scan.png').toString(), 'medical scan');
  r.close();

  assert.throws(() => issueFileUnlockToken(file, owner, 'contracts'), /Lock 'contracts' is a password lock: it has no unlock token/);
  assert.throws(() => issueFileUnlockToken(file, owner, 'nope'), /No lock 'nope' in this file/);
  assert.throws(() => issueFileUnlockToken(file, keys.a, 'medical'), /need the owner key/);

  const o = open(file, { key: owner });
  assert.deepEqual(o.locks.map((l) => [l.id, l.unlocked]), [['contracts', true], ['medical', true], ['vault', true]]);
  assert.ok(o.readFile('contract.pdf').equals(contract));
  assert.equal(o.readFile('scan.png').toString(), 'medical scan');
  assert.equal(o.readFile('both.txt').toString(), 'both kinds');
  assert.deepEqual(o.files.find((f) => f.path === 'scan.png').lock, { id: 'medical', kind: 'online', unlocked: true });
  assert.deepEqual(o.writerFeatures, ['file-locks']);
  assert.deepEqual(o.readerFeatures, [], 'no reader feature: older readers still read the file');
  o.close();
});

test('the same bytes stored unlocked and locked are two contents', () => {
  // The same bytes stored unlocked and locked are two contents: the unlocked one's key must not open the locked one.
  const owner = JazminKey.generate();
  const a = owner.createAccessKey();
  const twice = path.join(tmpDir(), 'twice.jzm');
  write(twice, rows, {
    columns, key: owner, access: { partitionBy: 'group', grants: [{ key: a, rows: '*' }] },
    files: [{ path: 'open.bin', content: contract, groups: ['A'] }, { path: 'locked.bin', content: contract, groups: ['A'], lock: 'l' }],
    locks: { l: { password: 'pw', iterations: ITERATIONS } },
  });
  const t = asKey(twice, a);
  assert.ok(t.readFile('open.bin').equals(contract));
  assert.throws(() => t.readFile('locked.bin'), JazminFileLockedError);
  t.close();
});

test('locks are refused outside access-controlled files, and checked', () => {
  const owner = JazminKey.generate();
  const lock = { l: { password: 'pw', iterations: ITERATIONS } };
  assert.throws(() => write(null, rows, { columns, key: owner, files: [{ path: 'a', content: 'x', lock: 'l' }], locks: lock }),
    /Locks need an access-controlled file \(spec 6\.8\.1\): with one key or password, that key would open every lock/);
  assert.throws(() => write(null, rows, { columns, password: 'pw', locks: lock }), /Locks need an access-controlled file/);
  const access = { partitionBy: 'group', grants: [{ key: owner.createAccessKey(), rows: '*' }] };
  const base = { columns, key: owner, access };
  assert.throws(() => write(null, rows, { ...base, files: [{ path: 'a', content: 'x', groups: ['A'], lock: 'm' }], locks: lock }), /File 'a': no lock 'm' \(locks: l\)/);
  assert.throws(() => write(null, rows, { ...base, locks: { l: {} } }), /Lock 'l': give a password, online: true, or both/);
  assert.throws(() => write(null, rows, { ...base, locks: { l: { password: '' } } }), /Lock 'l': the password must be a non-empty string/);
  assert.throws(() => write(null, rows, { ...base, locks: { l: { password: 'x', iterations: 10 } } }), /Lock 'l': iterations must be from 1000 to 10000000/);
  assert.throws(() => write(null, rows, { ...base, locks: { l: { online: 'yes' } } }), /Lock 'l': online must be true or false/);
  assert.throws(() => write(null, rows, { ...base, locks: { l: { password: 'x', colour: 'red' } } }), /Lock 'l': unknown option 'colour'/);
  assert.throws(() => write(null, rows, { ...base, locks: { ['x'.repeat(65)]: { online: true } } }), /A lock id is 1 to 64 characters/);
  assert.throws(() => write(null, rows, { ...base, locks: [] }), /locks must be an object of locks by id/);
});

test('rewrites and appends keep the locks; a lock can change its password, become online, or be removed', () => {
  const { keys, file, owner } = locked();
  const token = issueFileUnlockToken(file, owner, 'medical');
  const check = (when, password = 'correct horse') => {
    const r = asKey(file, keys.a);
    assert.throws(() => r.readFile('contract.pdf'), JazminFileLockedError, when);
    r.unlock('contracts', { password });
    assert.ok(r.readFile('contract.pdf').equals(contract), when);
    r.close();
    const b = asKey(file, keys.b);
    b.unlock('medical', { unlockToken: token }); // the same token across versions: the lock keeps its secret
    assert.equal(b.readFile('scan.png').toString(), 'medical scan', when);
    b.close();
  };
  check('written');
  compact(file, { key: owner });
  check('compacted');
  update(file, { key: owner, addFiles: [{ path: 'new.txt', content: 'new', groups: ['A'], lock: 'contracts' }] });
  check('updated');
  append(file, { key: owner, insert: [{ id: 500, group: 'B' }], addFiles: [{ path: 'more.txt', content: 'more', groups: ['A'], lock: 'contracts' }] });
  check('appended');
  const r = asKey(file, keys.a);
  r.unlock('contracts', { password: 'correct horse' });
  assert.equal(r.readFile('more.txt').toString(), 'more');
  assert.equal(r.readFile('new.txt').toString(), 'new');
  r.close();

  // A new password: the old one stops working, the files stay.
  append(file, { key: owner, locks: { contracts: { password: 'new pass', iterations: ITERATIONS } } });
  const changed = asKey(file, keys.a);
  assert.throws(() => changed.unlock('contracts', { password: 'correct horse' }), /Wrong password/);
  changed.unlock('contracts', { password: 'new pass' });
  assert.ok(changed.readFile('contract.pdf').equals(contract));
  changed.close();
  check('password changed by an append', 'new pass');
  update(file, { key: owner, locks: { contracts: { password: 'third', iterations: ITERATIONS } } });
  check('password changed by an update', 'third');

  // A password as well: the online lock becomes both kinds and keeps its secret, so the token issued before still works.
  update(file, { key: owner, locks: { medical: { password: 'med', online: true, iterations: ITERATIONS } } });
  const both = asKey(file, keys.b);
  assert.equal(both.locks.find((l) => l.id === 'medical').kind, 'both');
  assert.throws(() => both.unlock('medical', { password: 'nope', unlockToken: token }), /Wrong password or unlock token/);
  both.unlock('medical', { password: 'med', unlockToken: token });
  assert.equal(both.readFile('scan.png').toString(), 'medical scan');
  both.close();

  // Removed: its files stay, unlocked.
  update(file, { key: owner, locks: { contracts: null } });
  const open1 = asKey(file, keys.a);
  assert.equal(open1.files.find((f) => f.path === 'contract.pdf').lock, undefined);
  assert.ok(open1.readFile('contract.pdf').equals(contract));
  assert.deepEqual(open1.locks.map((l) => l.id), ['vault']);
  open1.close();
  append(file, { key: owner, locks: { vault: null, medical: null } });
  const open2 = open(file, { key: owner });
  assert.deepEqual(open2.locks, []);
  assert.deepEqual(open2.writerFeatures, [], 'no lock left: no writer feature');
  assert.equal(open2.readFile('both.txt').toString(), 'both kinds');
  open2.close();
  assert.throws(() => update(file, { key: owner, locks: { gone: null } }), /locks: no lock 'gone' to remove/);
});

test('a writer feature the library does not know stops appends and rewrites, not reads', () => {
  const buf = Buffer.from(write(null, rows, { columns }));
  const trailer = buf.subarray(buf.length - TRAILER_SIZE);
  const headerOffset = Number(trailer.readBigUInt64LE(0));
  const header = decodeHeader(decodeSection(buf.subarray(headerOffset, headerOffset + trailer.readUInt32LE(8)), { sectionId: 'header' }));
  header.writerFeatures = ['future-thing'];
  const section = encodeSection(encodeHeader(header), { sectionId: 'header' });
  const newTrailer = Buffer.alloc(TRAILER_SIZE);
  newTrailer.writeBigUInt64LE(BigInt(headerOffset), 0);
  newTrailer.writeUInt32LE(section.length, 8);
  newTrailer.writeUInt32LE(crc32(newTrailer.subarray(0, 36)), 36);
  MAGIC.copy(newTrailer, 40);
  const file = path.join(tmpDir(), 'future.jzm');
  fs.writeFileSync(file, Buffer.concat([buf.subarray(0, headerOffset), section, newTrailer]));
  const r = open(file);
  assert.equal(r.rowCount, rows.length);
  assert.deepEqual(r.writerFeatures, ['future-thing']);
  r.close();
  const refused = /This file needs the writer feature 'future-thing' to be modified, which this JAZMIN library does not support/;
  assert.throws(() => append(file, { insert: [{ id: 1, group: 'A' }] }), refused);
  assert.throws(() => update(file, { insert: [{ id: 1, group: 'A' }] }), refused);
  assert.throws(() => compact(file), refused);
});
