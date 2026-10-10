// End-to-end check of the viewer (TASKS F-2) in real browsers: opens the embedded-files fixtures written by both
// libraries with each kind of key, checks the data, the files and the rendered document, then saves the page as one
// HTML file and opens that copy from disk. Drives Chrome and Edge through the DevTools protocol, Firefox through
// WebDriver BiDi and Safari (macOS) through WebDriver classic (Node 22+, no packages).
//   node scripts/viewer-e2e.mjs [--browser chrome|edge|firefox|safari|ios ...]   (default: every browser found, except ios)
// ios is Safari in the iPhone simulator (macOS with Xcode), driven by the same safaridriver.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { JazminAccessKey, JazminKey, applyChanges, exportString, issueUnlockToken, open, portableHtml, portableScript, write } from '../src/index.js';
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
// A browser's own folder, removed once it has quit; a file it still holds is left for the system to clear, not a failure.
const removeProfile = (profile) => {
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  } catch { /* still in use */ }
};
// The viewer saves files (change files, exports) through a link that downloads them. The checks read what it saved
// from JazminViewer.state.lastSaved instead, so the page's download links are made to do nothing: nothing reaches the
// Downloads folder of whoever runs the checks.
const NO_DOWNLOADS = `(HTMLAnchorElement.prototype.click = ((click) => function () { return this.download ? undefined : click.call(this); })(HTMLAnchorElement.prototype.click), true)`;

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

// A document that tries to pass the viewer a file of its own: the viewer takes files only from the page around it.
write(path.join(temp, 'post.jzm'), [{ n: 1 }], {
  files: [
    { path: 'index.html', content: '<!doctype html><title>Post</title><body><p>Post</p><script src="app.js"></script></body>' },
    {
      path: 'app.js',
      content: `(() => {
        parent.postMessage({ type: 'jazmin:open', file: new Blob(['not a JAZMIN file']), name: 'from-document.jzm' }, '*');
        top.postMessage({ type: 'test:from-document' }, '*');
      })();`,
    },
  ],
  package: { entry: 'index.html', title: 'Post' },
});

// The viewer as files on disk: its folder and the browser reader's side by side, and a page of one's own that shows the
// viewer in an iframe (src from ?viewer=, else viewer/index.html beside it), passes it files and hears how they open.
const disk = path.join(temp, 'disk');
fs.cpSync(path.join(root, 'js/viewer'), path.join(disk, 'viewer'), { recursive: true });
fs.cpSync(path.join(root, 'js/browser'), path.join(disk, 'browser'), { recursive: true });
fs.writeFileSync(path.join(disk, 'host.html'), `<!doctype html>
<meta charset="utf-8">
<title>A page with the viewer</title>
<iframe id="viewer" title="JAZMIN viewer" style="width:100%;height:600px;border:0"></iframe>
<script>
  const frame = document.getElementById('viewer');
  window.statuses = [];
  addEventListener('message', (event) => {
    if (event.source === frame.contentWindow && event.data && event.data.type === 'jazmin:status') statuses.push(event.data);
    if (event.data && event.data.type === 'test:from-document') window.fromDocument = true;
  });
  frame.addEventListener('load', () => { window.loaded = true; });
  frame.src = new URLSearchParams(location.search).get('viewer') || 'viewer/index.html';
  window.pass = (file, name) => (frame.contentWindow.postMessage({ type: 'jazmin:open', file, name }, '*'), true);
</script>
`);
// Files made into scripts (portableScript), which a page opens with openScript(): one in another folder, one in a folder
// beside the page.
fs.mkdirSync(path.join(temp, 'elsewhere'));
fs.writeFileSync(path.join(temp, 'elsewhere/js-key.jzm.js'), portableScript(path.join(fixtures, 'js-key.jzm')));
fs.mkdirSync(path.join(disk, 'data'));
fs.writeFileSync(path.join(disk, 'data/js-plain.jzm.js'), portableScript(path.join(fixtures, 'js-plain.jzm')));
fs.writeFileSync(path.join(disk, 'script.html'), `<!doctype html>
<meta charset="utf-8">
<title>Files as scripts</title>
<script src="browser/jazmin-browser.js"></script>
<script>
  window.opened = (url, options) => JazminBrowser.openScript(url, options)
    .then(async (table) => ({ rows: table.rowCount, first: (await table.query({}, { limit: 1, total: false })).rows[0].id }));
</script>
`);

// A larger file for the viewer's busy display: a filter matching 1 row in 100 shows its first page at once and counts the
// rest while the rows show; one matching nothing searches the whole file under an overlay.
const BUSY_ROWS = 1_000_000;
write(path.join(temp, 'busy.jzm'), (function* rows() {
  for (let i = 0; i < BUSY_ROWS; i++) yield { id: i, amount: ((i * 7919) % 100000) / 100, note: `row ${i}` };
})(), { columns: [{ name: 'id', type: 'int' }, { name: 'amount', type: 'float' }, { name: 'note', type: 'string' }] });
const busyReader = open(path.join(temp, 'busy.jzm'));
const BUSY_TOTAL = busyReader.count({ amount: { gt: 990 } });
const BUSY_EXPORT = { csv: exportString(busyReader, 'csv', { filter: { amount: { gt: 990 } } }), xml: exportString(busyReader, 'xml', { filter: { amount: { gt: 990 } } }) };
busyReader.close();

