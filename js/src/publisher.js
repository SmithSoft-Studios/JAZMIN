// Publisher signatures (spec 6.9): verifying the block before the header (6.9.1), its signatures, certificates,
// timestamps and log receipts, the revocation status, and the signed facts (6.9.8). Reads only the parts of the file it
// needs: the trailer, the block, the header and signature sections, and bytes [0, B) through a hash in 1 MiB chunks.
import crypto from 'node:crypto';
import { digest, findKeySlotPage, parseKeySlots, unsealSlot } from './access.js';
import { crc32, parseJsonText } from './binary.js';
import { FLAG_ACCESS, FLAG_ENCRYPTED, FLAG_PASSWORD, MAGIC, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS, PREAMBLE_SIZE, TRAILER_SIZE } from './constants.js';
import { DerReader, TAG, bitString, boolean, contents, integerBytes, octets, oid, parseOne, raw, smallInteger, string, time } from './der.js';
import { JazminValidationError } from './errors.js';
import { JazminAccessKey, decrypt, deriveFromPassword, hkdf, parseAnyKey, sha256, slotId } from './keys.js';
import { bytesOf, readMessage, toInt64 } from './proto.js';
import { openSource } from './reader.js';
import { decodeSection } from './section.js';

const FOOTER_SIZE = 16;
const BLOCK_MAGIC = Buffer.from('JZPS', 'ascii');
const CHUNK = 1 << 20;
const FILE_LABEL = Buffer.from('JAZMIN/1/publisher-file');
const SIGNED_LABEL = Buffer.from('JAZMIN/1/publisher');
const LOG_LABEL = Buffer.from('JAZMIN/1/log');
const FACTS_AAD = Buffer.from('publisher/facts');
const ZERO = Buffer.from([0]);
const ONE = Buffer.from([1]);
const STATUSES = new Set(['valid', 'revoked', 'withdrawn', 'superseded']);

const OID = Object.freeze({
  ecPublicKey: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34',
  ecdsaSha256: '1.2.840.10045.4.3.2', ecdsaSha384: '1.2.840.10045.4.3.3', sha256: '2.16.840.1.101.3.4.2.1',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', policies: '2.5.29.32',
  subjectKeyId: '2.5.29.14', authorityKeyId: '2.5.29.35', subjectAltName: '2.5.29.17', timeStamping: '1.3.6.1.5.5.7.3.8',
  signedData: '1.2.840.113549.1.7.2', tstInfo: '1.2.840.113549.1.9.16.1.4', contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4', signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  commonName: '2.5.4.3', country: '2.5.4.6', organization: '2.5.4.10', organizationIdentifier: '2.5.4.97',
});

/** SmithSoft's roots (6.9.4): none yet; added before 1.8.0 is released. The arc of the id-jazmin-* identifiers is set with them. */
const BUILT_IN = Object.freeze({ roots: Object.freeze([]), arc: null });

const ROOT = 'root';
const CROSS = 'cross';
const ISSUING = 'issuing';
const LEAF = 'leaf';

/**
 * Verifies a file's publisher signature (spec 6.9.8). `source` is a path or a Buffer. Options: `key` or `password` (to
 * read the facts of an encrypted file), `revocationList` (a revocation list the app holds) and `statusAnswer`
 * ({ answer, nonce }: an online status answer for the app's own nonce). Trusts only the built-in roots; `trust` is for
 * this repository's tests, which use the test PKI of spec/fixtures/publisher.
 */
export function verifyPublisher(source, options = {}, trust = BUILT_IN) {
  const opts = checkOptions(options ?? {});
  const ctx = context(trust);
  const src = openSource(source);
  try {
    return verifyFrom(src, opts, ctx, typeof source === 'string');
  } finally {
    src.close();
  }
}

function checkOptions(options) {
  const { key, password, revocationList, statusAnswer } = options;
  if (password !== undefined && typeof password !== 'string') throw new JazminValidationError('password must be a string');
  if (revocationList !== undefined && typeof revocationList !== 'string') throw new JazminValidationError('revocationList must be a compact JWS string');
  if (statusAnswer !== undefined && (typeof statusAnswer?.answer !== 'string' || typeof statusAnswer?.nonce !== 'string')) {
    throw new JazminValidationError('statusAnswer must be { answer, nonce } (strings)');
  }
  return {
    key: key === undefined || key === null ? null : parseAnyKey(key), password, revocationList: revocationList?.trim(),
    statusAnswer: statusAnswer && { answer: statusAnswer.answer.trim(), nonce: statusAnswer.nonce },
  };
}

function context(trust) {
  const ids = trust.arc
    ? { policy: `${trust.arc}.1`, signing: `${trust.arc}.2`, status: `${trust.arc}.3`, kind: `${trust.arc}.5`, log: `${trust.arc}.6` }
    : null;
  const at = trust.at === undefined ? Date.now() : trust.at instanceof Date ? trust.at.getTime() : trust.at;
  return { ids, roots: trust.roots.map(certificate), at, issued: new WeakMap() };
}

