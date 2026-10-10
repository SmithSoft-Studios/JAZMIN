// Shape output, byte for byte: every value type, escapes, literals, metadata, aggregates, groups, sorts, limits and
// empty results, as JSON, pretty JSON and XML. The expected output (shape-golden.json) was recorded with JAZMIN 1.2.0
// before the shape writer was compiled; any change to it is a change to the export format. To record it again on
// purpose: JAZMIN_WRITE_GOLDEN=1 node --test test/shape-output.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { open, toJSON, toXML, write } from '../src/index.js';
import { cases, columns, jsonOnlyRows, metadata, rows } from './shape-golden-cases.js';

const goldenPath = fileURLToPath(new URL('./shape-golden.json', import.meta.url));

function outputs(source) {
  const reader = open(write(null, source, { columns, metadata }));
  const result = {};
  for (const [name, shape] of Object.entries(cases)) {
    result[`${name} | json`] = toJSON(reader, { shape });
    result[`${name} | pretty`] = toJSON(reader, { shape, pretty: true });
    result[`${name} | filtered json`] = toJSON(reader, { shape, filter: { country: { in: ['ZA', 'BW'] } } });
  }
  return result;
}

function xmlOutputs() {
  const reader = open(write(null, rows, { columns, metadata }));
  const result = {};
  for (const [name, shape] of Object.entries(cases)) {
    result[`${name} | xml`] = toXML(reader, { shape });
    result[`${name} | xml root`] = toXML(reader, { shape, root: 'golden', filter: { country: 'NA' } });
  }
  return result;
}

const actual = { ...outputs(jsonOnlyRows), ...xmlOutputs() };
if (process.env.JAZMIN_WRITE_GOLDEN) fs.writeFileSync(goldenPath, `${JSON.stringify(actual, null, 1)}\n`);
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

for (const key of Object.keys(golden)) {
  test(`shape output is unchanged: ${key}`, () => {
    assert.equal(actual[key], golden[key]);
  });
}

test('the golden cases are all still run', () => {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(golden).sort());
});
