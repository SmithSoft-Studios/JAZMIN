// Checks that the previous release reads the files this one writes (release checklist: "1.6.x reads 1.7 files"). It
// writes one file for each kind of file added since then, installs the previous release from npm in a scratch folder,
// and opens each with it as its users would: what they must read, and what they must refuse or not see. The .NET twin,
// dotnet/scripts/compat-previous.cs, reads the same files with the previous NuGet package.
//
//   node scripts/compat-previous.mjs [--version 1.6.2] [--out <folder>]   (the files and keys.json stay in --out)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { JazminKey, open, update, write } from '../src/index.js';

const { values: args } = parseArgs({ options: { version: { type: 'string', default: '1.6.2' }, out: { type: 'string' } } });
if (!/^\d+\.\d+\.\d+$/.test(args.version)) throw new Error(`--version is a release such as 1.6.2, not '${args.version}'`);
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-compat-')));
fs.mkdirSync(out, { recursive: true });

// ---- the files: one per kind added since the previous release ---------------------------------------------------
const columns = [{ name: 'id', type: 'int' }, { name: 'region', type: 'string' }, { name: 'name', type: 'string' }, { name: 'account', type: 'string' }];
const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, region: ['North', 'South', 'East'][i % 3], name: `file${(i * 7) % 23}`, account: `4821 ${String(1000 + i)}` }));
const owner = JazminKey.generate();
const reader = owner.createAccessKey();
const keys = { owner: owner.toString(), reader: reader.toString() };
const file = (name) => path.join(out, name);

// Other text orders (spec 6.7): sorted by region, then name ignoring case with its numbers by value.
write(file('sort.jzm'), rows, { columns, chunkRows: 16 });
update(file('sort.jzm'), { sortedBy: ['region', { column: 'name', nocase: true, natural: true }] });
// The package's newer settings: online (6.8), keyService (6.8.2), masks (7.6.8).
write(file('package.jzm'), rows, {
  columns, files: [{ path: 'index.html', content: '<p>Chart</p>' }],
  package: {
    entry: 'index.html', title: 'Online', allowedOrigins: ['https://cdn.jsdelivr.net'], online: 'required',
    keyService: 'https://keys.example.com/unlock', masks: { account: { seconds: 10 } },
  },
});
// Stored-file options (#188): a page's own file (list: false) and actions per file group, in a shared file.
write(file('file-options.jzm'), rows, {
  columns, key: owner, access: { partitionBy: 'region', grants: [{ key: reader, rows: '*' }] },
  files: [
    { path: 'index.html', content: '<p>Page</p>' }, { path: 'font.woff2', content: 'font', actions: { list: false } },
    { path: 'terms.pdf', content: 'terms', groups: ['North', 'South'], groupActions: { North: { save: false }, South: { print: false } } },
  ],
});
// Locked stored files (6.8.1): one open file, one locked.
write(file('locks.jzm'), rows, {
  columns, key: owner, access: { grants: [{ key: reader }] },
  files: [{ path: 'readme.txt', content: 'open' }, { path: 'contract.pdf', content: 'locked', lock: 'contracts' }],
  locks: { contracts: { password: 'pw', iterations: 1000 } },
});
// Masked columns (7.6.8): account masked with its format kept, and viewer settings in a file with no stored files.
write(file('masks.jzm'), rows, {
  columns: columns.map((c) => (c.name === 'account' ? { ...c, mask: { lock: 'pay', show: { keepFormat: true, last: 4 } } } : c)),
  key: owner, access: { grants: [{ key: reader }] }, locks: { pay: { password: 'pw', iterations: 1000 } },
  package: { masks: { account: { seconds: 10 } } },
});
// Document pages (6.8): two pages with their own tables' settings, the document's own files, and a page only one
// file group knows of.
write(file('pages.jzm'), rows, {
  columns, key: owner, access: { partitionBy: 'region', grants: [{ key: reader, rows: '*' }] },
  files: [
    { path: 'index.html', content: 'overview' }, { path: 'detail.html', content: 'detail' }, { path: 'app.js', content: 'js' },
    { path: 'board.html', content: 'board', groups: ['North'], page: { title: 'Board', order: 1 } },
  ],
  package: { pages: [{ path: 'index.html', title: 'Overview' }, { path: 'detail.html', title: 'Detail', actions: { print: false } }], files: ['app.js'] },
});
fs.writeFileSync(file('keys.json'), JSON.stringify(keys, null, 2));

