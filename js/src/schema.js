import { JazminValidationError } from './errors.js';
import { INDEX_KINDS, TYPES } from './types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Validates column definitions and returns normalized copies:
 *   { name, type, nullable, description?, attributes?, index: string[] }
 */
/**
 * Sets the field `name` of an object built from column names. A column may be named `__proto__`: plain assignment
 * would set the object's prototype instead of adding a field (issue #68).
 */
export function setField(target, name, value) {
  if (name === '__proto__') Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
  else target[name] = value;
}

export function normalizeColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) throw new JazminValidationError('At least one column is required');
  const seen = new Set();
  return columns.map((c) => {
    if (!c || typeof c.name !== 'string' || c.name.length === 0) throw new JazminValidationError('Every column needs a non-empty name');
    if (seen.has(c.name)) throw new JazminValidationError(`Duplicate column '${c.name}'`);
    seen.add(c.name);
    if (!TYPES.includes(c.type)) throw new JazminValidationError(`Column '${c.name}' has unknown type '${c.type}'`);
    const index = c.index === undefined ? [] : [].concat(c.index);
    for (const kind of index) {
      if (!INDEX_KINDS[kind]) throw new JazminValidationError(`Column '${c.name}': unknown index kind '${kind}'`);
      if (!INDEX_KINDS[kind].has(c.type)) throw new JazminValidationError(`Column '${c.name}': a ${kind} index is not supported on ${c.type}`);
    }
    const column = { name: c.name, type: c.type, nullable: c.nullable !== false, index: [...new Set(index)] };
    if (c.description !== undefined) column.description = String(c.description);
    if (c.attributes !== undefined) column.attributes = c.attributes;
    return column;
  });
}

function typeOf(value, detectDates) {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return detectDates && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) ? 'datetime' : 'string';
  if (value instanceof Date) return 'datetime';
  if (value instanceof Uint8Array) return 'binary';
  return 'json';
}

function merge(a, b) {
  if (a === undefined || a === b) return b;
  if ((a === 'int' && b === 'float') || (a === 'float' && b === 'int')) return 'float';
  if ((a === 'datetime' && b === 'string') || (a === 'string' && b === 'datetime')) return 'string';
  return 'json'; // mixed types are preserved exactly as JSON
}

/**
 * Infers a schema from an array of plain objects. Columns appear in first-seen order;
 * a column is nullable when any row omits it or holds null.
 */
export function inferSchema(rows, { detectDates = false } = {}) {
  const found = new Map();
  let count = 0;
  for (const row of rows) {
    count++;
    for (const [name, value] of Object.entries(row)) {
      let info = found.get(name);
      if (!info) found.set(name, (info = { type: undefined, present: 0, nullable: count > 1 }));
      if (value === null || value === undefined) {
        info.nullable = true;
        continue;
      }
      info.present++;
      info.type = merge(info.type, typeOf(value, detectDates));
    }
  }
  return [...found.entries()].map(([name, info]) => ({
    name,
    type: info.type ?? 'string',
    nullable: info.nullable || info.present < count,
  }));
}
