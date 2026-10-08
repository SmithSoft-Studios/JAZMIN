// Columnar chunk layout (spec section 5.3): one stream per column, with per-type encodings. List and object columns
// (spec 5.4) hold streams of their parts.
import { ByteReader, ByteWriter, dateFromMs, msFromFile, normalizeBigInt, parseJsonText } from './binary.js';
import { readDecimal, skipDecimal, writeDecimal } from './decimal.js';
import { JazminFormatError, JazminValidationError } from './errors.js';
import { setField } from './schema.js';
import { normalizeValue } from './types.js';

export const ENCODING = Object.freeze({ plain: 0, delta: 1, dictionary: 2, bitmap: 3, scaled: 4, nested: 5 });
const HAS_NULLS = 0x10;
const ALLOWED = {
  bool: [ENCODING.plain, ENCODING.bitmap],
  int: [ENCODING.plain, ENCODING.delta],
  datetime: [ENCODING.plain, ENCODING.delta],
  float: [ENCODING.plain, ENCODING.scaled],
  decimal: [ENCODING.plain, ENCODING.dictionary],
  string: [ENCODING.plain, ENCODING.dictionary],
  binary: [ENCODING.plain],
  json: [ENCODING.plain],
  list: [ENCODING.nested],
  object: [ENCODING.nested],
};
const MAX_ITEMS = 2 ** 31 - 1; // items of one chunk's lists, at most (spec 5.4)
const POW10 = Array.from({ length: 23 }, (_, s) => 10 ** s); // exact binary64 for s <= 22
const MAX_WRITE_SCALE = 15;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// ---- writing -----------------------------------------------------------------------------------

/** Size in bytes of a zigzag varint (for choosing between encodings). */
function varIntSize(v) {
  if (typeof v === 'bigint') {
    let z = v >= 0n ? v << 1n : ((-v) << 1n) - 1n;
    let n = 1;
    while (z >= 0x80n) { z >>= 7n; n++; }
    return n;
  }
  let z = v >= 0 ? v * 2 : -v * 2 - 1;
  let n = 1;
  while (z >= 0x80) { z = Math.floor(z / 128); n++; }
  return n;
}

const sub = (a, b) => (typeof a === 'number' && typeof b === 'number' && Number.isSafeInteger(a - b) ? a - b : BigInt(a) - BigInt(b));

/** Scale (0..15) at which m / 10^s reproduces v exactly, or -1 (always for -0, NaN and infinities). */
function scaleOf(v) {
  if (Object.is(v, -0)) return -1; // a varint has no negative zero
  for (let s = 0; s <= MAX_WRITE_SCALE; s++) {
    const m = Math.round(v * POW10[s]);
    if (!Number.isSafeInteger(m)) return -1;
    if (Object.is(m / POW10[s], v)) return s;
  }
  return -1;
}

function writePlain(w, type, values) {
  for (const v of values) {
    switch (type) {
      case 'bool': w.byte(v ? 1 : 0); break;
      case 'int':
      case 'datetime': w.varInt(v); break;
      case 'float': w.float64(v); break;
      case 'binary': w.blob(v); break;
      case 'decimal': writeDecimal(w, v); break; // scale + integer (spec 5.1)
      default: w.string(v); // string, and json (already stringified by the caller)
    }
  }
}

/** A string or decimal value (decimals as scale + integer, strings as length + UTF-8). */
function writeText(w, type, v) {
  if (type === 'decimal') writeDecimal(w, v);
  else w.string(v);
}

/** Chooses an encoding for the non-null values of one column and writes the body. */
function writeBody(w, type, values) {
  switch (type) {
    case 'bool': {
      const bits = Buffer.alloc((values.length + 7) >> 3);
      values.forEach((v, i) => { if (v) bits[i >> 3] |= 1 << (i & 7); });
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
          const d = sub(values[i], values[i - 1]);
          if (typeof d === 'bigint' && (d < INT64_MIN || d > INT64_MAX)) { fits = false; break; }
          deltas.push(typeof d === 'bigint' ? normalizeBigInt(d) : d);
          delta += varIntSize(d);
        }
        if (fits && delta < plain) {
          w.varInt(values[0]);
          for (const d of deltas) w.varInt(d);
          return ENCODING.delta;
        }
      }
      writePlain(w, type, values);
      return ENCODING.plain;
    }
    case 'float': {
      const scales = values.map(scaleOf);
      let scaledSize = 0;
      for (let i = 0; i < values.length; i++) scaledSize += scales[i] < 0 ? 9 : 1 + varIntSize(Math.round(values[i] * POW10[scales[i]]));
      if (scaledSize < values.length * 8) {
        for (let i = 0; i < values.length; i++) {
          if (scales[i] < 0) { w.byte(255); w.float64(values[i]); }
          else { w.byte(scales[i]); w.varInt(Math.round(values[i] * POW10[scales[i]])); }
        }
        return ENCODING.scaled;
      }
      writePlain(w, type, values);
      return ENCODING.plain;
    }
    case 'decimal':
    case 'string': {
      const ids = new Map();
      for (const v of values) if (!ids.has(v)) ids.set(v, ids.size);
      if (values.length > 0 && ids.size * 2 <= values.length) {
        w.varUint(ids.size);
        for (const v of ids.keys()) writeText(w, type, v);
        for (const v of values) w.varUint(ids.get(v));
        return ENCODING.dictionary;
      }
      writePlain(w, type, values);
      return ENCODING.plain;
    }
    default:
      writePlain(w, type, values);
      return ENCODING.plain;
  }
}

