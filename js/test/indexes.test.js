import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteWriter } from '../src/binary.js';
import { TrigramIndex, TrigramIndexBuilder, trigrams, writePostings } from '../src/indexes.js';
import { JazminFormatError } from '../src/errors.js';

/**
 * The straightforward definition (spec 8.2): an encoding byte (0), then distinct ASCII-lower-cased grams in code-unit
 * order (or, with `reversed`, the opposite order: an index that breaks the rule).
 */
function reference(values, reversed = false) {
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
  if (reversed) sorted.reverse();
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

test('trigram index lookups return the rows with every gram of the text, read rarest gram first', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const word = (length) => Array.from({ length }, () => 'abcde fgAB'[Math.floor(rnd() * 10)]).join('');
  const values = Array.from({ length: 3000 }, (_, i) => (i % 97 === 0 ? null : word(4 + Math.floor(rnd() * 20))));
  const has = (value, text) => value !== null && [...trigrams(text)].every((gram) => trigrams(value).has(gram));
  for (const reversed of [false, true]) {
    const index = TrigramIndex.decode(reference(values, reversed));
    for (let k = 0; k < 200; k++) {
      const text = k % 2 ? word(3 + Math.floor(rnd() * 5)) : (values[k * 7] ?? 'abcd').slice(1, 8); // 3 characters or more
      const lookup = { op: 'contains', text };
      const want = values.flatMap((v, id) => (has(v, text) ? [id] : []));
      assert.deepEqual(index.rows(lookup), want, `${reversed} ${text}`);
      // The rarest gram's rows: at least the matches, as many as its postings hold, from its first to its last.
      const rarest = [...trigrams(text)].map((gram) => values.flatMap((v, id) => (v !== null && trigrams(v).has(gram) ? [id] : [])))
        .sort((a, b) => a.length - b.length)[0];
      assert.equal(index.bound(lookup), rarest.length, text);
      assert.equal(index.span(lookup), rarest.length ? rarest.at(-1) - rarest[0] + 1 : 0, text);
    }
  }
});

test('a damaged row id in a trigram index is a JazminFormatError when a lookup reads it', () => {
  // One gram, 'abc', in one row whose id is far beyond 2^53: the index loads (its shape is sound), the lookup fails.
  const index = TrigramIndex.decode(Buffer.from([0, 1, 0x61, 0, 0x62, 0, 0x63, 0, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]));
  const lookup = { op: 'contains', text: 'ABC' };
  assert.equal(index.bound(lookup), 1);
  assert.throws(() => index.rows(lookup), JazminFormatError);
  assert.throws(() => index.span(lookup), JazminFormatError);
  assert.throws(() => TrigramIndex.decode(Buffer.from([0, 1, 0x61, 0, 0x62, 0, 0x63, 0, 2, 1])), JazminFormatError); // truncated
});
