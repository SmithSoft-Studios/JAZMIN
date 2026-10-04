// JAZMIN browser reader: read-only, async, no dependencies (TASKS F-2). Runs in browsers (also from file://) and in
// Node 22+, using WebCrypto and DecompressionStream. Reads format 1.0 files: plain, key, password and
// access-controlled (owner and access keys, online keys with an unlock token), appended files, several tables and
// embedded files. Files are read in slices (a File or Blob is never loaded whole). Brotli sections cannot be read:
// browsers have no Brotli decompressor.
// A classic script (browsers block module scripts on file://): it defines globalThis.JazminBrowser.
(function (global) {
  'use strict';

  const PREAMBLE = 64;
  const TRAILER = 44;
  const ENVELOPE = 16;
  const FLAG_ENCRYPTED = 0x1;
  const FLAG_PASSWORD = 0x2;
  const FLAG_ACCESS = 0x4;
  const KNOWN_FLAGS = 0xf;
  const CODEC_NONE = 0;
  const CODEC_DEFLATE = 1;
  const CODEC_BROTLI = 2;
  const MIN_KDF_ITERATIONS = 1000;
  const MAX_KDF_ITERATIONS = 10000000;
  const TYPE_NAMES = ['', 'bool', 'int', 'float', 'decimal', 'string', 'datetime', 'binary', 'json'];
  const ENCODING = { plain: 0, delta: 1, dictionary: 2, bitmap: 3, scaled: 4 };
  const HAS_NULLS = 0x10;
  const POW10 = Array.from({ length: 23 }, (_, s) => 10 ** s);
  const SLOT_ID = 8;
  const SLOT_ENTRY = SLOT_ID + 8;
  const PAGE_ENTRY = SLOT_ID + 8 + 4 + 32;
  const ONLINE_SLOT = 0x80000000;
  const WHOLE_TABLE = '*';
  const EVERYONE = '*';
  const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const subtle = global.crypto.subtle;
  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder('utf-8', { fatal: false });

  class JazminError extends Error {
    constructor(message) {
      super(message);
      this.name = 'JazminError';
    }
  }

  class JazminFormatError extends JazminError {
    constructor(message) {
      super(message);
      this.name = 'JazminFormatError';
    }
  }

  class JazminKeyError extends JazminError {
    constructor(message) {
      super(message);
      this.name = 'JazminKeyError';
    }
  }

  /** An online key needs an unlock token from the owner's key service: send fileId and keyId to it. */
  class JazminUnlockRequiredError extends JazminKeyError {
    constructor(message, fileId, keyId) {
      super(message);
      this.name = 'JazminUnlockRequiredError';
      this.fileId = fileId;
      this.keyId = keyId;
    }
  }

  // ---- bytes -------------------------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }

  function base64ToBytes(text) {
    const bin = global.atob(text.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const base64UrlToBytes = (text) => base64ToBytes(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));

  function bytesToBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return global.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // ---- cryptography (WebCrypto only) ---------------------------------------------------------------

  async function sha256(...parts) {
    return new Uint8Array(await subtle.digest('SHA-256', parts.length === 1 ? parts[0] : concat(...parts)));
  }

  async function hkdf(ikm, salt, info, bits = 256) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) }, base, bits));
  }

  async function hmacSha256(key, data) {
    const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', k, data));
  }

  async function pbkdf2(password, salt, iterations) {
    const base = await subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  }

  async function decrypt(keyBytes, payload, aad) {
    if (payload.length < 28) throw new JazminKeyError('Encrypted section is too short');
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12), additionalData: aad }, key, payload.subarray(12)));
    } catch {
      throw new JazminKeyError('Decryption failed - wrong key or password, or the file was tampered with');
    }
  }

  async function inflateRaw(bytes, rawLength) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const out = new Uint8Array(rawLength);
    let at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.length > rawLength) throw new JazminFormatError('A section is longer than its declared length'); // stops a decompression bomb
        out.set(value, at);
        at += value.length;
      }
    } catch (error) {
      if (error instanceof JazminError) throw error;
      throw new JazminFormatError('A section could not be decompressed');
    } finally {
      reader.cancel().catch(() => {});
    }
    if (at !== rawLength) throw new JazminFormatError('A section has the wrong decompressed length');
    return out;
  }

  /**
   * Whether `publicKey` (from the file's signature section) belongs to this owner key. The signing key is derived as in
   * spec 7.6.1: d = (HKDF(owner key, "", "JAZMIN/1/owner-signing", 48) mod (n - 1)) + 1. WebCrypto cannot compute d's
   * public point in every browser, so d is imported with the file's point and a challenge is signed: the signature
   * verifies against that point only when the point is d's.
   */
  async function isOwnerKey(master, publicKey) {
    if (publicKey.length !== 65 || publicKey[0] !== 4) return false;
    const okm = await hkdf(master, new Uint8Array(0), 'JAZMIN/1/owner-signing', 384);
    const d = (BigInt('0x' + toHex(okm)) % (P256_ORDER - 1n)) + 1n;
    const jwk = {
      kty: 'EC', crv: 'P-256', ext: true, d: bytesToBase64Url(hexToBytes(d.toString(16).padStart(64, '0'))),
      x: bytesToBase64Url(publicKey.subarray(1, 33)), y: bytesToBase64Url(publicKey.subarray(33, 65)),
    };
    let key;
    try {
      key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    } catch {
      return false; // some browsers refuse a private key that does not match its point
    }
    const challenge = global.crypto.getRandomValues(new Uint8Array(32));
    return verifySignature(publicKey, challenge, new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, challenge)));
  }

  async function verifySignature(publicKey, message, signature) {
    const key = await subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message);
  }

  // ---- keys ---------------------------------------------------------------------------------------

  async function checksum(bytes) {
    return (await sha256(bytes)).subarray(0, 4);
  }

  /** A key's text: { kind: 'owner', bytes } (jzk1-) or { kind: 'access', secret, fingerprint } (jza1-); checksums are verified. */
  async function parseKey(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (t.startsWith('jzk1-')) {
      const raw = base64UrlToBytes(t.slice(5));
      if (raw.length !== 36) throw new JazminKeyError('Key text has the wrong length');
      if (!equal(await checksum(raw.subarray(0, 32)), raw.subarray(32))) throw new JazminKeyError('Key checksum mismatch - the key is mistyped or incomplete');
      return { kind: 'owner', bytes: raw.slice(0, 32) };
    }
    if (t.startsWith('jza1-')) {
      const raw = base64UrlToBytes(t.slice(5));
      if (raw.length !== 44) throw new JazminKeyError('Access key text has the wrong length');
      if (!equal(await checksum(raw.subarray(0, 40)), raw.subarray(40))) throw new JazminKeyError('Key checksum mismatch - the key is mistyped or incomplete');
      return { kind: 'access', secret: raw.slice(0, 32), fingerprint: raw.slice(32, 40) };
    }
    throw new JazminKeyError("A key starts with 'jzk1-' (master or owner key) or 'jza1-' (access key)");
  }

  async function parseUnlockToken(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t.startsWith('jzu1-')) throw new JazminKeyError("An unlock token starts with 'jzu1-'");
    const raw = base64UrlToBytes(t.slice(5));
    if (raw.length !== 36 || !equal(await checksum(raw.subarray(0, 32)), raw.subarray(32))) {
      throw new JazminKeyError('Unlock token checksum mismatch - the token is mistyped or corrupted');
    }
    return raw.slice(0, 32);
  }

  const slotId = async (secret) => (await sha256(utf8.encode('JAZMIN/1/slot-id'), secret)).subarray(0, SLOT_ID);

  // ---- binary readers -----------------------------------------------------------------------------

  /** Little-endian reader over a Uint8Array, mirroring the library's ByteReader. */
  class Reader {
    constructor(bytes, pos = 0) {
      this.buf = bytes;
      this.view = view(bytes);
      this.pos = pos;
    }

    need(n) {
      if (!(n >= 0) || this.pos + n > this.buf.length) throw new JazminFormatError('Unexpected end of data');
    }

    get remaining() {
      return this.buf.length - this.pos;
    }

    byte() {
      this.need(1);
      return this.buf[this.pos++];
    }

    bytes(n) {
      this.need(n);
      const out = this.buf.subarray(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }

    u16() {
      this.need(2);
      const v = this.view.getUint16(this.pos, true);
      this.pos += 2;
      return v;
    }

    float64() {
      this.need(8);
      const v = this.view.getFloat64(this.pos, true);
      this.pos += 8;
      return v;
    }

    /** Unsigned varint as a BigInt (up to `max` bytes). */
    bigVarUint(max = 10) {
      let result = 0n;
      let shift = 0n;
      for (let count = 0; ; count++) {
        if (count === max) throw new JazminFormatError('Varint too long');
        const b = this.byte();
        result |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        if (!(b & 0x80)) return result;
      }
    }

    /** Unsigned varint that must fit a safe integer (lengths, counts, offsets). */
    varUint() {
      const v = this.bigVarUint();
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new JazminFormatError('Value out of range');
      return Number(v);
    }

    /** Zigzag varint: a Number when it is safe, else a BigInt (as the library returns). */
    varInt() {
      const z = this.bigVarUint();
      const v = z & 1n ? -((z + 1n) >> 1n) : z >> 1n;
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }

    string() {
      return fromUtf8.decode(this.bytes(this.varUint()));
    }

    get eof() {
      return this.pos === this.buf.length;
    }
  }

  const text = (bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new JazminFormatError('Catalog: a field has the wrong wire type');
    return fromUtf8.decode(bytes);
  };
  const num = (v) => {
    if (typeof v !== 'number') throw new JazminFormatError('Catalog: a field has the wrong wire type');
    return v;
  };
  const bytesOf = (v) => {
    if (!(v instanceof Uint8Array)) throw new JazminFormatError('Catalog: a field has the wrong wire type');
    return v;
  };

  function parseJson(textValue, what) {
    try {
      return JSON.parse(textValue);
    } catch {
      throw new JazminFormatError(`${what} is not valid JSON`);
    }
  }

  function dateFromMs(ms) {
    const n = Number(ms);
    if (!(Math.abs(n) <= 8.64e15)) throw new JazminFormatError('A datetime value is out of range');
    return new Date(n);
  }

  // ---- catalog (Protocol Buffers wire format, spec/jazmin.proto) ----------------------------------

  /** Calls onField(field, value) for each field: varints as Numbers, length-delimited fields as bytes. */
  function readMessage(bytes, onField) {
    const r = new Reader(bytesOf(bytes));
    while (!r.eof) {
      const tag = r.varUint();
      const field = Math.floor(tag / 8);
      if (field === 0) throw new JazminFormatError('Catalog message has an invalid field');
      switch (tag & 7) {
        case 0: onField(field, r.varUint()); break;
        case 1: r.bytes(8); break;
        case 2: onField(field, r.bytes(r.varUint())); break;
        case 5: r.bytes(4); break;
        default: throw new JazminFormatError(`Catalog: unsupported wire type ${tag & 7}`);
      }
    }
  }

  function readPacked(value) {
    if (typeof value === 'number') return [value];
    const r = new Reader(bytesOf(value));
    const out = [];
    while (!r.eof) out.push(r.varUint());
    return out;
  }

  const cumulative = (values) => {
    let total = 0;
    return values.map((v) => (total += v));
  };

  function readRef(bytes) {
    const ref = { offset: 0, length: 0, digest: null };
    readMessage(bytes, (f, v) => {
      if (f === 1) ref.offset = num(v);
      else if (f === 2) ref.length = num(v);
      else if (f === 3) ref.digest = bytesOf(v).slice();
    });
    return ref;
  }

  function readColumn(bytes) {
    const c = { position: 0, name: '', type: '', nullable: true };
    readMessage(bytes, (f, v) => {
      if (f === 1) c.position = num(v);
      else if (f === 2) c.name = text(v);
      else if (f === 3) c.type = TYPE_NAMES[num(v)] || '';
      else if (f === 4) c.nullable = num(v) === 0;
      else if (f === 5) c.description = text(v);
      else if (f === 6) c.attributes = parseJson(text(v), 'Column attributes');
      else if (f === 7 && num(v) !== 0) throw new JazminFormatError(`Column '${c.name}' uses an unknown time unit`);
    });
    if (!c.type) throw new JazminFormatError(`Column '${c.name}' has an unknown type`);
    return c;
  }

  function readPartition(bytes) {
    const p = { id: new Uint8Array(0), segments: [] };
    readMessage(bytes, (f, v) => {
      if (f === 1) p.id = bytesOf(v).slice();
      else if (f === 2) p.segments.push(readRef(v));
    });
    return p;
  }

  function readTable(bytes) {
    const t = {
      name: '', columnCount: 0, groups: [], sortedBy: [], partitionBy: '', rowCount: 0, deletedCount: 0, chunkCount: 0,
      partitions: [], partitionTable: null, deletes: null,
    };
    readMessage(bytes, (f, v) => {
      switch (f) {
        case 1: t.name = text(v); break;
        case 2: t.columnCount = num(v); break;
        case 3: {
          const g = { name: '', columns: [], columnCount: 0, definitions: null };
          readMessage(v, (gf, gv) => {
            if (gf === 1) g.name = text(gv);
            else if (gf === 2) g.columns.push(readColumn(gv));
            else if (gf === 3) g.columnCount = num(gv);
            else if (gf === 4) g.definitions = readRef(gv);
          });
          t.groups.push(g);
          break;
        }
        case 4: t.sortedBy.push(text(v)); break;
        case 5: t.partitionBy = text(v); break;
        case 6: t.rowCount = num(v); break;
        case 7: t.deletedCount = num(v); break;
        case 8: t.chunkCount = num(v); break;
        case 9: t.partitions.push(readPartition(v)); break;
        case 10: t.partitionTable = readRef(v); break;
        case 12: t.deletes = readRef(v); break;
        default: break;
      }
    });
    return t;
  }

  function readHeader(bytes) {
    const h = { readerFeatures: [], metadata: '', tables: [], keyring: {}, files: null, access: null, deltas: [], appendCount: 0, created: 0, modified: 0 };
    readMessage(bytes, (f, v) => {
      switch (f) {
        case 1: h.readerFeatures.push(text(v)); break;
        case 3: h.created = num(v); break;
        case 4: h.modified = num(v); break;
        case 5: h.appendCount = num(v); break;
        case 6: h.metadata = text(v); break;
        case 7: h.tables.push(readTable(v)); break;
        case 8:
          readMessage(v, (kf, kv) => {
            const group = ['', 'data', 'index', 'files'][kf];
            if (group) h.keyring[group] = bytesOf(kv).slice();
          });
          break;
        case 9: {
          const files = { directories: [], package: '', segment: 0 };
          readMessage(v, (ff, fv) => {
            if (ff === 1) {
              const d = { group: '', section: null };
              readMessage(fv, (df, dv) => {
                if (df === 1) d.group = text(dv);
                else if (df === 2) d.section = readRef(dv);
              });
              files.directories.push(d);
            } else if (ff === 3) files.package = text(fv);
            else if (ff === 4) files.segment = num(fv);
          });
          h.files = files;
          break;
        }
        case 10: {
          const access = { ownerDirectory: null };
          readMessage(v, (af, av) => {
            if (af === 1) access.ownerDirectory = readRef(av);
          });
          h.access = access;
          break;
        }
        case 11: h.deltas.push(readRef(v)); break;
        default: break;
      }
    });
    return h;
  }

  /** A chunk-directory segment (spec 6.3): one entry per chunk, with its parts (one per column group). */
  function readDirectory(bytes, groupCount) {
    let ordinals = [];
    let rowStarts = [];
    let rowCounts = [];
    let offsets = [];
    let lengths = [];
    let digests = null;
    readMessage(bytes, (f, v) => {
      if (f === 1) ordinals = cumulative(readPacked(v));
      else if (f === 2) rowStarts = cumulative(readPacked(v));
      else if (f === 3) rowCounts = readPacked(v);
      else if (f === 4) offsets = cumulative(readPacked(v));
      else if (f === 5) lengths = readPacked(v);
      else if (f === 6) digests = bytesOf(v);
    });
    const n = ordinals.length;
    if (rowStarts.length !== n || rowCounts.length !== n || offsets.length !== n * groupCount || lengths.length !== n * groupCount
      || (digests && digests.length !== n * groupCount * 32)) {
      throw new JazminFormatError('Chunk directory lists are inconsistent');
    }
    return ordinals.map((ordinal, i) => ({
      ordinal,
      rowStart: rowStarts[i],
      rowCount: rowCounts[i],
      parts: Array.from({ length: groupCount }, (_, g) => {
        const k = i * groupCount + g;
        return { offset: offsets[k], length: lengths[k], digest: digests ? digests.slice(k * 32, k * 32 + 32) : null };
      }),
    }));
  }

  function readPartitionList(bytes) {
    const partitions = [];
    readMessage(bytes, (f, v) => {
      if (f === 1) partitions.push(readPartition(v));
    });
    return partitions;
  }

  function readDelta(bytes) {
    const tables = [];
    readMessage(bytes, (f, v) => {
      if (f !== 1) return;
      const t = { table: 0, partitions: [] };
      readMessage(v, (tf, tv) => {
        if (tf === 1) t.table = num(tv);
        else if (tf === 2) t.partitions.push(readPartition(tv));
      });
      tables.push(t);
    });
    return tables;
  }

  /** A postings section (deleted rows): encoding byte, count, then differences. */
  function readPostingsSection(bytes) {
    const r = new Reader(bytes);
    if (r.byte() !== 0) throw new JazminFormatError('Deleted rows use an encoding this reader does not support');
    const count = r.varUint();
    if (count > r.remaining) throw new JazminFormatError('Postings are truncated');
    const ids = new Array(count);
    let previous = 0;
    for (let i = 0; i < count; i++) {
      previous += r.varUint();
      if (previous > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
      ids[i] = previous;
    }
    if (!r.eof) throw new JazminFormatError('Deleted rows have trailing bytes');
    return ids;
  }

  function checkFileDirectory(d) {
    const ok = (test) => {
      if (!test) throw new JazminFormatError('An embedded-file directory is malformed');
    };
    const count = (v) => Number.isSafeInteger(v) && v >= 0;
    ok(d && typeof d === 'object' && Array.isArray(d.files) && Array.isArray(d.contents));
    for (const c of d.contents) {
      ok(c && count(c.id) && count(c.size) && typeof c.sha256 === 'string' && Array.isArray(c.blocks));
      ok(count(c.blockSize) && c.blockSize > 0 && c.blocks.length === Math.ceil(c.size / c.blockSize));
      ok(c.key === undefined || typeof c.key === 'string');
      for (const b of c.blocks) ok(b && count(b.offset) && count(b.length) && (b.digest === undefined || typeof b.digest === 'string'));
    }
    for (const f of d.files) {
      ok(f && typeof f.path === 'string' && typeof f.type === 'string' && count(f.content));
      ok(f.groups === undefined || (Array.isArray(f.groups) && f.groups.every((g) => typeof g === 'string')));
    }
    return d;
  }

  // ---- columnar chunks (spec 5.4) --------------------------------------------------------------

  function formatDecimal(m, s) {
    const negative = m < 0n;
    const digits = (negative ? -m : m).toString().padStart(s + 1, '0');
    const t = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
    return negative ? `-${t}` : t;
  }

  /** A decimal: varint scale, then the integer m as a zigzag varint of any size (spec 5.1). */
  function readDecimal(r) {
    const s = r.varUint();
    if (s > 255) throw new JazminFormatError('Decimal scale is invalid');
    const z = r.bigVarUint(132);
    return formatDecimal(z & 1n ? -((z + 1n) >> 1n) : z >> 1n, s);
  }

  function readPlain(r, type) {
    switch (type) {
      case 'bool': return r.byte() !== 0;
      case 'int': return r.varInt();
      case 'datetime': return dateFromMs(r.varInt());
      case 'float': return r.float64();
      case 'binary': return r.bytes(r.varUint()).slice();
      case 'json': return parseJson(r.string(), 'A json value');
      case 'decimal': return readDecimal(r);
      default: return r.string();
    }
  }

  /** Decodes a columnar chunk payload into one array of values per column (null for null). */
  function decodeColumnar(raw, types, rowCount, ordinal) {
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || (rowCount > 0 && rowCount > raw.length * 8)) {
      throw new JazminFormatError(`Chunk ${ordinal}: row count does not match its size`);
    }
    const reader = new Reader(raw);
    const columns = new Array(types.length);
    for (let j = 0; j < types.length; j++) {
      const length = reader.varUint();
      const end = reader.pos + length;
      if (length < 1 || end > raw.length) throw new JazminFormatError(`Chunk ${ordinal}: invalid stream length`);
      const r = new Reader(raw.subarray(0, end), reader.pos);
      const flags = r.byte();
      const type = types[j];
      if (flags & 0xe0) throw new JazminFormatError(`Chunk ${ordinal}: reserved stream flags are set`);
      const nulls = flags & HAS_NULLS ? r.bytes((rowCount + 7) >> 3) : null;
      const isNull = (i) => nulls !== null && (nulls[i >> 3] & (1 << (i & 7))) !== 0;
      let count = rowCount;
      if (nulls) for (let i = 0; i < rowCount; i++) if (isNull(i)) count--;
      const values = new Array(count);
      switch (flags & 0x0f) {
        case ENCODING.plain:
          for (let i = 0; i < count; i++) values[i] = readPlain(r, type);
          break;
        case ENCODING.delta: {
          let prev = 0n;
          for (let i = 0; i < count; i++) {
            prev += BigInt(r.varInt());
            const v = prev >= BigInt(Number.MIN_SAFE_INTEGER) && prev <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(prev) : prev;
            values[i] = type === 'datetime' ? dateFromMs(v) : v;
          }
          break;
        }
        case ENCODING.dictionary: {
          const k = r.varUint();
          if (k < 1 || k > end - r.pos) throw new JazminFormatError(`Chunk ${ordinal}: invalid dictionary size`);
          const entries = Array.from({ length: k }, () => (type === 'decimal' ? readDecimal(r) : r.string()));
          for (let i = 0; i < count; i++) {
            const id = r.varUint();
            if (id >= entries.length) throw new JazminFormatError(`Chunk ${ordinal}: dictionary index out of range`);
            values[i] = entries[id];
          }
          break;
        }
        case ENCODING.bitmap: {
          const bits = r.bytes((count + 7) >> 3);
          for (let i = 0; i < count; i++) values[i] = (bits[i >> 3] & (1 << (i & 7))) !== 0;
          break;
        }
        case ENCODING.scaled:
          for (let i = 0; i < count; i++) {
            const s = r.byte();
            if (s === 255) values[i] = r.float64();
            else if (s <= 22) values[i] = Number(r.varInt()) / POW10[s];
            else throw new JazminFormatError(`Chunk ${ordinal}: invalid scale ${s}`);
          }
          break;
        default:
          throw new JazminFormatError(`Chunk ${ordinal}: unknown encoding ${flags & 0x0f}`);
      }
      if (r.pos !== end) throw new JazminFormatError(`Chunk ${ordinal}: stream length does not match its contents`);
      reader.pos = end;
      if (!nulls) columns[j] = values;
      else {
        const full = new Array(rowCount);
        for (let i = 0, k = 0; i < rowCount; i++) full[i] = isNull(i) ? null : values[k++];
        columns[j] = full;
      }
    }
    if (!reader.eof) throw new JazminFormatError(`Chunk ${ordinal} has trailing bytes`);
    return columns;
  }

  // ---- filters (spec 9) ----------------------------------------------------------------------------

  const OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'icontains', 'startsWith', 'isNull']);
  const STRING_OPS = new Set(['contains', 'icontains', 'startsWith']);

  /** A comparable form of a value of a column type: numbers and BigInts, ms for dates, [m, s] for decimals, text, booleans. */
  function keyOf(type, value) {
    switch (type) {
      case 'int': {
        const n = typeof value === 'bigint' ? value : typeof value === 'string' ? BigInt(value) : BigInt(Math.trunc(Number(value)));
        return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
      }
      case 'float': return Number(value);
      case 'datetime': return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
      case 'decimal': {
        const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
        if (!m) throw new JazminError(`'${value}' is not a decimal`);
        return { sign: m[1] ? -1n : 1n, digits: BigInt(m[2] + (m[3] ?? '')), scale: (m[3] ?? '').length };
      }
      case 'bool': return Boolean(value);
      default: return String(value);
    }
  }

  function compare(type, a, b) {
    if (type === 'decimal') {
      const scale = Math.max(a.scale, b.scale);
      const x = a.sign * a.digits * 10n ** BigInt(scale - a.scale);
      const y = b.sign * b.digits * 10n ** BigInt(scale - b.scale);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      const x = BigInt(a);
      const y = BigInt(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Compiles a filter (spec 9) for these columns into a predicate over row objects. */
  function compileFilter(filter, columns) {
    if (filter === null || filter === undefined) return () => true;
    if (typeof filter !== 'object' || Array.isArray(filter)) throw new JazminError('A filter must be an object');
    const byName = new Map(columns.map((c) => [c.name, c]));
    const parts = [];
    for (const [key, spec] of Object.entries(filter)) {
      if (key === 'and' || key === 'or') {
        if (!Array.isArray(spec)) throw new JazminError(`'${key}' takes an array of filters`);
        const items = spec.map((f) => compileFilter(f, columns));
        parts.push(key === 'and' ? (row) => items.every((p) => p(row)) : (row) => items.some((p) => p(row)));
      } else if (key === 'not') {
        const inner = compileFilter(spec, columns);
        parts.push((row) => !inner(row));
      } else {
        const column = byName.get(key);
        if (!column) throw new JazminError(`unknown column '${key}'`);
        const conditions = spec === null ? { isNull: true }
          : typeof spec === 'object' && !(spec instanceof Date) && !Array.isArray(spec) ? spec : { eq: spec };
        for (const [op, operand] of Object.entries(conditions)) {
          if (!OPS.has(op)) throw new JazminError(`unknown operator '${op}'`);
          if (STRING_OPS.has(op) && column.type !== 'string') throw new JazminError(`'${op}' applies to string columns only`);
          parts.push(condition(column, op, operand));
        }
      }
    }
    return (row) => parts.every((p) => p(row));
  }

  function condition(column, op, operand) {
    const { name, type } = column;
    if (op === 'isNull') return (row) => (row[name] === null || row[name] === undefined) === Boolean(operand);
    if (op === 'contains') return (row) => row[name] != null && row[name].includes(operand);
    if (op === 'icontains') {
      const lower = String(operand).toLowerCase();
      return (row) => row[name] != null && row[name].toLowerCase().includes(lower);
    }
    if (op === 'startsWith') return (row) => row[name] != null && row[name].startsWith(operand);
    if (op === 'in') {
      if (!Array.isArray(operand)) throw new JazminError(`'in' takes an array`);
      const keys = operand.filter((v) => v !== null).map((v) => keyOf(type, v));
      return (row) => row[name] != null && keys.some((k) => compare(type, keyOf(type, row[name]), k) === 0);
    }
    const key = keyOf(type, operand);
    const test = { eq: (c) => c === 0, ne: (c) => c !== 0, gt: (c) => c > 0, gte: (c) => c >= 0, lt: (c) => c < 0, lte: (c) => c <= 0 }[op];
    return (row) => row[name] != null && test(compare(type, keyOf(type, row[name]), key));
  }

  // ---- sources: a File / Blob read in slices, or bytes in memory -------------------------------------

  function sourceOf(input) {
    if (input instanceof Uint8Array) {
      return { size: input.length, read: async (offset, length) => input.subarray(offset, offset + length) };
    }
    if (input instanceof ArrayBuffer) return sourceOf(new Uint8Array(input));
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      return { size: input.size, read: async (offset, length) => new Uint8Array(await input.slice(offset, offset + length).arrayBuffer()) };
    }
    throw new JazminError('Open a File, Blob, ArrayBuffer or Uint8Array');
  }

  // ---- the reader ---------------------------------------------------------------------------------

  /**
   * Opens a JAZMIN file. `input`: a File, Blob, ArrayBuffer or Uint8Array. options: { key } (jzk1-... master or owner
   * key, or jza1-... access key), { password }, { unlockToken } for online access keys, { table } (default: the first).
   */
  async function open(input, options = {}) {
    const file = await openFile(sourceOf(input), options);
    return file.table(options.table);
  }

  /** What is shared by the readers of a file's tables: source, header, keys, files. */
  async function openFile(source, options) {
    const { size } = source;
    const read = async (offset, length) => {
      if (!(offset >= 0 && length >= 0 && offset + length <= size)) throw new JazminFormatError('Unexpected end of file');
      return source.read(offset, length);
    };
    if (size < PREAMBLE + TRAILER) throw new JazminFormatError('File is too small to be JAZMIN');
    const preamble = await read(0, PREAMBLE);
    const magic = fromUtf8.decode(preamble.subarray(0, 4));
    if (magic === 'JZMN') throw new JazminFormatError('This file uses a pre-release JAZMIN draft format - write it again from its source data');
    if (magic !== 'JZM1') throw new JazminFormatError('Not a JAZMIN file');
    const pv = view(preamble);
    const flags = pv.getUint16(4, true);
    if (flags & ~KNOWN_FLAGS) throw new JazminFormatError(`Unsupported file features (flags 0x${flags.toString(16)})`);
    const fileId = preamble.slice(8, 24);
    const salt = preamble.slice(24, 56);
    const iterations = pv.getUint32(56, true);
    const trailer = await locateTrailer(read, size);

    /** Reads, checks (digest, CRC-32), decrypts and decompresses a section. */
    async function section(ref, sectionId, key, { requireDigest = false } = {}) {
      if (!(ref.length >= ENVELOPE)) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
      const s = await read(ref.offset, ref.length);
      if (ref.digest) {
        if (!equal(await sha256(s), ref.digest)) throw new JazminFormatError(`Section '${sectionId}' does not match the owner's signature`);
      } else if (requireDigest) {
        throw new JazminFormatError(`Section '${sectionId}' has no digest`);
      }
      return decode(s, sectionId, key);
    }

    async function decode(s, sectionId, key) {
      if (s.length < ENVELOPE) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
      const v = view(s);
      const codec = s[0];
      const encrypted = (s[1] & 1) !== 0;
      const rawLength = v.getUint32(4, true);
      const payloadLength = v.getUint32(8, true);
      let body = s.subarray(ENVELOPE, ENVELOPE + payloadLength);
      if (body.length !== payloadLength || payloadLength + ENVELOPE !== s.length) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
      if (crc32(body) !== v.getUint32(12, true)) throw new JazminFormatError(`Section '${sectionId}' failed its CRC-32 check`);
      if (key && !encrypted) throw new JazminFormatError(`Section '${sectionId}' is not encrypted but the file is`);
      if (encrypted) {
        if (!key) throw new JazminKeyError('This file is encrypted - enter its key or password');
        body = await decrypt(key, body, concat(fileId, s.subarray(0, 8), utf8.encode(sectionId)));
      }
      if (codec === CODEC_DEFLATE) return inflateRaw(body, rawLength);
      if (codec === CODEC_BROTLI) throw new JazminFormatError('Brotli sections cannot be read in browsers - write the file with deflate');
      if (codec !== CODEC_NONE) throw new JazminFormatError(`Unsupported codec ${codec}`);
      if (body.length !== rawLength) throw new JazminFormatError(`Section '${sectionId}' has the wrong decompressed length`);
      return body;
    }

    const plainSection = (bytes, sectionId) => {
      if (bytes.length < ENVELOPE || bytes[0] !== CODEC_NONE || bytes[1] !== 0) throw new JazminFormatError(`Section '${sectionId}' must be stored as is`);
      return decode(bytes, sectionId, null);
    };

    const headerSection = await read(trailer.header.offset, trailer.header.length);
    let headerRaw;
    let keys = null; // key or password files: { master }
    let access = null; // access-controlled files
    if (flags & FLAG_ACCESS) {
      if (options.password || !options.key) throw new JazminKeyError('This file is access-controlled - enter an owner key or access key');
      const key = await parseKey(options.key);
      if (!trailer.keySlots.length || !trailer.signature.length) throw new JazminFormatError('Key-slot or signature section is missing');
      const slotsSection = await read(trailer.keySlots.offset, trailer.keySlots.length);
      const signature = await plainSection(await read(trailer.signature.offset, trailer.signature.length), 'signature');
      if (signature.length !== 65 + 64) throw new JazminFormatError('Signature section has the wrong length');
      const owner = signature.subarray(0, 65);
      const ownerOk = key.kind === 'access' ? equal((await sha256(owner)).subarray(0, 8), key.fingerprint) : await isOwnerKey(key.bytes, owner);
      if (!ownerOk) throw new JazminKeyError('This file was not signed by the owner of this key');
      const message = concat(utf8.encode('JAZMIN/1/signature'), fileId, await sha256(slotsSection), await sha256(headerSection));
      if (!(await verifySignature(owner, message, signature.subarray(65)))) throw new JazminFormatError("The file's owner signature is invalid - the file was modified");
      const secret = key.kind === 'access' ? key.secret : key.bytes;
      const id = await slotId(secret);
      const list = await plainSection(slotsSection, 'keyslots');
      const page = findPage(list, id);
      if (!page) throw new JazminKeyError('This key has not been granted access to this file');
      const pageSection = await read(page.offset, page.length);
      if (!equal(await sha256(pageSection), page.digest)) throw new JazminFormatError("Key-slot page does not match the owner's signature");
      const slot = findSlot(await plainSection(pageSection, `keyslots/${page.index}`), id);
      if (!slot) throw new JazminKeyError('This key has not been granted access to this file');
      let share = null;
      if (slot.online) {
        if (!options.unlockToken) throw new JazminUnlockRequiredError("This key needs an unlock token from the file owner's key service", toHex(fileId), toHex(id));
        share = await parseUnlockToken(options.unlockToken);
      }
      let bundle;
      try {
        const kek = await hkdf(share ? concat(secret, share) : secret, salt, 'JAZMIN/1/slot');
        bundle = parseJson(fromUtf8.decode(await decrypt(kek, slot.sealed, concat(fileId, id))), 'A key slot');
      } catch (error) {
        if (slot.online && error instanceof JazminKeyError) throw new JazminKeyError('The unlock token is not valid for this key and file');
        throw error;
      }
      const isOwner = bundle.owner !== undefined;
      const b = (s) => base64ToBytes(String(s));
      access = {
        isOwner,
        header: b(bundle.header),
        owner: isOwner ? b(bundle.owner) : null,
        partitions: new Map(Object.entries(bundle.partitions ?? {}).map(([pid, s]) => [pid, b(s)])),
        columns: new Map(Object.entries(bundle.columns ?? {}).map(([g, s]) => [g, b(s)])),
        files: new Map(Object.entries(bundle.files ?? {}).map(([g, s]) => [g, b(s)])),
        expires: bundle.expires,
        online: Boolean(bundle.online),
      };
      if (access.expires !== undefined) {
        const expires = Date.parse(access.expires);
        // The libraries also keep a last-seen record; a browser cannot keep one users could not clear.
        if (!(Date.now() <= expires)) throw new JazminKeyError(`Access for this key expired at ${access.expires}`);
      }
      headerRaw = await decode(headerSection, 'header', await hkdf(access.header, salt, 'JAZMIN/1/header'));
    } else {
      if (options.key && /^\s*jza1-/.test(options.key)) throw new JazminKeyError('This file is not access-controlled - use its master key');
      if (flags & FLAG_ENCRYPTED) {
        if (!options.key && !options.password) throw new JazminKeyError('This file is encrypted - enter its key or password');
        if (options.password && !(flags & FLAG_PASSWORD)) throw new JazminKeyError('This file was encrypted with a key, not a password');
        let master;
        if (options.password) {
          if (!(iterations >= MIN_KDF_ITERATIONS && iterations <= MAX_KDF_ITERATIONS)) throw new JazminFormatError(`The file asks for ${iterations} password iterations`);
          master = await pbkdf2(options.password, salt, iterations);
        } else {
          const key = await parseKey(options.key);
          if (key.kind !== 'owner') throw new JazminKeyError('This file needs its master key (jzk1-...)');
          master = key.bytes;
        }
        keys = { master };
        headerRaw = await decode(headerSection, 'header', await hkdf(master, salt, 'JAZMIN/1/header'));
      } else {
        if (options.key || options.password) throw new JazminKeyError('A key was entered but the file is not encrypted');
        headerRaw = await decode(headerSection, 'header', null);
      }
    }
    const header = readHeader(headerRaw);
    if (access?.expires !== undefined && Date.now() + 5 * 60000 < (header.modified || header.created)) {
      throw new JazminKeyError('The clock reads earlier than when this file was written - access refused'); // spec 7.7, check 2
    }
    if (header.readerFeatures.length) throw new JazminFormatError(`This file needs features this reader does not support: ${header.readerFeatures.join(', ')}`);
    if (!header.tables.length) throw new JazminFormatError('Catalog: the file lists no tables');

    const file = {
      header, fileId, salt, size, keys, access, section, read,
      metadata: header.metadata ? parseJson(header.metadata, 'Metadata') : {},
      /** Key of a catalog section: keyring group (key files) or HKDF(secret) (access-controlled files). */
      async key(sectionId, secret, group = 'data') {
        if (access) return hkdf(secret, salt, `JAZMIN/1/${sectionId}`);
        if (!keys) return null;
        const ring = header.keyring[group];
        if (!ring) throw new JazminFormatError(`Keyring has no secret for group '${group}'`);
        return hkdf(keys.master, ring, `JAZMIN/1/${sectionId}`);
      },
      async partitionSecret(id) {
        return access.isOwner ? hkdf(access.owner, salt, `JAZMIN/1/partition/${id}`) : access.partitions.get(id) ?? null;
      },
      async columnSecret(group) {
        return access.isOwner ? hkdf(access.owner, salt, `JAZMIN/1/column-group/${group}`) : access.columns.get(group) ?? null;
      },
      table: (name) => openTable(file, name),
    };
    return file;
  }

  async function locateTrailer(read, size) {
    const parse = (t) => {
      const v = view(t);
      return {
        header: { offset: Number(v.getBigUint64(0, true)), length: v.getUint32(8, true) },
        keySlots: { offset: Number(v.getBigUint64(12, true)), length: v.getUint32(20, true) },
        signature: { offset: Number(v.getBigUint64(24, true)), length: v.getUint32(32, true) },
      };
    };
    const valid = (t) => fromUtf8.decode(t.subarray(40, 44)) === 'JZM1' && crc32(t.subarray(0, 36)) === view(t).getUint32(36, true);
    const last = await read(size - TRAILER, TRAILER);
    if (valid(last)) return parse(last);
    // An interrupted append left bytes after the last complete version: find its trailer (spec 4.2, 11.2).
    const start = Math.max(PREAMBLE, size - 4 * 1024 * 1024);
    const tail = await read(start, size - start);
    for (let at = tail.length - TRAILER; at >= 0; at--) {
      if (tail[at + 40] === 0x4a && valid(tail.subarray(at, at + TRAILER))) return parse(tail.subarray(at, at + TRAILER));
    }
    throw new JazminFormatError('Missing trailer - the file is truncated');
  }

  function findPage(list, id) {
    if (list.length < 4) throw new JazminFormatError('Key-slot list is truncated');
    const v = view(list);
    const count = v.getUint32(0, true);
    if (list.length !== 4 + count * PAGE_ENTRY) throw new JazminFormatError('Key-slot list has the wrong length');
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = 4 + mid * PAGE_ENTRY;
      if (compareBytes(list.subarray(at, at + SLOT_ID), id) <= 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    const at = 4 + (lo - 1) * PAGE_ENTRY;
    return {
      index: lo - 1,
      offset: Number(v.getBigUint64(at + SLOT_ID, true)),
      length: v.getUint32(at + SLOT_ID + 8, true),
      digest: list.subarray(at + SLOT_ID + 12, at + PAGE_ENTRY),
    };
  }

  function findSlot(raw, id) {
    if (raw.length < 4) throw new JazminFormatError('Key-slot page is truncated');
    const v = view(raw);
    const count = v.getUint32(0, true);
    const blobsAt = 4 + count * SLOT_ENTRY;
    if (blobsAt > raw.length) throw new JazminFormatError('Key-slot page is truncated');
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = 4 + mid * SLOT_ENTRY;
      const c = compareBytes(raw.subarray(at, at + SLOT_ID), id);
      if (c === 0) {
        const start = blobsAt + v.getUint32(at + SLOT_ID, true);
        const length = v.getUint32(at + SLOT_ID + 4, true);
        const end = start + ((length & ~ONLINE_SLOT) >>> 0);
        if (end > raw.length) throw new JazminFormatError('Key slot points outside its page');
        return { sealed: raw.subarray(start, end), online: (length & ONLINE_SLOT) !== 0 };
      }
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** One table of an open file: its columns (those this key may see), chunks and deleted rows. */
  async function openTable(file, name) {
    const { header, access } = file;
    const index = name === undefined ? 0 : header.tables.findIndex((t) => t.name === name);
    if (index < 0) throw new JazminError(`This file has no table '${name}' (tables: ${header.tables.map((t) => `'${t.name}'`).join(', ')})`);
    const table = header.tables[index];
    const counted = table.groups.reduce((n, g) => n + (g.definitions ? g.columnCount : g.columns.length), 0);
    if (counted !== table.columnCount || counted > file.size) throw new JazminFormatError('Catalog: the column count does not match the column groups');
    if (table.chunkCount * ENVELOPE > file.size) throw new JazminFormatError('Catalog: the chunk count is larger than the file can hold');
    const requireDigest = Boolean(access);

    // Column groups: restricted ones are read with the group's secret, when this key has it.
    const columns = new Array(table.columnCount).fill(null);
    const groups = [];
    for (const g of table.groups) {
      let defs = g.columns;
      let visible = true;
      let secret = null;
      if (access) {
        secret = await file.columnSecret(g.name);
        visible = Boolean(secret);
      }
      if (g.definitions && visible) {
        const sectionId = `${index}/columns/${g.name}`;
        const raw = await file.section(g.definitions, sectionId, await file.key(sectionId, secret), { requireDigest });
        defs = [];
        readMessage(raw, (f, v) => {
          if (f === 1) defs.push(readColumn(v));
        });
      }
      for (const c of visible ? defs : []) {
        if (c.position >= table.columnCount || columns[c.position]) throw new JazminFormatError('Column positions are inconsistent');
        columns[c.position] = c;
      }
      groups.push({ name: g.name, secret, visible, cols: visible ? defs.map((c) => c.position).sort((a, b) => a - b) : [] });
    }

    // Partitions this key may read, with their directory segments (inline, partition table, deltas).
    let partitions = table.partitions;
    if (table.partitionTable) {
      const sectionId = `${index}/partitions`;
      partitions = readPartitionList(await file.section(table.partitionTable, sectionId, await file.key(sectionId, access?.header), { requireDigest }));
    }
    const segments = new Map(partitions.map((p) => [p.id.length ? bytesToBase64Url(p.id) : WHOLE_TABLE, [...p.segments]]));
    for (let d = 0; d < header.deltas.length; d++) {
      const sectionId = `delta/${d}`;
      for (const t of readDelta(await file.section(header.deltas[d], sectionId, await file.key(sectionId, access?.header), { requireDigest }))) {
        if (t.table !== index) continue;
        for (const p of t.partitions) {
          const id = p.id.length ? bytesToBase64Url(p.id) : WHOLE_TABLE;
          segments.set(id, [...(segments.get(id) ?? []), ...p.segments]);
        }
      }
    }
    const chunks = [];
    const groupCount = table.groups.length;
    let hiddenRows = 0;
    for (const [id, list] of segments) {
      const secret = access ? await file.partitionSecret(id) : null;
      const visible = !access || (secret && groups.some((g) => g.visible));
      for (let s = 0; s < list.length; s++) {
        const sectionId = `${index}/dir/${id}${s ? `/${s}` : ''}`;
        if (!visible) {
          continue; // another key's partition: not read
        }
        for (const c of readDirectory(await file.section(list[s], sectionId, await file.key(sectionId, secret), { requireDigest }), groupCount)) {
          chunks.push({ ...c, partition: id, partitionSecret: secret });
        }
      }
    }
    chunks.sort((a, b) => a.ordinal - b.ordinal);
    for (let i = 1; i < chunks.length; i++) if (chunks[i].ordinal === chunks[i - 1].ordinal) throw new JazminFormatError('Chunk ordinals are inconsistent');

    let deleted = [];
    if (table.deletes) {
      const sectionId = `${index}/deletes/${table.deletedCount}`;
      deleted = readPostingsSection(await file.section(table.deletes, sectionId, await file.key(sectionId, access?.header), { requireDigest }));
    }
    const deletedSet = new Set(deleted);
    /** Rows of a chunk not deleted by appends (`deleted` is sorted). */
    const liveRows = (chunk) => {
      const below = (id) => {
        let lo = 0;
        let hi = deleted.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (deleted[mid] < id) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      return chunk.rowCount - (below(chunk.rowStart + chunk.rowCount) - below(chunk.rowStart));
    };
    const visibleColumns = columns.filter(Boolean).map(({ position, ...c }) => c);
    const visibleRows = chunks.reduce((n, c) => n + c.rowCount, 0) - deleted.filter((id) => chunks.some((c) => id >= c.rowStart && id < c.rowStart + c.rowCount)).length;
    hiddenRows = table.rowCount - table.deletedCount - visibleRows;

    /** A chunk's rows as objects (deleted rows left out). */
    async function chunkRows(chunk) {
      const values = new Array(table.columnCount).fill(null);
      let decoded = false;
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        if (!group.visible || !group.cols.length) continue;
        const sectionId = `${index}/chunk/${chunk.ordinal}/${group.name}`;
        const key = access
          ? await hkdf(concat(chunk.partitionSecret, group.secret), file.salt, `JAZMIN/1/${sectionId}`)
          : await file.key(sectionId, null);
        const raw = await file.section(chunk.parts[g], sectionId, key, { requireDigest });
        const cols = decodeColumnar(raw, group.cols.map((c) => columns[c].type), chunk.rowCount, chunk.ordinal);
        group.cols.forEach((c, j) => { values[c] = cols[j]; });
        decoded = true;
      }
      const rows = [];
      if (!decoded) return rows;
      const visibleCols = columns.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      for (let r = 0; r < chunk.rowCount; r++) {
        if (deletedSet.has(chunk.rowStart + r)) continue;
        const row = {};
        for (const i of visibleCols) row[columns[i].name] = values[i][r];
        rows.push(row);
      }
      return rows;
    }

    // Embedded files this key can see (spec 6.8): directories merged by path.
    let fileIndex = null;
    async function files() {
      if (fileIndex) return fileIndex;
      const entries = new Map();
      const contents = new Map();
      const member = header.files;
      if (member) {
        const suffix = member.segment ? `/${member.segment}` : '';
        for (const dir of member.directories) {
          let sectionId;
          let key;
          if (!access) {
            sectionId = `files/dir${suffix}`;
            key = await file.key(sectionId, null, 'files');
          } else {
            const secret = access.isOwner ? await hkdf(access.owner, file.salt, `JAZMIN/1/file-group/${dir.group}`) : access.files.get(dir.group);
            if (!secret) continue; // a group this key does not see
            sectionId = `files/dir/${dir.group}${suffix}`;
            key = await hkdf(secret, file.salt, `JAZMIN/1/${sectionId}`);
          }
          const directory = checkFileDirectory(parseJson(fromUtf8.decode(await file.section(dir.section, sectionId, key, { requireDigest })), 'An embedded-file directory'));
          for (const c of directory.contents) contents.set(c.id, c);
          for (const f of directory.files) if (!entries.has(f.path)) entries.set(f.path, { path: f.path, type: f.type, content: f.content });
        }
        for (const e of entries.values()) if (!contents.has(e.content)) throw new JazminFormatError(`Embedded file '${e.path}' refers to missing content`);
      }
      return (fileIndex = { entries, contents });
    }

    async function block(content, b) {
      const ref = content.blocks[b];
      const sectionId = `file/${content.id}/${b}`;
      if (!content.key && (file.keys || access)) throw new JazminFormatError(`Embedded content ${content.id} has no key in an encrypted file`);
      const key = content.key ? await hkdf(base64ToBytes(content.key), file.salt, `JAZMIN/1/${sectionId}`) : null;
      const bytes = await file.section({ offset: ref.offset, length: ref.length, digest: ref.digest ? base64ToBytes(ref.digest) : null }, sectionId, key, { requireDigest });
      if (bytes.length !== Math.min(content.blockSize, content.size - b * content.blockSize)) {
        throw new JazminFormatError(`Section '${sectionId}' has the wrong length for its embedded file`);
      }
      return bytes;
    }

    return {
      /** Names of the file's tables, in order. */
      tables: header.tables.map((t) => t.name),
      /** Name of this table. */
      table: table.name,
      columns: visibleColumns,
      metadata: file.metadata,
      sortedBy: table.sortedBy.length ? [...table.sortedBy] : undefined,
      /** Rows this key can read (deleted rows left out). */
      rowCount: visibleRows,
      /** Rows of this table this key may not see. */
      hiddenRowCount: Math.max(0, hiddenRows),
      encrypted: Boolean(file.keys || access),
      access: access ? { isOwner: access.isOwner, online: access.online, expires: access.expires, partitionBy: table.partitionBy || null } : null,
      package: header.files?.package ? parseJson(header.files.package, 'Package settings') : undefined,
      /** Another table of the same file (the file is not read again). */
      openTable: (tableName) => openTable(file, tableName),
      /** Rows matching a filter (spec 9), chunk by chunk. options: { offset, limit, select }. */
      async *find(filter, { offset = 0, limit = Infinity, select } = {}) {
        const match = filter ? compileFilter(filter, visibleColumns) : null;
        let skipped = 0;
        let yielded = 0;
        for (const chunk of chunks) {
          if (yielded >= limit) return;
          // Without a filter every row matches: chunks wholly before the offset are counted, not read.
          if (!match && offset - skipped >= liveRows(chunk)) {
            skipped += liveRows(chunk);
            continue;
          }
          for (const row of await chunkRows(chunk)) {
            if (match && !match(row)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            yield select ? Object.fromEntries(select.map((s) => [s, row[s]])) : row;
            if (++yielded >= limit) return;
          }
        }
      },
      /** A page of rows as an array, in file order: { rows, total } (total counts every match). */
      async query(filter, { offset = 0, limit = 100, select } = {}) {
        // Without a filter the total is the row count, so only the page is read.
        if (!filter) {
          const rows = [];
          for await (const row of this.find(null, { offset, limit, select })) rows.push(row);
          return { rows, total: visibleRows };
        }
        const rows = [];
        let total = 0;
        for await (const row of this.find(filter, { select })) {
          if (total >= offset && rows.length < limit) rows.push(row);
          total++;
        }
        return { rows, total };
      },
      async count(filter) {
        if (!filter) return visibleRows;
        let n = 0;
        for await (const row of this.find(filter)) if (row) n++;
        return n;
      },
      /** Embedded files this key can see: [{ path, type, size, sha256 }]. */
      async files() {
        const { entries, contents } = await files();
        return [...entries.values()].map((e) => {
          const c = contents.get(e.content);
          return { path: e.path, type: e.type, size: c.size, sha256: c.sha256 };
        }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      },
      /** A whole embedded file, checked against its SHA-256. */
      async readFile(path) {
        const { entries, contents } = await files();
        const entry = entries.get(path);
        if (!entry) throw new JazminError(`No file '${path}' is visible with this key`);
        const content = contents.get(entry.content);
        const parts = [];
        for (let b = 0; b < content.blocks.length; b++) parts.push(await block(content, b));
        const bytes = concat(...parts);
        if (toHex(await sha256(bytes)) !== content.sha256) throw new JazminFormatError(`File '${path}' does not match its SHA-256`);
        return bytes;
      },
      /** The embedded file as a Blob with its media type. */
      async fileBlob(path) {
        const { entries } = await files();
        const entry = entries.get(path);
        return new Blob([await this.readFile(path)], { type: entry ? entry.type : 'application/octet-stream' });
      },
    };
  }

  global.JazminBrowser = {
    open,
    compileFilter,
    base64ToBytes,
    JazminError,
    JazminFormatError,
    JazminKeyError,
    JazminUnlockRequiredError,
  };
})(globalThis);
