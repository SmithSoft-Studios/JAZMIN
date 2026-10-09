import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFilter, indexPlan, normalizeFilter } from '../src/filter.js';
import { open, write } from '../src/index.js';
import { PAGING } from '../src/writer.js';

// Query planning (issue #7): range conditions on one column make one bounded index lookup; an index lookup that would
// read more than scanning the chunks the filter leaves is not made; index rows outside those chunks are not read.

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 1);
const ACCOUNTS = 40;
const columns = [
  { name: 'account', type: 'string', nullable: false, index: 'sorted' },
  { name: 'at', type: 'datetime', nullable: false, index: 'sorted' },
  { name: 'amount', type: 'int', nullable: false },
  { name: 'description', type: 'string', index: 'trigram' },
];

/** 60,000 rows: every account's rows over a year, sorted by account then time, with a unique time on every row. */
function accountRows() {
  const rows = [];
  for (let i = 0; i < 60_000; i++) {
    const account = `ACC${String(i % ACCOUNTS).padStart(3, '0')}`;
    rows.push({ account, at: new Date(START + i * 523_000), amount: (i * 7919) % 10_000, description: `Purchase ${i % 997} at shop ${i % 53}` });
  }
  return rows.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.at - b.at));
}

const rows = accountRows();
const file = write(null, rows, { columns, sortedBy: ['account', 'at'], chunkRows: 500 });
const expected = (filter) => rows.filter(compileFilter(filter, columns)).length;
const analyze = (filter, options = {}) => {
  const reader = open(file);
  try {
    const { ms, ...cost } = reader.explain(filter, { analyze: true, ...options });
    return cost;
  } finally {
    reader.close();
  }
};

test('a range on one column reads only the index pages it spans', () => {
  const day = { at: { gte: new Date(START + 100 * DAY), lt: new Date(START + 101 * DAY) } };
  const cost = analyze(day);
  assert.equal(cost.rows, expected(day));
  assert.equal(cost.strategy, 'index');
  // The directory and one or two pages - not the half of the index each bound would read on its own.
  assert.ok(cost.indexPagesRead <= 3, JSON.stringify(cost));
});

test('a sort range is scanned instead of reading a costly index', () => {
  // Within one account the rows after a time: the time index would read most of its pages, the account's rows are
  // a couple of chunks.
  const keyset = { account: 'ACC007', at: { gt: new Date(START + 200 * DAY) } };
  const cost = analyze(keyset, { limit: 50 });
  // Only the time index's directory is read, to plan: none of its pages.
  assert.deepEqual([cost.strategy, cost.rows, cost.indexPagesRead], ['scan', 50, 1]);
  assert.ok(cost.chunksRead <= 2, JSON.stringify(cost));
  assert.equal(analyze(keyset).rows, expected(keyset));
  // A text search inside the account is answered by scanning its chunks: the trigram index is not read.
  const search = { account: 'ACC007', description: { contains: 'shop 7' } };
  assert.deepEqual([analyze(search).strategy, analyze(search).indexPagesRead, analyze(search).rows], ['scan', 0, expected(search)]);
});

test('index rows outside the chunks a scan would read are not read', () => {
  // A cheap index (one page) is still used, but only within the account's chunks.
  const small = write(null, rows.slice(0, 6000), { columns, sortedBy: ['account', 'at'], chunkRows: 100, [PAGING]: { pageBytes: 1 << 20 } });
  const reader = open(small);
  try {
    const filter = { account: 'ACC003', at: { gte: new Date(START) } };
    const scanChunks = reader.explain({ account: 'ACC003' }, { analyze: true }).chunksRead;
    const cost = reader.explain(filter, { analyze: true });
    assert.equal(cost.rows, rows.slice(0, 6000).filter(compileFilter(filter, columns)).length);
    assert.ok(cost.chunksRead <= scanChunks, JSON.stringify(cost));
  } finally {
    reader.close();
  }
});

