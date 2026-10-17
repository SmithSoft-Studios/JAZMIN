  // ---- publisher signatures (spec 6.9) --------------------------------------------------------------------------
  // The library's verifyPublisher (js/src/publisher.js) on the browser's own crypto (WebCrypto): who published a file,
  // that it hasn't changed, its signed facts and code, and its status. The file is never loaded whole: bytes [0, B)
  // are hashed in 1 MiB slices with the SHA-256 below (WebCrypto hashes only whole buffers). CI checks it gives the
  // results spec/fixtures/publisher/expected.json names, as the library does.

  // SmithSoft's roots (spec 6.9.4), as base64 DER: none yet; added before 1.8.0 is released. Only a test build (made by
  // js/scripts/publisher-test-build.mjs for the tests and the demo gallery) has other roots, and its results say so.
  // `at`: the time to verify at, null for now (a test build may fix it).
  const PUBLISHER_TRUST = Object.freeze({ roots: Object.freeze([]), arc: null, test: false, at: null });

  const PS_FOOTER = 16;
  const PS_CHUNK = 1 << 20;
  const PS_STATUSES = new Set(['valid', 'revoked', 'withdrawn', 'superseded']);
  const PS_OID = Object.freeze({
    ecPublicKey: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34',
    ecdsaSha256: '1.2.840.10045.4.3.2', ecdsaSha384: '1.2.840.10045.4.3.3', sha256: '2.16.840.1.101.3.4.2.1',
    basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', policies: '2.5.29.32',
    subjectKeyId: '2.5.29.14', authorityKeyId: '2.5.29.35', subjectAltName: '2.5.29.17', timeStamping: '1.3.6.1.5.5.7.3.8',
    signedData: '1.2.840.113549.1.7.2', tstInfo: '1.2.840.113549.1.9.16.1.4', contentType: '1.2.840.113549.1.9.3',
    messageDigest: '1.2.840.113549.1.9.4', signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
    commonName: '2.5.4.3', country: '2.5.4.6', organization: '2.5.4.10', organizationIdentifier: '2.5.4.97',
  });

  /**
   * Verifies a file's publisher signature (spec 6.9.8). `input`: a File, Blob, ArrayBuffer, Uint8Array or { size, read }.
   * options: { key } (jzk1-... or jza1-...) or { password } to read an encrypted file's facts, { revocationList },
   * { statusAnswer: { answer, nonce } }. Trusts only the built-in roots.
   */
  async function verifyPublisher(input, options = {}) {
    const opts = await publisherOptions(options ?? {});
    const ctx = { ids: publisherIds(PUBLISHER_TRUST.arc), roots: [], at: PUBLISHER_TRUST.at ?? Date.now(), issued: new WeakMap() };
    for (const root of PUBLISHER_TRUST.roots) ctx.roots.push(certificateOf(base64ToBytes(root)));
    const result = await verifyBlock(sourceOf(input), opts, ctx, input instanceof Uint8Array || input instanceof ArrayBuffer);
    return PUBLISHER_TRUST.test ? { ...result, test: true } : result;
  }

  async function publisherOptions({ key, password, revocationList, statusAnswer }) {
    if (password !== undefined && typeof password !== 'string') throw new JazminValidationError('password must be a string');
    if (revocationList !== undefined && typeof revocationList !== 'string') throw new JazminValidationError('revocationList must be a compact JWS string');
    if (statusAnswer !== undefined && (typeof statusAnswer?.answer !== 'string' || typeof statusAnswer?.nonce !== 'string')) {
      throw new JazminValidationError('statusAnswer must be { answer, nonce } (strings)');
    }
    return {
      key: key === undefined || key === null ? null : await parseKey(key), password, revocationList: revocationList?.trim(),
      statusAnswer: statusAnswer && { answer: statusAnswer.answer.trim(), nonce: statusAnswer.nonce },
    };
  }

  const publisherIds = (arc) => (arc ? { policy: `${arc}.1`, signing: `${arc}.2`, status: `${arc}.3`, kind: `${arc}.5`, log: `${arc}.6` } : null);

  async function verifyBlock(source, opts, ctx, inMemory) {
    const { size } = source;
    const read = (offset, length) => source.read(offset, length);
    // A browser never takes a shared file's master key, whatever the result would be (as open()).
    if (opts.key?.kind === 'owner' && size >= PREAMBLE && view(await read(0, PREAMBLE)).getUint16(4, true) & FLAG_ACCESS) {
      throw Object.assign(new JazminKeyError(MASTER_KEY_REFUSED), { masterKeyRefused: true });
    }
    // A file whose last bytes are not a valid trailer is not a valid file, and isn't verified (6.9.1).
    const t = size >= PREAMBLE + TRAILER ? await publisherTrailer(read, size) : null;
    if (!t) return publisherEmpty('not-verified', 'not-a-valid-file');
    // 1. the block, its CRC, version and coverage
    const found = await findPublisherBlock(read, t);
    if (found.problem) return publisherEmpty('invalid', 'block');
    if (!found.block) return publisherEmpty('none');
    const block = found.block;
    let doc;
    try {
      doc = signedDocumentOf(block.signed);
    } catch {
      return publisherEmpty('invalid', 'block');
    }
    if (doc.version !== 1) return publisherEmpty('invalid', 'block');
    const trailerStart = size - TRAILER;
    const headerEnd = t.header.offset + t.header.length;
    const sections = t.signature.length > 0
      ? headerEnd === t.signature.offset && t.signature.offset + t.signature.length === trailerStart
      : headerEnd === trailerStart;
    // Every section the trailer points to lies in a covered range (6.9.1): the key slots before the block.
    if (!sections || (t.keySlots.length > 0 && t.keySlots.offset + t.keySlots.length > block.b)) return publisherEmpty('changed', 'coverage');

    // 2. D and the file id
    const preamble = await read(0, PREAMBLE);
    const fileId = preamble.slice(8, 24);
    const d = await sha256(utf8.encode('JAZMIN/1/publisher-file'), fileId, await hashRange(read, 0, block.b, inMemory),
      await hashRange(read, t.header.offset, t.header.length, inMemory), await hashRange(read, t.signature.offset, t.signature.length, inMemory));
    if (!equal(doc.fileId, fileId) || !equal(doc.fileDigest, d)) return publisherEmpty('changed', 'digest');

    // 3. algorithms entry for entry, the publisher first, and each signature this reader knows
    const sigs = block.signatures;
    if (sigs.length === 0 || sigs.length !== doc.algorithms.length || sigs.some((s, i) => s.algorithm !== doc.algorithms[i])) return publisherEmpty('invalid', 'algorithms');
    if (sigs[0].role !== 'publisher' || sigs.some((s, i) => i > 0 && s.role !== 'cosigner') || sigs[0].algorithm !== 'ES256') return publisherEmpty('invalid', 'algorithms');
    let certs;
    let pool;
    try {
      certs = sigs.map((s) => s.certificates.map(certificateOf));
      pool = [...certs.flat(), ...block.certificates.map(certificateOf)];
    } catch {
      return publisherEmpty('invalid', 'chain');
    }
    const message = concat(utf8.encode('JAZMIN/1/publisher'), block.signed);
    const checked = [];
    for (let i = 0; i < sigs.length; i++) {
      if (sigs[i].algorithm !== 'ES256') continue; // reserved algorithms (ML-DSA-65) aren't known yet
      if (certs[i].length === 0) return publisherEmpty('invalid', 'chain');
      if (!(await ecdsaVerifies(certs[i][0], 'SHA-256', message, sigs[i].value))) return publisherEmpty('invalid', 'signature');
      checked.push({ sig: sigs[i], chain: await checkChain(ctx, certs[i], ctx.ids?.signing) });
    }
    // "signed": the publisher's certificate doesn't chain to a trusted root. No name, facts or code.
    if (!checked[0].chain.trusted) return publisherEmpty('signed');

    // 4. each chain, timestamp (inside the chain's validity) and log receipt
    const times = [];
    for (const { sig, chain } of checked) {
      if (!chain.trusted || chain.problem) return publisherEmpty('invalid', 'chain');
      const at = await timestampOf(ctx, sig.timestamp, sig.value, pool);
      if (at === null || !validAt(chain, at)) return publisherEmpty('invalid', 'timestamp');
      const entry = concat(utf8.encode('JAZMIN/1/log'), await sha256(block.signed), await sha256(sig.value));
      if ((await receiptIndex(ctx, sig.logReceipt, entry, pool, at)) < 0) return publisherEmpty('invalid', 'log');
      times.push(at);
    }

    // 5. revocation: per certificate, the most recent statement held (6.9.5). Status answers are about the publisher's.
    const publisher = checked[0].chain;
    const expect = { d: bytesToBase64Url(d), code: doc.code, certificate: await certificateName(publisher) };
    const stored = block.status ? await statusAnswerOf(ctx, block.status, pool, { ...expect, nonce: expect.d }) : null;
    const online = opts.statusAnswer ? await statusAnswerOf(ctx, opts.statusAnswer.answer, pool, { ...expect, nonce: opts.statusAnswer.nonce }) : null;
    const list = opts.revocationList ? await revocationListOf(ctx, opts.revocationList) : null;
    let checkedAt = null;
    for (let i = 0; i < checked.length; i++) {
      const statements = [];
      if (i === 0 && stored) statements.push(stored);
      if (list) statements.push({ time: list.issued, revokedFrom: list.revoked.get(await certificateName(checked[i].chain)) ?? null });
      if (i === 0 && online) statements.push(online);
      if (statements.length === 0) continue;
      const newest = statements.reduce((a, b) => (b.time > a.time ? b : a));
      if (i === 0) checkedAt = newest.time;
      if (newest.revokedFrom !== null && newest.revokedFrom <= times[i]) return publisherEmpty('invalid', 'revoked');
    }

    // 6. the facts, with a key that reads the header (or in a file that isn't encrypted)
    const flags = view(preamble).getUint16(4, true);
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
    let facts = null;
    if (doc.factsDigest.length > 0) {
      let plain = encrypted ? null : block.facts;
      if (encrypted && (opts.key || opts.password)) {
        const opened = await openFacts(read, t, preamble, opts, block.facts);
        if (opened === false) return publisherEmpty('invalid', 'facts');
        plain = opened;
      }
      if (plain) {
        if (!equal(await sha256(plain), doc.factsDigest)) return publisherEmpty('invalid', 'facts');
        facts = factsOf(plain.subarray(16));
        if (!facts) return publisherEmpty('invalid', 'facts');
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
      ...identityOf(publisher.leaf, ctx.ids),
      code: doc.code,
      documentKind: doc.kind,
      credential: doc.credential,
      signedAt: isoSecond(doc.signedAt),
      timestamp: isoSecond(times[0]),
      cosigners: checked.slice(1).map((c) => identityOf(c.chain.leaf, ctx.ids)),
      facts,
      factsNeedKey: encrypted,
      statusAnswer: stored ? { status: stored.status, from: stored.from === null ? null : isoSecond(stored.from) } : null,
      checkedAt: checkedAt === null ? null : isoSecond(checkedAt),
    };
  }

  function publisherEmpty(status, reason = null) {
    return {
      status, reason, name: null, organization: null, registration: null, country: null, domain: null, kind: null, code: null,
      documentKind: null, credential: null, signedAt: null, timestamp: null, cosigners: [], facts: null, factsNeedKey: false,
      statusAnswer: null, checkedAt: null,
    };
  }

  // ---- the file: trailer, block, messages ----

  /** A valid trailer at the file's end (4.2), after the magic in the preamble, or null. */
  async function publisherTrailer(read, size) {
    if (fromUtf8.decode(await read(0, 4)) !== 'JZM1') return null;
    const raw = await read(size - TRAILER, TRAILER);
    const v = view(raw);
    if (fromUtf8.decode(raw.subarray(40, 44)) !== 'JZM1' || crc32(raw.subarray(0, 36)) !== v.getUint32(36, true)) return null;
    const header = { offset: Number(v.getBigUint64(0, true)), length: v.getUint32(8, true) };
    const keySlots = { offset: Number(v.getBigUint64(12, true)), length: v.getUint32(20, true) };
    const signature = { offset: Number(v.getBigUint64(24, true)), length: v.getUint32(32, true) };
    const last = Math.max(header.offset + header.length, signature.offset + signature.length);
    return header.offset >= PREAMBLE && last === size - TRAILER ? { header, keySlots, signature } : null;
  }

  /** Step 1: the block before the header. `problem`: the magic is there, but the block is damaged (invalid). */
  async function findPublisherBlock(read, t) {
    const h = t.header.offset;
    if (h < PREAMBLE + PS_FOOTER) return {};
    const footer = await read(h - PS_FOOTER, PS_FOOTER);
    if (fromUtf8.decode(footer.subarray(12)) !== 'JZPS') return {};
    const v = view(footer);
    const length = v.getUint32(0, true);
    const b = h - PS_FOOTER - length;
    if (b < PREAMBLE) return { problem: 'the payload would start inside the preamble' };
    if (v.getUint16(8, true) !== 1) return { problem: 'unknown version' };
    if (v.getUint16(10, true) !== 0) return { problem: 'non-zero reserved' };
    const payload = await read(b, length);
    if (crc32(payload) !== v.getUint32(4, true)) return { problem: 'CRC' };
    try {
      return { block: { ...publisherSignaturesOf(payload), b } };
    } catch {
      return { problem: 'not a PublisherSignatures' };
    }
  }

  function publisherSignaturesOf(bytes) {
    const m = { signed: new Uint8Array(0), signatures: [], facts: new Uint8Array(0), status: '', certificates: [] };
    readMessage(bytes, (field, v) => {
      if (field === 1) m.signed = bytesOf(v);
      else if (field === 2) m.signatures.push(publisherSignatureOf(bytesOf(v)));
      else if (field === 3) m.facts = bytesOf(v);
      else if (field === 4) m.status = text(v);
      else if (field === 5) m.certificates.push(bytesOf(v));
    });
    return m;
  }

  function publisherSignatureOf(bytes) {
    const s = { algorithm: '', value: new Uint8Array(0), certificates: [], role: '', timestamp: new Uint8Array(0), logReceipt: '' };
    readMessage(bytes, (field, v) => {
      if (field === 1) s.algorithm = text(v);
      else if (field === 2) s.value = bytesOf(v);
      else if (field === 3) s.certificates.push(bytesOf(v));
      else if (field === 4) s.role = text(v);
      else if (field === 5) s.timestamp = bytesOf(v);
      else if (field === 6) s.logReceipt = text(v);
    });
    return s;
  }

  function signedDocumentOf(bytes) {
    const d = { version: 0, fileId: new Uint8Array(0), fileDigest: new Uint8Array(0), code: '', kind: '', factsDigest: new Uint8Array(0), algorithms: [], credential: '', signedAt: 0 };
    readMessage(bytes, (field, v) => {
      if (field === 1) d.version = num(v);
      else if (field === 2) d.fileId = bytesOf(v);
      else if (field === 3) d.fileDigest = bytesOf(v);
      else if (field === 4) d.code = text(v);
      else if (field === 5) d.kind = text(v);
      else if (field === 6) d.factsDigest = bytesOf(v);
      else if (field === 7) d.algorithms.push(text(v));
      else if (field === 8) d.credential = text(v);
      else if (field === 9) d.signedAt = num(v);
    });
    return d;
  }

  /** SHA-256 of bytes [offset, offset + length): WebCrypto for a small range, else in 1 MiB slices. */
  async function hashRange(read, offset, length, inMemory) {
    if (length <= PS_CHUNK || inMemory) return sha256(await read(offset, length));
    const hash = sha256Stream();
    for (let at = 0; at < length; at += PS_CHUNK) hash.update(await read(offset + at, Math.min(PS_CHUNK, length - at)));
    return hash.digest();
  }

  // ---- facts (6.9.3) ----

  /**
   * The facts of an encrypted file: their bytes, null when the key can't read the header (a wrong key or password, or a
   * key without a slot), or false when the key reads the header but not the facts.
   */
  async function openFacts(read, t, preamble, { key, password }, stored) {
    const flags = view(preamble).getUint16(4, true);
    const fileId = preamble.slice(8, 24);
    const salt = preamble.slice(24, 56);
    let ikm;
    let readsHeader = null; // key and password files: whether the key reads the header, asked only when the facts fail
    try {
      if (flags & FLAG_ACCESS) {
        if (password !== undefined || !key || !t.keySlots.length) return null;
        const id = await slotId(key.secret);
        const page = findPage(plainPayload(await read(t.keySlots.offset, t.keySlots.length)), id);
        if (!page) return null;
        const pageSection = await read(page.offset, page.length);
        if (!equal(await sha256(pageSection), page.digest)) return null;
        const slot = findSlot(plainPayload(pageSection), id);
        if (!slot || slot.online) return null; // an online slot needs an unlock token
        const kek = await hkdf(key.secret, salt, 'JAZMIN/1/slot');
        const bundle = parseJson(fromUtf8.decode(await decrypt(kek, slot.sealed, concat(fileId, id))), 'A key slot', true);
        if (typeof bundle.header !== 'string') return null;
        ikm = base64ToBytes(bundle.header); // H: the slot opened, so this key reads the header
      } else {
        if (key?.kind === 'access') return null;
        if (password !== undefined) {
          const iterations = view(preamble).getUint32(56, true);
          if (!(flags & FLAG_PASSWORD) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) return null;
          ikm = await pbkdf2(password, salt, iterations);
        } else ikm = key.bytes;
        readsHeader = async () => {
          const section = await read(t.header.offset, t.header.length);
          const payload = section.subarray(ENVELOPE, ENVELOPE + view(section).getUint32(8, true));
          await decrypt(await hkdf(ikm, salt, 'JAZMIN/1/header'), payload, concat(fileId, section.subarray(0, 8), utf8.encode('header')));
          return true;
        };
      }
    } catch {
      return null; // a damaged key-slot section
    }
    try {
      const envelope = new Uint8Array(8);
      envelope[1] = 0x01; // codec 0, ENCRYPTED (7.4)
      view(envelope).setUint32(4, Math.max(0, stored.length - 28), true);
      return await decrypt(await hkdf(ikm, salt, 'JAZMIN/1/publisher/facts'), stored, concat(fileId, envelope, utf8.encode('publisher/facts')));
    } catch {
      if (!readsHeader) return false;
      try {
        return (await readsHeader()) ? false : null;
      } catch {
        return null; // the key doesn't read the header either: not this file's key
      }
    }
  }

  /** The payload of a section stored as is (the key slots are never encrypted or compressed), its CRC checked. */
  function plainPayload(section) {
    if (section.length < ENVELOPE || section[0] !== CODEC_NONE || section[1] !== 0) throw new JazminFormatError('A key-slot section must be stored as is');
    const v = view(section);
    const payload = section.subarray(ENVELOPE, ENVELOPE + v.getUint32(8, true));
    if (payload.length !== v.getUint32(8, true) || crc32(payload) !== v.getUint32(12, true)) throw new JazminFormatError('A key-slot section failed its CRC-32 check');
    return payload;
  }

  /** Facts: a JSON object of text values (6.9.3), or null. */
  function factsOf(bytes) {
    let value;
    try {
      value = parseJson(fromUtf8.decode(bytes), 'Facts', true);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const v of Object.values(value)) if (typeof v !== 'string') return null;
    return value;
  }

  // ---- a small, strict DER reader (6.9.4: no general X.509 processing) ----

  const DER = Object.freeze({
    BOOLEAN: 0x01, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, UTF8: 0x0c,
    PRINTABLE: 0x13, IA5: 0x16, UTC_TIME: 0x17, GENERALIZED_TIME: 0x18, SEQUENCE: 0x30, SET: 0x31,
  });

  function derElement(buf, pos, end) {
    if (pos + 2 > end) throw new Error('DER: truncated');
    const tag = buf[pos];
    if ((tag & 0x1f) === 0x1f) throw new Error('DER: multi-byte tag');
    let length = buf[pos + 1];
    let body = pos + 2;
    if (length & 0x80) {
      const n = length & 0x7f;
      if (n === 0 || n > 4) throw new Error('DER: indefinite or oversized length');
      if (body + n > end || buf[body] === 0) throw new Error('DER: length is not minimal');
      length = 0;
      for (let i = 0; i < n; i++) length = length * 256 + buf[body + i];
      if (length < 0x80) throw new Error('DER: length is not minimal');
      body += n;
    }
    if (body + length > end) throw new Error('DER: truncated');
    return { tag, start: pos, body, end: body + length, buf };
  }

  class DerReader {
    constructor(buf, pos = 0, end = buf.length) {
      this.buf = buf;
      this.pos = pos;
      this.end = end;
    }

    static of(el) {
      return new DerReader(el.buf, el.body, el.end);
    }

    get more() {
      return this.pos < this.end;
    }

    peek() {
      return this.pos < this.end ? this.buf[this.pos] : -1;
    }

    next(tag) {
      const el = derElement(this.buf, this.pos, this.end);
      if (tag !== undefined && el.tag !== tag) throw new Error('DER: unexpected tag');
      this.pos = el.end;
      return el;
    }

    optional(tag) {
      return this.peek() === tag ? this.next(tag) : null;
    }

    sequence(tag = DER.SEQUENCE) {
      return DerReader.of(this.next(tag));
    }

    done() {
      if (this.pos !== this.end) throw new Error('DER: unexpected data');
    }
  }

  const derRaw = (el) => el.buf.subarray(el.start, el.end);
  const derContents = (el) => el.buf.subarray(el.body, el.end);

  function derOne(buf, tag) {
    const r = new DerReader(buf);
    const el = r.next(tag);
    r.done();
    return el;
  }

  function derOid(el) {
    if (el.tag !== DER.OID) throw new Error('DER: expected an object identifier');
    const b = derContents(el);
    if (b.length === 0) throw new Error('DER: empty object identifier');
    const arcs = [];
    let value = 0n;
    let started = false;
    for (let i = 0; i < b.length; i++) {
      if (!started && b[i] === 0x80) throw new Error('DER: object identifier is not minimal');
      started = true;
      value = (value << 7n) | BigInt(b[i] & 0x7f);
      if ((b[i] & 0x80) === 0) {
        if (arcs.length === 0) {
          const first = value < 40n ? 0n : value < 80n ? 1n : 2n;
          arcs.push(first, value - first * 40n);
        } else arcs.push(value);
        value = 0n;
        started = false;
      } else if (i === b.length - 1) throw new Error('DER: truncated object identifier');
    }
    return arcs.join('.');
  }

  function derInteger(el) {
    if (el.tag !== DER.INTEGER) throw new Error('DER: expected an integer');
    const b = derContents(el);
    if (b.length === 0) throw new Error('DER: empty integer');
    if (b.length > 1 && ((b[0] === 0 && b[1] < 0x80) || (b[0] === 0xff && b[1] >= 0x80))) throw new Error('DER: integer is not minimal');
    return b;
  }

  function derSmall(el) {
    const b = derInteger(el);
    if (b[0] & 0x80 || b.length > 6) throw new Error('DER: integer out of range');
    let n = 0;
    for (const x of b) n = n * 256 + x;
    return n;
  }

  function derBoolean(el) {
    const b = derContents(el);
    if (el.tag !== DER.BOOLEAN || b.length !== 1 || (b[0] !== 0 && b[0] !== 0xff)) throw new Error('DER: invalid boolean');
    return b[0] === 0xff;
  }

  function derBits(el) {
    const b = derContents(el);
    if (el.tag !== DER.BIT_STRING || b.length === 0 || b[0] > 7 || (b.length === 1 && b[0] !== 0)) throw new Error('DER: invalid bit string');
    const bytes = b.subarray(1);
    if (b[0] && bytes[bytes.length - 1] & ((1 << b[0]) - 1)) throw new Error('DER: bit string has unused bits set');
    return { unused: b[0], bytes };
  }

  function derOctets(el) {
    if (el.tag !== DER.OCTET_STRING) throw new Error('DER: expected an octet string');
    return derContents(el);
  }

  function derString(el) {
    const b = derContents(el);
    if (el.tag === DER.UTF8) return fromUtf8.decode(b);
    if (el.tag !== DER.PRINTABLE && el.tag !== DER.IA5) throw new Error('DER: unsupported string type');
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return s;
  }

  /** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSS[.fff]Z), as milliseconds since 1970. */
  function derTime(el) {
    const s = derString({ ...el, tag: DER.IA5 });
    let m;
    let year;
    if (el.tag === DER.UTC_TIME && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) {
      year = Number(m[1]);
      year += year < 50 ? 2000 : 1900;
    } else if (el.tag === DER.GENERALIZED_TIME && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d*[1-9]))?Z$/.exec(s))) {
      year = Number(m[1]);
    } else throw new Error('DER: invalid time');
    const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
    const t = Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
    const d = new Date(t);
    if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3]) || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) {
      throw new Error('DER: invalid time');
    }
    return t;
  }

  // ---- certificates (6.9.4) ----

  /** A certificate read with the strict DER reader: what the profile and the chains need. */
  function certificateOf(der) {
    const outer = new DerReader(der);
    const certEl = outer.next(DER.SEQUENCE);
    outer.done();
    const c = DerReader.of(certEl);
    const tbsEl = c.next(DER.SEQUENCE);
    const algorithm = c.sequence();
    const signatureAlgorithm = derOid(algorithm.next(DER.OID));
    algorithm.done();
    const signature = derBits(c.next(DER.BIT_STRING));
    if (signature.unused) throw new Error('certificate signature');
    c.done();
    const t = DerReader.of(tbsEl);
    let version = 1;
    const versionEl = t.optional(0xa0);
    if (versionEl) {
      const v = DerReader.of(versionEl);
      version = derSmall(v.next(DER.INTEGER)) + 1;
      v.done();
    }
    const serial = derInteger(t.next(DER.INTEGER));
    const inner = t.sequence();
    if (derOid(inner.next(DER.OID)) !== signatureAlgorithm) throw new Error('signature algorithms differ');
    inner.done();
    const issuer = derRaw(t.next(DER.SEQUENCE));
    const validity = t.sequence();
    const notBefore = derTime(validity.next());
    const notAfter = derTime(validity.next());
    validity.done();
    const subject = derRaw(t.next(DER.SEQUENCE));
    const spkiEl = t.next(DER.SEQUENCE);
    const spki = DerReader.of(spkiEl);
    const keyAlgorithm = spki.sequence();
    const keyOid = derOid(keyAlgorithm.next(DER.OID));
    const curve = keyAlgorithm.peek() === DER.OID ? derOid(keyAlgorithm.next(DER.OID)) : '';
    keyAlgorithm.done();
    derBits(spki.next(DER.BIT_STRING));
    spki.done();
    const extensions = new Map();
    const extensionsEl = t.optional(0xa3);
    if (extensionsEl) {
      const wrapper = DerReader.of(extensionsEl);
      const list = wrapper.sequence();
      wrapper.done();
      while (list.more) {
        const e = list.sequence();
        const id = derOid(e.next(DER.OID));
        let critical = false;
        if (e.peek() === DER.BOOLEAN) {
          critical = derBoolean(e.next(DER.BOOLEAN));
          if (!critical) throw new Error('DER: a default value is encoded');
        }
        const value = derOctets(e.next(DER.OCTET_STRING));
        e.done();
        if (extensions.has(id)) throw new Error(`extension ${id} twice`);
        extensions.set(id, { critical, value });
      }
    }
    t.done();
    return {
      raw: derRaw(certEl), tbs: derRaw(tbsEl), signatureAlgorithm, signature: signature.bytes, version, serialHex: toHex(serial),
      issuer, subject, notBefore, notAfter, spki: derRaw(spkiEl), keyAlgorithm: keyOid, curve, extensions, key: null, attributes: null,
    };
  }

  /** The certificate's key for WebCrypto (ECDSA P-256 or P-384), or null when it has none this reader can use. */
  function publicKeyOf(c) {
    const curve = c.keyAlgorithm === PS_OID.ecPublicKey ? (c.curve === PS_OID.p256 ? 'P-256' : c.curve === PS_OID.p384 ? 'P-384' : null) : null;
    c.key ??= curve
      ? subtle.importKey('spki', c.spki, { name: 'ECDSA', namedCurve: curve }, false, ['verify']).then((k) => ({ key: k, size: curve === 'P-256' ? 32 : 48 }), () => null)
      : Promise.resolve(null);
    return c.key;
  }

  /** ECDSA with this certificate's key over `data`: `signature` as r || s, or DER (der: true). */
  async function ecdsaVerifies(c, hash, data, signature, der = false) {
    const k = await publicKeyOf(c);
    if (!k) return false;
    try {
      const raw = der ? ecdsaRaw(signature, k.size) : signature;
      return raw !== null && await subtle.verify({ name: 'ECDSA', hash }, k.key, raw, data);
    } catch {
      return false;
    }
  }

  /** A DER ECDSA signature (SEQUENCE { r, s }) as r || s of `size` bytes each, or null. */
  function ecdsaRaw(der, size) {
    try {
      const r = new DerReader(der);
      const seq = r.sequence();
      r.done();
      const out = new Uint8Array(2 * size);
      for (let i = 0; i < 2; i++) {
        let n = derInteger(seq.next(DER.INTEGER));
        if (n[0] & 0x80) return null;
        while (n.length > 1 && n[0] === 0) n = n.subarray(1);
        if (n.length > size) return null;
        out.set(n, (i + 1) * size - n.length);
      }
      seq.done();
      return out;
    } catch {
      return null;
    }
  }

  function attributesOf(c) {
    if (c.attributes) return c.attributes;
    const result = new Map();
    const name = DerReader.of(derOne(c.subject, DER.SEQUENCE));
    while (name.more) {
      const set = name.sequence(DER.SET);
      while (set.more) {
        const pair = set.sequence();
        const id = derOid(pair.next(DER.OID));
        result.set(id, derString(pair.next()));
        pair.done();
      }
    }
    c.attributes = result;
    return result;
  }

  const extensionOf = (c, id) => c.extensions.get(id) ?? null;

  function subjectKeyIdOf(c) {
    const e = extensionOf(c, PS_OID.subjectKeyId);
    return e ? derOctets(derOne(e.value, DER.OCTET_STRING)) : null;
  }

  function authorityKeyIdOf(c) {
    const e = extensionOf(c, PS_OID.authorityKeyId);
    if (!e) return null;
    const keyId = DerReader.of(derOne(e.value, DER.SEQUENCE)).optional(0x80);
    return keyId ? derContents(keyId) : null;
  }

  function oidListOf(value, policies) {
    const list = [];
    const seq = DerReader.of(derOne(value, DER.SEQUENCE));
    while (seq.more) list.push(policies ? derOid(seq.sequence().next(DER.OID)) : derOid(seq.next(DER.OID)));
    return list;
  }

  /** The certificate's one extended key usage, or null. */
  function extendedKeyUsageOf(c) {
    const e = extensionOf(c, PS_OID.extKeyUsage);
    if (!e) return null;
    const list = oidListOf(e.value, false);
    return list.length === 1 ? list[0] : null;
  }

  function keyUsageBitsOf(value) {
    const { unused, bytes } = derBits(derOne(value, DER.BIT_STRING));
    const bits = [];
    for (let i = 0; i < bytes.length * 8 - unused; i++) if (bytes[i >> 3] & (0x80 >> (i & 7))) bits.push(i);
    return bits.join(',');
  }

  const kindTextOf = (value) => derString(derOne(value, DER.UTF8));

  /**
   * The profile's rows (6.9.4): a root and a cross-certificate P-384 signed with ecdsa-with-SHA384, path length 2; an
   * issuing certificate P-256 signed with ecdsa-with-SHA384, path length 0; leaves P-256 signed with ecdsa-with-SHA256
   * and one extended key usage. Only the listed extensions, with their criticality. A problem, or null.
   */
  function profileProblem(c, role, eku, ids) {
    try {
      if (c.version !== 3) return 'not X.509 v3';
      if (c.keyAlgorithm !== PS_OID.ecPublicKey || c.curve !== (role === 'root' || role === 'cross' ? PS_OID.p384 : PS_OID.p256)) return 'key';
      if (c.signatureAlgorithm !== (role === 'leaf' ? PS_OID.ecdsaSha256 : PS_OID.ecdsaSha384)) return 'signature algorithm';
      const publisher = role === 'leaf' && eku === ids.signing;
      for (const [id, e] of c.extensions) {
        let allowed;
        if (id === PS_OID.basicConstraints || id === PS_OID.keyUsage) allowed = e.critical;
        else if (id === PS_OID.extKeyUsage) allowed = role === 'leaf' && e.critical === (eku === PS_OID.timeStamping);
        else if (id === PS_OID.policies || id === PS_OID.subjectKeyId || id === PS_OID.authorityKeyId) allowed = !e.critical;
        else if (id === PS_OID.subjectAltName) allowed = publisher && !e.critical;
        else if (id === ids.kind) allowed = publisher && !e.critical && (kindTextOf(e.value) === 'company' || kindTextOf(e.value) === 'individual');
        else allowed = false;
        if (!allowed) return `extension ${id}`;
      }
      let ca = false;
      let pathLength = null;
      const basic = extensionOf(c, PS_OID.basicConstraints);
      if (basic) {
        const seq = DerReader.of(derOne(basic.value, DER.SEQUENCE));
        if (seq.peek() === DER.BOOLEAN) ca = derBoolean(seq.next(DER.BOOLEAN));
        if (seq.more) pathLength = derSmall(seq.next(DER.INTEGER));
        seq.done();
      }
      const usage = extensionOf(c, PS_OID.keyUsage);
      const bits = usage ? keyUsageBitsOf(usage.value) : null;
      if (role === 'leaf') {
        if (ca) return 'a leaf that is a CA';
        if (bits !== '0') return 'key usage';
        if (extendedKeyUsageOf(c) !== eku) return 'extended key usage';
      } else {
        if (!ca || pathLength !== (role === 'issuing' ? 0 : 2)) return 'basic constraints';
        if (bits !== '5,6') return 'key usage';
        if (!subjectKeyIdOf(c)) return 'subject key identifier';
      }
      if (role !== 'root' && !authorityKeyIdOf(c)) return 'authority key identifier';
      const policies = extensionOf(c, PS_OID.policies);
      if (!policies || !oidListOf(policies.value, true).includes(ids.policy)) return 'certificate policy';
      attributesOf(c);
      return null;
    } catch {
      return 'not in the profile';
    }
  }

  /** Whether `issuer` issued `child`: its name, its key identifier when the child names one, and its signature. */
  function issuedBy(ctx, issuer, child) {
    let known = ctx.issued.get(child);
    if (!known) ctx.issued.set(child, (known = new Map()));
    if (!known.has(issuer)) {
      known.set(issuer, (async () => {
        try {
          const aki = authorityKeyIdOf(child);
          const ski = subjectKeyIdOf(issuer);
          const hash = child.signatureAlgorithm === PS_OID.ecdsaSha256 ? 'SHA-256' : child.signatureAlgorithm === PS_OID.ecdsaSha384 ? 'SHA-384' : null;
          return equal(child.issuer, issuer.subject) && (aki === null || (ski !== null && equal(aki, ski))) && hash !== null
            && await ecdsaVerifies(issuer, hash, child.tbs, child.signature, true);
        } catch {
          return false;
        }
      })());
    }
    return known.get(issuer);
  }

  async function findIssuer(ctx, candidates, child) {
    for (const c of candidates) if (await issuedBy(ctx, c, child)) return c;
    return null;
  }

  /**
   * A chain as a signature lists it (6.9.4): the leaf, its issuing certificate, optionally a cross-certificate. Trusted
   * when it reaches a built-in root; `problem` when a trusted chain is outside the profile.
   */
  async function checkChain(ctx, listed, eku) {
    const leaf = listed[0];
    const untrusted = { trusted: false, problem: null, leaf, certificates: [leaf] };
    if (!ctx.ids || !eku || listed.length < 2 || listed.length > 3) return untrusted; // a self-signed certificate alone, or no chain the profile has
    const [, issuing, cross] = listed;
    if (!(await issuedBy(ctx, issuing, leaf))) return untrusted;
    const root = cross
      ? ((await issuedBy(ctx, cross, issuing)) ? await findIssuer(ctx, ctx.roots, cross) : null)
      : await findIssuer(ctx, ctx.roots, issuing);
    if (!root) return untrusted;
    const problem = profileProblem(leaf, 'leaf', eku, ctx.ids) ?? profileProblem(issuing, 'issuing', null, ctx.ids)
      ?? (cross ? profileProblem(cross, 'cross', null, ctx.ids) : null) ?? profileProblem(root, 'root', null, ctx.ids);
    return { trusted: true, problem, leaf, certificates: cross ? [leaf, issuing, cross, root] : [leaf, issuing, root] };
  }

  /** The chain of a certificate the block shares (6.9.6), its issuing and any cross-certificate found in the pool. */
  async function buildChain(ctx, leaf, pool, eku) {
    const issuing = await findIssuer(ctx, pool, leaf);
    if (!issuing) return checkChain(ctx, [leaf], eku);
    if (await findIssuer(ctx, ctx.roots, issuing)) return checkChain(ctx, [leaf, issuing], eku);
    const cross = await findIssuer(ctx, pool, issuing);
    return checkChain(ctx, cross ? [leaf, issuing, cross] : [leaf, issuing], eku);
  }

  const validAt = (chain, t) => chain.certificates.every((c) => t >= c.notBefore && t <= c.notAfter);

  /** A certificate's name in status answers and revocation lists (6.9.5): the issuing certificate's key, and the serial. */
  const certificateName = async (chain) => `${bytesToBase64Url(await sha256(chain.certificates[1].spki))}/${chain.certificates[0].serialHex}`;

  function identityOf(c, ids) {
    const a = attributesOf(c);
    let domain = null;
    const san = extensionOf(c, PS_OID.subjectAltName);
    if (san) {
      const names = DerReader.of(derOne(san.value, DER.SEQUENCE));
      while (names.more && domain === null) {
        const el = names.next();
        if (el.tag === 0x82) domain = derString({ ...el, tag: DER.IA5 }); // dNSName
      }
    }
    const kind = ids ? extensionOf(c, ids.kind) : null;
    return {
      name: a.get(PS_OID.commonName) ?? null,
      organization: a.get(PS_OID.organization) ?? null,
      registration: a.get(PS_OID.organizationIdentifier) ?? null,
      country: a.get(PS_OID.country) ?? null,
      domain,
      kind: kind ? kindTextOf(kind.value) : null,
    };
  }

  // ---- time, the log and status (6.9.5) ----

  /**
   * An RFC 3161 token over SHA-256(value) by a time-stamping certificate whose chain is trusted, with id-jazmin-policy:
   * the time it proves (milliseconds), or null. CMS SignedData with one signer, read with the strict DER reader.
   */
  async function timestampOf(ctx, token, value, pool) {
    try {
      const top = new DerReader(token);
      const info = top.sequence();
      top.done();
      if (derOid(info.next(DER.OID)) !== PS_OID.signedData) return null;
      const explicit = DerReader.of(info.next(0xa0));
      info.done();
      const sd = explicit.sequence();
      explicit.done();
      sd.next(DER.INTEGER); // version
      sd.next(DER.SET); // digestAlgorithms
      const encap = sd.sequence();
      if (derOid(encap.next(DER.OID)) !== PS_OID.tstInfo) return null;
      const wrapped = DerReader.of(encap.next(0xa0));
      encap.done();
      const eContent = derOctets(wrapped.next(DER.OCTET_STRING));
      wrapped.done();
      const own = [];
      const certificatesEl = sd.optional(0xa0);
      if (certificatesEl) for (const r = DerReader.of(certificatesEl); r.more;) own.push(certificateOf(derRaw(r.next(DER.SEQUENCE))));
      sd.optional(0xa1); // revocation information: not used
      const signers = DerReader.of(sd.next(DER.SET));
      sd.done();
      const si = signers.sequence();
      if (signers.more) return null; // one signer
      si.next(DER.INTEGER); // version
      let isSigner;
      if (si.peek() === DER.SEQUENCE) {
        const ias = si.sequence();
        const issuerName = derRaw(ias.next(DER.SEQUENCE));
        const serial = toHex(derInteger(ias.next(DER.INTEGER)));
        ias.done();
        isSigner = (c) => equal(c.issuer, issuerName) && c.serialHex === serial;
      } else {
        const id = derContents(si.next(0x80));
        isSigner = (c) => {
          const ski = subjectKeyIdOf(c);
          return ski !== null && equal(ski, id);
        };
      }
      if (!sha256AlgorithmIn(si.sequence())) return null;
      const attributesEl = si.next(0xa0);
      const signatureAlgorithm = si.sequence();
      if (derOid(signatureAlgorithm.next(DER.OID)) !== PS_OID.ecdsaSha256) return null;
      signatureAlgorithm.done();
      const signature = derOctets(si.next(DER.OCTET_STRING));
      si.optional(0xa1); // unsigned attributes
      si.done();

      const attrs = new Map();
      for (const r = DerReader.of(attributesEl); r.more;) {
        const a = r.sequence();
        const type = derOid(a.next(DER.OID));
        const values = DerReader.of(a.next(DER.SET));
        a.done();
        const v = values.next();
        if (values.more || attrs.has(type)) return null;
        attrs.set(type, v);
      }
      if (derOid(attrs.get(PS_OID.contentType)) !== PS_OID.tstInfo) return null;
      if (!equal(derOctets(attrs.get(PS_OID.messageDigest)), await sha256(eContent))) return null;
      // signingCertificateV2: the first ESSCertIDv2 names the signer's certificate by its SHA-256
      const essIds = DerReader.of(attrs.get(PS_OID.signingCertificateV2)).sequence();
      const first = essIds.sequence();
      if (first.peek() === DER.SEQUENCE && !sha256AlgorithmIn(first.sequence())) return null;
      const certHash = derOctets(first.next(DER.OCTET_STRING));
      const candidates = [...pool, ...own];
      let signer = null;
      for (const c of candidates) if (isSigner(c) && equal(await sha256(c.raw), certHash)) signer = signer ?? c;
      if (!signer) return null;
      const signedAttributes = derRaw(attributesEl).slice();
      signedAttributes[0] = DER.SET; // signed as a SET OF, stored as [0] IMPLICIT
      if (!(await ecdsaVerifies(signer, 'SHA-256', signedAttributes, signature, true))) return null;

      const tr = new DerReader(eContent);
      const tst = tr.sequence();
      tr.done();
      if (derSmall(tst.next(DER.INTEGER)) !== 1) return null;
      if (derOid(tst.next(DER.OID)) !== ctx.ids.policy) return null;
      const imprint = tst.sequence();
      if (!sha256AlgorithmIn(imprint.sequence())) return null;
      if (!equal(derOctets(imprint.next(DER.OCTET_STRING)), await sha256(value))) return null;
      imprint.done();
      derInteger(tst.next(DER.INTEGER)); // serial number
      const at = derTime(tst.next(DER.GENERALIZED_TIME));
      const chain = await buildChain(ctx, signer, candidates, PS_OID.timeStamping);
      return chain.trusted && !chain.problem && validAt(chain, at) ? at : null;
    } catch {
      return null;
    }
  }

  function sha256AlgorithmIn(r) {
    if (derOid(r.next(DER.OID)) !== PS_OID.sha256) return false;
    r.optional(DER.NULL);
    r.done();
    return true;
  }

  /**
   * A C2SP checkpoint signed (type 0x02: DER ECDSA over SHA-256 of the note's text) by a trusted log certificate's key,
   * valid at `at`, whose commonName is the origin and the key name: { size, root }, or null.
   */
  async function checkpointOf(ctx, note, pool, at) {
    const split = note.indexOf('\n\n');
    if (split < 0) return null;
    const body = note.slice(0, split + 1);
    const lines = body.slice(0, -1).split('\n');
    if (lines.length < 3 || !/^\d+$/.test(lines[1])) return null;
    const textBytes = utf8.encode(body);
    let verified = false;
    for (const log of pool) {
      if (verified || extendedKeyUsageOf(log) !== ctx.ids.log) continue;
      const chain = await buildChain(ctx, log, pool, ctx.ids.log);
      if (!chain.trusted || chain.problem || !validAt(chain, at)) continue;
      const name = attributesOf(log).get(PS_OID.commonName);
      if (lines[0] !== name) continue;
      const id = (await sha256(log.spki)).subarray(0, 4);
      for (const line of note.slice(split + 2).split('\n')) {
        const fields = line.split(' ');
        if (fields.length !== 3 || fields[0] !== '\u2014' || fields[1] !== name) continue;
        const sig = strictBase64(fields[2]);
        if (sig && sig.length > 4 && equal(sig.subarray(0, 4), id) && await ecdsaVerifies(log, 'SHA-256', textBytes, sig.subarray(4), true)) verified = true;
      }
    }
    if (!verified) return null;
    const root = strictBase64(lines[2]);
    return root?.length === 32 ? { size: BigInt(lines[1]), root } : null;
  }

  /** A receipt (C2SP tlog-proof@v1) for this entry: the index it proves, or -1. */
  async function receiptIndex(ctx, receiptText, entry, pool, at) {
    let pos = 0;
    const line = () => {
      const nl = receiptText.indexOf('\n', pos);
      if (nl < 0) throw new Error('the receipt ends early');
      const l = receiptText.slice(pos, nl);
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
        const hash = strictBase64(l);
        if (!hash) return -1;
        proof.push(hash);
      }
      const cp = await checkpointOf(ctx, receiptText.slice(pos), pool, at);
      return cp && (await inclusionHolds(index, cp.size, await sha256(new Uint8Array([0]), entry), proof, cp.root)) ? Number(index) : -1;
    } catch {
      return -1;
    }
  }

  /** RFC 9162 section 2.1.3.2: whether `proof` places the leaf at `index` in a tree of `size` with this root. */
  async function inclusionHolds(index, size, leafHash, proof, root) {
    if (index >= size) return false;
    const one = new Uint8Array([1]);
    let fn = index;
    let sn = size - 1n;
    let r = leafHash;
    for (const p of proof) {
      if (p.length !== 32 || sn === 0n) return false;
      if ((fn & 1n) === 1n || fn === sn) {
        r = await sha256(one, p, r);
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      } else r = await sha256(one, r, p);
      fn >>= 1n;
      sn >>= 1n;
    }
    return sn === 0n && equal(r, root);
  }

  /**
   * A compact JWS (ES256) from a trusted certificate with this extended key usage, valid at the payload's time, which is
   * not after the time of verifying. x5t#S256 names the certificate, which is in x5c or among the block's certificates.
   */
  async function jwsPayload(ctx, jwsText, eku, timeField, pool) {
    const parts = jwsText.split('.');
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
    try {
      const header = parseJson(fromUtf8.decode(base64UrlToBytes(parts[0])), 'JWS header', true);
      const thumbprint = header?.['x5t#S256'];
      if (header?.alg !== 'ES256' || typeof thumbprint !== 'string') return null;
      const chains = [];
      if (Array.isArray(header.x5c)) chains.push(await checkChain(ctx, header.x5c.map((c) => certificateOf(strictBase64(c) ?? new Uint8Array(0))), eku));
      else {
        for (const c of pool) if (bytesToBase64Url(await sha256(c.raw)) === thumbprint) chains.push(await buildChain(ctx, c, pool, eku));
      }
      const input = utf8.encode(`${parts[0]}.${parts[1]}`);
      const signature = base64UrlToBytes(parts[2]);
      for (const chain of chains) {
        if (!chain.trusted || chain.problem || bytesToBase64Url(await sha256(chain.leaf.raw)) !== thumbprint) continue;
        if (!(await ecdsaVerifies(chain.leaf, 'SHA-256', input, signature))) continue;
        const payload = parseJson(fromUtf8.decode(base64UrlToBytes(parts[1])), 'JWS payload', true);
        const t = rfc3339Of(payload?.[timeField]);
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
  async function statusAnswerOf(ctx, jwsText, pool, expect) {
    const p = ctx.ids ? await jwsPayload(ctx, jwsText, ctx.ids.status, 'time', pool) : null;
    if (!p || !PS_STATUSES.has(p.status) || p.digest !== expect.d || p.code !== expect.code || p.nonce !== expect.nonce) return null;
    if (typeof p.nonce !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.nonce) || base64UrlToBytes(p.nonce).length < 16) return null;
    if (certificateNameOf(p.certificate) !== expect.certificate) return null;
    const from = p.from === undefined || p.from === null ? null : rfc3339Of(p.from);
    if (from === null && (p.status !== 'valid' || (p.from !== undefined && p.from !== null))) return null; // from is REQUIRED with revoked, withdrawn and superseded
    return { status: p.status, from, time: rfc3339Of(p.time), revokedFrom: p.status === 'revoked' ? from : null };
  }

  /** A revocation list (6.9.5): { issued, revoked: Map(name, from) }, or null when it doesn't verify. */
  async function revocationListOf(ctx, jwsText) {
    const p = ctx.ids ? await jwsPayload(ctx, jwsText, ctx.ids.status, 'issued', []) : null;
    if (!p || !Array.isArray(p.revoked)) return null;
    const revoked = new Map();
    for (const entry of p.revoked) {
      const name = certificateNameOf(entry?.certificate);
      const from = rfc3339Of(entry?.from);
      if (name === null || from === null) return null;
      revoked.set(name, Math.min(from, revoked.get(name) ?? Infinity));
    }
    return { issued: rfc3339Of(p.issued), revoked };
  }

  const certificateNameOf = (c) => (typeof c?.issuer === 'string' && typeof c?.serial === 'string' ? `${c.issuer}/${c.serial}` : null);

  function rfc3339Of(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s)) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  function isoSecond(ms) {
    const d = new Date(Number(ms));
    return Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
  }

  /** Standard base64 with padding, strictly: bytes, or null. */
  function strictBase64(s) {
    if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
    return base64ToBytes(s);
  }

  const API_PUBLISHER = { verifyPublisher };
