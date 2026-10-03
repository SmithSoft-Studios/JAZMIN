// Scenario benchmark: a large JSON file of statement lines, consumed one section at a time
// (e.g. one Puppeteer PDF per section). Compares re-loading the JSON per section with
// opening a JAZMIN file once and fetching sections on demand.
//
// Run: node bench/sections.js [targetMB=300] [sections=5000]
// Each phase runs in a separate process so its peak memory (max RSS) is measured in isolation.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importJSONFile, open, readJsonObjects } from '../src/index.js';

const self = fileURLToPath(import.meta.url);
const [, , arg1, arg2, arg3] = process.argv;
const PHASES = new Set(['generate', 'json', 'json-stream', 'import', 'import-indexed', 'jazmin', 'jazmin-indexed', 'jazmin-scan']);

const sectionId = (s) => `ACC${String(s).padStart(6, '0')}`;
const peakMb = () => Math.round(process.resourceUsage().maxRSS / 1024);
const report = (data) => process.stdout.write(JSON.stringify({ ...data, peakMb: peakMb() }));

function sampleSections(sections, count) {
  const step = Math.max(1, Math.floor(sections / count));
  return Array.from({ length: Math.min(count, sections) }, (_, i) => sectionId(i * step));
}

// ---------------------------------------------------------------------------------------
// Child-process phases
// ---------------------------------------------------------------------------------------
if (PHASES.has(arg1)) {
  const dir = arg2;
  const sections = Number(arg3);
  const json = path.join(dir, 'statements.json');
  const start = performance.now();

  switch (arg1) {
    case 'generate': {
      // Written in pieces - the generator itself never holds the file in memory.
      const targetBytes = Number(process.argv[5]) * 1024 * 1024;
      const fd = fs.openSync(json, 'w');
      let bytes = 0;
      let rows = 0;
      let buffer = '[';
      const words = ['Payment received', 'Debit order', 'Card purchase', 'Interest', 'Service fee', 'Transfer to savings'];
      // Lines are grouped by section, as statement data normally is.
      const linesPerSection = Math.ceil(targetBytes / 230 / sections);
      for (let s = 0; s < sections; s++) {
        let balance = 10_000;
        for (let l = 0; l < linesPerSection; l++) {
          const amount = ((s * 7919 + l * 104729) % 500_000) / 100;
          balance += l % 3 === 0 ? amount : -amount;
          const line = {
            section: sectionId(s),
            client: `Client ${s} Holdings (Pty) Ltd`,
            line: l,
            date: new Date(Date.UTC(2025, 0, 1) + l * 3_600_000 * 7).toISOString(),
            description: `${words[(s + l) % words.length]} ref ${(s * 1000 + l).toString(36).toUpperCase()}`,
            amount: Number(amount.toFixed(2)),
            balance: Number(balance.toFixed(2)),
            category: words[(s * 3 + l) % words.length].split(' ')[0],
          };
          buffer += (rows === 0 ? '' : ',') + JSON.stringify(line);
          rows++;
          if (buffer.length > 1 << 20) {
            bytes += fs.writeSync(fd, buffer);
            buffer = '';
          }
        }
      }
      bytes += fs.writeSync(fd, buffer + ']');
      fs.closeSync(fd);
      report({ rows, mb: Math.round(bytes / 1048576), ms: performance.now() - start });
      break;
    }
    case 'json': {
      // The old approach: every section needs the whole file read and parsed again.
      const iterations = 3;
      const times = [];
      let found = 0;
      for (const id of sampleSections(sections, iterations)) {
        const t = performance.now();
        found += JSON.parse(fs.readFileSync(json, 'utf8')).filter((r) => r.section === id).length;
        times.push(performance.now() - t);
      }
      report({ msPerSection: times.reduce((a, b) => a + b) / times.length, linesPerSection: found / iterations });
      break;
    }
    case 'json-stream': {
      // Streaming JSON: low memory, but must read from the start until the section has passed.
      const probes = { first: sectionId(0), middle: sectionId(Math.floor(sections / 2)), last: sectionId(sections - 1) };
      const result = {};
      for (const [name, id] of Object.entries(probes)) {
        const t = performance.now();
        const lines = [];
        for (const row of readJsonObjects(json)) {
          if (row.section === id) lines.push(row);
          else if (lines.length) break; // section passed (rows are grouped)
        }
        result[name] = performance.now() - t;
      }
      const t = performance.now();
      let n = 0;
      for (const _ of readJsonObjects(json)) n++;
      result.fullScan = performance.now() - t;
      report(result);
      break;
    }
    case 'jazmin-scan': {
      const t = performance.now();
      const reader = open(path.join(dir, 'import.jzm'));
      let n = 0;
      for (const _ of reader.rows()) n++;
      reader.close();
      report({ fullScan: performance.now() - t });
      break;
    }
    case 'import':
    case 'import-indexed': {
      const target = path.join(dir, `${arg1}.jzm`);
      importJSONFile(json, target, arg1 === 'import-indexed' ? { indexes: { section: 'sorted' } } : {});
      report({ ms: performance.now() - start, mb: Math.round(fs.statSync(target).size / 1048576 * 10) / 10 });
      break;
    }
    case 'jazmin':
    case 'jazmin-indexed': {
      const file = path.join(dir, `${arg1 === 'jazmin' ? 'import' : 'import-indexed'}.jzm`);
      const openStart = performance.now();
      const reader = open(file);
      const openMs = performance.now() - openStart;
      const ids = sampleSections(sections, sections); // every section, start to finish
      const times = [];
      let lines = 0;
      for (const id of ids) {
        const t = performance.now();
        for (const _ of reader.find({ section: id })) lines++;
        times.push(performance.now() - t);
      }
      reader.close();
      times.sort((a, b) => a - b);
      report({
        openMs,
        sectionsRead: ids.length,
        totalMs: performance.now() - start,
        msPerSection: times.reduce((a, b) => a + b) / times.length,
        p99Ms: times[Math.floor(times.length * 0.99)],
        linesPerSection: lines / ids.length,
      });
      break;
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------------------
// Parent: run phases and print the comparison
// ---------------------------------------------------------------------------------------
const targetMb = Number(arg1 ?? 300);
const sections = Number(arg2 ?? 5000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-sections-'));

// The JSON phase gets a large heap so it can finish at all. JAZMIN phases run with a small heap
// cap and a small young generation (--max-semi-space-size): on machines with plenty of RAM,
// Node otherwise lets short-lived garbage grow to ~150 MB before collecting, which inflates
// peak memory without being needed. Both are standard Node flags you can use in production.
const HEAP_MB = { generate: 8192, json: 8192, 'json-stream': 64, 'jazmin-scan': 64, import: 64, 'import-indexed': 128, jazmin: 32, 'jazmin-indexed': 64 };
const SEMI_SPACE_MB = 2;

function run(phase, extra = []) {
  const flags = [`--max-old-space-size=${HEAP_MB[phase]}`];
  if (HEAP_MB[phase] < 1024) flags.push(`--max-semi-space-size=${SEMI_SPACE_MB}`);
  const result = spawnSync(process.execPath, [...flags, self, phase, dir, String(sections), ...extra], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  if (result.status !== 0) throw new Error(`${phase} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(ms < 10 ? 2 : 0)} ms`);
try {
  console.log(`Generating ~${targetMb} MB of statement JSON in ${sections} sections...`);
  const gen = run('generate', [String(targetMb)]);
  const json = run('json');
  const imp = run('import');
  const impIx = run('import-indexed');
  const jz = run('jazmin');
  const jzIx = run('jazmin-indexed');
  const stream = run('json-stream');
  const scan = run('jazmin-scan');

  const rows = [
    ['Input', `${gen.mb} MB JSON, ${gen.rows.toLocaleString()} lines, ${sections} sections (~${Math.round(json.linesPerSection)} lines each)`],
    ['', ''],
    ['OLD: load JSON per section', `${fmt(json.msPerSection)} per section, peak memory ${json.peakMb} MB`],
    ['OLD: projected for all sections', fmt(json.msPerSection * sections)],
    ['', ''],
    ['Convert JSON -> JAZMIN (streaming, once)', `${fmt(imp.ms)}, peak memory ${imp.peakMb} MB (heap cap ${HEAP_MB.import} MB), file ${imp.mb} MB`],
    ['  ...with a section index', `${fmt(impIx.ms)}, peak memory ${impIx.peakMb} MB (heap cap ${HEAP_MB['import-indexed']} MB), file ${impIx.mb} MB`],
    ['', ''],
    ['NEW: open once', `${fmt(jz.openMs)} (header only)`],
    ['NEW: per section (chunk statistics)', `${fmt(jz.msPerSection)} avg, ${fmt(jz.p99Ms)} p99`],
    ['NEW: all sections, start to finish', `${fmt(jz.totalMs)}, peak memory ${jz.peakMb} MB (heap cap ${HEAP_MB.jazmin} MB)`],
    ['NEW: per section (sorted index)', `${fmt(jzIx.msPerSection)} avg, ${fmt(jzIx.p99Ms)} p99`],
    ['NEW: all sections with index', `${fmt(jzIx.totalMs)}, peak memory ${jzIx.peakMb} MB (heap cap ${HEAP_MB['jazmin-indexed']} MB)`],
    ['', ''],
    ['STREAMING JSON: first section', fmt(stream.first)],
    ['STREAMING JSON: middle section', fmt(stream.middle)],
    ['STREAMING JSON: last section', `${fmt(stream.last)}, peak memory ${stream.peakMb} MB`],
    ['STREAMING JSON: projected for all sections', `${fmt(stream.middle * sections)} (each section re-reads up to its position)`],
    ['Full sequential read: streaming JSON', fmt(stream.fullScan)],
    ['Full sequential read: JAZMIN rows()', `${fmt(scan.fullScan)}, peak memory ${scan.peakMb} MB`],
  ];
  console.log(`\nJAZMIN sections benchmark - Node ${process.version}, ${os.cpus()[0].model}`);
  console.log(`(an idle Node process peaks at ~${Math.round(process.resourceUsage().maxRSS / 1024)} MB; JAZMIN phases use --max-semi-space-size=${SEMI_SPACE_MB})\n`);
  const width = Math.max(...rows.map(([l]) => l.length));
  for (const [label, value] of rows) console.log(label ? `${label.padEnd(width)}  ${value}` : '');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
