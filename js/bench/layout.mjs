// Layout benchmark: what changing an existing file's indexes or sort order costs - time and peak memory - beside a
// plain compact() (a rewrite that changes nothing), for a file of 1,000,000 rows sorted by id with two sorted indexes.
// Each run is in its own process, on a fresh copy of the file; peak memory is the process's peak resident memory above
// what it used before. Time is the median of 3 runs.
// Run: node bench/layout.mjs            (the file is made once, in the system's temp folder, and kept)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JazminKey, compact, update, write } from '../src/index.js';

const RUNS = 3;
const here = fileURLToPath(import.meta.url);
const dir = path.join(os.tmpdir(), 'jazmin-layout-bench');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const PAYMENT_COLUMNS = [{ name: 'customer', type: 'string', index: 'sorted' }, { name: 'amount', type: 'decimal' }, { name: 'at', type: 'datetime' }];
/** 200,000 payments, made as they are read: the rows are never all in memory. */
function* payments() {
  for (let i = 0; i < 200_000; i++) yield { customer: `C${String((i * 7919) % 50_000).padStart(5, '0')}`, amount: `${i % 5000}.00`, at: new Date(Date.UTC(2026, 0, 1) + i * 60_000) };
}

const SCENARIOS = {
  compact: { label: 'compact() (rewrite, nothing changed)', run: (file, key) => compact(file, { key }) },
  'add-trigram': { label: 'Add a text-search index on customer', run: (file, key) => update(file, { key, indexes: { customer: ['sorted', 'trigram'] } }) },
  'drop-index': { label: 'Remove the index on customer', run: (file, key) => update(file, { key, indexes: { customer: [] } }) },
  'sort-memory': { label: "Re-sort by customer, id (priority 'memory')", run: (file, key) => update(file, { key, sortedBy: ['customer', 'id'], priority: 'memory' }) },
  'sort-balanced': { label: 'Re-sort by customer, id (balanced)', run: (file, key) => update(file, { key, sortedBy: ['customer', 'id'] }) },
  'sort-speed': { label: "Re-sort by customer, id (priority 'speed')", run: (file, key) => update(file, { key, sortedBy: ['customer', 'id'], priority: 'speed' }) },
  'rename-table': { label: 'Name the table (a rewrite)', run: (file, key) => update(file, { key, renameTables: { '': 'orders' } }) },
  'add-table': { label: 'Add a 200,000-row table, rows streamed', run: (file, key) => update(file, { key, renameTables: { '': 'orders' }, addTables: [{ name: 'payments', columns: PAYMENT_COLUMNS, rows: payments() }] }) },
  'add-table-sorted': { label: 'Add a 200,000-row table, sorted on the way in', run: (file, key) => update(file, { key, renameTables: { '': 'orders' }, addTables: [{ name: 'payments', columns: PAYMENT_COLUMNS, sortedBy: ['customer', 'at'], rows: payments() }] }) },
};

if (process.argv[2] === '--run') {
  const { source, keyText, scenario } = JSON.parse(process.argv[3]);
  const key = JazminKey.from(keyText);
  const work = path.join(dir, `work-${process.pid}.jzm`);
  fs.copyFileSync(source, work);
  const before = process.memoryUsage().rss;
  const start = process.hrtime.bigint();
  SCENARIOS[scenario].run(work, key);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const peakMb = Math.max(0, process.resourceUsage().maxRSS * 1024 - before) / 1048576;
  const bytes = fs.statSync(work).size;
  fs.rmSync(work, { force: true });
  process.stdout.write(JSON.stringify({ ms, peakMb, bytes }));
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
const keyFile = path.join(dir, 'key.txt');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, JazminKey.generate().export());
const keyText = fs.readFileSync(keyFile, 'utf8').trim();
const source = path.join(dir, 'orders.jzm');
if (!fs.existsSync(source)) {
  const columns = [
    { name: 'id', type: 'int', nullable: false },
    { name: 'customer', type: 'string', index: 'sorted' },
    { name: 'city', type: 'string', index: 'sorted' },
    { name: 'amount', type: 'decimal' },
    { name: 'note', type: 'string' },
  ];
  const cities = ['Durban', 'Cape Town', 'Johannesburg', 'Pretoria', 'Gqeberha'];
  write(source, Array.from({ length: 1_000_000 }, (_, i) => ({
    id: i, customer: `C${String((i * 7919) % 50_000).padStart(5, '0')}`, city: cities[i % 5], amount: `${(i * 13) % 10_000}.25`, note: `order ${i}`,
  })), { columns, key: JazminKey.from(keyText), sortedBy: ['id'] });
}

console.log(`Layout benchmark - Node ${process.version}, ${os.cpus()[0].model}; 1,000,000 rows, ${(fs.statSync(source).size / 1048576).toFixed(1)} MB\n`);
console.log('| Change | Time | Peak memory | File after |');
console.log('|---|---:|---:|---:|');
for (const [scenario, { label }] of Object.entries(SCENARIOS)) {
  const runs = Array.from({ length: RUNS }, () => JSON.parse(execFileSync(process.execPath, [here, '--run', JSON.stringify({ source, keyText, scenario })], { encoding: 'utf8' })));
  console.log(`| ${label} | ${(median(runs.map((r) => r.ms)) / 1000).toFixed(2)} s | ${median(runs.map((r) => r.peakMb)).toFixed(0)} MB | ${(runs[0].bytes / 1048576).toFixed(1)} MB |`);
}