/**
 * Encodes one chunk payload in the columnar layout.
 * `types[j]` is the type of column j of the payload; `columnValues[j]` holds its `rowCount` values in
 * internal form (null for null; json values already stringified).
 */
export function encodeColumnar(types, columnValues, rowCount) {
  const out = new ByteWriter(64 * 1024);
  for (let j = 0; j < types.length; j++) {
    const all = columnValues[j];
    let nulls = null;
    const values = [];
    for (let r = 0; r < rowCount; r++) {
      if (all[r] === null) {
        nulls ??= Buffer.alloc((rowCount + 7) >> 3);
        nulls[r >> 3] |= 1 << (r & 7);
      } else {
        values.push(all[r]);
      }
    }
    const body = new ByteWriter(1024);
    const encoding = writeBody(body, types[j], values);
    const stream = body.toBuffer();
    out.varUint(1 + (nulls ? nulls.length : 0) + stream.length);
    out.byte(encoding | (nulls ? HAS_NULLS : 0));
    if (nulls) out.bytes(nulls);
    out.bytes(stream);
  }
  return out.toBuffer();
}

/**
 * Typed buffers for one column of the chunk being written. Values are kept unboxed (numbers in a
 * Float64Array, booleans in bytes, strings as UTF-8 plus a capped dictionary) instead of as JS values in
 * arrays, so a chunk's values do not pile up in the garbage-collected heap. `encode` writes exactly the bytes
 * `encodeColumnar` writes for the same values.
 */
class ColumnBuffer {
  constructor(type, maxRows) {
    this.type = type;
    this.maxRows = maxRows; // rows per chunk at most (the writer's chunkRows)
    this.rows = 0;
    this.nulls = null; // null bitmap, allocated at the first null
  }

  addNull() {
    if (this.nulls === null || this.nulls.length < (this.rows >> 3) + 1) {
      const next = new Uint8Array(Math.max(64, (this.nulls?.length ?? 0) * 2, (this.rows >> 3) + 1));
      if (this.nulls) next.set(this.nulls);
      this.nulls = next;
    }
    this.nulls[this.rows >> 3] |= 1 << (this.rows & 7);
    this.rows++;
  }

  /** Writes the column's stream: length, flags, null bitmap, body. */
  encode(out, body) {
    body.length = 0;
    const encoding = this.writeBody(body);
    const nullBytes = this.nulls ? (this.rows + 7) >> 3 : 0;
    const hasNulls = nullBytes > 0 && this.nulls.some((b) => b !== 0);
    out.varUint(1 + (hasNulls ? nullBytes : 0) + body.length);
    out.byte(encoding | (hasNulls ? HAS_NULLS : 0));
    if (hasNulls) {
      const have = Math.min(nullBytes, this.nulls.length); // the bitmap only grows when a null is added
      out.bytes(this.nulls.subarray(0, have));
      for (let i = have; i < nullBytes; i++) out.byte(0);
    }
    out.bytes(body.buf.subarray(0, body.length));
  }

  reset() {
    this.rows = 0;
    this.nulls?.fill(0);
  }
}

/** int, datetime and float columns: a Float64Array; falls back to an array if a BigInt arrives. */
class NumberColumn extends ColumnBuffer {
  constructor(type, maxRows) {
    super(type, maxRows);
    this.values = new Float64Array(Math.min(maxRows, 1024));
    this.count = 0;
    this.big = null; // all values, once the column holds a BigInt
  }

  add(v) {
    if (this.big) this.big.push(v);
    else if (typeof v === 'bigint') {
      this.big = Array.from(this.values.subarray(0, this.count));
      this.big.push(v);
    } else {
      if (this.count === this.values.length) {
        const next = new Float64Array(this.count * 2);
        next.set(this.values);
        this.values = next;
      }
      this.values[this.count] = v;
    }
    this.count++;
    this.rows++;
  }

  writeBody(w) {
    return writeBody(w, this.type, this.big ?? this.values.subarray(0, this.count));
  }

  reset() {
    super.reset();
    this.count = 0;
    this.big = null;
  }
}

class BoolColumn extends ColumnBuffer {
  constructor(type, maxRows) {
    super(type, maxRows);
    this.values = new Uint8Array(Math.min(maxRows, 1024));
    this.count = 0;
  }

