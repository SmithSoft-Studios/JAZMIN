import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFormatError, JazminKey, append, compact, open, write } from '../src/index.js';
import { decodeIndexDirectory } from '../src/catalog.js';
import { APPEND_STATE } from '../src/reader.js';
import { decodeSection } from '../src/section.js';
import { PAGING } from '../src/writer.js';

// Rows sorted by `seq`, so indexes on the other columns are used (not chunk statistics).
const columns = [
  { name: 'seq', type: 'int', nullable: false },
  { name: 'account', type: 'string', index: 'sorted' },
  { name: 'amount', type: 'int', index: 'sorted' },
  { name: 'price', type: 'float', index: 'sorted' },
  { name: 'when', type: 'datetime', index: 'sorted' },
];
const rows = Array.from({ length: 3000 }, (_, i) => ({
  seq: i,
  account: i % 17 === 0 ? null : `ACC${String((i * 7919) % 1000).padStart(4, '0')}`,
  amount: (i * 104729) % 5000 - 2500,
  price: i % 13 === 0 ? null : ((i * 31) % 997) / 4,
  when: new Date(Date.UTC(2024, 0, 1) + ((i * 613) % 3000) * 86_400_000),
}));
const small = { [PAGING]: { pageBytes: 200 } }; // many small pages
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-paged-')), name);
/** "column:pages" for each sorted index of an unencrypted file (read from the index directories). */
const pageCounts = (buf, r) => r[APPEND_STATE].indexes.map((ix) => {
  const { offset, length } = ix.section;
  const raw = decodeSection(buf.subarray(offset, offset + length), { sectionId: `0/index/${ix.column}/${ix.kind}` });
  return `${ix.column}:${decodeIndexDirectory(raw).pages.length}`;
});
const ids = (r, filter) => [...r.find(filter, { select: ['seq'] })].map((x) => x.seq);

const filters = [
  { account: 'ACC0001' }, { account: 'ACC9999' }, { account: 'A' }, { account: 'ZZZ' },
  { account: { in: ['ACC0001', 'ACC0500', 'ACC0999', 'nope'] } },
  { account: { startsWith: 'ACC00' } }, { account: { startsWith: 'ACC0' } }, { account: { startsWith: 'X' } },
  { account: { isNull: true } },
  { amount: -2500 }, { amount: 2499 }, { amount: 0 }, { amount: { gt: 2400 } }, { amount: { gte: 2400 } },
  { amount: { lt: -2400 } }, { amount: { lte: -2400 } }, { amount: { gt: 9999 } }, { amount: { lt: -9999 } },
  { amount: { gte: -100, lt: 100 } },
  { price: 0.25 }, { price: { gt: 248 } }, { price: { lte: 1 } }, { price: { isNull: true } },
  { when: new Date(Date.UTC(2024, 0, 1)) }, { when: { gte: new Date(Date.UTC(2031, 0, 1)) } },
  { account: 'ACC0001', amount: { gt: 0 } },
];

test('a sorted index in many pages answers every lookup like one in a single page', () => {
  const wholeBuf = write(null, rows, { columns, sortedBy: ['seq'] });
  const pagedBuf = write(null, rows, { columns, sortedBy: ['seq'], ...small });
  const [whole, paged] = [open(wholeBuf), open(pagedBuf)];
  assert.deepEqual(pageCounts(wholeBuf, whole), ['account:1', 'amount:1', 'price:1', 'when:1']);
  assert.ok(pageCounts(pagedBuf, paged).every((p) => Number(p.split(':')[1]) > 20), pageCounts(pagedBuf, paged).join());
  assert.deepEqual(paged.indexes, whole.indexes); // pages are a storage detail
  for (const filter of filters) {
    assert.equal(paged.explain(filter).strategy, 'index', JSON.stringify(filter));
    assert.deepEqual(ids(paged, filter), ids(whole, filter), JSON.stringify(filter));
  }
});

test('with the default page size, small indexes are one page and large ones many', () => {
  const many = Array.from({ length: 120_000 }, (_, i) => ({ seq: i, amount: (i * 104729) % 1_000_003 }));
  const buf = write(null, many, { columns: [columns[0], columns[2]], sortedBy: ['seq'] });
  const [counts] = pageCounts(buf, open(buf));
  assert.ok(Number(counts.split(':')[1]) > 5, counts);
});

test('a lookup reads one page, not the whole index', () => {
  const many = Array.from({ length: 200_000 }, (_, i) => ({ seq: i, amount: (i * 104729) % 1_000_003 }));
  const file = tmp('big.jzm');
  write(file, many, { columns: [columns[0], columns[2]], sortedBy: ['seq'], chunkRows: 1000 });
  const r = open(file);
  const target = many[123_456];
  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => {
    const n = original(...args);
    bytes += n;
    return n;
  };
  try {
    assert.deepEqual([...r.find({ amount: target.amount })].map((x) => x.seq), [123_456]);
  } finally {
    fs.readSync = original;
  }
  const withoutIndex = write(null, many, { columns: [columns[0], { ...columns[2], index: undefined }], sortedBy: ['seq'], chunkRows: 1000 });
  const indexBytes = fs.statSync(file).size - withoutIndex.length;
  assert.ok(indexBytes > 400_000, `index is large (${indexBytes} bytes)`);
  assert.ok(bytes < 100_000, `lookup read ${bytes} bytes (directory, one page, one chunk)`);
  r.close();
});

test('paged indexes: appended segments, compaction, encryption and owner signatures', () => {
  const key = JazminKey.generate();
  const file = tmp('grow.jzm');
  write(file, rows.slice(0, 2000), { columns, sortedBy: ['seq'], key, ...small });
  append(file, { key, insert: rows.slice(2000) }); // the append writes its own index segment
  let r = open(file, { key });
  assert.deepEqual(r[APPEND_STATE].indexes.filter((ix) => ix.column === 'amount').map((ix) => ix.segment), [0, 1]);
  const whole = open(write(null, rows, { columns, sortedBy: ['seq'] }));
  for (const filter of filters) assert.deepEqual(ids(r, filter), ids(whole, filter), JSON.stringify(filter));
  r.close();
  compact(file, { key });
  r = open(file, { key });
  for (const filter of filters) assert.deepEqual(ids(r, filter), ids(whole, filter), JSON.stringify(filter));
  r.close();

  // Access-controlled: the owner's index pages carry digests; a changed page is detected.
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  const access = { partitionBy: 'account', grants: [{ key: bob, rows: ['ACC0001'], columns: '*' }] };
  const buffer = write(null, rows, { columns, sortedBy: ['seq'], key: owner, access, ...small });
  const asOwner = open(buffer, { key: owner });
  assert.deepEqual(ids(asOwner, { amount: { gt: 2400 } }), ids(whole, { amount: { gt: 2400 } }));
  const directory = asOwner[APPEND_STATE].indexes.find((ix) => ix.column === 'amount').section;
  const tampered = Buffer.from(buffer);
  tampered[directory.offset - 10] ^= 1; // inside the last page written before the amount directory
  assert.throws(() => ids(open(tampered, { key: owner }), { amount: { gt: -9999 } }), JazminFormatError);
});
