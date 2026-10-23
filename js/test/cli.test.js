// The jazmin command-line tool (bin/jazmin.mjs, issue #15), run as users run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, JazminKey, open, portableScript, toJSON, toXML, write } from '../src/index.js';
import { verifyFiles } from '../bin/verify.mjs';

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
  for (const command of ['inspect', 'query', 'explain', 'advise', 'convert', 'keygen', 'script', 'verify', 'check']) {
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

test('inspect lists the saved shapes, and query exports with one by name, or with a shape in a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-cli-shapes-'));
  const file = path.join(dir, 'shapes.jzm');
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: i, kind: i % 2 ? 'odd' : 'even' }));
  const totals = { $groupBy: 'kind', $sort: ['kind'], $rows: { kind: 'kind', count: { $count: true } } };
  write(file, rows, { shapes: [{ name: 'By kind', shape: totals, default: true, description: 'Counts' }] });
  assert.deepEqual(JSON.parse(jazmin(['inspect', file]).stdout).shapes, [{ name: 'By kind', description: 'Counts', default: true }]);
  const reader = open(file);
  const ended = (text) => (text.endsWith('\n') ? text : `${text}\n`); // the library's text, ending with a new line
  const shaped = jazmin(['query', file, '--shape', 'By kind', '--filter', '{"id":{"gt":1}}']);
  assert.equal(shaped.stdout, ended(toJSON(reader, { shape: totals, pretty: true, filter: { id: { gt: 1 } } })));
  assert.equal(jazmin(['query', file, '--shape', 'By kind', '--format', 'xml']).stdout, ended(toXML(reader, { shape: totals })));
  reader.close();
  fs.writeFileSync(path.join(dir, 'ids.json'), JSON.stringify({ $rows: 'id', $limit: 2 }));
  assert.deepEqual(JSON.parse(jazmin(['query', file, '--shape-file', path.join(dir, 'ids.json')]).stdout), [0, 1]);
  const missing = jazmin(['query', file, '--shape', 'Nope']);
  assert.deepEqual([missing.status, missing.stderr.trim()], [1, "No saved shape 'Nope' is visible with this key"]);
  for (const extra of [['--limit', '2'], ['--format', 'csv'], ['--shape-file', 'x.json']]) assert.equal(jazmin(['query', file, '--shape', 'By kind', ...extra]).status, 2, extra.join(' '));
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

