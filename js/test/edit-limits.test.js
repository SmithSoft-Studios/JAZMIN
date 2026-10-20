// Per-key limits on what a key may send back (spec 7.9.1, docs/design/per-key-edit-limits.md): a grant's edit narrows
// the document's package.edit for its key; writers store the document's settings as editByKey and name the writer
// feature edit-limits while any limit narrows something; writeChanges and applyChanges keep each key to its limit; a
// limit an older release lost allows nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminKey, JazminWriter, append, applyChanges, compact, grantAccess, open, rotateOwnerKey, update, write, writeChanges,
} from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-edit-limits-')), name);
const doc = { path: 'index.html', content: '<p>critical results</p>' };
const columns = [
  { name: 'ack', type: 'string', nullable: false },
  { name: 'ward', type: 'string', nullable: false },
  { name: 'result', type: 'string' },
  { name: 'ackAction', type: 'string' },
  { name: 'ackNote', type: 'string' },
];
const acks = [
  { ack: 'A-1', ward: 'W1', result: 'K+ 6.9', ackAction: null, ackNote: null },
  { ack: 'A-2', ward: 'W1', result: 'Hb 6.1', ackAction: null, ackNote: null },
  { ack: 'A-3', ward: 'W2', result: 'Na 118', ackAction: null, ackNote: null },
];
const EDIT = { key: ['ack'], columns: ['ward', 'ackAction', 'ackNote'], add: true, delete: true };
const IPC_LIMIT = { columns: ['ackNote'], add: false, delete: false };

/** The hospital's file: a doctor without a limit, infection control (ipc) limited to notes. */
function hospital({ grants, edit = EDIT, columnGroups } = {}) {
  const file = tmp('acks.jzm');
  const owner = JazminKey.generate();
  const doctor = owner.createAccessKey();
  const ipc = owner.createAccessKey();
  write(file, acks, {
    columns, key: owner, files: [doc], package: { entry: 'index.html', ...(edit ? { edit } : {}) },
    access: {
      partitionBy: 'ward', ...(columnGroups ? { columnGroups } : {}),
      grants: grants ? grants(doctor, ipc) : [
        { key: doctor, rows: ['W1', 'W2'], label: 'Doctor' },
        { key: ipc, rows: ['W1', 'W2'], label: 'Infection control', edit: IPC_LIMIT },
      ],
    },
  });
  return { file, owner, doctor, ipc };
}

const openAs = (file, key) => open(file, { key: key.export ? key.export() : key, accessState: false });
const grantsOf = (file, owner) => {
  const r = open(file, { key: owner });
  try {
    return Object.fromEntries(r.access.grants.map((g) => [g.label, g]));
  } finally {
    r.close();
  }
};
const featuresOf = (file, key) => {
  const r = open(file, { key });
  try {
    return r.writerFeatures;
  } finally {
    r.close();
  }
};
const rowsOf = (file, owner) => {
  const r = open(file, { key: owner });
  try {
    return Object.fromEntries([...r.rows()].map((row) => [row.ack, row]));
  } finally {
    r.close();
  }
};

/** A change file made by hand with a key's submission key: a sender who bypasses writeChanges. */
function forged(file, key, rows) {
  const r = openAs(file, key);
  try {
    const names = ['ward', 'ackAction', 'ackNote'];
    return write(null, rows.map((row) => ({
      ...Object.fromEntries(names.flatMap((n) => [[n, null], [`jazmin.before.${n}`, null]])), ...row,
    })), {
      columns: [
        { name: 'jazmin.op', type: 'string', nullable: false }, { name: 'jazmin.set', type: 'json' }, { name: 'ack', type: 'string', nullable: false },
        ...names.flatMap((n) => [{ name: n, type: 'string' }, { name: `jazmin.before.${n}`, type: 'string' }]),
      ],
      metadata: { 'jazmin.changes': { version: 1, file: r.fileId, table: r.table, key: ['ack'], columns: names, sender: r.access.keyId } },
      key: r.submissionKey,
    });
  } finally {
    r.close();
  }
}

