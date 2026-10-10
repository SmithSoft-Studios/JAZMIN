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
