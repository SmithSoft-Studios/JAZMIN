import { JazminValidationError } from './errors.js';
import { intersect, unionAll } from './rowset.js';
import { isNested } from './nested.js';
import { EQUATABLE_TYPES, ORDERED_TYPES, compareKeys, keyId, normalizeValue, toKey } from './types.js';

// Filter language (spec section 9). GraphQL-style "where" objects:
//   { age: { gte: 18 }, country: 'ZA', or: [{ name: { contains: 'son' } }, { vip: true }] }

const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
const STRING_OPS = new Set(['contains', 'icontains', 'startsWith']);
const ALL_OPS = new Set(['eq', 'ne', 'in', 'isNull', 'any', 'all', 'match', ...RANGE_OPS, ...STRING_OPS]);
/** In a condition on list items that are not objects: the item itself ({ tags: { any: 'vip' } } is { '': 'vip' } per item). */
const ITSELF = '';

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
 * An `in` list's keys as a hash set (to check rows) and in order (to check chunk statistics), so a long list costs about
 * as much as a short one. Null and NaN are left out: they equal nothing.
 */
function inKeys(keys) {
  const usable = new Map();
  for (const key of keys) if (key !== null && !(typeof key === 'number' && Number.isNaN(key))) usable.set(keyId(key), key);
  return { set: new Set(usable.keys()), sorted: [...usable.values()].sort(compareKeys) };
}

/** Whether keys sorted by compareKeys hold one within [min, max]; an absent bound is open. */
function anyBetween(sorted, min, max) {
  let lo = 0;
  let hi = sorted.length;
  if (min !== undefined) {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareKeys(sorted[mid], min) < 0) lo = mid + 1;
      else hi = mid;
    }
  }
  return lo < sorted.length && (max === undefined || compareKeys(sorted[lo], max) <= 0);
}

/**
 * Validates a filter against the schema and returns a normalized tree:
 *   { kind: 'and'|'or', items } | { kind: 'not', item } | { kind: 'leaf', col, name, type, op, value }
 *   | { kind: 'nested', col, name, op: 'any'|'all'|'match', inner, part } (spec 9.2: `inner` is about `part`, a list's
 *     item or an object: its fields by position, or the item itself at position 0)
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
    if (op === 'any' || op === 'all' || op === 'match') {
      const isMatch = op === 'match';
      if (column.type !== (isMatch ? 'object' : 'list')) {
        throw invalid(`'${op}' only applies to ${isMatch ? 'object' : 'list'} columns, and '${column.name}' is a ${column.type}`);
      }
      const part = isMatch ? column : column.item; // what the inner filter is about
      const inner = part.type === 'object'
        ? normalizeFilter(value, part.fields)
        : normalizeFilter({ [ITSELF]: value }, [{ ...part, name: ITSELF }]);
      if (inner === null) throw invalid(`'${op}' needs a filter`);
      // The fields the inner filter reads, and the row it is checked on: filled again for each object or item.
      const reads = part.type === 'object' ? part.fields.flatMap((f, i) => (readsPosition([inner], i) ? [i] : [])) : [];
      const names = reads.map((i) => part.fields[i].name);
      const scratch = new Array(part.type === 'object' ? part.fields.length : 1).fill(null);
      return { kind: 'nested', col: column.col, name: column.name, op, inner, part, reads, names, scratch };
    }
    const base = { kind: 'leaf', col: column.col, name: column.name, type: column.type, op };
    if (op === 'isNull') {
      if (typeof value !== 'boolean') throw invalid(`'isNull' needs true or false`);
      return { ...base, value };
    }
    // { col: null } means isNull, for every type (spec 9.1): json, binary, lists and objects included.
    if ((op === 'eq' || op === 'ne') && (value === null || value === undefined)) return { ...base, op: 'isNull', value: op === 'eq' };
    if (STRING_OPS.has(op)) {
      if (column.type !== 'string') throw invalid(`'${op}' only applies to string columns`);
      if (typeof value !== 'string') throw invalid(`'${op}' needs a string`);
      return { ...base, value, lower: value.toLowerCase() };
    }
    const allowed = RANGE_OPS.has(op) ? ORDERED_TYPES : EQUATABLE_TYPES;
    if (!allowed.has(column.type)) throw invalid(`'${op}' is not supported on ${column.type} column '${column.name}'`);
    if (op === 'in') {
      if (!Array.isArray(value)) throw invalid(`'in' needs an array`);
      const keys = value.map((v) => coerce(column, v));
      return { ...base, value: keys, ...inKeys(keys) };
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
    case 'in': return leaf.set.has(keyId(key));
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
    case 'nested': return evaluateNested(node, row[node.col]);
    default: return evaluateLeaf(node, row);
  }
}

/** The node's row with the fields its filter reads of `object` (no new array per object: filled again each time). */
function fieldsOf(node, object) {
  const row = node.scratch;
  for (let j = 0; j < node.reads.length; j++) {
    const name = node.names[j];
    row[node.reads[j]] = Object.hasOwn(object, name) ? object[name] ?? null : null;
  }
  return row;
}

