// A small, strict DER reader (spec 6.9.4: certificates are read with our own parser, no general X.509 processing).
// Definite, minimal lengths only; single-byte tags; no BER.

export const TAG = Object.freeze({
  BOOLEAN: 0x01, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, UTF8: 0x0c,
  PRINTABLE: 0x13, IA5: 0x16, UTC_TIME: 0x17, GENERALIZED_TIME: 0x18, SEQUENCE: 0x30, SET: 0x31,
});

const STRING_TAGS = new Set([TAG.UTF8, TAG.PRINTABLE, TAG.IA5]);

export class DerError extends Error {}

/** One element: its tag, and where its header, contents and end are in `buf`. */
function element(buf, pos, end) {
  if (pos + 2 > end) throw new DerError('DER: truncated');
  const tag = buf[pos];
  if ((tag & 0x1f) === 0x1f) throw new DerError('DER: multi-byte tag');
  let length = buf[pos + 1];
  let body = pos + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4) throw new DerError('DER: indefinite or oversized length');
    if (body + n > end || buf[body] === 0) throw new DerError('DER: length is not minimal');
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[body + i];
    if (length < 0x80) throw new DerError('DER: length is not minimal');
    body += n;
  }
  if (body + length > end) throw new DerError('DER: truncated');
  return { tag, start: pos, body, end: body + length, buf };
}

/** Reads the elements of a constructed value (or a whole buffer) in order. */
export class DerReader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  static of(el) {
    return new DerReader(el.buf, el.body, el.end);
  }

  get more() {
    return this.pos < this.end;
  }

  peek() {
    return this.pos < this.end ? this.buf[this.pos] : -1;
  }

  next(tag) {
    const el = element(this.buf, this.pos, this.end);
    if (tag !== undefined && el.tag !== tag) throw new DerError(`DER: expected tag 0x${tag.toString(16)}, found 0x${el.tag.toString(16)}`);
    this.pos = el.end;
    return el;
  }

  /** The next element when it has this tag, else null. */
  optional(tag) {
    return this.peek() === tag ? this.next(tag) : null;
  }

  /** The reader over the next element's contents (SEQUENCE by default). */
  sequence(tag = TAG.SEQUENCE) {
    return DerReader.of(this.next(tag));
  }

  done() {
    if (this.pos !== this.end) throw new DerError('DER: unexpected data');
  }
}

export const raw = (el) => el.buf.subarray(el.start, el.end);
export const contents = (el) => el.buf.subarray(el.body, el.end);

/** Parses one element that fills `buf` exactly. */
export function parseOne(buf, tag) {
  const r = new DerReader(buf);
  const el = r.next(tag);
  r.done();
  return el;
}

export function oid(el) {
  if (el.tag !== TAG.OID) throw new DerError('DER: expected an object identifier');
  const b = contents(el);
  if (b.length === 0) throw new DerError('DER: empty object identifier');
  const arcs = [];
  let value = 0n;
  let started = false;
  for (let i = 0; i < b.length; i++) {
    if (!started && b[i] === 0x80) throw new DerError('DER: object identifier is not minimal');
    started = true;
    value = (value << 7n) | BigInt(b[i] & 0x7f);
    if ((b[i] & 0x80) === 0) {
      if (arcs.length === 0) {
        const first = value < 40n ? 0n : value < 80n ? 1n : 2n;
        arcs.push(first, value - first * 40n);
      } else arcs.push(value);
      value = 0n;
      started = false;
    } else if (i === b.length - 1) throw new DerError('DER: truncated object identifier');
  }
  return arcs.join('.');
}

/** An INTEGER's contents (two's complement, minimal). */
export function integerBytes(el) {
  if (el.tag !== TAG.INTEGER) throw new DerError('DER: expected an integer');
  const b = contents(el);
  if (b.length === 0) throw new DerError('DER: empty integer');
  if (b.length > 1 && ((b[0] === 0 && b[1] < 0x80) || (b[0] === 0xff && b[1] >= 0x80))) throw new DerError('DER: integer is not minimal');
  return b;
}

/** A small non-negative INTEGER as a number. */
export function smallInteger(el) {
  const b = integerBytes(el);
  if (b[0] & 0x80 || b.length > 6) throw new DerError('DER: integer out of range');
  let n = 0;
  for (const x of b) n = n * 256 + x;
  return n;
}

export function boolean(el) {
  const b = contents(el);
  if (el.tag !== TAG.BOOLEAN || b.length !== 1 || (b[0] !== 0 && b[0] !== 0xff)) throw new DerError('DER: invalid boolean');
  return b[0] === 0xff;
}

/** A BIT STRING: its bytes and the number of unused bits in the last one. */
export function bitString(el) {
  const b = contents(el);
  if (el.tag !== TAG.BIT_STRING || b.length === 0 || b[0] > 7 || (b.length === 1 && b[0] !== 0)) throw new DerError('DER: invalid bit string');
  const bytes = b.subarray(1);
  if (b[0] && bytes[bytes.length - 1] & ((1 << b[0]) - 1)) throw new DerError('DER: bit string has unused bits set');
  return { unused: b[0], bytes };
}

export function octets(el) {
  if (el.tag !== TAG.OCTET_STRING) throw new DerError('DER: expected an octet string');
  return contents(el);
}

export function string(el) {
  if (!STRING_TAGS.has(el.tag)) throw new DerError('DER: unsupported string type');
  return contents(el).toString(el.tag === TAG.UTF8 ? 'utf8' : 'latin1');
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSS[.fff]Z), as milliseconds since 1970. */
export function time(el) {
  const s = contents(el).toString('latin1');
  let m;
  let year;
  if (el.tag === TAG.UTC_TIME && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) {
    year = Number(m[1]);
    year += year < 50 ? 2000 : 1900;
  } else if (el.tag === TAG.GENERALIZED_TIME && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d*[1-9]))?Z$/.exec(s))) {
    year = Number(m[1]);
  } else throw new DerError('DER: invalid time');
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  const t = Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
  const d = new Date(t);
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3]) || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) {
    throw new DerError('DER: invalid time');
  }
  return t;
}
