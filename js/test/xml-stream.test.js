// Streaming XML import (TASKS C-2): rows read a block at a time must be exactly those of the whole text, as the parser
// before streaming read them, and a file imported with importXMLFile() must equal fromXML() of its text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fromXML, importXMLFile, open, readXmlRows, toXML, write } from '../src/index.js';
import { XmlRowParser, parseXml, xmlRecord } from '../src/formats/xml.js';
import { inferTextColumns, toObjects } from '../src/formats/text.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-xml-')), name);

// ---- the parser before streaming (1.1.0): the reference ----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function referenceUnescape(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in ENTITIES)) throw new Error(`Unknown XML entity &${e};`);
    return ENTITIES[e];
  });
}
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
const NAME_ATTR = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;
function referenceParse(text, inferTypes = true) {
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
    if (stray) throw new Error('Malformed XML');
    if (cdata !== undefined || chars !== undefined) {
      if (depth === 3) fieldText += cdata ?? referenceUnescape(chars);
      else if ((chars ?? '').trim() !== '' && depth !== 3) throw new Error('Unexpected text in XML');
      continue;
    }
    if (!tag) continue;
    if (!closing) {
      depth++;
      if (depth === 2) record = new Map();
      if (depth === 3) {
        const m = tag === 'field' ? NAME_ATTR.exec(attrs) : null;
        fieldName = m ? referenceUnescape(m[1] ?? m[2]) : tag;
        fieldText = '';
      }
      if (depth > 3) throw new Error('XML is nested deeper than root > row > field');
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
  if (depth !== 0) throw new Error('XML is not well-formed (unclosed elements)');
  const positional = records.map((r) => names.map((_, i) => (r.has(i) ? r.get(i) : null)));
  const columns = inferTextColumns(names, positional, inferTypes);
  return { columns, rows: toObjects(columns, positional) };
}
// ---- end of the reference ----

function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const FRAGMENTS = ['<a>', '</a>', '<b>', '</b>', '<a/>', '<field name="x y">', '</field>', "<field name='q&amp;r'>", 'text', ' ', '\n', '42',
  '2.5', 'true', '&amp;', '&lt;', '&#233;', '&#x1F600;', '&bogus;', 'é', '日本', '<![CDATA[x<y]]>', '<!-- c > d -->', '<?pi x?>',
  '<!DOCTYPE j>', '<', '>', '"', "'", '<row>', '</row>', '<row/>', '<c d="e>f">', '</c>'];

/** Random XML: mostly a document of the canonical shape, with fragments (some invalid) mixed in. */
function randomXml(rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  let xml = rnd() < 0.3 ? '<?xml version="1.0"?>\n' : '';
  xml += '<jazmin>';
  for (let r = Math.floor(rnd() * 4); r > 0; r--) {
    xml += '<row>';
    for (let f = Math.floor(rnd() * 4); f > 0; f--) {
      const name = pick(['a', 'b', 'c']);
      xml += rnd() < 0.15 ? `<${name}/>` : `<${name}>${pick(FRAGMENTS.slice(8, 22))}${rnd() < 0.3 ? pick(FRAGMENTS.slice(8, 22)) : ''}</${name}>`;
    }
    if (rnd() < 0.2) xml += pick(FRAGMENTS);
    xml += '</row>';
  }
  if (rnd() < 0.3) xml += pick(FRAGMENTS);
  return rnd() < 0.9 ? `${xml}</jazmin>\n` : xml;
}

const outcome = (fn) => {
  try {
    return { result: fn() };
  } catch (error) {
    return { error: error.message };
  }
};

/** parseXml() with the bytes pushed in pieces of 1 to `max` bytes. */
function parseInPieces(text, rnd, max) {
  const bytes = Buffer.from(text, 'utf8');
  const parser = new XmlRowParser();
  const rows = [];
  for (let at = 0; at < bytes.length;) {
    const size = 1 + Math.floor(rnd() * max);
    rows.push(...parser.push(bytes.subarray(at, at + size)));
    at += size;
  }
  rows.push(...parser.push(Buffer.alloc(0), true));
  const positional = rows.map((row) => xmlRecord(row, parser.names.length));
  const columns = inferTextColumns(parser.names, positional, true);
  return { columns, rows: toObjects(columns, positional) };
}

test('rows from XML in pieces of any size equal those of the whole text, as the reference parser reads them', () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const rnd = random(seed);
    const text = randomXml(rnd);
    const expected = outcome(() => referenceParse(text));
    assert.deepEqual(outcome(() => parseXml(text)), expected, `seed ${seed}: ${JSON.stringify(text)}`);
    assert.deepEqual(outcome(() => parseInPieces(text, rnd, 6)), expected, `seed ${seed} in pieces: ${JSON.stringify(text)}`);
  }
});

