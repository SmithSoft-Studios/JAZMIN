// Builds the from-disk sample (README.md): a folder you can copy anywhere and open by double-clicking index.html, with
// no web server and no Node. It holds the pages, the viewer, the browser reader, and demo files (demo-data.mjs):
// - data/statement.jzm: one account's statement for three months, with export shapes saved in it, also made into a
//   script (statement.jzm.js), which small-file.html and shapes.html open with no choosing;
// - data/transactions.jzm: many accounts' transactions for a year (1,000,000 by default), sorted by date, with indexes
//   on the columns people filter by and export shapes saved in it, for pick-file.html;
// - data/bank.jzm: clients and their transactions, two tables linked by a saved shape (tables.html);
// - data/report.jzm and data/tasks.jzm: documents, a print-ready report and a task list that saves changes
//   (documents.html shows them in the viewer);
// - data/shared.jzm: one file with access keys that see different rows, columns, files and shapes (shared.html);
// - data/remco.jzm: executives' pay, opened with an online access key: the sample key service gives its unlock token
//   only after a code from an authenticator app (two-factor.html). key-service/tokens.json is what that service reads;
// - data/payroll-masked.jzm: a payroll whose private columns are masked until a lock's password opens them (masked.html).
// Every file is locked with the password "demo", except the report (open to anyone) and the shared file (access keys,
// in data/shared-keys.js for this demo only: real keys never belong in a page). The payroll's key and its lock's
// password are in data/masked-keys.js, for this demo only too.
// Run: node examples/from-disk/make.mjs [folder] [--rows n]
//      (default folder: examples/from-disk/site; --rows: transactions in transactions.jzm, 0 for none)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JazminKey, inspect, listFileUnlockTokens, listUnlockTokens, open, portableScript, update, write } from '../../src/index.js';
import {
  bank, branchSales, branchTargets, contracts, customers, executives, inspections, orders, payroll, staff, statement, tasks, transactions,
} from './demo-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { rows: { type: 'string', default: '1000000' } } });
const site = path.resolve(positionals[0] ?? path.join(here, 'site'));
const rows = Number(values.rows);
if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('--rows must be a whole number');

// The pages, and beside them the viewer and the browser reader, as the npm package has them
// (node_modules/@smithsoft-studios/jazmin/viewer and .../browser).
fs.cpSync(path.join(here, 'pages'), site, { recursive: true });
fs.mkdirSync(path.join(site, 'viewer'), { recursive: true });
for (const file of ['index.html', 'viewer.js', 'viewer.css', 'sandbox.js', 'icon-32.png']) fs.copyFileSync(path.join(js, 'viewer', file), path.join(site, 'viewer', file));
// The JAZMIN logo: the start page's, and the pages' tab icon.
fs.copyFileSync(path.join(js, '../docs/images/jazmin-logo.png'), path.join(site, 'logo.png'));
fs.copyFileSync(path.join(js, 'viewer/icon-32.png'), path.join(site, 'favicon.png'));
fs.mkdirSync(path.join(site, 'browser'), { recursive: true });
// The full script, and the core with its add-ons, which the demo pages load only as they need them.
for (const name of ['jazmin-browser.js', 'jazmin-browser-core.js', 'jazmin-browser-shapes.js', 'jazmin-browser-writer.js', 'jazmin-browser-queries.js']) {
  fs.copyFileSync(path.join(js, 'browser', name), path.join(site, 'browser', name));
}
fs.mkdirSync(path.join(site, 'data'), { recursive: true });

// Export shapes saved in the files (USER-GUIDE 21.7): offered by name in the viewer's Export menu and in shapes.html.
const spent = { amount: { lt: '0' } };
const spendingByCategory = { $filter: spent, $groupBy: 'category', $sort: ['category'], $rows: { category: 'category', spent: { $sum: 'amount' }, payments: { $count: true } } };

