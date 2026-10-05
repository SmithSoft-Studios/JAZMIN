import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, open, revokeAccess, write } from '../src/index.js';
import { RejectedBatch, fileBatch } from '../examples/filing-service/filing.mjs';
import { processInbox } from '../examples/filing-service/inbox.mjs';
import '../browser/jazmin-browser.js';

// The reference filing service (js/examples/filing-service, issue #13): phones send outbox batches written in the
// browser; the service, which holds the owner key, files them into the shared file by the rules in filing.mjs.

const { JazminBrowser } = globalThis;
const columns = [
  { name: 'id', type: 'string', nullable: false, index: 'sorted' },
  { name: 'person', type: 'string', nullable: false },
  { name: 'note', type: 'string' },
  { name: 'amount', type: 'float' },
];
const batchColumns = columns.map(({ index, ...c }) => c); // browsers don't write indexes

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-filing-'));
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const sally = owner.createAccessKey();
  const late = owner.createAccessKey();
  const shared = path.join(dir, 'shared.jzm');
  write(shared, [{ id: 'seed', person: 'P1', note: 'first', amount: 1 }], {
    columns, key: owner,
    access: {
      partitionBy: 'person',
      grants: [
        { key: bob, rows: ['P1'], columns: '*', label: 'Bob' },
        { key: sally, rows: ['P2'], columns: '*', label: 'Sally' },
        { key: late, rows: ['P3'], columns: '*', label: 'Late', expires: new Date(Date.UTC(2026, 0, 1)) },
      ],
    },
    now: Date.UTC(2025, 0, 1),
  });
  return { dir, owner, bob, sally, late, shared };
}

/** A batch as a phone writes it: in the browser, locked with the person's outbox key. */
async function phoneBatch(accessKey, records, cols = batchColumns) {
  const key = await JazminBrowser.outboxKey(accessKey.toString());
  return Buffer.from(await (await JazminBrowser.write(records, { columns: cols, key })).arrayBuffer());
}

const rowsOf = (shared, owner) => {
  const reader = open(shared, { key: owner });
  try {
    return [...reader.rows()].map((r) => `${r.person}:${r.id}`).sort();
  } finally {
    reader.close();
  }
};

test('filing: rows go into the sender own partition, and a batch sent twice is filed once', async () => {
  const { owner, bob, shared } = setup();
  const batch = await phoneBatch(bob, [
    { id: 'b1', person: 'P1', note: 'visit', amount: 10 },
    { id: 'b2', person: 'P2', note: 'claims to be Sally', amount: 20 }, // filed as Bob's
    { id: 'b2', person: 'P1', note: 'twice in one batch', amount: 20 },
  ]);
  assert.deepEqual(fileBatch(shared, owner, { keyId: bob.id, batch }), { filed: 2, duplicates: 1 });
  assert.deepEqual(fileBatch(shared, owner, { keyId: bob.id, batch }), { filed: 0, duplicates: 3 });
  assert.deepEqual(rowsOf(shared, owner), ['P1:b1', 'P1:b2', 'P1:seed']);
});

test('filing: forged, revoked, expired and ill-fitting batches are rejected with the reason', async () => {
  const { owner, bob, sally, late, shared } = setup();
  const rejects = (keyId, batch, pattern, now) => assert.throws(() => fileBatch(shared, owner, { keyId, batch, now }), (e) => e instanceof RejectedBatch && pattern.test(e.message));
  const sallys = await phoneBatch(sally, [{ id: 's1', person: 'P2', note: null, amount: 1 }]);
  rejects(bob.id, sallys, /doesn't open with key .* outbox key/); // Sally's batch, sent as Bob's
  rejects('not-an-id', sallys, /not an access key id/);
  rejects(bob.id, Buffer.from('not a jzm file'), /not a readable \.jzm file|doesn't open/);
  rejects(bob.id, await phoneBatch(bob, [{ id: 1, person: 'P1' }], [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }]), /Column 'id' is int in the batch, string in the shared file/);
  rejects(bob.id, await phoneBatch(bob, [{ id: 'x', extra: 1 }], [{ name: 'id', type: 'string' }, { name: 'extra', type: 'int' }]), /column 'extra' the shared file doesn't have/);
  rejects(late.id, await phoneBatch(late, [{ id: 'l1', person: 'P3' }], [{ name: 'id', type: 'string' }, { name: 'person', type: 'string' }]), /expired/, Date.UTC(2026, 5, 1));
  revokeAccess(shared, owner, sally);
  rejects(sally.id, sallys, /has no grant in this file: unknown or revoked/);
  assert.deepEqual(rowsOf(shared, owner), ['P1:seed']);
});

test('the inbox runner files, rejects with a reason, and compacts with regrouping', async () => {
  const { dir, owner, bob, sally, shared } = setup();
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox);
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(inbox, `${bob.id}.${i}.jzm`), await phoneBatch(bob, [{ id: `b${i}`, person: 'P1', note: null, amount: i }]));
    fs.writeFileSync(path.join(inbox, `${sally.id}.${i}.jzm`), await phoneBatch(sally, [{ id: `s${i}`, person: 'P2', note: null, amount: i }]));
  }
  fs.writeFileSync(path.join(inbox, `${bob.id}.forged.jzm`), await phoneBatch(sally, [{ id: 'f', person: 'P1', note: null, amount: 0 }]));
  const report = processInbox(shared, inbox, owner, { compactAfter: 5 });
  assert.deepEqual([report.batches, report.filed, report.duplicates, report.rejected.length, report.compacted], [8, 8, 0, 1, true]);
  assert.match(fs.readFileSync(path.join(inbox, 'rejected', `${bob.id}.forged.jzm.txt`), 'utf8'), /doesn't open/);
  assert.equal(fs.readdirSync(path.join(inbox, 'filed')).length, 8);
  assert.equal(fs.readdirSync(inbox).filter((n) => n.endsWith('.jzm')).length, 0);
  const reader = open(shared, { key: owner });
  try {
    assert.equal(reader.rowCount, 9);
    assert.equal(reader.appendCount, 0); // compacted
    assert.equal(reader.chunkCount, 2); // regrouped: one chunk per person
  } finally {
    reader.close();
  }
});
