// Server-side helpers (TASKS F-3): embedded files served by path (ranges, ETags, the document policy, access per key),
// a Node request handler, and the same template rendered to PDF as the viewer renders it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { after, test } from 'node:test';
import { JazminKey, createFileHandler, documentPolicy, open, renderImage, renderPdf, serveFiles, write } from '../src/index.js';
import { TEMPLATE_READY, writeTemplate } from './template-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-server-'));
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));

/** A file with a page and a 600,000-byte file (three blocks of 256 KiB), with a key. */
function filesFile() {
  const key = JazminKey.generate();
  const big = Buffer.alloc(600_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
  const target = path.join(temp, `files-${Date.now()}-${Math.random()}.jzm`);
  write(target, [{ n: 1 }], {
    key,
    files: [
      { path: 'index.html', content: '<!doctype html><p>Page</p>' },
      { path: 'media/big file.bin', content: big },
      { path: 'img/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    ],
    package: { entry: 'index.html', allowedOrigins: ['https://fonts.example.com'] },
  });
  return { reader: open(target, { key: key.export() }), big };
}

const read = async (stream) => {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
};

test('files are served by path, whole or a byte range, with ETags, types and the document policy', async () => {
  const { reader, big } = filesFile();
  try {
    const handle = createFileHandler(reader);
    const whole = handle('/media/big%20file.bin');
    assert.equal(whole.status, 200);
    assert.deepEqual(whole.body, big);
    assert.deepEqual(await read(whole.stream()), big);
    const { sha256 } = reader.files.find((f) => f.path === 'media/big file.bin');
    assert.deepEqual(
      { type: whole.headers['content-type'], length: whole.headers['content-length'], etag: whole.headers.etag, ranges: whole.headers['accept-ranges'], sniff: whole.headers['x-content-type-options'] },
      { type: 'application/octet-stream', length: '600000', etag: `"${sha256}"`, ranges: 'bytes', sniff: 'nosniff' },
    );
    assert.equal(whole.headers['content-security-policy'], undefined);

    for (const [range, start, end] of [['bytes=0-99', 0, 100], ['bytes=262100-262299', 262100, 262300], ['bytes=599900-', 599900, 600000], ['bytes=-50', 599950, 600000], ['bytes=10-9999999', 10, 600000]]) {
      const part = handle('media/big file.bin', { range });
      assert.equal(part.status, 206, range);
      assert.equal(part.headers['content-range'], `bytes ${start}-${end - 1}/600000`, range);
      assert.equal(part.headers['content-length'], String(end - start), range);
      assert.deepEqual(part.body, big.subarray(start, end), range);
      assert.deepEqual(await read(part.stream()), big.subarray(start, end), range);
    }
    assert.equal(handle('media/big file.bin', { range: 'bytes=600000-' }).status, 416);
    assert.equal(handle('media/big file.bin', { range: 'bytes=600000-' }).headers['content-range'], 'bytes */600000');
    assert.equal(handle('media/big file.bin', { range: 'bytes=0-1,5-6' }).status, 200); // several ranges: the whole file
    assert.equal(handle('media/big file.bin', { ifNoneMatch: `"${sha256}"` }).status, 304);
    const head = handle('media/big file.bin', { method: 'HEAD' });
    assert.deepEqual([head.status, head.headers['content-length'], head.body.length], [200, '600000', 0]);
    assert.equal(handle('nope.txt').status, 404);
    assert.equal(handle('index.html', { method: 'POST' }).status, 405);
    assert.equal(handle('%E0%A4%A').status, 400);

    // Pages and SVG run script: they get the document's policy, sandboxed away from the server's own origin.
    for (const page of ['index.html', 'img/logo.svg']) {
      const policy = handle(page).headers['content-security-policy'];
      assert.match(policy, /default-src 'none'/, page);
      assert.match(policy, /font-src blob: data: 'self' https:\/\/fonts\.example\.com/, page);
      assert.match(policy, /sandbox allow-scripts/, page);
    }
    assert.doesNotMatch(createFileHandler(reader, { sandbox: false })('index.html').headers['content-security-policy'], /sandbox/);
  } finally {
    reader.close();
  }
});

test('an access key is served only the files it can see', () => {
  const reader = open(path.join(fixtures, 'js-files-access.jzm'), { key: keys.bob });
  try {
    const handle = createFileHandler(reader);
    assert.equal(handle('docs/za.bin').status, 200);
    assert.equal(handle('docs/shared.bin').status, 404); // Sally's, not Bob's
  } finally {
    reader.close();
  }
});

test('serveFiles serves under a prefix, streams ranges, and passes other requests on', async () => {
  const { reader, big } = filesFile();
  const files = serveFiles(reader, { prefix: '/files/' });
  const server = http.createServer((req, res) => files(req, res, () => {
    res.writeHead(418);
    res.end('next');
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const whole = await fetch(`${base}/files/media/big%20file.bin`);
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), big);
    const part = await fetch(`${base}/files/media/big%20file.bin`, { headers: { range: 'bytes=300000-300009' } });
    assert.equal(part.status, 206);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), big.subarray(300000, 300010));
    assert.equal((await fetch(`${base}/files/missing.txt`)).status, 418); // not a file: the next handler
    assert.equal((await fetch(`${base}/elsewhere`)).status, 418);
    const page = await fetch(`${base}/files/index.html`);
    assert.match(page.headers.get('content-security-policy'), /sandbox/);
  } finally {
    server.close();
    reader.close();
  }
});

test("the document policy is the viewer's", () => {
  const source = fs.readFileSync(path.resolve(here, '../viewer/viewer.js'), 'utf8').replace(/\r\n/g, '\n'); // Windows checkouts: CRLF
  const start = source.indexOf('function policy(settings) {');
  const end = source.indexOf('\n  }\n', start);
  const viewerPolicy = vm.runInNewContext(`(${source.slice(start, end + 4)})`);
  for (const settings of [{}, { allowedOrigins: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] }, { allowedOrigins: ['https://api.example.com'], allowWasm: true }]) {
    assert.equal(documentPolicy(settings), viewerPolicy(settings), JSON.stringify(settings));
  }
});

