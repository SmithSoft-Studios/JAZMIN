import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminKey, JazminKeyError, JazminValidationError, grantAccess, issueUnlockToken, open, revokeAccess, update, write,
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

const rowsOf = (file, options) => {
  const r = open(file, options);
  try {
    return [...r.rows()];
  } finally {
    r.close();
  }
};

test('upsert: in one call the last row for a key wins, as if the rows were upserted one after another (#275)', () => {
  const file = tmp('last.jzm');
  const plain = [{ name: 'id', type: 'int' }, { name: 'v', type: 'string' }];
  write(file, [{ id: 1, v: 'a' }, { id: 2, v: 'x' }], { columns: plain });
  const result = update(file, { upsert: [{ id: 1, v: 'b' }, { id: 1, v: 'c' }, { id: 3, v: 'p' }, { id: 3, v: 'q' }], keyColumns: ['id'] });
  assert.deepEqual(rowsOf(file), [{ id: 1, v: 'c' }, { id: 2, v: 'x' }, { id: 3, v: 'q' }]);
  assert.deepEqual(result, { rowCount: 3, inserted: 1, updated: 1, deleted: 0, expiredGrantsRemoved: 0 });

  // One after another, a new key is added at the end and then replaced where it is.
  update(file, { upsert: [{ id: 4, v: 'd' }, { id: 5, v: 'e' }, { id: 4, v: 'f' }], keyColumns: ['id'] });
  assert.deepEqual(rowsOf(file).slice(3), [{ id: 4, v: 'f' }, { id: 5, v: 'e' }]);

  // Keys with empty parts: an empty part matches an empty part.
  const composite = tmp('composite.jzm');
  write(composite, [{ a: 1, b: null, v: 'old' }, { a: 2, b: 'x', v: 'kept' }], {
    columns: [{ name: 'a', type: 'int' }, { name: 'b', type: 'string' }, { name: 'v', type: 'string' }],
  });
  const both = update(composite, {
    upsert: [
      { a: 1, b: null, v: '1' }, { a: 1, b: 'x', v: '2' }, { a: 1, b: null, v: '3' },
      { a: null, b: null, v: '4' }, { a: 2, b: 'y', v: '5' }, { a: null, b: null, v: '6' },
    ],
    keyColumns: ['a', 'b'],
  });
  assert.deepEqual(rowsOf(composite).map((r) => r.v), ['3', 'kept', '2', '6', '5']);
  assert.deepEqual(both, { rowCount: 5, inserted: 3, updated: 1, deleted: 0, expiredGrantsRemoved: 0 });

  const single = tmp('single-null.jzm');
  write(single, [{ id: 1, v: 'a' }], { columns: plain });
  const nulls = update(single, { upsert: [{ id: null, v: 'n1' }, { id: 1, v: 'b' }, { id: null, v: 'n2' }], keyColumns: ['id'] });
  assert.deepEqual(rowsOf(single), [{ id: 1, v: 'b' }, { id: null, v: 'n2' }]);
  assert.deepEqual([nulls.rowCount, nulls.inserted, nulls.updated], [2, 1, 1]);
});

test('upsert in a sorted file: the last row for a key goes in at its sorted place', () => {
  const file = tmp('sorted-last.jzm');
  write(file, [{ id: 1, section: 'B' }, { id: 2, section: 'D' }], { columns, sortedBy: ['section'] });
  const result = update(file, { upsert: [{ id: 1, section: 'E' }, { id: 9, section: 'F' }, { id: 1, section: 'A' }, { id: 9, section: 'C' }], keyColumns: ['id'] });
  assert.deepEqual(rowsOf(file).map((r) => `${r.section}${r.id}`), ['A1', 'C9', 'D2']);
  assert.deepEqual(result, { rowCount: 3, inserted: 1, updated: 1, deleted: 0, expiredGrantsRemoved: 0 });
});

