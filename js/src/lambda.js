// Arrow functions as filters (docs/design/js-queries.md): a query's where((t) => t.city === 'Durban' && t.amount < 0)
// is read from its text and turned into the filter language where that is safe, so the reader can use indexes,
// statistics and the sort order. The function itself still runs on the rows the filter lets through, so the answer is
// always the function's: a filter here only ever lets through more rows than the function keeps, never fewer. Where
// they agree on every row (`exact`), the function needn't run, and counts, offsets and limits go to the reader.

// ---- reading a function's text ----------------------------------------------------------------------------------

const PUNCTUATORS = ['===', '!==', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '(', ')', '[', ']', '{', '}', ',', '.', '<', '>', '!', '+', '-', '*', '/', '%', '?', ':', ';', '='];
const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$‌‍]/u;

/** The tokens of a function's text: { type: 'ident' | 'number' | 'string' | 'template' | 'punct', value }. */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('comment');
      i = end + 2;
    } else if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j])) j++;
      tokens.push({ type: 'ident', value: text.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?\.?[0-9_]*(?:[eE][+-]?[0-9_]+)?)n?/.exec(text.slice(i));
      const raw = m[0].replace(/_/g, '');
      tokens.push({ type: 'number', value: raw.endsWith('n') ? BigInt(raw.slice(0, -1)) : Number(raw) });
      i += m[0].length;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') {
          const [decoded, used] = escape(text, j + 1);
          value += decoded;
          j += 1 + used;
        } else {
          value += text[j++];
        }
      }
      if (j >= text.length) throw new SyntaxError('string');
      tokens.push({ type: 'string', value });
      i = j + 1;
    } else if (ch === '`') {
      let j = i + 1;
      let value = '';
      let plain = true;
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') {
          const [decoded, used] = escape(text, j + 1);
          value += decoded;
          j += 1 + used;
        } else {
          if (text[j] === '$' && text[j + 1] === '{') plain = false;
          value += text[j++];
        }
      }
      if (j >= text.length) throw new SyntaxError('template');
      tokens.push(plain ? { type: 'string', value } : { type: 'template', value });
      i = j + 1;
    } else {
      const p = PUNCTUATORS.find((s) => text.startsWith(s, i));
      if (!p) throw new SyntaxError(`character ${ch}`);
      tokens.push({ type: 'punct', value: p });
      i += p.length;
    }
  }
  return tokens;
}

/** An escape in a string literal, after its backslash: [the character(s), the length read]. */
function escape(text, i) {
  const ch = text[i];
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  if (ch in simple && !(ch === '0' && /[0-9]/.test(text[i + 1] ?? ''))) return [simple[ch], 1];
  if (ch === 'x') return [String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)), 3];
  if (ch === 'u' && text[i + 1] === '{') {
    const end = text.indexOf('}', i);
    return [String.fromCodePoint(parseInt(text.slice(i + 2, end), 16)), end - i + 1];
  }
  if (ch === 'u') return [String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)), 5];
  if (ch === '\r' && text[i + 1] === '\n') return ['', 2];
  if (ch === '\n' || ch === '\r') return ['', 1];
  return [ch, 1];
}

