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
      if (value !== null) out += elements[i].open + escape(valueToText(c.type, value)) + elements[i].close;
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

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
const NAME_ATTR = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * Parses the canonical XML shape (root > row > field elements) into { columns, rows }.
 * This is intentionally a small parser for tabular XML, not a general XML parser.
 */
export function parseXml(text, { inferTypes = true } = {}) {
  const records = [];
  const names = [];
  const nameIndex = new Map();
  let depth = 0;
  let record = null;
  let fieldName = null;
  let fieldText = '';
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text))) {
    const [, cdata, closing, tag, attrs, selfClosing, chars, stray] = match;
    if (stray) throw new JazminValidationError('Malformed XML');
    if (cdata !== undefined || chars !== undefined) {
      if (depth === 3) fieldText += cdata ?? unescape(chars);
      else if ((chars ?? '').trim() !== '' && depth !== 3) throw new JazminValidationError('Unexpected text in XML');
      continue;
    }
    if (!tag) continue; // comment, prolog, doctype
    if (!closing) {
      depth++;
      if (depth === 2) record = new Map();
      if (depth === 3) {
        const m = tag === 'field' ? NAME_ATTR.exec(attrs) : null;
        fieldName = m ? unescape(m[1] ?? m[2]) : tag;
        fieldText = '';
      }
      if (depth > 3) throw new JazminValidationError('XML is nested deeper than root > row > field');
      if (!selfClosing) continue;
    }
    if (depth === 3) {
      if (!nameIndex.has(fieldName)) {
        nameIndex.set(fieldName, names.length);
        names.push(fieldName);
      }
      record.set(nameIndex.get(fieldName), fieldText);
    } else if (depth === 2) {
      records.push(record);
    }
    depth--;
  }
  if (depth !== 0) throw new JazminValidationError('XML is not well-formed (unclosed elements)');
  const positional = records.map((r) => names.map((_, i) => (r.has(i) ? r.get(i) : null)));
  const columns = inferTextColumns(names, positional, inferTypes);
  return { columns, rows: toObjects(columns, positional) };
}
