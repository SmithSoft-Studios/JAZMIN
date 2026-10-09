// End-to-end check of the viewer (TASKS F-2) in real browsers: opens the embedded-files fixtures written by both
// libraries with each kind of key, checks the data, the files and the rendered document, then saves the page as one
// HTML file and opens that copy from disk. Drives Chrome and Edge through the DevTools protocol, Firefox through
// WebDriver BiDi and Safari (macOS) through WebDriver classic (Node 22+, no packages).
//   node scripts/viewer-e2e.mjs [--browser chrome|edge|firefox|safari|ios ...]   (default: every browser found, except ios)
// ios is Safari in the iPhone simulator (macOS with Xcode), driven by the same safaridriver.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { JazminAccessKey, JazminKey, applyChanges, issueUnlockToken, open, portableHtml, write } from '../src/index.js';
import { TEMPLATE_READY, writeTemplate } from '../test/template-fixture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = path.join(root, 'spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const { values: args } = parseArgs({ options: { browser: { type: 'string', multiple: true } } });
const BROWSERS = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  firefox: ['C:/Program Files/Mozilla Firefox/firefox.exe', '/usr/bin/firefox', '/Applications/Firefox.app/Contents/MacOS/firefox'],
  safari: ['/usr/bin/safaridriver'],
  ios: ['/usr/bin/safaridriver'],
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
  // What viewers may do with the document's files (format 1.4): data.csv can't be saved, index.html can't be printed.
  CASES.push({
    file: `${writer}-document-key.jzm`, key: 'key', files: ['data.csv', 'index.html', 'logo.svg'], downloads: ['index.html', 'logo.svg'],
    actions: { print: false, pdf: true, image: false },
  });
  for (const key of ['bob', 'sally', 'carol']) CASES.push({ file: `${writer}-files-access.jzm`, key, files: FILES[key] }); // never the master key: see below
}

// A package whose template uses the API (test/template-fixture.js): count, sorted queries, a date, all rows, a file, an
// image, and ready().
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-viewer-e2e-files-'));
const templateKey = JazminKey.generate();
writeTemplate(write, path.join(temp, 'template.jzm'), { key: templateKey }); // the template renderPdf's test renders too

// A package allowed to reach one origin: its fonts and media load from there, and from no other origin. The template
// asks for a font and an audio file from the allowed origin and from another, and reports what the policy refused.
// Both origins are made up, so the requests fail: Firefox logs those failures, which are not page errors.
const ORIGINS_TEST = /fonts\.example\.com|other\.example\.org/;
write(path.join(temp, 'origins.jzm'), [{ n: 1 }], {
  key: templateKey,
  files: [
    { path: 'index.html', content: '<!doctype html><title>Origins</title><body><p>Allowed origins</p><script src="app.js"></script></body>' },
    {
      path: 'app.js',
      content: `(async () => {
        const refused = [];
        document.addEventListener('securitypolicyviolation', (e) => refused.push(e.effectiveDirective + ' ' + new URL(e.blockedURI).host));
        const css = document.createElement('style');
        css.textContent = '@font-face { font-family: Allowed; src: url(https://fonts.example.com/a.woff2); }'
          + '@font-face { font-family: Other; src: url(https://other.example.org/b.woff2); }';
        document.head.append(css);
        const settle = (promise) => Promise.race([promise.catch(() => null), new Promise((r) => setTimeout(r, 4000))]);
        const media = (url) => new Promise((resolve) => {
          const audio = new Audio();
          audio.onerror = resolve;
          audio.src = url;
          audio.load();
        });
        await Promise.all([document.fonts.load('16px Allowed'), document.fonts.load('16px Other'),
          media('https://fonts.example.com/a.mp3'), media('https://other.example.org/b.mp3')].map(settle));
        await new Promise((r) => setTimeout(r, 300)); // violation reports arrive as events
        jazmin.ready({ refused: [...new Set(refused)].sort() }); // each policy copy (frame and page) reports
      })();`,
    },
  ],
  package: { entry: 'index.html', title: 'Origins', allowedOrigins: ['https://fonts.example.com'] },
});

