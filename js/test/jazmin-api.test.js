import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JAZMIN, JazminKey } from '../src/index.js';

test('JAZMIN.stringify / JAZMIN.parse mirror JSON.stringify / JSON.parse', () => {
  const rows = [{ a: 1, b: 'x' }, { a: 2, b: null }];
  assert.deepEqual(JAZMIN.parse(JAZMIN.stringify(rows)), rows);
  const key = JazminKey.generate();
  assert.deepEqual(JAZMIN.parse(JAZMIN.stringify(rows, { key }), { key }), rows);
});
