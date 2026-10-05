import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { JazminKey, compact, open, revokeAccess, write } from '../src/index.js';
import { RejectedBatch, fileBatch } from '../examples/filing-service/filing.mjs';
import { processInbox } from '../examples/filing-service/inbox.mjs';
import '../browser/jazmin-browser.js';

// The reference filing service (js/examples/filing-service, issue #13): phones send batches written in the
// browser; the service, which holds the owner key, files them into the shared file by the rules in filing.mjs.

const { JazminBrowser } = globalThis;
const columns = [
  { name: 'id', type: 'string', nullable: false, index: 'sorted' },
  { name: 'person', type: 'string', nullable: false },
  { name: 'note', type: 'string' },
  { name: 'amount', type: 'float' },
  { name: 'attachments', type: 'json' }, // the paths of each record's files (filing.mjs)
];
const batchColumns = columns.map(({ index, ...c }) => c); // browsers don't write indexes

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-filing-'));
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const sally = owner.createAccessKey();
  const late = owner.createAccessKey();
  const team = owner.createAccessKey();
  const shared = path.join(dir, 'shared.jzm');
  write(shared, [{ id: 'seed', person: 'P1', note: 'first', amount: 1 }], {
    columns, key: owner,
    access: {
      partitionBy: 'person',
      grants: [
        { key: bob, rows: ['P1'], columns: '*', label: 'Bob' },
        { key: sally, rows: ['P2'], columns: '*', label: 'Sally' },
        { key: late, rows: ['P3'], columns: '*', label: 'Late', expires: new Date(Date.UTC(2026, 0, 1)) },
        { key: team, rows: ['P1', 'P2'], columns: '*', label: 'Team' },
      ],
    },
    now: Date.UTC(2025, 0, 1),
  });
  return { dir, owner, bob, sally, late, team, shared };
}

/** The submission key a phone gets by opening the shared file in the browser with the person's access key. */
async function phoneKey(shared, accessKey) {
  return (await JazminBrowser.open(new Blob([fs.readFileSync(shared)]), { key: accessKey.toString() })).submissionKey;
}

/** A batch as a phone writes it: in the browser, locked with the person's submission key, with any files. */
async function phoneBatch(key, records, cols = batchColumns, files = [], writtenAt = undefined) {
  return Buffer.from(await (await JazminBrowser.write(records, { columns: cols, key, files, now: writtenAt })).arrayBuffer());
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
  const batch = await phoneBatch(await phoneKey(shared, bob), [
    { id: 'b1', person: 'P1', note: 'visit', amount: 10 },
    { id: 'b2', person: 'P2', note: 'claims to be Sally', amount: 20 }, // filed as Bob's
    { id: 'b2', person: 'P1', note: 'twice in one batch', amount: 20 },
  ]);
  assert.deepEqual(fileBatch(shared, owner, { keyId: bob.id, batch }), { filed: 2, duplicates: 1, files: 0 });
  assert.deepEqual(fileBatch(shared, owner, { keyId: bob.id, batch }), { filed: 0, duplicates: 3, files: 0 });
  assert.deepEqual(rowsOf(shared, owner), ['P1:b1', 'P1:b2', 'P1:seed']);
});

