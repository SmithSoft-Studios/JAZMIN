// JAZMIN browser reader, add-on: export shapes, and the saved shapes of a file (reader.shapes(), exports with { shape }). Load it after
// jazmin-browser-core.js (the full jazmin-browser.js already has it).
// Built by js/scripts/build-browser.mjs from js/browser/src: change those, then run it.
(function (global) {
  'use strict';

  const internals = global.JazminBrowser?.[Symbol.for('jazmin.browser.internals')];
  if (!internals) throw new Error('jazmin-browser-shapes.js needs jazmin-browser-core.js, loaded first');
  const { keyOf, keyHash, compare, compileFilter, planOf, XML_NAME, bytesToBase64, exportText, exportNested, xmlEscape, xmlElement, JazminValidationError, normalizeBigInt, hooks } = internals;

  // ---- export shapes (docs/design/export-shapes.md): the library's js/src/shape.js, for this async reader ------------
  // The same templates, checks and output. Here the tables a shape links are opened before it is checked (openTable is
  // async), and linked rows are fetched for each batch of parents before the batch is written, so the writers stay
  // synchronous; the library may instead read a linked table in step with sorted parents. The output is the same.

  const SHAPE_ORDERED = new Set(['bool', 'int', 'float', 'string', 'datetime', 'decimal']);
  const SHAPE_SUMMABLE = new Set(['int', 'float', 'decimal']);
  const SHAPE_LIST_KEYS = new Set(['$rows', '$filter', '$groupBy', '$sort', '$limit', '$xmlItem']);
  const SHAPE_LINK_KEYS = new Set(['$from', '$on', ...SHAPE_LIST_KEYS]);
  const SHAPE_ONE_KEYS = new Set(['$from', '$on', '$one', '$filter']);
  const SHAPE_FLUSH = 64 * 1024;
  const SHAPE_BATCH_ROWS = 100_000; // rows held at a time when grouping an unsorted file with nested lists
  const SHAPE_LINK_BATCH = 10_000; // parents whose linked rows are fetched together (one query per link)
  const SHAPE_LINK_TABLE_ROWS = 100_000; // linked tables this small are read once and kept by key
  const shapeFail = (path, message) => new JazminValidationError(`Shape${path ? ` at ${path}` : ''}: ${message}`);
  const shapePath = (path, name) => (path ? `${path}.${name}` : name);

  /** Every table a shape links ($from, at any depth). */
  function shapeTables(shape, names = new Set()) {
    if (shape && typeof shape === 'object' && !Array.isArray(shape)) {
      if (typeof shape.$from === 'string') names.add(shape.$from);
      for (const value of Object.values(shape)) shapeTables(value, names);
    }
    return names;
  }

  /** A saved shape given by its name (reader.shapes()): the shape, and the reader of the table it reads. */
  async function resolveShape(reader, shape) {
    if (typeof shape !== 'string') return { reader, shape };
    const saved = (await reader.shapes()).find((s) => s.name === shape);
    if (!saved) throw new JazminValidationError(`No saved shape '${shape}' is visible with this key`);
    const table = saved.table ?? reader.tables[0];
    return { reader: table === reader.table ? reader : await reader.openTable(table), shape: saved.shape };
  }

  /** Readers of the tables a shape uses, by name: the reader's own, and those it links that the file has. */
  async function shapeReaders(reader, shape) {
    const readers = new Map([[reader.table, reader]]);
    for (const name of shapeTables(shape)) if (!readers.has(name) && reader.tables.includes(name)) readers.set(name, await reader.openTable(name));
    return readers;
  }

  /**
   * Checks a shape against the columns a reader can see (and those of the tables it links: columnsOf(name)) and
   * returns it compiled. Throws a JazminValidationError naming the place of the first mistake.
   */
  function compileShape(columns, shape, columnsOf) {
    const scopeOf = (cols, table) => ({ table, columns: cols, byName: new Map(cols.map((c, i) => [c.name, { ...c, index: i }])) });
    const column = (scope, name, path, allowed, what) => {
      if (typeof name !== 'string') throw shapeFail(path, `${what} must name a column`);
      const c = scope.byName.get(name);
      if (!c) throw shapeFail(path, `unknown or hidden column '${name}'${scope.table === null ? '' : ` in table '${scope.table}'`}`);
      if (allowed && !allowed.has(c.type)) throw shapeFail(path, `${what} is not supported on ${c.type} column '${name}'`);
      return c;
    };
    const filterOf = (scope, filter, path) => {
      if (filter === undefined || filter === null) return null;
      try {
        compileFilter(filter, scope.columns);
      } catch (error) {
        throw shapeFail(path, error.message.startsWith('Invalid filter: ') ? error.message : `Invalid filter: ${error.message}`);
      }
      return filter;
    };

    function listOptions(scope, value, path) {
      const groupBy = value.$groupBy === undefined ? null : (Array.isArray(value.$groupBy) ? value.$groupBy : [value.$groupBy])
        .map((name, i) => column(scope, name, shapePath(path, `$groupBy[${i}]`), SHAPE_ORDERED, 'grouping'));
      if (groupBy?.length === 0) throw shapeFail(path, '$groupBy needs at least one column');
      if (value.$sort !== undefined && !Array.isArray(value.$sort)) throw shapeFail(shapePath(path, '$sort'), 'must be an array of column names');
      const sort = (value.$sort ?? []).map((entry, i) => {
        const desc = typeof entry === 'string' && entry.startsWith('-');
        return { column: column(scope, desc ? entry.slice(1) : entry, shapePath(path, `$sort[${i}]`), SHAPE_ORDERED, 'sorting'), desc };
      });
      const limit = value.$limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw shapeFail(shapePath(path, '$limit'), 'must be a non-negative integer');
      const xmlItem = value.$xmlItem ?? 'item';
      if (typeof xmlItem !== 'string' || !XML_NAME.test(xmlItem)) throw shapeFail(shapePath(path, '$xmlItem'), 'must be a valid XML element name');
      return { groupBy, sort, limit: limit ?? Infinity, xmlItem };
    }

    function link(scope, value, path, keys) {
      const one = '$one' in value;
      if (one === '$rows' in value) throw shapeFail(path, 'a link needs one of $rows or $one');
      for (const k of keys) if (!(one ? SHAPE_ONE_KEYS : SHAPE_LINK_KEYS).has(k)) throw shapeFail(path, `unknown option '${k}' ${one ? 'with $one' : 'in a linked list'}`);
      const table = value.$from;
      if (typeof table !== 'string') throw shapeFail(shapePath(path, '$from'), '$from must name a table');
      const cols = columnsOf(table);
      if (!cols) throw shapeFail(shapePath(path, '$from'), `unknown table '${table}'`);
      const linked = scopeOf(cols, table);
      const on = value.$on;
      if (on === null || typeof on !== 'object' || Array.isArray(on) || Object.keys(on).length === 0) {
        throw shapeFail(shapePath(path, '$on'), '$on needs at least one column pair, such as { "customer_id": "id" }');
      }
      const pairs = Object.entries(on).map(([childName, parentName]) => {
        const where = shapePath(path, `$on.${childName}`);
        const c = column(linked, childName, where, SHAPE_ORDERED, 'a link');
        const p = column(scope, parentName, where, SHAPE_ORDERED, 'a link');
        if (c.type !== p.type) throw shapeFail(where, `$on links ${c.type} column '${c.name}' to ${p.type} column '${p.name}': the types must match`);
        return { child: c, parent: p };
      });
      const base = { kind: 'link', table, columns: cols, on: pairs, where: filterOf(linked, value.$filter, shapePath(path, '$filter')), filter: null, one };
      if (one) return { ...base, groupBy: null, sort: [], limit: Infinity, xmlItem: 'item', item: node(linked, value.$one, shapePath(path || 'shape', '$one'), false) };
      const options = listOptions(linked, value, path);
      return { ...base, ...options, item: node(linked, value.$rows, `${path || 'shape'}[]`, !options.groupBy) };
    }

    function node(scope, value, path, inRow) {
      if (typeof value === 'string') return { kind: 'col', column: column(scope, value, path, null, 'a value') };
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return { kind: 'lit', value };
      if (Array.isArray(value)) throw shapeFail(path, 'arrays are not templates; use { "$rows": ... } for a list');
      if (typeof value !== 'object') throw shapeFail(path, `unsupported value ${String(value)}`);
      const keys = Object.keys(value);
      const special = keys.filter((k) => k.startsWith('$'));
      if (special.length === 0) return { kind: 'obj', members: keys.map((k) => [k, node(scope, value[k], shapePath(path, k), inRow)]) };
      if (special.length !== keys.length) throw shapeFail(path, `'$' members cannot be mixed with other members (${keys.join(', ')})`);
      if ('$from' in value) return link(scope, value, path, keys);
      if ('$rows' in value) {
        if (inRow) throw shapeFail(path, 'a list inside a row list needs $groupBy on the outer list');
        for (const k of keys) if (!SHAPE_LIST_KEYS.has(k)) throw shapeFail(path, `unknown list option '${k}'`);
        const options = listOptions(scope, value, path);
        return { kind: 'list', filter: filterOf(scope, value.$filter, shapePath(path, '$filter')), ...options, item: node(scope, value.$rows, `${path || 'shape'}[]`, !options.groupBy) };
      }
      if (keys.length !== 1) throw shapeFail(path, `expected one '$' member, found ${keys.join(', ')}`);
      const [key] = keys;
      const arg = value[key];
      switch (key) {
        case '$value': return { kind: 'lit', value: arg };
        case '$meta':
          if (typeof arg !== 'string') throw shapeFail(path, '$meta must name a metadata member');
          return { kind: 'meta', key: arg };
        case '$count':
          if (inRow) throw shapeFail(path, 'aggregates need a set of rows (use $groupBy on the list)');
          if (arg !== true) throw shapeFail(path, '$count takes true');
          return { kind: 'agg', op: 'count', column: null };
        case '$sum': case '$min': case '$max':
          if (inRow) throw shapeFail(path, 'aggregates need a set of rows (use $groupBy on the list)');
          return { kind: 'agg', op: key.slice(1), column: column(scope, arg, shapePath(path, key), key === '$sum' ? SHAPE_SUMMABLE : SHAPE_ORDERED, key) };
        default: throw shapeFail(path, `unknown operator '${key}'`);
      }
    }

    if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) throw shapeFail('', 'must be an object');
    return node(scopeOf(columns, null), shape, '', false);
  }

  /** Columns and aggregates a set-context template uses directly (not inside its lists). */
  function setNeeds(node, needs = { columns: new Map(), aggs: [] }) {
    switch (node.kind) {
      case 'col': needs.columns.set(node.column.name, node.column); break;
      case 'agg': needs.aggs.push(node); break;
      case 'obj': for (const [, member] of node.members) setNeeds(member, needs); break;
      case 'link': for (const { parent } of node.on) needs.columns.set(parent.name, parent); break;
      default: break;
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

  /** Orders two non-null values of one column type (decimals by value). */
  const shapeCompare = (a, b, type) => compare(type, keyOf(type, a), keyOf(type, b));

  /** Sort comparison with nulls first (spec 5.3) and descending columns. */
  function shapeCompareBy(sort, valuesOf) {
    return (a, b) => {
      for (const { column, desc } of sort) {
        const x = valuesOf(a)[column.name] ?? null;
        const y = valuesOf(b)[column.name] ?? null;
        const c = x === null ? (y === null ? 0 : -1) : y === null ? 1 : shapeCompare(x, y, column.type);
        if (c !== 0) return desc ? -c : c;
      }
      return 0;
    };
  }

  /** Running aggregate of one column (sum, min, max) or of rows (count). */
  function shapeAccumulator({ op, column }) {
    let count = 0;
    let value = null;
    let scale = 0;
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
            const [, sign, whole, fraction = ''] = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
            const digits = BigInt(`${sign}${whole}${fraction}`);
            if (value === null) value = 0n;
            if (fraction.length > scale) {
              value *= 10n ** BigInt(fraction.length - scale);
              scale = fraction.length;
            }
            value += digits * 10n ** BigInt(scale - fraction.length);
          }
        } else if (value === null || (op === 'min' ? shapeCompare(v, value, column.type) < 0 : shapeCompare(v, value, column.type) > 0)) {
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

  const shapeTypeOf = (node) => (node.kind === 'col' ? node.column.type : node.kind === 'agg' ? (node.op === 'count' ? 'int' : node.column.type) : 'json');
  const groupPart = (v) => (v === null || v === undefined ? '\u0000' : v instanceof Date ? `d${v.getTime()}` : `${typeof v}:${String(v)}`);
  const groupKey = (values) => values.map(groupPart).join('\u0001');
  const andFilters = (a, b) => (!a ? b ?? null : !b ? a : { and: [a, b] });

  class ShapeJsonSink {
    constructor(pretty, metadata) {
      this.out = '';
      this.pretty = pretty;
      this.metadata = metadata;
      this.stack = [];
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

    writer(node) {
      const text = this.#compiled(node);
      return (values, aggs) => {
        this.out += this.#prefix() + text(values, aggs);
      };
    }

    #compiled(node) {
      const depth = this.stack.length;
      const cache = (node.json ??= []);
      return (cache[depth] ??= shapeJson(node, depth, this.pretty, this.metadata, this.one));
    }

    write(node, values, aggs) {
      this.out += this.#prefix() + this.#compiled(node)(values, aggs);
    }

    end() { if (this.pretty) this.out += '\n'; }
  }

  class ShapeXmlSink {
    constructor(root, metadata) {
      this.out = '<?xml version="1.0" encoding="UTF-8"?>\n';
      this.root = root;
      this.metadata = metadata;
      this.stack = [];
      this.pendingKey = null;
    }

    #name() {
      const parent = this.stack[this.stack.length - 1];
      const name = this.stack.length === 0 ? this.root : this.pendingKey ?? parent?.item ?? 'item';
      this.pendingKey = null;
      return name;
    }

    #indent() { return '  '.repeat(this.stack.length); }

    key(name) { this.pendingKey = name; }

    startObject() {
      const tag = xmlElement(this.#name());
      this.out += `${this.#indent()}${tag.open}\n`;
      this.stack.push({ close: tag.close, item: null });
    }

    endObject() {
      const { close } = this.stack.pop();
      this.out += `${this.#indent()}${close}\n`;
    }

    startArray(item) {
      const tag = xmlElement(this.#name());
      this.out += `${this.#indent()}${tag.open}\n`;
      this.stack.push({ close: tag.close, item });
    }

    endArray() { this.endObject(); }

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
      if (!text) byName.set(name, (text = shapeXml(node, depth, xmlElement(name), this.metadata, this.one)));
      return text;
    }

    write(node, values, aggs) {
      this.out += this.#compiled(node, this.#name())(values, aggs);
    }

    end() {}
  }

  const SHAPE_JSON_TEXT = {
    int: String,
    decimal: String,
    float: (v) => (Number.isFinite(v) ? String(v) : 'null'),
    datetime: (v) => `"${v.toISOString()}"`,
    bool: (v) => (v ? 'true' : 'false'),
    binary: (v) => `"${bytesToBase64(v)}"`,
  };
  const shapeJsonText = (type, column) => {
    const text = type === 'list' || type === 'object' ? (v) => exportNested(column, v) : SHAPE_JSON_TEXT[type] ?? ((v) => JSON.stringify(v) ?? 'null');
    return (v) => (v === null || v === undefined ? 'null' : text(v));
  };

  /** (values, aggs) => JSON text of a template without lists, written where `depth` containers are open. */
  function shapeJson(node, depth, pretty, metadata, one) {
    switch (node.kind) {
      case 'col': {
        const text = shapeJsonText(node.column.type, node.column);
        const { name } = node.column;
        return (values) => text(values[name]);
      }
      case 'lit': {
        const text = shapeJsonText('json')(node.value);
        return () => text;
      }
      case 'meta': {
        const text = shapeJsonText('json')(metadata[node.key]);
        return () => text;
      }
      case 'agg': {
        const text = shapeJsonText(shapeTypeOf(node));
        return (values, aggs) => text(aggs.get(node));
      }
      case 'link': {
        const item = shapeJson(node.item, depth, pretty, metadata, one);
        return (values) => one(node, values, item, 'null');
      }
      case 'obj': {
        if (!node.members.length) return () => '{}';
        const indent = pretty ? `\n${'  '.repeat(depth + 1)}` : '';
        const colon = pretty ? ': ' : ':';
        const members = node.members.map(([name, member], i) => [`${i ? ',' : ''}${indent}${JSON.stringify(name)}${colon}`, shapeJson(member, depth + 1, pretty, metadata, one)]);
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

  /** An XML element for a value; nulls and non-finite floats are left out. */
  function shapeXmlValue(type, v, indent, tag, column) {
    if (v === null || v === undefined || (type === 'float' && !Number.isFinite(v))) return '';
    const text = type === 'json' ? (typeof v === 'string' ? v : JSON.stringify(v)) : exportText(type, v, column);
    return `${indent}${tag.open}${xmlEscape(text)}${tag.close}\n`;
  }

  /** (values, aggs) => XML text of a template without lists: element `tag` where `depth` elements are open. */
  function shapeXml(node, depth, tag, metadata, one) {
    const indent = '  '.repeat(depth);
    switch (node.kind) {
      case 'col': {
        const { name, type } = node.column;
        return (values) => shapeXmlValue(type, values[name], indent, tag, node.column);
      }
      case 'lit': {
        const text = shapeXmlValue('json', node.value, indent, tag);
        return () => text;
      }
      case 'meta': {
        const text = shapeXmlValue('json', metadata[node.key], indent, tag);
        return () => text;
      }
      case 'agg': {
        const type = shapeTypeOf(node);
        return (values, aggs) => shapeXmlValue(type, aggs.get(node), indent, tag);
      }
      case 'link': {
        const item = shapeXml(node.item, depth, tag, metadata, one);
        return (values) => one(node, values, item, '');
      }
      case 'obj': {
        const members = node.members.map(([name, member]) => shapeXml(member, depth + 1, xmlElement(name), metadata, one));
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

  /** A map keyed by a link key: one column's value, or (several columns) an array of values, as nested maps. */
  class ShapeKeyMap {
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

    get(key) { return this.width === 1 ? this.map.get(key) : this.#last(key, false)?.get(key[this.width - 1]); }

    has(key) { return this.width === 1 ? this.map.has(key) : this.#last(key, false)?.has(key[this.width - 1]) ?? false; }

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

  function shapeHasList(node) {
    if (node.kind === 'list') return true;
    if (node.kind === 'link') return !node.one || shapeHasList(node.item);
    return node.kind === 'obj' && node.members.some(([, member]) => shapeHasList(member));
  }

  function shapeMarkLists(node) {
    if (node.kind === 'obj') for (const [, member] of node.members) shapeMarkLists(member);
    if (node.kind === 'list' || node.kind === 'link') shapeMarkLists(node.item);
    node.lists = shapeHasList(node);
    return node;
  }

  /** The links a template's rows are the parents of: in its objects and its lists of the same rows, not inside links. */
  function shapeLinksIn(node, found = []) {
    if (node.kind === 'link') found.push(node);
    else if (node.kind === 'obj') for (const [, member] of node.members) shapeLinksIn(member, found);
    else if (node.kind === 'list') shapeLinksIn(node.item, found);
    return found;
  }

  /** Every column a template reads, including its lists' filters, groups and sorts (at any depth). */
  function shapeDeepColumns(node, columns, names = new Set()) {
    switch (node.kind) {
      case 'col': names.add(node.column.name); break;
      case 'agg': if (node.column) names.add(node.column.name); break;
      case 'obj': for (const [, member] of node.members) shapeDeepColumns(member, columns, names); break;
      case 'list': {
        if (node.filter) {
          (function collect(n) {
            if (n.kind === 'leaf' || n.kind === 'nested') names.add(n.column.name);
            else if (n.kind === 'not') collect(n.item);
            else n.items.forEach(collect);
          })(planOf(node.filter, columns));
        }
        for (const c of node.groupBy ?? []) names.add(c.name);
        for (const { column } of node.sort) names.add(column.name);
        shapeDeepColumns(node.item, columns, names);
        break;
      }
      case 'link': for (const { parent } of node.on) names.add(parent.name); break;
      default: break;
    }
    return names;
  }

  /**
   * Writes a shape's output for a reader (format 'json' or 'xml'): `write(text)` receives it in pieces of about 64 KiB.
   * options: filter (the whole export's), pretty (JSON), root (XML root element, default 'export'), signal.
   */
  async function writeShape(reader, shape, format, options, write) {
    const { filter = null, pretty = false, root = 'export', signal, onProgress } = options ?? {};
    if (format !== 'json' && format !== 'xml') throw new JazminValidationError(`Shapes export JSON or XML, not '${format}'`);
    ({ reader, shape } = await resolveShape(reader, shape));
    const readers = await shapeReaders(reader, shape);
    const compiled = shapeMarkLists(compileShape(reader.columns, shape, (name) => readers.get(name)?.columns));
    if (format === 'xml' && !XML_NAME.test(root)) throw new JazminValidationError(`'${root}' is not a valid XML element name`);
    if (filter) compileFilter(filter, reader.columns);
    const metadata = reader.metadata ?? {};
    const sink = format === 'json' ? new ShapeJsonSink(pretty, metadata) : new ShapeXmlSink(root, metadata);
    sink.one = oneText;
    const flush = () => {
      signal?.throwIfAborted();
      if (sink.out.length < SHAPE_FLUSH) return;
      write(sink.out);
      sink.out = '';
    };
    const sortedBy = reader.sortedBy ?? [];
    const anyColumn = reader.columns[0]?.name;
    const predicates = new WeakMap();
    const collect = async (rows) => {
      if (Array.isArray(rows)) return rows;
      const all = [];
      for await (const row of rows) all.push(row);
      return all;
    };

    // Rows come from the file (a query) or, inside a group with nested lists, from that group's rows held in memory.
    const fileSource = {
      inMemory: false,
      find: (where, names, limit = Infinity) => reader.find(where, { select: names.size ? [...names] : [anyColumn], limit, signal, onProgress }),
    };
    const memorySource = (rows, columns = reader.columns) => ({
      inMemory: true,
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
    async function setValues(node, rows) {
      const needs = setNeeds(node);
      const accumulators = needs.aggs.map((a) => [a, shapeAccumulator(a)]);
      let first = null;
      for await (const row of rows) {
        first ??= row;
        if (!accumulators.length) break;
        for (const [, acc] of accumulators) acc.add(row);
      }
      return { first: first ?? {}, aggs: new Map(accumulators.map(([a, acc]) => [a, acc.result()])) };
    }

    // ---- links between tables ----

    let batching = 0;
    const NO_ROWS = [];
    const nullNode = shapeMarkLists({ kind: 'lit', value: null });
    const keyFor = (type, v) => {
      if (v === null || v === undefined) return null;
      const key = keyOf(type, v);
      return typeof key === 'number' && Number.isNaN(key) ? null : keyHash(type, key);
    };
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
    async function prepare(link) {
      if (link.reader) return link;
      link.reader = readers.get(link.table);
      const names = shapeDeepColumns(link.item, link.columns, new Set(link.on.map((p) => p.child.name)));
      for (const c of link.groupBy ?? []) names.add(c.name);
      for (const { column } of link.sort) names.add(column.name);
      link.select = [...names];
      link.nested = shapeLinksIn(link.item);
      link.cache = new ShapeKeyMap(link.on.length);
      if (link.reader.rowCount <= SHAPE_LINK_TABLE_ROWS) {
        const held = new ShapeKeyMap(link.on.length);
        for await (const row of link.reader.find(link.where, { select: link.select, signal })) {
          const key = keyOfPairs(link.on, row, 'child');
          if (key === null) continue;
          const rows = held.get(key);
          if (rows) rows.push(row);
          else held.set(key, [row]);
        }
        link.held = held;
      }
      return link;
    }

    /** Fetches the rows linked to these parents (one query), then their own links' rows; kept in each link's cache. */
    async function prefetch(link, parents) {
      await prepare(link);
      if (link.held && link.nested.length === 0) return;
      const want = new ShapeKeyMap(link.on.length);
      const wanted = [];
      for (const values of parents) {
        const key = keyOfPairs(link.on, values, 'parent');
        if (key === null || link.cache.has(key) || want.has(key)) continue;
        want.set(key, true);
        wanted.push([key, values]);
      }
      if (wanted.length === 0) return;
      let found = link.held;
      if (!found) {
        found = new ShapeKeyMap(link.on.length);
        const where = { and: link.on.map(({ child, parent }) => ({ [child.name]: { in: wanted.map(([, values]) => values[parent.name]) } })) };
        for await (const row of link.reader.find(andFilters(where, link.where), { select: link.select, signal })) {
          const key = keyOfPairs(link.on, row, 'child');
          if (key === null || !want.has(key)) continue;
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
      for (const nested of link.nested) await prefetch(nested, children);
    }

    /** The rows linked to one parent: fetched already (ready, a batch, or the parent's link). */
    function linkedRows(link, values) {
      const key = keyOfPairs(link.on, values, 'parent');
      if (key === null) return NO_ROWS;
      if (link.held && link.nested.length === 0) return link.held.get(key) ?? NO_ROWS;
      const rows = link.cache.get(key);
      if (rows === undefined) throw new Error('JAZMIN shape: linked rows were not fetched');
      return rows;
    }

    /** Fetches what the links of a template without lists need for these values; returns the links it fetched for. */
    async function ready(node, values) {
      const fetched = [];
      for (const link of (node.readyLinks ??= shapeLinksIn(node))) {
        await prepare(link);
        if (link.held && link.nested.length === 0) continue;
        const key = keyOfPairs(link.on, values, 'parent');
        if (key === null || link.cache.has(key)) continue;
        await prefetch(link, [values]);
        fetched.push(link);
      }
      return fetched;
    }

    function release(links) {
      for (const link of links) {
        if (!link.held) link.texts?.clear();
        if (link.cache?.size) link.cache.clear();
        if (link.nested) release(link.nested);
      }
    }

    /** The text of a $one without lists for one parent: made once per key and place, then reused. */
    function oneText(link, values, item, nullText) {
      const key = keyOfPairs(link.on, values, 'parent');
      if (key === null) return nullText;
      const texts = (link.texts ??= new Map());
      let memo = texts.get(item);
      if (!memo) texts.set(item, (memo = new ShapeKeyMap(link.on.length)));
      let text = memo.get(key);
      if (text !== undefined) return text;
      const rows = linkedRows(link, values);
      if (rows.length) {
        const needs = setNeeds(link.item);
        const accumulators = needs.aggs.map((a) => [a, shapeAccumulator(a)]);
        for (const row of rows) for (const [, acc] of accumulators) acc.add(row);
        text = item(rows[0], new Map(accumulators.map(([a, acc]) => [a, acc.result()])));
      } else {
        text = nullText;
      }
      memo.set(key, text);
      return text;
    }

    /** Writes a template without lists for these values: its links' rows fetched first. */
    async function writePlain(node, values, aggs) {
      const fetched = await ready(node, values);
      sink.write(node, values, aggs);
      if (batching === 0 && fetched.length) release(fetched);
      flush();
    }

    async function emitLink(node, ctx) {
      const top = batching === 0;
      if (top) batching++;
      try {
        const values = ctx.row ?? ctx.first;
        await prepare(node);
        const key = keyOfPairs(node.on, values, 'parent');
        if (key !== null && !(node.held && node.nested.length === 0) && !node.cache.has(key)) await prefetch(node, [values]);
        const rows = linkedRows(node, values);
        const linked = { source: memorySource(rows, node.columns), filter: null, columns: node.columns };
        if (node.one) {
          if (rows.length) await emit(node.item, { ...linked, ...(await setValues(node.item, rows)) });
          else sink.write(nullNode);
        } else {
          sink.startArray(node.xmlItem);
          await (node.groupBy ? emitGroups(node, linked) : emitRows(node, linked));
          sink.endArray();
        }
      } finally {
        if (top) {
          release([node]);
          batching--;
        }
      }
    }

    async function scanSet(node, source, where) {
      const needs = setNeeds(node);
      if (!needs.columns.size && !needs.aggs.length) return { source, filter: where, first: {}, aggs: new Map() };
      const names = new Set([...needs.columns.keys(), ...needs.aggs.filter((a) => a.column).map((a) => a.column.name)]);
      return { source, filter: where, ...(await setValues(node, source.find(where, names, needs.aggs.length ? Infinity : 1))) };
    }

    async function emit(node, ctx) {
      if (!node.lists) {
        await writePlain(node, ctx.row ?? ctx.first, ctx.aggs);
        return;
      }
      switch (node.kind) {
        case 'obj': {
          const values = ctx.row ?? ctx.first;
          sink.startObject();
          for (const [name, member] of node.members) {
            sink.key(name);
            if (!member.lists) {
              const fetched = await ready(member, values);
              sink.key(name); // ready() may have read: the key is set again for the write
              sink.write(member, values, ctx.aggs);
              if (batching === 0 && fetched.length) release(fetched);
            } else {
              await emit(member, ctx);
            }
          }
          sink.endObject();
          break;
        }
        case 'list':
          sink.startArray(node.xmlItem);
          await (node.groupBy ? emitGroups(node, ctx) : emitRows(node, ctx));
          sink.endArray();
          break;
        case 'link': await emitLink(node, ctx); break;
        default: throw new Error(`unknown node ${node.kind}`);
      }
      flush();
    }

    async function emitRows(node, ctx) {
      if (!node.names) {
        node.names = rowColumns(node.item);
        for (const { column } of node.sort) node.names.add(column.name);
      }
      const { names } = node;
      const where = andFilters(ctx.filter, node.filter);
      const rows = node.sort.length
        ? (await collect(ctx.source.find(where, names))).slice().sort(shapeCompareBy(node.sort, (r) => r)).slice(0, node.limit)
        : ctx.source.find(where, names, node.limit);
      const links = (node.itemLinks ??= shapeLinksIn(node.item));
      if (links.length && batching === 0) {
        // Rows with links: written in batches, each batch's linked rows fetched together (one query per link).
        batching++;
        try {
          let batch = [];
          const writeBatch = async () => {
            for (const link of links) await prefetch(link, batch);
            for (const row of batch) await emit(node.item, { row });
            release(links);
            batch = [];
          };
          for await (const row of rows) {
            batch.push(row);
            if (batch.length >= SHAPE_LINK_BATCH) await writeBatch();
          }
          if (batch.length) await writeBatch();
        } finally {
          batching--;
        }
        return;
      }
      if (node.item.lists) {
        for await (const row of rows) await emit(node.item, { row });
        return;
      }
      if (links.length) {
        for await (const row of rows) await emit(node.item, { row }); // their links' rows: fetched for each row if needed
        return;
      }
      const writer = sink.writer(node.item);
      for await (const row of rows) {
        writer(row);
        flush();
      }
    }

    async function emitGroup(node, rows) {
      await emit(node.item, { source: memorySource(rows), filter: null, ...(await setValues(node.item, rows)) });
    }

    async function emitGroups(node, ctx) {
      const where = andFilters(ctx.filter, node.filter);
      const single = node.groupBy.length === 1 ? node.groupBy[0].name : null;
      const keyOfRow = single ? (row) => groupPart(row[single]) : (row) => groupKey(node.groupBy.map((c) => row[c.name]));
      const contiguous = !ctx.source.inMemory && !node.sort.length && node.groupBy.every((c) => sortedBy.slice(0, node.groupBy.length).includes(c.name));

      if (!shapeHasList(node.item)) {
        const needs = setNeeds(node.item);
        const names = new Set([...node.groupBy.map((c) => c.name), ...needs.columns.keys(), ...node.sort.map((s) => s.column.name)]);
        for (const a of needs.aggs) if (a.column) names.add(a.column.name);
        const start = (row) => ({ first: row, accumulators: needs.aggs.map((a) => [a, shapeAccumulator(a)]) });
        const writeGroup = (group) => emit(node.item, { first: group.first, aggs: new Map(group.accumulators.map(([a, acc]) => [a, acc.result()])) });
        const groups = new Map();
        let current = null;
        let currentKey = null;
        let written = 0;
        for await (const row of ctx.source.find(where, names)) {
          const key = keyOfRow(row);
          let group;
          if (contiguous) {
            if (key !== currentKey) {
              if (current) {
                await writeGroup(current);
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
          if (current && written < node.limit) await writeGroup(current);
          return;
        }
        const all = [...groups.values()];
        if (node.sort.length) all.sort(shapeCompareBy(node.sort, (g) => g.first));
        for (const group of all.slice(0, node.limit)) await writeGroup(group);
        return;
      }

      const names = shapeDeepColumns(node.item, ctx.columns ?? reader.columns, new Set(node.groupBy.map((c) => c.name)));
      for (const { column } of node.sort) names.add(column.name);
      if (contiguous) {
        let rows = [];
        let currentKey = null;
        let written = 0;
        for await (const row of ctx.source.find(where, names)) {
          const key = keyOfRow(row);
          if (key !== currentKey && rows.length) {
            await emitGroup(node, rows);
            if (++written >= node.limit) return;
            rows = [];
          }
          currentKey = key;
          rows.push(row);
        }
        if (rows.length && written < node.limit) await emitGroup(node, rows);
        return;
      }
      if (ctx.source.inMemory) {
        const groups = new Map();
        for (const row of ctx.source.find(where, names)) {
          const key = keyOfRow(row);
          const rows = groups.get(key);
          if (rows) rows.push(row);
          else groups.set(key, [row]);
        }
        const all = [...groups.values()];
        if (node.sort.length) all.sort(shapeCompareBy(node.sort, (rows) => rows[0]));
        for (const rows of all.slice(0, node.limit)) await emitGroup(node, rows);
        return;
      }
      // Unsorted file: find the groups (order, sizes), then collect their rows in bounded batches, one pass per batch.
      const keyNames = new Set([...node.groupBy.map((c) => c.name), ...node.sort.map((s) => s.column.name)]);
      const found = new Map();
      for await (const row of ctx.source.find(where, keyNames)) {
        const key = keyOfRow(row);
        const group = found.get(key);
        if (group) group.count++;
        else found.set(key, { key, first: row, count: 1 });
      }
      let order = [...found.values()];
      if (node.sort.length) order.sort(shapeCompareBy(node.sort, (g) => g.first));
      order = order.slice(0, node.limit);
      for (let start = 0; start < order.length;) {
        const batch = new Map();
        let held = 0;
        for (; start < order.length && (batch.size === 0 || held + order[start].count <= SHAPE_BATCH_ROWS); start++) {
          batch.set(order[start].key, []);
          held += order[start].count;
        }
        for await (const row of ctx.source.find(where, names)) batch.get(keyOfRow(row))?.push(row);
        for (const rows of batch.values()) await emitGroup(node, rows);
      }
    }

    await emit(compiled, await scanSet(compiled, fileSource, filter));
    sink.end();
    if (sink.out) write(sink.out);
    sink.out = '';
  }

  const SHAPE_JSON_TYPES = {
    bool: { type: 'boolean' },
    int: { type: 'integer' },
    float: { type: 'number' },
    decimal: { type: 'number' },
    string: { type: 'string' },
    datetime: { type: 'string', format: 'date-time' },
    binary: { type: 'string', contentEncoding: 'base64' },
    json: {},
  };

  function shapeColumnSchema(column) {
    const part = (c) => (c.nullable || c.type === 'float' ? shapeNullable(shapeColumnSchema(c)) : shapeColumnSchema(c));
    if (column.type === 'list') return { type: 'array', items: part(column.item) };
    if (column.type === 'object') {
      return { type: 'object', properties: Object.fromEntries(column.fields.map((f) => [f.name, part(f)])), required: column.fields.map((f) => f.name), additionalProperties: false };
    }
    return { ...SHAPE_JSON_TYPES[column.type] };
  }

  const shapeNullable = (schema) => (schema.type ? { ...schema, type: [schema.type, 'null'] } : schema);

  /** A JSON Schema (draft 2020-12) describing the shape's JSON output for this reader: the library's shapeSchema. */
  async function shapeSchema(reader, shape) {
    ({ reader, shape } = await resolveShape(reader, shape));
    const readers = await shapeReaders(reader, shape);
    const compiled = compileShape(reader.columns, shape, (name) => readers.get(name)?.columns);
    function schema(node, mayBeEmpty) {
      switch (node.kind) {
        case 'col': {
          const s = shapeColumnSchema(node.column);
          return node.column.nullable || mayBeEmpty || node.column.type === 'float' ? shapeNullable(s) : s;
        }
        case 'lit': return { const: node.value };
        case 'meta': return {};
        case 'agg': return node.op === 'count' ? { type: 'integer', minimum: 0 } : shapeNullable(SHAPE_JSON_TYPES[node.column.type]);
        case 'obj': return {
          type: 'object',
          properties: Object.fromEntries(node.members.map(([name, member]) => [name, schema(member, mayBeEmpty)])),
          required: node.members.map(([name]) => name),
          additionalProperties: false,
        };
        case 'list': return { type: 'array', items: schema(node.item, false) };
        case 'link': return node.one ? shapeNullable(schema(node.item, false)) : { type: 'array', items: schema(node.item, false) };
        default: throw new Error(`unknown node ${node.kind}`);
      }
    }
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema(compiled, true) };
  }

  hooks.shapes = { compileShape, shapeTables, writeShape };

  const API_SHAPES = { shapeSchema };

  Object.assign(global.JazminBrowser, API_SHAPES);
})(globalThis);
