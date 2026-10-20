// Embedded files (format 1.3): validation, media types and the file directory model.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JazminValidationError } from './errors.js';

/** Raw bytes per stored block: bounds memory and lets readers fetch part of a file. */
export const FILE_BLOCK_SIZE = 256 * 1024;
export const EVERYONE = '*';
/** Marks an already prepared file source (used when update/append carry files over). */
export const FILE_SOURCE = Symbol('jazmin.fileSource');

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.zip': 'application/zip',
};

/** Media type from a path's extension. */
export function mediaType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Paths are relative, '/'-separated, without empty, '.' or '..' segments (spec 6.8). */
export function validatePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) throw new JazminValidationError('A file path must be a string of 1 to 1024 characters');
  const segments = p.split('/');
  if (p.includes('\\') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new JazminValidationError(`Invalid file path '${p}': use relative paths with '/' and no empty, '.' or '..' segments`);
  }
  return p;
}

/** Groups that may see a file: '*' (everyone with a key) or names (row groups or named file groups). */
export function normalizeGroups(groups, filePath) {
  if (groups === undefined || groups === EVERYONE) return [EVERYONE];
  if (!Array.isArray(groups) || groups.length === 0) throw new JazminValidationError(`File '${filePath}': groups must be '*' or a non-empty array`);
  const names = [...new Set(groups.map((g) => String(g)))];
  for (const g of names) if (g.length === 0 || g.length > 256) throw new JazminValidationError(`File '${filePath}': invalid group name '${g}'`);
  return names.includes(EVERYONE) ? [EVERYONE] : names.sort();
}

/**
 * A file to store: { path, content (Buffer | string) | file (path on disk), type?, groups?, actions? }.
 * Returns { path, type, groups, actions?, size, sha256, read(offset, length) } without loading files from disk.
 */
export function fileSource(entry) {
  if (entry === null || typeof entry !== 'object') throw new JazminValidationError('Each file must be an object { path, content | file }');
  const filePath = validatePath(entry.path);
  const type = entry.type === undefined ? mediaType(filePath) : String(entry.type);
  const groups = normalizeGroups(entry.groups, filePath);
  const actions = normalizeActions(entry.actions, filePath);
  const groupActions = normalizeGroupActions(entry.groupActions, groups, filePath);
  // lock: the id of the lock (spec 6.8.1) that must be opened before the file is, one of the writer's `locks`.
  if (entry.lock !== undefined && (typeof entry.lock !== 'string' || entry.lock.length < 1 || entry.lock.length > 64)) {
    throw new JazminValidationError(`File '${filePath}': lock must be a lock id (1 to 64 characters)`);
  }
  // page: the file is a page of the document that only its file groups' keys know of (spec 6.8; checked by the writer).
  const page = entry.page === undefined ? undefined : normalizePageSettings(entry.page, `File '${filePath}': page`, undefined, true);
  const extra = {
    ...(actions ? { actions } : {}), ...(groupActions ? { groupActions } : {}), ...(entry.lock !== undefined ? { lock: entry.lock } : {}), ...(page ? { page } : {}),
  };
  if ((entry.content === undefined) === (entry.file === undefined)) {
    throw new JazminValidationError(`File '${filePath}': supply exactly one of content or file`);
  }
  if (entry.content !== undefined) {
    const bytes = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8')
      : entry.content instanceof Uint8Array ? Buffer.from(entry.content.buffer, entry.content.byteOffset, entry.content.byteLength)
        : null;
    if (!bytes) throw new JazminValidationError(`File '${filePath}': content must be a Buffer, Uint8Array or string`);
    return {
      [FILE_SOURCE]: true,
      path: filePath, type, groups, ...extra, size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      read: (offset, length) => bytes.subarray(offset, offset + length),
    };
  }
  const diskPath = String(entry.file);
  const size = fs.statSync(diskPath).size;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(diskPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(FILE_BLOCK_SIZE, Math.max(size, 1)));
    for (let offset = 0; offset < size;) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    [FILE_SOURCE]: true,
    path: filePath, type, groups, ...extra, size, sha256: hash.digest('hex'),
    read: (offset, length) => {
      const out = Buffer.alloc(length);
      const handle = fs.openSync(diskPath, 'r');
      try {
        fs.readSync(handle, out, 0, length, offset);
      } finally {
        fs.closeSync(handle);
      }
      return out;
    },
  };
}

