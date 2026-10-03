// End-to-end check of the viewer (TASKS F-2) in real browsers: opens the embedded-files fixtures written by both
// libraries with each kind of key, checks the data, the files and the rendered document, then saves the page as one
// HTML file and opens that copy from disk. Drives Chrome and Edge through the DevTools protocol and Firefox through
// WebDriver BiDi (Node 22+, no packages).
//   node scripts/viewer-e2e.mjs [--browser chrome|edge|firefox ...]   (default: every browser found)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { JazminAccessKey, JazminKey, issueUnlockToken, write } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = path.join(root, 'spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const { values: args } = parseArgs({ options: { browser: { type: 'string', multiple: true } } });
const BROWSERS = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  firefox: ['C:/Program Files/Mozilla Firefox/firefox.exe', '/usr/bin/firefox', '/Applications/Firefox.app/Contents/MacOS/firefox'],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What each key sees in the files fixtures (mirrors FILES_VIEWS in js/test/fixture-helpers.js).
const FILES = {
  key: ['docs/shared.bin', 'docs/za.bin', 'empty.txt', 'img/logo.svg', 'index.html'],
  bob: ['docs/za.bin', 'empty.txt', 'img/logo.svg', 'index.html'],
  sally: ['docs/shared.bin', 'empty.txt', 'index.html'],
  carol: ['docs/shared.bin', 'docs/za.bin', 'empty.txt', 'index.html'],
};
const CASES = [];
for (const writer of ['js', 'dotnet']) {
  CASES.push({ file: `${writer}-files-key.jzm`, key: 'key', files: FILES.key });
  for (const key of ['key', 'bob', 'sally', 'carol']) CASES.push({ file: `${writer}-files-access.jzm`, key, files: FILES[key] });
}

// A package whose template uses the API: count, a sorted page of rows (queried in the viewer), all rows, and ready().
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-viewer-e2e-files-'));
const templateKey = JazminKey.generate();
write(path.join(temp, 'template.jzm'), Array.from({ length: 120 }, (_, n) => ({ n, label: `row ${n}` })), {
  columns: [{ name: 'n', type: 'int' }, { name: 'label', type: 'string' }],
  key: templateKey,
  files: [
    { path: 'index.html', content: '<!doctype html><title>Template</title><body><p id="out">…</p><script src="js/app.js"></script></body>' },
    {
      path: 'js/app.js',
      content: `(async () => {
        const total = await jazmin.count();
        const top = (await jazmin.query({ n: { gte: 100 } }, { orderBy: '-n', limit: 3, select: ['n'] })).map((r) => r.n);
        document.getElementById('out').textContent = 'JAZMIN interop template: ' + total + ' rows';
        jazmin.ready({ total, top, all: jazmin.rows().length, columns: jazmin.columns.map((c) => c.name) });
      })();`,
    },
  ],
  package: { entry: 'index.html', title: 'Template' },
});

