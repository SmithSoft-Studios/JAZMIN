import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteWriter } from '../src/binary.js';
import { TrigramIndexBuilder, trigrams, writePostings } from '../src/indexes.js';

/** The straightforward definition (spec 8.2): an encoding byte (0), then distinct ASCII-lower-cased grams in code-unit order. */
function reference(values) {
  const grams = new Map();
  values.forEach((text, id) => {
    if (text === null) return;
    for (const gram of trigrams(text)) {
      if (!grams.has(gram)) grams.set(gram, []);
      grams.get(gram).push(id);
    }
  });
  const writer = new ByteWriter();
  writer.byte(0);
  const sorted = [...grams.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  writer.varUint(sorted.length);
  for (const gram of sorted) {
    for (let i = 0; i < 3; i++) writer.u16(gram.charCodeAt(i));
    writePostings(writer, grams.get(gram));
  }
  return writer.toBuffer();
}

test('trigram builder writes the same bytes as the definition', () => {
  const alphabet = ['a', 'B', 'z', 'Z', ' ', 'é', 'É', 'ß', '😀', '­', 'Ω', 'x', '1'];
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let round = 0; round < 50; round++) {
    const values = Array.from({ length: 400 }, () => (rnd() < 0.05
      ? null
      : Array.from({ length: Math.floor(rnd() * 12) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')));
    const builder = new TrigramIndexBuilder();
    values.forEach((v, id) => builder.add(id, v));
    assert.ok(builder.encode().equals(reference(values)), `round ${round}`);
  }
});
