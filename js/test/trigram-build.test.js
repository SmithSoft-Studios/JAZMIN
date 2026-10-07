// The trigram index builder keys ASCII grams as small integers and remembers the grams of values it has seen: the index
// it writes must be byte for byte the one the previous builder wrote.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteWriter } from '../src/binary.js';
import { POSTINGS_ENCODING } from '../src/constants.js';
import { TrigramIndexBuilder, writePostings } from '../src/indexes.js';

/** The builder before (1.1.0): one map, every gram keyed as c0·2³² + c1·2¹⁶ + c2. */
class ReferenceBuilder {
  grams = new Map();

  add(rowId, value) {
    if (value === null || value.length < 3) return;
    const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c);
    let a = lower(value.charCodeAt(0));
    let b = lower(value.charCodeAt(1));
    for (let i = 2; i < value.length; i++) {
      const c = lower(value.charCodeAt(i));
      const key = a * 4294967296 + b * 65536 + c;
      const ids = this.grams.get(key);
      if (!ids) this.grams.set(key, [rowId]);
      else if (ids[ids.length - 1] !== rowId) ids.push(rowId);
      a = b;
      b = c;
    }
  }

  encode() {
    const sorted = [...this.grams.keys()].sort((x, y) => x - y);
    const writer = new ByteWriter();
    writer.byte(POSTINGS_ENCODING);
    writer.varUint(sorted.length);
    for (const key of sorted) {
      writer.u16(Math.floor(key / 4294967296));
      writer.u16(Math.floor(key / 65536) % 65536);
      writer.u16(key % 65536);
      writePostings(writer, this.grams.get(key));
    }
    return writer.toBuffer();
  }
}

function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const ALPHABET = ['a', 'b', 'A', 'B', 'z', ' ', '1', '.', 'é', 'Ü', '日', '本', '\u{1F600}', 'aa', 'ab'];

/** Random text, short and long, ASCII and not; often a value used before. */
function randomValue(rnd, pool) {
  if (rnd() < 0.05) return null;
  if (rnd() < 0.6 && pool.length) return pool[Math.floor(rnd() * pool.length)];
  let text = '';
  for (let k = Math.floor(rnd() * 12); k > 0; k--) text += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  if (rnd() < 0.3) pool.push(text);
  return text;
}

test('the index is the one the previous builder wrote: ASCII and other text, repeated and unique values', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = random(seed);
    const builder = new TrigramIndexBuilder();
    const reference = new ReferenceBuilder();
    const pool = [];
    const rows = seed % 4 === 0 ? 30_000 : 2000; // some runs remember 4,096 values and then no more
    for (let row = 0; row < rows; row++) {
      // Unique values (as e-mail addresses) in some runs, so the builder stops remembering.
      const value = seed % 5 === 0 ? `user${row}@example.com` : randomValue(rnd, pool);
      builder.add(row, value);
      reference.add(row, value);
    }
    assert.deepEqual(builder.encode(), reference.encode(), `seed ${seed}`);
  }
});
