import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminKey, JazminKeyError, JazminValidationError, grantAccess, open, revokeAccess, update, write,
} from '../src/index.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-update-')), name);
const ids = (file, options, filter) => {
  const r = open(file, options);
  try {
    return [...r.find(filter ?? null)].map((x) => x.id);
  } finally {
    r.close();
  }
};

const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'section', type: 'string', index: 'sorted' },
  { name: 'amount', type: 'float' },
];

test('unsorted file: upsert replaces in place, inserts append, delete removes; indexes survive', () => {
  const file = tmp('a.jzm');
  write(file, [1, 2, 3, 4].map((id) => ({ id, section: 'A', amount: id })), { columns, metadata: { v: 1 } });
  const result = update(file, {
    upsert: [{ id: 2, section: 'B', amount: 20 }, { id: 9, section: 'C', amount: 90 }],
    keyColumns: ['id'],
    insert: [{ id: 5, section: 'A', amount: 5 }],
    delete: { id: 4 },
    metadata: { v: 2 },
  });
  assert.deepEqual(result, { rowCount: 5, inserted: 2, updated: 1, deleted: 1, expiredGrantsRemoved: 0 });
  const r = open(file);
  assert.deepEqual([...r.rows()].map((x) => [x.id, x.section, x.amount]), [[1, 'A', 1], [2, 'B', 20], [3, 'A', 3], [5, 'A', 5], [9, 'C', 90]]);
  assert.deepEqual(r.metadata, { v: 2 });
  assert.equal(r.explain({ id: 9 }).strategy, 'index');
  r.close();
});

test('the writer enforces sortedBy order', () => {
  assert.throws(() => write(null, [{ id: 2, section: 'B' }, { id: 1, section: 'A' }], { columns, sortedBy: ['section'] }), /out of order/);
});

test('sorted file: new and changed rows land in sorted position', () => {
  const file = tmp('s.jzm');
  const rows = ['A', 'B', 'D'].flatMap((s, i) => [0, 1].map((n) => ({ id: i * 10 + n, section: s, amount: n })));
  write(file, rows, { columns, sortedBy: ['section', 'id'], chunkRows: 2 });
  update(file, {
    insert: [{ id: 30, section: 'C', amount: 1 }, { id: 1, section: 'A', amount: 9 }],
    upsert: [{ id: 0, section: 'E', amount: 0 }], // moves from section A to the end
    keyColumns: ['id'],
  });
  const r = open(file);
  assert.deepEqual(r.sortedBy, ['section', 'id']);
  assert.deepEqual([...r.rows()].map((x) => `${x.section}${x.id}`), ['A1', 'A1', 'B10', 'B11', 'C30', 'D20', 'D21', 'E0']);
  r.close();
});

test('encrypted and password files stay protected; a failed update leaves the file untouched', () => {
  const key = JazminKey.generate();
  const file = tmp('k.jzm');
  write(file, [{ id: 1, section: 'A' }], { columns, key });
  const before = fs.readFileSync(file);
  assert.throws(() => update(file, { key: JazminKey.generate(), insert: [{ id: 2 }] }), JazminKeyError);
  assert.throws(() => update(file, { key, insert: [{ id: 'not a number' }] }), JazminValidationError);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['k.jzm']); // no temp files left behind
  update(file, { key, insert: [{ id: 2, section: 'B' }] });
  assert.deepEqual(ids(file, { key }), [1, 2]);

  const pw = tmp('p.jzm');
  write(pw, [{ id: 1, section: 'A' }], { columns, password: 'secret', kdfIterations: 1000 });
  update(pw, { password: 'secret', insert: [{ id: 2, section: 'A' }] });
  const r = open(pw, { password: 'secret' });
  assert.equal(r.kdfIterations, 1000);
  assert.equal(r.rowCount, 2);
  r.close();
});

test('access-controlled: only the owner can update; grant and revoke re-issue access', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const carol = owner.createAccessKey();
  const file = tmp('acl.jzm');
  write(file, [{ id: 1, section: 'A' }, { id: 2, section: 'B' }], {
    columns, key: owner, sortedBy: ['section'],
    access: { partitionBy: 'section', grants: [{ key: bob, rows: ['A'], label: 'Bob' }] },
  });
  assert.deepEqual(ids(file, { key: bob }), [1]);
  assert.throws(() => update(file, { key: bob, insert: [{ id: 3, section: 'A' }] }), /Only the file owner/);

  update(file, { key: owner, insert: [{ id: 3, section: 'A' }, { id: 4, section: 'C' }] });
  assert.deepEqual(ids(file, { key: bob }), [1, 3]); // Bob's grant carried into the new version
  assert.deepEqual(ids(file, { key: owner }), [1, 3, 2, 4]);

  grantAccess(file, owner, carol, { rows: '*', label: 'Carol' });
  assert.deepEqual(ids(file, { key: carol }), [1, 3, 2, 4]);
  revokeAccess(file, owner, bob);
  assert.throws(() => open(file, { key: bob }), /not been granted/);
  assert.deepEqual(ids(file, { key: carol }), [1, 3, 2, 4]);
  const r = open(file, { key: owner });
  assert.deepEqual(r.access.grants.map((g) => g.label), ['Carol']);
  r.close();
});

test('grant/revoke on a file without access control is an error', () => {
  const file = tmp('plain.jzm');
  write(file, [{ id: 1 }], { columns });
  assert.throws(() => grantAccess(file, JazminKey.generate(), JazminKey.generate().createAccessKey()), JazminKeyError);
  assert.throws(() => update(file, { revoke: [JazminKey.generate().createAccessKey()] }), /access-controlled/);
});
