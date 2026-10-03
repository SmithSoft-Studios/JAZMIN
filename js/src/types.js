import { dateFromMs, normalizeBigInt, parseJsonText } from './binary.js';
import { DecimalKey, canonicalDecimal, compareDecimalKeys, decimalKey, readDecimal, writeDecimal } from './decimal.js';
import { JazminValidationError } from './errors.js';

export const TYPES = Object.freeze(['bool', 'int', 'float', 'decimal', 'string', 'datetime', 'binary', 'json']);

/** Types that support ordering (range filters, sorted indexes, chunk min/max statistics). */
export const ORDERED_TYPES = new Set(['bool', 'int', 'float', 'decimal', 'string', 'datetime']);

/** Types that support equality filters. */
export const EQUATABLE_TYPES = ORDERED_TYPES;

export const INDEX_KINDS = Object.freeze({
  sorted: ORDERED_TYPES,
  trigram: new Set(['string']),
});

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function fail(column, message) {
  return new JazminValidationError(`Column '${column}': ${message}`);
}

function toInt(value, column) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw fail(column, `expected an integer, got ${value}`);
    if (Number.isSafeInteger(value)) return value;
    value = BigInt(value);
  }
  if (typeof value === 'bigint') {
    if (value < INT64_MIN || value > INT64_MAX) throw fail(column, 'integer is outside the 64-bit range');
    return normalizeBigInt(value);
  }
  throw fail(column, `expected an integer, got ${typeof value}`);
}

function toDateMs(value, column) {
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') ms = Date.parse(value);
  else if (typeof value === 'number' && Number.isInteger(value)) ms = value;
  else throw fail(column, 'expected a Date, ISO-8601 string or epoch milliseconds');
  if (!Number.isFinite(ms)) throw fail(column, `invalid date '${value}'`);
  return ms;
}

/**
 * Validates a caller-supplied value and converts it to its internal form
 * (datetime -> epoch milliseconds, int -> number or BigInt). Returns null for null/undefined.
 */
export function normalizeValue(type, value, column) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'bool':
      if (typeof value !== 'boolean') throw fail(column, `expected a boolean, got ${typeof value}`);
      return value;
    case 'int':
      return toInt(value, column);
    case 'float':
      if (typeof value !== 'number') throw fail(column, `expected a number, got ${typeof value}`);
      return value;
    case 'decimal':
      return canonicalDecimal(value, column); // stored as scale + integer; read back as this canonical text
    case 'string':
      if (typeof value !== 'string') throw fail(column, `expected a string, got ${typeof value}`);
      return value;
    case 'datetime':
      return toDateMs(value, column);
    case 'binary':
      if (!(value instanceof Uint8Array)) throw fail(column, 'expected a Uint8Array/Buffer');
      return value;
    case 'json':
      if (JSON.stringify(value) === undefined) throw fail(column, 'value is not JSON-serialisable');
      return value;
    default:
      throw fail(column, `unknown type '${type}'`);
  }
}

/** Writes a normalized, non-null value. */
export function encodeValue(writer, type, value) {
  switch (type) {
    case 'bool': writer.byte(value ? 1 : 0); break;
    case 'int': writer.varInt(value); break;
    case 'float': writer.float64(value); break;
    case 'decimal': writeDecimal(writer, value); break; // text or key form
    case 'string': writer.string(value); break;
    case 'datetime': writer.varInt(value); break;
    case 'binary': writer.blob(value); break;
    case 'json': writer.string(JSON.stringify(value)); break;
    default: throw new JazminValidationError(`Unknown type '${type}'`);
  }
}

/** Reads a non-null value in its public form (datetime -> Date, binary -> Buffer). */
export function decodeValue(reader, type) {
  switch (type) {
    case 'bool': return reader.byte() !== 0;
    case 'int': return reader.varInt();
    case 'float': return reader.float64();
    case 'decimal': return readDecimal(reader);
    case 'string': return reader.string();
    case 'datetime': return dateFromMs(reader.varInt());
    case 'binary': return Buffer.from(reader.blob());
    case 'json': return parseJsonText(reader.string(), 'A json value');
    default: throw new JazminValidationError(`Unknown type '${type}'`);
  }
}

/** Key form of a value (public or internal form), spec 5.2. */
export function toKey(type, value) {
  if (type === 'datetime') return value instanceof Date ? value.getTime() : value;
  if (type === 'float' && value === 0) return 0; // fold -0 into 0
  if (type === 'decimal') return decimalKey(value);
  return value;
}

/** Total order for keys of one type. Returns NaN when either side is NaN. */
export function compareKeys(a, b) {
  if (a instanceof DecimalKey) return compareDecimalKeys(a, b);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A key's identity for Map lookups (decimal keys are objects; equal values share their text). */
export const keyId = (key) => (key instanceof DecimalKey ? key.text : key);
