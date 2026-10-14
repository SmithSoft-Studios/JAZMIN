// Links benchmark: what checkLinks() costs - time and peak memory - for 1,000,000 orders linked to 50,000 customers,
// once with both tables sorted by the link (walked side by side) and once unsorted (the customers' keys held). Each run
// is in its own process; peak memory is the process's peak resident memory above what it used before; time is the median
// of 3 runs. Run: node bench/links.mjs   (the files are made once, in the system's temp folder, and kept)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JazminWriter, open } from '../src/index.js';

const RUNS = 3;
const here = fileURLToPath(import.meta.url);
const dir = path.join(os.tmpdir(), 'jazmin-links-bench');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if (process.argv[2] === '--run') {
  const file = process.argv[3];
  const before = process.memoryUsage().rss;
  const start = process.hrtime.bigint();
  const reader = open(file);
  const [check] = reader.checkLinks();
  reader.close();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  process.stdout.write(JSON.stringify({ ms, peakMb: Math.max(0, process.resourceUsage().maxRSS * 1024 - before) / 1048576, check }));
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
const customer = (i) => `C${String(i).padStart(5, '0')}`;
const make = (name, sorted) => {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  const writer = new JazminWriter(`${file}.tmp`, {
    tables: [
      { name: 'customers', columns: [{ name: 'customer', type: 'string' }, { name: 'name', type: 'string' }], ...(sorted ? { sortedBy: ['customer'] } : {}) },
      { name: 'orders', columns: [{ name: 'id', type: 'int' }, { name: 'customer', type: 'string' }, { name: 'amount', type: 'decimal' }], ...(sorted ? { sortedBy: ['customer', 'id'] } : {}) },
    ],
    links: [{ name: 'customer', from: { table: 'orders', columns: ['customer'] }, to: { table: 'customers', columns: ['customer'] } }],
  });
  for (let c = 0; c < 50_000; c++) writer.writeRow({ customer: customer(c), name: `Customer ${c}` });
  writer.startTable('orders');
  // 1,000,000 orders, 20 per customer (one in 1,000 for a customer that isn't there).
  for (let i = 0; i < 1_000_000; i++) {
    const c = sorted ? Math.floor(i / 20) : (i * 7919) % 50_000;
    // A customer that isn't there sorts just after the real one: the last of each of its orders in sorted files.
    writer.writeRow({ id: i, customer: i % 1000 === 999 ? `${customer(c)}x` : customer(c), amount: `${i % 1000}.50` });
  }
  writer.finish();
  fs.renameSync(`${file}.tmp`, file); // made in full, or not at all
  return file;
};
const sorted = make('sorted.jzm', true);
const unsorted = make('unsorted.jzm', false);

console.log(`Links benchmark - Node ${process.version}, ${os.cpus()[0].model}; 1,000,000 orders linked to 50,000 customers\n`);
console.log('| Tables | Method | Time | Peak memory | Missing |');
console.log('|---|---|---:|---:|---:|');
for (const [label, file] of [['Both sorted by customer', sorted], ['Unsorted', unsorted]]) {
  const runs = Array.from({ length: RUNS }, () => JSON.parse(execFileSync(process.execPath, [here, '--run', file], { encoding: 'utf8' })));
  console.log(`| ${label} | ${runs[0].check.method} | ${(median(runs.map((r) => r.ms)) / 1000).toFixed(2)} s | ${median(runs.map((r) => r.peakMb)).toFixed(0)} MB | ${runs[0].check.missing.toLocaleString('en')} |`);
}
