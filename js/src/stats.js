import { ByteReader, ByteWriter } from './binary.js';
import { ORDERED_TYPES, compareKeys, decodeValue, encodeValue, toKey } from './types.js';

const MAX_STRING_STAT = 64;
const EMPTY = Buffer.alloc(0);

/** Collects one chunk's null count and min/max (key form) for one column (spec 6.4). */
// Types whose normalized values are their keys and compare with < and > (BigInts included; datetimes are ms).
const SIMPLE_KEYS = new Set(['bool', 'int', 'float', 'string', 'datetime']);

export class ColumnStats {
  constructor(type) {
    this.type = type;
    this.ordered = ORDERED_TYPES.has(type);
    this.simple = SIMPLE_KEYS.has(type);
    this.nulls = 0;
    this.min = undefined;
    this.max = undefined;
  }

  add(value) {
    if (value === null) {
      this.nulls++;
      return;
    }
    if (this.simple) {
      const key = value === 0 ? 0 : value; // fold -0 into 0
      if (key !== key) return; // NaN
      if (this.min === undefined) this.min = this.max = key;
      else if (key < this.min) this.min = key;
      else if (key > this.max) this.max = key;
      return;
    }
    if (!this.ordered) return;
    const key = toKey(this.type, value);
    if (Number.isNaN(key)) return;
    if (this.min === undefined || compareKeys(key, this.min) < 0) this.min = key;
    if (this.max === undefined || compareKeys(key, this.max) > 0) this.max = key;
  }

  /** The stored bounds: Buffers in key form, empty when unbounded (spec 6.4, 6.5). */
  bounds() {
    if (this.min === undefined) return { min: EMPTY, max: EMPTY };
    if (this.type === 'float' && (!Number.isFinite(this.min) || !Number.isFinite(this.max))) return { min: EMPTY, max: EMPTY };
    if (this.type === 'string') {
      // A prefix is still a lower bound; a truncated max would not be an upper bound.
      let min = this.min;
      if (min.length > MAX_STRING_STAT) {
        let end = MAX_STRING_STAT;
        const code = min.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--; // do not split a surrogate pair
        min = min.substring(0, end);
      }
      return { min: Buffer.from(min, 'utf8'), max: this.max.length > MAX_STRING_STAT ? EMPTY : Buffer.from(this.max, 'utf8') };
    }
    return { min: encodeBound(this.type, this.min), max: encodeBound(this.type, this.max) };
  }
}

/** Key-form bytes of a bound (spec 6.5): the value encoding, except strings, which are bare UTF-8. */
export function encodeBound(type, key) {
  if (type === 'string') return Buffer.from(key, 'utf8');
  const w = new ByteWriter(16);
  encodeValue(w, type, key);
  return Buffer.from(w.toBuffer());
}

export function decodeBound(type, bytes) {
  if (bytes.length === 0) return undefined;
  if (type === 'string') return bytes.toString('utf8');
  return toKey(type, type === 'datetime' ? new ByteReader(bytes).varInt() : decodeValue(new ByteReader(bytes), type));
}