/** Validates `package` settings (spec 6.8). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A key service's address (spec 6.8.2): an https URL (or http on a loopback host, for development) without a user name,
 * password or fragment; else undefined.
 */
export function keyServiceAddress(value) {
  if (typeof value !== 'string') return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  return secure && !url.username && !url.password && !url.hash ? url.href : undefined;
}

/** Checks a key service's address given to a writer; returns it as a URL's text. */
export function checkKeyService(value, where) {
  const address = keyServiceAddress(value);
  if (!address) throw new JazminValidationError(`${where} must be an https address without a user name, password or #fragment, such as https://keys.example.com/unlock`);
  return address;
}

const MASK_SETTINGS = { reveal: ['value', 'column'], seconds: 'count', whenHidden: 'bool', idleSeconds: 'count', export: 'bool' };

/**
 * How viewers show masked columns' revealed values (spec 7.6.8), by column: { reveal: 'value' | 'column', seconds,
 * whenHidden, idleSeconds } (seconds and idleSeconds 0 to 86400; 0: no time limit).
 */
function normalizeMaskSettings(masks) {
  if (masks === null || typeof masks !== 'object' || Array.isArray(masks)) throw new JazminValidationError('package.masks: { column: { reveal, seconds, whenHidden, idleSeconds } }');
  const out = {};
  for (const [column, given] of Object.entries(masks)) {
    const where = `package.masks.${column}`;
    if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new JazminValidationError(`${where} must be an object`);
    const settings = {};
    for (const [name, value] of Object.entries(given)) {
      const kind = MASK_SETTINGS[name];
      if (!kind) throw new JazminValidationError(`${where}: unknown setting '${name}' (reveal, seconds, whenHidden, idleSeconds, export)`);
      if (Array.isArray(kind) ? !kind.includes(value) : kind === 'bool' ? typeof value !== 'boolean' : !(Number.isInteger(value) && value >= 0 && value <= 86400)) {
        throw new JazminValidationError(`${where}.${name}: ${Array.isArray(kind) ? kind.map((k) => `'${k}'`).join(' or ') : kind === 'bool' ? 'true or false' : 'a whole number of seconds from 0 to 86400'}`);
      }
      settings[name] = value;
    }
    out[column] = settings;
  }
  return out;
}