// A page whose file refuses PDFs (actions, format 1.4): it turns Print off and back on, and can't turn PDFs on.
write(path.join(temp, 'actions.jzm'), [{ n: 1 }], {
  key: templateKey,
  files: [
    { path: 'index.html', content: '<!doctype html><title>Actions</title><body><p>Actions</p><script src="app.js"></script></body>', actions: { pdf: false } },
    {
      path: 'app.js',
      content: `(() => {
        const before = jazmin.actions;
        jazmin.setActions({ print: false, pdf: true });
        const after = jazmin.actions;
        let refused = '';
        try { jazmin.print(); } catch (e) { refused = e.message; }
        jazmin.setActions({ print: true });
        jazmin.ready({ mode: jazmin.mode, before, after, again: jazmin.actions, refused });
      })();`,
    },
  ],
  package: { entry: 'index.html', title: 'Actions' },
});
const ACTIONS_READY = {
  mode: 'view',
  before: { print: true, pdf: false, image: false },
  after: { print: false, pdf: false, image: false },
  again: { print: true, pdf: false, image: false },
  refused: 'This page cannot be printed here',
};

// A document that changes its rows (package.edit): one change it may not make, then one it may, saved as a change file
// once the person confirms it in the viewer's dialog.
const editFile = path.join(temp, 'edit.jzm');
const EDIT_ROWS = [{ id: 1, status: 'open' }, { id: 2, status: 'open' }];
write(editFile, EDIT_ROWS, {
  key: templateKey,
  columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'status', type: 'string' }],
  files: [
    { path: 'index.html', content: '<!doctype html><title>Edit</title><body><p>Edit</p><script src="app.js"></script></body>' },
    {
      path: 'app.js',
      content: `(async () => {
        const edit = jazmin.edit;
        let refused = '';
        try { await jazmin.saveChanges({ update: [{ id: 1, nope: 'x' }] }); } catch (e) { refused = e.message; }
        const saved = await jazmin.saveChanges({ update: [{ id: 1, status: 'done' }], add: [{ id: 9, status: 'new' }] });
        jazmin.ready({ edit, refused, saved: [saved.saved, saved.updated, saved.added, saved.deleted] });
      })();`,
    },
  ],
  package: { entry: 'index.html', title: 'Edit', edit: { key: ['id'], columns: ['status'], add: true } },
});
const EDIT_READY = {
  edit: { key: ['id'], columns: ['status'], add: true },
  refused: "Column 'nope' can't be changed through this document",
  saved: ['change-file', 1, 1, 0],
};

