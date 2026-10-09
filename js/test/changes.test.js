// Editable documents (docs/design/editable-documents.md): package.edit checked by writers; change files made from an
// open file (writeChanges) and applied to it (applyChanges): changes, additions and deletions, typed values; rows
// changed since the sender's copy held as conflicts unless overwritten; a shared file's senders limited to their
// grant's rows and columns, found by their submission key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, applyChanges, compact, open, update, write, writeChanges } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-changes-'));
const doc = { path: 'index.html', content: '<p>claims</p>' };
const columns = [
  { name: 'claim', type: 'string', nullable: false },
  { name: 'region', type: 'string', nullable: false },
  { name: 'status', type: 'string' },
  { name: 'amount', type: 'decimal' },
  { name: 'due', type: 'datetime' },
  { name: 'note', type: 'string' },
  { name: 'internal', type: 'string' },
];
const claims = [
  { claim: 'C-1', region: 'A', status: 'open', amount: '100.50', due: new Date(Date.UTC(2026, 9, 1)), note: null, internal: 'x' },
  { claim: 'C-2', region: 'A', status: 'open', amount: '20.00', due: null, note: 'call back', internal: 'y' },
  { claim: 'C-3', region: 'B', status: 'closed', amount: '7.25', due: null, note: null, internal: 'z' },
];
const EDIT = { key: ['claim'], columns: ['region', 'status', 'amount', 'due', 'note'], add: true, delete: true };
const rowsOf = (file, options) => {
  const r = open(file, options);
  try {
    return Object.fromEntries([...r.rows()].map((row) => [row.claim, row]));
  } finally {
    r.close();
  }
};

