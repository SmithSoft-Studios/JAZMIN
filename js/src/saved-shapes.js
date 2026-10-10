// Saved export shapes (spec 6.8, docs/design/saved-shapes.md): named shapes kept in a file's directories, each
// listed only for keys that can use all of it.
import { JazminValidationError } from './errors.js';
import { EVERYONE } from './files.js';
import { compileShape } from './shape.js';

export const MAX_SHAPES = 1000;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const MEMBERS = new Set(['name', 'shape', 'description', 'default', 'table', 'groups']);

/**
 * One saved shape as given: { name, shape, description?, default?, table?, groups? }. `table` is the table the shape
 * reads (default: the file's first); `groups` the file groups whose keys see it (default '*', everyone).
 */
export function normalizeShape(s, where = 'shape') {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new JazminValidationError(`${where} must be an object`);
  for (const k of Object.keys(s)) if (!MEMBERS.has(k)) throw new JazminValidationError(`${where}: unknown member '${k}' (name, shape, description, default, table, groups)`);
  const { name, shape, description, default: isDefault, table, groups } = s;
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) throw new JazminValidationError(`${where}: name must be text of 1 to ${MAX_NAME} characters`);
  const label = `Saved shape '${name}'`;
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(shape)); // stored as JSON: what a reader gets back
  } catch (error) {
    throw new JazminValidationError(`${label}: the shape must be JSON (${error.message})`);
  }
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) throw new JazminValidationError(`${label}: the shape must be an object`);
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION)) {
    throw new JazminValidationError(`${label}: description must be text of at most ${MAX_DESCRIPTION} characters`);
  }
  if (isDefault !== undefined && typeof isDefault !== 'boolean') throw new JazminValidationError(`${label}: default must be true or false`);
  if (table !== undefined && (typeof table !== 'string' || table === '')) throw new JazminValidationError(`${label}: table must name a table`);
  return {
    name, ...(description ? { description } : {}), ...(isDefault ? { default: true } : {}), ...(table === undefined ? {} : { table }),
    groups: shapeGroups(groups, label), shape: copy,
  };
}

/** The file groups whose keys see a shape: '*' (everyone) or names, as for embedded files. */
function shapeGroups(groups, label) {
  if (groups === undefined || groups === EVERYONE) return [EVERYONE];
  if (!Array.isArray(groups) || groups.length === 0) throw new JazminValidationError(`${label}: groups must be '*' or a non-empty array`);
  const names = [...new Set(groups.map((g) => String(g)))];
  for (const g of names) if (g.length === 0 || g.length > 256) throw new JazminValidationError(`${label}: invalid group name '${g}'`);
  return names.includes(EVERYONE) ? [EVERYONE] : names.sort();
}

/** The `shapes` option: a list of saved shapes, names unique, at most one default in each group. */
export function normalizeShapes(list, what = 'shapes') {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new JazminValidationError(`${what} must be an array`);
  const shapes = list.map((s, n) => normalizeShape(s, `${what}[${n}]`));
  checkShapeList(shapes);
  return shapes;
}

/** Names unique, at most one default in each group, at most MAX_SHAPES. */
export function checkShapeList(shapes) {
  if (shapes.length > MAX_SHAPES) throw new JazminValidationError(`A file keeps at most ${MAX_SHAPES} saved shapes`);
  const names = new Set();
  const defaults = new Map();
  for (const s of shapes) {
    if (names.has(s.name)) throw new JazminValidationError(`Saved shape '${s.name}' is given twice`);
    names.add(s.name);
    if (!s.default) continue;
    for (const g of s.groups) {
      if (defaults.has(g)) throw new JazminValidationError(`Saved shapes '${defaults.get(g)}' and '${s.name}' are both the default for ${g === EVERYONE ? 'everyone' : `group '${g}'`}`);
      defaults.set(g, s.name);
    }
  }
}

