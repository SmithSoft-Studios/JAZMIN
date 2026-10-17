import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { testBuild, testTrust } from '../scripts/publisher-test-build.mjs';
import '../browser/jazmin-browser-core.js';
import '../browser/jazmin-browser-publisher.js';

// The browser reader's verifyPublisher (spec 6.9): its test build gives the results spec/fixtures/publisher/expected.json
// names, as the library does (publisher.test.js); the released script trusts no root but SmithSoft's.

const J = globalThis.JazminBrowser;
const released = J.verifyPublisher;
const js = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(js, '../spec/fixtures/publisher');
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const revocationList = fs.readFileSync(path.join(dir, expected.revocationList), 'utf8').trim();
const file = (name) => new Uint8Array(fs.readFileSync(path.join(dir, name)));

// The test build of the add-on, loaded over the released one (the core stays the same).
vm.runInThisContext(testBuild(fs.readFileSync(path.join(js, 'browser/jazmin-browser-publisher.js'), 'utf8'), { at: expected.verifyAt }));
const verify = (input, options = {}) => J.verifyPublisher(input, { revocationList, ...options });
const SHOWN = new Set(['certified', 'withdrawn', 'superseded']);
const IDENTITY = ['name', 'organization', 'registration', 'country', 'domain', 'kind', 'code', 'documentKind', 'credential', 'signedAt', 'timestamp'];

function check(result, want, withKey) {
  for (const [name, value] of Object.entries(want)) {
    assert.deepEqual(result[name], name === 'facts' && want.factsNeedKey && !withKey ? null : value, name);
  }
  assert.equal(result.test, true);
  if (!SHOWN.has(want.status)) {
    for (const name of IDENTITY) assert.equal(result[name], null, name);
    assert.deepEqual(result.cosigners, []);
  }
}

for (const fixture of expected.fixtures) {
  test(`${fixture.file}: ${fixture.result.status}${fixture.result.reason ? ` (${fixture.result.reason})` : ''}`, async () => {
    check(await verify(file(fixture.file)), fixture.result, false);
    for (const [kind, text] of Object.entries(fixture.keys)) {
      if (kind === 'ownerKey') {
        // A browser never takes a shared file's master key (as open()).
        await assert.rejects(verify(file(fixture.file), { key: text }), (e) => e.masterKeyRefused === true);
      } else check(await verify(file(fixture.file), kind === 'password' ? { password: text } : { key: text }), fixture.result, true);
    }
  });
}

test('a Uint8Array, a Blob and a { size, read } source (hashed in slices) give the same result', async () => {
  for (const name of ['signed-plain.jzm', 'signed-shared.jzm', 'signed-cosigned.jzm', 'changed-byte.jzm']) {
    const bytes = file(name);
    const sliced = { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length) };
    const want = await verify(bytes);
    assert.deepEqual(await verify(new Blob([bytes])), want);
    assert.deepEqual(await verify(sliced), want);
  }
});

test('an online status answer counts for its own nonce only', async () => {
  const answer = expected.statusAnswers[0];
  const text = fs.readFileSync(path.join(dir, answer.file), 'utf8').trim();
  const online = await verify(file(answer.for), { statusAnswer: { answer: text, nonce: answer.nonce } });
  assert.equal(online.status, 'certified');
  assert.equal(online.checkedAt, answer.time);
  assert.deepEqual(await verify(file(answer.for), { statusAnswer: { answer: text, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' } }), await verify(file(answer.for)));
});

test('the released script trusts no test root: a certified file shows as signed, with nothing from its certificate', async () => {
  const result = await released(file('signed-plain.jzm'), { revocationList });
  assert.equal(result.status, 'signed');
  assert.equal(result.name, null);
  assert.equal(result.test, undefined);
  assert.equal((await released(file('unsigned.jzm'))).status, 'none');
  const root = testTrust().roots[0];
  for (const name of ['jazmin-browser.js', 'jazmin-browser-publisher.js']) {
    assert.ok(!fs.readFileSync(path.join(js, 'browser', name), 'utf8').includes(root.slice(0, 64)), `${name} holds the test root`);
  }
});

test('SHA-256 in pieces gives what one-shot SHA-256 gives, wherever the pieces split', () => {
  const { sha256Stream } = J[Symbol.for('jazmin.browser.internals')];
  const data = crypto.randomBytes(200_000);
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 200_000]) {
    const bytes = new Uint8Array(data.subarray(0, length));
    const want = crypto.createHash('sha256').update(bytes).digest('hex');
    for (const piece of [1, 7, 64, 100, 65_537, Infinity]) {
      const hash = sha256Stream();
      for (let at = 0; at < length; at += piece) hash.update(bytes.subarray(at, Math.min(length, at + piece)));
      assert.equal(Buffer.from(hash.digest()).toString('hex'), want, `${length} bytes in pieces of ${piece}`);
    }
  }
});
