import fs from 'node:fs';
import { JazminValidationError } from './errors.js';
import { checkCsvFields, csvHeaderNames, csvPieces, parseCsv, readCsvRecords, readCsvTypes } from './formats/csv.js';
import { jsonPieces, parseJsonRows } from './formats/json.js';
import { readJsonObjects } from './formats/json-stream.js';
import { parseXml, readXmlRows, xmlPieces, xmlRecord } from './formats/xml.js';
import { JazminReader, fileSource } from './reader.js';
import { PREAMBLE_SIZE } from './constants.js';
import { inferSchema } from './schema.js';
import { TextColumnInference, textToValue, toObject } from './formats/text.js';
import { setField } from './schema.js';
import { writeShape } from './shape.js';
import { JazminWriter } from './writer.js';

export { JazminReader } from './reader.js';
export { JazminWriter } from './writer.js';
export { JazminAccessKey, JazminKey } from './keys.js';
export { grantAccess, revokeAccess, update } from './update.js';
export { append, compact } from './append.js';
export { rotateKey, rotateOwnerKey } from './rotate.js';
export { createFileHandler, documentPolicy, renderPdf, serveFiles } from './server.js';
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

/**
 * Converts a CSV file of any size to JAZMIN without loading it: the file is read twice, a block at a time (column
 * types, then rows), so memory stays at about one chunk of rows. Column types are inferred as fromCSV() infers them
 * unless options.columns is given: then every header name must be one of those columns, each value is read as its
 * column's type, and the file is read once.
 */
export function importCSVFile(inputPath, target, options = {}) {
  const { delimiter = ',', inferTypes = true } = options;
  const records = () => readCsvRecords(inputPath, { delimiter });
  let columns = options.columns;
  if (!columns) {
    // The header's names, then each value's type, worked out from the bytes without making a string of it.
    const reading = records();
    const header = reading.next();
    reading.return(); // closes the file
    if (header.done) throw new JazminValidationError('CSV has no header row');
    const names = csvHeaderNames(header.value);
    const inference = new TextColumnInference(names, inferTypes);
    let n = -1;
    for (const types of readCsvTypes(inputPath, { delimiter })) {
      if (n >= 0) {
        checkCsvFields(types, names, n);
        inference.addTypes(types);
      }
      n++;
    }
    columns = inference.columns();
  }
  return writeFrom(target, () => csvRows(records(), columns, Boolean(options.columns)), { ...options, columns });
}

/** The data records of a CSV file as objects of `columns`; given columns are found by the header's names. */
function* csvRows(records, columns, byName) {
  let order = null;
  let names = null;
  let n = 0;
  for (const record of records) {
    if (!names) {
      names = csvHeaderNames(record);
      if (byName) {
        order = names.map((name) => {
          const column = columns.find((c) => c.name === name);
          if (!column) throw new JazminValidationError(`CSV column '${name}' is not one of the columns given`);
          return column;
        });
      }
      continue;
    }
    checkCsvFields(record, names, n++);
    yield toObject(order ?? columns, record);
  }
  if (!names) throw new JazminValidationError('CSV has no header row');
}

/**
 * Converts an XML file of the canonical shape (as toXML writes it) of any size to JAZMIN without loading it: the file
 * is read twice, a block at a time (column types as fromXML infers them, then rows). With options.columns, the file
 * is read once, each value is read as its column's type, and every element must name one of the columns.
 */
export function importXMLFile(inputPath, target, options = {}) {
  const { inferTypes = true } = options;
  let columns = options.columns;
  if (!columns) {
    const names = [];
    let inference = null;
    let rows = 0;
    for (const row of readXmlRows(inputPath, { names })) {
      inference ??= new TextColumnInference([], inferTypes);
      while (inference.width < names.length) inference.grow(names[inference.width], rows > 0); // earlier rows lacked it
      inference.add(xmlRecord(row, names.length));
      rows++;
    }
    columns = inference?.columns() ?? [];
  }
  return writeFrom(target, () => xmlRows(inputPath, columns, Boolean(options.columns)), { ...options, columns });
}

/** The rows of an XML file as objects of `columns`; given columns are found by the elements' names. */
function* xmlRows(inputPath, columns, byName) {
  const names = [];
  const order = [];
  for (const row of readXmlRows(inputPath, { names })) {
    while (order.length < names.length) {
      const column = byName ? columns.find((c) => c.name === names[order.length]) : columns[order.length];
      if (!column) throw new JazminValidationError(`XML element '${names[order.length]}' is not one of the columns given`);
      order.push(column);
    }
    const out = {};
    for (const c of columns) setField(out, c.name, null);
    for (const [i, text] of row) setField(out, order[i].name, textToValue(order[i].type, text));
    yield out;
  }
}

const EXPORTERS = { json: jsonPieces, csv: csvPieces, xml: xmlPieces };

/**
 * Writes an export: `write(text)` receives it in pieces. An export shape (docs/design/export-shapes.md) decides the
 * structure itself, so select/limit/offset belong in it.
 */
function exportTo(reader, format, options, write) {
  const exporter = EXPORTERS[format];
  if (!exporter) throw new JazminValidationError(`Unknown export format '${format}'`);
  const { filter, select, limit, offset, shape, ...formatOptions } = options ?? {};
  if (shape !== undefined) {
    if (select || limit !== undefined || offset !== undefined) throw new JazminValidationError('With a shape, use $rows/$limit in the shape instead of select, limit or offset');
    writeShape(reader, shape, format, { filter, ...formatOptions }, write);
    return;
  }
  const columns = select ? reader.columns.filter((c) => select.includes(c.name)) : reader.columns;
  for (const piece of exporter(columns, reader.find(filter, { select, limit, offset }), formatOptions)) write(piece);
}

/** Converts (optionally filtered) rows to a JSON / CSV / XML string. */
export function exportString(reader, format, options) {
  let out = '';
  exportTo(reader, format, options, (piece) => {
    out += piece;
  });
  return out;
}

/** Streams (optionally filtered) rows to a JSON / CSV / XML file with bounded memory. */
export function exportFile(reader, format, path, options) {
  const fd = fs.openSync(path, 'w');
  try {
    let buffer = '';
    exportTo(reader, format, options, (piece) => {
      buffer += piece;
      if (buffer.length >= 65536) {
        fs.writeSync(fd, buffer);
        buffer = '';
      }
    });
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

export { parseCsv, parseXml, parseJsonRows, readCsvRecords, readJsonObjects, readXmlRows };

/**
 * Drop-in counterpart of JSON.stringify / JSON.parse for arrays of records:
 *   const bytes = JAZMIN.stringify(rows, { key });
 *   const rows  = JAZMIN.parse(bytes, { key });
 */
export const JAZMIN = Object.freeze({
  stringify: (rows, options) => write(null, rows, options),
  parse: (bytes, options) => [...open(bytes, options).rows()],
});
