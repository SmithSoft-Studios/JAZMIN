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
import {
  JazminAccessKey, JazminKey, applyChanges, exportString, fileSubmission, issueFileUnlockToken, issueUnlockToken, open, portableHtml, portableScript, write,
} from '../src/index.js';
import { TEMPLATE_READY, writeTemplate } from '../test/template-fixture.js';
import { testBuild } from './publisher-test-build.mjs';

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
// The viewer saves files (change files, exports) through a link that downloads them. The page's download links are made
// to do nothing, so nothing reaches the Downloads folder of whoever runs the checks: a click keeps the link's name and
// address in window.jzSaved instead, and the checks read the file from that address (SAVED_TEXT).
const NO_DOWNLOADS = `(HTMLAnchorElement.prototype.click = ((click) => function () { if (!this.download) return click.call(this); window.jzSaved = { name: this.download, href: this.href }; })(HTMLAnchorElement.prototype.click), true)`;
const SAVED_TEXT = `window.jzSaved && fetch(window.jzSaved.href).then((r) => r.text()).then((text) => ({ name: window.jzSaved.name, text }))`;

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
      actions: { list: false }, // the page's own script: the page loads it, the Files tab leaves it out
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

// A shared file with a locked file (spec 6.8.1): its reader's key lists it, and opens it with the lock's password.
const lockedOwner = JazminKey.generate();
const lockedReader = lockedOwner.createAccessKey();
keys.lockedReader = lockedReader.toString();
write(path.join(temp, 'locked.jzm'), [{ n: 1 }], {
  key: lockedOwner, access: { grants: [{ key: lockedReader }] },
  files: [
    { path: 'index.html', content: '<!doctype html><title>Locked</title><body><p>A file with a locked contract</p><script src="app.js"></script></body>' },
    // The page asks for the locked file: null until it is unlocked, when the viewer shows the document again.
    { path: 'app.js', actions: { list: false }, content: "jazmin.file('contract.pdf').then(async (b) => jazmin.ready({ contract: b ? await b.text() : null }));" },
    { path: 'contract.pdf', content: 'The contract', lock: 'contracts' },
  ],
  locks: { contracts: { password: 'pw', iterations: 1000 } },
  package: { entry: 'index.html', title: 'Locked' },
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

// A document that reads every table of its file (jazmin.tables, the table option of query and count).
write(path.join(temp, 'tables.jzm'), {
  clients: [{ clientId: 'C1', name: 'Ann' }, { clientId: 'C2', name: 'Ben' }],
  transactions: [{ clientId: 'C1', amount: 10 }, { clientId: 'C1', amount: 2.5 }, { clientId: 'C2', amount: 99 }],
}, {
  key: templateKey,
  tables: [
    { name: 'clients', columns: [{ name: 'clientId', type: 'string' }, { name: 'name', type: 'string' }] },
    { name: 'transactions', columns: [{ name: 'clientId', type: 'string' }, { name: 'amount', type: 'float' }] },
  ],
  files: [
    { path: 'index.html', content: '<!doctype html><title>Tables</title><body><p>Tables</p><script src="app.js"></script></body>' },
    {
      path: 'app.js',
      content: `(async () => {
        const tables = jazmin.tables.map((t) => [t.name, t.columns.length, t.rowCount]);
        const amounts = (await jazmin.query({ clientId: 'C1' }, { table: 'transactions', orderBy: 'amount' })).map((r) => r.amount);
        const count = await jazmin.count({ amount: { gt: 5 } }, { table: 'transactions' });
        const own = await jazmin.count();
        const missing = await jazmin.count(null, { table: 'nope' }).catch((e) => e.message);
        jazmin.ready({ table: jazmin.table, tables, amounts, count, own, missing });
      })();`,
    },
  ],
  package: { entry: 'index.html', title: 'Tables' },
});
const TABLES_READY = {
  table: 'clients', tables: [['clients', 2, 2], ['transactions', 2, 3]], amounts: [2.5, 10], count: 2, own: 2, missing: "The file has no table 'nope'",
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
  // The masked payroll (masked.html): its exports as the library gives them to the clerk's key, masked, and with the
  // values the file lets viewers export revealed once the lock is open.
  const maskedKeys = fs.readFileSync(path.join(temp, 'sample/data/masked-keys.js'), 'utf8');
  const maskedDemo = JSON.parse(maskedKeys.slice(maskedKeys.indexOf('{'), maskedKeys.lastIndexOf('}') + 1));
  const payroll = open(path.join(temp, 'sample/data/payroll-masked.jzm'), { key: maskedDemo.key });
  const masked = { rows: payroll.rowCount, csv: exportString(payroll, 'csv', { revealMasked: false }) };
  payroll.unlock(maskedDemo.lock, { password: maskedDemo.password });
  Object.assign(masked, {
    unlockedCsv: exportString(payroll, 'csv', { revealMasked: false }),
    revealedCsv: exportString(payroll, 'csv', { revealMasked: ['email', 'account', 'salary'] }),
    revealedJson: exportString(payroll, 'json', { revealMasked: ['email', 'account', 'salary'], pretty: true }),
    firstSalary: [...payroll.rows({ limit: 1 })][0].salary,
  });
  payroll.close();
  // The demos added in 1.7's gallery: what the library says they should show. Keys and passwords from the sample's demo
  // key scripts (for the demo only).
  const demoScript = (name, ...vars) => new Function(`${fs.readFileSync(path.join(temp, 'sample/data', name), 'utf8')}; return { ${vars.join(', ')} };`)();
  const names = (file) => {
    const reader = open(path.join(temp, 'sample/data', file));
    const list = [...reader.rows()].map((r) => r.name);
    reader.close();
    return list;
  };
  const orders = open(path.join(temp, 'sample/data/orders.jzm'));
  const gallery = {
    estimate: demo.estimate({ account: 'ACC-1042' }),
    natural: names('customers.jzm'), plain: names('customers-plain.jzm'),
    ledPanels: orders.count({ lines: { any: { sku: 'EL-2210', qty: { gte: 5 } } } }),
    ...demoScript('shared-keys.js', 'sharedLock'), ...demoScript('inspection-keys.js', 'fieldKeys'), ...demoScript('two-factor-keys.js', 'twoFactor'),
  };
  orders.close();
  return {
    gallery,
    masked,
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
// The publisher check's test build (scripts/publisher-test-build.mjs), trusting the test root: the viewer under
// /js/viewer-test/ loads the reader from /js/browser-test/, whose publisher add-on is the test build. Only here.
const TEST_BUILDS = {
  '/js/browser-test/jazmin-browser-publisher.js': testBuild(fs.readFileSync(path.join(root, 'js/browser/jazmin-browser-publisher.js'), 'utf8')),
  '/js/browser-test/jazmin-browser.js': testBuild(fs.readFileSync(path.join(root, 'js/browser/jazmin-browser.js'), 'utf8')),
  '/js/viewer-test/index.html': fs.readFileSync(path.join(root, 'js/viewer/index.html'), 'utf8').replaceAll('../browser/', '../browser-test/'),
};
const serve = (req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (TEST_BUILDS[pathname]) {
    res.writeHead(200, { 'content-type': TYPES[path.extname(pathname)] }).end(TEST_BUILDS[pathname]);
    return;
  }
  pathname = pathname.replace(/^\/js\/(viewer|browser)-test\//, '/js/$1/');
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

// A locked file whose lock names a key service (spec 6.8.2) on the other origin: a page that, as a service would after
// its sign-in and 2FA, posts the token back to the viewer, for the file and lock the viewer asked about.
const serviceOwner = JazminKey.generate();
const serviceReader = serviceOwner.createAccessKey();
keys.serviceReader = serviceReader.toString();
const servicePath = path.join(temp, 'locked-service.jzm');
write(servicePath, [{ n: 1 }], {
  key: serviceOwner, access: { grants: [{ key: serviceReader }] },
  files: [
    { path: 'index.html', content: '<!doctype html><title>Service</title><body><p>A file with a locked scan</p></body>' },
    { path: 'scan.png', content: 'The scan', lock: 'medical' },
  ],
  locks: { medical: { online: true, keyService: `${otherBase}/e2e/key-service.html` } },
  package: { entry: 'index.html', title: 'Service' },
});
const serviceToken = issueFileUnlockToken(servicePath, serviceOwner, 'medical');

// A document that needs the network (spec 6.8): it names the origins it loads from (none is reached in this test).
write(path.join(temp, 'online.jzm'), [{ n: 1 }], {
  columns: [{ name: 'n', type: 'int' }],
  files: [{ path: 'index.html', content: '<!doctype html><title>Online</title><body><p>Chart</p><script>jazmin.ready({ shown: true })</script></body>' }],
  package: { entry: 'index.html', title: 'Online', allowedOrigins: ['https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'], online: 'required' },
});

// Document pages (spec 6.8): three tabs, each reporting what it reads; the Summary needs the network, Sales has no
// Print; the document's own files (app.js, fonts/) and its pages are kept out of the Files tab.
const pageHtml = (name) => `<!doctype html><title>${name}</title><body><p>${name}</p><script>
  jazmin.query({}, { limit: 1000 }).then((r) => jazmin.ready({ page: '${name}', table: jazmin.table, rows: (r.rows || r).length, print: jazmin.actions.print }));
</script></body>`;
write(path.join(temp, 'pages.jzm'), { clients: [{ id: 1 }, { id: 2 }], sales: [{ id: 1 }, { id: 2 }, { id: 3 }] }, {
  tables: [{ name: 'clients', columns: [{ name: 'id', type: 'int' }] }, { name: 'sales', columns: [{ name: 'id', type: 'int' }] }],
  files: [
    { path: 'clients.html', content: pageHtml('clients') }, { path: 'sales.html', content: pageHtml('sales') },
    { path: 'summary.html', content: pageHtml('summary') }, { path: 'app.js', content: '// the pages\' script' },
    { path: 'jump.html', content: '<!doctype html><title>Jump</title><body><script>jazmin.navigate(\'clients.html\')</script></body>' },
    { path: 'fonts/inter.woff2', content: 'font' }, { path: 'terms.pdf', content: 'terms' },
  ],
  package: {
    pages: [
      { path: 'clients.html', title: 'Clients', table: 'clients' },
      { path: 'sales.html', title: 'Sales', table: 'sales', actions: { print: false } },
      { path: 'summary.html', title: 'Summary', online: 'required' },
      { path: 'jump.html', title: 'Jump' }, // goes to the Clients page itself (jazmin.navigate)
    ],
    files: ['app.js', 'fonts/'], allowedOrigins: ['https://cdn.jsdelivr.net'],
  },
});

// Masked columns (spec 7.6.8): account masked with its format kept, salary masked only from id 2. Revealed account
// values show for 2 seconds here (30 by default).
const maskedOwner = JazminKey.generate();
const maskedReader = maskedOwner.createAccessKey();
keys.maskedReader = maskedReader.toString();
write(path.join(temp, 'masked.jzm'), [
  { id: 1, name: 'Ann', account: '4821 0393 7712 4821', salary: '52000.00' },
  { id: 2, name: 'Ben', account: '1111 2222 3333 4444', salary: '61000.50' },
], {
  columns: [
    { name: 'id', type: 'int' }, { name: 'account', type: 'string', mask: { lock: 'pay', show: { keepFormat: true, last: 4 } } },
    { name: 'name', type: 'string' }, { name: 'salary', type: 'decimal', mask: { lock: 'pay', rows: { id: { gte: 2 } } } },
  ],
  key: maskedOwner, access: { grants: [{ key: maskedReader }] }, locks: { pay: { password: 'pw', iterations: 1000 } },
  files: [{ path: 'index.html', content: '<!doctype html><title>Staff</title><body><p>Staff</p></body>' }],
  package: { entry: 'index.html', title: 'Staff', masks: { account: { seconds: 2 } } },
});
fs.writeFileSync(path.join(temp, 'key-service.html'), `<!doctype html><title>Key service</title><body><p>Signed in</p><script>
  const q = new URLSearchParams(location.search);
  const asked = q.get('jazmin') === 'unlock' && q.get('lock') === 'medical' && /^[0-9a-f]{32}$/.test(q.get('file') || '');
  opener.postMessage({ type: 'jazmin:file-unlock', file: q.get('file'), lock: asked ? 'medical' : 'not asked so',
    token: ${JSON.stringify(serviceToken)} }, q.get('origin') === 'null' ? '*' : q.get('origin'));
</script></body>`);

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
      // As the person's own action (userGesture), so a page may open a window (a key service's sign-in).
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, awaitPromise: true, returnByValue: true, userGesture: true });
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
        expression: `(async () => JSON.stringify(await (${expression})))()`, target: { context }, awaitPromise: true, resultOwnership: 'none', userActivation: true,
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
    // The page loaded app.js, which is list: false: the Files tab shows only index.html.
    const inFiles = await page.evaluate(`[...document.querySelectorAll('#jz-files .path')].map((e) => e.textContent).join(',')`);
    results.push({ browser: name, label: 'a file marked list: false: the page loads it, the Files tab leaves it out', ok: inFiles === 'index.html', problems: inFiles === 'index.html' ? [] : [`listed: ${inFiles}`] });

    // A locked file: listed with a padlock and no Download; Unlock… refuses a wrong password, then opens it.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/locked.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'locked.jzm')).then(() => true)`);
    await unlock(page, { file: 'locked.jzm', key: 'lockedReader' });
    const fileRows = `[...document.querySelectorAll('#jz-files li')].map((li) => [li.querySelector('.path').textContent, li.querySelector('.locked') ? 'locked' : 'open',
      li.querySelector('button') ? li.querySelector('button').textContent : ''].join(':')).join(', ')`;
    const pageBefore = await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', 'the locked page to call jazmin.ready()');
    const lockedBefore = await page.evaluate(fileRows);
    await page.evaluate(`([...document.querySelectorAll('#jz-files li')].find((li) => li.querySelector('.locked')).querySelector('button').click(), true)`);
    await waitFor(page, `document.getElementById('jz-lock').open`, 'the unlock dialog');
    await page.evaluate(`(document.getElementById('jz-lock-password').value = 'wrong', document.getElementById('jz-lock-form').requestSubmit(), true)`);
    const wrongPassword = await waitFor(page, `/Wrong password/.test(document.getElementById('jz-lock-error').textContent) && document.getElementById('jz-lock').open`, 'the wrong password refused');
    await page.evaluate(`(document.getElementById('jz-lock-password').value = 'pw', document.getElementById('jz-lock-form').requestSubmit(), true)`);
    await waitFor(page, `!document.getElementById('jz-lock').open && !document.querySelector('#jz-files .locked')`, 'the file unlocked');
    const lockedAfter = await page.evaluate(fileRows);
    const pageAfter = await waitFor(page, `JazminViewer.state.lastReady && JazminViewer.state.lastReady.info && JazminViewer.state.lastReady.info.contract
      && JazminViewer.state.lastReady.info`, 'the page shown again with the unlocked file');
    const contract = await page.evaluate(`JazminViewer.state.reader.readFile('contract.pdf').then((b) => new TextDecoder().decode(b))`);
    const lockOk = lockedBefore === 'contract.pdf:locked:Unlock…, index.html:open:Download' && wrongPassword === true
      && lockedAfter === 'contract.pdf:open:Download, index.html:open:Download' && contract === 'The contract'
      && pageBefore.contract === null && pageAfter.contract === 'The contract';
    results.push({
      browser: name, label: 'a locked file: a padlock and Unlock…, a wrong password refused, then its Download; the page gets it once unlocked', ok: lockOk,
      problems: lockOk ? [] : [JSON.stringify({ lockedBefore, wrongPassword, lockedAfter, contract, pageBefore, pageAfter })],
    });

    // A lock with a key service: Sign in opens it in a window, which posts the token back; the file opens.
    // Not on the iPhone simulator: Safari there opens the window only from a person's tap and pauses the viewer's
    // tab behind it, which WebDriver can't drive. It is in the phone check by hand (docs/CONTRIBUTING.md).
    if (name === 'ios') console.log(`skip ${name.padEnd(8)} a lock's key service: Sign in (in the phone check by hand)`);
    else {
      await page.navigate(`${base}/js/viewer/index.html`);
      await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
      await page.evaluate(`fetch('/e2e/locked-service.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'locked-service.jzm')).then(() => true)`);
      await unlock(page, { file: 'locked-service.jzm', key: 'serviceReader' });
      await page.evaluate(`([...document.querySelectorAll('#jz-files li')].find((li) => li.querySelector('.locked')).querySelector('button').click(), true)`);
      await waitFor(page, `document.getElementById('jz-lock').open`, 'the unlock dialog');
      const signInButton = await page.evaluate(`document.getElementById('jz-lock-service').hidden ? '' : document.getElementById('jz-lock-service').textContent`);
      // The right token from another origin (here the viewer's own) is not the key service's answer: it is ignored.
      await page.evaluate(`(window.postMessage({ type: 'jazmin:file-unlock', file: JazminViewer.state.reader.fileId, lock: 'medical', token: ${JSON.stringify(serviceToken)} }, '*'),
        new Promise((r) => setTimeout(r, 400)).then(() => true))`);
      const forgedIgnored = await page.evaluate(`document.getElementById('jz-lock').open && document.getElementById('jz-lock-token').value === ''`);
      await page.evaluate(`(document.getElementById('jz-lock-service').click(), true)`);
      let serviceUnlocked = true;
      try {
        await waitFor(page, `!document.getElementById('jz-lock').open && !document.querySelector('#jz-files .locked')`, 'the token from the key service');
      } catch {
        serviceUnlocked = await page.evaluate(`document.getElementById('jz-lock-error').textContent`);
      }
      const scan = serviceUnlocked === true ? await page.evaluate(`JazminViewer.state.reader.readFile('scan.png').then((b) => new TextDecoder().decode(b))`) : null;
      const serviceOk = signInButton === `Sign in at ${new URL(otherBase).host}` && forgedIgnored === true && serviceUnlocked === true && scan === 'The scan';
      results.push({
        browser: name, label: "a lock's key service: Sign in opens its window, which posts the token back, and the file opens; other origins are ignored", ok: serviceOk,
        problems: serviceOk ? [] : [JSON.stringify({ signInButton, forgedIgnored, serviceUnlocked, scan })],
      });
    }

    // A document of pages: a tab each, in order, each reading its own table; offline only the page that needs the
    // network waits; the pages and the document's own files are left out of the Files tab.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`(Object.defineProperty(navigator, 'onLine', { get: () => window.jzOnline !== false, configurable: true }), window.jzOnline = false, true)`);
    await page.evaluate(`fetch('/e2e/pages.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'pages.jzm')).then(() => true)`);
    const pageReady = (what) => waitFor(page, `JazminViewer.state.lastReady && JazminViewer.state.lastReady.info && JazminViewer.state.lastReady.info.page === '${what}'`, `the ${what} page`);
    await pageReady('clients');
    const pgTabs = await page.evaluate(`[...document.querySelectorAll('#jz-pages button')].map((b) => b.textContent + (b.getAttribute('aria-current') ? '*' : '')).join(', ')`);
    const pgListed = await page.evaluate(`[...document.querySelectorAll('#jz-files .path')].map((e) => e.textContent).join(', ')`);
    const pgClients = await page.evaluate(`JazminViewer.state.lastReady.info`);
    await page.evaluate(`(document.querySelector('#jz-pages button[data-page="sales.html"]').click(), true)`);
    await pageReady('sales');
    const pgSales = await page.evaluate(`JazminViewer.state.lastReady.info`);
    await page.evaluate(`(document.querySelector('#jz-pages button[data-page="summary.html"]').click(), true)`);
    await waitFor(page, `!document.getElementById('jz-offline').hidden`, 'the Summary waiting for the network');
    const pgSummary = await page.evaluate(`({ note: document.getElementById('jz-online').textContent, frameHidden: document.getElementById('jz-frame').hidden })`);
    await page.evaluate(`(document.querySelector('#jz-pages button[data-page="clients.html"]').click(), true)`);
    await pageReady('clients');
    const pgBack = await page.evaluate(`document.getElementById('jz-offline').hidden && !document.getElementById('jz-frame').hidden`);
    await page.evaluate(`(window.jzOnline = true, true)`);
    // A page that goes to another tab's page (jazmin.navigate): that tab is shown, highlighted, with its own table.
    await page.evaluate(`(document.querySelector('#jz-pages button[data-page="sales.html"]').click(), true)`);
    await pageReady('sales');
    await page.evaluate(`(JazminViewer.state.lastReady = null, document.querySelector('#jz-pages button[data-page="jump.html"]').click(), true)`);
    await pageReady('clients');
    const pgJumped = await page.evaluate(`({ tab: document.querySelector('#jz-pages button[aria-current="page"]').dataset.page, table: JazminViewer.state.lastReady.info.table })`);
    const pgPagesOk = pgTabs === 'Clients*, Sales, Summary, Jump' && pgListed === 'terms.pdf' && pgJumped.tab === 'clients.html' && pgJumped.table === 'clients'
      && pgClients.table === 'clients' && pgClients.rows === 2 && pgClients.print === true
      && pgSales.table === 'sales' && pgSales.rows === 3 && pgSales.print === false
      && pgSummary.note === 'This page needs to be online.' && pgSummary.frameHidden === true && pgBack === true;
    results.push({
      browser: name, label: 'document pages: a tab each in order, each with its table and buttons; offline only the page that needs the network waits; its own files unlisted', ok: pgPagesOk,
      problems: pgPagesOk ? [] : [JSON.stringify({ pgTabs, pgListed, pgClients, pgSales, pgSummary, pgBack, pgJumped })],
    });

    // A document that needs the network: the note says so; offline it waits with a message, then shows.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`(Object.defineProperty(navigator, 'onLine', { get: () => window.jzOnline !== false, configurable: true }), window.jzOnline = false, true)`);
    await page.evaluate(`fetch('/e2e/online.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'online.jzm')).then(() => true)`);
    await waitFor(page, `!document.getElementById('jz-offline').hidden`, 'the offline message');
    const offlineState = await page.evaluate(`({ note: document.getElementById('jz-online').textContent, what: document.getElementById('jz-offline-what').textContent,
      frameHidden: document.getElementById('jz-frame').hidden })`);
    await page.evaluate(`(window.jzOnline = true, dispatchEvent(new Event('online')), true)`);
    await waitFor(page, `document.getElementById('jz-offline').hidden && !document.getElementById('jz-frame').hidden
      && JazminViewer.state.lastReady && JazminViewer.state.lastReady.info && JazminViewer.state.lastReady.info.shown`, 'the document once online');
    const onlineOk = offlineState.note === 'This document needs to be online.' && offlineState.what === 'This document needs to be online.'
      && offlineState.frameHidden === true;
    results.push({
      browser: name, label: 'a document that needs the network: a note says so; offline it waits with a message, and shows once online', ok: onlineOk,
      problems: onlineOk ? [] : [JSON.stringify(offlineState)],
    });

    // Masked columns: each in its place showing its masked text; Unlock… in its header; then Reveal one value at a time,
    // masked again when its time is up; the page that asked hears of each reveal, without the value.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/masked.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'masked.jzm')).then(() => true)`);
    await unlock(page, { file: 'masked.jzm', key: 'maskedReader' });
    const table = `({ head: [...document.querySelectorAll('#jz-rows th')].map((th) => th.textContent).join(' | '),
      rows: [...document.querySelectorAll('#jz-rows tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent).join(' | ')) })`;
    const maskedBefore = await page.evaluate(table);
    await page.evaluate(`([...document.querySelectorAll('#jz-rows th button')][0].click(), true)`);
    await waitFor(page, `document.getElementById('jz-lock').open`, 'the unlock dialog for a masked column');
    await page.evaluate(`(document.getElementById('jz-lock-password').value = 'pw', document.getElementById('jz-lock-form').requestSubmit(), true)`);
    await waitFor(page, `!document.getElementById('jz-lock').open && document.querySelectorAll('#jz-rows td .reveal').length === 3`, 'the masked columns unlocked');
    const maskedUnlocked = await page.evaluate(table);
    await page.evaluate(`(JazminViewer.state.reportReveals = true, JazminViewer.state.answerTo = location.origin, window.jzReveals = [],
      addEventListener('message', (e) => e.data && e.data.type === 'jazmin:revealed' && window.jzReveals.push(e.data)), true)`);
    const revealAt = (row, col) => `(document.querySelectorAll('#jz-rows tbody tr')[${row}].cells[${col}].querySelector('.reveal').click(), true)`;
    await page.evaluate(revealAt(0, 1));
    const firstShown = await page.evaluate(table);
    await page.evaluate(revealAt(1, 1));
    const secondShown = await page.evaluate(table);
    await waitFor(page, `!document.querySelector('#jz-rows td.revealed')`, 'the revealed value masked again after 2 seconds');
    const reveals = await page.evaluate(`JSON.stringify(window.jzReveals.map((m) => [m.column, m.lock, m.scope, 'value' in m]))`);
    // Exports: masked until the person asks for the revealed values (the Export menu's box, unticked).
    await page.evaluate(NO_DOWNLOADS);
    const exportCsv = async (reveal) => {
      await page.evaluate(`(document.getElementById('jz-export-reveal').checked = ${reveal}, window.jzSaved = null,
        document.querySelector('#jz-export-menu [data-format="csv"]').click(), true)`);
      return (await waitFor(page, SAVED_TEXT, 'the CSV export')).text.trim().split(String.fromCharCode(10)).map((l) => l.trim()).join(' / ');
    };
    const revealRow = await page.evaluate(`document.getElementById('jz-export-reveal-row').hidden ? null
      : [document.getElementById('jz-export-reveal').checked, document.getElementById('jz-export-reveal-text').textContent]`);
    const maskedCsv = await exportCsv(false);
    const revealedCsv = await exportCsv(true);
    // A shape reads columns directly: one that reads an unlocked masked column is refused unless the box is ticked.
    await page.evaluate(`(document.getElementById('jz-export-reveal').checked = false, document.getElementById('jz-shape-open').click(),
      document.getElementById('jz-shape-text').value = ${JSON.stringify(JSON.stringify({ $rows: { name: 'name', account: 'account' } }))},
      document.getElementById('jz-shape-text').dispatchEvent(new Event('input')), true)`);
    await waitFor(page, `document.getElementById('jz-shape-check').className.includes('ok')`, 'the shape check');
    await page.evaluate(`(window.jzSaved = null, document.getElementById('jz-shape-json').click(), true)`);
    const shapeRefused = await waitFor(page, `/masked column whose values aren't exported/.test(document.getElementById('jz-export-note').textContent)`, 'the shaped export refused');
    await page.evaluate(`(document.getElementById('jz-shape').open && document.getElementById('jz-shape').close(), true)`);
    const maskedOk = maskedBefore.head === 'id | account 🔒 Unlock… | name | salary 🔒 Unlock…'
      && maskedBefore.rows.join(' / ') === '1 | •••• •••• •••• 4821 | Ann | 52000.00 / 2 | •••• •••• •••• 4444 | Ben | ••••'
      && maskedUnlocked.head === 'id | account | name | salary'
      && maskedUnlocked.rows.join(' / ') === '1 | •••• •••• •••• 4821 Reveal | Ann | 52000.00 / 2 | •••• •••• •••• 4444 Reveal | Ben | •••• Reveal'
      && firstShown.rows[0] === '1 | 4821 0393 7712 4821 Hide (2 s) | Ann | 52000.00'
      && secondShown.rows.join(' / ') === '1 | •••• •••• •••• 4821 Reveal | Ann | 52000.00 / 2 | 1111 2222 3333 4444 Hide (2 s) | Ben | •••• Reveal'
      && reveals === JSON.stringify([['account', 'pay', 'value', false], ['account', 'pay', 'value', false]])
      && JSON.stringify(revealRow) === JSON.stringify([false, 'Include revealed values (account, salary)'])
      && maskedCsv === 'id,account,name,salary / 1,•••• •••• •••• 4821,Ann,52000.00 / 2,•••• •••• •••• 4444,Ben,••••'
      && revealedCsv === 'id,account,name,salary / 1,4821 0393 7712 4821,Ann,52000.00 / 2,1111 2222 3333 4444,Ben,61000.50'
      && shapeRefused === true;
    results.push({
      browser: name, label: 'masked columns: masked text in place, Unlock… in the header, Reveal one value at a time, masked again after its time, reveals reported, exports masked unless asked', ok: maskedOk,
      problems: maskedOk ? [] : [JSON.stringify({ maskedBefore, maskedUnlocked, firstShown, secondShown, reveals, revealRow, maskedCsv, revealedCsv, shapeRefused })],
    });

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
      const bytes = new Uint8Array(await (await fetch(window.jzSaved.href)).arrayBuffer());
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

    // A document that reads every table of its file.
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/tables.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'tables.jzm')).then(() => true)`);
    await unlock(page, { file: 'tables.jzm', key: 'template' });
    const tabled = JSON.stringify(await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', 'the tables page to call jazmin.ready()'));
    results.push({ browser: name, label: "a document reads every table of its file (jazmin.tables, query and count's table)", ok: tabled === JSON.stringify(TABLES_READY), problems: tabled === JSON.stringify(TABLES_READY) ? [] : [tabled] });

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
      // The viewer loads the reader's core; the writer is an add-on, loaded after it.
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '../browser/jazmin-browser-writer.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('the writer add-on did not load'));
        document.head.append(script);
      });
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

    // Publisher signatures (spec 6.9), in the viewer's own bar. The test build of the viewer trusts the test root and says
    // so; the released viewer trusts the published roots built into it, so the same file shows as signed by an unknown key.
    const publisherShown = `(() => {
      const bar = document.getElementById('jz-publisher');
      return bar.hidden ? { hidden: true } : { state: bar.dataset.state, badge: document.getElementById('jz-publisher-badge').textContent,
        text: document.getElementById('jz-publisher-text').textContent, details: document.getElementById('jz-publisher-details').textContent };
    })()`;
    const showSigned = async (viewer, file) => {
      await page.navigate(`${base}/js/${viewer}/index.html`);
      await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
      await page.evaluate(`fetch('/spec/fixtures/publisher/${file}').then((r) => r.blob()).then((b) => JazminViewer.choose(b, '${file}')).then(() => true)`);
      await waitFor(page, `JazminViewer.state.publisher && JazminViewer.state.publisher.status`, `${file}: the publisher check`, 30000);
      return page.evaluate(publisherShown);
    };
    const signedChecks = [];
    const certified = await showSigned('viewer-test', 'signed-plain.jzm');
    signedChecks.push(['signed-plain.jzm in the test viewer: a verified publisher, marked TEST, with its code and facts', certified.state === 'test'
      && certified.badge === 'TEST · Verified publisher' && certified.text.includes('Sable Line Logistics (Pty) Ltd') && /JZ-[0-9A-Z]{5}-[0-9A-Z]{5}/.test(certified.text)
      && certified.details.includes('TEST BUILD') && certified.details.includes('NTRZA-2020/123456/07') && certified.details.includes('14102.37'), certified]);
    const released = await showSigned('viewer', 'signed-plain.jzm');
    signedChecks.push(['signed-plain.jzm in the released viewer: signed by a key SmithSoft does not certify, no name', released.state === 'signed'
      && released.badge === 'Signed' && !released.text.includes('Sable'), released]);
    const individual = await showSigned('viewer-test', 'signed-sole-trader.jzm');
    signedChecks.push(['signed-sole-trader.jzm: a verified individual, trading as', individual.badge === 'TEST · Verified individual'
      && individual.text.includes('Thandi Mokoena, trading as TM Bookkeeping'), individual]);
    for (const [file, state, words] of [['withdrawn.jzm', 'withdrawn', 'withdrew this document'], ['changed-byte.jzm', 'changed', 'changed after it was signed'],
      ['self-signed.jzm', 'signed', "SmithSoft doesn't certify"], ['invalid-block-crc.jzm', 'invalid', 'signature block is damaged']]) {
      const shown = await showSigned('viewer-test', file);
      signedChecks.push([`${file}: ${state}`, shown.state === state && shown.text.includes(words), shown]);
    }
    const unsigned = await showSigned('viewer-test', 'unsigned.jzm');
    signedChecks.push(['unsigned.jzm: no bar', unsigned.hidden === true, unsigned]);
    // An encrypted file: who published it shows before the password; its facts once the password opens it.
    const locked = await showSigned('viewer-test', 'signed-password.jzm');
    await waitFor(page, `document.getElementById('jz-unlock')?.hidden === false`, 'the unlock form');
    await page.evaluate(`(document.getElementById('jz-key').value = 'Sable-Payroll-2026!', document.getElementById('jz-unlock').requestSubmit(), true)`);
    await waitFor(page, `JazminViewer.state.publisher && JazminViewer.state.publisher.facts`, 'the facts after the password', 30000);
    const unlocked = await page.evaluate(publisherShown);
    signedChecks.push(['signed-password.jzm: the publisher before the password, the facts after it', locked.state === 'test'
      && locked.details.includes('Unlock the file to see them') && unlocked.details.includes('18871.48'), { locked, unlocked }]);
    // A certified document is sealed: its page is shown without the network though its package allows a font's origin.
    const sealedDoc = async (viewer) => {
      await showSigned(viewer, 'signed-document.jzm');
      const ready = await waitFor(page, 'JazminViewer.state.lastReady && JazminViewer.state.lastReady.info', `signed-document.jzm's page in ${viewer}`, 30000);
      return { ...ready, note: await page.evaluate(`document.getElementById('jz-online').hidden ? '' : document.getElementById('jz-online').textContent`) };
    };
    const sealedTest = await sealedDoc('viewer-test');
    const sealedReleased = await sealedDoc('viewer');
    signedChecks.push(['signed-document.jzm: certified, shown without the network (the font refused); the released viewer allows it', sealedTest.lines === 5
      && sealedTest.refused.some((r) => /^style-src(-elem)? fonts\.example\.com$/.test(r)) && sealedTest.note.includes('asked for the internet')
      && sealedReleased.lines === 5 && sealedReleased.refused.length === 0, { sealedTest, sealedReleased }]);
    for (const [label, ok, shown] of signedChecks) results.push({ browser: name, label: `publisher: ${label}`, ok, problems: ok ? [] : [JSON.stringify(shown)] });

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
      await page.evaluate(`(window.jzSaved = null, document.querySelector('#jz-export-menu [data-format="${format}"]').click(), true)`);
      exported[format] = await waitFor(page, `window.jzSaved && window.jzSaved.name.endsWith('.${format}') && fetch(window.jzSaved.href).then((r) => r.text()).then((text) => ({ name: window.jzSaved.name, text, note: document.getElementById('jz-export-note').textContent }))`, `the ${format} export`, 120000);
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
    await page.evaluate(`(window.jzSaved = null, document.getElementById('jz-shape-json').click(), true)`);
    const shaped = await waitFor(page, SAVED_TEXT, 'the shaped export');
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
      // The saved shapes are listed after the rows show: wait for them (both keys can use some).
      savedFor[who] = await waitFor(page, `document.querySelectorAll('#jz-saved-list .saved-shape .name').length > 0 && [...document.querySelectorAll('#jz-saved-list .saved-shape .name')].map((e) => e.textContent)`, `${who}'s saved shapes`);
    }
    await page.evaluate(NO_DOWNLOADS);
    await page.evaluate(`(window.jzSaved = null, document.querySelector('#jz-saved-list [aria-label="Export Countries as JSON"]').click(), true)`);
    const savedExport = await waitFor(page, SAVED_TEXT, 'the saved shape export');
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
    // Newest 20 for the filter tried (reverse: true, against counting and reading the last page), and what it will read:
    // the browser reader's estimate() and explain(), which must equal the library's, then the measured count.
    await page.evaluate(`(document.getElementById('newest').click(), true)`);
    const newest = await waitFor(page, `document.getElementById('t-reverse') && { rows: [...document.querySelectorAll('#newest-rows tbody tr')].map((tr) => tr.cells[0].textContent + ' ' + tr.cells[1].textContent), note: document.getElementById('newest-note').textContent, timings: [document.getElementById('t-count').textContent, document.getElementById('t-reverse').textContent] }`, 'the newest 20', 30000);
    await page.evaluate(`(document.getElementById('estimate').click(), true)`);
    const estimated = await waitFor(page, `document.getElementById('first-took') && { plan: document.getElementById('plan-note').textContent, table: document.getElementById('estimate-table') ? [...document.querySelectorAll('#estimate-table tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent)) : null, count: document.getElementById('count-took').textContent }`, 'what it will read', 30000);
    const est = SAMPLE.gallery.estimate;
    const newestRows = newest.rows.map((r) => r.slice(0, 16));
    const readsOk = newest.rows.length === 20 && newest.rows.every((r) => r.endsWith(' ACC-1042')) && JSON.stringify(newestRows) === JSON.stringify([...newestRows].sort().reverse())
      && newest.note.startsWith(`${SAMPLE.oneAccount.toLocaleString('en-US')} matches. Both give the same 20 rows`) && newest.timings.every((t) => / (ms|s)$/.test(t))
      && estimated.plan.includes(`an index: ${SAMPLE.oneAccount.toLocaleString('en-US')} candidate rows`)
      && JSON.stringify(estimated.table?.map((r) => r.slice(1, 3))) === JSON.stringify([[est.chunks, est.rows], [est.countChunks, est.countRows]].map((r) => r.map((v) => v.toLocaleString('en-US'))))
      && estimated.count.startsWith(`${SAMPLE.oneAccount.toLocaleString('en-US')} in `);
    results.push({ browser: name, label: 'the from-disk sample: Newest 20 read last first (reverse: true) as the last page, and what a filter will read (estimate(), explain()) before it runs', ok: readsOk, problems: readsOk ? [] : [JSON.stringify({ newest, estimated, est })] });

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
    const people = await waitFor(page, `!document.getElementById('people').hidden && [...document.querySelectorAll('.person')].map((p) => ({ who: p.querySelector('h2').textContent, rows: p.querySelector('.rows').textContent, columns: [...p.querySelectorAll('.columns-chips .chip:not(.off)')].map((c) => c.textContent), shapes: [...p.querySelectorAll('.shape-chips .chip')].map((c) => c.textContent), files: p.querySelectorAll('.file-list li').length, table: [...p.querySelectorAll('.rows-table th')].map((th) => th.textContent), shown: p.querySelectorAll('.rows-table tbody tr').length, hint: p.querySelector('.rows-hint').textContent, branches: p.querySelector('.rows-table th').textContent === 'branch' ? [...new Set([...p.querySelectorAll('.rows-table tbody tr')].map((tr) => tr.cells[0].textContent))] : null, tabs: [...p.querySelectorAll('.page-chips .chip:not(.off)')].map((c) => c.textContent), locked: [...p.querySelectorAll('.file-list li.locked-file > a')].map((a) => a.textContent), unknown: p.querySelectorAll('.unknown-files .chip').length }))`, 'the three keys');
    // HR's locked file: a wrong password refused, then the lock's password opens it, here in the page.
    const hrLock = `document.querySelectorAll('.person')[2].querySelector('.lock-box')`;
    await page.evaluate(`(${hrLock}.querySelector('input').value = 'wrong', ${hrLock}.querySelector('form').requestSubmit(), true)`);
    const lockWrong = await waitFor(page, `${hrLock}.querySelector('.error').textContent`, 'the wrong lock password');
    await page.evaluate(`(${hrLock}.querySelector('input').value = ${JSON.stringify(SAMPLE.gallery.sharedLock.password)}, ${hrLock}.querySelector('form').requestSubmit(), true)`);
    // The time taken shows as the file's text is written: wait for the text too.
    const lockOpened = await waitFor(page, `${hrLock}.querySelector('.took') && document.querySelectorAll('.person')[2].querySelector('.file-output').textContent.length > 0 && document.querySelectorAll('.person')[2].querySelector('.file-output').textContent.split(String.fromCharCode(10)).slice(0, 2)`, 'the HR file unlocked');
    // The masked payroll: masked with the key alone (the masked export equal to the revealed one), then unlocked: a value
    // revealed with its countdown, and both exports as the library gives them, in CSV and in JSON.
    await page.navigate(sample('masked.html'));
    await waitFor(page, `!!document.getElementById('open')`, 'the masked page');
    await page.evaluate(`(document.getElementById('open').click(), true)`);
    const payrollExports = `({ masked: exported?.masked, revealed: exported?.revealed })`;
    const payrollShown = await waitFor(page, `/rows ·/.test(${text('masked-note')}) && /rows ·/.test(${text('revealed-note')}) && { rows: ${text('rows')}, lock: ${text('lock-state')}, buttons: document.querySelectorAll('#payroll button.reveal').length, cells: [...document.querySelectorAll('#payroll tbody tr:first-child td')].map((td) => td.textContent), why: !document.getElementById('revealed-why').hidden, masked: document.getElementById('masked-output').textContent.split(String.fromCharCode(10))[0] }`, 'the payroll masked');
    const payrollLocked = await page.evaluate(payrollExports);
    await page.evaluate(`(document.getElementById('unlock').requestSubmit(), true)`);
    await waitFor(page, `/^Unlocked in /.test(${text('lock-state')}) && document.querySelectorAll('#payroll button.reveal').length > 0`, 'the payroll unlocked');
    await page.evaluate(`(document.querySelector('#payroll tbody tr:first-child td[data-column="salary"] button.reveal').click(), true)`);
    const payrollRevealed = await waitFor(page, `document.querySelector('#payroll .countdown') && { value: document.querySelector('#payroll .revealed').textContent, countdown: document.querySelector('#payroll .countdown').textContent }`, 'a salary revealed');
    const payrollUnlocked = await waitFor(page, `exported?.revealed !== ${JSON.stringify(SAMPLE.masked.csv)} && ${payrollExports}`, 'the unlocked exports');
    await page.evaluate(`(document.querySelector('#formats [data-format="json"]').click(), true)`);
    const payrollJson = await waitFor(page, `exported?.revealed?.startsWith('[') && exported.revealed`, 'the JSON export');
    const payrollOk = payrollShown.rows === `${SAMPLE.masked.rows} of ${SAMPLE.masked.rows}` && payrollShown.lock === 'Locked' && payrollShown.buttons === 0 && payrollShown.why
      && payrollShown.cells[7] === '••••' && /^a•+@harbourco\.co\.za$/.test(payrollShown.cells[4]) && payrollShown.masked.trim() === 'staff,name,branch,grade,email,account,id_number,salary'
      && payrollLocked.masked === SAMPLE.masked.csv && payrollLocked.revealed === SAMPLE.masked.csv
      && payrollRevealed.value === `R ${Number(SAMPLE.masked.firstSalary).toLocaleString('en-US', { minimumFractionDigits: 2 })}` && /^1[45] s$/.test(payrollRevealed.countdown)
      && payrollUnlocked.masked === SAMPLE.masked.unlockedCsv && payrollUnlocked.revealed === SAMPLE.masked.revealedCsv && payrollJson === SAMPLE.masked.revealedJson;
    results.push({ browser: name, label: `the demo gallery: masked columns, unlocked with the lock's password, and their exports masked and revealed, as the library gives them${fromDisk ? ', from disk' : ' (over HTTP)'}`, ok: payrollOk, problems: payrollOk ? [] : [JSON.stringify({ payrollShown, payrollRevealed, payrollLocked: { masked: payrollLocked.masked?.slice(0, 200), revealed: payrollLocked.revealed?.slice(0, 200) }, payrollUnlocked: { masked: payrollUnlocked.masked?.slice(0, 200), revealed: payrollUnlocked.revealed?.slice(0, 200) }, json: payrollJson?.slice(0, 200), expected: { csv: SAMPLE.masked.csv.slice(0, 200), revealed: SAMPLE.masked.revealedCsv.slice(0, 200) } })] });
    // signatures.html: the certified payslip in the gallery's test viewer, marked TEST; the same file in the released one.
    // Over HTTP, where the test can reach into the viewer in the page.
    await page.navigate(`${base}/e2e/sample/signatures.html`);
    await waitFor(page, `!!document.querySelector('[data-sample]')`, 'the signatures page');
    const overlayViewer = `document.querySelector('.viewer-overlay iframe').contentWindow`;
    const overlayPublisher = `document.querySelector('.viewer-overlay iframe') && ${overlayViewer}.JazminViewer?.state?.publisher?.status
      && ({ status: ${overlayViewer}.JazminViewer.state.publisher.status, badge: ${overlayViewer}.document.getElementById('jz-publisher-badge').textContent })`;
    await page.evaluate(`(document.querySelector('[data-sample="signed-document.jzm"]:not([data-viewer])').click(), true)`);
    const galleryTest = await waitFor(page, overlayPublisher, 'the certified payslip in the test viewer', 30000);
    await page.evaluate(`(document.querySelector('.viewer-overlay button').click(), document.querySelector('[data-viewer="released"]').click(), true)`);
    const galleryReleased = await waitFor(page, overlayPublisher, 'the payslip in the released viewer', 30000);
    const signaturesOk = galleryTest.status === 'certified' && galleryTest.badge === 'TEST · Verified publisher' && galleryReleased.status === 'signed';
    results.push({ browser: name, label: `the demo gallery: a certified payslip in the test viewer, marked TEST, and signed by an unknown key in the released viewer (over HTTP)`, ok: signaturesOk, problems: signaturesOk ? [] : [JSON.stringify({ galleryTest, galleryReleased })] });
    await page.navigate(sample('documents.html'));
    await waitFor(page, `!!document.getElementById('open-report')`, 'the documents page');
    await page.evaluate(`(window.statuses = [], addEventListener('message', (e) => e.data?.type === 'jazmin:status' && statuses.push(e.data.state + ' ' + e.data.name)), document.getElementById('open-report').click(), true)`);
    await waitFor(page, `statuses.length > 0`, 'the report in the viewer', 30000);
    await page.evaluate(`(document.getElementById('open-tasks').click(), true)`);
    await waitFor(page, `statuses.length > 1`, 'the task list in the viewer', 30000);
    await page.evaluate(`(document.getElementById('open-dashboard').click(), true)`);
    await waitFor(page, `statuses.length > 2`, 'the dashboard in the viewer', 30000);
    await page.evaluate(`(document.getElementById('open-client-file').click(), true)`);
    const documentStatuses = await waitFor(page, `statuses.length > 3 && statuses`, 'the client file in the viewer', 30000);
    const galleryOk = shapesShown.status.startsWith(`${SAMPLE.statementRows} transactions · 4 saved shapes · opened in `) && shapesShown.bars === SAMPLE.categories
      && JSON.stringify(shapesShown.saved) === JSON.stringify(['Chart data', 'Merchants', 'Spending by category', 'Statement']) && shapesShown.output === '['
      && labMistake === "Shape at categories[].spent.$sum: unknown or hidden column 'amont'"
      && JSON.stringify(tablesShown) === JSON.stringify(SAMPLE.bank) && JSON.stringify(perSegment) === JSON.stringify(SAMPLE.perSegment)
      && JSON.stringify(people) === JSON.stringify([
        { who: 'Cape Town manager', rows: '10 of 30', columns: ['branch', 'name', 'role', 'since', 'salary', 'bonus'], shapes: ['Cape Town pay', 'Headcount by role', 'Team list'], files: 2, table: ['name', 'role', 'salary'], shown: 6, hint: '(the first 6)', branches: null, tabs: ['Handbook'], locked: [], unknown: 5 },
        { who: 'Johannesburg team lead', rows: '10 of 30', columns: ['branch', 'name', 'role', 'since'], shapes: ['Headcount by role', 'Team list'], files: 2, table: ['name', 'role'], shown: 6, hint: '(the first 6)', branches: null, tabs: ['Handbook'], locked: [], unknown: 5 },
        { who: 'HR', rows: '30 of 30', columns: ['branch', 'name', 'role', 'since', 'salary', 'bonus'], shapes: ['Cape Town pay', 'Headcount by role', 'Pay by branch', 'Team list'], files: 7, table: ['branch', 'name', 'role', 'salary'], shown: 6, hint: '(2 from each branch)', branches: ['Cape Town', 'Johannesburg', 'Durban'], tabs: ['Handbook', 'Pay review 2027'], locked: ['hr/increases-2027.csv'], unknown: 0 },
      ])
      && lockWrong === 'Wrong password: try again' && JSON.stringify(lockOpened) === JSON.stringify(['hr/increases-2027.csv', 'name,branch,role,salary,proposed,increase'])
      && JSON.stringify(documentStatuses) === JSON.stringify(['opened report.jzm', 'locked tasks.jzm', 'opened dashboard.jzm', 'locked client-file.jzm']);
    results.push({ browser: name, label: `the demo gallery: export shapes, several tables, one file with three keys (a page and a locked file only HR sees, unlocked in the page), documents in the viewer${fromDisk ? ', from disk' : ' (over HTTP)'}`, ok: galleryOk, problems: galleryOk ? [] : [JSON.stringify({ shapesShown, labMistake, tablesShown, perSegment, people, lockWrong, lockOpened, documentStatuses, SAMPLE: { ...SAMPLE, gallery: undefined } })] });

    // Text orders, nested columns and a record written in the browser, as the library has them.
    await page.navigate(sample('sort-order.html'));
    const orderOf = (id) => `[...document.querySelectorAll('#${id} li > span')].map((e) => e.textContent)`;
    const ordered = await waitFor(page, `document.querySelectorAll('#natural li').length > 0 && { natural: ${orderOf('natural')}, plain: ${orderOf('plain')} }`, 'the two orders');
    await page.evaluate(`(document.getElementById('search').value = 'bakery', document.getElementById('search').dispatchEvent(new Event('input')), true)`);
    const bakeries = await waitFor(page, `/matching/.test(document.getElementById('note').textContent) && { natural: ${orderOf('natural')}, plain: ${orderOf('plain')} }`, 'the search in both orders');
    await page.navigate(sample('nested.html'));
    const nested = await waitFor(page, `/orders ·/.test(document.getElementById('json-took').textContent) && { nested: document.getElementById('nested-took').textContent, json: document.getElementById('json-took').textContent, rows: document.querySelectorAll('#orders tbody tr').length, saved: document.getElementById('size-saved').textContent }`, 'the nested filter');
    await page.navigate(sample('send-back.html'));
    await waitFor(page, `!document.getElementById('form').hidden`, 'the inspection form');
    // A small PNG as the photo (made here, as a camera's file would be chosen), then the file written in the browser.
    await page.evaluate(`(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 24, height: 16 });
      canvas.getContext('2d').fillRect(0, 0, 24, 16);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const files = new DataTransfer();
      files.items.add(new File([blob], 'exit.png', { type: 'image/png' }));
      document.getElementById('photo').files = files.files;
      document.getElementById('photo').dispatchEvent(new Event('change'));
      document.getElementById('note').value = 'Fire exit partly blocked by pallets: cleared while there.';
      return true;
    })()`);
    await waitFor(page, `!document.getElementById('preview').hidden`, 'the photo');
    await page.evaluate(`(document.getElementById('form').requestSubmit(), true)`);
    const sent = await waitFor(page, `!document.getElementById('result').hidden && written.blob.arrayBuffer().then((b) => ({ name: written.name, checked: document.getElementById('checked').textContent, bytes: btoa(String.fromCharCode(...new Uint8Array(b))) }))`, 'the file written in the browser');
    // The owner's side: the filing service's checks (fileSubmission), without writing (dryRun).
    let filing;
    try {
      filing = fileSubmission(path.join(temp, 'sample/data/inspections.jzm'), Buffer.from(sent.bytes, 'base64'), {
        key: fs.readFileSync(path.join(temp, 'sample/filing/owner.key'), 'utf8').trim(), keyId: sent.name.split('.')[0], dryRun: true,
      });
    } catch (error) {
      filing = { error: error.message };
    }
    const moreOk = JSON.stringify(ordered) === JSON.stringify({ natural: SAMPLE.gallery.natural, plain: SAMPLE.gallery.plain })
      && JSON.stringify(bakeries) === JSON.stringify({ natural: ['Bakery 7', 'Bakery 21', 'Sunrise Bakery'], plain: ['Bakery 21', 'Bakery 7', 'Sunrise Bakery'] })
      && nested.nested.startsWith(`${SAMPLE.gallery.ledPanels} orders · `) && nested.json.startsWith(`${SAMPLE.gallery.ledPanels} orders · `) && nested.rows === Math.min(12, SAMPLE.gallery.ledPanels) && /^\d+%$/.test(nested.saved)
      && sent.name.startsWith(`${SAMPLE.gallery.fieldKeys[0].keyId}.`) && /^Checked: it opens with the submission key: 1 record .* and 1 file \(DUR-W\d+\/photo\.png, image\/png\)\.$/.test(sent.checked)
      && filing.filed === 1 && filing.files === 1 && filing.sender === SAMPLE.gallery.fieldKeys[0].keyId;
    results.push({ browser: name, label: `the demo gallery: text orders (nocase, natural) against plain, nested columns against JSON, an inspection written in the browser that the filing service accepts${fromDisk ? ', from disk' : ' (over HTTP)'}`, ok: moreOk, problems: moreOk ? [] : [JSON.stringify({ ordered, bakeries, nested, sent: { name: sent.name, checked: sent.checked }, filing, expected: { natural: SAMPLE.gallery.natural.slice(0, 5), ledPanels: SAMPLE.gallery.ledPanels } })] });

    // Over HTTP, where the test can reach into the viewer in the page: the client file's pages as tabs (its own files
    // and pages out of the Files tab), the report's Files tab without its own files, and the contracts' lock naming
    // the key service (the service itself isn't run here: two-factor.html shows it working).
    await page.navigate(`${base}/e2e/sample/documents.html`);
    await waitFor(page, `!!document.getElementById('open-report')`, 'the documents page');
    const inOverlay = `document.querySelector('.viewer-overlay iframe').contentWindow`;
    await page.evaluate(`(document.getElementById('open-report').click(), true)`);
    const reportFiles = await waitFor(page, `document.querySelector('.viewer-overlay iframe') && ${inOverlay}.JazminViewer?.state?.lastReady && [...${inOverlay}.document.querySelectorAll('#jz-files .path')].map((e) => e.textContent)`, 'the report in the viewer', 30000);
    await page.evaluate(`(document.querySelector('.viewer-overlay .bar button').click(), document.getElementById('open-client-file').click(), true)`);
    await waitFor(page, `document.querySelector('.viewer-overlay iframe') && ${inOverlay}.document?.getElementById('jz-unlock')?.hidden === false`, 'the client file locked', 30000);
    await page.evaluate(`(${inOverlay}.document.getElementById('jz-key').value = 'demo', ${inOverlay}.document.getElementById('jz-unlock').requestSubmit(), true)`);
    const shownPage = (what) => waitFor(page, `${inOverlay}.JazminViewer.state.lastReady?.info?.page === '${what}' && ${inOverlay}.JazminViewer.state.lastReady.info`, `the ${what} page`, 30000);
    const clientsPage = await shownPage('clients');
    const tabs = await page.evaluate(`[...${inOverlay}.document.querySelectorAll('#jz-pages button')].map((b) => b.textContent.trim())`);
    const filesTab = await page.evaluate(`${inOverlay}.document.getElementById('jz-tab-files').hidden`);
    await page.evaluate(`(${inOverlay}.document.querySelector('#jz-pages button[data-page="statement.html"]').click(), true)`);
    const statementPage = await shownPage('statement');
    await page.evaluate(`(${inOverlay}.document.querySelector('#jz-pages button[data-page="transactions.html"]').click(), true)`);
    const transactionsPage = await shownPage('transactions');
    await page.navigate(`${base}/js/viewer/index.html`);
    await waitFor(page, `typeof JazminViewer === 'object'`, 'the viewer');
    await page.evaluate(`fetch('/e2e/sample/data/contracts.jzm').then((r) => r.blob()).then((b) => JazminViewer.choose(b, 'contracts.jzm')).then(() => true)`);
    await waitFor(page, `document.getElementById('jz-unlock')?.hidden === false`, 'the unlock form');
    await page.evaluate(`(document.getElementById('jz-key').value = ${JSON.stringify(SAMPLE.gallery.twoFactor.contracts.key)}, document.getElementById('jz-unlock').requestSubmit(), true)`);
    const contractFiles = await waitFor(page, `document.querySelectorAll('#jz-files li').length === 4 && [...document.querySelectorAll('#jz-files li')].map((li) => li.querySelector('.path').textContent + (li.querySelector('.locked') ? ':locked' : ''))`, 'the contracts listed');
    await page.evaluate(`([...document.querySelectorAll('#jz-files li')].find((li) => li.querySelector('.locked')).querySelector('button').click(), true)`);
    const signIn = await waitFor(page, `document.getElementById('jz-lock').open && document.getElementById('jz-lock-service').textContent`, 'the unlock dialog');
    const pagesOk = JSON.stringify(reportFiles) === JSON.stringify(['index.html']) && JSON.stringify(tabs) === JSON.stringify(['Clients', 'Transactions', 'Summary', 'Statement'])
      && filesTab === true && clientsPage.rows === 250 && statementPage.print === true && statementPage.lines > 0 && transactionsPage.rows > 0
      && JSON.stringify(contractFiles) === JSON.stringify(['contracts/chief-executive.html:locked', 'contracts/chief-operating-officer.html:locked', 'contracts/financial-director.html:locked', 'terms-of-reference.html'])
      && signIn === 'Sign in at localhost:5080';
    results.push({ browser: name, label: "the demo gallery: the client file's four pages as tabs, documents' own files out of the Files tab, contracts locked by a lock that names the key service", ok: pagesOk, problems: pagesOk ? [] : [JSON.stringify({ reportFiles, tabs, filesTab, clientsPage, statementPage, transactionsPage, contractFiles, signIn })] });
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
