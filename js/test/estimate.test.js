import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { open, write } from '../src/index.js';

// estimate() (issue #185): what a read would cost, known before it starts, from directories, statistics and indexes
// only. Checked against what explain({ analyze }) and count() then read. Mirrors dotnet/tests/Jazmin.Tests/EstimateTests.cs.

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));

const CASES = [
  ['js-paged-key.jzm', { id: 7 }, {}],
  ['js-paged-key.jzm', { country: 'NA' }, {}],
  ['js-paged-key.jzm', { score: { gt: 50 } }, {}],
  ['js-paged-key.jzm', null, {}],
  ['js-paged-key.jzm', null, { offset: 100 }],
  ['js-access.jzm', { score: { gt: 50 } }, {}],
  ['js-access.jzm', null, { offset: 100 }],
];

test('estimate() names the chunks find() then reads, without reading a row', () => {
  for (const [file, filter, options] of CASES) {
    const label = `${file} ${JSON.stringify(filter)} ${JSON.stringify(options)}`;
    const reader = open(path.join(fixtures, file), { key: keys.key });
    const fresh = open(path.join(fixtures, file), { key: keys.key });
    try {
      const estimate = reader.estimate(filter, options);
      assert.deepEqual(Object.keys(estimate).sort(), ['bytes', 'chunks', 'countBytes', 'countChunks', 'countRows', 'rows'], label);
      const actual = fresh.explain(filter, { analyze: true, ...options });
      assert.equal(estimate.chunks, actual.chunksRead, `${label}: chunks`);
      assert.ok(estimate.rows >= actual.rows, `${label}: rows ${estimate.rows} >= ${actual.rows}`);
      assert.ok(estimate.bytes > 0 || estimate.chunks === 0, label);
      assert.ok(estimate.bytes <= actual.bytesRead || estimate.chunks === 0, `${label}: chunk bytes ${estimate.bytes} within the ${actual.bytesRead} read`);
      // Without a filter, count() reads only the header.
      if (filter === null) assert.deepEqual([estimate.countChunks, estimate.countRows, estimate.countBytes], [0, 0, 0], label);
    } finally {
      reader.close();
      fresh.close();
    }
  }
});

test('estimate() says what count() reads: nothing when indexes or statistics answer it, else the chunks it scans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-estimate-'));
  const file = path.join(dir, 'e.jzm');
  write(file, Array.from({ length: 2000 }, (_, id) => ({ id, city: ['Durban', 'Cape Town'][id % 2], amount: (id * 37) % 1000 })), {
    columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'city', type: 'string', index: 'sorted' }, { name: 'amount', type: 'float' }],
    sortedBy: ['id'], chunkRows: 100,
  });
  const reader = open(file);
  try {
    // An exact index answer, and a range of the sort column whose chunks all match: counted without reading rows.
    assert.equal(reader.estimate({ city: 'Durban' }).countChunks, 0);
    assert.equal(reader.estimate({ id: { gte: 1000 } }).countChunks, 0);
    // A column with no index: count() reads every chunk, and only those.
    const scan = reader.estimate({ amount: { gt: 900 } });
    assert.deepEqual([scan.countChunks, scan.countRows], [20, 2000]);
    assert.equal(scan.countBytes, scan.bytes);
    let progressChunks = 0;
    reader.count({ amount: { gt: 900 } }, { onProgress: (p) => { progressChunks = p.total; } });
    assert.equal(progressChunks, scan.countChunks, 'the chunks count() then goes through');
    // A range of the sort column that starts inside a chunk: that chunk is read, the rest counted from statistics.
    const partial = reader.estimate({ id: { gte: 1050 } });
    assert.deepEqual([partial.countChunks, partial.countRows], [1, 100]);
    // An unknown column is refused, as the reads refuse it.
    assert.throws(() => reader.estimate({ nope: 1 }), /unknown column 'nope'/);
  } finally {
    reader.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