/** A small expression parser over the tokens: the parts of JavaScript filters are written in. */
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.at = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.at + offset];
  }

  is(value, offset = 0) {
    const t = this.peek(offset);
    return Boolean(t) && t.type === 'punct' && t.value === value;
  }

  isWord(value, offset = 0) {
    const t = this.peek(offset);
    return Boolean(t) && t.type === 'ident' && t.value === value;
  }

  take(value) {
    if (!this.is(value)) throw new SyntaxError(`expected ${value}`);
    this.at++;
  }

  done() {
    return this.at >= this.tokens.length;
  }

  // Binary operators by precedence: a higher number binds tighter.
  static BINARY = { '??': 1, '||': 1, '&&': 2, '===': 3, '!==': 3, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

  expression(min = 0) {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const precedence = t?.type === 'punct' ? Parser.BINARY[t.value] : undefined;
      if (precedence === undefined || precedence <= min) break;
      this.at++;
      const right = this.expression(precedence);
      left = { kind: t.value === '&&' || t.value === '||' || t.value === '??' ? 'logical' : 'binary', op: t.value, left, right };
    }
    if (min === 0 && this.is('?')) {
      this.at++;
      const yes = this.expression();
      this.take(':');
      return { kind: 'conditional', test: left, yes, no: this.expression() };
    }
    return left;
  }

  unary() {
    if (this.is('!') || this.is('-') || this.is('+')) {
      const op = this.peek().value;
      this.at++;
      return { kind: 'unary', op, argument: this.unary() };
    }
    return this.postfix(this.primary());
  }

  primary() {
    const t = this.peek();
    if (!t) throw new SyntaxError('end');
    this.at++;
    if (t.type === 'number' || t.type === 'string') return { kind: 'literal', value: t.value };
    if (t.type === 'template') return { kind: 'unknown' };
    if (t.type === 'ident') {
      if (t.value === 'true' || t.value === 'false') return { kind: 'literal', value: t.value === 'true' };
      if (t.value === 'null') return { kind: 'literal', value: null };
      if (t.value === 'undefined') return { kind: 'literal', value: undefined };
      if (t.value === 'new') {
        const callee = this.primary();
        const args = this.is('(') ? this.args() : [];
        return { kind: 'new', callee, args };
      }
      if (t.value === 'typeof' || t.value === 'void' || t.value === 'await' || t.value === 'function' || t.value === 'class') throw new SyntaxError(t.value);
      if (this.is('=>')) throw new SyntaxError('function');
      return { kind: 'ident', name: t.value };
    }
    if (t.value === '(') {
      if (this.isArrowAhead()) throw new SyntaxError('function');
      const inner = this.expression();
      this.take(')');
      return inner;
    }
    if (t.value === '[') {
      const elements = [];
      while (!this.is(']')) {
        if (this.is('...')) throw new SyntaxError('spread');
        elements.push(this.expression());
        if (!this.is(']')) this.take(',');
      }
      this.take(']');
      return { kind: 'array', elements };
    }
    throw new SyntaxError(t.value);
  }

  /** After '(': does a parameter list and '=>' follow (a function inside the expression)? */
  isArrowAhead() {
    let depth = 1;
    for (let k = this.at; k < this.tokens.length; k++) {
      const t = this.tokens[k];
      if (t.type !== 'punct') continue;
      if (t.value === '(') depth++;
      else if (t.value === ')' && --depth === 0) return this.tokens[k + 1]?.type === 'punct' && this.tokens[k + 1].value === '=>';
    }
    return false;
  }

  postfix(node) {
    for (;;) {
      if (this.is('.') || this.is('?.')) {
        const optional = this.peek().value === '?.';
        this.at++;
        if (optional && this.is('(')) {
          node = { kind: 'call', callee: node, args: this.args(), optional };
          continue;
        }
        if (optional && this.is('[')) {
          this.at++;
          node = { kind: 'member', object: node, property: this.expression(), computed: true, optional };
          this.take(']');
          continue;
        }
        const name = this.peek();
        if (name?.type !== 'ident') throw new SyntaxError('property');
        this.at++;
        node = { kind: 'member', object: node, property: name.value, computed: false, optional };
      } else if (this.is('[')) {
        this.at++;
        node = { kind: 'member', object: node, property: this.expression(), computed: true, optional: false };
        this.take(']');
      } else if (this.is('(')) {
        node = { kind: 'call', callee: node, args: this.args(), optional: false };
      } else {
        return node;
      }
    }
  }

  args() {
    this.take('(');
    const list = [];
    while (!this.is(')')) {
      if (this.is('...')) throw new SyntaxError('spread');
      list.push(this.expression());
      if (!this.is(')')) this.take(',');
    }
    this.take(')');
    return list;
  }
}

