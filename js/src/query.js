// LINQ-style queries with arrow functions (docs/design/js-queries.md): from(reader).where(...).select(...).toArray().
// What the reader can do, it does: filters translated from the where functions (lambda.js), only the columns the
// functions read, the file's own order, offset and limit. The rest runs here, in memory, as LINQ to Objects does.
import { JazminValidationError } from './errors.js';
import { columnKey, columnsRead, translate } from './lambda.js';
import { compareKeys, toKey } from './types.js';

const isReader = (source) => source !== null && typeof source === 'object' && typeof source.find === 'function' && Array.isArray(source.columns);

const fail = (message) => new JazminValidationError(`Query: ${message}`);
const fn = (f, what) => {
  if (typeof f !== 'function') throw fail(`${what} must be a function`);
  return f;
};
const count = (n, what) => {
  if (!Number.isSafeInteger(n) || n < 0) throw fail(`${what} must be a non-negative integer`);
  return n;
};

/** A key's identity for joins and groups: equal values (dates, big integers, objects of values) give equal keys. */
export function keyOf(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return `d${value.getTime()}`;
  switch (typeof value) {
    case 'string': return `s${value}`;
    case 'number': return `n${value}`;
    case 'bigint': return `n${value}`; // 5n and 5 are the same key, as a filter takes them
    case 'boolean': return `b${value}`;
    default:
      if (Array.isArray(value)) return `[${value.map(keyOf).join(',')}]`;
      if (value instanceof Uint8Array) return `x${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${keyOf(value[k])}`).join(',')}}`;
  }
}

/** Orders values: nulls first; numbers and big integers together; dates by time; decimal text (a column's) exactly. */
export function compareValues(a, b, decimal = false) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (decimal) return compareKeys(toKey('decimal', a), toKey('decimal', b));
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return a < b ? -1 : a > b ? 1 : 0;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A number from a value: decimal text and big integers as numbers. */
const numeric = (v) => (typeof v === 'number' ? v : Number(v));

/**
 * Starts a query over a reader (a table of a JAZMIN file) or anything iterable (an array, another query's results).
 * Synchronous, as the reader's find(); the browser reader has the same, awaited (JazminBrowser.from).
 */
export function from(source) {
  if (!isReader(source) && (source === null || typeof source !== 'object' || typeof source[Symbol.iterator] !== 'function')) {
    throw fail('from() takes a reader, or something iterable such as an array');
  }
  return new JazminQuery(source, []);
}

export class JazminQuery {
  #source;
  #steps;
  #want = null; // the columns a join needs of this query's rows, when they leave it whole (a Set), or null: all

  constructor(source, steps, key) {
    this.#source = source;
    this.#steps = steps;
    if (key !== undefined) this.key = key; // a group's key (groupBy)
  }

  #with(step) {
    return new JazminQuery(this.#source, [...this.#steps, step]);
  }

  /** The same query, its rows read with only these columns (for a join's inner side). */
  #only(names) {
    const q = new JazminQuery(this.#source, this.#steps);
    q.#want = names;
    return q;
  }

  /** Keeps the rows the function keeps; `values` are what it reads through its second parameter ((t, $) => …). */
  where(predicate, values) {
    return this.#with({ op: 'where', fn: fn(predicate, 'where'), values });
  }

  select(selector) {
    return this.#with({ op: 'select', fn: fn(selector, 'select') });
  }

  orderBy(key) {
    return this.#with({ op: 'order', fn: fn(key, 'orderBy'), desc: false, then: false });
  }

  orderByDescending(key) {
    return this.#with({ op: 'order', fn: fn(key, 'orderByDescending'), desc: true, then: false });
  }

  thenBy(key) {
    this.#afterOrder('thenBy');
    return this.#with({ op: 'order', fn: fn(key, 'thenBy'), desc: false, then: true });
  }

  thenByDescending(key) {
    this.#afterOrder('thenByDescending');
    return this.#with({ op: 'order', fn: fn(key, 'thenByDescending'), desc: true, then: true });
  }

  #afterOrder(what) {
    if (this.#steps.at(-1)?.op !== 'order') throw fail(`${what} follows orderBy or orderByDescending`);
  }

  skip(n) {
    return this.#with({ op: 'skip', n: count(n, 'skip') });
  }

  take(n) {
    return this.#with({ op: 'take', n: count(n, 'take') });
  }

  /** Each row with each row of `inner` whose key matches: result(row, innerRow). `inner` is read once. */
  join(inner, outerKey, innerKey, result) {
    return this.#with({ op: 'join', inner: asQuery(inner), outerKey: fn(outerKey, 'join'), innerKey: fn(innerKey, 'join'), fn: fn(result, 'join') });
  }

  /** Each row with the rows of `inner` whose key matches, as a query: result(row, matches). */
  groupJoin(inner, outerKey, innerKey, result) {
    return this.#with({ op: 'groupJoin', inner: asQuery(inner), outerKey: fn(outerKey, 'groupJoin'), innerKey: fn(innerKey, 'groupJoin'), fn: fn(result, 'groupJoin') });
  }

  /** Groups by key, in the order keys first appear: result(key, rows), or the groups themselves (queries with .key). */
  groupBy(key, result) {
    return this.#with({ op: 'groupBy', key: fn(key, 'groupBy'), fn: result === undefined ? null : fn(result, 'groupBy') });
  }

  // ---- running it ------------------------------------------------------------------------------------------------

  /**
   * How it runs: the reader's part (filter, columns, order, offset, limit) and the rest, in memory. Leading where
   * functions become one filter as far as they can be read; a leading orderBy on the file's own sortedBy columns
   * needs no sort; skip and take go to the reader when nothing before them runs here.
   */
  #plan(terminal) {
    const plan = { filter: null, exact: true, notes: [], select: null, offset: 0, limit: Infinity, fileOrder: false, rest: [] };
    const reader = isReader(this.#source) ? this.#source : null;
    if (!reader) {
      plan.rest = sorts(this.#steps, null);
      return plan;
    }
    const steps = this.#steps;
    let k = 0;
    const filters = [];
    const checks = []; // where functions that still run on each row: those not translated exactly
    for (; k < steps.length && steps[k].op === 'where'; k++) {
      const t = translate(steps[k].fn, steps[k].values, reader.columns);
      plan.notes.push(...t.notes);
      if (t.filter) filters.push(t.filter);
      if (!t.exact) checks.push(steps[k]);
    }
    plan.filter = filters.length === 0 ? null : filters.length === 1 ? filters[0] : { and: filters };
    plan.exact = checks.length === 0;
    // The file's order: orderBy((t) => t.col) and its thenBy keys on the leading sortedBy columns, ascending.
    const sortedBy = reader.sortedBy ?? [];
    let j = k;
    let inOrder = true;
    for (let s = 0; j < steps.length && steps[j].op === 'order' && (j === k || steps[j].then); j++, s++) {
      if (steps[j].desc || columnKey(steps[j].fn) !== sortedBy[s]) inOrder = false;
    }
    if (j > k && inOrder) {
      plan.fileOrder = true;
      k = j;
    }
    // Offset and limit: to the reader when every where ran there exactly and nothing reorders the rows before them.
    let rest = steps.slice(k);
    let r = 0;
    if (plan.exact) {
      for (; r < rest.length && (rest[r].op === 'skip' || rest[r].op === 'take'); r++) {
        if (rest[r].op === 'skip') {
          const n = Math.min(rest[r].n, plan.limit);
          plan.offset += n;
          plan.limit -= n;
        } else {
          plan.limit = Math.min(plan.limit, rest[r].n);
        }
      }
    }
    rest = sorts([...checks, ...rest.slice(r)], reader); // the where functions not read exactly run first, here
    // A join reads only the inner rows' columns its key and result use.
    plan.rest = rest.map((step) => {
      if (step.op !== 'join') return step;
      const key = columnsRead(step.innerKey);
      const result = columnsRead(step.fn, 1);
      return key === '*' || result === '*' ? step : { ...step, inner: step.inner.#only(new Set([...key, ...result])) };
    });
    plan.select = neededColumns(plan.rest, terminal, reader, this.#want);
    return plan;
  }

  #rows(terminal) {
    const plan = this.#plan(terminal);
    let rows;
    if (isReader(this.#source)) {
      const options = { ...(plan.select ? { select: plan.select } : {}), ...(plan.offset ? { offset: plan.offset } : {}), ...(plan.limit !== Infinity ? { limit: plan.limit } : {}) };
      rows = plan.limit === 0 ? [] : this.#source.find(plan.filter, options);
    } else {
      rows = this.#source;
    }
    for (const step of plan.rest) rows = APPLY[step.op](rows, step);
    return rows;
  }

  [Symbol.iterator]() {
    return this.#rows(null)[Symbol.iterator]();
  }

  toArray() {
    return [...this];
  }

  /** How many rows; with a function, how many it keeps. A filter read exactly is counted by the reader. */
  count(predicate) {
    if (predicate !== undefined) return this.where(predicate).count();
    const plan = this.#plan('count');
    if (isReader(this.#source) && plan.rest.length === 0) {
      if (plan.limit === 0) return 0;
      const total = this.#source.count(plan.filter);
      return Math.max(0, Math.min(plan.limit, total - plan.offset));
    }
    let n = 0;
    for (const _ of this.#rows('count')) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  any(predicate) {
    for (const _ of (predicate === undefined ? this : this.where(predicate)).take(1)) return true; // eslint-disable-line no-unused-vars
    return false;
  }

  first(predicate) {
    for (const row of (predicate === undefined ? this : this.where(predicate)).take(1)) return row;
    throw fail('first() found no rows');
  }

  firstOrDefault(predicate, fallback = null) {
    for (const row of (predicate === undefined ? this : this.where(predicate)).take(1)) return row;
    return fallback;
  }

  /** The sum of the values (decimal text and big integers added as numbers); 0 for none. */
  sum(selector) {
    let total = 0;
    for (const v of this.#values(selector, 'sum')) if (v !== null && v !== undefined) total += numeric(v);
    return total;
  }

  /** The smallest value (null for none); decimal text compared as numbers. */
  min(selector) {
    return this.#extreme(selector, -1, 'min');
  }

  max(selector) {
    return this.#extreme(selector, 1, 'max');
  }

  #extreme(selector, sign, what) {
    let best = null;
    for (const v of this.#values(selector, what)) {
      if (v === null || v === undefined) continue;
      const decimal = typeof v === 'string' && typeof best === 'string' && DECIMAL.test(v) && DECIMAL.test(best);
      if (best === null || compareValues(v, best, decimal) * sign > 0) best = v;
    }
    return best;
  }

  /** The mean of the values (decimal text as numbers); null for none. */
  average(selector) {
    let total = 0;
    let n = 0;
    for (const v of this.#values(selector, 'average')) {
      if (v === null || v === undefined) continue;
      total += numeric(v);
      n++;
    }
    return n ? total / n : null;
  }

  #values(selector, what) {
    return (selector === undefined ? this : this.select(fn(selector, what))).#rows('values');
  }

  /**
   * How the query runs: { filter, exact, columns, offset, limit, fileOrder, inMemory, notes }. `exact`: the filter
   * says what the where functions say, so they don't run again; notes say what wasn't translated.
   */
  explain() {
    const plan = this.#plan(null);
    const reader = isReader(this.#source) ? this.#source : null;
    return {
      filter: plan.filter,
      exact: plan.exact,
      columns: plan.select ?? reader?.columns.map((c) => c.name) ?? null,
      offset: plan.offset,
      limit: plan.limit === Infinity ? null : plan.limit,
      fileOrder: plan.fileOrder,
      inMemory: plan.rest.map((s) => s.op),
      notes: [...new Set(plan.notes)],
    };
  }
}

const asQuery = (source) => (source instanceof JazminQuery ? source : from(source));

/**
 * orderBy and its thenBy steps as one sort: { op: 'sort', keys: [{ fn, desc, decimal }] }. A key that is a decimal
 * column of the reader's rows (before anything reshapes them) sorts as a number.
 */
function sorts(steps, reader) {
  const out = [];
  let shaped = false;
  for (const step of steps) {
    if (step.op === 'order') {
      const name = !shaped && reader ? columnKey(step.fn) : null;
      const decimal = name !== null && reader.columns.find((c) => c.name === name)?.type === 'decimal';
      const key = { fn: step.fn, desc: step.desc, decimal };
      if (step.then && out.at(-1)?.op === 'sort') out.at(-1).keys.push(key);
      else out.push({ op: 'sort', keys: [key] });
      continue;
    }
    if (step.op === 'select' || step.op === 'join' || step.op === 'groupJoin' || step.op === 'groupBy') shaped = true;
    out.push(step);
  }
  return out;
}

/**
 * The columns the rows must have: those the functions that see whole rows read, up to the first step that reshapes
 * them. Every column (null) when rows leave the query whole (unless a join said which it needs), or when a function
 * may read any.
 */
function neededColumns(rest, terminal, reader, want) {
  const names = new Set();
  let all = false;
  const add = (read) => {
    if (read === '*') all = true;
    else for (const n of read) names.add(n);
  };
  let shaped = false;
  for (const step of rest) {
    if (shaped) break;
    switch (step.op) {
      case 'where': add(columnsRead(step.fn)); break;
      case 'sort': for (const k of step.keys) add(columnsRead(k.fn)); break;
      case 'select': add(columnsRead(step.fn)); shaped = true; break;
      case 'join': case 'groupJoin': add(columnsRead(step.outerKey)); add(columnsRead(step.fn)); shaped = true; break;
      case 'groupBy': add(columnsRead(step.key)); all = true; shaped = true; break; // the groups hold whole rows
      default: break;
    }
  }
  if (!shaped && terminal !== 'count') {
    if (want) add(want);
    else all = true; // whole rows come out
  }
  if (all) return null;
  const columns = reader.columns.map((c) => c.name).filter((n) => names.has(n));
  return columns.length ? columns : [reader.columns[0].name]; // rows are read by a column
}

/** The in-memory steps, over iterables. */
const APPLY = {
  *where(rows, step) {
    for (const row of rows) if (step.fn(row, step.values)) yield row;
  },
  *select(rows, step) {
    let i = 0;
    for (const row of rows) yield step.fn(row, i++);
  },
  sort(rows, step) {
    const list = [...rows].map((row, i) => ({ row, i, values: step.keys.map((k) => k.fn(row)) }));
    list.sort((a, b) => {
      for (let k = 0; k < step.keys.length; k++) {
        const c = compareValues(a.values[k], b.values[k], step.keys[k].decimal);
        if (c !== 0) return step.keys[k].desc ? -c : c;
      }
      return a.i - b.i; // stable
    });
    return list.map((x) => x.row);
  },
  *skip(rows, step) {
    let left = step.n;
    for (const row of rows) {
      if (left > 0) left--;
      else yield row;
    }
  },
  *take(rows, step) {
    if (step.n === 0) return;
    let left = step.n;
    for (const row of rows) {
      yield row;
      if (--left === 0) return;
    }
  },
  *join(rows, step) {
    const byKey = lookup(step.inner, step.innerKey);
    for (const row of rows) for (const match of byKey.get(keyOf(step.outerKey(row))) ?? []) yield step.fn(row, match);
  },
  *groupJoin(rows, step) {
    const byKey = lookup(step.inner, step.innerKey);
    for (const row of rows) yield step.fn(row, from(byKey.get(keyOf(step.outerKey(row))) ?? []));
  },
  *groupBy(rows, step) {
    const groups = new Map();
    for (const row of rows) {
      const key = step.key(row);
      const id = keyOf(key);
      let group = groups.get(id);
      if (!group) groups.set(id, (group = { key, rows: [] }));
      group.rows.push(row);
    }
    for (const { key, rows: list } of groups.values()) {
      const group = new JazminQuery(list, [], key);
      yield step.fn ? step.fn(key, group) : group;
    }
  },
};

/** An inner sequence read once, its rows kept by key. */
function lookup(inner, key) {
  const byKey = new Map();
  for (const row of inner) {
    const id = keyOf(key(row));
    const list = byKey.get(id);
    if (list) list.push(row);
    else byKey.set(id, [row]);
  }
  return byKey;
}
