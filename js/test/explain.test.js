import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { open } from '../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));

/** explain({ analyze }) on a freshly opened reader, without the time (which varies). */
function analyze(file, filter, options = {}) {
  const reader = open(path.join(fixtures, file), { key: keys.key });
  try {
    const { ms, ...cost } = reader.explain(filter, { analyze: true, ...options });
    assert.ok(ms >= 0);
    return cost;
  } finally {
    reader.close();
  }
}

// The same file and queries are checked with the same numbers in dotnet/tests/Jazmin.Tests/ExplainTests.cs.
const CASES = [
  ['js-paged-key.jzm', { id: 7 }, {}, { strategy: 'index', candidateRows: 1, rows: 1, bytesRead: 1817, chunksRead: 1, indexPagesRead: 2, columnsDecoded: 9 }],
  ['js-paged-key.jzm', { country: 'NA' }, {}, { strategy: 'index', candidateRows: 100, rows: 100, bytesRead: 9187, chunksRead: 8, indexPagesRead: 2, columnsDecoded: 72 }],
  ['js-paged-key.jzm', { score: { gt: 50 } }, { select: ['id'] }, { strategy: 'scan', chunks: 8, chunksSkipped: 5, rows: 126, bytesRead: 3493, chunksRead: 3, indexPagesRead: 0, columnsDecoded: 6 }],
  ['js-paged-key.jzm', null, { offset: 100, limit: 10 }, { strategy: 'scan', chunks: 8, chunksSkipped: 0, rows: 10, bytesRead: 2292, chunksRead: 2, indexPagesRead: 0, columnsDecoded: 18 }],
  ['js-access.jzm', { score: { gt: 50 } }, { select: ['id'] }, { strategy: 'scan', chunks: 500, chunksSkipped: 374, rows: 126, bytesRead: 70847, chunksRead: 126, indexPagesRead: 0, columnsDecoded: 1134 }],
];

test('explain({ analyze }) reports rows, bytes, chunks, index pages and columns decoded', () => {
  for (const [file, filter, options, expected] of CASES) {
    assert.deepEqual(analyze(file, filter, options), expected, `${file} ${JSON.stringify(filter)} ${JSON.stringify(options)}`);
  }
});

test('explain({ analyze }) counts the same bytes as the reads from the file', () => {
  let bytes = 0;
  const readSync = fs.readSync;
  fs.readSync = (...args) => {
    const n = readSync.apply(fs, args);
    bytes += n;
    return n;
  };
  try {
    for (const [file, filter, options] of CASES) {
      const reader = open(path.join(fixtures, file), { key: keys.key });
      bytes = 0;
      const found = [...reader.find(filter, options)].length;
      const read = bytes;
      reader.close();
      const cost = analyze(file, filter, options);
      assert.equal(cost.bytesRead, read, `${file} ${JSON.stringify(filter)}`);
      assert.equal(cost.rows, found);
    }
  } finally {
    fs.readSync = readSync;
  }
});

test('explain() without analyze is unchanged, and analyze leaves the reader as it was', () => {
  const reader = open(path.join(fixtures, 'js-paged-key.jzm'), { key: keys.key });
  try {
    assert.deepEqual(reader.explain({ id: 7 }), { strategy: 'index', candidateRows: 1 });
    const before = [...reader.find({ country: 'NA' }, { limit: 5 })];
    assert.equal(reader.explain({ country: 'NA' }, { analyze: true, limit: 5 }).rows, 5);
    assert.deepEqual([...reader.find({ country: 'NA' }, { limit: 5 })], before);
    // Already loaded: the index pages and the last chunk are not read again.
    const again = reader.explain({ id: 7 }, { analyze: true });
    assert.equal(again.indexPagesRead, 0);
    assert.throws(() => reader.explain({ nope: 1 }, { analyze: true }), /unknown column 'nope'/);
  } finally {
    reader.close();
  }
});
