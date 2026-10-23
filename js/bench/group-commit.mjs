// Group commit (GitHub #275): N callers each add one row to a 10,000-row file, two ways:
//   append  one append() per caller, one after another (the event loop gets a turn between them)
//   writer  every caller at once through openWriter(), which merges them into as few appends as it can
// Each run is a process of its own (from a copy of the same 10,000-row file, after one untimed append that loads and
// warms the code, as in a running server) and reports the time until every row is on disk, rows per second, peak
// memory (maxRSS), the longest the event loop was blocked (Windows timers tick every ~16 ms: shorter blocks show as
// about that), and the appends written.
// Ways and runs take turns, so load from other work affects each way alike. Times depend on the disk: each append
// flushes twice (spec 11.2), so compare the ways with each other, from one sitting.
//
//   node bench/group-commit.mjs [--only append|writer] [--runs 5] [--callers 100] [--lib <path to index.js>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = fileURLToPath(import.meta.url);
const { values: args } = parseArgs({
  options: {
    only: { type: 'string' }, runs: { type: 'string', default: '5' }, callers: { type: 'string', default: '100' },
    lib: { type: 'string', default: path.join(path.dirname(here), '..', 'src', 'index.js') },
    child: { type: 'string' }, file: { type: 'string' },
  },
});
const callers = Number(args.callers);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'name', type: 'string' },
  { name: 'amount', type: 'float' },
];
const row = (id) => ({ id, name: `caller ${id}`, amount: id * 1.5 });

if (args.child) {
  // One run: the file is a fresh copy, so every run starts from the same 10,000 rows.
  const j = await import(pathToFileURL(path.resolve(args.lib)));
  const file = args.file;
  j.append(file, { insert: [row(-1)] }); // warm-up, not timed
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const start = process.hrtime.bigint();
  if (args.child === 'append') {
    for (let i = 0; i < callers; i++) {
      j.append(file, { insert: [row(10_000 + i)] });
      await new Promise((resolve) => setImmediate(resolve)); // other callers' turn
    }
  } else {
    const w = j.openWriter(file);
    await Promise.all(Array.from({ length: callers }, (_, i) => w.insert([row(10_000 + i)])));
    await w.close();
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  loop.disable();
  const r = j.open(file);
  const result = { ms, rowCount: r.rowCount - 1, appends: r.appendCount - 1, maxRssMb: process.resourceUsage().maxRSS / 1024, blockMs: loop.max / 1e6 };
  r.close();
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-group-commit-'));
try {
  const j = await import(pathToFileURL(path.resolve(args.lib)));
  const template = path.join(dir, 'template.jzm');
  j.write(template, Array.from({ length: 10_000 }, (_, i) => row(i)), { columns });
  const ways = args.only ? [args.only] : ['append', 'writer'];
  const results = Object.fromEntries(ways.map((w) => [w, []]));
  for (let run = 0; run < Number(args.runs); run++) {
    for (const way of run % 2 ? [...ways].reverse() : ways) { // take turns at going first
      const file = path.join(dir, `${way}-${run}.jzm`);
      fs.copyFileSync(template, file);
      const out = execFileSync(process.execPath, [here, '--child', way, '--file', file, '--callers', String(callers), '--lib', args.lib], { encoding: 'utf8' });
      const result = JSON.parse(out);
      if (result.rowCount !== 10_000 + callers) throw new Error(`${way}: ${result.rowCount} rows, expected ${10_000 + callers}`);
      results[way].push(result);
      fs.rmSync(file, { force: true });
    }
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`${callers} callers, one row each, into a 10,000-row file; ${args.runs} runs per way (median; min-max)`);
  console.log('way      time ms              rows/s     peak RSS MB        longest block ms     appends');
  for (const way of ways) {
    const rs = results[way];
    const cell = (key, digits) => {
      const xs = rs.map((r) => r[key]);
      return `${median(xs).toFixed(digits)} (${Math.min(...xs).toFixed(digits)}-${Math.max(...xs).toFixed(digits)})`;
    };
    const rate = median(rs.map((r) => (callers * 1000) / r.ms));
    console.log(`${way.padEnd(8)} ${cell('ms', 0).padEnd(20)} ${rate.toFixed(0).padEnd(10)} ${cell('maxRssMb', 1).padEnd(18)} ${cell('blockMs', 1).padEnd(20)} ${cell('appends', 0)}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
