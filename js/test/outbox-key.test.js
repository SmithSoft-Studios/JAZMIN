import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, JazminKey, accessKeyOf, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

// Outbox keys (spec 7.8, issue #13): an access key holder writes files for the owner - records captured offline and
// sent later - locked with a key derived from their access key. The owner derives the same key from the shared file's
// grant list; the key opens nothing in the shared file.

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
const { JazminBrowser } = globalThis;

test('the outbox key is HKDF-SHA256 of the access key secret with info "JAZMIN/1/outbox" (spec 7.8)', () => {
  const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const key = new JazminAccessKey(secret, Buffer.alloc(8, 7)).outboxKey();
  assert.ok(key instanceof JazminKey);
  assert.equal(key.bytes.toString('hex'), '8e729d9585b59bce5cd951fb3b5f4f81df22fbbb3088e382bd2b490c98309596'); // the RFC's test vector
  assert.ok(key.bytes.equals(Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from('JAZMIN/1/outbox'), 32))));
  assert.equal(JazminAccessKey.parse(keys.bob).outboxKey().toString(), keys.bobOutbox); // the same in .NET and the browser
});

test('the browser derives the same outbox key', async () => {
  assert.equal(await JazminBrowser.outboxKey(keys.bob), keys.bobOutbox);
  await assert.rejects(JazminBrowser.outboxKey(keys.key), /access key/);
});

test('the owner finds an access key in the grant list, and opens that holder outbox files', () => {
  const shared = path.join(dir, 'js-access.jzm');
  const bob = JazminAccessKey.parse(keys.bob);
  assert.equal(accessKeyOf(shared, keys.key, bob.id).toString(), keys.bob);
  assert.equal(accessKeyOf(shared, keys.key, bob).toString(), keys.bob); // the key itself also names it
  assert.throws(() => accessKeyOf(shared, keys.key, '0123456789abcdef'), /has no grant in this file/);
  assert.throws(() => accessKeyOf(shared, keys.bob, bob.id), /owner/);

  // Bob writes an outbox batch; the owner opens it with the key derived from the grant list.
  const batch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-outbox-')), 'batch.jzm');
  write(batch, [{ id: 1, note: 'captured offline' }], { columns: [{ name: 'id', type: 'int' }, { name: 'note', type: 'string' }], key: bob.outboxKey() });
  const reader = open(batch, { key: accessKeyOf(shared, keys.key, bob.id).outboxKey() });
  assert.deepEqual([...reader.rows()], [{ id: 1, note: 'captured offline' }]);
  reader.close();
  assert.throws(() => open(batch, { key: JazminAccessKey.parse(keys.sally).outboxKey() }), /key/i); // someone else's outbox key
  assert.throws(() => open(shared, { key: bob.outboxKey() }), /key/i); // the outbox key opens nothing in the shared file
});
