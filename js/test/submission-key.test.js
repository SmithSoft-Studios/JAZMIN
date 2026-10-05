import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminKey, accessKeyOf, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

// Submission keys (spec 7.8, issue #13): the key of the files an access key's holder sends back to the owner. The
// owner derives it from its own key and the access key's id, and the writer seals it into that key's slot of the shared
// file: only someone who opens the shared file with that access key (and its unlock token, for an online grant) has it.
// A leaked access key without the file can't make a file the owner accepts.

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const { JazminBrowser } = globalThis;

function shared() {
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const sally = owner.createAccessKey();
  const carol = owner.createAccessKey();
  const bytes = write(null, [{ id: 1, person: 'P1' }, { id: 2, person: 'P2' }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }], key: owner,
    access: { partitionBy: 'person', grants: [{ key: bob, rows: ['P1'] }, { key: sally, rows: ['P2'] }, { key: carol, rows: ['P2'], mode: 'online' }] },
  });
  return { owner, bob, sally, carol, bytes };
}

test('the submission key is HKDF-SHA256 of the owner key, labelled with the access key id (spec 7.8)', () => {
  const owner = new JazminKey(Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
  const key = owner.submissionKey('0001020304050607');
  assert.equal(key.bytes.toString('hex'), '457ac056dd344efb467cdc8a574b1469c328daafd2f09fe14782cd2818ecf29e'); // the RFC's test vector
  assert.ok(key.bytes.equals(Buffer.from(crypto.hkdfSync('sha256', owner.bytes, Buffer.alloc(0), Buffer.from('JAZMIN/1/submission/0001020304050607'), 32))));
  const bob = owner.createAccessKey();
  assert.equal(owner.submissionKey(bob).toString(), owner.submissionKey(bob.id).toString());
  assert.equal(owner.submissionKey(bob.toString()).toString(), owner.submissionKey(bob.id).toString());
  assert.throws(() => owner.submissionKey(owner), /belongs to an access key/);
});

test('only a key that opened the shared file has its submission key, and the owner derives the same', () => {
  const { owner, bob, sally, carol, bytes } = shared();
  const bobs = open(bytes, { key: bob });
  assert.equal(bobs.submissionKey.toString(), owner.submissionKey(bob.id).toString());
  assert.notEqual(open(bytes, { key: sally }).submissionKey.toString(), bobs.submissionKey.toString());
  assert.equal(open(bytes, { key: owner }).submissionKey, null); // the owner derives anyone's
  // An online grant: opening needs the unlock token, so the submission key does too.
  assert.throws(() => open(bytes, { key: carol }), /unlock token/);
  // Files written before submission keys existed have none, until the owner's next rewrite.
  const bob1 = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8')).bob;
  assert.equal(open(path.join(fixtures, 'js-files-access.jzm'), { key: bob1, accessState: false }).submissionKey, null);
});

test('a file sent with the submission key opens for the owner only with that holder key', async () => {
  const { owner, bob, sally, bytes } = shared();
  const reader = await JazminBrowser.open(new Blob([bytes]), { key: bob.toString() }); // a phone opens the shared file
  assert.equal(reader.submissionKey, owner.submissionKey(bob.id).toString());
  const sent = Buffer.from(await (await JazminBrowser.write([{ id: 3, person: 'P1' }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }], key: reader.submissionKey,
  })).arrayBuffer());
  assert.deepEqual([...open(sent, { key: owner.submissionKey(bob.id) }).rows()], [{ id: 3, person: 'P1' }]);
  assert.throws(() => open(sent, { key: owner.submissionKey(sally.id) }), /key/i);
  assert.throws(() => open(bytes, { key: owner.submissionKey(bob.id) }), /key/i); // it opens nothing in the shared file
  assert.equal((await JazminBrowser.open(new Blob([bytes]), { key: owner.toString() }).catch((e) => e)).masterKeyRefused, true);
});

test('accessKeyOf still finds a key in the grant list, for checking a sender', () => {
  const { owner, bob, bytes } = shared();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-submission-')), 'shared.jzm');
  fs.writeFileSync(file, bytes);
  assert.equal(accessKeyOf(file, owner, bob.id).toString(), bob.toString());
});

test('reads the submission key the .NET writer sealed', () => {
  const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
  const owner = JazminKey.parse(keys.key);
  const reader = open(path.join(fixtures, 'dotnet-access.jzm'), { key: keys.bob, accessState: false });
  try {
    assert.equal(reader.submissionKey.toString(), owner.submissionKey(keys.bob).toString());
  } finally {
    reader.close();
  }
});
