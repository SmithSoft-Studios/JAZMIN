// Locked stored files (spec 6.8.1): a content's key K sealed under a lock key L, which comes from a password, a
// secret the owner's key service hands out as an unlock token, or both.
import crypto from 'node:crypto';
import { DEFAULTS, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS } from './constants.js';
import { JazminFormatError, JazminKeyError, JazminValidationError } from './errors.js';
import { checkKeyService, keyServiceAddress } from './files.js';
import { decrypt, deriveFromPassword, encrypt, hkdf } from './keys.js';

export const LOCK_KINDS = ['password', 'online', 'both'];

const SALT_SIZE = 16;
const SECRET_SIZE = 32;
const CHECKSUM_SIZE = 4;
const TOKEN_PREFIX = 'jzf1-';
const OPTIONS = new Set(['password', 'online', 'iterations', 'keyService']);

const lockInfo = (id) => `JAZMIN/1/lock/${id}`;
const sealAad = (id, contentId) => Buffer.from(`JAZMIN/1/lock/${id}/${contentId}`, 'utf8');
const needsPassword = (kind) => kind !== 'online';
const needsSecret = (kind) => kind !== 'password';

/** The lock key L of a lock { id, kind, salt, iterations } from its password and/or secret S. */
export function lockKey({ id, kind, salt, iterations }, { password, secret } = {}) {
  const fromPassword = needsPassword(kind) ? deriveFromPassword(password, salt, iterations) : null;
  if (kind === 'password') return fromPassword;
  return hkdf(kind === 'online' ? secret : Buffer.concat([fromPassword, secret]), salt, lockInfo(id));
}

/** A content's key sealed under a lock's key, as directories keep it: nonce || AES-256-GCM(K) || tag. */
export function sealContentKey(lock, contentId, contentKey) {
  return encrypt(lock.key, contentKey, sealAad(lock.id, contentId));
}

/** A content's key from its sealed form; throws JazminKeyError when L is wrong. */
export function openContentKey(lockKeyBytes, lockId, contentId, sealed) {
  return decrypt(lockKeyBytes, sealed, sealAad(lockId, contentId));
}

const checksum = (bytes) => crypto.createHash('sha256').update(bytes).digest().subarray(0, CHECKSUM_SIZE);

/** An online lock's secret as the key service hands it out: "jzf1-" + base64url(S || SHA-256(S)[0..3]). */
export function encodeFileUnlockToken(secret) {
  return TOKEN_PREFIX + Buffer.concat([secret, checksum(secret)]).toString('base64url');
}

export function parseFileUnlockToken(text) {
  if (typeof text !== 'string' || !text.startsWith(TOKEN_PREFIX)) throw new JazminKeyError(`A file unlock token starts with '${TOKEN_PREFIX}'`);
  const raw = Buffer.from(text.slice(TOKEN_PREFIX.length), 'base64url');
  if (raw.length !== SECRET_SIZE + CHECKSUM_SIZE) throw new JazminKeyError('Unlock token has the wrong length');
  const secret = raw.subarray(0, SECRET_SIZE);
  if (!checksum(secret).equals(raw.subarray(SECRET_SIZE))) throw new JazminKeyError('Unlock token checksum mismatch - the token is mistyped or corrupted');
  return Buffer.from(secret);
}

/** What a lock needs to open, in words: "its password", "an unlock token from ...", or both. */
export function lockNeeds(kind) {
  const token = "an unlock token from the file owner's key service";
  return kind === 'password' ? 'its password' : kind === 'online' ? token : `its password and ${token}`;
}

export function checkLockId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) throw new JazminValidationError('A lock id is 1 to 64 characters');
  return id;
}

/** Checks a lock's iteration count as read from a file: outside the limits it would take too long, or be too weak. */
export function checkLockIterations(lock) {
  if (needsPassword(lock.kind) && !(Number.isInteger(lock.iterations) && lock.iterations >= MIN_KDF_ITERATIONS && lock.iterations <= MAX_KDF_ITERATIONS)) {
    throw new JazminFormatError(`Lock '${lock.id}' has an iteration count outside ${MIN_KDF_ITERATIONS} to ${MAX_KDF_ITERATIONS}`);
  }
}

/**
 * The writer's locks: those the file keeps (`kept`, as the owner directory has them: { id, kind, salt, iterations, key,
 * secret }), changed by those given ({ id: { password, online, iterations } }, or null to remove one: its files stay,
 * unlocked). A changed lock gets a new salt and key; an online one keeps its secret, so issued tokens still work.
 * Returns { locks: Map(id -> lock), removed: Set(id) }.
 */