export function normalizePackage(settings, paths) {
  if (settings === undefined || settings === null) return undefined;
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new JazminValidationError('package must be an object');
  const out = {};
  if (settings.entry !== undefined) {
    if (!paths.has(settings.entry)) throw new JazminValidationError(`package.entry '${settings.entry}' is not one of the stored files`);
    out.entry = settings.entry;
  }
  if (settings.title !== undefined) out.title = String(settings.title);
  if (settings.allowedOrigins !== undefined) {
    if (!Array.isArray(settings.allowedOrigins)) throw new JazminValidationError('package.allowedOrigins must be an array');
    out.allowedOrigins = settings.allowedOrigins.map((o) => {
      let url;
      try {
        url = new URL(o);
      } catch {
        url = null;
      }
      if (!url || url.protocol !== 'https:' || url.origin !== o) throw new JazminValidationError(`package.allowedOrigins: '${o}' must be an https origin such as https://api.example.com`);
      return o;
    });
  }
  if (settings.allowWasm !== undefined) out.allowWasm = settings.allowWasm === true;
  if (settings.pdf !== undefined) out.pdf = normalizePdf(settings.pdf, 'package.pdf');
  // A shared file whose grants limit what keys send back stores the settings as editByKey (spec 7.9.1); callers give
  // them as edit either way, and the writer decides which member it stores.
  if (settings.edit !== undefined && settings.editByKey !== undefined) throw new JazminValidationError('package: give edit or editByKey, not both');
  const edit = settings.edit ?? settings.editByKey;
  if (edit !== undefined) out.edit = normalizeEdit(edit);
  // The owner's key service for the file's online locks (spec 6.8.2).
  if (settings.keyService !== undefined) out.keyService = checkKeyService(settings.keyService, 'package.keyService');
  if (settings.masks !== undefined) out.masks = normalizeMaskSettings(settings.masks);
  // Whether the document needs the network (spec 6.8): only with an origin it may reach.
  if (settings.online !== undefined) {
    if (settings.online !== 'required' && settings.online !== 'optional') throw new JazminValidationError("package.online is 'required' or 'optional'");
    if (!out.allowedOrigins?.length) throw new JazminValidationError('package.online needs allowedOrigins: the https origins the document loads from');
    out.online = settings.online;
  }
  // The document's pages, shown as tabs, and its own files, kept out of viewers' lists (spec 6.8).
  if (settings.pages !== undefined) {
    if (!Array.isArray(settings.pages) || !settings.pages.length) throw new JazminValidationError('package.pages must be a non-empty array of pages: { path, title }');
    const seen = new Set();
    out.pages = settings.pages.map((page, i) => {
      const where = `package.pages[${i}]`;
      if (page === null || typeof page !== 'object' || Array.isArray(page)) throw new JazminValidationError(`${where} must be a page: { path, title }`);
      if (page.path === undefined || page.path === null || page.path === '') throw new JazminValidationError(`${where}.path is required`);
      if (typeof page.path !== 'string' || !paths.has(page.path)) throw new JazminValidationError(`${where}.path '${page.path}' is not one of the stored files`);
      if (page.order !== undefined) throw new JazminValidationError(`${where}.order is only for a page in a file group's directory`);
      if (seen.has(page.path)) throw new JazminValidationError(`package.pages: '${page.path}' is listed twice`);
      seen.add(page.path);
      const { path: _, ...rest } = page;
      return { path: page.path, ...normalizePageSettings(rest, where, out.allowedOrigins ?? []) };
    });
    if (out.entry === undefined) out.entry = out.pages[0].path;
    else if (!seen.has(out.entry)) throw new JazminValidationError(`package.entry '${out.entry}' is not one of package.pages`);
  }
  if (settings.files !== undefined) {
    const bad = 'package.files must be an array of stored paths or folders (ending in /)';
    if (!Array.isArray(settings.files)) throw new JazminValidationError(bad);
    const seen = new Set();
    out.files = settings.files.map((f) => {
      if (typeof f !== 'string' || !f.length) throw new JazminValidationError(bad);
      if (seen.has(f)) throw new JazminValidationError(`package.files: '${f}' is listed twice`);
      seen.add(f);
      if (f.endsWith('/')) {
        if (![...paths].some((p) => p.startsWith(f))) throw new JazminValidationError(`package.files: no stored file is in the folder '${f}'`);
      } else if (!paths.has(f)) {
        throw new JazminValidationError(`package.files: '${f}' is not one of the stored files`);
      }
      return f;
    });
  }
  return out;
}

const PAGE_SETTINGS = ['title', 'online', 'table', 'pdf', 'actions', 'order'];
const PAGE_ACTIONS = ['print', 'pdf', 'image'];

/**
 * A page's settings (spec 6.8): { title, online?, table?, pdf?, actions? }, and order for a page in a file group's
 * directory (withOrder). `where` names it in errors; `origins` are the package's allowedOrigins (online needs them;
 * undefined: checked later, by the writer).
 */
