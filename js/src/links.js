// Links between a file's tables (docs/design/table-links.md): declared once, kept in the file's metadata under
// `jazmin.links` (names, tables and columns only, never values), so every tool knows them; and checked against the rows.
// No format change: readers that don't know the key ignore it.
import { JazminValidationError } from './errors.js';
import { compareKeys, keyId, normalizeValue, toKey } from './types.js';

export const LINKS_KEY = 'jazmin.links';

const names = (list, what) => {
  if (!Array.isArray(list) || list.length === 0 || list.some((n) => typeof n !== 'string' || n === '')) {
    throw new JazminValidationError(`${what}: a non-empty list of column names`);
  }
  return [...list];
};

/** Links as given, checked for their shape: [{ name, from: { table, columns }, to: { table, columns } }]. */
export function normalizeLinks(links) {
  if (links === null || links === undefined) return [];
  if (!Array.isArray(links)) throw new JazminValidationError('links must be an array of { name, from: { table, columns }, to: { table, columns } }');
  const seen = new Set();
  return links.map((link, i) => {
    if (!link || typeof link !== 'object') throw new JazminValidationError(`links[${i}] must be an object`);
    const { name, from, to } = link;
    if (typeof name !== 'string' || name === '') throw new JazminValidationError(`links[${i}] needs a name`);
    if (seen.has(name)) throw new JazminValidationError(`Link '${name}' is declared twice`);
    seen.add(name);
    const side = (s, what) => {
      if (!s || typeof s !== 'object' || typeof (s.table ?? '') !== 'string') throw new JazminValidationError(`Link '${name}': ${what} needs { table, columns }`);
      return { table: s.table ?? '', columns: names(s.columns, `Link '${name}': ${what}.columns`) };
    };
    const out = { name, from: side(from, 'from'), to: side(to, 'to') };
    if (out.from.columns.length !== out.to.columns.length) throw new JazminValidationError(`Link '${name}': from and to need as many columns`);
    return out;
  });
}

/** The links a file declares (its metadata's `jazmin.links`); a malformed list reads as none. */
export function readLinks(metadata) {
  try {
    return normalizeLinks(metadata?.[LINKS_KEY] ?? []);
  } catch {
    return [];
  }
}

/** Checks links against the tables (`tables`: name -> columns): each table and column exists, and types are equal. */
export function checkLinkDefinitions(links, tables) {
  for (const link of links) {
    for (const [what, side] of [['from', link.from], ['to', link.to]]) {
      const columns = tables.get(side.table);
      if (!columns) throw new JazminValidationError(`Link '${link.name}': ${what} table '${side.table}' isn't in the file`);
      for (const c of side.columns) {
        if (!columns.some((x) => x.name === c)) throw new JazminValidationError(`Link '${link.name}': table '${side.table}' has no column '${c}'`);
      }
    }
    link.from.columns.forEach((c, i) => {
      const a = tables.get(link.from.table).find((x) => x.name === c);
      const b = tables.get(link.to.table).find((x) => x.name === link.to.columns[i]);
      if (a.type !== b.type) throw new JazminValidationError(`Link '${link.name}': ${link.from.table}.${c} is ${a.type} but ${link.to.table}.${b.name} is ${b.type}`);
    });
  }
  return links;
}

/** Links after tables are renamed; a link that uses a removed table is refused. */
export function linksAfter(links, { removed, names: renamed }) {
  return links.map((link) => {
    for (const side of [link.from, link.to]) {
      if (removed.has(side.table)) throw new JazminValidationError(`Link '${link.name}' uses table '${side.table}', which is being removed: change the links too (links)`);
    }
    const rename = (t) => renamed.get(t) ?? t;
    return { ...link, from: { ...link.from, table: rename(link.from.table) }, to: { ...link.to, table: rename(link.to.table) } };
  });
}

function compareTuples(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return -1;
    if (b[i] === null) return 1;
    const c = compareKeys(a[i], b[i]);
    if (c !== 0) return Number.isNaN(c) ? 0 : c;
  }
  return 0;
}

const shown = (v) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v);

