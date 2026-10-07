// The template both the viewer's browser test (scripts/viewer-e2e.mjs) and renderPdf's test (server.test.js) render:
// one template, the same answers in the viewer and in a PDF (TASKS F-3). It uses the document API: count, sorted
// queries (an integer, and a decimal whose text order differs from its numeric order), a date, all rows, an embedded
// file and an image, then calls jazmin.ready() with what it saw.

const APP = `(async () => {
  const total = await jazmin.count();
  const top = (await jazmin.query({ n: { gte: 100 } }, { orderBy: '-n', limit: 3, select: ['n'] })).map((r) => r.n);
  const amounts = (await jazmin.query(null, { orderBy: '-amount', limit: 3, select: ['amount'] })).map((r) => r.amount);
  const [first] = await jazmin.query(null, { limit: 1, select: ['at'] });
  const note = await (await jazmin.file('notes.txt')).text();
  const img = document.getElementById('dot');
  if (!img.complete) await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
  document.getElementById('out').textContent = 'JAZMIN interop template: ' + total + ' rows';
  jazmin.ready({ total, top, amounts, all: jazmin.rows().length, columns: jazmin.columns.map((c) => c.name),
    date: first.at instanceof Date && first.at.toISOString(), note, image: img.naturalWidth > 0 });
})();`;

/** Writes the template file with write() from the library: options adds the key (or password). */
export function writeTemplate(write, target, options = {}) {
  const start = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: 120 }, (_, n) => ({ n, label: `row ${n}`, amount: `${n * 9}.25`, at: new Date(start + n * 3_600_000) }));
  write(target, rows, {
    columns: [{ name: 'n', type: 'int' }, { name: 'label', type: 'string' }, { name: 'amount', type: 'decimal' }, { name: 'at', type: 'datetime' }],
    ...options,
    files: [
      { path: 'index.html', content: '<!doctype html><title>Template</title><body><img id="dot" src="img/dot.svg" alt=""><p id="out">…</p><script src="js/app.js"></script></body>' },
      { path: 'js/app.js', content: APP },
      { path: 'img/dot.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>' },
      { path: 'notes.txt', content: 'notes from the package' },
    ],
    package: { entry: 'index.html', title: 'Template' },
  });
}

/** What the template reports, in the viewer and in a PDF. Amounts by value: as text, 999.25 would come first. */
export const TEMPLATE_READY = {
  total: 120,
  top: [119, 118, 117],
  amounts: ['1071.25', '1062.25', '1053.25'],
  all: 120,
  columns: ['n', 'label', 'amount', 'at'],
  date: '2026-01-01T00:00:00.000Z',
  note: 'notes from the package',
  image: true,
};
