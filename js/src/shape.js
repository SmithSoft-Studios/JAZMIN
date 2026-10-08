// Export shapes (docs/design/export-shapes.md): a JSON template that turns rows into nested JSON or XML.
// Every list is a query on the file, so only the columns a shape uses are decoded, filters use indexes and
// statistics, and memory grows with the number of groups, not rows.
import { normalizeBigInt } from './binary.js';
import { JazminValidationError } from './errors.js';
import { compileFilter, normalizeFilter } from './filter.js';
import { READ_PRIORITY } from './reader.js';
import { valueToText } from './formats/text.js';
import { compareKeys, toKey } from './types.js';

const ORDERED = new Set(['bool', 'int', 'float', 'string', 'datetime', 'decimal']);
const GROUPABLE = ORDERED;
const SUMMABLE = new Set(['int', 'float', 'decimal']);
const LIST_KEYS = new Set(['$rows', '$filter', '$groupBy', '$sort', '$limit', '$xmlItem']);
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const fail = (path, message) => new JazminValidationError(`Shape${path ? ` at ${path}` : ''}: ${message}`);
const child = (path, name) => (path ? `${path}.${name}` : name);

// ---- compiling and validating ---------------------------------------------------------------------

/**
 * Validates a shape against the columns a reader can see and returns it compiled. Throws a
 * JazminValidationError naming the place of the first mistake (for example `shape.clients[].name`).
 */
export function compileShape(columns, shape) {
  const byName = new Map(columns.map((c, i) => [c.name, { ...c, index: i }]));
  const column = (name, path, allowed, what) => {
    if (typeof name !== 'string') throw fail(path, `${what} must name a column`);
    const c = byName.get(name);
    if (!c) throw fail(path, `unknown or hidden column '${name}'`);
    if (allowed && !allowed.has(c.type)) throw fail(path, `${what} is not supported on ${c.type} column '${name}'`);
    return c;
  };
  const filterOf = (filter, path) => {
    if (filter === undefined || filter === null) return null;
    try {
      normalizeFilter(filter, columns);
    } catch (error) {
      throw fail(path, error.message);
    }
    return filter;
  };

  function node(value, path, inRow) {
    if (typeof value === 'string') return { kind: 'col', column: column(value, path, null, 'a value') };
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return { kind: 'lit', value };
    if (Array.isArray(value)) throw fail(path, 'arrays are not templates; use { "$rows": ... } for a list');
    if (typeof value !== 'object') throw fail(path, `unsupported value ${String(value)}`);
    const keys = Object.keys(value);
    const special = keys.filter((k) => k.startsWith('$'));
    if (special.length === 0) {
      return { kind: 'obj', members: keys.map((k) => [k, node(value[k], child(path, k), inRow)]) };
    }
    if (special.length !== keys.length) throw fail(path, `'$' members cannot be mixed with other members (${keys.join(', ')})`);
    if ('$rows' in value) {
      if (inRow) throw fail(path, 'a list inside a row list needs $groupBy on the outer list');
      for (const k of keys) if (!LIST_KEYS.has(k)) throw fail(path, `unknown list option '${k}'`);
      const groupBy = value.$groupBy === undefined ? null : (Array.isArray(value.$groupBy) ? value.$groupBy : [value.$groupBy])
        .map((name, i) => column(name, child(path, `$groupBy[${i}]`), GROUPABLE, 'grouping'));
      if (groupBy?.length === 0) throw fail(path, '$groupBy needs at least one column');
      if (value.$sort !== undefined && !Array.isArray(value.$sort)) throw fail(child(path, '$sort'), 'must be an array of column names');
      const sort = (value.$sort ?? []).map((entry, i) => {
        const desc = typeof entry === 'string' && entry.startsWith('-');
        return { column: column(desc ? entry.slice(1) : entry, child(path, `$sort[${i}]`), GROUPABLE, 'sorting'), desc };
      });
      const limit = value.$limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw fail(child(path, '$limit'), 'must be a non-negative integer');
      const xmlItem = value.$xmlItem ?? 'item';
      if (typeof xmlItem !== 'string' || !XML_NAME.test(xmlItem)) throw fail(child(path, '$xmlItem'), 'must be a valid XML element name');
      return {
        kind: 'list',
        filter: filterOf(value.$filter, child(path, '$filter')),
        groupBy,
        sort,
        limit: limit ?? Infinity,
        xmlItem,
        item: node(value.$rows, `${path || 'shape'}[]`, !groupBy),
      };
    }
    if (keys.length !== 1) throw fail(path, `expected one '$' member, found ${keys.join(', ')}`);
    const [key] = keys;
    const arg = value[key];
    switch (key) {
      case '$value': return { kind: 'lit', value: arg };
      case '$meta':
        if (typeof arg !== 'string') throw fail(path, '$meta must name a metadata member');
        return { kind: 'meta', key: arg };
      case '$count':
        if (inRow) throw fail(path, 'aggregates need a set of rows (use $groupBy on the list)');
        if (arg !== true) throw fail(path, '$count takes true');
        return { kind: 'agg', op: 'count', column: null };
      case '$sum': case '$min': case '$max':
        if (inRow) throw fail(path, 'aggregates need a set of rows (use $groupBy on the list)');
        return { kind: 'agg', op: key.slice(1), column: column(arg, child(path, key), key === '$sum' ? SUMMABLE : ORDERED, key) };
      default: throw fail(path, `unknown operator '${key}'`);
    }
  }

  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) throw fail('', 'must be an object');
  return node(shape, '', false);
}

