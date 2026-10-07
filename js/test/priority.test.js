// The priority option: memory or speed first. It only sets the default thread count, so every priority must write
// the same rows, and an explicit maxDegreeOfParallelism still wins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminValidationError, JazminWriter, append, open, update } from '../src/index.js';
import { writeThreads } from '../src/writer.js';

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
  const reader = open(file);
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
