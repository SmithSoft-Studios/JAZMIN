// JAZMIN browser reader, add-on: writing files (createWriter, write), and changes made through a document (writeChanges). Load it after
// jazmin-browser-core.js (the full jazmin-browser.js already has it).
// Built by js/scripts/build-browser.mjs from js/browser/src: change those, then run it.
(function (global) {
  'use strict';

  const internals = global.JazminBrowser?.[Symbol.for('jazmin.browser.internals')];
  if (!internals) throw new Error('jazmin-browser-writer.js needs jazmin-browser-core.js, loaded first');
  const { PREAMBLE, TRAILER, ENVELOPE, FLAG_ENCRYPTED, FLAG_PASSWORD, CODEC_NONE, CODEC_DEFLATE, MIN_KDF_ITERATIONS, MAX_KDF_ITERATIONS, TYPE_NAMES, ENCODING, NESTED_COLUMNS, MAX_NESTING_DEPTH, isNested, HAS_NULLS, POW10, subtle, utf8, JazminError, JazminKeyError, crc32, toHex, concat, base64ToBytes, view, sha256, hkdf, pbkdf2, parseKey, formatDecimal, streamType, bytesToBase64, JazminValidationError, normalizeBigInt, compareDecimalKeys, decimalKeyOf, parseDecimalText, validation } = internals;

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
  const MAX_WRITE_SCALE = 15;
  const MAX_STRING_STAT = 64;
  const TINY_SECTION = 256; // raw bytes below which catalog sections are stored uncompressed
  const FILE_BLOCK_SIZE = 256 * 1024; // raw bytes per stored block of an embedded file, as the library writes
  const MIME = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.zip': 'application/zip',
  };

  /** Secure random bytes: the browser's generator, never anything weaker. */
  function randomBytes(n) {
    if (typeof global.crypto?.getRandomValues !== 'function') throw new JazminError('This browser has no secure random generator (crypto.getRandomValues)');
    return global.crypto.getRandomValues(new Uint8Array(n));
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
    if (entry.actions !== undefined) throw new JazminValidationError(`File '${p}': file actions are not written in browsers yet`);
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

  const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const NON_FINITE = new Map([['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]]);

  /**
   * A list or object value (spec 5.4) in stored form, checked part by part before the row is kept: a list as an array
   * of its items, an object as an array of its fields' values (in field order). Leaves are stored as columns of their
   * types are, and also taken in JSON forms: base64 text for binary, "NaN" / "Infinity" / "-Infinity" for floats.
   */
  function normalizeNested(column, value, path) {
    if (value === null || value === undefined) return null;
    if (column.type === 'list') {
      if (!Array.isArray(value)) throw validation(path, `expected a list (an array), got ${typeof value}`);
      return Array.from(value, (item) => normalizePart(column.item, item, `${path}[]`));
    }
    if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date || ArrayBuffer.isView(value)) {
      throw validation(path, `expected an object, got ${Array.isArray(value) ? 'an array' : typeof value}`);
    }
    const names = new Set(column.fields.map((f) => f.name));
    for (const name of Object.keys(value)) if (!names.has(name)) throw validation(path, `'${name}' is not one of its fields`);
    return column.fields.map((f) => normalizePart(f, Object.hasOwn(value, f.name) ? value[f.name] : undefined, `${path}.${f.name}`));
  }

  function normalizePart(column, value, path) {
    if (value === null || value === undefined) {
      if (!column.nullable) throw new JazminValidationError(`Column '${path}' is not nullable`);
      return null;
    }
    if (isNested(column.type)) return normalizeNested(column, value, path);
    if (column.type === 'binary' && typeof value === 'string') {
      if (!BASE64.test(value)) throw validation(path, 'expected binary data or base64 text');
      return base64ToBytes(value);
    }
    if (column.type === 'float' && typeof value === 'string' && NON_FINITE.has(value)) return NON_FINITE.get(value);
    const v = normalizeWriteValue(column.type, value, path);
    return column.type === 'json' ? JSON.stringify(v) : v;
  }

  /** Approximate stored size of a list's or object's stored form. */
  function nestedSize(v) {
    if (v === null) return 0;
    if (Array.isArray(v)) return v.reduce((n, x) => n + nestedSize(x), 0); // leaves only, as the library counts
    return typeof v === 'string' ? v.length + 1 : v instanceof Uint8Array ? v.length + 2 : 5;
  }

  /** Approximate stored size of a value, to cap chunks at chunkBytes (as the library). */
  function estimateSize(type, v) {
    if (v === null) return 0;
    switch (type) {
      case 'list':
      case 'object': return nestedSize(v);
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

  /**
   * One chunk's payload in the columnar layout: `columnValues[j]` holds column j's `rowCount` stored values. `types[j]`
   * is its type, or a list's or object's definition.
   */
  function encodeColumnar(types, columnValues, rowCount) {
    const out = new ByteWriter(64 * 1024);
    for (let j = 0; j < types.length; j++) writeStream(out, types[j], columnValues[j], rowCount);
    return out.result();
  }

  /**
   * One stream (length, flags, nulls, body) of `count` entries. A list or object (spec 5.4) holds the streams of its
   * parts: a list its lengths (one per list that is not null) and its items, an object one stream per field.
   */
  function writeStream(out, type, all, count) {
    let nulls = null;
    const values = [];
    for (let r = 0; r < count; r++) {
      if (all[r] === null) {
        nulls ??= new Uint8Array((count + 7) >> 3);
        nulls[r >> 3] |= 1 << (r & 7);
      } else {
        values.push(all[r]);
      }
    }
    const body = new ByteWriter(1024);
    let encoding;
    if (typeof type === 'object') {
      encoding = ENCODING.nested;
      if (type.type === 'list') {
        writeStream(body, 'int', values.map((v) => v.length), values.length);
        const items = values.flat(1);
        writeStream(body, streamType(type.item), items, items.length);
      } else {
        type.fields.forEach((f, i) => writeStream(body, streamType(f), values.map((v) => v[i]), values.length));
      }
    } else encoding = writeColumnBody(body, type, values);
    const stream = body.result();
    out.varUint(1 + (nulls ? nulls.length : 0) + stream.length);
    out.byte(encoding | (nulls ? HAS_NULLS : 0));
    if (nulls) out.bytes(nulls);
    out.bytes(stream);
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
      for (const f of c.fields ?? []) w.message(8, writeColumnDefinition(f), true); // objects: their fields (spec 5.4)
      if (c.item) w.message(9, writeColumnDefinition(c.item), true); // lists: their items
    };
  }

  /** A column's catalog definition, with a list's item or an object's fields. */
  function catalogColumn(c, position) {
    return {
      position, name: c.name, type: c.type, required: !c.nullable, description: c.description, attributes: c.attributes,
      ...(c.item ? { item: catalogColumn(c.item, 0) } : {}),
      ...(c.fields ? { fields: c.fields.map(catalogColumn) } : {}),
    };
  }

  function encodeStatisticsBlock(columns) {
    const w = new ProtoWriter();
    for (const c of columns) {
      w.message(1, (cw) => {
        cw.packed(1, c.nullCounts);
        for (const b of c.min) cw.always(2, b);
        for (const b of c.max) cw.always(3, b);
        for (const leaf of c.leaves ?? []) {
          cw.message(4, (lw) => {
            lw.packed(1, leaf.path);
            lw.packed(2, leaf.counts);
            lw.packed(3, leaf.nullCounts);
            for (const b of leaf.min) lw.always(4, b);
            for (const b of leaf.max) lw.always(5, b);
          }, true);
        }
      }, true);
    }
    return w.result();
  }

  /**
   * A nested column's leaves' statistics over one chunk's values (spec 6.4), depth first as the library keeps them:
   * { path (field positions; a list's item adds none), count (entries, null or not), stats }.
   */
  function leafStatsOf(column, values) {
    const leaves = [];
    const walk = (part, path, entries) => {
      if (part.type === 'list') {
        const items = [];
        for (const list of entries) if (list !== null) for (const item of list) items.push(item);
        walk(part.item, path, items);
      } else if (part.type === 'object') {
        part.fields.forEach((field, i) => {
          const parts = [];
          for (const object of entries) if (object !== null) parts.push(object[i]);
          walk(field, [...path, i], parts);
        });
      } else {
        const stats = new ColumnStats(part.type);
        for (const v of entries) stats.add(v);
        leaves.push({ path, count: entries.length, stats });
      }
    };
    walk(column, [], values);
    return leaves;
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
    if (table.columns.some((c) => isNested(c.type))) w.string(1, NESTED_COLUMNS); // reader features (spec 12)
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
      return writerColumn(c, c.name, 0);
    });
  }

  /** A column (or a list's item, or an object's field) checked, with its parts (spec 5.4: at most 64 levels deep). */
  function writerColumn(c, path, depth) {
    if (depth > MAX_NESTING_DEPTH) throw validation(path, `nested more than ${MAX_NESTING_DEPTH} levels deep`);
    if (!WRITE_TYPES.includes(c.type)) throw new JazminValidationError(`Column '${path}' has unknown type '${c.type}'`);
    const column = {
      name: c.name, type: c.type, nullable: c.nullable !== false,
      description: c.description === undefined ? undefined : String(c.description),
      attributes: c.attributes === undefined ? undefined : JSON.stringify(c.attributes),
    };
    const part = (d, name, at) => {
      if (d === null || typeof d !== 'object') throw validation(at, 'needs a definition (an object with a type)');
      if (d.index !== undefined && [].concat(d.index).length) throw validation(at, 'items and fields cannot be indexed');
      return writerColumn({ ...d, name: d.name ?? name }, at, depth + 1);
    };
    if (c.type === 'list') {
      if (c.item === undefined || c.item === null) throw validation(path, 'a list needs an item');
      if (c.fields !== undefined) throw validation(path, 'a list has an item, not fields');
      column.item = part(c.item, 'item', `${path}[]`);
    } else if (c.type === 'object') {
      if (!Array.isArray(c.fields) || c.fields.length === 0) throw validation(path, 'an object needs at least one field');
      if (c.item !== undefined) throw validation(path, 'an object has fields, not an item');
      const names = new Set();
      column.fields = c.fields.map((f) => {
        if (!f || typeof f.name !== 'string' || f.name === '') throw validation(path, 'every field needs a non-empty name');
        if (names.has(f.name)) throw validation(path, `duplicate field '${f.name}'`);
        names.add(f.name);
        return part(f, f.name, `${path}.${f.name}`);
      });
    } else if (c.item !== undefined || c.fields !== undefined) {
      throw validation(path, 'only lists have an item and only objects have fields');
    }
    return column;
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
    const streamTypes = columns.map(streamType);
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
      const s = await section(encodeColumnar(streamTypes, values, inChunk), sectionId, await sectionKey(sectionId));
      columns.forEach((c, i) => {
        if (isNested(c.type)) stats[i].leaves = leafStatsOf(c, values[i]); // spec 6.4, as the library writes them
      });
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
        const v = isNested(c.type) ? normalizeNested(c, row[c.name], c.name) : normalizeWriteValue(c.type, row[c.name], c.name);
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
            const first = chunks[0].stats[col].leaves;
            const leaves = first ? first.map((leaf, k) => {
              const leafBounds = chunks.map((c) => c.stats[col].leaves[k].stats.bounds());
              return {
                path: leaf.path, counts: chunks.map((c) => c.stats[col].leaves[k].count), nullCounts: chunks.map((c) => c.stats[col].leaves[k].stats.nulls),
                min: leafBounds.map((b) => b.min), max: leafBounds.map((b) => b.max),
              };
            }) : [];
            const raw = encodeStatisticsBlock([{ nullCounts: chunks.map((c) => c.stats[col].nulls), min: bounds.map((b) => b.min), max: bounds.map((b) => b.max), leaves }]);
            statistics.push({ columns: [col], section: await writeSection(raw, `0/stats/*/${col}`) });
          }
          partitions.push({ segments: [await writeSection(encodeDirectory(chunks, statistics), '0/dir/*')] });
        }
        const table = {
          name: '', rowCount, chunkCount: chunks.length, partitions,
          columns: columns.map(catalogColumn),
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

  // ---- changes made through a document (docs/design/editable-documents.md, spec 7.9): the library's writeChanges ----

  const CHANGE_OPS = ['add', 'update', 'delete'];
  const changeKeyText = (row, key) => JSON.stringify(key.map((k) => {
    const v = row[k];
    return v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? `${v}n` : v;
  }));
  const showKey = (row, key) => key.map((k) => `${k} ${row[k] instanceof Date ? row[k].toISOString() : String(row[k])}`).join(', ');
  const changeDefinition = ({ name, type, nullable, item, fields }) => ({
    name, type, nullable: nullable !== false, ...(item ? { item: changeDefinition(item) } : {}), ...(fields ? { fields: fields.map(changeDefinition) } : {}),
  });

  /**
   * A call's changes as [{ op, key, values }], checked against what the document allows (`editable`: its columns the key
   * sees) and what the key may send (`allowed`: narrowed by its limit, spec 7.9.1), as the library checks.
   */
  function changeList(changes, edit, editable, allowed) {
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw new JazminValidationError('Changes are { update, add, delete }: lists of rows');
    for (const name of Object.keys(changes)) if (!CHANGE_OPS.includes(name)) throw new JazminValidationError(`Changes: unknown '${name}' (update, add, delete)`);
    const out = [];
    const seen = new Set();
    for (const op of CHANGE_OPS) {
      const list = changes[op];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) throw new JazminValidationError(`Changes: ${op} must be a list of rows`);
      if (list.length && op === 'add' && !edit.add) throw new JazminValidationError("This document doesn't allow adding rows");
      if (list.length && op === 'delete' && !edit.delete) throw new JazminValidationError("This document doesn't allow deleting rows");
      if (list.length && op === 'add' && !allowed.add) throw new JazminValidationError("This key can't add rows");
      if (list.length && op === 'delete' && !allowed.delete) throw new JazminValidationError("This key can't delete rows");
      for (const row of list) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new JazminValidationError(`Changes: ${op} must be a list of rows (objects)`);
        const key = {};
        for (const k of edit.key) {
          if (row[k] === undefined || row[k] === null) throw new JazminValidationError(`Changes: a row to ${op} without its key column '${k}'`);
          key[k] = row[k];
        }
        const values = {};
        for (const [name, value] of Object.entries(row)) {
          if (edit.key.includes(name)) continue;
          if (op === 'delete') throw new JazminValidationError(`Changes: give the rows to delete by their key only ('${name}' isn't a key column)`);
          if (!editable.has(name)) throw new JazminValidationError(`Column '${name}' can't be changed through this document`);
          if (!allowed.columns.includes(name)) throw new JazminValidationError(`Column '${name}' can't be changed with this key`);
          values[name] = value === undefined ? null : value;
        }
        if (op === 'update' && !Object.keys(values).length) throw new JazminValidationError(`Changes: the update of ${showKey(key, edit.key)} changes nothing`);
        const text = changeKeyText(key, edit.key);
        if (seen.has(text)) throw new JazminValidationError(`Changes: ${showKey(key, edit.key)} appears twice: one change per row`);
        seen.add(text);
        out.push({ op, key, values });
      }
    }
    if (!out.length) throw new JazminValidationError('No changes to save');
    return out;
  }

  /**
   * A change file (a Blob) for changes to `source`, a file opened here whose document allows them (package.edit): as
   * the library's writeChanges, with the earlier values from `source`. Sealed with a shared file's submission key; give
   * a file that isn't shared its key or password ({ key } / { password }).
   */
  async function writeChanges(source, changes, { key, password } = {}) {
    const edit = source.package?.edit;
    if (!edit) throw new JazminValidationError("This file's document doesn't allow changes (it has no package.edit)");
    let seal;
    if (source.access) {
      if (source.access.isOwner) throw new JazminValidationError("A shared file's owner changes it directly, not with a change file");
      if (!source.submissionKey) throw new JazminValidationError('This shared file has no submission keys yet (written before they existed): its owner adds them with any rewrite');
      seal = { key: source.submissionKey };
    } else if (source.encrypted) {
      if (!key && !password) throw new JazminValidationError('Give the key or password the file opens with, to seal its changes with');
      seal = key ? { key } : { password };
    } else {
      seal = {};
    }
    // A shared file's grant may limit what its key sends back (spec 7.9.1); a limit an older release lost allows nothing.
    const limit = source.access && !source.access.isOwner ? source.access : null;
    if (limit?.editLost) throw new JazminValidationError("This key's limits were lost: ask the file's owner to grant it again");
    const tableName = edit.table ?? source.tables[0];
    const reader = source.table === tableName ? source : await source.openTable(tableName);
    const columns = new Map(reader.columns.map((c) => [c.name, c]));
    for (const k of edit.key) if (!columns.has(k)) throw new JazminValidationError(`The key column '${k}' isn't visible with this key`);
    const visible = new Set(edit.columns.filter((n) => columns.has(n))); // the document's columns this key sees
    const allowed = {
      columns: edit.columns.filter((n) => visible.has(n) && (!limit?.edit?.columns || limit.edit.columns.includes(n))),
      add: edit.add === true && limit?.edit?.add !== false,
      delete: edit.delete === true && limit?.edit?.delete !== false,
    };
    if (limit?.edit && !allowed.columns.length && !allowed.add && !allowed.delete) throw new JazminValidationError("This key can't send changes to this document");
    const editable = allowed.columns; // the change file lists what this key may change
    const list = changeList(changes, edit, visible, allowed);
    const current = new Map();
    for (let i = 0; i < list.length; i += 500) {
      const batch = list.slice(i, i + 500).map((c) => c.key);
      const filter = edit.key.length === 1
        ? { [edit.key[0]]: { in: batch.map((r) => r[edit.key[0]]) } }
        : { or: batch.map((r) => Object.fromEntries(edit.key.map((k) => [k, r[k]]))) };
      for await (const row of reader.find(filter)) current.set(changeKeyText(row, edit.key), row);
    }
    const rows = list.map(({ op, key: k, values }) => {
      const now = current.get(changeKeyText(k, edit.key));
      if (op === 'add' && now) throw new JazminValidationError(`A row with ${showKey(k, edit.key)} is already there: change it instead`);
      if (op !== 'add' && !now) throw new JazminValidationError(`No row with ${showKey(k, edit.key)} is visible with this key`);
      const set = Object.keys(values);
      const row = { 'jazmin.op': op, 'jazmin.set': op === 'delete' ? null : set, ...k };
      for (const n of editable) {
        row[n] = n in values ? values[n] : null;
        row[`jazmin.before.${n}`] = op === 'delete' || (op === 'update' && n in values) ? now[n] : null;
      }
      return row;
    });
    const defs = [
      { name: 'jazmin.op', type: 'string', nullable: false },
      { name: 'jazmin.set', type: 'json' },
      ...edit.key.map((k) => changeDefinition(columns.get(k))),
      ...editable.map((n) => ({ ...changeDefinition(columns.get(n)), nullable: true })),
      ...editable.map((n) => ({ ...changeDefinition(columns.get(n)), name: `jazmin.before.${n}`, nullable: true })),
    ];
    const metadata = {
      'jazmin.changes': {
        version: 1, file: source.fileId, table: reader.table, key: edit.key, columns: editable, sender: source.access?.keyId ?? null,
        based: { writtenAt: source.writtenAt.toISOString(), appendCount: source.appendCount },
      },
    };
    return write(rows, { columns: defs, metadata, ...seal });
  }

  const API_WRITER = { createWriter, write, writeChanges };

  Object.assign(global.JazminBrowser, API_WRITER);
})(globalThis);
