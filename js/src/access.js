// Access-controlled files (spec 7.6): partitions and column groups, their secrets, key slots and the owner signature.
import crypto from 'node:crypto';
import { DEFAULT_COLUMN_GROUP, PUBLIC_KEY_SIZE, SIGNATURE_SIZE } from './constants.js';
import { JazminFormatError, JazminKeyError, JazminUnlockRequiredError, JazminValidationError } from './errors.js';
import { grantExpiry } from './expiry.js';
import {
  HkdfKeys, JazminAccessKey, decrypt, encrypt, fingerprint, hkdf, ownerSigning, parseAnyKey, sha256, sign, slotId, verify,
} from './keys.js';

const GROUP_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PARTITION_TYPES = new Set(['string', 'int']);
const SIGNATURE_LABEL = Buffer.from('JAZMIN/1/signature');
const SLOT_ID_SIZE = 8;
const SLOT_ENTRY_SIZE = SLOT_ID_SIZE + 8; // id | offset u32 | length u32
const ONLINE_SLOT = 0x80000000; // high bit of a slot's length: opening it also needs an unlock token

/** Name of the partition a value belongs to (null -> ""). */
export function partitionName(value) {
  return value === null || value === undefined ? '' : String(value);
}

function normalizeGrantList(value, what) {
  if (value === undefined || value === '*') return '*';
  if (!Array.isArray(value)) throw new JazminValidationError(`grant ${what} must be '*' or an array`);
  return value.map((v) => String(v));
}

/**
 * Validates writer `access` options against the schema:
 *   { partitionBy?, columnGroups?: { name: [columns] },
 *     grants?: [{ key, rows, columns, files, label, expires | expiresIn, mode: 'offline' | 'online' }] }
 * `rows` lists the partitions a grant opens. Grants that have already expired at `now` are dropped
 * (counted in `expiredGrants`).
 */
export function normalizeAccess(access, columns, now = Date.now()) {
  checkAccessOptions(access);
  const table = normalizeTableAccess(access, columns);
  return { ...table, ...normalizeGrants(access.grants, new Set(table.columnGroups.map((g) => g.name)), now) };
}

export function checkAccessOptions(access) {
  if (access === null || typeof access !== 'object') throw new JazminValidationError('access must be an object');
  if (access.rowGroupBy !== undefined) throw new JazminValidationError('access.rowGroupBy is now access.partitionBy');
}

/** One table's partition column and column groups (spec 7.6.2): { partitionBy, partitionCol, columnGroups: [{ name, cols }] }. */
export function normalizeTableAccess({ partitionBy, columnGroups }, columns) {
  let partitionCol = -1;
  if (partitionBy !== undefined && partitionBy !== null) {
    partitionCol = columns.findIndex((c) => c.name === partitionBy);
    if (partitionCol < 0) throw new JazminValidationError(`partitionBy: unknown column '${partitionBy}'`);
    if (!PARTITION_TYPES.has(columns[partitionCol].type)) throw new JazminValidationError('partitionBy must be a string or int column');
  }

  const assigned = new Map();
  const named = [];
  for (const [name, members] of Object.entries(columnGroups ?? {})) {
    if (name === DEFAULT_COLUMN_GROUP || !GROUP_NAME.test(name)) throw new JazminValidationError(`Invalid column group name '${name}'`);
    if (!Array.isArray(members) || members.length === 0) throw new JazminValidationError(`Column group '${name}' needs at least one column`);
    const cols = members.map((m) => {
      const i = columns.findIndex((c) => c.name === m);
      if (i < 0) throw new JazminValidationError(`Column group '${name}': unknown column '${m}'`);
      if (assigned.has(i)) throw new JazminValidationError(`Column '${m}' is in two column groups`);
      assigned.set(i, name);
      return i;
    });
    named.push({ name, cols: cols.sort((a, b) => a - b) });
  }
  if (partitionCol >= 0 && assigned.has(partitionCol)) {
    throw new JazminValidationError(`The partition column '${partitionBy}' must stay in the default column group`);
  }
  const rest = columns.map((_, i) => i).filter((i) => !assigned.has(i));
  return {
    partitionBy: partitionCol >= 0 ? columns[partitionCol].name : null,
    partitionCol,
    columnGroups: [...(rest.length ? [{ name: DEFAULT_COLUMN_GROUP, cols: rest }] : []), ...named],
  };
}

/**
 * The file's grants: { grants, expiredGrants }. `groupNames` are the column groups a grant may name (those of
 * every table); grants that have already expired at `now` are left out and counted.
 */
