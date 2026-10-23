import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminAccessExpiredError, JazminKey, JazminKeyError, JazminReaderCache, JazminValidationError,
  append, compact, open, openAsync, revokeAccess, update, write,
} from '../src/index.js';
import { DERIVED_KEY } from '../src/reader.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-refresh-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'section', type: 'string' },
];
const row = (id) => ({ id, section: id % 2 ? 'A' : 'B' });
const rows = (from, count) => Array.from({ length: count }, (_, i) => row(from + i));
const ids = (reader) => [...reader.rows()].map((r) => r.id);
const closed = (reader) => assert.throws(() => reader.changed(), /closed/);

test('changed() is false and refresh() returns the same reader while the file is unchanged', () => {
  const file = tmp('same.jzm');
  write(file, rows(0, 5), { columns });
  const r = open(file);
  assert.equal(r.changed(), false);
  assert.equal(r.refresh(), r);
  assert.deepEqual(ids(r), [0, 1, 2, 3, 4]);
  r.close();
});

test('after an append, refresh() opens the new version; the old reader keeps its version until closed', () => {
  const file = tmp('append.jzm');
  const key = JazminKey.generate();
  write(file, rows(0, 5), { columns, key });
  const old = open(file, { key });
  append(file, { key, insert: rows(5, 2) });
  assert.equal(old.changed(), true);
  const fresh = old.refresh();
  assert.notEqual(fresh, old);
  assert.equal(fresh.appendCount, 1);
  assert.deepEqual(ids(fresh), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(fresh.changed(), false);
  assert.deepEqual(ids(old), [0, 1, 2, 3, 4], 'the old reader still reads the version it opened');
  old.close();
  assert.deepEqual([...fresh.find({ id: 6 })].map((r) => r.id), [6]);
  fresh.close();
});

test('after update() or compact() replaces the file, changed() is true and refresh() reads the new file', () => {
  const file = tmp('replace.jzm');
  write(file, rows(0, 4), { columns });
  const first = open(file);
  update(file, { insert: rows(4, 1) });
  assert.equal(first.changed(), true);
  const second = first.refresh();
  assert.notEqual(second.fileId, first.fileId);
  assert.deepEqual(ids(second), [0, 1, 2, 3, 4]);
  assert.deepEqual(ids(first), [0, 1, 2, 3], 'the replaced file stays readable through the old reader');
  first.close();

  append(file, { insert: rows(5, 1) });
  compact(file);
  assert.equal(second.changed(), true);
  const third = second.refresh();
  assert.deepEqual(ids(third), [0, 1, 2, 3, 4, 5]);
  assert.equal(third.appendCount, 0);
  second.close();
  third.close();
});

test('an interrupted append (bytes after the last trailer) is not a change', () => {
  const file = tmp('crash.jzm');
  write(file, rows(0, 3), { columns });
  append(file, { insert: rows(3, 1) });
  const r = open(file);
  fs.appendFileSync(file, Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(300, 7), Buffer.from('JZMN')]));
  assert.equal(r.changed(), false);
  assert.equal(r.refresh(), r);
  append(file, { insert: rows(4, 1) }); // the next append replaces the leftover bytes
  assert.equal(r.changed(), true);
  const fresh = r.refresh();
  assert.deepEqual(ids(fresh), [0, 1, 2, 3, 4]);
  r.close();
  fresh.close();
});

test('a reader opened from bytes refuses changed() and refresh()', () => {
  const bytes = write(null, rows(0, 2), { columns });
  const r = open(bytes);
  assert.throws(() => r.changed(), JazminValidationError);
  assert.throws(() => r.refresh(), JazminValidationError);
  r.close();
});

test('openAsync readers know their path; openTable readers refresh to the same table', async () => {
  const file = tmp('async.jzm');
  write(file, rows(0, 2), { columns });
  const r = await openAsync(file);
  assert.equal(r.changed(), false);
  append(file, { insert: rows(2, 1) });
  assert.equal(r.changed(), true);
  const fresh = r.refresh();
  assert.deepEqual(ids(fresh), [0, 1, 2]);
  r.close();
  fresh.close();

  const multi = tmp('tables.jzm');
  write(multi, { a: rows(0, 2), b: rows(10, 2) }, { tables: [{ name: 'a', columns }, { name: 'b', columns }] });
  const a = open(multi);
  const b = a.openTable('b');
  append(multi, { table: 'b', insert: rows(12, 1) });
  const b2 = b.refresh();
  assert.equal(b2.table, 'b');
  assert.deepEqual(ids(b2), [10, 11, 12]);
  a.close();
  b.close();
  b2.close();
});

test('a closed reader refuses changed() and refresh()', () => {
  const file = tmp('closed.jzm');
  write(file, rows(0, 1), { columns });
  const r = open(file);
  r.close();
  closed(r);
  assert.throws(() => r.refresh(), /closed/);
});

