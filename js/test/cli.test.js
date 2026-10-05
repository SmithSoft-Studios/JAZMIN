// The jazmin command-line tool (bin/jazmin.mjs, issue #15), run as users run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, JazminKey, open } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '../bin/jazmin.mjs');
const fixtures = path.resolve(here, '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const paged = path.join(fixtures, 'js-paged-key.jzm');

/** Runs the tool: { status, stdout, stderr }. The key is passed in the environment, as documented. */
function jazmin(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, JAZMIN_KEY: '', JAZMIN_PASSWORD: '', ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const withKey = { JAZMIN_KEY: keys.key };

test('every command has help, and mistakes are usage errors', () => {
  const main = jazmin(['--help']);
  assert.equal(main.status, 0);
  for (const command of ['inspect', 'query', 'explain', 'advise', 'convert', 'keygen']) {
    assert.match(main.stdout, new RegExp(`^  ${command}`, 'm'));
    const help = jazmin([command, '--help']);
    assert.deepEqual([help.status, help.stdout.startsWith(`Usage: jazmin ${command}`)], [0, true], command);
  }
  assert.equal(jazmin(['nope']).status, 2);
  assert.equal(jazmin(['query', paged, '--filter', '{bad'], withKey).status, 2);
  assert.equal(jazmin(['query', paged, '--limit', '-1'], withKey).status, 2);
  assert.equal(jazmin(['advise', paged], withKey).status, 2);
});

test('inspect describes a file, and never prints its key', () => {
  const result = jazmin(['inspect', paged], withKey);
  assert.equal(result.status, 0);
  const facts = JSON.parse(result.stdout);
  assert.deepEqual([facts.rows, facts.chunks, facts.encrypted, facts.columns.length], [500, 8, true, 9]);
  assert.ok(!result.stdout.includes(keys.key) && !result.stderr.includes(keys.key));
  const locked = JSON.parse(jazmin(['inspect', paged]).stdout);
  assert.deepEqual([locked.encrypted, locked.rows, /JAZMIN_KEY/.test(locked.note)], [true, undefined, true]);
});

test('query prints the rows the library finds, as JSON lines, JSON or CSV', () => {
  const library = open(paged, { key: keys.key });
  const expected = [...library.find({ country: 'ZA' }, { select: ['id', 'name'] })];
  library.close();
  const lines = jazmin(['query', paged, '--filter', '{"country":"ZA"}', '--select', 'id,name'], withKey).stdout.trim().split('\n');
  assert.deepEqual(lines.map((l) => JSON.parse(l)), expected);
  const json = JSON.parse(jazmin(['query', paged, '--filter', '{"country":"ZA"}', '--select', 'id,name', '--format', 'json', '--offset', '2', '--limit', '3'], withKey).stdout);
  assert.deepEqual(json, expected.slice(2, 5));
  const csv = jazmin(['query', paged, '--select', 'id,name,extra', '--limit', '2', '--format', 'csv'], withKey).stdout.trim().split('\n');
  assert.deepEqual(csv, ['id,name,extra', '0,,', '1,Person 1 Smith,"{""i"":1,""tags"":[""x"",false]}"']);
  const refused = jazmin(['query', paged]);
  assert.deepEqual([refused.status, /encrypted/.test(refused.stderr)], [1, true]);
});

test('explain --analyze and advise report what queries read', () => {
  const plan = JSON.parse(jazmin(['explain', paged, '--filter', '{"id":7}', '--analyze'], withKey).stdout);
  assert.deepEqual([plan.strategy, plan.rows, plan.chunksRead], ['index', 1, 1]);
  const advice = JSON.parse(jazmin(['advise', paged, '--column', 'country', '--column', 'id', '--json'], withKey).stdout);
  assert.deepEqual(advice.columns.map((c) => [c.column, c.indexed]), [['country', true], ['id', true]]);
  assert.ok(advice.suggestions.some((s) => s.includes('sortedBy: ["country"]')), advice.suggestions.join('\n'));
  const text = jazmin(['advise', paged, '--column', 'country'], withKey).stdout;
  assert.match(text, /^500 rows in 8 chunks/);
});

test('convert writes .jzm files from JSON, JSON Lines and CSV, and exports .jzm files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-cli-'));
  fs.writeFileSync(path.join(dir, 'in.json'), JSON.stringify([{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }]));
  fs.writeFileSync(path.join(dir, 'in.jsonl'), '{"id":1,"name":"Ann"}\n{"id":2,"name":"Bob"}\n');
  fs.writeFileSync(path.join(dir, 'in.csv'), 'id,name\n1,Ann\n2,Bob\n');
  for (const input of ['in.json', 'in.jsonl', 'in.csv']) {
    const output = path.join(dir, `${input}.jzm`);
    assert.equal(jazmin(['convert', path.join(dir, input), output, '--sorted-by', 'id'], withKey).status, 0, input);
    const reader = open(output, { key: keys.key });
    assert.deepEqual([...reader.rows()], [{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }], input);
    assert.deepEqual(reader.sortedBy, ['id']);
    reader.close();
  }
  assert.equal(jazmin(['convert', paged, path.join(dir, 'za.csv'), '--filter', '{"country":"ZA"}'], withKey).status, 0);
  const library = open(paged, { key: keys.key });
  assert.equal(fs.readFileSync(path.join(dir, 'za.csv'), 'utf8').trim().split('\n').length - 1, library.count({ country: 'ZA' }));
  library.close();
  assert.equal(jazmin(['convert', path.join(dir, 'in.json'), path.join(dir, 'out.txt')]).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keygen prints a new key, or an access key issued from the owner key', () => {
  const key = jazmin(['keygen']).stdout.trim();
  assert.ok(JazminKey.parse(key));
  const access = jazmin(['keygen', '--access'], withKey);
  const accessKey = JazminAccessKey.parse(access.stdout.trim());
  assert.match(access.stderr, new RegExp(`Key id ${accessKey.id}`));
  assert.equal(jazmin(['keygen', '--access']).status, 2);
});