test('a file read in small blocks gives the same rows: tags, entities, CDATA and multi-byte characters split', () => {
  const text = '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- a > comment -->\n<jazmin>\n  <row><name>Ann &amp; Bob</name><city>Zürich 日本</city>'
    + '<field name="two words">x</field></row>\n  <row><name><![CDATA[<raw> & text]]></name><age>31</age></row>\n  <row/>\n</jazmin>\n';
  const file = tmp('split.xml');
  fs.writeFileSync(file, text);
  const expected = referenceParse(text);
  for (const blockSize of [1, 2, 3, 5, 7, 64, 1 << 20]) {
    const names = [];
    const rows = [...readXmlRows(file, { blockSize, names })].map((row) => xmlRecord(row, names.length));
    const columns = inferTextColumns(names, rows, true);
    assert.deepEqual({ columns, rows: toObjects(columns, rows) }, expected, `block ${blockSize}`);
  }
});

test('importXMLFile() gives what fromXML() gives for the same text', () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({
    id: i, amount: i % 7 === 0 ? null : i * 1.25, active: i % 2 === 0, label: i % 5 === 0 ? null : `L & ${i % 9} <x>`, 'two words': `w${i}`,
  }));
  const text = toXML(open(write(null, rows)));
  const file = tmp('rows.xml');
  fs.writeFileSync(file, text);
  const expected = open(fromXML(text, null, { chunkRows: 256 }));
  const actual = open(importXMLFile(file, null, { chunkRows: 256 }));
  assert.deepEqual(actual.columns, expected.columns);
  assert.deepEqual([...actual.rows()], [...expected.rows()]);
  // A column that first appears after some rows is nullable, as fromXML() infers it.
  const late = tmp('late.xml');
  fs.writeFileSync(late, '<jazmin><row><a>1</a></row><row><a>2</a><b>x</b></row></jazmin>');
  assert.deepEqual(open(importXMLFile(late, null)).columns, open(fromXML(fs.readFileSync(late, 'utf8'), null)).columns);
});

test('importXMLFile() with columns reads each value as its column type: an XML export imports back exactly', () => {
  const columns = [
    { name: 'id', type: 'int' }, { name: 'at', type: 'datetime' }, { name: 'price', type: 'decimal' },
    { name: 'ok', type: 'bool' }, { name: 'data', type: 'binary' }, { name: 'meta', type: 'json' }, { name: 'ratio', type: 'float' },
  ];
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: i, at: i % 4 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + i * 60_000), price: `${i}.05`, ok: i % 3 === 0,
    data: Buffer.from([i & 255, 7]), meta: { i, tags: ['a', '<b>'] }, ratio: i / 8,
  }));
  const reader = open(write(null, rows, { columns }));
  const file = tmp('export.xml');
  fs.writeFileSync(file, toXML(reader));
  const back = open(importXMLFile(file, null, { columns: reader.columns }));
  assert.deepEqual([...back.rows()], [...reader.rows()]);
});

test('importXMLFile() reports what is wrong with the file', () => {
  const file = (text) => {
    const f = tmp('bad.xml');
    fs.writeFileSync(f, text);
    return f;
  };
  assert.throws(() => importXMLFile(file('<jazmin><row><a>1</a></row>'), null), /not well-formed/);
  assert.throws(() => importXMLFile(file('<jazmin><row><a><b>1</b></a></row></jazmin>'), null), /nested deeper/);
  assert.throws(() => importXMLFile(file('<jazmin><row><a>&nope;</a></row></jazmin>'), null), /Unknown XML entity/);
  assert.throws(() => importXMLFile(file('<jazmin><row><a>1</a></row><!-- unclosed'), null), /Malformed XML/);
  assert.throws(() => importXMLFile(file('<jazmin><row><c>1</c></row></jazmin>'), null, { columns: [{ name: 'a', type: 'int' }] }),
    /XML element 'c' is not one of the columns given/);
});