/** Columns and aggregates a set-context template uses directly (not inside its lists). */
function setNeeds(node, needs = { columns: new Map(), aggs: [] }) {
  switch (node.kind) {
    case 'col': needs.columns.set(node.column.name, node.column); break;
    case 'agg': needs.aggs.push(node); break;
    case 'obj': for (const [, member] of node.members) setNeeds(member, needs); break;
    default: break; // lit, meta, list
  }
  return needs;
}

/** Columns a one-row template uses. */
function rowColumns(node, names = new Set()) {
  if (node.kind === 'col') names.add(node.column.name);
  else if (node.kind === 'obj') for (const [, member] of node.members) rowColumns(member, names);
  return names;
}

// ---- values ------------------------------------------------------------------------------------------

const sortValue = (v) => (v instanceof Date ? v.getTime() : v);

/** Orders two non-null values of one column type (numbers and BigInts compare directly; decimals by value). */
function compareValues(a, b, type) {
  if (type === 'decimal') return compareKeys(toKey(type, a), toKey(type, b));
  const x = sortValue(a);
  const y = sortValue(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Sort comparison with nulls first (spec 5.3) and descending columns. */
function compareBy(sort, valuesOf) {
  return (a, b) => {
    for (const { column, desc } of sort) {
      const x = valuesOf(a)[column.name] ?? null;
      const y = valuesOf(b)[column.name] ?? null;
      const c = x === null ? (y === null ? 0 : -1) : y === null ? 1 : compareValues(x, y, column.type);
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  };
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Running aggregate of one column (sum, min, max) or of rows (count). */
function accumulator({ op, column }) {
  let count = 0;
  let value = null;
  let scale = 0; // decimal sums: digits after the point
  return {
    add(row) {
      if (op === 'count') {
        count++;
        return;
      }
      const v = row[column.name];
      if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return;
      if (op === 'sum') {
        if (column.type === 'float') value = (value ?? 0) + v;
        else if (column.type === 'int') value = (value ?? 0n) + BigInt(v);
        else {
          const [, sign, whole, fraction = ''] = DECIMAL.exec(v);
          const digits = BigInt(`${sign}${whole}${fraction}`);
          if (value === null) value = 0n;
          if (fraction.length > scale) {
            value *= 10n ** BigInt(fraction.length - scale);
            scale = fraction.length;
          }
          value += digits * 10n ** BigInt(scale - fraction.length);
        }
      } else if (value === null || (op === 'min' ? compareValues(v, value, column.type) < 0 : compareValues(v, value, column.type) > 0)) {
        value = v;
      }
    },
    result() {
      if (op === 'count') return count;
      if (op !== 'sum' || value === null || column.type === 'float') return value;
      if (column.type === 'int') return normalizeBigInt(value);
      const negative = value < 0n;
      const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
      const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
      return negative ? `-${text}` : text;
    },
  };
}

/** Type of a node's value for writing (a column type, or 'json' for literals and metadata). */
function typeOf(node) {
  if (node.kind === 'col') return node.column.type;
  if (node.kind === 'agg') return node.op === 'count' ? 'int' : node.column.type;
  return 'json';
}

const keyPart = (v) => (v === null || v === undefined ? '\u0000' : v instanceof Date ? `d${v.getTime()}` : `${typeof v}:${String(v)}`);
const keyOf = (values) => values.map(keyPart).join('\u0001');
const and = (a, b) => (!a ? b ?? null : !b ? a : { and: [a, b] });

// ---- output sinks ------------------------------------------------------------------------------------

class JsonSink {
  constructor(pretty, metadata) {
    this.out = '';
    this.pretty = pretty;
    this.metadata = metadata;
    this.stack = []; // per open container: has an item been written?
    this.pendingKey = null;
  }

  #prefix() {
    const depth = this.stack.length;
    if (depth === 0) return '';
    const comma = this.stack[depth - 1] ? ',' : '';
    this.stack[depth - 1] = true;
    const indent = this.pretty ? `\n${'  '.repeat(depth)}` : '';
    const key = this.pendingKey === null ? '' : `${JSON.stringify(this.pendingKey)}${this.pretty ? ': ' : ':'}`;
    this.pendingKey = null;
    return comma + indent + key;
  }

  key(name) { this.pendingKey = name; }

  open(bracket) {
    this.out += this.#prefix() + bracket;
    this.stack.push(false);
  }

  close(bracket) {
    const wrote = this.stack.pop();
    this.out += (wrote && this.pretty ? `\n${'  '.repeat(this.stack.length)}` : '') + bracket;
  }

  startObject() { this.open('{'); }
  endObject() { this.close('}'); }
  startArray() { this.open('['); }
  endArray() { this.close(']'); }

  /**
   * A writer for a template without lists at this place (the next item or member): (values, aggs) appends its text.
   * The template is compiled once per depth, so a list's rows cost one call each, not one per value.
   */
  writer(node) {
    const depth = this.stack.length;
    const cache = (node.json ??= []);
    const text = (cache[depth] ??= compileJson(node, depth, this.pretty, this.metadata));
    return (values, aggs) => {
      this.out += this.#prefix() + text(values, aggs);
    };
  }

  end() { if (this.pretty) this.out += '\n'; }
}

const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;

function xmlEscape(text) {
  if (INVALID_XML_CHARS.test(text)) throw new JazminValidationError('Value contains characters that XML 1.0 cannot represent');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const xmlTag = (name) => (XML_NAME.test(name) && !/^xml/i.test(name)
  ? { open: `<${name}>`, close: `</${name}>` }
  : { open: `<field name="${xmlEscape(name)}">`, close: '</field>' });

class XmlSink {
  constructor(root, metadata) {
    this.out = '<?xml version="1.0" encoding="UTF-8"?>\n';
    this.root = root;
    this.metadata = metadata;
    this.stack = []; // open elements: { close, item } (item: element name for array items)
    this.pendingKey = null;
  }

  #name() {
    const parent = this.stack[this.stack.length - 1];
    const name = this.stack.length === 0 ? this.root : this.pendingKey ?? parent?.item ?? 'item';
    this.pendingKey = null;
    return name;
  }

  #tag() { return xmlTag(this.#name()); }

  #indent() { return '  '.repeat(this.stack.length); }

  key(name) { this.pendingKey = name; }

  startObject() {
    const tag = this.#tag();
    this.out += `${this.#indent()}${tag.open}\n`;
    this.stack.push({ close: tag.close, item: null });
  }

  endObject() {
    const { close } = this.stack.pop();
    this.out += `${this.#indent()}${close}\n`;
  }

  startArray(item) {
    const tag = this.#tag();
    this.out += `${this.#indent()}${tag.open}\n`;
    this.stack.push({ close: tag.close, item });
  }

  endArray() { this.endObject(); }

  /** As JsonSink.writer: compiled once per depth and element name. */
  writer(node) {
    const depth = this.stack.length;
    const name = this.#name();
    const cache = (node.xml ??= new Map());
    const key = `${depth}\u0000${name}`;
    let text = cache.get(key);
    if (!text) cache.set(key, (text = compileXml(node, depth, xmlTag(name), this.metadata)));
    return (values, aggs) => {
      this.pendingKey = null;
      this.out += text(values, aggs);
    };
  }

  end() {}
}

// ---- compiled templates: a template without lists becomes one function from values to text -----------------

/** JSON text of a non-null value of a column type, as valueToJson; other values ('json': literals, metadata) as JSON. */
const JSON_TEXT = {
  int: String,
  decimal: String,
  float: (v) => (Number.isFinite(v) ? String(v) : 'null'),
  datetime: (v) => `"${v.toISOString()}"`, // ISO-8601 text needs no escaping
  bool: (v) => (v ? 'true' : 'false'),
  binary: (v) => `"${Buffer.from(v).toString('base64')}"`,
};
const jsonText = (type) => {
  const text = JSON_TEXT[type] ?? ((v) => JSON.stringify(v) ?? 'null');
  return (v) => (v === null || v === undefined ? 'null' : text(v));
};

/** (values, aggs) => JSON text of a template without lists, written where `depth` containers are open. */
function compileJson(node, depth, pretty, metadata) {
  switch (node.kind) {
    case 'col': {
      const text = jsonText(node.column.type);
      const { name } = node.column;
      return (values) => text(values[name]);
    }
    case 'lit': {
      const text = jsonText('json')(node.value);
      return () => text;
    }
    case 'meta': {
      const text = jsonText('json')(metadata[node.key]);
      return () => text;
    }
    case 'agg': {
      const text = jsonText(typeOf(node));
      return (values, aggs) => text(aggs.get(node));
    }
    case 'obj': {
      if (!node.members.length) return () => '{}';
      const indent = pretty ? `\n${'  '.repeat(depth + 1)}` : '';
      const colon = pretty ? ': ' : ':';
      const members = node.members.map(([name, member], i) => [
        `${i ? ',' : ''}${indent}${JSON.stringify(name)}${colon}`,
        compileJson(member, depth + 1, pretty, metadata),
      ]);
      const close = `${pretty ? `\n${'  '.repeat(depth)}` : ''}}`;
      return (values, aggs) => {
        let out = '{';
        for (const [prefix, text] of members) out += prefix + text(values, aggs);
        return out + close;
      };
    }
    default: throw new Error(`a ${node.kind} has no compiled form`);
  }
}

/** An XML element for a value; nulls and non-finite floats are omitted. */
function xmlElement(type, v, indent, tag) {
  if (v === null || v === undefined || (type === 'float' && !Number.isFinite(v))) return '';
  const text = type === 'json' ? (typeof v === 'string' ? v : JSON.stringify(v)) : valueToText(type, v);
  return `${indent}${tag.open}${xmlEscape(text)}${tag.close}\n`;
}

/** (values, aggs) => XML text of a template without lists: element `tag` where `depth` elements are open. */
function compileXml(node, depth, tag, metadata) {
  const indent = '  '.repeat(depth);
  switch (node.kind) {
    case 'col': {
      const { name, type } = node.column;
      return (values) => xmlElement(type, values[name], indent, tag);
    }
    case 'lit': {
      const text = xmlElement('json', node.value, indent, tag);
      return () => text;
    }
    case 'meta': {
      const text = xmlElement('json', metadata[node.key], indent, tag);
      return () => text;
    }
    case 'agg': {
      const type = typeOf(node);
      return (values, aggs) => xmlElement(type, aggs.get(node), indent, tag);
    }
    case 'obj': {
      const members = node.members.map(([name, member]) => compileXml(member, depth + 1, xmlTag(name), metadata));
      const open = `${indent}${tag.open}\n`;
      const close = `${indent}${tag.close}\n`;
      return (values, aggs) => {
        let out = open;
        for (const text of members) out += text(values, aggs);
        return out + close;
      };
    }
    default: throw new Error(`a ${node.kind} has no compiled form`);
  }
}

// ---- evaluation --------------------------------------------------------------------------------------

const FLUSH = 64 * 1024;
// Rows held at a time when grouping an unsorted file with nested lists: each batch is one pass over the file. With
// priority 'speed', larger batches: 1M rows of 10,000 groups took 4.8 s in one pass against 9.4 s in ten, for about
// 90 MB more. Smaller batches than the default saved little memory (25,000 rows: 294 against 337 MB) for 2-4 times
// the time, so 'memory' keeps the default.
const BATCH_ROWS = 100_000;
const SPEED_BATCH_ROWS = 1_000_000;

/** Internal option: rows per batch (tests use small batches). */
export const SHAPE_BATCH_ROWS = Symbol('jazmin.shapeBatchRows');

/** Does a template contain a list (at any depth)? */
function hasList(node) {
  if (node.kind === 'list') return true;
  return node.kind === 'obj' && node.members.some(([, member]) => hasList(member));
}

/** Marks each node with whether it holds a list (`lists`): nodes without one are written by compiled writers. */
function markLists(node) {
  if (node.kind === 'obj') for (const [, member] of node.members) markLists(member);
  if (node.kind === 'list') markLists(node.item);
  node.lists = hasList(node);
  return node;
}

/** Every column a template reads, including its lists' filters, groups and sorts (at any depth). */
function deepColumns(node, columns, names = new Set()) {
  switch (node.kind) {
    case 'col': names.add(node.column.name); break;
    case 'agg': if (node.column) names.add(node.column.name); break;
    case 'obj': for (const [, member] of node.members) deepColumns(member, columns, names); break;
    case 'list': {
      if (node.filter) {
        (function collect(n) {
          if (n.kind === 'leaf') names.add(n.name);
          else if (n.kind === 'not') collect(n.item);
          else n.items.forEach(collect);
        })(normalizeFilter(node.filter, columns));
      }
      for (const c of node.groupBy ?? []) names.add(c.name);
      for (const { column } of node.sort) names.add(column.name);
      deepColumns(node.item, columns, names);
      break;
    }
    default: break;
  }
  return names;
}

/**
 * Yields the shape's output for a reader as text pieces (format 'json' or 'xml'), streaming.
 * Options: filter (applies to the whole export), pretty (JSON), root (XML root element, default 'export').
 */
export function* shapePieces(reader, shape, format, options = {}) {
  const { filter = null, pretty = false, root = 'export' } = options;
  const batchRows = options[SHAPE_BATCH_ROWS] ?? (reader[READ_PRIORITY] === 'speed' ? SPEED_BATCH_ROWS : BATCH_ROWS);
  const compiled = markLists(compileShape(reader.columns, shape));
  if (format !== 'json' && format !== 'xml') throw new JazminValidationError(`Shapes export JSON or XML, not '${format}'`);
  if (format === 'xml' && !XML_NAME.test(root)) throw new JazminValidationError(`'${root}' is not a valid XML element name`);
  if (filter) normalizeFilter(filter, reader.columns);
  const metadata = reader.metadata ?? {};
  const sink = format === 'json' ? new JsonSink(pretty, metadata) : new XmlSink(root, metadata);
  const sortedBy = reader.sortedBy ?? [];
  const anyColumn = reader.columns[0]?.name;
  const predicates = new WeakMap(); // filter object -> predicate over row objects (rows held in memory)

  // Rows come from the file (a query: indexes, statistics, only the columns asked for) or, inside a group
  // with nested lists, from that group's rows held in memory.
  const fileSource = {
    inMemory: false,
    find: (where, names, limit = Infinity) => reader.find(where, { select: names.size ? [...names] : [anyColumn], limit }),
  };
  const memorySource = (rows) => ({
    inMemory: true,
    /** The rows (held already) matching `where`, as an array: no copy without a filter or a limit. */
    find(where, _names, limit = Infinity) {
      if (!where) return limit < rows.length ? rows.slice(0, limit) : rows;
      let test = predicates.get(where);
      if (!test) predicates.set(where, (test = compileFilter(where, reader.columns)));
      const found = [];
      for (const row of rows) {
        if (found.length >= limit) break;
        if (test(row)) found.push(row);
      }
      return found;
    },
  });

  /** First values and aggregates of a set, from rows (one pass; first values alone stop at the first row). */
  function setValues(node, rows) {
    const needs = setNeeds(node);
    const accumulators = needs.aggs.map((a) => [a, accumulator(a)]);
    let first = null;
    for (const row of rows) {
      first ??= row;
      if (!accumulators.length) break;
      for (const [, acc] of accumulators) acc.add(row);
    }
    return { first: first ?? {}, aggs: new Map(accumulators.map(([a, acc]) => [a, acc.result()])) };
  }

  function scanSet(node, source, where) {
    const needs = setNeeds(node);
    if (!needs.columns.size && !needs.aggs.length) return { source, filter: where, first: {}, aggs: new Map() };
    const names = new Set([...needs.columns.keys(), ...needs.aggs.filter((a) => a.column).map((a) => a.column.name)]);
    return { source, filter: where, ...setValues(node, source.find(where, names, needs.aggs.length ? Infinity : 1)) };
  }

  function* emit(node, ctx) {
    if (!node.lists) {
      sink.writer(node)(ctx.row ?? ctx.first, ctx.aggs);
      if (sink.out.length >= FLUSH) {
        yield sink.out;
        sink.out = '';
      }
      return;
    }
    switch (node.kind) {
      case 'obj':
        sink.startObject();
        for (const [name, member] of node.members) {
          sink.key(name);
          yield* emit(member, ctx);
        }
        sink.endObject();
        break;
      case 'list':
        sink.startArray(node.xmlItem);
        yield* node.groupBy ? emitGroups(node, ctx) : emitRows(node, ctx);
        sink.endArray();
        break;
      default: throw new Error(`unknown node ${node.kind}`);
    }
    if (sink.out.length >= FLUSH) {
      yield sink.out;
      sink.out = '';
    }
  }

  function* emitRows(node, ctx) {
    if (!node.names) { // the columns a list reads: worked out once, not per group it is written for
      node.names = rowColumns(node.item);
      for (const { column } of node.sort) node.names.add(column.name);
    }
    const { names } = node;
    const where = and(ctx.filter, node.filter);
    const rows = node.sort.length
      ? [...ctx.source.find(where, names)].sort(compareBy(node.sort, (r) => r)).slice(0, node.limit)
      : ctx.source.find(where, names, node.limit);
    if (node.item.lists) {
      for (const row of rows) yield* emit(node.item, { row });
      return;
    }
    const write = sink.writer(node.item); // every item is written at the same place: one compiled writer
    for (const row of rows) {
      write(row);
      if (sink.out.length >= FLUSH) {
        yield sink.out;
        sink.out = '';
      }
    }
  }

  /** Emits one group: its first values and aggregates, and nested lists over its rows (held in memory). */
  function* emitGroup(node, rows) {
    yield* emit(node.item, { source: memorySource(rows), filter: null, ...setValues(node.item, rows) });
  }

  function* emitGroups(node, ctx) {
    const where = and(ctx.filter, node.filter);
    const single = node.groupBy.length === 1 ? node.groupBy[0].name : null;
    const keyOfRow = single ? (row) => keyPart(row[single]) : (row) => keyOf(node.groupBy.map((c) => row[c.name]));
    // Rows sorted by the group columns arrive group by group: each group is written when the next begins.
    const contiguous = !ctx.source.inMemory && !node.sort.length
      && node.groupBy.every((c) => sortedBy.slice(0, node.groupBy.length).includes(c.name));

    if (!hasList(node.item)) {
      // First values and aggregates only: one pass with running totals per group, rows are not kept.
      const needs = setNeeds(node.item);
      const names = new Set([...node.groupBy.map((c) => c.name), ...needs.columns.keys(), ...node.sort.map((s) => s.column.name)]);
      for (const a of needs.aggs) if (a.column) names.add(a.column.name);
      const start = (row) => ({ first: row, accumulators: needs.aggs.map((a) => [a, accumulator(a)]) });
      const write = (group) => emit(node.item, { first: group.first, aggs: new Map(group.accumulators.map(([a, acc]) => [a, acc.result()])) });
      const groups = new Map();
      let current = null;
      let currentKey = null;
      let written = 0;
      for (const row of ctx.source.find(where, names)) {
        const key = keyOfRow(row);
        let group;
        if (contiguous) {
          if (key !== currentKey) {
            if (current) {
              yield* write(current);
              if (++written >= node.limit) return;
            }
            current = start(row);
            currentKey = key;
          }
          group = current;
        } else {
          group = groups.get(key);
          if (!group) groups.set(key, (group = start(row)));
        }
        for (const [, acc] of group.accumulators) acc.add(row);
      }
      if (contiguous) {
        if (current && written < node.limit) yield* write(current);
        return;
      }
      const all = [...groups.values()];
      if (node.sort.length) all.sort(compareBy(node.sort, (g) => g.first));
      for (const group of all.slice(0, node.limit)) yield* write(group);
      return;
    }

    // Nested lists: the group's rows are needed. Read every column the item uses, at any depth.
    const names = deepColumns(node.item, reader.columns, new Set(node.groupBy.map((c) => c.name)));
    for (const { column } of node.sort) names.add(column.name);
    if (contiguous) {
      // Sorted file: one pass, holding one group's rows at a time.
      let rows = [];
      let currentKey = null;
      let written = 0;
      for (const row of ctx.source.find(where, names)) {
        const key = keyOfRow(row);
        if (key !== currentKey && rows.length) {
          yield* emitGroup(node, rows);
          if (++written >= node.limit) return;
          rows = [];
        }
        currentKey = key;
        rows.push(row);
      }
      if (rows.length && written < node.limit) yield* emitGroup(node, rows);
      return;
    }
    if (ctx.source.inMemory) {
      // Already in memory (a group of an outer list): bucket the rows by key.
      const groups = new Map();
      for (const row of ctx.source.find(where, names)) {
        const key = keyOfRow(row);
        const rows = groups.get(key);
        if (rows) rows.push(row);
        else groups.set(key, [row]);
      }
      const all = [...groups.values()];
      if (node.sort.length) all.sort(compareBy(node.sort, (rows) => rows[0]));
      for (const rows of all.slice(0, node.limit)) yield* emitGroup(node, rows);
      return;
    }
    // Unsorted file: find the groups (order, sizes), then collect their rows in batches of at most
    // BATCH_ROWS rows, one pass per batch, so memory stays bounded however large the file is.
    const keyNames = new Set([...node.groupBy.map((c) => c.name), ...node.sort.map((s) => s.column.name)]);
    const found = new Map();
    for (const row of ctx.source.find(where, keyNames)) {
      const key = keyOfRow(row);
      const group = found.get(key);
      if (group) group.count++;
      else found.set(key, { key, first: row, count: 1 });
    }
    let order = [...found.values()];
    if (node.sort.length) order.sort(compareBy(node.sort, (g) => g.first));
    order = order.slice(0, node.limit);
    for (let start = 0; start < order.length;) {
      const batch = new Map();
      let held = 0;
      for (; start < order.length && (batch.size === 0 || held + order[start].count <= batchRows); start++) {
        batch.set(order[start].key, []);
        held += order[start].count;
      }
      for (const row of ctx.source.find(where, names)) batch.get(keyOfRow(row))?.push(row);
      for (const rows of batch.values()) yield* emitGroup(node, rows);
    }
  }

  yield* emit(compiled, scanSet(compiled, fileSource, filter));
  sink.end();
  if (sink.out) yield sink.out;
}

// ---- JSON Schema -------------------------------------------------------------------------------------

const JSON_TYPES = {
  bool: { type: 'boolean' },
  int: { type: 'integer' },
  float: { type: 'number' },
  decimal: { type: 'number' },
  string: { type: 'string' },
  datetime: { type: 'string', format: 'date-time' },
  binary: { type: 'string', contentEncoding: 'base64' },
  json: {},
};

function nullable(schema) {
  if (!schema.type) return schema; // any JSON value already allows null
  return { ...schema, type: [schema.type, 'null'] };
}

/** A JSON Schema (draft 2020-12) describing the shape's JSON output for this reader. */
export function shapeSchema(reader, shape) {
  const compiled = compileShape(reader.columns, shape);
  function schema(node, mayBeEmpty) {
    switch (node.kind) {
      case 'col': {
        const s = JSON_TYPES[node.column.type];
        return node.column.nullable || mayBeEmpty || node.column.type === 'float' ? nullable(s) : { ...s };
      }
      case 'lit': return { const: node.value };
      case 'meta': return {};
      case 'agg':
        if (node.op === 'count') return { type: 'integer', minimum: 0 };
        return nullable(JSON_TYPES[node.column.type]);
      case 'obj': return {
        type: 'object',
        properties: Object.fromEntries(node.members.map(([name, member]) => [name, schema(member, mayBeEmpty)])),
        required: node.members.map(([name]) => name),
        additionalProperties: false,
      };
      case 'list': return { type: 'array', items: schema(node.item, false) };
      default: throw new Error(`unknown node ${node.kind}`);
    }
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema(compiled, true) };
}
