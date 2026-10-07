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
  async function verifySignature(publicKey, message, signature) {
    const key = await subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message);
  }

  // ---- keys ---------------------------------------------------------------------------------------

  // A master (owner) key controls the whole of a shared file: in a page it could be stolen, so browsers never take one.
  const MASTER_KEY_REFUSED = "A master key can't be used in a browser for a shared file: it controls the whole file, and a page could leak it. "
    + "Open the file with an access key. To see everything, the owner can create a full-read access key "
    + "(grantAccess(file, ownerKey, key, { rows: '*', columns: '*' }) in the library).";

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

  /** Key text ("jzk1-...") of 32 key bytes. */
  async function keyText(bytes) {
    return `jzk1-${bytesToBase64Url(concat(bytes, await checksum(bytes)))}`;
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

    /**
     * Unsigned varint: read with numbers when it has at most 7 bytes (49 bits, exact as a double), as the library
     * reads it, else as a BigInt. BigInt arithmetic for every value made decoding several times slower.
     */
    numberVarUint() {
      const start = this.pos;
      let result = 0;
      let multiplier = 1;
      for (let count = 0; ; count++) {
        if (count === 10) throw new JazminFormatError('Varint too long');
        const b = this.byte();
        result += (b & 0x7f) * multiplier;
        multiplier *= 128;
        if (!(b & 0x80)) {
          if (count < 7) return result;
          this.pos = start;
          return this.bigVarUint();
        }
      }
    }

    /** Unsigned varint that must fit a safe integer (lengths, counts, offsets). */
    varUint() {
      const v = this.numberVarUint();
      if (typeof v === 'number') return v;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new JazminFormatError('Value out of range');
      return Number(v);
    }

    /** Zigzag varint: a Number when it is safe, else a BigInt (as the library returns). */
    varInt() {
      const z = this.numberVarUint();
      if (typeof z === 'number') return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
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

  /** As the library's parseJsonText: uniqueNames for the JSON the reader uses itself (spec 2). */
  function parseJson(textValue, what, uniqueNames = false) {
    let value;
    try {
      value = JSON.parse(textValue);
    } catch {
      throw new JazminFormatError(`${what} is not valid JSON`);
    }
    if (uniqueNames && repeatsName(textValue)) throw new JazminFormatError(`${what} is not valid JSON: a name appears twice in one object`);
    return value;
  }

  /** Whether valid JSON text repeats a name in one object, comparing names with their escapes decoded. */
  function repeatsName(text) {
    const open = []; // per open object: the names seen in it; null for an open array
    let name = false; // the next string is a name
    let slash = text.indexOf('\\'); // the next backslash: there are none in most strings
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34) { // '"': a string, which ends at the first quote unless a backslash comes before it
        let end = text.indexOf('"', i + 1);
        const escaped = slash !== -1 && slash < end;
        if (escaped) for (end = i + 1; text.charCodeAt(end) !== 34; end++) if (text.charCodeAt(end) === 92) end++;
        if (name) {
          const names = open[open.length - 1];
          const key = escaped ? JSON.parse(text.slice(i, end + 1)) : text.slice(i + 1, end);
          if (names.has(key)) return true;
          names.add(key);
          name = false;
        }
        i = end;
        if (escaped) slash = text.indexOf('\\', end);
      } else if (c === 123) { // '{'
        open.push(new Set());
        name = true;
      } else if (c === 91) open.push(null); // '['
      else if (c === 125 || c === 93) open.pop(); // '}' ']'
      else if (c === 44) name = open[open.length - 1] !== null; // ','
    }
    return false;
  }

  function dateFromMs(ms) {
    return new Date(msFromFile(ms));
  }

  /** A datetime read from a file, as milliseconds since 1970, checked as dateFromMs() does. */
  function msFromFile(ms) {
    const n = Number(ms);
    if (!(Math.abs(n) <= 8.64e15)) throw new JazminFormatError('A datetime value is out of range');
    return n;
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
      else if (f === 6) c.attributes = parseJson(text(v), 'Column attributes', true);
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
   * skips column j (left undefined) without decoding it. With `datesAsMs`, datetimes are milliseconds since 1970
   * instead of Date objects (for column arrays: no object per value).
   */
  function decodeColumnar(raw, types, rowCount, ordinal, wanted, datesAsMs = false) {
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
          if (datesAsMs && type === 'datetime') for (let i = 0; i < count; i++) values[i] = msFromFile(r.varInt());
          else for (let i = 0; i < count; i++) values[i] = readPlain(r, type);
          break;
        case ENCODING.delta: {
          // Numbers while the running sum stays exact; BigInt beyond ±2^53 (as the library's decoder).
          let prev = 0;
          for (let i = 0; i < count; i++) {
            const d = r.varInt();
            let v;
            if (typeof prev === 'number' && typeof d === 'number' && Number.isSafeInteger(prev + d)) v = prev + d;
            else {
              const big = BigInt(prev) + BigInt(d);
              v = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
            }
            prev = v;
            values[i] = type !== 'datetime' ? v : datesAsMs ? msFromFile(v) : dateFromMs(v);
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

  /** As setField in the library's schema.js: a column named `__proto__` becomes a field, not the prototype (#68). */
  function setField(target, name, value) {
    if (name === '__proto__') Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
    else target[name] = value;
  }

  /**
   * As columnCollector in the library's reader.js: one column's values for columnArrays(). add(column, from, to) takes
   * a decoded column's rows from..to-1 in one loop.
   */
  function columnCollector({ name, type }) {
    const PIECE = 8192; // values per piece: pieces are joined once, at the end
    const Typed = type === 'int' || type === 'float' || type === 'datetime' ? Float64Array : type === 'bool' ? Uint8Array : null;
    if (!Typed) {
      const values = [];
      return {
        add(column, from, to) {
          for (let r = from; r < to; r++) values.push(column[r]);
        },
        finish: () => ({ values }),
      };
    }
    const pieces = [];
    let piece = new Typed(PIECE);
    let used = 0;
    let count = 0;
    const nullRows = [];
    return {
      add(column, from, to) {
        for (let r = from; r < to; r++) {
          if (used === PIECE) {
            pieces.push(piece);
            piece = new Typed(PIECE);
            used = 0;
          }
          const v = column[r];
          if (v === null || v === undefined) {
            nullRows.push(count);
            piece[used] = Typed === Float64Array ? NaN : 0;
          } else if (type === 'datetime') piece[used] = typeof v === 'number' ? v : v.getTime();
          else if (type === 'bool') piece[used] = v ? 1 : 0;
          else if (typeof v === 'bigint') throw new JazminError(`Column '${name}' holds ${v}, beyond ±2^53: a Float64Array cannot hold it exactly (use find())`);
          else piece[used] = v;
          used++;
          count++;
        }
      },
      finish() {
        const values = new Typed(count);
        let at = 0;
        for (const p of pieces) {
          values.set(p, at);
          at += p.length;
        }
        values.set(piece.subarray(0, used), at);
        if (!nullRows.length) return { values };
        const nulls = new Uint8Array((count + 7) >> 3);
        for (const r of nullRows) nulls[r >> 3] |= 1 << (r & 7);
        return { values, nulls };
      },
    };
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
      if (key.kind === 'owner') throw Object.assign(new JazminKeyError(MASTER_KEY_REFUSED), { masterKeyRefused: true });
      if (!trailer.keySlots.length || !trailer.signature.length) throw new JazminFormatError('Key-slot or signature section is missing');
      const slotsSection = await read(trailer.keySlots.offset, trailer.keySlots.length);
      const signature = await plainSection(await read(trailer.signature.offset, trailer.signature.length), 'signature');
      if (signature.length !== 65 + 64) throw new JazminFormatError('Signature section has the wrong length');
      const owner = signature.subarray(0, 65);
      if (!equal((await sha256(owner)).subarray(0, 8), key.fingerprint)) throw new JazminKeyError('This file was not signed by the owner of this key');
      const message = concat(utf8.encode('JAZMIN/1/signature'), fileId, await sha256(slotsSection), await sha256(headerSection));
      if (!(await verifySignature(owner, message, signature.subarray(65)))) throw new JazminFormatError("The file's owner signature is invalid - the file was modified");
      const secret = key.secret;
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
        bundle = parseJson(fromUtf8.decode(await decrypt(kek, slot.sealed, concat(fileId, id))), 'A key slot', true);
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
        // The key of what this key's holder sends back to the owner (spec 7.8); files written before it have none.
        submission: typeof bundle.submission === 'string' ? await keyText(b(bundle.submission)) : null,
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
      metadata: header.metadata ? parseJson(header.metadata, 'Metadata', true) : {},
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
     * A chunk's columns: `values` by column position (null where not decoded) and the positions decoded. `wanted` (by
     * column position) limits the columns decoded; a column group none of whose columns is wanted is not read.
     * `datesAsMs` gives datetimes as milliseconds instead of Date objects.
     */
    async function chunkColumns(chunk, wanted = null, datesAsMs = false) {
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
        const cols = decodeColumnar(raw, group.cols.map((c) => columns[c].type), chunk.rowCount, chunk.ordinal, groupWanted, datesAsMs);
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
      return { values, decodedCols };
    }

    /**
     * A chunk's rows as objects, by position in the chunk (rows deleted by appends are null). `wanted` (by column
     * position) limits the columns decoded; a column group none of whose columns is wanted is not read.
     */
    async function chunkRows(chunk, wanted = null) {
      const { values, decodedCols } = await chunkColumns(chunk, wanted);
      const rows = new Array(chunk.rowCount);
      for (let r = 0; r < chunk.rowCount; r++) {
        if (deletedSet.has(chunk.rowStart + r)) {
          rows[r] = null;
          continue;
        }
        const row = {};
        for (const i of decodedCols) setField(row, columns[i].name, values[i][r]);
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
    /**
     * Rows matching a filter. With `sink`, no rows are yielded: sink(values, from, to) is called instead for rows
     * from..to-1 of a chunk, with its decoded columns by position, which is all columnArrays() needs. Without a filter,
     * no row object is built at all, unbroken runs of rows go to the sink together, and dates are milliseconds.
     */
    async function* matches(filter, { offset = 0, limit = Infinity, select } = {}, sink = null) {
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
        if (sink && !match) {
          const { values } = await chunkColumns(chunk, wanted, true);
          let runFrom = -1;
          let runTo = -1;
          const count = rowIds === null ? chunk.rowCount : to - from;
          for (let k = 0; k < count && yielded < limit; k++) {
            const r = rowIds === null ? k : rowIds[from + k] - chunk.rowStart;
            if (deletedSet.has(chunk.rowStart + r)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            yielded++;
            if (r !== runTo) {
              if (runFrom >= 0) sink(values, runFrom, runTo);
              runFrom = r;
            }
            runTo = r + 1;
          }
          if (runFrom >= 0) sink(values, runFrom, runTo);
          continue;
        }
        if (sink) {
          // A filter: it reads each row as an object, but the values go to the sink from the columns.
          const { values, decodedCols } = await chunkColumns(chunk, wanted);
          const count = rowIds === null ? chunk.rowCount : to - from;
          for (let k = 0; k < count && yielded < limit; k++) {
            const r = rowIds === null ? k : rowIds[from + k] - chunk.rowStart;
            if (deletedSet.has(chunk.rowStart + r)) continue;
            const row = {};
            for (const i of decodedCols) setField(row, columns[i].name, values[i][r]);
            if (!match(row)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            yielded++;
            sink(values, r, r + 1);
          }
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
          const directory = checkFileDirectory(parseJson(fromUtf8.decode(await file.section(dir.section, sectionId, key, { requireDigest })), 'An embedded-file directory', true));
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
      /** When the file was last written (its last append, or when it was created), by the writer's clock. */
      writtenAt: new Date(header.modified || header.created),
      access: access ? { isOwner: access.isOwner, online: access.online, expires: access.expires, partitionBy: table.partitionBy || null } : null,
      /**
       * The submission key (spec 7.8), as key text: lock the files you send back to the owner with it, for example
       * with JazminBrowser.write(rows, { columns, key: reader.submissionKey }). Null for files written before
       * submission keys existed, until the owner's next rewrite.
       */
      submissionKey: access?.submission ?? null,
      package: header.files?.package ? parseJson(header.files.package, 'Package settings', true) : undefined,
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
       * Column values as arrays, for charts and totals, as the library's columnArrays(): { rowCount, values, nulls }.
       * Numbers and dates (milliseconds) in a Float64Array, bools in a Uint8Array (1 = true), other types in plain
       * arrays. Null rows of typed arrays hold NaN (0 for bools), with their bit (i & 7 of byte i >> 3) set in
       * nulls[column]. Far less memory than an object per row: 200,000 rows of a date and an amount take 3.2 MB.
       */
      async columnArrays(filter, { select, offset, limit } = {}) {
        const names = select ?? visibleColumns.map((c) => c.name);
        const collectors = names.map((name) => columnCollector(visibleColumns.find((c) => c.name === name) ?? { name }));
        const positions = names.map((name) => columns.findIndex((c) => c?.name === name));
        let rowCount = 0;
        // Values go from the decoded columns straight into the arrays: no object per row.
        const sink = (values, from, to) => {
          for (let i = 0; i < positions.length; i++) collectors[i].add(values[positions[i]], from, to);
          rowCount += to - from;
        };
        for await (const _ of matches(filter, { select: names, offset, limit }, sink)); // eslint-disable-line no-unused-vars
        const values = {};
        const nulls = {};
        names.forEach((name, i) => {
          const column = collectors[i].finish();
          setField(values, name, column.values);
          if (column.nulls) setField(nulls, name, column.nulls);
        });
        return { rowCount, values, nulls };
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

  // ---- writing: files with one key, a password or no key ------------------------------------------------------
  // The library's writer (js/src/writer.js and the modules it uses) for this subset, on the browser's own crypto
  // (WebCrypto) and compression (CompressionStream). Shared files are never written in a browser: their master key
  // must stay off web pages (docs/design/browser-writer.md). CI checks this writer writes the same bytes as the
  // library for the same rows, options and random bytes.

  const MAGIC = utf8.encode('JZM1');
  const WRITE_DEFAULTS = { chunkRows: 4096, chunkBytes: 1024 * 1024, codec: 'deflate', kdfIterations: 600000 };
  const WRITE_OPTIONS = new Set(['columns', 'metadata', 'codec', 'chunkRows', 'chunkBytes', 'key', 'password', 'kdfIterations', 'now', 'files']);
  const NOT_IN_BROWSERS = {
    access: "Shared (access-controlled) files are written only by the owner's own service: their master key must stay off web pages",
    tables: 'Several tables are not written in browsers yet',
    package: 'Viewer package settings are not written in browsers yet',
    sortedBy: 'sortedBy is not written in browsers yet',
    level: "Browsers compress at one level: leave out 'level'",
  };
  const TYPE_IDS = new Map(TYPE_NAMES.map((name, i) => [name, i]));
  const WRITE_TYPES = TYPE_NAMES.slice(1);
  const INT64_MIN = -(2n ** 63n);
  const INT64_MAX = 2n ** 63n - 1n;
  const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
  const MAX_WRITE_SCALE = 15;
  const MAX_STRING_STAT = 64;
  const TINY_SECTION = 256; // raw bytes below which catalog sections are stored uncompressed
  const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;
  const FILE_BLOCK_SIZE = 256 * 1024; // raw bytes per stored block of an embedded file, as the library writes
  const MIME = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.zip': 'application/zip',
  };

  class JazminValidationError extends JazminError {
    constructor(message) {
      super(message);
      this.name = 'JazminValidationError';
    }
  }

  /** Secure random bytes: the browser's generator, never anything weaker. */
  function randomBytes(n) {
    if (typeof global.crypto?.getRandomValues !== 'function') throw new JazminError('This browser has no secure random generator (crypto.getRandomValues)');
    return global.crypto.getRandomValues(new Uint8Array(n));
  }

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return global.btoa(bin);
  }

  /** A file to store (the library's fileSource): { path, content: Blob | File | Uint8Array | ArrayBuffer | string, type?, groups? }. */
  async function fileInput(entry) {
    if (entry === null || typeof entry !== 'object') throw new JazminValidationError('Each file must be an object { path, content }');
    const p = entry.path;
    if (typeof p !== 'string' || p.length === 0 || p.length > 1024) throw new JazminValidationError('A file path must be a string of 1 to 1024 characters');
    if (p.includes('\\') || p.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new JazminValidationError(`Invalid file path '${p}': use relative paths with '/' and no empty, '.' or '..' segments`);
    }
    const dot = p.lastIndexOf('.');
    const type = entry.type === undefined ? (dot > p.lastIndexOf('/') + 1 && MIME[p.slice(dot).toLowerCase()]) || 'application/octet-stream' : String(entry.type);
    let groups = ['*'];
    if (entry.groups !== undefined && entry.groups !== '*') {
      if (!Array.isArray(entry.groups) || entry.groups.length === 0) throw new JazminValidationError(`File '${p}': groups must be '*' or a non-empty array`);
      const names = [...new Set(entry.groups.map((g) => String(g)))];
      for (const g of names) if (g.length === 0 || g.length > 256) throw new JazminValidationError(`File '${p}': invalid group name '${g}'`);
      groups = names.includes('*') ? ['*'] : names.sort();
    }
    if (entry.file !== undefined) throw new JazminValidationError(`File '${p}': browsers have no file paths - pass the File or Blob as content`);
    const c = entry.content;
    const bytes = typeof c === 'string' ? utf8.encode(c)
      : c instanceof Uint8Array ? c
        : ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength)
          : c instanceof ArrayBuffer ? new Uint8Array(c)
            : typeof Blob !== 'undefined' && c instanceof Blob ? new Uint8Array(await c.arrayBuffer())
              : null;
    if (!bytes) throw new JazminValidationError(`File '${p}': content must be a Blob, File, Uint8Array, ArrayBuffer or string`);
    if (!subtle) throw new JazminError("Embedded files need the browser's built-in cryptography (crypto.subtle), which pages on plain http:// don't have");
    return { path: p, type, groups, bytes, sha256: toHex(await sha256(bytes)) };
  }

  /** A growable byte buffer: the library's ByteWriter. */
  class ByteWriter {
    constructor(size = 1024) {
      this.buf = new Uint8Array(size);
      this.length = 0;
    }

    ensure(extra) {
      const needed = this.length + extra;
      if (needed <= this.buf.length) return;
      let size = Math.max(this.buf.length * 2, 64);
      while (size < needed) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }

    byte(v) {
      this.ensure(1);
      this.buf[this.length++] = v;
    }

    bytes(src) {
      this.ensure(src.length);
      this.buf.set(src, this.length);
      this.length += src.length;
    }

    float64(v) {
      this.ensure(8);
      new DataView(this.buf.buffer).setFloat64(this.length, v, true);
      this.length += 8;
    }

    /** Unsigned LEB128 varint: a non-negative safe integer or BigInt. */
    varUint(value) {
      if (typeof value === 'bigint') {
        this.ensure(Math.ceil(value.toString(2).length / 7));
        while (value >= 0x80n) {
          this.buf[this.length++] = Number(value & 0x7fn) | 0x80;
          value >>= 7n;
        }
        this.buf[this.length++] = Number(value);
        return;
      }
      this.ensure(10);
      while (value >= 0x80) {
        this.buf[this.length++] = (value % 128) | 0x80;
        value = Math.floor(value / 128);
      }
      this.buf[this.length++] = value;
    }

    /** Signed varint (ZigZag, 64-bit range). */
    varInt(value) {
      if (typeof value === 'number' && Math.abs(value) < 2 ** 52) {
        this.varUint(value >= 0 ? value * 2 : -value * 2 - 1);
        return;
      }
      const big = BigInt(value);
      this.varUint(big >= 0n ? big << 1n : ((-big) << 1n) - 1n);
    }

    string(value) {
      const bytes = utf8.encode(value);
      this.varUint(bytes.length);
      this.bytes(bytes);
    }

    blob(value) {
      this.varUint(value.length);
      this.bytes(value);
    }

    result() {
      return this.buf.slice(0, this.length);
    }
  }

  /** One Protocol Buffers message (spec 6), as the library's ProtoWriter: fields holding their default are left out. */
  class ProtoWriter {
    constructor() {
      this.w = new ByteWriter(256);
    }

    tag(field, wire) {
      this.w.varUint(field * 8 + wire);
    }

    uint(field, value) {
      if (!value) return this;
      this.tag(field, 0);
      this.w.varUint(typeof value === 'boolean' ? 1 : value);
      return this;
    }

    int64(field, value) {
      if (!value) return this;
      this.tag(field, 0);
      this.w.varUint(value < 0 ? BigInt.asUintN(64, BigInt(value)) : value);
      return this;
    }

    bytes(field, value) {
      if (!value || value.length === 0) return this;
      return this.always(field, value);
    }

    string(field, value) {
      return value ? this.bytes(field, utf8.encode(value)) : this;
    }

    always(field, value) {
      const bytes = value instanceof ProtoWriter ? value.result() : value;
      this.tag(field, 2);
      this.w.varUint(bytes.length);
      this.w.bytes(bytes);
      return this;
    }

    message(field, build, always = false) {
      if (build === undefined || build === null) return this;
      const inner = new ProtoWriter();
      build(inner);
      if (inner.w.length === 0 && !always) return this;
      return this.always(field, inner);
    }

    packed(field, values) {
      if (!values || values.length === 0) return this;
      const inner = new ByteWriter(values.length * 2 + 8);
      for (const v of values) inner.varUint(v);
      this.tag(field, 2);
      this.w.varUint(inner.length);
      this.w.bytes(inner.result());
      return this;
    }

    result() {
      return this.w.result();
    }
  }

  // -- values (the library's types.js and decimal.js) --

  const validation = (column, message) => new JazminValidationError(`Column '${column}': ${message}`);
  const normalizeBigInt = (v) => (v >= -MAX_SAFE_BIG && v <= MAX_SAFE_BIG ? Number(v) : v);

  function parseDecimalText(value, column) {
    const t = typeof value === 'number' ? String(value) : value;
    const match = typeof t === 'string' ? DECIMAL_TEXT.exec(t) : null;
    if (!match) throw validation(column, `expected a decimal string like '-12.50', got '${value}'`);
    const [, sign, whole, fraction = ''] = match;
    if (fraction.length > 255) throw validation(column, 'more than 255 digits after the point');
    const digits = (whole + fraction).replace(/^0+(?=\d)/, '');
    if (digits.length > 256) throw validation(column, 'more than 256 significant digits');
    const m = BigInt(digits);
    return { m: sign && m !== 0n ? -m : m, s: fraction.length };
  }

  /** A decimal's key form: trailing zeros removed, compared numerically (12.5 and 12.50 are equal). */
  function decimalKeyOf(text) {
    let { m, s } = parseDecimalText(text, 'decimal');
    while (s > 0 && m % 10n === 0n) {
      m /= 10n;
      s--;
    }
    return { m, s };
  }

  function compareDecimalKeys(a, b) {
    const x = a.s < b.s ? a.m * 10n ** BigInt(b.s - a.s) : a.m;
    const y = b.s < a.s ? b.m * 10n ** BigInt(a.s - b.s) : b.m;
    return x < y ? -1 : x > y ? 1 : 0;
  }

  /** A decimal (text, or key form { m, s }): varint scale, then the integer as a zigzag varint (spec 5.1). */
  function writeDecimal(w, value) {
    const { m, s } = typeof value === 'string' ? parseDecimalText(value, 'decimal') : value;
    w.varUint(s);
    w.varUint(m >= 0n ? m << 1n : ((-m) << 1n) - 1n);
  }

  function dateMs(value, column) {
    let ms;
    if (value instanceof Date) ms = value.getTime();
    else if (typeof value === 'string') ms = Date.parse(value);
    else if (typeof value === 'number' && Number.isInteger(value)) ms = value;
    else throw validation(column, 'expected a Date, ISO-8601 string or epoch milliseconds');
    if (!Number.isFinite(ms)) throw validation(column, `invalid date '${value}'`);
    return ms;
  }

  /** A value in its stored form: datetime as milliseconds, decimals as canonical text, ints as numbers or BigInts. */
  function normalizeWriteValue(type, value, column) {
    if (value === null || value === undefined) return null;
    switch (type) {
      case 'bool':
        if (typeof value !== 'boolean') throw validation(column, `expected a boolean, got ${typeof value}`);
        return value;
      case 'int': {
        let v = value;
        if (typeof v === 'number') {
          if (!Number.isInteger(v)) throw validation(column, `expected an integer, got ${v}`);
          if (Number.isSafeInteger(v)) return v;
          v = BigInt(v);
        }
        if (typeof v !== 'bigint') throw validation(column, `expected an integer, got ${typeof value}`);
        if (v < INT64_MIN || v > INT64_MAX) throw validation(column, 'integer is outside the 64-bit range');
        return normalizeBigInt(v);
      }
      case 'float':
        if (typeof value !== 'number') throw validation(column, `expected a number, got ${typeof value}`);
        return value;
      case 'decimal': {
        const { m, s } = parseDecimalText(value, column);
        return formatDecimal(m, s);
      }
      case 'string':
        if (typeof value !== 'string') throw validation(column, `expected a string, got ${typeof value}`);
        return value;
      case 'datetime':
        return dateMs(value, column);
      case 'binary':
        if (!(value instanceof Uint8Array)) throw validation(column, 'expected a Uint8Array');
        return value;
      case 'json':
        if (JSON.stringify(value) === undefined) throw validation(column, 'value is not JSON-serialisable');
        return value;
      default:
        throw validation(column, `unknown type '${type}'`);
    }
  }

  /** Approximate stored size of a value, to cap chunks at chunkBytes (as the library). */
  function estimateSize(type, v) {
    if (v === null) return 0;
    switch (type) {
      case 'decimal':
      case 'string':
      case 'json': return v.length + 1;
      case 'binary': return v.length + 2;
      case 'float': return 8;
      case 'bool': return 1;
      default: return 5;
    }
  }

  // -- columnar chunks (the library's encodeColumnar) --

  function varIntSize(v) {
    if (typeof v === 'bigint') {
      let z = v >= 0n ? v << 1n : ((-v) << 1n) - 1n;
      let n = 1;
      while (z >= 0x80n) {
        z >>= 7n;
        n++;
      }
      return n;
    }
    let z = v >= 0 ? v * 2 : -v * 2 - 1;
    let n = 1;
    while (z >= 0x80) {
      z = Math.floor(z / 128);
      n++;
    }
    return n;
  }

  const subtract = (a, b) => (typeof a === 'number' && typeof b === 'number' && Number.isSafeInteger(a - b) ? a - b : BigInt(a) - BigInt(b));

  function scaleOf(v) {
    if (Object.is(v, -0)) return -1;
    for (let s = 0; s <= MAX_WRITE_SCALE; s++) {
      const m = Math.round(v * POW10[s]);
      if (!Number.isSafeInteger(m)) return -1;
      if (Object.is(m / POW10[s], v)) return s;
    }
    return -1;
  }

  function writePlainValues(w, type, values) {
    for (const v of values) {
      switch (type) {
        case 'bool': w.byte(v ? 1 : 0); break;
        case 'int':
        case 'datetime': w.varInt(v); break;
        case 'float': w.float64(v); break;
        case 'binary': w.blob(v); break;
        case 'decimal': writeDecimal(w, v); break;
        default: w.string(v); // string, and json (already stringified)
      }
    }
  }

  /** Chooses one column's encoding for its non-null values and writes them (spec 5.4). */
  function writeColumnBody(w, type, values) {
    switch (type) {
      case 'bool': {
        const bits = new Uint8Array((values.length + 7) >> 3);
        values.forEach((v, i) => {
          if (v) bits[i >> 3] |= 1 << (i & 7);
        });
        w.bytes(bits);
        return ENCODING.bitmap;
      }
      case 'int':
      case 'datetime': {
        if (values.length > 1) {
          let plain = 0;
          let delta = varIntSize(values[0]);
          const deltas = [];
          let fits = true;
          for (let i = 0; i < values.length; i++) {
            plain += varIntSize(values[i]);
            if (i === 0) continue;
            const d = subtract(values[i], values[i - 1]);
            if (typeof d === 'bigint' && (d < INT64_MIN || d > INT64_MAX)) {
              fits = false;
              break;
            }
            deltas.push(typeof d === 'bigint' ? normalizeBigInt(d) : d);
            delta += varIntSize(d);
          }
          if (fits && delta < plain) {
            w.varInt(values[0]);
            for (const d of deltas) w.varInt(d);
            return ENCODING.delta;
          }
        }
        writePlainValues(w, type, values);
        return ENCODING.plain;
      }
      case 'float': {
        const scales = values.map(scaleOf);
        let scaledSize = 0;
        for (let i = 0; i < values.length; i++) scaledSize += scales[i] < 0 ? 9 : 1 + varIntSize(Math.round(values[i] * POW10[scales[i]]));
        if (scaledSize < values.length * 8) {
          for (let i = 0; i < values.length; i++) {
            if (scales[i] < 0) {
              w.byte(255);
              w.float64(values[i]);
            } else {
              w.byte(scales[i]);
              w.varInt(Math.round(values[i] * POW10[scales[i]]));
            }
          }
          return ENCODING.scaled;
        }
        writePlainValues(w, type, values);
        return ENCODING.plain;
      }
      case 'decimal':
      case 'string': {
        const ids = new Map();
        for (const v of values) if (!ids.has(v)) ids.set(v, ids.size);
        if (values.length > 0 && ids.size * 2 <= values.length) {
          w.varUint(ids.size);
          for (const v of ids.keys()) {
            if (type === 'decimal') writeDecimal(w, v);
            else w.string(v);
          }
          for (const v of values) w.varUint(ids.get(v));
          return ENCODING.dictionary;
        }
        writePlainValues(w, type, values);
        return ENCODING.plain;
      }
      default:
        writePlainValues(w, type, values);
        return ENCODING.plain;
    }
  }

  /** One chunk's payload in the columnar layout: `columnValues[j]` holds column j's `rowCount` stored values. */
  function encodeColumnar(types, columnValues, rowCount) {
    const out = new ByteWriter(64 * 1024);
    for (let j = 0; j < types.length; j++) {
      const all = columnValues[j];
      let nulls = null;
      const values = [];
      for (let r = 0; r < rowCount; r++) {
        if (all[r] === null) {
          nulls ??= new Uint8Array((rowCount + 7) >> 3);
          nulls[r >> 3] |= 1 << (r & 7);
        } else {
          values.push(all[r]);
        }
      }
      const body = new ByteWriter(1024);
      const encoding = writeColumnBody(body, types[j], values);
      const stream = body.result();
      out.varUint(1 + (nulls ? nulls.length : 0) + stream.length);
      out.byte(encoding | (nulls ? HAS_NULLS : 0));
      if (nulls) out.bytes(nulls);
      out.bytes(stream);
    }
    return out.result();
  }

  // -- statistics (the library's stats.js) --

  /** Key-form bytes of a bound (spec 6.5): the value encoding, except strings, which are bare UTF-8. */
  function encodeBound(type, key) {
    if (type === 'string') return utf8.encode(key);
    const w = new ByteWriter(16);
    switch (type) {
      case 'bool': w.byte(key ? 1 : 0); break;
      case 'int':
      case 'datetime': w.varInt(key); break;
      case 'float': w.float64(key); break;
      case 'decimal': writeDecimal(w, key); break;
      default: throw new JazminValidationError(`No bounds for type '${type}'`);
    }
    return w.result();
  }

  /** One chunk's null count and min/max for one column (spec 6.4). */
  class ColumnStats {
    constructor(type) {
      this.type = type;
      this.nulls = 0;
      this.min = undefined;
      this.max = undefined;
    }

    add(value) {
      if (value === null) {
        this.nulls++;
        return;
      }
      const type = this.type;
      if (type === 'bool' || type === 'int' || type === 'float' || type === 'string' || type === 'datetime') {
        const key = value === 0 ? 0 : value; // fold -0 into 0
        if (key !== key) return; // NaN
        if (this.min === undefined) this.min = this.max = key;
        else if (key < this.min) this.min = key;
        else if (key > this.max) this.max = key;
        return;
      }
      if (type !== 'decimal') return; // binary and json are not ordered
      const key = decimalKeyOf(value);
      if (this.min === undefined || compareDecimalKeys(key, this.min) < 0) this.min = key;
      if (this.max === undefined || compareDecimalKeys(key, this.max) > 0) this.max = key;
    }

    bounds() {
      const none = new Uint8Array(0);
      if (this.min === undefined) return { min: none, max: none };
      if (this.type === 'float' && (!Number.isFinite(this.min) || !Number.isFinite(this.max))) return { min: none, max: none };
      if (this.type === 'string') {
        // A prefix is still a lower bound; a cut max would not be an upper bound.
        let min = this.min;
        if (min.length > MAX_STRING_STAT) {
          let end = MAX_STRING_STAT;
          const code = min.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff) end--;
          min = min.substring(0, end);
        }
        return { min: utf8.encode(min), max: this.max.length > MAX_STRING_STAT ? none : utf8.encode(this.max) };
      }
      return { min: encodeBound(this.type, this.min), max: encodeBound(this.type, this.max) };
    }
  }

  // -- catalog (the library's catalog.js) --

  function differences(values) {
    let previous = 0;
    return values.map((v) => {
      const d = v - previous;
      previous = v;
      return d;
    });
  }

  const writeRef = (ref) => (w) => w.uint(1, ref.offset).uint(2, ref.length);

  function writeColumnDefinition(c) {
    return (w) => {
      w.uint(1, c.position).string(2, c.name).uint(3, TYPE_IDS.get(c.type)).uint(4, c.required ? 1 : 0)
        .string(5, c.description).string(6, c.attributes);
    };
  }

  function encodeStatisticsBlock(columns) {
    const w = new ProtoWriter();
    for (const c of columns) {
      w.message(1, (cw) => {
        cw.packed(1, c.nullCounts);
        for (const b of c.min) cw.always(2, b);
        for (const b of c.max) cw.always(3, b);
      }, true);
    }
    return w.result();
  }

  function encodeDirectory(chunks, statistics) {
    const w = new ProtoWriter();
    w.packed(1, differences(chunks.map((c) => c.ordinal)));
    w.packed(2, differences(chunks.map((c) => c.rowStart)));
    w.packed(3, chunks.map((c) => c.rowCount));
    w.packed(4, differences(chunks.map((c) => c.offset)));
    w.packed(5, chunks.map((c) => c.length));
    for (const s of statistics) w.message(7, (sw) => sw.packed(1, s.columns).message(2, writeRef(s.section)), true);
    return w.result();
  }

  function encodeFileHeader({ created, metadata, table, keyring, files }) {
    const w = new ProtoWriter();
    w.int64(3, created).string(6, metadata);
    w.message(7, (tw) => {
      tw.string(1, table.name).uint(2, table.columns.length);
      tw.message(3, (gw) => {
        gw.string(1, '*');
        for (const c of table.columns) gw.message(2, writeColumnDefinition(c), true);
      }, true);
      tw.uint(6, table.rowCount).uint(8, table.chunkCount);
      for (const p of table.partitions) {
        tw.message(9, (pw) => {
          for (const s of p.segments) pw.message(2, writeRef(s), true);
        }, true);
      }
    }, true);
    if (keyring) w.message(8, (k) => k.bytes(1, keyring.data).bytes(2, keyring.index).bytes(3, keyring.files));
    if (files) {
      w.message(9, (fw) => {
        for (const d of files.directories) fw.message(1, (dw) => dw.string(1, d.group).message(2, writeRef(d.section)), true);
        fw.uint(2, files.nextContent);
      }, true);
    }
    return w.result();
  }

  // -- sections --

  async function deflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** AES-256-GCM with a fresh random nonce: nonce || ciphertext || tag, as the library writes. */
  async function encrypt(keyBytes, plaintext, aad) {
    const nonce = randomBytes(12);
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
    return concat(nonce, sealed);
  }

  /** Normalized column definitions (the library's normalizeColumns), refusing indexes. */
  function writerColumns(columns) {
    if (!Array.isArray(columns) || columns.length === 0) throw new JazminValidationError('At least one column is required');
    const seen = new Set();
    return columns.map((c) => {
      if (!c || typeof c.name !== 'string' || c.name.length === 0) throw new JazminValidationError('Every column needs a non-empty name');
      if (seen.has(c.name)) throw new JazminValidationError(`Duplicate column '${c.name}'`);
      seen.add(c.name);
      if (!WRITE_TYPES.includes(c.type)) throw new JazminValidationError(`Column '${c.name}' has unknown type '${c.type}'`);
      if (c.index !== undefined && [].concat(c.index).length) {
        throw new JazminValidationError(`Column '${c.name}': indexes are not written in browsers (the owner's service adds them when it compacts)`);
      }
      return {
        name: c.name, type: c.type, nullable: c.nullable !== false,
        description: c.description === undefined ? undefined : String(c.description),
        attributes: c.attributes === undefined ? undefined : JSON.stringify(c.attributes),
      };
    });
  }

  /**
   * Starts writing a file in the browser: one table, locked with a key ("jzk1-...", for example a submission key), a
   * password, or nothing. options: { columns, key | password, kdfIterations, metadata, codec: 'deflate' | 'none',
   * chunkRows, chunkBytes, now, files }. Rows go in with writeRows / writeRow and files with addFile (await each call);
   * finish() returns the file as a Blob. Shared (access-controlled) files, indexes, several tables, viewer package
   * settings and sortedBy are not written in browsers.
   */
  async function createWriter(options = {}) {
    if (options === null || typeof options !== 'object') throw new JazminValidationError('options must be an object');
    for (const name of Object.keys(options)) {
      if (NOT_IN_BROWSERS[name]) throw new JazminValidationError(NOT_IN_BROWSERS[name]);
      if (!WRITE_OPTIONS.has(name)) throw new JazminValidationError(`Unknown option '${name}'`);
    }
    const {
      metadata = {}, codec = WRITE_DEFAULTS.codec, chunkRows = WRITE_DEFAULTS.chunkRows, chunkBytes = WRITE_DEFAULTS.chunkBytes,
      key, password, kdfIterations = WRITE_DEFAULTS.kdfIterations, now,
    } = options;
    const columns = writerColumns(options.columns);
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new JazminValidationError('metadata must be a plain object');
    if (codec !== 'deflate' && codec !== 'none') {
      throw new JazminValidationError(codec === 'brotli' ? "Browsers can't compress with Brotli: use 'deflate'" : `Unknown codec '${codec}'`);
    }
    if (codec === 'deflate') {
      try {
        new CompressionStream('deflate-raw'); // eslint-disable-line no-new
      } catch {
        throw new JazminError("This browser can't compress (CompressionStream 'deflate-raw' needs Chrome 103, Firefox 113 or Safari 16.4): pass codec: 'none'");
      }
    }
    for (const [name, value] of [['chunkRows', chunkRows], ['chunkBytes', chunkBytes]]) {
      if (!Number.isInteger(value) || value < 1) throw new JazminValidationError(`${name} must be a positive integer`);
    }
    if (key && password) throw new JazminValidationError('Supply either key or password, not both');
    if (password !== undefined && (typeof password !== 'string' || password.length === 0)) throw new JazminValidationError('password must be a non-empty string');
    if (password && (!Number.isInteger(kdfIterations) || kdfIterations < MIN_KDF_ITERATIONS || kdfIterations > MAX_KDF_ITERATIONS)) {
      throw new JazminValidationError(`kdfIterations must be from ${MIN_KDF_ITERATIONS} to ${MAX_KDF_ITERATIONS}`);
    }
    const encrypted = Boolean(key || password);
    if (encrypted && !subtle) throw new JazminError("Encrypting needs the browser's built-in cryptography (crypto.subtle), which pages on plain http:// don't have");
    let keyBytes = null;
    if (key) {
      const parsed = await parseKey(typeof key === 'string' ? key : String(key));
      if (parsed.kind !== 'owner') throw new JazminKeyError("An access key can't write a file: lock what you send back with your submission key (reader.submissionKey, after opening the shared file)");
      keyBytes = parsed.bytes;
    }
    const created = now === undefined || now === null ? Date.now() : now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now;
    if (!Number.isFinite(created)) throw new JazminValidationError(`Invalid time '${now}'`);

    // Random bytes are drawn in the library's order: file id, salt, keyring, then one nonce per section.
    const fileId = randomBytes(16);
    const salt = encrypted ? randomBytes(32) : new Uint8Array(32);
    const master = password ? await pbkdf2(password, salt, kdfIterations) : keyBytes;
    const keyring = encrypted ? { data: randomBytes(32), index: randomBytes(32) } : null;
    const sectionKey = (sectionId, group = 'data') => (master ? hkdf(master, keyring[group], `JAZMIN/1/${sectionId}`) : null);

    const parts = [];
    let position = 0;
    const emit = (bytes) => {
      parts.push(bytes);
      position += bytes.length;
    };
    /** A section: 16-byte envelope, then the payload, compressed (when that helps) and encrypted (spec 5.3, 7). */
    const section = async (raw, sectionId, sectionKeyBytes, sectionCodec = codec) => {
      let codecId = sectionCodec === 'deflate' ? CODEC_DEFLATE : CODEC_NONE;
      let body = raw;
      if (codecId === CODEC_DEFLATE) {
        body = await deflateRaw(raw);
        if (body.length >= raw.length) {
          codecId = CODEC_NONE; // compression did not help: stored as is
          body = raw;
        }
      }
      const envelope = new Uint8Array(ENVELOPE);
      const v = view(envelope);
      envelope[0] = codecId;
      envelope[1] = sectionKeyBytes ? 1 : 0;
      v.setUint32(4, raw.length, true);
      if (sectionKeyBytes) body = await encrypt(sectionKeyBytes, body, concat(fileId, envelope.subarray(0, 8), utf8.encode(sectionId)));
      v.setUint32(8, body.length, true);
      v.setUint32(12, crc32(body), true);
      return concat(envelope, body);
    };
    /** A catalog section; tiny ones are stored uncompressed, as the library does. */
    const writeSection = async (raw, sectionId, group) => {
      const s = await section(raw, sectionId, await sectionKey(sectionId, group), raw.length < TINY_SECTION ? 'none' : codec);
      const ref = { offset: position, length: s.length };
      emit(s);
      return ref;
    };

    const preamble = new Uint8Array(PREAMBLE);
    preamble.set(MAGIC, 0);
    view(preamble).setUint16(4, (encrypted ? FLAG_ENCRYPTED : 0) | (password ? FLAG_PASSWORD : 0), true);
    preamble.set(fileId, 8);
    preamble.set(salt, 24);
    view(preamble).setUint32(56, password ? kdfIterations : 0, true);
    emit(preamble);

    const types = columns.map((c) => c.type);
    const names = new Set(columns.map((c) => c.name));
    const chunks = []; // { ordinal, rowStart, rowCount, offset, length, stats }
    let values = types.map(() => []);
    let stats = types.map((t) => new ColumnStats(t));
    let inChunk = 0;
    let chunkSize = 0;
    let rowCount = 0;
    let busy = false;
    let finished = false;

    // Embedded files (spec 6.8): path -> entry, and each distinct content stored once (by SHA-256).
    const fileEntries = new Map();
    const fileContents = new Map();
    const storeFile = async (entry) => {
      const src = await fileInput(entry);
      if (fileEntries.has(src.path)) throw new JazminValidationError(`File '${src.path}' is added twice`);
      let stored = fileContents.get(src.sha256);
      if (!stored) {
        const id = fileContents.size;
        const contentKey = encrypted ? randomBytes(32) : null; // one random key per stored content
        const blocks = [];
        for (let offset = 0, b = 0; offset < src.bytes.length; offset += FILE_BLOCK_SIZE, b++) {
          const sectionId = `file/${id}/${b}`;
          const s = await section(src.bytes.subarray(offset, offset + FILE_BLOCK_SIZE), sectionId, contentKey ? await hkdf(contentKey, salt, `JAZMIN/1/${sectionId}`) : null);
          blocks.push({ offset: position, length: s.length });
          emit(s);
        }
        stored = { id, size: src.bytes.length, sha256: src.sha256, blockSize: FILE_BLOCK_SIZE, ...(contentKey ? { key: bytesToBase64(contentKey) } : {}), blocks };
        fileContents.set(src.sha256, stored);
      }
      fileEntries.set(src.path, { path: src.path, type: src.type, groups: src.groups, content: stored.id });
    };
    if (options.files !== undefined && !Array.isArray(options.files)) throw new JazminValidationError('files must be an array');
    for (const f of options.files ?? []) await storeFile(f);

    const flushChunk = async () => {
      if (inChunk === 0) return;
      const ordinal = chunks.length;
      const sectionId = `0/chunk/${ordinal}/*`;
      const s = await section(encodeColumnar(types, values, inChunk), sectionId, await sectionKey(sectionId));
      chunks.push({ ordinal, rowStart: rowCount - inChunk, rowCount: inChunk, offset: position, length: s.length, stats });
      emit(s);
      values = types.map(() => []);
      stats = types.map((t) => new ColumnStats(t));
      inChunk = 0;
      chunkSize = 0;
    };

    const addRow = async (row) => {
      if (row === null || typeof row !== 'object') throw new JazminValidationError('Each row must be an object');
      for (const name in row) if (!names.has(name)) throw new JazminValidationError(`Row ${rowCount}: unknown column '${name}'`);
      const normalized = columns.map((c) => {
        const v = normalizeWriteValue(c.type, row[c.name], c.name);
        if (v === null && !c.nullable) throw new JazminValidationError(`Row ${rowCount}: column '${c.name}' is not nullable`);
        return v;
      });
      for (let i = 0; i < types.length; i++) {
        let v = normalized[i];
        if (v !== null && types[i] === 'json') v = JSON.stringify(v);
        values[i].push(v);
        chunkSize += estimateSize(types[i], v);
        stats[i].add(normalized[i]);
      }
      rowCount++;
      inChunk++;
      if (inChunk >= chunkRows || chunkSize >= chunkBytes) await flushChunk();
    };

    /** Runs one call at a time: each must be awaited before the next. */
    const step = async (work) => {
      if (finished) throw new JazminValidationError('Writer is already finished');
      if (busy) throw new JazminValidationError('Await the previous call before the next one');
      busy = true;
      try {
        return await work();
      } finally {
        busy = false;
      }
    };

    return {
      columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
      get rowCount() {
        return rowCount;
      },
      /** Adds one row. */
      writeRow: (row) => step(() => addRow(row)),
      /** Adds rows (any iterable, or an async one). */
      writeRows: (rows) => step(async () => {
        for await (const row of rows) await addRow(row);
      }),
      /**
       * Stores a file: addFile({ path, content, type, groups }) or addFile(path, content, { type, groups }). content is a
       * File, Blob, Uint8Array, ArrayBuffer or string; the type defaults from the path's extension. Identical content is
       * stored once; adding a path twice is an error.
       */
      addFile: (entryOrPath, content, fileOptions = {}) => step(() => storeFile(typeof entryOrPath === 'string' ? { ...fileOptions, path: entryOrPath, content } : entryOrPath)),
      /** Writes the statistics, directory, header and trailer; returns the file as a Blob. */
      finish: () => step(async () => {
        await flushChunk();
        const partitions = [];
        if (chunks.length) {
          // One statistics block per column (spec 6.4), then the chunk directory.
          const statistics = [];
          for (let col = 0; col < types.length; col++) {
            const bounds = chunks.map((c) => c.stats[col].bounds());
            const raw = encodeStatisticsBlock([{ nullCounts: chunks.map((c) => c.stats[col].nulls), min: bounds.map((b) => b.min), max: bounds.map((b) => b.max) }]);
            statistics.push({ columns: [col], section: await writeSection(raw, `0/stats/*/${col}`) });
          }
          partitions.push({ segments: [await writeSection(encodeDirectory(chunks, statistics), '0/dir/*')] });
        }
        const table = {
          name: '', rowCount, chunkCount: chunks.length, partitions,
          columns: columns.map((c, position) => ({ position, name: c.name, type: c.type, required: !c.nullable, description: c.description, attributes: c.attributes })),
        };
        let files = null;
        if (fileEntries.size) {
          // One directory: every file, with its groups, and the contents they use (the library's #writeFileDirectories).
          if (keyring) keyring.files = randomBytes(32);
          const entries = [...fileEntries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
          const byId = new Map([...fileContents.values()].map((c) => [c.id, c]));
          const directory = {
            files: entries.map((e) => ({ path: e.path, type: e.type, content: e.content, groups: e.groups })),
            contents: [...new Set(entries.map((e) => e.content))].sort((a, b) => a - b).map((id) => byId.get(id)),
          };
          files = { directories: [{ group: '*', section: await writeSection(utf8.encode(JSON.stringify(directory)), 'files/dir', 'files') }], nextContent: fileContents.size };
        }
        const headerKey = master ? await hkdf(master, salt, 'JAZMIN/1/header') : null;
        const header = await section(encodeFileHeader({ created, metadata: JSON.stringify(metadata), table, keyring, files }), 'header', headerKey);
        const headerOffset = position;
        emit(header);
        const trailer = new Uint8Array(TRAILER);
        const t = view(trailer);
        t.setBigUint64(0, BigInt(headerOffset), true);
        t.setUint32(8, header.length, true);
        t.setUint32(36, crc32(trailer.subarray(0, 36)), true);
        trailer.set(MAGIC, 40);
        emit(trailer);
        finished = true;
        return new Blob(parts, { type: 'application/octet-stream' });
      }),
    };
  }

  /** Writes rows into a new file in one call: createWriter(options), writeRows(rows), finish(). Returns a Blob. */
  async function write(rows, options) {
    const writer = await createWriter(options);
    await writer.writeRows(rows);
    return writer.finish();
  }

  global.JazminBrowser = {
    open,
    openUrl,
    createWriter,
    write,
    compileFilter,
    base64ToBytes,
    JazminError,
    JazminFormatError,
    JazminKeyError,
    JazminUnlockRequiredError,
    JazminValidationError,
  };
})(globalThis);
