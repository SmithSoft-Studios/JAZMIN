// The report's page: it reads the file's rows through window.jazmin (the viewer holds the file and the key) and draws
// the totals, two charts and a table. Print uses the viewer's print. Save as PDF makes the PDF here, with pdf.js (stored
// in the file beside this page), and downloads it: no print dialog, and the same file in every browser.
(function () {
  const $ = (id) => document.getElementById(id);
  const rand = (n) => `R ${Math.round(n).toLocaleString('en-US')}`;
  const millions = (n) => `R ${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)} m`;
  const monthName = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const m = jazmin.metadata || {};
  const title = m.title || 'Sales report';
  $('company').textContent = m.company || '';
  $('title').textContent = title;
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
  const kpis = [['Revenue', millions(total)], ['Orders', orders.toLocaleString('en-US')], ['Average order', rand(total / orders)], ['Best branch', branches[0].name]];
  $('revenue').textContent = kpis[0][1];
  $('orders').textContent = kpis[1][1];
  $('average').textContent = kpis[2][1];
  $('best').textContent = kpis[3][1];

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
    column.innerHTML = '<b></b><span></span>';
    column.firstChild.textContent = (x.revenue / 1e6).toFixed(1);
    column.children[1].style.height = `${Math.max(4, (x.revenue / peak) * 82)}%`;
    column.append(monthName(x.month));
    return column;
  }));

  // The table, as text: the page's and the PDF's.
  const lines = [...by('category').keys()].sort();
  const head = ['Branch', ...lines, 'Total'];
  const body = branches.map((b) => {
    const own = rows.filter((r) => r.branch === b.name);
    return [b.name, ...lines.map((l) => rand(revenue(own.filter((r) => r.category === l)))), rand(b.revenue)];
  });
  const foot = ['All branches', ...lines.map((l) => rand(revenue(rows.filter((r) => r.category === l)))), rand(total)];
  const cell = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const tr = (tag, cells) => {
    const row = document.createElement('tr');
    row.append(...cells.map((text) => cell(tag, text)));
    return row;
  };
  $('grid').tHead.append(tr('th', head));
  $('grid').tBodies[0].append(...body.map((cells) => tr('td', cells)));
  $('grid').tFoot.append(tr('td', foot));

  /** The report drawn on an A4 page, as the screen shows it. */
  function reportPdf() {
    const ink = '#1d2433';
    const muted = '#5b6475';
    const rule = '#e1e5ec';
    const soft = '#f4f6fa';
    const accent = '#2456c9';
    const pdf = new MiniPdf({ title: `${title}${m.period ? `, ${m.period}` : ''}` });
    const M = 40; // margin
    const W = pdf.width - 2 * M;
    let y = 52;
    pdf.text(M, y, (m.company || '').toUpperCase(), { size: 8.5, bold: true, color: accent });
    pdf.text(M, (y += 26), title, { size: 22, bold: true, color: ink });
    pdf.text(M, (y += 18), m.period || '', { size: 10.5, color: muted });
    pdf.line(M, (y += 14), M + W, y, { color: ink, width: 1.5 });

    y += 16;
    const kw = (W - 30) / 4;
    kpis.forEach(([label, value], i) => {
      const x = M + i * (kw + 10);
      pdf.rect(x, y, kw, 52, { fill: soft, radius: 7 });
      pdf.text(x + 12, y + 19, label, { size: 8.5, color: muted });
      pdf.text(x + 12, y + 39, value, { size: 15, bold: true, color: ink });
    });

    y += 66;
    const cw = (W - 12) / 2;
    const ch = 196;
    pdf.rect(M, y, cw, ch, { stroke: rule, radius: 9 });
    pdf.text(M + 14, y + 24, 'Revenue by branch', { size: 10.5, bold: true, color: ink });
    const step = Math.min(26, (ch - 64) / branches.length);
    const tx = M + 100;
    const tw = cw - 100 - 72;
    branches.forEach((b, i) => {
      const by = y + 54 + i * step;
      pdf.text(M + 14, by + 3, b.name, { size: 9, color: ink });
      pdf.rect(tx, by - 3.5, tw, 6.5, { fill: soft, radius: 3.25 });
      pdf.rect(tx, by - 3.5, Math.max(6.5, tw * (b.revenue / top)), 6.5, { fill: accent, radius: 3.25 });
      pdf.text(M + cw - 14, by + 3, millions(b.revenue), { size: 9, bold: true, color: ink, align: 'right' });
    });

    const mx = M + cw + 12;
    pdf.rect(mx, y, cw, ch, { stroke: rule, radius: 9 });
    pdf.text(mx + 14, y + 24, 'Revenue by month', { size: 10.5, bold: true, color: ink });
    const base = y + ch - 28;
    const tall = ch - 28 - 62;
    const slot = (cw - 28) / months.length;
    const bw = Math.min(32, slot - 10);
    months.forEach((x, i) => {
      const cx = mx + 14 + slot * (i + 0.5);
      const h = Math.max(3, (x.revenue / peak) * tall);
      pdf.rect(cx - bw / 2, base - h, bw, h, { fill: accent, radius: 3 });
      pdf.text(cx, base - h - 6, (x.revenue / 1e6).toFixed(1), { size: 8, bold: true, color: ink, align: 'center' });
      pdf.text(cx, base + 14, monthName(x.month), { size: 8, color: muted, align: 'center' });
    });

    y += ch + 14;
    const rowH = 20;
    const th = 50 + rowH * (body.length + 1) + 12;
    pdf.rect(M, y, W, th, { stroke: rule, radius: 9 });
    pdf.text(M + 14, y + 24, 'Branches and product lines', { size: 10.5, bold: true, color: ink });
    const first = 104;
    const colW = (W - 28 - first) / (head.length - 1);
    const at = (i) => (i === 0 ? M + 14 : M + 14 + first + colW * i); // left edge of the first column, right edge of the rest
    const row = (cells, ry, style) => cells.forEach((text, i) => pdf.text(at(i), ry, text, { ...style, align: i ? 'right' : 'left' }));
    let ry = y + 50;
    row(head.map((h) => h.toUpperCase()), ry, { size: 7.5, bold: true, color: muted });
    for (const [i, cells] of body.entries()) {
      pdf.line(M + 14, ry + 7, M + W - 14, ry + 7, { color: rule, width: 0.75 });
      ry += rowH;
      row(cells, ry, { size: 9, color: ink });
    }
    pdf.line(M + 14, ry + 7, M + W - 14, ry + 7, { color: ink, width: 1.5 });
    ry += rowH;
    row(foot, ry, { size: 9, bold: true, color: ink });

    const footer = pdf.height - 28;
    pdf.text(M, footer, `${m.company ? `${m.company} · ` : ''}${title}${m.period ? `, ${m.period}` : ''} · made from report.jzm`, { size: 7.5, color: muted });
    pdf.text(M + W, footer, 'Page 1 of 1', { size: 7.5, color: muted, align: 'right' });
    return pdf;
  }

  async function savePdf() {
    const button = $('pdf');
    button.disabled = true;
    button.textContent = 'Making the PDF…';
    try {
      const blob = await reportPdf().blob();
      jazmin.download(`${title}${m.period ? ` - ${m.period}` : ''}.pdf`, blob, 'application/pdf');
    } finally {
      button.disabled = false;
      button.textContent = 'Save as PDF';
    }
  }

  // Buttons only for what the file allows here: Print through the viewer, Save as PDF made by this page.
  $('print').hidden = !jazmin.actions.print;
  $('pdf').hidden = !jazmin.actions.pdf;
  $('print').addEventListener('click', () => jazmin.print());
  $('pdf').addEventListener('click', savePdf);
  jazmin.ready({ rows: rows.length });
}());