// A shared file Bob may read, written now: a phone opens it to get the submission key it sends records back with.
write(path.join(temp, 'shared.jzm'), [{ id: 0, person: 'P1' }], {
  columns: [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }],
  key: keys.key,
  access: { partitionBy: 'person', grants: [{ key: keys.bob, rows: ['P1'] }] },
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
    } else if (msg.method === 'log.entryAdded' && msg.params.level === 'error' && !ORIGINS_TEST.test(msg.params.text)) {
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

// Safari through WebDriver classic: plain HTTP calls to safaridriver, which is built into macOS. It must be switched on
// once with "sudo safaridriver --enable". WebDriver classic reports no page errors, so for Safari the checks alone
// show problems.
async function launchSafari(exe, simulator = false) {
  const port = 4400 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, ['--port', String(port)], { stdio: 'ignore' });
  const driver = `http://127.0.0.1:${port}`;
  const call = async (method, route, body) => {
    const res = await fetch(driver + route, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const { value } = await res.json();
    if (!res.ok) throw new Error(`${method} ${route}: ${value?.error} ${value?.message}`);
    return value;
  };
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    await sleep(100);
    try { ready = (await call('GET', '/status')).ready; } catch { /* not listening yet */ }
  }
  if (!ready) {
    proc.kill();
    throw new Error('safaridriver did not start within 15 seconds');
  }
  let session;
  try {
    const capabilities = simulator
      ? { browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true, ...(process.env.JAZMIN_IOS_UDID ? { 'safari:deviceUDID': process.env.JAZMIN_IOS_UDID } : { 'safari:deviceType': 'iPhone' }) }
      : { browserName: 'safari' };
    session = `/session/${(await call('POST', '/session', { capabilities: { alwaysMatch: capabilities } })).sessionId}`;
  } catch (error) {
    proc.kill();
    throw new Error(`${error.message} (switch safaridriver on once with "sudo safaridriver --enable")`);
  }
  await call('POST', `${session}/timeouts`, { script: 60000, pageLoad: 60000 });
  return {
    problems: [],
    async navigate(url) {
      await call('POST', `${session}/url`, { url });
    },
    async evaluate(expression) {
      const r = await call('POST', `${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          (async () => JSON.stringify(await (${expression})))().then((json) => done({ json }), (e) => done({ error: String(e) + ' ' + ((e && e.stack) || '') }));`,
        args: [],
      });
      if (r.error) throw new Error(r.error);
      return r.json === undefined ? undefined : JSON.parse(r.json);
    },
    async close() {
      await call('DELETE', session).catch(() => {});
      proc.kill();
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
  downloads: [...document.querySelectorAll('#jz-files li')].filter((li) => li.querySelector('button')).map((li) => li.querySelector('.path').textContent),
  document: (JazminViewer.state.lastShown || {}).text || '',
  actions: (JazminViewer.state.lastShown || {}).actions || null,
  error: document.getElementById('jz-error').textContent,
  status: document.getElementById('jz-status').textContent,
})`;

/** Types the key (and an unlock token when asked) into the unlock form, as a person would. */
async function unlock(page, c) {
  try {
    await waitFor(page, `document.getElementById('jz-unlock')?.hidden === false`, 'the unlock form');
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(`({ url: location.href, title: document.title, text: (document.body?.innerText ?? '').slice(0, 300) })`))}`);
  }
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
  // What the files' actions allow: a Download button each, and the page's Print and Save as PDF (this viewer makes no
  // images).
  if (JSON.stringify(shown.downloads) !== JSON.stringify(c.downloads ?? c.files)) problems.push(`Download buttons: ${shown.downloads.join(', ')}`);
  const actions = c.actions ?? { print: true, pdf: true, image: false };
  if (JSON.stringify(shown.actions) !== JSON.stringify(actions)) problems.push(`page actions: ${JSON.stringify(shown.actions)}`);
  if (!(shown.rows > 0)) problems.push(`no rows (${shown.data})`);
  if (shown.error) problems.push(`error: ${shown.error}`);
  return { label, ok: problems.length === 0, problems, rows: shown.data };
}