export function normalizePageSettings(page, where, origins, withOrder = false) {
  const members = PAGE_SETTINGS.filter((n) => withOrder || n !== 'order');
  if (page === null || typeof page !== 'object' || Array.isArray(page)) throw new JazminValidationError(`${where} must be an object { ${members.join(', ')} }`);
  if (withOrder && page.path !== undefined) throw new JazminValidationError(`${where}.path is not used: the page is the file itself`);
  for (const name of Object.keys(page)) {
    if (!members.includes(name)) throw new JazminValidationError(`${where}: unknown setting '${name}' (${members.join(', ')})`);
  }
  if (typeof page.title !== 'string' || !page.title.length) throw new JazminValidationError(`${where}.title is required`);
  const out = { title: page.title };
  if (page.online !== undefined) {
    if (page.online !== 'required' && page.online !== 'optional') throw new JazminValidationError(`${where}.online is 'required' or 'optional'`);
    if (origins !== undefined && !origins.length) throw new JazminValidationError(`${where}.online needs allowedOrigins`);
    out.online = page.online;
  }
  if (page.table !== undefined) {
    if (typeof page.table !== 'string' || !page.table.length) throw new JazminValidationError(`${where}.table must be a table name`);
    out.table = page.table;
  }
  if (page.pdf !== undefined) out.pdf = normalizePdf(page.pdf, `${where}.pdf`);
  if (page.actions !== undefined) {
    if (page.actions === null || typeof page.actions !== 'object' || Array.isArray(page.actions)) throw new JazminValidationError(`${where}.actions must be an object { print, pdf, image }`);
    out.actions = {};
    for (const [name, value] of Object.entries(page.actions)) {
      if (!PAGE_ACTIONS.includes(name)) throw new JazminValidationError(`${where}.actions: unknown action '${name}' (print, pdf, image)`);
      if (typeof value !== 'boolean') throw new JazminValidationError(`${where}.actions.${name} must be true or false`);
      out.actions[name] = value;
    }
  }
  if (withOrder && page.order !== undefined) {
    if (!Number.isInteger(page.order)) throw new JazminValidationError(`${where}.order must be a whole number`);
    out.order = page.order;
  }
  return out;
}

/**
 * The writer's checks of pages against the whole file (spec 6.8): the tables they name, directory pages only in
 * access-controlled files, needing allowedOrigins for online, and never also in package.pages.
 */
export function checkPages(settings, entries, tableNames, { access, partial = false }) {
  const known = new Set(tableNames);
  (settings?.pages ?? []).forEach((p, i) => {
    if (p.table !== undefined && !partial && !known.has(p.table)) throw new JazminValidationError(`package.pages[${i}].table '${p.table}' is not a table of the file`);
  });
  const listed = new Set((settings?.pages ?? []).map((p) => p.path));
  for (const e of entries) {
    if (!e.page) continue;
    if (!access) throw new JazminValidationError(`File '${e.path}': page needs an access-controlled file (use package.pages)`);
    if (listed.has(e.path)) throw new JazminValidationError(`File '${e.path}': its page is also in package.pages`);
    if (e.page.online !== undefined && !settings?.allowedOrigins?.length) throw new JazminValidationError(`File '${e.path}': page.online needs allowedOrigins`);
    if (e.page.table !== undefined && !partial && !known.has(e.page.table)) throw new JazminValidationError(`File '${e.path}': page.table '${e.page.table}' is not a table of the file`);
  }
}

/** A directory page as a reader takes it (spec 6.8): members of the wrong type left out; none without a title. */
export function readPage(page) {
  if (page === null || typeof page !== 'object' || Array.isArray(page) || typeof page.title !== 'string') return undefined;
  const out = { title: page.title };
  if (page.online === 'required' || page.online === 'optional') out.online = page.online;
  if (typeof page.table === 'string') out.table = page.table;
  if (page.pdf !== null && typeof page.pdf === 'object' && !Array.isArray(page.pdf)) out.pdf = page.pdf;
  if (page.actions !== null && typeof page.actions === 'object' && !Array.isArray(page.actions)) {
    const actions = Object.fromEntries(PAGE_ACTIONS.filter((a) => typeof page.actions[a] === 'boolean').map((a) => [a, page.actions[a]]));
    if (Object.keys(actions).length) out.actions = actions;
  }
  if (Number.isInteger(page.order)) out.order = page.order;
  return out;
}

const EDIT_SETTINGS = ['table', 'key', 'columns', 'add', 'delete'];
const KEY_TYPES = new Set(['string', 'int', 'decimal', 'datetime', 'bool']);

/**
 * What a document may change (docs/design/editable-documents.md): { table, key: [columns], columns: [columns], add,
 * delete }. Its columns are checked against the table by the writer (checkEdit).
 */
