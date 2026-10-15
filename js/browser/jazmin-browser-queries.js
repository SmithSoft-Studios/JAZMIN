// JAZMIN browser reader, add-on: queries with arrow functions (JazminBrowser.from). Load it after
// jazmin-browser-core.js (the full jazmin-browser.js already has it).
// Built by js/scripts/build-browser.mjs from js/browser/src: change those, then run it.
(function (global) {
  'use strict';

  const internals = global.JazminBrowser?.[Symbol.for('jazmin.browser.internals')];
  if (!internals) throw new Error('jazmin-browser-queries.js needs jazmin-browser-core.js, loaded first');
  const { JazminValidationError, compareDecimalKeys, decimalKeyOf } = internals;

  // ---- queries with arrow functions (docs/design/js-queries.md): js/src/lambda.js, as it is, and js/src/query.js ----
  // The translator reads where functions into filters; see lambda.js for how it stays exact or lets more rows through.

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
  function readFunction(fn) {
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
  function columnsRead(fn, index = 0) {
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
  function translate(fn, values, columns) {
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
  function columnKey(fn) {
    const { params, destructured, body } = readFunction(fn);
    if (!body) return null;
    if (body.kind === 'ident' && destructured?.has(body.name)) return body.name;
    if (body.kind === 'member' && !body.computed && body.object.kind === 'ident' && body.object.name === params?.[0]) return body.property;
    return null;
  }

  // The queries (js/src/query.js): from(reader) is awaited here, as the reader is; in-memory sequences (arrays, the
  // groups groupBy makes, the matches groupJoin gives) are not, so `rows.sum((x) => x.amount)` inside a group gives a
  // number.
  const isQueryReader = (source) => source !== null && typeof source === 'object' && typeof source.find === 'function' && Array.isArray(source.columns) && typeof source.count === 'function';
  const queryFail = (message) => new JazminValidationError(`Query: ${message}`);
  const queryFn = (f, what) => {
    if (typeof f !== 'function') throw queryFail(`${what} must be a function`);
    return f;
  };
  const queryCount = (n, what) => {
    if (!Number.isSafeInteger(n) || n < 0) throw queryFail(`${what} must be a non-negative integer`);
    return n;
  };

  /** A key's identity for joins and groups: equal values (dates, big integers, objects of values) give equal keys. */
  function queryKeyOf(value) {
    if (value === null || value === undefined) return 'null';
    if (value instanceof Date) return `d${value.getTime()}`;
    switch (typeof value) {
      case 'string': return `s${value}`;
      case 'number': return `n${value}`;
      case 'bigint': return `n${value}`;
      case 'boolean': return `b${value}`;
      default:
        if (Array.isArray(value)) return `[${value.map(queryKeyOf).join(',')}]`;
        if (value instanceof Uint8Array) return `x${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${queryKeyOf(value[k])}`).join(',')}}`;
    }
  }

  function compareValues(a, b, decimal = false) {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (decimal) return compareDecimalKeys(decimalKeyOf(String(a)), decimalKeyOf(String(b)));
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  const QUERY_DECIMAL = /^-?\d+(\.\d+)?$/;
  const numericValue = (v) => (typeof v === 'number' ? v : Number(v));

  /** orderBy and its thenBy steps as one sort; a key that is a decimal column (before rows are reshaped) sorts exactly. */
  function querySorts(steps, reader) {
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

  function sortQueryRows(list, step) {
    const keyed = list.map((row, i) => ({ row, i, values: step.keys.map((k) => k.fn(row)) }));
    keyed.sort((a, b) => {
      for (let k = 0; k < step.keys.length; k++) {
        const c = compareValues(a.values[k], b.values[k], step.keys[k].decimal);
        if (c !== 0) return step.keys[k].desc ? -c : c;
      }
      return a.i - b.i;
    });
    return keyed.map((x) => x.row);
  }

  /** The steps of a query, shared by the in-memory and the reader's queries. */
  class QueryBase {
    constructor(source, steps, key) {
      Object.defineProperty(this, '_source', { value: source });
      Object.defineProperty(this, '_steps', { value: steps });
      if (key !== undefined) this.key = key;
    }

    _with(step) {
      return new this.constructor(this._source, [...this._steps, step]);
    }

    where(predicate, values) {
      return this._with({ op: 'where', fn: queryFn(predicate, 'where'), values });
    }

    select(selector) {
      return this._with({ op: 'select', fn: queryFn(selector, 'select') });
    }

    orderBy(key) {
      return this._with({ op: 'order', fn: queryFn(key, 'orderBy'), desc: false, then: false });
    }

    orderByDescending(key) {
      return this._with({ op: 'order', fn: queryFn(key, 'orderByDescending'), desc: true, then: false });
    }

    thenBy(key) {
      if (this._steps.at(-1)?.op !== 'order') throw queryFail('thenBy follows orderBy or orderByDescending');
      return this._with({ op: 'order', fn: queryFn(key, 'thenBy'), desc: false, then: true });
    }

    thenByDescending(key) {
      if (this._steps.at(-1)?.op !== 'order') throw queryFail('thenByDescending follows orderBy or orderByDescending');
      return this._with({ op: 'order', fn: queryFn(key, 'thenByDescending'), desc: true, then: true });
    }

    /** The rows in the other order; after the where functions (or the file's own order) the reader reads last first. */
    reverse() {
      return this._with({ op: 'reverse' });
    }

    skip(n) {
      return this._with({ op: 'skip', n: queryCount(n, 'skip') });
    }

    take(n) {
      return this._with({ op: 'take', n: queryCount(n, 'take') });
    }

    join(inner, outerKey, innerKey, result) {
      return this._with({ op: 'join', inner: asQuery(inner), outerKey: queryFn(outerKey, 'join'), innerKey: queryFn(innerKey, 'join'), fn: queryFn(result, 'join') });
    }

    groupJoin(inner, outerKey, innerKey, result) {
      return this._with({ op: 'groupJoin', inner: asQuery(inner), outerKey: queryFn(outerKey, 'groupJoin'), innerKey: queryFn(innerKey, 'groupJoin'), fn: queryFn(result, 'groupJoin') });
    }

    groupBy(key, result) {
      return this._with({ op: 'groupBy', key: queryFn(key, 'groupBy'), fn: result === undefined ? null : queryFn(result, 'groupBy') });
    }
  }

  /** A query over rows in memory (an array, a group): it runs at once. */
  class MemoryQuery extends QueryBase {
    *[Symbol.iterator]() {
      let rows = this._source;
      for (const step of querySorts(this._steps, null)) rows = MEMORY_STEPS[step.op](rows, step);
      yield* rows;
    }

    toArray() {
      return [...this];
    }

    count(predicate) {
      let n = 0;
      for (const _ of predicate === undefined ? this : this.where(predicate)) n++; // eslint-disable-line no-unused-vars
      return n;
    }

    any(predicate) {
      for (const _ of (predicate === undefined ? this : this.where(predicate)).take(1)) return true; // eslint-disable-line no-unused-vars
      return false;
    }

    first(predicate) {
      for (const row of (predicate === undefined ? this : this.where(predicate)).take(1)) return row;
      throw queryFail('first() found no rows');
    }

    firstOrDefault(predicate, fallback = null) {
      for (const row of (predicate === undefined ? this : this.where(predicate)).take(1)) return row;
      return fallback;
    }

    sum(selector) {
      return sumOf(selector === undefined ? this : this.select(queryFn(selector, 'sum')));
    }

    min(selector) {
      return extremeOf(selector === undefined ? this : this.select(queryFn(selector, 'min')), -1);
    }

    max(selector) {
      return extremeOf(selector === undefined ? this : this.select(queryFn(selector, 'max')), 1);
    }

    average(selector) {
      return averageOf(selector === undefined ? this : this.select(queryFn(selector, 'average')));
    }

    explain() {
      return { filter: null, exact: true, columns: null, offset: 0, limit: null, fileOrder: false, reverse: false, inMemory: querySorts(this._steps, null).map((s) => s.op), notes: [] };
    }
  }

  function sumOf(values) {
    let total = 0;
    for (const v of values) if (v !== null && v !== undefined) total += numericValue(v);
    return total;
  }

  function extremeOf(values, sign) {
    let best = null;
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const decimal = typeof v === 'string' && typeof best === 'string' && QUERY_DECIMAL.test(v) && QUERY_DECIMAL.test(best);
      if (best === null || compareValues(v, best, decimal) * sign > 0) best = v;
    }
    return best;
  }

  function averageOf(values) {
    let total = 0;
    let n = 0;
    for (const v of values) {
      if (v === null || v === undefined) continue;
      total += numericValue(v);
      n++;
    }
    return n ? total / n : null;
  }

  const MEMORY_STEPS = {
    *where(rows, step) {
      for (const row of rows) if (step.fn(row, step.values)) yield row;
    },
    *select(rows, step) {
      let i = 0;
      for (const row of rows) yield step.fn(row, i++);
    },
    sort(rows, step) {
      return sortQueryRows([...rows], step);
    },
    reverse(rows) {
      return [...rows].reverse();
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
      const byKey = memoryLookup(step.inner, step.innerKey);
      for (const row of rows) for (const match of byKey.get(queryKeyOf(step.outerKey(row))) ?? []) yield step.fn(row, match);
    },
    *groupJoin(rows, step) {
      const byKey = memoryLookup(step.inner, step.innerKey);
      for (const row of rows) yield step.fn(row, new MemoryQuery(byKey.get(queryKeyOf(step.outerKey(row))) ?? [], []));
    },
    *groupBy(rows, step) {
      for (const [key, list] of groupRows(rows, step.key)) {
        const group = new MemoryQuery(list, [], key);
        yield step.fn ? step.fn(key, group) : group;
      }
    },
  };

  function memoryLookup(inner, key) {
    if (inner instanceof ReaderQuery) throw queryFail("a join in memory can't wait for a file's rows: start the query from the file, or join await inner.toArray()");
    const byKey = new Map();
    for (const row of inner) {
      const id = queryKeyOf(key(row));
      const list = byKey.get(id);
      if (list) list.push(row);
      else byKey.set(id, [row]);
    }
    return byKey;
  }

  function groupRows(rows, key) {
    const groups = new Map();
    for (const row of rows) {
      const k = key(row);
      const id = queryKeyOf(k);
      let group = groups.get(id);
      if (!group) groups.set(id, (group = [k, []]));
      group[1].push(row);
    }
    return groups.values();
  }

  /** A query over a table of a file: what the reader can do, it does; the rest runs here. Awaited. */
  class ReaderQuery extends QueryBase {
    _only(names) {
      const q = new ReaderQuery(this._source, this._steps);
      Object.defineProperty(q, '_want', { value: names });
      return q;
    }

    /** As the library's: leading where functions as one filter, the file's order, offset and limit, the columns read. */
    _plan(terminal) {
      const reader = this._source;
      const steps = this._steps;
      const plan = { filter: null, exact: true, notes: [], select: null, offset: 0, limit: Infinity, fileOrder: false, reverse: false, rest: [] };
      let k = 0;
      const filters = [];
      const checks = [];
      for (; k < steps.length && steps[k].op === 'where'; k++) {
        const t = translate(steps[k].fn, steps[k].values, reader.columns);
        plan.notes.push(...t.notes);
        if (t.filter) filters.push(t.filter);
        if (!t.exact) checks.push(steps[k]);
      }
      plan.filter = filters.length === 0 ? null : filters.length === 1 ? filters[0] : { and: filters };
      plan.exact = checks.length === 0;
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
      // The file's order backwards: the reader reads last first.
      if (steps[k]?.op === 'reverse') {
        plan.reverse = true;
        plan.fileOrder = true;
        k++;
      }
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
      rest = querySorts([...checks, ...rest.slice(r)], reader);
      plan.rest = rest.map((step) => {
        if (step.op !== 'join' || !(step.inner instanceof ReaderQuery)) return step;
        const key = columnsRead(step.innerKey);
        const result = columnsRead(step.fn, 1);
        return key === '*' || result === '*' ? step : { ...step, inner: step.inner._only(new Set([...key, ...result])) };
      });
      plan.select = queryColumns(plan.rest, terminal, reader, this._want ?? null);
      return plan;
    }

    async *_rows(terminal) {
      const plan = this._plan(terminal);
      const options = {
        ...(plan.select ? { select: plan.select } : {}), ...(plan.offset ? { offset: plan.offset } : {}), ...(plan.limit !== Infinity ? { limit: plan.limit } : {}),
        ...(plan.reverse ? { reverse: true } : {}),
      };
      let rows = plan.limit === 0 ? [] : this._source.find(plan.filter, options);
      for (const step of plan.rest) rows = READER_STEPS[step.op](rows, step);
      yield* rows;
    }

    [Symbol.asyncIterator]() {
      return this._rows(null)[Symbol.asyncIterator]();
    }

    async toArray() {
      const out = [];
      for await (const row of this) out.push(row);
      return out;
    }

    async count(predicate) {
      if (predicate !== undefined) return this.where(predicate).count();
      const plan = this._plan('count');
      if (plan.rest.length === 0) {
        if (plan.limit === 0) return 0;
        const total = await this._source.count(plan.filter);
        return Math.max(0, Math.min(plan.limit, total - plan.offset));
      }
      let n = 0;
      for await (const _ of this._rows('count')) n++; // eslint-disable-line no-unused-vars
      return n;
    }

    async any(predicate) {
      for await (const _ of (predicate === undefined ? this : this.where(predicate)).take(1)) return true; // eslint-disable-line no-unused-vars
      return false;
    }

    async first(predicate) {
      for await (const row of (predicate === undefined ? this : this.where(predicate)).take(1)) return row;
      throw queryFail('first() found no rows');
    }

    async firstOrDefault(predicate, fallback = null) {
      for await (const row of (predicate === undefined ? this : this.where(predicate)).take(1)) return row;
      return fallback;
    }

    async _values(selector, what) {
      const out = [];
      for await (const v of (selector === undefined ? this : this.select(queryFn(selector, what)))._rows('values')) out.push(v);
      return out;
    }

    async sum(selector) {
      return sumOf(await this._values(selector, 'sum'));
    }

    async min(selector) {
      return extremeOf(await this._values(selector, 'min'), -1);
    }

    async max(selector) {
      return extremeOf(await this._values(selector, 'max'), 1);
    }

    async average(selector) {
      return averageOf(await this._values(selector, 'average'));
    }

    explain() {
      const plan = this._plan(null);
      return {
        filter: plan.filter,
        exact: plan.exact,
        columns: plan.select ?? this._source.columns.map((c) => c.name),
        offset: plan.offset,
        limit: plan.limit === Infinity ? null : plan.limit,
        fileOrder: plan.fileOrder,
        reverse: plan.reverse,
        inMemory: plan.rest.map((s) => s.op),
        notes: [...new Set(plan.notes)],
      };
    }
  }

  function queryColumns(rest, terminal, reader, want) {
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
        case 'groupBy': add(columnsRead(step.key)); all = true; shaped = true; break;
        default: break;
      }
    }
    if (!shaped && terminal !== 'count') {
      if (want) add(want);
      else all = true;
    }
    if (all) return null;
    const columns = reader.columns.map((c) => c.name).filter((n) => names.has(n));
    return columns.length ? columns : [reader.columns[0].name];
  }

  async function readerLookup(inner, key) {
    const byKey = new Map();
    for await (const row of inner) {
      const id = queryKeyOf(key(row));
      const list = byKey.get(id);
      if (list) list.push(row);
      else byKey.set(id, [row]);
    }
    return byKey;
  }

  const READER_STEPS = {
    async *where(rows, step) {
      for await (const row of rows) if (step.fn(row, step.values)) yield row;
    },
    async *select(rows, step) {
      let i = 0;
      for await (const row of rows) yield step.fn(row, i++);
    },
    async *sort(rows, step) {
      const list = [];
      for await (const row of rows) list.push(row);
      yield* sortQueryRows(list, step);
    },
    async *reverse(rows) {
      const list = [];
      for await (const row of rows) list.push(row);
      yield* list.reverse();
    },
    async *skip(rows, step) {
      let left = step.n;
      for await (const row of rows) {
        if (left > 0) left--;
        else yield row;
      }
    },
    async *take(rows, step) {
      if (step.n === 0) return;
      let left = step.n;
      for await (const row of rows) {
        yield row;
        if (--left === 0) return;
      }
    },
    async *join(rows, step) {
      const byKey = await readerLookup(step.inner, step.innerKey);
      for await (const row of rows) for (const match of byKey.get(queryKeyOf(step.outerKey(row))) ?? []) yield step.fn(row, match);
    },
    async *groupJoin(rows, step) {
      const byKey = await readerLookup(step.inner, step.innerKey);
      for await (const row of rows) yield step.fn(row, new MemoryQuery(byKey.get(queryKeyOf(step.outerKey(row))) ?? [], []));
    },
    async *groupBy(rows, step) {
      const list = [];
      for await (const row of rows) list.push(row);
      for (const [key, members] of groupRows(list, step.key)) {
        const group = new MemoryQuery(members, [], key);
        yield step.fn ? step.fn(key, group) : group;
      }
    },
  };

  const asQuery = (source) => (source instanceof QueryBase ? source : queryFrom(source));

  /**
   * A query over a table of a file (awaited: await from(reader).where(…).toArray(), for await … of) or rows in memory
   * (at once). As the library's from() (docs/design/js-queries.md).
   */
  function queryFrom(source) {
    if (isQueryReader(source)) return new ReaderQuery(source, []);
    if (source !== null && typeof source === 'object' && typeof source[Symbol.iterator] === 'function') return new MemoryQuery(source, []);
    throw queryFail('from() takes a reader, or something iterable such as an array');
  }

  const API_QUERIES = { from: queryFrom };

  Object.assign(global.JazminBrowser, API_QUERIES);
})(globalThis);