test('upsert in a shared file: the last row for a key wins when its rows are in different partitions', () => {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const carol = owner.createAccessKey();
  const file = tmp('shared-last.jzm');
  write(file, [{ id: 1, section: 'A', amount: 1 }, { id: 2, section: 'B', amount: 2 }], {
    columns, key: owner,
    access: { partitionBy: 'section', grants: [{ key: bob, rows: ['A'] }, { key: carol, rows: ['B'] }] },
  });
  const result = update(file, {
    key: owner,
    upsert: [{ id: 1, section: 'B', amount: 10 }, { id: 3, section: 'A', amount: 30 }, { id: 1, section: 'A', amount: 11 }, { id: 3, section: 'B', amount: 31 }],
    keyColumns: ['id'],
  });
  assert.deepEqual(result, { rowCount: 3, inserted: 1, updated: 1, deleted: 0, expiredGrantsRemoved: 0 });
  assert.deepEqual(rowsOf(file, { key: bob }).map((r) => [r.id, r.amount]), [[1, 11]]);
  assert.deepEqual(rowsOf(file, { key: carol }).map((r) => [r.id, r.amount]), [[2, 2], [3, 31]]);
});

test('upsert in several tables at once: the last row for a key wins in each', () => {
  const file = tmp('tables-last.jzm');
  const plain = [{ name: 'id', type: 'int' }, { name: 'v', type: 'string' }];
  write(file, { first: [{ id: 1, v: 'a' }], second: [{ id: 1, v: 'a' }] }, { tables: [{ name: 'first', columns: plain }, { name: 'second', columns: plain }] });
  const result = update(file, {
    tables: {
      first: { upsert: [{ id: 1, v: 'b' }, { id: 1, v: 'c' }], keyColumns: ['id'] },
      second: { upsert: [{ id: 2, v: 'p' }, { id: 2, v: 'q' }], keyColumns: ['id'] },
    },
  });
  assert.deepEqual(result.tables, { first: { rowCount: 1, inserted: 0, updated: 1, deleted: 0 }, second: { rowCount: 2, inserted: 1, updated: 0, deleted: 0 } });
  assert.deepEqual(rowsOf(file, { table: 'first' }), [{ id: 1, v: 'c' }]);
  assert.deepEqual(rowsOf(file, { table: 'second' }), [{ id: 1, v: 'a' }, { id: 2, v: 'q' }]);
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

test('grantAccess for a key already granted keeps what it is not given: expiry, online mode and its share, file groups, label', () => {
  const owner = JazminKey.generate();
  const ann = owner.createAccessKey();
  const file = tmp('regrant.jzm');
  const expires = '2099-01-01T00:00:00.000Z';
  write(file, [{ id: 1, section: 'A' }, { id: 2, section: 'B' }], {
    columns, key: owner, sortedBy: ['section'],
    files: [{ path: 'a.txt', content: 'only A', groups: ['extra'] }],
    access: { partitionBy: 'section', grants: [{ key: ann, rows: ['A'], label: 'Ann', expires, mode: 'online', files: ['extra'] }] },
  });
  const token = issueUnlockToken(file, owner, ann.id);
  const grantOf = () => {
    const r = open(file, { key: owner });
    try {
      const { rows, columns: groups, label, mode, expires: until, files } = r.access.grants[0];
      return { rows, columns: groups, label, mode, expires: until && new Date(until).toISOString(), files };
    } finally {
      r.close();
    }
  };
  const before = grantOf();

  grantAccess(file, owner, ann, { rows: ['A', 'B'] }); // more rows: nothing else given
  assert.deepEqual(grantOf(), { ...before, rows: ['A', 'B'] });
  assert.deepEqual(ids(file, { key: ann, unlockToken: token }), [1, 2]); // still online, with the same share: the token still opens it

  grantAccess(file, owner, ann, { label: 'Ann (audit)' }); // a new label: rows kept, not widened to '*'
  assert.deepEqual(grantOf(), { ...before, rows: ['A', 'B'], label: 'Ann (audit)' });

  // A key not yet granted gets the defaults, as before: every partition and column group, offline, no expiry.
  const bob = owner.createAccessKey();
  grantAccess(file, owner, bob);
  const r = open(file, { key: owner });
  const added = r.access.grants.find((g) => g.keyId === bob.id);
  r.close();
  assert.deepEqual([added.rows, added.columns, added.mode, added.expires ?? null], ['*', '*', 'offline', null]);
});

test('grant/revoke on a file without access control is an error', () => {
  const file = tmp('plain.jzm');
  write(file, [{ id: 1 }], { columns });
  assert.throws(() => grantAccess(file, JazminKey.generate(), JazminKey.generate().createAccessKey()), JazminKeyError);
  assert.throws(() => update(file, { revoke: [JazminKey.generate().createAccessKey()] }), /access-controlled/);
});