  add(v) {
    if (this.count === this.values.length) {
      const next = new Uint8Array(this.count * 2);
      next.set(this.values);
      this.values = next;
    }
    this.values[this.count++] = v ? 1 : 0;
    this.rows++;
  }

  writeBody(w) {
    return writeBody(w, 'bool', this.values.subarray(0, this.count));
  }

  reset() {
    super.reset();
    this.count = 0;
  }
}

/**
 * string and decimal columns. Values are collected as a dictionary of distinct strings plus one id per value,
 * so repeated strings are held once. Once the dictionary holds more than half the rows a chunk can have it can
 * no longer be chosen: the values so far are written out as UTF-8 (the plain encoding) and later ones follow.
 */
class StringColumn extends ColumnBuffer {
  constructor(type, maxRows) {
    super(type, maxRows);
    this.plain = null; // ByteWriter once the dictionary is dropped
    this.ids = new Map();
    this.order = new Int32Array(Math.min(maxRows, 1024));
    this.count = 0;
  }

  add(v) {
    if (this.plain === null) {
      let id = this.ids.get(v);
      if (id === undefined) {
        id = this.ids.size;
        if (id * 2 >= this.maxRows) this.#dropDictionary(); // one more distinct value: more than half of any chunk
        else this.ids.set(v, id);
      }
      if (this.plain === null) {
        if (this.count === this.order.length) {
          const next = new Int32Array(this.count * 2);
          next.set(this.order);
          this.order = next;
        }
        this.order[this.count] = id;
      }
    }
    if (this.plain !== null) writeText(this.plain, this.type, v);
    this.count++;
    this.rows++;
  }

  #dropDictionary() {
    this.plain = new ByteWriter(64 * 1024);
    this.#writePlain(this.plain);
    this.ids = null;
  }

  #writePlain(w) {
    const entries = [...this.ids.keys()];
    for (let i = 0; i < this.count; i++) writeText(w, this.type, entries[this.order[i]]);
  }

  writeBody(w) {
    if (this.plain !== null) {
      w.bytes(this.plain.buf.subarray(0, this.plain.length));
      return ENCODING.plain;
    }
    if (this.count > 0 && this.ids.size * 2 <= this.count) {
      w.varUint(this.ids.size);
      for (const v of this.ids.keys()) writeText(w, this.type, v);
      for (let i = 0; i < this.count; i++) w.varUint(this.order[i]);
      return ENCODING.dictionary;
    }
    this.#writePlain(w);
    return ENCODING.plain;
  }

  reset() {
    super.reset();
    this.plain = null;
    this.ids = new Map();
    this.count = 0;
  }
}

/** binary and json columns (json already stringified): plain values. */
class ValueColumn extends ColumnBuffer {
  constructor(type, maxRows) {
    super(type, maxRows);
    this.values = [];
  }

  add(v) {
    this.values.push(v);
    this.rows++;
  }

  writeBody(w) {
    return writeBody(w, this.type, this.values);
  }

  reset() {
    super.reset();
    this.values = [];
  }
}

const PRESENT = Symbol('present'); // a staged list or object that is not null

