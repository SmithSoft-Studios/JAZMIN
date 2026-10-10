// Viewer-from-disk benchmark (USER-GUIDE 24.4): what the viewer reads, how long it takes and how much memory the
// browser uses when a person opens a large .jzm from disk, in three ways:
//   1. the viewer's folder opened as it is (file://), the file picked in it;
//   2. the viewer in an iframe on a page of one's own, the file picked in the iframe;
//   3. the page picks the file and passes it to the viewer in its iframe (postMessage 'jazmin:open').
// Each way opens the file, filters it by id, then by a condition that reads every row. Bytes read: the slices the viewer
// takes of the file. Memory: the browser's processes (private memory on Windows, resident memory elsewhere), sampled a
// few times a second, above what they used before the file was picked: a second after the lookup, the peak while every
// row is read, and what is held after that. Chrome and Edge are driven through the DevTools protocol with plain settings, Firefox through
// WebDriver BiDi (no packages). The file is written once to the temp folder and reused.
// Run: node bench/viewer-disk.mjs [rows] [--browser chrome|edge|firefox ...]   (default 10,000,000 rows, about 200 MB)
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { write } from '../src/index.js';

const js = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { browser: { type: 'string', multiple: true } } });
const ROWS = Number(positionals[0] ?? 10_000_000);
const BROWSERS = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  firefox: ['C:/Program Files/Mozilla Firefox/firefox.exe', '/usr/bin/firefox', '/Applications/Firefox.app/Contents/MacOS/firefox'],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 2 : 0)} MB`;

// ---- the file: ROWS rows of 5 columns, a sorted index on id ---------------------------------------------------

const file = path.join(os.tmpdir(), `jazmin-bench-viewer-${ROWS}.jzm`);
if (!fs.existsSync(file)) {
  console.log(`Writing ${ROWS.toLocaleString('en-US')} rows to ${file} (once)...`);
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ');
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  function* rows() {
    for (let i = 0; i < ROWS; i++) {
      yield {
        id: i, name: `${words[rnd(20)]} ${words[rnd(20)]} ${i}`, country: ['ZA', 'NL', 'GB', 'US', 'DE'][rnd(5)], amount: rnd(100000) / 100,
        note: `${Array.from({ length: 6 }, () => words[rnd(20)]).join(' ')} #${rnd(1e9)}`,
      };
    }
  }
  const columns = [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }, { name: 'country', type: 'string' }, { name: 'amount', type: 'float' }, { name: 'note', type: 'string' }];
  write(`${file}.part`, rows(), { columns, indexes: { id: 'sorted' } });
  fs.renameSync(`${file}.part`, file);
}
const SIZE = fs.statSync(file).size;
const NAME = path.basename(file);

// ---- the pages, on disk: the viewer and the browser reader side by side, and a page with the viewer in an iframe ----

const site = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-bench-viewer-'));
fs.cpSync(path.join(js, 'viewer'), path.join(site, 'viewer'), { recursive: true });
fs.cpSync(path.join(js, 'browser'), path.join(site, 'browser'), { recursive: true });
fs.writeFileSync(path.join(site, 'page.html'), `<!doctype html>
<meta charset="utf-8">
<title>A page with the viewer</title>
<input id="pick" type="file" accept=".jzm">
<iframe id="viewer" src="viewer/index.html" title="JAZMIN viewer" style="width:100%;height:600px;border:0"></iframe>
<script>
  const frame = document.getElementById('viewer');
  window.statuses = [];
  addEventListener('message', (event) => {
    if (event.source === frame.contentWindow && event.data && event.data.type === 'jazmin:status') statuses.push(event.data);
  });
  document.getElementById('pick').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) frame.contentWindow.postMessage({ type: 'jazmin:open', file, name: file.name }, '*');
  });
</script>
`);

// In every frame: counts the slices taken of the file; frames report their totals to the top page, which adds them up.
const COUNTER = `(() => {
  const own = { id: Math.random(), bytes: 0, slices: 0, largest: 0, whole: 0 };
  const report = () => { if (window.top !== window) window.top.postMessage(Object.assign({ type: 'bench:read' }, own), '*'); };
  if (window.top === window) {
    const frames = new Map();
    addEventListener('message', (e) => { if (e.data && e.data.type === 'bench:read') frames.set(e.data.id, e.data); });
    window.benchRead = () => [own, ...frames.values()].reduce((t, r) => ({ bytes: t.bytes + r.bytes, slices: t.slices + r.slices,
      largest: Math.max(t.largest, r.largest), whole: t.whole + r.whole }), { bytes: 0, slices: 0, largest: 0, whole: 0 });
  }
  const slice = Blob.prototype.slice;
  Blob.prototype.slice = function (start, end, type) {
    const out = slice.call(this, start, end, type);
    if (this.size === ${SIZE}) { own.bytes += out.size; own.slices++; own.largest = Math.max(own.largest, out.size); report(); }
    return out;
  };
  for (const m of ['arrayBuffer', 'bytes', 'text', 'stream']) {
    const f = Blob.prototype[m];
    if (f) Blob.prototype[m] = function (...a) { if (this.size === ${SIZE}) { own.whole++; report(); } return f.apply(this, a); };
  }
})();`;