test('script writes a .jzm as a script for pages opened from disk, beside it or where asked; no key is needed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-cli-script-'));
  try {
    const file = path.join(dir, 'report.jzm');
    fs.copyFileSync(paged, file);
    assert.equal(jazmin(['script', file]).status, 0);
    assert.equal(fs.readFileSync(`${file}.js`, 'utf8'), portableScript(file));
    const other = path.join(dir, 'pages', 'data.js');
    fs.mkdirSync(path.dirname(other));
    assert.equal(jazmin(['script', file, other, '--name', 'statement.jzm']).status, 0);
    assert.equal(fs.readFileSync(other, 'utf8'), portableScript(file, { name: 'statement.jzm' }));
    fs.writeFileSync(path.join(dir, 'notes.jzm'), 'not a JAZMIN file, only some text that is long enough to be checked');
    const refused = jazmin(['script', path.join(dir, 'notes.jzm')]);
    assert.deepEqual([refused.status, /not a JAZMIN file/.test(refused.stderr)], [1, true]);
    assert.equal(jazmin(['script']).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// jazmin verify (issue #260): a file's publisher signature (spec 6.9). The command trusts only the built-in roots, and
// takes no option that adds one (6.9.4), so the test root is given to the command's implementation, verifyFiles.
const publisherDir = path.join(fixtures, 'publisher');
const publisher = JSON.parse(fs.readFileSync(path.join(publisherDir, 'expected.json'), 'utf8'));
const testTrust = { roots: publisher.trustedRoots.map((p) => fs.readFileSync(path.join(publisherDir, p))), arc: '2.999.1', at: new Date(publisher.verifyAt) };
const revocationText = fs.readFileSync(path.join(publisherDir, publisher.revocationList), 'utf8');
const SHOWN = new Set(['certified', 'withdrawn', 'superseded']);
const option = { password: 'password', key: 'key', ownerKey: 'key', accessKey: 'key' };

/** verifyFiles with the test root: { code, stdout, stderr }. */
function verifyTest(files, options = {}) {
  let stdout = '';
  let stderr = '';
  const code = verifyFiles(files.map((f) => path.join(publisherDir, f)), { revocationList: revocationText, ...options }, {
    trust: testTrust, out: (text) => { stdout += `${text}\n`; }, err: (text) => { stderr += `${text}\n`; },
  });
  return { code, stdout, stderr };
}

for (const fixture of publisher.fixtures) {
  test(`verify ${fixture.file}: ${fixture.result.status}, as the library says, with its exit code`, () => {
    const want = fixture.result;
    const json = verifyTest([fixture.file], { json: true });
    assert.equal(json.code, want.status === 'certified' ? 0 : 1);
    const result = JSON.parse(json.stdout);
    assert.deepEqual([result.status, result.reason], [want.status, want.reason]);
    const text = verifyTest([fixture.file]);
    assert.equal(text.code, json.code);
    if (SHOWN.has(want.status)) {
      for (const value of [want.name, want.registration, want.country, want.domain, want.code, want.documentKind, want.timestamp].filter(Boolean)) assert.ok(text.stdout.includes(value), value);
      for (const cosigner of want.cosigners) assert.ok(text.stdout.includes(cosigner.name), cosigner.name);
      if (want.facts && !want.factsNeedKey) for (const value of Object.values(want.facts)) assert.ok(text.stdout.includes(value), value);
    } else {
      assert.ok(!/Sable|Khumalo|Mokoena/.test(text.stdout), text.stdout); // no name (6.9.8)
    }
    for (const [kind, secret] of Object.entries(fixture.keys)) {
      const keyed = verifyTest([fixture.file], { [option[kind]]: secret });
      assert.equal(keyed.code, json.code, kind);
      if (want.facts) for (const value of Object.values(want.facts)) assert.ok(keyed.stdout.includes(value), `${kind}: ${value}`);
    }
  });
}

test('check: every section of a file, with exit code 0 when unchanged and 1 when a byte changed', () => {
  const ok = jazmin(['check', paged], withKey);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Unchanged: every section checked \(\d+ sections, [\d,]+ bytes\) by its encryption/);
  assert.doesNotMatch(ok.stdout + ok.stderr, new RegExp(keys.key));
  const json = JSON.parse(jazmin(['check', paged, '--json'], withKey).stdout);
  assert.deepEqual([json.checkedBy, json.unusedBytes], ['encryption', 0]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-cli-check-'));
  const bad = path.join(dir, 'bad.jzm');
  const bytes = fs.readFileSync(paged);
  bytes[200] ^= 1;
  fs.writeFileSync(bad, bytes);
  const changed = jazmin(['check', bad], withKey);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /^Changed or damaged: /);

  const plain = jazmin(['check', path.join(fixtures, 'js-plain.jzm')]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /accidental damage only/);
  assert.equal(jazmin(['check', paged]).status, 2); // encrypted, and no key
});

test('check: a signed file\'s publisher signature is whole, and is not called unused; bytes added beside it are a change', () => {
  const signed = jazmin(['check', path.join(fixtures, 'publisher', 'signed-plain.jzm')]);
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /publisher signature \([\d,]+ bytes\) is whole; jazmin verify checks who signed it/);
  assert.doesNotMatch(signed.stdout, /compact|earlier versions/);
  const json = JSON.parse(jazmin(['check', path.join(fixtures, 'publisher', 'signed-plain.jzm'), '--json']).stdout);
  assert.deepEqual([json.unusedBytes, json.publisherBytes > 0], [0, true]);
  const gap = jazmin(['check', path.join(fixtures, 'publisher', 'changed-extra-byte.jzm')]);
  assert.equal(gap.status, 1);
  assert.match(gap.stderr, /^Changed or damaged: /);
});

test('verify: several files print one line each and a summary; the exit code is the worst', () => {
  const all = verifyTest(['signed-plain.jzm', 'withdrawn.jzm', 'unsigned.jzm']);
  assert.equal(all.code, 1);
  const lines = all.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /signed-plain\.jzm: Certified/);
  assert.match(lines[1], /withdrawn\.jzm: Withdrawn/);
  assert.match(lines[2], /unsigned\.jzm: Not signed/);
  assert.equal(lines[3], '3 files: 1 certified, 1 withdrawn, 1 none');
  assert.equal(verifyTest(['signed-plain.jzm', 'signed-sole-trader.jzm']).code, 0);
  const json = JSON.parse(verifyTest(['signed-plain.jzm', 'changed-byte.jzm'], { json: true }).stdout);
  assert.deepEqual(json.map((r) => [r.file, r.status]), [['signed-plain.jzm', 'certified'], ['changed-byte.jzm', 'changed']]);
});

