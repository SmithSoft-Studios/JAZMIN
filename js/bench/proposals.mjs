// Proposals benchmark (GitHub issue #5): bytes read, rows returned and time for the queries behind the improvement
// proposals, on 200,000 seeded card and account transactions (500 accounts, 9 columns, encrypted, deflate, sorted
// indexes on id, account, at and reference). Every query runs on a freshly opened reader; time is the median of 5 runs.
// Bytes and rows are machine-independent and are checked against proposals-baseline.json; compare times only with
// each other, on one machine.
//   node bench/proposals.mjs                     print the table and write results.json
//   node bench/proposals.mjs --check             also fail if a query reads > 10% more bytes, or returns other rows
//   node bench/proposals.mjs --update-baseline   record the current bytes and rows as the baseline
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JazminKey, open, write } from '../src/index.js';

const ROWS = 200_000;
const ACCOUNTS = 500;
const RUNS = 5;
const BYTES_TOLERANCE = 0.10;
const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'proposals-baseline.json');
const args = new Set(process.argv.slice(2));

// ---- seeded data ----------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so every run builds the same rows. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function transactions() {
  const random = seeded(20261004);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const accounts = Array.from({ length: ACCOUNTS }, (_, i) => `ACC-${100001 + i}`);
  // Some accounts transact far more than others, as in real statements.
  const weights = accounts.map(() => 0.2 + random() ** 3 * 5);
  const cumulative = [];
  weights.reduce((sum, w) => (cumulative.push(sum + w), sum + w), 0);
  const total = cumulative[cumulative.length - 1];
  const pickAccount = () => {
    const target = random() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return accounts[lo];
  };
  const merchants = ['Checkers', 'Pick n Pay', 'Woolworths', 'Engen', 'Shell', 'Takealot', 'Uber', 'Netflix', 'Vodacom',
    'Clicks', 'Dis-Chem', 'Spur', 'Nandos', 'Builders', 'Mr Price', 'Edgars', 'Sasol', 'Bolt', 'Spotify', 'Makro'];
  const cities = ['Johannesburg', 'Cape Town', 'Durban', 'Pretoria', 'Gqeberha', 'Bloemfontein', 'Polokwane', 'Online'];
  const categories = ['groceries', 'fuel', 'dining', 'transport', 'utilities', 'entertainment', 'health', 'clothing',
    'home', 'transfer', 'salary', 'fees'];
  const channels = ['card', 'card', 'card', 'eft', 'online', 'atm'];
  const balances = new Map(accounts.map((a) => [a, 1000 + Math.round(random() * 50_000)]));
  const start = Date.UTC(2025, 0, 1);
  const span = 365 * 86_400_000;
  const reference = () => `TX${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`.toUpperCase();
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    const account = pickAccount();
    const credit = random() < 0.12;
    const amount = Math.round((credit ? random() * 20_000 : -(random() ** 2) * 3_000) * 100) / 100;
    const balance = Math.round((balances.get(account) + amount) * 100) / 100;
    balances.set(account, balance);
    const channel = credit ? 'eft' : pick(channels);
    rows.push({
      id: i + 1,
      account,
      at: new Date(start + Math.floor(((i + random()) * span) / ROWS)), // increasing: generation order is time order
      amount,
      balance,
      description: credit ? `Payment received ${pick(merchants)}` : `${channel === 'atm' ? 'ATM withdrawal' : 'Purchase'} ${pick(merchants)} ${pick(cities)}`,
      reference: reference(),
      category: credit ? pick(['salary', 'transfer']) : pick(categories),
      channel,
    });
  }
  return { rows, accounts };
}

const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'account', type: 'string', nullable: false, index: 'sorted' },
  { name: 'at', type: 'datetime', nullable: false, index: 'sorted' },
  { name: 'amount', type: 'float', nullable: false },
  { name: 'balance', type: 'float', nullable: false },
  { name: 'description', type: 'string' },
  { name: 'reference', type: 'string', index: 'sorted' },
  { name: 'category', type: 'string' },
  { name: 'channel', type: 'string' },
];

// ---- byte counting --------------------------------------------------------------------------------------------

let bytesRead = 0;
const readSync = fs.readSync;
fs.readSync = function countedReadSync(...readArgs) {
  const n = readSync.apply(fs, readArgs);
  bytesRead += n;
  return n;
};

/** A Blob that counts what the browser reader reads from it (it reads through slice()). */
class CountingBlob extends Blob {
  slice(start = 0, end = this.size, type) {
    bytesRead += Math.max(0, Math.min(end, this.size) - start);
    return super.slice(start, end, type);
  }
}

