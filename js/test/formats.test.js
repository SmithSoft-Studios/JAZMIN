import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  exportFile, fromCSV, fromJSON, fromXML, open, parseCsv, parseXml, toCSV, toJSON, toXML, write,
} from '../src/index.js';

const people = [
  { id: 1, name: 'Ann, "the brave"', city: 'Cape Town', score: 1.5, active: true },
  { id: 2, name: 'Bob\nNewline', city: null, score: 2, active: false },
  { id: 3, name: '', city: 'Durban', score: null, active: null },
];

test('JSON -> JAZMIN -> JSON preserves data', () => {
  const buf = fromJSON(JSON.stringify(people), null);
  assert.deepEqual(JSON.parse(toJSON(open(buf))), people);
});

test('JSON export keeps big integers and decimals exact', () => {
  const buf = write(null, [{ big: 2n ** 62n, money: '12345678901234567890.12' }], {
    columns: [{ name: 'big', type: 'int' }, { name: 'money', type: 'decimal' }],
  });
  assert.equal(toJSON(open(buf)), '[{"big":4611686018427387904,"money":12345678901234567890.12}]');
});

test('JSON export can omit nulls, pretty-print, filter and select', () => {
  const r = open(fromJSON(people, null));
  assert.deepEqual(JSON.parse(toJSON(r, { omitNulls: true }))[1], { id: 2, name: 'Bob\nNewline', score: 2, active: false });
  assert.deepEqual(JSON.parse(toJSON(r, { filter: { id: { gt: 1 } }, select: ['id'] })), [{ id: 2 }, { id: 3 }]);
  assert.match(toJSON(r, { pretty: true }), /\n  \{/);
});

test('CSV round-trip distinguishes null from empty string and handles quoting', () => {
  const csv = toCSV(open(fromJSON(people, null)));
  assert.equal(csv.split('\r\n')[0], 'id,name,city,score,active');
  assert.ok(csv.includes('"Ann, ""the brave"""'));
  const back = open(fromCSV(csv, null));
  assert.deepEqual([...back.rows()], people);
  assert.deepEqual(back.columns.map((c) => c.type), ['int', 'string', 'string', 'float', 'bool']);
});

test('CSV parsing without type inference keeps text', () => {
  const { columns, rows } = parseCsv('zip,n\n0042,1\n', { inferTypes: false });
  assert.deepEqual(columns.map((c) => c.type), ['string', 'string']);
  assert.deepEqual(rows, [{ zip: '0042', n: '1' }]);
});

test('XML round-trip, including names that are not valid XML element names', () => {
  const data = [{ 'first name': 'Ann & <Co>', age: 31 }, { 'first name': null, age: 5 }];
  const xml = toXML(open(fromJSON(data, null)));
  assert.ok(xml.includes('<field name="first name">Ann &amp; &lt;Co&gt;</field>'));
  const back = open(fromXML(xml, null));
  assert.deepEqual([...back.rows()], data);
});

test('XML parser handles comments, CDATA and self-closing elements', () => {
  const { rows } = parseXml(`<?xml version="1.0"?><!-- c --><root><r><a><![CDATA[x<y]]></a><b/></r><r/></root>`);
  assert.deepEqual(rows, [{ a: 'x<y', b: '' }, { a: null, b: null }]);
});

test('exportFile streams to disk', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-')), 'out.csv');
  exportFile(open(fromJSON(people, null)), 'csv', file);
  assert.equal(fs.readFileSync(file, 'utf8'), toCSV(open(fromJSON(people, null))));
});
