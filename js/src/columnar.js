// Columnar chunk layout (spec section 5.4): one stream per column, with per-type encodings.
import { ByteReader, ByteWriter, dateFromMs, msFromFile, normalizeBigInt, parseJsonText } from './binary.js';
import { readDecimal, writeDecimal } from './decimal.js';
import { JazminFormatError } from './errors.js';

export const ENCODING = Object.freeze({ plain: 0, delta: 1, dictionary: 2, bitmap: 3, scaled: 4 });
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
};
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

/** A typed buffer for one column of type `type`, for chunks of at most `maxRows` rows. */
export function columnBuffer(type, maxRows) {
  switch (type) {
    case 'int':
    case 'datetime':
    case 'float': return new NumberColumn(type, maxRows);
    case 'bool': return new BoolColumn(type, maxRows);
    case 'decimal':
    case 'string': return new StringColumn(type, maxRows);
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

/**
 * Decodes a columnar payload into one array per column (public value forms, null for null).
 * `wanted[j] === false` skips column j without decoding it. With `datesAsMs`, datetimes are milliseconds since 1970
 * instead of Date objects (for column arrays: no object per value).
 */
export function decodeColumnar(raw, types, rowCount, ordinal, wanted, datesAsMs = false) {
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
    if (wanted && !wanted[j]) {
      reader.skip(length);
      continue;
    }
    const stream = new ByteReader(raw.subarray(0, end), reader.pos);
    const flags = stream.byte();
    const encoding = flags & 0x0f;
    const type = types[j];
    if (flags & 0xe0) throw new JazminFormatError(`Chunk ${ordinal}: reserved stream flags are set`);
    if (!ALLOWED[type].includes(encoding)) throw new JazminFormatError(`Chunk ${ordinal}: encoding ${encoding} is not valid for a ${type} column`);
    let nulls = null;
    if (flags & HAS_NULLS) nulls = stream.bytes((rowCount + 7) >> 3);
    const isNull = (r) => nulls !== null && (nulls[r >> 3] & (1 << (r & 7))) !== 0;
    let count = rowCount;
    if (nulls) for (let r = 0; r < rowCount; r++) if (isNull(r)) count--;

    const values = new Array(count);
    switch (encoding) {
      case ENCODING.plain:
        if (datesAsMs && type === 'datetime') for (let i = 0; i < count; i++) values[i] = msFromFile(stream.varInt());
        else for (let i = 0; i < count; i++) values[i] = readPlain(stream, type);
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
        if (typeof k !== 'number' || k < 1) throw new JazminFormatError(`Chunk ${ordinal}: invalid dictionary size`);
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
    reader.skip(length);

    if (!nulls) columns[j] = values;
    else {
      const full = new Array(rowCount);
      for (let r = 0, i = 0; r < rowCount; r++) full[r] = isNull(r) ? null : values[i++];
      columns[j] = full;
    }
  }
  if (!reader.eof) throw new JazminFormatError(`Chunk ${ordinal} has trailing bytes`);
  return columns;
}
