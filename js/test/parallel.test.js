import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, JazminWriter, append, compact, open, write } from '../src/index.js';
import { ENVELOPE_SIZE, PREAMBLE_SIZE } from '../src/constants.js';

// Chunks are compressed on worker threads from the third chunk on; these files have 20+ chunks.
const columns = [
  { name: 'id', type: 'int', nullable: false },
  { name: 'name', type: 'string' },
  { name: 'amount', type: 'float' },
  { name: 'when', type: 'datetime' },
  { name: 'note', type: 'string' },
];
const rows = Array.from({ length: 2000 }, (_, i) => ({
  id: i,
  name: `Customer ${i % 37}`,
  amount: i % 11 === 0 ? null : i * 1.25,
  when: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000),
  note: i % 3 === 0 ? `free text ${i} ${'x'.repeat(i % 50)}` : null,
}));
/** The bytes of the first `count` sections after the preamble (the chunks). */
const chunkSections = (buf, count) => {
  let at = PREAMBLE_SIZE;
  for (let i = 0; i < count; i++) at += ENVELOPE_SIZE + buf.readUInt32LE(at + 8);
  return buf.subarray(PREAMBLE_SIZE, at);
};
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-par-')), name);

test('parallel and single-thread writes give the same file', () => {
  const [one, many] = [tmp('one.jzm'), tmp('many.jzm')];
  write(one, rows, { columns, chunkRows: 64, maxDegreeOfParallelism: 1, sortedBy: ['id'] });
  write(many, rows, { columns, chunkRows: 64, maxDegreeOfParallelism: 3, sortedBy: ['id'] });
  const [ra, rb] = [open(one), open(many)];
  assert.ok(rb.chunkCount > 20);
  // Chunk sections are byte-for-byte the same. (The header holds the random file id, so its compressed
  // length may differ by a byte between any two files.)
  assert.ok(chunkSections(fs.readFileSync(many), rb.chunkCount).equals(chunkSections(fs.readFileSync(one), ra.chunkCount)));
  assert.deepEqual([...rb.rows()], [...ra.rows()]);
  assert.deepEqual([...rb.find({ id: { gte: 500, lte: 520 } })], [...ra.find({ id: { gte: 500, lte: 520 } })]);
});

test('parallel writes: encrypted, in memory, with files added between chunks', () => {
  const key = JazminKey.generate();
  const writer = new JazminWriter(null, { columns, key, chunkRows: 50, maxDegreeOfParallelism: 2 });
  rows.slice(0, 1000).forEach((r) => writer.writeRow(r));
  writer.addFile('report.html', '<h1>Statement</h1>'); // sections stay in order while chunks are in flight
  rows.slice(1000).forEach((r) => writer.writeRow(r));
  const buffer = writer.finish();
  const r = open(buffer, { key });
  assert.deepEqual([...r.rows()], [...open(write(null, rows, { columns, maxDegreeOfParallelism: 1 })).rows()]);
  assert.equal(r.readFile('report.html').toString(), '<h1>Statement</h1>');
});

test('append and compact use the pool too', () => {
  const file = tmp('grow.jzm');
  write(file, rows.slice(0, 500), { columns, chunkRows: 40, sortedBy: ['id'] });
  append(file, { insert: rows.slice(500), chunkRows: 40, maxDegreeOfParallelism: 2 });
  compact(file, { chunkRows: 40, maxDegreeOfParallelism: 2 });
  assert.deepEqual([...open(file).rows()], rows.map((r) => ({ ...r })));
});

test('an aborted parallel write removes the file; bad settings are rejected', () => {
  const file = tmp('aborted.jzm');
  const writer = new JazminWriter(file, { columns, chunkRows: 20, maxDegreeOfParallelism: 2 });
  rows.slice(0, 400).forEach((r) => writer.writeRow(r));
  writer.abort();
  assert.equal(fs.existsSync(file), false);
  for (const bad of [0, -1, 1.5, '2']) {
    assert.throws(() => new JazminWriter(null, { columns, maxDegreeOfParallelism: bad }), JazminValidationError);
  }
});

test('parallel writes work in code given on the command line (node -e, node -p)', () => {
  // Workers inherit the process's Node options; given -e or -p, they ran that code instead of their own file, which
  // wrote again and started more workers until the pool gave up (two minutes later).
  const index = new URL('../src/index.js', import.meta.url).href;
  const code = `const { write, open } = await import(${JSON.stringify(index)});`
    + "const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i, s: 'x' + i }));"
    + "const bytes = write(null, rows, { columns: [{ name: 'id', type: 'int' }, { name: 's', type: 'string' }], chunkRows: 1000, maxDegreeOfParallelism: 2 });"
    + "console.log('rows', open(bytes).rowCount);";
  for (const args of [['--input-type=module', '-e', code], ['--input-type', 'module', '--eval', code], ['-p', `(async () => { ${code} })().then(() => '')`]]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr || result.error}`);
    assert.match(result.stdout, /rows 20000/, args[0]);
  }
});
