// Builds the from-disk sample (README.md): a folder you can copy anywhere and open by double-clicking index.html, with
// no web server and no Node. It holds the pages, the viewer, the browser reader, and demo files (demo-data.mjs):
// - data/statement.jzm: one account's statement for three months, with export shapes saved in it, also made into a
//   script (statement.jzm.js), which small-file.html and shapes.html open with no choosing;
// - data/transactions.jzm: many accounts' transactions for a year (1,000,000 by default), sorted by date, with indexes
//   on the columns people filter by and export shapes saved in it, for pick-file.html;
// - data/bank.jzm: clients and their transactions, two tables linked by a saved shape (tables.html);
// - data/report.jzm and data/tasks.jzm: documents, a print-ready report and a task list that saves changes
//   (documents.html shows them in the viewer);
// - data/shared.jzm: one file with access keys that see different rows, columns, files and shapes (shared.html).
// Every file is locked with the password "demo", except the report (open to anyone) and the shared file (access keys,
// in data/shared-keys.js for this demo only: real keys never belong in a page).
// Run: node examples/from-disk/make.mjs [folder] [--rows n]
//      (default folder: examples/from-disk/site; --rows: transactions in transactions.jzm, 0 for none)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JazminKey, portableScript, write } from '../../src/index.js';
import { bank, branchSales, staff, statement, tasks, transactions } from './demo-data.mjs';

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
for (const file of ['index.html', 'viewer.js', 'viewer.css', 'sandbox.js']) fs.copyFileSync(path.join(js, 'viewer', file), path.join(site, 'viewer', file));
fs.mkdirSync(path.join(site, 'browser'), { recursive: true });
fs.copyFileSync(path.join(js, 'browser/jazmin-browser.js'), path.join(site, 'browser/jazmin-browser.js'));
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
write(reportFile, branchSales(), {
  columns: [{ name: 'month', type: 'string' }, { name: 'branch', type: 'string' }, { name: 'category', type: 'string' }, { name: 'revenue', type: 'decimal' }, { name: 'orders', type: 'int' }],
  metadata: { company: 'Harbour & Co. Stores', title: 'Sales report', period: 'January to June 2026', currency: 'ZAR' },
  files: pageFiles('report'),
  package: { entry: 'index.html', title: 'Sales report, January to June 2026', pdf: { format: 'A4', printBackground: true } },
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
  package: { entry: 'index.html', title: 'Team tasks', edit: { key: ['id'], columns: ['task', 'owner', 'due', 'status', 'priority'], add: true, delete: true } },
  password: 'demo',
});
fs.writeFileSync(`${tasksFile}.js`, portableScript(tasksFile));

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
  ],
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
  '',
].join('\n'));

console.log(`Made ${site}\nOpen ${path.join(site, 'index.html')} in a browser. The password is "demo".`);
