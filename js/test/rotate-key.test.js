// Key rotation (TASKS S-2): a file encrypted with a key or password, encrypted again under a new one without decoding
// its rows. Everything readable before is readable after, with the new key or password only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminKeyError, JazminValidationError, JazminWriter, append, open, rotateKey, write } from '../src/index.js';
import { fixtureFiles, FIXTURE_PACKAGE } from './fixture-helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-rotate-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const clientColumns = [
  { name: 'clientId', type: 'string', nullable: false },
  { name: 'name', type: 'string', index: ['sorted', 'trigram'] },
  { name: 'since', type: 'datetime', index: 'sorted' },
];
const transactionColumns = [
  { name: 'clientId', type: 'string', nullable: false },
  { name: 'line', type: 'int', nullable: false, index: 'sorted' },
  { name: 'amount', type: 'decimal' },
  { name: 'memo', type: 'string', index: 'trigram' },
];
const clients = Array.from({ length: 300 }, (_, i) => ({
  clientId: `C${String(i).padStart(4, '0')}`, name: i % 9 ? `Client ${i} ${['Ltd', 'Inc', 'Trust'][i % 3]}` : null, since: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000),
}));
const transactions = clients.flatMap((c, k) => Array.from({ length: 12 }, (_, i) => ({
  clientId: c.clientId, line: k * 12 + i, amount: `${(k * 7 + i) % 500}.${String(i * 3).padStart(2, '0')}`, memo: i % 4 ? `Payment ${i} for ${c.clientId}` : null,
})));

/** Writes the two-table file: chunks of 20 rows, sorted and trigram indexes, embedded files and package settings. */
function writeFile(file, credentials, extra = {}) {
  const writer = new JazminWriter(file, {
    tables: [
      { name: 'clients', columns: clientColumns, sortedBy: ['clientId'] },
      { name: 'transactions', columns: transactionColumns, sortedBy: ['clientId', 'line'], chunkRows: 20 },
    ],
    metadata: { title: 'Rotation', version: 3 },
    files: fixtureFiles(),
    package: FIXTURE_PACKAGE,
    chunkRows: 20,
    ...credentials,
    ...extra,
  });
  writer.writeRows(clients);
  writer.startTable('transactions');
  writer.writeRows(transactions);
  writer.finish();
}

/** Everything a key holder can read: tables, rows, index lookups, embedded files, metadata and package settings. */
function snapshot(file, credentials) {
  const r = open(file, credentials);
  const t = open(file, { ...credentials, table: 'transactions' });
  try {
    return {
      tables: r.tables,
      metadata: r.metadata,
      package: r.package,
      files: r.files.map((f) => {
        const whole = r.readFile(f.path);
        return [f.path, whole.toString('base64'), r.readFileRange(f.path, Math.min(10, whole.length), Math.min(2000, whole.length)).toString('base64')];
      }),
      clients: [...r.rows()],
      clientIndexes: r.indexes,
      byName: [...r.find({ name: { startsWith: 'Client 2' } })],
      nameContains: [...r.find({ name: { icontains: 'TRUST' } })],
      since: [...r.find({ since: { gte: new Date(Date.UTC(2020, 5, 1)), lt: new Date(Date.UTC(2020, 6, 1)) } })],
      nulls: [...r.find({ name: null })],
      transactions: [...t.rows()],
      lines: [...t.find({ line: { in: [5, 77, 2999, 3599] } })],
      memo: [...t.find({ memo: { contains: 'for C01' } })],
      client: [...t.find({ clientId: 'C0123' })],
    };
  } finally {
    r.close();
    t.close();
  }
}

test('a file under a new key reads as before, with the new key only', () => {
  const file = path.join(dir, 'key.jzm');
  const key = JazminKey.generate();
  writeFile(file, { key });
  const before = snapshot(file, { key });
  const size = fs.statSync(file).size;

  const newKey = JazminKey.generate();
  const result = rotateKey(file, { key, newKey });
  assert.ok(result.sections > 100);
  assert.deepEqual(snapshot(file, { key: newKey }), before);
  assert.throws(() => open(file, { key }), JazminKeyError);
  // Sections keep their lengths: only the header (new keyring, compressed again) may differ by a few bytes.
  assert.ok(Math.abs(fs.statSync(file).size - size) < 64, `${fs.statSync(file).size} vs ${size}`);
});

test('keys and passwords change places, with compact indexes too', () => {
  const file = path.join(dir, 'password.jzm');
  const password = 'correct horse battery staple';
  writeFile(file, { password, kdfIterations: 1000 }, { compactIndexes: true });
  const before = snapshot(file, { password });

  const key = JazminKey.generate();
  rotateKey(file, { password, newKey: key.toString() });
  assert.deepEqual(snapshot(file, { key }), before);
  assert.throws(() => open(file, { password }), JazminKeyError);

  rotateKey(file, { key, newPassword: 'another one', kdfIterations: 2000 });
  assert.deepEqual(snapshot(file, { password: 'another one' }), before);
  assert.throws(() => open(file, { key }), JazminKeyError);
  assert.equal(open(file, { password: 'another one' }).kdfIterations, 2000);
});

test('a file with appends is compacted first: its earlier versions, under the old key, are not kept', () => {
  const file = path.join(dir, 'appended.jzm');
  const key = JazminKey.generate();
  writeFile(file, { key });
  append(file, { key, table: 'transactions', insert: [{ clientId: 'C9999', line: 99_999, amount: '1.00', memo: 'late' }], delete: { line: { lt: 30 } } });
  append(file, { key, addFiles: [{ path: 'late.txt', content: 'added later' }] });
  const before = snapshot(file, { key });
  const oldBytes = fs.readFileSync(file);

  const newKey = JazminKey.generate();
  rotateKey(file, { key, newKey });
  assert.deepEqual(snapshot(file, { key: newKey }), before);
  assert.throws(() => open(file, { key }), JazminKeyError);
  assert.ok(fs.statSync(file).size < oldBytes.length); // the earlier versions are gone
});

test('rotation refuses what it cannot do, and leaves the file as it was', () => {
  const plain = path.join(dir, 'plain.jzm');
  write(plain, [{ n: 1 }]);
  assert.throws(() => rotateKey(plain, { newKey: JazminKey.generate() }), /not encrypted/);

  const file = path.join(dir, 'kept.jzm');
  const key = JazminKey.generate();
  write(file, [{ n: 1 }], { key });
  const bytes = fs.readFileSync(file);
  assert.throws(() => rotateKey(file, { key }), JazminValidationError); // no new key
  assert.throws(() => rotateKey(file, { key, newKey: JazminKey.generate(), newPassword: 'x' }), JazminValidationError);
  assert.throws(() => rotateKey(file, { key: JazminKey.generate(), newKey: JazminKey.generate() }), JazminKeyError); // wrong key
  assert.throws(() => rotateKey(file, { key, newPassword: 'x', kdfIterations: 10 }), /kdfIterations/);
  assert.ok(fs.readFileSync(file).equals(bytes));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

  const owner = JazminKey.generate();
  const shared = path.join(dir, 'shared.jzm');
  write(shared, [{ region: 'ZA', n: 1 }], { key: owner, access: { partitionBy: 'region', grants: [] } });
  assert.throws(() => rotateKey(shared, { key: owner, newKey: JazminKey.generate() }), /key or password/);
});