export function writerLocks(given, kept = []) {
  const locks = new Map(kept.map((l) => [l.id, l]));
  const removed = new Set();
  if (given === undefined) return { locks, removed };
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new JazminValidationError('locks must be an object of locks by id: { contracts: { password } }');
  for (const [id, options] of Object.entries(given)) {
    checkLockId(id);
    if (options === null) {
      if (!locks.delete(id)) throw new JazminValidationError(`locks: no lock '${id}' to remove`);
      removed.add(id);
      continue;
    }
    const where = `Lock '${id}'`;
    if (typeof options !== 'object' || Array.isArray(options)) throw new JazminValidationError(`${where}: give { password, online, iterations, keyService }, or null to remove it`);
    for (const name of Object.keys(options)) if (!OPTIONS.has(name)) throw new JazminValidationError(`${where}: unknown option '${name}' (password, online, iterations, keyService)`);
    const { password, online = false, iterations = DEFAULTS.kdfIterations, keyService } = options;
    if (keyService != null && online !== true) throw new JazminValidationError(`${where}: keyService is for online locks (online: true)`);
    if (password !== undefined && (typeof password !== 'string' || password.length === 0)) throw new JazminValidationError(`${where}: the password must be a non-empty string`);
    if (typeof online !== 'boolean') throw new JazminValidationError(`${where}: online must be true or false`);
    if (password === undefined && !online) throw new JazminValidationError(`${where}: give a password, online: true, or both`);
    if (password !== undefined && (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS)) {
      throw new JazminValidationError(`${where}: iterations must be from ${MIN_KDF_ITERATIONS} to ${MAX_KDF_ITERATIONS}`);
    }
    const kind = password !== undefined && online ? 'both' : online ? 'online' : 'password';
    const secret = needsSecret(kind) ? (locks.get(id)?.secret ?? crypto.randomBytes(SECRET_SIZE)) : undefined;
    // Its own key service (spec 6.8.2): as given (null: none, the file's), else the one it had.
    const service = !needsSecret(kind) || keyService === null ? undefined
      : keyService !== undefined ? checkKeyService(keyService, `${where}: keyService`) : locks.get(id)?.keyService;
    const lock = {
      id, kind, salt: crypto.randomBytes(SALT_SIZE), ...(needsPassword(kind) ? { iterations } : {}), ...(secret ? { secret } : {}),
      ...(service ? { keyService: service } : {}),
    };
    lock.key = lockKey(lock, { password, secret });
    locks.set(id, lock);
    removed.delete(id);
  }
  return { locks, removed };
}

/** Locks as the owner directory keeps them (spec 6.8.1), sorted by id. */
export function ownerLockList(locks) {
  return [...locks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((l) => ({
    id: l.id, kind: l.kind, salt: l.salt.toString('base64'), ...(l.iterations === undefined ? {} : { iterations: l.iterations }),
    key: l.key.toString('base64'), ...(l.secret ? { secret: l.secret.toString('base64') } : {}),
    ...(l.keyService ? { keyService: l.keyService } : {}),
  }));
}

/** The owner directory's locks, read: Map(id -> { id, kind, salt, iterations, key, secret }) with Buffers. */
export function readOwnerLocks(list) {
  const locks = new Map();
  if (list === undefined) return locks;
  const ok = (test) => {
    if (!test) throw new JazminFormatError("The owner directory's locks are malformed");
  };
  ok(Array.isArray(list));
  for (const l of list) {
    ok(l && typeof l.id === 'string' && LOCK_KINDS.includes(l.kind) && typeof l.salt === 'string' && typeof l.key === 'string');
    ok(!needsSecret(l.kind) || typeof l.secret === 'string');
    const key = Buffer.from(l.key, 'base64');
    ok(key.length === 32);
    locks.set(l.id, {
      id: l.id, kind: l.kind, salt: Buffer.from(l.salt, 'base64'), ...(l.iterations === undefined ? {} : { iterations: l.iterations }), key,
      ...(needsSecret(l.kind) ? { secret: Buffer.from(l.secret, 'base64') } : {}),
      ...(keyServiceAddress(l.keyService) ? { keyService: keyServiceAddress(l.keyService) } : {}),
    });
  }
  return locks;
}