/**
 * A nested column's condition (spec 9.2): `match` on an object's fields; `any` / `all` on a list's items (the same item
 * meets every condition of one filter). A null list or object matches nothing; an empty list fails `any`, passes `all`.
 */
function evaluateNested(node, value) {
  if (value === null || value === undefined) return false;
  if (node.op === 'match') return evaluate(node.inner, fieldsOf(node, value));
  if (!Array.isArray(value)) return false;
  const objects = node.part.type === 'object';
  const row = node.scratch;
  for (const item of value) {
    let matched;
    if (objects) matched = item !== null && item !== undefined && evaluate(node.inner, fieldsOf(node, item));
    else {
      row[0] = item ?? null;
      matched = evaluate(node.inner, row);
    }
    if (matched === (node.op === 'any')) return matched;
  }
  return node.op === 'all';
}

/**
 * Nested column `column` (at position `col`) with only the fields a normalized filter checks: the others are copies
 * marked `unread`, whose streams the decoder passes over. The same definition when the filter reads every field.
 */
export function filterReads(column, col, plan) {
  return fieldsRead(column, innerFilters([plan], col));
}

/** `part` with only what `nodes` (filters of its fields, or of its item at position 0) read. */
function fieldsRead(part, nodes) {
  if (part.type === 'list') {
    const item = part.item;
    const read = item.type === 'object' ? fieldsRead(item, nodes) // filters of the items' fields
      : isNested(item.type) ? fieldsRead(item, innerFilters(nodes, 0)) // items that are lists: their conditions' filters
        : item;
    return read === item ? part : { ...part, item: read };
  }
  let same = true;
  const fields = part.fields.map((f, i) => {
    const read = !readsPosition(nodes, i) ? { ...f, unread: true } : isNested(f.type) ? fieldsRead(f, innerFilters(nodes, i)) : f;
    if (read !== f) same = false;
    return read;
  });
  return same ? part : { ...part, fields };
}

/** The filters of the any / all / match conditions on position `col`, through and, or and not. */
function innerFilters(nodes, col) {
  const found = [];
  const walk = (n) => {
    if (n.kind === 'nested') {
      if (n.col === col) found.push(n.inner);
    } else if (n.kind === 'not') walk(n.item);
    else n.items?.forEach(walk);
  };
  nodes.forEach(walk);
  return found;
}

/** Whether any condition of `nodes` is on position `col`. */
function readsPosition(nodes, col) {
  const walk = (n) => (n.kind === 'leaf' || n.kind === 'nested' ? n.col === col : n.kind === 'not' ? walk(n.item) : (n.items?.some(walk) ?? false));
  return nodes.some(walk);
}

