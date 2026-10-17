import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../src/binary.js';
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

test('the key slots must lie before the block (6.9.1: every section the trailer points to is covered)', () => {
  const bytes = fs.readFileSync(path.join(dir, 'signed-shared.jzm'));
  const t = bytes.length - 44;
  assert.notEqual(bytes.readUInt32LE(t + 20), 0);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(t), t + 12); // the key slots moved to the header: after B
  bytes.writeUInt32LE(crc32(bytes.subarray(t, t + 36)), t + 36);
  const result = verifyWith(bytes, {}, trust);
  assert.equal(result.status, 'changed');
  assert.equal(result.reason, 'coverage');
});

/** A statement (6.9.5) signed with the test status key, its certificate and the issuing one in x5c. */
function statement(payload) {
  const status = fs.readFileSync(path.join(dir, 'pki/test-status.der'));
  const issuing = fs.readFileSync(path.join(dir, 'pki/test-issuing.der'));
  const header = { alg: 'ES256', 'x5t#S256': crypto.createHash('sha256').update(status).digest('base64url'), x5c: [status.toString('base64'), issuing.toString('base64')] };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'test-keys/test-status.key.pem'), 'utf8'));
  return `${input}.${crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

test('statement times are UTC strings ending in Z', () => {
  const fixture = expected.fixtures.find((f) => f.file === 'signed-plain.jzm');
  const nonce = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1)).toString('base64url');
  for (const [time, used] of [['2026-10-17T11:59:00Z', true], ['2026-10-17T11:59:00.250Z', true], ['2026-10-17T13:59:00+02:00', false],
    ['2026-10-17T11:59:00', false], ['2026-10-17T11:59:00.Z', false]]) {
    const answer = statement({ digest: fixture.fileDigest, certificate: expected.statusAnswers[0].certificate, code: fixture.result.code, status: 'valid', time, nonce });
    const result = verify('signed-plain.jzm', { statusAnswer: { answer, nonce } });
    assert.equal(result.status, 'certified', time);
    assert.equal(result.checkedAt >= '2026-10-17T11:59:00Z', used, time); // else only the older statements
  }
});

test('a revocation with a reason this reader does not know still revokes', () => {
  const list = statement({
    issued: '2026-10-16T00:00:00Z', next: '2026-10-23T00:00:00Z',
    revoked: [{ certificate: expected.statusAnswers[0].certificate, from: '2026-09-01T00:00:00Z', reason: 'notAReasonName' }],
  });
  const result = verify('signed-plain.jzm', { revocationList: list });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'revoked');
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
