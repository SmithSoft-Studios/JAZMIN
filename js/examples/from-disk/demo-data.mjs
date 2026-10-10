// Demo data for the from-disk sample: card transactions that look like real ones (merchants, categories, amounts that
// fit them, a salary each month), the same every time for the same seed. make.mjs writes them.

/** A small, fast random number generator (mulberry32): the same numbers for the same seed. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Merchants by category, how often people pay them (weight), and what a payment usually costs (Rand).
export const CATEGORIES = [
  { name: 'Groceries', weight: 24, min: 85, max: 2400, merchants: ['Fresh Market', 'City Grocer', 'Green Valley Foods', 'Corner Deli', 'Harbour Fish Market', 'Sunrise Bakery'] },
  { name: 'Dining', weight: 18, min: 45, max: 950, merchants: ['Bean There Coffee', 'Coffee Corner', 'Pasta Place', 'Sushi Bay', 'Burger Joint', 'The Tea Room'] },
  { name: 'Transport', weight: 16, min: 28, max: 1450, merchants: ['RideNow', 'City Rail', 'Fuel Stop', 'Parking Garage', 'Toll Road'] },
  { name: 'Shopping', weight: 12, min: 99, max: 12500, merchants: ['Online Mall', 'Bookworm Books', 'Tech Store', 'Home & Garden', 'Fashion Hub'] },
  { name: 'Utilities', weight: 7, min: 199, max: 2900, merchants: ['City Power', 'Water Works', 'FibreNet', 'Mobile Telecom'] },
  { name: 'Entertainment', weight: 8, min: 59, max: 650, merchants: ['Streamflix', 'Music Stream', 'Cinema Nouveau', 'Game Store'] },
  { name: 'Health', weight: 6, min: 120, max: 3600, merchants: ['Pharmacy Plus', 'Dental Care', 'Fitness Club'] },
  { name: 'Travel', weight: 3, min: 950, max: 26000, merchants: ['SkyHigh Airlines', 'Coastal Hotels', 'Car Rentals'] },
];
export const CITIES = ['Cape Town', 'Johannesburg', 'Durban', 'Pretoria', 'Gqeberha', 'Bloemfontein', 'Stellenbosch', 'East London'];
const TOTAL_WEIGHT = CATEGORIES.reduce((s, c) => s + c.weight, 0);
const DAY = 86400000;

/** Two decimals, as text (decimal columns keep money exact). */
const money = (value) => value.toFixed(2);

/** Picks a category by weight, a merchant and an amount that fit it (small amounts more often than large ones). */
function purchase(rnd) {
  let pick = rnd() * TOTAL_WEIGHT;
  const category = CATEGORIES.find((c) => (pick -= c.weight) < 0) ?? CATEGORIES[0];
  const merchant = category.merchants[Math.floor(rnd() * category.merchants.length)];
  const amount = category.min + (category.max - category.min) * rnd() ** 2.2;
  return { category: category.name, merchant, amount: -amount };
}

/**
 * `count` transactions over the year 2026, in date order, across `accounts` accounts (ACC-1001...): mostly card
 * purchases, with each account's salary on the 25th of each month.
 */
export function* transactions(count, { seed = 2026, accounts = Math.max(50, Math.round(count / 2000)) } = {}) {
  const rnd = random(seed);
  const start = Date.UTC(2026, 0, 1);
  const step = (365 * DAY) / count;
  const salaries = Array.from({ length: accounts }, () => Math.round(18000 + rnd() * 52000));
  const homes = Array.from({ length: accounts }, () => CITIES[Math.floor(rnd() * CITIES.length)]);
  let nextSalaryMonth = 0;
  for (let i = 0; i < count;) {
    // Row i's time: its share of the year, a little later at random; always after the row before.
    const at = start + Math.floor((i * step + rnd() * step) / 1000) * 1000; // whole seconds
    if (nextSalaryMonth < 12 && new Date(at).getUTCMonth() === nextSalaryMonth && new Date(at).getUTCDate() >= 25) {
      // Salaries: when the 25th comes round, each account's, one after another.
      for (let a = 0; a < accounts && i < count; a++, i++) {
        yield { date: new Date(at + a * 1000), account: `ACC-${1001 + a}`, merchant: 'Salary', category: 'Income', city: homes[a], amount: money(salaries[a]) };
      }
      nextSalaryMonth++;
      continue;
    }
    const a = Math.floor(rnd() * accounts);
    const p = purchase(rnd);
    yield { date: new Date(at), account: `ACC-${1001 + a}`, merchant: p.merchant, category: p.category, city: rnd() < 0.8 ? homes[a] : CITIES[Math.floor(rnd() * CITIES.length)], amount: money(p.amount) };
    i++;
  }
}

/** One account's statement for January to March 2026: about 150 transactions, two salaries, and its opening balance. */
export function statement() {
  const rnd = random(1042);
  const rows = [];
  for (let day = 0; day < 90; day++) {
    const at = Date.UTC(2026, 0, 1) + day * DAY;
    const date = new Date(at);
    if (date.getUTCDate() === 25) rows.push({ date: new Date(at + 6 * 3600000), merchant: 'Salary', category: 'Income', amount: money(52000) });
    const purchases = rnd() < 0.15 ? 0 : 1 + Math.floor(rnd() * 2.4);
    for (let k = 0; k < purchases; k++) {
      const p = purchase(rnd);
      rows.push({ date: new Date(at + (8 + k * 4 + Math.floor(rnd() * 4)) * 3600000), ...p, amount: money(p.amount) });
    }
  }
  return { rows, openingBalance: '24850.00' };
}