test('every plan returns the same rows as checking every row', () => {
  const at = (days) => new Date(START + days * DAY);
  const filters = [
    { at: { gte: at(10), lt: at(11) } },
    { at: { gt: at(300) }, amount: { lt: 100 } },
    { account: 'ACC001', at: { gte: at(50), lte: at(60) } },
    { account: { in: ['ACC002', 'ACC030'] }, at: { lt: at(5) } },
    { or: [{ at: { lt: at(1) } }, { account: 'ACC039', amount: 1 }] },
    { description: { contains: 'shop 5' }, at: { gte: at(200), lt: at(201) } },
    { not: { account: 'ACC000' }, at: { gte: at(364) } },
    { at: { gt: at(100), lt: at(100) } },
    { at: { gte: at(100), lte: at(100) }, amount: { gt: -1 } },
  ];
  const reader = open(file);
  try {
    for (const filter of filters) assert.equal([...reader.find(filter)].length, expected(filter), JSON.stringify(filter));
  } finally {
    reader.close();
  }
});

// 20,000 rows in chunks of 500: 'often' in every other row, 'seldom' in every 5,000th, 'early' in the first 6,000.
const textColumns = [{ name: 'id', type: 'int', nullable: false, index: 'sorted' }, { name: 'text', type: 'string', index: 'trigram' }];
const textRow = (i) => ({ id: i, text: `n${i}${i % 2 ? '' : ' often'}${i % 5000 ? '' : ' seldom'}${i < 6000 ? ' early' : ''}` });
const textRows = Array.from({ length: 20_000 }, (_, i) => textRow(i));
const textFilters = [
  { text: { contains: 'often' } },
  { text: { contains: 'seldom' } },
  { text: { contains: 'early' } },
  { text: { contains: 'often' }, id: { in: [2, 4000, 12_001, 19_000] } },
  { or: [{ text: { contains: 'often' } }, { text: { contains: 'seldom' } }] },
  { text: { icontains: 'EARLY' }, id: { gte: 5000 } },
];

test('a text search scans for common text spread over the rows, and uses the index for rare or clustered text', () => {
  const reader = open(write(null, textRows, { columns: textColumns, chunkRows: 500 }));
  try {
    const plan = (filter) => {
      const { strategy, rows } = reader.explain(filter, { analyze: true });
      assert.equal(rows, textRows.filter(compileFilter(filter, textColumns)).length, JSON.stringify(filter));
      return strategy;
    };
    // Its candidates would fall in every chunk: checking each row of a scan is quicker.
    assert.equal(plan(textFilters[0]), 'scan');
    assert.equal(plan(textFilters[1]), 'index');
    // As common, but in rows that are together: the index skips the chunks around them.
    assert.equal(plan(textFilters[2]), 'index');
    assert.ok(reader.explain(textFilters[2], { analyze: true }).chunksRead <= 12);
    // Chunk statistics leave 4 chunks for the ids, and the common text adds nothing: they are scanned.
    assert.deepEqual(reader.explain(textFilters[3]), { strategy: 'scan', chunks: 40, chunksSkipped: 36 });
    // An OR with a common branch scans.
    assert.equal(plan(textFilters[4]), 'scan');
    for (const filter of textFilters) assert.equal(reader.count(filter), textRows.filter(compileFilter(filter, textColumns)).length, JSON.stringify(filter));
  } finally {
    reader.close();
  }
});

test('a lookup that narrows nothing leaves the others of an AND, and makes an OR scan', () => {
  // Stand-in indexes: the text index declines (null), as for common text; the id index returns its rows.
  const indexes = {
    get: (column) => ({
      cost: () => 0,
      rows: (lookup, scanRows) => (column === 'text' ? (scanRows === 1000 ? null : [1, 2, 3]) : [2, 3, 4]),
    }),
  };
  const node = (filter) => normalizeFilter(filter, textColumns);
  const text = { text: { contains: 'often' } };
  assert.deepEqual(indexPlan(node({ ...text, id: { in: [2, 3, 4] } }), indexes, Infinity, 1000).rows(), [2, 3, 4]);
  assert.equal(indexPlan(node(text), indexes, Infinity, 1000).rows(), null);
  assert.equal(indexPlan(node({ or: [text, { id: 2 }] }), indexes, Infinity, 1000).rows(), null);
  // Without the scan's row count (as when an owner looks for the partitions to load), the text index answers.
  assert.deepEqual(indexPlan(node({ ...text, id: { in: [2, 3, 4] } }), indexes).rows(), [2, 3]);
});