const failAt = (path, message) => new JazminValidationError(`Column '${path}': ${message}`);
const kindOf = (v) => (Array.isArray(v) ? 'an array' : v instanceof Date ? 'a Date' : v === null ? 'null' : typeof v);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const NON_FINITE = new Map([['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]]);

/**
 * A field's or item's value in the form its buffer takes (as normalizeValue, json as text). Also takes the JSON forms
 * other writers and exports use: base64 text for binary, and "NaN" / "Infinity" / "-Infinity" for floats.
 */
function leafValue(type, value, path) {
  if (type === 'binary' && typeof value === 'string') {
    if (!BASE64.test(value)) throw failAt(path, 'expected binary data or base64 text');
    return Buffer.from(value, 'base64');
  }
  if (type === 'float' && typeof value === 'string' && NON_FINITE.has(value)) return NON_FINITE.get(value);
  const v = normalizeValue(type, value, path);
  return type === 'json' ? JSON.stringify(v) : v;
}

/** A nested value checked and converted before any buffer takes it: reused row after row (see NestedBuffer). */
export function nestedStage() {
  return { values: [], lengths: [], vi: 0, li: 0, bytes: 0 };
}

/**
 * A list or object column (or field, or a list's items) being written (spec 5.4). A value is first checked and
 * converted into a stage (`stage`), then added from it (`add`): a value that fails leaves every buffer as it was, so
 * its row is refused whole, as a row with any other bad value is.
 */
class NestedBuffer extends ColumnBuffer {
  constructor(column, maxRows, path) {
    super(column.type, maxRows);
    this.column = column;
    this.path = path;
    this.scratch = new ByteWriter(1024); // this column's part streams, while its own stream is written
    if (column.type === 'list') {
      this.itemPath = `${path}[]`;
      this.lengths = new NumberColumn('int', maxRows);
      // A chunk may hold more items than rows: their text keeps a dictionary until it is written.
      this.items = columnBuffer(column.item.type, Infinity, column.item, this.itemPath);
    } else {
      this.fieldPaths = column.fields.map((f) => `${path}.${f.name}`);
      this.fieldBuffers = column.fields.map((f, i) => columnBuffer(f.type, maxRows, f, this.fieldPaths[i]));
      this.names = new Set(column.fields.map((f) => f.name));
    }
  }

  /** Checks and converts `value` (not null) into `stage`, adding nothing. */
  stage(value, stage) {
    if (this.lengths) {
      if (!Array.isArray(value)) throw failAt(this.path, `expected a list (an array), got ${kindOf(value)}`);
      stage.lengths.push(value.length);
      for (let i = 0; i < value.length; i++) this.#stageChild(this.items, this.column.item, value[i], this.itemPath, stage);
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date || ArrayBuffer.isView(value)) {
      throw failAt(this.path, `expected an object, got ${kindOf(value)}`);
    }
    for (const name of Object.keys(value)) if (!this.names.has(name)) throw failAt(this.path, `'${name}' is not one of its fields`);
    const fields = this.column.fields;
    for (let i = 0; i < fields.length; i++) {
      const name = fields[i].name;
      this.#stageChild(this.fieldBuffers[i], fields[i], Object.hasOwn(value, name) ? value[name] : undefined, this.fieldPaths[i], stage);
    }
  }

  #stageChild(buffer, column, value, path, stage) {
    if (value === null || value === undefined) {
      if (!column.nullable) throw failAt(path, 'is not nullable');
      stage.values.push(null);
    } else if (buffer instanceof NestedBuffer) {
      stage.values.push(PRESENT);
      buffer.stage(value, stage);
    } else {
      const v = leafValue(column.type, value, path);
      stage.values.push(v);
      stage.bytes += typeof v === 'string' ? v.length + 1 : v instanceof Uint8Array ? v.length + 2 : 5;
    }
  }

  /** Adds a staged value (taken in the order `stage` put it: nothing here can fail). */
  add(stage) {
    if (this.lengths) {
      const n = stage.lengths[stage.li++];
      this.lengths.add(n);
      for (let i = 0; i < n; i++) NestedBuffer.#addChild(this.items, stage);
    } else {
      for (const buffer of this.fieldBuffers) NestedBuffer.#addChild(buffer, stage);
    }
    this.rows++;
  }

  static #addChild(buffer, stage) {
    const v = stage.values[stage.vi++];
    if (v === null) buffer.addNull();
    else if (v === PRESENT) buffer.add(stage);
    else buffer.add(v);
  }

  writeBody(w) {
    if (this.lengths) {
      this.lengths.encode(w, this.scratch);
      this.items.encode(w, this.scratch);
    } else {
      for (const buffer of this.fieldBuffers) buffer.encode(w, this.scratch);
    }
    return ENCODING.nested;
  }

  reset() {
    super.reset();
    this.lengths?.reset();
    this.items?.reset();
    if (this.fieldBuffers) for (const buffer of this.fieldBuffers) buffer.reset();
  }
}

/**
 * A typed buffer for one column of type `type`, for chunks of at most `maxRows` rows. A list or object column needs
 * its definition (`column`); `path` names it in messages (as "lines[].sku").
 */
export function columnBuffer(type, maxRows, column = null, path = column?.name) {
  switch (type) {
    case 'int':
    case 'datetime':
    case 'float': return new NumberColumn(type, maxRows);
    case 'bool': return new BoolColumn(type, maxRows);
    case 'decimal':
    case 'string': return new StringColumn(type, maxRows);
    case 'list':
    case 'object': return new NestedBuffer(column, maxRows, path);
    default: return new ValueColumn(type, maxRows);
  }
}

const chunkOut = new ByteWriter(64 * 1024);
const streamBody = new ByteWriter(16 * 1024);

/**
 * Encodes one chunk payload from column buffers (same bytes as `encodeColumnar`), then resets them.
 * The result is a view of a reused buffer: valid until the next call (callers compress or copy it at once).
 */
export function encodeColumnBuffers(buffers) {
  const out = chunkOut;
  const body = streamBody;
  out.length = 0;
  for (const b of buffers) {
    b.encode(out, body);
    b.reset();
  }
  return out.toBuffer();
}

// ---- reading -----------------------------------------------------------------------------------

const toPublic = {
  datetime: dateFromMs,
  binary: (b) => Buffer.from(b),
  json: (text) => parseJsonText(text, 'A json value'),
};

function readPlain(r, type) {
  switch (type) {
    case 'bool': return r.byte() !== 0;
    case 'int': return r.varInt();
    case 'datetime': return dateFromMs(r.varInt());
    case 'float': return r.float64();
    case 'binary': return Buffer.from(r.blob());
    case 'json': return parseJsonText(r.string(), 'A json value');
    case 'decimal': return readDecimal(r);
    default: return r.string();
  }
}

/** Passes over a plain value of a row no one reads: text, decimals, json and binary are not made. */
function skipPlain(r, type) {
  if (type === 'decimal') skipDecimal(r);
  else r.skip(r.varUint()); // string, json and binary: a length, then bytes
  return undefined;
}

const MADE_PER_ROW = new Set(['string', 'decimal', 'json', 'binary']); // values worth skipping for rows not returned

/**
 * Decodes a columnar payload into one array per column (public value forms, null for null).
 * `types[j]` is column j's type, or for a list or object column its definition (with `item` or `fields`).
 * `wanted[j] === false` skips column j without decoding it. With `datesAsMs`, datetimes are milliseconds since 1970
 * instead of Date objects (for column arrays: no object per value). With `rows` (by row: truthy for the rows a query
 * returns), plain text, decimal, json and binary values, and lists and objects, are made only for those rows; the
 * others are left undefined.
 */
export function decodeColumnar(raw, types, rowCount, ordinal, wanted, datesAsMs = false, rows = null) {
  // Every column stream holds at least one bit per row (a null bitmap or values): a larger row count is damage,
  // caught before allocating for it.
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || (rowCount > 0 && rowCount > raw.length * 8)) {
    throw new JazminFormatError(`Chunk ${ordinal}: row count does not match its size`);
  }
  const reader = new ByteReader(raw);
  const columns = new Array(types.length);
  for (let j = 0; j < types.length; j++) {
    const length = reader.varUint();
    if (typeof length !== 'number' || length < 1) throw new JazminFormatError(`Chunk ${ordinal}: invalid stream length`);
    const end = reader.pos + length;
    if (end > raw.length) throw new JazminFormatError(`Chunk ${ordinal}: stream runs past the payload`);
    if (!wanted || wanted[j]) columns[j] = decodeStream(raw, reader.pos, end, types[j], rowCount, ordinal, datesAsMs, rows);
    reader.skip(length);
  }
  if (!reader.eof) throw new JazminFormatError(`Chunk ${ordinal} has trailing bytes`);
  return columns;
}