export function normalizeGrants(list, groupNames, now) {
  const grants = (list ?? []).map((g, n) => {
    const key = parseAnyKey(g?.key);
    if (!(key instanceof JazminAccessKey)) throw new JazminValidationError(`grant ${n}: key must be an access key (jza1-...)`);
    const cols = normalizeGrantList(g.columns, 'columns');
    if (cols !== '*') {
      for (const c of cols) if (!groupNames.has(c)) throw new JazminValidationError(`grant ${n}: unknown column group '${c}'`);
    }
    const mode = g.mode ?? 'offline';
    if (mode !== 'offline' && mode !== 'online') throw new JazminValidationError(`grant ${n}: mode must be 'offline' or 'online'`);
    return {
      key,
      rows: normalizeGrantList(g.rows, 'rows'),
      columns: cols,
      files: g.files === undefined ? [] : normalizeGrantList(g.files, 'files'), // extra file groups (embedded files)
      label: g.label === undefined ? undefined : String(g.label),
      expires: grantExpiry(g, now),
      mode,
      // An online grant's share is held by the owner's key service; it stays the same across versions.
      share: mode === 'online' ? (g.share ? Buffer.from(g.share, 'base64') : crypto.randomBytes(32)) : undefined,
    };
  });
  const expiredGrants = grants.filter((g) => g.expires !== undefined && g.expires <= now).length;
  const seen = new Set();
  for (const g of grants) {
    if (seen.has(g.key.id)) throw new JazminValidationError(`The same access key is granted twice (${g.key.id})`);
    seen.add(g.key.id);
  }
  return { grants: grants.filter((g) => g.expires === undefined || g.expires > now), expiredGrants };
}

/**
 * Secrets of one version of a file (every rewrite generates new ones; spec 7.6.3). Only `header` and
 * `owner` are random; partition and column-group secrets are derived from `owner`, so the owner's key
 * slot stays tiny however many partitions there are. Access keys receive only the derived secrets of
 * their groups, from which nothing else can be derived.
 */
export class FileSecrets {
  constructor(salt, header = crypto.randomBytes(32), owner = crypto.randomBytes(32)) {
    this.salt = salt;
    this.header = header;
    this.owner = owner;
    this.idKey = hkdf(owner, salt, 'JAZMIN/1/partition-id');
    this.partitionNames = new Map(); // partition id (base64url) -> name, for partitions present in the file
    this.columnSecrets = new Map();
    this.partitionSecrets = new Map(); // derived once per partition
  }

  /** Opaque, owner-keyed id (base64url of 12 bytes) for a partition or file-group name. */
  partitionId(name) {
    return groupId(this.idKey, name);
  }

  /** Records a partition name and returns its id. */
  addPartition(name) {
    const id = this.partitionId(name);
    this.partitionNames.set(id, name);
    return id;
  }

  partitionSecret(id) {
    let secret = this.partitionSecrets.get(id);
    if (!secret) this.partitionSecrets.set(id, (secret = hkdf(this.owner, this.salt, `JAZMIN/1/partition/${id}`)));
    return secret;
  }

  /** Secret of a file group (embedded files, spec 6.8): opens that group's file directory. */
  fileGroupSecret(id) {
    return hkdf(this.owner, this.salt, `JAZMIN/1/file-group/${id}`);
  }

  columnSecret(name) {
    let secret = this.columnSecrets.get(name);
    if (!secret) this.columnSecrets.set(name, (secret = hkdf(this.owner, this.salt, `JAZMIN/1/column-group/${name}`)));
    return secret;
  }
}

export function groupId(idKey, name) {
  return crypto.createHmac('sha256', idKey).update(name, 'utf8').digest().subarray(0, 12).toString('base64url');
}

export const headerKey = (headerSecret, salt) => hkdf(headerSecret, salt, 'JAZMIN/1/header');
export const ownerDirectoryKey = (ownerSecret, salt) => hkdf(ownerSecret, salt, 'JAZMIN/1/owner');
// HKDF extract steps, kept per secret (secrets are long-lived Buffers: a file's, or a key's from its slot).
const extracted = new WeakMap(); // secret -> HkdfKeys
const extractedPairs = new WeakMap(); // partition secret -> Map(column secret -> HkdfKeys)

function keysFor(secret, salt) {
  let keys = extracted.get(secret);
  if (!keys || !keys.salt.equals(salt)) extracted.set(secret, (keys = new HkdfKeys(secret, salt)));
  return keys;
}

/** Key of a section derived from one secret: HKDF(secret, salt, "JAZMIN/1/" || section id) (spec 7.6.3). */
export const sectionKeyFrom = (secret, salt, sectionId) => keysFor(secret, salt).key(`JAZMIN/1/${sectionId}`);