/**
 * A function's parameters and body, from its text: { params: [names], destructured: Set | null, body: expression
 * node | null (a body this reader can't follow), tokens }. Arrow functions with an expression or `{ return …; }` body,
 * and `function (…) { return …; }`.
 */
export function readFunction(fn) {
  let tokens;
  const text = Function.prototype.toString.call(fn);
  try {
    if (text.includes('[native code]')) throw new SyntaxError('native'); // built in, or bound: its text says nothing
    tokens = tokenize(text);
  } catch {
    return { params: null, destructured: null, body: null, tokens: null };
  }
  const p = new Parser(tokens);
  const params = [];
  let destructured = null;
  let header = false; // the parameters were read: a body that can't be read still has them
  try {
    if (p.isWord('async')) throw new SyntaxError('async');
    if (p.isWord('function')) {
      p.at++;
      if (p.is('*')) throw new SyntaxError('generator');
      if (p.peek()?.type === 'ident') p.at++; // its name
    }
    const param = () => {
      if (p.is('{')) {
        p.at++;
        destructured = new Set();
        while (!p.is('}')) {
          const name = p.peek();
          if (name?.type !== 'ident' || p.is(':', 1) || p.is('=', 1)) throw new SyntaxError('pattern');
          destructured.add(name.value);
          p.at++;
          if (!p.is('}')) p.take(',');
        }
        p.take('}');
        params.push(null);
        return;
      }
      const name = p.peek();
      if (name?.type !== 'ident' || p.is('=', 1)) throw new SyntaxError('parameter');
      params.push(name.value);
      p.at++;
    };
    if (p.is('(')) {
      p.at++;
      while (!p.is(')')) {
        param();
        if (!p.is(')')) p.take(',');
      }
      p.take(')');
    } else {
      param();
    }
    if (p.is('=>')) p.at++;
    else if (!p.is('{')) throw new SyntaxError('header');
    header = true;
    let body;
    if (p.is('{')) {
      p.at++;
      if (!p.isWord('return')) throw new SyntaxError('statements');
      p.at++;
      body = p.expression();
      if (p.is(';')) p.at++;
      p.take('}');
    } else {
      body = p.expression();
    }
    if (!p.done()) throw new SyntaxError('more');
    return { params, destructured, body, tokens };
  } catch {
    return header ? { params, destructured, body: null, tokens } : { params: null, destructured: null, body: null, tokens: null };
  }
}

/**
 * The row's columns a function reads: a Set of names, or '*' when it uses the row in a way that may read any column
 * (passes it on, spreads it, or reads a property whose name is computed). Read from the tokens, so it works for any
 * body, not only those that can be translated.
 */
export function columnsRead(fn, index = 0) {
  const { params, destructured, tokens } = readFunction(fn);
  if (destructured && params?.[index] === null) return new Set(destructured);
  if (params && params.length <= index) return new Set(); // the function doesn't take that argument
  const row = params?.[index];
  if (!tokens || !row) return tokens && params && params.length === 0 ? new Set() : '*';
  if (tokens.some((t) => t.type === 'template')) return '*'; // `${…}` holds code this doesn't look into
  const names = new Set();
  // The parameters themselves come first in the tokens: skip past the '=>' or the body's '{'.
  let start = tokens.findIndex((t) => t.type === 'punct' && (t.value === '=>' || t.value === '{'));
  if (start < 0) return '*';
  for (let k = start + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'ident' || t.value !== row) continue;
    const before = tokens[k - 1];
    if (before?.type === 'punct' && (before.value === '.' || before.value === '?.')) continue; // a property named like the row
    const next = tokens[k + 1];
    const name = tokens[k + 2];
    if (next?.type === 'punct' && (next.value === '.' || next.value === '?.') && name?.type === 'ident') names.add(name.value);
    else if (next?.type === 'punct' && next.value === '[' && name?.type === 'string' && tokens[k + 3]?.value === ']') names.add(name.value);
    else return '*';
  }
  return names;
}