/**
 * One stream, raw[start, end) after its length: flags, null bitmap and body over `rowCount` entries (a chunk's rows,
 * or the entries of a nested column's part). Returns one value per entry, null for null.
 */
function decodeStream(raw, start, end, type, rowCount, ordinal, datesAsMs, rows) {
  const stream = new ByteReader(raw.subarray(0, end), start);
  const flags = stream.byte();
  const encoding = flags & 0x0f;
  const column = typeof type === 'object' ? type : null; // a list or object
  if (column) type = column.type;
  if (flags & 0xe0) throw new JazminFormatError(`Chunk ${ordinal}: reserved stream flags are set`);
  if (!ALLOWED[type]?.includes(encoding)) throw new JazminFormatError(`Chunk ${ordinal}: encoding ${encoding} is not valid for a ${type} column`);
  let nulls = null;
  if (flags & HAS_NULLS) nulls = stream.bytes((rowCount + 7) >> 3);
  if (column) return decodeNested(stream, end, column, rowCount, nulls, ordinal, rows);
  const isNull = (r) => nulls !== null && (nulls[r >> 3] & (1 << (r & 7))) !== 0;
  let count = rowCount;
  if (nulls) for (let r = 0; r < rowCount; r++) if (isNull(r)) count--;

  const values = new Array(count);
  switch (encoding) {
    case ENCODING.plain:
      if (datesAsMs && type === 'datetime') for (let i = 0; i < count; i++) values[i] = msFromFile(stream.varInt());
      else if (rows && MADE_PER_ROW.has(type)) {
        for (let r = 0, i = 0; i < count; r++) {
          if (isNull(r)) continue;
          values[i++] = rows[r] ? readPlain(stream, type) : skipPlain(stream, type);
        }
      } else for (let i = 0; i < count; i++) values[i] = readPlain(stream, type);
      break;
    case ENCODING.delta: {
      let prev = 0;
      for (let i = 0; i < count; i++) {
        const d = stream.varInt();
        const v = i === 0 ? d : typeof prev === 'number' && typeof d === 'number' && Number.isSafeInteger(prev + d) ? prev + d : normalizeBigInt(BigInt(prev) + BigInt(d));
        values[i] = v;
        prev = v;
      }
      if (type === 'datetime') {
        if (datesAsMs) for (let i = 0; i < count; i++) msFromFile(values[i]);
        else for (let i = 0; i < count; i++) values[i] = toPublic.datetime(values[i]);
      }
      break;
    }
    case ENCODING.dictionary: {
      const k = stream.varUint();
      // Each entry takes at least one byte.
      if (typeof k !== 'number' || k < 1 || k > end - stream.pos) throw new JazminFormatError(`Chunk ${ordinal}: invalid dictionary size`);
      const entries = new Array(k);
      for (let i = 0; i < k; i++) entries[i] = type === 'decimal' ? readDecimal(stream) : stream.string();
      for (let i = 0; i < count; i++) {
        const id = stream.varUint();
        if (typeof id !== 'number' || id >= k) throw new JazminFormatError(`Chunk ${ordinal}: dictionary index out of range`);
        values[i] = entries[id];
      }
      break;
    }
    case ENCODING.bitmap: {
      const bits = stream.bytes((count + 7) >> 3);
      for (let i = 0; i < count; i++) values[i] = (bits[i >> 3] & (1 << (i & 7))) !== 0;
      break;
    }
    case ENCODING.scaled:
      for (let i = 0; i < count; i++) {
        const s = stream.byte();
        if (s === 255) values[i] = stream.float64();
        else if (s <= 22) {
          const m = stream.varInt();
          if (typeof m !== 'number' || Math.abs(m) > 2 ** 53) throw new JazminFormatError(`Chunk ${ordinal}: scaled value out of range`);
          values[i] = m / POW10[s];
        } else throw new JazminFormatError(`Chunk ${ordinal}: invalid scale ${s}`);
      }
      break;
    default:
      throw new JazminFormatError(`Chunk ${ordinal}: unknown encoding ${encoding}`);
  }
  if (stream.pos !== end) throw new JazminFormatError(`Chunk ${ordinal}: stream length does not match its contents`);

  if (!nulls) return values;
  const full = new Array(rowCount);
  for (let r = 0, i = 0; r < rowCount; r++) full[r] = isNull(r) ? null : values[i++];
  return full;
}

