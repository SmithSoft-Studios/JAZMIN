// This library against the previous release, workload by workload (release checklist): each run in a process of its
// own, the two versions taking turns at going first, the median of --rounds runs of time and peak memory (maxRSS).
// Reads use one file both versions read (written by the previous release), so only the readers differ; writes and
// rewrites each make their own. Run it on a quiet machine: other work running alongside skews it.
//
//   node --expose-gc bench/compare-previous.mjs [--version 1.7.6] [--rows 500000] [--rounds 5] [--only "<workload>"]
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = fileURLToPath(import.meta.url);
const { values: args } = parseArgs({
  options: {
    version: { type: 'string', default: '1.7.6' }, rows: { type: 'string', default: '500000' }, rounds: { type: 'string', default: '5' },
    run: { type: 'string' }, workload: { type: 'string' }, dir: { type: 'string' }, only: { type: 'string' },
  },
});

const WORKLOADS = {
  // Reads (the priority): one file, written by the previous release.
  'open + count (index)': (j, d) => {
    const r = j.open(path.join(d, 'read.jzm'));
    const n = r.count({ country: 'ZA' });
    r.close();
    return n;
  },
  'find, text search (trigram)': (j, d) => {
    const r = j.open(path.join(d, 'read.jzm'));
    let n = 0;
    for (const x of r.find({ name: { contains: 'Ndlovu' } }, { limit: 5000 })) if (x) n++;
    r.close();
    return n;
  },
  'find, scan (no index)': (j, d) => {
    const r = j.open(path.join(d, 'read.jzm'));
    let n = 0;
    for (const x of r.find({ age: { gte: 80 } })) if (x) n++;
    r.close();
    return n;
  },
  'every row': (j, d) => {
    const r = j.open(path.join(d, 'read.jzm'));
    let n = 0;
    for (const x of r.rows()) if (x) n++;
    r.close();
    return n;
  },
  'column arrays (2 columns)': (j, d) => {
    const r = j.open(path.join(d, 'read.jzm'));
    const { rowCount } = r.columnArrays(null, { select: ['age', 'balance'] });
    r.close();
    return rowCount;
  },
  // Writes: each version its own file.
  write: (j, d, rows) => {
    j.write(path.join(d, `write-${process.pid}.jzm`), makeRows(rows), { columns: COLUMNS });
    return rows;
  },
  'update (insert, keeps order)': (j, d) => {
    const file = path.join(d, `update-${process.pid}.jzm`);
    fs.copyFileSync(path.join(d, 'read.jzm'), file);
    j.update(file, { insert: [{ id: -1, name: 'New', email: 'n@x', country: 'ZA', age: 30, balance: 1, joined: new Date(0), active: true }] });
    return 1;
  },
};

const COLUMNS = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' }, { name: 'name', type: 'string', index: 'trigram' },
  { name: 'email', type: 'string' }, { name: 'country', type: 'string', index: 'sorted' }, { name: 'age', type: 'int' },
  { name: 'balance', type: 'float' }, { name: 'joined', type: 'datetime' }, { name: 'active', type: 'bool' },
];
const countries = ['ZA', 'NA', 'BW', 'ZW', 'MZ', 'LS', 'SZ', 'ZM'];
const first = ['Ann', 'Bob', 'Thabo', 'Lerato', 'Pieter', 'Aisha', 'Sipho', 'Maria'];
const last = ['Smith', 'Johnson', 'Ndlovu', 'Botha', 'Naidoo', 'Mokoena', 'van Wyk', 'Dlamini'];
function* makeRows(n) {
  for (let i = 0; i < n; i++) {
    yield {
      id: i, name: `${first[i % 8]} ${last[(i * 7) % 8]}`, email: `user${i}@example.com`, country: countries[(i * 13) % 8],
      age: 18 + ((i * 31) % 70), balance: Math.round(((i * 7919) % 1_000_000) * 1.37) / 100,
      joined: new Date(Date.UTC(2015, 0, 1) + (i % 3650) * 86_400_000), active: i % 3 !== 0,
    };
  }
}

// ---- one run, in its own process -----------------------------------------------------------------------------------
if (args.run) {
  const j = await import(pathToFileURL(args.run).href);
  const started = performance.now();
  const result = WORKLOADS[args.workload](j, args.dir, Number(args.rows));
  const ms = performance.now() - started;
  process.stdout.write(JSON.stringify({ ms, rssMB: process.resourceUsage().maxRSS / 1024, result }));
  process.exit(0);
}

// ---- the comparison ----------------------------------------------------------------------------------------------
if (!/^\d+\.\d+\.\d+$/.test(args.version)) throw new Error(`--version is a release such as 1.6.2, not '${args.version}'`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-compare-'));
execSync(`npm install @smithsoft-studios/jazmin@${args.version} --prefix "${dir}" --no-audit --no-fund --silent`, { stdio: 'inherit' });
const previous = createRequire(path.join(dir, 'x.js')).resolve('@smithsoft-studios/jazmin');
const current = path.resolve(path.dirname(here), '../src/index.js');
const versions = [['previous', previous], ['this', current]];
const rows = Number(args.rows);
const rounds = Number(args.rounds);
{
  const j = await import(pathToFileURL(previous).href);
  j.write(path.join(dir, 'read.jzm'), makeRows(rows), { columns: COLUMNS });
}
const run = (lib, workload) => JSON.parse(execFileSync(process.execPath,
  ['--expose-gc', here, '--run', lib, '--workload', workload, '--dir', dir, '--rows', String(rows)], { encoding: 'utf8', maxBuffer: 1 << 20 }));
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

console.log(`${rows.toLocaleString('en')} rows, ${rounds} rounds; median time and peak memory (maxRSS). ${args.version} vs this version.\n`);
console.log('| Workload | ms before | ms now | change | MB before | MB now |');
console.log('|---|---|---|---|---|---|');
let slower = 0;
if (args.only && !WORKLOADS[args.only]) throw new Error(`No workload '${args.only}' (${Object.keys(WORKLOADS).join(', ')})`);
for (const workload of args.only ? [args.only] : Object.keys(WORKLOADS)) {
  const seen = { previous: [], this: [] };
  for (let round = 0; round < rounds; round++) {
    for (const [name, lib] of round % 2 ? [...versions].reverse() : versions) seen[name].push(run(lib, workload)); // who goes first takes turns
  }
  const results = new Set([...seen.previous, ...seen.this].map((x) => JSON.stringify(x.result)));
  if (results.size !== 1) throw new Error(`${workload}: the versions give different results: ${[...results].join(' / ')}`);
  const [before, now] = [median(seen.previous.map((x) => x.ms)), median(seen.this.map((x) => x.ms))];
  const [mbBefore, mbNow] = [median(seen.previous.map((x) => x.rssMB)), median(seen.this.map((x) => x.rssMB))];
  const change = (now - before) / before;
  if (change > 0.1) slower++;
  console.log(`| ${workload} | ${before.toFixed(1)} | ${now.toFixed(1)} | ${change >= 0 ? '+' : ''}${(change * 100).toFixed(0)}% | ${mbBefore.toFixed(0)} | ${mbNow.toFixed(0)} |`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(slower ? `\n${slower} workload(s) more than 10% slower: run again on a quiet machine before calling it a regression.` : '\nNone more than 10% slower.');
