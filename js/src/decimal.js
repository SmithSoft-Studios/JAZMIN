// Exact decimals (spec 5.1, 5.2): stored as a scale and an integer, read back as canonical text, ordered
// numerically. 12.50 is m = 1250, scale 2; its key form is (125, 1), so 12.5 and 12.50 compare equal.
import { JazminFormatError, JazminValidationError } from './errors.js';

const PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const MAX_SCALE = 255;
const MAX_DIGITS = 256;
const MAX_VARINT_BYTES = 132; // 256 digits need at most 851 bits (+1 for the sign): 122 bytes

/** Parses decimal text into { m: BigInt, s }; throws a validation error for anything else. */
export function parseDecimal(value, column = 'decimal') {
  const text = typeof value === 'number' ? String(value) : value;
  const match = typeof text === 'string' ? PATTERN.exec(text) : null;
  if (!match) throw new JazminValidationError(`Column '${column}': expected a decimal string like '-12.50', got '${value}'`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > MAX_SCALE) throw new JazminValidationError(`Column '${column}': more than ${MAX_SCALE} digits after the point`);
  const digits = (whole + fraction).replace(/^0+(?=\d)/, '');
  if (digits.length > MAX_DIGITS) throw new JazminValidationError(`Column '${column}': more than ${MAX_DIGITS} significant digits`);
  const m = BigInt(digits);
  return { m: sign && m !== 0n ? -m : m, s: fraction.length };
}

/** Canonical text of m × 10^-s: no leading zeros, no sign on zero, the scale's digits after the point. */
export function formatDecimal(m, s) {
  const negative = m < 0n;
  const digits = (negative ? -m : m).toString().padStart(s + 1, '0');
  const text = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
  return negative ? `-${text}` : text;
}

/**
 * Canonical text of a decimal value (number or text): formatDecimal(parseDecimal(value)), worked out with string
 * operations (leading zeros of the whole part dropped, and the sign of zero), with no BigInt arithmetic per value.
 */
export function canonicalDecimal(value, column = 'decimal') {
  const text = typeof value === 'number' ? String(value) : value;
  const match = typeof text === 'string' ? PATTERN.exec(text) : null;
  if (!match) throw new JazminValidationError(`Column '${column}': expected a decimal string like '-12.50', got '${value}'`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > MAX_SCALE) throw new JazminValidationError(`Column '${column}': more than ${MAX_SCALE} digits after the point`);
  if (whole.length + fraction.length > MAX_DIGITS && (whole + fraction).replace(/^0+(?=\d)/, '').length > MAX_DIGITS) {
    throw new JazminValidationError(`Column '${column}': more than ${MAX_DIGITS} significant digits`);
  }
  let w = 0;
  while (w < whole.length - 1 && whole.charCodeAt(w) === 48) w++;
  const digits = w ? whole.slice(w) : whole;
  const out = fraction ? `${digits}.${fraction}` : digits;
  return sign && (digits !== '0' || /[1-9]/.test(fraction)) ? `-${out}` : out; // zero has no sign
}

/**
 * m and s of decimal text with at most 15 digits, as numbers (exact: below 2^53), or undefined for anything else:
 * the common case, read without BigInt.
 */
export function smallDecimal(text) {
  if (typeof text !== 'string' || text.length > 17) return undefined;
  let i = text.charCodeAt(0) === 45 ? 1 : 0; // '-'
  const negative = i === 1;
  let m = 0;
  let digits = 0;
  let s = -1;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46 && s < 0) s = 0; // '.'
    else if (c >= 48 && c <= 57) {
      m = m * 10 + (c - 48);
      digits++;
      if (s >= 0) s++;
    } else return undefined;
  }
  if (digits === 0 || digits > 15 || s === 0) return undefined;
  return { m: negative ? -m : m, s: s < 0 ? 0 : s };
}

/** Key form of a decimal: reduced (trailing zeros removed), compared numerically. */
export class DecimalKey {
  constructor(m, s) {
    let mm = m;
    let ss = s;
    while (ss > 0 && mm % 10n === 0n) {
      mm /= 10n;
      ss--;
    }
    this.m = mm;
    this.s = ss;
    this.text = formatDecimal(mm, ss); // identity of equal values (Map keys)
  }

  toString() {
    return this.text;
  }
}

export function decimalKey(value) {
  if (value instanceof DecimalKey) return value;
  const { m, s } = parseDecimal(value);
  return new DecimalKey(m, s);
}

const POW10 = [1n];
function pow10(n) {
  while (POW10.length <= n) POW10.push(POW10[POW10.length - 1] * 10n);
  return POW10[n];
}

/** Numeric order of two decimal keys. */
export function compareDecimalKeys(a, b) {
  if (a.s === b.s) return a.m < b.m ? -1 : a.m > b.m ? 1 : 0;
  const x = a.s < b.s ? a.m * pow10(b.s - a.s) : a.m;
  const y = b.s < a.s ? b.m * pow10(a.s - b.s) : b.m;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Writes a decimal (text or key) as varint scale + big zigzag varint m (spec 5.1). */
export function writeDecimal(writer, value) {
  const small = smallDecimal(value);
  if (small) {
    // The same bytes, with numbers: |m| < 10^15, so 2|m| is exact.
    writer.varUint(small.s);
    writer.varUint(small.m > 0 ? small.m * 2 : small.m < 0 ? -small.m * 2 - 1 : 0);
    return;
  }
  const { m, s } = value instanceof DecimalKey ? value : parseDecimal(value);
  writer.varUint(s);
  writer.varUint(m >= 0n ? m << 1n : ((-m) << 1n) - 1n);
}

function readBigVarUint(reader) {
  let result = 0n;
  let shift = 0n;
  for (let n = 0; n < MAX_VARINT_BYTES; n++) {
    const b = reader.byte();
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return result;
    shift += 7n;
  }
  throw new JazminFormatError('Decimal value is too long');
}

/** Reads a decimal written by writeDecimal; returns { m, s }. */
export function readDecimalParts(reader) {
  const s = reader.varUint();
  if (typeof s !== 'number' || s > MAX_SCALE) throw new JazminFormatError('Decimal scale is invalid');
  const z = readBigVarUint(reader);
  return { m: z & 1n ? -((z + 1n) >> 1n) : z >> 1n, s };
}

/** Passes over a decimal without making its text (a row a query does not return). */
export function skipDecimal(reader) {
  const s = reader.varUint();
  if (typeof s !== 'number' || s > MAX_SCALE) throw new JazminFormatError('Decimal scale is invalid');
  for (let n = 0; n < MAX_VARINT_BYTES; n++) if (!(reader.byte() & 0x80)) return;
  throw new JazminFormatError('Decimal value is too long');
}

/** Reads a decimal as canonical text. */
export function readDecimal(reader) {
  const { m, s } = readDecimalParts(reader);
  return formatDecimal(m, s);
}