function verifyFrom(src, opts, ctx, fromFile) {
  // A file whose last bytes are not a valid trailer is not a valid file, and isn't verified (6.9.1).
  const t = readTrailer(src);
  if (!t) return empty('not-verified', 'not-a-valid-file');
  // 1. the block, its CRC, version and coverage
  const found = findBlock(src, t);
  if (found.problem) return empty('invalid', 'block');
  if (!found.block) return empty('none');
  const block = found.block;
  let doc;
  try {
    doc = signedDocument(block.signed);
  } catch {
    return empty('invalid', 'block');
  }
  if (doc.version !== 1) return empty('invalid', 'block');
  const trailerStart = src.size - TRAILER_SIZE;
  const headerEnd = t.header.offset + t.header.length;
  const sections = t.signature.length > 0
    ? headerEnd === t.signature.offset && t.signature.offset + t.signature.length === trailerStart
    : headerEnd === trailerStart;
  // Every section the trailer points to lies in a covered range (6.9.1): the key slots before the block.
  if (!sections || (t.keySlots.length > 0 && t.keySlots.offset + t.keySlots.length > block.b)) return empty('changed', 'coverage');

  // 2. D and the file id
  const preamble = Buffer.from(src.read(0, PREAMBLE_SIZE));
  const fileId = preamble.subarray(8, 24);
  // One buffer for every chunk read from disk (a Buffer source is hashed in place).
  const scratch = fromFile ? Buffer.allocUnsafe(Math.min(CHUNK, Math.max(block.b, t.header.length, t.signature.length, 1))) : undefined;
  const d = sha256(FILE_LABEL, fileId, hashRange(src, 0, block.b, scratch), hashRange(src, t.header.offset, t.header.length, scratch),
    hashRange(src, t.signature.offset, t.signature.length, scratch));
  if (!doc.fileId.equals(fileId) || !doc.fileDigest.equals(d)) return empty('changed', 'digest');

  // 3. algorithms entry for entry, the publisher first, and each signature this reader knows
  const sigs = block.signatures;
  if (sigs.length === 0 || sigs.length !== doc.algorithms.length || sigs.some((s, i) => s.algorithm !== doc.algorithms[i])) return empty('invalid', 'algorithms');
  if (sigs[0].role !== 'publisher' || sigs.some((s, i) => i > 0 && s.role !== 'cosigner') || sigs[0].algorithm !== 'ES256') return empty('invalid', 'algorithms');
  let certs;
  let pool;
  try {
    certs = sigs.map((s) => s.certificates.map(certificate));
    pool = [...certs.flat(), ...block.certificates.map(certificate)];
  } catch {
    return empty('invalid', 'chain');
  }
  const message = Buffer.concat([SIGNED_LABEL, block.signed]);
  const checked = [];
  for (let i = 0; i < sigs.length; i++) {
    if (sigs[i].algorithm !== 'ES256') continue; // reserved algorithms (ML-DSA-65) aren't known yet
    if (certs[i].length === 0) return empty('invalid', 'chain');
    let key = null;
    try {
      key = keyOf(certs[i][0]);
    } catch {
      // a key that isn't usable: the signature can't be checked
    }
    if (!key || !verifies('sha256', message, key, 'ieee-p1363', sigs[i].value)) return empty('invalid', 'signature');
    checked.push({ sig: sigs[i], chain: checkChain(ctx, certs[i], ctx.ids?.signing) });
  }
  // "signed": the publisher's certificate doesn't chain to a trusted root. No name, facts or code.
  if (!checked[0].chain.trusted) return empty('signed');

  // 4. each chain, timestamp (inside the chain's validity) and log receipt
  const times = [];
  for (const { sig, chain } of checked) {
    if (!chain.trusted || chain.problem) return empty('invalid', 'chain');
    const at = timestamp(ctx, sig.timestamp, sig.value, pool);
    if (at === null || !validAt(chain, at)) return empty('invalid', 'timestamp');
    const entry = Buffer.concat([LOG_LABEL, sha256(block.signed), sha256(sig.value)]);
    if (receipt(ctx, sig.logReceipt, entry, pool, at) < 0) return empty('invalid', 'log');
    times.push(at);
  }

  // 5. revocation: per certificate, the most recent statement held (6.9.5). Status answers are about the publisher's.
  const publisher = checked[0].chain;
  const expect = { d: b64url(d), code: doc.code, certificate: certificateName(publisher) };
  const stored = block.status ? statusAnswer(ctx, block.status, pool, { ...expect, nonce: expect.d }) : null;
  const online = opts.statusAnswer ? statusAnswer(ctx, opts.statusAnswer.answer, pool, { ...expect, nonce: opts.statusAnswer.nonce }) : null;
  const list = opts.revocationList ? revocationList(ctx, opts.revocationList) : null;
  let checkedAt = null;
  for (let i = 0; i < checked.length; i++) {
    const statements = [];
    if (i === 0 && stored) statements.push(stored);
    if (list) statements.push({ time: list.issued, revokedFrom: list.revoked.get(certificateName(checked[i].chain)) ?? null });
    if (i === 0 && online) statements.push(online);
    if (statements.length === 0) continue;
    const newest = statements.reduce((a, b) => (b.time > a.time ? b : a));
    if (i === 0) checkedAt = newest.time;
    if (newest.revokedFrom !== null && newest.revokedFrom <= times[i]) return empty('invalid', 'revoked');
  }

  // 6. the facts, with a key that reads the header (or in a file that isn't encrypted)
  const encrypted = (preamble.readUInt16LE(4) & FLAG_ENCRYPTED) !== 0;
  let facts = null;
  if (doc.factsDigest.length > 0) {
    let plain = encrypted ? null : block.facts;
    if (encrypted && (opts.key || opts.password)) {
      const opened = openFacts(src, t, preamble, opts, block.facts);
      if (opened === false) return empty('invalid', 'facts');
      plain = opened;
    }
    if (plain) {
      if (!sha256(plain).equals(doc.factsDigest)) return empty('invalid', 'facts');
      facts = parseFacts(plain.subarray(16));
      if (!facts) return empty('invalid', 'facts');
    }
  }

  // Withdrawn or superseded: only status answers say so, the most recent of them.
  let status = 'certified';
  const answers = [stored, online].filter(Boolean);
  if (answers.length) {
    const newest = answers.reduce((a, b) => (b.time > a.time ? b : a));
    if ((newest.status === 'withdrawn' || newest.status === 'superseded') && newest.from <= ctx.at) status = newest.status;
  }
  return {
    status,
    reason: null,
    ...identity(publisher.leaf, ctx.ids),
    code: doc.code,
    documentKind: doc.kind,
    credential: doc.credential,
    signedAt: iso(doc.signedAt),
    timestamp: iso(times[0]),
    cosigners: checked.slice(1).map((c) => identity(c.chain.leaf, ctx.ids)),
    facts,
    factsNeedKey: encrypted,
    statusAnswer: stored ? { status: stored.status, from: stored.from === null ? null : iso(stored.from) } : null,
    checkedAt: checkedAt === null ? null : iso(checkedAt),
  };
}

