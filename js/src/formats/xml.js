import fs from 'node:fs';
import { latin1Slice, utf8Slice } from '../binary.js';
import { JazminValidationError } from '../errors.js';
import { inferTextColumns, toObjects, valueToText } from './text.js';

// Canonical XML shape:
//   <jazmin><row><name>Ann</name><age>31</age></row>...</jazmin>
// Null values are omitted. Column names that are not valid XML names use <field name="...">.

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;

function escape(text) {
  if (INVALID_XML_CHARS.test(text)) throw new JazminValidationError('Value contains characters that XML 1.0 cannot represent');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function elementFor(name) {
  return XML_NAME.test(name) && !/^xml/i.test(name)
    ? { open: `<${name}>`, close: `</${name}>` }
    : { open: `<field name="${escape(name)}">`, close: '</field>' };
}

export function* xmlPieces(columns, rows, { root = 'jazmin', row: rowName = 'row' } = {}) {
  const elements = columns.map((c) => elementFor(c.name));
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n`;
  for (const row of rows) {
    let out = `  <${rowName}>`;
    columns.forEach((c, i) => {
      const value = row[c.name] ?? null;
      if (value !== null) out += elements[i].open + escape(valueToText(c.type, value, c)) + elements[i].close;
    });
    yield `${out}</${rowName}>\n`;
  }
  yield `</${root}>\n`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in ENTITIES)) throw new JazminValidationError(`Unknown XML entity &${e};`);
    return ENTITIES[e];
  });
}

const NAME_ATTR = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const TAG = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/;
const LT = 60;
const GT = 62;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
// Markup that carries no data: [what opens it, what closes it]. A DOCTYPE ends at the first '>'.
const MARKUP = [['<!--', '-->'], ['<?', '?>'], ['<!DOCTYPE', '>'], ['<![CDATA[', ']]>']].map(([open, close]) => [Buffer.from(open), Buffer.from(close)]);
const CDATA = MARKUP[3][0];

/** Whether `bytes` at `at` starts with `prefix`: 1 it does, 0 it does not, -1 they end before that is known. */
function startsWith(bytes, at, prefix) {
  for (let k = 0; k < prefix.length; k++) {
    if (at + k >= bytes.length) return -1;
    if (bytes[at + k] !== prefix[k]) return 0;
  }
  return 1;
}

const malformed = () => new JazminValidationError('Malformed XML');

// Bytes of an element name ([A-Za-z_][\w.:-]*) and of the white space ASCII XML uses.
const NAME_START = new Uint8Array(256);
const NAME_PART = new Uint8Array(256);
for (let b = 0; b < 128; b++) {
  const c = String.fromCharCode(b);
  NAME_START[b] = /[A-Za-z_]/.test(c) ? 1 : 0;
  NAME_PART[b] = /[\w.:-]/.test(c) ? 1 : 0;
}
const isSpace = (b) => b === 32 || b === 9 || b === 10 || b === 13;
const SLASH = 47;

/**
 * Rows of the canonical XML shape (root > row > field elements) from UTF-8 bytes that arrive in blocks: push() returns
 * the rows the bytes complete, each a Map from column position to its text, and keeps an unfinished token for the next
 * block. `names` lists the columns in the order they first appear. Text is decoded from the bytes into strings of its
 * own: text cut from a larger string would keep that string alive (see csv.js). This is intentionally a small parser
 * for tabular XML, not a general XML parser.
 */
export class XmlRowParser {
  names = [];
  #index = new Map();
  #pending = null; // the bytes of an unfinished token (a copy: the caller may reuse its block)
  #depth = 0;
  #record = null;
  #fieldName = null;
  #fieldText = '';

  /** The rows `block` completes; `final` marks the end of the input. */
  push(block, final = false) {
    const bytes = this.#pending ? Buffer.concat([this.#pending, block]) : block;
    this.#pending = null;
    const rows = [];
    let at = 0;
    while (at < bytes.length) {
      const next = this.#token(bytes, at, final, rows);
      if (next < 0) {
        if (final) throw malformed();
        this.#pending = Buffer.from(bytes.subarray(at));
        break;
      }
      at = next;
    }
    if (final && this.#depth !== 0) throw new JazminValidationError('XML is not well-formed (unclosed elements)');
    return rows;
  }

  /** Reads the token at `at`; returns where the next one starts, or -1 when it continues past the bytes. */
  #token(bytes, at, final, rows) {
    if (bytes[at] !== LT) {
      let end = bytes.indexOf(LT, at);
      if (end < 0) {
        if (!final) return -1; // more text may follow (an entity could be split)
        end = bytes.length;
      }
      // White space between elements (indentation) needs no string.
      let k = at;
      if (this.#depth !== 3) while (k < end && isSpace(bytes[k])) k++;
      if (k < end) this.#text(utf8Slice(bytes, at, end), false);
      return end;
    }
    const simple = this.#simpleTag(bytes, at, rows);
    if (simple !== 0) return simple;
    for (const [open, close] of MARKUP) {
      const opens = startsWith(bytes, at, open);
      if (opens < 0) return -1;
      if (opens === 0) continue;
      const end = bytes.indexOf(close, at + open.length);
      if (end < 0) return -1;
      if (open === CDATA) this.#text(utf8Slice(bytes, at + open.length, end), true);
      return end + close.length;
    }
    // An element tag: up to the first '>' outside quoted attribute values.
    let quote = 0;
    let end = at + 1;
    for (; end < bytes.length; end++) {
      const b = bytes[end];
      if (quote) {
        if (b === quote) quote = 0;
      } else if (b === DOUBLE_QUOTE || b === SINGLE_QUOTE) quote = b;
      else if (b === GT) break;
    }
    if (end === bytes.length) return -1;
    const tag = TAG.exec(utf8Slice(bytes, at, end + 1));
    if (!tag) throw malformed();
    this.#element(tag, rows);
    return end + 1;
  }

  /**
   * A tag without attributes (<name>, </name>, <name/>), read from the bytes: most tags of tabular XML. Returns where
   * the next token starts, -1 when the tag continues past the bytes, or 0 for any other tag (read with TAG).
   */
  #simpleTag(bytes, at, rows) {
    let i = at + 1;
    if (i === bytes.length) return -1;
    const closing = bytes[i] === SLASH;
    if (closing) i++;
    if (i === bytes.length) return -1;
    if (!NAME_START[bytes[i]]) return 0;
    const nameStart = i;
    while (i < bytes.length && NAME_PART[bytes[i]]) i++;
    const nameEnd = i;
    while (i < bytes.length && isSpace(bytes[i])) i++;
    if (i === bytes.length) return -1;
    let selfClosing = false;
    if (bytes[i] === SLASH) {
      if (i + 1 === bytes.length) return -1;
      if (bytes[i + 1] !== GT) return 0;
      selfClosing = true;
      i++;
    } else if (bytes[i] !== GT) return 0;
    this.#element([undefined, closing ? '/' : '', latin1Slice(bytes, nameStart, nameEnd), '', selfClosing ? '/' : ''], rows);
    return i + 1;
  }

  #text(text, cdata) {
    if (this.#depth === 3) this.#fieldText += cdata ? text : unescape(text);
    else if (!cdata && text.trim() !== '') throw new JazminValidationError('Unexpected text in XML');
  }

  #element([, closing, tag, attrs, selfClosing], rows) {
    if (!closing) {
      this.#depth++;
      if (this.#depth === 2) this.#record = new Map();
      if (this.#depth === 3) {
        const m = tag === 'field' ? NAME_ATTR.exec(attrs) : null;
        this.#fieldName = m ? unescape(m[1] ?? m[2]) : tag;
        this.#fieldText = '';
      }
      if (this.#depth > 3) throw new JazminValidationError('XML is nested deeper than root > row > field');
      if (!selfClosing) return;
    }
    if (this.#depth === 3) {
      if (!this.#index.has(this.#fieldName)) {
        this.#index.set(this.#fieldName, this.names.length);
        this.names.push(this.#fieldName);
      }
      this.#record.set(this.#index.get(this.#fieldName), this.#fieldText);
    } else if (this.#depth === 2) {
      rows.push(this.#record);
    }
    this.#depth--;
  }
}

/** A row (column position -> text) as a positional record over the first `width` columns. */
export const xmlRecord = (row, width) => Array.from({ length: width }, (_, i) => (row.has(i) ? row.get(i) : null));

/**
 * The rows of an XML file of the canonical shape, without loading it: it is read a block at a time. Each row is a
 * Map from column position to its text; `names` (filled as rows are read) holds the columns in order of appearance.
 */
export function* readXmlRows(path, { blockSize = 1 << 20, names = [] } = {}) {
  const parser = new XmlRowParser();
  parser.names = names;
  const fd = fs.openSync(path, 'r');
  try {
    const block = Buffer.allocUnsafe(blockSize);
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, block, 0, blockSize, position);
      position += read;
      yield* parser.push(block.subarray(0, read), read === 0);
      if (read === 0) return;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parses the canonical XML shape (root > row > field elements) into { columns, rows }.
 * This is intentionally a small parser for tabular XML, not a general XML parser.
 */
export function parseXml(text, { inferTypes = true } = {}) {
  const parser = new XmlRowParser();
  const rows = parser.push(Buffer.from(text, 'utf8'), true);
  const positional = rows.map((row) => xmlRecord(row, parser.names.length));
  const columns = inferTextColumns(parser.names, positional, inferTypes);
  return { columns, rows: toObjects(columns, positional) };
}
