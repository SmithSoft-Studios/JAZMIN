import fs from 'node:fs';
import { JazminValidationError } from './errors.js';
import { csvPieces, parseCsv } from './formats/csv.js';
import { jsonPieces, parseJsonRows } from './formats/json.js';
import { readJsonObjects } from './formats/json-stream.js';
import { parseXml, xmlPieces } from './formats/xml.js';
import { JazminReader, fileSource } from './reader.js';
import { PREAMBLE_SIZE } from './constants.js';
import { inferSchema } from './schema.js';
import { shapePieces } from './shape.js';
import { JazminWriter } from './writer.js';

export { JazminReader } from './reader.js';
export { JazminWriter } from './writer.js';
export { JazminAccessKey, JazminKey } from './keys.js';
export { grantAccess, revokeAccess, update } from './update.js';
export { append, compact } from './append.js';
export { accessKeyOf, inspect, issueUnlockToken, listUnlockTokens } from './online.js';
export { inferSchema } from './schema.js';
export { compileShape, shapeSchema } from './shape.js';
export { TYPES } from './types.js';
export {
  JazminAccessExpiredError, JazminError, JazminFormatError, JazminKeyError, JazminUnlockRequiredError, JazminValidationError,
} from './errors.js';

/** Opens a .jzm file path or Buffer for reading. Options: { key } or { password }. */
export function open(source, options) {
  return new JazminReader(source, options);
}

const OPEN_TAIL = 1 << 20; // bytes read from the end of a file by openAsync: trailer, header and key slots

/**
 * open() for async code: the preamble and the end of the file (trailer, header, key slots) are read with
 * non-blocking reads. Queries can then use findAsync / rowsAsync. Buffers are opened as with open().
 */
export async function openAsync(source, options) {
  if (typeof source !== 'string') return open(source, options);
  const fd = await new Promise((resolve, reject) => fs.open(source, 'r', (error, f) => (error ? reject(error) : resolve(f))));
  let src;
  try {
    const { size } = await new Promise((resolve, reject) => fs.fstat(fd, (error, s) => (error ? reject(error) : resolve(s))));
    src = fileSource(fd, size);
    const tail = Math.min(size, OPEN_TAIL);
    await Promise.all([src.load(0, Math.min(size, PREAMBLE_SIZE)), src.load(size - tail, tail)]);
  } catch (error) {
    if (src) src.close();
    else fs.closeSync(fd);
    throw error;
  }
  const reader = new JazminReader(src, options); // reads anything beyond the loaded ranges itself
  src.drop();
  return reader;
}

/**
 * write() for async code: `rows` may be an async iterable (a database cursor, a stream); then
 * options.columns is required, because the schema cannot be inferred without reading the rows twice.
 * Resolves to the Buffer (target = null) or undefined.
 */
export async function writeAsync(target, rows, options = {}) {
  const isAsync = rows && typeof rows[Symbol.asyncIterator] === 'function';
  if (isAsync && !options.columns) throw new JazminValidationError('writeAsync with an async iterable needs options.columns');
  const list = isAsync || options.columns ? rows : Array.from(rows);
  let columns = options.columns ?? inferSchema(list, options);
  if (options.indexes) columns = withIndexes(columns, options.indexes);
  const writer = new JazminWriter(target, { ...options, columns });
  try {
    await writer.writeRowsAsync(list);
    return await writer.finishAsync();
  } catch (error) {
    writer.abort();
    throw error;
  }
}

/**
 * Writes rows to a JAZMIN file (path) or returns a Buffer (target = null).
 * When options.columns is omitted the schema is inferred from the rows.
 * `indexes` is a shorthand: { columnName: 'sorted' | 'trigram' | [...] }.
 */
export function write(target, rows, options = {}) {
  if (options.tables) return writeTables(target, rows, options);
  const list = options.columns ? rows : Array.from(rows);
  return writeFrom(target, () => list, options);
}

/** write() with `tables`: `rows` maps each table's name to its rows (a table left out is written empty). */
function writeTables(target, rows, options) {
  if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new JazminValidationError('With tables, rows must be an object of rows by table name: { clients: [...], transactions: [...] }');
  }
  const writer = new JazminWriter(target, options);
  try {
    options.tables.forEach((t, i) => {
      if (i > 0) writer.startTable(t.name);
      writer.writeRows(rows[t.name] ?? []);
    });
    for (const name of Object.keys(rows)) {
      if (!options.tables.some((t) => t.name === name)) throw new JazminValidationError(`rows: no table '${name}' in tables`);
    }
  } catch (error) {
    writer.abort();
    throw error;
  }
  return writer.finish();
}

