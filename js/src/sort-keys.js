// A table's order (spec 6.7): its keys, plain or with other text comparisons (nocase, natural), as one comparison of
// rows. Plain keys compare as values do (spec 5.2); nulls come first.
import { JazminValidationError } from './errors.js';
import { isNested } from './nested.js';
import { compareKeys, toKey } from './types.js';

const MARK = /\p{Mn}/gu;

/** A text's folded form (spec 6.7, nocase): NFD, nonspacing marks removed, each code point lowercased on its own. */
export function foldText(text) {
  let out = '';
  for (const ch of text.normalize('NFD').replace(MARK, '')) out += ch.toLowerCase();
  return out;
}

const DIGITS = /[0-9]+/g;

/** A text as natural-order parts (spec 6.7): digit runs as { digits (no leading zeros), length }, other runs as text. */
function naturalParts(text) {
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(DIGITS)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    const digits = m[0].replace(/^0+/, '');
    parts.push({ digits, length: m[0].length });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function compareNatural(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    const xDigits = typeof x !== 'string';
    const yDigits = typeof y !== 'string';
    if (xDigits !== yDigits) return xDigits ? -1 : 1; // a digit run before other text
    if (xDigits) {
      if (x.digits.length !== y.digits.length) return x.digits.length - y.digits.length;
      const c = compareText(x.digits, y.digits) || x.length - y.length; // equal values: the shorter run first
      if (c !== 0) return c;
    } else {
      const c = compareText(x, y);
      if (c !== 0) return c;
    }
  }
  return a.length - b.length;
}

/**
 * A table's order, checked against its columns: from `sortedBy`, a list of column names or of keys
 * { column, nocase, natural } (those two for string columns). Returns { keys, names, plain, sort }: keys with their
 * column positions; the plain leading keys' names (the catalog's sorted_by); and `sort`, the keys as the catalog keeps
 * them, or null when the order is plain.
 */
export function normalizeOrder(sortedBy, columns, where = 'sortedBy') {
  if (!Array.isArray(sortedBy) || sortedBy.length === 0) throw new JazminValidationError(`${where} must be a non-empty array of column names or { column, nocase, natural }`);
  const keys = sortedBy.map((entry) => {
    const key = typeof entry === 'string' ? { column: entry } : entry;
    if (key === null || typeof key !== 'object' || typeof key.column !== 'string') throw new JazminValidationError(`${where}: each key is a column name or { column, nocase, natural }`);
    for (const name of Object.keys(key)) if (!['column', 'nocase', 'natural'].includes(name)) throw new JazminValidationError(`${where}: unknown option '${name}' (column, nocase, natural)`);
    const col = columns.findIndex((c) => c.name === key.column);
    if (col < 0) throw new JazminValidationError(`${where}: unknown column '${key.column}'`);
    const { type } = columns[col];
    if (isNested(type)) throw new JazminValidationError(`${where}: a ${type} column cannot be sorted`);
    for (const flag of ['nocase', 'natural']) if (key[flag] !== undefined && typeof key[flag] !== 'boolean') throw new JazminValidationError(`${where}: ${flag} must be true or false`);
    const nocase = key.nocase === true;
    const natural = key.natural === true;
    if ((nocase || natural) && type !== 'string') throw new JazminValidationError(`${where}: nocase and natural are for string columns ('${key.column}' is ${type})`);
    return { column: key.column, col, type, nocase, natural };
  });
  const plain = [];
  for (const k of keys) {
    if (k.nocase || k.natural) break;
    plain.push(k.column);
  }
  const sort = keys.some((k) => k.nocase || k.natural)
    ? keys.map((k) => ({ column: k.column, ...(k.nocase ? { nocase: true } : {}), ...(k.natural ? { natural: true } : {}) }))
    : null;
  return { keys, names: keys.map((k) => k.column), plain, sort };
}

/** How the order's keys are named in messages: "name (nocase)". */
export const describeOrder = (keys) => keys.map((k) => (k.nocase || k.natural ? `${k.column} (${[k.nocase && 'nocase', k.natural && 'natural'].filter(Boolean).join(', ')})` : k.column)).join(', ');

/**
 * A row's sort key for the order's keys: one entry per key, from `valueOf(col)` (a normalized value): null, the value's
 * key form (plain), its folded text (nocase), or its natural-order parts. Each value is folded or split once.
 */
export function orderKeyMaker(keys) {
  return (valueOf) => keys.map((k) => {
    const v = valueOf(k.col);
    if (v === null || v === undefined) return null;
    if (!k.nocase && !k.natural) return toKey(k.type, v);
    const text = k.nocase ? foldText(v) : v;
    return k.natural ? naturalParts(text) : text;
  });
}

/** Compares two sort keys made by orderKeyMaker for these keys; nulls first. */
export function orderComparer(keys) {
  return (a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      if (x === null) return -1;
      if (y === null) return 1;
      const k = keys[i];
      const c = k.natural ? compareNatural(x, y) : k.nocase ? compareText(x, y) : compareKeys(x, y);
      if (c !== 0) return Number.isNaN(c) ? 0 : c;
    }
    return 0;
  };
}
