import crypto from 'node:crypto';
import { JazminKeyError } from './errors.js';

const KEY_PREFIX = 'jzk1-';
const KEY_SIZE = 32;
const CHECKSUM_SIZE = 4;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;

/**
 * A 256-bit JAZMIN master key. Its text form ("jzk1-...") carries a 4-byte
 * SHA-256 checksum so that typos are detected before any decryption is attempted.
 */
export class JazminKey {
  #bytes;

  constructor(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_SIZE) {
      throw new JazminKeyError(`A JAZMIN key must be exactly ${KEY_SIZE} bytes`);
    }
    this.#bytes = Buffer.from(bytes);
  }

  static generate() {
    return new JazminKey(crypto.randomBytes(KEY_SIZE));
  }

  static parse(text) {
    if (typeof text !== 'string' || !text.startsWith(KEY_PREFIX)) {
      throw new JazminKeyError(`Key text must start with '${KEY_PREFIX}'`);
    }
    const raw = Buffer.from(text.slice(KEY_PREFIX.length), 'base64url');
    if (raw.length !== KEY_SIZE + CHECKSUM_SIZE) throw new JazminKeyError('Key text has the wrong length');
    const bytes = raw.subarray(0, KEY_SIZE);
    if (!checksum(bytes).equals(raw.subarray(KEY_SIZE))) {
      throw new JazminKeyError('Key checksum mismatch - the key text is mistyped or corrupted');
    }
    return new JazminKey(bytes);
  }

  /** Accepts a JazminKey, its text form, or 32 raw bytes. */
  static from(value) {
    if (value instanceof JazminKey) return value;
    if (typeof value === 'string') return JazminKey.parse(value);
    return new JazminKey(value);
  }

  get bytes() {
    return Buffer.from(this.#bytes);
  }

  toString() {
    return KEY_PREFIX + Buffer.concat([this.#bytes, checksum(this.#bytes)]).toString('base64url');
  }

  /** The owner's public signing key (65-byte uncompressed P-256 point), stable for this key. */
  get ownerPublicKey() {
    return ownerSigning(this.#bytes).publicKey;
  }

  /**
   * Creates a new access key issued by this (owner) key. Grant it rows/columns of a file
   * with the writer's `access.grants` or grantAccess(); on its own it opens nothing.
   */
  createAccessKey() {
    return new JazminAccessKey(crypto.randomBytes(KEY_SIZE), fingerprint(this.ownerPublicKey));
  }
}

const ACCESS_PREFIX = 'jza1-';
const FINGERPRINT_SIZE = 8;

/**
 * A key that opens only the parts of a file it has been granted. Its text form
 * ("jza1-...") carries the owner's fingerprint, so a reader can verify that a file was
 * signed by the same owner that issued the key.
 */
export class JazminAccessKey {
  #secret;
  #fingerprint;

  constructor(secret, ownerFingerprint) {
    if (!(secret instanceof Uint8Array) || secret.length !== KEY_SIZE) throw new JazminKeyError('An access key secret must be 32 bytes');
    if (!(ownerFingerprint instanceof Uint8Array) || ownerFingerprint.length !== FINGERPRINT_SIZE) {
      throw new JazminKeyError('An owner fingerprint must be 8 bytes');
    }
    this.#secret = Buffer.from(secret);
    this.#fingerprint = Buffer.from(ownerFingerprint);
  }

  static parse(text) {
    if (typeof text !== 'string' || !text.startsWith(ACCESS_PREFIX)) {
      throw new JazminKeyError(`Access key text must start with '${ACCESS_PREFIX}'`);
    }
    const raw = Buffer.from(text.slice(ACCESS_PREFIX.length), 'base64url');
    if (raw.length !== KEY_SIZE + FINGERPRINT_SIZE + CHECKSUM_SIZE) throw new JazminKeyError('Access key text has the wrong length');
    const body = raw.subarray(0, KEY_SIZE + FINGERPRINT_SIZE);
    if (!checksum(body).equals(raw.subarray(KEY_SIZE + FINGERPRINT_SIZE))) {
      throw new JazminKeyError('Key checksum mismatch - the key text is mistyped or corrupted');
    }
    return new JazminAccessKey(body.subarray(0, KEY_SIZE), body.subarray(KEY_SIZE));
  }

  get secret() {
    return Buffer.from(this.#secret);
  }

  get ownerFingerprint() {
    return Buffer.from(this.#fingerprint);
  }

  /**
   * The key of this holder's outbox files (spec 7.8): files they write for the owner, such as records captured offline
   * and sent later. The owner derives the same key from the shared file's grant list (accessKeyOf); it opens nothing
   * in the shared file.
   */
  outboxKey() {
    return new JazminKey(hkdf(this.#secret, Buffer.alloc(0), 'JAZMIN/1/outbox'));
  }

  /** Short public identifier (hex) of this key, safe to log. */
  get id() {
    return slotId(this.#secret).toString('hex');
  }

  toString() {
    const body = Buffer.concat([this.#secret, this.#fingerprint]);
    return ACCESS_PREFIX + Buffer.concat([body, checksum(body)]).toString('base64url');
  }
}

const UNLOCK_PREFIX = 'jzu1-';

/** Text form of an online grant's unlock share: "jzu1-" + base64url(share(32) || checksum(4)). */
export function encodeUnlockToken(share) {
  return UNLOCK_PREFIX + Buffer.concat([share, checksum(share)]).toString('base64url');
}

export function parseUnlockToken(text) {
  if (typeof text !== 'string' || !text.startsWith(UNLOCK_PREFIX)) throw new JazminKeyError(`Unlock token must start with '${UNLOCK_PREFIX}'`);
  const raw = Buffer.from(text.slice(UNLOCK_PREFIX.length), 'base64url');
  if (raw.length !== KEY_SIZE + CHECKSUM_SIZE) throw new JazminKeyError('Unlock token has the wrong length');
  const share = raw.subarray(0, KEY_SIZE);
  if (!checksum(share).equals(raw.subarray(KEY_SIZE))) throw new JazminKeyError('Unlock token checksum mismatch - the token is mistyped or corrupted');
  return Buffer.from(share);
}

/** Accepts a JazminKey / JazminAccessKey, their text forms, or 32 raw bytes (owner key). */
export function parseAnyKey(value) {
  if (value instanceof JazminAccessKey || value instanceof JazminKey) return value;
  if (typeof value === 'string' && value.startsWith(ACCESS_PREFIX)) return JazminAccessKey.parse(value);
  return JazminKey.from(value);
}

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const signingCache = new Map();

/**
 * Deterministic ECDSA P-256 signing key for an owner key (spec 7.6.1):
 *   d = (OS2IP(HKDF(master, "", "JAZMIN/1/owner-signing", 48)) mod (n - 1)) + 1
 */
export function ownerSigning(master) {
  const cacheKey = sha256(master).toString('hex'); // the cache does not hold owner keys themselves
  let entry = signingCache.get(cacheKey);
  if (entry) return entry;
  const okm = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('JAZMIN/1/owner-signing'), 48));
  const d = (BigInt(`0x${okm.toString('hex')}`) % (P256_ORDER - 1n)) + 1n;
  const dBytes = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(dBytes);
  const publicKey = ecdh.getPublicKey(); // 0x04 || X || Y
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256', d: dBytes.toString('base64url'),
      x: publicKey.subarray(1, 33).toString('base64url'), y: publicKey.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  entry = { privateKey, publicKey };
  if (signingCache.size > 16) signingCache.clear();
  signingCache.set(cacheKey, entry);
  return entry;
}

export function sign(privateKey, message) {
  return crypto.sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

export function verify(publicKey, message, signature) {
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: publicKey.subarray(1, 33).toString('base64url'), y: publicKey.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  return crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature);
}

export function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** First 8 bytes of SHA-256 of the owner's public key. */
export function fingerprint(publicKey) {
  return sha256(publicKey).subarray(0, FINGERPRINT_SIZE);
}

/** Identifier of the key slot opened by a secret (access secret or owner key bytes). */
export function slotId(secret) {
  return sha256(Buffer.from('JAZMIN/1/slot-id'), secret).subarray(0, 8);
}

function checksum(bytes) {
  return crypto.createHash('sha256').update(bytes).digest().subarray(0, CHECKSUM_SIZE);
}

export function deriveFromPassword(password, salt, iterations) {
  if (typeof password !== 'string' || password.length === 0) throw new JazminKeyError('Password must be a non-empty string');
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, KEY_SIZE, 'sha256');
}

/** HKDF-SHA256 (RFC 5869) producing a 32-byte key. */
export function hkdf(ikm, salt, info) {
  const infoBytes = typeof info === 'string' ? Buffer.from(info, 'utf8') : info;
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, infoBytes, KEY_SIZE));
}

const ONE = Buffer.from([1]);

/**
 * HKDF-SHA256 in its two steps (RFC 5869): the extract step (PRK = HMAC(salt, ikm)) is done once and shared by
 * every key derived from the same secret and salt; each key then costs one HMAC. Gives the same keys as hkdf().
 */
export class HkdfKeys {
  constructor(ikm, salt) {
    this.salt = salt;
    this.prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  }

  /** The 32-byte key for `info`: T(1) = HMAC(PRK, info || 0x01). */
  key(info) {
    return crypto.createHmac('sha256', this.prk).update(info, 'utf8').update(ONE).digest();
  }
}

/** AES-256-GCM. Output: nonce(12) || ciphertext || tag(16). */
export function encrypt(key, plaintext, aad) {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

export function decrypt(key, payload, aad) {
  if (payload.length < NONCE_SIZE + TAG_SIZE) throw new JazminKeyError('Encrypted section is too short');
  const nonce = payload.subarray(0, NONCE_SIZE);
  const tag = payload.subarray(payload.length - TAG_SIZE);
  const body = payload.subarray(NONCE_SIZE, payload.length - TAG_SIZE);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new JazminKeyError('Decryption failed - wrong key/password or the data was tampered with');
  }
}

/**
 * Key hierarchy (spec section 7):
 *   master     = key bytes, or PBKDF2-SHA256(password, salt, iterations)
 *   headerKey  = HKDF(master, salt, "JAZMIN/1/header")
 *   sectionKey = HKDF(master, keyring[group], "JAZMIN/1/" + sectionId)
 */
export class KeySchedule {
  constructor(master, salt) {
    this.master = master;
    this.headerKey = hkdf(master, salt, 'JAZMIN/1/header');
    this.keyring = null;
  }

  setKeyring(keyring) {
    this.keyring = keyring;
    this.groups = new Map();
  }

  sectionKey(group, sectionId) {
    const secret = this.keyring?.[group];
    if (!secret) throw new JazminKeyError(`Keyring has no secret for group '${group}'`);
    let keys = this.groups?.get(group);
    if (!keys || keys.salt !== secret) (this.groups ??= new Map()).set(group, (keys = new HkdfKeys(this.master, secret)));
    return keys.key(`JAZMIN/1/${sectionId}`);
  }
}
