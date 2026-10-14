import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, append, compact, inspect, open, write } from '../src/index.js';

// reader.storage(): how a file's bytes are used, for deciding whether to compact it. A file written in full uses
// every byte; an append leaves the replaced header behind; deleted rows stay stored until compact() removes them.

const fixtures = path.resolve(import.meta.dirname, '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-storage-'));

const storageOf = (file, options) => {
  const reader = open(file, options);
  try {
    return reader.storage();
  } finally {
    reader.close();
  }
};

/** The header length the trailer names: the bytes an append replaces (with the 44-byte trailer). */
const headerLength = (file) => {
  const bytes = fs.readFileSync(file);
  return bytes.readUInt32LE(bytes.length - 44 + 8);
};

test('every fixture written in full uses every byte; appended ones have unused bytes', () => {
  for (const name of fs.readdirSync(fixtures).filter((n) => n.endsWith('.jzm'))) {
    const file = path.join(fixtures, name);
    const facts = inspect(file);
    const options = !facts.encrypted ? {} : facts.passwordProtected ? { password: keys.password } : { key: keys.key };
    const s = storageOf(file, options);
    assert.equal(s.fileBytes, fs.statSync(file).size, name);
    assert.equal(s.usedBytes + s.unusedBytes, s.fileBytes, name);
    if (facts.appended) assert.ok(s.unusedBytes > 0 && s.appendCount > 0, `${name}: appended, so some bytes are unused`);
    else assert.deepEqual([s.unusedBytes, s.deletedRows, s.appendCount], [0, 0, 0], name);
  }
});

test('an append leaves the replaced header unused; deleted rows stay stored; compact() gives every byte back', () => {
  const file = path.join(temp(), 'orders.jzm');
  const key = JazminKey.generate();
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, customer: `C${i % 50}`, note: `order ${i} `.repeat(4) }));
  write(file, rows, { key, columns: [{ name: 'id', type: 'int', index: 'sorted' }, { name: 'customer', type: 'string', index: 'sorted' }, { name: 'note', type: 'string' }], chunkRows: 500 });
  let s = storageOf(file, { key });
  assert.deepEqual([s.unusedBytes, s.deletedRows, s.tables[0].chunks, s.tables[0].rowsPerChunk], [0, 0, 4, 500]);
  assert.deepEqual(s.tables[0].indexes, [{ column: 'id', kind: 'sorted', segments: 1 }, { column: 'customer', kind: 'sorted', segments: 1 }]);

  // An insert: the header it replaces, and its trailer, are all that's unused.
  const replaced = headerLength(file) + 44;
  append(file, { key, insert: [{ id: 5000, customer: 'C1', note: 'new' }] });
  s = storageOf(file, { key });
  assert.deepEqual([s.unusedBytes, s.appendCount, s.tables[0].chunks], [replaced, 1, 5]);
  assert.deepEqual(s.tables[0].indexes.map((ix) => ix.segments), [2, 2]); // one more segment per append

  // Deletes: the rows stay stored until compact(); their bytes are estimated from their chunks.
  append(file, { key, delete: { id: { lt: 400 } } });
  s = storageOf(file, { key });
  assert.deepEqual([s.deletedRows, s.tables[0].rows, s.tables[0].deletedRows], [400, 1601, 400]);
  const firstChunk = s.deletedBytes; // 400 of the first chunk's 500 rows
  assert.ok(firstChunk > 0 && firstChunk < s.usedBytes / 4, `deletedBytes ${firstChunk}`);

  const before = fs.statSync(file).size;
  const result = compact(file, { key });
  s = storageOf(file, { key });
  assert.deepEqual([s.unusedBytes, s.deletedRows, s.appendCount, s.fileBytes], [0, 0, 0, result.bytesAfter]);
  assert.deepEqual(s.tables[0].indexes.map((ix) => ix.segments), [1, 1]);
  assert.ok(result.bytesAfter < before);
});

test('a shared file is measured with its owner key, every table; an access key is refused', () => {
  const file = path.join(temp(), 'shared.jzm');
  const owner = JazminKey.generate();
  const bob = owner.createAccessKey();
  write(file, { clients: [{ id: 'C1', region: 'A' }, { id: 'C2', region: 'B' }], lines: [{ client: 'C1', region: 'A', amount: 1 }] }, {
    key: owner,
    access: { grants: [{ key: bob, rows: ['A'] }] },
    tables: [
      { name: 'clients', columns: [{ name: 'id', type: 'string' }, { name: 'region', type: 'string' }], partitionBy: 'region' },
      { name: 'lines', columns: [{ name: 'client', type: 'string' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'float' }], partitionBy: 'region' },
    ],
  });
  const s = storageOf(file, { key: owner });
  assert.deepEqual([s.unusedBytes, s.tables.map((t) => [t.name, t.rows])], [0, [['clients', 2], ['lines', 1]]]);
  append(file, { key: owner, table: 'lines', insert: [{ client: 'C2', region: 'B', amount: 2 }] });
  assert.ok(storageOf(file, { key: owner }).unusedBytes > 0);
  const reader = open(file, { key: bob });
  assert.throws(() => reader.storage(), (e) => e instanceof JazminValidationError && /measured with its owner key/.test(e.message));
  reader.close();
});