// One account's statement: small, so a page can open it with no choosing, as a script.
const file = path.join(site, 'data/statement.jzm');
const { rows: statementRows, openingBalance } = statement();
write(file, statementRows, {
  columns: [{ name: 'date', type: 'datetime' }, { name: 'merchant', type: 'string' }, { name: 'category', type: 'string' }, { name: 'amount', type: 'decimal' }],
  metadata: { holder: 'Demo Customer', account: 'ACC-1042', period: 'January to March 2026', currency: 'ZAR', openingBalance },
  password: 'demo',
  shapes: [
    { name: 'Spending by category', description: 'What went out, per category: the total and how many payments', default: true, shape: spendingByCategory },
    {
      name: 'Chart data', description: "A bar chart's labels and values (Chart.js and the like), in one call",
      shape: {
        labels: { $filter: spent, $groupBy: 'category', $sort: ['category'], $rows: 'category' },
        data: { $filter: spent, $groupBy: 'category', $sort: ['category'], $rows: { $sum: 'amount' } },
      },
    },
    { name: 'Merchants', description: 'Each merchant once: its category, visits and total', shape: { $groupBy: 'merchant', $sort: ['merchant'], $rows: { merchant: 'merchant', category: 'category', visits: { $count: true }, total: { $sum: 'amount' } } } },
    {
      name: 'Statement', description: 'The holder and period, then every transaction: good as XML',
      shape: { holder: { $meta: 'holder' }, account: { $meta: 'account' }, period: { $meta: 'period' }, transactions: { $rows: { date: 'date', merchant: 'merchant', amount: 'amount' }, $xmlItem: 'transaction' } },
    },
  ],
});
fs.writeFileSync(`${file}.js`, portableScript(file)); // the same as `jazmin script data/statement.jzm`

