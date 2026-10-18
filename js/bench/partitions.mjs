// Partitions benchmark (issue #258): a key that spans thousands of partitions. Writes N rows into P partitions (one per
// customer) and grants one access key every partition and another key one partition. Then, for each key, times open + one
// filter in the Node reader and in the browser reader (jazmin-browser.js under Node's WebCrypto), each run on a freshly
// opened reader. With --chrome, also in headless Chrome through the viewer, as a person uses it: unlock to the first
// page, a filter's first page and its count, and memory: the page's peak JavaScript heap (garbage included: V8 collects it
// late) and the heap it holds after a garbage collection once the count is shown, both above what the page held before the
// key was entered (Chrome keeps some of each earlier page load for a while, so the page's own figure creeps up).
// Two layouts of the same rows: grouped by customer (as USER-GUIDE 15.5 advises: one chunk per partition here) and
// interleaved (each row the next customer's: a chunk holds one partition, so every row is a chunk of its own). Writing
// is also timed for the same rows, encrypted, with no partitions.
// Run: node bench/partitions.mjs [partitions] [rows] [--layout grouped|interleaved] [--runs 3] [--chrome [path]]
//      (default 2,400 partitions, 600,000 rows, both layouts, 3 runs; files in the system's temp folder)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JazminKey, open, write } from '../src/index.js';

await import('../browser/jazmin-browser.js');

