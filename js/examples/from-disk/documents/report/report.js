// The report's page: it reads the file's rows through window.jazmin (the viewer holds the file and the key) and draws
// the totals, two charts and a table. The same page prints: the viewer's print, or a PDF with the package's settings.
(function () {
  const $ = (id) => document.getElementById(id);
  const rand = (n) => `R ${Math.round(n).toLocaleString('en-US')}`;
  const millions = (n) => `R ${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)} m`;
  const m = jazmin.metadata || {};
  $('company').textContent = m.company || '';
  $('title').textContent = m.title || 'Sales report';
  $('period').textContent = m.period || '';

  const rows = jazmin.rows(); // a small data set: every row at once (jazmin.query pages through large ones)
  const sum = (list, f) => list.reduce((s, r) => s + f(r), 0);
  const by = (key) => {
    const groups = new Map();
    for (const r of rows) groups.set(r[key], (groups.get(r[key]) || []).concat(r));
    return groups;
  };
  const revenue = (list) => sum(list, (r) => Number(r.revenue));
  const total = revenue(rows);
  const orders = sum(rows, (r) => r.orders);
  const branches = [...by('branch')].map(([name, list]) => ({ name, revenue: revenue(list) })).sort((a, b) => b.revenue - a.revenue);
  $('revenue').textContent = millions(total);
  $('orders').textContent = orders.toLocaleString('en-US');
  $('average').textContent = rand(total / orders);
  $('best').textContent = branches[0].name;

  const top = branches[0].revenue;
  $('branches').replaceChildren(...branches.map((b) => {
    const row = document.createElement('div');
    row.className = 'bar';
    row.innerHTML = '<span></span><span class="track"><span></span></span><strong></strong>';
    row.children[0].textContent = b.name;
    row.children[1].firstChild.style.width = `${(b.revenue / top) * 100}%`;
    row.children[2].textContent = millions(b.revenue);
    return row;
  }));

  const months = [...by('month')].sort().map(([month, list]) => ({ month, revenue: revenue(list) }));
  const peak = Math.max(...months.map((x) => x.revenue));
  $('months').replaceChildren(...months.map((x) => {
    const column = document.createElement('div');
    const label = new Date(`${x.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    column.innerHTML = '<b></b><span></span>';
    column.firstChild.textContent = (x.revenue / 1e6).toFixed(1);
    column.children[1].style.height = `${Math.max(4, (x.revenue / peak) * 82)}%`;
    column.append(label);
    return column;
  }));

  const lines = [...by('category').keys()].sort();
  const cell = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const tr = (cells) => {
    const row = document.createElement('tr');
    row.append(...cells);
    return row;
  };
  $('grid').tHead.append(tr([cell('th', 'Branch'), ...lines.map((l) => cell('th', l)), cell('th', 'Total')]));
  $('grid').tBodies[0].append(...branches.map((b) => {
    const own = rows.filter((r) => r.branch === b.name);
    return tr([cell('td', b.name), ...lines.map((l) => cell('td', rand(revenue(own.filter((r) => r.category === l))))), cell('td', rand(b.revenue))]);
  }));
  $('grid').tFoot.append(tr([cell('td', 'All branches'), ...lines.map((l) => cell('td', rand(revenue(rows.filter((r) => r.category === l))))), cell('td', rand(total))]));

  // Buttons only for what the viewer offers here (the file's settings and the viewer's abilities).
  $('print').hidden = !jazmin.actions.print;
  $('pdf').hidden = !jazmin.actions.pdf;
  $('print').addEventListener('click', () => jazmin.print());
  $('pdf').addEventListener('click', () => jazmin.savePdf());
  jazmin.ready({ rows: rows.length });
}());
