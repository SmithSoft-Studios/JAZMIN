// Server-side helpers (TASKS F-3): a file's embedded files served by path (for request interception or a web server),
// and its document rendered to PDF in a browser you supply (Puppeteer or Playwright), with the same window.jazmin API
// the viewer gives it, so one template serves both. No dependencies.
import { Readable } from 'node:stream';
import { JazminValidationError } from './errors.js';
import { FILE_BLOCK_SIZE, normalizePdf } from './files.js';
import { JazminReader } from './reader.js';

/** The origin a document has when rendered here: requests to it are answered from the file (.invalid never resolves). */
const ORIGIN = 'https://jazmin.invalid';
const TEMPLATE_ROWS = 20000; // jazmin.rows() holds up to this many rows, as in the viewer
const SORT_KEEP = 100000; // a sorted page keeps offset + limit rows in memory
const ORDERED = new Set(['bool', 'int', 'float', 'decimal', 'string', 'datetime']);

/** Types a browser can run script in: served with a policy that also sandboxes them, away from the server's origin. */
const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/i;

/**
 * The security policy of a package's document, as the viewer sets it (js/viewer/viewer.js, policy()): the package's
 * allowed origins are its only network access, for scripts, styles, images, fonts, audio and video, and requests.
 * `self` names where the package's own files are served from (an origin, or "'self'").
 */
