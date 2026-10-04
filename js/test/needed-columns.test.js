import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { open } from '../src/index.js';

// Index lookups and access-controlled reads decode only the columns a query uses (issue #11). The rows must be the
// same as with every column decoded. Mirrored in dotnet/tests/Jazmin.Tests/NeededColumnsTests.cs.

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const FILTERS = [null, { id: { lt: 40 } }, { country: 'NA' }, { score: { gt: 50 } }, { name: { contains: 'son' } }, { not: { country: 'ZA' } }];
const SELECTS = [['id'], ['balance'], ['blob', 'name'], ['extra', 'joined', 'active']];

for (const file of ['js-paged-key.jzm', 'js-access.jzm']) {
  test(`${file}: a query returns the selected columns of the full rows`, () => {
    const reader = open(path.join(fixtures, file), { key: keys.key });
    try {
      for (const filter of FILTERS) {
        const full = [...reader.find(filter)];
        for (const select of SELECTS) {
          const expected = full.map((row) => Object.fromEntries(select.map((c) => [c, row[c]])));
          assert.deepEqual([...reader.find(filter, { select })], expected, `${JSON.stringify(filter)} ${select}`);
          assert.deepEqual([...reader.find(filter, { select, offset: 3, limit: 4 })], expected.slice(3, 7));
        }
      }
    } finally {
      reader.close();
    }
  });

  test(`${file}: a chunk decoded for a narrow query is not reused where every column is needed`, () => {
    const reader = open(path.join(fixtures, file), { key: keys.key });
    try {
      const [whole] = [...reader.find({ id: 3 })];
      assert.deepEqual([...reader.find({ id: 3 }, { select: ['id'] })], [{ id: 3 }]);
      assert.deepEqual(reader.get(3), whole);
      assert.deepEqual([...reader.find({ id: 3 })], [whole]);
    } finally {
      reader.close();
    }
  });
}
