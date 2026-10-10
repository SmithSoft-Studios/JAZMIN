// Which file small-file.html opens: the statement made into a script, by a path relative to the page. It may be in
// any folder; a file:/// address works too, for example 'file:///C:/Reports/statement.jzm.js'.
var data = {
  file: 'data/statement.jzm.js',
};

// Filters pick-file.html offers for a demo file, by its name: each button sends one to the viewer
// ({ type: 'jazmin:filter', filter }), as typing it in the viewer's Filter box does.
var demos = {
  'transactions.jzm': [
    { label: 'One account', filter: { account: 'ACC-1042' } },
    { label: 'Coffee shops', filter: { merchant: { icontains: 'coffee' } } },
    { label: 'Spends over R 20,000', filter: { amount: { lt: '-20000' } } },
    { label: 'Travel in March', filter: { category: 'Travel', date: { gte: '2026-03-01T00:00:00Z', lt: '2026-04-01T00:00:00Z' } } },
    { label: 'Salaries', filter: { category: 'Income' } },
  ],
};
