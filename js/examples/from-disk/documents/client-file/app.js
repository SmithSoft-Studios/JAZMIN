// What the client file's pages share: money and dates as the bank shows them, and a client picker that reads the
// clients table by name (jazmin.query(..., { table: 'clients' })). Stored in the file and listed in package.files.
(function () {
  const money = (n) => `${n < 0 ? '−' : ''}R ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const since = (t) => `${Math.max(1, Math.round(performance.now() - t))} ms`;
  const cell = (text, className) => Object.assign(document.createElement('td'), { textContent: text, className: className || '' });

  /** Fills a <select> with the file's clients (250: one read of their id and name) and calls onPick(client) on a change. */
  async function clientPicker(select, onPick) {
    const clients = await jazmin.query({}, { table: 'clients', select: ['id', 'name', 'city', 'segment', 'since'], limit: 1000 });
    select.replaceChildren(...clients.map((c) => new Option(`${c.name} (#${c.id})`, String(c.id))));
    const pickNow = () => onPick(clients.find((c) => String(c.id) === select.value));
    select.addEventListener('change', pickNow);
    return { clients, pickNow };
  }

  const meta = jazmin.metadata || {};
  for (const el of document.querySelectorAll('[data-meta="title"]')) el.textContent = meta.title || '';
  window.app = { money, day, since, cell, clientPicker };
}());
