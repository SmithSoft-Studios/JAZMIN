import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { append, compact, open, update, write } from '../src/index.js';
import { foldText, normalizeOrder, orderComparer, orderKeyMaker } from '../src/sort-keys.js';

// Other text orders (spec 6.7): text sorted ignoring case and accents (nocase), with the numbers inside it by value
// (natural), or both, kept by writers, appends, updates and rewrites; sortedBy keeps the plain leading keys.

const vectors = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures/sort-orders.json'), 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-sort-orders-'));
const sortWith = (list, flags) => {
  const { keys } = normalizeOrder([{ column: 's', ...flags }], [{ name: 's', type: 'string' }]);
  const key = orderKeyMaker(keys);
  const compare = orderComparer(keys);
  return list.map((s) => ({ s, k: key(() => s) })).sort((a, b) => compare(a.k, b.k)).map((x) => x.s);
};

test('the shared vectors: folded forms, and each order from a shuffled copy', () => {
  for (const [text, folded] of vectors.fold) assert.equal(foldText(text), folded, text);
  for (const [name, flags] of [['nocase', { nocase: true }], ['natural', { natural: true }], ['naturalNocase', { nocase: true, natural: true }]]) {
    assert.deepEqual(sortWith([...vectors[name]].reverse(), flags), vectors[name], name);
    assert.deepEqual(sortWith([...vectors[name]].sort(), flags), vectors[name], `${name} (code-unit order first)`);
  }
});

const columns = [{ name: 'region', type: 'string' }, { name: 'name', type: 'string', index: ['sorted'] }, { name: 'n', type: 'int' }];
const names = ['apple', 'Banana', 'café', 'Cafe2', 'Émile', 'file1', 'file10', 'File2', 'zebra', 'Zoë']; // without natural, '10' before '2'
const ids = (r, options) => [...r.rows(options)].map((x) => x.name);

test('a table sorted ignoring case and accents: written in that order, checked, read forwards and backwards', () => {
  const rows = names.map((name, n) => ({ region: 'A', name, n }));
  const r = open(write(null, rows, { columns, sortedBy: [{ column: 'name', nocase: true }], chunkRows: 3 }));
  assert.equal(r.sortedBy, undefined, 'no plain leading key: readers without sort see an unsorted table');
  assert.deepEqual(r.sort, [{ column: 'name', nocase: true }]);
  assert.deepEqual(ids(r), names);
  assert.deepEqual(ids(r, { reverse: true }), [...names].reverse());
  assert.ok(r.indexes.some((ix) => ix.column === 'name' && ix.kind === 'sorted'), 'a leading key with another text order keeps its sorted index');
  assert.deepEqual([...r.find({ name: 'Banana' })].map((x) => x.n), [1], 'filters compare as before');
  r.close();
  assert.throws(() => write(null, [{ region: 'A', name: 'b', n: 1 }, { region: 'A', name: 'A', n: 2 }], { columns, sortedBy: [{ column: 'name', nocase: true }] }),
    /Row 1 is out of order for sortedBy \[name \(nocase\)\]/);
  // Plainly, 'B' < 'a': the same rows are out of order for a plain sortedBy.
  assert.throws(() => write(null, rows, { columns, sortedBy: ['name'] }), /out of order for sortedBy \[name\]/);
  assert.throws(() => write(null, rows, { columns, sortedBy: [{ column: 'n', natural: true }] }), /nocase and natural are for string columns \('n' is int\)/);
  assert.throws(() => write(null, rows, { columns, sortedBy: [{ column: 'name', fold: true }] }), /unknown option 'fold' \(column, nocase, natural\)/);
});

test('a plain leading key stays sortedBy, so every reader binary-searches it; natural numbers after it', () => {
  const rows = ['A', 'B', 'C'].flatMap((region) => ['x1', 'x2', 'x10', 'x20', 'x100'].map((name, n) => ({ region, name, n })));
  const file = path.join(tmpDir(), 'mixed.jzm');
  write(file, rows, { columns, sortedBy: ['region', { column: 'name', natural: true }], chunkRows: 5 });
  const r = open(file);
  assert.deepEqual(r.sortedBy, ['region']);
  assert.deepEqual(r.sort, [{ column: 'region' }, { column: 'name', natural: true }]);
  assert.deepEqual(ids(r).slice(0, 5), ['x1', 'x2', 'x10', 'x20', 'x100']);
  assert.equal(r.explain({ region: 'B' }).chunksSkipped, 2, 'the leading plain key is binary-searched');
  r.close();
});

test('appends, updates, compaction and re-sorts keep the order', () => {
  const file = path.join(tmpDir(), 'kept.jzm');
  const order = [{ column: 'name', nocase: true, natural: true }];
  write(file, ['file1', 'File2', 'file10'].map((name, n) => ({ region: 'A', name, n })), { columns, sortedBy: order, chunkRows: 2 });
  append(file, { insert: [{ region: 'A', name: 'FILE20', n: 3 }, { region: 'A', name: 'file11', n: 4 }] });
  assert.throws(() => append(file, { insert: [{ region: 'A', name: 'file3', n: 5 }] }), /Appended rows must sort after the existing rows/);
  let r = open(file);
  assert.deepEqual(ids(r), ['file1', 'File2', 'file10', 'file11', 'FILE20']);
  assert.deepEqual(r.sort, order);
  r.close();
  update(file, { insert: [{ region: 'A', name: 'file3', n: 5 }, { region: 'A', name: 'File15', n: 6 }] });
  r = open(file);
  assert.deepEqual(ids(r), ['file1', 'File2', 'file3', 'file10', 'file11', 'File15', 'FILE20'], 'an update merges rows at their place');
  r.close();
  update(file, { set: { name: 'file12' }, where: { n: 0 } });
  r = open(file);
  assert.deepEqual(ids(r), ['File2', 'file3', 'file10', 'file11', 'file12', 'File15', 'FILE20'], 'a row whose sort value is set moves');
  r.close();
  compact(file);
  r = open(file);
  assert.deepEqual(r.sort, order, 'compaction keeps it');
  r.close();
  // A re-sort to a plain order and back: the sorter compares the same way.
  update(file, { sortedBy: ['name'] });
  r = open(file);
  assert.deepEqual(ids(r), ['FILE20', 'File15', 'File2', 'file10', 'file11', 'file12', 'file3']);
  assert.deepEqual(r.sortedBy, ['name']);
  assert.equal(r.sort, undefined);
  r.close();
  update(file, { sortedBy: order, sortRunRows: 2 }); // runs of 2 rows: merged through temporary files
  r = open(file);
  assert.deepEqual(ids(r), ['File2', 'file3', 'file10', 'file11', 'file12', 'File15', 'FILE20']);
  assert.deepEqual(r.sort, order);
  r.close();
});
