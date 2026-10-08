// Nested columns (spec 5.4, reader feature 'nested-columns'): list and object columns, whose items or fields are
// stored as columns of their own. A list column has an `item` definition, an object column its `fields`.
import { JazminValidationError } from './errors.js';

/** Lists and objects within one another, at most (deeper definitions are refused when written and when read). */
export const MAX_NESTING_DEPTH = 64;

export const isNested = (type) => type === 'list' || type === 'object';

const fail = (path, message) => new JazminValidationError(`Column '${path}': ${message}`);

/**
 * The parts of a list or object column, checked: `item` for a list, `fields` for an object (at least one, unique
 * names), at most 64 levels deep, never indexed. `normalize(definition, path)` checks and copies one part's own
 * settings (name, type, nullable...). Returns { item } or { fields }, or {} for other types.
 */
export function nestedParts(c, path, normalize, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) throw fail(path, `nested more than ${MAX_NESTING_DEPTH} levels deep`);
  const part = (d, name, at) => {
    if (d === null || typeof d !== 'object') throw fail(at, 'needs a definition (an object with a type)');
    if (d.index !== undefined && [].concat(d.index).length > 0) throw fail(at, 'items and fields cannot be indexed');
    const column = normalize({ ...d, name: d.name ?? name }, at);
    return { ...column, ...nestedParts(d, at, normalize, depth + 1) };
  };
  switch (c.type) {
    case 'list':
      if (c.item === undefined || c.item === null) throw fail(path, 'a list needs an item');
      if (c.fields !== undefined) throw fail(path, 'a list has an item, not fields');
      return { item: part(c.item, 'item', `${path}[]`) };
    case 'object': {
      if (!Array.isArray(c.fields) || c.fields.length === 0) throw fail(path, 'an object needs at least one field');
      if (c.item !== undefined) throw fail(path, 'an object has fields, not an item');
      const names = new Set();
      return {
        fields: c.fields.map((f) => {
          if (!f || typeof f.name !== 'string' || f.name === '') throw fail(path, 'every field needs a non-empty name');
          if (names.has(f.name)) throw fail(path, `duplicate field '${f.name}'`);
          names.add(f.name);
          return part(f, f.name, `${path}.${f.name}`);
        }),
      };
    }
    default:
      if (c.item !== undefined || c.fields !== undefined) throw fail(path, 'only lists have an item and only objects have fields');
      return {};
  }
}

/**
 * Why `grown` is not `column` with fields added at the end of its objects (fields that may be null), or null when it
 * is: the only change a nested column's definition may have when rows are appended (spec 5.4).
 */
export function notGrown(column, grown, path) {
  if (grown.type !== column.type) return `Column '${path}': a ${column.type} cannot become a ${grown.type}`;
  if (grown.nullable !== column.nullable) return `Column '${path}': whether it may be null cannot change`;
  if (column.type === 'list') return notGrown(column.item, grown.item, `${path}[]`);
  if (column.type !== 'object') return null;
  if (grown.fields.length < column.fields.length) return `Column '${path}': fields cannot be removed (rewrite the file to change its fields)`;
  for (let i = 0; i < column.fields.length; i++) {
    if (grown.fields[i].name !== column.fields[i].name) return `Column '${path}': fields cannot be renamed or reordered; new fields go at the end`;
    const why = notGrown(column.fields[i], grown.fields[i], `${path}.${column.fields[i].name}`);
    if (why) return why;
  }
  for (let i = column.fields.length; i < grown.fields.length; i++) {
    if (!grown.fields[i].nullable) return `Column '${path}.${grown.fields[i].name}': a field added later must allow null (rows written before have none)`;
  }
  return null;
}

/**
 * A table's columns with nested columns given fields (spec 5.4): `given` holds their new definitions (checked with
 * `normalize`, then against the old ones). The other columns are as they were.
 */
export function growColumns(columns, given, normalize) {
  if (given === undefined) return { columns, grown: new Set() };
  if (!Array.isArray(given)) throw new JazminValidationError('columns must be an array of column definitions');
  const result = [...columns];
  const grown = new Set();
  for (const definition of given) {
    const i = result.findIndex((c) => c.name === definition?.name);
    if (i < 0) throw new JazminValidationError(`columns: unknown column '${definition?.name}'`);
    if (!isNested(result[i].type)) throw new JazminValidationError(`columns: '${definition.name}' is not a list or object column; only those can be given fields`);
    const [checked] = normalize([{ ...definition, index: undefined }]);
    const why = notGrown(result[i], checked, definition.name);
    if (why) throw new JazminValidationError(why);
    result[i] = { ...checked, index: result[i].index };
    grown.add(definition.name);
  }
  return { columns: result, grown };
}

/** A column's type with its parts, as `list<object{sku: string?, qty: int}>` (a `?` marks a part that may be null). */
export function describeType(c) {
  const part = (p) => `${describeType(p)}${p.nullable ? '?' : ''}`;
  if (c.type === 'list') return `list<${part(c.item)}>`;
  if (c.type === 'object') return `object{${c.fields.map((f) => `${f.name}: ${part(f)}`).join(', ')}}`;
  return c.type;
}