/** Chunk parts and statistics: locked by both the partition's and the column group's secrets. */
export function partKey(partitionSecret, columnSecret, salt, sectionId) {
  let byColumn = extractedPairs.get(partitionSecret);
  if (!byColumn) extractedPairs.set(partitionSecret, (byColumn = new Map()));
  let keys = byColumn.get(columnSecret);
  if (!keys || !keys.salt.equals(salt)) byColumn.set(columnSecret, (keys = new HkdfKeys(Buffer.concat([partitionSecret, columnSecret]), salt)));
  return keys.key(`JAZMIN/1/${sectionId}`);
}

function slotAad(fileId, id) {
  return Buffer.concat([fileId, id]);
}

/** Key that seals a slot: from the key's secret, plus the server-held share for online grants. */
function slotKek(secret, share, salt) {
  return hkdf(share ? Buffer.concat([secret, share]) : secret, salt, 'JAZMIN/1/slot');
}

/** Seals a bundle for the holder of `secret` (and, for online grants, of `share`): { id, sealed, online }. */
export function sealSlot(secret, salt, fileId, bundle, share) {
  const id = slotId(secret);
  return { id, sealed: encrypt(slotKek(secret, share, salt), Buffer.from(JSON.stringify(bundle), 'utf8'), slotAad(fileId, id)), online: Boolean(share) };
}

/**
 * Returns the bundle sealed for this secret, or null when the file has no slot for it.
 * An online slot also needs `share` (from an unlock token); without it JazminUnlockRequiredError is thrown.
 */
export function unsealSlot(keySlots, secret, salt, fileId, share) {
  const id = slotId(secret);
  const slot = findSlot(keySlots, id);
  if (!slot) return null;
  if (slot.online && !share) {
    throw new JazminUnlockRequiredError('This key needs an unlock token from the file owner\'s key service',
      { fileId: fileId.toString('hex'), keyId: id.toString('hex') });
  }
  try {
    return JSON.parse(decrypt(slotKek(secret, slot.online ? share : undefined, salt), slot.sealed, slotAad(fileId, id)).toString('utf8'));
  } catch (error) {
    if (slot.online) throw new JazminKeyError('The unlock token is not valid for this key and file');
    throw error;
  }
}

/** What the owner signs: the key-slot list section (which holds each page's digest) and the header section. */
function signatureMessage(fileId, keySlotsSection, headerSection) {
  return Buffer.concat([SIGNATURE_LABEL, fileId, sha256(keySlotsSection), sha256(headerSection)]);
}

/** Target raw size of a key-slot page (spec 7.6.4): a key holder reads the page list and one page. */
export const KEY_SLOT_PAGE_BYTES = 16 * 1024;
const PAGE_ENTRY_SIZE = SLOT_ID_SIZE + 8 + 4 + 32; // first slot id | offset u64 | length u32 | SHA-256 of the page section

/**
 * The key slots in pages of about `pageBytes` raw bytes, sorted by slot id (spec 7.6.4): [{ firstId, raw }], each
 * `raw` a key-slot page: u32 count | count x (id(8) | offset u32 | length u32), sorted by id | sealed bundles.
 */
export function buildKeySlotPages(slots, pageBytes = KEY_SLOT_PAGE_BYTES) {
  const sorted = [...slots].sort((a, b) => Buffer.compare(a.id, b.id));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].id.equals(sorted[i - 1].id)) throw new JazminValidationError('Two keys share a slot id');
  }
  const pages = [];
  let page = [];
  let size = 4;
  for (const slot of sorted) {
    const bytes = SLOT_ENTRY_SIZE + slot.sealed.length;
    if (page.length > 0 && size + bytes > pageBytes) {
      pages.push(page);
      page = [];
      size = 4;
    }
    page.push(slot);
    size += bytes;
  }
  if (page.length > 0) pages.push(page);
  return pages.map((list) => ({ firstId: list[0].id, raw: keySlotPage(list) }));
}

function keySlotPage(sorted) {
  const table = Buffer.alloc(4 + sorted.length * SLOT_ENTRY_SIZE);
  table.writeUInt32LE(sorted.length, 0);
  let offset = 0;
  sorted.forEach((slot, i) => {
    const at = 4 + i * SLOT_ENTRY_SIZE;
    slot.id.copy(table, at);
    table.writeUInt32LE(offset, at + SLOT_ID_SIZE);
    table.writeUInt32LE((slot.sealed.length | (slot.online ? ONLINE_SLOT : 0)) >>> 0, at + SLOT_ID_SIZE + 4);
    offset += slot.sealed.length;
  });
  return Buffer.concat([table, ...sorted.map((s) => s.sealed)]);
}

/**
 * The page list (section `keyslots`, the one the owner signs): u32 count | count x (first slot id(8) | offset u64 |
 * length u32 | SHA-256(page section)(32)), sorted by first slot id. `pages` are [{ firstId, offset, length, digest }].
 */
