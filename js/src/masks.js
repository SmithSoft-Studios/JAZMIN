// Masked columns (spec 7.6.8): a column of a shared file shown masked until its lock (6.8.1) opens. The writer keeps it
// in a column group of its own, makes its shown column by a rule, and moves the rows not masked to its unmasked column.
import crypto from 'node:crypto';
import { MASKED_COLUMNS } from './constants.js';
import { JazminValidationError } from './errors.js';
import { compileFilter } from './filter.js';

export { MASKED_COLUMNS };

const GROUP_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const DOTS = '••••';
const SHOWN_TYPES = new Set(['string', 'int', 'float', 'decimal', 'datetime', 'bool']);

/** A masked column's group: "mask." and its name, or a name made from it when that isn't a valid group name. */
export function maskGroupName(column) {
  const plain = `mask.${column}`;
  return GROUP_NAME.test(plain) ? plain : `mask.${crypto.createHash('sha256').update(column, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * A mask's shown rule, checked: 'none' (no shown column), { last }, { first, last }, { keepFormat, last } or
 * { column } (the owner gives the shown values in that column).
 */
function normalizeShow(show, where) {
  if (show === undefined || show === 'none') return { kind: 'none' };
  if (show === null || typeof show !== 'object' || Array.isArray(show)) throw new JazminValidationError(`${where}: show is 'none', { last }, { first, last }, { keepFormat, last } or { column }`);
  const count = (n, name) => {
    if (!Number.isInteger(n) || n < 0 || n > 64) throw new JazminValidationError(`${where}: show.${name} must be a whole number from 0 to 64`);
    return n;
  };
  for (const name of Object.keys(show)) if (!['last', 'first', 'keepFormat', 'column'].includes(name)) throw new JazminValidationError(`${where}: unknown show option '${name}' (last, first, keepFormat, column)`);
  if (show.column !== undefined) {
    if (typeof show.column !== 'string' || Object.keys(show).length !== 1) throw new JazminValidationError(`${where}: show: { column } names the column the owner gives the shown values in, alone`);
    return { kind: 'column', column: show.column };
  }
  if (show.keepFormat !== undefined) {
    if (show.keepFormat !== true || show.first !== undefined) throw new JazminValidationError(`${where}: show: { keepFormat: true, last }`);
    return { kind: 'keepFormat', last: count(show.last ?? 4, 'last') };
  }
  if (show.first !== undefined) return { kind: 'firstLast', first: count(show.first, 'first'), last: count(show.last ?? 0, 'last') };
  if (show.last !== undefined) return { kind: 'last', last: count(show.last, 'last') };
  throw new JazminValidationError(`${where}: show needs last, first, keepFormat or column`);
}

/** The show rule as the owner directory keeps it (and as writers take it back). */
const showAsGiven = (rule) => (rule.kind === 'none' ? 'none' : rule.kind === 'column' ? { column: rule.column }
  : rule.kind === 'keepFormat' ? { keepFormat: true, last: rule.last } : rule.kind === 'firstLast' ? { first: rule.first, last: rule.last } : { last: rule.last });

const textOf = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : String(value));
const WORD = /[\p{L}\p{N}]/u;
const isWordChar = (ch) => WORD.test(ch);
const SURROGATE = /[\uD800-\uDFFF]/;
const NOT_ASCII = /[^\x00-\x7F]/; // eslint-disable-line no-control-regex
const ASCII_WORDS = /[0-9A-Za-z]/g;
const WORDS = /[\p{L}\p{N}]/gu;
const DOT_CODE = 0x2022; // •
const MASK_BUFFER = new Uint16Array(4096); // keepFormat's output, reused: values up to this long make no array
const isWordAt = (text, i) => {
  const code = text.charCodeAt(i);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 128 && WORD.test(text[i]));
};

/**
 * What a masked value shows, by its rule (null for none), by code points so a character is never split. Text without
 * surrogate pairs (nearly all) is masked by slicing, without an array per value.
 */
export function shownText(rule, value) {
  if (value === null || value === undefined) return null;
  const plain = textOf(value);
  if (!SURROGATE.test(plain)) {
    switch (rule.kind) {
      case 'last': return plain.length > rule.last ? DOTS + plain.slice(plain.length - rule.last) : DOTS;
      case 'firstLast': return plain.length > rule.first + rule.last ? plain.slice(0, rule.first) + DOTS + plain.slice(plain.length - rule.last) : DOTS;
      case 'keepFormat': {
        const at = plain.lastIndexOf('@');
        if (at > 0) return plain[0] + '•'.repeat(at - 1) + plain.slice(at); // an email: its domain kept
        // The last `last` letters and digits stay, other letters and digits are masked: one pass into a reused buffer.
        let keep = rule.last;
        const n = plain.length;
        if (n <= MASK_BUFFER.length) {
          for (let i = n - 1; i >= 0; i--) MASK_BUFFER[i] = !isWordAt(plain, i) || keep-- > 0 ? plain.charCodeAt(i) : DOT_CODE;
          return String.fromCharCode.apply(null, MASK_BUFFER.subarray(0, n));
        }
        let from = n; // a long value: the letters and digits before the first kept one, masked by a regex
        while (from > 0 && keep > 0) {
          from--;
          if (isWordAt(plain, from)) keep--;
        }
        const head = plain.slice(0, from);
        return head.replace(NOT_ASCII.test(head) ? WORDS : ASCII_WORDS, '•') + plain.slice(from);
      }
      default: return null;
    }
  }
  return shownCodePoints(rule, plain);
}

/** shownText by code points, for text with surrogate pairs (exported for tests). */
export function shownCodePoints(rule, plain) {
  const text = [...plain]; // by code points, so a character is never split
  switch (rule.kind) {
    case 'last': return text.length > rule.last ? DOTS + text.slice(text.length - rule.last).join('') : DOTS;
    case 'firstLast': return text.length > rule.first + rule.last ? text.slice(0, rule.first).join('') + DOTS + text.slice(text.length - rule.last).join('') : DOTS;
    case 'keepFormat': {
      const at = text.lastIndexOf('@');
      if (at > 0) return text[0] + '•'.repeat(at - 1) + text.slice(at).join(''); // an email: its domain kept
      let keep = rule.last;
      const out = new Array(text.length);
      for (let i = text.length - 1; i >= 0; i--) {
        if (!isWordChar(text[i])) out[i] = text[i];
        else if (keep > 0) {
          out[i] = text[i];
          keep--;
        } else out[i] = '•';
      }
      return out.join('');
    }
    default: return null;
  }
}

/**
 * A table's masks, checked: the columns that have `mask: { lock, show, rows }` (or masks a rewrite keeps, `kept`, by
 * column name). Returns { columns, masks, groups }: the columns with the shown and unmasked columns added (unless they
 * are there) and `mask` taken off; each mask { column, group, lock, show (rule), shown, unmasked, rows (filter) }; and
 * the masked groups as column groups ({ group: [column] }).
 */
export function tableMasks(columns, kept = []) {
  const masks = [];
  const out = columns.map((c) => {
    if (c?.mask === undefined) return c;
    const { mask, ...column } = c;
    masks.push({ ...mask, column: c.name, given: true });
    return column;
  });
  for (const k of kept) if (!masks.some((m) => m.column === k.column)) masks.push({ ...k, given: false });
  if (!masks.length) return { columns, masks: [], groups: {} };
  const names = new Set(out.map((c) => c?.name));
  const groups = {};
  const checked = masks.map((m) => {
    const where = `Column '${m.column}': mask`;
    if (m === null || typeof m !== 'object') throw new JazminValidationError(`${where} must be { lock, show, rows }`);
    for (const name of Object.keys(m)) {
      if (!['column', 'given', 'lock', 'show', 'rows', 'group', 'shown', 'unmasked', 'table', 'tableName', 'position', 'type'].includes(name)) throw new JazminValidationError(`${where}: unknown option '${name}' (lock, show, rows)`);
    }
    const column = out.find((c) => c.name === m.column);
    if (!column) throw new JazminValidationError(`${where}: no column '${m.column}'`);
    if (!SHOWN_TYPES.has(column.type ?? 'string')) throw new JazminValidationError(`${where}: a ${column.type} column can't be masked`);
    if (typeof m.lock !== 'string' || !m.lock) throw new JazminValidationError(`${where} needs the lock that opens it (one of locks)`);
    const show = normalizeShow(m.show, where);
    let shown;
    if (show.kind === 'column') {
      if (!names.has(show.column)) throw new JazminValidationError(`${where}: show.column '${show.column}' is not a column`);
      shown = show.column;
    } else if (show.kind !== 'none') {
      shown = m.shown ?? `${m.column}_shown`;
      if (!names.has(shown)) {
        out.push({ name: shown, type: 'string', nullable: true, description: `What a masked '${m.column}' value shows` });
        names.add(shown);
      } else if (m.given && m.shown === undefined) {
        throw new JazminValidationError(`${where}: a column '${shown}' is there already; name the column the shown values are made in with show: { column }, or rename it`);
      }
    }
    let unmasked;
    if (m.rows !== undefined || m.unmasked !== undefined) {
      unmasked = m.unmasked ?? `${m.column}_unmasked`;
      if (!names.has(unmasked)) {
        out.push({ name: unmasked, type: column.type, nullable: true, description: `'${m.column}' in the rows that aren't masked` });
        names.add(unmasked);
      } else if (m.given && m.unmasked === undefined) {
        throw new JazminValidationError(`${where}: a column '${unmasked}' is there already, for the rows that aren't masked: rename it`);
      }
    }
    const group = m.group ?? maskGroupName(m.column);
    groups[group] = [m.column];
    return {
      column: m.column, group, lock: m.lock, show, shown, unmasked,
      ...(m.rows !== undefined ? { rows: m.rows } : {}),
    };
  });
  return { columns: out, masks: checked, groups };
}