test('a password file refreshed after an append reuses the derived key (no second PBKDF2)', () => {
  const file = tmp('password.jzm');
  write(file, rows(0, 2), { columns, password: 'correct horse', kdfIterations: 1000 });
  const r = open(file, { password: 'correct horse' });
  append(file, { password: 'correct horse', insert: rows(2, 1) });
  const fresh = r.refresh();
  assert.ok(r[DERIVED_KEY], 'the reader keeps the key derived from the password');
  assert.equal(fresh[DERIVED_KEY], r[DERIVED_KEY], 'the same derived key, not derived again');
  assert.deepEqual(ids(fresh), [0, 1, 2]);
  r.close();
  assert.equal(r[DERIVED_KEY], null, 'close() lets go of it');
  fresh.close();

  // A new version with a new salt (update) derives again.
  const r2 = open(file, { password: 'correct horse' });
  update(file, { password: 'correct horse', insert: rows(3, 1) });
  const r3 = r2.refresh();
  assert.notEqual(r3[DERIVED_KEY], r2[DERIVED_KEY]);
  assert.deepEqual(ids(r3), [0, 1, 2, 3]);
  r2.close();
  r3.close();
});

test('a refresh that fails (key revoked) throws as open() would and leaves the old reader working', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('revoked.jzm');
  write(file, rows(0, 3), { columns, key: owner, access: { partitionBy: 'section', grants: [{ key: bob, rows: '*' }] } });
  const r = open(file, { key: bob });
  revokeAccess(file, owner, bob);
  assert.equal(r.changed(), true);
  assert.throws(() => r.refresh(), JazminKeyError);
  assert.deepEqual(ids(r).sort(), [0, 1, 2], 'the old reader is untouched');
  r.close();
});

test('a refresh after the key expired fails as open() would; the old reader keeps working', async () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('expiring.jzm');
  const expires = Date.now() + 1500; // the system clock: refresh() opens with the options the reader was given
  write(file, rows(0, 2), { columns, key: owner, access: { partitionBy: 'section', grants: [{ key: bob, rows: '*', expires }] } });
  const r = open(file, { key: bob, accessState: false });
  append(file, { key: owner, insert: rows(2, 1) }); // the grant is kept, with its expiry
  await new Promise((resolve) => setTimeout(resolve, expires - Date.now() + 50));
  assert.throws(() => r.refresh(), JazminAccessExpiredError);
  assert.equal(ids(r).length, 2);
  r.close();
});

// ---- JazminReaderCache --------------------------------------------------------------------------------------------

test('the cache keeps readers open: the same reader is leased again while the file is unchanged', () => {
  const file = tmp('cache.jzm');
  const key = JazminKey.generate();
  write(file, rows(0, 3), { columns, key });
  const cache = new JazminReaderCache({ max: 10 });
  const lease = cache.open(file, { key });
  const reader = lease.reader;
  assert.deepEqual(ids(reader), [0, 1, 2]);
  lease.release();
  lease.release(); // twice is harmless
  const again = cache.open(file, { key });
  assert.equal(again.reader, reader);
  again[Symbol.dispose](); // what `using` calls
  assert.equal(cache.size, 1);
  cache.close();
  closed(reader);
});

test('the cache replaces an idle reader whose file changed, and closes the old one', () => {
  const file = tmp('cache-change.jzm');
  write(file, rows(0, 2), { columns });
  const cache = new JazminReaderCache({ max: 10 });
  const first = cache.open(file);
  const old = first.reader;
  first.release();
  append(file, { insert: rows(2, 1) });
  const second = cache.open(file);
  assert.notEqual(second.reader, old);
  assert.deepEqual(ids(second.reader), [0, 1, 2]);
  closed(old);
  second.release();
  update(file, { insert: rows(3, 1) });
  const third = cache.open(file);
  assert.deepEqual(ids(third.reader), [0, 1, 2, 3]);
  third.release();
  cache.close();
});

test('a reader in use is never closed or replaced under its user: another request gets a reader of its own', () => {
  const file = tmp('cache-lease.jzm');
  write(file, rows(0, 2), { columns });
  const cache = new JazminReaderCache({ max: 10 });
  const busy = cache.open(file);
  append(file, { insert: rows(2, 1) });
  const other = cache.open(file);
  assert.notEqual(other.reader, busy.reader);
  assert.deepEqual(ids(other.reader), [0, 1, 2], 'a separate reader of the new version');
  assert.deepEqual(ids(busy.reader), [0, 1], 'the leased reader is untouched');
  const separate = other.reader;
  other.release();
  closed(separate); // closed with its lease
  assert.deepEqual(ids(busy.reader), [0, 1]);
  busy.release();
  const next = cache.open(file); // idle now: checked, and replaced by the new version
  assert.deepEqual(ids(next.reader), [0, 1, 2]);
  next.release();
  cache.close();
});

