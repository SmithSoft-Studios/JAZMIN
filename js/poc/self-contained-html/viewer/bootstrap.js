// Runs inside the sandboxed iframe (opaque origin: no access to the viewer, the key or storage).
// Receives the decrypted package from the viewer, turns every file into an in-memory URL created
// here (URLs made by the viewer do not load inside the sandbox), rewrites the template's relative
// references to those URLs, then renders the entry page. Templates use window.jazmin for data,
// assets, printing and downloads.
(function () {
  'use strict';

  const files = new Map();
  const urls = new Map();
  let pkg;

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

    jazmin.page = path;
    document.open();
    document.write('<!doctype html>' + doc.documentElement.outerHTML);
    document.close();
    // document.open() clears listeners, so page links are wired up after writing.
    document.addEventListener('click', (e) => {
      const link = e.target.closest && e.target.closest('[data-jazmin-page]');
      if (!link) return;
      e.preventDefault();
      show(link.getAttribute('data-jazmin-page')).catch(fail);
    });
    if (doc.title) report('jazmin:title', { title: doc.title });
  }

  const fail = (error) => report('jazmin:error', { message: String((error && error.message) || error) });

  /** The API templates use. It never exposes the key: the data arrives already decrypted. */
  const jazmin = {
    page: null,
    get metadata() { return pkg.data.metadata; },
    get columns() { return pkg.data.columns; },
    /** The data rows this package (and key) can see. Optional filter function. */
    rows(filter) { return filter ? pkg.data.rows.filter(filter) : pkg.data.rows.slice(); },
    /** In-memory URL of a packaged file, e.g. for images added from script. */
    asset(path) { return urls.get(path) || null; },
    /** The packaged file itself (a Blob), e.g. to read JSON or offer it for download. */
    file(path) { const f = files.get(path); return f ? f.blob : null; },
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
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    },
    print() { window.print(); },
    navigate(path) { return show(path); },
    /** Templates call this when rendered (used by the viewer's status line and by tests). */
    ready(info) { report('jazmin:ready', { page: jazmin.page, info: info || {} }); },
  };
  window.jazmin = jazmin;

  addEventListener('message', function onPackage(e) {
    if (e.source !== parent || !e.data || e.data.type !== 'jazmin:package') return;
    removeEventListener('message', onPackage);
    pkg = e.data;
    prepare().then(() => show(pkg.entry)).catch(fail);
  });
  report('jazmin:bootstrap', {});
})();
