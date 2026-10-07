// Key rotation (TASKS S-2): a file encrypted with a key or password, encrypted again under a new key or password
// without decoding its rows. Every section is decrypted and encrypted again as it is stored (still compressed), under a
// new master key, file id, salt and keyring, so the new file shares no key with the one it replaces. Sections keep
// their lengths, so the file keeps its layout; only the header, the last section, is written anew (new keyring).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { crc32 } from './binary.js';
import { encodeHeader } from './catalog.js';
import {
  CODEC, DEFAULTS, FILE_ID_SIZE, FLAG_APPENDED, FLAG_ENCRYPTED, FLAG_PASSWORD, MAGIC, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS,
  PREAMBLE_SIZE, SALT_SIZE, TRAILER_SIZE,
} from './constants.js';
import { JazminFormatError, JazminValidationError } from './errors.js';
import { grantExpiry, toMs } from './expiry.js';
import { JazminAccessKey, JazminKey, KeySchedule, deriveFromPassword, hkdf, parseAnyKey } from './keys.js';
import { withLock } from './lock.js';
import { JazminReader, KEY_ROTATION } from './reader.js';
import { encodeSection, reencryptSection } from './section.js';
import { NEW_OWNER, replaceFile, updateUnlocked } from './update.js';

const CODEC_NAMES = Object.fromEntries(Object.entries(CODEC).map(([name, id]) => [id, name]));

/**
 * Encrypts a file again under a new key or password: rotateKey(path, { key | password, newKey | newPassword,
 * kdfIterations }). Only the new key or password opens the result. A file with appends is compacted first (its
 * earlier versions, still under the old key, are dropped). Access-controlled files are not supported.
 * Returns { sections, bytes }: the sections encrypted again and the new file's size.
 */
export function rotateKey(path, options = {}) {
  return withLock(path, () => rotateUnlocked(path, options));
}

/**
 * A shared (access-controlled) file under a new owner key, when the old one may have leaked: rotateOwnerKey(path,
 * { key, newKey }) with the owner key now and the new one (default: generated). Every access key is replaced too, since
 * each carries its owner's fingerprint (spec 7.6.6): each grant keeps its rows, columns, files, label, expiry and mode
 * under a new access key. Online grants also get a new share, so they need new unlock tokens (issueUnlockToken with the
 * new owner key). Expired grants are dropped. The file is rewritten with fresh secrets throughout, as update() does.
 * Returns { ownerKey, accessKeys: [{ previous (the old key's id), key, label, mode, expires }] }, in the file's grant
 * order: hand each person their new key.
 */
export function rotateOwnerKey(path, { key, newKey = JazminKey.generate(), now } = {}) {
  const owner = parseAnyKey(newKey);
  if (!(owner instanceof JazminKey)) throw new JazminValidationError('newKey must be an owner key (jzk1-...)');
  const at = toMs(now);
  return withLock(path, () => {
    const accessKeys = [];
    const grants = (current) => current.flatMap((g) => {
      const expires = grantExpiry(g, at);
      if (expires !== undefined && expires <= at) return []; // expired: dropped, as update() drops it
      const previous = (g.key instanceof JazminAccessKey ? g.key : JazminAccessKey.fromOwnerDirectory(g.key)).id;
      const next = owner.createAccessKey();
      accessKeys.push({ previous, key: next, label: g.label, mode: g.mode ?? 'offline', expires: expires === undefined ? undefined : new Date(expires) });
      // No share: an online grant gets a new one, which the new owner key's unlock tokens use.
      return [{ key: next, rows: g.rows, columns: g.columns, files: g.files, label: g.label, expires: g.expires, mode: g.mode }];
    });
    updateUnlocked(path, { key, now: at, [NEW_OWNER]: { key: owner, grants } }); // the instant the grants were checked against
    return { ownerKey: owner, accessKeys };
  });
}

