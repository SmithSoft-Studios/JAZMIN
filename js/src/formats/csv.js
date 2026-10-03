import { JazminValidationError } from '../errors.js';
import { inferTextColumns, toObjects, valueToText } from './text.js';

// RFC 4180 CSV. Convention: an unquoted empty field is null; a quoted empty field ("") is an empty string.

function quote(text, delimiter) {
  if (text === '' || /["\r\n]/.test(text) || text.includes(delimiter) || text.trim() !== text) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function* csvPieces(columns, rows, { delimiter = ',', newline = '\r\n' } = {}) {
  yield columns.map((c) => quote(c.name, delimiter)).join(delimiter) + newline;
  for (const row of rows) {
    yield columns
      .map((c) => {
        const value = row[c.name] ?? null;
        return value === null ? '' : quote(valueToText(c.type, value), delimiter);
      })
      .join(delimiter) + newline;
  }
}

/** Parses CSV text into positional rows of strings/null. */
export function parseCsvRecords(text, delimiter = ',') {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  const endField = () => {
    record.push(quoted || field !== '' ? field : null);
    field = '';
    quoted = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === '' && !quoted) {
      inQuotes = true;
      quoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      endField();
      records.push(record);
      record = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (inQuotes) throw new JazminValidationError('CSV ends inside a quoted field');
  if (field !== '' || quoted || record.length > 0) {
    endField();
    records.push(record);
  }
  return records;
}

/** Parses CSV (first line = header) into { columns, rows }. */
export function parseCsv(text, { delimiter = ',', inferTypes = true } = {}) {
  const records = parseCsvRecords(text.replace(/^﻿/, ''), delimiter);
  if (records.length === 0) throw new JazminValidationError('CSV has no header row');
  const [header, ...data] = records;
  const names = header.map((h, i) => h ?? `column${i + 1}`);
  data.forEach((r, n) => {
    if (r.length > names.length) throw new JazminValidationError(`CSV line ${n + 2} has more fields than the header`);
  });
  const columns = inferTextColumns(names, data, inferTypes);
  return { columns, rows: toObjects(columns, data) };
}
