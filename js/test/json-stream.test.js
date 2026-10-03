import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminValidationError, importJSONFile, open, readJsonObjects } from '../src/index.js';

const tmp = (name, text) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-stream-')), name);
  fs.writeFileSync(file, text);
  return file;
};

// Strings containing braces, brackets, escaped quotes and multi-byte characters.
const tricky = [
  { id: 1, text: 'brace } and { inside', nested: { a: [1, { b: ']' }] } },
  { id: 2, text: 'quote \\" and \\\\ backslash "', emoji: 'Zoë 👋 €' },
  { id: 3, text: '', nested: null },
];

test('streams a JSON array, including objects split across tiny read blocks', () => {
  const file = tmp('a.json', JSON.stringify(tricky, null, 2));
  for (const blockSize of [1, 3, 7, 64, 1 << 20]) {
    assert.deepEqual([...readJsonObjects(file, { blockSize })], tricky, `blockSize ${blockSize}`);
  }
});

test('streams JSON Lines and tolerates a UTF-8 BOM', () => {
  const file = tmp('a.jsonl', '﻿' + tricky.map((o) => JSON.stringify(o)).join('\n') + '\n');
  assert.deepEqual([...readJsonObjects(file, { blockSize: 5 })], tricky);
});

test('rejects malformed input with a clear error', () => {
  assert.throws(() => [...readJsonObjects(tmp('b.json', '[{"a":1}'))], /not closed/);
  assert.throws(() => [...readJsonObjects(tmp('c.json', '[{"a":1'))], /ends inside object 0/);
  assert.throws(() => [...readJsonObjects(tmp('d.json', '[{"a":1}, 5]'))], JazminValidationError);
  assert.throws(() => [...readJsonObjects(tmp('e.json', '[{"a":}]'))], /object 0 is invalid/);
});

test('stopping early closes the file', () => {
  const file = tmp('f.json', JSON.stringify(tricky));
  for (const _ of readJsonObjects(file)) break;
  fs.rmSync(file); // would fail on Windows if the handle were still open
});

test('importJSONFile infers the schema and writes without loading the input', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ section: `S${Math.floor(i / 100)}`, line: i, amount: i * 0.5, note: i % 3 ? null : 'x' }));
  const input = tmp('big.json', JSON.stringify(rows));
  const output = input.replace('.json', '.jzm');
  importJSONFile(input, output, { indexes: { section: 'sorted' }, chunkRows: 256 });
  const reader = open(output);
  assert.deepEqual(reader.columns.map((c) => `${c.name}:${c.type}:${c.nullable}`),
    ['section:string:false', 'line:int:false', 'amount:float:false', 'note:string:true']);
  assert.deepEqual([...reader.find({ section: 'S42' })], rows.filter((r) => r.section === 'S42'));
  reader.close();
});

test('importJSONFile with explicit columns reads the input once', () => {
  const input = tmp('g.jsonl', '{"a":1}\n{"a":2}\n');
  const reader = open(importJSONFile(input, null, { columns: [{ name: 'a', type: 'int' }] }));
  assert.deepEqual([...reader.rows()], [{ a: 1 }, { a: 2 }]);
});
