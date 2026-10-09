// JAZMIN beside other formats, for reference (USER-GUIDE 9.12): Parquet (hyparquet, hyparquet-writer), Arrow IPC
// (apache-arrow), SQLite (node:sqlite) and MessagePack (msgpackr), on the same 200,000 customers as bench/benchmark.js.
// Each format is used as its library documents it, with its defaults; the notes printed at the end say what that
// means. Every time is the best of 3 runs after a warm-up run, for every contender alike. Memory: each operation in a
// process of its own (--child), first on a file of 1,000 rows (so each library's code is loaded and compiled), then
// on the real file, measured as how far it raises the process's memory (RSS, sampled throughout by a worker thread),
// so native memory (SQLite) and buffers count too.
//   npm install && npm run bench [rows]
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { tableFromArrays, tableFromIPC, tableToIPC } from 'apache-arrow';
import { asyncBufferFromFile, parquetQuery, parquetReadObjects } from 'hyparquet';
import { parquetWriteFile } from 'hyparquet-writer';
import { pack, unpack } from 'msgpackr';
import { fileURLToPath } from 'node:url';
import { open, write } from '../../src/index.js';

// node formats.mjs [rows], or (for memory) node formats.mjs --child <format> <measure> <dir> <rows> <small dir> <small rows>
const a = process.argv;
const CHILD = a[2] === '--child' ? { name: a[3], measure: a[4], dir: a[5], rows: Number(a[6]), smallDir: a[7], smallRows: Number(a[8]) } : null;
const FULL_ROWS = CHILD ? CHILD.rows : Number(a[2] ?? 200_000);
const SMALL_ROWS = 1000;
// The data in use: the full file, or the small one the memory measurement warms each library up with.
let ROWS = FULL_ROWS;
let dir = CHILD ? CHILD.dir : fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-formats-'));
let target;
const f = (name) => path.join(dir, name);
const countries = ['ZA', 'NA', 'BW', 'ZW', 'MZ', 'LS', 'SZ', 'ZM'];
const first = ['Ann', 'Bob', 'Thabo', 'Lerato', 'Pieter', 'Aisha', 'Sipho', 'Maria'];
const last = ['Smith', 'Johnson', 'Ndlovu', 'Botha', 'Naidoo', 'Mokoena', 'van Wyk', 'Dlamini'];

// The same rows as bench/benchmark.js, made when a write needs them.
let rowsMade = null;
const rowsOf = () => (rowsMade ??= Array.from({ length: ROWS }, (_, i) => ({
  id: i,
  name: `${first[i % 8]} ${last[(i * 7) % 8]}`,
  email: `user${i}@example.com`,
  country: countries[(i * 13) % 8],
  age: 18 + ((i * 31) % 70),
  balance: Math.round(((i * 7919) % 1_000_000) * 1.37) / 100,
  joined: new Date(Date.UTC(2015, 0, 1) + (i % 3650) * 86_400_000),
  active: i % 3 !== 0,
})));
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'name', type: 'string', index: 'trigram' },
  { name: 'email', type: 'string' },
  { name: 'country', type: 'string', index: 'sorted' },
  { name: 'age', type: 'int' },
  { name: 'balance', type: 'float' },
  { name: 'joined', type: 'datetime' },
  { name: 'active', type: 'bool' },
];
function useData(rowCount, directory) {
  ROWS = rowCount;
  dir = directory;
  target = Math.floor(rowCount * 0.6173);
  rowsMade = null;
}
useData(ROWS, dir);
const isMatch = (r) => r.country === 'NA' && r.age > 80;
const expected = () => {
  const rows = rowsOf();
  return { filter: rows.filter(isMatch).length, contains: rows.filter((r) => r.name.includes('Ndlovu')).length, sum: rows.reduce((s, r) => s + r.balance, 0) };
};