const FIRST_NAMES = ['Thandi', 'Johan', 'Aisha', 'Pieter', 'Lerato', 'Sipho', 'Megan', 'Ravi', 'Nomvula', 'David', 'Zanele', 'Michael',
  'Fatima', 'Kagiso', 'Sarah', 'Andile', 'Chloe', 'Tshepo', 'Priya', 'Willem', 'Naledi', 'Ethan', 'Amahle', 'Ruan'];
const LAST_NAMES = ['Nkosi', 'van der Merwe', 'Patel', 'Botha', 'Mokoena', 'Dlamini', 'Smith', 'Naidoo', 'Khumalo', 'Jacobs', 'Mahlangu',
  'Pillay', 'le Roux', 'Ndlovu', 'Adams', 'Molefe', 'Fourie', 'Govender'];
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

/**
 * A bank's clients and their card transactions for 2026, for a file of two tables. Clients are in id order and
 * transactions in client and date order, so a shape that nests each client's transactions reads both tables once.
 */
export function bank(clientCount = 250) {
  const rnd = random(77);
  const clients = [];
  const transactions = [];
  for (let id = 1; id <= clientCount; id++) {
    const segment = rnd() < 0.68 ? 'Personal' : rnd() < 0.6 ? 'Business' : 'Private';
    clients.push({
      id, name: `${pick(rnd, FIRST_NAMES)} ${pick(rnd, LAST_NAMES)}`, city: pick(rnd, CITIES), segment,
      since: new Date(Date.UTC(2009 + Math.floor(rnd() * 17), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28))),
    });
    const salary = Math.round((segment === 'Private' ? 60000 : 16000) + rnd() * (segment === 'Private' ? 90000 : 50000));
    const own = [];
    for (let month = 0; month < 12; month++) own.push({ date: new Date(Date.UTC(2026, month, 25, 6)), merchant: 'Salary', category: 'Income', amount: money(salary) });
    const purchases = Math.round(40 + rnd() * 110);
    for (let k = 0; k < purchases; k++) {
      const p = purchase(rnd);
      own.push({ date: new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 365 * 24) * 3600000), merchant: p.merchant, category: p.category, amount: money(p.amount) });
    }
    own.sort((a, b) => a.date - b.date);
    for (const t of own) transactions.push({ client: id, ...t });
  }
  return { clients, transactions };
}

/** A sales report's figures: each branch's revenue and orders by month and category, January to June 2026. */
export function branchSales() {
  const rnd = random(2606);
  const branches = [['Cape Town', 1.15], ['Johannesburg', 1.35], ['Durban', 0.9], ['Pretoria', 1.0], ['Gqeberha', 0.6]];
  const lines = [['Groceries', 420000], ['Home & Garden', 180000], ['Electronics', 260000], ['Clothing', 150000]];
  const rows = [];
  for (let month = 0; month < 6; month++) {
    for (const [branch, size] of branches) {
      for (const [category, base] of lines) {
        const revenue = base * size * (0.85 + rnd() * 0.3) * (1 + month * 0.025);
        rows.push({ month: `2026-${String(month + 1).padStart(2, '0')}`, branch, category, revenue: money(revenue), orders: Math.round(revenue / (180 + rnd() * 140)) });
      }
    }
  }
  return rows;
}

/** A team's task list, for a document that changes its own rows. */
export function tasks() {
  const due = (day) => new Date(Date.UTC(2026, 10, day, 15));
  return [
    { id: 'T-101', task: 'Send the quarterly report to the board', owner: 'Lerato', due: due(3), status: 'In progress', priority: 'High' },
    { id: 'T-102', task: 'Renew the office lease', owner: 'Johan', due: due(14), status: 'Open', priority: 'High' },
    { id: 'T-103', task: 'Plan the year-end function', owner: 'Aisha', due: due(28), status: 'Open', priority: 'Low' },
    { id: 'T-104', task: 'Interview two developers', owner: 'Sipho', due: due(7), status: 'In progress', priority: 'Medium' },
    { id: 'T-105', task: 'Update the price list', owner: 'Megan', due: due(5), status: 'Done', priority: 'Medium' },
    { id: 'T-106', task: 'Move the website to the new host', owner: 'Ravi', due: due(19), status: 'Open', priority: 'Medium' },
    { id: 'T-107', task: 'Check the fire extinguishers', owner: 'Johan', due: due(10), status: 'Done', priority: 'Low' },
  ];
}

/** A company's staff in three branches, with pay: for one file several people open with keys that see different parts. */
export function staff() {
  const rnd = random(311);
  const roles = [['Branch manager', 1, 68000], ['Team lead', 2, 42000], ['Consultant', 5, 27000], ['Administrator', 2, 19500]];
  const rows = [];
  for (const branch of ['Cape Town', 'Johannesburg', 'Durban']) {
    for (const [role, count, pay] of roles) {
      for (let n = 0; n < count; n++) {
        const salary = Math.round(pay * (0.9 + rnd() * 0.25) / 100) * 100;
        rows.push({
          branch, name: `${pick(rnd, FIRST_NAMES)} ${pick(rnd, LAST_NAMES)}`, role,
          since: new Date(Date.UTC(2012 + Math.floor(rnd() * 14), Math.floor(rnd() * 12), 1)),
          salary: money(salary), bonus: money(Math.round(salary * rnd() * 0.15 / 100) * 100),
        });
      }
    }
  }
  return rows;
}
