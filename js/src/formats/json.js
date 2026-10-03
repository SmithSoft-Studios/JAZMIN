import { JazminValidationError } from '../errors.js';
import { valueToJson } from './text.js';

/** Yields a JSON array of row objects piece by piece (so large files can be streamed). */
export function* jsonPieces(columns, rows, { omitNulls = false, pretty = false } = {}) {
  const names = columns.map((c) => JSON.stringify(c.name));
  const nl = pretty ? '\n' : '';
  const indent = pretty ? '  ' : '';
  const sep = pretty ? ': ' : ':';
  yield '[';
  let first = true;
  for (const row of rows) {
    const fields = [];
    columns.forEach((c, i) => {
      const value = row[c.name] ?? null;
      if (value === null && omitNulls) return;
      fields.push(`${names[i]}${sep}${valueToJson(c.type, value)}`);
    });
    yield `${first ? '' : ','}${nl}${indent}{${fields.join(pretty ? ', ' : ',')}}`;
    first = false;
  }
  yield `${first ? '' : nl}]`;
}

/** Parses JSON text (array of objects, or a single object) into row objects. */
export function parseJsonRows(input) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  const rows = Array.isArray(value) ? value : [value];
  rows.forEach((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new JazminValidationError(`JSON item ${i} is not an object`);
    }
  });
  return rows;
}
