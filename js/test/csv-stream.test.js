// Streaming CSV import (TASKS C-2): records read a block at a time must be exactly those of the whole text, and a file
// imported with importCSVFile() must equal fromCSV() of its text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fromCSV, importCSVFile, open, readCsvRecords, toCSV, write } from '../src/index.js';
import { CsvRecordParser, parseCsvRecords } from '../src/formats/csv.js';

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-csv-')), name);

/** The parser before streaming (1.1.0), character by character: the reference the streaming parser must match. */
function referenceRecords(text, delimiter = ',') {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  const endField = () => {
    record.push(quoted || field !== '' ? field : null);
    field = '';
    quoted = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '' && !quoted) {
      inQuotes = true;
      quoted = true;
    } else if (ch === delimiter) endField();
    else if (ch === '\r' || ch === '\n') {
      endField();
      records.push(record);
      record = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
    i++;
  }
  if (inQuotes) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || quoted || record.length > 0) {
    endField();
    records.push(record);
  }
  return records;
}

function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Random CSV text made of the pieces that matter: quotes, escaped quotes, delimiters and every line ending. */
function randomCsv(rnd, delimiter) {
  const parts = ['a', 'bc', ' ', '"', '""', delimiter, '\r', '\n', '\r\n', 'é', '日本', '"x""y"', ''];
  let text = '';
  const length = Math.floor(rnd() * 60);
  for (let i = 0; i < length; i++) text += parts[Math.floor(rnd() * parts.length)];
  // Quotes left open are an error in both parsers; close them half the time.
  return rnd() < 0.5 ? text : `${text}"`;
}

const outcome = (fn) => {
  try {
    return { records: fn() };
  } catch (error) {
    return { error: error.message };
  }
};

test('records from text in pieces of any size equal those of the whole text, as the reference parser reads them', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const rnd = random(seed);
    const delimiter = seed % 3 === 0 ? ';' : ',';
    const text = randomCsv(rnd, delimiter);
    const expected = outcome(() => referenceRecords(text, delimiter));
    assert.deepEqual(outcome(() => parseCsvRecords(text, delimiter)), expected, `seed ${seed}: ${JSON.stringify(text)}`);
    const pieces = outcome(() => {
      const parser = new CsvRecordParser(delimiter);
      const records = [];
      for (let at = 0; at < text.length;) {
        const size = 1 + Math.floor(rnd() * 5);
        records.push(...parser.push(text.slice(at, at + size)));
        at += size;
      }
      records.push(...parser.push('', true));
      return records;
    });
    assert.deepEqual(pieces, expected, `seed ${seed} in pieces: ${JSON.stringify(text)}`);
  }
});

test('a file read in small blocks gives the same records: multi-byte characters, line endings and quotes split', () => {
  const text = '\uFEFFid,name,note\r\n1,"Smith, J",é日本\r\n2,"say ""hi""",\n3,,"line one\r\nline two"\r\n';
  const file = tmp('split.csv');
  fs.writeFileSync(file, text);
  const expected = referenceRecords(text.slice(1));
  for (const blockSize of [1, 2, 3, 5, 7, 64, 1 << 20]) {
    assert.deepEqual([...readCsvRecords(file, { blockSize })], expected, `block ${blockSize}`);
  }
});

test('files read in blocks of random small sizes give the reference records, with any delimiter', () => {
  const file = tmp('random.csv');
  for (let seed = 1; seed <= 600; seed++) {
    const rnd = random(seed);
    const delimiter = [',', ';', '\t', '§'][seed % 4]; // § is not ASCII: found in the decoded text
    const text = randomCsv(rnd, delimiter) + randomCsv(rnd, delimiter);
    fs.writeFileSync(file, text);
    const expected = outcome(() => referenceRecords(text.replace(/^\uFEFF/, ''), delimiter));
    const blockSize = 1 + Math.floor(rnd() * 12);
    assert.deepEqual(outcome(() => [...readCsvRecords(file, { delimiter, blockSize })]), expected, `seed ${seed} block ${blockSize}: ${JSON.stringify(text)}`);
  }
});