// ---- functions to filters -----------------------------------------------------------------------------------------

const RELATIONAL = { '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };
const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '===': '===', '!==': '!==', '==': '==', '!=': '!=' };

/** What JavaScript gives for `a op b`, for the null rows a filter leaves out. */
function js(op, a, b) {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '===': return a === b;
    case '!==': return a !== b;
    case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; // eslint-disable-line eqeqeq
    default: return false;
  }
}

const bits = new Float64Array(1);
const raw = new BigUint64Array(bits.buffer);
/** The next number above x (one unit in the last place). */
function nextUp(x) {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  bits[0] = x;
  raw[0] += x > 0 ? 1n : -1n;
  return bits[0];
}
const nextDown = (x) => -nextUp(-x);

const or = (...parts) => (parts.length === 1 ? parts[0] : { or: parts });
const and = (...parts) => (parts.length === 1 ? parts[0] : { and: parts });
const isNull = (column, yes = true) => ({ [column]: { isNull: yes } });

/** Values that may stand for a column of this type in a filter, as JavaScript compares them with its values. */
function fits(type, value) {
  switch (type) {
    case 'int': return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'bigint';
    case 'float': return typeof value === 'number' && !Number.isNaN(value);
    case 'decimal': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'bool': return typeof value === 'boolean';
    case 'datetime': return value instanceof Date && !Number.isNaN(value.getTime());
    default: return false;
  }
}

/**
 * Turns a function into a filter: { filter (or null), exact, notes }. `columns`: the reader's columns. The filter lets
 * through every row the function keeps; `exact` when it keeps exactly those, null rows included. `notes` say what
 * wasn't translated, for explain().
 */
