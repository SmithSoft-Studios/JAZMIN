// Column names come from the file, so they are data: a name must never run as code (the reader generates row
// builders with new Function), and every name must come back as an ordinary field. `__proto__` is special in
// JavaScript: plain assignment sets an object's prototype instead of adding a field (issue #68).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const src = new URL('../src/index.js', import.meta.url).href;
const browser = new URL('../browser/jazmin-browser.js', import.meta.url).href;

// Runs in a child process, so the same checks can run with code generation switched off. Each check reports true,
// false, or the error it threw.
const script = String.raw`
import { write, open, parseCsv, fromCSV } from ${JSON.stringify(src)};
import ${JSON.stringify(browser)};
const { JazminBrowser } = globalThis;

const tick = String.fromCharCode(96); // a template literal, to break out of one
const names = ['"};globalThis.pwned=1;//', "'];globalThis.pwned=2;//", 'a\\b', 'line sep', tick + '$' + '{globalThis.pwned=3}' + tick, 'constructor', 'toString', '__proto__', 'ok'];
const valueOf = (name, i) => (name === '__proto__' ? { x: 'inherited' } : 'v' + i);
const row = {};
names.forEach((n, i) => Object.defineProperty(row, n, { value: valueOf(n, i), enumerable: true, writable: true, configurable: true }));
const columns = names.map((name) => ({ name, type: name === '__proto__' ? 'json' : 'string' }));
const bytes = write(null, [row, row], { columns });

const checks = {};
const check = async (name, fn) => {
  try {
    checks[name] = (await fn()) === true;
  } catch (error) {
    checks[name] = String(error.message);
  }
};
const same = (got, keys) =>
  Object.getPrototypeOf(got) === Object.prototype && got.x === undefined &&
  JSON.stringify(Object.keys(got)) === JSON.stringify(keys) &&
  keys.every((n) => JSON.stringify(Object.getOwnPropertyDescriptor(got, n)?.value) === JSON.stringify(valueOf(n, names.indexOf(n))));

const reader = open(bytes);
await check('rows', () => [...reader.rows()].every((r) => same(r, names)));
await check('findSelect', () => [...reader.find(null, { select: ['__proto__', 'ok'] })].every((r) => same(r, ['__proto__', 'ok'])));
await check('findFilterSelect', () => [...reader.find({ ok: 'v8' }, { select: [names[0], '__proto__'] })].every((r) => same(r, [names[0], '__proto__'])));
await check('get', () => same(reader.get(1), names));

// In a row parsed from JSON, '__proto__' is an ordinary field.
const numberRow = () => JSON.parse('{"__proto__": 1, "ok": 2}');
const numberColumns = [{ name: '__proto__', type: 'int' }, { name: 'ok', type: 'int' }];
await check('columnArrays', () => {
  const arrays = open(write(null, [numberRow()], { columns: numberColumns })).columnArrays();
  return Object.getPrototypeOf(arrays.values) === Object.prototype && Object.hasOwn(arrays.values, '__proto__') && arrays.values.__proto__[0] === 1;
});
await check('csvParse', () => {
  const csv = parseCsv('__proto__,ok\n1,2\n');
  return Object.hasOwn(csv.rows[0], '__proto__') && csv.rows[0].__proto__ === 1 && Object.getPrototypeOf(csv.rows[0]) === Object.prototype;
});
await check('csvImport', () => {
  const imported = [...open(fromCSV('__proto__,ok\n1,2\n', null)).rows()][0];
  return Object.hasOwn(imported, '__proto__') && imported.__proto__ === 1;
});

const inBrowser = await JazminBrowser.open(new Blob([bytes]));
await check('browserRows', async () => {
  const rows = [];
  for await (const r of inBrowser.find(null)) rows.push(r);
  return rows.length === 2 && rows.every((r) => same(r, names));
});
await check('browserSelect', async () => {
  const rows = [];
  for await (const r of inBrowser.find(null, { select: ['__proto__', 'ok'] })) rows.push(r);
  return rows.length === 2 && rows.every((r) => same(r, ['__proto__', 'ok']));
});
await check('browserColumnArrays', async () => {
  const arrays = await (await JazminBrowser.open(new Blob([write(null, [numberRow()], { columns: numberColumns })]))).columnArrays();
  return Object.hasOwn(arrays.values, '__proto__') && arrays.values.__proto__[0] === 1;
});

checks.noCodeRan = globalThis.pwned === undefined;
console.log(JSON.stringify(checks));
`;

function run(flags) {
  const result = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const expected = {
  rows: true, findSelect: true, findFilterSelect: true, get: true, columnArrays: true, csvParse: true, csvImport: true,
  browserRows: true, browserSelect: true, browserColumnArrays: true, noCodeRan: true,
};

test('hostile and special column names never run as code and read back as ordinary fields', () => {
  assert.deepEqual(run([]), expected);
});

test('the same with code generation switched off (the reader builds rows without new Function)', () => {
  assert.deepEqual(run(['--disallow-code-generation-from-strings']), expected);
});