// ---- PDFs: the template the viewer's browser test renders, rendered here through Playwright and Puppeteer ----------

/** Chrome or Edge, through Playwright and through Puppeteer (the installed browsers: neither package downloads one). */
async function launch() {
  const drivers = [];
  const { chromium } = await import('playwright-core');
  for (const channel of process.env.JAZMIN_BROWSER ? [process.env.JAZMIN_BROWSER] : ['chrome', 'msedge']) {
    try {
      drivers.push({ name: `Playwright (${channel})`, browser: await chromium.launch({ channel }) });
      break;
    } catch {
      // not installed: try the next one
    }
  }
  const puppeteer = (await import('puppeteer-core')).default;
  try {
    drivers.push({ name: 'Puppeteer (chrome)', browser: await puppeteer.launch({ channel: 'chrome', headless: true }) });
  } catch {
    // Chrome not installed (Puppeteer's channels are Chrome's)
  }
  return drivers;
}

const drivers = await launch();
after(() => Promise.all(drivers.map((d) => d.browser.close())));
if (drivers.length === 0) test('PDFs (no Chrome or Edge installed)', { skip: 'no Chrome or Edge installed' }, () => {});

for (const { name, browser } of drivers) {
  test(`${name}: a template renders to PDF with the answers it gets in the viewer`, async () => {
    const key = JazminKey.generate();
    const file = path.join(temp, `template-${name.split(' ')[0]}.jzm`);
    writeTemplate(write, file, { key });
    let info;
    const downloads = [];
    const pdf = await renderPdf({ file, key: key.export(), browser, onReady: (i) => { info = i; }, onDownload: (d) => downloads.push(d) });
    assert.deepEqual(info, TEMPLATE_READY);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length >= 1);
    assert.deepEqual(downloads, []);
  });

  test(`${name}: a document reaches only its files and allowed origins, downloads through renderPdf, and can be rendered on load`, async () => {
    const file = path.join(temp, `origins-${name.split(' ')[0]}.jzm`);
    write(file, [{ n: 1 }], {
      files: [
        { path: 'index.html', content: '<!doctype html><body><p>Hello</p><script src="app.js"></script></body>' },
        {
          path: 'app.js',
          content: `(async () => {
            const tried = async (url) => { try { await fetch(url); return 'reached'; } catch { return 'refused'; } };
            const other = await tried('https://other.example.org/secret');
            const local = await tried('http://127.0.0.1:9/');
            jazmin.download('report.txt', 'from the document', 'text/plain');
            jazmin.ready({ other, local });
          })();`,
        },
      ],
      package: { entry: 'index.html', allowedOrigins: ['https://fonts.example.com'] },
    });
    let info;
    const downloads = [];
    await renderPdf({ file, browser, onReady: (i) => { info = i; }, onDownload: (d) => downloads.push(d) });
    assert.deepEqual(info, { other: 'refused', local: 'refused' });
    assert.deepEqual(downloads.map((d) => [d.filename, d.type, d.bytes.toString()]), [['report.txt', 'text/plain', 'from the document']]);

    // A document that never calls jazmin.ready(): rendered on load, or refused after the timeout.
    const plain = path.join(fixtures, 'js-files-key.jzm');
    const loaded = await renderPdf({ file: plain, key: keys.key, browser, waitFor: 'load' });
    assert.equal(loaded.subarray(0, 5).toString('latin1'), '%PDF-');
    await assert.rejects(renderPdf({ file: plain, key: keys.key, browser, timeout: 1500 }), /did not call jazmin\.ready\(\)/);
    await assert.rejects(renderPdf({ file: path.join(fixtures, 'js-key.jzm'), key: keys.key, browser }), /no document/);
  });

  test(`${name}: a printed document is told so (jazmin.mode), sees only the filter's rows, and gets the package's page settings`, async () => {
    const file = path.join(temp, `print-${name.split(' ')[0]}.jzm`);
    const rows = Array.from({ length: 30 }, (_, i) => ({ account: `A${i % 3}`, amount: `${i}.50` }));
    write(file, rows, {
      columns: [{ name: 'account', type: 'string' }, { name: 'amount', type: 'decimal' }],
      files: [
        { path: 'index.html', content: '<!doctype html><body><p id="out"></p><script src="app.js"></script></body>' },
        {
          path: 'app.js',
          content: `(async () => {
            const all = jazmin.rows().map((r) => r.account);
            const page = (await jazmin.query({ amount: { gte: 20 } }, { orderBy: 'amount' })).map((r) => r.amount);
            document.getElementById('out').textContent = jazmin.mode;
            jazmin.ready({ mode: jazmin.mode, filter: jazmin.filter, rowCount: jazmin.rowCount, count: await jazmin.count(), all, page });
          })();`,
        },
      ],
      package: { entry: 'index.html', pdf: { format: 'Letter', landscape: true } },
    });
    let info;
    const pdf = await renderPdf({ file, browser, filter: { account: 'A1' }, onReady: (i) => { info = i; } });
    const a1 = rows.filter((r) => r.account === 'A1');
    assert.deepEqual(info, {
      mode: 'print', filter: { account: 'A1' }, rowCount: a1.length, count: a1.length, all: a1.map((r) => r.account),
      page: a1.filter((r) => Number(r.amount) >= 20).map((r) => r.amount),
    });
    // The package's page settings: Letter, landscape (792 x 612 points); the caller's override them.
    const box = (bytes) => bytes.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/).slice(1).map(Number);
    assert.deepEqual(box(pdf), [792, 612]);
    // Page sizes in points, give or take a point or two by driver (browsers round them).
    const near = (bytes, [w, h]) => {
      const [bw, bh] = box(bytes);
      assert.ok(Math.abs(bw - w) <= 1.5 && Math.abs(bh - h) <= 1.5, `${bw} x ${bh}, not ${w} x ${h}`);
    };
    near(await renderPdf({ file, browser, pdf: { format: 'A4', landscape: false } }), [595, 842]);
    await assert.rejects(renderPdf({ file, browser, filter: { nope: 1 } }), /unknown column 'nope'/);

    // The page's file's settings (actions.pdf) over the package's, and the page's own (setActions) over both. A page
    // being rendered is offered nothing more (jazmin.actions).
    const pages = path.join(temp, `pages-${name.split(' ')[0]}.jzm`);
    const script = (code) => `(async () => {
      ${code};
      const save = await jazmin.saveChanges({ update: [] }).then(() => 'saved', (e) => e.message);
      jazmin.ready({ actions: jazmin.actions, edit: jazmin.edit, save });
    })();`;
    write(pages, rows, {
      files: [
        { path: 'file.html', content: '<!doctype html><body>file<script src="file.js"></script></body>', actions: { pdf: { format: 'A5' } } },
        { path: 'file.js', content: script('') },
        { path: 'own.html', content: '<!doctype html><body>own<script src="own.js"></script></body>', actions: { pdf: { format: 'A5' } } },
        { path: 'own.js', content: script("jazmin.setActions({ pdf: { format: 'A3' } })") },
        { path: 'bad.html', content: '<!doctype html><body>bad<script src="bad.js"></script></body>' },
        { path: 'bad.js', content: script("jazmin.setActions({ pdf: { format: 'Z9' } })") },
      ],
      package: { entry: 'file.html', pdf: { format: 'Letter', landscape: true } },
    });
    let seen;
    near(await renderPdf({ file: pages, browser, onReady: (i) => { seen = i; } }), [595, 420]); // A5, landscape
    assert.deepEqual(seen, { actions: { print: false, pdf: false, image: false }, edit: null, save: "This document can't save changes here" });
    near(await renderPdf({ file: pages, browser, entry: 'own.html' }), [1191, 842]); // A3, landscape
    near(await renderPdf({ file: pages, browser, entry: 'own.html', pdf: { landscape: false } }), [842, 1191]);
    await assert.rejects(renderPdf({ file: pages, browser, entry: 'bad.html' }), /The page's jazmin\.setActions pdf\.format: 'Z9'/);
    // A viewer's defaults (pdfDefaults) count only where the document sets nothing: the package's Letter wins here.
    near(await renderPdf({ file: pages, browser, entry: 'file.html', pdfDefaults: { format: 'A3', landscape: false } }), [595, 420]);
    const bare = path.join(temp, `bare-${name.split(' ')[0]}.jzm`);
    write(bare, rows, { files: [{ path: 'index.html', content: '<p>bare</p>' }], package: { entry: 'index.html' } });
    near(await renderPdf({ file: bare, browser, waitFor: 'load', pdfDefaults: { format: 'A5', landscape: true } }), [595, 420]);
    await assert.rejects(renderPdf({ file: bare, browser, waitFor: 'load', pdfDefaults: { format: 'A5', path: 'x.pdf' } }), /pdfDefaults: unknown setting 'path'/);

    // An image of it: PNG, the viewport's width.
    const png = await renderImage({ file, browser, viewport: { width: 640, height: 400 } });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 640); // IHDR width
  });
}
