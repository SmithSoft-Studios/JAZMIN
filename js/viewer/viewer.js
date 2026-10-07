// The JAZMIN viewer (TASKS F-2): an installable web app, a hosted page, or a self-contained HTML file. Opens a .jzm
// on this device - nothing is uploaded - and shows its document (the package's entry page, in a sandbox), its data
// and its files. The file is read in slices with the browser reader (js/browser/jazmin-browser.js).
(function () {
  'use strict';

  const { JazminBrowser, JazminSandbox } = globalThis;
  const $ = (id) => document.getElementById(id);
  const PAGE_ROWS = 50;
  const ROWS_FOR_TEMPLATES = 20000; // jazmin.rows() is offered up to this many rows; beyond it, templates use query()

  const state = { blob: null, name: '', options: null, reader: null, readers: new Map(), filter: null, page: 0, total: 0, shown: null };

  const status = (message) => { $('jz-status').textContent = message || ''; };

  function show(id) {
    for (const panel of ['jz-start', 'jz-unlock', 'jz-content']) $(panel).hidden = panel !== id;
  }

  // ---- choosing and unlocking a file -------------------------------------------------------------

  /** Takes a file (picker, drop, file handler or an embedded copy) and opens it, asking for a key when it needs one. */
  async function choose(blob, name) {
    state.blob = blob;
    state.name = name || 'file.jzm';
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
      show('jz-unlock');
      $('jz-key').focus();
    }
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
    return reader;
  }

  function fail(error) {
    show(state.reader ? 'jz-content' : 'jz-start');
    status(`Could not open ${state.name}: ${error.message || error}`);
  }

  async function unlock(event) {
    event.preventDefault();
    const secret = $('jz-key').value.trim();
    const token = $('jz-token').value.trim();
    const options = /^jz[ka]1-/.test(secret) ? { key: secret } : { password: secret };
    if (token) options.unlockToken = token;
    $('jz-error').textContent = '';
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
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  async function showRows() {
    const reader = state.reader;
    const { rows, total } = await reader.query(state.filter, { offset: state.page * PAGE_ROWS, limit: PAGE_ROWS });
    state.total = total;
    const head = document.createElement('tr');
    for (const c of reader.columns) {
      const th = document.createElement('th');
      th.textContent = c.name;
      th.title = [c.type, c.description].filter(Boolean).join(' - ');
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
    const first = total === 0 ? 0 : state.page * PAGE_ROWS + 1;
    $('jz-data-status').textContent = `Rows ${first.toLocaleString()}–${(state.page * PAGE_ROWS + rows.length).toLocaleString()} of ${total.toLocaleString()}`
      + (state.filter ? ' matching the filter' : '');
    $('jz-prev').disabled = state.page === 0;
    $('jz-next').disabled = (state.page + 1) * PAGE_ROWS >= total;
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
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Download';
      button.addEventListener('click', () => save(f.path.split('/').pop(), state.reader.fileBlob(f.path)).catch((e) => status(e.message)));
      li.append(name, size, button);
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
    for (const f of list) files.push({ path: f.path, blob: await reader.fileBlob(f.path) });
    const rows = [];
    if (reader.rowCount <= ROWS_FOR_TEMPLATES) for await (const row of reader.find(null)) rows.push(row);
    frameReader = reader;
    const frame = $('jz-frame');
    const message = {
      type: 'jazmin:package', entry: settings.entry, files, policy: policy(settings), allowedOrigins: settings.allowedOrigins || [],
      metadata: reader.metadata, columns: reader.columns, access: reader.access, rowCount: reader.rowCount,
      rows: reader.rowCount <= ROWS_FOR_TEMPLATES ? rows : null,
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
      state.lastShown = { page: m.page, title: m.title, text: m.text };
      if (m.title) document.title = `${m.title} - JAZMIN viewer`;
    } else if (m.type === 'jazmin:ready') {
      state.lastReady = m;
    } else if (m.type === 'jazmin:error') {
      status(`Document: ${m.message}`);
    } else if (m.type === 'jazmin:query' || m.type === 'jazmin:count') {
      try {
        const reply = m.type === 'jazmin:count' ? { count: await frameReader.count(m.filter) } : { rows: await queryPage(frameReader, m.filter, m.options) };
        frame.contentWindow.postMessage(Object.assign({ type: 'jazmin:result', id: m.id }, reply), '*');
      } catch (error) {
        frame.contentWindow.postMessage({ type: 'jazmin:failed', id: m.id, message: error.message || String(error) }, '*');
      }
    }
  });

  /** A page of rows for a template: { select, orderBy ('col' or '-col'), offset, limit }. */
  async function queryPage(reader, filter, options) {
    const { select, orderBy, offset = 0, limit = 100 } = options || {};
    if (!orderBy) return (await reader.query(filter, { select, offset, limit, total: false })).rows;
    const desc = orderBy.startsWith('-');
    const name = desc ? orderBy.slice(1) : orderBy;
    if (!reader.columns.some((c) => c.name === name)) throw new Error(`orderBy: unknown column '${name}'`);
    const all = [];
    for await (const row of reader.find(filter)) all.push(row);
    const key = (v) => (v instanceof Date ? v.getTime() : v);
    all.sort((a, b) => {
      const x = key(a[name]);
      const y = key(b[name]);
      const c = x === y ? 0 : x === null || x === undefined ? -1 : y === null || y === undefined ? 1 : x < y ? -1 : 1;
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
  // A saved HTML copy carries its .jzm.
  const embedded = document.getElementById('jz-embedded');
  if (embedded) choose(new Blob([JazminBrowser.base64ToBytes(embedded.textContent)]), embedded.dataset.name);

  /** For tests and integrations: open a file, read what is shown, save as HTML. */
  window.JazminViewer = { choose, open, exportHtml, state, selectTab };
})();