// Many accounts' transactions: written in date order (sortedBy), with indexes on the columns people filter by, so those
// filters read only what they need.
if (rows) {
  const big = path.join(site, 'data/transactions.jzm');
  const started = Date.now();
  process.stdout.write(`Writing ${rows.toLocaleString('en-US')} transactions... `);
  write(big, transactions(rows), {
    columns: [
      { name: 'date', type: 'datetime' }, { name: 'account', type: 'string' }, { name: 'merchant', type: 'string' },
      { name: 'category', type: 'string' }, { name: 'city', type: 'string' }, { name: 'amount', type: 'decimal' },
    ],
    sortedBy: ['date'],
    indexes: { account: 'sorted', merchant: ['sorted', 'trigram'], category: 'sorted', amount: 'sorted' },
    metadata: { title: 'Card transactions, 2026 (demo data)', currency: 'ZAR' },
    password: 'demo',
    shapes: [
      { name: 'Spending by category', description: 'What went out, per category', default: true, shape: spendingByCategory },
      { name: 'Accounts', description: 'Each account: its transactions and their total', shape: { $groupBy: 'account', $sort: ['account'], $rows: { account: 'account', transactions: { $count: true }, total: { $sum: 'amount' } } } },
      { name: 'Cities', description: 'Card spending per city', shape: { $filter: spent, $groupBy: 'city', $sort: ['city'], $rows: { city: 'city', spent: { $sum: 'amount' }, payments: { $count: true } } } },
    ],
  });
  console.log(`${(fs.statSync(big).size / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// Several tables: clients, and their transactions sorted by client and date, so a shape that nests each client's
// transactions reads both tables once, in step.
const { clients, transactions: bankRows } = bank();
const bankFile = path.join(site, 'data/bank.jzm');
write(bankFile, { clients, transactions: bankRows }, {
  tables: [
    {
      name: 'clients', sortedBy: ['id'],
      columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'string', index: 'trigram' }, { name: 'city', type: 'string' }, { name: 'segment', type: 'string' }, { name: 'since', type: 'datetime' }],
    },
    {
      name: 'transactions', sortedBy: ['client', 'date'],
      columns: [{ name: 'client', type: 'int', nullable: false }, { name: 'date', type: 'datetime' }, { name: 'merchant', type: 'string' }, { name: 'category', type: 'string' }, { name: 'amount', type: 'decimal' }],
    },
  ],
  metadata: { title: 'Clients and their card transactions, 2026 (demo data)', currency: 'ZAR' },
  password: 'demo',
  shapes: [
    {
      name: 'Clients and their spending', description: 'Each client with their spending (from the transactions table) and latest three transactions', default: true,
      shape: {
        $rows: {
          id: 'id', name: 'name', city: 'city', segment: 'segment',
          spending: { $from: 'transactions', $on: { client: 'id' }, $filter: spent, $one: { total: { $sum: 'amount' }, payments: { $count: true }, largest: { $min: 'amount' } } },
          latest: { $from: 'transactions', $on: { client: 'id' }, $sort: ['-date'], $limit: 3, $rows: { date: 'date', merchant: 'merchant', amount: 'amount' } },
        },
      },
    },
    { name: 'Clients by city', description: 'How many clients live in each city', shape: { $groupBy: 'city', $sort: ['city'], $rows: { city: 'city', clients: { $count: true } } } },
    { name: 'Spending by category', table: 'transactions', description: 'Every client, per category', shape: spendingByCategory },
  ],
});
fs.writeFileSync(`${bankFile}.js`, portableScript(bankFile));

// Documents: a page stored in the file with its data. The report is open to anyone; the task list saves changes.
const documents = path.join(here, 'documents');
const pageFiles = (folder) => fs.readdirSync(path.join(documents, folder)).map((name) => ({ path: name, file: path.join(documents, folder, name) }));
const reportFile = path.join(site, 'data/report.jzm');
// Two tables: the sales, and each branch's target, which the page reads by name (jazmin.query(..., { table: 'targets' })).
write(reportFile, { sales: branchSales(), targets: branchTargets() }, {
  tables: [
    { name: 'sales', columns: [{ name: 'month', type: 'string' }, { name: 'branch', type: 'string' }, { name: 'category', type: 'string' }, { name: 'revenue', type: 'decimal' }, { name: 'orders', type: 'int' }] },
    { name: 'targets', columns: [{ name: 'branch', type: 'string', nullable: false }, { name: 'target', type: 'decimal' }], sortedBy: ['branch'] },
  ],
  links: [{ name: 'target', from: { table: 'sales', columns: ['branch'] }, to: { table: 'targets', columns: ['branch'] } }],
  metadata: { company: 'Harbour & Co. Stores', title: 'Sales report', period: 'January to June 2026', currency: 'ZAR' },
  files: pageFiles('report'),
  // Its own files (USER-GUIDE 19.7): the page loads them, and viewers keep them out of the Files tab.
  package: { entry: 'index.html', title: 'Sales report, January to June 2026', pdf: { format: 'A4', printBackground: true }, files: ['report.css', 'report.js', 'pdf.js'] },
  shapes: [{ name: 'Revenue by branch', default: true, shape: { $groupBy: 'branch', $sort: ['branch'], $rows: { branch: 'branch', revenue: { $sum: 'revenue' }, orders: { $sum: 'orders' } } } }],
});
fs.writeFileSync(`${reportFile}.js`, portableScript(reportFile));
const tasksFile = path.join(site, 'data/tasks.jzm');
write(tasksFile, tasks(), {
  columns: [
    { name: 'id', type: 'string', nullable: false }, { name: 'task', type: 'string' }, { name: 'owner', type: 'string' },
    { name: 'due', type: 'datetime' }, { name: 'status', type: 'string' }, { name: 'priority', type: 'string' },
  ],
  metadata: { title: 'Team tasks, November 2026' },
  files: pageFiles('tasks'),
  package: { entry: 'index.html', title: 'Team tasks', files: ['tasks.css', 'tasks.js'], edit: { key: ['id'], columns: ['task', 'owner', 'due', 'status', 'priority'], add: true, delete: true } },
  password: 'demo',
});
fs.writeFileSync(`${tasksFile}.js`, portableScript(tasksFile));
// A dashboard that loads from the internet: the Inter font from Google Fonts, Chart.js and icons from jsDelivr. The
// file names those origins (allowedOrigins) and says it needs them (online: 'required'): the viewer says so, and
// offline it waits for the network.
const dashboardFile = path.join(site, 'data/dashboard.jzm');
write(dashboardFile, branchSales(), {
  columns: [{ name: 'month', type: 'string' }, { name: 'branch', type: 'string' }, { name: 'category', type: 'string' }, { name: 'revenue', type: 'decimal' }, { name: 'orders', type: 'int' }],
  metadata: { company: 'Harbour & Co. Stores', title: 'Sales dashboard', period: 'January to June 2026', currency: 'ZAR' },
  files: pageFiles('dashboard'),
  package: {
    entry: 'index.html', title: 'Sales dashboard, January to June 2026', online: 'required', files: ['dashboard.css', 'dashboard.js'],
    allowedOrigins: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
  },
});
fs.writeFileSync(`${dashboardFile}.js`, portableScript(dashboardFile));
// A document of four pages, shown by the viewer as tabs (USER-GUIDE 19.7): the bank's clients and transactions (one
// table each), a summary that needs the internet for its charts, and a statement laid out for A4. Its script and
// stylesheet are its own files (package.files), which viewers keep out of the Files tab.
const clientFile = path.join(site, 'data/client-file.jzm');
write(clientFile, { clients, transactions: bankRows }, {
  tables: [
    { name: 'clients', sortedBy: ['id'], columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'string', index: 'trigram' }, { name: 'city', type: 'string' }, { name: 'segment', type: 'string', index: 'sorted' }, { name: 'since', type: 'datetime' }] },
    { name: 'transactions', sortedBy: ['client', 'date'], columns: [{ name: 'client', type: 'int', nullable: false }, { name: 'date', type: 'datetime' }, { name: 'merchant', type: 'string' }, { name: 'category', type: 'string' }, { name: 'amount', type: 'decimal' }] },
  ],
  metadata: { title: 'Harbour Bank client file, 2026 (demo data)', currency: 'ZAR' },
  password: 'demo',
  files: pageFiles('client-file'),
  package: {
    title: 'Client file 2026',
    pages: [
      { path: 'clients.html', title: 'Clients', table: 'clients', actions: { print: false } },
      { path: 'transactions.html', title: 'Transactions', table: 'transactions', actions: { print: false } },
      { path: 'summary.html', title: 'Summary', online: 'required' },
      { path: 'statement.html', title: 'Statement', table: 'transactions', pdf: { format: 'A4', printBackground: true } },
    ],
    files: ['app.js', 'app.css'],
    allowedOrigins: ['https://cdn.jsdelivr.net'],
  },
});
fs.writeFileSync(`${clientFile}.js`, portableScript(clientFile));

// One file, three people: each access key sees its branch's rows (or all), the pay columns or not, and the files and
// saved shapes of the groups it sees. The owner key stays out of the site: browsers refuse a shared file's owner key.
const owner = JazminKey.generate();
const people = [
  { label: 'Cape Town manager', sees: 'Cape Town staff, with their pay', grant: { rows: ['Cape Town'], columns: '*' } },
  { label: 'Johannesburg team lead', sees: 'Johannesburg staff, without pay', grant: { rows: ['Johannesburg'], columns: ['*'] } },
  { label: 'HR', sees: 'Every branch, with pay, and the HR files', grant: { rows: '*', columns: '*', files: ['hr'] } },
].map((p) => ({ ...p, key: owner.createAccessKey() }));
const notice = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px/1.5 system-ui,sans-serif;margin:2rem;max-width:40rem"><h1>${title}</h1><p>${text}</p>`;
const sharedFile = path.join(site, 'data/shared.jzm');
// HR's own page and a locked file (USER-GUIDE 19.7, 19.6): marked on files of the hr group, so only keys that see that
// group know of them. The page reads the proposed increases, which a password lock keeps shut until HR opens it.
const sharedLock = { lock: 'pay-review', file: 'hr/increases-2027.csv', password: 'review 2027' };
const increases = ['name,branch,role,salary,proposed,increase',
  ...staff().map((p, i) => {
    const rate = [0.045, 0.055, 0.06, 0.07, 0.085][(i * 7) % 5];
    return [p.name, p.branch, p.role, p.salary, (Number(p.salary) * (1 + rate)).toFixed(2), `${(rate * 100).toFixed(1)}%`].join(',');
  })].join('\n');
write(sharedFile, staff(), {
  columns: [
    { name: 'branch', type: 'string' }, { name: 'name', type: 'string' }, { name: 'role', type: 'string' }, { name: 'since', type: 'datetime' },
    { name: 'salary', type: 'decimal' }, { name: 'bonus', type: 'decimal' },
  ],
  metadata: { title: 'Staff of Harbour & Co. Stores (demo data)', currency: 'ZAR' },
  key: owner,
  access: { partitionBy: 'branch', columnGroups: { pay: ['salary', 'bonus'] }, grants: people.map((p) => ({ key: p.key, label: p.label, ...p.grant })) },
  files: [
    { path: 'handbook.html', content: notice('Staff handbook', 'Everyone who opens this file sees the handbook.') },
    { path: 'notices/cape-town.html', content: notice('Cape Town notice', 'The Cape Town branch closes early on Friday.'), groups: ['Cape Town'] },
    { path: 'notices/johannesburg.html', content: notice('Johannesburg notice', 'Stock count in Johannesburg on Saturday.'), groups: ['Johannesburg'] },
    { path: 'notices/durban.html', content: notice('Durban notice', 'Welcome to the new Durban team members.'), groups: ['Durban'] },
    { path: 'hr/pay-bands.html', content: notice('Pay bands 2026', 'For HR only: the pay bands for each role.'), groups: ['hr'] },
    { path: 'hr/pay-review.html', file: path.join(documents, 'shared/pay-review.html'), groups: ['hr'], page: { title: 'Pay review 2027', order: 1 } },
    { path: sharedLock.file, content: `${increases}\n`, groups: ['hr'], lock: sharedLock.lock },
  ],
  locks: { [sharedLock.lock]: { password: sharedLock.password } },
  // The handbook is the document's page for everyone; HR's key adds the Pay review tab.
  package: { title: 'Staff of Harbour & Co. Stores', pages: [{ path: 'handbook.html', title: 'Handbook' }] },
  shapes: [
    { name: 'Team list', description: 'Who works where, and since when', default: true, shape: { $sort: ['branch', 'name'], $rows: { name: 'name', role: 'role', branch: 'branch', since: 'since' } } },
    { name: 'Headcount by role', description: 'How many people in each role', shape: { $groupBy: 'role', $sort: ['role'], $rows: { role: 'role', people: { $count: true } } } },
    { name: 'Pay by branch', description: 'Salaries and bonuses per branch: for HR', groups: ['hr'], shape: { $groupBy: 'branch', $sort: ['branch'], $rows: { branch: 'branch', people: { $count: true }, salaries: { $sum: 'salary' }, bonuses: { $sum: 'bonus' } } } },
    { name: 'Cape Town pay', description: "The Cape Town team's pay: for those who see Cape Town's rows and pay", groups: ['Cape Town'], shape: { $rows: { name: 'name', role: 'role', salary: 'salary', bonus: 'bonus' } } },
  ],
});
fs.writeFileSync(`${sharedFile}.js`, portableScript(sharedFile));
fs.writeFileSync(path.join(site, 'data/shared-keys.js'), [
  '// The access keys shared.html opens data/shared.jzm with. FOR THIS DEMO ONLY: a real key is like a password, and never',
  '// belongs in a page or a file next to it. Made by make.mjs; each run makes new keys.',
  `var sharedKeys = ${JSON.stringify(people.map((p) => ({ label: p.label, sees: p.sees, key: p.key.export() })), null, 2)};`,
  "// The password of the lock on HR's proposed increases (only HR's key sees the file): for this demo only, too.",
  `var sharedLock = ${JSON.stringify(sharedLock, null, 2)};`,
  '',
].join('\n'));

// A file that asks for an authenticator code: its access key is an online one, so it opens only with an unlock token,
// which the sample key service (dotnet/samples/Jazmin.KeyService) gives out after a code from the user's authenticator
// app. The service reads the tokens, listed here with the owner key; it never holds the owner key itself.
const remcoOwner = JazminKey.generate();
const remcoKey = remcoOwner.createAccessKey();
const remcoFile = path.join(site, 'data/remco.jzm');
write(remcoFile, executives(), {
  columns: [
    { name: 'name', type: 'string' }, { name: 'role', type: 'string' }, { name: 'salary', type: 'decimal' },
    { name: 'bonus', type: 'decimal' }, { name: 'shares', type: 'decimal' }, { name: 'total', type: 'decimal' },
  ],
  metadata: { title: 'Executive pay 2026, for the remuneration committee (demo data)', currency: 'ZAR' },
  key: remcoOwner,
  access: { grants: [{ key: remcoKey, label: 'Remuneration committee: Thandi Mokoena', rows: '*', columns: '*', mode: 'online', expiresIn: '30d' }] },
});
fs.writeFileSync(`${remcoFile}.js`, portableScript(remcoFile));
// The committee's contract file: an ordinary (offline) access key opens it, but the contracts are locked with an online
// lock that names the same key service (spec 6.8.2), so the viewer's Unlock… offers "Sign in at localhost:5080", which
// gives the lock's token only after a code from the authenticator app (USER-GUIDE 19.6, 18.5).
const service = 'http://localhost:5080';
const contractsOwner = JazminKey.generate();
const committee = contractsOwner.createAccessKey();
const contractsFile = path.join(site, 'data/contracts.jzm');
const contractRows = contracts();
const isoDay = (d) => d.toISOString().slice(0, 10);
const contractPage = (c) => notice(`Employment contract: ${c.role}`, `${c.name}, ${c.role}. Started ${isoDay(c.started)}; the contract runs to `
  + `${isoDay(c.ends)}, with ${c.notice} months' notice. Salary, bonus and share awards as in the remuneration report. (Demo data: a `
  + 'stand-in for the signed contract.)');
const slug = (text) => text.toLowerCase().replace(/[^a-z]+/g, '-');
write(contractsFile, contractRows, {
  columns: [{ name: 'name', type: 'string' }, { name: 'role', type: 'string' }, { name: 'started', type: 'datetime' }, { name: 'ends', type: 'datetime' }, { name: 'notice', type: 'int' }],
  metadata: { title: 'Executive contracts, for the remuneration committee (demo data)' },
  key: contractsOwner,
  access: { grants: [{ key: committee, label: 'Remuneration committee: Thandi Mokoena', rows: '*', columns: '*' }] },
  files: [
    { path: 'terms-of-reference.html', content: notice('Remuneration committee', 'Terms of reference: the committee reviews executive pay and contracts once a year.') },
    ...contractRows.slice(0, 3).map((c) => ({ path: `contracts/${slug(c.role)}.html`, content: contractPage(c), lock: 'contracts' })),
  ],
  locks: { contracts: { online: true, keyService: `${service}/jazmin/unlock` } },
});
fs.writeFileSync(`${contractsFile}.js`, portableScript(contractsFile));
fs.mkdirSync(path.join(site, 'key-service'), { recursive: true });
const contractsId = inspect(contractsFile).fileId;
const tokens = { files: [
  { fileId: inspect(remcoFile).fileId, tokens: listUnlockTokens(remcoFile, remcoOwner) },
  { fileId: contractsId, tokens: [], locks: listFileUnlockTokens(contractsFile, contractsOwner) },
] };
fs.writeFileSync(path.join(site, 'key-service/tokens.json'), `${JSON.stringify(tokens, null, 2)}\n`);
const twoFactor = {
  user: 'thandi', label: 'Thandi Mokoena, remuneration committee', keyId: remcoKey.id, key: remcoKey.export(), service,
  contracts: { fileId: contractsId, lock: 'contracts', key: committee.export() },
};
fs.writeFileSync(path.join(site, 'data/two-factor-keys.js'), [
  '// The access key two-factor.html opens data/remco.jzm with, and who holds it. FOR THIS DEMO ONLY: a real key is like',
  '// a password, and never belongs in a page or a file next to it. Made by make.mjs; each run makes new keys.',
  `var twoFactor = ${JSON.stringify(twoFactor, null, 2)};`,
  '',
].join('\n'));

// Masked columns (USER-GUIDE 15.7): a payroll clerk's key sees every row, but each person's email, bank account and ID
// number, and the directors' salaries, show masked (what the rule lets them show) until the lock's password opens them.
// package.masks says how viewers show revealed values, and that the ID numbers never leave a viewer revealed.
const payrollOwner = JazminKey.generate();
const clerk = payrollOwner.createAccessKey();
const payrollPassword = 'payroll 2026';
const maskedFile = path.join(site, 'data/payroll-masked.jzm');
write(maskedFile, payroll(), {
  columns: [
    { name: 'staff', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'branch', type: 'string' }, { name: 'grade', type: 'string' },
    { name: 'email', type: 'string', mask: { lock: 'payroll', show: { keepFormat: true } } }, // a••••••••••@harbourco.co.za
    { name: 'account', type: 'string', mask: { lock: 'payroll', show: { keepFormat: true, last: 4 } } }, // •••• ••• 5526
    { name: 'id_number', type: 'string', mask: { lock: 'payroll', show: { first: 2, last: 2 } } }, // 80•••••••••89
    { name: 'salary', type: 'decimal', mask: { lock: 'payroll', rows: { grade: 'Director' } } }, // only the directors' rows
  ],
  metadata: { company: 'Harbour & Co. Stores', title: 'Payroll, October 2026 (demo data)', currency: 'ZAR' },
  key: payrollOwner,
  access: { grants: [{ key: clerk, label: 'Payroll clerk: Megan Botha', rows: '*', columns: '*' }] },
  locks: { payroll: { password: payrollPassword } },
  package: { masks: { salary: { reveal: 'value', seconds: 15 }, id_number: { seconds: 10, export: false } } },
  // A saved shape that needs no masked column. (The package is kept with the file's stored files and saved shapes: a
  // file with neither keeps no package settings.)
  shapes: [{ name: 'Headcount', description: 'Staff per branch and grade', default: true, shape: { $groupBy: ['branch', 'grade'], $sort: ['branch', 'grade'], $rows: { branch: 'branch', grade: 'grade', people: { $count: true } } } }],
});
fs.writeFileSync(`${maskedFile}.js`, portableScript(maskedFile));
fs.writeFileSync(path.join(site, 'data/masked-keys.js'), [
  "// The access key masked.html opens data/payroll-masked.jzm with, and the password of the file's lock. FOR THIS DEMO",
  '// ONLY: a real key and password are never in a page or a file next to it. Made by make.mjs; each run makes a new key.',
  `var maskedDemo = ${JSON.stringify({ label: 'Payroll clerk: Megan Botha', key: clerk.export(), lock: 'payroll', password: payrollPassword }, null, 2)};`,
  '',
].join('\n'));

// Text orders (USER-GUIDE 16.1, spec 6.7): the same customers written twice, in plain order and in an order that
// ignores case and accents and puts the numbers in names by value (sort-order.html).
const customerColumns = [{ name: 'account', type: 'string', nullable: false }, { name: 'name', type: 'string', index: 'trigram' }, { name: 'city', type: 'string' }, { name: 'balance', type: 'decimal' }];
for (const [name, sortedBy] of [['customers-plain', ['name']], ['customers', [{ column: 'name', nocase: true, natural: true }]]]) {
  const target = path.join(site, `data/${name}.jzm`);
  // Written in the order the customers signed up, then put in the order by update() (a write takes rows in order).
  write(target, customers(), { columns: customerColumns, metadata: { title: 'Wholesale customers (demo data)', currency: 'ZAR' } });
  update(target, { sortedBy });
  fs.writeFileSync(`${target}.js`, portableScript(target));
}

// Nested columns (USER-GUIDE 4.2): 5,000 orders with their lines (a list of objects) and delivery (an object), and the
// same orders with those two as JSON text, to compare (nested.html).
const orderRows = orders();
const lineFields = [{ name: 'sku', type: 'string' }, { name: 'product', type: 'string' }, { name: 'qty', type: 'int' }, { name: 'price', type: 'decimal' }];
for (const [name, delivery, lines] of [
  ['orders', { name: 'delivery', type: 'object', fields: [{ name: 'method', type: 'string' }, { name: 'city', type: 'string' }] }, { name: 'lines', type: 'list', item: { type: 'object', fields: lineFields } }],
  ['orders-json', { name: 'delivery', type: 'json' }, { name: 'lines', type: 'json' }],
]) {
  const target = path.join(site, `data/${name}.jzm`);
  const started = Date.now();
  write(target, orderRows, {
    columns: [{ name: 'order', type: 'string', nullable: false }, { name: 'date', type: 'datetime' }, { name: 'customer', type: 'string' }, { name: 'branch', type: 'string', index: 'sorted' }, delivery, lines, { name: 'total', type: 'decimal' }],
    sortedBy: ['date'], metadata: { title: 'Online orders, July to September 2026 (demo data)', currency: 'ZAR' },
  });
  fs.writeFileSync(`${target}.js`, portableScript(target));
  console.log(`${name}.jzm: ${(fs.statSync(target).size / 1024).toFixed(0)} KB, written in ${Date.now() - started} ms`);
}

// Records sent back (USER-GUIDE 15.6, 24.3): store inspections, a shared file each area manager's key sees a branch of.
// send-back.html opens it with the Durban manager's key, for its submission key, and writes a new inspection in the
// browser. The owner key (filing/owner.key, FOR THIS DEMO ONLY) files it with the filing-service sample.
const inspectionsOwner = JazminKey.generate();
const inspectors = [['Durban', 'Sipho Dlamini'], ['Cape Town', 'Megan Fourie']].map(([branch, name]) => ({ branch, name, key: inspectionsOwner.createAccessKey() }));
const inspectionsFile = path.join(site, 'data/inspections.jzm');
write(inspectionsFile, inspections(), {
  columns: [
    { name: 'id', type: 'string', nullable: false }, { name: 'branch', type: 'string' }, { name: 'inspector', type: 'string' },
    { name: 'visited', type: 'datetime' }, { name: 'area', type: 'string' }, { name: 'rating', type: 'int' }, { name: 'note', type: 'string' },
    { name: 'attachments', type: 'json' },
  ],
  metadata: { company: 'Harbour & Co. Stores', title: 'Store inspections, 2026 (demo data)' },
  key: inspectionsOwner,
  access: { partitionBy: 'branch', grants: inspectors.map((p) => ({ key: p.key, label: `Area manager, ${p.branch}: ${p.name}`, rows: [p.branch], columns: '*' })) },
});
fs.writeFileSync(`${inspectionsFile}.js`, portableScript(inspectionsFile));
fs.writeFileSync(path.join(site, 'data/inspection-keys.js'), [
  "// The area managers' access keys send-back.html opens data/inspections.jzm with. FOR THIS DEMO ONLY: a real key is",
  '// like a password, and never belongs in a page or a file next to it. Made by make.mjs; each run makes new keys.',
  `var fieldKeys = ${JSON.stringify(inspectors.map((p) => ({ branch: p.branch, inspector: p.name, keyId: p.key.id, key: p.key.export() })), null, 2)};`,
  '',
].join('\n'));
fs.mkdirSync(path.join(site, 'filing/inbox'), { recursive: true });
fs.writeFileSync(path.join(site, 'filing/owner.key'), `${inspectionsOwner.export()}\n`);
fs.writeFileSync(path.join(site, 'filing/README.txt'), [
  "The owner's side of send-back.html. FOR THIS DEMO ONLY: owner.key is the master key of data/inspections.jzm. A real",
  'owner key stays on the machine that files the records, never next to the pages.',
  '',
  'Put the .jzm files the page saves into inbox/, then, in the js folder of JAZMIN:',
  '  node examples/filing-service/inbox.mjs --key-file <this folder>/owner.key <site>/data/inspections.jzm <this folder>/inbox',
  '  node bin/jazmin.mjs script <site>/data/inspections.jzm      (send-back.html reads the file as a script)',
  '',
].join('\n'));

console.log(`Made ${site}\nOpen ${path.join(site, 'index.html')} in a browser. The password is "demo".`);
