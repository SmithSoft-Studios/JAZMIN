// The rows and where functions the query tests run in the library and the browser reader (lambda-query.test.js,
// browser-query.test.js): every operator, nulls, decimals at their rounding edges, dates, text calls, values passed
// and not, and functions the translator leaves to JavaScript.
export const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'city', type: 'string', index: 'sorted' },
  { name: 'amount', type: 'decimal' },
  { name: 'score', type: 'float' },
  { name: 'n', type: 'int' },
  { name: 'active', type: 'bool' },
  { name: 'joined', type: 'datetime' },
  { name: 'note', type: 'string' },
];
const cities = ['Durban', 'Cape Town', 'durban', 'Pretoria', null, ''];
const amounts = ['-25000.00', '-5000', '-4999.99', '0.00', '12.50', '99.999999999999999999', '100', '100.000000000000000001', null];
export const rows = Array.from({ length: 360 }, (_, i) => ({
  id: i,
  city: cities[i % cities.length],
  amount: amounts[i % amounts.length],
  score: i % 7 === 0 ? null : (i % 11) - 5.5,
  n: i % 5 === 0 ? null : (i % 9) - 4,
  active: i % 4 === 0 ? null : i % 3 === 0,
  joined: i % 6 === 0 ? null : new Date(Date.UTC(2026, i % 12, 1 + (i % 27))),
  note: i % 8 === 0 ? null : `note ${i} ${i % 2 ? 'Coffee' : 'tea'}`,
}));

export const city = 'Durban';
const limit = -5000;
const day = new Date(Date.UTC(2026, 5, 1));
/** [function, values?]: every operator, both sides, nulls, decimals at their rounding edges, dates, text calls. */
export const CASES = [
  [(t) => t.city === 'Durban'], [(t) => t.city == 'Durban'], [(t) => t.city !== 'Durban'], [(t) => t.city != 'Durban'], // eslint-disable-line eqeqeq
  [(t) => 'Durban' === t.city], [(t) => t.city === null], [(t) => t.city == null], [(t) => t.city !== null], [(t) => t.city === undefined], // eslint-disable-line eqeqeq
  [(t) => t.city < 'E'], [(t) => t.city >= 'D'], [(t) => t.city > ''], [(t) => t.city],
  [(t) => t.n < 0], [(t) => t.n <= 0], [(t) => t.n > -1], [(t) => t.n >= 0], [(t) => 0 > t.n], [(t) => t.n === 0], [(t) => t.n !== 0], [(t) => t.n],
  [(t) => !t.n], [(t) => t.n < 2 && t.n > -2], [(t) => t.n < -3 || t.n > 3], [(t) => !(t.n < 0)],
  [(t) => t.score < 0], [(t) => t.score >= -0.5], [(t) => t.score === 0.5], [(t) => t.score !== 0.5],
  [(t) => t.amount < -5000], [(t) => t.amount <= -5000], [(t) => t.amount > 100], [(t) => t.amount >= 100], [(t) => t.amount == 100], // eslint-disable-line eqeqeq
  [(t) => t.amount === 100], [(t) => t.amount != 100], [(t) => t.amount < 0], [(t) => t.amount], [(t) => !t.amount], [(t) => t.amount <= 99.99999999999999], // eslint-disable-line eqeqeq
  [(t) => t.active], [(t) => !t.active], [(t) => t.active === true], [(t) => t.active === false], [(t) => t.active !== true], [(t) => t.active == null], // eslint-disable-line eqeqeq
  [(t) => t.joined > new Date('2026-06-01')], [(t) => t.joined <= new Date(Date.UTC(2026, 2, 1))], [(t) => t.joined], [(t) => t.joined === null],
  [(t, $) => t.joined >= $.day, { day }], [(t) => t.joined === day], [(t) => t.joined !== day],
  [(t) => t.note.includes('Coffee')], [(t) => t.note?.includes('Coffee')], [(t) => t.note?.startsWith('note 1')], [(t) => t.note?.toLowerCase().includes('coffee')],
  [(t) => t.note?.toLowerCase().includes('Coffee')], [(t) => t.note?.toUpperCase().includes('COFFEE')], [(t) => t.note?.endsWith('tea')],
  [(t) => ['Durban', 'Pretoria'].includes(t.city)], [(t, $) => $.list.includes(t.n), { list: [1, 2, null] }], [(t) => [-4, 4].includes(t.n)],
  [(t, $) => t.city === $.city && t.amount < $.limit, { city, limit }], [(t) => t.city === city], [(t, $) => t.city === $.missing, {}],
  [({ city: c }) => c === 'Durban'], [({ city, n }) => city === 'Durban' && n > 0], // eslint-disable-line no-shadow
  [function (t) { return t.n > 1; }], [(t) => { return t.city === 'Pretoria' || t.active; }], [(t) => { const x = t.n; return x > 1; }],
  [(t) => t.n > 1 && String(t.id).endsWith('7')], [(t) => t.n > 1 || String(t.id).endsWith('7')], [(t) => !(t.n > 1 && t.id % 2)],
  [(t) => t.n + 1 > 2], [(t) => t.n > t.id], [(t) => (t.n ?? 0) > 1], [(t) => (t.active ? t.n > 0 : t.n < 0)], [(t) => /^D/.test(t.city ?? '')],
  [(t) => t.missing === 1], [(t) => t['city'] === 'Durban'], [(t) => t.id === 9007199254740993], // eslint-disable-line dot-notation, no-loss-of-precision
];