/**
 * Checks saved shapes against the file's tables, `tables` [{ name, groups: [{ name, columns }] }] (the first table
 * first), and in shared files against the columns of every key that sees them: `viewers` [{ who, columns: '*' or a
 * Set of column-group names, sees(fileGroup) }]. Throws naming the shape, the key and the mistake.
 */
export function checkShapes(shapes, tables, viewers = null) {
  if (!shapes.length) return;
  const byName = new Map(tables.map((t) => [t.name, t]));
  const fit = (s, visible) => {
    const columnsOf = (name) => byName.get(name)?.groups.filter((g) => visible === '*' || visible.has(g.name)).flatMap((g) => g.columns);
    compileShape(columnsOf(s.table ?? tables[0].name), s.shape, columnsOf);
  };
  const seen = new Map(); // shape and column groups -> the mistake, or null: keys with the same columns are checked once
  for (const s of shapes) {
    if (s.table !== undefined && !byName.has(s.table)) throw new JazminValidationError(`Saved shape '${s.name}': unknown table '${s.table}'`);
    try {
      fit(s, '*');
    } catch (error) {
      throw new JazminValidationError(`Saved shape '${s.name}': ${error.message}`);
    }
    for (const v of viewers ?? []) {
      const group = s.groups.find((g) => v.sees(g));
      if (group === undefined) continue;
      const id = `${s.name}\u0000${v.columns === '*' ? '*' : [...v.columns].sort().join('\u0001')}`;
      if (!seen.has(id)) {
        try {
          fit(s, v.columns);
          seen.set(id, null);
        } catch (error) {
          seen.set(id, error.message);
        }
      }
      const mistake = seen.get(id);
      if (mistake) {
        const why = group === EVERYONE ? 'a shape for everyone' : `file group '${group}'`;
        throw new JazminValidationError(`Saved shape '${s.name}' doesn't fit access key ${v.who}, which sees it (${why}): ${mistake}`);
      }
    }
  }
}

/** A file directory's saved shapes (spec 6.8): its well-formed entries. Readers ignore others, as other members. */
export function directoryShapes(directory) {
  if (!Array.isArray(directory.shapes)) return [];
  return directory.shapes.filter((s) => s !== null && typeof s === 'object' && typeof s.name === 'string' && s.name !== ''
    && s.shape !== null && typeof s.shape === 'object' && !Array.isArray(s.shape)
    && (s.description === undefined || typeof s.description === 'string') && (s.default === undefined || typeof s.default === 'boolean')
    && (s.table === undefined || typeof s.table === 'string')
    && (s.groups === undefined || (Array.isArray(s.groups) && s.groups.every((g) => typeof g === 'string'))));
}

/** A table's column groups as the owner (or a single key) sees them, for checking shapes: { name, groups }. */
export function tableColumns(reader) {
  const columns = reader.columns;
  const groupColumns = reader.access?.groupColumns;
  if (!groupColumns) return { name: reader.table, groups: [{ name: EVERYONE, columns }] };
  const byName = new Map(columns.map((c) => [c.name, c]));
  return { name: reader.table, groups: Object.entries(groupColumns).map(([name, names]) => ({ name, columns: names.map((n) => byName.get(n)) })) };
}

/** Does the shape fit the columns this reader sees, in every table it reads? `columnsOf(table)`: a table's columns. */
export function shapeFits(saved, firstTable, columnsOf) {
  const columns = columnsOf(saved.table ?? firstTable);
  if (!columns) return false;
  try {
    compileShape(columns, saved.shape, columnsOf);
    return true;
  } catch {
    return false;
  }
}

/** The saved shapes a change keeps: the file's, less those removed by name or given again. */
export function keptShapes(existing, addShapes, removeShapes) {
  const kept = new Map(existing.map((s) => [s.name, s]));
  for (const name of removeShapes) if (!kept.delete(name)) throw new JazminValidationError(`removeShapes: no saved shape '${name}'`);
  for (const s of addShapes) kept.delete(s?.name);
  return [...kept.values()];
}
