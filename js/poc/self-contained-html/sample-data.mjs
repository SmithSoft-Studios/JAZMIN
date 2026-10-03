// A deterministic sample bank statement: 12 months of transactions for one account.
export function sampleStatement() {
  let seed = 20261002;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const spend = [
    ['Groceries', ['Checkers Hyper', 'Woolworths Food', 'Pick n Pay', 'Spar Kloof']],
    ['Fuel', ['Engen Garage', 'Shell Ultra City', 'BP Express']],
    ['Eating out', ['Ocean Basket', 'Nando\'s', 'Vida e Caffe', 'Spur Steak Ranch']],
    ['Utilities', ['City Power prepaid', 'Water and rates', 'Fibre internet']],
    ['Shopping', ['Takealot order', 'Mr Price', 'Dis-Chem']],
  ];

  const rows = [];
  let balance = 1_250_000; // cents
  const add = (date, description, category, cents) => {
    balance += cents;
    rows.push({ date, description, category, amount: (cents / 100).toFixed(2), balance: (balance / 100).toFixed(2) });
  };
  for (let m = 0; m < 12; m++) {
    const year = 2025 + Math.floor((9 + m) / 12);
    const month = (9 + m) % 12;
    const at = (d) => new Date(Date.UTC(year, month, d, 9, 0, 0));
    add(at(1), 'Salary - Example Employer', 'Income', 3_850_000);
    add(at(3), 'Home loan repayment', 'Housing', -1_420_000);
    for (let i = 0; i < 12; i++) {
      const [category, places] = pick(spend);
      add(at(4 + Math.floor(random() * 24)), pick(places), category, -Math.round(5_000 + random() * 180_000));
    }
    if (m % 3 === 2) add(at(28), 'Interest received', 'Income', Math.round(random() * 40_000));
  }
  rows.sort((a, b) => a.date - b.date);
  // Recompute running balances in date order.
  let running = 1_250_000;
  for (const r of rows) {
    running += Math.round(Number(r.amount) * 100);
    r.balance = (running / 100).toFixed(2);
  }

  return {
    rows,
    columns: [
      { name: 'date', type: 'datetime', nullable: false, index: 'sorted' },
      { name: 'description', type: 'string', nullable: false, index: 'trigram' },
      { name: 'category', type: 'string', nullable: false, index: 'sorted' },
      { name: 'amount', type: 'decimal', nullable: false },
      { name: 'balance', type: 'decimal', nullable: false },
    ],
    metadata: {
      title: 'Account statement',
      client: 'Ms A. Sample',
      account: '1234 5678 90',
      period: '1 October 2025 - 30 September 2026',
      currency: 'R',
    },
  };
}