/** Applies the `indexes` shorthand ({ columnName: 'sorted' | 'trigram' | [...] }) to column definitions. */
function withIndexes(columns, indexes) {
  for (const name of Object.keys(indexes)) {
    if (!columns.some((c) => c.name === name)) throw new JazminValidationError(`Cannot index unknown column '${name}'`);
  }
  return columns.map((c) => (indexes[c.name] ? { ...c, index: indexes[c.name] } : c));
}

/**
 * Shared by write() and the streaming importers. `rows()` must return a fresh
 * iterable each call: it is read once to infer the schema (unless options.columns
 * is given) and once more to write.
 */
function writeFrom(target, rows, options) {
  let columns = options.columns ?? inferSchema(rows(), options);
  if (options.indexes) columns = withIndexes(columns, options.indexes);
  const writer = new JazminWriter(target, { ...options, columns });
  try {
    writer.writeRows(rows());
  } catch (error) {
    writer.abort();
    throw error;
  }
  return writer.finish();
}

/**
 * Converts a JSON file of any size (a JSON array of objects, or JSON Lines) to JAZMIN
 * without loading it: the input is streamed twice (schema, then rows) unless
 * options.columns is supplied, in which case it is streamed once.
 * Memory stays at roughly one chunk of rows regardless of file size.
 */
export function importJSONFile(inputPath, target, options = {}) {
  return writeFrom(target, () => readJsonObjects(inputPath), options);
}

const EXPORTERS = { json: jsonPieces, csv: csvPieces, xml: xmlPieces };

function pieces(reader, format, options = {}) {
  const exporter = EXPORTERS[format];
  if (!exporter) throw new JazminValidationError(`Unknown export format '${format}'`);
  const { filter, select, limit, offset, shape, ...formatOptions } = options;
  if (shape !== undefined) {
    // An export shape (docs/design/export-shapes.md) decides the structure; select/limit/offset belong in it.
    if (select || limit !== undefined || offset !== undefined) throw new JazminValidationError('With a shape, use $rows/$limit in the shape instead of select, limit or offset');
    return shapePieces(reader, shape, format, { filter, ...formatOptions });
  }
  const columns = select ? reader.columns.filter((c) => select.includes(c.name)) : reader.columns;
  return exporter(columns, reader.find(filter, { select, limit, offset }), formatOptions);
}

/** Converts (optionally filtered) rows to a JSON / CSV / XML string. */
export function exportString(reader, format, options) {
  let out = '';
  for (const piece of pieces(reader, format, options)) out += piece;
  return out;
}

/** Streams (optionally filtered) rows to a JSON / CSV / XML file with bounded memory. */
export function exportFile(reader, format, path, options) {
  const fd = fs.openSync(path, 'w');
  try {
    let buffer = '';
    for (const piece of pieces(reader, format, options)) {
      buffer += piece;
      if (buffer.length >= 65536) {
        fs.writeSync(fd, buffer);
        buffer = '';
      }
    }
    if (buffer) fs.writeSync(fd, buffer);
  } finally {
    fs.closeSync(fd);
  }
}

export const toJSON = (reader, options) => exportString(reader, 'json', options);
export const toCSV = (reader, options) => exportString(reader, 'csv', options);
export const toXML = (reader, options) => exportString(reader, 'xml', options);

/** JSON text/array -> JAZMIN (path or Buffer). */
export function fromJSON(json, target, options = {}) {
  return write(target, parseJsonRows(json), options);
}

/** CSV text -> JAZMIN. Column types are inferred unless options.inferTypes === false. */
export function fromCSV(csv, target, options = {}) {
  const { columns, rows } = parseCsv(csv, options);
  return write(target, rows, { columns, ...options });
}

/** Canonical tabular XML -> JAZMIN. */
export function fromXML(xml, target, options = {}) {
  const { columns, rows } = parseXml(xml, options);
  return write(target, rows, { columns, ...options });
}

export { parseCsv, parseXml, parseJsonRows, readJsonObjects };

/**
 * Drop-in counterpart of JSON.stringify / JSON.parse for arrays of records:
 *   const bytes = JAZMIN.stringify(rows, { key });
 *   const rows  = JAZMIN.parse(bytes, { key });
 */
export const JAZMIN = Object.freeze({
  stringify: (rows, options) => write(null, rows, options),
  parse: (bytes, options) => [...open(bytes, options).rows()],
});