/** The index lookup a condition can use - [index kind, lookup] (see indexes.js) - or null. */
function leafLookup(leaf) {
  switch (leaf.op) {
    case 'contains': case 'icontains': return ['trigram', { op: 'contains', text: leaf.value, ci: leaf.op === 'icontains' }];
    case 'eq': return ['sorted', { op: 'eq', value: leaf.value }];
    case 'in': return ['sorted', { op: 'in', values: leaf.value.filter((v) => v !== null) }];
    case 'startsWith': return ['sorted', { op: 'prefix', text: leaf.value }];
    case 'isNull': return leaf.value ? ['sorted', { op: 'nulls' }] : null;
    case 'gt': case 'gte': return ['sorted', { op: 'range', low: leaf.value, lowInclusive: leaf.op === 'gte' }];
    case 'lt': case 'lte': return ['sorted', { op: 'range', high: leaf.value, highInclusive: leaf.op === 'lte' }];
    default: return null; // 'ne' cannot be answered efficiently from an index
  }
}

function lookupPlan(column, kind, lookup, indexes, budget) {
  const index = indexes.get(column, kind);
  const cost = index ? index.cost(lookup) : null;
  return cost === null || cost > budget ? null : { cost, rows: () => index.rows(lookup) };
}

/** Range conditions of an AND on one column, merged into one bounded lookup (the tightest bounds win). */
function mergeRange(range, leaf) {
  const merged = range ?? { op: 'range' };
  const [, { low, lowInclusive, high, highInclusive }] = leafLookup(leaf);
  if (low !== undefined && (merged.low === undefined || compareKeys(low, merged.low) > 0 || (compareKeys(low, merged.low) === 0 && !lowInclusive))) {
    Object.assign(merged, { low, lowInclusive });
  }
  if (high !== undefined && (merged.high === undefined || compareKeys(high, merged.high) < 0 || (compareKeys(high, merged.high) === 0 && !highInclusive))) {
    Object.assign(merged, { high, highInclusive });
  }
  return merged;
}

const isRange = (node) => node.kind === 'leaf' && RANGE_OPS.has(node.op) && !(typeof node.value === 'number' && Number.isNaN(node.value));

/**
 * How indexes can narrow a filter: { cost, rows() }, where `cost` is the bytes of index data the lookups still have
 * to read (estimated from index directories: nothing is read yet) and rows() returns a sorted superset of the
 * matching row ids; or null when indexes cannot narrow it. Within an AND, range conditions on one column become one
 * bounded lookup, lookups are taken cheapest first, and those that would push the cost over `budget` bytes are left
 * out (the filter is still checked on every row read).
 */
export function indexPlan(node, indexes, budget = Infinity) {
  switch (node.kind) {
    case 'and': {
      const parts = [];
      const ranges = new Map(); // column name -> merged range lookup
      for (const item of node.items) {
        if (isRange(item)) ranges.set(item.name, mergeRange(ranges.get(item.name), item));
        else parts.push(indexPlan(item, indexes, budget));
      }
      for (const [name, lookup] of ranges) parts.push(lookupPlan(name, 'sorted', lookup, indexes, budget));
      const usable = parts.filter(Boolean).sort((a, b) => a.cost - b.cost);
      const chosen = [];
      let cost = 0;
      for (const part of usable) {
        if (cost + part.cost > budget) break;
        chosen.push(part);
        cost += part.cost;
      }
      if (!chosen.length) return null;
      return {
        cost,
        rows: () => {
          let result = chosen[0].rows();
          for (let i = 1; i < chosen.length && result.length; i++) result = intersect(result, chosen[i].rows());
          return result;
        },
      };
    }
    case 'or': {
      const parts = [];
      let cost = 0;
      for (const item of node.items) {
        const part = indexPlan(item, indexes, budget);
        if (part === null) return null; // a branch no index narrows: every row may match
        parts.push(part);
        cost += part.cost;
      }
      return cost > budget ? null : { cost, rows: () => unionAll(parts.map((p) => p.rows())) };
    }
    case 'not': return null;
    default: {
      const lookup = leafLookup(node);
      return lookup ? lookupPlan(node.name, lookup[0], lookup[1], indexes, budget) : null;
    }
  }
}

const EXACT_OPS = new Set(['eq', 'in', 'isNull', ...RANGE_OPS]);
const hasNaN = (leaf) => (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).some((v) => typeof v === 'number' && Number.isNaN(v));

