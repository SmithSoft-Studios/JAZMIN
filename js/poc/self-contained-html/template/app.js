// The statement template. Data comes from window.jazmin (the rows in this package); nothing is fetched.
(function () {
  'use strict';
  const meta = jazmin.metadata;
  const rows = jazmin.rows().sort((a, b) => a.date - b.date);
  const $ = (id) => document.getElementById(id);
  const amount = (r) => Number(r.amount); // decimals arrive as exact strings
  const money = (n) => (n < 0 ? '-' : '') + meta.currency + ' '
    + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (d) => d.toISOString().slice(0, 10);

  $('client').textContent = meta.client;
  $('account').textContent = 'Account ' + meta.account;
  $('title').textContent = meta.title;
  $('period').textContent = 'Period: ' + meta.period;
  const moneyIn = rows.filter((r) => amount(r) > 0).reduce((s, r) => s + amount(r), 0);
  const moneyOut = rows.filter((r) => amount(r) < 0).reduce((s, r) => s + amount(r), 0);
  const closing = Number(rows[rows.length - 1].balance);
  $('opening').textContent = money(closing - moneyIn - moneyOut);
  $('in').textContent = money(moneyIn);
  $('out').textContent = money(moneyOut);
  $('closing').textContent = money(closing);

  for (const c of [...new Set(rows.map((r) => r.category))].sort()) $('category').add(new Option(c, c));

  function visible() {
    const text = $('search').value.trim().toLowerCase();
    const category = $('category').value;
    return rows.filter((r) => (!text || r.description.toLowerCase().includes(text)) && (!category || r.category === category));
  }

  function renderTable() {
    const list = visible();
    $('rows').replaceChildren(...list.map((r) => {
      const tr = document.createElement('tr');
      const cells = [
        [day(r.date)], [r.description], [r.category],
        [money(amount(r)), amount(r) < 0 ? 'num neg' : 'num pos'], [money(Number(r.balance)), 'num'],
      ];
      for (const [value, cls] of cells) {
        const td = document.createElement('td');
        td.textContent = value;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      return tr;
    }));
    $('count').textContent = `${list.length} of ${rows.length} transactions`;
  }

  function renderChart() {
    const months = new Map();
    for (const r of rows) {
      const m = day(r.date).slice(0, 7);
      const e = months.get(m) || { in: 0, out: 0 };
      if (amount(r) > 0) e.in += amount(r);
      else e.out -= amount(r);
      months.set(m, e);
    }
    const c = $('chart').getContext('2d');
    const { width, height } = c.canvas;
    const max = Math.max(...[...months.values()].flatMap((e) => [e.in, e.out]));
    const slot = width / months.size;
    const scale = (height - 30) / max;
    c.font = '12px Segoe UI, sans-serif';
    [...months].forEach(([m, e], i) => {
      const x = i * slot + slot * 0.2;
      const bar = slot * 0.28;
      c.fillStyle = '#12b76a';
      c.fillRect(x, height - 20 - e.in * scale, bar, e.in * scale);
      c.fillStyle = '#f04438';
      c.fillRect(x + bar + 2, height - 20 - e.out * scale, bar, e.out * scale);
      c.fillStyle = '#5b6475';
      c.fillText(m.slice(5) + '/' + m.slice(2, 4), x, height - 4);
    });
  }

  function exportCsv() {
    const quote = (v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    const lines = [['date', 'description', 'category', 'amount', 'balance'].join(',')]
      .concat(visible().map((r) => [day(r.date), r.description, r.category, r.amount, r.balance].map((v) => quote(String(v))).join(',')));
    jazmin.download(`statement-${meta.account}.csv`, lines.join('\r\n') + '\r\n', 'text/csv');
  }

  function exportPdf() {
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    let y = 56;
    doc.setFontSize(16);
    doc.text(meta.title, 40, y);
    y += 20;
    doc.setFontSize(10);
    doc.text(`${meta.client} - account ${meta.account} - ${meta.period}`, 40, y);
    y += 24;
    doc.setFontSize(9);
    for (const r of visible()) {
      if (y > 800) {
        doc.addPage();
        y = 48;
      }
      doc.text(day(r.date), 40, y);
      doc.text(r.description.slice(0, 48), 110, y);
      doc.text(r.amount, 440, y, { align: 'right' });
      doc.text(r.balance, 540, y, { align: 'right' });
      y += 14;
    }
    jazmin.download(`statement-${meta.account}.pdf`, doc.output('blob'));
  }

  $('search').addEventListener('input', renderTable);
  $('category').addEventListener('change', renderTable);
  $('print').addEventListener('click', () => jazmin.print());
  $('csv').addEventListener('click', exportCsv);
  if (window.jspdf) $('pdf').addEventListener('click', exportPdf);
  else $('pdf').hidden = true; // packaged without jsPDF: Print > Save as PDF still works

  renderTable();
  renderChart();

  // Tells the viewer (and the automated test) what rendered.
  const logo = document.querySelector('.logo');
  const done = () => jazmin.ready({
    rows: rows.length, shown: $('rows').children.length,
    closing: rows[rows.length - 1].balance, logo: logo.naturalWidth > 0, jspdf: !!window.jspdf,
    pdfBytes: window.jspdf ? new window.jspdf.jsPDF().output('arraybuffer').byteLength : 0,
  });
  if (logo.complete) done();
  else logo.addEventListener('load', done, { once: true });
})();
