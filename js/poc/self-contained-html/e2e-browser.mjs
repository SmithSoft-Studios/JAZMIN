// End-to-end check of the self-contained HTML in a real browser, opened from disk (file://) as a
// double-click would. Drives Chrome or Edge through the DevTools protocol (Node 22+, no packages).
//   node poc/self-contained-html/e2e-browser.mjs [path/to/statement.html] [--browser chrome|edge] [--screenshot out.png]
// Build the HTML with --test-key to open without typing, or pass --key to type it into the unlock form.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { browser: { type: 'string', default: 'chrome' }, screenshot: { type: 'string' }, page: { type: 'string' }, key: { type: 'string' } },
});
const BROWSERS = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
};
const exe = BROWSERS[args.browser]?.find((p) => fs.existsSync(p));
if (!exe) throw new Error(`No ${args.browser} found`);
const file = path.resolve(positionals[0] ?? 'poc/self-contained-html/out/statement-test.html');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-e2e-'));
const downloads = path.join(profile, 'downloads');
const browser = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const problems = [];
  let frameSession = null; // Chrome runs the sandboxed iframe in its own process (a separate target)
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
      frameSession = msg.params.sessionId;
      send('Runtime.enable', {}, frameSession).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, frameSession).catch(() => {});
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      problems.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push('log: ' + msg.params.entry.text);
    }
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

  await send('Runtime.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Log.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await send('Page.navigate', { url: pathToFileURL(file).href });

  const waitFor = async (expression, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const value = await evaluate(expression);
      if (value) return value;
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  };
  if (args.key) {
    await waitFor(`document.documentElement.dataset.status === 'locked'`);
    await evaluate(`document.getElementById('jz-key').value = ${JSON.stringify(args.key)}; document.getElementById('jz-unlock').requestSubmit(); true`);
    await waitFor(`document.documentElement.dataset.status !== 'locked'`);
  }
  const status = await waitFor(`['ready','error'].includes(document.documentElement.dataset.status) && document.documentElement.dataset.status`);
  const ready = await evaluate('document.documentElement.dataset.ready || null');
  const error = await evaluate(`document.getElementById('jz-status').textContent`);
  const result = { browser: args.browser, status, ready: ready && JSON.parse(ready), title: await evaluate('document.title') };
  if (status === 'error') result.error = error;

  if (status === 'ready') {
    // Use the template from inside the sandbox: click Export CSV and Terms (PDF), check the downloads.
    const inFrame = async (code) => {
      if (!frameSession) throw new Error('The sandboxed frame was not attached');
      const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true }, frameSession);
      if (r.exceptionDetails) throw new Error('In frame: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return r.result.value;
    };
    result.frame = await inFrame(`({ rows: document.querySelectorAll('#rows tr').length, logoWidth: document.querySelector('.logo')?.naturalWidth,
      background: getComputedStyle(document.body).backgroundImage.slice(0, 10), storage: (() => { try { localStorage.x = 1; return 'allowed'; } catch { return 'blocked'; } })() })`);
    result.frame.network = await inFrame(`fetch('https://example.com').then(() => 'allowed', () => 'blocked')`);
    await inFrame(`document.getElementById('csv').click(); document.querySelector('a[download]')?.click(); document.getElementById('pdf').hidden || document.getElementById('pdf').click(); true`);
    for (let i = 0; i < 50 && (!fs.existsSync(downloads) || fs.readdirSync(downloads).filter((f) => !f.endsWith('.crdownload')).length < 3); i++) await sleep(100);
    result.downloads = fs.existsSync(downloads) ? fs.readdirSync(downloads).map((f) => `${f} (${fs.statSync(path.join(downloads, f)).size} bytes)`) : [];
    if (args.page) {
      await inFrame(`document.querySelector('[data-jazmin-page="${args.page}"]').click(); true`);
      await waitFor(`JSON.parse(document.documentElement.dataset.ready || '{}').page === '${args.page}'`);
      result.navigated = JSON.parse(await evaluate('document.documentElement.dataset.ready'));
    }
    if (args.screenshot) {
      await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      fs.writeFileSync(args.screenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
  }
  result.problems = problems;
  console.log(JSON.stringify(result, null, 2));
  ws.close();
  process.exitCode = status === 'ready' ? 0 : 1;
} finally {
  browser.kill();
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
