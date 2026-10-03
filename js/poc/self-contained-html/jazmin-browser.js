// JAZMIN browser reader (proof of concept): read-only, async, no dependencies.
// Runs in browsers (also from file://) and in Node 22+, using WebCrypto and DecompressionStream.
// Supports plain, key-encrypted and password-protected format 1.0 files. Not yet: access-controlled and
// appended files, and Brotli (browsers cannot decompress it natively).
// Loaded as a classic script (browsers block module scripts on file://); defines globalThis.JazminBrowser.
(function (global) {
  'use strict';

  const PREAMBLE = 64;
  const TRAILER = 44;
  const ENVELOPE = 16;
  const FLAG_ENCRYPTED = 0x1;
  const FLAG_PASSWORD = 0x2;
  const FLAG_ACCESS = 0x4;
  const FLAG_APPENDED = 0x8;
  const KNOWN_FLAGS = 0xf;
  const CODEC_NONE = 0;
  const CODEC_DEFLATE = 1;
  const CODEC_BROTLI = 2;
  const TYPE_NAMES = ['', 'bool', 'int', 'float', 'decimal', 'string', 'datetime', 'binary', 'json'];
  const ENCODING = { plain: 0, delta: 1, dictionary: 2, bitmap: 3, scaled: 4 };
  const HAS_NULLS = 0x10;
  const POW10 = Array.from({ length: 23 }, (_, s) => 10 ** s);
  const subtle = global.crypto.subtle;
  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder();

  class JazminError extends Error {
    constructor(message) {
      super(message);
      this.name = 'JazminError';
    }
  }

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

  function base64ToBytes(text) {
    const bin = global.atob(text.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const base64UrlToBytes = (text) => base64ToBytes(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));

  async function sha256(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }

  /** Parses "jzk1-..." and checks its built-in checksum, so typos fail before any decryption. */
  async function parseKey(text) {
    if (typeof text !== 'string' || !text.trim().startsWith('jzk1-')) {
      throw new JazminError(text && text.trim().startsWith('jza1-')
        ? 'Access keys (jza1-) are not supported by this proof of concept yet - use the master key'
        : "A key must start with 'jzk1-'");
    }
    const raw = base64UrlToBytes(text.trim().slice(5));
    if (raw.length !== 36) throw new JazminError('Key text has the wrong length');
    const key = raw.subarray(0, 32);
    if (!equal((await sha256(key)).subarray(0, 4), raw.subarray(32))) {
      throw new JazminError('Key checksum mismatch - the key is mistyped or incomplete');
    }
    return key;
  }

  async function hkdf(ikm, salt, info) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) }, base, 256));
  }

  async function pbkdf2(password, salt, iterations) {
    const base = await subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  }

  async function decrypt(keyBytes, payload, aad) {
    if (payload.length < 28) throw new JazminError('Encrypted section is too short');
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12), additionalData: aad }, key, payload.subarray(12)));
    } catch {
      throw new JazminError('Decryption failed - wrong key or password, or the file was tampered with');
    }
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Little-endian reader over a Uint8Array, mirroring the library's ByteReader. */
  class Reader {
    constructor(bytes, pos = 0) {
      this.buf = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = pos;
    }

    need(n) {
      if (this.pos + n > this.buf.length) throw new JazminError('Unexpected end of data');
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
        if (count === max) throw new JazminError('Varint too long');
        const b = this.byte();
        result |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        if (!(b & 0x80)) return result;
      }
    }

    /** Unsigned varint that must fit a safe integer (lengths, counts, offsets). */
    varUint() {
      const v = this.bigVarUint();
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new JazminError('Value out of range');
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

  // ---- catalog (Protocol Buffers wire format, spec/jazmin.proto) ----------------------------------

  /** Calls onField(field, value) for each field: varints as Numbers, length-delimited fields as bytes. */
  function readMessage(bytes, onField) {
    const r = new Reader(bytes);
    while (!r.eof) {
      const tag = r.varUint();
      const field = Math.floor(tag / 8);
      switch (tag & 7) {
        case 0: onField(field, r.varUint()); break;
        case 1: r.bytes(8); break;
        case 2: onField(field, r.bytes(r.varUint())); break;
        case 5: r.bytes(4); break;
        default: throw new JazminError(`Catalog: unsupported wire type ${tag & 7}`);
      }
    }
  }

  function readPacked(bytes) {
    const r = new Reader(bytes);
    const out = [];
    while (!r.eof) out.push(r.varUint());
    return out;
  }

  const cumulative = (values) => {
    let total = 0;
    return values.map((v) => (total += v));
  };

  function readRef(bytes) {
    const ref = { offset: 0, length: 0 };
    readMessage(bytes, (f, v) => {
      if (f === 1) ref.offset = v;
      else if (f === 2) ref.length = v;
    });
    return ref;
  }

  function readColumn(bytes) {
    const c = { position: 0, name: '', type: '', nullable: true };
    readMessage(bytes, (f, v) => {
      if (f === 1) c.position = v;
      else if (f === 2) c.name = fromUtf8.decode(v);
      else if (f === 3) c.type = TYPE_NAMES[v] || '';
      else if (f === 4) c.nullable = v === 0;
      else if (f === 5) c.description = fromUtf8.decode(v);
      else if (f === 6) c.attributes = JSON.parse(fromUtf8.decode(v));
      else if (f === 7 && v !== 0) throw new JazminError(`Column '${c.name}' uses an unknown time unit`);
    });
    if (!c.type) throw new JazminError(`Column '${c.name}' has an unknown type`);
    return c;
  }

  function readTable(bytes) {
    const t = { columnCount: 0, groups: [], rowCount: 0, chunkCount: 0, partitions: [], partitionTable: false };
    readMessage(bytes, (f, v) => {
      if (f === 2) t.columnCount = v;
      else if (f === 3) {
        const g = { name: '', columns: [], restricted: false };
        readMessage(v, (gf, gv) => {
          if (gf === 1) g.name = fromUtf8.decode(gv);
          else if (gf === 2) g.columns.push(readColumn(gv));
          else if (gf === 4) g.restricted = true;
        });
        t.groups.push(g);
      } else if (f === 6) t.rowCount = v;
      else if (f === 8) t.chunkCount = v;
      else if (f === 9) {
        const p = { id: new Uint8Array(0), segments: [] };
        readMessage(v, (pf, pv) => {
          if (pf === 1) p.id = pv;
          else if (pf === 2) p.segments.push(readRef(pv));
        });
        t.partitions.push(p);
      } else if (f === 10) t.partitionTable = true;
    });
    return t;
  }

  function readHeader(bytes) {
    const h = { readerFeatures: [], metadata: '', tables: [], keyring: {} };
    readMessage(bytes, (f, v) => {
      if (f === 1) h.readerFeatures.push(fromUtf8.decode(v));
      else if (f === 6) h.metadata = fromUtf8.decode(v);
      else if (f === 7) h.tables.push(readTable(v));
      else if (f === 8) {
        readMessage(v, (kf, kv) => {
          const group = ['', 'data', 'index', 'files'][kf];
          if (group) h.keyring[group] = kv.slice();
        });
      }
    });
    return h;
  }

  /** One chunk-directory segment of a file with one column group: [{ ordinal, rowStart, rowCount, part }]. */
  function readChunkDirectory(bytes) {
    let ordinals = [];
    let rowStarts = [];
    let rowCounts = [];
    let offsets = [];
    let lengths = [];
    readMessage(bytes, (f, v) => {
      if (f === 1) ordinals = cumulative(readPacked(v));
      else if (f === 2) rowStarts = cumulative(readPacked(v));
      else if (f === 3) rowCounts = readPacked(v);
      else if (f === 4) offsets = cumulative(readPacked(v));
      else if (f === 5) lengths = readPacked(v);
    });
    const n = ordinals.length;
    if ([rowStarts, rowCounts, offsets, lengths].some((list) => list.length !== n)) throw new JazminError('Chunk directory lists are inconsistent');
    return ordinals.map((ordinal, i) => ({ ordinal, rowStart: rowStarts[i], rowCount: rowCounts[i], offset: offsets[i], length: lengths[i] }));
  }

  // ---- columnar chunks (spec 5.4) --------------------------------------------------------------

  function formatDecimal(m, s) {
    const negative = m < 0n;
    const digits = (negative ? -m : m).toString().padStart(s + 1, '0');
    const text = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
    return negative ? `-${text}` : text;
  }

  /** A decimal: varint scale, then the integer m as a zigzag varint of any size (spec 5.1). */
  function readDecimal(r) {
    const s = r.varUint();
    if (s > 255) throw new JazminError('Decimal scale is invalid');
    const z = r.bigVarUint(132);
    return formatDecimal(z & 1n ? -((z + 1n) >> 1n) : z >> 1n, s);
  }

  function readPlain(r, type) {
    switch (type) {
      case 'bool': return r.byte() !== 0;
      case 'int': return r.varInt();
      case 'datetime': return new Date(Number(r.varInt()));
      case 'float': return r.float64();
      case 'binary': return r.bytes(r.varUint()).slice();
      case 'json': return JSON.parse(r.string());
      case 'decimal': return readDecimal(r);
      default: return r.string();
    }
  }

  /** Decodes a columnar chunk payload into one array of values per column (null for null). */
  function decodeColumnar(raw, types, rowCount, ordinal) {
    const reader = new Reader(raw);
    const columns = new Array(types.length);
    for (let j = 0; j < types.length; j++) {
      const length = reader.varUint();
      const end = reader.pos + length;
      if (length < 1 || end > raw.length) throw new JazminError(`Chunk ${ordinal}: invalid stream length`);
      const r = new Reader(raw.subarray(0, end), reader.pos);
      const flags = r.byte();
      const type = types[j];
      if (flags & 0xe0) throw new JazminError(`Chunk ${ordinal}: reserved stream flags are set`);
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
            values[i] = type === 'datetime' ? new Date(Number(v)) : v;
          }
          break;
        }
        case ENCODING.dictionary: {
          const entries = Array.from({ length: r.varUint() }, () => (type === 'decimal' ? readDecimal(r) : r.string()));
          for (let i = 0; i < count; i++) {
            const id = r.varUint();
            if (id >= entries.length) throw new JazminError(`Chunk ${ordinal}: dictionary index out of range`);
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
            else throw new JazminError(`Chunk ${ordinal}: invalid scale ${s}`);
          }
          break;
        default:
          throw new JazminError(`Chunk ${ordinal}: unknown encoding ${flags & 0x0f}`);
      }
      if (r.pos !== end) throw new JazminError(`Chunk ${ordinal}: stream length does not match its contents`);
      reader.pos = end;
      if (!nulls) columns[j] = values;
      else {
        const full = new Array(rowCount);
        for (let i = 0, k = 0; i < rowCount; i++) full[i] = isNull(i) ? null : values[k++];
        columns[j] = full;
      }
    }
    if (!reader.eof) throw new JazminError(`Chunk ${ordinal} has trailing bytes`);
    return columns;
  }

  class JazminBrowserReader {
    #bytes;
    #fileId;
    #master = null;
    #keyring = {};
    #chunks = [];
    #groupName;

    constructor(bytes) {
      this.#bytes = bytes;
    }

    async open(options) {
      const b = this.#bytes;
      if (b.length < PREAMBLE + TRAILER) throw new JazminError('File is too small to be JAZMIN');
      const magic = fromUtf8.decode(b.subarray(0, 4));
      if (magic === 'JZMN') throw new JazminError('This file uses a pre-release JAZMIN draft format - write it again from its source data');
      if (magic !== 'JZM1') throw new JazminError('Not a JAZMIN file');
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const flags = view.getUint16(4, true);
      if (flags & ~KNOWN_FLAGS) throw new JazminError(`Unsupported file features (flags 0x${flags.toString(16)})`);
      if (flags & FLAG_ACCESS) throw new JazminError('Access-controlled files are not supported by this proof of concept yet');
      if (flags & FLAG_APPENDED) throw new JazminError('Appended files are not supported by this proof of concept yet - compact the file first');
      this.#fileId = b.subarray(8, 24);
      const salt = b.subarray(24, 56);
      this.encrypted = (flags & FLAG_ENCRYPTED) !== 0;
      this.passwordProtected = (flags & FLAG_PASSWORD) !== 0;

      const t = b.subarray(b.length - TRAILER);
      if (fromUtf8.decode(t.subarray(40, 44)) !== 'JZM1') throw new JazminError('Missing trailer - the file is truncated');
      const tv = new DataView(t.buffer, t.byteOffset, TRAILER);
      if (crc32(t.subarray(0, 36)) !== tv.getUint32(36, true)) throw new JazminError('Trailer failed its CRC-32 check');
      const headerOffset = Number(tv.getBigUint64(0, true));
      const headerLength = tv.getUint32(8, true);

      let headerKey = null;
      if (this.encrypted) {
        const { key, password } = options || {};
        if (!key && !password) throw new JazminError('This file is encrypted - enter its key or password');
        if (password && !this.passwordProtected) throw new JazminError('This file was encrypted with a key, not a password');
        this.#master = password ? await pbkdf2(password, salt, view.getUint32(56, true)) : await parseKey(key);
        headerKey = await hkdf(this.#master, salt, 'JAZMIN/1/header');
      }
      const header = readHeader(await this.#section(headerOffset, headerLength, 'header', headerKey));
      if (header.readerFeatures.length) throw new JazminError(`This file needs features this reader does not support: ${header.readerFeatures.join(', ')}`);
      const table = header.tables[0];
      if (!table) throw new JazminError('The file lists no table');
      if (table.groups.length !== 1 || table.partitions.length !== 1 || table.partitionTable) throw new JazminError('Unexpected table structure for a file that is not access-controlled');
      this.#keyring = header.keyring;
      this.#groupName = table.groups[0].name;
      this.columns = table.groups[0].columns.sort((x, y) => x.position - y.position).map(({ position, ...c }) => c);
      if (this.columns.length !== table.columnCount) throw new JazminError('Column definitions are incomplete');
      this.metadata = header.metadata ? JSON.parse(header.metadata) : {};
      this.rowCount = table.rowCount;

      const [segment] = table.partitions[0].segments; // one segment: the file has not been appended to
      const sectionId = '0/dir/*';
      this.#chunks = readChunkDirectory(await this.#section(segment.offset, segment.length, sectionId, await this.#sectionKey('data', sectionId)));
      if (this.#chunks.length !== table.chunkCount || this.#chunks.some((c, i) => c.ordinal !== i)) throw new JazminError('Chunk directory does not match the header');
      return this;
    }

    /** Verifies (CRC-32), decrypts and decompresses one section. */
    async #section(offset, length, sectionId, key) {
      const s = this.#bytes.subarray(offset, offset + length);
      if (s.length < ENVELOPE) throw new JazminError(`Section '${sectionId}' is truncated`);
      const v = new DataView(s.buffer, s.byteOffset, ENVELOPE);
      const codec = s[0];
      const encrypted = (s[1] & 1) !== 0;
      const rawLength = v.getUint32(4, true);
      const payloadLength = v.getUint32(8, true);
      let body = s.subarray(ENVELOPE, ENVELOPE + payloadLength);
      if (body.length !== payloadLength) throw new JazminError(`Section '${sectionId}' is truncated`);
      if (crc32(body) !== v.getUint32(12, true)) throw new JazminError(`Section '${sectionId}' failed its CRC-32 check`);
      if (key && !encrypted) throw new JazminError(`Section '${sectionId}' is not encrypted but the file is`);
      if (encrypted) {
        if (!key) throw new JazminError('This file is encrypted - enter its key or password');
        body = await decrypt(key, body, concat(this.#fileId, s.subarray(0, 8), utf8.encode(sectionId)));
      }
      if (codec === CODEC_DEFLATE) body = await inflateRaw(body);
      else if (codec === CODEC_BROTLI) throw new JazminError('Brotli sections cannot be read in browsers - write the file with deflate');
      else if (codec !== CODEC_NONE) throw new JazminError(`Unsupported codec ${codec}`);
      if (body.length !== rawLength) throw new JazminError(`Section '${sectionId}' has the wrong decompressed length`);
      return body;
    }

    async #sectionKey(group, sectionId) {
      if (!this.#master) return null;
      const secret = this.#keyring[group];
      if (!secret) throw new JazminError(`Keyring has no secret for group '${group}'`);
      return hkdf(this.#master, secret, `JAZMIN/1/${sectionId}`);
    }

    /** Decodes one chunk into row objects. Only this chunk is decrypted and decompressed. */
    async chunk(ordinal) {
      const chunk = this.#chunks[ordinal];
      const sectionId = `0/chunk/${ordinal}/${this.#groupName}`;
      const raw = await this.#section(chunk.offset, chunk.length, sectionId, await this.#sectionKey('data', sectionId));
      const cols = this.columns;
      const values = decodeColumnar(raw, cols.map((c) => c.type), chunk.rowCount, ordinal);
      const rows = new Array(chunk.rowCount);
      for (let i = 0; i < rows.length; i++) {
        const row = {};
        for (let j = 0; j < cols.length; j++) row[cols[j].name] = values[j][i];
        rows[i] = row;
      }
      return rows;
    }

    get chunkCount() {
      return this.#chunks.length;
    }

    /** All rows, chunk by chunk. */
    async rows() {
      const all = [];
      for (let i = 0; i < this.chunkCount; i++) all.push(...(await this.chunk(i)));
      return all;
    }
  }

  global.JazminBrowser = {
    JazminError,
    base64ToBytes,
    /** Opens JAZMIN bytes. options: { key: 'jzk1-...' } or { password } for encrypted files. */
    open: (bytes, options) => new JazminBrowserReader(bytes).open(options),
  };
})(globalThis);
