// A shared (access-controlled) file under a new owner key: every access key is replaced, each grant keeping what it
// opened, and none of the old keys open the file afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminKeyError, JazminValidationError, issueUnlockToken, open, rotateOwnerKey, write } from '../src/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-rotate-owner-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 1);
const countries = ['ZA', 'NA', 'BW'];
const rows = Array.from({ length: 600 }, (_, i) => ({
  country: countries[i % 3], id: i, name: `Person ${i}`, balance: `${i}.50`, note: i % 5 ? `note ${i}` : null,
}));
const columns = [
  { name: 'country', type: 'string', nullable: false },
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'name', type: 'string', index: 'trigram' },
  { name: 'balance', type: 'decimal' },
  { name: 'note', type: 'string' },
];

/** What a key opens: its rows, columns, files and an index lookup. */
function view(file, options) {
  const r = open(file, { ...options, now: T0 + 4 * 3_600_000, accessState: false }); // after the rotation, at T0 + 3 h
  try {
    return {
      columns: r.columns.map((c) => c.name),
      rows: [...r.rows()],
      lookup: [...r.find({ id: { in: [3, 4, 5, 300] } })],
      files: r.files.map((f) => [f.path, r.readFile(f.path).toString()]),
    };
  } finally {
    r.close();
  }
}

test('every access key is replaced, keeping what it opened; the old keys open nothing', () => {
  const file = path.join(dir, 'shared.jzm');
  const owner = JazminKey.generate();
  const [alice, bob, carol, dave] = [0, 1, 2, 3].map(() => owner.createAccessKey());
  write(file, rows, {
    columns,
    key: owner,
    now: T0,
    files: [{ path: 'all.txt', content: 'for everyone' }, { path: 'team.txt', content: 'for the team', groups: ['team'] }],
    access: {
      partitionBy: 'country',
      columnGroups: { money: ['balance'] },
      grants: [
        { key: alice, rows: ['ZA'], columns: '*', label: 'Alice', files: ['team'] },
        { key: bob, rows: ['NA', 'BW'], columns: ['*'], label: 'Bob' }, // the default group only: balance hidden
        { key: carol, columns: '*', label: 'Carol', mode: 'online', expires: '2099-01-01T00:00:00.000Z' },
        { key: dave, columns: '*', label: 'Dave', expires: new Date(T0 + 2 * 3_600_000) }, // expired before the rotation
      ],
    },
  });
  const before = {
    owner: view(file, { key: owner }),
    alice: view(file, { key: alice }),
    bob: view(file, { key: bob }),
    carol: view(file, { key: carol, unlockToken: issueUnlockToken(file, owner, carol, { now: T0 }) }),
  };

  const result = rotateOwnerKey(file, { key: owner, now: T0 + 3 * 3_600_000 });
  assert.ok(result.ownerKey instanceof JazminKey);
  assert.deepEqual(result.accessKeys.map((k) => [k.previous, k.label, k.mode]), [
    [alice.id, 'Alice', 'offline'], [bob.id, 'Bob', 'offline'], [carol.id, 'Carol', 'online'], // Dave's grant had expired
  ]);
  const next = Object.fromEntries(result.accessKeys.map((k) => [k.label.toLowerCase(), k.key]));
  assert.deepEqual(view(file, { key: result.ownerKey }), before.owner);
  assert.deepEqual(view(file, { key: next.alice }), before.alice);
  assert.deepEqual(view(file, { key: next.bob }), before.bob);
  const token = issueUnlockToken(file, result.ownerKey, next.carol, { now: T0 + 3 * 3_600_000 });
  assert.deepEqual(view(file, { key: next.carol, unlockToken: token }), before.carol);
  assert.equal(result.accessKeys[2].expires.toISOString(), '2099-01-01T00:00:00.000Z');

  for (const old of [owner, alice, bob, carol, dave]) assert.throws(() => view(file, { key: old }), JazminKeyError);
});

test("owner-key rotation refuses files that are not shared, and keys that are not the owner's", () => {
  const plain = path.join(dir, 'plain.jzm');
  const key = JazminKey.generate();
  write(plain, [{ n: 1 }], { key });
  assert.throws(() => rotateOwnerKey(plain, { key }), /not access-controlled/);

  const file = path.join(dir, 'refused.jzm');
  const owner = JazminKey.generate();
  const reader = owner.createAccessKey();
  write(file, rows, { columns, key: owner, access: { partitionBy: 'country', grants: [{ key: reader, rows: ['ZA'] }] } });
  const bytes = fs.readFileSync(file);
  assert.throws(() => rotateOwnerKey(file, { key: reader }), JazminKeyError); // an access key is not the owner's
  assert.throws(() => rotateOwnerKey(file, { key: JazminKey.generate() }), JazminKeyError);
  assert.throws(() => rotateOwnerKey(file, { key: owner, newKey: reader }), JazminValidationError);
  assert.ok(fs.readFileSync(file).equals(bytes));
});
