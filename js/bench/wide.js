// Wide-table benchmark: JAZMIN vs JSON on many rows x many columns, without holding the data in memory.
// Both sides are written and read as streams; each measurement runs in its own process so its peak
// memory (max RSS) is measured cleanly.
//
//   node bench/wide.js [rows=1000000] [columns=300] [dir=<temp>]
//   JAZMIN_PARALLELISM=1 node bench/wide.js ...   (writer threads; default: by priority)
//   JAZMIN_PRIORITY=memory node bench/wide.js ...  (memory | balanced | speed; default: balanced)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { JazminWriter, open } from '../src/index.js';
import { readJsonObjects } from '../src/formats/json-stream.js';

const self = fileURLToPath(import.meta.url);
const [ROWS, COLS] = [Number(process.argv[2] ?? 1_000_000), Number(process.argv[3] ?? 300)];
const DIR = process.argv[4] ?? path.join(os.tmpdir(), `jazmin-wide-${ROWS}x${COLS}`);
const phase = process.argv[5];
const jzm = path.join(DIR, 'wide.jzm');
const json = path.join(DIR, 'wide.json');

// ---- deterministic data: a realistic mix of column types, ~5% nulls ----------------------------------
const KINDS = ['status', 'name', 'amount', 'money', 'date', 'flag', 'price', 'qty'];
const STATUSES = ['paid', 'due', 'overdue', 'void', 'draft', 'sent', 'partial', 'disputed'];
const NAMES = Array.from({ length: 2000 }, (_, i) => `Customer ${i} ${['Ltd', 'Inc', 'CC', 'Trust'][i % 4]}`);
const columns = [{ name: 'id', type: 'int', nullable: false }];
for (let c = 1; c < COLS; c++) {
  const kind = KINDS[c % KINDS.length];
  const type = { status: 'string', name: 'string', amount: 'int', money: 'float', date: 'datetime', flag: 'bool', price: 'decimal', qty: 'int' }[kind];
  columns.push({ name: `${kind}_${c}`, type });
}
const BASE = Date.UTC(2015, 0, 1);
function row(r) {
  const out = { id: r };
  for (let c = 1; c < COLS; c++) {
    const h = (Math.imul(r + 1, 2654435761) ^ Math.imul(c, 40503)) >>> 0;
    const col = columns[c];
    if (h % 20 === 0) { out[col.name] = null; continue; }
    switch (c % 8) {
      case 0: out[col.name] = STATUSES[h % 8]; break;
      case 1: out[col.name] = NAMES[h % 2000]; break;
      case 2: out[col.name] = h % 10_000_000; break;
      case 3: out[col.name] = (h % 1_000_000) / 100; break;
      case 4: out[col.name] = new Date(BASE + (r * 60_000) + (h % 86_400) * 1000); break;
      case 5: out[col.name] = (h & 1) === 1; break;
      case 6: out[col.name] = `${h % 100_000}.${String(h % 100).padStart(2, '0')}`; break;
      default: out[col.name] = h % 101;
    }
  }
  return out;
}
const TARGET = Math.floor(ROWS * 0.731);
const [P1, P2, P3] = [columns[2].name, columns[3].name, columns[10].name]; // amount, money, amount
const [STATUS, AMOUNT] = [columns[8].name, columns[2].name];

// ---- one measurement (child process) --------------------------------------------------------------------
function measure(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  process.stdout.write(JSON.stringify({ ms, maxRssMb: process.resourceUsage().maxRSS / 1024, result }));
}

const READ = process.env.JAZMIN_PRIORITY ? { priority: process.env.JAZMIN_PRIORITY } : {};