test('package.edit: checked by writers against the table, read back as written', () => {
  const withEdit = (edit, cols = columns) => write(null, claims, { columns: cols, files: [doc], package: { entry: 'index.html', edit } });
  assert.deepEqual(open(withEdit(EDIT)).package.edit, EDIT);
  assert.deepEqual(open(withEdit({ key: ['claim'], columns: ['note'] })).package.edit, { key: ['claim'], columns: ['note'] });
  assert.throws(() => withEdit({ ...EDIT, keys: ['claim'] }), /package\.edit: unknown setting 'keys'/);
  assert.throws(() => withEdit({ key: [], columns: ['note'] }), /give the column \(or columns\) that identify a row/);
  assert.throws(() => withEdit({ key: ['claim'], columns: ['claim'] }), /'claim' is a key column/);
  assert.throws(() => withEdit({ key: ['claim'] }), /allows nothing/);
  assert.throws(() => withEdit({ key: ['nope'], columns: ['note'] }), /package\.edit\.key: no column 'nope'/);
  assert.throws(() => withEdit({ key: ['claim'], columns: ['nope'] }), /package\.edit\.columns: no column 'nope'/);
  assert.throws(() => withEdit({ key: ['claim'], columns: ['note'], table: 'other' }), /no table 'other'/);
  assert.throws(() => withEdit({ key: ['claim'], columns: ['note'], add: 'yes' }), /package\.edit\.add must be true or false/);
  // Added rows must be able to fill every column that can't be empty.
  assert.throws(() => withEdit({ key: ['claim'], columns: ['note'], add: true }), /column 'region' can't be empty, so added rows must set it/);
  const withJsonKey = [{ name: 'k', type: 'json' }, { name: 'v', type: 'string' }];
  assert.throws(() => write(null, [{ k: [1], v: 'a' }], { columns: withJsonKey, files: [doc], package: { entry: 'index.html', edit: { key: ['k'], columns: ['v'] } } }), /'k' is a json column; keys are/);
});

test("a file of one's own: changes, additions and deletions written into it, with their types; a dry run writes nothing", () => {
  const dir = tmp();
  const file = path.join(dir, 'claims.jzm');
  const key = JazminKey.generate();
  write(file, claims, { columns, key, files: [doc], package: { entry: 'index.html', edit: EDIT } });
  const source = open(file, { key });
  assert.equal(source.encrypted, true);
  assert.throws(() => writeChanges(source, { update: [{ claim: 'C-1', status: 'paid' }] }), /Give the key or password/);
  const change = writeChanges(source, {
    update: [{ claim: 'C-1', status: 'paid', amount: '99.95', due: new Date(Date.UTC(2026, 10, 1)) }],
    add: [{ claim: 'C-9', region: 'B', status: 'new', note: 'from the document' }],
    delete: [{ claim: 'C-2' }],
  }, { key });
  source.close();
  assert.throws(() => open(change), /key/i); // sealed with the file's key

  const dry = applyChanges(file, change, { key, dryRun: true });
  assert.deepEqual(dry, { sender: null, fileChanged: false, updated: 1, added: 1, deleted: 1, conflicts: [], refused: [] });
  assert.equal(rowsOf(file, { key })['C-1'].status, 'open');

  assert.deepEqual(applyChanges(file, change, { key }), dry);
  const after = rowsOf(file, { key });
  assert.deepEqual(Object.keys(after).sort(), ['C-1', 'C-3', 'C-9']);
  assert.deepEqual(after['C-1'], { ...claims[0], status: 'paid', amount: '99.95', due: new Date(Date.UTC(2026, 10, 1)) });
  assert.deepEqual(after['C-9'], { claim: 'C-9', region: 'B', status: 'new', amount: null, due: null, note: 'from the document', internal: null });
  assert.deepEqual(after['C-3'], claims[2]);

  // The same change file again: its rows are no longer as the sender saw them.
  const again = applyChanges(file, change, { key });
  assert.deepEqual(again.conflicts.map((c) => [c.op, c.key.claim, c.kind]), [['add', 'C-9', 'exists'], ['update', 'C-1', 'changed'], ['delete', 'C-2', 'missing']]);
  assert.deepEqual(again.conflicts[1].columns.map((c) => c.name), ['status', 'amount', 'due']);
  assert.deepEqual(again.refused, []);
  assert.equal(again.updated + again.added + again.deleted, 0);
});

test('conflicts: rows changed since the sender\'s copy are held, reported, and applied only with overwrite', () => {
  const dir = tmp();
  const file = path.join(dir, 'claims.jzm');
  write(file, claims, { columns, files: [doc], package: { entry: 'index.html', edit: EDIT } });
  const source = open(file);
  const change = writeChanges(source, { update: [{ claim: 'C-1', status: 'approved' }, { claim: 'C-2', note: 'done' }], delete: [{ claim: 'C-3' }] });
  source.close();
  // Meanwhile someone else changes C-1's status and C-3's note; C-2's status (not what the sender changes) too.
  update(file, { upsert: [{ ...claims[0], status: 'rejected' }, { ...claims[1], status: 'paid' }, { ...claims[2], note: 'disputed' }], keyColumns: ['claim'] });

  const held = applyChanges(file, change);
  assert.equal(held.updated, 1); // C-2: its note is as the sender saw it
  assert.deepEqual(held.conflicts, [
    { op: 'update', key: { claim: 'C-1' }, kind: 'changed', columns: [{ name: 'status', before: 'open', wanted: 'approved', now: 'rejected' }] },
    { op: 'delete', key: { claim: 'C-3' }, kind: 'changed', columns: [{ name: 'note', before: null, wanted: undefined, now: 'disputed' }] },
  ]);
  let now = rowsOf(file);
  assert.equal(now['C-1'].status, 'rejected');
  assert.deepEqual([now['C-2'].status, now['C-2'].note], ['paid', 'done']);
  assert.ok(now['C-3']);

  const forced = applyChanges(file, change, { overwrite: true });
  assert.deepEqual([forced.updated, forced.deleted, forced.conflicts.length], [2, 1, 0]);
  now = rowsOf(file);
  assert.equal(now['C-1'].status, 'approved');
  assert.equal(now['C-3'], undefined);

  // A rewrite gives the file a new id: the change file still applies, and the result says so.
  const later = open(file);
  const next = writeChanges(later, { update: [{ claim: 'C-2', note: 'closed' }] });
  later.close();
  compact(file);
  assert.equal(applyChanges(file, next).fileChanged, true);
});

test('the sender\'s side: only what the document allows, rows the key sees, one change per row', () => {
  const file = write(null, claims, { columns, files: [doc], package: { entry: 'index.html', edit: { key: ['claim'], columns: ['status'] } } });
  const source = open(file);
  assert.throws(() => writeChanges(source, { update: [{ claim: 'C-1', note: 'x' }] }), /Column 'note' can't be changed through this document/);
  assert.throws(() => writeChanges(source, { add: [{ claim: 'C-9', status: 'new' }] }), /doesn't allow adding rows/);
  assert.throws(() => writeChanges(source, { delete: [{ claim: 'C-1' }] }), /doesn't allow deleting rows/);
  assert.throws(() => writeChanges(source, { update: [{ claim: 'C-1', status: 'a' }, { claim: 'C-1', status: 'b' }] }), /appears twice/);
  assert.throws(() => writeChanges(source, { update: [{ claim: 'C-7', status: 'a' }] }), /No row with claim C-7 is visible/);
  assert.throws(() => writeChanges(source, { update: [{ status: 'a' }] }), /without its key column 'claim'/);
  assert.throws(() => writeChanges(source, { update: [{ claim: 'C-1' }] }), /changes nothing/);
  assert.throws(() => writeChanges(source, { upsert: [] }), /unknown 'upsert'/);
  assert.throws(() => writeChanges(source, {}), /No changes to save/);
  assert.throws(() => writeChanges(open(write(null, claims, { columns })), { update: [] }), /has no package\.edit/);
  // Not encrypted: neither is its change file.
  assert.equal(open(writeChanges(source, { update: [{ claim: 'C-1', status: 'a' }] })).metadata['jazmin.changes'].sender, null);
});

test('a shared file: the sender found by submission key, limited to its grant\'s partitions and columns', () => {
  const dir = tmp();
  const file = path.join(dir, 'shared.jzm');
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const sally = owner.createAccessKey();
  const revoked = owner.createAccessKey();
  write(file, claims, {
    columns,
    key: owner,
    files: [doc],
    package: { entry: 'index.html', edit: EDIT },
    access: {
      partitionBy: 'region',
      columnGroups: { private: ['internal', 'note'] },
      grants: [
        { key: bob, rows: ['A'], columns: '*' },
        { key: sally, rows: ['B'], columns: ['*'] }, // the default group, not the private one: no note, no internal
      ],
    },
  });

  // Bob sees region A: he changes C-1, adds a claim (it goes to A, his one partition) and deletes C-2.
  const asBob = open(file, { key: bob.export(), accessState: false });
  assert.equal(asBob.access.keyId, bob.id);
  const change = writeChanges(asBob, { update: [{ claim: 'C-1', status: 'paid', note: 'ok' }], add: [{ claim: 'C-8', status: 'new' }], delete: [{ claim: 'C-2' }] });
  assert.throws(() => writeChanges(asBob, { update: [{ claim: 'C-3', status: 'x' }] }), /No row with claim C-3 is visible/);
  asBob.close();
  assert.throws(() => open(change, { key: owner }), /key/i); // only the submission key opens it

  assert.throws(() => applyChanges(file, change, { key: bob.export() }), /applied with its owner key/);
  const result = applyChanges(file, change, { key: owner });
  assert.deepEqual(result, { sender: bob.id, fileChanged: false, updated: 1, added: 1, deleted: 1, conflicts: [], refused: [] });
  const rows = rowsOf(file, { key: owner });
  assert.deepEqual([rows['C-1'].status, rows['C-1'].note], ['paid', 'ok']);
  assert.deepEqual([rows['C-8'].region, rows['C-8'].status], ['A', 'new']);
  assert.equal(rows['C-2'], undefined);
  assert.equal(applyChanges(file, change, { key: owner, keyId: bob.id, dryRun: true }).sender, bob.id);
  assert.throws(() => applyChanges(file, change, { key: owner, keyId: sally.id }), /doesn't open with the submission key/);
  assert.throws(() => applyChanges(file, change, { key: owner, keyId: revoked.id }), /has no grant in this file/);

  // Sally's view has no note column: her change file can't set it. A change file made by hand with her submission key
  // (a sender bypassing the viewer) is checked as strictly.
  const asSally = open(file, { key: sally.export(), accessState: false });
  assert.throws(() => writeChanges(asSally, { update: [{ claim: 'C-3', note: 'x' }] }), /Column 'note' can't be changed/);
  const forged = write(null, [
    { 'jazmin.op': 'update', 'jazmin.set': ['status'], claim: 'C-1', status: 'mine', amount: null, due: null, 'jazmin.before.status': 'paid', 'jazmin.before.amount': null, 'jazmin.before.due': null },
    { 'jazmin.op': 'add', 'jazmin.set': ['status'], claim: 'C-4', status: 'new', amount: null, due: null, 'jazmin.before.status': null, 'jazmin.before.amount': null, 'jazmin.before.due': null },
    { 'jazmin.op': 'update', 'jazmin.set': ['note'], claim: 'C-3', status: null, amount: null, due: null, 'jazmin.before.status': null, 'jazmin.before.amount': null, 'jazmin.before.due': null, note: 'mine', 'jazmin.before.note': null },
  ], {
    columns: [
      { name: 'jazmin.op', type: 'string', nullable: false }, { name: 'jazmin.set', type: 'json' }, { name: 'claim', type: 'string', nullable: false },
      { name: 'status', type: 'string' }, { name: 'amount', type: 'decimal' }, { name: 'due', type: 'datetime' },
      { name: 'jazmin.before.status', type: 'string' }, { name: 'jazmin.before.amount', type: 'decimal' }, { name: 'jazmin.before.due', type: 'datetime' },
      { name: 'note', type: 'string' }, { name: 'jazmin.before.note', type: 'string' },
    ],
    metadata: { 'jazmin.changes': { version: 1, file: 'x', table: asSally.table, key: ['claim'], columns: ['status', 'amount', 'due'], sender: sally.id } },
    key: asSally.submissionKey,
  });
  asSally.close();
  const checked = applyChanges(file, forged, { key: owner });
  assert.equal(checked.sender, sally.id);
  assert.deepEqual(checked.refused, [
    { op: 'update', key: { claim: 'C-1' }, reason: "the row is in partition 'A', which this sender isn't granted" },
    { op: 'update', key: { claim: 'C-3' }, reason: "column 'note' can't be changed by this sender" },
  ]);
  assert.equal(checked.added, 1); // C-4 goes to B, Sally's one partition
  assert.equal(rowsOf(file, { key: owner })['C-4'].region, 'B');

  // Not a change file of this file's senders at all.
  assert.throws(() => applyChanges(file, write(null, [{ a: 1 }], { key: JazminKey.generate() }), { key: owner }), /doesn't open with the submission key of any key granted/);
});

test("the browser reader makes the same change files (a viewer's), and the library applies them", async () => {
  const dir = tmp();
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const shared = path.join(dir, 'shared.jzm');
  write(shared, claims, {
    columns, key: owner, files: [doc], package: { entry: 'index.html', edit: EDIT },
    access: { partitionBy: 'region', grants: [{ key: bob, rows: ['A'], columns: '*' }] },
  });
  const inBrowser = await JazminBrowser.open(new Blob([fs.readFileSync(shared)]), { key: bob.export() });
  assert.equal(inBrowser.access.keyId, bob.id);
  assert.equal(inBrowser.fileId, open(shared, { key: owner }).fileId);
  const blob = await JazminBrowser.writeChanges(inBrowser, { update: [{ claim: 'C-2', status: 'paid', due: new Date(Date.UTC(2026, 11, 24)) }], add: [{ claim: 'C-5', status: 'new' }] });
  await assert.rejects(JazminBrowser.writeChanges(inBrowser, { update: [{ claim: 'C-3', status: 'x' }] }), /No row with claim C-3 is visible/);
  const result = applyChanges(shared, Buffer.from(await blob.arrayBuffer()), { key: owner });
  assert.deepEqual(result, { sender: bob.id, fileChanged: false, updated: 1, added: 1, deleted: 0, conflicts: [], refused: [] });
  const rows = rowsOf(shared, { key: owner });
  assert.deepEqual([rows['C-2'].status, rows['C-2'].due], ['paid', new Date(Date.UTC(2026, 11, 24))]);
  assert.equal(rows['C-5'].region, 'A');

  // A file of one's own, opened with its key: its change file is sealed with that key.
  const own = path.join(dir, 'own.jzm');
  const key = JazminKey.generate();
  write(own, claims, { columns, key, files: [doc], package: { entry: 'index.html', edit: EDIT } });
  const mine = await JazminBrowser.open(new Blob([fs.readFileSync(own)]), { key: key.export() });
  await assert.rejects(JazminBrowser.writeChanges(mine, { delete: [{ claim: 'C-3' }] }), /Give the key or password/);
  const sealed = Buffer.from(await (await JazminBrowser.writeChanges(mine, { delete: [{ claim: 'C-3' }] }, { key: key.export() })).arrayBuffer());
  assert.equal(applyChanges(own, sealed, { key }).deleted, 1);
  assert.equal(rowsOf(own, { key })['C-3'], undefined);
});