export function normalizeEdit(edit) {
  if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) throw new JazminValidationError('package.edit must be an object: { table, key, columns, add, delete }');
  for (const name of Object.keys(edit)) {
    if (!EDIT_SETTINGS.includes(name)) throw new JazminValidationError(`package.edit: unknown setting '${name}' (${EDIT_SETTINGS.join(', ')})`);
  }
  const names = (value, what) => {
    if (!Array.isArray(value) || value.some((n) => typeof n !== 'string' || n.length === 0)) throw new JazminValidationError(`package.edit.${what} must be a list of column names`);
    if (new Set(value).size !== value.length) throw new JazminValidationError(`package.edit.${what} names a column twice`);
    return [...value];
  };
  const out = {};
  if (edit.table !== undefined) {
    if (typeof edit.table !== 'string') throw new JazminValidationError('package.edit.table must be a table name');
    out.table = edit.table;
  }
  out.key = names(edit.key, 'key');
  if (!out.key.length) throw new JazminValidationError('package.edit.key: give the column (or columns) that identify a row');
  out.columns = edit.columns === undefined ? [] : names(edit.columns, 'columns');
  for (const c of out.columns) if (out.key.includes(c)) throw new JazminValidationError(`package.edit.columns: '${c}' is a key column, which changes can't alter`);
  for (const flag of ['add', 'delete']) {
    if (edit[flag] === undefined) continue;
    if (typeof edit[flag] !== 'boolean') throw new JazminValidationError(`package.edit.${flag} must be true or false`);
    out[flag] = edit[flag];
  }
  if (!out.columns.length && !out.add && !out.delete) throw new JazminValidationError('package.edit allows nothing: give columns, add or delete');
  return out;
}

const LIMIT_SETTINGS = ['columns', 'add', 'delete'];

/**
 * A grant's limit on what its key may send back (spec 7.9.1): { columns?, add?, delete? }, members in that order, only
 * those given. `where` names it in errors.
 */
export function normalizeEditLimit(limit, where) {
  if (limit === null || typeof limit !== 'object' || Array.isArray(limit)) throw new JazminValidationError(`${where} must be an object: { columns, add, delete }`);
  for (const name of Object.keys(limit)) {
    if (!LIMIT_SETTINGS.includes(name)) throw new JazminValidationError(`${where}: unknown setting '${name}' (${LIMIT_SETTINGS.join(', ')})`);
  }
  const out = {};
  if (limit.columns !== undefined) {
    const value = limit.columns;
    if (!Array.isArray(value) || value.some((n) => typeof n !== 'string' || n.length === 0)) throw new JazminValidationError(`${where}.columns must be a list of column names`);
    if (new Set(value).size !== value.length) throw new JazminValidationError(`${where}.columns names a column twice`);
    out.columns = [...value];
  }
  for (const flag of ['add', 'delete']) {
    if (limit[flag] === undefined) continue;
    if (typeof limit[flag] !== 'boolean') throw new JazminValidationError(`${where}.${flag} must be true or false`);
    out[flag] = limit[flag];
  }
  return out;
}

/**
 * Whether a limit narrows what the document allows (spec 7.9.1). With no document settings, any limit that says
 * something counts, so that it is kept until the document allows changes again.
 */
export function limitNarrows(limit, edit) {
  if (!limit) return false;
  if (!edit) return Object.keys(limit).length > 0;
  return (limit.columns !== undefined && edit.columns.some((c) => !limit.columns.includes(c)))
    || (limit.add === false && edit.add === true) || (limit.delete === false && edit.delete === true);
}

/**
 * What a key may send back (spec 7.9.1): the document's settings narrowed by the key's limit and by the columns it
 * sees (`visible`: a Set of column names, or null for every column). `lost`: the key's limit was lost (it may send
 * nothing). Returns { table?, key, columns, add, delete }.
 */
export function effectiveEdit(edit, limit, visible, lost = false) {
  if (lost) return { ...edit, columns: [], add: false, delete: false };
  return {
    ...edit,
    columns: edit.columns.filter((c) => (!limit?.columns || limit.columns.includes(c)) && (!visible || visible.has(c))),
    add: edit.add === true && limit?.add !== false,
    delete: edit.delete === true && limit?.delete !== false,
  };
}