// ---- files ----------------------------------------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-proposals-'));
const file = (name) => path.join(dir, name);
const key = JazminKey.generate();
const { rows, accounts } = transactions();
const byAccount = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.account < b.r.account ? -1 : a.r.account > b.r.account ? 1 : a.i - b.i)).map((x) => x.r);
console.log(`Writing the benchmark files (${ROWS.toLocaleString('en-US')} rows) in ${dir}`);
write(file('time.jzm'), rows, { columns, sortedBy: ['at'], key });
write(file('account.jzm'), byAccount, { columns, sortedBy: ['account', 'at'], key });
write(file('access.jzm'), byAccount, { columns, sortedBy: ['account', 'at'], key, access: { partitionBy: 'account' } });

// ---- query parameters, derived from the seeded data -----------------------------------------------------------

const firstAccount = accounts[0];
const lastAccount = accounts[accounts.length - 1];
const midAccount = accounts[ACCOUNTS / 2];
const lookupId = 123_457;
const lookupReference = rows[lookupId - 1].reference;
const midRows = rows.filter((r) => r.account === midAccount);
const keysetCursor = midRows[Math.floor(midRows.length / 2)].at;
const dayStart = new Date(Date.UTC(2025, 4, 31));
const dayEnd = new Date(Date.UTC(2025, 5, 1));
const inDay = (r) => r.at >= dayStart && r.at < dayEnd;
// Positions in the account-sorted file of one day's rows, in time order (as a pointer table would list them).
const positionOf = new Map(byAccount.map((r, p) => [r.id, p]));
const dayPositions = rows.filter(inDay).map((r) => positionOf.get(r.id));
const sum = (list, column) => list.reduce((s, r) => s + r[column], 0);
const take = (iterable) => [...iterable].length;

// ---- scenarios ------------------------------------------------------------------------------------------------
// Each: [name, issue, file, query(reader) -> rows returned]. Node scenarios get a JazminReader; browser ones the
// browser reader opened from a CountingBlob.

const scenarios = [
  ['open', '#6', 'time.jzm', () => 0],
  ['id lookup', '#10', 'account.jzm', (r) => take(r.find({ id: lookupId }))],
  ['account page, first account', '#14', 'account.jzm', (r) => take(r.find({ account: firstAccount }, { limit: 50 }))],
  ['account page, last account', '#10', 'account.jzm', (r) => take(r.find({ account: lastAccount }, { limit: 50 }))],
  ['account page, time-sorted file', '#14', 'time.jzm', (r) => take(r.find({ account: firstAccount }, { limit: 50 }))],
  ['account count, time-sorted file', '#14', 'time.jzm', (r) => r.count({ account: firstAccount })],
  ['account count, account-sorted file', '#14', 'account.jzm', (r) => r.count({ account: firstAccount })],
  ['keyset page within an account', '#7', 'account.jzm', (r) => take(r.find({ account: midAccount, at: { gt: keysetCursor } }, { limit: 50 }))],
  ['one day, all accounts', '#7', 'account.jzm', (r) => take(r.find({ at: { gte: dayStart, lt: dayEnd } }))],
  ['one day, time-sorted file', '#7', 'time.jzm', (r) => take(r.find({ at: { gte: dayStart, lt: dayEnd } }))],
  ['deep page (offset 150,000)', '#8', 'time.jzm', (r) => take(r.rows({ offset: 150_000, limit: 50 }))],
  ['newest 50 (offset rowCount - 50)', '#8', 'time.jzm', (r) => take(r.rows({ offset: r.rowCount - 50, limit: 50 }))],
  ['sum of amount, select', '#11', 'time.jzm', (r) => (sum(r.rows({ select: ['amount'] }), 'amount'), r.rowCount)],
  ['sum of amount, all columns', '#11', 'time.jzm', (r) => (sum(r.rows(), 'amount'), r.rowCount)],
  ['account amounts through an index', '#11', 'time.jzm', (r) => take(r.find({ account: firstAccount }, { select: ['amount'] }))],
  ['reference lookup, select', '#11', 'account.jzm', (r) => take(r.find({ reference: lookupReference }, { select: ['amount'] }))],
  ['access file: account amounts', '#11', 'access.jzm', (r) => take(r.find({ account: firstAccount }, { select: ['amount'] }))],
  ['access file: all amounts', '#11', 'access.jzm', (r) => take(r.rows({ select: ['amount'] }))],
  ['get() one day, time order', '#27', 'account.jzm', (r) => dayPositions.map((p) => r.get(p)).length],
  ['get() one day, position order', '#27', 'account.jzm', (r) => [...dayPositions].sort((a, b) => a - b).map((p) => r.get(p)).length],
  ['browser: open', '#10', 'account.jzm', async () => 0, 'browser'],
  ['browser: id lookup', '#10', 'account.jzm', async (r) => (await collect(r.find({ id: lookupId }))), 'browser'],
  ['browser: account page, first account', '#10', 'account.jzm', async (r) => (await collect(r.find({ account: firstAccount }, { limit: 50 }))), 'browser'],
  ['browser: account page, last account', '#10', 'account.jzm', async (r) => (await collect(r.find({ account: lastAccount }, { limit: 50 }))), 'browser'],
  ['browser: query() deep page with total', '#10', 'account.jzm', async (r) => (await r.query(null, { offset: 150_000, limit: 50 })).rows.length, 'browser'],
];