/** Where the part stream that starts at `stream.pos` (its length first) ends; the stream is moved to its start. */
function partEnd(stream, end, ordinal) {
  const length = stream.varUint();
  if (typeof length !== 'number' || length < 1 || stream.pos + length > end) throw new JazminFormatError(`Chunk ${ordinal}: invalid stream length`);
  return stream.pos + length;
}

/**
 * A part of a nested column: `entries` entries in raw[start, end) (every entry takes at least one bit). With [lo, hi)
 * narrower than all entries, only those are decoded and returned (value e at e - lo); otherwise all, with `rows`.
 */
function decodePart(raw, start, end, column, entries, ordinal, rows, lo = 0, hi = entries) {
  if (entries > (end - start) * 8 + 8) throw new JazminFormatError(`Chunk ${ordinal}: column part '${column.name}': entry count does not match its size`);
  const nested = column.type === 'list' || column.type === 'object';
  if (lo === 0 && hi === entries) return decodeStream(raw, start, end, nested ? column : column.type, entries, ordinal, false, rows);
  if (!nested) return decodeRange(raw, start, end, column.type, entries, lo, hi, ordinal);
  const stream = new ByteReader(raw.subarray(0, end), start);
  const flags = stream.byte();
  if ((flags & 0x0f) !== ENCODING.nested || (flags & 0xe0)) throw new JazminFormatError(`Chunk ${ordinal}: encoding ${flags & 0x0f} is not valid for a ${column.type} column`);
  const nulls = flags & HAS_NULLS ? stream.bytes((entries + 7) >> 3) : null;
  return decodeNested(stream, end, column, entries, nulls, ordinal, null, lo, hi);
}

const bit = (bits, i) => (bits[i >> 3] & (1 << (i & 7))) !== 0;

/** Passes over one plain value of a type, making nothing. */
function skipValue(r, type) {
  switch (type) {
    case 'bool': r.byte(); break;
    case 'int':
    case 'datetime': r.varInt(); break;
    case 'float': r.float64(); break;
    case 'decimal': skipDecimal(r); break;
    default: r.skip(r.varUint()); // string, json and binary: a length, then bytes
  }
}

/**
 * Entries [from, to) of one leaf stream at raw[start, end), as to - from values: values before `from` are passed over
 * without being made, and later ones are not read, so a lookup costs little more than its own values. The rest of the
 * stream is not checked (decodeStream decodes and checks whole streams).
 */