test('importCSVFile() gives what fromCSV() gives for the same text', () => {
  const lines = ['id,amount,active,label,when'];
  for (let i = 0; i < 2500; i++) lines.push(`${i},${i % 7 === 0 ? '' : (i * 1.25).toString()},${i % 2 === 0},${i % 5 === 0 ? '' : `"L, ${i % 9}"`},2026-10-${String(1 + (i % 28)).padStart(2, '0')}`);
  const text = `${lines.join('\r\n')}\r\n`;
  const file = tmp('rows.csv');
  fs.writeFileSync(file, text);
  const expected = open(fromCSV(text, null, { chunkRows: 256 }));
  const actual = open(importCSVFile(file, null, { chunkRows: 256 }));
  assert.deepEqual(actual.columns, expected.columns);
  assert.deepEqual([...actual.rows()], [...expected.rows()]);
  // Written to a path, and without type inference.
  const out = tmp('rows.jzm');
  importCSVFile(file, out, { inferTypes: false });
  assert.ok(open(out).columns.every((c) => c.type === 'string'));
});

test('importCSVFile() with columns reads each value as its column type: a CSV export imports back exactly', () => {
  const columns = [
    { name: 'id', type: 'int' }, { name: 'at', type: 'datetime' }, { name: 'price', type: 'decimal' },
    { name: 'ok', type: 'bool' }, { name: 'data', type: 'binary' }, { name: 'meta', type: 'json' }, { name: 'ratio', type: 'float' },
  ];
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: i, at: i % 4 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + i * 60_000), price: `${i}.05`, ok: i % 3 === 0,
    data: Buffer.from([i & 255, 7]), meta: { i, tags: ['a', 'b'] }, ratio: i / 8,
  }));
  const reader = open(write(null, rows, { columns }));
  const file = tmp('export.csv');
  fs.writeFileSync(file, toCSV(reader));
  const back = open(importCSVFile(file, null, { columns: reader.columns }));
  assert.deepEqual([...back.rows()], [...reader.rows()]);
});

test('importCSVFile() reports what is wrong with the file', () => {
  const file = (text) => {
    const f = tmp('bad.csv');
    fs.writeFileSync(f, text);
    return f;
  };
  assert.throws(() => importCSVFile(file(''), null), /CSV has no header row/);
  assert.throws(() => importCSVFile(file('a,b\n1,2\n1,2,3\n'), null), /CSV line 3 has more fields than the header/);
  assert.throws(() => importCSVFile(file('a,b\n"1,2\n'), null), /CSV ends inside a quoted field/);
  assert.throws(() => importCSVFile(file('a,c\n1,2\n'), null, { columns: [{ name: 'a', type: 'int' }, { name: 'b', type: 'int' }] }),
    /CSV column 'c' is not one of the columns given/);
});

test('the type of a value worked out from its bytes is the type its text is inferred as', async () => {
  const { textType, textTypeOfBytes } = await import('../src/formats/text.js');
  const alphabet = ['0', '7', '-', '+', '.', 'e', 'E', 't', 'r', 'u', 'f', 'a', 'l', 's', 'T', 'R', 'U', 'F', 'A', 'L', 'S', 'x', ' ', 'é', '4', '\u0014'];
  const samples = ['', '-', '.', '1', '-1', '1.', '.5', '-.5', '1e5', '1E+5', '1e-5', 'e5', '1e', '1.2.3', 'true', 'FALSE', 'True', 'truee', '--1', '1-'];
  const rnd = random(99);
  for (let n = 0; n < 50_000; n++) {
    let text = '';
    const length = Math.floor(rnd() * 7);
    for (let k = 0; k < length; k++) text += alphabet[Math.floor(rnd() * alphabet.length)];
    samples.push(text);
  }
  for (const text of samples) {
    const bytes = Buffer.from(`#${text}#`); // with bytes around it: only start..end counts
    assert.equal(textTypeOfBytes(bytes, 1, bytes.length - 1), textType(text), JSON.stringify(text));
  }
});