test('filing: forged, revoked and ill-fitting batches are rejected with the reason', async () => {
  const { owner, bob, sally, shared } = setup();
  const rejects = (keyId, batch, pattern) => assert.throws(() => fileBatch(shared, owner, { keyId, batch }), (e) => e instanceof RejectedBatch && pattern.test(e.message));
  const bobKey = await phoneKey(shared, bob);
  const sallys = await phoneBatch(await phoneKey(shared, sally), [{ id: 's1', person: 'P2', note: null, amount: 1 }]);
  rejects(bob.id, sallys, /doesn't open with key .* submission key/); // Sally's batch, sent as Bob's
  // A leaked access key without the shared file: a key made from the access key alone doesn't open.
  rejects(bob.id, await phoneBatch(JazminKey.generate().toString(), [{ id: 'x', person: 'P1', note: null, amount: 0 }]), /doesn't open/);
  rejects('not-an-id', sallys, /not an access key id/);
  rejects(bob.id, Buffer.from('not a jzm file'), /not a readable \.jzm file|doesn't open/);
  rejects(bob.id, await phoneBatch(bobKey, [{ id: 1, person: 'P1' }], [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }]), /Column 'id' is int in the batch, string in the shared file/);
  rejects(bob.id, await phoneBatch(bobKey, [{ id: 'x', extra: 1 }], [{ name: 'id', type: 'string' }, { name: 'extra', type: 'int' }]), /column 'extra' the shared file doesn't have/);
  revokeAccess(shared, owner, sally);
  rejects(sally.id, sallys, /has no grant in this file: unknown or revoked/);
  assert.deepEqual(rowsOf(shared, owner), ['P1:seed']);
});

// Late's access expires at midnight UTC on 1 January 2026 (setup). The phone saved its submission key while the access
// was valid, so it can still lock batches; what it sends after that is judged by when it was written and when it arrived.
const EXPIRY = Date.UTC(2026, 0, 1);
const minutes = (n) => n * 60_000;

test('filing: a key that expires is filed only for batches written and arrived before it expired', async () => {
  const { owner, late, shared } = setup();
  const lateKey = owner.submissionKey(late.id).toString(); // the owner derives the key the phone saved
  const send = async (id, writtenAt, receivedAt) => {
    const batch = await phoneBatch(lateKey, [{ id, person: 'P3', note: null, amount: 0 }], batchColumns, [], writtenAt);
    return fileBatch(shared, owner, { keyId: late.id, batch, receivedAt });
  };
  const rejected = (pattern) => (e) => e instanceof RejectedBatch && pattern.test(e.message);
  // Captured before expiry, arrived a minute after it: rejected, whatever time the batch says it was written.
  await assert.rejects(send('l1', EXPIRY - minutes(10), EXPIRY + minutes(1)),
    rejected(/^The batch arrived at 2026-01-01T00:01:00\.000Z, after key [0-9a-f]{16}'s access expired at 2026-01-01T00:00:00\.000Z$/));
  // Written after expiry by the phone's clock: rejected, even though it arrived before.
  await assert.rejects(send('l2', EXPIRY + minutes(1), EXPIRY - minutes(1)),
    rejected(/^The batch was written at 2026-01-01T00:01:00\.000Z, after key [0-9a-f]{16}'s access expired at 2026-01-01T00:00:00\.000Z$/));
  // Written and arrived before expiry: filed, although the filing happens later.
  assert.deepEqual(await send('l3', EXPIRY - minutes(10), EXPIRY - minutes(1)), { filed: 1, duplicates: 0, files: 0 });
  // That append happened after the expiry, so it removed the grant (spec 11.2): from now on the key is unknown.
  await assert.rejects(send('l4', EXPIRY - minutes(10), EXPIRY - minutes(1)), rejected(/has no grant in this file/));
  assert.deepEqual(rowsOf(shared, owner), ['P1:seed', 'P3:l3']);
});

test('the inbox runner judges expiry by when each batch arrived (its file time), not when the run happens', async () => {
  const { dir, owner, late, shared } = setup();
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox);
  const lateKey = owner.submissionKey(late.id).toString();
  const record = (id) => [{ id, person: 'P3', note: null, amount: 0 }];
  const tooLate = path.join(inbox, `${late.id}.1.jzm`);
  const inTime = path.join(inbox, `${late.id}.2.jzm`);
  fs.writeFileSync(tooLate, await phoneBatch(lateKey, record('too-late'), batchColumns, [], EXPIRY - minutes(10)));
  fs.writeFileSync(inTime, await phoneBatch(lateKey, record('on-time'), batchColumns, [], EXPIRY - minutes(10)));
  fs.utimesSync(tooLate, new Date(EXPIRY + minutes(5)), new Date(EXPIRY + minutes(5))); // arrived 5 minutes after expiry
  fs.utimesSync(inTime, new Date(EXPIRY - minutes(5)), new Date(EXPIRY - minutes(5))); // 5 minutes before
  const report = processInbox(shared, inbox, owner); // this run happens months later
  assert.equal(report.filed, 1);
  assert.deepEqual(report.rejected.map((r) => r.batch), [`${late.id}.1.jzm`]);
  assert.match(report.rejected[0].reason, /^The batch arrived at 2026-01-01T00:05:00\.000Z, after key/);
  assert.deepEqual(rowsOf(shared, owner), ['P1:seed', 'P3:on-time']);
});

const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300_000)]); // two blocks
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('filing: each record\'s files are stored once, at paths the service chooses, for the keys that see its row', async () => {
  const { owner, bob, sally, shared } = setup();
  const batch = await phoneBatch(await phoneKey(shared, bob), [
    { id: 'b1', person: 'P1', note: 'visit', amount: 1, attachments: ['visit/receipt.pdf', 'visit/photo.jpg'] },
    { id: 'b2', person: 'P1', note: 'same photo', amount: 2, attachments: ['visit/photo.jpg'] },
    { id: 'b3', person: 'P1', note: 'no files', amount: 3, attachments: null },
  ], batchColumns, [
    { path: 'visit/receipt.pdf', content: new Blob([pdf]) },
    { path: 'visit/photo.jpg', content: new File([photo], 'photo.jpg'), type: 'text/html' }, // the type the phone gives is ignored
  ]);
  assert.deepEqual(fileBatch(shared, owner, { keyId: bob.id, batch }), { filed: 3, duplicates: 0, files: 2 });
  assert.deepEqual(fileBatch(shared, owner, { keyId: bob.id, batch }), { filed: 0, duplicates: 3, files: 0 });

  const pdfPath = `attachments/${bob.id}/${sha(pdf)}.pdf`;
  const photoPath = `attachments/${bob.id}/${sha(photo)}.jpg`;
  compact(shared, { key: owner, regroup: true }); // files stay through compaction
  const owners = open(shared, { key: owner });
  const byId = Object.fromEntries([...owners.rows()].map((r) => [r.id, r.attachments]));
  assert.deepEqual(byId.b1, [
    { path: pdfPath, name: 'receipt.pdf', type: 'application/pdf', size: pdf.length },
    { path: photoPath, name: 'photo.jpg', type: 'image/jpeg', size: photo.length },
  ]);
  assert.deepEqual(byId.b2, [{ path: photoPath, name: 'photo.jpg', type: 'image/jpeg', size: photo.length }]);
  assert.equal(byId.b3, null);
  assert.deepEqual(owners.files.map((f) => [f.path, f.type, f.groups]).sort(), [[pdfPath, 'application/pdf', ['P1']], [photoPath, 'image/jpeg', ['P1']]].sort());
  owners.close();
  const bobs = open(shared, { key: bob });
  assert.ok(bobs.readFile(photoPath).equals(photo));
  assert.ok(bobs.readFile(pdfPath).equals(pdf));
  bobs.close();
  assert.deepEqual(open(shared, { key: sally }).files, []); // Sally doesn't see P1's rows, so not their files either
  const browser = await JazminBrowser.open(new Blob([fs.readFileSync(shared)]), { key: bob.toString() });
  assert.ok(Buffer.from(await browser.readFile(pdfPath)).equals(pdf));
});

test('filing: a file a sender attaches to rows of two partitions is seen by the keys of both', async () => {
  const { owner, bob, sally, team, shared } = setup();
  const teamKey = await phoneKey(shared, team);
  const photoPath = `attachments/${team.id}/${sha(photo)}.jpg`;
  const first = await phoneBatch(teamKey, [
    { id: 't1', person: 'P1', note: null, amount: 1, attachments: ['p.jpg'] },
    { id: 't2', person: 'P2', note: null, amount: 2, attachments: ['p.jpg'] },
  ], batchColumns, [{ path: 'p.jpg', content: photo }]);
  assert.deepEqual(fileBatch(shared, owner, { keyId: team.id, batch: first }), { filed: 2, duplicates: 0, files: 1 });
  for (const key of [bob, sally]) assert.ok(open(shared, { key }).readFile(photoPath).equals(photo));
  // The same photo again, for a row of P1: already stored for P1, so nothing is added.
  const again = await phoneBatch(teamKey, [{ id: 't3', person: 'P1', note: null, amount: 3, attachments: ['again.jpg'] }], batchColumns, [{ path: 'again.jpg', content: photo }]);
  assert.deepEqual(fileBatch(shared, owner, { keyId: team.id, batch: again }), { filed: 1, duplicates: 0, files: 0 });
});

test('filing: batches with unlisted, missing, disguised or oversized files are rejected with the reason', async () => {
  const { owner, bob, shared } = setup();
  const bobKey = await phoneKey(shared, bob);
  const rejects = async (records, files, pattern, rules = {}) => {
    const batch = await phoneBatch(bobKey, records, batchColumns, files);
    assert.throws(() => fileBatch(shared, owner, { keyId: bob.id, batch, ...rules }), (e) => e instanceof RejectedBatch && pattern.test(e.message), String(pattern));
  };
  const row = (attachments) => [{ id: 'x', person: 'P1', note: null, amount: 0, attachments }];
  await rejects(row(['a.pdf']), [], /A row lists the file 'a.pdf', which the batch doesn't hold/);
  await rejects(row(['a.pdf']), [{ path: 'a.pdf', content: pdf }, { path: 'extra.pdf', content: pdf }], /holds the file 'extra.pdf', which no row lists/);
  await rejects(row(null), [{ path: 'a.pdf', content: pdf }], /which no row lists/);
  await rejects(row(['page.pdf']), [{ path: 'page.pdf', content: '<script>alert(1)</script>', type: 'application/pdf' }], /'page.pdf' is not a PDF, JPEG, PNG or WebP file/);
  await rejects(row(['a.pdf']), [{ path: 'a.pdf', content: pdf }], /'a.pdf' is not a PNG file/, { fileTypes: ['image/png'] });
  await rejects(row(['a.pdf']), [{ path: 'a.pdf', content: pdf }], /has \d+ bytes; the limit is 10$/, { maxFileBytes: 10 });
  await rejects(row(['a.pdf', 'b.jpg']), [{ path: 'a.pdf', content: pdf }, { path: 'b.jpg', content: photo }], /The batch's files have \d+ bytes; the limit is 100000/, { maxBatchFileBytes: 100_000 });
  await rejects(row([1]), [], /Column 'attachments' must list the paths of the row's files/);
  assert.throws(() => fileBatch(shared, owner, { keyId: bob.id, batch: Buffer.alloc(0), fileTypes: ['text/html'] }), /Unknown file type 'text\/html'/);
  assert.deepEqual(rowsOf(shared, owner), ['P1:seed']);
});

test('the inbox runner files, rejects with a reason, and compacts with regrouping', async () => {
  const { dir, owner, bob, sally, shared } = setup();
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox);
  const bobKey = await phoneKey(shared, bob);
  const sallyKey = await phoneKey(shared, sally);
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(inbox, `${bob.id}.${i}.jzm`), await phoneBatch(bobKey, [{ id: `b${i}`, person: 'P1', note: null, amount: i }]));
    fs.writeFileSync(path.join(inbox, `${sally.id}.${i}.jzm`), await phoneBatch(sallyKey, [{ id: `s${i}`, person: 'P2', note: null, amount: i }]));
  }
  fs.writeFileSync(path.join(inbox, `${bob.id}.forged.jzm`), await phoneBatch(sallyKey, [{ id: 'f', person: 'P1', note: null, amount: 0 }]));
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