function time(fn, repeat = 3) {
  fn();
  let best = Infinity;
  let result;
  for (let i = 0; i < repeat; i++) {
    globalThis.gc?.();
    const start = process.hrtime.bigint();
    result = fn();
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { ms: best, result };
}

async function timeAsync(fn, repeat = 3) {
  await fn();
  let best = Infinity;
  let result;
  for (let i = 0; i < repeat; i++) {
    globalThis.gc?.();
    const start = process.hrtime.bigint();
    result = await fn();
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { ms: best, result };
}

const size = (name) => fs.statSync(f(name)).size;
const check = (what, got, want) => {
  const ok = typeof want === 'number' && !Number.isInteger(want) ? Math.abs(got - want) < 1e-3 * Math.abs(want) : got === want;
  if (!ok) throw new Error(`${what}: got ${got}, expected ${want}`);
};
const sumOf = (values) => {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s;
};

// ---- the contenders: write, read all, sum a column, find by id, filter, text search ------------------------------

const contenders = [];

contenders.push({
  name: 'JAZMIN',
  write: () => write(f('data.jzm'), rowsOf(), { columns }),
  size: () => size('data.jzm'),
  readAll: () => [...open(f('data.jzm')).rows()].length,
  sum: () => {
    const r = open(f('data.jzm'));
    const s = sumOf(r.columnArrays(null, { select: ['balance'] }).values.balance);
    r.close();
    return s;
  },
  lookup: () => {
    const r = open(f('data.jzm'));
    const x = [...r.find({ id: target })];
    r.close();
    return x[0].id;
  },
  filter: () => {
    const r = open(f('data.jzm'));
    const n = r.count({ country: 'NA', age: { gt: 80 } });
    r.close();
    return n;
  },
  contains: () => {
    const r = open(f('data.jzm'));
    const n = r.count({ name: { contains: 'Ndlovu' } });
    r.close();
    return n;
  },
});

const parquetColumns = (rows = rowsOf()) => [
  { name: 'id', data: Int32Array.from(rows, (r) => r.id), type: 'INT32' },
  { name: 'name', data: rows.map((r) => r.name), type: 'STRING' },
  { name: 'email', data: rows.map((r) => r.email), type: 'STRING' },
  { name: 'country', data: rows.map((r) => r.country), type: 'STRING' },
  { name: 'age', data: Int32Array.from(rows, (r) => r.age), type: 'INT32' },
  { name: 'balance', data: Float64Array.from(rows, (r) => r.balance), type: 'DOUBLE' },
  { name: 'joined', data: rows.map((r) => r.joined), type: 'TIMESTAMP' },
  { name: 'active', data: rows.map((r) => r.active), type: 'BOOLEAN' },
];
const parquetFile = () => asyncBufferFromFile(f('data.parquet'));
contenders.push({
  name: 'Parquet',
  async: true,
  write: () => parquetWriteFile({ filename: f('data.parquet'), columnData: parquetColumns() }),
  size: () => size('data.parquet'),
  readAll: async () => (await parquetReadObjects({ file: await parquetFile() })).length,
  sum: async () => sumOf((await parquetReadObjects({ file: await parquetFile(), columns: ['balance'] })).map((r) => r.balance)),
  lookup: async () => (await parquetQuery({ file: await parquetFile(), filter: { id: { $eq: target } } }))[0].id,
  filter: async () => (await parquetQuery({ file: await parquetFile(), filter: { country: 'NA', age: { $gt: 80 } }, columns: ['id', 'country', 'age'] })).length,
  contains: async () => (await parquetReadObjects({ file: await parquetFile(), columns: ['name'] })).filter((r) => r.name.includes('Ndlovu')).length,
});

contenders.push({
  name: 'Arrow IPC',
  write: () => {
    const rows = rowsOf();
    const table = tableFromArrays({
      id: Int32Array.from(rows, (r) => r.id),
      name: rows.map((r) => r.name),
      email: rows.map((r) => r.email),
      country: rows.map((r) => r.country),
      age: Int32Array.from(rows, (r) => r.age),
      balance: Float64Array.from(rows, (r) => r.balance),
      joined: rows.map((r) => r.joined),
      active: rows.map((r) => r.active),
    });
    fs.writeFileSync(f('data.arrow'), tableToIPC(table, 'file'));
  },
  size: () => size('data.arrow'),
  readAll: () => {
    const table = tableFromIPC(fs.readFileSync(f('data.arrow')));
    const out = [];
    for (const row of table) out.push(row.toJSON());
    return out.length;
  },
  sum: () => sumOf(tableFromIPC(fs.readFileSync(f('data.arrow'))).getChild('balance').toArray()),
  lookup: () => {
    const table = tableFromIPC(fs.readFileSync(f('data.arrow')));
    const i = table.getChild('id').toArray().indexOf(target);
    return table.get(i).toJSON().id;
  },
  filter: () => {
    const table = tableFromIPC(fs.readFileSync(f('data.arrow')));
    const country = table.getChild('country');
    const age = table.getChild('age').toArray();
    let n = 0;
    for (let i = 0; i < age.length; i++) if (age[i] > 80 && country.get(i) === 'NA') n++;
    return n;
  },
  contains: () => {
    const names = tableFromIPC(fs.readFileSync(f('data.arrow'))).getChild('name');
    let n = 0;
    for (const name of names) if (name.includes('Ndlovu')) n++;
    return n;
  },
});

// SQLite with the same indexes as JAZMIN's file (id, country); no full-text index for the text search.
const sqliteRow = (r) => ({ ...r, joined: new Date(r.joined), active: r.active === 1 });
contenders.push({
  name: 'SQLite',
  write: () => {
    fs.rmSync(f('data.sqlite'), { force: true });
    const db = new DatabaseSync(f('data.sqlite'));
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, country TEXT, age INTEGER, balance REAL, joined INTEGER, active INTEGER)');
    db.exec('CREATE INDEX customers_country ON customers (country)');
    const insert = db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const r of rowsOf()) insert.run(r.id, r.name, r.email, r.country, r.age, r.balance, r.joined.getTime(), r.active ? 1 : 0);
    db.exec('COMMIT');
    db.close();
  },
  size: () => size('data.sqlite'),
  readAll: () => {
    const db = new DatabaseSync(f('data.sqlite'), { readOnly: true });
    const out = db.prepare('SELECT * FROM customers').all().map(sqliteRow);
    db.close();
    return out.length;
  },
  sum: () => {
    const db = new DatabaseSync(f('data.sqlite'), { readOnly: true });
    const s = db.prepare('SELECT sum(balance) AS s FROM customers').get().s;
    db.close();
    return s;
  },
  lookup: () => {
    const db = new DatabaseSync(f('data.sqlite'), { readOnly: true });
    const row = sqliteRow(db.prepare('SELECT * FROM customers WHERE id = ?').get(target));
    db.close();
    return row.id;
  },
  filter: () => {
    const db = new DatabaseSync(f('data.sqlite'), { readOnly: true });
    const n = db.prepare("SELECT count(*) AS n FROM customers WHERE country = 'NA' AND age > 80").get().n;
    db.close();
    return n;
  },
  contains: () => {
    const db = new DatabaseSync(f('data.sqlite'), { readOnly: true });
    const n = db.prepare("SELECT count(*) AS n FROM customers WHERE name LIKE '%Ndlovu%'").get().n;
    db.close();
    return n;
  },
});