// ---- the previous release ------------------------------------------------------------------------------------------
const install = path.join(out, `npm-${args.version}`);
fs.mkdirSync(install, { recursive: true });
execSync(`npm install @smithsoft-studios/jazmin@${args.version} --prefix "${install}" --no-audit --no-fund --silent`, { stdio: 'inherit' });
const entry = createRequire(path.join(install, 'x.js')).resolve('@smithsoft-studios/jazmin');
const previous = await import(pathToFileURL(entry).href);

// ---- what it reads ----------------------------------------------------------------------------------------------
const results = [];
function check(label, fn) {
  try {
    const problem = fn();
    results.push({ label, ok: !problem, problem });
  } catch (error) {
    results.push({ label, ok: false, problem: `${error.name}: ${error.message}` });
  }
}
const as = (name, key) => previous.open(fs.readFileSync(file(name)), key ? { key, accessState: false } : {});
const same = (a, b) => (JSON.stringify(a) === JSON.stringify(b) ? null : `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const plain = (r) => [...r.rows()].map((x) => ({ ...x, id: Number(x.id) }));
const refuses = (fn, pattern) => {
  try {
    fn();
    return 'not refused';
  } catch (error) {
    return error instanceof previous.JazminError && pattern.test(error.message) ? null : `${error.name}: ${error.message}`;
  }
};

check('other text orders: every row, in the file\'s order; sortedBy is the plain leading key', () => {
  const now = open(file('sort.jzm'));
  const r = as('sort.jzm');
  return same([plain(r), r.sortedBy], [plain(now), ['region']]) ?? same([...r.find({ region: 'East' })].length, 20);
});
check('the newer package settings: the document and its settings that version knows', () => {
  const r = as('package.jzm');
  return same([r.package.entry, r.package.title, r.package.allowedOrigins, r.rowCount], ['index.html', 'Online', ['https://cdn.jsdelivr.net'], 60]);
});
check('stored-file options: the files, rows and each file\'s content', () => {
  const r = as('file-options.jzm', keys.reader);
  return same([r.files.map((f) => f.path).sort(), r.rowCount, Buffer.from(r.readFile('terms.pdf')).toString()], [['font.woff2', 'index.html', 'terms.pdf'], 60, 'terms']);
});
check('locked files: the rows and the open file; the locked one refused (it has no key there)', () => {
  const r = as('locks.jzm', keys.reader);
  return same([r.rowCount, Buffer.from(r.readFile('readme.txt')).toString()], [60, 'open']) ?? refuses(() => r.readFile('contract.pdf'), /key/i);
});
check('masked columns: an access key reads the rows and what the column shows, never the masked values', () => {
  const r = as('masks.jzm', keys.reader);
  const first = [...r.rows()][0];
  return same([r.columns.map((c) => c.name), first.account_shown, 'account' in first], [['id', 'region', 'name', 'account_shown'], '•••• 1000', false]);
});
check('document pages: the rows, the entry page, and every page and file as a stored file', () => {
  const r = as('pages.jzm', keys.reader);
  return same([r.rowCount, r.package.entry, r.files.map((f) => f.path).sort(), Buffer.from(r.readFile('board.html')).toString()],
    [60, 'index.html', ['app.js', 'board.html', 'detail.html', 'index.html'], 'board']);
});
check('masked columns: the owner reads every column', () => {
  const r = as('masks.jzm', keys.owner);
  return same([...r.rows()][0].account, '4821 1000');
});

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${args.version} ${r.label}${r.ok ? '' : `\n       ${r.problem}`}`);
console.log(`\nFiles and keys in ${out}. .NET: dotnet run -c Release dotnet/scripts/compat-previous.cs -- "${out}"`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
