import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminAccessKey, JazminKey, JazminSubmissionRejectedError, JazminValidationError, SUBMISSION_FILE_TYPES, fileSubmission, open, write,
} from '../src/index.js';

// fileSubmission (USER-GUIDE 15.6): the filing rules as library API. The rules themselves are tested through the
// reference filing service, which calls it (filing-service.test.js); these are the API's own: a dry run, the result,
// the errors, and a batch given by path.

const columns = [
  { name: 'id', type: 'string', nullable: false, index: 'sorted' },
  { name: 'person', type: 'string', nullable: false },
  { name: 'note', type: 'string' },
  { name: 'attachments', type: 'json' },
];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-submissions-'));
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const shared = path.join(dir, 'shared.jzm');
  write(shared, [{ id: 'seed', person: 'P1', note: 'first' }], {
    columns, key: owner, access: { partitionBy: 'person', grants: [{ key: bob, rows: ['P1'], columns: '*', label: 'Bob' }] },
  });
  /** A batch as Bob's phone writes it: locked with his submission key (the owner can make the same key). */
  const batch = (rows, files = []) => {
    const where = path.join(dir, `${bob.id}.${Math.random().toString(36).slice(2)}.jzm`);
    write(where, rows, { columns: columns.map(({ index, ...c }) => c), key: owner.submissionKey(bob.id), files });
    return where;
  };
  return { dir, owner, bob, shared, batch };
}

const ids = (shared, owner) => {
  const reader = open(shared, { key: owner });
  try {
    return [...reader.rows()].map((r) => r.id).sort();
  } finally {
    reader.close();
  }
};

test('fileSubmission: a dry run says what would be filed and writes nothing; then it is filed, from a path or bytes', () => {
  const { owner, bob, shared, batch } = setup();
  const sent = batch([{ id: 'b1', person: 'P2', note: 'visit', attachments: ['photo.png'] }], [{ path: 'photo.png', content: PNG }]);
  const before = fs.readFileSync(shared);
  const dry = fileSubmission(shared, sent, { key: owner, keyId: bob.id, dryRun: true });
  assert.deepEqual(dry, { sender: bob.id, filed: 1, updated: 0, duplicates: 0, files: 1, ignoredColumns: [] });
  assert.ok(fs.readFileSync(shared).equals(before), 'a dry run writes nothing');

  assert.deepEqual(fileSubmission(shared, fs.readFileSync(sent), { key: owner.toString(), keyId: bob.id }), dry);
  assert.deepEqual(ids(shared, owner), ['b1', 'seed']);
  const reader = open(shared, { key: owner });
  const [row] = [...reader.find({ id: 'b1' })];
  reader.close();
  assert.equal(row.person, 'P1', "filed in Bob's partition, whatever the row said");
  assert.deepEqual(row.attachments.map((a) => [a.name, a.type, a.size]), [['photo.png', 'image/png', PNG.length]]);
  // Sent again: nothing new.
  assert.deepEqual(fileSubmission(shared, sent, { key: owner, keyId: bob.id }), { sender: bob.id, filed: 0, updated: 0, duplicates: 1, files: 0, ignoredColumns: [] });
});

test('fileSubmission: a batch that must not be filed is rejected with the reason; mistakes in the call are validation errors', () => {
  const { owner, bob, shared, batch, dir } = setup();
  const sent = batch([{ id: 'b1', person: 'P1', note: 'visit' }]);
  const rejected = (pattern) => (e) => e instanceof JazminSubmissionRejectedError && pattern.test(e.message);
  assert.throws(() => fileSubmission(shared, sent, { key: owner, keyId: 'nonsense' }), rejected(/'nonsense' is not an access key id/));
  assert.throws(() => fileSubmission(shared, sent, { key: owner, keyId: '0123456789abcdef' }), rejected(/has no grant in this file/));
  const forged = path.join(dir, 'forged.jzm');
  write(forged, [{ id: 'x', person: 'P1', note: null, attachments: null }], { columns: columns.map(({ index, ...c }) => c), key: JazminKey.generate() });
  assert.throws(() => fileSubmission(shared, forged, { key: owner, keyId: bob.id }), rejected(/doesn't open with key .*'s submission key/));

  const invalid = (pattern) => (e) => e instanceof JazminValidationError && !(e instanceof JazminSubmissionRejectedError) && pattern.test(e.message);
  assert.throws(() => fileSubmission(shared, sent, { keyId: bob.id }), invalid(/needs the shared file's owner key/));
  assert.throws(() => fileSubmission(shared, sent, { key: owner, keyId: bob.id, fileTypes: ['text/plain'] }), invalid(/Unknown file type 'text\/plain'/));
  assert.throws(() => fileSubmission(shared, sent, { key: owner, keyId: bob.id, onDuplicate: 'merge' }), invalid(/onDuplicate must be/));
  assert.throws(() => fileSubmission(shared, sent, { key: bob, keyId: bob.id }), invalid(/owner key, not an access key/));
  const plain = path.join(dir, 'plain.jzm');
  const key = JazminKey.generate();
  write(plain, [{ id: 'a', person: 'P1', note: null, attachments: null }], { columns, key });
  assert.throws(() => fileSubmission(plain, sent, { key, keyId: bob.id }), invalid(/into a shared file/));
  assert.deepEqual(SUBMISSION_FILE_TYPES, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
});

test('fileSubmission: files into a shared file the .NET library wrote', () => {
  const fixtures = path.resolve(import.meta.dirname, '../../spec/fixtures');
  const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
  const owner = JazminKey.from(keys.key);
  const bob = JazminAccessKey.parse(keys.bob);
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-submissions-')), 'dotnet-access.jzm');
  fs.copyFileSync(path.join(fixtures, 'dotnet-access.jzm'), shared);
  const batch = write(null, [{ id: 9001, name: 'Filed by JavaScript', country: 'NA' }], {
    columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'string' }, { name: 'country', type: 'string' }], key: owner.submissionKey(bob.id),
  });
  assert.deepEqual(fileSubmission(shared, batch, { key: owner, keyId: bob.id }), { sender: bob.id, filed: 1, updated: 0, duplicates: 0, files: 0, ignoredColumns: [] });
  const reader = open(shared, { key: owner });
  const [row] = [...reader.find({ id: 9001 })];
  reader.close();
  assert.deepEqual([row.name, row.country], ['Filed by JavaScript', 'ZA']); // Bob's one partition
});

test('a shared file with no files column files new and changed records', () => {
  const owner = JazminKey.generate();
  const ann = owner.createAccessKey();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-submissions-'));
  const shared = path.join(dir, 'field.jzm');
  const columns = [{ name: 'id', type: 'string', nullable: false }, { name: 'inspector', type: 'string' }, { name: 'note', type: 'string' }];
  write(shared, [{ id: 'r1', inspector: 'ann', note: 'roof ok' }], { columns, key: owner, access: { partitionBy: 'inspector', grants: [{ key: ann, rows: ['ann'] }] } });
  const view = open(shared, { key: ann });
  const batch = path.join(dir, 'batch.jzm');
  write(batch, [{ id: 'r1', note: 'roof leaks' }, { id: 'r2', note: 'gate broken' }], { columns, key: view.submissionKey });
  view.close();
  const result = fileSubmission(shared, fs.readFileSync(batch), { key: owner, keyId: ann.id });
  assert.deepEqual([result.filed, result.updated], [1, 1]);
  const reader = open(shared, { key: owner });
  assert.deepEqual([...reader.rows()].map((r) => `${r.id}: ${r.note}`).sort(), ['r1: roof leaks', 'r2: gate broken']);
  reader.close();
});
