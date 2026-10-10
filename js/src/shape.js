// Export shapes (docs/design/export-shapes.md): a JSON template that turns rows into nested JSON or XML.
// Every list is a query on the file, so only the columns a shape uses are decoded, filters use indexes and
// statistics, and memory grows with the number of groups, not rows.
import { normalizeBigInt } from './binary.js';
import { JazminValidationError } from './errors.js';
import { compileFilter, normalizeFilter } from './filter.js';
import { READ_PRIORITY } from './reader.js';
import { nestedJson, valueToText } from './formats/text.js';
import { compareKeys, keyId, toKey } from './types.js';

const ORDERED = new Set(['bool', 'int', 'float', 'string', 'datetime', 'decimal']);
const GROUPABLE = ORDERED;
const SUMMABLE = new Set(['int', 'float', 'decimal']);
const LIST_KEYS = new Set(['$rows', '$filter', '$groupBy', '$sort', '$limit', '$xmlItem']);
const LINK_KEYS = new Set(['$from', '$on', ...LIST_KEYS]);
const ONE_KEYS = new Set(['$from', '$on', '$one', '$filter']);
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const fail = (path, message) => new JazminValidationError(`Shape${path ? ` at ${path}` : ''}: ${message}`);
const child = (path, name) => (path ? `${path}.${name}` : name);

// ---- compiling and validating ---------------------------------------------------------------------

/**
 * Validates a shape against the columns a reader can see and returns it compiled. Throws a
 * JazminValidationError naming the place of the first mistake (for example `shape.clients[].name`).
 */
export function compileShape(columns, shape, tables) {
  // A scope is a table's columns: the reader's, or a linked table's ($from). Names inside a link are the linked table's.
  const columnsOf = typeof tables === 'function' ? tables : (name) => tables?.[name];
  const scopeOf = (cols, table) => ({ table, columns: cols, byName: new Map(cols.map((c, i) => [c.name, { ...c, index: i }])) });
  const column = (scope, name, path, allowed, what) => {
    if (typeof name !== 'string') throw fail(path, `${what} must name a column`);
    const c = scope.byName.get(name);
    if (!c) throw fail(path, `unknown or hidden column '${name}'${scope.table === null ? '' : ` in table '${scope.table}'`}`);
    if (allowed && !allowed.has(c.type)) throw fail(path, `${what} is not supported on ${c.type} column '${name}'`);
    return c;
  };
  const filterOf = (scope, filter, path) => {
    if (filter === undefined || filter === null) return null;
    try {
      normalizeFilter(filter, scope.columns);
    } catch (error) {
      throw fail(path, error.message);
    }
    return filter;
  };

  /** A list's $groupBy, $sort, $limit and $xmlItem. */
  function listOptions(scope, value, path) {
    const groupBy = value.$groupBy === undefined ? null : (Array.isArray(value.$groupBy) ? value.$groupBy : [value.$groupBy])
      .map((name, i) => column(scope, name, child(path, `$groupBy[${i}]`), GROUPABLE, 'grouping'));
    if (groupBy?.length === 0) throw fail(path, '$groupBy needs at least one column');
    if (value.$sort !== undefined && !Array.isArray(value.$sort)) throw fail(child(path, '$sort'), 'must be an array of column names');
    const sort = (value.$sort ?? []).map((entry, i) => {
      const desc = typeof entry === 'string' && entry.startsWith('-');
      return { column: column(scope, desc ? entry.slice(1) : entry, child(path, `$sort[${i}]`), GROUPABLE, 'sorting'), desc };
    });
    const limit = value.$limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw fail(child(path, '$limit'), 'must be a non-negative integer');
    const xmlItem = value.$xmlItem ?? 'item';
    if (typeof xmlItem !== 'string' || !XML_NAME.test(xmlItem)) throw fail(child(path, '$xmlItem'), 'must be a valid XML element name');
    return { groupBy, sort, limit: limit ?? Infinity, xmlItem };
  }

  /** A link to another table (section 7): a list of the linked rows ($rows), or the linked rows as one set ($one). */
  function link(scope, value, path, keys) {
    const one = '$one' in value;
    if (one === '$rows' in value) throw fail(path, 'a link needs one of $rows or $one');
    for (const k of keys) if (!(one ? ONE_KEYS : LINK_KEYS).has(k)) throw fail(path, `unknown option '${k}' ${one ? 'with $one' : 'in a linked list'}`);
    const table = value.$from;
    if (typeof table !== 'string') throw fail(child(path, '$from'), '$from must name a table');
    const cols = columnsOf(table);
    if (!cols) throw fail(child(path, '$from'), `unknown table '${table}'`);
    const linked = scopeOf(cols, table);
    const on = value.$on;
    if (on === null || typeof on !== 'object' || Array.isArray(on) || Object.keys(on).length === 0) {
      throw fail(child(path, '$on'), '$on needs at least one column pair, such as { "customer_id": "id" }');
    }
    const pairs = Object.entries(on).map(([childName, parentName]) => {
      const where = child(path, `$on.${childName}`);
      const c = column(linked, childName, where, GROUPABLE, 'a link');
      const p = column(scope, parentName, where, GROUPABLE, 'a link');
      if (c.type !== p.type) throw fail(where, `$on links ${c.type} column '${c.name}' to ${p.type} column '${p.name}': the types must match`);
      return { child: c, parent: p };
    });
    const base = { kind: 'link', table, columns: cols, on: pairs, where: filterOf(linked, value.$filter, child(path, '$filter')), filter: null, one };
    if (one) return { ...base, groupBy: null, sort: [], limit: Infinity, xmlItem: 'item', item: node(linked, value.$one, child(path || 'shape', '$one'), false) };
    const options = listOptions(linked, value, path);
    return { ...base, ...options, item: node(linked, value.$rows, `${path || 'shape'}[]`, !options.groupBy) };
  }

  function node(scope, value, path, inRow) {
    if (typeof value === 'string') return { kind: 'col', column: column(scope, value, path, null, 'a value') };
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return { kind: 'lit', value };
    if (Array.isArray(value)) throw fail(path, 'arrays are not templates; use { "$rows": ... } for a list');
    if (typeof value !== 'object') throw fail(path, `unsupported value ${String(value)}`);
    const keys = Object.keys(value);
    const special = keys.filter((k) => k.startsWith('$'));
    if (special.length === 0) {
      return { kind: 'obj', members: keys.map((k) => [k, node(scope, value[k], child(path, k), inRow)]) };
    }
    if (special.length !== keys.length) throw fail(path, `'$' members cannot be mixed with other members (${keys.join(', ')})`);
    if ('$from' in value) return link(scope, value, path, keys); // allowed in a row: how a row's details nest
    if ('$rows' in value) {
      if (inRow) throw fail(path, 'a list inside a row list needs $groupBy on the outer list');
      for (const k of keys) if (!LIST_KEYS.has(k)) throw fail(path, `unknown list option '${k}'`);
      const options = listOptions(scope, value, path);
      return {
        kind: 'list',
        filter: filterOf(scope, value.$filter, child(path, '$filter')),
        ...options,
        item: node(scope, value.$rows, `${path || 'shape'}[]`, !options.groupBy),
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
        return { kind: 'agg', op: key.slice(1), column: column(scope, arg, child(path, key), key === '$sum' ? SUMMABLE : ORDERED, key) };
      default: throw fail(path, `unknown operator '${key}'`);
    }
  }

  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) throw fail('', 'must be an object');
  return node(scopeOf(columns, null), shape, '', false);
}