/**
 * Checks a limit given with a grant against the document's settings and the grant's column groups (spec 7.9.1): it may
 * only narrow. `granted`: the names of the columns of the document's table the grant sees, or null for every column.
 */
export function checkEditLimit(limit, edit, granted, where) {
  if (!edit) return;
  for (const c of limit.columns ?? []) {
    if (!edit.columns.includes(c)) throw new JazminValidationError(`${where} can only narrow the document's: '${c}' isn't an editable column`);
    if (granted && !granted.has(c)) throw new JazminValidationError(`${where}.columns: '${c}' isn't in a column group this key sees`);
  }
  if (limit.add === true && edit.add !== true) throw new JazminValidationError(`${where} can only narrow the document's: the document doesn't allow adding rows`);
  if (limit.delete === true && edit.delete !== true) throw new JazminValidationError(`${where} can only narrow the document's: the document doesn't allow deleting rows`);
}

/**
 * Checks package.edit against the file's tables ([{ name, columns, partitionBy }]): the table and columns exist, key
 * columns are of a type that identifies rows, and rows can be added (every column that can't be empty is set). A table
 * this writer doesn't know (an append to another table) was checked when it was written.
 */
export function checkEdit(edit, tables, { partial = false } = {}) {
  const table = edit.table === undefined ? tables[0] : tables.find((t) => t.name === edit.table);
  if (!table) {
    if (partial) return;
    throw new JazminValidationError(`package.edit.table: the file has no table '${edit.table}'`);
  }
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  for (const k of edit.key) {
    const c = byName.get(k);
    if (!c) throw new JazminValidationError(`package.edit.key: no column '${k}'`);
    if (!KEY_TYPES.has(c.type)) throw new JazminValidationError(`package.edit.key: '${k}' is a ${c.type} column; keys are string, int, decimal, datetime or bool columns`);
  }
  for (const n of edit.columns) if (!byName.has(n)) throw new JazminValidationError(`package.edit.columns: no column '${n}'`);
  if (edit.add) {
    const set = new Set([...edit.key, ...edit.columns, ...(table.partitionBy ? [table.partitionBy] : [])]);
    for (const c of table.columns) {
      if (c.nullable === false && !set.has(c.name)) throw new JazminValidationError(`package.edit.add: column '${c.name}' can't be empty, so added rows must set it: list it in columns`);
    }
  }
}

const FLAGS = ['open', 'save', 'print', 'image', 'list'];

/**
 * What viewers may do with a file (spec 6.8): { open, save, print, pdf, image, list }, each true or false (all allowed
 * when left out); pdf may instead be the page settings for its PDFs; list: false keeps the file out of viewers' lists of
 * files (one the document page uses, such as a script or a font). These steer viewers: a key that sees a file can read
 * it with the library whatever they say.
 */
