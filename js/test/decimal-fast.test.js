// Decimals of up to 15 digits are written without BigInt arithmetic (canonical text, encoding, chunk statistics): the
// results must be exactly those of the exact BigInt path, which longer decimals still take.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteWriter } from '../src/binary.js';
import { canonicalDecimal, decimalKey, formatDecimal, parseDecimal, writeDecimal } from '../src/decimal.js';
import { ColumnStats } from '../src/stats.js';

function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Random decimal text: short and long, with leading zeros, signs, zeros and some invalid forms. */
function randomDecimal(rnd) {
  const digits = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');
  const pick = rnd();
  if (pick < 0.03) return ['', '-', '1.', '.5', 'abc', '1e5', '--1', '1.2.3', ' 1'][Math.floor(rnd() * 9)];
  if (pick < 0.06) return ['0', '-0', '-0.00', '000', '0.000', '-000.10', '0.05'][Math.floor(rnd() * 7)];
  const whole = (rnd() < 0.2 ? '00' : '') + digits(Math.floor(rnd() * (rnd() < 0.8 ? 8 : 25)));
  const fraction = rnd() < 0.7 ? digits(Math.floor(rnd() * (rnd() < 0.8 ? 6 : 20))) : '';
  const text = `${rnd() < 0.3 ? '-' : ''}${whole || '0'}${fraction ? `.${fraction}` : ''}`;
  return rnd() < 0.05 ? Number(text) : text; // numbers too, as the writer accepts them
}

const outcome = (fn) => {
  try {
    return fn();
  } catch (error) {
    return `error: ${error.message}`;
  }
};

test('canonical text without BigInt equals formatDecimal(parseDecimal())', () => {
  const rnd = random(1);
  for (let n = 0; n < 50_000; n++) {
    const value = randomDecimal(rnd);
    const expected = outcome(() => {
      const { m, s } = parseDecimal(value, 'c');
      return formatDecimal(m, s);
    });
    assert.equal(outcome(() => canonicalDecimal(value, 'c')), expected, JSON.stringify(value));
  }
  // The limits: 255 digits after the point, 256 significant digits (leading zeros not counted).
  assert.equal(canonicalDecimal(`0.${'1'.repeat(255)}`).length, 257);
  assert.throws(() => canonicalDecimal(`0.${'1'.repeat(256)}`), /more than 255 digits after the point/);
  assert.equal(canonicalDecimal(`${'0'.repeat(300)}${'9'.repeat(256)}`), '9'.repeat(256));
  assert.throws(() => canonicalDecimal('9'.repeat(257)), /more than 256 significant digits/);
});

test('encoding a decimal without BigInt writes the same bytes', () => {
  const rnd = random(2);
  for (let n = 0; n < 50_000; n++) {
    const value = randomDecimal(rnd);
    let text;
    try {
      text = canonicalDecimal(value);
    } catch {
      continue;
    }
    const fast = new ByteWriter();
    writeDecimal(fast, text);
    const exact = new ByteWriter();
    const { m, s } = parseDecimal(text);
    exact.varUint(s);
    exact.varUint(m >= 0n ? m << 1n : ((-m) << 1n) - 1n);
    assert.deepEqual(fast.toBuffer(), exact.toBuffer(), text);
  }
});

test('chunk statistics of decimals are those of the exact comparison, also when a long decimal comes later', () => {
  const rnd = random(3);
  for (let n = 0; n < 4000; n++) {
    const values = [];
    for (let k = 1 + Math.floor(rnd() * 40); k > 0; k--) {
      try {
        values.push(rnd() < 0.1 ? null : canonicalDecimal(randomDecimal(rnd)));
      } catch {
        // invalid text never reaches the statistics
      }
    }
    const fast = new ColumnStats('decimal');
    const exact = new ColumnStats('decimal');
    for (const v of values) {
      fast.add(v);
      exact.add(v === null ? null : decimalKey(v)); // keys take the exact path
    }
    assert.deepEqual(fast.bounds(), exact.bounds(), JSON.stringify(values));
    assert.equal(fast.nulls, exact.nulls);
  }
});
