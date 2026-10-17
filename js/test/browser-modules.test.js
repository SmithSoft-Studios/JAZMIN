import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The browser scripts built from js/browser/src (TASKS P-26): the full jazmin-browser.js, and the core with its
// add-ons. Each load runs in a process of its own, so each starts without a JazminBrowser.

const js = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = (name) => path.join(js, 'browser', name).replace(/\\/g, '/');
const fixture = path.resolve(js, '../spec/fixtures/js-shapes-key.jzm').replace(/\\/g, '/');
const keys = path.resolve(js, '../spec/fixtures/keys.json').replace(/\\/g, '/');

/** Runs `body` in a new Node process after loading `scripts` in order; returns what it prints (JSON). */
function run(scripts, body) {
  const code = `
    import fs from 'node:fs';
    ${scripts.map((s) => `await import(${JSON.stringify(`file:///${browser(s)}`)});`).join('\n')}
    const J = globalThis.JazminBrowser;
    const bytes = new Uint8Array(fs.readFileSync(${JSON.stringify(fixture)}));
    const key = JSON.parse(fs.readFileSync(${JSON.stringify(keys)}, 'utf8')).key;
    const out = {};
    ${body}
    console.log(JSON.stringify(out));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

test('the scripts are what js/browser/src gives (node scripts/build-browser.mjs)', () => {
  execFileSync(process.execPath, [path.join(js, 'scripts/build-browser.mjs'), '--check'], { encoding: 'utf8' });
});

test('the core reads files and exports them; shapes, writing and queries say which add-on they need', () => {
  const out = run(['jazmin-browser-core.js'], `
    const reader = await J.open(bytes, { key });
    out.rows = (await reader.query({}, { limit: 3 })).rows.length;
    out.csv = (await J.toCSV(reader)).split('\\n').length > 1;
    out.api = Object.keys(J).sort();
    for (const [name, call] of [['shapes', () => reader.shapes()], ['shape export', () => J.toJSON(reader, { shape: { id: '$id' } })]]) {
      try { await call(); out[name] = 'ran'; } catch (e) { out[name] = e.message; }
    }`);
  assert.equal(out.rows, 3);
  assert.equal(out.csv, true);
  assert.deepEqual(out.api.filter((n) => ['write', 'createWriter', 'writeChanges', 'from', 'shapeSchema'].includes(n)), []);
  assert.match(out.shapes, /needs jazmin-browser-shapes\.js, loaded after jazmin-browser-core\.js/);
  assert.match(out['shape export'], /needs jazmin-browser-shapes\.js/);
});

test('each add-on, loaded after the core, adds what the full script has', () => {
  const full = run(['jazmin-browser.js'], `
    const reader = await J.open(bytes, { key });
    out.api = Object.keys(J).sort();
    out.shapes = (await reader.shapes()).map((s) => s.name);
    out.shaped = await J.toJSON(reader, { shape: (await reader.shapes())[0].name });
    out.query = (await J.from(reader).take(2).toArray()).length;
    const written = await J.write([{ n: 1 }, { n: 2 }], { columns: [{ name: 'n', type: 'int' }] });
    out.written = (await (await J.open(written)).query({})).rows.length;`);
  const parts = run(['jazmin-browser-core.js', 'jazmin-browser-shapes.js', 'jazmin-browser-writer.js', 'jazmin-browser-queries.js', 'jazmin-browser-publisher.js'], `
    const reader = await J.open(bytes, { key });
    out.api = Object.keys(J).sort();
    out.shapes = (await reader.shapes()).map((s) => s.name);
    out.shaped = await J.toJSON(reader, { shape: (await reader.shapes())[0].name });
    out.query = (await J.from(reader).take(2).toArray()).length;
    const written = await J.write([{ n: 1 }, { n: 2 }], { columns: [{ name: 'n', type: 'int' }] });
    out.written = (await (await J.open(written)).query({})).rows.length;`);
  assert.deepEqual(parts, full);
  assert.ok(full.shapes.length > 0 && full.query === 2 && full.written === 2);
});

test('an add-on loaded without the core says so', () => {
  for (const addOn of ['jazmin-browser-shapes.js', 'jazmin-browser-writer.js', 'jazmin-browser-queries.js', 'jazmin-browser-publisher.js']) {
    assert.throws(() => run([addOn], ''), new RegExp(`${addOn.replace(/\./g, '\\.')} needs jazmin-browser-core\\.js, loaded first`));
  }
});
