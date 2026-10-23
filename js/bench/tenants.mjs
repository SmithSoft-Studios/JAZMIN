// One encrypted file per tenant (issue #275): each request opens its tenant's file with that tenant's key and looks up
// one row. Without a cache every request reads, decrypts and opens the file; with JazminReaderCache an open reader is
// leased instead, checked with changed() first.
// Run: node --expose-gc bench/tenants.mjs [--mode open|cache] [--tenants 1000] [--rows 500] [--passes 5] [--dir <folder>]
//      [--lib <path to src/index.js>]   (another copy of the library, to compare releases in the same sitting)
// Each run prints one JSON line. Run the modes in turn, several times, and compare the medians.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const mode = arg('mode', 'open');
const tenants = Number(arg('tenants', 1000));
const rows = Number(arg('rows', 500));
const passes = Number(arg('passes', 5));
const dir = arg('dir', path.join(os.tmpdir(), `jazmin-tenants-${tenants}x${rows}`));
const lib = await import(arg('lib') ? pathToFileURL(path.resolve(arg('lib'))).href : new URL('../src/index.js', import.meta.url).href);
const { JazminKey, write, open } = lib;

const file = (t) => path.join(dir, `tenant-${String(t).padStart(5, '0')}.jzm`);
const keysFile = path.join(dir, 'keys.json');
if (!fs.existsSync(keysFile)) {
  fs.mkdirSync(dir, { recursive: true });
  const columns = [
    { name: 'id', type: 'int', nullable: false, index: 'sorted' },
    { name: 'customer', type: 'string' },
    { name: 'amount', type: 'float' },
    { name: 'note', type: 'string' },
  ];
  const keys = [];
  for (let t = 0; t < tenants; t++) {
    const key = JazminKey.generate();
    keys.push(key.export());
    write(file(t), Array.from({ length: rows }, (_, i) => ({ id: i, customer: `C${t}-${i % 97}`, amount: i * 1.25, note: `Invoice ${t}/${i}` })), { columns, key });
  }
  fs.writeFileSync(keysFile, JSON.stringify(keys)); // made-up keys for a throwaway folder
}
const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8')).map((k) => JazminKey.parse(k));

let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
const order = () => {
  const list = Array.from({ length: tenants }, (_, t) => t);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
const memory = () => {
  globalThis.gc?.();
  globalThis.gc?.();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, external: m.external, rss: m.rss };
};

const cache = mode === 'cache' ? new lib.JazminReaderCache({ max: tenants }) : null;
let found = 0;
const request = (t) => {
  const id = Math.floor(random() * rows);
  if (cache) {
    const lease = cache.open(file(t), { key: keys[t] });
    try {
      for (const row of lease.reader.find({ id })) found += row.id === id ? 1 : 0;
    } finally {
      lease.release();
    }
  } else {
    const reader = open(file(t), { key: keys[t] });
    try {
      for (const row of reader.find({ id })) found += row.id === id ? 1 : 0;
    } finally {
      reader.close();
    }
  }
};

const before = memory();
const timings = [];
for (let p = 0; p < passes; p++) {
  const list = order();
  const start = performance.now();
  for (const t of list) request(t);
  timings.push((performance.now() - start) / tenants);
}
const after = memory();
if (found !== tenants * passes) throw new Error(`expected ${tenants * passes} rows, found ${found}`);
const warm = timings.slice(1).sort((a, b) => a - b);
console.log(JSON.stringify({
  mode, tenants, rows, node: process.version,
  firstPassMsPerRequest: +timings[0].toFixed(4),
  warmMsPerRequest: +warm[Math.floor(warm.length / 2)].toFixed(4), // median of the later passes
  retainedHeapKB: Math.round((after.heap - before.heap) / 1024),
  retainedExternalKB: Math.round((after.external - before.external) / 1024),
  rssMB: Math.round(after.rss / 1048576),
  peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
}));
cache?.close();