function rotateUnlocked(path, { key, password, newKey, newPassword, kdfIterations = DEFAULTS.kdfIterations } = {}) {
  if ((newKey === undefined) === (newPassword === undefined)) throw new JazminValidationError('Supply either newKey or newPassword');
  if (newPassword !== undefined && (!Number.isInteger(kdfIterations) || kdfIterations < MIN_KDF_ITERATIONS || kdfIterations > MAX_KDF_ITERATIONS)) {
    throw new JazminValidationError(`kdfIterations must be from ${MIN_KDF_ITERATIONS} to ${MAX_KDF_ITERATIONS}`);
  }
  const salt = crypto.randomBytes(SALT_SIZE);
  const master = newPassword !== undefined ? deriveFromPassword(newPassword, salt, kdfIterations) : JazminKey.from(newKey).bytes;

  let reader = new JazminReader(path, { key, password });
  let plan;
  try {
    if (!reader.encrypted) throw new JazminValidationError('The file is not encrypted: it has no key to rotate');
    plan = reader[KEY_ROTATION];
    if (plan.flags & FLAG_APPENDED || plan.recovered) {
      // Earlier versions are still in the file, under the old key: compact first, which writes only the current one.
      reader.close();
      reader = null;
      updateUnlocked(path, { key, password });
      reader = new JazminReader(path, { key, password });
      plan = reader[KEY_ROTATION];
    }
  } catch (error) {
    reader?.close();
    throw error;
  }

  const { header, headerRef, sections } = plan;
  sections.sort((a, b) => a.offset - b.offset);
  // Every byte between the preamble and the header must belong to a listed section: anything else would be lost.
  let at = PREAMBLE_SIZE;
  for (const s of sections) {
    if (s.offset !== at) {
      reader.close();
      throw new JazminFormatError(`Bytes ${at} to ${s.offset} belong to no section this reader knows: the key was not rotated`);
    }
    at += s.length;
  }
  if (at !== headerRef.offset) {
    reader.close();
    throw new JazminFormatError(`Bytes ${at} to ${headerRef.offset} belong to no section this reader knows: the key was not rotated`);
  }

  const fileId = crypto.randomBytes(FILE_ID_SIZE);
  const keys = new KeySchedule(master, salt);
  keys.setKeyring(Object.fromEntries(Object.keys(header.keyring ?? {}).map((group) => [group, crypto.randomBytes(32)])));
  const temp = `${path}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let bytes = 0;
  try {
    const source = fs.openSync(path, 'r');
    const out = fs.openSync(temp, 'wx');
    try {
      const write = (buf) => {
        fs.writeSync(out, buf, 0, buf.length, bytes);
        bytes += buf.length;
      };
      const preamble = Buffer.alloc(PREAMBLE_SIZE);
      MAGIC.copy(preamble, 0);
      preamble.writeUInt16LE(FLAG_ENCRYPTED | (newPassword !== undefined ? FLAG_PASSWORD : 0), 4);
      fileId.copy(preamble, 8);
      salt.copy(preamble, 24);
      preamble.writeUInt32LE(newPassword !== undefined ? kdfIterations : 0, 56);
      write(preamble);

      let buffer = Buffer.alloc(0); // one section at a time
      for (const s of sections) {
        if (buffer.length < s.length) buffer = Buffer.allocUnsafeSlow(Math.ceil(s.length * 1.25));
        const section = buffer.subarray(0, s.length);
        if (fs.readSync(source, section, 0, s.length, s.offset) !== s.length) throw new JazminFormatError(`Section '${s.sectionId}' is truncated`);
        const next = s.contentKey ? hkdf(s.contentKey, salt, `JAZMIN/1/${s.sectionId}`) : keys.sectionKey(s.group, s.sectionId);
        const { envelope, body } = reencryptSection(section, { key: s.key, fileId: plan.fileId, sectionId: s.sectionId }, { key: next, fileId });
        write(envelope);
        write(body);
      }

      const oldHeader = Buffer.alloc(1);
      fs.readSync(source, oldHeader, 0, 1, headerRef.offset);
      const headerSection = encodeSection(encodeHeader({ ...header, keyring: keys.keyring, modified: Date.now() }), {
        codec: CODEC_NAMES[oldHeader[0]] ?? 'deflate', key: keys.headerKey, fileId, sectionId: 'header',
      });
      const headerOffset = bytes;
      write(headerSection);
      fs.fsyncSync(out); // data first: a trailer must never point at data that is not on disk yet
      const trailer = Buffer.alloc(TRAILER_SIZE);
      trailer.writeBigUInt64LE(BigInt(headerOffset), 0);
      trailer.writeUInt32LE(headerSection.length, 8);
      trailer.writeUInt32LE(crc32(trailer.subarray(0, 36)), 36);
      MAGIC.copy(trailer, 40);
      write(trailer);
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
      fs.closeSync(source);
    }
    reader.close();
    reader = null;
    replaceFile(temp, path);
  } catch (error) {
    reader?.close();
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return { sections: sections.length + 1, bytes };
}
