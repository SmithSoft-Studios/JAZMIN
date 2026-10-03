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
 * A file to store: { path, content (Buffer | string) | file (path on disk), type?, groups? }.
 * Returns { path, type, groups, size, sha256, read(offset, length) } without loading files from disk.
 */
export function fileSource(entry) {
  if (entry === null || typeof entry !== 'object') throw new JazminValidationError('Each file must be an object { path, content | file }');
  const filePath = validatePath(entry.path);
  const type = entry.type === undefined ? mediaType(filePath) : String(entry.type);
  const groups = normalizeGroups(entry.groups, filePath);
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
      path: filePath, type, groups, size: bytes.length,
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
    path: filePath, type, groups, size, sha256: hash.digest('hex'),
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
  return out;
}

/** Does a key with these row groups and named file groups see a file listed for `groups`? */
export function canSee(groups, rowNames, fileNames) {
  return groups.some((g) => g === EVERYONE || rowNames.has(g) || fileNames.has(g) || fileNames.has(EVERYONE));
}
