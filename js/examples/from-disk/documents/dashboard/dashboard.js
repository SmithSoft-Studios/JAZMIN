// The dashboard inside dashboard.jzm: its rows from the file (jazmin.rows()), drawn with Chart.js, which the page loads
// from jsDelivr as the file allows (package.allowedOrigins; online: 'required', so the viewer says it needs the
// internet). Without the network, or if the script didn't load, the figures show as a table.
(function () {
  const $ = (id) => document.getElementById(id);
  const meta = jazmin.metadata || {};
  const rows = jazmin.rows();
  const money = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: meta.currency || 'ZAR', maximumFractionDigits: 0 });
  const millions = (n) => `R${(n / 1e6).toFixed(1)}m`;
  const sum = (list, key) => list.reduce((n, r) => n + Number(r[key]), 0);
  const group = (key) => {
    const map = new Map();
    for (const r of rows) map.set(r[key], [...(map.get(r[key]) || []), r]);
    return map;
  };
  const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });

  $('company').textContent = meta.company || '';
  $('period').textContent = meta.period || '';
  $('online').textContent = jazmin.online ? 'Online' : 'Offline';
  $('revenue').textContent = millions(sum(rows, 'revenue'));
  $('orders').textContent = sum(rows, 'orders').toLocaleString('en-ZA');
  const branches = [...group('branch')].map(([name, list]) => ({ name, revenue: sum(list, 'revenue'), orders: sum(list, 'orders') }))
    .sort((a, b) => b.revenue - a.revenue);
  $('branches').textContent = String(branches.length);
  const months = [...group('month').keys()].sort();
  const byMonth = months.map((m) => sum(rows.filter((r) => r.month === m), 'revenue'));
  $('best').textContent = monthName(months[byMonth.indexOf(Math.max(...byMonth))]);

  if (typeof Chart !== 'function') { // the script from the internet isn't here: the figures as a table
    document.querySelector('.grid').hidden = true;
    $('fallback').hidden = false;
    $('fallback-rows').replaceChildren(...branches.map((b) => {
      const tr = document.createElement('tr');
      for (const text of [b.name, money.format(b.revenue), b.orders.toLocaleString('en-ZA')]) tr.append(Object.assign(document.createElement('td'), { textContent: text }));
      return tr;
    }));
    jazmin.ready({ charts: 0 });
    return;
  }

  const palette = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444'];
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  Chart.defaults.color = '#5d6679';
  Chart.defaults.animation.duration = 500; // only the duration: the rest of Chart.js's animation settings stay
  const axis = { ticks: { callback: (v) => millions(v) }, grid: { color: '#eef1f6' } };

  new Chart($('months'), {
    type: 'line',
    data: {
      labels: months.map(monthName),
      datasets: branches.map((b, i) => ({
        label: b.name, borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length], tension: 0.3, pointRadius: 3,
        data: months.map((m) => sum(rows.filter((r) => r.month === m && r.branch === b.name), 'revenue')),
      })),
    },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { y: axis },
      plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money.format(c.parsed.y)}` } } } },
  });
  new Chart($('branch'), {
    type: 'bar',
    data: { labels: branches.map((b) => b.name), datasets: [{ data: branches.map((b) => b.revenue), backgroundColor: palette, borderRadius: 6 }] },
    options: { maintainAspectRatio: false, scales: { y: axis, x: { grid: { display: false } } }, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: (c) => money.format(c.parsed.y) } } } },
  });
  const categories = [...group('category')].map(([name, list]) => ({ name, revenue: sum(list, 'revenue') }));
  new Chart($('category'), {
    type: 'doughnut',
    data: { labels: categories.map((c) => c.name), datasets: [{ data: categories.map((c) => c.revenue), backgroundColor: palette, borderWidth: 0 }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right' },
      tooltip: { callbacks: { label: (c) => `${c.label}: ${money.format(c.parsed)}` } } } },
  });
  jazmin.ready({ charts: 3 });
})();