test('verify: an encrypted file without a key, or with a password that does not open it, leaves its facts unread', () => {
  const none = verifyTest(['signed-password.jzm']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /Facts: +encrypted: give a key or password to read them/);
  const wrong = verifyTest(['signed-password.jzm'], { password: 'not the password' });
  assert.equal(wrong.code, 0);
  assert.match(wrong.stdout, /Facts: +encrypted: the key or password given doesn't open them/);
  assert.ok(!wrong.stdout.includes(publisher.fixtures[1].result.facts.net));
});

test('verify: the command trusts only the built-in roots, so a certified test file shows as signed, with no name', () => {
  const file = path.join(publisherDir, 'signed-plain.jzm');
  const signed = jazmin(['verify', file, '--revocation-list', path.join(publisherDir, publisher.revocationList)]);
  assert.equal(signed.status, 1);
  assert.match(signed.stdout, /Signed by an unknown key/);
  assert.ok(!/Sable|JZ-/.test(signed.stdout), signed.stdout);
  assert.deepEqual(JSON.parse(jazmin(['verify', file, '--json']).stdout).status, 'signed');
  const unsigned = jazmin(['verify', path.join(publisherDir, 'unsigned.jzm')]);
  assert.deepEqual([unsigned.status, /Not signed/.test(unsigned.stdout)], [1, true]);
  const both = jazmin(['verify', file, path.join(publisherDir, 'unsigned.jzm')]);
  assert.equal(both.stdout.trim().split('\n').at(-1), '2 files: 1 signed, 1 none');
  // Keys from the options or the environment; a wrong password changes nothing that is shown.
  const password = path.join(publisherDir, 'signed-password.jzm');
  assert.equal(jazmin(['verify', password, '--password', publisher.secrets.password]).status, 1);
  assert.equal(jazmin(['verify', password], { JAZMIN_PASSWORD: 'not the password' }).status, 1);
  assert.equal(jazmin(['verify', path.join(publisherDir, 'signed-cosigned.jzm')], { JAZMIN_KEY: publisher.secrets.key }).status, 1);
});

test('verify: help has the exit codes; no option adds a root; mistakes and unreadable files are reported', () => {
  const help = jazmin(['verify', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: jazmin verify/);
  assert.match(help.stdout, /JAZMIN_KEY/);
  assert.match(help.stdout, /0 +certified/);
  assert.match(help.stdout, /2 +the command line is wrong/);
  assert.match(jazmin(['--help']).stdout, /^ {2}verify/m);
  const file = path.join(publisherDir, 'signed-plain.jzm');
  for (const extra of [['--root', 'pki/test-root.der'], ['--trust', 'x'], ['--trusted-root', 'x']]) assert.equal(jazmin(['verify', file, ...extra]).status, 2, extra[0]);
  assert.equal(jazmin(['verify']).status, 2);
  const missing = jazmin(['verify', path.join(publisherDir, 'nope.jzm')]);
  assert.deepEqual([missing.status, /No such file/.test(missing.stderr)], [1, true]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-cli-verify-'));
  try {
    fs.writeFileSync(path.join(dir, 'notes.jzm'), 'not a JAZMIN file, only some text that is long enough to be checked');
    fs.writeFileSync(path.join(dir, 'short.jzm'), 'short');
    for (const name of ['notes.jzm', 'short.jzm']) {
      const other = jazmin(['verify', path.join(dir, name)]);
      assert.deepEqual([other.status, /Not verified: not a valid JAZMIN file/.test(other.stdout)], [1, true], name);
    }
    const mixed = jazmin(['verify', file, path.join(dir, 'nope.jzm')]);
    assert.equal(mixed.status, 1);
    assert.equal(mixed.stdout.trim().split('\n').at(-1), '2 files: 1 signed, 1 not read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const mistyped = jazmin(['verify', file, '--key', 'jzk1-mistyped']);
  assert.equal(mistyped.status, 1);
  assert.ok(!mistyped.stderr.includes('jzk1-mistyped'));
});
