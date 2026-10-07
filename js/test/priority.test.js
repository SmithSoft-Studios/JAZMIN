// The priority option: memory or speed first. It only sets the default thread count, so every priority must write
// the same rows, and an explicit maxDegreeOfParallelism still wins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFormatError, JazminKey, JazminValidationError, JazminWriter, append, open, update } from '../src/index.js';
import { readThreads, writeThreads } from '../src/priority.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-priority-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'name', type: 'string' },
  { name: 'amount', type: 'float' },
  { name: 'price', type: 'decimal' },
];
const row = (i) => ({ id: i, name: i % 7 ? `name ${i % 97}` : null, amount: i / 3, price: `${i % 1000}.${String(i % 100).padStart(2, '0')}` });

function write(file, options) {
  const writer = new JazminWriter(file, { columns, chunkRows: 100, ...options });
  for (let i = 0; i < 2500; i++) writer.writeRow(row(i)); // 25 chunks: worker threads start from the third
  writer.finish();
  const reader = open(file, { key: options.key });
  try {
    return [...reader.rows()];
  } finally {
    reader.close();
  }
}

test('each priority sets the default thread count, within the processors there are', () => {
  const cores = os.availableParallelism();
  assert.equal(writeThreads('memory'), 1);
  assert.equal(writeThreads('balanced'), Math.max(1, Math.min(cores - 1, 2))); // the default before the option
  assert.equal(writeThreads('speed'), Math.max(1, Math.min(cores - 1, 2))); // 4 threads were no faster than 2
});

test('every priority writes the same rows, and an explicit thread count still wins', () => {
  const expected = write(path.join(dir, 'balanced.jzm'), {});
  for (const options of [{ priority: 'memory' }, { priority: 'balanced' }, { priority: 'speed' }, { priority: 'memory', maxDegreeOfParallelism: 3 }]) {
    assert.deepEqual(write(path.join(dir, `${options.priority}-${options.maxDegreeOfParallelism ?? 'default'}.jzm`), options), expected, JSON.stringify(options));
  }
});

test('an unknown priority is refused, by writes, updates and appends', () => {
  const file = path.join(dir, 'refused.jzm');
  for (const priority of ['fast', '', 1, null, 'toString']) {
    assert.throws(() => new JazminWriter(file, { columns, priority }), JazminValidationError, String(priority));
  }
  write(file, {});
  assert.throws(() => update(file, { insert: [row(9999)], priority: 'fast' }), JazminValidationError);
  assert.throws(() => append(file, { insert: [row(9999)], priority: 'fast' }), JazminValidationError);
});

test('each priority sets the threads that decode ahead of a scan: speed only', () => {
  assert.equal(readThreads('memory'), 0);
  assert.equal(readThreads('balanced'), 0);
  assert.equal(readThreads('speed'), Math.max(1, Math.min(os.availableParallelism() - 1, 4)));
  assert.throws(() => open(path.join(dir, 'missing.jzm'), { priority: 'fast' }), JazminValidationError);
});

test('reads with speed (chunks decoded ahead on worker threads) return what balanced reads return', () => {
  // 2,500 rows in chunks of 100: workers start from a scan's third chunk.
  const key = JazminKey.generate();
  const plain = path.join(dir, 'read-plain.jzm');
  const locked = path.join(dir, 'read-locked.jzm');
  write(plain, {});
  write(locked, { key });
  const queries = [
    (r) => [...r.rows()],
    (r) => [...r.rows({ select: ['id', 'price'] })],
    (r) => [...r.find({ amount: { gt: 400 } }, { select: ['id'], offset: 30, limit: 500 })],
    (r) => [...r.find({ name: 'name 5' })],
    (r) => [...r.rows({ offset: 1234, limit: 10 })],
    (r) => r.columnArrays(null, { select: ['id', 'amount'] }),
    (r) => r.columnArrays({ id: { gte: 700 } }, { select: ['amount'], limit: 900 }),
    (r) => { // a scan stopped early, then others on the same reader: nothing it read ahead is mixed in
      const first = [];
      for (const row of r.rows()) if (first.push(row) === 250) break;
      return [first, [...r.rows({ select: ['name'] })], [...r.rows()].length];
    },
  ];
  for (const [file, options] of [[plain, {}], [locked, { key }], [fs.readFileSync(plain), {}]]) {
    const balanced = open(file, options);
    const speed = open(file, { ...options, priority: 'speed' });
    try {
      for (const query of queries) assert.deepEqual(query(speed), query(balanced), query.toString());
    } finally {
      balanced.close();
      speed.close();
    }
  }
});

test('a damaged chunk fails as it does without reading ahead', () => {
  const file = path.join(dir, 'damaged.jzm');
  write(file, { codec: 'none' });
  const bytes = fs.readFileSync(file);
  // A byte in the middle of the data: chunk sections come first, so this damages a chunk's payload, which its CRC-32
  // catches on the worker; the reader then decodes that chunk itself and reports it.
  bytes[Math.floor(bytes.length / 3)] ^= 0xff;
  const failure = (priority) => {
    const r = open(bytes, { priority });
    try {
      for (const _ of r.rows()); // eslint-disable-line no-unused-vars
      return null;
    } catch (error) {
      return error;
    } finally {
      r.close();
    }
  };
  const balanced = failure('balanced');
  assert.ok(balanced instanceof JazminFormatError, String(balanced));
  const speed = failure('speed');
  assert.ok(speed instanceof JazminFormatError);
  assert.equal(speed.message, balanced.message);
});

test('updates and appends take a priority', () => {
  const file = path.join(dir, 'changed.jzm');
  write(file, {});
  update(file, { insert: [row(5000)], priority: 'memory' });
  append(file, { insert: [row(5001)], priority: 'speed' });
  const reader = open(file);
  try {
    assert.equal(reader.rowCount, 2502);
  } finally {
    reader.close();
  }
});