test('a file without limits is written as before: package.edit, no edit members, no feature', () => {
  const { file, owner, doctor, ipc } = hospital({ grants: (d, i) => [{ key: d, rows: '*', label: 'Doctor' }, { key: i, rows: '*', label: 'Infection control' }] });
  assert.deepEqual(featuresOf(file, owner), []);
  for (const g of Object.values(grantsOf(file, owner))) assert.deepEqual([g.edit, g.editLost, g.editUnreadable], [undefined, undefined, undefined]);
  const r = openAs(file, ipc);
  assert.deepEqual([r.access.edit, r.access.editLost, r.package.edit, r.edit], [undefined, undefined, EDIT, EDIT]);
  r.close();
  // A limit that narrows nothing (every column, add and delete allowed) is not kept.
  const same = hospital({ grants: (d, i) => [{ key: d, rows: '*' }, { key: i, rows: '*', label: 'ipc', edit: { columns: EDIT.columns, add: true, delete: true } }] });
  assert.deepEqual(featuresOf(same.file, same.owner), []);
  assert.equal(grantsOf(same.file, same.owner).ipc.edit, undefined);
  void doctor;
});

test('a limit narrows the document for its key: the feature, the grants list, the key holder and reader.edit', () => {
  const { file, owner, doctor, ipc } = hospital();
  assert.deepEqual(featuresOf(file, owner), ['edit-limits']);
  const grants = grantsOf(file, owner);
  assert.equal(grants.Doctor.edit, undefined); // stored as {}: no limit
  assert.equal(grants.Doctor.editLost, undefined);
  assert.deepEqual(grants['Infection control'].edit, IPC_LIMIT);
  const asIpc = openAs(file, ipc);
  assert.deepEqual(asIpc.package.edit, EDIT); // the document's settings, from editByKey
  assert.deepEqual(asIpc.access.edit, IPC_LIMIT);
  assert.deepEqual(asIpc.edit, { key: ['ack'], columns: ['ackNote'], add: false, delete: false });
  asIpc.close();
  const asDoctor = openAs(file, doctor);
  assert.equal(asDoctor.access.edit, undefined);
  assert.deepEqual(asDoctor.edit, { key: ['ack'], columns: ['ward', 'ackAction', 'ackNote'], add: true, delete: true });
  asDoctor.close();
});

