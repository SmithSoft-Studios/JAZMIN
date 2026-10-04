import { JazminValidationError } from './errors.js';
import { intersect, unionAll } from './rowset.js';
import { EQUATABLE_TYPES, ORDERED_TYPES, compareKeys, normalizeValue, toKey } from './types.js';

// Filter language (spec section 9). GraphQL-style "where" objects:
//   { age: { gte: 18 }, country: 'ZA', or: [{ name: { contains: 'son' } }, { vip: true }] }

const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
const STRING_OPS = new Set(['contains', 'icontains', 'startsWith']);
const ALL_OPS = new Set(['eq', 'ne', 'in', 'isNull', ...RANGE_OPS, ...STRING_OPS]);

function invalid(message) {
  return new JazminValidationError(`Invalid filter: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof Date) && !(value instanceof Uint8Array);
}

/** Lenient conversion of filter operands (e.g. GraphQL/JSON strings) to the column's key form. */
function coerce(column, value) {
  if (value === null || value === undefined) return null;
  let v = value;
  if (column.type === 'int' && typeof v === 'string' && /^-?\d+$/.test(v)) v = BigInt(v);
  if (column.type === 'float' && typeof v === 'string' && v.trim() !== '') v = Number(v);
  if (column.type === 'bool' && (v === 'true' || v === 'false')) v = v === 'true';
  if (column.type === 'string' && typeof v === 'number') v = String(v);
  return toKey(column.type, normalizeValue(column.type, v, column.name));
}

/**
 * Validates a filter against the schema and returns a normalized tree:
 *   { kind: 'and'|'or', items } | { kind: 'not', item } | { kind: 'leaf', col, name, type, op, value }
 */
export function normalizeFilter(filter, columns) {
  const byName = new Map(columns.map((c, i) => [c.name, { ...c, col: i }]));

  function node(f) {
    if (!isPlainObject(f)) throw invalid('expected an object');
    const items = [];
    for (const [key, value] of Object.entries(f)) {
      if (key === 'and' || key === 'or') {
        if (!Array.isArray(value)) throw invalid(`'${key}' must be an array`);
        items.push({ kind: key, items: value.map(node) });
      } else if (key === 'not') {
        items.push({ kind: 'not', item: node(value) });
      } else {
        const column = byName.get(key);
        if (!column) throw invalid(`unknown column '${key}'`);
        items.push(...conditions(column, value));
      }
    }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  }

  function conditions(column, condition) {
    if (!isPlainObject(condition)) return [leaf(column, 'eq', condition)]; // shorthand: { name: 'x' }
    const entries = Object.entries(condition);
    if (entries.length === 0) throw invalid(`empty condition for '${column.name}'`);
    return entries.map(([op, value]) => leaf(column, op, value));
  }

  function leaf(column, op, value) {
    if (!ALL_OPS.has(op)) throw invalid(`unknown operator '${op}'`);
    const base = { kind: 'leaf', col: column.col, name: column.name, type: column.type, op };
    if (op === 'isNull') {
      if (typeof value !== 'boolean') throw invalid(`'isNull' needs true or false`);
      return { ...base, value };
    }
    if (STRING_OPS.has(op)) {
      if (column.type !== 'string') throw invalid(`'${op}' only applies to string columns`);
      if (typeof value !== 'string') throw invalid(`'${op}' needs a string`);
      return { ...base, value, lower: value.toLowerCase() };
    }
    const allowed = RANGE_OPS.has(op) ? ORDERED_TYPES : EQUATABLE_TYPES;
    if (!allowed.has(column.type)) throw invalid(`'${op}' is not supported on ${column.type} column '${column.name}'`);
    if (op === 'in') {
      if (!Array.isArray(value)) throw invalid(`'in' needs an array`);
      return { ...base, value: value.map((v) => coerce(column, v)) };
    }
    const operand = coerce(column, value);
    if (operand === null) {
      if (op === 'eq') return { ...base, op: 'isNull', value: true };
      if (op === 'ne') return { ...base, op: 'isNull', value: false };
      throw invalid(`'${op}' cannot compare with null`);
    }
    return { ...base, value: operand };
  }

  return filter == null ? null : node(filter);
}

function evaluateLeaf(leaf, row) {
  const value = row[leaf.col];
  if (leaf.op === 'isNull') return (value === null) === leaf.value;
  if (value === null) return false; // SQL-style: comparisons with null are false
  switch (leaf.op) {
    case 'contains': return value.includes(leaf.value);
    case 'icontains': return value.toLowerCase().includes(leaf.lower);
    case 'startsWith': return value.startsWith(leaf.value);
    default: break;
  }
  const key = toKey(leaf.type, value);
  switch (leaf.op) {
    case 'eq': return compareKeys(key, leaf.value) === 0;
    case 'ne': return !(compareKeys(key, leaf.value) === 0);
    case 'in': return leaf.value.some((v) => v !== null && compareKeys(key, v) === 0);
    case 'gt': return compareKeys(key, leaf.value) > 0;
    case 'gte': return compareKeys(key, leaf.value) >= 0;
    case 'lt': return compareKeys(key, leaf.value) < 0;
    case 'lte': return compareKeys(key, leaf.value) <= 0;
    default: throw invalid(`unknown operator '${leaf.op}'`);
  }
}

/** Compiles a filter into a predicate over row objects ({ column: value }). */
export function compileFilter(filter, columns) {
  const plan = normalizeFilter(filter, columns);
  if (!plan) return () => true;
  return (obj) => evaluate(plan, columns.map((c) => (obj[c.name] === undefined ? null : obj[c.name])));
}

/** Evaluates a normalized filter against a row (array of values in column order). */
export function evaluate(node, row) {
  switch (node.kind) {
    case 'and': return node.items.every((n) => evaluate(n, row));
    case 'or': return node.items.some((n) => evaluate(n, row));
    case 'not': return !evaluate(node.item, row);
    default: return evaluateLeaf(node, row);
  }
}

function leafCandidates(leaf, indexes) {
  if (leaf.op === 'contains' || leaf.op === 'icontains') {
    return indexes.get(leaf.name, 'trigram')?.candidates(leaf.value, leaf.op === 'icontains') ?? null;
  }
  const sorted = indexes.get(leaf.name, 'sorted');
  if (!sorted) return null;
  switch (leaf.op) {
    case 'eq': return sorted.eq(leaf.value);
    case 'in': return unionAll(leaf.value.filter((v) => v !== null).map((v) => sorted.eq(v)));
    case 'startsWith': return sorted.prefix(leaf.value);
    case 'isNull': return leaf.value ? sorted.nulls : null;
    case 'gt': case 'gte': case 'lt': case 'lte': return sorted.range(leaf.op, leaf.value);
    default: return null; // 'ne' cannot be answered efficiently from an index
  }
}

/**
 * Uses indexes to compute a sorted superset of matching row ids.
 * Returns null when indexes cannot narrow the search (caller must scan).
 * `indexes.get(columnName, kind)` returns a loaded index or undefined.
 */
export function candidates(node, indexes) {
  switch (node.kind) {
    case 'and': {
      let result = null;
      for (const item of node.items) {
        const ids = candidates(item, indexes);
        if (ids !== null) result = result === null ? ids : intersect(result, ids);
      }
      return result;
    }
    case 'or': {
      const lists = [];
      for (const item of node.items) {
        const ids = candidates(item, indexes);
        if (ids === null) return null;
        lists.push(ids);
      }
      return unionAll(lists);
    }
    case 'not': return null;
    default: return leafCandidates(node, indexes);
  }
}

function leafMayMatch(leaf, stat, rowCount) {
  if (!stat) return true;
  if (leaf.op === 'isNull') return leaf.value ? stat.nulls > 0 : stat.nulls < rowCount;
  if (stat.nulls === rowCount) return false;
  const { min, max } = stat;
  const belowMax = (v, inclusive) => max === undefined || (inclusive ? compareKeys(v, max) <= 0 : compareKeys(v, max) < 0);
  const aboveMin = (v, inclusive) => min === undefined || (inclusive ? compareKeys(v, min) >= 0 : compareKeys(v, min) > 0);
  switch (leaf.op) {
    case 'eq': return aboveMin(leaf.value, true) && belowMax(leaf.value, true);
    case 'in': return leaf.value.some((v) => v !== null && aboveMin(v, true) && belowMax(v, true));
    case 'gt': return max === undefined || compareKeys(max, leaf.value) > 0;
    case 'gte': return max === undefined || compareKeys(max, leaf.value) >= 0;
    case 'lt': return min === undefined || compareKeys(min, leaf.value) < 0;
    case 'lte': return min === undefined || compareKeys(min, leaf.value) <= 0;
    default: return true;
  }
}

/** Uses per-chunk min/max/null statistics to decide whether a chunk can be skipped. */
/** `stats` is a chunk's statistics by column position, or a function returning a column's statistics. */
export function mayMatch(node, stats, rowCount) {
  switch (node.kind) {
    case 'and': return node.items.every((n) => mayMatch(n, stats, rowCount));
    case 'or': return node.items.some((n) => mayMatch(n, stats, rowCount));
    case 'not': return true;
    default: return leafMayMatch(node, typeof stats === 'function' ? stats(node.col) : stats[node.col], rowCount);
  }
}

function leafMustMatch(leaf, stat, rowCount) {
  // Float statistics leave NaN values out, so they cannot prove that every row matches.
  if (!stat || leaf.type === 'float') return false;
  if (leaf.op === 'isNull') return leaf.value ? stat.nulls === rowCount : stat.nulls === 0;
  // A string minimum may be a prefix of the real one: still a lower bound. A maximum is exact or absent.
  const { min, max } = stat;
  if (stat.nulls !== 0 || min === undefined || max === undefined) return false;
  switch (leaf.op) {
    case 'eq': return compareKeys(min, leaf.value) === 0 && compareKeys(max, leaf.value) === 0;
    case 'ne': return compareKeys(max, leaf.value) < 0 || compareKeys(min, leaf.value) > 0;
    case 'in': return compareKeys(min, max) === 0 && leaf.value.some((v) => v !== null && compareKeys(min, v) === 0);
    case 'gt': return compareKeys(min, leaf.value) > 0;
    case 'gte': return compareKeys(min, leaf.value) >= 0;
    case 'lt': return compareKeys(max, leaf.value) < 0;
    case 'lte': return compareKeys(max, leaf.value) <= 0;
    default: return false; // string searches: statistics cannot prove a match
  }
}

/**
 * Whether per-chunk statistics prove that every row of a chunk matches (the counterpart of mayMatch): such a
 * chunk can be counted by its row count, for example to skip it whole for an offset.
 */
export function mustMatch(node, stats, rowCount) {
  switch (node.kind) {
    case 'and': return node.items.every((n) => mustMatch(n, stats, rowCount));
    case 'or': return node.items.some((n) => mustMatch(n, stats, rowCount));
    case 'not': return !mayMatch(node.item, stats, rowCount);
    default: return leafMustMatch(node, typeof stats === 'function' ? stats(node.col) : stats[node.col], rowCount);
  }
}