// ---- browsers: a top page and its first iframe, each with evaluate(expression) and pick(selector, file) ----------

async function chromium(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-bench-viewer-cr-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
  }
  if (!port) throw new Error(`${path.basename(exe)} did not start`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const contexts = new Map(); // frame id -> its page's (default) execution context
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.executionContextCreated' && msg.params.context.auxData?.isDefault) {
      contexts.set(msg.params.context.auxData.frameId, msg.params.context.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNTER });
  const frameId = async (child) => {
    const { frameTree } = await send('Page.getFrameTree');
    return child ? frameTree.childFrames?.[0]?.frame.id : frameTree.frame.id;
  };
  const target = (child) => ({
    async evaluate(expression) {
      const contextId = contexts.get(await frameId(child));
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, contextId, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value === undefined ? undefined : JSON.parse(result.value);
    },
    async pick(selector, path_) {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
      let doc = root;
      if (child) {
        const want = await frameId(true);
        const find = (n) => (n.frameId === want && n.contentDocument ? n.contentDocument : (n.children ?? []).map(find).find(Boolean));
        doc = find(root);
      }
      const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector });
      await send('DOM.setFileInputFiles', { files: [path_], nodeId });
    },
  });
  return {
    pid: proc.pid,
    top: target(false),
    frame: target(true),
    async navigate(url) {
      await send('Page.navigate', { url });
      await sleep(500);
    },
    async close() {
      ws.close();
      proc.kill();
      await sleep(500);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function firefox(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-bench-viewer-ff-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, ['--headless', `--remote-debugging-port=${port}`, '--profile', profile, '--no-remote', 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 150 && !ws; i++) {
    await sleep(200);
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      ws = socket;
    } catch { /* not listening yet */ }
  }
  if (!ws) throw new Error('Firefox did not start WebDriver BiDi');
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.type === 'error' ? reject(new Error(`${method}: ${m.error} ${m.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('session.new', { capabilities: {} });
  await send('script.addPreloadScript', { functionDeclaration: `() => { ${COUNTER} }` });
  const top = (await send('browsingContext.getTree', {})).contexts[0].context;
  const contextOf = async (child) => (child ? (await send('browsingContext.getTree', { root: top })).contexts[0].children?.[0]?.context : top);
  const target = (child) => ({
    async evaluate(expression) {
      const r = await send('script.evaluate', {
        expression: `(async () => JSON.stringify(await (${expression})))()`, target: { context: await contextOf(child) }, awaitPromise: true, resultOwnership: 'none',
      });
      if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
      return r.result.type === 'string' ? JSON.parse(r.result.value) : undefined;
    },
    async pick(selector, path_) {
      const context = await contextOf(child);
      const r = await send('script.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, target: { context }, awaitPromise: false, resultOwnership: 'root' });
      await send('input.setFiles', { context, element: { sharedId: r.result.sharedId }, files: [path_] });
    },
  });
  return {
    pid: proc.pid,
    top: target(false),
    frame: target(true),
    async navigate(url) {
      await send('browsingContext.navigate', { context: top, url, wait: 'complete' });
    },
    async close() {
      await send('session.end').catch(() => {});
      ws.close();
      proc.kill();
      await sleep(800);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// ---- memory: the browser's process and its children, a few times a second -----------------------------------

function sampleMemory(pid) {
  const samples = []; // [time, bytes]
  if (process.platform === 'win32') {
    const script = `$root = ${pid}
      while ($true) {
        $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
        $ids = New-Object 'System.Collections.Generic.HashSet[int]'
        [void]$ids.Add($root)
        do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added)
        $sum = (Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum
        [Console]::Out.WriteLine("$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()),$sum")
        Start-Sleep -Milliseconds 100
      }`;
    const ps = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let rest = '';
    ps.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) if (line) samples.push(line.split(',').map(Number));
    });
    return { samples, stop: () => ps.kill() };
  }
  const timer = setInterval(() => execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], (error, out) => {
    if (error) return;
    const all = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const ids = new Set([pid]);
    for (let added = true; added;) {
      added = false;
      for (const [p, parent] of all) if (ids.has(parent) && !ids.has(p)) { ids.add(p); added = true; }
    }
    samples.push([Date.now(), all.filter(([p]) => ids.has(p)).reduce((s, [, , rss]) => s + rss * 1024, 0)]);
  }), 200);
  return { samples, stop: () => clearInterval(timer) };
}

// ---- the measurements ----------------------------------------------------------------------------------------

async function waitFor(target, expression, what, ms = 300000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const value = await target.evaluate(expression).catch(() => null);
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const WAYS = [
  { label: '1 viewer opened from disk', url: 'viewer/index.html', frame: false, picker: '#jz-input' },
  { label: '2 viewer in an iframe, picked in it', url: 'page.html', frame: true, picker: '#jz-input' },
  { label: '3 page passes the file to the viewer', url: 'page.html', frame: true, picker: '#pick', fromPage: true },
];
const ID = Math.floor(ROWS * 0.765);
const chosen = args.browser ?? Object.keys(BROWSERS);
console.log(`${NAME}: ${ROWS.toLocaleString('en-US')} rows, ${MB(SIZE)}; ${os.cpus()[0].model.trim()}, ${os.platform()} ${os.release()}\n`);
console.log('browser  way                                    open (read)            id filter (read)      reads every row (read, largest piece)       memory: after lookup / peak reading every row / held');
for (const name of chosen) {
  const exe = BROWSERS[name]?.find((p) => fs.existsSync(p));
  if (!exe) {
    console.log(`${name.padEnd(8)} (not installed)`);
    continue;
  }
  for (const way of WAYS) {
    const browser = await (name === 'firefox' ? firefox : chromium)(exe);
    const memory = sampleMemory(browser.pid);
    try {
      await browser.navigate(pathToFileURL(path.join(site, way.url)).href);
      const viewer = way.frame ? browser.frame : browser.top;
      await waitFor(viewer, `typeof JazminViewer === 'object'`, 'the viewer');
      await sleep(2500);
      const before = memory.samples.at(-1)?.[1] ?? 0;
      const read = async () => (await sleep(150), browser.top.evaluate('benchRead()'));
      const t0 = Date.now();
      await (way.fromPage ? browser.top : viewer).pick(way.picker, file);
      await waitFor(viewer, `JazminViewer.state.name === ${JSON.stringify(NAME)} && JazminViewer.state.total > 0`, 'the first rows');
      if (way.fromPage) await waitFor(browser.top, `statuses.some((s) => s.state === 'opened')`, 'the opened status');
      const openMs = Date.now() - t0;
      const opened = await read();
      const filter = async (text) => {
        const prev = await viewer.evaluate(`document.getElementById('jz-data-status').textContent`);
        const t = Date.now();
        await viewer.evaluate(`(document.getElementById('jz-filter').value = ${JSON.stringify(text)}, document.getElementById('jz-filter-form').requestSubmit(), true)`);
        await waitFor(viewer, `((s) => s.includes('matching the filter') && s !== ${JSON.stringify(prev)})(document.getElementById('jz-data-status').textContent)`, `the filter ${text}`);
        return Date.now() - t;
      };
      const idMs = await filter(`{ "id": ${ID} }`);
      const byId = await read();
      await sleep(1000);
      const afterLookup = (memory.samples.at(-1)?.[1] ?? before) - before;
      const t2 = Date.now();
      const scanMs = await filter('{ "country": "ZA", "amount": { "gt": 999 } }');
      const scanned = await read();
      const t1 = Date.now();
      await sleep(2500);
      const during = memory.samples.filter(([t]) => t >= t2 && t <= t1 + 500).map(([, b]) => b);
      const peak = Math.max(before, ...during) - before;
      const held = (memory.samples.at(-1)?.[1] ?? before) - before;
      const whole = scanned.whole ? `, ${scanned.whole} whole-file read(s)` : '';
      console.log(`${name.padEnd(8)} ${way.label.padEnd(38)} ${`${openMs} ms (${MB(opened.bytes)})`.padEnd(22)} ${`${idMs} ms (${MB(byId.bytes - opened.bytes)})`.padEnd(21)} ${`${scanMs} ms (${MB(scanned.bytes - byId.bytes)}, ${Math.round(scanned.largest / 1024)} KB${whole})`.padEnd(43)} ${MB(Math.max(0, afterLookup))} / ${MB(peak)} / ${MB(Math.max(0, held))}`);
    } catch (error) {
      console.log(`${name.padEnd(8)} ${way.label.padEnd(38)} FAILED: ${error.message.split('\n')[0]}`);
    } finally {
      memory.stop();
      await browser.close();
    }
  }
}
fs.rmSync(site, { recursive: true, force: true });
console.log(`\nThe file is kept for the next run: ${file}`);
