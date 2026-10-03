// Owner-side tools for online grants (spec section 7.7): a key service issues unlock tokens.
import { JazminAccessExpiredError, JazminValidationError } from './errors.js';
import { toMs } from './expiry.js';
import { JazminAccessKey, encodeUnlockToken, parseAnyKey } from './keys.js';
import { JazminReader, OWNER_GRANTS } from './reader.js';
import { DRAFT_MAGIC, FLAG_ACCESS, FLAG_APPENDED, FLAG_ENCRYPTED, FLAG_PASSWORD, MAGIC, PREAMBLE_SIZE } from './constants.js';
import { JazminFormatError } from './errors.js';
import fs from 'node:fs';

function ownerGrants(path, ownerKey) {
  const reader = new JazminReader(path, { key: ownerKey });
  try {
    const owner = reader[OWNER_GRANTS];
    if (!owner) throw new JazminValidationError('Unlock tokens exist only for access-controlled files, and need the owner key');
    return { grants: owner.grants };
  } finally {
    reader.close();
  }
}

/**
 * Lists the unlock tokens of a file's online grants, for a key service that stores them:
 * [{ keyId, label?, expires?, token }]. Owner key required. Tokens stay valid across updates and
 * appends of the file; a grant's token stops being issued (issueUnlockToken) once it expires.
 */
export function listUnlockTokens(path, ownerKey) {
  return ownerGrants(path, ownerKey).grants
    .filter((g) => g.mode === 'online' && g.share)
    .map((g) => ({
      keyId: JazminAccessKey.parse(g.key).id,
      ...(g.label === undefined ? {} : { label: g.label }),
      ...(g.expires ? { expires: g.expires } : {}),
      token: encodeUnlockToken(Buffer.from(g.share, 'base64')),
    }));
}

/**
 * What a key service calls before handing a token to a user: returns the unlock token for an
 * online grant if it exists and has not expired at `now`, otherwise throws.
 * `accessKey` may be the key, its text, or its id (hex).
 */
export function issueUnlockToken(path, ownerKey, accessKey, { now } = {}) {
  const keyId = typeof accessKey === 'string' && /^[0-9a-f]{16}$/.test(accessKey) ? accessKey : parseAnyKey(accessKey).id;
  const grant = ownerGrants(path, ownerKey).grants.find((g) => JazminAccessKey.parse(g.key).id === keyId);
  if (!grant) throw new JazminValidationError(`Key ${keyId} has no grant in this file`);
  if (grant.mode !== 'online') throw new JazminValidationError(`Key ${keyId} is an offline grant - it needs no unlock token`);
  if (grant.expires && !(toMs(now) <= Date.parse(grant.expires))) { // an unreadable date counts as expired
    throw new JazminAccessExpiredError(`Access for key ${keyId} expired at ${grant.expires}`);
  }
  return encodeUnlockToken(Buffer.from(grant.share, 'base64'));
}

/**
 * Reads what can be known about a file without a key (the preamble): its id - which, with an
 * access key's id, is what a client sends to a key service - and which features it uses.
 */
export function inspect(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const preamble = Buffer.alloc(PREAMBLE_SIZE);
    const complete = fs.readSync(fd, preamble, 0, PREAMBLE_SIZE, 0) === PREAMBLE_SIZE;
    if (complete && preamble.subarray(0, 4).equals(DRAFT_MAGIC)) {
      throw new JazminFormatError('This file uses a pre-release JAZMIN draft format. Write it again from its source data.');
    }
    if (!complete || !preamble.subarray(0, 4).equals(MAGIC)) throw new JazminFormatError('Not a JAZMIN file (bad magic)');
    const flags = preamble.readUInt16LE(4);
    return {
      fileId: preamble.subarray(8, 24).toString('hex'),
      version: '1.0', // the magic names the major version; later additions are reader/writer features
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
      passwordProtected: (flags & FLAG_PASSWORD) !== 0,
      accessControlled: (flags & FLAG_ACCESS) !== 0,
      appended: (flags & FLAG_APPENDED) !== 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}
