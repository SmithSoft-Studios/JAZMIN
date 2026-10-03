// Indicative benchmark: JAZMIN vs JSON (and gzipped JSON / CSV) on the same data.
// Run: node --expose-gc bench/benchmark.js [rows]
// Results depend on hardware and data shape - re-run on your own data before quoting numbers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { JazminKey, open, toCSV, write } from '../src/index.js';

const ROWS = Number(process.argv[2] ?? 200_000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-bench-'));
const countries = ['ZA', 'NA', 'BW', 'ZW', 'MZ', 'LS', 'SZ', 'ZM'];
const first = ['Ann', 'Bob', 'Thabo', 'Lerato', 'Pieter', 'Aisha', 'Sipho', 'Maria'];
const last = ['Smith', 'Johnson', 'Ndlovu', 'Botha', 'Naidoo', 'Mokoena', 'van Wyk', 'Dlamini'];

const rows = Array.from({ length: ROWS }, (_, i) => ({
  id: i,
  name: `${first[i % 8]} ${last[(i * 7) % 8]}`,
  email: `user${i}@example.com`,
  country: countries[(i * 13) % 8],
  age: 18 + ((i * 31) % 70),
  balance: Math.round(((i * 7919) % 1_000_000) * 1.37) / 100,
  joined: new Date(Date.UTC(2015, 0, 1) + (i % 3650) * 86_400_000),
  active: i % 3 !== 0,
}));
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

function time(fn, repeat = 3) {
  fn(); // warm-up for every contender alike, so timings compare optimised (steady-state) code
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

function heapAfter(fn) {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const keep = fn();
  globalThis.gc?.();
  const used = process.memoryUsage().heapUsed - before;
  return { mb: Math.max(0, used) / 1048576, keep };
}

const f = (p) => path.join(dir, p);
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const results = [];
const row = (label, value) => results.push([label, value]);

// ---- Size ---------------------------------------------------------------------------
const jsonText = JSON.stringify(rows);
fs.writeFileSync(f('data.json'), jsonText);
fs.writeFileSync(f('data.json.gz'), zlib.gzipSync(jsonText));
const key = JazminKey.generate();
write(f('plain.jzm'), rows, { columns });
write(f('noindex.jzm'), rows, { columns: columns.map(({ index, ...c }) => c) });
write(f('brotli.jzm'), rows, { columns: columns.map(({ index, ...c }) => c), codec: 'brotli' });
write(f('secure.jzm'), rows, { columns, key });
fs.writeFileSync(f('data.csv'), toCSV(open(f('noindex.jzm'))));
const size = (p) => fs.statSync(f(p)).size;

row('Rows', ROWS.toLocaleString());
row('Size: JSON', kb(size('data.json')));
row('Size: JSON + gzip', kb(size('data.json.gz')));
row('Size: CSV', kb(size('data.csv')));
row('Size: JAZMIN deflate, no indexes', kb(size('noindex.jzm')));
row('Size: JAZMIN brotli, no indexes', kb(size('brotli.jzm')));
row('Size: JAZMIN deflate + 3 indexes', kb(size('plain.jzm')));
row('Size: JAZMIN + indexes + AES-256-GCM', kb(size('secure.jzm')));

// ---- Write --------------------------------------------------------------------------
row('Write: JSON.stringify + writeFile', `${time(() => fs.writeFileSync(f('w.json'), JSON.stringify(rows))).ms.toFixed(0)} ms`);
row('Write: JAZMIN (no indexes)', `${time(() => write(f('w1.jzm'), rows, { columns: columns.map(({ index, ...c }) => c) })).ms.toFixed(0)} ms`);
row('Write: JAZMIN (+3 indexes)', `${time(() => write(f('w2.jzm'), rows, { columns })).ms.toFixed(0)} ms`);

// ---- Full read ----------------------------------------------------------------------
row('Read all: JSON.parse(readFile)', `${time(() => JSON.parse(fs.readFileSync(f('data.json'), 'utf8')).length).ms.toFixed(0)} ms`);
row('Read all: JAZMIN rows()', `${time(() => { let n = 0; const r = open(f('noindex.jzm')); for (const _ of r.rows()) n++; r.close(); return n; }).ms.toFixed(0)} ms`);

// ---- Point lookup -------------------------------------------------------------------
const target = Math.floor(ROWS * 0.73);
row('Lookup id: JSON (parse all, then find)', `${time(() => JSON.parse(fs.readFileSync(f('data.json'), 'utf8')).find((r) => r.id === target)).ms.toFixed(1)} ms`);
row('Lookup id: JAZMIN open + index', `${time(() => { const r = open(f('plain.jzm')); const x = [...r.find({ id: target })]; r.close(); return x; }).ms.toFixed(1)} ms`);
row('Lookup id: JAZMIN encrypted open + index', `${time(() => { const r = open(f('secure.jzm'), { key }); const x = [...r.find({ id: target })]; r.close(); return x; }).ms.toFixed(1)} ms`);

// ---- Filtered query -----------------------------------------------------------------
const pred = (r) => r.country === 'NA' && r.age > 80;
row('Filter: JSON (parse all, then filter)', `${time(() => JSON.parse(fs.readFileSync(f('data.json'), 'utf8')).filter(pred).length).ms.toFixed(0)} ms`);
row('Filter: JAZMIN (country index + age check)', `${time(() => { const r = open(f('plain.jzm')); const n = r.count({ country: 'NA', age: { gt: 80 } }); r.close(); return n; }).ms.toFixed(0)} ms`);
row('Contains: JSON (parse all, then filter)', `${time(() => JSON.parse(fs.readFileSync(f('data.json'), 'utf8')).filter((r) => r.name.includes('Ndlovu')).length).ms.toFixed(0)} ms`);
row('Contains: JAZMIN (trigram index)', `${time(() => { const r = open(f('plain.jzm')); const n = r.count({ name: { contains: 'Ndlovu' } }); r.close(); return n; }).ms.toFixed(0)} ms`);

// ---- Memory -------------------------------------------------------------------------
if (globalThis.gc) {
  // Working set needed to answer one lookup (objects kept alive while answering).
  const jsonMem = heapAfter(() => JSON.parse(fs.readFileSync(f('data.json'), 'utf8')));
  row('Memory to answer a lookup: JSON', `${jsonMem.mb.toFixed(1)} MB (whole array must be parsed)`);
  const jzm = heapAfter(() => { const r = open(f('plain.jzm')); const x = [...r.find({ id: target })]; return { r, x }; });
  row('Memory to answer a lookup: JAZMIN', `${jzm.mb.toFixed(1)} MB (header + id index + 1 chunk)`);
}

console.log(`\nJAZMIN benchmark - Node ${process.version}, ${os.cpus()[0].model}\n`);
const width = Math.max(...results.map(([l]) => l.length));
for (const [label, value] of results) console.log(`${label.padEnd(width)}  ${value}`);
fs.rmSync(dir, { recursive: true, force: true });