export function translate(fn, values, columns) {
  const { params, destructured, body } = readFunction(fn);
  const notes = [];
  if (!body) return { filter: null, exact: false, notes: ['the function was not read (a body of statements, or syntax this reader leaves to JavaScript)'] };
  const types = new Map(columns.map((c) => [c.name, c.type]));
  const row = params?.[0] ?? null;
  const valuesName = params?.[1] ?? null;

  /** The column a node names: row.name, row['name'], or a destructured name; else null. */
  function column(node) {
    if (node.kind === 'ident' && destructured?.has(node.name)) return node.name;
    if (node.kind !== 'member' || node.object.kind !== 'ident' || node.object.name !== row || !row) return null;
    const name = node.computed ? (node.property.kind === 'literal' && typeof node.property.value === 'string' ? node.property.value : null) : node.property;
    return name;
  }
  const known = (name) => types.has(name);

  /** A value the filter can use: a literal, -number, [values], new Date(literal), or $.name; else NOT (a symbol). */
  const NOT = Symbol('not a value');
  function value(node) {
    switch (node.kind) {
      case 'literal': return node.value;
      case 'unary':
        if (node.op === '-' && node.argument.kind === 'literal' && (typeof node.argument.value === 'number' || typeof node.argument.value === 'bigint')) return -node.argument.value;
        return NOT;
      case 'array': {
        const list = node.elements.map(value);
        return list.includes(NOT) ? NOT : list;
      }
      case 'new':
        if (node.callee.kind === 'ident' && node.callee.name === 'Date' && node.args.length === 1) {
          const arg = value(node.args[0]);
          if (typeof arg === 'string' || typeof arg === 'number') return new Date(arg);
        }
        return NOT;
      case 'member':
        if (!node.computed && node.object.kind === 'ident' && node.object.name === valuesName && valuesName && values && Object.hasOwn(values, node.property)) {
          return values[node.property];
        }
        if (node.object.kind === 'ident' && node.object.name === valuesName && valuesName) notes.push(`$.${node.computed ? '[…]' : node.property}: no such value was passed`);
        return NOT;
      default:
        return NOT;
    }
  }

  /** `col op value` as a filter. */
  function compare(op, name, v) {
    const type = types.get(name);
    if (v === null || v === undefined) {
      if (op === '===' || op === '==') return { filter: isNull(name), exact: op === '==' || v === null };
      if (op === '!==' || op === '!=') return { filter: isNull(name, false), exact: op === '!=' || v === null };
      return null;
    }
    if (!fits(type, v)) {
      notes.push(`${name} ${op} ${String(v)}: a ${type} column compared with a ${v instanceof Date ? 'date' : typeof v}`);
      return null;
    }
    const nullToo = js(op, null, v); // what JavaScript says for a null value: the filter must let those rows through too
    const withNull = (filter) => (nullToo ? or(filter, isNull(name)) : filter);
    if (type === 'decimal') {
      // Decimal values are text, which JavaScript compares with a number as a number: widen the bounds by one unit in
      // the last place where rounding could make them meet, and let the function decide.
      const n = Number(v);
      switch (op) {
        case '<': return { filter: withNull({ [name]: { lt: n } }), exact: false };
        case '>': return { filter: withNull({ [name]: { gt: n } }), exact: false };
        case '<=': return { filter: withNull({ [name]: { lte: nextUp(n) } }), exact: false };
        case '>=': return { filter: withNull({ [name]: { gte: nextDown(n) } }), exact: false };
        case '==': case '===': return { filter: { [name]: { gte: nextDown(n), lte: nextUp(n) } }, exact: false };
        default: return null; // != and !== keep nearly every row
      }
    }
    if (type === 'datetime' && op !== '<' && op !== '<=' && op !== '>' && op !== '>=') {
      // Dates are objects: === and == compare which object, so they never hold, and !== always does.
      if (op === '===' || op === '==') return { filter: { [name]: { eq: v } }, exact: false };
      return null;
    }
    const filter = RELATIONAL[op] ? { [name]: { [RELATIONAL[op]]: v } }
      : op === '===' || op === '==' ? { [name]: { eq: v } } : { [name]: { ne: v } };
    // Integers past 2^53 come back as BigInts, which === a number never equals.
    const exact = !(type === 'int' && typeof v === 'number' && !Number.isSafeInteger(v));
    return { filter: op === '!==' || op === '!=' ? or(filter, isNull(name)) : withNull(filter), exact };
  }

  /** A node that is true or false as a whole: { filter, exact } or null (not translated). */
  function test(node) {
    switch (node.kind) {
      case 'logical': {
        if (node.op === '&&') {
          const parts = [test(node.left), test(node.right)];
          const kept = parts.filter(Boolean);
          if (!kept.length) return null;
          return { filter: and(...kept.map((p) => p.filter)), exact: kept.length === 2 && kept.every((p) => p.exact) };
        }
        if (node.op === '||') {
          const left = test(node.left);
          const right = test(node.right);
          if (!left || !right) return null;
          return { filter: or(left.filter, right.filter), exact: left.exact && right.exact };
        }
        notes.push('??: left to JavaScript');
        return null;
      }
      case 'unary': {
        if (node.op !== '!') return null;
        const inner = test(node.argument);
        if (!inner?.exact) {
          if (inner) notes.push('!(…): its inside is not exactly a filter');
          return null;
        }
        return { filter: { not: inner.filter }, exact: true };
      }
      case 'binary': {
        if (!(node.op in FLIP)) return null;
        let name = column(node.left);
        let other = node.right;
        let op = node.op;
        if (name === null) {
          name = column(node.right);
          other = node.left;
          op = FLIP[node.op];
        }
        if (name === null) {
          notes.push(`a comparison without a column on one side (${describe(node)})`);
          return null;
        }
        if (!known(name)) {
          notes.push(`${name}: no such column`);
          return null;
        }
        const v = value(other);
        if (v === NOT) {
          if (other.kind === 'ident') notes.push(`${other.name}: a value from outside the function; pass it as the second argument to use it here`);
          else notes.push(`${name} ${node.op} …: the other side is not a plain value`);
          return null;
        }
        return compare(op, name, v);
      }
      case 'call':
        return call(node);
      default: {
        // A column on its own: truthy.
        const name = column(node);
        if (name === null) return null;
        if (!known(name)) {
          notes.push(`${name}: no such column`);
          return null;
        }
        switch (types.get(name)) {
          case 'bool': return { filter: { [name]: { eq: true } }, exact: true };
          case 'string': return { filter: { [name]: { ne: '' } }, exact: true };
          case 'int': return { filter: { [name]: { ne: 0 } }, exact: true };
          case 'decimal': case 'datetime': return { filter: isNull(name, false), exact: true }; // text and dates are always truthy
          default: return null;
        }
      }
    }
  }

  /** text.includes(v), text.startsWith(v), text.toLowerCase().includes(v), [..].includes(column). */
  function call(node) {
    const callee = node.callee;
    if (callee.kind !== 'member' || callee.computed || node.args.length !== 1) return null;
    const method = callee.property;
    if (method === 'includes' && column(node.args[0]) !== null) {
      const name = column(node.args[0]);
      const list = value(callee.object);
      if (!known(name) || !Array.isArray(list) || !list.every((v) => fits(types.get(name), v))) return null;
      const type = types.get(name);
      return { filter: { [name]: { in: list } }, exact: type === 'string' || type === 'int' || type === 'bool' };
    }
    if (method !== 'includes' && method !== 'startsWith') return null;
    let target = callee.object;
    let lower = false;
    if (target.kind === 'call' && target.callee.kind === 'member' && !target.callee.computed && target.args.length === 0
      && (target.callee.property === 'toLowerCase' || target.callee.property === 'toUpperCase')) {
      if (method !== 'includes') return null;
      lower = target.callee.property;
      target = target.callee.object;
    }
    const name = column(target);
    if (name === null || !known(name) || types.get(name) !== 'string') return null;
    const v = value(node.args[0]);
    if (typeof v !== 'string') return null;
    if (!lower) return { filter: { [name]: { [method === 'includes' ? 'contains' : 'startsWith']: v } }, exact: true };
    // Case-insensitive: exact when the text is already in the case the column is changed to.
    return { filter: { [name]: { icontains: v } }, exact: lower === 'toLowerCase' && v === v.toLowerCase() };
  }

  const result = test(body);
  if (!result) {
    if (!notes.length) notes.push(`the function (${describe(body)}) has no part that a filter can say`);
    return { filter: null, exact: false, notes };
  }
  return { filter: result.filter, exact: result.exact, notes };
}

/** A short text for a node, for notes. */
function describe(node) {
  switch (node.kind) {
    case 'literal': return JSON.stringify(typeof node.value === 'bigint' ? `${node.value}n` : node.value) ?? 'undefined';
    case 'ident': return node.name;
    case 'member': return `${describe(node.object)}${node.optional ? '?.' : '.'}${node.computed ? `[${describe(node.property)}]` : node.property}`;
    case 'call': return `${describe(node.callee)}(…)`;
    case 'binary': case 'logical': return `${describe(node.left)} ${node.op} ${describe(node.right)}`;
    case 'unary': return `${node.op}${describe(node.argument)}`;
    default: return '…';
  }
}

/** For a key function `(t) => t.column`: the column's name; else null. */
export function columnKey(fn) {
  const { params, destructured, body } = readFunction(fn);
  if (!body) return null;
  if (body.kind === 'ident' && destructured?.has(body.name)) return body.name;
  if (body.kind === 'member' && !body.computed && body.object.kind === 'ident' && body.object.name === params?.[0]) return body.property;
  return null;
}
