// The code that runs inside the viewer's sandboxed frame (an opaque origin: no access to the viewer, the key or browser
// storage). The viewer passes this function's text into the frame. It receives the package's files from the viewer,
// turns each into an in-memory URL created here (URLs made by the viewer do not load inside the sandbox), rewrites the
// template's relative references to them, renders the entry page and provides window.jazmin (API version 1).
globalThis.JazminSandbox = function () {
  'use strict';

  const files = new Map();
  const urls = new Map();
  const calls = new Map();
  let pkg;
  let next = 0;

  const report = (type, detail) => parent.postMessage(Object.assign({ type }, detail), '*');
  const isHtml = (path) => /\.html?$/i.test(path);
  const isCss = (path) => /\.css$/i.test(path);

  /** Resolves a reference relative to the page or stylesheet it appears in; null for external URLs. */
  function resolve(fromPath, ref) {
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref.trim())) return null;
    const url = new URL(ref.trim(), 'https://package.invalid/' + fromPath);
    return decodeURIComponent(url.pathname.slice(1));
  }

  function rewriteCss(css, fromPath) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, ref) => {
      const target = resolve(fromPath, ref);
      return target && urls.has(target) ? `url("${urls.get(target)}")` : match;
    });
  }

  async function prepare() {
    for (const f of pkg.files) files.set(f.path, f);
    for (const [path, f] of files) {
      if (!isHtml(path) && !isCss(path)) urls.set(path, URL.createObjectURL(f.blob));
    }
    for (const [path, f] of files) {
      if (isCss(path)) urls.set(path, URL.createObjectURL(new Blob([rewriteCss(await f.blob.text(), path)], { type: 'text/css' })));
    }
  }

  async function show(path) {
    const page = files.get(path);
    if (!page) throw new Error(`The package has no page '${path}'`);
    const doc = new DOMParser().parseFromString(await page.blob.text(), 'text/html');
    for (const el of doc.querySelectorAll('[src], [href], [poster], object[data]')) {
      for (const attr of ['src', 'href', 'poster', 'data']) {
        const target = resolve(path, el.getAttribute(attr));
        if (!target) continue;
        if (isHtml(target) && files.has(target)) {
          el.setAttribute(attr, '#');
          el.setAttribute('data-jazmin-page', target);
        } else if (urls.has(target)) {
          el.setAttribute(attr, urls.get(target));
        }
      }
    }
    for (const el of doc.querySelectorAll('style')) el.textContent = rewriteCss(el.textContent, path);
    for (const el of doc.querySelectorAll('[style]')) el.setAttribute('style', rewriteCss(el.getAttribute('style'), path));
    // The security policy travels with every page the template shows.
    const policy = doc.createElement('meta');
    policy.setAttribute('http-equiv', 'Content-Security-Policy');
    policy.setAttribute('content', pkg.policy);
    doc.head.prepend(policy);

    jazmin.page = path;
    document.open();
    document.write('<!doctype html>' + doc.documentElement.outerHTML);
    document.close();
    // document.open() clears the listeners of the document and the window: answers from the viewer and page links are
    // wired up again after writing.
    addEventListener('message', onMessage);
    document.addEventListener('click', (e) => {
      const link = e.target.closest && e.target.closest('[data-jazmin-page]');
      if (!link) return;
      e.preventDefault();
      show(link.getAttribute('data-jazmin-page')).catch(fail);
    });
    report('jazmin:shown', { page: path, title: doc.title || '', text: (document.body ? document.body.innerText : '').slice(0, 2000) });
  }

  const fail = (error) => report('jazmin:error', { message: String((error && error.message) || error) });

  /** Asks the viewer, which holds the reader and the key, to run a query; only the answer crosses into the sandbox. */
  function call(type, payload) {
    return new Promise((resolveCall, reject) => {
      const id = ++next;
      calls.set(id, { resolve: resolveCall, reject });
      parent.postMessage(Object.assign({ type, id }, payload), '*');
    });
  }

  /** The API templates use (version 1). It never exposes the key: data arrives already decrypted, a page at a time. */
  const jazmin = {
    version: 1,
    page: null,
    get metadata() { return pkg.metadata; },
    get columns() { return pkg.columns; },
    get access() { return pkg.access; },
    get rowCount() { return pkg.rowCount; },
    /** A page of rows: options { select, orderBy (a column, '-column' for descending), offset, limit (default 100) }. */
    query(filter, options) { return call('jazmin:query', { filter: filter || null, options: options || {} }).then((r) => r.rows); },
    /** How many rows match. */
    count(filter) { return call('jazmin:count', { filter: filter || null }).then((r) => r.count); },
    /** Every row, for small data sets only (see query for large ones). Optional filter function. */
    rows(filter) {
      if (!pkg.rows) throw new Error(`This data set has ${pkg.rowCount} rows: use jazmin.query() to read it a page at a time`);
      return filter ? pkg.rows.filter(filter) : pkg.rows.slice();
    },
    /** In-memory URL of a packaged file, e.g. for images added from script. */
    asset(path) { return urls.get(path) || null; },
    /** The packaged file itself (a Blob). */
    file(path) { const f = files.get(path); return Promise.resolve(f ? f.blob : null); },
    paths() { return [...files.keys()]; },
    /** Saves content as a file: a string, Blob or bytes. */
    download(filename, content, type) {
      const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    },
    print() { window.print(); },
    navigate(path) { return show(path); },
    /** True when the package allows network access to some origins. */
    get online() { return pkg.allowedOrigins.length > 0 && navigator.onLine; },
    /** Templates call this when rendered (shown in the viewer's status line, and used by tests). */
    ready(info) { report('jazmin:ready', { page: jazmin.page, info: info || {} }); },
  };
  window.jazmin = jazmin;

  function onMessage(e) {
    if (e.source !== parent || !e.data) return;
    const m = e.data;
    if (m.type === 'jazmin:package' && !pkg) {
      pkg = m;
      prepare().then(() => show(pkg.entry)).catch(fail);
    } else if ((m.type === 'jazmin:result' || m.type === 'jazmin:failed') && calls.has(m.id)) {
      const pending = calls.get(m.id);
      calls.delete(m.id);
      if (m.type === 'jazmin:result') pending.resolve(m);
      else pending.reject(new Error(m.message));
    }
  }
  addEventListener('message', onMessage);
  report('jazmin:bootstrap', {});
};