function empty(status, reason = null) {
  return {
    status, reason, name: null, organization: null, registration: null, country: null, domain: null, kind: null, code: null,
    documentKind: null, credential: null, signedAt: null, timestamp: null, cosigners: [], facts: null, factsNeedKey: false,
    statusAnswer: null, checkedAt: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The file: trailer, block, messages

/** A valid trailer at the file's end (4.2), or null. */
function readTrailer(src) {
  const { size } = src;
  if (size < PREAMBLE_SIZE + TRAILER_SIZE || !src.read(0, 4).equals(MAGIC)) return null;
  const t = Buffer.from(src.read(size - TRAILER_SIZE, TRAILER_SIZE));
  if (!t.subarray(40).equals(MAGIC) || crc32(t.subarray(0, 36)) !== t.readUInt32LE(36)) return null;
  const header = { offset: Number(t.readBigUInt64LE(0)), length: t.readUInt32LE(8) };
  const keySlots = { offset: Number(t.readBigUInt64LE(12)), length: t.readUInt32LE(20) };
  const signature = { offset: Number(t.readBigUInt64LE(24)), length: t.readUInt32LE(32) };
  const last = Math.max(header.offset + header.length, signature.offset + signature.length);
  return header.offset >= PREAMBLE_SIZE && last === size - TRAILER_SIZE ? { header, keySlots, signature } : null;
}

/** Step 1: the block before the header. `problem`: the magic is there, but the block is damaged (invalid). */
function findBlock(src, t) {
  const h = t.header.offset;
  if (h < PREAMBLE_SIZE + FOOTER_SIZE) return {};
  const footer = Buffer.from(src.read(h - FOOTER_SIZE, FOOTER_SIZE));
  if (!footer.subarray(12).equals(BLOCK_MAGIC)) return {};
  const length = footer.readUInt32LE(0);
  const b = h - FOOTER_SIZE - length;
  if (b < PREAMBLE_SIZE) return { problem: 'the payload would start inside the preamble' };
  if (footer.readUInt16LE(8) !== 1) return { problem: 'unknown version' };
  if (footer.readUInt16LE(10) !== 0) return { problem: 'non-zero reserved' };
  const payload = src.read(b, length);
  if (crc32(payload) !== footer.readUInt32LE(4)) return { problem: 'CRC' };
  try {
    return { block: { ...publisherSignatures(payload), b } };
  } catch {
    return { problem: 'not a PublisherSignatures' };
  }
}

const number = (v) => {
  if (typeof v !== 'number' && typeof v !== 'bigint') throw new TypeError('wire type');
  return v;
};
const utf8 = (v) => bytesOf(v).toString('utf8');

function publisherSignatures(buf) {
  const m = { signed: Buffer.alloc(0), signatures: [], facts: Buffer.alloc(0), status: '', certificates: [] };
  readMessage(buf, (field, v) => {
    if (field === 1) m.signed = bytesOf(v);
    else if (field === 2) m.signatures.push(publisherSignature(bytesOf(v)));
    else if (field === 3) m.facts = bytesOf(v);
    else if (field === 4) m.status = utf8(v);
    else if (field === 5) m.certificates.push(bytesOf(v));
  });
  return m;
}

function publisherSignature(buf) {
  const s = { algorithm: '', value: Buffer.alloc(0), certificates: [], role: '', timestamp: Buffer.alloc(0), logReceipt: '' };
  readMessage(buf, (field, v) => {
    if (field === 1) s.algorithm = utf8(v);
    else if (field === 2) s.value = bytesOf(v);
    else if (field === 3) s.certificates.push(bytesOf(v));
    else if (field === 4) s.role = utf8(v);
    else if (field === 5) s.timestamp = bytesOf(v);
    else if (field === 6) s.logReceipt = utf8(v);
  });
  return s;
}

function signedDocument(buf) {
  const d = { version: 0, fileId: Buffer.alloc(0), fileDigest: Buffer.alloc(0), code: '', kind: '', factsDigest: Buffer.alloc(0), algorithms: [], credential: '', signedAt: 0 };
  readMessage(buf, (field, v) => {
    if (field === 1) d.version = Number(number(v));
    else if (field === 2) d.fileId = bytesOf(v);
    else if (field === 3) d.fileDigest = bytesOf(v);
    else if (field === 4) d.code = utf8(v);
    else if (field === 5) d.kind = utf8(v);
    else if (field === 6) d.factsDigest = bytesOf(v);
    else if (field === 7) d.algorithms.push(utf8(v));
    else if (field === 8) d.credential = utf8(v);
    else if (field === 9) d.signedAt = Number(toInt64(number(v)));
  });
  return d;
}

function hashRange(src, offset, length, scratch) {
  const hash = crypto.createHash('sha256');
  for (let at = 0; at < length; at += CHUNK) hash.update(src.read(offset + at, Math.min(CHUNK, length - at), scratch));
  return hash.digest();
}

// ---------------------------------------------------------------------------------------------------------------------
// Facts (6.9.3)

/**
 * The facts of an encrypted file: their bytes, null when the key can't read the header (a wrong key or password, or a
 * key without a slot), or false when the key reads the header but not the facts.
 */
function openFacts(src, t, preamble, { key, password }, stored) {
  const flags = preamble.readUInt16LE(4);
  const fileId = preamble.subarray(8, 24);
  const salt = preamble.subarray(24, 56);
  let ikm;
  let checkHeader = null; // for key and password files: whether the key reads the header, asked only when the facts fail
  try {
    if (flags & FLAG_ACCESS) {
      if (!key || password || !t.keySlots.length) return null;
      const secret = key instanceof JazminAccessKey ? key.secret : key.bytes;
      const list = decodeSection(plainSection(src.read(t.keySlots.offset, t.keySlots.length), 'keyslots'), { key: undefined, fileId, sectionId: 'keyslots' });
      const page = findKeySlotPage(list, slotId(secret));
      if (!page) return null;
      const pageSection = src.read(page.offset, page.length);
      if (!digest(pageSection).equals(page.digest)) return null;
      const keySlots = parseKeySlots(decodeSection(plainSection(pageSection, `keyslots/${page.index}`), { key: undefined, fileId, sectionId: `keyslots/${page.index}` }));
      const bundle = unsealSlot(keySlots, secret, salt, fileId);
      if (!bundle || typeof bundle.header !== 'string') return null;
      ikm = Buffer.from(bundle.header, 'base64'); // H: the slot opened, so this key reads the header
    } else {
      if (key instanceof JazminAccessKey) return null;
      if (password !== undefined) {
        const iterations = preamble.readUInt32LE(56);
        if (!(flags & FLAG_PASSWORD) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) return null;
        ikm = deriveFromPassword(password, salt, iterations);
      } else ikm = key.bytes;
      checkHeader = () => {
        decodeSection(src.read(t.header.offset, t.header.length), { key: hkdf(ikm, salt, 'JAZMIN/1/header'), fileId, sectionId: 'header' });
        return true;
      };
    }
  } catch {
    return null; // an online slot without its unlock token, or a damaged key-slot section
  }
  try {
    const envelope = Buffer.alloc(8);
    envelope[1] = 0x01; // codec 0, ENCRYPTED (7.4)
    envelope.writeUInt32LE(Math.max(0, stored.length - 28), 4);
    return decrypt(hkdf(ikm, salt, 'JAZMIN/1/publisher/facts'), stored, Buffer.concat([fileId, envelope, FACTS_AAD]));
  } catch {
    if (!checkHeader) return false;
    try {
      return checkHeader() ? false : null;
    } catch {
      return null; // the key doesn't read the header either: not this file's key
    }
  }
}

/** A section stored as is (the key slots are never encrypted or compressed). */
function plainSection(section, sectionId) {
  if (section.length < 16 || section[0] !== 0 || section[1] !== 0) throw new Error(`Section '${sectionId}' must be stored as is`);
  return section;
}

/** Facts: a JSON object of text values (6.9.3), or null. */
function parseFacts(buf) {
  let value;
  try {
    value = parseJsonText(buf.toString('utf8'), 'Facts', true);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const v of Object.values(value)) if (typeof v !== 'string') return null;
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Certificates (6.9.4)

/** A certificate read with the strict DER reader: what the profile and the chains need. */
function certificate(der) {
  const buf = Buffer.isBuffer(der) ? der : Buffer.from(der);
  const outer = new DerReader(buf);
  const certEl = outer.next(TAG.SEQUENCE);
  outer.done();
  const c = DerReader.of(certEl);
  const tbsEl = c.next(TAG.SEQUENCE);
  const algorithm = c.sequence();
  const signatureAlgorithm = oid(algorithm.next(TAG.OID));
  algorithm.done();
  const signature = bitString(c.next(TAG.BIT_STRING));
  if (signature.unused) throw new Error('certificate signature');
  c.done();
  const t = DerReader.of(tbsEl);
  let version = 1;
  const versionEl = t.optional(0xa0);
  if (versionEl) {
    const v = DerReader.of(versionEl);
    version = smallInteger(v.next(TAG.INTEGER)) + 1;
    v.done();
  }
  const serial = integerBytes(t.next(TAG.INTEGER));
  const inner = t.sequence();
  if (oid(inner.next(TAG.OID)) !== signatureAlgorithm) throw new Error('signature algorithms differ');
  inner.done();
  const issuer = raw(t.next(TAG.SEQUENCE));
  const validity = t.sequence();
  const notBefore = time(validity.next());
  const notAfter = time(validity.next());
  validity.done();
  const subject = raw(t.next(TAG.SEQUENCE));
  const spkiEl = t.next(TAG.SEQUENCE);
  const spki = DerReader.of(spkiEl);
  const keyAlgorithm = spki.sequence();
  const keyOid = oid(keyAlgorithm.next(TAG.OID));
  const curve = keyAlgorithm.peek() === TAG.OID ? oid(keyAlgorithm.next(TAG.OID)) : '';
  keyAlgorithm.done();
  bitString(spki.next(TAG.BIT_STRING));
  spki.done();
  const extensions = new Map();
  const extensionsEl = t.optional(0xa3);
  if (extensionsEl) {
    const wrapper = DerReader.of(extensionsEl);
    const list = wrapper.sequence();
    wrapper.done();
    while (list.more) {
      const e = list.sequence();
      const id = oid(e.next(TAG.OID));
      let critical = false;
      if (e.peek() === TAG.BOOLEAN) {
        critical = boolean(e.next(TAG.BOOLEAN));
        if (!critical) throw new Error('DER: a default value is encoded');
      }
      const value = octets(e.next(TAG.OCTET_STRING));
      e.done();
      if (extensions.has(id)) throw new Error(`extension ${id} twice`);
      extensions.set(id, { critical, value });
    }
  }
  t.done();
  return {
    raw: raw(certEl), tbs: raw(tbsEl), signatureAlgorithm, signature: signature.bytes, version, serialHex: serial.toString('hex'),
    issuer, subject, notBefore, notAfter, spki: raw(spkiEl), keyAlgorithm: keyOid, curve, extensions, key: null, attributes: null,
  };
}

function keyOf(c) {
  c.key ??= crypto.createPublicKey({ key: c.spki, format: 'der', type: 'spki' });
  return c.key;
}

function verifies(hash, data, key, dsaEncoding, signature) {
  try {
    return crypto.verify(hash, data, { key, dsaEncoding }, signature);
  } catch {
    return false;
  }
}

/** The subject's attributes, by object identifier. */
function attributes(c) {
  if (c.attributes) return c.attributes;
  const result = new Map();
  const name = DerReader.of(parseOne(c.subject, TAG.SEQUENCE));
  while (name.more) {
    const set = name.sequence(TAG.SET);
    while (set.more) {
      const pair = set.sequence();
      const id = oid(pair.next(TAG.OID));
      result.set(id, string(pair.next()));
      pair.done();
    }
  }
  c.attributes = result;
  return result;
}

const extension = (c, id) => c.extensions.get(id) ?? null;

function subjectKeyId(c) {
  const e = extension(c, OID.subjectKeyId);
  return e ? octets(parseOne(e.value, TAG.OCTET_STRING)) : null;
}

function authorityKeyId(c) {
  const e = extension(c, OID.authorityKeyId);
  if (!e) return null;
  const seq = DerReader.of(parseOne(e.value, TAG.SEQUENCE));
  const keyId = seq.optional(0x80);
  return keyId ? contents(keyId) : null;
}

function oidList(value, policies) {
  const list = [];
  const seq = DerReader.of(parseOne(value, TAG.SEQUENCE));
  while (seq.more) list.push(policies ? oid(seq.sequence().next(TAG.OID)) : oid(seq.next(TAG.OID)));
  return list;
}

/** The certificate's one extended key usage, or null. */
function extendedKeyUsage(c) {
  const e = extension(c, OID.extKeyUsage);
  if (!e) return null;
  const list = oidList(e.value, false);
  return list.length === 1 ? list[0] : null;
}

function keyUsageBits(value) {
  const { unused, bytes } = bitString(parseOne(value, TAG.BIT_STRING));
  const bits = [];
  for (let i = 0; i < bytes.length * 8 - unused; i++) if (bytes[i >> 3] & (0x80 >> (i & 7))) bits.push(i);
  return bits.join(',');
}

const kindOf = (value) => string(parseOne(value, TAG.UTF8));

/**
 * The profile's rows (6.9.4): a root and a cross-certificate P-384 signed with ecdsa-with-SHA384, path length 2; an
 * issuing certificate P-256 signed with ecdsa-with-SHA384, path length 0; leaves P-256 signed with ecdsa-with-SHA256
 * and one extended key usage. Only the listed extensions, with their criticality. A problem, or null.
 */
function profileProblem(c, role, eku, ids) {
  try {
    if (c.version !== 3) return 'not X.509 v3';
    if (c.keyAlgorithm !== OID.ecPublicKey || c.curve !== (role === ROOT || role === CROSS ? OID.p384 : OID.p256)) return 'key';
    if (c.signatureAlgorithm !== (role === LEAF ? OID.ecdsaSha256 : OID.ecdsaSha384)) return 'signature algorithm';
    const publisher = role === LEAF && eku === ids.signing;
    for (const [id, e] of c.extensions) {
      let allowed;
      if (id === OID.basicConstraints || id === OID.keyUsage) allowed = e.critical;
      else if (id === OID.extKeyUsage) allowed = role === LEAF && e.critical === (eku === OID.timeStamping);
      else if (id === OID.policies || id === OID.subjectKeyId || id === OID.authorityKeyId) allowed = !e.critical;
      else if (id === OID.subjectAltName) allowed = publisher && !e.critical;
      else if (id === ids.kind) allowed = publisher && !e.critical && (kindOf(e.value) === 'company' || kindOf(e.value) === 'individual');
      else allowed = false;
      if (!allowed) return `extension ${id}`;
    }
    let ca = false;
    let pathLength = null;
    const basic = extension(c, OID.basicConstraints);
    if (basic) {
      const seq = DerReader.of(parseOne(basic.value, TAG.SEQUENCE));
      if (seq.peek() === TAG.BOOLEAN) ca = boolean(seq.next(TAG.BOOLEAN));
      if (seq.more) pathLength = smallInteger(seq.next(TAG.INTEGER));
      seq.done();
    }
    const usage = extension(c, OID.keyUsage);
    const bits = usage ? keyUsageBits(usage.value) : null;
    if (role === LEAF) {
      if (ca) return 'a leaf that is a CA';
      if (bits !== '0') return 'key usage';
      if (extendedKeyUsage(c) !== eku) return 'extended key usage';
    } else {
      if (!ca || pathLength !== (role === ISSUING ? 0 : 2)) return 'basic constraints';
      if (bits !== '5,6') return 'key usage';
      if (!subjectKeyId(c)) return 'subject key identifier';
    }
    if (role !== ROOT && !authorityKeyId(c)) return 'authority key identifier';
    const policies = extension(c, OID.policies);
    if (!policies || !oidList(policies.value, true).includes(ids.policy)) return 'certificate policy';
    attributes(c);
    return null;
  } catch {
    return 'not in the profile';
  }
}

/** Whether `issuer` issued `child`: its name, its key identifier when the child names one, and its signature. */
function issued(ctx, issuer, child) {
  let known = ctx.issued.get(child);
  if (!known) ctx.issued.set(child, (known = new Map()));
  let result = known.get(issuer);
  if (result === undefined) {
    result = false;
    try {
      const aki = authorityKeyId(child);
      const ski = subjectKeyId(issuer);
      const hash = child.signatureAlgorithm === OID.ecdsaSha256 ? 'sha256' : child.signatureAlgorithm === OID.ecdsaSha384 ? 'sha384' : null;
      result = child.issuer.equals(issuer.subject) && (aki === null || (ski !== null && aki.equals(ski))) && hash !== null
        && verifies(hash, child.tbs, keyOf(issuer), 'der', child.signature);
    } catch {
      result = false;
    }
    known.set(issuer, result);
  }
  return result;
}

/**
 * A chain as a signature lists it (6.9.4): the leaf, its issuing certificate, optionally a cross-certificate. Trusted
 * when it reaches a built-in root; `problem` when a trusted chain is outside the profile.
 */
function checkChain(ctx, listed, eku) {
  const leaf = listed[0];
  const untrusted = { trusted: false, problem: null, leaf, certificates: [leaf] };
  if (!ctx.ids || !eku || listed.length < 2 || listed.length > 3) return untrusted; // a self-signed certificate alone, or no chain the profile has
  const [, issuing, cross] = listed;
  if (!issued(ctx, issuing, leaf)) return untrusted;
  const root = cross
    ? (issued(ctx, cross, issuing) ? ctx.roots.find((r) => issued(ctx, r, cross)) : undefined)
    : ctx.roots.find((r) => issued(ctx, r, issuing));
  if (!root) return untrusted;
  const problem = profileProblem(leaf, LEAF, eku, ctx.ids) ?? profileProblem(issuing, ISSUING, null, ctx.ids)
    ?? (cross ? profileProblem(cross, CROSS, null, ctx.ids) : null) ?? profileProblem(root, ROOT, null, ctx.ids);
  return { trusted: true, problem, leaf, certificates: cross ? [leaf, issuing, cross, root] : [leaf, issuing, root] };
}

/**
 * The chain of a certificate the block shares (6.9.6): its issuing certificate and any cross-certificate, found by issuer
 * name and authorityKeyIdentifier among the signatures' chains and the block's certificates (6.9.4).
 */
function buildChain(ctx, leaf, pool, eku) {
  const issuing = pool.find((c) => issued(ctx, c, leaf));
  if (!issuing) return checkChain(ctx, [leaf], eku);
  if (ctx.roots.some((r) => issued(ctx, r, issuing))) return checkChain(ctx, [leaf, issuing], eku);
  const cross = pool.find((c) => issued(ctx, c, issuing));
  return checkChain(ctx, cross ? [leaf, issuing, cross] : [leaf, issuing], eku);
}

const validAt = (chain, t) => chain.certificates.every((c) => t >= c.notBefore && t <= c.notAfter);

/** A certificate's name in status answers and revocation lists (6.9.5): the issuing certificate's key, and the serial. */
const certificateName = (chain) => `${b64url(sha256(chain.certificates[1].spki))}/${chain.certificates[0].serialHex}`;

function identity(c, ids) {
  const a = attributes(c);
  let domain = null;
  const san = extension(c, OID.subjectAltName);
  if (san) {
    const names = DerReader.of(parseOne(san.value, TAG.SEQUENCE));
    while (names.more && domain === null) {
      const el = names.next();
      if (el.tag === 0x82) domain = contents(el).toString('latin1'); // dNSName
    }
  }
  const kind = ids ? extension(c, ids.kind) : null;
  return {
    name: a.get(OID.commonName) ?? null,
    organization: a.get(OID.organization) ?? null,
    registration: a.get(OID.organizationIdentifier) ?? null,
    country: a.get(OID.country) ?? null,
    domain,
    kind: kind ? kindOf(kind.value) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Time, the log and status (6.9.5)

/**
 * An RFC 3161 token over SHA-256(value) by a time-stamping certificate whose chain is trusted, with id-jazmin-policy:
 * the time it proves (milliseconds), or null. CMS SignedData with one signer, read with the strict DER reader.
 */
function timestamp(ctx, token, value, pool) {
  try {
    const top = new DerReader(token);
    const info = top.sequence();
    top.done();
    if (oid(info.next(TAG.OID)) !== OID.signedData) return null;
    const explicit = DerReader.of(info.next(0xa0));
    info.done();
    const sd = explicit.sequence();
    explicit.done();
    sd.next(TAG.INTEGER); // version
    sd.next(TAG.SET); // digestAlgorithms
    const encap = sd.sequence();
    if (oid(encap.next(TAG.OID)) !== OID.tstInfo) return null;
    const wrapped = DerReader.of(encap.next(0xa0));
    encap.done();
    const eContent = octets(wrapped.next(TAG.OCTET_STRING));
    wrapped.done();
    const own = [];
    const certificatesEl = sd.optional(0xa0);
    if (certificatesEl) for (const r = DerReader.of(certificatesEl); r.more;) own.push(certificate(raw(r.next(TAG.SEQUENCE))));
    sd.optional(0xa1); // revocation information: not used
    const signers = DerReader.of(sd.next(TAG.SET));
    sd.done();
    const si = signers.sequence();
    if (signers.more) return null; // one signer
    si.next(TAG.INTEGER); // version
    let isSigner;
    if (si.peek() === TAG.SEQUENCE) {
      const ias = si.sequence();
      const issuerName = raw(ias.next(TAG.SEQUENCE));
      const serial = integerBytes(ias.next(TAG.INTEGER)).toString('hex');
      ias.done();
      isSigner = (c) => c.issuer.equals(issuerName) && c.serialHex === serial;
    } else {
      const id = contents(si.next(0x80));
      isSigner = (c) => subjectKeyId(c)?.equals(id) === true;
    }
    if (!sha256Algorithm(si.sequence())) return null;
    const attributesEl = si.next(0xa0);
    const signatureAlgorithm = si.sequence();
    if (oid(signatureAlgorithm.next(TAG.OID)) !== OID.ecdsaSha256) return null;
    signatureAlgorithm.done();
    const signature = octets(si.next(TAG.OCTET_STRING));
    si.optional(0xa1); // unsigned attributes
    si.done();

    const attrs = new Map();
    for (const r = DerReader.of(attributesEl); r.more;) {
      const a = r.sequence();
      const type = oid(a.next(TAG.OID));
      const values = DerReader.of(a.next(TAG.SET));
      a.done();
      const v = values.next();
      if (values.more || attrs.has(type)) return null;
      attrs.set(type, v);
    }
    if (oid(attrs.get(OID.contentType)) !== OID.tstInfo) return null;
    if (!octets(attrs.get(OID.messageDigest)).equals(sha256(eContent))) return null;
    // signingCertificateV2: the first ESSCertIDv2 names the signer's certificate by its SHA-256
    const essIds = DerReader.of(attrs.get(OID.signingCertificateV2)).sequence();
    const first = essIds.sequence();
    if (first.peek() === TAG.SEQUENCE && !sha256Algorithm(first.sequence())) return null;
    const certHash = octets(first.next(TAG.OCTET_STRING));
    const candidates = [...pool, ...own];
    const signer = candidates.find((c) => isSigner(c) && sha256(c.raw).equals(certHash));
    if (!signer) return null;
    const signedAttributes = Buffer.from(raw(attributesEl));
    signedAttributes[0] = TAG.SET; // signed as a SET OF, stored as [0] IMPLICIT
    if (!verifies('sha256', signedAttributes, keyOf(signer), 'der', signature)) return null;

    const tr = new DerReader(eContent);
    const tst = tr.sequence();
    tr.done();
    if (smallInteger(tst.next(TAG.INTEGER)) !== 1) return null;
    if (oid(tst.next(TAG.OID)) !== ctx.ids.policy) return null;
    const imprint = tst.sequence();
    if (!sha256Algorithm(imprint.sequence())) return null;
    if (!octets(imprint.next(TAG.OCTET_STRING)).equals(sha256(value))) return null;
    imprint.done();
    integerBytes(tst.next(TAG.INTEGER)); // serial number
    const at = time(tst.next(TAG.GENERALIZED_TIME));
    const chain = buildChain(ctx, signer, candidates, OID.timeStamping);
    return chain.trusted && !chain.problem && validAt(chain, at) ? at : null;
  } catch {
    return null;
  }
}

function sha256Algorithm(r) {
  if (oid(r.next(TAG.OID)) !== OID.sha256) return false;
  r.optional(TAG.NULL);
  r.done();
  return true;
}

/**
 * A C2SP checkpoint signed (type 0x02: DER ECDSA over SHA-256 of the note's text) by a trusted log certificate's key,
 * valid at `at`, whose commonName is the origin and the key name: { size, root }, or null.
 */
function checkpoint(ctx, note, pool, at) {
  const split = note.indexOf('\n\n');
  if (split < 0) return null;
  const body = note.slice(0, split + 1);
  const lines = body.slice(0, -1).split('\n');
  if (lines.length < 3 || !/^\d+$/.test(lines[1])) return null;
  const text = Buffer.from(body, 'utf8');
  let verified = false;
  for (const log of pool) {
    if (verified || extendedKeyUsage(log) !== ctx.ids.log) continue;
    const chain = buildChain(ctx, log, pool, ctx.ids.log);
    if (!chain.trusted || chain.problem || !validAt(chain, at)) continue;
    const name = attributes(log).get(OID.commonName);
    if (lines[0] !== name) continue;
    const id = sha256(log.spki).subarray(0, 4);
    for (const line of note.slice(split + 2).split('\n')) {
      const fields = line.split(' ');
      if (fields.length !== 3 || fields[0] !== '\u2014' || fields[1] !== name) continue;
      const sig = base64(fields[2]);
      if (sig && sig.length > 4 && sig.subarray(0, 4).equals(id) && verifies('sha256', text, keyOf(log), 'der', sig.subarray(4))) verified = true;
    }
  }
  if (!verified) return null;
  const root = base64(lines[2]);
  return root?.length === 32 ? { size: BigInt(lines[1]), root } : null;
}

/** A receipt (C2SP tlog-proof@v1) for this entry: the index it proves, or -1. */
function receipt(ctx, text, entry, pool, at) {
  let pos = 0;
  const line = () => {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) throw new Error('the receipt ends early');
    const l = text.slice(pos, nl);
    pos = nl + 1;
    return l;
  };
  try {
    if (line() !== 'c2sp.org/tlog-proof@v1') return -1;
    let l = line();
    if (l.startsWith('extra ')) l = line();
    if (!/^index \d+$/.test(l)) return -1;
    const index = BigInt(l.slice(6));
    const proof = [];
    while ((l = line()).length > 0) {
      const hash = base64(l);
      if (!hash) return -1;
      proof.push(hash);
    }
    const cp = checkpoint(ctx, text.slice(pos), pool, at);
    return cp && inclusion(index, cp.size, sha256(ZERO, entry), proof, cp.root) ? Number(index) : -1;
  } catch {
    return -1;
  }
}

/** RFC 9162 section 2.1.3.2: whether `proof` places the leaf at `index` in a tree of `size` with this root. */
function inclusion(index, size, leafHash, proof, root) {
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1n;
  let r = leafHash;
  for (const p of proof) {
    if (p.length !== 32 || sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = sha256(ONE, p, r);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else r = sha256(ONE, r, p);
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && r.equals(root);
}

/**
 * A compact JWS (ES256) from a trusted certificate with this extended key usage, valid at the payload's time, which is
 * not after the time of verifying. x5t#S256 names the certificate, which is in x5c or among the block's certificates.
 */
function jws(ctx, text, eku, timeField, pool) {
  const parts = text.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const header = parseJsonText(Buffer.from(parts[0], 'base64url').toString('utf8'), 'JWS header', true);
    const thumbprint = header?.['x5t#S256'];
    if (header?.alg !== 'ES256' || typeof thumbprint !== 'string') return null;
    const chains = Array.isArray(header.x5c)
      ? [checkChain(ctx, header.x5c.map((c) => certificate(base64(c) ?? Buffer.alloc(0))), eku)]
      : pool.filter((c) => b64url(sha256(c.raw)) === thumbprint).map((c) => buildChain(ctx, c, pool, eku));
    const input = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const signature = Buffer.from(parts[2], 'base64url');
    for (const chain of chains) {
      if (!chain.trusted || chain.problem || b64url(sha256(chain.leaf.raw)) !== thumbprint) continue;
      if (!verifies('sha256', input, keyOf(chain.leaf), 'ieee-p1363', signature)) continue;
      const payload = parseJsonText(Buffer.from(parts[1], 'base64url').toString('utf8'), 'JWS payload', true);
      const t = rfc3339(payload?.[timeField]);
      return t !== null && validAt(chain, t) && t <= ctx.at ? payload : null;
    }
  } catch {
    // not a statement this reader can rely on
  }
  return null;
}

/**
 * A status answer (6.9.5) about this document and the publisher's certificate, for this nonce: { status, from, time,
 * revokedFrom }, or null when it doesn't verify or lacks a required field (it is then ignored).
 */
function statusAnswer(ctx, text, pool, expect) {
  const p = ctx.ids ? jws(ctx, text, ctx.ids.status, 'time', pool) : null;
  if (!p || !STATUSES.has(p.status) || p.digest !== expect.d || p.code !== expect.code || p.nonce !== expect.nonce) return null;
  if (typeof p.nonce !== 'string' || Buffer.from(p.nonce, 'base64url').length < 16 || nameOf(p.certificate) !== expect.certificate) return null;
  const from = p.from === undefined || p.from === null ? null : rfc3339(p.from);
  if (from === null && (p.status !== 'valid' || (p.from !== undefined && p.from !== null))) return null; // from is REQUIRED with revoked, withdrawn and superseded
  return { status: p.status, from, time: rfc3339(p.time), revokedFrom: p.status === 'revoked' ? from : null };
}

/** A revocation list (6.9.5): { issued, revoked: Map(name, from) }, or null when it doesn't verify. */
function revocationList(ctx, text) {
  const p = ctx.ids ? jws(ctx, text, ctx.ids.status, 'issued', []) : null;
  if (!p || !Array.isArray(p.revoked)) return null;
  const revoked = new Map();
  for (const entry of p.revoked) {
    const name = nameOf(entry?.certificate);
    const from = rfc3339(entry?.from);
    if (name === null || from === null) return null;
    revoked.set(name, Math.min(from, revoked.get(name) ?? Infinity));
  }
  return { issued: rfc3339(p.issued), revoked };
}

const nameOf = (c) => (typeof c?.issuer === 'string' && typeof c?.serial === 'string' ? `${c.issuer}/${c.serial}` : null);

function rfc3339(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function iso(ms) {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

const b64url = (b) => b.toString('base64url');

/** Standard base64 with padding, strictly: bytes, or null. */
function base64(s) {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64');
}