const js = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { layout: { type: 'string', multiple: true }, runs: { type: 'string', default: '3' }, chrome: { type: 'string' } },
  args: process.argv.slice(2).map((a, i, all) => (a === '--chrome' && (!all[i + 1] || all[i + 1].startsWith('--')) ? '--chrome=' : a)),
});
const PARTS = Number(positionals[0] ?? 2400);
const ROWS = Number(positionals[1] ?? 600_000);
const RUNS = Number(args.runs);
const LAYOUTS = args.layout ?? ['grouped', 'interleaved'];
const CHROME = args.chrome === undefined ? null
  : [args.chrome, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/pw-browsers/chromium']
    .find((p) => p && fs.existsSync(p));
if (args.chrome !== undefined && !CHROME) throw new Error('Chrome was not found: give its path after --chrome');

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const list = (values, digits = 0) => values.map((v) => v.toFixed(digits)).join(', ');
const customer = (i) => `C${String(i).padStart(5, '0')}`;
const columns = [{ name: 'customer', type: 'string' }, { name: 'id', type: 'int' }, { name: 'amount', type: 'decimal' }, { name: 'kind', type: 'string' }];
const FILTER = { kind: 'cash', amount: { gt: 90000 } };
function* rows(layout) {
  for (let i = 0; i < ROWS; i++) {
    const c = layout === 'grouped' ? Math.floor((i * PARTS) / ROWS) : i % PARTS;
    yield { customer: customer(c), id: i, amount: String((i * 37) % 100000), kind: i % 7 === 0 ? 'cash' : 'eft' };
  }
}
const seconds = (fn) => {
  const t = performance.now();
  fn();
  return (performance.now() - t) / 1000;
};
const mb = (file) => `${(fs.statSync(file).size / 1048576).toFixed(1)} MB`;

console.log(`Node ${process.version}, ${os.cpus()[0].model.trim()}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB, ${os.platform()}`);
const owner = JazminKey.generate();
const plain = path.join(os.tmpdir(), 'jazmin-bench-parts-none.jzm');
const unpartitioned = seconds(() => write(plain, rows('grouped'), { columns, key: owner }));
console.log(`write ${ROWS.toLocaleString('en-US')} rows, no partitions: ${unpartitioned.toFixed(1)} s (${mb(plain)})`);

const page = CHROME ? await viewer(CHROME) : null;
if (page) console.log(`${page.version}, headless, through the viewer`);
for (const layout of LAYOUTS) {
  const all = owner.createAccessKey();
  const one = owner.createAccessKey();
  const file = path.join(os.tmpdir(), `jazmin-bench-parts-${PARTS}-${layout}.jzm`);
  const took = seconds(() => write(file, rows(layout), {
    columns, key: owner,
    access: { partitionBy: 'customer', grants: [{ key: all, rows: Array.from({ length: PARTS }, (_, i) => customer(i)) }, { key: one, rows: [customer(0)] }] },
  }));
  const counted = open(file, { key: all.export() });
  const chunks = counted.chunkCount;
  counted.close();
  console.log(`\n${layout}: write into ${PARTS.toLocaleString('en-US')} partitions ${took.toFixed(1)} s (${mb(file)}, ${chunks.toLocaleString('en-US')} chunks)`);
  const bytes = new Uint8Array(fs.readFileSync(file));
  for (const [label, key] of [[`key spanning all ${PARTS} partitions`, all.export()], ['key for one partition', one.export()]]) {
    const node = [];
    const browser = [];
    let n;
    let bn;
    for (let run = 0; run < RUNS; run++) {
      let t = performance.now();
      const r = open(file, { key });
      n = r.count(FILTER);
      r.close();
      node.push(performance.now() - t);
      t = performance.now();
      const b = await globalThis.JazminBrowser.open(bytes, { key });
      bn = await b.count(FILTER);
      browser.push(performance.now() - t);
    }
    console.log(`  ${label}, open + count: Node reader ${median(node).toFixed(0)} ms (${list(node)}; ${n} rows) | browser reader in Node ${median(browser).toFixed(0)} ms (${list(browser)}; ${bn} rows)`);
    if (page) {
      const shown = [];
      for (let run = 0; run < RUNS; run++) shown.push(await page.measure(file, key));
      const field = (name) => shown.map((s) => s[name]);
      console.log(`  ${label}, Chrome viewer: first page ${median(field('first')).toFixed(0)} ms (${list(field('first'))}) | filter's first page ${median(field('page')).toFixed(0)} ms (${list(field('page'))}) | counted ${median(field('counted')).toFixed(0)} ms (${list(field('counted'))}; "${shown[0].status}") | peak JS heap +${median(field('heapMb')).toFixed(1)} MB (${list(field('heapMb'), 1)}), held after GC +${median(field('heldMb')).toFixed(1)} MB (${list(field('heldMb'), 1)})`);
    }
  }
  fs.rmSync(file, { force: true });
}
fs.rmSync(plain, { force: true });
await page?.close();

/** The viewer in headless Chrome, driven through the DevTools protocol (as scripts/viewer-e2e.mjs does). */
async function viewer(exe) {
  let served = null;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = name === '/file.jzm' ? served : path.join(js, name); // the file measured, or the viewer and browser reader
    if (!file || !file.startsWith(name === '/file.jzm' ? os.tmpdir() : js) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-bench-parts-chrome-'));
  const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--enable-precise-memory-info', '--disable-features=BackForwardCache', '--remote-debugging-port=0', `--user-data-dir=${profile}`];
  if (process.getuid?.() === 0) flags.push('--no-sandbox'); // Chrome refuses to run as root otherwise (containers)
  const proc = spawn(exe, [...flags, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
  }
  if (!port) throw new Error('Chrome did not start within 15 seconds');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (pending.has(msg.id)) pending.get(msg.id)(msg);
    pending.delete(msg.id);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value === undefined ? undefined : JSON.parse(result.value);
  };
  // In the page: when `condition` holds (checked every 5 ms), and the peak JS heap seen while waiting.
  const until = (condition) => `new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      window.jzPeak = Math.max(window.jzPeak || 0, performance.memory.usedJSHeapSize);
      if (${condition}) resolve(performance.now());
      else if (performance.now() - started > 600000) reject(new Error('Timed out: ' + document.getElementById('jz-data-status').textContent));
      else setTimeout(tick, 5);
    };
    tick();
  })`;
  const status = `document.getElementById('jz-data-status').textContent`;
  return {
    version: (await send('Browser.getVersion')).product,
    async measure(file, key) {
      served = file;
      await send('Page.navigate', { url: `${base}/viewer/index.html` });
      await evaluate(`new Promise((r) => { const t = () => (typeof JazminViewer === 'object' ? r(true) : setTimeout(t, 20)); t(); })`);
      await evaluate(`fetch('/file.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'file.jzm')).then(() => true)`);
      await evaluate(until(`document.getElementById('jz-unlock').hidden === false`));
      await send('HeapProfiler.collectGarbage');
      const before = await evaluate('performance.memory.usedJSHeapSize');
      await evaluate('(window.jzPeak = 0, true)');
      const t0 = await evaluate(`(document.getElementById('jz-key').value = ${JSON.stringify(key)}, document.getElementById('jz-unlock').requestSubmit(), performance.now())`);
      const t1 = await evaluate(until(`/ of /.test(${status})`));
      const t2 = await evaluate(`(document.getElementById('jz-filter').value = ${JSON.stringify(JSON.stringify(FILTER))}, document.getElementById('jz-filter-form').requestSubmit(), performance.now())`);
      const t3 = await evaluate(until(`/^Rows/.test(${status})`)); // the page shows ("Searching…" until then)
      const t4 = await evaluate(until(`/matching the filter|failed|stopped/.test(${status})`));
      const heapMb = ((await evaluate('window.jzPeak')) - before) / 1048576;
      await send('HeapProfiler.collectGarbage');
      const heldMb = ((await evaluate('performance.memory.usedJSHeapSize')) - before) / 1048576;
      return { first: t1 - t0, page: t3 - t2, counted: t4 - t2, heapMb, heldMb, status: await evaluate(status) };
    },
    async close() {
      ws.close();
      proc.kill();
      server.close();
      await new Promise((r) => setTimeout(r, 500));
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still in use */ }
    },
  };
}
