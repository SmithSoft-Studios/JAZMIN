// The JAZMIN viewer (TASKS F-2): an installable web app, a hosted page, or a self-contained HTML file. Opens a .jzm
// on this device - nothing is uploaded - and shows its document (the package's entry page, in a sandbox), its data
// and its files. The file is read in slices with the browser reader (js/browser/jazmin-browser.js).
(function () {
  'use strict';

  const { JazminBrowser, JazminSandbox } = globalThis;
  const $ = (id) => document.getElementById(id);
  const PAGE_ROWS = 50;
  const ROWS_FOR_TEMPLATES = 20000; // jazmin.rows() is offered up to this many rows; beyond it, templates use query()

  const state = { blob: null, name: '', options: null, reader: null, readers: new Map(), filter: null, page: 0, total: 0, shown: null, answerTo: null };

  const status = (message) => { $('jz-status').textContent = message || ''; };

  function show(id) {
    for (const panel of ['jz-start', 'jz-unlock', 'jz-content']) $(panel).hidden = panel !== id;
  }

  // ---- choosing and unlocking a file -------------------------------------------------------------

  /**
   * Takes a file (picker, drop, file handler, an embedded copy, or the page around the viewer) and opens it, asking for
   * a key when it needs one. `answerTo`: the origin of the page that passed the file, which hears how it opens.
   */
  async function choose(blob, name, answerTo = null) {
    state.blob = blob;
    state.name = name || 'file.jzm';
    state.answerTo = answerTo;
    state.readers.clear();
    $('jz-name').textContent = state.name;
    $('jz-key').value = '';
    $('jz-token').value = '';
    $('jz-token-row').hidden = true;
    $('jz-error').textContent = '';
    try {
      await open({});
    } catch (error) {
      if (!(error instanceof JazminBrowser.JazminKeyError)) return fail(error);
      $('jz-unlock-title').textContent = `${state.name} is locked`;
      status(''); // nothing is opening now: the file waits for its key
      show('jz-unlock');
      $('jz-key').focus();
      tell('locked');
    }
  }

  /** Tells the page that passed the file how it opens: 'opened', 'locked' (the key is typed here) or 'failed'. */
  function tell(outcome, message) {
    if (state.answerTo) window.parent.postMessage(Object.assign({ type: 'jazmin:status', state: outcome, name: state.name }, message ? { message } : {}), state.answerTo);
  }

  /** Opens the chosen file with these options: { key | password, unlockToken }. */
  async function open(options) {
    status('Opening…');
    const reader = await JazminBrowser.open(state.blob, options);
    state.options = options;
    state.readers.set(reader.table, reader);
    state.reader = reader;
    await render(reader);
    status(describe(reader));
    tell('opened');
    return reader;
  }

  function fail(error) {
    show(state.reader ? 'jz-content' : 'jz-start');
    status(`Could not open ${state.name}: ${error.message || error}`);
    tell('failed', String(error.message || error));
  }

  async function unlock(event) {
    event.preventDefault();
    const secret = $('jz-key').value.trim();
    const token = $('jz-token').value.trim();
    const options = /^jz[ka]1-/.test(secret) ? { key: secret } : { password: secret };
    if (token) options.unlockToken = token;
    $('jz-error').textContent = '';
    // The Open button says it is opening, where the person is looking, until the file opens or the key is refused.
    const button = $('jz-unlock').querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Opening…';
    try {
      await open(options);
    } catch (error) {
      if (error instanceof JazminBrowser.JazminUnlockRequiredError) {
        $('jz-token-row').hidden = false;
        $('jz-file-id').textContent = error.fileId;
        $('jz-key-id').textContent = error.keyId;
        $('jz-token').focus();
      }
      if (error.masterKeyRefused) $('jz-key').value = ''; // don't leave a master key in the page
      $('jz-error').textContent = error.message || String(error);
      status('');
    } finally {
      button.disabled = false;
      button.textContent = 'Open';
    }
  }

  function describe(reader) {
    const parts = [`${reader.rowCount.toLocaleString()} rows`];
    if (reader.hiddenRowCount) parts.push(`${reader.hiddenRowCount.toLocaleString()} more not visible with this key`);
    if (reader.access) parts.push(reader.access.isOwner ? 'owner key' : `access key${reader.access.expires ? `, until ${new Date(reader.access.expires).toLocaleString()}` : ''}`);
    else if (reader.encrypted) parts.push('encrypted');
    return parts.join(' · ');
  }

  // ---- showing a file ----------------------------------------------------------------------------

  async function render(reader) {
    show('jz-content');
    $('jz-export').hidden = false;
    document.title = `${reader.package?.title || state.name} - JAZMIN viewer`;
    const select = $('jz-table');
    select.replaceChildren(...reader.tables.map((t) => new Option(t || '(table)', t, false, t === reader.table)));
    $('jz-table-label').hidden = reader.tables.length < 2;
    const hasDocument = Boolean(reader.package?.entry);
    $('jz-tab-document').hidden = !hasDocument;
    state.filter = null;
    state.page = 0;
    $('jz-filter').value = '';
    await Promise.all([showRows(), showFiles()]);
    selectTab(state.shown && (state.shown !== 'document' || hasDocument) ? state.shown : hasDocument ? 'document' : 'data');
    if (hasDocument) await showDocument(reader);
  }

  function selectTab(name) {
    state.shown = name;
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      $(`jz-pane-${tab.dataset.tab}`).hidden = !selected;
    }
  }

  const cell = (value) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return `${value.length} bytes`;
    // json values, and lists and objects (nested columns), whose parts may be large integers or binary data
    if (typeof value === 'object') return JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? `${v.length} bytes` : v));
    return String(value);
  };

  /** A column's type, with a list's item or an object's fields: list<object{sku: string?, qty: int}>. */
  const typeName = (c) => {
    const part = (p) => `${typeName(p)}${p.nullable ? '?' : ''}`;
    if (c.type === 'list' && c.item) return `list<${part(c.item)}>`;
    if (c.type === 'object' && c.fields) return `object{${c.fields.map((f) => `${f.name}: ${part(f)}`).join(', ')}}`;
    return c.type;
  };

  // ---- searching: a page of rows at once, the total counted while they show -------------------------------------------

  const work = { page: null, count: null }; // the page being read and the count running (AbortControllers)
  const OVERLAY_AFTER_MS = 250; // a page found sooner shows without an overlay flashing up
  const elapsed = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
  const percent = (p) => (p ? Math.floor((p.done / p.total) * 100) : 0);

  /**
   * Shows a page of the rows matching the filter. The page is read first and shown as soon as it is found; the total
   * is counted after it, while the rows show, with its progress and Stop beside it. A page that takes a moment to find
   * (few matches, far apart) is searched under an overlay that says how far it is, with Stop.
   */
  async function showRows() {
    work.page?.abort();
    const page = (work.page = new AbortController());
    const reader = state.reader;
    const filter = state.filter;
    const key = JSON.stringify(filter);
    const offset = state.page * PAGE_ROWS;
    if (state.countReader !== reader || state.countKey !== key) {
      // Another filter or file: a count still running for the last one is of no use.
      work.count?.abort();
      work.count = null;
      Object.assign(state, { countReader: reader, countKey: key, total: null, counted: null, countStopped: false, countError: null, started: performance.now() });
      // The last filter's result no longer applies.
      $('jz-data-status').textContent = 'Searching…';
      $('jz-count-stop').hidden = true;
    }
    let progress = null;
    let painted = 0;
    const overlay = setTimeout(() => {
      $('jz-busy').hidden = false;
      state.busyShown = (state.busyShown || 0) + 1;
      paintBusy(reader, progress);
    }, OVERLAY_AFTER_MS);
    let rows;
    try {
      ({ rows } = await reader.query(filter, {
        offset, limit: PAGE_ROWS, total: false, signal: page.signal,
        onProgress: (p) => {
          progress = p;
          if (!$('jz-busy').hidden && performance.now() - painted > 50) {
            painted = performance.now();
            paintBusy(reader, p);
          }
        },
      }));
    } catch (error) {
      if (page.signal.aborted) return; // a newer search, or Stop
      throw error;
    } finally {
      clearTimeout(overlay);
      if (work.page === page) {
        work.page = null;
        $('jz-busy').hidden = true;
      }
    }
    showTable(reader, rows);
    state.shownRows = rows.length;
    // The total: every row without a filter; a page that isn't full ends the matches; otherwise it is counted.
    if (state.total === null) {
      if (!filter) state.total = reader.rowCount;
      else if (rows.length < PAGE_ROWS && (rows.length || !offset)) state.total = offset + rows.length;
      if (state.total !== null) state.elapsed = performance.now() - state.started;
      else if (!work.count && !state.countStopped) countMatches(reader, filter, key);
    }
    showStatus();
  }

  /** Counts the filter's matches while its first page shows: progress a few times a second, Stop beside it. */
  async function countMatches(reader, filter, key) {
    const counting = (work.count = new AbortController());
    const current = () => state.countReader === reader && state.countKey === key;
    let painted = 0;
    try {
      const total = await reader.count(filter, {
        signal: counting.signal,
        onProgress: (p) => {
          state.counted = p;
          if (performance.now() - painted > 100) {
            painted = performance.now();
            showStatus();
          }
        },
      });
      if (current()) Object.assign(state, { total, elapsed: performance.now() - state.started });
    } catch (error) {
      if (current()) Object.assign(state, { countStopped: true, countError: counting.signal.aborted ? null : error.message || String(error) });
    } finally {
      if (work.count === counting) work.count = null;
      if (current()) showStatus();
    }
  }

  /** The line above the rows: which rows show, of how many - or how far counting them is. */
  function showStatus() {
    const shown = state.shownRows || 0;
    const offset = state.page * PAGE_ROWS;
    const range = `Rows ${(shown ? offset + 1 : 0).toLocaleString()}–${(offset + shown).toLocaleString()}`;
    const atLeast = Math.max(state.counted?.matches ?? 0, offset + shown).toLocaleString();
    let text;
    if (state.total !== null) {
      text = `${range} of ${state.total.toLocaleString()}${state.filter ? ` matching the filter · ${elapsed(state.elapsed)}` : ''}`;
    } else if (state.countError) {
      text = `${range} · at least ${atLeast} matches (counting failed: ${state.countError})`;
    } else if (state.countStopped) {
      text = `${range} · at least ${atLeast} matches (counting stopped)`;
    } else {
      text = `${range} · ${atLeast} matches so far · counting ${percent(state.counted)}%`;
    }
    $('jz-data-status').textContent = text;
    $('jz-count-stop').hidden = !(work.count && state.total === null);
    $('jz-prev').disabled = state.page === 0;
    $('jz-next').disabled = state.total !== null ? offset + shown >= state.total : shown < PAGE_ROWS;
  }

  /** The overlay over the rows while a page is searched for: how many rows, how far, the matches so far, Stop. */
  function paintBusy(reader, p) {
    $('jz-busy-title').textContent = `Searching ${reader.rowCount.toLocaleString()} rows…`;
    const matches = p?.matches ?? 0;
    $('jz-busy-detail').textContent = p ? `${percent(p)}% · ${matches.toLocaleString()} ${matches === 1 ? 'match' : 'matches'} so far` : 'Starting…';
    $('jz-busy-bar').style.width = `${percent(p)}%`;
  }

  /** Stop on the overlay: the search ends, and the rows it was looking for aren't shown. */
  function stopSearch() {
    work.page?.abort();
    work.count?.abort();
    work.count = null;
    state.countKey = undefined; // applying the filter again searches again
    $('jz-busy').hidden = true;
    $('jz-rows').tBodies[0].replaceChildren();
    $('jz-data-status').textContent = 'Search stopped. Apply the filter to search again.';
    $('jz-prev').disabled = true;
    $('jz-next').disabled = true;
  }

  function showTable(reader, rows) {
    const head = document.createElement('tr');
    for (const c of reader.columns) {
      const th = document.createElement('th');
      th.textContent = c.name;
      th.title = [typeName(c), c.description].filter(Boolean).join(' - ');
      head.append(th);
    }
    $('jz-rows').tHead.replaceChildren(head);
    $('jz-rows').tBodies[0].replaceChildren(...rows.map((row) => {
      const tr = document.createElement('tr');
      for (const c of reader.columns) {
        const td = document.createElement('td');
        const text = cell(row[c.name]);
        if (text === null) {
          td.textContent = 'null';
          td.className = 'null';
        } else {
          td.textContent = text;
          td.title = text;
        }
        tr.append(td);
      }
      return tr;
    }));
  }

  async function applyFilter(event) {
    event.preventDefault();
    const text = $('jz-filter').value.trim();
    try {
      state.filter = text ? JSON.parse(text) : null;
      state.page = 0;
      await showRows();
    } catch (error) {
      $('jz-data-status').textContent = `Filter: ${error.message}`;
    }
  }

  async function showFiles() {
    const list = await state.reader.files();
    $('jz-tab-files').hidden = list.length === 0;
    $('jz-files-status').textContent = list.length ? `${list.length} file${list.length === 1 ? '' : 's'} visible with this key` : '';
    $('jz-files').replaceChildren(...list.map((f) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'path';
      name.textContent = f.path;
      const size = document.createElement('span');
      size.className = 'hint';
      size.textContent = `${f.type}, ${f.size.toLocaleString()} bytes`;
      li.append(name, size);
      if (f.actions?.save !== false) { // the file's writer may keep viewers from offering it as a download
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Download';
        button.addEventListener('click', () => save(f.path.split('/').pop(), state.reader.fileBlob(f.path)).catch((e) => status(e.message)));
        li.append(button);
      }
      return li;
    }));
  }

  async function save(filename, blobOrPromise) {
    const blob = await blobOrPromise;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ---- the document: the package's entry page, in a sandbox ----------------------------------------

  /**
   * The sandbox's security policy, from the signed package settings: allowed origins are its only network access, for
   * scripts, styles, images, fonts, audio and video, and requests.
   */
  function policy(settings) {
    const origins = (settings.allowedOrigins || []).join(' ');
    const extra = origins ? ` ${origins}` : '';
    return [
      "default-src 'none'",
      `script-src 'unsafe-inline' blob:${settings.allowWasm ? " 'wasm-unsafe-eval'" : ''}${extra}`,
      `style-src 'unsafe-inline' blob:${extra}`,
      `img-src blob: data:${extra}`,
      `font-src blob: data:${extra}`,
      `media-src blob: data:${extra}`,
      'object-src blob:', 'frame-src blob:', 'worker-src blob:',
      `connect-src blob: data:${extra}`,
    ].join('; ');
  }

  let frameReader = null; // the reader the document's queries go to

  async function showDocument(reader) {
    const settings = reader.package;
    const list = await reader.files();
    const files = [];
    for (const f of list) files.push({ path: f.path, blob: await reader.fileBlob(f.path), actions: f.actions });
    const rows = [];
    if (reader.rowCount <= ROWS_FOR_TEMPLATES) for await (const row of reader.find(null)) rows.push(row);
    frameReader = reader;
    const frame = $('jz-frame');
    const message = {
      type: 'jazmin:package', entry: settings.entry, files, policy: policy(settings), allowedOrigins: settings.allowedOrigins || [],
      metadata: reader.metadata, columns: reader.columns, access: reader.access, rowCount: reader.rowCount,
      rows: reader.rowCount <= ROWS_FOR_TEMPLATES ? rows : null,
      // Pages print with the browser's dialog, which also saves them as PDF. Changes are saved as change files.
      capabilities: ['print', 'pdf', 'edit'], renders: false, edit: settings.edit || null,
    };
    const csp = policy(settings).replace(/"/g, '&quot;');
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`
      + `<body><script>(${JazminSandbox.toString()})();<\/script></body></html>`;
    pendingPackage = message;
  }

  let pendingPackage = null;

  /** Messages from the sandbox: it starts, shows pages, and asks for data. */
  addEventListener('message', async (event) => {
    const frame = $('jz-frame');
    if (event.source !== frame.contentWindow || !event.data) return;
    const m = event.data;
    if (m.type === 'jazmin:bootstrap' && pendingPackage) {
      frame.contentWindow.postMessage(pendingPackage, '*');
      pendingPackage = null;
    } else if (m.type === 'jazmin:shown') {
      state.lastShown = { page: m.page, title: m.title, text: m.text, actions: m.actions };
      if (m.title) document.title = `${m.title} - JAZMIN viewer`;
    } else if (m.type === 'jazmin:ready') {
      state.lastReady = m;
    } else if (m.type === 'jazmin:error') {
      status(`Document: ${m.message}`);
    } else if (m.type === 'jazmin:saveChanges') {
      try {
        const result = await saveChanges(m.changes);
        frame.contentWindow.postMessage({ type: 'jazmin:result', id: m.id, result }, '*');
      } catch (error) {
        frame.contentWindow.postMessage({ type: 'jazmin:failed', id: m.id, message: error.message || String(error) }, '*');
      }
    } else if (m.type === 'jazmin:query' || m.type === 'jazmin:count') {
      try {
        const reply = m.type === 'jazmin:count' ? { count: await frameReader.count(m.filter) } : { rows: await queryPage(frameReader, m.filter, m.options) };
        frame.contentWindow.postMessage(Object.assign({ type: 'jazmin:result', id: m.id }, reply), '*');
      } catch (error) {
        frame.contentWindow.postMessage({ type: 'jazmin:failed', id: m.id, message: error.message || String(error) }, '*');
      }
    }
  });

  // ---- changes made in the document: checked, shown, then saved as a change file ------------------------------------

  const valueText = (v) => (v === null || v === undefined ? 'empty' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));

  /** What the person is asked: the changes, a line each (the first 50), and where they go. */
  function confirmChanges(changes, edit, shared) {
    const keyOf = (row) => edit.key.map((k) => valueText(row[k])).join(', ');
    const lines = [
      ...(changes.update || []).map((r) => `Change ${keyOf(r)}: ${Object.keys(r).filter((n) => !edit.key.includes(n)).map((n) => `${n} → ${valueText(r[n])}`).join(', ')}`),
      ...(changes.add || []).map((r) => `Add ${keyOf(r)}`),
      ...(changes.delete || []).map((r) => `Delete ${keyOf(r)}`),
    ];
    const count = (list) => (list || []).length;
    $('jz-changes-summary').textContent = [
      count(changes.update) && `${count(changes.update)} changed`, count(changes.add) && `${count(changes.add)} added`, count(changes.delete) && `${count(changes.delete)} deleted`,
    ].filter(Boolean).join(', ') + ` in ${state.name}.`;
    $('jz-changes-list').replaceChildren(...lines.slice(0, 50).map((text) => Object.assign(document.createElement('li'), { textContent: text })),
      ...(lines.length > 50 ? [Object.assign(document.createElement('li'), { textContent: `and ${lines.length - 50} more` })] : []));
    $('jz-changes-where').textContent = shared
      ? "They're saved as a change file for the file's owner: send it to them. Only the owner can open it, and they apply it to the shared file."
      : "A browser can't change the file itself: they're saved as a change file, which the JAZMIN library (applyChanges) writes into it.";
    const dialog = $('jz-changes');
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'save'), { once: true });
      dialog.returnValue = '';
      dialog.showModal();
    });
  }

  /** The document's changes: checked and made into a change file (the reader's writeChanges), shown, then saved. */
  async function saveChanges(changes) {
    const reader = frameReader;
    const shared = Boolean(reader.access);
    const blob = await JazminBrowser.writeChanges(reader, changes, shared ? {} : state.options); // checks them first
    if (!(await confirmChanges(changes, reader.package.edit, shared))) throw new Error('The changes were not saved');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const name = `${state.name.replace(/\.jzm$/i, '')}-changes-${stamp}.jzm`;
    state.lastSaved = { name, blob };
    await save(name, blob);
    const count = (list) => (list || []).length;
    return { saved: 'change-file', file: name, updated: count(changes.update), added: count(changes.add), deleted: count(changes.delete) };
  }

  /** Exact decimal strings ("-12.50", "3", "0.001") by value: -1, 0 or 1. */
  function compareDecimals(a, b) {
    const parse = (text) => {
      const negative = text.startsWith('-');
      const [whole, fraction = ''] = (negative || text.startsWith('+') ? text.slice(1) : text).split('.');
      return { negative, whole: whole.replace(/^0+/, ''), fraction: fraction.replace(/0+$/, '') };
    };
    const x = parse(a);
    const y = parse(b);
    const zero = (v) => v.whole === '' && v.fraction === '';
    const xn = x.negative && !zero(x);
    const yn = y.negative && !zero(y);
    if (xn !== yn) return xn ? -1 : 1;
    let c = x.whole.length - y.whole.length || (x.whole < y.whole ? -1 : x.whole > y.whole ? 1 : 0);
    if (c === 0) {
      const w = Math.max(x.fraction.length, y.fraction.length);
      const xf = x.fraction.padEnd(w, '0');
      const yf = y.fraction.padEnd(w, '0');
      c = xf < yf ? -1 : xf > yf ? 1 : 0;
    }
    return c === 0 ? 0 : xn ? -Math.sign(c) : Math.sign(c);
  }

  /** A page of rows for a template: { select, orderBy ('col' or '-col'), offset, limit }. */
  async function queryPage(reader, filter, options) {
    const { select, orderBy, offset = 0, limit = 100 } = options || {};
    if (!orderBy) return (await reader.query(filter, { select, offset, limit, total: false })).rows;
    const desc = orderBy.startsWith('-');
    const name = desc ? orderBy.slice(1) : orderBy;
    const column = reader.columns.find((c) => c.name === name);
    if (!column) throw new Error(`orderBy: unknown column '${name}'`);
    const all = [];
    for await (const row of reader.find(filter)) all.push(row);
    const key = (v) => (v instanceof Date ? v.getTime() : v);
    // Decimals are exact strings: compared by value, not as text ("100.00" after "99.00"), as the library does.
    const less = column.type === 'decimal' ? (x, y) => compareDecimals(x, y) < 0 : (x, y) => x < y;
    all.sort((a, b) => {
      const x = key(a[name]);
      const y = key(b[name]);
      const c = x === y ? 0 : x === null || x === undefined ? -1 : y === null || y === undefined ? 1 : less(x, y) ? -1 : less(y, x) ? 1 : 0;
      return desc ? -c : c;
    });
    return all.slice(offset, offset + limit).map((row) => (select ? Object.fromEntries(select.map((s) => [s, row[s]])) : row));
  }

  async function switchTable() {
    const name = $('jz-table').value;
    let reader = state.readers.get(name);
    if (!reader) {
      reader = await state.reader.openTable(name);
      state.readers.set(name, reader);
    }
    state.reader = reader;
    state.filter = null;
    state.page = 0;
    $('jz-filter').value = '';
    await showRows();
    status(describe(reader));
  }

  // ---- saving as one HTML file ---------------------------------------------------------------------

  /** The viewer's own sources: inline when this page is itself an export, fetched otherwise. */
  async function source(el) {
    if (!el.src && !el.href) return el.textContent;
    const response = await fetch(el.src || el.href);
    if (!response.ok) throw new Error(`Could not read ${el.src || el.href}`);
    return response.text();
  }

  function toBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  /** One HTML file holding the viewer and this .jzm: it opens by double-click, offline, and still asks for the key. */
  async function exportHtml() {
    const doc = document.documentElement.cloneNode(true);
    for (const el of doc.querySelectorAll('[data-jz-inline]')) {
      const kind = el.getAttribute('data-jz-inline');
      const live = document.querySelector(`[data-jz-inline="${kind}"]`);
      const text = await source(live);
      const replacement = document.createElement(kind === 'css' ? 'style' : 'script');
      replacement.setAttribute('data-jz-inline', kind);
      replacement.textContent = kind === 'css' ? text : text.replace(/<\/script/gi, '<\\/script');
      el.replaceWith(replacement);
    }
    for (const el of doc.querySelectorAll('link[rel="manifest"], link[rel="icon"], #jz-embedded')) el.remove();
    const content = doc.querySelector('#jz-content');
    content.hidden = true; // the copy starts at its own unlock form
    doc.querySelector('#jz-start').hidden = false;
    doc.querySelector('#jz-unlock').hidden = true;
    doc.querySelector('#jz-export').hidden = true;
    doc.querySelector('#jz-frame').removeAttribute('srcdoc');
    for (const id of ['jz-name', 'jz-status', 'jz-error', 'jz-data-status', 'jz-files-status']) doc.querySelector(`#${id}`).textContent = '';
    doc.querySelector('#jz-rows thead').replaceChildren();
    doc.querySelector('#jz-rows tbody').replaceChildren();
    doc.querySelector('#jz-files').replaceChildren();
    const embedded = document.createElement('script');
    embedded.id = 'jz-embedded';
    embedded.type = 'application/octet-stream';
    embedded.dataset.name = state.name;
    embedded.textContent = toBase64(new Uint8Array(await state.blob.arrayBuffer()));
    doc.querySelector('body').prepend(embedded);
    return '<!doctype html>\n' + doc.outerHTML;
  }

  // ---- wiring --------------------------------------------------------------------------------------

  $('jz-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) choose(file, file.name);
    e.target.value = '';
  });
  const drop = $('jz-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) choose(file, file.name);
  });
  $('jz-unlock').addEventListener('submit', unlock);
  $('jz-filter-form').addEventListener('submit', applyFilter);
  $('jz-busy-stop').addEventListener('click', stopSearch);
  $('jz-count-stop').addEventListener('click', () => work.count?.abort());
  $('jz-prev').addEventListener('click', () => { state.page--; showRows(); });
  $('jz-next').addEventListener('click', () => { state.page++; showRows(); });
  $('jz-table').addEventListener('change', () => switchTable().catch((e) => status(e.message)));
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  $('jz-export').addEventListener('click', async () => {
    try {
      const html = await exportHtml();
      await save(state.name.replace(/\.jzm$/i, '') + '.html', new Blob([html], { type: 'text/html' }));
    } catch (error) {
      status(`Save as HTML: ${error.message}`);
    }
  });

  // Installed app: Chrome and Edge open .jzm files with it (manifest file_handlers).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const [handle] = params.files || [];
      if (handle) choose(await handle.getFile(), handle.name);
    });
  }
  // Offline use once installed (not for a page opened from disk).
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // The page that shows the viewer in an iframe can pass it a file it has (picked, dropped or made):
  // postMessage({ type: 'jazmin:open', file, name }). Only that page: not a document's sandbox below the viewer, and
  // nothing when the viewer isn't in a frame. It hears { type: 'jazmin:status', state, name, message } and no more:
  // the key is typed here and the data stays here. A File stays on disk: the viewer reads the slices it needs.
  // It can also show the rows matching a filter: { type: 'jazmin:filter', filter } (an object or JSON text), as typing
  // it in the Filter box and applying it does.
  addEventListener('message', (event) => {
    const m = event.data;
    if (window.parent === window || event.source !== window.parent || !m) return;
    if (m.type === 'jazmin:filter' && state.reader) {
      $('jz-filter').value = m.filter == null ? '' : typeof m.filter === 'string' ? m.filter : JSON.stringify(m.filter);
      selectTab('data');
      $('jz-filter-form').requestSubmit();
      return;
    }
    if (m.type !== 'jazmin:open' || !(m.file instanceof Blob)) return;
    // A page opened from disk has the origin "null" (Chrome: "file://"), which postMessage can't address.
    const answerTo = /^(null|file:)/.test(event.origin) ? '*' : event.origin;
    choose(m.file, typeof m.name === 'string' && m.name ? m.name : m.file.name, answerTo);
  });

  // A saved HTML copy carries its .jzm.
  const embedded = document.getElementById('jz-embedded');
  if (embedded) choose(new Blob([JazminBrowser.base64ToBytes(embedded.textContent)]), embedded.dataset.name);

  /** For tests and integrations: open a file, read what is shown, save as HTML. */
  window.JazminViewer = { choose, open, exportHtml, state, selectTab };
})();