/**
 * The masks as the owner directory keeps them (spec 7.6.8), for a table by its index and its columns: with each
 * column's position and type, so an append writes every key slot again.
 */
export const ownerMasks = (masks, table, columns) => masks.map((m) => {
  const position = columns.findIndex((c) => c.name === m.column);
  return {
    group: m.group, lock: m.lock, table, position, column: m.column, type: columns[position].type,
    ...(m.shown ? { shown: m.shown } : {}), ...(m.unmasked ? { unmasked: m.unmasked } : {}),
    show: showAsGiven(m.show), ...(m.rows !== undefined ? { rows: m.rows } : {}),
  };
});

/**
 * A row's mask work, for the writer: the shown values made, and in tables that mask some rows, each row's value in the
 * masked or the unmasked column: it stays masked when the row matches `rows`, else it moves to the unmasked column. A
 * row with only an unmasked value (one the file has) keeps it. The .NET library does the same.
 */
export function rowMasker(masks, columns) {
  const work = masks.map((m) => ({ ...m, matches: m.rows !== undefined ? compileFilter(m.rows, columns) : () => true }));
  return (row) => {
    let out = row;
    for (const m of work) {
      if (out === row) out = { ...row };
      const value = row[m.column];
      if (m.unmasked && value !== null && value !== undefined) {
        if (m.matches(row)) out[m.unmasked] = null;
        else {
          out[m.unmasked] = value;
          out[m.column] = null;
        }
      }
      if (m.shown && m.show.kind !== 'column') out[m.shown] = shownText(m.show, out[m.column]);
    }
    return out;
  };
}
