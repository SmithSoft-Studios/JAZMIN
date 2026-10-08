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

/** A column's type with its parts, as `list<object{sku: string?, qty: int}>` (a `?` marks a part that may be null). */
export function describeType(c) {
  const part = (p) => `${describeType(p)}${p.nullable ? '?' : ''}`;
  if (c.type === 'list') return `list<${part(c.item)}>`;
  if (c.type === 'object') return `object{${c.fields.map((f) => `${f.name}: ${part(f)}`).join(', ')}}`;
  return c.type;
}
