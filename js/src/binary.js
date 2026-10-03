import zlib from 'node:zlib';
import { JazminFormatError } from './errors.js';

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const SMALL_INT_LIMIT = 2 ** 52;

/** Returns a number when the BigInt fits safely, otherwise the BigInt itself. */
export function normalizeBigInt(value) {
  return value >= -MAX_SAFE_BIG && value <= MAX_SAFE_BIG ? Number(value) : value;
}

/** Growable little-endian byte buffer. */
export class ByteWriter {
  constructor(initialSize = 1024) {
    this.buf = Buffer.allocUnsafe(initialSize);
    this.length = 0;
  }

  #ensure(extra) {
    const needed = this.length + extra;
    if (needed <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < needed) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  byte(value) {
    this.#ensure(1);
    this.buf[this.length++] = value;
  }

  bytes(source) {
    this.#ensure(source.length);
    this.buf.set(source, this.length);
    this.length += source.length;
  }

  /** Appends `count` zero bytes and returns their offset (e.g. a null bitmap filled in later). */
  reserve(count) {
    this.#ensure(count);
    const at = this.length;
    this.buf.fill(0, at, at + count);
    this.length += count;
    return at;
  }

  u16(value) {
    this.#ensure(2);
    this.buf.writeUInt16LE(value, this.length);
    this.length += 2;
  }

  float64(value) {
    this.#ensure(8);
    this.buf.writeDoubleLE(value, this.length);
    this.length += 8;
  }

  /** Unsigned LEB128 varint. Accepts a non-negative safe integer or BigInt. */
  varUint(value) {
    if (typeof value === 'bigint') {
      this.#ensure(10);
      while (value >= 0x80n) {
        this.buf[this.length++] = Number(value & 0x7fn) | 0x80;
        value >>= 7n;
      }
      this.buf[this.length++] = Number(value);
      return;
    }
    this.#ensure(10);
    while (value >= 0x80) {
      this.buf[this.length++] = (value % 128) | 0x80;
      value = Math.floor(value / 128);
    }
    this.buf[this.length++] = value;
  }

  /** Signed varint using ZigZag encoding (64-bit range). */
  varInt(value) {
    if (typeof value === 'number' && Math.abs(value) < SMALL_INT_LIMIT) {
      this.varUint(value >= 0 ? value * 2 : -value * 2 - 1);
      return;
    }
    const big = BigInt(value);
    this.varUint(big >= 0n ? big << 1n : ((-big) << 1n) - 1n);
  }

  /** varint length prefix followed by UTF-8 bytes. */
  string(value) {
    const size = Buffer.byteLength(value, 'utf8');
    this.varUint(size);
    this.#ensure(size);
    this.buf.write(value, this.length, size, 'utf8');
    this.length += size;
  }

  blob(value) {
    this.varUint(value.length);
    this.bytes(value);
  }

  toBuffer() {
    return this.buf.subarray(0, this.length);
  }
}

/** Parses JSON text read from a file; malformed text is a format error. */
export function parseJsonText(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new JazminFormatError(`${what} is not valid JSON`);
  }
}

const MAX_DATE_MS = 8.64e15; // the range of JavaScript dates

/** A datetime read from a file (ms since 1970), checked to be one JavaScript can represent. */
export function dateFromMs(ms) {
  if (typeof ms !== 'number' || !(Math.abs(ms) <= MAX_DATE_MS)) throw new JazminFormatError('A datetime value is out of range');
  return new Date(ms);
}

// Buffer#utf8Slice skips the argument handling of toString(); fall back where it is missing.
const utf8Slice = typeof Buffer.prototype.utf8Slice === 'function'
  ? (buf, start, end) => buf.utf8Slice(start, end)
  : (buf, start, end) => buf.toString('utf8', start, end);

/** Sequential little-endian reader over a Buffer. */
export class ByteReader {
  // One instance that stays alive, so V8 keeps this class's object shape through full garbage collections. Without
  // it, readers are short-lived, the shape dies at a full collection, the optimised decoders built on it are thrown
  // away, and the next read runs unoptimised: an index lookup took about 6 ms instead of 2.
  static #keepShape = new ByteReader(Buffer.alloc(0));

  constructor(buf, position = 0) {
    this.buf = buf;
    this.pos = position;
  }

  get eof() {
    return this.pos >= this.buf.length;
  }

  #need(count) {
    // A length read from damaged data may be a BigInt or negative: it is checked here, before any use.
    if (typeof count !== 'number' || count < 0 || this.pos + count > this.buf.length) throw new JazminFormatError('Unexpected end of data');
  }

  /** Bytes left to read. */
  get remaining() {
    return this.buf.length - this.pos;
  }

  byte() {
    this.#need(1);
    return this.buf[this.pos++];
  }

  /** Advances past `count` bytes and returns their start offset (read them in place from `buf`). */
  skip(count) {
    this.#need(count);
    const at = this.pos;
    this.pos += count;
    return at;
  }

  bytes(count) {
    this.#need(count);
    const out = this.buf.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  u16() {
    this.#need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  float64() {
    this.#need(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  varUint() {
    const start = this.pos;
    let result = 0;
    let multiplier = 1;
    let count = 0;
    let b;
    do {
      if (count === 10) throw new JazminFormatError('Varint too long');
      this.#need(1);
      b = this.buf[this.pos++];
      result += (b & 0x7f) * multiplier;
      multiplier *= 128;
      count++;
    } while (b & 0x80);
    if (count <= 7) return result; // at most 49 bits: exact as a double
    let big = 0n;
    let shift = 0n;
    for (let i = start; i < this.pos; i++) {
      big |= BigInt(this.buf[i] & 0x7f) << shift;
      shift += 7n;
    }
    return normalizeBigInt(big);
  }

  varInt() {
    const z = this.varUint();
    if (typeof z === 'number') return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    return normalizeBigInt(z & 1n ? -((z + 1n) >> 1n) : z >> 1n);
  }

  string() {
    const size = this.varUint();
    this.#need(size);
    const s = utf8Slice(this.buf, this.pos, this.pos + size);
    this.pos += size;
    return s;
  }

  blob() {
    return this.bytes(this.varUint());
  }
}

const CRC_TABLES = (() => {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tables[0][n] = c >>> 0;
  }
  for (let t = 1; t < 8; t++) {
    for (let n = 0; n < 256; n++) tables[t][n] = (tables[t - 1][n] >>> 8) ^ tables[0][tables[t - 1][n] & 0xff];
  }
  return tables;
})();

/** Reference byte-at-a-time CRC-32 (used by tests). */
export function crc32Bytewise(data) {
  const t0 = CRC_TABLES[0];
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = t0[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 computed 8 bytes at a time ("slicing-by-8"); fallback when zlib.crc32 is unavailable. */
export function crc32Sliced(data) {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
  let crc = 0xffffffff;
  let i = 0;
  for (const end = data.length - 8; i <= end; i += 8) {
    crc ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    crc = t7[crc & 0xff] ^ t6[(crc >>> 8) & 0xff] ^ t5[(crc >>> 16) & 0xff] ^ t4[crc >>> 24]
      ^ t3[data[i + 4]] ^ t2[data[i + 5]] ^ t1[data[i + 6]] ^ t0[data[i + 7]];
  }
  for (; i < data.length; i++) crc = t0[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 (IEEE 802.3, as used by ZIP/PNG). Uses Node's native implementation when available (Node 22+). */
export const crc32 = typeof zlib.crc32 === 'function' ? (data) => zlib.crc32(data) >>> 0 : crc32Sliced;