/**
 * Whether the rows sorted indexes return for this filter are exactly its matches, so count() can take their number
 * without checking rows: one condition, or range conditions on one column, answered by the same key comparison rows
 * are checked with. Prefixes and text search are answered with a superset; NaN compares unlike other values.
 */
export function answeredExactly(node) {
  const leaves = node.kind === 'leaf' ? [node] : node.kind === 'and' && node.items.every((i) => i.kind === 'leaf') ? node.items : [];
  if (!leaves.length || leaves.some((l) => !EXACT_OPS.has(l.op) || !ORDERED_TYPES.has(l.type) || hasNaN(l))) return false;
  return leaves.length === 1 || leaves.every((l) => isRange(l) && l.col === leaves[0].col);
}

/**
 * Uses indexes to compute a sorted superset of matching row ids, or null when indexes cannot narrow the search
 * (the caller must scan). `indexes.get(columnName, kind)` returns a loaded index or undefined.
 */
export function candidates(node, indexes) {
  return indexPlan(node, indexes)?.rows() ?? null;
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
    case 'in': return anyBetween(leaf.sorted, min, max);
    case 'gt': return max === undefined || compareKeys(max, leaf.value) > 0;
    case 'gte': return max === undefined || compareKeys(max, leaf.value) >= 0;
    case 'lt': return min === undefined || compareKeys(min, leaf.value) < 0;
    case 'lte': return min === undefined || compareKeys(min, leaf.value) <= 0;
    default: return true;
  }
}

/**
 * Uses per-chunk min/max/null statistics to decide whether a chunk can be skipped. `stats` is a chunk's statistics by
 * column position, or a function returning a column's statistics; `leaves(col, path)`, a nested column's leaf's (path:
 * field positions, as "1,0"), or undefined when not kept.
 */
export function mayMatch(node, stats, rowCount, leaves) {
  switch (node.kind) {
    case 'and': return node.items.every((n) => mayMatch(n, stats, rowCount, leaves));
    case 'or': return node.items.some((n) => mayMatch(n, stats, rowCount, leaves));
    case 'not': return true;
    case 'nested': {
      const stat = typeof stats === 'function' ? stats(node.col) : stats[node.col];
      if (stat && stat.nulls === rowCount) return false; // every list or object of the chunk is null: none matches
      return !leaves || nestedMayMatch(node, (path) => leaves(node.col, path), '');
    }
    default: return leafMayMatch(node, typeof stats === 'function' ? stats(node.col) : stats[node.col], rowCount);
  }
}

/**
 * Whether a nested column's condition may match in a chunk, from the statistics of the leaves its filter reads (spec
 * 6.4): `any` and `match` need an item or object that may match each condition. `all` may always match (an empty list
 * does).
 */
function nestedMayMatch(node, leafOf, path) {
  return node.op === 'all' || partMayMatch(node.inner, node.part, leafOf, path);
}

/** A filter of `part` (its fields by position, or the item itself at 0) at `path`. */
function partMayMatch(node, part, leafOf, path) {
  switch (node.kind) {
    case 'and': return node.items.every((n) => partMayMatch(n, part, leafOf, path));
    case 'or': return node.items.some((n) => partMayMatch(n, part, leafOf, path));
    case 'not': return true;
    case 'nested': return nestedMayMatch(node, leafOf, step(part, node.col, path));
    default: {
      const stat = leafOf(step(part, node.col, path));
      return !stat || leafMayMatch(node, stat, stat.count);
    }
  }
}

/** The path of an object's field (one step more), or of a list's item (the same path). */
const step = (part, col, path) => (part.type !== 'object' ? path : path === '' ? String(col) : `${path},${col}`);

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
    case 'in': return compareKeys(min, max) === 0 && leaf.set.has(keyId(min));
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
    case 'nested': return false; // statistics bound values, not whether every list has a matching item
    default: return leafMustMatch(node, typeof stats === 'function' ? stats(node.col) : stats[node.col], rowCount);
  }
}