const msgpackAll = () => unpack(fs.readFileSync(f('data.msgpack')));
contenders.push({
  name: 'MessagePack',
  write: () => fs.writeFileSync(f('data.msgpack'), pack(rowsOf())),
  size: () => size('data.msgpack'),
  readAll: () => msgpackAll().length,
  sum: () => msgpackAll().reduce((s, r) => s + r.balance, 0),
  lookup: () => msgpackAll().find((r) => r.id === target).id,
  filter: () => msgpackAll().filter(isMatch).length,
  contains: () => msgpackAll().filter((r) => r.name.includes('Ndlovu')).length,
});

// ---- run ------------------------------------------------------------------------------------------------------

const MEASURES = [
  ['write', 'Write every row', (ms) => `${ms.toFixed(0)} ms`],
  ['readAll', 'Read every row (objects)', (ms) => `${ms.toFixed(0)} ms`],
  ['sum', 'Sum one column', (ms) => `${ms.toFixed(1)} ms`],
  ['lookup', 'Find one row by id (open → row)', (ms) => `${ms.toFixed(1)} ms`],
  ['filter', 'Filter: country = NA, age > 80', (ms) => `${ms.toFixed(1)} ms`],
  ['contains', "Text search: name contains 'Ndlovu'", (ms) => `${ms.toFixed(1)} ms`],
];
// A child process: one operation on the small file (the library's code loaded and compiled), then on the full file,
// with a worker thread sampling the process's memory (RSS) throughout. Prints how far it rose (KB).
if (CHILD) {
  const c = contenders.find((x) => x.name === CHILD.name);
  useData(CHILD.smallRows, CHILD.smallDir);
  if (CHILD.measure === 'write') rowsOf();
  await c[CHILD.measure]();
  useData(CHILD.rows, CHILD.dir);
  if (CHILD.measure === 'write') rowsOf();
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const sampler = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const stop = workerData;
    let peak = 0;
    parentPort.postMessage('ready');
    while (Atomics.load(stop, 0) === 0) { const rss = process.memoryUsage.rss(); if (rss > peak) peak = rss; }
    parentPort.postMessage(peak);`, { eval: true, workerData: stop });
  const messages = [];
  const next = () => new Promise((resolve) => (messages.length ? resolve(messages.shift()) : sampler.once('message', resolve)));
  await next(); // the sampler is running before the baseline is taken
  globalThis.gc?.();
  const before = process.memoryUsage.rss();
  await c[CHILD.measure]();
  const after = process.memoryUsage.rss();
  Atomics.store(stop, 0, 1);
  const peak = Math.max(await next(), after);
  process.stdout.write(String(Math.round((peak - before) / 1024)));
  process.exit(0);
}

const want = expected();
const results = new Map(contenders.map((c) => [c.name, {}]));
for (const c of contenders) {
  const run = c.async ? timeAsync : async (fn) => time(fn);
  const r = results.get(c.name);
  r.write = (await run(c.write)).ms;
  r.size = c.size();
  for (const [key] of MEASURES.slice(1)) {
    const { ms, result } = await run(c[key]);
    if (key === 'readAll') check(`${c.name} read`, result, ROWS);
    if (key === 'lookup') check(`${c.name} lookup`, result, target);
    if (key === 'filter') check(`${c.name} filter`, result, want.filter);
    if (key === 'contains') check(`${c.name} contains`, result, want.contains);
    if (key === 'sum') check(`${c.name} sum`, result, want.sum);
    r[key] = ms;
  }
}

const cpu = os.cpus()[0]?.model?.trim() ?? 'unknown CPU';
console.log(`\nJAZMIN beside other formats - Node ${process.version}, ${cpu}, ${ROWS.toLocaleString('en')} rows\n`);
const names = contenders.map((c) => c.name);
const width = 38;
const cell = 13;
console.log('Measure'.padEnd(width) + names.map((n) => n.padStart(cell)).join(''));
console.log('File size'.padEnd(width) + names.map((n) => `${Math.round(results.get(n).size / 1024).toLocaleString('en')} KB`.padStart(cell)).join(''));
for (const [key, label, show] of MEASURES) console.log(label.padEnd(width) + names.map((n) => show(results.get(n)[key]).padStart(cell)).join(''));

// Memory: each operation in a process of its own, on the files written above, after the same operation on files of
// SMALL_ROWS rows (written now).
const fullDir = dir;
const smallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-formats-small-'));
useData(SMALL_ROWS, smallDir);
for (const c of contenders) await c.write();
useData(FULL_ROWS, fullDir);
const memory = (name, measure) => {
  const run = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child', name, measure, fullDir, String(FULL_ROWS), smallDir, String(SMALL_ROWS)], { encoding: 'utf8' });
  const kb = Number(run.stdout.trim());
  if (run.status !== 0 || !Number.isFinite(kb)) throw new Error(`${name} ${measure} memory: ${run.stderr.trim().split(String.fromCharCode(10)).pop()}`);
  return `${(Math.max(0, kb) / 1024).toFixed(1)} MB`;
};
console.log(`
Peak memory added${' '.repeat(width - 17)}` + names.map((n) => n.padStart(cell)).join(''));
for (const [key, label] of MEASURES) console.log(label.padEnd(width) + names.map((n) => memory(n, key).padStart(cell)).join(''));
const gz = zlib.gzipSync(fs.readFileSync(f('data.msgpack'))).length;
console.log(`
Notes:
- JAZMIN: deflate, 3 indexes (id sorted, name trigram, country sorted); "Sum one column" with columnArrays.
- Parquet: hyparquet-writer defaults (Snappy, statistics, row groups of 1,000 then up to 100,000 rows); hyparquet
  reads, its filters skip row groups by their statistics; no text index.
- Arrow IPC: the file format, uncompressed (apache-arrow writes no compressed IPC); read whole, then searched.
- SQLite: node:sqlite, a table with id as its primary key and an index on country; LIKE scans for the text search.
- MessagePack: msgpackr defaults; every query reads the whole file (gzipped it would be ${Math.round(gz / 1024).toLocaleString('en')} KB).`);
fs.rmSync(fullDir, { recursive: true, force: true });
fs.rmSync(smallDir, { recursive: true, force: true });