test('writeChanges keeps the sender to its limit; applyChanges applies what it allows', () => {
  const { file, owner, ipc, doctor } = hospital();
  const asIpc = openAs(file, ipc);
  assert.throws(() => writeChanges(asIpc, { update: [{ ack: 'A-1', ackAction: 'acknowledged' }] }), /^JazminValidationError: Column 'ackAction' can't be changed with this key$/);
  assert.throws(() => writeChanges(asIpc, { add: [{ ack: 'A-9', ward: 'W1', ackNote: 'x' }] }), /^JazminValidationError: This key can't add rows$/);
  assert.throws(() => writeChanges(asIpc, { delete: [{ ack: 'A-1' }] }), /^JazminValidationError: This key can't delete rows$/);
  const note = writeChanges(asIpc, { update: [{ ack: 'A-1', ackNote: 'isolation started' }] });
  asIpc.close();
  assert.deepEqual(open(note, { key: owner.submissionKey(ipc.id) }).metadata['jazmin.changes'].columns, ['ackNote']);
  assert.deepEqual(applyChanges(file, note, { key: owner }), { sender: ipc.id, fileChanged: false, updated: 1, added: 0, deleted: 0, conflicts: [], refused: [] });
  // The doctor has no limit: the document's settings.
  const asDoctor = openAs(file, doctor);
  const acked = writeChanges(asDoctor, { update: [{ ack: 'A-1', ackAction: 'acknowledged' }], delete: [{ ack: 'A-2' }] });
  asDoctor.close();
  assert.deepEqual(applyChanges(file, acked, { key: owner }), { sender: doctor.id, fileChanged: false, updated: 1, added: 0, deleted: 1, conflicts: [], refused: [] });
  const rows = rowsOf(file, owner);
  assert.deepEqual([rows['A-1'].ackAction, rows['A-1'].ackNote, rows['A-2']], ['acknowledged', 'isolation started', undefined]);
});

test("applyChanges refuses a hand-made change file outside the sender's limit, also with overwrite", () => {
  const { file, owner, ipc } = hospital();
  const change = forged(file, ipc, [
    { 'jazmin.op': 'update', 'jazmin.set': ['ackAction'], ack: 'A-1', ackAction: 'acknowledged' },
    { 'jazmin.op': 'add', 'jazmin.set': ['ward', 'ackNote'], ack: 'A-9', ward: 'W1', ackNote: 'x' },
    { 'jazmin.op': 'delete', 'jazmin.set': null, ack: 'A-2' },
    { 'jazmin.op': 'update', 'jazmin.set': ['ackNote'], ack: 'A-3', ackNote: 'allowed' },
  ]);
  const refused = [
    { op: 'update', key: { ack: 'A-1' }, reason: "column 'ackAction' can't be changed by this sender" },
    { op: 'add', key: { ack: 'A-9' }, reason: "this sender's grant doesn't allow adding rows" },
    { op: 'delete', key: { ack: 'A-2' }, reason: "this sender's grant doesn't allow deleting rows" },
  ];
  assert.deepEqual(applyChanges(file, change, { key: owner, dryRun: true }).refused, refused);
  const result = applyChanges(file, change, { key: owner, overwrite: true });
  assert.deepEqual([result.updated, result.added, result.deleted, result.refused], [1, 0, 0, refused]);
  const rows = rowsOf(file, owner);
  assert.deepEqual([rows['A-1'].ackAction, rows['A-2'].ack, rows['A-3'].ackNote, rows['A-9']], [null, 'A-2', 'allowed', undefined]);
});

test('a read-only key (columns [], no add, no delete) may send nothing', () => {
  const { file, owner, ipc } = hospital({ grants: (d, i) => [{ key: d, rows: '*' }, { key: i, rows: '*', label: 'ipc', edit: { columns: [], add: false, delete: false } }] });
  const asIpc = openAs(file, ipc);
  assert.deepEqual(asIpc.edit, { key: ['ack'], columns: [], add: false, delete: false });
  assert.throws(() => writeChanges(asIpc, { update: [{ ack: 'A-1', ackNote: 'x' }] }), /^JazminValidationError: This key can't send changes to this document$/);
  asIpc.close();
  const change = forged(file, ipc, [{ 'jazmin.op': 'update', 'jazmin.set': ['ackNote'], ack: 'A-1', ackNote: 'x' }]);
  assert.deepEqual(applyChanges(file, change, { key: owner }).refused, [{ op: 'update', key: { ack: 'A-1' }, reason: "column 'ackNote' can't be changed by this sender" }]);
});

test('a limit given with a grant may only narrow: writers refuse a wider or malformed one', () => {
  const given = (edit, docEdit = EDIT, columnGroups) => () => hospital({ edit: docEdit, columnGroups, grants: (d, i) => [{ key: d, rows: '*' }, { key: i, rows: '*', edit }] });
  assert.throws(given({ columns: ['result'] }), /^JazminValidationError: grant 1: edit can only narrow the document's: 'result' isn't an editable column$/);
  assert.throws(given({ add: true }, { key: ['ack'], columns: ['ackNote'] }), /grant 1: edit can only narrow the document's: the document doesn't allow adding rows$/);
  assert.throws(given({ delete: true }, { key: ['ack'], columns: ['ackNote'] }), /the document doesn't allow deleting rows$/);
  assert.throws(given({ cols: [] }), /^JazminValidationError: grant 1: edit: unknown setting 'cols' \(columns, add, delete\)$/);
  assert.throws(given({ add: 'no' }), /grant 1: edit\.add must be true or false/);
  assert.throws(given({ columns: ['ackNote', 'ackNote'] }), /grant 1: edit\.columns names a column twice/);
  assert.throws(given(['ackNote']), /grant 1: edit must be an object/);
  // A column outside the key's column groups.
  const outside = () => hospital({
    columnGroups: { clinical: ['ackAction'] },
    grants: (d, i) => [{ key: d, rows: '*', columns: '*' }, { key: i, rows: '*', columns: ['*'], edit: { columns: ['ackAction'] } }],
  });
  assert.throws(outside, /^JazminValidationError: grant 1: edit\.columns: 'ackAction' isn't in a column group this key sees$/);
});

test('limits are carried by update, compact, append, grantAccess and a new owner key; edit: null removes one', () => {
  const { file, owner, ipc } = hospital();
  const limitOf = () => grantsOf(file, owner)['Infection control']?.edit;
  update(file, { key: owner, insert: [{ ack: 'A-4', ward: 'W2', result: 'pH 7.0', ackAction: null, ackNote: null }] });
  assert.deepEqual(limitOf(), IPC_LIMIT);
  compact(file, { key: owner });
  assert.deepEqual(limitOf(), IPC_LIMIT);
  append(file, { key: owner, insert: [{ ack: 'A-5', ward: 'W1', result: 'Glu 1.9', ackAction: null, ackNote: null }] });
  assert.deepEqual(limitOf(), IPC_LIMIT);
  grantAccess(file, owner, ipc, { rows: ['W1', 'W2', 'W3'] }); // more wards: the limit is kept
  assert.deepEqual(limitOf(), IPC_LIMIT);
  update(file, { key: owner, grant: [{ key: ipc, rows: ['W1'], label: 'Infection control' }] }); // a grant given again keeps it too
  assert.deepEqual(limitOf(), IPC_LIMIT);
  assert.deepEqual(featuresOf(file, owner), ['edit-limits']);

  const { ownerKey, accessKeys } = rotateOwnerKey(file, { key: owner });
  const r = open(file, { key: ownerKey });
  const rotated = r.access.grants.find((g) => g.label === 'Infection control');
  r.close();
  assert.deepEqual(rotated.edit, IPC_LIMIT);
  const newIpc = accessKeys.find((k) => k.label === 'Infection control').key;
  const asIpc = openAs(file, newIpc);
  assert.deepEqual(asIpc.access.edit, IPC_LIMIT);
  asIpc.close();

  grantAccess(file, ownerKey, newIpc, { edit: null }); // the last limit removed: the file is as one without limits
  const after = open(file, { key: ownerKey });
  assert.equal(after.access.grants.find((g) => g.label === 'Infection control').edit, undefined);
  assert.deepEqual(after.writerFeatures, []);
  after.close();
});

test('append may narrow or widen a limit (the owner enforces it when applying: no re-lock needed)', () => {
  const { file, owner, ipc } = hospital({ grants: (d, i) => [{ key: d, rows: '*' }, { key: i, rows: '*', label: 'ipc' }] });
  assert.deepEqual(featuresOf(file, owner), []);
  append(file, { key: owner, grant: [{ key: ipc, rows: '*', label: 'ipc', edit: IPC_LIMIT }] });
  assert.deepEqual(grantsOf(file, owner).ipc.edit, IPC_LIMIT);
  assert.deepEqual(featuresOf(file, owner), ['edit-limits']);
  const asIpc = openAs(file, ipc);
  assert.throws(() => writeChanges(asIpc, { update: [{ ack: 'A-1', ackAction: 'x' }] }), /can't be changed with this key/);
  asIpc.close();
  append(file, { key: owner, grant: [{ key: ipc, rows: '*', label: 'ipc', edit: { columns: ['ackAction', 'ackNote'] } }] });
  assert.deepEqual(grantsOf(file, owner).ipc.edit, { columns: ['ackAction', 'ackNote'] });
});

test('a limit an older release lost: the key may send nothing, until the owner grants it again with a limit', () => {
  // What an append by a release that doesn't know limits leaves: the document's settings still as editByKey, the
  // grant without edit. Made here with the writer's own flag for it.
  const file = tmp('lost.jzm');
  const owner = JazminKey.generate();
  const doctor = owner.createAccessKey();
  const ipc = owner.createAccessKey();
  const writer = new JazminWriter(file, {
    columns, key: owner, files: [doc], package: { entry: 'index.html', edit: EDIT },
    access: { partitionBy: 'ward', grants: [{ key: doctor, rows: '*', label: 'Doctor' }, { key: ipc, rows: '*', label: 'ipc', editLost: true }] },
  });
  writer.writeRows(acks);
  writer.finish();
  assert.deepEqual(featuresOf(file, owner), ['edit-limits']);
  assert.equal(grantsOf(file, owner).ipc.editLost, true);
  const asIpc = openAs(file, ipc);
  assert.equal(asIpc.access.editLost, true);
  assert.deepEqual(asIpc.edit, { key: ['ack'], columns: [], add: false, delete: false });
  assert.throws(() => writeChanges(asIpc, { update: [{ ack: 'A-1', ackNote: 'x' }] }), /^JazminValidationError: This key's limits were lost: ask the file's owner to grant it again$/);
  asIpc.close();
  const change = forged(file, ipc, [{ 'jazmin.op': 'update', 'jazmin.set': ['ackNote'], ack: 'A-1', ackNote: 'x' }]);
  assert.deepEqual(applyChanges(file, change, { key: owner }).refused, [
    { op: 'update', key: { ack: 'A-1' }, reason: "this sender's limits were lost when an older release rewrote the file: grant the key again" },
  ]);

  // A rewrite keeps it lost, and so does a grant given again without a limit; one with a limit mends it.
  compact(file, { key: owner });
  grantAccess(file, owner, ipc, { rows: ['W1'] });
  assert.equal(grantsOf(file, owner).ipc.editLost, true);
  grantAccess(file, owner, ipc, { edit: IPC_LIMIT });
  const mended = grantsOf(file, owner).ipc;
  assert.deepEqual([mended.editLost, mended.edit], [undefined, IPC_LIMIT]);
  assert.equal(applyChanges(file, change, { key: owner }).updated, 1);
});

test('the document without edit settings keeps the limits; they apply again when it allows changes again', () => {
  const { file, owner, ipc } = hospital();
  update(file, { key: owner, package: { entry: 'index.html' } });
  assert.deepEqual(grantsOf(file, owner)['Infection control'].edit, IPC_LIMIT);
  assert.deepEqual(featuresOf(file, owner), ['edit-limits']);
  let asIpc = openAs(file, ipc);
  assert.equal(asIpc.edit, null);
  asIpc.close();
  update(file, { key: owner, package: { entry: 'index.html', edit: EDIT } });
  asIpc = openAs(file, ipc);
  assert.deepEqual(asIpc.edit, { key: ['ack'], columns: ['ackNote'], add: false, delete: false });
  asIpc.close();
});

test('the browser reader, which does not read limits yet, offers no changes for a file with limits', async () => {
  const { file, ipc } = hospital();
  const inBrowser = await JazminBrowser.open(new Blob([fs.readFileSync(file)]), { key: ipc.export() });
  await assert.rejects(JazminBrowser.writeChanges(inBrowser, { update: [{ ack: 'A-1', ackNote: 'x' }] }), /doesn't allow changes/);
});
