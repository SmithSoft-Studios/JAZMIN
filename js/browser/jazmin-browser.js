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

  function readIndexRef(bytes) {
    const ix = { column: '', kind: '', section: null, segment: 0 };
    readMessage(bytes, (f, v) => {
      if (f === 1) ix.column = text(v);
      else if (f === 2) ix.kind = text(v);
      else if (f === 3) ix.section = readRef(v);
      else if (f === 4) ix.segment = num(v);
    });
    return ix;
  }

  function readTable(bytes) {
    const t = {
      name: '', columnCount: 0, groups: [], sortedBy: [], partitionBy: '', rowCount: 0, deletedCount: 0, chunkCount: 0,
      partitions: [], partitionTable: null, deletes: null, indexes: [],
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
        case 11: t.indexes.push(readIndexRef(v)); break;
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

  /**
   * A chunk-directory segment (spec 6.3): one entry per chunk, with its parts (one per column group), and its
   * statistics blocks ({ columns, section }).
   */
  function readDirectory(bytes, groupCount) {
    let ordinals = [];
    let rowStarts = [];
    let rowCounts = [];
    let offsets = [];
    let lengths = [];
    let digests = null;
    const statistics = [];
    readMessage(bytes, (f, v) => {
      if (f === 1) ordinals = cumulative(readPacked(v));
      else if (f === 2) rowStarts = cumulative(readPacked(v));
      else if (f === 3) rowCounts = readPacked(v);
      else if (f === 4) offsets = cumulative(readPacked(v));
      else if (f === 5) lengths = readPacked(v);
      else if (f === 6) digests = bytesOf(v);
      else if (f === 7) {
        const block = { columns: [], section: null };
        readMessage(v, (bf, bv) => {
          if (bf === 1) block.columns = readPacked(bv);
          else if (bf === 2) block.section = readRef(bv);
        });
        statistics.push(block);
      }
    });
    const n = ordinals.length;
    if (rowStarts.length !== n || rowCounts.length !== n || offsets.length !== n * groupCount || lengths.length !== n * groupCount
      || (digests && digests.length !== n * groupCount * 32)) {
      throw new JazminFormatError('Chunk directory lists are inconsistent');
    }
    const chunks = ordinals.map((ordinal, i) => ({
      ordinal,
      rowStart: rowStarts[i],
      rowCount: rowCounts[i],
      parts: Array.from({ length: groupCount }, (_, g) => {
        const k = i * groupCount + g;
        return { offset: offsets[k], length: lengths[k], digest: digests ? digests.slice(k * 32, k * 32 + 32) : null };
      }),
    }));
    return { chunks, statistics };
  }

  /** A statistics section (spec 6.4): per column, null counts and bounds (key-form bytes) for each chunk. */
  function readStatistics(bytes) {
    const columns = [];
    readMessage(bytes, (f, v) => {
      if (f !== 1) return;
      const c = { nulls: [], min: [], max: [] };
      readMessage(v, (cf, cv) => {
        if (cf === 1) c.nulls = readPacked(cv);
        else if (cf === 2) c.min.push(bytesOf(cv));
        else if (cf === 3) c.max.push(bytesOf(cv));
      });
      columns.push(c);
    });
    return columns;
  }

  /** A sorted index's directory (spec 8.1): its pages ({ first, count, offset, length, digest }) and null postings. */
  function readIndexDirectory(bytes) {
    const firsts = [];
    let counts = [];
    let offsets = [];
    let lengths = [];
    let digests = null;
    let nulls = null;
    readMessage(bytes, (f, v) => {
      if (f === 1) firsts.push(bytesOf(v));
      else if (f === 2) counts = readPacked(v);
      else if (f === 3) offsets = cumulative(readPacked(v));
      else if (f === 4) lengths = readPacked(v);
      else if (f === 5) digests = bytesOf(v);
      else if (f === 6) nulls = readRef(v);
    });
    const n = firsts.length;
    if (counts.length !== n || offsets.length !== n || lengths.length !== n || (digests && digests.length !== n * 32)) {
      throw new JazminFormatError('Index directory lists are inconsistent');
    }
    return {
      pages: firsts.map((first, i) => ({ first, count: counts[i], offset: offsets[i], length: lengths[i], digest: digests ? digests.slice(i * 32, i * 32 + 32) : null })),
      nulls,
    };
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

  /** Postings: count, then differences between ascending row ids. */
  function readPostings(r) {
    const count = r.varUint();
    if (count > r.remaining) throw new JazminFormatError('Postings are truncated');
    const ids = new Array(count);
    let previous = 0;
    for (let i = 0; i < count; i++) {
      previous += r.varUint();
      if (previous > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
      ids[i] = previous;
    }
    return ids;
  }

  /** A postings section (deleted rows, null cells): encoding byte, then postings. */
  function readPostingsSection(bytes, what = 'Deleted rows') {
    const r = new Reader(bytes);
    if (r.byte() !== 0) throw new JazminFormatError(`${what} use an encoding this reader does not support`);
    const ids = readPostings(r);
    if (!r.eof) throw new JazminFormatError(`${what} have trailing bytes`);
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

  /**
   * Decodes a columnar chunk payload into one array of values per column (null for null). `wanted[j] === false`
   * skips column j (left undefined) without decoding it.
   */
  function decodeColumnar(raw, types, rowCount, ordinal, wanted) {
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || (rowCount > 0 && rowCount > raw.length * 8)) {
      throw new JazminFormatError(`Chunk ${ordinal}: row count does not match its size`);
    }
    const reader = new Reader(raw);
    const columns = new Array(types.length);
    for (let j = 0; j < types.length; j++) {
      const length = reader.varUint();
      const end = reader.pos + length;
      if (length < 1 || end > raw.length) throw new JazminFormatError(`Chunk ${ordinal}: invalid stream length`);
      if (wanted && !wanted[j]) {
        reader.pos = end;
        continue;
      }
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
    if ((op === 'eq' || op === 'ne') && (operand === null || operand === undefined)) return condition(column, 'isNull', op === 'eq');
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
      return (row) => row[name] != null && keys.some((k) => keyCompare(type, keyOf(type, row[name]), k) === 0);
    }
    const key = keyOf(type, operand);
    const test = { eq: (c) => c === 0, ne: (c) => c !== 0, gt: (c) => c > 0, gte: (c) => c >= 0, lt: (c) => c < 0, lte: (c) => c <= 0 }[op];
    return (row) => row[name] != null && test(keyCompare(type, keyOf(type, row[name]), key)); // NaN matches no comparison but ne
  }

  // ---- query planning: statistics, sort order and indexes (as the library does, spec 6.4, 8, 9) --------

  const ORDERED_TYPES = new Set(['int', 'float', 'decimal', 'string', 'datetime', 'bool']);
  const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
  const SMALL_LOOKUP_BYTES = 8 * 1024; // index lookups this small are always made: the bytes are negligible
  const PAGES_CACHED = 8; // decoded pages kept per sorted index

  /** Compares two keys of a column type; NaN when a float key is NaN (NaN matches nothing). */
  function keyCompare(type, a, b) {
    if (type === 'float' && (Number.isNaN(a) || Number.isNaN(b))) return NaN;
    return compare(type, a, b);
  }

  /** A value in the value encoding (spec 5.1), as a key. */
  function readKey(r, type) {
    switch (type) {
      case 'bool': return r.byte() !== 0;
      case 'int': return r.varInt();
      case 'float': return r.float64();
      case 'decimal': return keyOf('decimal', readDecimal(r));
      case 'datetime': return r.varInt();
      default: return r.string();
    }
  }

  /** A statistics or index-directory bound (spec 6.5): strings are bare UTF-8; empty means unbounded. */
  function decodeBound(type, bytes) {
    if (bytes.length === 0) return undefined;
    if (type === 'string') return fromUtf8.decode(bytes);
    return readKey(new Reader(bytes), type);
  }

  /**
   * A filter as a tree for planning, parsed by the same rules as compileFilter (which checks it first):
   * { kind: 'and' | 'or', items } | { kind: 'not', item } | { kind: 'leaf', column, op, value } (values as keys).
   */
  function planOf(filter, columns) {
    if (filter === null || filter === undefined) return null;
    const byName = new Map(columns.map((c) => [c.name, c]));
    const node = (f) => {
      const items = [];
      for (const [key, spec] of Object.entries(f)) {
        if (key === 'and' || key === 'or') items.push({ kind: key, items: spec.map(node) });
        else if (key === 'not') items.push({ kind: 'not', item: node(spec) });
        else {
          const column = byName.get(key);
          const conditions = spec === null ? { isNull: true }
            : typeof spec === 'object' && !(spec instanceof Date) && !Array.isArray(spec) ? spec : { eq: spec };
          for (const [op, operand] of Object.entries(conditions)) items.push(planLeaf(column, op, operand));
        }
      }
      return items.length === 1 ? items[0] : { kind: 'and', items };
    };
    return node(filter);
  }

  function planLeaf(column, op, operand) {
    const leaf = { kind: 'leaf', column, op };
    if ((op === 'eq' || op === 'ne') && (operand === null || operand === undefined)) return { ...leaf, op: 'isNull', value: op === 'eq' };
    if (op === 'isNull') return { ...leaf, value: Boolean(operand) };
    if (STRING_OPS.has(op)) return { ...leaf, value: String(operand) };
    if (!ORDERED_TYPES.has(column.type)) return { ...leaf, op: 'opaque' }; // binary / json: not planned
    if (op === 'in') return { ...leaf, value: operand.filter((v) => v !== null && v !== undefined).map((v) => keyOf(column.type, v)) };
    return { ...leaf, value: keyOf(column.type, operand) };
  }

  /** As answeredExactly in the library's filter.js: whether the rows sorted indexes return are exactly the matches. */
  function answeredExactly(plan) {
    const leaves = plan.kind === 'leaf' ? [plan] : plan.kind === 'and' && plan.items.every((i) => i.kind === 'leaf') ? plan.items : [];
    const nan = (l) => (Array.isArray(l.value) ? l.value : [l.value]).some((v) => typeof v === 'number' && Number.isNaN(v));
    if (!leaves.length || leaves.some((l) => !['eq', 'in', 'isNull', ...RANGE_OPS].includes(l.op) || !ORDERED_TYPES.has(l.column.type) || nan(l))) return false;
    return leaves.length === 1 || leaves.every((l) => RANGE_OPS.has(l.op) && l.column.position === leaves[0].column.position);
  }

  function planColumns(plan, into = new Set()) {
    if (!plan) return into;
    if (plan.kind === 'leaf') into.add(plan.column.position);
    else (plan.items ?? [plan.item]).forEach((n) => planColumns(n, into));
    return into;
  }

  function leafMayMatch(leaf, stat, rowCount) {
    if (!stat) return true;
    if (leaf.op === 'isNull') return leaf.value ? stat.nulls > 0 : stat.nulls < rowCount;
    if (stat.nulls === rowCount) return false;
    const { min, max } = stat;
    const cmp = (a, b) => keyCompare(leaf.column.type, a, b);
    const belowMax = (v, inclusive) => max === undefined || (inclusive ? cmp(v, max) <= 0 : cmp(v, max) < 0);
    const aboveMin = (v, inclusive) => min === undefined || (inclusive ? cmp(v, min) >= 0 : cmp(v, min) > 0);
    switch (leaf.op) {
      case 'eq': return aboveMin(leaf.value, true) && belowMax(leaf.value, true);
      case 'in': return leaf.value.some((v) => aboveMin(v, true) && belowMax(v, true));
      case 'gt': return max === undefined || cmp(max, leaf.value) > 0;
      case 'gte': return max === undefined || cmp(max, leaf.value) >= 0;
      case 'lt': return min === undefined || cmp(min, leaf.value) < 0;
      case 'lte': return min === undefined || cmp(min, leaf.value) <= 0;
      default: return true;
    }
  }

  /** False when chunk statistics prove no row can match; `stats(col)` gives a column's statistics or undefined. */
  function mayMatch(node, stats, rowCount) {
    switch (node.kind) {
      case 'and': return node.items.every((n) => mayMatch(n, stats, rowCount));
      case 'or': return node.items.some((n) => mayMatch(n, stats, rowCount));
      case 'not': return true;
      default: return leafMayMatch(node, stats(node.column.position), rowCount);
    }
  }

  function leafMustMatch(leaf, stat, rowCount) {
    // Float statistics leave NaN values out, so they cannot prove that every row matches.
    if (!stat || leaf.column.type === 'float') return false;
    if (leaf.op === 'isNull') return leaf.value ? stat.nulls === rowCount : stat.nulls === 0;
    const { min, max } = stat;
    if (stat.nulls !== 0 || min === undefined || max === undefined) return false;
    const cmp = (a, b) => keyCompare(leaf.column.type, a, b);
    switch (leaf.op) {
      case 'eq': return cmp(min, leaf.value) === 0 && cmp(max, leaf.value) === 0;
      case 'ne': return cmp(max, leaf.value) < 0 || cmp(min, leaf.value) > 0;
      case 'in': return cmp(min, max) === 0 && leaf.value.some((v) => cmp(min, v) === 0);
      case 'gt': return cmp(min, leaf.value) > 0;
      case 'gte': return cmp(min, leaf.value) >= 0;
      case 'lt': return cmp(max, leaf.value) < 0;
      case 'lte': return cmp(max, leaf.value) <= 0;
      default: return false;
    }
  }

  /** True when chunk statistics prove that every row matches (an offset can then skip the chunk by its row count). */
  function mustMatch(node, stats, rowCount) {
    switch (node.kind) {
      case 'and': return node.items.every((n) => mustMatch(n, stats, rowCount));
      case 'or': return node.items.some((n) => mustMatch(n, stats, rowCount));
      case 'not': return !mayMatch(node.item, stats, rowCount);
      default: return leafMustMatch(node, stats(node.column.position), rowCount);
    }
  }

  /** Bounds the top-level AND of a filter puts on one column: { low, lowInclusive, high, highInclusive } or null. */
  function sortBounds(plan, position) {
    const leaves = plan.kind === 'and' ? plan.items : [plan];
    let bounds = null;
    for (const leaf of leaves) {
      if (leaf.kind !== 'leaf' || leaf.column.position !== position || !['eq', ...RANGE_OPS].includes(leaf.op)) continue;
      if (typeof leaf.value === 'number' && Number.isNaN(leaf.value)) continue;
      const cmp = (a, b) => keyCompare(leaf.column.type, a, b);
      bounds ??= {};
      if (leaf.op !== 'lt' && leaf.op !== 'lte' && (bounds.low === undefined || cmp(leaf.value, bounds.low) > 0)) {
        Object.assign(bounds, { low: leaf.value, lowInclusive: leaf.op !== 'gt' });
      }
      if (leaf.op !== 'gt' && leaf.op !== 'gte' && (bounds.high === undefined || cmp(leaf.value, bounds.high) < 0)) {
        Object.assign(bounds, { high: leaf.value, highInclusive: leaf.op !== 'lt' });
      }
    }
    return bounds;
  }

  /*
   * Index lookups (as the library's indexes.js): { op: 'eq', value } | { op: 'in', values }
   * | { op: 'range', low, lowInclusive, high, highInclusive } | { op: 'prefix', text } | { op: 'nulls' }
   * | { op: 'contains', text, ci }. cost(lookup): bytes of index data still to read (nothing is read to answer),
   * null when the index cannot answer it; rows(lookup): the sorted row ids.
   */
  const unionAll = (lists) => [...new Set(lists.flat())].sort((a, b) => a - b);
  function intersectSorted(a, b) {
    const out = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) {
        out.push(a[i]);
        i++;
        j++;
      } else if (a[i] < b[j]) i++;
      else j++;
    }
    return out;
  }

  /** A sorted index (spec 8.1): its directory is read up front; pages as lookups need them (a few kept). */
  class PagedIndex {
    constructor(directory, type, load) {
      this.type = type;
      this.pages = directory.pages.map((p) => ({ ...p, first: decodeBound(type, p.first) }));
      if (this.pages.some((p) => p.first === undefined)) throw new JazminFormatError('Index page has no first key');
      this.nullsAt = directory.nulls;
      this.load = load;
      this.cache = new Map();
    }

    async page(i) {
      let page = this.cache.get(i);
      if (page) {
        this.cache.delete(i);
      } else {
        const r = new Reader(await this.load(`page/${i}`, this.pages[i]));
        if (r.byte() !== 0) throw new JazminFormatError('Index page uses an encoding this reader does not support');
        const count = r.varUint();
        if (count > r.remaining || count !== this.pages[i].count) throw new JazminFormatError('Index page does not match its directory');
        page = { keys: new Array(count), postings: new Array(count) };
        for (let k = 0; k < count; k++) {
          page.keys[k] = readKey(r, this.type);
          page.postings[k] = readPostings(r);
        }
        if (!r.eof) throw new JazminFormatError('Index page has trailing bytes');
        if (this.cache.size >= PAGES_CACHED) this.cache.delete(this.cache.keys().next().value);
      }
      this.cache.set(i, page);
      return page;
    }

    /** Last page whose first key is <= value, or -1. */
    pageFor(value) {
      let lo = 0;
      let hi = this.pages.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keyCompare(this.type, this.pages[mid].first, value) <= 0) lo = mid + 1;
        else hi = mid;
      }
      return lo - 1;
    }

    span(lookup) {
      const last = this.pages.length - 1;
      const isNaNKey = (v) => typeof v === 'number' && Number.isNaN(v);
      switch (lookup.op) {
        case 'eq': {
          if (isNaNKey(lookup.value)) return [0, -1];
          const i = this.pageFor(lookup.value);
          return [Math.max(i, 0), i];
        }
        case 'range':
          if (isNaNKey(lookup.low) || isNaNKey(lookup.high)) return [0, -1];
          return [lookup.low === undefined ? 0 : Math.max(this.pageFor(lookup.low), 0), lookup.high === undefined ? last : this.pageFor(lookup.high)];
        case 'prefix': {
          const from = Math.max(this.pageFor(lookup.text), 0);
          let to = from;
          while (to < last && this.pages[to + 1].first.startsWith(lookup.text)) to++;
          return [from, Math.min(to, last)];
        }
        default: return [0, -1];
      }
    }

    cost(lookup) {
      if (lookup.op === 'contains') return null;
      if (lookup.op === 'nulls') return this.nullsAt ? this.nullsAt.length : 0;
      const pages = new Set();
      const add = ([from, to]) => {
        for (let i = from; i <= to; i++) if (!this.cache.has(i)) pages.add(i);
      };
      if (lookup.op === 'in') for (const value of lookup.values) add(this.span({ op: 'eq', value }));
      else add(this.span(lookup));
      let bytes = 0;
      for (const i of pages) bytes += this.pages[i].length;
      return bytes;
    }

    /** First position in a page whose key is >= value (> value when strict). */
    bound(page, value, strict) {
      let lo = 0;
      let hi = page.keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const c = keyCompare(this.type, page.keys[mid], value);
        if (c < 0 || (strict && c === 0)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    async rows(lookup) {
      switch (lookup.op) {
        case 'eq': case 'in': {
          const lists = [];
          for (const value of lookup.op === 'eq' ? [lookup.value] : lookup.values) {
            const [from, to] = this.span({ op: 'eq', value });
            if (to < from) continue;
            const page = await this.page(from);
            const i = this.bound(page, value, false);
            if (i < page.keys.length && keyCompare(this.type, page.keys[i], value) === 0) lists.push(page.postings[i]);
          }
          return unionAll(lists);
        }
        case 'nulls': return this.nullsAt ? readPostingsSection(await this.load('nulls', this.nullsAt), 'Index null postings') : [];
        case 'range': case 'prefix': {
          const [from, to] = this.span(lookup);
          const lists = [];
          for (let j = from; j <= to; j++) {
            const page = await this.page(j);
            let start;
            let end;
            if (lookup.op === 'prefix') {
              start = this.bound(page, lookup.text, false);
              end = start;
              while (end < page.keys.length && page.keys[end].startsWith(lookup.text)) end++;
            } else {
              start = lookup.low === undefined ? 0 : this.bound(page, lookup.low, !lookup.lowInclusive);
              end = lookup.high === undefined ? page.keys.length : this.bound(page, lookup.high, lookup.highInclusive);
            }
            for (let k = start; k < end; k++) lists.push(page.postings[k]);
          }
          return unionAll(lists);
        }
        default: return [];
      }
    }
  }

  /** Whether a trigram index can narrow a search: not under 3 characters, nor case-insensitive non-ASCII. */
  function trigramsOf(text) {
    const lower = text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
    const grams = new Set();
    for (let i = 0; i + 3 <= lower.length; i++) grams.add(lower.substring(i, i + 3));
    return grams;
  }
  const trigramAnswers = (text, ci) => !(ci && /[^\x00-\x7f]/.test(text)) && trigramsOf(text).size > 0;

  /** A trigram index (spec 8.2), read only when a lookup is made: until then a lookup costs its whole size. */
  class LazyTrigramIndex {
    constructor(bytes, load) {
      this.bytes = bytes;
      this.load = load;
      this.grams = null;
    }

    cost(lookup) {
      if (lookup.op !== 'contains' || !trigramAnswers(lookup.text, lookup.ci)) return null;
      return this.grams ? 0 : this.bytes;
    }

    async rows(lookup) {
      if (!this.grams) {
        this.grams = new Map();
        for (const bytes of await this.load()) {
          const r = new Reader(bytes);
          if (r.byte() !== 0) throw new JazminFormatError('Trigram index uses an encoding this reader does not support');
          const count = r.varUint();
          if (count > r.remaining / 7) throw new JazminFormatError('Trigram index is truncated');
          for (let i = 0; i < count; i++) {
            const gram = String.fromCharCode(r.u16(), r.u16(), r.u16());
            this.grams.set(gram, [...(this.grams.get(gram) ?? []), ...readPostings(r)]);
          }
          if (!r.eof) throw new JazminFormatError('Trigram index has trailing bytes');
        }
        for (const [gram, ids] of this.grams) this.grams.set(gram, unionAll([ids]));
      }
      let result = null;
      for (const gram of trigramsOf(lookup.text)) {
        const ids = this.grams.get(gram);
        if (!ids) return [];
        result = result === null ? ids : intersectSorted(result, ids);
        if (!result.length) return result;
      }
      return result ?? [];
    }
  }

  /** Several index segments of one column (the original rows, and each append's): costs add up, rows unite. */
  class CompositeIndex {
    constructor(parts) {
      this.parts = parts;
    }

    cost(lookup) {
      let bytes = 0;
      for (const part of this.parts) {
        const c = part.cost(lookup);
        if (c === null) return null;
        bytes += c;
      }
      return bytes;
    }

    async rows(lookup) {
      const lists = [];
      for (const part of this.parts) lists.push(await part.rows(lookup));
      return unionAll(lists);
    }
  }

  /** The index lookup a condition can use - [kind, lookup] - or null. */
  function leafLookup(leaf) {
    switch (leaf.op) {
      case 'contains': case 'icontains': return ['trigram', { op: 'contains', text: leaf.value, ci: leaf.op === 'icontains' }];
      case 'eq': return ['sorted', { op: 'eq', value: leaf.value }];
      case 'in': return ['sorted', { op: 'in', values: leaf.value }];
      case 'startsWith': return ['sorted', { op: 'prefix', text: leaf.value }];
      case 'isNull': return leaf.value ? ['sorted', { op: 'nulls' }] : null;
      case 'gt': case 'gte': return ['sorted', { op: 'range', low: leaf.value, lowInclusive: leaf.op === 'gte' }];
      case 'lt': case 'lte': return ['sorted', { op: 'range', high: leaf.value, highInclusive: leaf.op === 'lte' }];
      default: return null;
    }
  }

  /**
   * How indexes can narrow a filter: { cost, rows() } or null (as the library's indexPlan). Range conditions on one
   * column (in an AND) become one bounded lookup; lookups are taken cheapest first within `budget` bytes.
   */
  async function indexPlan(node, indexes, budget) {
    const lookupPlan = async (leaf, kind, lookup) => {
      const index = await indexes(leaf.column.name, kind);
      const cost = index ? index.cost(lookup) : null;
      return cost === null || cost > budget ? null : { cost, rows: () => index.rows(lookup) };
    };
    switch (node.kind) {
      case 'and': {
        const parts = [];
        const ranges = new Map(); // column position -> [leaf, merged range lookup]
        for (const item of node.items) {
          if (item.kind === 'leaf' && RANGE_OPS.has(item.op) && !(typeof item.value === 'number' && Number.isNaN(item.value))) {
            const [, add] = leafLookup(item);
            const [, merged] = ranges.get(item.column.position) ?? [item, { op: 'range' }];
            const cmp = (a, b) => keyCompare(item.column.type, a, b);
            if (add.low !== undefined && (merged.low === undefined || cmp(add.low, merged.low) > 0 || (cmp(add.low, merged.low) === 0 && !add.lowInclusive))) {
              Object.assign(merged, { low: add.low, lowInclusive: add.lowInclusive });
            }
            if (add.high !== undefined && (merged.high === undefined || cmp(add.high, merged.high) < 0 || (cmp(add.high, merged.high) === 0 && !add.highInclusive))) {
              Object.assign(merged, { high: add.high, highInclusive: add.highInclusive });
            }
            ranges.set(item.column.position, [item, merged]);
          } else {
            parts.push(await indexPlan(item, indexes, budget));
          }
        }
        for (const [leaf, lookup] of ranges.values()) parts.push(await lookupPlan(leaf, 'sorted', lookup));
        const usable = parts.filter(Boolean).sort((a, b) => a.cost - b.cost);
        const chosen = [];
        let cost = 0;
        for (const part of usable) {
          if (cost + part.cost > budget) break;
          chosen.push(part);
          cost += part.cost;
        }
        if (!chosen.length) return null;
        return {
          cost,
          rows: async () => {
            let result = await chosen[0].rows();
            for (let i = 1; i < chosen.length && result.length; i++) result = intersectSorted(result, await chosen[i].rows());
            return result;
          },
        };
      }
      case 'or': {
        const parts = [];
        let cost = 0;
        for (const item of node.items) {
          const part = await indexPlan(item, indexes, budget);
          if (part === null) return null;
          parts.push(part);
          cost += part.cost;
        }
        return cost > budget ? null : { cost, rows: async () => unionAll(await Promise.all(parts.map((p) => p.rows()))) };
      }
      case 'not': return null;
      default: {
        const lookup = leafLookup(node);
        return lookup ? lookupPlan(node, lookup[0], lookup[1]) : null;
      }
    }
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
    // Any other source: { size, read(offset, length) -> Uint8Array or a promise of one }.
    if (input && Number.isSafeInteger(input.size) && input.size >= 0 && typeof input.read === 'function') {
      return {
        size: input.size,
        read: async (offset, length) => {
          const bytes = await input.read(offset, length);
          if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new JazminFormatError('The source returned the wrong number of bytes');
          return bytes;
        },
      };
    }
    throw new JazminError('Open a File, Blob, ArrayBuffer, Uint8Array or { size, read(offset, length) }');
  }

  const BLOCK_SIZE = 64 * 1024; // bytes fetched per range request, at least
  const BLOCKS_CACHED = 64; // fetched blocks kept per file (4 MiB with the default block size)

  /**
   * A file on a web server read with HTTP range requests. The first request fetches the last block (the trailer,
   * header and directories of most files, and the size from Content-Range); later reads fetch whole aligned blocks,
   * kept in a small cache, and reads of the same block wait for one request. A server that answers with the whole
   * file instead (no range support) is read from memory. Cross-origin servers must expose Content-Range (CORS).
   */
  async function urlSource(url, { headers = {}, blockSize = BLOCK_SIZE } = {}) {
    if (!(Number.isSafeInteger(blockSize) && blockSize >= 1024)) throw new JazminError('blockSize must be at least 1024 bytes');
    const get = async (range) => {
      let response;
      try {
        response = await fetch(url, { headers: { ...headers, Range: range } });
      } catch (error) {
        throw new JazminError(`Could not read ${url}: ${error.message}`);
      }
      if (response.status !== 206 && response.status !== 200) throw new JazminError(`Could not read ${url}: HTTP ${response.status}`);
      return response;
    };
    const tail = await get(`bytes=-${blockSize}`);
    const body = new Uint8Array(await tail.arrayBuffer());
    if (tail.status === 200) return sourceOf(body); // no range support: the whole file came back
    const total = /\/(\d+)\s*$/.exec(tail.headers.get('Content-Range') ?? '');
    if (!total) throw new JazminError(`${url}: the server's answer has no readable Content-Range header (cross-origin servers must expose it)`);
    const size = Number(total[1]);
    const blocks = new Map(); // block number -> bytes (least recently used first), or a pending fetch
    const keep = (n, bytes) => {
      blocks.delete(n);
      blocks.set(n, bytes);
      if (blocks.size > BLOCKS_CACHED) blocks.delete(blocks.keys().next().value);
    };
    // The tail block: the bytes it holds, cut at block boundaries (its start need not be one).
    const tailStart = size - body.length;
    for (let n = Math.ceil(tailStart / blockSize); n * blockSize < size; n++) {
      const start = n * blockSize - tailStart;
      keep(n, body.subarray(start, Math.min(start + blockSize, body.length)));
    }
    const fetchBlocks = async (first, last) => {
      const start = first * blockSize;
      const end = Math.min((last + 1) * blockSize, size) - 1;
      const response = await get(`bytes=${start}-${end}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const from = response.status === 200 ? start : 0; // a server may answer a range with the whole file
      if (bytes.length < from + end - start + 1) throw new JazminFormatError(`${url}: the server returned fewer bytes than asked for`);
      for (let n = first; n <= last; n++) keep(n, bytes.subarray(from + (n - first) * blockSize, from + Math.min((n - first + 1) * blockSize, end - start + 1)));
    };
    return {
      size,
      async read(offset, length) {
        const first = Math.floor(offset / blockSize);
        const last = Math.floor((offset + Math.max(length, 1) - 1) / blockSize);
        if (last - first + 1 > BLOCKS_CACHED / 2) {
          // A large read (a big index, say) would push its own blocks out of the cache: fetch it as it is.
          const response = await get(`bytes=${offset}-${offset + length - 1}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const from = response.status === 200 ? offset : 0;
          if (bytes.length < from + length) throw new JazminFormatError(`${url}: the server returned fewer bytes than asked for`);
          return bytes.subarray(from, from + length);
        }
        // One request for the blocks still missing (from the first missing to the last), shared by concurrent reads.
        let missingFrom = -1;
        let missingTo = -1;
        for (let n = first; n <= last; n++) {
          if (!blocks.has(n)) {
            if (missingFrom < 0) missingFrom = n;
            missingTo = n;
          }
        }
        if (missingFrom >= 0) {
          const pending = fetchBlocks(missingFrom, missingTo);
          const waiting = [];
          for (let n = missingFrom; n <= missingTo; n++) {
            if (!blocks.has(n)) {
              blocks.set(n, pending);
              waiting.push(n);
            }
          }
          try {
            await pending;
          } catch (error) {
            for (const n of waiting) if (blocks.get(n) === pending) blocks.delete(n); // a later read tries again
            throw error;
          }
        }
        for (let n = first; n <= last; n++) if (blocks.get(n) instanceof Promise) await blocks.get(n);
        const out = new Uint8Array(length);
        for (let n = first; n <= last; n++) {
          const block = blocks.get(n);
          keep(n, block);
          const blockStart = n * blockSize;
          const from = Math.max(offset, blockStart);
          const to = Math.min(offset + length, blockStart + block.length);
          out.set(block.subarray(from - blockStart, to - blockStart), from - offset);
        }
        return out;
      },
    };
  }

  /**
   * Opens a JAZMIN file on a web server, reading only the parts a query needs (HTTP range requests). options: those
   * of open(), plus { headers } (sent with every request, e.g. Authorization) and { blockSize } (bytes per request,
   * at least; default 64 KiB).
   */
  async function openUrl(url, options = {}) {
    const { headers, blockSize, ...openOptions } = options;
    return open(await urlSource(url, { headers, blockSize }), openOptions);
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
      if (file.cost) file.cost.bytesRead += ref.length;
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
      cost: null, // while explain({ analyze }) runs a query: what it reads
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
    const dirSegments = []; // { partition, suffix, chunks, statistics, loaded: block numbers read }
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
        const directory = readDirectory(await file.section(list[s], sectionId, await file.key(sectionId, secret), { requireDigest }), groupCount);
        const segmentChunks = directory.chunks.map((c) => ({ ...c, partition: id, partitionSecret: secret, stats: [] }));
        chunks.push(...segmentChunks);
        dirSegments.push({ partition: id, suffix: s ? `/${s}` : '', chunks: segmentChunks, statistics: directory.statistics, loaded: new Set() });
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

    /**
     * A chunk's rows as objects, by position in the chunk (rows deleted by appends are null). `wanted` (by column
     * position) limits the columns decoded; a column group none of whose columns is wanted is not read.
     */
    async function chunkRows(chunk, wanted = null) {
      const values = new Array(table.columnCount).fill(null);
      const decodedCols = [];
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        if (!group.visible || !group.cols.length) continue;
        const groupWanted = wanted && group.cols.map((c) => wanted[c]);
        if (groupWanted && !groupWanted.includes(true)) continue;
        const sectionId = `${index}/chunk/${chunk.ordinal}/${group.name}`;
        const key = access
          ? await hkdf(concat(chunk.partitionSecret, group.secret), file.salt, `JAZMIN/1/${sectionId}`)
          : await file.key(sectionId, null);
        const raw = await file.section(chunk.parts[g], sectionId, key, { requireDigest });
        const cols = decodeColumnar(raw, group.cols.map((c) => columns[c].type), chunk.rowCount, chunk.ordinal, groupWanted);
        group.cols.forEach((c, j) => {
          if (groupWanted && !groupWanted[j]) return;
          values[c] = cols[j];
          decodedCols.push(c);
        });
      }
      if (file.cost) {
        file.cost.chunksRead++;
        file.cost.columnsDecoded += decodedCols.length;
      }
      const rows = new Array(chunk.rowCount);
      for (let r = 0; r < chunk.rowCount; r++) {
        if (deletedSet.has(chunk.rowStart + r)) {
          rows[r] = null;
          continue;
        }
        const row = {};
        for (const i of decodedCols) row[columns[i].name] = values[i][r];
        rows[r] = row;
      }
      return rows;
    }

    // ---- planning (as the library's reader): statistics, sort order, indexes ----
    const planColumnsList = columns.filter(Boolean);
    const byOrdinal = new Map(chunks.map((c) => [c.ordinal, c]));
    const chunkBytes = (chunk) => chunk.parts.reduce((n, part) => n + part.length, 0);
    const groupOfColumn = new Map();
    groups.forEach((g) => g.cols.forEach((c) => groupOfColumn.set(c, g)));

    /** Loads the statistics of these columns for every directory segment that has them. */
    async function ensureStats(cols) {
      for (const segment of dirSegments) {
        for (let b = 0; b < segment.statistics.length; b++) {
          const block = segment.statistics[b];
          if (segment.loaded.has(b) || !block.columns.some((c) => cols.has(c))) continue;
          segment.loaded.add(b);
          if (block.columns.some((c) => !(c >= 0 && c < table.columnCount))) throw new JazminFormatError('Statistics block lists unknown columns');
          const group = groupOfColumn.get(block.columns[0]);
          if (!group || !group.visible) continue; // a column group this key cannot see
          const sectionId = `${index}/stats/${segment.partition}/${b}${segment.suffix}`;
          const key = access
            ? await hkdf(concat(segment.chunks[0]?.partitionSecret ?? await file.partitionSecret(segment.partition), group.secret), file.salt, `JAZMIN/1/${sectionId}`)
            : await file.key(sectionId, null);
          const entries = readStatistics(await file.section(block.section, sectionId, key, { requireDigest }));
          if (entries.length !== block.columns.length) throw new JazminFormatError('Statistics block does not match its columns');
          block.columns.forEach((col, k) => {
            const e = entries[k];
            const n = segment.chunks.length;
            if (e.nulls.length !== n || e.min.length !== n || e.max.length !== n) throw new JazminFormatError('Statistics do not match the chunk directory');
            const type = columns[col]?.type;
            if (!type) return;
            segment.chunks.forEach((chunk, i) => {
              chunk.stats[col] = { nulls: e.nulls[i], min: decodeBound(type, e.min[i]), max: decodeBound(type, e.max[i]) };
            });
          });
        }
      }
    }

    const statsOf = (chunk) => (col) => chunk.stats[col];
    const chunkMayMatch = (plan, chunk) => !plan || mayMatch(plan, statsOf(chunk), chunk.rowCount);

    /** The chunks a scan reads: on the leading sort column, a binary search on chunk statistics; then statistics. */
    function scanList(plan) {
      let list = chunks;
      const leading = table.sortedBy[0];
      const sortColumn = leading !== undefined ? planColumnsList.find((c) => c.name === leading) : undefined;
      const bounds = plan && sortColumn ? sortBounds(plan, sortColumn.position) : null;
      if (bounds && chunks.every((c) => { const st = c.stats[sortColumn.position]; return st && st.min !== undefined && st.max !== undefined && st.nulls === 0; })) {
        const cmp = (a, b) => keyCompare(sortColumn.type, a, b);
        const stat = (i) => chunks[i].stats[sortColumn.position];
        const firstWhere = (test) => {
          let lo = 0;
          let hi = chunks.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (test(stat(mid))) hi = mid;
            else lo = mid + 1;
          }
          return lo;
        };
        const from = bounds.low === undefined ? 0 : firstWhere((st) => (bounds.lowInclusive ? cmp(st.max, bounds.low) >= 0 : cmp(st.max, bounds.low) > 0));
        const to = bounds.high === undefined ? chunks.length : firstWhere((st) => (bounds.highInclusive ? cmp(st.min, bounds.high) > 0 : cmp(st.min, bounds.high) >= 0));
        list = chunks.slice(from, Math.max(from, to));
      }
      return list.filter((c) => chunkMayMatch(plan, c));
    }

    // Indexes: files that are not access-controlled (in those, indexes are the owner's alone).
    const loadedIndexes = new Map();
    async function indexOf(column, kind) {
      const cacheKey = `${column}/${kind}`;
      if (loadedIndexes.has(cacheKey)) return loadedIndexes.get(cacheKey);
      let result;
      const refs = access || table.sortedBy[0] === column ? [] : table.indexes.filter((ix) => ix.column === column && ix.kind === kind);
      const type = planColumnsList.find((c) => c.name === column)?.type;
      if (refs.length && type) {
        const readIndex = async (sectionId, ref) => {
          if (file.cost) file.cost.indexPagesRead++;
          return file.section(ref, sectionId, await file.key(sectionId, null, 'index'));
        };
        const sectionIdOf = (ix) => `${index}/index/${column}/${kind}${ix.segment ? `/${ix.segment}` : ''}`;
        const combine = (parts) => (parts.length === 1 ? parts[0] : new CompositeIndex(parts));
        if (kind === 'trigram') {
          result = new LazyTrigramIndex(refs.reduce((n, ix) => n + ix.section.length, 0), () => Promise.all(refs.map((ix) => readIndex(sectionIdOf(ix), ix.section))));
        } else {
          const parts = [];
          for (const ix of refs) {
            const sectionId = sectionIdOf(ix);
            parts.push(new PagedIndex(readIndexDirectory(await readIndex(sectionId, ix.section)), type, (part, ref) => readIndex(`${sectionId}/${part}`, ref)));
          }
          result = combine(parts);
        }
      }
      loadedIndexes.set(cacheKey, result);
      return result;
    }

    /** The chunk holding a row id, or undefined. */
    function chunkFor(rowId) {
      let lo = 0;
      let hi = chunks.length - 1;
      if (hi < 0) return undefined;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (chunks[mid].rowStart <= rowId) lo = mid;
        else hi = mid - 1;
      }
      const c = chunks[lo];
      return rowId >= c.rowStart && rowId < c.rowStart + c.rowCount ? c : undefined;
    }

    /**
     * How a filtered query reads (as the library's #candidates): the chunks a scan would read, or - when an index
     * lookup reads less than they do - the index's candidate rows in them. { runs: [{ chunk, from, to }], rowIds }
     * (from..to: the chunk's candidates in rowIds; rowIds null: every row of each chunk is checked).
     */
    async function route(plan) {
      if (!plan) return { runs: chunks.map((chunk) => ({ chunk })), rowIds: null };
      const cols = planColumns(plan);
      const leading = planColumnsList.find((c) => c.name === table.sortedBy[0]);
      if (leading) cols.add(leading.position);
      await ensureStats(cols);
      const scan = scanList(plan);
      let budget = 0;
      let smallest = Infinity;
      for (const chunk of scan) {
        budget += chunkBytes(chunk);
        smallest = Math.min(smallest, chunkBytes(chunk));
      }
      const lookup = await indexPlan(plan, indexOf, Math.max(scan.length ? budget - smallest : 0, SMALL_LOOKUP_BYTES));
      if (!lookup) return { runs: scan.map((chunk) => ({ chunk })), rowIds: null };
      const inScan = new Set(scan);
      const rowIds = (await lookup.rows()).filter((id) => inScan.has(chunkFor(id)));
      const runs = [];
      for (let i = 0; i < rowIds.length;) {
        const chunk = chunkFor(rowIds[i]);
        let j = i + 1;
        while (j < rowIds.length && rowIds[j] < chunk.rowStart + chunk.rowCount) j++;
        runs.push({ chunk, from: i, to: j });
        i = j;
      }
      return { runs, rowIds };
    }

    /** By column position: the columns a query decodes - those its filter reads and those it returns. */
    function wantedColumns(plan, select) {
      const used = planColumns(plan);
      if (select) for (const name of select) used.add(planColumnsList.find((c) => c.name === name)?.position);
      else for (const c of planColumnsList) used.add(c.position);
      return Array.from({ length: table.columnCount }, (_, i) => used.has(i));
    }

    /** Rows of a query, chunk by chunk: { row } for each match, after skipping `offset` (whole chunks unread). */
    async function* matches(filter, { offset = 0, limit = Infinity, select } = {}) {
      const match = filter ? compileFilter(filter, visibleColumns) : null;
      if (select) for (const name of select) if (!visibleColumns.some((c) => c.name === name)) throw new JazminError(`Unknown column '${name}' in select`);
      const plan = planOf(filter, planColumnsList);
      const { runs, rowIds } = await route(plan);
      const wanted = wantedColumns(plan, select);
      let skipped = 0;
      let yielded = 0;
      for (const { chunk, from, to } of runs) {
        if (yielded >= limit) return;
        // Chunks wholly before the offset whose every row matches are counted, not read.
        if (rowIds === null && skipped < offset && offset - skipped >= liveRows(chunk) && (!plan || mustMatch(plan, statsOf(chunk), chunk.rowCount))) {
          skipped += liveRows(chunk);
          continue;
        }
        const rows = await chunkRows(chunk, wanted);
        const count = rowIds === null ? rows.length : to - from;
        for (let k = 0; k < count; k++) {
          const row = rows[rowIds === null ? k : rowIds[from + k] - chunk.rowStart];
          if (row === null || (match && !match(row))) continue;
          if (skipped < offset) {
            skipped++;
            continue;
          }
          yield select ? Object.fromEntries(select.map((name) => [name, row[name]])) : row;
          if (++yielded >= limit) return;
        }
      }
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
      /**
       * Rows matching a filter (spec 9), chunk by chunk. options: { offset, limit, select }. Chunk statistics, the
       * sort order and indexes decide which chunks are read, as in the library.
       */
      find(filter, options) {
        return matches(filter, options);
      },
      /**
       * A page of rows as an array, in file order: { rows, total }. `total` counts every match (chunks whose every
       * row matches are counted without reading them); pass { total: false } to read only the page.
       */
      async query(filter, { offset = 0, limit = 100, select, total = true } = {}) {
        const rows = [];
        for await (const row of matches(filter, { offset, limit, select })) rows.push(row);
        return total ? { rows, total: await this.count(filter) } : { rows };
      },
      /**
       * Rows matching a filter. When sorted indexes answer it exactly, their row count is the answer; otherwise chunks
       * whose every row matches are counted by their row count, without reading them.
       */
      async count(filter) {
        if (!filter) return visibleRows;
        const match = compileFilter(filter, visibleColumns);
        const plan = planOf(filter, planColumnsList);
        const { runs, rowIds } = await route(plan);
        if (rowIds !== null && answeredExactly(plan)) return rowIds.filter((id) => !deletedSet.has(id)).length;
        const wanted = wantedColumns(plan, []);
        let n = 0;
        for (const { chunk, from, to } of runs) {
          if (rowIds === null && mustMatch(plan, statsOf(chunk), chunk.rowCount)) {
            n += liveRows(chunk);
            continue;
          }
          const rows = await chunkRows(chunk, wanted);
          const count = rowIds === null ? rows.length : to - from;
          for (let k = 0; k < count; k++) {
            const row = rows[rowIds === null ? k : rowIds[from + k] - chunk.rowStart];
            if (row !== null && match(row)) n++;
          }
        }
        return n;
      },
      /**
       * How a filter executes, as the library reports it: { strategy: 'index', candidateRows } or { strategy: 'scan',
       * chunks, chunksSkipped }. With { analyze: true } (and any find() options) it also runs the query and reports
       * rows, bytesRead, chunksRead, indexPagesRead, columnsDecoded and ms. Statistics and indexes already loaded are
       * not read again: analyze on a freshly opened reader to see a query's full cost.
       */
      async explain(filter, { analyze = false, ...options } = {}) {
        if (filter) compileFilter(filter, visibleColumns);
        const describe = async () => {
          const { runs, rowIds } = await route(planOf(filter, planColumnsList));
          return rowIds ? { strategy: 'index', candidateRows: rowIds.length } : { strategy: 'scan', chunks: chunks.length, chunksSkipped: chunks.length - runs.length };
        };
        if (!analyze) return describe();
        const cost = { rows: 0, bytesRead: 0, chunksRead: 0, indexPagesRead: 0, columnsDecoded: 0, ms: 0 };
        const start = performance.now();
        file.cost = cost;
        try {
          for await (const _ of matches(filter, options)) cost.rows++;
        } finally {
          file.cost = null;
        }
        cost.ms = performance.now() - start;
        return { ...(await describe()), ...cost };
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
    openUrl,
    compileFilter,
    base64ToBytes,
    JazminError,
    JazminFormatError,
    JazminKeyError,
    JazminUnlockRequiredError,
  };
})(globalThis);