// The from-disk sample (examples/from-disk), built as its README says: a folder opened by double-clicking its pages.
execFileSync(process.execPath, [path.join(root, 'js/examples/from-disk/make.mjs'), path.join(temp, 'sample'), '--rows', '20000'], { stdio: 'ignore' });
// What its pages should show, from the library: the statement's rows, closing balance and coffee shops, and the demo
// file's rows for one account.
const SAMPLE = (() => {
  const statement = open(path.join(temp, 'sample/data/statement.jzm'), { password: 'demo' });
  const rows = [...statement.rows()];
  const closing = Number(statement.metadata.openingBalance) + rows.reduce((sum, r) => sum + Number(r.amount), 0);
  const demo = open(path.join(temp, 'sample/data/transactions.jzm'), { password: 'demo' });
  // The gallery's tables page shows the first client and their spending.
  const rand = (n) => `R ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const clients = open(path.join(temp, 'sample/data/bank.jzm'), { password: 'demo' });
  const bankTransactions = clients.openTable('transactions');
  const [first] = [...clients.rows({ limit: 1 })];
  const spending = [...bankTransactions.find({ client: first.id, amount: { lt: '0' } })];
  const bank = {
    clients: `${clients.rowCount} rows`, transactions: `${bankTransactions.rowCount.toLocaleString('en-US')} rows`, name: first.name,
    spent: rand(Math.abs(spending.reduce((sum, t) => sum + Number(t.amount), 0))), payments: String(spending.length),
  };
  // The query panel's spending per segment: the payments (amount below 0) of each segment's clients, most spent first.
  const segmentOf = new Map([...clients.rows()].map((c) => [c.id, c.segment]));
  const segments = new Map();
  for (const t of bankTransactions.find({ amount: { lt: '0' } })) {
    const s = segments.get(segmentOf.get(t.client)) ?? { segment: segmentOf.get(t.client), spent: 0, payments: 0 };
    s.spent += Number(t.amount);
    s.payments++;
    segments.set(s.segment, s);
  }
  const perSegment = [...segments.values()].sort((a, b) => a.spent - b.spent)
    .map((s) => [s.segment, `−${rand(Math.abs(s.spent))}`, s.payments.toLocaleString('en-US')]); // the pages' minus sign
  bankTransactions.close();
  clients.close();
  return {
    statementRows: rows.length,
    closing: rand(closing),
    coffee: rows.filter((r) => /coffee/i.test(r.merchant)).length,
    oneAccount: demo.count({ account: 'ACC-1042' }),
    categories: new Set(rows.filter((r) => Number(r.amount) < 0).map((r) => r.category)).size,
    bank,
    perSegment,
  };
})();

// A shared file Bob may read, written now: a phone opens it to get the submission key it sends records back with.
write(path.join(temp, 'shared.jzm'), [{ id: 0, person: 'P1' }], {
  columns: [{ name: 'id', type: 'int' }, { name: 'person', type: 'string' }],
  key: keys.key,
  access: { partitionBy: 'person', grants: [{ key: keys.bob, rows: ['P1'] }] },
});

// ---- a static server for the repository (the viewer, the browser reader and the fixtures) ----------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const serve = (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [dirOf, rel] = pathname.startsWith('/e2e/') ? [temp, pathname.slice(5)] : [root, pathname];
  const file = path.join(dirOf, rel);
  if (!file.startsWith(dirOf) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
};
const server = http.createServer(serve);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
// The same files on another port: another origin, for a page that shows the viewer from a different site.
const otherServer = http.createServer(serve);
await new Promise((r) => otherServer.listen(0, '127.0.0.1', r));
const otherBase = `http://127.0.0.1:${otherServer.address().port}`;

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
      removeProfile(profile);
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
      removeProfile(profile);
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
      // WebDriver doesn't wait when the URL is the page's own, so mark this page and wait until a new one replaces it.
      await call('POST', `${session}/execute/sync`, { script: 'window.jazminOldPage = true', args: [] }).catch(() => {});
      await call('POST', `${session}/url`, { url });
      for (const end = Date.now() + 60000; Date.now() < end; await sleep(100)) {
        const fresh = await call('POST', `${session}/execute/sync`, { script: 'return !window.jazminOldPage && document.readyState === "complete"', args: [] }).catch(() => false);
        if (fresh === true) return;
      }
      throw new Error(`Timed out opening ${url}`);
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
    await page.evaluate(NO_DOWNLOADS);
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

    // From disk (Safari's WebDriver can't open file:// pages): the viewer's folder opened as it is, then shown in an
    // iframe by a page of its own that passes it the file. Pages on disk can't fetch, so the file is made in the page.
    const doc = CASES.find((x) => x.file === 'js-document-key.jzm');
    const blobOf = (file) => `new Blob([Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString('base64'))}), (ch) => ch.charCodeAt(0))])`;
    if (fromDisk) {
      await page.navigate(pathToFileURL(path.join(disk, 'viewer/index.html')).href);
      await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer from disk');
      await page.evaluate(`JazminViewer.choose(${blobOf(path.join(fixtures, doc.file))}, ${JSON.stringify(doc.file)}).then(() => true)`);
      results.push({ browser: name, ...check(doc, await unlock(page, doc), 'the viewer folder opened from disk') });

      // Chrome and Edge give a page on disk the origin "null", so it can't reach into the viewer (Firefox can, within
      // its folder): the page hears the statuses, and the document's own message shows it ran.
      await page.navigate(pathToFileURL(path.join(disk, 'host.html')).href);
      await waitFor(page, 'window.loaded', 'the viewer in the page');
      await page.evaluate(`pass(${blobOf(path.join(fixtures, doc.file))}, 'statement.jzm')`);
      await waitFor(page, `statuses.some((s) => s.name === 'statement.jzm')`, 'statement.jzm');
      await page.evaluate(`pass(${blobOf(path.join(temp, 'post.jzm'))}, 'post.jzm')`);
      const inPage = await waitFor(page, `window.fromDocument && statuses.some((s) => s.name === 'post.jzm') && statuses.map((s) => s.name + ' ' + s.state)`, 'the document in the page');
      await sleep(500);
      const after = await page.evaluate(`statuses.map((s) => s.name + ' ' + s.state)`);
      const ok = JSON.stringify(after) === JSON.stringify(['statement.jzm locked', 'post.jzm opened']);
      results.push({ browser: name, label: 'from disk: a page passes the viewer in its iframe files; one locked, one opened and its document run', ok, problems: ok ? [] : [JSON.stringify({ inPage, after })] });
    }

    // A page on one site passes files to the viewer on another: it hears how each opens, and can't reach into the viewer.
    // A document inside a file can't pass the viewer files, and neither can anything when the viewer isn't in a frame.
    await page.navigate(`${otherBase}/e2e/disk/host.html?viewer=${encodeURIComponent(`${base}/js/viewer/index.html`)}`);
    await waitFor(page, 'window.loaded', 'the viewer in the page');
    const passed = (url, file) => page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.blob()).then((b) => pass(b, ${JSON.stringify(file)}))`);
    await passed('/spec/fixtures/js-plain.jzm', 'plain.jzm');
    await waitFor(page, `statuses.some((s) => s.name === 'plain.jzm')`, 'plain.jzm');
    await passed('/spec/fixtures/js-key.jzm', 'locked.jzm');
    await waitFor(page, `statuses.some((s) => s.name === 'locked.jzm')`, 'locked.jzm');
    await page.evaluate(`pass(new Blob(['not a JAZMIN file']), 'bad.jzm')`);
    await waitFor(page, `statuses.some((s) => s.name === 'bad.jzm')`, 'bad.jzm');
    await passed('/e2e/post.jzm', 'post.jzm');
    await waitFor(page, `window.fromDocument && statuses.some((s) => s.name === 'post.jzm')`, 'the document that passes a file');
    await sleep(800);
    const heard = await page.evaluate(`statuses.map((s) => s.name + ' ' + s.state + (s.message ? ': ' + s.message : ''))`);
    const reached = await page.evaluate(`(() => { try { return !!document.getElementById('viewer').contentWindow.document; } catch { return false; } })()`);
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`(postMessage({ type: 'jazmin:open', file: new Blob(['x']), name: 'self.jzm' }, '*'), true)`);
    await sleep(500);
    const unframed = await page.evaluate('JazminViewer.state.name');
    const crossOk = heard.length === 4 && heard[0] === 'plain.jzm opened' && heard[1] === 'locked.jzm locked' && heard[2].startsWith('bad.jzm failed: ')
      && heard[3] === 'post.jzm opened' && reached === false && unframed === '';
    results.push({ browser: name, label: 'across sites: a page passes the viewer files and hears opened / locked / failed; documents and unframed viewers take none', ok: crossOk, problems: crossOk ? [] : [JSON.stringify({ heard, reached, unframed })] });

    // Files made into scripts, opened with openScript(): from disk (one in another folder, by its file:/// address), or
    // over HTTP where the browser's automation can't open files from disk.
    const keyRows = open(path.join(fixtures, 'js-key.jzm'), { key: keys.key }).rowCount;
    const plainRows = open(path.join(fixtures, 'js-plain.jzm')).rowCount;
    await page.navigate(fromDisk ? pathToFileURL(path.join(disk, 'script.html')).href : `${base}/e2e/disk/script.html`);
    await waitFor(page, `typeof window.opened === 'function'`, 'the page');
    const elsewhere = fromDisk ? pathToFileURL(path.join(temp, 'elsewhere/js-key.jzm.js')).href : '/e2e/elsewhere/js-key.jzm.js';
    const scripted = await page.evaluate(`Promise.all([opened(${JSON.stringify(elsewhere)}, { key: ${JSON.stringify(keys.key)} }), opened('data/js-plain.jzm.js'),
      opened('data/missing.jzm.js').catch((e) => e.message), Object.keys(window.JazminScripts).length])`);
    const scriptOk = JSON.stringify(scripted) === JSON.stringify([{ rows: keyRows, first: 0 }, { rows: plainRows, first: 0 }, 'Could not load data/missing.jzm.js', 0]);
    results.push({ browser: name, label: `files as scripts opened with openScript(), one from another folder${fromDisk ? ', from disk' : ' (over HTTP)'}`, ok: scriptOk, problems: scriptOk ? [] : [JSON.stringify(scripted)] });

    // The busy display: a filter's first page shows at once while the total is counted (with Stop beside it); Stop ends
    // a count; a filter matching nothing searches under an overlay that says how far it is.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/busy.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'busy.jzm')).then(() => true)`);
    await waitFor(page, `/of 1\\D?000\\D?000$/.test(document.getElementById('jz-data-status').textContent)`, 'busy.jzm');
    const dataStatus = `document.getElementById('jz-data-status').textContent`;
    const filterBy = (filter) => page.evaluate(`(document.getElementById('jz-filter').value = ${JSON.stringify(filter)}, document.getElementById('jz-filter-form').requestSubmit(), true)`);
    await filterBy('{ "amount": { "gt": 990 } }');
    const whileCounting = await waitFor(page, `/counting/.test(${dataStatus}) && { rows: document.querySelectorAll('#jz-rows tbody tr').length, stop: !document.getElementById('jz-count-stop').hidden }`, 'the count under way');
    const counted = await waitFor(page, `/matching the filter/.test(${dataStatus}) && document.getElementById('jz-count-stop').hidden && ${dataStatus}`, 'the total', 120000);
    await filterBy('{ "note": { "contains": "row 1" } }');
    await waitFor(page, `/counting/.test(${dataStatus})`, 'the second count');
    await page.evaluate(`(document.getElementById('jz-count-stop').click(), true)`);
    const stoppedCount = await waitFor(page, `/stopped/.test(${dataStatus}) && ${dataStatus}`, 'the stopped count');
    const overlaysBefore = await page.evaluate('JazminViewer.state.busyShown || 0');
    await filterBy('{ "note": { "contains": "zzz" } }');
    const nothing = await waitFor(page, `/matching the filter/.test(${dataStatus}) && ${dataStatus}`, 'no matches', 120000);
    const overlay = await page.evaluate(`({ shown: (JazminViewer.state.busyShown || 0) > ${overlaysBefore}, hidden: document.getElementById('jz-busy').hidden, text: document.getElementById('jz-busy').textContent })`);
    const totalShown = Number((/of ([\d\s.,  ]+) matching/.exec(counted)?.[1] ?? '').replace(/\D/g, ''));
    const busyOk = whileCounting.rows === 50 && whileCounting.stop && totalShown === BUSY_TOTAL && /stopped/.test(stoppedCount)
      && overlay.shown && overlay.hidden && /Searching 1\D?000\D?000 rows/.test(overlay.text) && /^Rows 0–0 of 0 matching the filter/.test(nothing);
    results.push({ browser: name, label: `busy display: the first page at once, the total counted with Stop, an overlay while nothing is ready (${BUSY_ROWS.toLocaleString('en-US')} rows)`, ok: busyOk, problems: busyOk ? [] : [JSON.stringify({ whileCounting, counted, stoppedCount, overlay, nothing, BUSY_TOTAL })] });

    // Export: the rows the filter matches, saved as CSV and XML, the same text as the library's.
    await filterBy('{ "amount": { "gt": 990 } }');
    await waitFor(page, `/matching the filter/.test(${dataStatus})`, 'the filter to export');
    await page.evaluate(NO_DOWNLOADS);
    const exported = {};
    for (const format of ['csv', 'xml']) {
      await page.evaluate(`(JazminViewer.state.lastSaved = null, document.querySelector('#jz-export-menu [data-format="${format}"]').click(), true)`);
      exported[format] = await waitFor(page, `JazminViewer.state.lastSaved && JazminViewer.state.lastSaved.name.endsWith('.${format}') && JazminViewer.state.lastSaved.blob.text().then((text) => ({ name: JazminViewer.state.lastSaved.name, text, note: document.getElementById('jz-export-note').textContent }))`, `the ${format} export`, 120000);
    }
    const exportOk = ['csv', 'xml'].every((format) => exported[format].name === `busy-filtered.${format}` && exported[format].text === BUSY_EXPORT[format] && /^Saved busy-filtered\./.test(exported[format].note));
    results.push({ browser: name, label: `export: the filter's ${BUSY_TOTAL.toLocaleString('en-US')} rows saved as CSV and XML, the same text as the library's`, ok: exportOk, problems: exportOk ? [] : [JSON.stringify(Object.fromEntries(Object.entries(exported).map(([f, e]) => [f, { name: e.name, note: e.note, length: e.text.length, expected: BUSY_EXPORT[f].length }])))] });

    // Export with a shape: a shape linking a file's two tables, checked, previewed, its JSON Schema shown, exported; and
    // checked against the columns each key can see (Bob's key hides balance, Sally's doesn't).
    const shapeDialog = async (shape) => {
      await page.evaluate(`(document.getElementById('jz-shape-open').click(), document.getElementById('jz-shape-text').value = ${JSON.stringify(JSON.stringify(shape, null, 2))}, document.getElementById('jz-shape-text').dispatchEvent(new Event('input')), true)`);
      return waitFor(page, `(document.getElementById('jz-shape-check').className.includes('ok') || document.getElementById('jz-shape-check').className.includes('bad')) && document.getElementById('jz-shape-check').textContent`, 'the shape check');
    };
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/spec/fixtures/js-tables.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'js-tables.jzm')).then(() => true)`);
    await waitFor(page, `/^Rows 1/.test(${dataStatus})`, 'js-tables.jzm');
    const linkShape = JSON.parse(fs.readFileSync(path.join(fixtures, 'shape-links.json'), 'utf8'));
    const fits = await shapeDialog(linkShape);
    await page.evaluate(`(document.getElementById('jz-shape-preview').click(), true)`);
    const preview = await waitFor(page, `/^Preview: /.test(document.getElementById('jz-shape-note').textContent) && document.getElementById('jz-shape-output').textContent.slice(0, 40)`, 'the preview');
    await page.evaluate(`(document.getElementById('jz-shape-schema').click(), true)`);
    const schema = await waitFor(page, `/JSON Schema/.test(document.getElementById('jz-shape-note').textContent) && JSON.parse(document.getElementById('jz-shape-output').textContent).$schema`, 'the schema');
    await page.evaluate(NO_DOWNLOADS);
    await page.evaluate(`(JazminViewer.state.lastSaved = null, document.getElementById('jz-shape-json').click(), true)`);
    const shaped = await waitFor(page, `JazminViewer.state.lastSaved && JazminViewer.state.lastSaved.blob.text().then((text) => ({ name: JazminViewer.state.lastSaved.name, text }))`, 'the shaped export');
    const byKey = {};
    for (const who of ['bob', 'sally']) {
      await page.navigate(`${base}/js/viewer/index.html`);
      await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
      await page.evaluate(`fetch('/spec/fixtures/js-access.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'js-access.jzm')).then(() => true)`);
      await waitFor(page, `document.getElementById('jz-unlock')?.hidden === false`, 'the unlock form');
      await page.evaluate(`(document.getElementById('jz-key').value = ${JSON.stringify(keys[who])}, document.getElementById('jz-unlock').requestSubmit(), true)`);
      await waitFor(page, `/^Rows 1/.test(${dataStatus})`, `js-access.jzm with ${who}'s key`);
      byKey[who] = await shapeDialog({ $rows: { id: 'id', balance: 'balance' } });
    }
    const shapeOk = fits === '✓ The shape fits the columns this key can see' && preview.startsWith('{') && schema === 'https://json-schema.org/draft/2020-12/schema'
      && shaped.name === 'js-tables-shaped.json' && JSON.stringify(JSON.parse(shaped.text)) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(fixtures, 'shape-links-expected.json'), 'utf8')))
      && byKey.bob === "Shape at shape[].balance: unknown or hidden column 'balance'" && byKey.sally === '✓ The shape fits the columns this key can see';
    results.push({ browser: name, label: 'export with a shape: checked, previewed, its JSON Schema, exported across two tables; checked against the columns each key can see', ok: shapeOk, problems: shapeOk ? [] : [JSON.stringify({ fits, preview, schema, shaped: { name: shaped.name, text: shaped.text.slice(0, 200) }, byKey })] });

    // Shapes saved in the file: each key's Export menu lists those it can use (the default first); one exports by name
    // (a shape of the other table, the same text as the library's), and one starts the shape box.
    const savedFor = {};
    for (const who of ['bob', 'sally']) {
      await page.navigate(`${base}/js/viewer/index.html?saved=${who}`);
      await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
      await page.evaluate(`fetch('/spec/fixtures/js-shapes-access.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'js-shapes-access.jzm')).then(() => true)`);
      await waitFor(page, `document.getElementById('jz-unlock')?.hidden === false`, 'the unlock form');
      await page.evaluate(`(document.getElementById('jz-key').value = ${JSON.stringify(keys[who])}, document.getElementById('jz-unlock').requestSubmit(), true)`);
      await waitFor(page, `/^Rows 1/.test(${dataStatus})`, `js-shapes-access.jzm with ${who}'s key`);
      savedFor[who] = await page.evaluate(`[...document.querySelectorAll('#jz-saved-list .saved-shape .name')].map((e) => e.textContent)`);
    }
    await page.evaluate(NO_DOWNLOADS);
    await page.evaluate(`(JazminViewer.state.lastSaved = null, document.querySelector('#jz-saved-list [aria-label="Export Countries as JSON"]').click(), true)`);
    const savedExport = await waitFor(page, `JazminViewer.state.lastSaved && JazminViewer.state.lastSaved.blob.text().then((text) => ({ name: JazminViewer.state.lastSaved.name, text }))`, 'the saved shape export');
    await page.evaluate(`(document.getElementById('jz-shape-open').click(), document.getElementById('jz-shape-saved').value = 'Balances', document.getElementById('jz-shape-saved').dispatchEvent(new Event('change')), true)`);
    const startedFrom = await waitFor(page, `document.getElementById('jz-shape-check').className.includes('ok') && { options: [...document.getElementById('jz-shape-saved').options].map((o) => o.value).filter(Boolean), shape: JSON.parse(document.getElementById('jz-shape-text').value) }`, 'the box started from a saved shape');
    const sallyReader = open(path.join(fixtures, 'js-shapes-access.jzm'), { key: keys.sally, accessState: false });
    const expectedCountries = exportString(sallyReader, 'json', { shape: 'Countries' });
    const balancesShape = sallyReader.shapes.find((s) => s.name === 'Balances').shape;
    sallyReader.close();
    const savedOk = JSON.stringify(savedFor) === JSON.stringify({ bob: ['People by country', 'Countries', 'People with country', 'South'], sally: ['People by country', 'Balances', 'Countries', 'People with country'] })
      && savedExport.name === 'js-shapes-access-countries.json' && savedExport.text === expectedCountries
      && JSON.stringify(startedFrom.options) === JSON.stringify(['People by country', 'Balances', 'People with country']) && JSON.stringify(startedFrom.shape) === JSON.stringify(balancesShape);
    results.push({ browser: name, label: "shapes saved in the file: each key's Export menu lists those it can use, one exports by name (another table's), one starts the shape box", ok: savedOk, problems: savedOk ? [] : [JSON.stringify({ savedFor, savedExport: { name: savedExport.name, text: savedExport.text.slice(0, 200) }, startedFrom })] });

    // The from-disk sample's pages, as a person uses them: the statement opened with its password, with no choosing; and
    // a chosen file passed to the viewer, which says it is locked.
    const sample = (page_) => (fromDisk ? pathToFileURL(path.join(temp, 'sample', page_)).href : `${base}/e2e/sample/${page_}`);
    await page.navigate(sample('small-file.html'));
    await waitFor(page, `!!document.getElementById('unlock')`, 'the statement page');
    await page.evaluate(`(document.getElementById('password').value = 'wrong', document.getElementById('unlock').requestSubmit(), true)`);
    const wrong = await waitFor(page, `/password/i.test(document.getElementById('error').textContent) && document.getElementById('error').textContent`, 'the wrong password');
    await page.evaluate(`(document.getElementById('password').value = 'demo', document.getElementById('unlock').requestSubmit(), true)`);
    const statementShown = await waitFor(page, `/^\\d+ transactions/.test(document.getElementById('status').textContent) && { status: document.getElementById('status').textContent, rows: document.querySelectorAll('#rows tbody tr').length, closing: document.getElementById('closing').textContent }`, 'the statement');
    // A search narrows the rows, and says how long it took.
    await page.evaluate(`(document.getElementById('search').value = 'coffee', document.getElementById('search').dispatchEvent(new Event('input')), true)`);
    const searched = await waitFor(page, `/ of \\d+ · \\d+ ms$/.test(document.getElementById('found').textContent) && { found: document.getElementById('found').textContent, rows: document.querySelectorAll('#rows tbody tr').length }`, 'the search');
    // Export: the transactions shown, saved as CSV.
    await page.evaluate(NO_DOWNLOADS);
    await page.evaluate(`(document.querySelector('#export [data-format="csv"]').click(), true)`);
    const savedStatement = await waitFor(page, `/^Saved /.test(document.getElementById('found').textContent) && document.getElementById('found').textContent`, 'the statement export');
    // The start page asks for a file; a file that isn't one brings it back with the reason; a chosen statement opens in
    // the viewer, which says it is locked.
    await page.navigate(sample('pick-file.html'));
    await waitFor(page, `!document.getElementById('browse').disabled`, 'the viewer in the page');
    const panels = `(document.getElementById('start').hidden ? 'viewer' : 'start')`;
    const asked = await page.evaluate(`${panels} === 'start' && document.getElementById('shown').hidden`);
    await page.evaluate(`(passFile(new File(['not a JAZMIN file'], 'notes.jzm')), true)`);
    const notFile = await waitFor(page, `document.getElementById('error').textContent && { error: document.getElementById('error').textContent, panel: ${panels} }`, 'the refusal');
    const statementBytes = fs.readFileSync(path.join(temp, 'sample/data/statement.jzm')).toString('base64');
    await page.evaluate(`(passFile(new File([Uint8Array.from(atob(${JSON.stringify(statementBytes)}), (ch) => ch.charCodeAt(0))], 'statement.jzm')), true)`);
    const picked = await waitFor(page, `/locked/.test(document.getElementById('status').textContent) && { status: document.getElementById('status').textContent, panel: ${panels}, name: document.getElementById('file-name').value }`, 'the locked status');
    const sampleOk = statementShown.rows === SAMPLE.statementRows && statementShown.status.startsWith(`${SAMPLE.statementRows} transactions · opened in `)
      && statementShown.closing === SAMPLE.closing && searched.rows === SAMPLE.coffee && searched.found.startsWith(`${SAMPLE.coffee} of ${SAMPLE.statementRows} · `)
      && savedStatement.startsWith(`Saved statement-search.csv · `)
      && asked === true && notFile.panel === 'start' && notFile.error.startsWith("notes.jzm couldn't be opened: ")
      && JSON.stringify(picked) === JSON.stringify({ status: 'statement.jzm is locked: type its password in the viewer', panel: 'viewer', name: 'statement.jzm' });
    results.push({ browser: name, label: `the from-disk sample: the statement with no choosing (wrong password, then right; totals, a search, an export); the start page asks for a file and opens it in the viewer${fromDisk ? '' : ' (over HTTP)'}`, ok: sampleOk, problems: sampleOk ? [] : [JSON.stringify({ wrong, statementShown, searched, savedStatement, asked, notFile, picked, SAMPLE })] });

    // The demo's Try buttons send filters to the viewer (jazmin:filter). Over HTTP, where the test can type the password
    // into the viewer in the page's iframe (a page on disk can't reach into it in Chrome and Edge).
    await page.navigate(`${base}/e2e/sample/pick-file.html`);
    await waitFor(page, `!document.getElementById('browse').disabled`, 'the viewer in the page');
    await page.evaluate(`fetch('data/transactions.jzm').then((r) => r.blob()).then((b) => (passFile(new File([b], 'transactions.jzm')), true))`);
    await waitFor(page, `/locked/.test(document.getElementById('status').textContent)`, 'the demo file locked');
    const inFrame = `document.getElementById('viewer').contentWindow`;
    await page.evaluate(`(${inFrame}.document.getElementById('jz-key').value = 'demo', ${inFrame}.document.getElementById('jz-unlock').requestSubmit(), true)`);
    const offered = await waitFor(page, `/is open/.test(document.getElementById('status').textContent) && !document.getElementById('tries').hidden && [...document.querySelectorAll('#tries button')].map((b) => b.textContent)`, 'the Try buttons');
    await page.evaluate(`([...document.querySelectorAll('#tries button')].find((b) => b.textContent === 'One account').click(), true)`);
    const tried = await waitFor(page, `/matching the filter/.test(${inFrame}.document.getElementById('jz-data-status').textContent) && { filter: ${inFrame}.document.getElementById('jz-filter').value, status: ${inFrame}.document.getElementById('jz-data-status').textContent }`, 'the tried filter');
    const triedTotal = Number((/of ([\d\s.,  ]+) matching/.exec(tried.status)?.[1] ?? '').replace(/\D/g, ''));
    const triesOk = offered.length === 5 && tried.filter === '{"account":"ACC-1042"}' && triedTotal === SAMPLE.oneAccount;
    results.push({ browser: name, label: 'the from-disk sample: Try buttons send filters to the viewer (jazmin:filter), answered from the demo file\'s indexes', ok: triesOk, problems: triesOk ? [] : [JSON.stringify({ offered, tried, SAMPLE })] });

    // The demo gallery, as a person uses it: export shapes (a chart from a saved shape, the saved list, the lab checking
    // as typed), several tables (a client and their spending through the saved linked shape), one file with three
    // keys, and documents handed to the viewer, which says how they open.
    const text = (id) => `document.getElementById('${id}').textContent`;
    await page.navigate(sample('shapes.html'));
    await waitFor(page, `!!document.getElementById('unlock')`, 'the shapes page');
    await page.evaluate(`(document.getElementById('unlock').requestSubmit(), true)`);
    const shapesShown = await waitFor(page, `document.getElementById('lab-check').className.includes('ok') && { status: ${text('status')}, bars: document.querySelectorAll('#chart .bar-row').length, saved: [...document.querySelectorAll('#saved .shape-card strong')].map((e) => e.firstChild.textContent.trim()), output: ${text('saved-output')}.slice(0, 1) }`, 'the shapes page opened');
    await page.evaluate(`(document.getElementById('lab').value = document.getElementById('lab').value.replace('"$sum": "amount"', '"$sum": "amont"'), document.getElementById('lab').dispatchEvent(new Event('input')), true)`);
    const labMistake = await waitFor(page, `document.getElementById('lab-check').className.includes('bad') && ${text('lab-check')}`, 'the lab mistake');
    await page.navigate(sample('tables.html'));
    await waitFor(page, `!!document.getElementById('unlock')`, 'the tables page');
    await page.evaluate(`(document.getElementById('unlock').requestSubmit(), true)`);
    const tablesShown = await waitFor(page, `/·/.test(${text('tx-note')}) && { clients: ${text('client-count')}, transactions: ${text('tx-count')}, name: document.querySelector('#client h2').textContent, spent: ${text('spent')}, payments: ${text('payments')} }`, 'a client and their spending');
    // A query across both tables, in its JavaScript: spending per segment.
    await waitFor(page, `/rows ·/.test(${text('query-note')})`, 'the first query');
    await page.evaluate(`([...document.querySelectorAll('#queries button')].find((b) => b.textContent === 'Spending per segment').click(), true)`);
    const perSegment = await waitFor(page, `document.querySelector('#queries [aria-selected="true"]')?.textContent === 'Spending per segment' && /^3 rows ·/.test(${text('query-note')}) && [...document.querySelectorAll('#query-result tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent))`, 'spending per segment');
    await page.navigate(sample('shared.html'));
    await waitFor(page, `!!document.getElementById('open')`, 'the shared page');
    await page.evaluate(`(document.getElementById('open').click(), true)`);
    const people = await waitFor(page, `!document.getElementById('people').hidden && [...document.querySelectorAll('.person')].map((p) => ({ who: p.querySelector('h2').textContent, rows: p.querySelector('.rows').textContent, columns: [...p.querySelectorAll('.columns-chips .chip:not(.off)')].map((c) => c.textContent), shapes: [...p.querySelectorAll('.shape-chips .chip')].map((c) => c.textContent), files: p.querySelectorAll('.file-list li').length }))`, 'the three keys');
    await page.navigate(sample('documents.html'));
    await waitFor(page, `!!document.getElementById('open-report')`, 'the documents page');
    await page.evaluate(`(window.statuses = [], addEventListener('message', (e) => e.data?.type === 'jazmin:status' && statuses.push(e.data.state + ' ' + e.data.name)), document.getElementById('open-report').click(), true)`);
    await waitFor(page, `statuses.length > 0`, 'the report in the viewer', 30000);
    await page.evaluate(`(document.getElementById('open-tasks').click(), true)`);
    const documentStatuses = await waitFor(page, `statuses.length > 1 && statuses`, 'the task list in the viewer', 30000);
    const galleryOk = shapesShown.status.startsWith(`${SAMPLE.statementRows} transactions · 4 saved shapes · opened in `) && shapesShown.bars === SAMPLE.categories
      && JSON.stringify(shapesShown.saved) === JSON.stringify(['Chart data', 'Merchants', 'Spending by category', 'Statement']) && shapesShown.output === '['
      && labMistake === "Shape at categories[].spent.$sum: unknown or hidden column 'amont'"
      && JSON.stringify(tablesShown) === JSON.stringify(SAMPLE.bank) && JSON.stringify(perSegment) === JSON.stringify(SAMPLE.perSegment)
      && JSON.stringify(people) === JSON.stringify([
        { who: 'Cape Town manager', rows: '10 of 30', columns: ['branch', 'name', 'role', 'since', 'salary', 'bonus'], shapes: ['Cape Town pay', 'Headcount by role', 'Team list'], files: 2 },
        { who: 'Johannesburg team lead', rows: '10 of 30', columns: ['branch', 'name', 'role', 'since'], shapes: ['Headcount by role', 'Team list'], files: 2 },
        { who: 'HR', rows: '30 of 30', columns: ['branch', 'name', 'role', 'since', 'salary', 'bonus'], shapes: ['Cape Town pay', 'Headcount by role', 'Pay by branch', 'Team list'], files: 5 },
      ])
      && JSON.stringify(documentStatuses) === JSON.stringify(['opened report.jzm', 'locked tasks.jzm']);
    results.push({ browser: name, label: `the demo gallery: export shapes, several tables, one file with three keys, documents in the viewer${fromDisk ? ', from disk' : ' (over HTTP)'}`, ok: galleryOk, problems: galleryOk ? [] : [JSON.stringify({ shapesShown, labMistake, tablesShown, perSegment, people, documentStatuses, SAMPLE })] });
    if (page.problems.length) results.push({ browser: name, label: 'page errors', ok: false, problems: page.problems });
  } catch (error) {
    results.push({ browser: name, label: 'run', ok: false, problems: [error.message] });
  } finally {
    await page.close();
  }
}
server.close();
otherServer.close();
fs.rmSync(temp, { recursive: true, force: true });

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.browser.padEnd(8)} ${r.label}${r.rows ? `  [${r.rows}]` : ''}${r.problems.length ? `\n       ${r.problems.join('\n       ')}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