async function collect(iterator) {
  let n = 0;
  for await (const _ of iterator) n++;
  return n;
}

await import('../browser/jazmin-browser.js');
const blobs = new Map();
const blobOf = (name) => {
  if (!blobs.has(name)) blobs.set(name, new CountingBlob([fs.readFileSync(file(name))]));
  return blobs.get(name);
};

async function measure([name, , fileName, query, kind]) {
  const once = async () => {
    bytesRead = 0;
    const start = process.hrtime.bigint();
    let rowsReturned;
    if (kind === 'browser') {
      const reader = await globalThis.JazminBrowser.open(blobOf(fileName), { key: key.toString() });
      rowsReturned = await query(reader);
    } else {
      const reader = open(file(fileName), { key });
      try {
        rowsReturned = query(reader);
      } finally {
        reader.close();
      }
    }
    return { rows: rowsReturned, bytes: bytesRead, ms: Number(process.hrtime.bigint() - start) / 1e6 };
  };
  await once(); // warm-up, so every query is timed with optimised code
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await once());
  if (new Set(runs.map((x) => x.bytes)).size > 1) throw new Error(`'${name}' read different byte counts between runs`);
  const ms = runs.map((x) => x.ms).sort((a, b) => a - b)[RUNS >> 1];
  return { rows: runs[0].rows, bytes: runs[0].bytes, ms };
}

// ---- run, report, check ---------------------------------------------------------------------------------------

const expected = { 'one day, all accounts': rows.filter(inDay).length, 'account count, time-sorted file': rows.filter((r) => r.account === firstAccount).length };
const results = {};
for (const scenario of scenarios) {
  results[scenario[0]] = { issue: scenario[1], file: scenario[2], ...(await measure(scenario)) };
  if (expected[scenario[0]] !== undefined && results[scenario[0]].rows !== expected[scenario[0]]) {
    throw new Error(`'${scenario[0]}' returned ${results[scenario[0]].rows} rows, expected ${expected[scenario[0]]}`);
  }
}

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const width = Math.max(...scenarios.map((s) => s[0].length));
console.log(`\nJAZMIN proposals benchmark - Node ${process.version}, ${os.cpus()[0]?.model.trim() ?? 'unknown CPU'}`);
console.log(`${'Query'.padEnd(width)}  Issue  ${'Rows'.padStart(7)}  ${'Read'.padStart(9)}  ${'Time'.padStart(9)}`);
for (const [name, r] of Object.entries(results)) {
  console.log(`${name.padEnd(width)}  ${r.issue.padEnd(5)}  ${String(r.rows).padStart(7)}  ${kb(r.bytes).padStart(9)}  ${`${r.ms.toFixed(1)} ms`.padStart(9)}`);
}
const resultsPath = path.join(os.tmpdir(), 'jazmin-proposals-results.json');
fs.writeFileSync(resultsPath, JSON.stringify({ node: process.version, rows: ROWS, results }, null, 2));
console.log(`\nResults: ${resultsPath}`);

const recorded = Object.fromEntries(Object.entries(results).map(([name, r]) => [name, { bytes: r.bytes, rows: r.rows }]));
if (args.has('--update-baseline')) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`Baseline updated: ${baselinePath}`);
}
if (args.has('--check')) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const problems = [];
  for (const [name, now] of Object.entries(recorded)) {
    const before = baseline[name];
    if (!before) {
      problems.push(`'${name}' has no baseline: run with --update-baseline`);
      continue;
    }
    if (now.rows !== before.rows) problems.push(`'${name}' returned ${now.rows} rows; the baseline has ${before.rows}`);
    if (now.bytes > before.bytes * (1 + BYTES_TOLERANCE)) problems.push(`'${name}' read ${kb(now.bytes)}; the baseline is ${kb(before.bytes)} (more than ${BYTES_TOLERANCE * 100}% over)`);
    else if (now.bytes < before.bytes * (1 - BYTES_TOLERANCE)) console.log(`Note: '${name}' now reads ${kb(now.bytes)} (baseline ${kb(before.bytes)}): update the baseline`);
  }
  for (const name of Object.keys(baseline)) if (!recorded[name]) problems.push(`'${name}' is in the baseline but was not measured`);
  if (problems.length) {
    console.error(`\nBytes-read check failed:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('Bytes-read check passed: every query is within 10% of the baseline and returns the same rows.');
  }
}
fs.rmSync(dir, { recursive: true, force: true });