// ---- a static server for the repository (the viewer, the browser reader and the fixtures) ----------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [dirOf, rel] = pathname.startsWith('/e2e/') ? [temp, pathname.slice(5)] : [root, pathname];
  const file = path.join(dirOf, rel);
  if (!file.startsWith(dirOf) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- browser drivers: navigate and evaluate (an expression whose value is returned as JSON) ----------------
async function launchChromium(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-viewer-e2e-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
  }
  if (!port) {
    proc.kill();
    throw new Error(`${path.basename(exe)} did not start within 15 seconds`);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  return {
    problems,
    async navigate(url) {
      await send('Page.navigate', { url });
      await sleep(300);
    },
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value === undefined ? undefined : JSON.parse(result.value);
    },
    async close() {
      ws.close();
      proc.kill();
      await sleep(500);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function launchFirefox(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-viewer-e2e-ff-'));
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
  const problems = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'log.entryAdded' && msg.params.level === 'error') {
      problems.push(msg.params.text);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.type === 'error' ? reject(new Error(`${method}: ${m.error} ${m.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('session.new', { capabilities: {} });
  await send('session.subscribe', { events: ['log.entryAdded'] });
  const { contexts } = await send('browsingContext.getTree', {});
  const context = contexts[0].context;
  return {
    problems,
    async navigate(url) {
      await send('browsingContext.navigate', { context, url, wait: 'complete' });
    },
    async evaluate(expression) {
      const r = await send('script.evaluate', {
        expression: `(async () => JSON.stringify(await (${expression})))()`, target: { context }, awaitPromise: true, resultOwnership: 'none',
      });
      if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
      return r.result.type === 'string' ? JSON.parse(r.result.value) : undefined;
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

// ---- the checks ----------------------------------------------------------------------------------------
const waitFor = async (page, expression, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const value = await page.evaluate(expression);
    if (value) return value;
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** What the viewer shows: rows on the first page, the data status line, the files and the document's text. */
const SHOWN = `({
  rows: document.querySelectorAll('#jz-rows tbody tr').length,
  data: document.getElementById('jz-data-status').textContent,
  files: [...document.querySelectorAll('#jz-files .path')].map((e) => e.textContent),
  document: (JazminViewer.state.lastShown || {}).text || '',
  error: document.getElementById('jz-error').textContent,
  status: document.getElementById('jz-status').textContent,
})`;

/** Types the key (and an unlock token when asked) into the unlock form, as a person would. */
async function unlock(page, c) {
  await waitFor(page, `!document.getElementById('jz-unlock').hidden`, 'the unlock form');
  await page.evaluate(`(document.getElementById('jz-key').value = ${JSON.stringify(keys[c.key])}, document.getElementById('jz-unlock').requestSubmit(), true)`);
  if (c.key === 'carol') {
    await waitFor(page, `!document.getElementById('jz-token-row').hidden`, 'the unlock token field');
    const token = issueUnlockToken(path.join(fixtures, c.file), keys.key, JazminAccessKey.parse(keys.carol));
    await page.evaluate(`(document.getElementById('jz-token').value = ${JSON.stringify(token)}, document.getElementById('jz-unlock').requestSubmit(), true)`);
  }
  try {
    return await waitFor(page, `(JazminViewer.state.lastShown || {}).text && ${SHOWN}`, 'the document');
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(SHOWN))}`);
  }
}

function check(c, shown, label) {
  const problems = [];
  if (!shown.document.includes('JAZMIN interop')) problems.push(`document text: ${JSON.stringify(shown.document)}`);
  if (JSON.stringify(shown.files) !== JSON.stringify(c.files)) problems.push(`files: ${shown.files.join(', ')}`);
  if (!(shown.rows > 0)) problems.push(`no rows (${shown.data})`);
  if (shown.error) problems.push(`error: ${shown.error}`);
  return { label, ok: problems.length === 0, problems, rows: shown.data };
}

const results = [];
const chosen = args.browser ?? Object.keys(BROWSERS);
for (const name of chosen) {
  const exe = BROWSERS[name]?.find((p) => fs.existsSync(p));
  if (!exe) {
    results.push({ browser: name, label: '(not installed)', ok: true, problems: [] });
    continue;
  }
  let page;
  try {
    page = name === 'firefox' ? await launchFirefox(exe) : await launchChromium(exe);
  } catch (error) {
    results.push({ browser: name, label: 'start', ok: false, problems: [error.message] });
    continue;
  }
  try {
    for (const c of CASES) {
      await page.navigate(`${base}/js/viewer/index.html`);
      await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
      await page.evaluate(`fetch('/spec/fixtures/${c.file}').then((r) => r.blob()).then((b) => JazminViewer.choose(b, '${c.file}')).then(() => true)`);
      const shown = await unlock(page, c);
      results.push({ browser: name, ...check(c, shown, `${c.file} with ${c.key === 'key' ? 'the owner/master' : c.key} key`) });
    }
    // A template that queries the data through the viewer.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/template.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'template.jzm')).then(() => true)`);
    keys.template = templateKey.toString();
    await unlock(page, { file: 'template.jzm', key: 'template' });
    const ready = await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', 'the template to call jazmin.ready()');
    const expected = { total: 120, top: [119, 118, 117], all: 120, columns: ['n', 'label'] };
    results.push({ browser: name, label: 'template API: count, sorted query, rows, ready', ok: JSON.stringify(ready) === JSON.stringify(expected), problems: JSON.stringify(ready) === JSON.stringify(expected) ? [] : [JSON.stringify(ready)] });

    // Save as HTML, then open the copy from disk (file://), as a double-click would.
    const c = CASES.find((x) => x.file === 'js-files-access.jzm' && x.key === 'bob');
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/spec/fixtures/${c.file}').then((r) => r.blob()).then((b) => JazminViewer.choose(b, '${c.file}')).then(() => true)`);
    await unlock(page, c);
    const html = await page.evaluate('JazminViewer.exportHtml()');
    const saved = path.join(os.tmpdir(), `jazmin-viewer-export-${name}.html`);
    fs.writeFileSync(saved, html);
    await page.navigate(pathToFileURL(saved).href);
    const shown = await unlock(page, c);
    results.push({ browser: name, ...check(c, shown, `saved as HTML (${Math.round(html.length / 1024)} KB), opened from disk with bob's key`) });
    fs.rmSync(saved, { force: true });
    if (page.problems.length) results.push({ browser: name, label: 'page errors', ok: false, problems: page.problems });
  } catch (error) {
    results.push({ browser: name, label: 'run', ok: false, problems: [error.message] });
  } finally {
    await page.close();
  }
}
server.close();
fs.rmSync(temp, { recursive: true, force: true });

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.browser.padEnd(8)} ${r.label}${r.rows ? `  [${r.rows}]` : ''}${r.problems.length ? `\n       ${r.problems.join('\n       ')}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