const results = [];
const chosen = args.browser ?? Object.keys(BROWSERS).filter((name) => name !== 'ios'); // the simulator is slow to start: only when asked
for (const name of chosen) {
  const exe = BROWSERS[name]?.find((p) => fs.existsSync(p));
  if (!exe) {
    results.push({ browser: name, label: '(not installed)', ok: true, problems: [] });
    continue;
  }
  // On CI machines a browser's start sometimes times out (Chrome's first start, Safari in the iPhone simulator) before
  // any check runs: up to 3 tries before the start counts as failed.
  let page;
  let startError;
  for (let attempt = 1; attempt <= 3 && !page; attempt++) {
    try {
      page = await ({ firefox: launchFirefox, safari: launchSafari, ios: (driver) => launchSafari(driver, true) }[name] ?? launchChromium)(exe);
    } catch (error) {
      startError = error;
      if (attempt < 3) console.log(`retry  ${name.padEnd(8)} start (${attempt} of 3 failed: ${error.message.split('\n')[0]})`);
    }
  }
  if (!page) {
    results.push({ browser: name, label: 'start', ok: false, problems: [startError.message] });
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
    // A shared file refuses its master key, and the viewer clears it from the page.
    for (const writer of ['js', 'dotnet']) {
      const file = `${writer}-files-access.jzm`;
      await page.navigate(`${base}/js/viewer/index.html`);
      await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
      await page.evaluate(`fetch('/spec/fixtures/${file}').then((r) => r.blob()).then((b) => JazminViewer.choose(b, '${file}')).then(() => true)`);
      await waitFor(page, `document.getElementById('jz-unlock')?.hidden === false`, 'the unlock form');
      await page.evaluate(`(document.getElementById('jz-key').value = ${JSON.stringify(keys.key)}, document.getElementById('jz-unlock').requestSubmit(), true)`);
      const shown = await waitFor(page, `document.getElementById('jz-error').textContent && ({ error: document.getElementById('jz-error').textContent, key: document.getElementById('jz-key').value })`, 'the refusal');
      const ok = /master key can't be used/.test(shown.error) && shown.key === '';
      results.push({ browser: name, label: `${file}: the master key is refused and cleared`, ok, problems: ok ? [] : [JSON.stringify(shown)] });
    }

    // A template that queries the data through the viewer.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/template.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'template.jzm')).then(() => true)`);
    keys.template = templateKey.export();
    await unlock(page, { file: 'template.jzm', key: 'template' });
    const ready = await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', 'the template to call jazmin.ready()');
    const expected = TEMPLATE_READY;
    results.push({ browser: name, label: 'template API: count, sorted queries, a date, rows, a file, an image, ready', ok: JSON.stringify(ready) === JSON.stringify(expected), problems: JSON.stringify(ready) === JSON.stringify(expected) ? [] : [JSON.stringify(ready)] });

    // Fonts and media load from the package's allowed origins, and only from those.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/origins.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'origins.jzm')).then(() => true)`);
    await unlock(page, { file: 'origins.jzm', key: 'template' });
    const origins = await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', 'the origins template to call jazmin.ready()', 20000);
    const refused = JSON.stringify(origins.refused);
    const wanted = JSON.stringify(['font-src other.example.org', 'media-src other.example.org']);
    results.push({ browser: name, label: 'allowed origins: fonts and media load from them only', ok: refused === wanted, problems: refused === wanted ? [] : [`refused: ${refused}`] });

    // A document's changes: checked by the viewer, shown in its dialog, saved as a change file the library applies.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/edit.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'edit.jzm')).then(() => true)`);
    await unlock(page, { file: 'edit.jzm', key: 'template' });
    await waitFor(page, `document.getElementById('jz-changes').open`, 'the changes dialog');
    const listed = await page.evaluate(`[...document.querySelectorAll('#jz-changes-list li')].map((li) => li.textContent).join(' | ')`);
    await page.evaluate(`(document.getElementById('jz-changes-save').click(), true)`);
    const edited = await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', 'the edit page to call jazmin.ready()');
    const changeFile = Buffer.from(await page.evaluate(`(async () => {
      const bytes = new Uint8Array(await JazminViewer.state.lastSaved.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    })()`), 'base64');
    const copy = path.join(temp, `edit-${name}.jzm`);
    fs.copyFileSync(editFile, copy);
    const applied = applyChanges(copy, changeFile, { key: templateKey });
    const after = Object.fromEntries([...open(copy, { key: templateKey }).rows()].map((r) => [r.id, r.status]));
    const editOk = JSON.stringify(edited) === JSON.stringify(EDIT_READY) && listed === 'Change 1: status → done | Add 9'
      && applied.updated === 1 && applied.added === 1 && JSON.stringify(after) === JSON.stringify({ 1: 'done', 2: 'open', 9: 'new' });
    results.push({ browser: name, label: 'editable document: changes checked, confirmed in the viewer, saved as a change file the library applies', ok: editOk, problems: editOk ? [] : [JSON.stringify({ edited, listed, applied, after })] });

    // A page's actions: its file's, narrowed by the page (setActions), never widened.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/actions.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'actions.jzm')).then(() => true)`);
    await unlock(page, { file: 'actions.jzm', key: 'template' });
    const acted = JSON.stringify(await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', 'the actions page to call jazmin.ready()'));
    results.push({ browser: name, label: 'page actions: the file refuses PDFs; the page turns Print off and on', ok: acted === JSON.stringify(ACTIONS_READY), problems: acted === JSON.stringify(ACTIONS_READY) ? [] : [acted] });

    // The browser writer: a file sent back with the submission key, with two attachments (a File of three blocks and a
    // string), written in the page, read back here and by the library.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    const written = await page.evaluate(`(async () => {
      const shared = await fetch('/e2e/shared.jzm').then((r) => r.blob());
      const key = (await JazminBrowser.open(shared, { key: ${JSON.stringify(keys.bob)} })).submissionKey;
      const rows = Array.from({ length: 300 }, (_, i) => ({ id: i, note: 'row ' + i, at: new Date(Date.UTC(2025, 0, 1) + i * 60000), amount: i / 4 }));
      const columns = [{ name: 'id', type: 'int' }, { name: 'note', type: 'string' }, { name: 'at', type: 'datetime' }, { name: 'amount', type: 'float' }];
      const photo = new Uint8Array(600000);
      for (let i = 0; i < photo.length; i++) photo[i] = i < 3 ? [0xff, 0xd8, 0xff][i] : (i * 31 + 7) & 255;
      const writer = await JazminBrowser.createWriter({ columns, key, chunkRows: 64 });
      await writer.writeRows(rows);
      await writer.addFile({ path: 'r0/photo.jpg', content: new File([photo], 'photo.jpg', { type: 'image/jpeg' }) });
      await writer.addFile('r0/receipt.pdf', '%PDF-1.4 receipt');
      const blob = await writer.finish();
      const reader = await JazminBrowser.open(blob, { key });
      let matches = 0;
      for await (const r of reader.find({ amount: { gte: 50 } })) matches++;
      const listed = (await reader.files()).map((f) => f.path + ':' + f.type + ':' + f.size).join(',');
      const back = await reader.readFile('r0/photo.jpg');
      const photoOk = back.length === photo.length && back.every((b, i) => b === photo[i]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { rowCount: reader.rowCount, matches, listed, photoOk, file: btoa(binary) };
    })()`);
    const library = open(Buffer.from(written.file, 'base64'), { key: JazminKey.parse(keys.key).submissionKey(JazminAccessKey.parse(keys.bob).id) });
    const back = [...library.rows()];
    const libraryPhoto = library.readFile('r0/photo.jpg');
    const writeOk = written.rowCount === 300 && written.matches === 100 && back.length === 300 && back[299].note === 'row 299' && library.count({ amount: { gte: 50 } }) === 100
      && written.photoOk && written.listed === 'r0/photo.jpg:image/jpeg:600000,r0/receipt.pdf:application/pdf:16'
      && libraryPhoto.length === 600000 && libraryPhoto[0] === 0xff && libraryPhoto[599999] === ((599999 * 31 + 7) & 255) && library.readFile('r0/receipt.pdf').toString() === '%PDF-1.4 receipt';
    results.push({ browser: name, label: `browser writer: a file sent back with the submission key and two attachments (${Math.round(written.file.length * 0.75 / 1024)} KB) read back here and by the library`, ok: writeOk, problems: writeOk ? [] : [JSON.stringify({ ...written, file: undefined, library: back.length })] });

    // Save as HTML, then open the copy from disk (file://), as a double-click would.
    const c = CASES.find((x) => x.file === 'js-files-access.jzm' && x.key === 'bob');
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/spec/fixtures/${c.file}').then((r) => r.blob()).then((b) => JazminViewer.choose(b, '${c.file}')).then(() => true)`);
    await unlock(page, c);
    const html = await page.evaluate('JazminViewer.exportHtml()');
    // Safari's WebDriver refuses file:// pages ("outside the sandbox"), so Safari opens the copy from the test server.
    const fromDisk = name !== 'safari' && name !== 'ios';
    const saved = path.join(fromDisk ? os.tmpdir() : temp, `jazmin-viewer-export-${name}.html`);
    fs.writeFileSync(saved, html);
    await page.navigate(fromDisk ? pathToFileURL(saved).href : `${base}/e2e/${path.basename(saved)}`);
    const shown = await unlock(page, c);
    results.push({ browser: name, ...check(c, shown, `saved as HTML (${Math.round(html.length / 1024)} KB), opened ${fromDisk ? 'from disk' : 'on its own over HTTP'} with bob's key`) });

    // The same copy made by the library (portableHtml), without a browser.
    const portable = portableHtml(path.join(fixtures, c.file));
    const portablePath = path.join(fromDisk ? os.tmpdir() : temp, `jazmin-portable-${name}.html`);
    fs.writeFileSync(portablePath, portable);
    await page.navigate(fromDisk ? pathToFileURL(portablePath).href : `${base}/e2e/${path.basename(portablePath)}`);
    const shownPortable = await unlock(page, c);
    results.push({ browser: name, ...check(c, shownPortable, `portableHtml (${Math.round(portable.length / 1024)} KB), opened ${fromDisk ? 'from disk' : 'on its own over HTTP'} with bob's key`) });
    fs.rmSync(portablePath, { force: true });
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