export function documentPolicy(settings = {}, { self = null } = {}) {
  const origins = [...(self ? [self] : []), ...(settings.allowedOrigins || [])].join(' ');
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

/** A single byte range of a file of `size` bytes: { start, end } (end exclusive), 'unsatisfiable', or null to ignore. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // not one range we understand: the whole file, as HTTP allows
  if (m[1] === '') {
    const suffix = Number(m[2]);
    return suffix === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size };
  }
  const start = Number(m[1]);
  const last = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || last < start) return 'unsatisfiable';
  return { start, end: last + 1 };
}

/**
 * Answers requests for a reader's embedded files by path: handle(path, { method, range, ifNoneMatch }) returns
 * { status, headers, body, stream() }. `body` (a Buffer) is read when asked for, and `stream()` reads block by block,
 * so a server can stream a large file and a request interceptor can take the bytes. Only files the reader's key can
 * see are served (404 otherwise); one byte range per request (206), ETags from the files' SHA-256 (304).
 * Pages and other types a browser can run script in get the document's security policy and, with `sandbox` (the
 * default), a sandbox too, so a file's page served from your site cannot act as your site. `origin`: where the files
 * are served from, for that policy (default "'self'").
 */
export function createFileHandler(reader, { origin = "'self'", sandbox = true } = {}) {
  if (!(reader instanceof JazminReader)) throw new JazminValidationError('createFileHandler needs a JazminReader');
  const files = new Map(reader.files.map((f) => [f.path, f]));
  const policy = documentPolicy(reader.package ?? {}, { self: origin }) + (sandbox ? '; sandbox allow-scripts allow-downloads allow-popups' : '');
  const empty = Buffer.alloc(0);
  const reply = (status, headers, read = () => empty, stream = null) => ({
    status,
    headers,
    get body() {
      return read();
    },
    stream: stream ?? (() => Readable.from([read()])),
  });
  return function handle(requestPath, { method = 'GET', range, ifNoneMatch } = {}) {
    let path;
    try {
      path = decodeURIComponent(String(requestPath).split(/[?#]/)[0]).replace(/^\/+/, '');
    } catch {
      return reply(400, { 'content-type': 'text/plain; charset=utf-8' }, () => Buffer.from('Bad path'));
    }
    const file = files.get(path);
    if (!file) return reply(404, { 'content-type': 'text/plain; charset=utf-8' }, () => Buffer.from('Not found'));
    if (method !== 'GET' && method !== 'HEAD') return reply(405, { allow: 'GET, HEAD' });
    const etag = `"${file.sha256}"`;
    const headers = {
      'content-type': file.type || 'application/octet-stream',
      'accept-ranges': 'bytes',
      etag,
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
    };
    if (ACTIVE.test(headers['content-type'])) headers['content-security-policy'] = policy;
    if (ifNoneMatch && String(ifNoneMatch).split(',').some((t) => t.trim() === etag || t.trim() === '*')) return reply(304, headers);
    const wanted = range ? parseRange(range, file.size) : null;
    if (wanted === 'unsatisfiable') return reply(416, { ...headers, 'content-range': `bytes */${file.size}` });
    const { start, end } = wanted ?? { start: 0, end: file.size };
    headers['content-length'] = String(end - start);
    if (wanted) headers['content-range'] = `bytes ${start}-${end - 1}/${file.size}`;
    const whole = !wanted;
    if (method === 'HEAD') return reply(wanted ? 206 : 200, headers);
    return reply(
      wanted ? 206 : 200,
      headers,
      () => (whole ? reader.readFile(path) : reader.readFileRange(path, start, end)),
      () => (whole ? reader.openFile(path) : Readable.from(rangeBlocks(reader, path, start, end))),
    );
  };
}

/** Bytes [start, end) of an embedded file, a stored block (256 KiB) at a time, each block decoded once. */
function* rangeBlocks(reader, path, start, end) {
  for (let at = start; at < end;) {
    const next = Math.min(end, (Math.floor(at / FILE_BLOCK_SIZE) + 1) * FILE_BLOCK_SIZE);
    yield reader.readFileRange(path, at, next);
    at = next;
  }
}

/**
 * A Node request handler serving a reader's embedded files under `prefix`, for http.createServer or Express:
 * (req, res, next?) => void. Streams each file block by block; requests outside the prefix, or for files the key
 * cannot see, go to `next` when given (404 otherwise).
 */
export function serveFiles(reader, { prefix = '/', origin } = {}) {
  const handle = createFileHandler(reader, { origin });
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return function jazminFiles(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const inside = url.pathname.startsWith(base);
    const answer = inside ? handle(url.pathname.slice(base.length), { method: req.method, range: req.headers.range, ifNoneMatch: req.headers['if-none-match'] }) : null;
    if ((!answer || answer.status === 404) && typeof next === 'function') return next();
    if (!answer) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(answer.status, answer.headers);
    if (req.method === 'HEAD' || answer.status === 304 || answer.status === 416) return res.end();
    const stream = answer.stream();
    stream.on('error', (error) => res.destroy(error));
    return stream.pipe(res);
  };
}

// ---- rendering a document to PDF ----------------------------------------------------------------------------------

/** Values crossing into the page by column type (as JSON): dates as ISO text, big integers and odd floats as text. */
function encodeValue(type, v) {
  if (v === null || v === undefined) return null;
  if (type === 'datetime') return v instanceof Date ? v.toISOString() : v;
  if (type === 'int') return typeof v === 'bigint' ? v.toString() : v;
  if (type === 'float') return Number.isFinite(v) ? v : String(v);
  if (type === 'binary') return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
  return v;
}

/** Exact decimal strings by value. */
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

/** Ascending order of a column's values, nulls first: decimals by value, dates by time, strings by code unit. */
function compareValues(type, a, b) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : an ? -1 : 1;
  if (type === 'decimal') return compareDecimals(a, b);
  if (type === 'datetime') return Math.sign(a.getTime() - b.getTime());
  if (type === 'float' && (Number.isNaN(a) || Number.isNaN(b))) return Number.isNaN(a) === Number.isNaN(b) ? 0 : Number.isNaN(a) ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** jazmin.query(filter, { select, orderBy ('col' or '-col'), offset, limit }): a page, sorted keeping offset + limit rows. */
function templateQuery(reader, filter, { select, orderBy, offset = 0, limit = 100 } = {}) {
  const types = new Map(reader.columns.map((c) => [c.name, c.type]));
  const pick = (row) => (select ? Object.fromEntries(select.map((s) => [s, row[s]])) : row);
  if (!orderBy) return [...reader.find(filter, { select, offset, limit })].map(pick);
  const descending = orderBy.startsWith('-');
  const name = descending ? orderBy.slice(1) : orderBy;
  const type = types.get(name);
  if (!type) throw new JazminValidationError(`orderBy: unknown column '${name}'`);
  if (!ORDERED.has(type)) throw new JazminValidationError(`orderBy: column '${name}' (${type}) has no order`);
  if (offset + limit > SORT_KEEP) throw new JazminValidationError(`orderBy: a sorted query reads the first ${SORT_KEEP} rows; narrow it with a filter`);
  const order = (x, y) => (descending ? -1 : 1) * compareValues(type, x.row[name], y.row[name]) || x.seq - y.seq;
  const keep = [];
  let seq = 0;
  for (const row of reader.find(filter)) {
    keep.push({ row, seq: seq++ });
    if (keep.length >= 2 * (offset + limit) + 1024) keep.sort(order).length = offset + limit; // bounded memory
  }
  return keep.sort(order).slice(offset, offset + limit).map(({ row }) => pick(row));
}

/** window.jazmin in the page, before its scripts run: the viewer's API (version 1), answered by renderPdf. */
function installApi(boot) {
  const types = new Map(boot.columns.map((c) => [c.name, c.type]));
  const decode = (row) => {
    const out = {};
    for (const [name, v] of Object.entries(row)) {
      const type = types.get(name);
      out[name] = v === null ? null
        : type === 'datetime' ? new Date(v)
          : type === 'int' && typeof v === 'string' ? BigInt(v)
            : type === 'float' && typeof v === 'string' ? Number(v)
              : type === 'binary' ? Uint8Array.from(atob(v), (c) => c.charCodeAt(0)) : v;
    }
    return out;
  };
  const call = (type, payload) => window.__jazminCall(JSON.stringify({ type, payload })).then((text) => {
    const answer = JSON.parse(text);
    if (answer.error) throw new Error(answer.error);
    return answer.result;
  });
  let rows = null;
  window.jazmin = {
    version: 1,
    page: decodeURIComponent(location.pathname.slice(1)),
    get metadata() { return boot.metadata; },
    get columns() { return boot.columns; },
    get access() { return boot.access; },
    get rowCount() { return boot.rowCount; },
    get mode() { return boot.mode; },
    get filter() { return boot.filter ? JSON.parse(JSON.stringify(boot.filter)) : null; },
    query(filter, options) { return call('query', { filter: filter || null, options: options || {} }).then((list) => list.map(decode)); },
    count(filter) { return call('count', { filter: filter || null }); },
    rows(filter) {
      if (!boot.rows) throw new Error(`This data set has ${boot.rowCount} rows: use jazmin.query() to read it a page at a time`);
      rows ??= boot.rows.map(decode);
      return filter ? rows.filter(filter) : rows.slice();
    },
    asset(path) { return boot.paths.includes(path) ? new URL(path, `${boot.origin}/`).href : null; },
    file(path) {
      if (!boot.paths.includes(path)) return Promise.resolve(null);
      return call('file', { path }).then((f) => new Blob([Uint8Array.from(atob(f.bytes), (c) => c.charCodeAt(0))], { type: f.type }));
    },
    paths() { return boot.paths.slice(); },
    download(filename, content, type) {
      const send = (bytes) => call('download', { filename: String(filename), type: type || '', bytes: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')) });
      if (content instanceof Blob) content.arrayBuffer().then((b) => send(new Uint8Array(b)));
      else if (typeof content === 'string') send(new TextEncoder().encode(content));
      else send(new Uint8Array(content.buffer || content, content.byteOffset || 0, content.byteLength));
    },
    print() {},
    // Rendering is the printing: nothing more to offer. A page's own page settings (setActions pdf) are used for its PDF.
    get actions() { return { print: false, pdf: false, image: false }; },
    setActions(changes) {
      if (changes === null || typeof changes !== 'object') throw new Error('setActions takes { print, pdf, image }');
      for (const [name, value] of Object.entries(changes)) {
        if (!['print', 'pdf', 'image'].includes(name)) throw new Error(`setActions: unknown action '${name}' (print, pdf, image)`);
        if (typeof value !== 'boolean' && (value === null || typeof value !== 'object')) throw new Error(`setActions: ${name} is true, false or settings`);
        if (name === 'pdf') window[Symbol.for('jazmin.pagePdf')] = typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null;
      }
    },
    savePdf() { throw new Error('This page cannot be saved as PDF here'); },
    get edit() { return null; }, // a rendered document saves no changes
    saveChanges() { return Promise.reject(new Error("This document can't save changes here")); },
    navigate(path) { location.href = new URL(path, `${boot.origin}/`).href; },
    get online() { return boot.allowedOrigins.length > 0; },
    ready(info) { window.__jazminReady(JSON.stringify(info || {})); },
  };
}

/** A filter, and the filter it is limited to (renderPdf's `filter`): both must match. */
const within = (scope, filter) => (scope ? (filter ? { and: [scope, filter] } : scope) : filter ?? null);

/**
 * Opens a file's document in a browser you supply and hands the loaded page to `capture(tab, pdf)`, which makes the
 * output (a PDF, an image); pdf is the page settings for the page shown (defaults, package, file, page's own, in that
 * order). The page gets the viewer's window.jazmin API (mode 'print'), answered from the file
 * here, limited to `filter` when one is given; only the package's files and its allowed origins are reachable
 * (everything else is refused), and it runs in a context of its own, closed afterwards.
 */
async function renderDocument({ file, key, password, unlockToken, table, entry, browser, filter = null, viewport, waitFor = 'ready', timeout = 30000, onReady, onDownload, pdfDefaults } = {}, what, capture) {
  if (!browser || typeof browser.newPage !== 'function') throw new JazminValidationError(`${what} needs a Puppeteer or Playwright browser`);
  const defaults = pdfDefaults == null ? {} : normalizePdf(pdfDefaults, 'pdfDefaults');
  const own = !(file instanceof JazminReader);
  const reader = own ? new JazminReader(file, { key, password, unlockToken, table }) : file;
  let context = null;
  let tab = null;
  try {
    const settings = reader.package ?? {};
    const page = entry ?? settings.entry;
    if (!page) throw new JazminValidationError('The file has no document: give entry, or write it with package.entry');
    // No sandbox here: the page has an origin of its own that nothing else uses, so its fonts load as its own files.
    const handle = createFileHandler(reader, { origin: ORIGIN, sandbox: false });
    if (handle(page, { method: 'HEAD' }).status !== 200) throw new JazminValidationError(`No page '${page}' is visible with this key`);
    const allowed = new Set(settings.allowedOrigins ?? []);
    const types = new Map(reader.columns.map((c) => [c.name, c.type]));
    const encode = (row) => Object.fromEntries(Object.entries(row).map(([n, v]) => [n, encodeValue(types.get(n), v)]));
    const scope = filter ?? null;
    const rowCount = scope ? reader.count(scope) : reader.rowCount; // checks the filter, before the browser starts
    const boot = {
      origin: ORIGIN,
      mode: 'print',
      filter: scope,
      metadata: reader.metadata ?? null,
      columns: reader.columns,
      access: reader.access ? { isOwner: false, online: reader.access.online ?? false, expires: reader.access.expires ?? null } : null,
      rowCount,
      rows: rowCount <= TEMPLATE_ROWS ? [...reader.find(scope)].map(encode) : null,
      paths: reader.files.map((f) => f.path),
      allowedOrigins: [...allowed],
    };

    // A context of its own (no cookies or storage shared with other pages), when the browser can make one: a
    // Playwright Browser (newContext) or a Puppeteer Browser (createBrowserContext). A Playwright BrowserContext is used
    // as it is.
    const makeContext = browser.newContext ?? browser.createBrowserContext ?? browser.createIncognitoBrowserContext;
    context = makeContext ? await makeContext.call(browser) : null;
    tab = await (context ?? browser).newPage();
    const playwright = typeof tab.addInitScript === 'function'; // Puppeteer pages have evaluateOnNewDocument
    if (viewport) await (playwright ? tab.setViewportSize(viewport) : tab.setViewport(viewport));
    let ready;
    const done = new Promise((resolve) => { ready = resolve; });
    await tab.exposeFunction('__jazminReady', (text) => ready(JSON.parse(text)));
    await tab.exposeFunction('__jazminCall', async (text) => {
      const { type, payload } = JSON.parse(text);
      try {
        let result;
        if (type === 'query') result = templateQuery(reader, within(scope, payload.filter), payload.options).map(encode);
        else if (type === 'count') result = reader.count(within(scope, payload.filter) ?? undefined);
        else if (type === 'file') {
          const info = reader.files.find((f) => f.path === payload.path);
          result = { type: info?.type ?? '', bytes: reader.readFile(payload.path).toString('base64') };
        } else if (type === 'download') {
          onDownload?.({ filename: payload.filename, type: payload.type, bytes: Buffer.from(payload.bytes, 'base64') });
          result = true;
        } else throw new JazminValidationError(`Unknown request '${type}'`);
        return JSON.stringify({ result });
      } catch (error) {
        return JSON.stringify({ error: error.message || String(error) });
      }
    });
    if (playwright) await tab.addInitScript(installApi, boot);
    else await tab.evaluateOnNewDocument(installApi, boot);

    // Requests: the package's files from the file, its allowed origins from the network, nothing else.
    const answer = (url) => {
      const u = new URL(url);
      if (u.origin === ORIGIN) {
        const a = handle(u.pathname, { method: 'GET' });
        return { status: a.status, headers: a.headers, body: a.status === 200 ? a.body : Buffer.alloc(0) };
      }
      return allowed.has(u.origin) || u.protocol === 'data:' || u.protocol === 'blob:' ? 'continue' : 'abort';
    };
    if (playwright) {
      await tab.route('**/*', (route) => {
        const a = answer(route.request().url());
        if (a === 'continue') return route.continue();
        if (a === 'abort') return route.abort('blockedbyclient');
        return route.fulfill({ status: a.status, headers: a.headers, body: a.body });
      });
    } else {
      await tab.setRequestInterception(true);
      tab.on('request', (request) => {
        const a = answer(request.url());
        if (a === 'continue') return request.continue();
        if (a === 'abort') return request.abort('blockedbyclient');
        return request.respond({ status: a.status, headers: a.headers, body: a.body });
      });
    }

    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new JazminValidationError(waitFor === 'ready'
        ? `The document did not call jazmin.ready() within ${timeout} ms (for documents that don't, use waitFor: 'load')`
        : `The document did not load within ${timeout} ms`)), timeout);
    });
    try {
      await Promise.race([tab.goto(`${ORIGIN}/${page.split('/').map(encodeURIComponent).join('/')}`, { waitUntil: 'load', timeout }), timedOut]);
      const info = waitFor === 'ready' ? await Promise.race([done, timedOut]) : {};
      onReady?.(info);
    } finally {
      clearTimeout(timer);
    }
    // The page settings of the page shown now: the package's, its file's (actions.pdf), the page's own (setActions).
    const shown = decodeURIComponent(new URL(tab.url()).pathname.slice(1));
    const fileActions = reader.files.find((f) => f.path === shown)?.actions ?? {};
    const fromPage = await tab.evaluate(() => window[Symbol.for('jazmin.pagePdf')] ?? null);
    const pdf = {
      ...defaults,
      ...(settings.pdf ?? {}),
      ...(typeof fileActions.pdf === 'object' ? fileActions.pdf : {}),
      ...(fromPage === null ? {} : normalizePdf(fromPage, 'The page\'s jazmin.setActions pdf')),
    };
    return Buffer.from(await capture(tab, pdf));
  } finally {
    if (context) await context.close();
    else await tab?.close();
    if (own) reader.close();
  }
}

/**
 * Renders a file's document (its package's entry page, or `entry`) to PDF in a browser you supply: a Puppeteer or
 * Playwright Browser (Chromium). The page gets the viewer's window.jazmin API with jazmin.mode 'print', answered from
 * the file here; only the package's files and its allowed origins are reachable (everything else is refused), and it
 * runs in a context of its own, closed afterwards. Resolves when the document calls jazmin.ready() (or, with
 * waitFor: 'load', when it has loaded), with the PDF as a Buffer.
 *   options: { file (a path, a Buffer or a JazminReader), key, password, unlockToken, table, entry, browser,
 *              filter (the document sees only these rows: jazmin.filter), pdfDefaults (page settings for documents
 *              that don't set them: a viewer's paper size, say), pdf (the browser's PDF options), waitFor
 *              ('ready' | 'load'), timeout (ms), onReady(info), onDownload({ filename, type, bytes }) }
 * Page settings, each over the ones before: A4 with backgrounds; pdfDefaults; the package's (package.pdf); the page's
 * file's (actions.pdf); the page's own (jazmin.setActions({ pdf })); options.pdf. Settings from untrusted places (a
 * page's jazmin.savePdf) go through checkPageSettings before they become options.pdf. A file's actions steer viewers:
 * renderPdf renders a page whose file says pdf: false (the caller has the key, and decides).
 */
export function renderPdf(options = {}) {
  return renderDocument(options, 'renderPdf', (tab, pdf) => tab.pdf({ format: 'A4', printBackground: true, ...pdf, ...(options.pdf ?? {}) }));
}

/**
 * Renders a file's document to an image (PNG by default), as renderPdf renders it to PDF: the whole page, at
 * `viewport` ({ width, height }; default 1200 x 800 CSS pixels).
 *   options: renderPdf's, without pdf; plus viewport, and image (the browser's screenshot options: type 'png' or
 *            'jpeg', quality, fullPage (default true), scale).
 */
export function renderImage(options = {}) {
  const { image = {}, viewport = { width: 1200, height: 800 } } = options;
  return renderDocument({ ...options, viewport }, 'renderImage', (tab) => tab.screenshot({ type: 'png', fullPage: true, ...image }));
}
