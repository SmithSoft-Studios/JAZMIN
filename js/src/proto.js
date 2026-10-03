// The Protocol Buffers wire format (spec 6): a small codec for the catalog messages of spec/jazmin.proto.
// Writers omit fields holding their default value (proto3); readers skip fields they do not know.
import { ByteWriter } from './binary.js';
import { JazminFormatError } from './errors.js';

const VARINT = 0;
const I64 = 1;
const LEN = 2;
const I32 = 5;

/** Builds one message. Numbers may be numbers or BigInts (uint64 above 2^53). */
export class ProtoWriter {
  constructor(size = 256) {
    this.w = new ByteWriter(size);
  }

  #tag(field, wire) {
    this.w.varUint(field * 8 + wire);
  }

  /** uint32 / uint64 / bool / enum; zero is omitted. */
  uint(field, value) {
    if (!value) return this;
    this.#tag(field, VARINT);
    this.w.varUint(typeof value === 'boolean' ? 1 : value);
    return this;
  }

  /** int64: negative values use 64-bit two's complement, as Protocol Buffers does. */
  int64(field, value) {
    if (!value) return this;
    this.#tag(field, VARINT);
    this.w.varUint(value < 0 ? BigInt.asUintN(64, BigInt(value)) : value);
    return this;
  }

  /** bytes / string; empty is omitted. */
  bytes(field, value) {
    if (!value || value.length === 0) return this;
    return this.always(field, value);
  }

  string(field, value) {
    return value ? this.bytes(field, Buffer.from(value, 'utf8')) : this;
  }

  /** A length-delimited value written even when empty (elements of repeated bytes and messages). */
  always(field, value) {
    const bytes = value instanceof ProtoWriter ? value.toBuffer() : value;
    this.#tag(field, LEN);
    this.w.varUint(bytes.length);
    this.w.bytes(bytes);
    return this;
  }

  /** A message field built by `build(writer)`; written even when empty when `always` is set. */
  message(field, build, always = false) {
    if (build === undefined || build === null) return this;
    const inner = new ProtoWriter();
    build(inner);
    if (inner.w.length === 0 && !always) return this;
    return this.always(field, inner);
  }

  /** Packed repeated varints. */
  packed(field, values) {
    if (!values || values.length === 0) return this;
    const inner = new ByteWriter(values.length * 2 + 8);
    for (const v of values) inner.varUint(v);
    this.#tag(field, LEN);
    this.w.varUint(inner.length);
    this.w.bytes(inner.toBuffer());
    return this;
  }

  toBuffer() {
    return this.w.toBuffer();
  }
}

function varint(buf, at) {
  let result = 0;
  let multiplier = 1;
  let pos = at;
  for (let n = 0; n < 10; n++) {
    if (pos >= buf.length) throw new JazminFormatError('Catalog message is truncated');
    const b = buf[pos++];
    if (n < 7) result += (b & 0x7f) * multiplier;
    else {
      // Past 49 bits: finish exactly with BigInt.
      let big = BigInt(result);
      let shift = 49n;
      let byte = b;
      let p = pos - 1;
      for (;;) {
        big |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
        if (!(byte & 0x80)) break;
        if (++p >= buf.length || shift > 70n) throw new JazminFormatError('Catalog varint is invalid');
        byte = buf[p];
      }
      return { value: big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big, next: p + 1 };
    }
    multiplier *= 128;
    if (!(b & 0x80)) return { value: result, next: pos };
  }
  throw new JazminFormatError('Catalog varint is too long');
}

/**
 * Calls `onField(field, value)` for each field of a message: varints as numbers (BigInt above 2^53),
 * length-delimited fields as Buffers (views). Fixed-width fields are skipped.
 */
export function readMessage(buf, onField) {
  if (!Buffer.isBuffer(buf)) throw new JazminFormatError('Catalog: a field has the wrong wire type');
  let pos = 0;
  while (pos < buf.length) {
    const tag = varint(buf, pos);
    pos = tag.next;
    if (typeof tag.value !== 'number') throw new JazminFormatError('Catalog message has an invalid field');
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (field === 0) throw new JazminFormatError('Catalog message has an invalid field');
    switch (wire) {
      case VARINT: {
        const v = varint(buf, pos);
        pos = v.next;
        onField(field, v.value);
        break;
      }
      case LEN: {
        const n = varint(buf, pos);
        pos = n.next;
        if (typeof n.value !== 'number' || pos + n.value > buf.length) throw new JazminFormatError('Catalog message is truncated');
        onField(field, buf.subarray(pos, pos + n.value));
        pos += n.value;
        break;
      }
      case I64:
        pos += 8;
        break;
      case I32:
        pos += 4;
        break;
      default:
        throw new JazminFormatError(`Catalog message uses an unsupported wire type ${wire}`);
    }
    if (pos > buf.length) throw new JazminFormatError('Catalog message is truncated');
  }
}

/** Packed varints (also accepts a single unpacked value, as the format allows). */
export function readPacked(value, out = []) {
  if (typeof value === 'number' || typeof value === 'bigint') {
    out.push(value);
    return out;
  }
  bytesOf(value);
  let pos = 0;
  while (pos < value.length) {
    const v = varint(value, pos);
    out.push(v.value);
    pos = v.next;
  }
  return out;
}

/** int64 from a varint (two's complement for negative values). */
export function toInt64(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'bigint') throw new JazminFormatError('Catalog: a field has the wrong wire type');
  const signed = BigInt.asIntN(64, value);
  return signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(signed) : signed;
}

/** A length-delimited field's bytes (a number here means the field had the wrong wire type). */
export function bytesOf(value) {
  if (!Buffer.isBuffer(value)) throw new JazminFormatError('Catalog: a field has the wrong wire type');
  return value;
}

export const text = (buf) => bytesOf(buf).toString('utf8');