/**
 * Each declared link checked against the rows this reader sees: { name, from, to, rows, empty, missing, examples,
 * duplicateTargets, duplicateExamples, method }. `missing` counts rows whose link finds nothing (rows with an empty key
 * are `empty`, not missing); `duplicateTargets` counts target keys that repeat (a link should find one row). Tables
 * sorted by their link columns are walked side by side (method 'merge', little memory); otherwise the target's keys
 * are held (method 'hash'). Only the link columns are read.
 */
export function checkLinks(reader, { limit = 10, links = reader.links } = {}) {
  return links.map((link) => {
    // A reader for each side (cheap: they share the open file), so a link within one table reads it twice safely.
    const from = reader.openTable(link.from.table);
    const to = reader.openTable(link.to.table);
    try {
      const typeOf = (r, cols) => cols.map((c) => r.columns.find((x) => x.name === c)?.type);
      const fromTypes = typeOf(from, link.from.columns);
      const toTypes = typeOf(to, link.to.columns);
      const keyOf = (row, cols, types) => cols.map((c, i) => {
        const v = normalizeValue(types[i], row[c], c);
        return v === null ? null : toKey(types[i], v);
      });
      // A key's identity for the set of target keys: the value itself for one column (the usual link), else text.
      const id = link.to.columns.length === 1
        ? (key) => keyId(key[0])
        : (key) => JSON.stringify(key.map((k) => { const v = keyId(k); return typeof v === 'bigint' ? `${v}n` : v; }));
      const valuesOf = (row, cols) => cols.map((c) => shown(row[c])); // examples as the rows hold them
      const result = { name: link.name, from: link.from, to: link.to, rows: 0, empty: 0, missing: 0, examples: [], duplicateTargets: 0, duplicateExamples: [], method: 'hash' };
      const noteMissing = (row) => {
        result.missing++;
        if (result.examples.length < limit) result.examples.push(valuesOf(row, link.from.columns));
      };
      const noteDuplicate = (row) => {
        result.duplicateTargets++;
        if (result.duplicateExamples.length < limit) result.duplicateExamples.push(valuesOf(row, link.to.columns));
      };
      const prefix = (sorted, cols) => cols.every((c, i) => sorted?.[i] === c);
      const fromRows = from.rows({ select: link.from.columns });
      const toRows = to.rows({ select: link.to.columns });
      if (prefix(from.sortedBy, link.from.columns) && prefix(to.sortedBy, link.to.columns)) {
        // Both in link order: one pass over each, side by side.
        result.method = 'merge';
        let target = toRows.next();
        let targetKey = target.done ? null : keyOf(target.value, link.to.columns, toTypes);
        let repeated = null; // the last target key counted as repeating
        const advance = () => {
          const before = targetKey;
          target = toRows.next();
          targetKey = target.done ? null : keyOf(target.value, link.to.columns, toTypes);
          if (targetKey && compareTuples(targetKey, before) === 0 && !(repeated && compareTuples(repeated, targetKey) === 0)) {
            noteDuplicate(target.value);
            repeated = targetKey;
          }
        };
        for (const row of fromRows) {
          result.rows++;
          const key = keyOf(row, link.from.columns, fromTypes);
          if (key.some((v) => v === null)) {
            result.empty++;
            continue;
          }
          while (targetKey && compareTuples(targetKey, key) < 0) advance();
          if (!targetKey || compareTuples(targetKey, key) !== 0) noteMissing(row);
        }
        while (targetKey) advance(); // the rest of the targets, for repeats
      } else {
        const keys = new Set();
        const repeated = new Set();
        for (const row of toRows) {
          const k = id(keyOf(row, link.to.columns, toTypes));
          if (keys.has(k)) {
            if (!repeated.has(k)) {
              repeated.add(k);
              noteDuplicate(row);
            }
          } else keys.add(k);
        }
        for (const row of fromRows) {
          result.rows++;
          const key = keyOf(row, link.from.columns, fromTypes);
          if (key.some((v) => v === null)) result.empty++;
          else if (!keys.has(id(key))) noteMissing(row);
        }
      }
      return result;
    } finally {
      from.close();
      to.close();
    }
  });
}