export function normalizeActions(actions, filePath) {
  if (actions === undefined) return undefined;
  const where = `File '${filePath}': actions`;
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) throw new JazminValidationError(`${where} must be an object`);
  const out = {};
  for (const [name, value] of Object.entries(actions)) {
    if (FLAGS.includes(name)) {
      if (typeof value !== 'boolean') throw new JazminValidationError(`${where}.${name} must be true or false`);
      out[name] = value;
    } else if (name === 'pdf') {
      out.pdf = typeof value === 'boolean' ? value : normalizePdf(value, `${where}.pdf`);
    } else {
      throw new JazminValidationError(`${where}: unknown action '${name}' (open, save, print, pdf, image, list)`);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A file's actions per file group (access-controlled files): { [group]: actions }, for groups the file is in, each as
 * `actions`. A key that sees the file through several groups may do what any of them allows (mergeActions).
 */
export function normalizeGroupActions(groupActions, groups, filePath) {
  if (groupActions === undefined) return undefined;
  const where = `File '${filePath}': groupActions`;
  if (groupActions === null || typeof groupActions !== 'object' || Array.isArray(groupActions)) throw new JazminValidationError(`${where} must be an object of actions by file group`);
  const out = {};
  for (const [group, actions] of Object.entries(groupActions)) {
    if (!groups.includes(group)) throw new JazminValidationError(`${where}: '${group}' is not one of the file's groups (${groups.join(', ')})`);
    out[group] = normalizeActions(actions, filePath) ?? {};
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Actions seen through two file groups, as one: an action is allowed when either allows it (an action left out is
 * allowed); page settings for PDFs are the first's that allows them.
 */
export function mergeActions(a, b) {
  if (!a || !b) return undefined;
  const out = {};
  for (const name of FLAGS) if (name in a && name in b) out[name] = a[name] || b[name];
  if ('pdf' in a && 'pdf' in b) out.pdf = a.pdf === false ? b.pdf : a.pdf;
  return Object.keys(out).length ? out : undefined;
}

/** A file's actions as a reader takes them: the ones it knows, of the right types (others are left out). */
export function readActions(actions) {
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) return undefined;
  const out = {};
  for (const name of FLAGS) if (typeof actions[name] === 'boolean') out[name] = actions[name];
  if (typeof actions.pdf === 'boolean') out.pdf = actions.pdf;
  else if (actions.pdf !== null && typeof actions.pdf === 'object' && !Array.isArray(actions.pdf)) {
    try {
      out.pdf = normalizePdf(actions.pdf, 'actions.pdf');
    } catch {
      out.pdf = true; // settings this reader doesn't know: allowed, with its own
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const PDF_FORMATS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid', 'Ledger'];
const CSS_LENGTH = /^(?:0|\d+(?:\.\d+)?(?:px|in|cm|mm))$/;

/**
 * The document's page settings for PDFs (renderPdf, and viewers' exports): { format, landscape, margin: { top, right,
 * bottom, left }, scale, printBackground }, each optional; checked here, so a file never holds settings a browser
 * would refuse.
 */
/**
 * Page settings checked as a writer checks package.pdf: a clean copy with only the settings browsers take, or a
 * JazminValidationError. For settings from untrusted places (a page's jazmin.savePdf) before they reach a browser.
 */
export function checkPageSettings(settings) {
  return normalizePdf(settings, 'Page settings');
}

export function normalizePdf(pdf, where = 'package.pdf') {
  if (pdf === null || typeof pdf !== 'object' || Array.isArray(pdf)) throw new JazminValidationError(`${where} must be an object`);
  const out = {};
  for (const [name, value] of Object.entries(pdf)) {
    switch (name) {
      case 'format':
        if (!PDF_FORMATS.includes(value)) throw new JazminValidationError(`${where}.format: '${value}' is not one of ${PDF_FORMATS.join(', ')}`);
        out.format = value;
        break;
      case 'landscape':
      case 'printBackground':
      case 'preferCSSPageSize':
        if (typeof value !== 'boolean') throw new JazminValidationError(`${where}.${name} must be true or false`);
        out[name] = value;
        break;
      case 'scale':
        if (typeof value !== 'number' || !(value >= 0.1 && value <= 2)) throw new JazminValidationError(`${where}.scale must be a number from 0.1 to 2`);
        out.scale = value;
        break;
      case 'margin': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new JazminValidationError(`${where}.margin must be an object: { top, right, bottom, left }`);
        out.margin = {};
        for (const [side, length] of Object.entries(value)) {
          if (!['top', 'right', 'bottom', 'left'].includes(side)) throw new JazminValidationError(`${where}.margin: unknown side '${side}'`);
          if (typeof length !== 'string' || !CSS_LENGTH.test(length)) throw new JazminValidationError(`${where}.margin.${side}: '${length}' must be a length such as 12mm, 1cm, 0.5in or 20px`);
          out.margin[side] = length;
        }
        break;
      }
      default:
        throw new JazminValidationError(`${where}: unknown setting '${name}' (format, landscape, margin, scale, printBackground, preferCSSPageSize)`);
    }
  }
  return out;
}

/** Does a key with these row groups and named file groups see a file listed for `groups`? */
export function canSee(groups, rowNames, fileNames) {
  return groups.some((g) => g === EVERYONE || rowNames.has(g) || fileNames.has(g) || fileNames.has(EVERYONE));
}
