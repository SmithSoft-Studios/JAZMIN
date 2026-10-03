import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JazminKey, JazminKeyError } from '../src/index.js';
import { HkdfKeys, decrypt, encrypt, hkdf } from '../src/keys.js';
import crypto from 'node:crypto';

test('key text round-trips and starts with the version prefix', () => {
  const key = JazminKey.generate();
  const text = key.toString();
  assert.match(text, /^jzk1-[A-Za-z0-9_-]{48}$/);
  assert.deepEqual(JazminKey.parse(text).bytes, key.bytes);
});

test('a mistyped key is rejected by its checksum', () => {
  const text = JazminKey.generate().toString();
  const last = text.at(-10);
  const typo = text.slice(0, -10) + (last === 'A' ? 'B' : 'A') + text.slice(-9);
  assert.throws(() => JazminKey.parse(typo), (e) => e instanceof JazminKeyError && /checksum|length/.test(e.message));
});

test('keys must be 32 bytes', () => {
  assert.throws(() => new JazminKey(Buffer.alloc(16)), JazminKeyError);
});

test('HKDF-SHA256 matches RFC 5869 test case 1', () => {
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
  const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
  // First 32 bytes of the RFC's 42-byte OKM
  assert.equal(
    hkdf(ikm, salt, info).toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf',
  );
});

test('AES-GCM detects tampering and wrong AAD', () => {
  const key = JazminKey.generate().bytes;
  const sealed = encrypt(key, Buffer.from('secret'), Buffer.from('aad'));
  assert.equal(decrypt(key, sealed, Buffer.from('aad')).toString(), 'secret');
  assert.throws(() => decrypt(key, sealed, Buffer.from('other')), JazminKeyError);
  sealed[15] ^= 1;
  assert.throws(() => decrypt(key, sealed, Buffer.from('aad')), JazminKeyError);
});

test('HKDF with a shared extract step gives the same keys as one-shot HKDF', () => {
  for (let i = 0; i < 50; i++) {
    const ikm = crypto.randomBytes(i % 3 ? 32 : 64);
    const salt = crypto.randomBytes(i % 5 ? 32 : 0);
    const keys = new HkdfKeys(ikm, salt);
    for (const info of [`JAZMIN/1/0/chunk/${i}/*`, 'JAZMIN/1/header', `é ${i}`]) assert.ok(keys.key(info).equals(hkdf(ikm, salt, info)), info);
  }
});