function decodeRange(raw, start, end, type, entries, from, to, ordinal) {
  const stream = new ByteReader(raw.subarray(0, end), start);
  const flags = stream.byte();
  const encoding = flags & 0x0f;
  if (flags & 0xe0) throw new JazminFormatError(`Chunk ${ordinal}: reserved stream flags are set`);
  if (!ALLOWED[type]?.includes(encoding)) throw new JazminFormatError(`Chunk ${ordinal}: encoding ${encoding} is not valid for a ${type} column`);
  const nulls = flags & HAS_NULLS ? stream.bytes((entries + 7) >> 3) : null;
  const isNull = (r) => nulls !== null && bit(nulls, r);
  const out = new Array(to - from).fill(null);
  switch (encoding) {
    case ENCODING.plain:
      for (let r = 0; r < to; r++) {
        if (isNull(r)) continue;
        if (r >= from) out[r - from] = readPlain(stream, type);
        else skipValue(stream, type);
      }
      break;
    case ENCODING.delta: {
      let previous = 0;
      let first = true;
      for (let r = 0; r < to; r++) {
        if (isNull(r)) continue;
        const d = stream.varInt();
        previous = first ? d : typeof previous === 'number' && typeof d === 'number' && Number.isSafeInteger(previous + d) ? previous + d : normalizeBigInt(BigInt(previous) + BigInt(d));
        first = false;
        if (r >= from) out[r - from] = type === 'datetime' ? dateFromMs(previous) : previous;
      }
      break;
    }
    case ENCODING.dictionary: {
      // Where each entry starts; only the entries these values use become text, once each.
      const k = stream.varUint();
      if (typeof k !== 'number' || k < 1 || k > end - stream.pos) throw new JazminFormatError(`Chunk ${ordinal}: invalid dictionary size`);
      const offsets = new Uint32Array(k);
      for (let i = 0; i < k; i++) {
        offsets[i] = stream.pos;
        skipValue(stream, type);
      }
      const made = new Map();
      for (let r = 0; r < to; r++) {
        if (isNull(r)) continue;
        const id = stream.varUint();
        if (typeof id !== 'number' || id >= k) throw new JazminFormatError(`Chunk ${ordinal}: dictionary index out of range`);
        if (r < from) continue;
        let text = made.get(id);
        if (text === undefined) {
          const entry = new ByteReader(stream.buf, offsets[id]);
          made.set(id, (text = type === 'decimal' ? readDecimal(entry) : entry.string()));
        }
        out[r - from] = text;
      }
      break;
    }
    case ENCODING.bitmap: {
      let count = entries;
      if (nulls) for (let r = 0; r < entries; r++) if (isNull(r)) count--;
      const bits = stream.bytes((count + 7) >> 3);
      for (let r = 0, i = 0; r < to; r++) {
        if (isNull(r)) continue;
        if (r >= from) out[r - from] = bit(bits, i);
        i++;
      }
      break;
    }
    case ENCODING.scaled:
      for (let r = 0; r < to; r++) {
        if (isNull(r)) continue;
        const s = stream.byte();
        let v;
        if (s === 255) v = stream.float64();
        else if (s <= 22) {
          const m = stream.varInt();
          if (typeof m !== 'number' || Math.abs(m) > 2 ** 53) throw new JazminFormatError(`Chunk ${ordinal}: scaled value out of range`);
          v = m / POW10[s];
        } else throw new JazminFormatError(`Chunk ${ordinal}: invalid scale ${s}`);
        if (r >= from) out[r - from] = v;
      }
      break;
    default:
      throw new JazminFormatError(`Chunk ${ordinal}: unknown encoding ${encoding}`);
  }
  return out;
}

/** A list's lengths: an int stream (plain or delta) without nulls, one length per list that is not null. */
function decodeLengths(raw, start, end, count, ordinal) {
  const stream = new ByteReader(raw.subarray(0, end), start);
  const flags = stream.byte();
  const encoding = flags & 0x0f;
  const bad = () => new JazminFormatError(`Chunk ${ordinal}: list lengths are not valid`);
  if ((flags & 0xf0) !== 0 || (encoding !== ENCODING.plain && encoding !== ENCODING.delta)) throw bad();
  if (count > end - stream.pos) throw bad(); // a length takes at least one byte
  const lengths = new Array(count);
  let previous = 0;
  for (let k = 0; k < count; k++) {
    let v = stream.varInt();
    if (typeof v !== 'number') throw bad();
    if (encoding === ENCODING.delta && k > 0) v += previous;
    if (!Number.isSafeInteger(v) || v < 0) throw bad();
    lengths[k] = previous = v;
  }
  if (stream.pos !== end) throw new JazminFormatError(`Chunk ${ordinal}: stream length does not match its contents`);
  return lengths;
}

// Field names -> (part values, index) => object. Readers make new definitions each time a file is opened: kept by
// names, so a builder is compiled once, and emptied when files bring very many different ones.
const objectMakers = new Map();

/** A field this chunk has no stream for (added after it was written, spec 5.4): null for each entry. */
function missingField(field, count, ordinal) {
  if (!field.nullable) throw new JazminFormatError(`Chunk ${ordinal}: field '${field.name}' may not be null but has no stream`);
  return new Array(count).fill(null);
}

