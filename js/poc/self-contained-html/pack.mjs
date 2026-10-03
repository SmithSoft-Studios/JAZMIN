// Builds one self-contained HTML file: viewer + browser reader + two embedded JAZMIN files
// (the template's files, and the statement data), encrypted with one key.
//
//   node poc/self-contained-html/pack.mjs                      # new random key, printed once
//   node poc/self-contained-html/pack.mjs --key jzk1-...       # your key
//   node poc/self-contained-html/pack.mjs --no-key             # unencrypted
//   options: --out <file.html>  --template <dir>  --test-key (embeds the key: automated tests only)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JazminKey, write } from '../../src/index.js';
import { sampleStatement } from './sample-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(here, 'out', 'statement.html') },
    template: { type: 'string', default: path.join(here, 'template') },
    key: { type: 'string' },
    'no-key': { type: 'boolean', default: false },
    'test-key': { type: 'boolean', default: false },
  },
});

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain',
};

function templateFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    if (e.isDirectory()) return templateFiles(path.join(dir, e.name), rel + '/');
    return [{ path: rel, mime: MIME[path.extname(e.name).toLowerCase()] ?? 'application/octet-stream', content: fs.readFileSync(path.join(dir, e.name)) }];
  });
}

const key = args['no-key'] ? null : args.key ? JazminKey.parse(args.key) : JazminKey.generate();
const files = templateFiles(args.template);
const statement = sampleStatement();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-pack-'));
try {
  const assetsFile = path.join(tmp, 'assets.jzm');
  const dataFile = path.join(tmp, 'data.jzm');
  write(assetsFile, files, {
    columns: [
      { name: 'path', type: 'string', nullable: false, index: 'sorted' },
      { name: 'mime', type: 'string', nullable: false },
      { name: 'content', type: 'binary', nullable: false },
    ],
    metadata: { kind: 'jazmin-web-package', entry: 'index.html' },
    ...(key ? { key } : {}),
  });
  write(dataFile, statement.rows, { columns: statement.columns, metadata: statement.metadata, ...(key ? { key } : {}) });

  const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fill = {
    TITLE: escapeHtml(statement.metadata.title),
    ASSETS: fs.readFileSync(assetsFile).toString('base64'),
    DATA: fs.readFileSync(dataFile).toString('base64'),
    BOOTSTRAP: read('viewer/bootstrap.js'),
    READER: read('jazmin-browser.js'),
    VIEWER: read('viewer/viewer.js'),
    TEST_HOOK: args['test-key'] && key ? `<script>window.JAZMIN_TEST_KEY = ${JSON.stringify(key.toString())};</script>` : '',
  };
  for (const name of ['BOOTSTRAP', 'READER', 'VIEWER']) {
    if (/<\/script/i.test(fill[name])) throw new Error(`${name} must not contain "</script"`);
  }
  // split/join rather than replace(): the sources contain "$" sequences that replace() would interpret.
  const html = Object.entries(fill).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(v), read('viewer/viewer.html'));
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, html);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const raw = files.reduce((n, f) => n + f.content.length, 0);
  console.log(`Wrote ${args.out} (${kb(html.length)})`);
  console.log(`  template: ${files.length} files, ${kb(raw)} -> ${kb(fs.statSync(assetsFile).size)} packed`);
  console.log(`  data: ${statement.rows.length} rows -> ${kb(fs.statSync(dataFile).size)} packed`);
  if (!files.some((f) => f.path.startsWith('vendor/'))) console.log('  (no jsPDF: run fetch-vendor.mjs to enable "Download PDF")');
  if (key && !args.key) console.log(`  key (shown once - keep it safe): ${key}`);
  else if (!key) console.log('  not encrypted');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
