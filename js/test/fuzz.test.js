// Damaged files fail with a JazminError (TASKS S-5). A short fuzz run with fixed seeds; scripts/fuzz.js runs for
// longer. spec/fixtures/damaged holds inputs that once failed with another error (shared with the .NET tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSection } from '../src/section.js';
import { corpus, exercise, exerciseDecoders, mutate, random, sections } from './fuzz-helpers.js';

const damaged = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'fixtures', 'damaged');
const files = corpus();

test('files damaged in ways that once crashed the reader fail with a JazminError', () => {
  const names = fs.readdirSync(damaged).filter((f) => f.endsWith('.jzm'));
  assert.ok(names.length >= 15);
  for (const name of names) {
    const error = exercise(fs.readFileSync(path.join(damaged, name)));
    assert.equal(error, null, `${name}: ${error?.stack}`);
  }
});

test('randomly damaged files fail with a JazminError', { timeout: 120_000 }, () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rnd = random(seed);
    const error = exercise(mutate(rnd.pick(files), rnd));
    assert.equal(error, null, `seed ${seed}: ${error?.stack}`);
  }
});

test('section decoders reject damaged payloads with a JazminError', { timeout: 120_000 }, () => {
  const payloads = [];
  for (const file of files) {
    for (const s of sections(file)) {
      try {
        payloads.push(decodeSection(file.subarray(s.at, s.at + 16 + s.length), { sectionId: 'x' }));
      } catch {
        // compressed payloads need their real section id
      }
    }
  }
  for (let seed = 1; seed <= 400; seed++) {
    const rnd = random(seed);
    const raw = Buffer.from(rnd.pick(payloads));
    for (let k = 1 + rnd.int(3); k > 0 && raw.length; k--) raw[rnd.int(raw.length)] = rnd.int(256);
    const error = exerciseDecoders(rnd() < 0.1 ? raw.subarray(0, rnd.int(raw.length + 1)) : raw, rnd);
    assert.equal(error, null, `seed ${seed}: ${error?.stack}`);
  }
});