/** Builds an object of a definition's fields from their decoded parts: compiled once per list of field names. */
function objectMaker(column) {
  const names = column.fields.map((f) => f.name);
  const key = JSON.stringify(names);
  let make = objectMakers.get(key);
  if (make) return make;
  if (objectMakers.size >= 1000) objectMakers.clear();
  if (!names.includes('__proto__')) {
    try {
      make = new Function('p', 'k', `return { ${names.map((name, i) => `${JSON.stringify(name)}: p[${i}][k]`).join(', ')} };`);
    } catch {
      make = null;
    }
  }
  make ??= (parts, k) => {
    const object = {};
    for (let i = 0; i < names.length; i++) setField(object, names[i], parts[i][k]);
    return object;
  };
  objectMakers.set(key, make);
  return make;
}

/**
 * A list or object column's values (spec 5.4), from its body at `stream.pos`: each list as an array of its items, each
 * object with every field. With `rows`, values are made only for those entries: when they are few and close together
 * (a lookup), only their slice of each part is decoded; otherwise every entry, with text made only for theirs.
 * A part decoded for entries [lo, hi) only returns those (value e at e - lo); otherwise one value per entry.
 */
function decodeNested(stream, end, column, entries, nulls, ordinal, rows, lo = 0, hi = entries) {
  const raw = stream.buf;
  const isNull = (e) => nulls !== null && bit(nulls, e);
  const base = lo; // where this node's output starts (0 for a column)
  if (rows) {
    let first = -1;
    let last = -1;
    for (let e = 0; e < entries; e++) {
      if (!rows[e]) continue;
      if (first < 0) first = e;
      last = e;
    }
    if (first < 0) [lo, hi] = [0, 0];
    else if ((last + 1 - first) * 4 <= entries) [lo, hi] = [first, last + 1]; // a slice
  }
  const sliced = lo > 0 || hi < entries;
  // Ranks among the entries that are not null: before lo, and before hi; and all of them.
  let present = 0;
  let kLo = 0;
  let kHi = 0;
  for (let e = 0; e < entries; e++) {
    if (e === lo) kLo = present;
    if (e === hi) kHi = present;
    if (!isNull(e)) present++;
  }
  if (lo >= entries) kLo = present;
  if (hi >= entries) kHi = present;
  let partRows = null; // by present entry: wanted (whole parts only)
  if (rows && !sliced) {
    partRows = new Uint8Array(present);
    for (let e = 0, k = 0; e < entries; e++) if (!isNull(e)) partRows[k++] = rows[e] ? 1 : 0;
  }
  const out = new Array(base === 0 ? entries : hi - lo);
  const wanted = (e) => !rows || rows[e];
  if (column.type === 'list') {
    const lengthsEnd = partEnd(stream, end, ordinal);
    const lengths = decodeLengths(raw, stream.pos, lengthsEnd, present, ordinal);
    stream.pos = lengthsEnd;
    let total = 0;
    let itemLo = 0;
    let itemHi = 0;
    for (let k = 0; k < present; k++) {
      if (k === kLo) itemLo = total;
      if (k === kHi) itemHi = total;
      total += lengths[k];
    }
    if (kLo >= present) itemLo = total;
    if (kHi >= present) itemHi = total;
    if (total > MAX_ITEMS) throw new JazminFormatError(`Chunk ${ordinal}: too many list items`);
    let itemRows = null;
    if (partRows) {
      itemRows = new Uint8Array(total);
      for (let k = 0, at = 0; k < present; at += lengths[k++]) if (partRows[k]) itemRows.fill(1, at, at + lengths[k]);
    }
    const itemsEnd = partEnd(stream, end, ordinal);
    const items = sliced
      ? decodePart(raw, stream.pos, itemsEnd, column.item, total, ordinal, null, itemLo, itemHi)
      : decodePart(raw, stream.pos, itemsEnd, column.item, total, ordinal, itemRows);
    stream.pos = itemsEnd;
    const itemBase = sliced ? itemLo : 0;
    for (let e = lo, k = kLo, at = itemLo; e < hi; e++) {
      if (isNull(e)) {
        out[e - base] = null;
        continue;
      }
      const n = lengths[k];
      if (wanted(e)) out[e - base] = items.slice(at - itemBase, at - itemBase + n);
      at += n;
      k++;
    }
  } else {
    const parts = column.fields.map((field) => {
      if (stream.pos === end) return missingField(field, sliced ? kHi - kLo : present, ordinal); // added since (spec 5.4)
      const partEndAt = partEnd(stream, end, ordinal);
      const values = sliced
        ? decodePart(raw, stream.pos, partEndAt, field, present, ordinal, null, kLo, kHi)
        : decodePart(raw, stream.pos, partEndAt, field, present, ordinal, partRows);
      stream.pos = partEndAt;
      return values;
    });
    const make = objectMaker(column);
    const partBase = sliced ? kLo : 0;
    for (let e = lo, k = kLo; e < hi; e++) {
      if (isNull(e)) {
        out[e - base] = null;
        continue;
      }
      if (wanted(e)) out[e - base] = make(parts, k - partBase);
      k++;
    }
  }
  if (stream.pos !== end) throw new JazminFormatError(`Chunk ${ordinal}: stream length does not match its contents`);
  return out;
}
