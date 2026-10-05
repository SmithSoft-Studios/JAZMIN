import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteReader, ByteWriter } from '../src/binary.js';
import { decimalKey, readDecimal } from '../src/decimal.js';
import { encodeBound } from '../src/stats.js';
import { JazminKey, open, write } from '../src/index.js';
import '../browser/jazmin-browser.js';

// Decimals may have up to 256 digits (spec 5.1). Their integer needs up to 122 varint bytes; the writer once made room
// for 10, so larger ones lost bytes: statistics bounds (from about 33 digits) could not be read, and with very long
// values the rows themselves could not be read back.

const { JazminBrowser } = globalThis;
const decimals = (digits, count) => Array.from({ length: count }, (_, i) => `${'9'.repeat(digits - 7)}${String(i).padStart(6, '0')}.5`); // `digits` significant digits

test('a varint of any size is written whole', () => {
  for (const bits of [7, 63, 64, 70, 200, 851]) {
    const value = (1n << BigInt(bits)) - 1n;
    const w = new ByteWriter(4); // smaller than the value: it must grow
    w.varUint(value);
    w.varUint(5n);
    const r = new ByteReader(w.toBuffer());
    let read = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const b = r.byte();
      read |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    assert.equal(read, value, `${bits} bits`);
    assert.equal(r.byte(), 5);
  }
});

test('statistics bounds of long decimals read back', () => {
  for (const digits of [20, 34, 40, 100, 256]) {
    const text = `${'7'.repeat(digits - 1)}.5`;
    assert.equal(readDecimal(new ByteReader(encodeBound('decimal', decimalKey(text)))), text, `${digits} digits`);
  }
});

test('files with decimals up to 256 digits read back, filter and index exactly, also encrypted and in the browser', async () => {
  for (const digits of [22, 40, 80, 256]) {
    const values = decimals(digits, 1500);
    const rows = [{ d: '1.5' }, { d: '2.5' }, ...values.map((d) => ({ d }))];
    for (const key of [undefined, JazminKey.generate()]) {
      const bytes = write(null, rows, { columns: [{ name: 'd', type: 'decimal', index: 'sorted' }], chunkRows: 2, key });
      const reader = open(bytes, { key });
      assert.deepEqual([...reader.rows()].map((r) => r.d), rows.map((r) => r.d), `${digits} digits`);
      assert.deepEqual([...reader.find({ d: { lt: '1000' } })].map((r) => r.d), ['1.5', '2.5'], `${digits} digits: lt`);
      assert.equal(reader.count({ d: { gt: '1000' } }), values.length, `${digits} digits: gt`);
      assert.deepEqual([...reader.find({ d: values[777] })].map((r) => r.d), [values[777]], `${digits} digits: eq`);
      assert.equal(reader.explain({ d: { lt: '1000' } }, { analyze: true }).chunksRead, 1, `${digits} digits: the bounds skip the long values' chunks`);
      reader.close();
      const browser = await JazminBrowser.open(new Blob([bytes]), { key: key?.toString() });
      const found = [];
      for await (const r of browser.find({ d: { lt: '1000' } })) found.push(r.d);
      assert.deepEqual(found, ['1.5', '2.5'], `${digits} digits: browser`);
    }
  }
});
