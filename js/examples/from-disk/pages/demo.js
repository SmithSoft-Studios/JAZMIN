// Small helpers the demo pages share: formatting, the password form, tables, saving a file, and the viewer shown over
// the page with a file the page hands it.
var demo = (function () {
  const $ = (id) => document.getElementById(id);
  const rand = (n) => `${n < 0 ? '−' : ''}R ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const since = (t) => {
    const ms = performance.now() - t;
    return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`;
  };
  const day = (d) => (d instanceof Date ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

  /** A value as a table shows it: money, dates, numbers; '—' for none. */
  function show(value, column) {
    if (value === null || value === undefined) return '—';
    if (value instanceof Date) return day(value);
    if (column && /amount|salary|bonus|revenue|total|spent|largest/.test(column) && !Number.isNaN(Number(value))) return rand(Number(value));
    return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
  }

  /** A table of rows: columns [name] or [[name, heading]]; numbers and money to the right. */
  function table(rows, columns) {
    const el = document.createElement('table');
    const cols = columns.map((c) => (Array.isArray(c) ? c : [c, c]));
    const head = el.createTHead().insertRow();
    for (const [name, heading] of cols) {
      const th = document.createElement('th');
      th.textContent = heading;
      if (rows.some((r) => typeof r[name] === 'number' || /amount|salary|bonus|revenue|total|spent/.test(name))) th.className = 'number';
      head.append(th);
    }
    const body = el.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const [name] of cols) {
        const td = tr.insertCell();
        td.textContent = show(row[name], name);
        if (typeof row[name] === 'number' || /amount|salary|bonus|revenue|total|spent/.test(name)) td.className = `number${Number(row[name]) < 0 ? ' out' : ''}`;
      }
    }
    return el;
  }

  /**
   * A password form: on submit, `open(password)` opens the file. The button says "Opening…" meanwhile, and a wrong
   * password shows below the form.
   */
  function unlock(form, error, open) {
    $(form).addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $(form).querySelector('button');
      button.disabled = true;
      button.textContent = 'Opening…';
      $(error).textContent = '';
      try {
        await open($(form).querySelector('input').value);
      } catch (e) {
        $(error).textContent = e instanceof JazminBrowser.JazminKeyError ? 'Wrong password: try again' : (e.message || String(e));
      } finally {
        button.disabled = false;
        button.textContent = 'Open';
      }
    });
  }

  function save(blob, name) {
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  /**
   * Shows the viewer over the page and hands it a file (bytes, as JazminBrowser.scriptBytes gives them): the page
   * opened from disk can't, but the viewer next to it reads what the page passes it. It asks for the password itself.
   */
  function inViewer(bytes, name, { filter } = {}) {
    let overlay = document.querySelector('.viewer-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'viewer-overlay';
      overlay.innerHTML = '<div class="bar"><strong></strong><button type="button" class="soft">Close ✕</button></div><iframe title="JAZMIN viewer"></iframe>';
      overlay.querySelector('button').addEventListener('click', () => overlay.remove());
      document.addEventListener('keydown', function closeOnEscape(e) {
        if (e.key !== 'Escape' || !document.body.contains(overlay)) return;
        overlay.remove();
        document.removeEventListener('keydown', closeOnEscape);
      });
      document.body.append(overlay);
    }
    overlay.querySelector('strong').textContent = `${name} in the viewer`;
    const frame = overlay.querySelector('iframe');
    frame.onload = () => {
      frame.contentWindow.postMessage({ type: 'jazmin:open', file: new Blob([bytes]), name }, '*');
      if (filter) {
        // The filter waits until the file is open: the viewer answers jazmin:status when it is.
        const opened = (e) => {
          if (e.source !== frame.contentWindow || e.data?.type !== 'jazmin:status' || e.data.state !== 'opened') return;
          frame.contentWindow.postMessage({ type: 'jazmin:filter', filter }, '*');
          window.removeEventListener('message', opened);
        };
        window.addEventListener('message', opened);
      }
    };
    frame.src = 'viewer/index.html';
    return overlay;
  }

  return { $, rand, since, day, show, table, unlock, save, inViewer };
}());