/** Columns and aggregates a set-context template uses directly (not inside its lists). */
function setNeeds(node, needs = { columns: new Map(), aggs: [] }) {
  switch (node.kind) {
    case 'col': needs.columns.set(node.column.name, node.column); break;
    case 'agg': needs.aggs.push(node); break;
    case 'obj': for (const [, member] of node.members) setNeeds(member, needs); break;
    case 'link': for (const { parent } of node.on) needs.columns.set(parent.name, parent); break; // the set's first values link
    default: break; // lit, meta, list
  }
  return needs;
}

/** Columns a one-row template uses (links: the row's columns they are linked on). */
function rowColumns(node, names = new Set()) {
  if (node.kind === 'col') names.add(node.column.name);
  else if (node.kind === 'obj') for (const [, member] of node.members) rowColumns(member, names);
  else if (node.kind === 'link') for (const { parent } of node.on) names.add(parent.name);
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
    const text = this.#compiled(node);
    return (values, aggs) => {
      this.out += this.#prefix() + text(values, aggs);
    };
  }

  #compiled(node) {
    const depth = this.stack.length;
    const cache = (node.json ??= []);
    return (cache[depth] ??= compileJson(node, depth, this.pretty, this.metadata, this.one));
  }

  /** Writes a template without lists here: as writer(node)(values, aggs), without a writer to keep. */
  write(node, values, aggs) {
    this.out += this.#prefix() + this.#compiled(node)(values, aggs);
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
    const text = this.#compiled(node, this.#name());
    return (values, aggs) => {
      this.pendingKey = null;
      this.out += text(values, aggs);
    };
  }

  #compiled(node, name) {
    const depth = this.stack.length;
    const byDepth = (node.xml ??= []);
    const byName = (byDepth[depth] ??= new Map());
    let text = byName.get(name);
    if (!text) byName.set(name, (text = compileXml(node, depth, xmlTag(name), this.metadata, this.one)));
    return text;
  }

  write(node, values, aggs) {
    this.out += this.#compiled(node, this.#name())(values, aggs);
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
const jsonText = (type, column) => {
  const text = type === 'list' || type === 'object' ? (v) => nestedJson(column, v) : JSON_TEXT[type] ?? ((v) => JSON.stringify(v) ?? 'null');
  return (v) => (v === null || v === undefined ? 'null' : text(v));
};

/**
 * (values, aggs) => JSON text of a template without lists, written where `depth` containers are open. `one` gives the
 * text of a $one link (see shapePieces): made once per linked key.
 */
function compileJson(node, depth, pretty, metadata, one) {
  switch (node.kind) {
    case 'col': {
      const text = jsonText(node.column.type, node.column);
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
    case 'link': {
      const item = compileJson(node.item, depth, pretty, metadata, one);
      return (values) => one(node, values, item, 'null');
    }
    case 'obj': {
      if (!node.members.length) return () => '{}';
      const indent = pretty ? `\n${'  '.repeat(depth + 1)}` : '';
      const colon = pretty ? ': ' : ':';
      const members = node.members.map(([name, member], i) => [
        `${i ? ',' : ''}${indent}${JSON.stringify(name)}${colon}`,
        compileJson(member, depth + 1, pretty, metadata, one),
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
function xmlElement(type, v, indent, tag, column) {
  if (v === null || v === undefined || (type === 'float' && !Number.isFinite(v))) return '';
  const text = type === 'json' ? (typeof v === 'string' ? v : JSON.stringify(v)) : valueToText(type, v, column);
  return `${indent}${tag.open}${xmlEscape(text)}${tag.close}\n`;
}

/** (values, aggs) => XML text of a template without lists: element `tag` where `depth` elements are open. */
function compileXml(node, depth, tag, metadata, one) {
  const indent = '  '.repeat(depth);
  switch (node.kind) {
    case 'col': {
      const { name, type } = node.column;
      return (values) => xmlElement(type, values[name], indent, tag, node.column);
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
    case 'link': {
      const item = compileXml(node.item, depth, tag, metadata, one);
      return (values) => one(node, values, item, ''); // nothing linked: omitted, as nulls are
    }
    case 'obj': {
      const members = node.members.map(([name, member]) => compileXml(member, depth + 1, xmlTag(name), metadata, one));
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
// Links between tables: linked tables small enough to be read once are kept by key. Larger ones are read in step with
// their parents when every link follows the tables' sort order (one pass each), otherwise per batch of parents (one
// query per link and batch, which reads about the whole linked table: larger batches mean fewer passes, more memory).
const LINK_BATCH = { memory: 2_500, balanced: 10_000, speed: 20_000 };
const LINK_TABLE_ROWS = { memory: 10_000, balanced: 100_000, speed: 1_000_000 };
// Rows a linked table's pass skips before it looks for the next parent's rows with a query instead (parents far apart).
const SEEK_AFTER = 2_048;

/** Internal options: parents per batch of linked rows, and the largest linked table held whole (tests use small ones). */
export const SHAPE_LINK_BATCH = Symbol('jazmin.shapeLinkBatch');
export const SHAPE_LINK_TABLE_ROWS = Symbol('jazmin.shapeLinkTableRows');
/** Internal option: an object whose `streams` becomes the number of linked tables read in step (tests check the path). */
export const SHAPE_LINK_STATS = Symbol('jazmin.shapeLinkStats');

/** Internal option: rows per batch (tests use small batches). */
export const SHAPE_BATCH_ROWS = Symbol('jazmin.shapeBatchRows');

/**
 * A map keyed by a link key: one column's value, or (several columns) an array of values, kept as nested maps so no
 * text is built per row to look a key up.
 */
class KeyMap {
  constructor(width) {
    this.width = width;
    this.map = new Map();
    this.size = 0;
  }

  #last(key, create) {
    let map = this.map;
    for (let i = 0; i < this.width - 1; i++) {
      let next = map.get(key[i]);
      if (next === undefined) {
        if (!create) return undefined;
        map.set(key[i], (next = new Map()));
      }
      map = next;
    }
    return map;
  }

  get(key) {
    return this.width === 1 ? this.map.get(key) : this.#last(key, false)?.get(key[this.width - 1]);
  }

  has(key) {
    if (this.width === 1) return this.map.has(key);
    return this.#last(key, false)?.has(key[this.width - 1]) ?? false;
  }

  set(key, value) {
    const map = this.width === 1 ? this.map : this.#last(key, true);
    const last = this.width === 1 ? key : key[this.width - 1];
    if (!map.has(last)) this.size++;
    map.set(last, value);
  }

  clear() {
    this.map.clear();
    this.size = 0;
  }
}

/** Does a template contain a list (at any depth)? */
function hasList(node) {
  if (node.kind === 'list') return true;
  if (node.kind === 'link') return !node.one || hasList(node.item); // a $one without lists is a value
  return node.kind === 'obj' && node.members.some(([, member]) => hasList(member));
}

/** Marks each node with whether it holds a list (`lists`): nodes without one are written by compiled writers. */
function markLists(node) {
  if (node.kind === 'obj') for (const [, member] of node.members) markLists(member);
  if (node.kind === 'list' || node.kind === 'link') markLists(node.item);
  node.lists = hasList(node);
  return node;
}

/**
 * The links a template's rows are the parents of: in its objects and in its lists of the same rows, not inside
 * other links (those are the linked rows' own, fetched with them).
 */
function linksIn(node, found = []) {
  if (node.kind === 'link') found.push(node);
  else if (node.kind === 'obj') for (const [, member] of node.members) linksIn(member, found);
  else if (node.kind === 'list') linksIn(node.item, found);
  return found;
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
          if (n.kind === 'leaf' || n.kind === 'nested') names.add(n.name);
          else if (n.kind === 'not') collect(n.item);
          else n.items.forEach(collect);
        })(normalizeFilter(node.filter, columns));
      }
      for (const c of node.groupBy ?? []) names.add(c.name);
      for (const { column } of node.sort) names.add(column.name);
      deepColumns(node.item, columns, names);
      break;
    }
    case 'link': for (const { parent } of node.on) names.add(parent.name); break; // the linked rows are read with the link
    default: break;
  }
  return names;
}

/**
 * A saved shape given by its name (reader.shapes): the shape, and the reader of the table it reads, opened when that is
 * not this reader's (close it after). Any other value is a shape itself.
 */
function resolveShape(reader, shape) {
  if (typeof shape !== 'string') return { reader, shape, opened: null };
  const saved = reader.shapes.find((s) => s.name === shape);
  if (!saved) throw new JazminValidationError(`No saved shape '${shape}' is visible with this key`);
  const table = saved.table ?? reader.tables[0];
  if (table === reader.table) return { reader, shape: saved.shape, opened: null };
  const opened = reader.openTable(table);
  return { reader: opened, shape: saved.shape, opened };
}

/**
 * Writes the shape's output for a reader (format 'json' or 'xml'), streaming: `write(text)` receives it in pieces of
 * about 64 KiB. `shape` is a shape, or the name of one saved in the file. Options: filter (applies to the whole export),
 * pretty (JSON), root (XML root element, default 'export').
 */
export function writeShape(reader, shape, format, options, write) {
  const resolved = resolveShape(reader, shape);
  try {
    writeShapeOn(resolved.reader, resolved.shape, format, options, write);
  } finally {
    resolved.opened?.close();
  }
}

function writeShapeOn(reader, shape, format, options, write) {
  options ??= {};
  const { filter = null, pretty = false, root = 'export' } = options;
  const priority = reader[READ_PRIORITY];
  const batchRows = options[SHAPE_BATCH_ROWS] ?? (priority === 'speed' ? SPEED_BATCH_ROWS : BATCH_ROWS);
  const linkBatchOption = options[SHAPE_LINK_BATCH];
  const priorityName = priority in LINK_BATCH ? priority : 'balanced';
  const tableRows = options[SHAPE_LINK_TABLE_ROWS] ?? LINK_TABLE_ROWS[priority] ?? LINK_TABLE_ROWS.balanced;
  const stats = options[SHAPE_LINK_STATS];
  if (stats) stats.streams = 0;
  const readers = new Map(); // linked tables, opened once: they share the reader's open file and key
  const tableReader = (name) => {
    if (name === reader.table) return reader;
    let r = readers.get(name);
    if (!r) readers.set(name, (r = reader.openTable(name)));
    return r;
  };
  const closeTables = () => {
    for (const r of readers.values()) r.close();
    readers.clear();
  };
  let compiled;
  try {
    compiled = markLists(compileShape(reader.columns, shape, (name) => (reader.tables.includes(name) ? tableReader(name).columns : undefined)));
  } catch (error) {
    closeTables();
    throw error;
  }
  if (format !== 'json' && format !== 'xml') throw new JazminValidationError(`Shapes export JSON or XML, not '${format}'`);
  if (format === 'xml' && !XML_NAME.test(root)) throw new JazminValidationError(`'${root}' is not a valid XML element name`);
  if (filter) normalizeFilter(filter, reader.columns);
  const metadata = reader.metadata ?? {};
  const sink = format === 'json' ? new JsonSink(pretty, metadata) : new XmlSink(root, metadata);
  sink.one = oneText;
  const flush = () => {
    if (sink.out.length < FLUSH) return;
    write(sink.out);
    sink.out = '';
  };
  const sortedBy = reader.sortedBy ?? [];
  const anyColumn = reader.columns[0]?.name;
  const predicates = new WeakMap(); // filter object -> predicate over row objects (rows held in memory)

  // Rows come from the file (a query: indexes, statistics, only the columns asked for) or, inside a group
  // with nested lists, from that group's rows held in memory.
  const fileSource = {
    inMemory: false,
    find: (where, names, limit = Infinity) => reader.find(where, { select: names.size ? [...names] : [anyColumn], limit }),
  };
  const memorySource = (rows, columns = reader.columns) => ({
    inMemory: true,
    /** The rows (held already) matching `where`, as an array: no copy without a filter or a limit. */
    find(where, _names, limit = Infinity) {
      if (!where) return limit < rows.length ? rows.slice(0, limit) : rows;
      let test = predicates.get(where);
      if (!test) predicates.set(where, (test = compileFilter(where, columns)));
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

  // ---- links between tables (docs/design/export-shapes.md section 7) ----

  // While a batch of parents is written (batching > 0), the rows linked to them stay in each link's cache; they are
  // released when the batch is done. A link written on its own (for the root or a group) is a batch of one.
  let batching = 0;
  const NO_ROWS = [];
  const nullNode = markLists({ kind: 'lit', value: null });

  /** A value's identity as a link key (as in filters: decimals by value), or null: null and NaN link nothing. */
  const keyFor = (type, v) => {
    if (v === null || v === undefined) return null;
    const key = toKey(type, v);
    return typeof key === 'number' && Number.isNaN(key) ? null : keyId(key);
  };
  /** A link key for a KeyMap: the value of one column, or the values of several; null when one is null or NaN. */
  const keyOfPairs = (pairs, values, side) => {
    if (pairs.length === 1) return keyFor(pairs[0][side].type, values[pairs[0][side].name]);
    const parts = new Array(pairs.length);
    for (let i = 0; i < pairs.length; i++) {
      const key = keyFor(pairs[i][side].type, values[pairs[i][side].name]);
      if (key === null) return null;
      parts[i] = key;
    }
    return parts;
  };

  /** Readies a link once: its table's reader, the columns read, and (a small table) every row, kept by key. */
  function prepare(link) {
    if (link.reader) return link;
    link.reader = tableReader(link.table);
    const names = deepColumns(link.item, link.columns, new Set(link.on.map((p) => p.child.name)));
    for (const c of link.groupBy ?? []) names.add(c.name);
    for (const { column } of link.sort) names.add(column.name);
    link.select = [...names];
    link.nested = linksIn(link.item);
    link.cache = new KeyMap(link.on.length);
    if (link.reader.rowCount <= tableRows) {
      link.held = new KeyMap(link.on.length);
      for (const row of link.reader.find(link.where, { select: link.select })) {
        const key = keyOfPairs(link.on, row, 'child');
        if (key === null) continue;
        const rows = link.held.get(key);
        if (rows) rows.push(row);
        else link.held.set(key, [row]);
      }
    }
    return link;
  }

  /**
   * Fetches the rows linked to these parents (one query: `in` conditions on the linked columns, and the link's filter),
   * or takes them from a held table, then the linked rows' own links, recursively. Kept in each link's cache.
   */
  function prefetch(link, parents) {
    prepare(link);
    if (link.held && link.nested.length === 0) return; // looked up directly when written
    const want = new KeyMap(link.on.length);
    const wanted = []; // [key, one parent's values]
    for (const values of parents) {
      const key = keyOfPairs(link.on, values, 'parent');
      if (key === null || link.cache.has(key) || want.has(key)) continue;
      want.set(key, true);
      wanted.push([key, values]);
    }
    if (wanted.length === 0) return;
    let found = link.held;
    if (!found) {
      found = new KeyMap(link.on.length);
      const where = { and: link.on.map(({ child, parent }) => ({ [child.name]: { in: wanted.map(([, values]) => values[parent.name]) } })) };
      for (const row of link.reader.find(and(where, link.where), { select: link.select })) {
        const key = keyOfPairs(link.on, row, 'child');
        if (key === null || !want.has(key)) continue; // several columns: their in-conditions together select a superset
        const rows = found.get(key);
        if (rows) rows.push(row);
        else found.set(key, [row]);
      }
    }
    const children = [];
    for (const [key] of wanted) {
      const rows = found.get(key) ?? NO_ROWS;
      link.cache.set(key, rows);
      if (link.nested.length) for (const row of rows) children.push(row);
    }
    for (const nested of link.nested) prefetch(nested, children);
  }

  /** The rows linked to one parent: fetched with its batch, or now (with their own links). */
  function linkedRows(link, values) {
    if (prepare(link).stream) return streamRows(link, link.stream, values);
    const key = keyOfPairs(link.on, values, 'parent');
    if (key === null) return NO_ROWS;
    if (link.held && link.nested.length === 0) return link.held.get(key) ?? NO_ROWS;
    if (!link.cache.has(key)) prefetch(link, [values]);
    return link.cache.get(key);
  }

  /**
   * Whether these links follow the sort order of their parents and of their own tables: each linked table is sorted by
   * the linked columns, and the parents arrive in that order (`parentSorted`: the parents' table order, or [] when it
   * is not known). Then a batch's linked rows lie together, and small batches read each linked table about once.
   */
  function aligned(links, parentSorted) {
    return links.every((link) => {
      prepare(link);
      const sorted = link.reader.sortedBy ?? [];
      const nestedOrder = link.sort.length || link.groupBy ? [] : sorted;
      if (link.held) return aligned(link.nested, []); // held: looked up in the parents' order
      for (let i = 0; i < link.on.length; i++) {
        const pair = link.on.find((p) => p.child.name === sorted[i]);
        if (!pair || pair.child.type === 'float' || parentSorted[i] !== pair.parent.name) return false;
      }
      return aligned(link.nested, nestedOrder);
    });
  }

  // ---- links read in step with their parents ----

  // A streamed link's table is sorted by the linked columns and its parents arrive in that order, so one forward pass
  // over the table finds every parent's rows, and only one parent's rows are held.

  function startStreams(links) {
    for (const link of links) {
      if (!link.held) {
        if (stats) stats.streams++;
        const sorted = link.reader.sortedBy;
        // The linked columns in the table's sort order: how keys are ordered.
        link.stream = { pairs: link.on.map((_, i) => link.on.find((p) => p.child.name === sorted[i])), rows: null, next: undefined, nextKey: null, lastKey: undefined, last: null };
      }
      startStreams(link.nested);
    }
  }

  function stopStreams(links) {
    for (const link of links) {
      link.stream?.rows?.return?.();
      link.stream = null;
      stopStreams(link.nested);
    }
  }

  /** A row's key in the linked table's order: one key, or several in sort order; null when one is null (links nothing). */
  function streamKey(stream, values, side) {
    const { pairs } = stream;
    if (pairs.length === 1) {
      const v = values[pairs[0][side].name];
      return v === null || v === undefined ? null : toKey(pairs[0][side].type, v);
    }
    const key = new Array(pairs.length);
    for (let i = 0; i < key.length; i++) {
      const v = values[pairs[i][side].name];
      if (v === null || v === undefined) return null;
      key[i] = toKey(pairs[i][side].type, v);
    }
    return key;
  }

  function compareStreamKeys(stream, a, b) {
    if (stream.pairs.length === 1) return compareKeys(a, b);
    for (let i = 0; i < a.length; i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return 0;
  }

  /** (Re)starts a stream's pass at a parent: the rows from its leading linked value on (statistics skip the rest). */
  function seek(link, stream, values) {
    stream.rows?.return?.();
    const { child, parent } = stream.pairs[0];
    stream.rows = link.reader.find(and({ [child.name]: { gte: values[parent.name] } }, link.where), { select: link.select })[Symbol.iterator]();
    stream.next = undefined;
  }

  /**
   * A streamed link's rows for one parent: read on from where the last parent's ended. Parents out of order (equal
   * parents apart, or a nested link under one) still get their rows, with a query of their own.
   */
  function streamRows(link, stream, values) {
    const key = streamKey(stream, values, 'parent');
    if (key === null) return NO_ROWS;
    if (stream.lastKey !== undefined) {
      const order = compareStreamKeys(stream, key, stream.lastKey);
      if (order === 0) return stream.last;
      if (order < 0) {
        const id = keyOfPairs(link.on, values, 'parent');
        if (!link.cache.has(id)) prefetch(link, [values]);
        return link.cache.get(id);
      }
    }
    if (!stream.rows) seek(link, stream, values);
    const lead = (k) => (stream.pairs.length === 1 ? k : k[0]);
    let rows = null;
    let skipped = 0;
    for (;;) {
      if (stream.next === undefined) {
        const step = stream.rows.next();
        if (step.done) break;
        stream.next = step.value;
        stream.nextKey = streamKey(stream, step.value, 'child');
      }
      const order = stream.nextKey === null ? -1 : compareStreamKeys(stream, stream.nextKey, key); // a null key links nothing
      if (order > 0) break;
      if (order === 0) (rows ??= []).push(stream.next);
      else if (++skipped > SEEK_AFTER && stream.nextKey !== null && compareKeys(lead(stream.nextKey), lead(key)) < 0) {
        seek(link, stream, values); // far behind: skip ahead with the table's statistics
        skipped = 0;
        continue;
      }
      stream.next = undefined;
    }
    stream.lastKey = key;
    return (stream.last = rows ?? NO_ROWS);
  }

  function release(links) {
    for (const link of links) {
      if (!link.held) link.texts?.clear(); // texts made from a held table stay valid for the whole export
      if (link.cache?.size) link.cache.clear();
      if (link.nested) release(link.nested);
    }
  }

  /**
   * The text of a $one without lists (a line's product, an order's count of lines) for one parent: it depends only on
   * the linked rows, so it is made once per key and place (`item`, compiled for it), then reused: a product named on a
   * million lines is written from one string. Outside a batch, the rows fetched for it are released at once.
   */
  function oneText(link, values, item, nullText) {
    const key = keyOfPairs(prepare(link).on, values, 'parent');
    if (key === null) return nullText;
    const texts = (link.texts ??= new Map());
    let memo = texts.get(item);
    if (!memo) texts.set(item, (memo = new KeyMap(link.on.length)));
    let text = memo.get(key);
    if (text !== undefined) return text;
    const top = batching === 0;
    if (top) batching++;
    try {
      const rows = linkedRows(link, values);
      if (rows.length) {
        const { first, aggs } = setValues(link.item, rows);
        text = item(first, aggs);
      } else {
        text = nullText;
      }
    } finally {
      if (top) {
        release([link]);
        batching--;
      }
    }
    memo.set(key, text);
    return text;
  }

  function emitLink(node, ctx) {
    const top = batching === 0;
    if (top) batching++;
    try {
      const rows = linkedRows(node, ctx.row ?? ctx.first);
      const linked = { source: memorySource(rows, node.columns), filter: null, columns: node.columns };
      if (node.one) {
        if (rows.length) emit(node.item, { ...linked, ...setValues(node.item, rows) });
        else sink.write(nullNode);
      } else {
        sink.startArray(node.xmlItem);
        node.groupBy ? emitGroups(node, linked) : emitRows(node, linked);
        sink.endArray();
      }
    } finally {
      if (top) {
        release([node]);
        batching--;
      }
    }
  }

  function scanSet(node, source, where) {
    const needs = setNeeds(node);
    if (!needs.columns.size && !needs.aggs.length) return { source, filter: where, first: {}, aggs: new Map() };
    const names = new Set([...needs.columns.keys(), ...needs.aggs.filter((a) => a.column).map((a) => a.column.name)]);
    return { source, filter: where, ...setValues(node, source.find(where, names, needs.aggs.length ? Infinity : 1)) };
  }

  function emit(node, ctx) {
    if (!node.lists) {
      sink.write(node, ctx.row ?? ctx.first, ctx.aggs);
      flush();
      return;
    }
    switch (node.kind) {
      case 'obj': {
        const values = ctx.row ?? ctx.first;
        sink.startObject();
        for (const [name, member] of node.members) {
          sink.key(name);
          if (!member.lists) sink.write(member, values, ctx.aggs); // no generator for a plain member
          else emit(member, ctx);
        }
        sink.endObject();
        break;
      }
      case 'list':
        sink.startArray(node.xmlItem);
        node.groupBy ? emitGroups(node, ctx) : emitRows(node, ctx);
        sink.endArray();
        break;
      case 'link': emitLink(node, ctx); break;
      default: throw new Error(`unknown node ${node.kind}`);
    }
    flush();
  }

  function emitRows(node, ctx) {
    if (!node.names) { // the columns a list reads: worked out once, not per group it is written for
      node.names = rowColumns(node.item);
      for (const { column } of node.sort) node.names.add(column.name);
    }
    const { names } = node;
    const where = and(ctx.filter, node.filter);
    const rows = node.sort.length
      ? [...ctx.source.find(where, names)].sort(compareBy(node.sort, (r) => r)).slice(0, node.limit)
      : ctx.source.find(where, names, node.limit);
    const links = (node.itemLinks ??= linksIn(node.item));
    const parentOrder = ctx.source.inMemory || node.sort.length ? [] : sortedBy;
    // 0: every link follows the tables' sort order, so each linked table is read once, in step with the rows.
    const linkBatch = links.length && batching === 0 ? linkBatchOption ?? (node.linkBatch ??= aligned(links, parentOrder) ? 0 : LINK_BATCH[priorityName]) : null;
    if (linkBatch === 0) {
      startStreams(links);
      batching++;
      try {
        for (const row of rows) {
          emit(node.item, { row });
          release(links); // rows a parent fetched for itself (out of order, or under a held link)
        }
      } finally {
        batching--;
        stopStreams(links);
      }
      return;
    }
    if (linkBatch) {
      // Rows with links: written in batches, each batch's linked rows fetched together (one query per link).
      batching++;
      try {
        let batch = [];
        const writeBatch = () => {
          for (const link of links) prefetch(link, batch);
          for (const row of batch) emit(node.item, { row });
          release(links);
          batch = [];
        };
        for (const row of rows) {
          batch.push(row);
          if (batch.length >= linkBatch) writeBatch();
        }
        if (batch.length) writeBatch();
      } finally {
        batching--;
      }
      return;
    }
    if (node.item.lists) {
      for (const row of rows) emit(node.item, { row });
      return;
    }
    const write = sink.writer(node.item); // every item is written at the same place: one compiled writer
    for (const row of rows) {
      write(row);
      flush();
    }
  }

  /** Emits one group: its first values and aggregates, and nested lists over its rows (held in memory). */
  function emitGroup(node, rows) {
    emit(node.item, { source: memorySource(rows), filter: null, ...setValues(node.item, rows) });
  }

  function emitGroups(node, ctx) {
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
              write(current);
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
        if (current && written < node.limit) write(current);
        return;
      }
      const all = [...groups.values()];
      if (node.sort.length) all.sort(compareBy(node.sort, (g) => g.first));
      for (const group of all.slice(0, node.limit)) write(group);
      return;
    }

    // Nested lists: the group's rows are needed. Read every column the item uses, at any depth.
    const names = deepColumns(node.item, ctx.columns ?? reader.columns, new Set(node.groupBy.map((c) => c.name)));
    for (const { column } of node.sort) names.add(column.name);
    if (contiguous) {
      // Sorted file: one pass, holding one group's rows at a time.
      let rows = [];
      let currentKey = null;
      let written = 0;
      for (const row of ctx.source.find(where, names)) {
        const key = keyOfRow(row);
        if (key !== currentKey && rows.length) {
          emitGroup(node, rows);
          if (++written >= node.limit) return;
          rows = [];
        }
        currentKey = key;
        rows.push(row);
      }
      if (rows.length && written < node.limit) emitGroup(node, rows);
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
      for (const rows of all.slice(0, node.limit)) emitGroup(node, rows);
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
      for (const rows of batch.values()) emitGroup(node, rows);
    }
  }

  try {
    emit(compiled, scanSet(compiled, fileSource, filter));
    sink.end();
    if (sink.out) write(sink.out);
    sink.out = '';
  } finally {
    closeTables();
  }
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

/** JSON Schema of a column's values: lists and objects with their items and fields (spec 5.4). */
function columnSchema(column) {
  const part = (c) => (c.nullable || c.type === 'float' ? nullable(columnSchema(c)) : columnSchema(c)); // a float that is not finite is null
  if (column.type === 'list') return { type: 'array', items: part(column.item) };
  if (column.type === 'object') {
    return {
      type: 'object',
      properties: Object.fromEntries(column.fields.map((f) => [f.name, part(f)])),
      required: column.fields.map((f) => f.name),
      additionalProperties: false,
    };
  }
  return { ...JSON_TYPES[column.type] };
}

function nullable(schema) {
  if (!schema.type) return schema; // any JSON value already allows null
  return { ...schema, type: [schema.type, 'null'] };
}

/** A JSON Schema (draft 2020-12) describing the shape's JSON output for this reader (a shape, or a saved shape's name). */
export function shapeSchema(reader, shape) {
  const resolved = resolveShape(reader, shape);
  try {
    return schemaOf(resolved.reader, resolved.shape);
  } finally {
    resolved.opened?.close();
  }
}

function schemaOf(reader, shape) {
  const opened = [];
  let compiled;
  try {
    compiled = compileShape(reader.columns, shape, (name) => {
      if (!reader.tables.includes(name)) return undefined;
      if (name === reader.table) return reader.columns;
      const table = reader.openTable(name);
      opened.push(table);
      return table.columns;
    });
  } finally {
    for (const table of opened) table.close();
  }
  function schema(node, mayBeEmpty) {
    switch (node.kind) {
      case 'col': {
        const s = columnSchema(node.column);
        return node.column.nullable || mayBeEmpty || node.column.type === 'float' ? nullable(s) : s;
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
      case 'link': return node.one ? nullable(schema(node.item, false)) : { type: 'array', items: schema(node.item, false) };
      default: throw new Error(`unknown node ${node.kind}`);
    }
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema(compiled, true) };
}
