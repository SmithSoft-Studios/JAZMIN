// Shared conversions between typed values and their text form (used by CSV and XML).
import { setField } from '../schema.js';

/** Text form of a non-null value. */
export function valueToText(type, value) {
  switch (type) {
    case 'datetime': return value.toISOString();
    case 'binary': return Buffer.from(value).toString('base64');
    case 'json': return JSON.stringify(value);
    default: return String(value);
  }
}

/** JSON literal for a value (exact for int and decimal, which may exceed double precision). */
export function valueToJson(type, value) {
  if (value === null) return 'null';
  switch (type) {
    case 'int':
    case 'decimal': return String(value);
    case 'float': return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'datetime': return JSON.stringify(value.toISOString());
    case 'binary': return JSON.stringify(Buffer.from(value).toString('base64'));
    default: return JSON.stringify(value);
  }
}

const INT = /^-?\d+$/;
const FLOAT = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const BOOL = /^(true|false)$/i;

/** The type a present text value is inferred as: int, float, bool, or string. */
export const textType = (v) => (INT.test(v) ? 'int' : FLOAT.test(v) ? 'float' : BOOL.test(v) ? 'bool' : 'string');

const digitsEnd = (bytes, i, end) => {
  while (i < end && bytes[i] >= 48 && bytes[i] <= 57) i++;
  return i;
};

/** textType() of a value from its UTF-8 bytes, without decoding it (the same answers, checked by a test). */
export function textTypeOfBytes(bytes, start, end) {
  let i = start < end && bytes[start] === 45 ? start + 1 : start; // '-'
  const whole = digitsEnd(bytes, i, end);
  if (whole > i && whole === end) return 'int';
  // float: -?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?
  let float = true;
  if (whole > i) {
    i = whole;
    if (i < end && bytes[i] === 46) i = digitsEnd(bytes, i + 1, end);
  } else if (i < end && bytes[i] === 46 && digitsEnd(bytes, i + 1, end) > i + 1) i = digitsEnd(bytes, i + 1, end);
  else float = false;
  if (float && i < end && (bytes[i] === 101 || bytes[i] === 69)) {
    i++;
    if (i < end && (bytes[i] === 43 || bytes[i] === 45)) i++;
    const exponent = digitsEnd(bytes, i, end);
    float = exponent > i;
    i = exponent;
  }
  if (float && i === end) return 'float';
  // bool: true or false, in any case (ASCII letters differ from their capitals by 0x20 only)
  const n = end - start;
  if (n === 4 || n === 5) {
    const word = n === 4 ? 'true' : 'false';
    let k = 0;
    while (k < n && (bytes[start + k] | 0x20) === word.charCodeAt(k)) k++;
    if (k === n) return 'bool';
  }
  return 'string';
}

/**
 * Infers column types from text records (positional; null or a missing field = absent), one record at a time, so a
 * file can be read without loading it. A column is int/float/bool only when every present value matches; otherwise
 * it stays string.
 */
export class TextColumnInference {
  #names;
  #inferTypes;
  #types;
  #nullable;

  constructor(names, inferTypes = true) {
    this.#names = names;
    this.#inferTypes = inferTypes;
    this.#types = new Array(names.length).fill(null);
    this.#nullable = new Array(names.length).fill(false);
  }

  add(record) {
    for (let i = 0; i < this.#names.length; i++) {
      const v = record[i];
      if (v === null || v === undefined) this.#nullable[i] = true;
      else if (this.#types[i] !== 'string') this.#merge(i, this.#inferTypes ? textType(v) : 'string'); // a string column stays one
    }
  }

  /** add() for a record whose present values are given as their types (textType), as the CSV file reader finds them. */
  addTypes(types) {
    for (let i = 0; i < this.#names.length; i++) {
      const t = types[i];
      if (t === null || t === undefined) this.#nullable[i] = true;
      else if (this.#types[i] !== 'string') this.#merge(i, this.#inferTypes ? t : 'string');
    }
  }

  /** A column first seen after `nullable` (some records came before it): XML rows name their columns. */
  grow(name, nullable) {
    this.#names = [...this.#names, name];
    this.#types.push(null);
    this.#nullable.push(nullable);
  }

  get width() {
    return this.#names.length;
  }

  #merge(i, t) {
    const type = this.#types[i];
    if (type === null) this.#types[i] = t;
    else if (type !== t) this.#types[i] = (type === 'int' && t === 'float') || (type === 'float' && t === 'int') ? 'float' : 'string';
  }

  columns() {
    return this.#names.map((name, i) => ({ name, type: this.#types[i] ?? 'string', nullable: this.#nullable[i] }));
  }
}

/** inferTextColumns for records that are all at hand (see TextColumnInference). */
export function inferTextColumns(names, rows, inferTypes) {
  const inference = new TextColumnInference(names, inferTypes);
  for (const row of rows) inference.add(row);
  return inference.columns();
}

/** Converts a text value into the column's type. */
export function textToValue(type, text) {
  if (text === null || text === undefined) return null;
  switch (type) {
    case 'int': {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : BigInt(text);
    }
    case 'float': return Number(text);
    case 'bool': return text.toLowerCase() === 'true';
    case 'binary': return Buffer.from(text, 'base64'); // as valueToText writes them
    case 'json': return JSON.parse(text);
    default: return text; // strings, and datetimes and decimals, which the writer reads from their text
  }
}

/** One positional text row as an object keyed by column name. */
export function toObject(columns, row) {
  const out = {};
  for (let i = 0; i < columns.length; i++) setField(out, columns[i].name, textToValue(columns[i].type, row[i] ?? null));
  return out;
}

/** Turns positional text rows into objects keyed by column name. */
export function toObjects(columns, rows) {
  return rows.map((row) => toObject(columns, row));
}