const PHASES = {
  'write-jzm': () => measure(() => {
    const parallel = process.env.JAZMIN_PARALLELISM ? { maxDegreeOfParallelism: Number(process.env.JAZMIN_PARALLELISM) } : {};
    if (process.env.JAZMIN_PRIORITY) parallel.priority = process.env.JAZMIN_PRIORITY;
    const w = new JazminWriter(jzm, { columns, sortedBy: ['id'], ...parallel });
    for (let r = 0; r < ROWS; r++) w.writeRow(row(r));
    w.finish();
    return fs.statSync(jzm).size;
  }),
  'write-json': () => measure(() => {
    const fd = fs.openSync(json, 'w');
    let batch = '[';
    for (let r = 0; r < ROWS; r++) {
      batch += (r ? ',' : '') + JSON.stringify(row(r));
      if (batch.length > 8 << 20) { fs.writeSync(fd, batch); batch = ''; }
    }
    fs.writeSync(fd, batch + ']');
    fs.closeSync(fd);
    return fs.statSync(json).size;
  }),
  'gzip-json': () => measure(() => {
    // Size of the JSON gzipped at level 6, in 8 MB pieces (not part of any timing comparison).
    let size = 0;
    const fd = fs.openSync(json, 'r');
    const buf = Buffer.alloc(8 << 20);
    for (let n; (n = fs.readSync(fd, buf)) > 0;) size += zlib.gzipSync(buf.subarray(0, n), { level: 6 }).length;
    fs.closeSync(fd);
    return size;
  }),
  'open-jzm': () => measure(() => { const r = open(jzm, READ); const n = r.chunkCount; r.close(); return n; }),
  'lookup-jzm': () => measure(() => { const r = open(jzm, READ); const hit = [...r.find({ id: TARGET })][0]; r.close(); return hit.id; }),
  'lookup-json': () => measure(() => { for (const o of readJsonObjects(json)) if (o.id === TARGET) return o.id; return null; }),
  'project-jzm': () => measure(() => {
    const r = open(jzm, READ);
    let sum = 0;
    for (const o of r.rows({ select: [P1, P2, P3] })) sum += (o[P1] ?? 0) + (o[P2] ?? 0) + (o[P3] ?? 0);
    r.close();
    return Math.round(sum);
  }),
  'project-json': () => measure(() => {
    let sum = 0;
    for (const o of readJsonObjects(json)) sum += (o[P1] ?? 0) + (o[P2] ?? 0) + (o[P3] ?? 0);
    return Math.round(sum);
  }),
  'filter-jzm': () => measure(() => {
    const r = open(jzm, READ);
    let n = 0;
    for (const _ of r.find({ [STATUS]: 'paid', [AMOUNT]: { gt: 5_000_000 } }, { select: ['id'] })) n++;
    r.close();
    return n;
  }),
  'filter-json': () => measure(() => {
    let n = 0;
    for (const o of readJsonObjects(json)) if (o[STATUS] === 'paid' && o[AMOUNT] > 5_000_000) n++;
    return n;
  }),
  'arrays-jzm': () => measure(() => {
    const r = open(jzm, READ);
    const { values } = r.columnArrays(null, { select: [P1, P2, P3] });
    let sum = 0;
    for (const name of [P1, P2, P3]) for (const v of values[name]) if (!Number.isNaN(v)) sum += v;
    r.close();
    return Math.round(sum);
  }),
  'scan-jzm': () => measure(() => { const r = open(jzm, READ); let n = 0; for (const _ of r.rows()) n++; r.close(); return n; }),
  'scan-json': () => measure(() => { let n = 0; for (const _ of readJsonObjects(json)) n++; return n; }),
};

if (phase) {
  PHASES[phase]();
} else {
  fs.mkdirSync(DIR, { recursive: true });
  const run = (name) => {
    process.stderr.write(`  ${name}...\n`);
    return JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=16384', self, String(ROWS), String(COLS), DIR, name], { encoding: 'utf8', maxBuffer: 1 << 20 }));
  };
  const results = Object.fromEntries(Object.keys(PHASES).map((name) => [name, run(name)]));
  const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;
  const t = (r) => `${(r.ms / 1000).toFixed(2)} s, ${r.maxRssMb.toFixed(0)} MB RAM`;
  console.log(`\nWide benchmark - ${ROWS.toLocaleString('en')} rows x ${COLS} columns, Node ${process.version}\n`);
  console.log(`Size: JSON                  ${mb(results['write-json'].result)}`);
  console.log(`Size: JSON + gzip           ${mb(results['gzip-json'].result)}`);
  console.log(`Size: JAZMIN (columnar)     ${mb(results['write-jzm'].result)}`);
  console.log(`Write: JSON                 ${t(results['write-json'])}`);
  console.log(`Write: JAZMIN               ${t(results['write-jzm'])}`);
  console.log(`Open: JAZMIN (header)       ${t(results['open-jzm'])}  (${results['open-jzm'].result} chunks)`);
  for (const [label, key] of [['Lookup one id', 'lookup'], ['Sum 3 of the columns', 'project'], ['Filter 2 conditions', 'filter'], ['Read every row', 'scan']]) {
    console.log(`${label}: JSON stream`.padEnd(34) + t(results[`${key}-json`]));
    console.log(`${label}: JAZMIN`.padEnd(34) + t(results[`${key}-jzm`]));
    if (results[`${key}-json`].result !== results[`${key}-jzm`].result) console.log(`  !! results differ: ${results[`${key}-json`].result} vs ${results[`${key}-jzm`].result}`);
  }
  console.log(`\nFiles kept in ${DIR} (delete when done).`);
}