export function buildKeySlotList(pages) {
  const list = Buffer.alloc(4 + pages.length * PAGE_ENTRY_SIZE);
  list.writeUInt32LE(pages.length, 0);
  pages.forEach((p, i) => {
    const at = 4 + i * PAGE_ENTRY_SIZE;
    p.firstId.copy(list, at);
    list.writeBigUInt64LE(BigInt(p.offset), at + SLOT_ID_SIZE);
    list.writeUInt32LE(p.length, at + SLOT_ID_SIZE + 8);
    p.digest.copy(list, at + SLOT_ID_SIZE + 12);
  });
  return list;
}

/** The page of a key-slot list that holds slot `id` (the last page whose first id is <= id): { index, offset, length, digest }, or null. */
export function findKeySlotPage(list, id) {
  if (list.length < 4) throw new JazminFormatError('Key-slot list is truncated');
  const count = list.readUInt32LE(0);
  if (list.length !== 4 + count * PAGE_ENTRY_SIZE) throw new JazminFormatError('Key-slot list has the wrong length');
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const at = 4 + mid * PAGE_ENTRY_SIZE;
    if (Buffer.compare(list.subarray(at, at + SLOT_ID_SIZE), id) <= 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null; // below the first page: no slot
  const at = 4 + (lo - 1) * PAGE_ENTRY_SIZE;
  return {
    index: lo - 1,
    offset: Number(list.readBigUInt64LE(at + SLOT_ID_SIZE)),
    length: list.readUInt32LE(at + SLOT_ID_SIZE + 8),
    digest: list.subarray(at + SLOT_ID_SIZE + 12, at + PAGE_ENTRY_SIZE),
  };
}

/** Parses a key-slot page (see buildKeySlotPages). */
export function parseKeySlots(raw) {
  if (raw.length < 4) throw new JazminFormatError('Key-slot page is truncated');
  const count = raw.readUInt32LE(0);
  const tableAt = 4;
  const blobsAt = tableAt + count * SLOT_ENTRY_SIZE;
  if (blobsAt > raw.length) throw new JazminFormatError('Key-slot page is truncated');
  return { raw, count, tableAt, blobsAt, signedLength: raw.length };
}

/** Signature section payload (spec 7.6.4): owner public key (65) | ECDSA P-256 signature (64, r||s). */
export function buildSignature(ownerKeyBytes, fileId, keySlotsSection, headerSection) {
  const { privateKey, publicKey } = ownerSigning(ownerKeyBytes);
  return Buffer.concat([publicKey, sign(privateKey, signatureMessage(fileId, keySlotsSection, headerSection))]);
}

/** Binary search of the slot table; returns { sealed, online } or null. */
function findSlot(keySlots, id) {
  const { raw, tableAt, blobsAt, signedLength } = keySlots;
  let lo = 0;
  let hi = keySlots.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = tableAt + mid * SLOT_ENTRY_SIZE;
    const c = Buffer.compare(raw.subarray(at, at + SLOT_ID_SIZE), id);
    if (c === 0) {
      const start = blobsAt + raw.readUInt32LE(at + SLOT_ID_SIZE);
      const length = raw.readUInt32LE(at + SLOT_ID_SIZE + 4);
      const end = start + (length & ~ONLINE_SLOT);
      if (end > signedLength) throw new JazminFormatError('Key slot points outside its page');
      return { sealed: raw.subarray(start, end), online: (length & ONLINE_SLOT) !== 0 };
    }
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/**
 * Checks that the key slots and header were signed by the owner who issued `key` (spec 7.6.6):
 * an owner key must match the signing public key; an access key must match its fingerprint.
 */
export function verifyOwner(signatureRaw, fileId, keySlotsSection, headerSection, key) {
  if (signatureRaw.length !== PUBLIC_KEY_SIZE + SIGNATURE_SIZE) throw new JazminFormatError('Signature section has the wrong length');
  const owner = signatureRaw.subarray(0, PUBLIC_KEY_SIZE);
  const expectedOwner = key instanceof JazminAccessKey
    ? fingerprint(owner).equals(key.ownerFingerprint)
    : owner.equals(ownerSigning(key.bytes).publicKey);
  if (!expectedOwner) throw new JazminKeyError('This file was not signed by the owner of this key');
  if (!verify(Buffer.from(owner), signatureMessage(fileId, keySlotsSection, headerSection), signatureRaw.subarray(PUBLIC_KEY_SIZE))) {
    throw new JazminFormatError("The file's owner signature is invalid - the file was modified");
  }
}

/** SHA-256 of a whole section (spec 7.6.5). */
export function digest(section) {
  return sha256(section);
}
