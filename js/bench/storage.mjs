// Storage benchmark: what reader.storage() costs - time and peak memory - beside opening the file, for a file of
// 1,000,000 rows (two sorted indexes), the same file after 200 appends (inserts and deletes), and shared files of
// 250,000 rows in 1,000 partitions (owner key): one written partition by partition, and one with the partitions'
// rows interleaved, which leaves a chunk per row (the worst case, which storage() exists to point out). Each measurement runs in its own process: peak memory is the process's
// peak resident memory above what it used before, on the first run; time is the median of 5 more runs, each with a
// newly opened reader.
// Run: node bench/storage.mjs            (the files are made once, in the system's temp folder, and kept)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JazminKey, append, open, write } from '../src/index.js';

const RUNS = 5;
const here = fileURLToPath(import.meta.url);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const msSince = (start) => Number(process.hrtime.bigint() - start) / 1e6;

if (process.argv[2] === '--run') {
  const { file, key, what } = JSON.parse(process.argv[3]);
  const before = process.memoryUsage().rss;
  const once = () => {
    const start = process.hrtime.bigint();
    const reader = open(file, { key });
    if (what === 'storage') reader.storage();
    reader.close();
    return msSince(start);
  };
  once();
  const peak = process.resourceUsage().maxRSS * 1024 - before;
  const ms = median(Array.from({ length: RUNS }, once));
  const reader = open(file, { key });
  const s = what === 'storage' ? reader.storage() : null;
  reader.close();
  process.stdout.write(JSON.stringify({ ms, peakMb: Math.max(0, peak) / 1048576, s }));
  process.exit(0);
}

const dir = path.join(os.tmpdir(), 'jazmin-storage-bench');
fs.mkdirSync(dir, { recursive: true });
const keyFile = path.join(dir, 'key.txt');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, JazminKey.generate().export());
const key = JazminKey.from(fs.readFileSync(keyFile, 'utf8'));
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'customer', type: 'string', index: 'sorted' },
  { name: 'amount', type: 'decimal' },
  { name: 'note', type: 'string' },
];
const row = (i) => ({ id: i, customer: `C${String(i % 5000).padStart(5, '0')}`, amount: `${i % 1000}.25`, note: `order ${i}` });

const big = path.join(dir, 'big.jzm');
if (!fs.existsSync(big)) write(big, Array.from({ length: 1_000_000 }, (_, i) => row(i)), { columns, key, sortedBy: ['id'] });
const appended = path.join(dir, 'appended.jzm');
if (!fs.existsSync(appended)) {
  fs.copyFileSync(big, appended);
  for (let a = 0; a < 200; a++) {
    const first = 1_000_000 + a * 50;
    append(appended, { key, insert: Array.from({ length: 50 }, (_, i) => row(first + i)), delete: { id: { in: Array.from({ length: 20 }, (_, i) => a * 1000 + i) } } });
  }
}
const ownerKeyFile = path.join(dir, 'owner.txt');
if (!fs.existsSync(ownerKeyFile)) fs.writeFileSync(ownerKeyFile, JazminKey.generate().export());
const owner = JazminKey.from(fs.readFileSync(ownerKeyFile, 'utf8'));
const sharedFile = (name, regionOf) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    write(file, Array.from({ length: 250_000 }, (_, i) => ({ ...row(i), region: `R${String(regionOf(i)).padStart(4, '0')}` })), {
      columns: [...columns, { name: 'region', type: 'string' }], key: owner,
      access: { partitionBy: 'region', grants: [{ key: owner.createAccessKey(), rows: ['R0000'] }] },
    });
  }
  return file;
};
const shared = sharedFile('shared.jzm', (i) => Math.floor(i / 250));
const interleaved = sharedFile('interleaved.jzm', (i) => i % 1000);

const measure = (file, keyText, what) => JSON.parse(execFileSync(process.execPath, [here, '--run', JSON.stringify({ file, key: keyText, what })], { encoding: 'utf8', maxBuffer: 1 << 26 }));
console.log(`Storage benchmark - Node ${process.version}, ${os.cpus()[0].model}\n`);
console.log('| File | Size | open() | open() + storage() | storage() alone | Unused | Deleted rows |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const [label, file, k] of [['1,000,000 rows', big, key], ['the same after 200 appends', appended, key], ['shared, 250,000 rows in 1,000 partitions', shared, owner], ['the same, partitions interleaved (250,000 chunks)', interleaved, owner]]) {
  const opened = measure(file, k.export(), 'open');
  const stored = measure(file, k.export(), 'storage');
  const mb = (x) => `${x.toFixed(1)} MB`;
  console.log(`| ${label} | ${(fs.statSync(file).size / 1048576).toFixed(1)} MB | ${opened.ms.toFixed(1)} ms, ${mb(opened.peakMb)} | ${stored.ms.toFixed(1)} ms, ${mb(stored.peakMb)} | ${(stored.ms - opened.ms).toFixed(1)} ms | ${stored.s.unusedBytes.toLocaleString('en')} B | ${stored.s.deletedRows.toLocaleString('en')} |`);
}
