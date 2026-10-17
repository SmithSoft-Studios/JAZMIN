// Which files the pages open, as scripts (a page opened from disk can't read a file beside it, but it can load a
// script): paths relative to the page. They may be in any folder; a file:/// address works too, for example
// 'file:///C:/Reports/statement.jzm.js'.
var data = {
  file: 'data/statement.jzm.js', // small-file.html and shapes.html
  bank: 'data/bank.jzm.js', // tables.html
  report: 'data/report.jzm.js', // documents.html
  tasks: 'data/tasks.jzm.js', // documents.html
  dashboard: 'data/dashboard.jzm.js', // documents.html: loads its font, charts and icons from the internet
  shared: 'data/shared.jzm.js', // shared.html, with the keys in data/shared-keys.js
  remco: 'data/remco.jzm.js', // two-factor.html, with the key in data/two-factor-keys.js
  masked: 'data/payroll-masked.jzm.js', // masked.html, with the key and the lock's password in data/masked-keys.js
  clientFile: 'data/client-file.jzm.js', // documents.html: a document of four pages
  contracts: 'data/contracts.jzm.js', // two-factor.html: files locked with a lock that names the key service
  customers: 'data/customers.jzm.js', // sort-order.html: in an order that ignores case and accents, numbers by value
  customersPlain: 'data/customers-plain.jzm.js', // sort-order.html: the same rows in plain order
  orders: 'data/orders.jzm.js', // nested.html: orders with their lines as nested columns
  ordersJson: 'data/orders-json.jzm.js', // nested.html: the same orders with their lines as JSON text
  inspections: 'data/inspections.jzm.js', // send-back.html, with the keys in data/inspection-keys.js
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