test('the cache closes the least recently used reader first; one in use is closed when its lease is released', () => {
  const files = ['a', 'b', 'c'].map((n) => {
    const file = tmp(`${n}.jzm`);
    write(file, rows(0, 1), { columns });
    return file;
  });
  const cache = new JazminReaderCache({ max: 2 });
  const a = cache.open(files[0]);
  const b = cache.open(files[1]);
  b.release();
  cache.open(files[0]).release(); // a used again: b is now the least recently used
  const c = cache.open(files[2]);
  closed(b.reader);
  assert.equal(cache.size, 2);
  const d = cache.open(files[1]); // b again: a is the least recently used, still leased
  assert.equal(cache.size, 2);
  assert.deepEqual(ids(a.reader), [0], 'evicted while in use: still working');
  a.release();
  closed(a.reader);
  c.release();
  d.release();
  cache.close();
});

test('cache entries are per key: a wrong key never gets a cached reader', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('cache-keys.jzm');
  write(file, rows(0, 4), { columns, key: owner, access: { partitionBy: 'section', grants: [{ key: bob, rows: ['A'] }] } });
  const cache = new JazminReaderCache({ max: 10 });
  cache.open(file, { key: owner }).release();
  const asBob = cache.open(file, { key: bob.export() });
  assert.deepEqual(ids(asBob.reader), [1, 3]);
  assert.equal(cache.size, 2);
  assert.throws(() => cache.open(file, { key: JazminKey.generate() }), JazminKeyError);
  assert.throws(() => cache.open(file), JazminKeyError);
  assert.equal(cache.size, 2);
  asBob.release();
  cache.close();
});

test('the cache checks expiry on each open: an expired key is dropped and refused as open() would', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('cache-expiry.jzm');
  write(file, rows(0, 2), { columns, key: owner, now: T0, access: { partitionBy: 'section', grants: [{ key: bob, rows: '*', expiresIn: '2h' }] } });
  const cache = new JazminReaderCache({ max: 10 });
  const lease = cache.open(file, { key: bob, now: T0 + HOUR, accessState: false });
  const reader = lease.reader;
  lease.release();
  assert.throws(() => cache.open(file, { key: bob, now: T0 + 3 * HOUR, accessState: false }), JazminAccessExpiredError);
  closed(reader);
  assert.equal(cache.size, 0);
  cache.close();
});

test('clear() and close(): idle readers close now, leased ones when released; a closed cache refuses open()', () => {
  const file = tmp('cache-clear.jzm');
  write(file, rows(0, 2), { columns });
  const cache = new JazminReaderCache({ max: 10 });
  const idle = cache.open(file);
  idle.release();
  cache.clear();
  closed(idle.reader);
  assert.equal(cache.size, 0);
  const held = cache.open(file);
  cache.close();
  assert.deepEqual(ids(held.reader), [0, 1]);
  held.release();
  closed(held.reader);
  assert.throws(() => cache.open(file), JazminValidationError);
  assert.throws(() => new JazminReaderCache({ max: 0 }), JazminValidationError);
});

test('a file that is gone counts as changed (after a short wait for a replace); refresh() throws as open() would', () => {
  const file = tmp('gone.jzm');
  write(file, rows(0, 2), { columns });
  const r = open(file);
  fs.renameSync(file, `${file}.moved`);
  const start = Date.now();
  assert.equal(r.changed(), true);
  assert.ok(Date.now() - start >= 90, 'a missing path is tried again for about 100 ms');
  assert.throws(() => r.refresh(), { code: 'ENOENT' });
  assert.deepEqual(ids(r), [0, 1]);
  fs.renameSync(`${file}.moved`, file);
  assert.equal(r.changed(), false, 'the same file back in place');
  r.close();
});

test('a file replaced at once by another of the same size is a change', () => {
  const file = tmp('same-size.jzm');
  const other = `${file}.new`;
  write(file, rows(0, 3), { columns });
  write(other, rows(10, 3), { columns });
  assert.equal(fs.statSync(other).size, fs.statSync(file).size);
  const { atime, mtime } = fs.statSync(file);
  fs.utimesSync(other, atime, mtime); // same times too, as a file system with a coarse clock (FAT: 2 s) can give them
  const r = open(file);
  fs.renameSync(file, `${file}.old`); // as update() replaces a file that is open (on Windows)
  fs.renameSync(other, file);
  assert.equal(r.changed(), true);
  const fresh = r.refresh();
  assert.deepEqual(ids(fresh), [10, 11, 12]);
  r.close();
  fresh.close();
});

test('a cached reader whose refresh fails (key revoked) is dropped and closed; open() throws as open() would', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const file = tmp('cache-revoked.jzm');
  write(file, rows(0, 2), { columns, key: owner, access: { partitionBy: 'section', grants: [{ key: bob, rows: '*' }] } });
  const cache = new JazminReaderCache({ max: 10 });
  const lease = cache.open(file, { key: bob });
  const reader = lease.reader;
  lease.release();
  revokeAccess(file, owner, bob);
  assert.throws(() => cache.open(file, { key: bob }), JazminKeyError);
  assert.equal(cache.size, 0);
  closed(reader);
  cache.close();
});
