// A sorted index on the leading sortedBy column is not written: readers find that column's values from chunk
// statistics and have never used such an index (spec 6.7). Other indexes, and a trigram index on that column, are.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { append, open, write } from '../src/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-leading-sort-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const columns = [
  { name: 'code', type: 'string', nullable: false, index: ['sorted', 'trigram'] },
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'amount', type: 'float' },
];
const row = (i) => ({ code: `C${String(i).padStart(5, '0')}`, id: (i * 7919) % 100_003, amount: i / 4 });

test('the leading sortedBy column gets no sorted index, and queries on it find the same rows, before and after an append', () => {
  const file = path.join(dir, 'codes.jzm');
  let rows = Array.from({ length: 1500 }, (_, i) => row(i));
  write(file, rows, { columns, sortedBy: ['code'], chunkRows: 100 });
  const check = () => {
    const r = open(file);
    try {
      assert.deepEqual(r.indexes.map((ix) => `${ix.column}/${ix.kind}`).sort(), ['code/trigram', 'id/sorted']);
      const queries = [
        [{ code: 'C00500' }, (x) => x.code === 'C00500'],
        [{ code: { gte: 'C00100', lt: 'C00230' } }, (x) => x.code >= 'C00100' && x.code < 'C00230'],
        [{ code: { in: ['C00007', 'C01499', 'C01600', 'C99999'] } }, (x) => ['C00007', 'C01499', 'C01600', 'C99999'].includes(x.code)],
        [{ code: { contains: '0050' } }, (x) => x.code.includes('0050')],
        [{ code: { startsWith: 'C014' } }, (x) => x.code.startsWith('C014')],
        [{ id: { lt: 500 } }, (x) => x.id < 500],
      ];
      for (const [filter, test] of queries) assert.deepEqual([...r.find(filter)], rows.filter(test), JSON.stringify(filter));
      // Chunk statistics locate the value: every chunk but the one holding it is skipped.
      const plan = r.explain({ code: 'C00500' });
      assert.equal(plan.strategy, 'scan');
      assert.equal(plan.chunks - plan.chunksSkipped, 1);
    } finally {
      r.close();
    }
  };
  check();
  const more = Array.from({ length: 300 }, (_, i) => row(1500 + i));
  append(file, { insert: more });
  rows = rows.concat(more);
  check();
});
