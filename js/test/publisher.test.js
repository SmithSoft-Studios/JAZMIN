import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminKeyError, JazminValidationError, verifyPublisher } from '../src/index.js';
import { verifyPublisher as verifyWith } from '../src/publisher.js';

// Publisher signatures (spec 6.9): every file of spec/fixtures/publisher gives the result expected.json names, with the
// test PKI's root, the revocation list and the files' keys. Mirrors dotnet/tests/Jazmin.Tests/PublisherTests.cs.

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures/publisher');
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const trust = { roots: expected.trustedRoots.map((p) => fs.readFileSync(path.join(dir, p))), arc: '2.999.1', at: new Date(expected.verifyAt) };
const revocationList = fs.readFileSync(path.join(dir, expected.revocationList), 'utf8').trim();
const IDENTITY = ['name', 'organization', 'registration', 'country', 'domain', 'kind', 'code', 'documentKind', 'credential', 'signedAt', 'timestamp'];
const SHOWN = new Set(['certified', 'withdrawn', 'superseded']);

function verify(file, options = {}) {
  return verifyWith(path.join(dir, file), { revocationList, ...options }, trust);
}

function check(result, want, withKey) {
  for (const [name, value] of Object.entries(want)) {
    const expect = name === 'facts' && want.factsNeedKey && !withKey ? null : value;
    assert.deepEqual(result[name], expect, name);
  }
  if (!SHOWN.has(want.status)) {
    // Nothing from the certificate or the document is shown (6.9.8).
    for (const name of IDENTITY) assert.equal(result[name], null, name);
    assert.deepEqual(result.cosigners, []);
    assert.equal(result.statusAnswer, null);
  }
}

const option = { password: 'password', key: 'key', ownerKey: 'key', accessKey: 'key' };

for (const fixture of expected.fixtures) {
  test(`${fixture.file}: ${fixture.result.status}${fixture.result.reason ? ` (${fixture.result.reason})` : ''}`, () => {
    check(verify(fixture.file), fixture.result, false);
    for (const [kind, text] of Object.entries(fixture.keys)) check(verify(fixture.file, { [option[kind]]: text }), fixture.result, true);
  });
}

test('a path and a Buffer give the same result', () => {
  for (const file of ['signed-plain.jzm', 'signed-shared.jzm', 'changed-gap.jzm', 'unsigned.jzm']) {
    assert.deepEqual(verifyWith(fs.readFileSync(path.join(dir, file)), { revocationList }, trust), verify(file));
  }
});

test('a key or password that does not open the file leaves the facts unread', () => {
  const result = verify('signed-password.jzm', { password: 'not the password' });
  assert.equal(result.status, 'certified');
  assert.equal(result.facts, null);
  assert.equal(verify('signed-cosigned.jzm', { key: expected.secrets.ownerKey }).facts, null);
  assert.equal(verify('signed-shared.jzm', { key: expected.secrets.key }).facts, null); // no slot for it
});

test('an online status answer counts for its own nonce only', () => {
  const answer = expected.statusAnswers[0];
  const text = fs.readFileSync(path.join(dir, answer.file), 'utf8').trim();
  const online = verify(answer.for, { statusAnswer: { answer: text, nonce: answer.nonce } });
  assert.equal(online.status, 'certified');
  assert.equal(online.checkedAt, answer.time);
  const replayed = verify(answer.for, { statusAnswer: { answer: text, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' } });
  assert.deepEqual(replayed, verify(answer.for));
  assert.notEqual(replayed.checkedAt, answer.time);
});

test('a revocation list or status answer that does not verify is ignored', () => {
  // revoked.jzm: its stored status says valid, and only the list revokes it.
  assert.equal(verifyWith(path.join(dir, 'revoked.jzm'), {}, trust).status, 'certified');
  const [header, payload, signature] = revocationList.split('.');
  const forged = [header, payload, `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`].join('.');
  assert.equal(verify('revoked.jzm', { revocationList: forged }).status, 'certified');
  assert.equal(verify('revoked.jzm').status, 'invalid');
  const answer = expected.statusAnswers[0];
  const text = fs.readFileSync(path.join(dir, answer.file), 'utf8').trim();
  const parts = text.split('.');
  const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  parts[1] = Buffer.from(JSON.stringify({ ...body, status: 'withdrawn', from: body.time })).toString('base64url');
  assert.equal(verify(answer.for, { statusAnswer: { answer: parts.join('.'), nonce: answer.nonce } }).status, 'certified');
});

test('a file that is not JAZMIN is not verified', () => {
  const bytes = fs.readFileSync(path.join(dir, 'signed-plain.jzm'));
  bytes[0] ^= 1; // the preamble's magic
  const result = verifyWith(bytes, {}, trust);
  assert.equal(result.status, 'not-verified');
  assert.equal(result.reason, 'not-a-valid-file');
});

test('only the built-in roots are trusted: none yet, so a certified file shows as signed', () => {
  const file = path.join(dir, 'signed-plain.jzm');
  const result = verifyPublisher(file, { revocationList });
  assert.equal(result.status, 'signed');
  assert.equal(result.name, null);
  assert.equal(result.facts, null);
  assert.equal(verifyPublisher(file, {}, trust).status, 'signed'); // the public function takes no trust
  assert.equal(verifyPublisher(path.join(dir, 'unsigned.jzm')).status, 'none');
  assert.equal(verifyPublisher(path.join(dir, 'changed-byte.jzm')).status, 'changed');
});

test('options are checked', () => {
  const file = path.join(dir, 'signed-plain.jzm');
  assert.throws(() => verifyPublisher(file, { revocationList: 42 }), JazminValidationError);
  assert.throws(() => verifyPublisher(file, { statusAnswer: 'text' }), JazminValidationError);
  assert.throws(() => verifyPublisher(file, { key: 'jzk1-mistyped' }), JazminKeyError);
});
