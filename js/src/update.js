import crypto from 'node:crypto';
import fs from 'node:fs';
import { JazminError, JazminKeyError, JazminValidationError } from './errors.js';
import { growColumns } from './nested.js';
import { keptShapes } from './saved-shapes.js';
import { normalizeColumns } from './schema.js';
import { compileFilter } from './filter.js';
import { grantExpiry, toMs } from './expiry.js';
import { JazminAccessKey, parseAnyKey } from './keys.js';
import { FILE_SOURCE } from './files.js';
import { COMPACT_INDEXES, FILE_STATE, JazminReader, OWNER_GRANTS, OWNER_LOCKS, ROWS_BY_PARTITION, checkWriterFeatures } from './reader.js';
import { INDEX_KINDS, keyId, normalizeValue, toKey } from './types.js';
import { withLock } from './lock.js';
import { RowSorter, SORT_RUN_ROWS } from './sort-rows.js';
import { normalizeOrder, orderComparer, orderKeyMaker } from './sort-keys.js';
import { linksAfter } from './links.js';
import { JazminWriter, KEPT_LOCKS, PROGRESS_TOTAL } from './writer.js';

/**
 * Atomically replaces `path` with `temp`: readers never see a half-written file. Readers that have the file open keep
 * reading the version they opened.
 */
export function replaceFile(temp, path) {
  try {
    fs.chmodSync(temp, fs.statSync(path).mode & 0o7777); // the new version keeps the file's permissions
    fs.renameSync(temp, path);
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) replaceOpenFile(temp, path);
    else throw error;
  }
}

/**
 * Windows refuses to replace a file that is open (W-1), but readers open files so that they may be renamed: the open
 * file is moved aside, the new version takes its place, and the old one is deleted (readers keep it until they close
 * it). Node has no single-step way to do this, so for an instant the path is missing; if the new version can't take
 * its place, the old one is put back.
 */
function replaceOpenFile(temp, path) {
  const aside = `${path}.${crypto.randomBytes(6).toString('hex')}.old`;
  try {
    fs.renameSync(path, aside);
  } catch {
    throw new JazminError(`Cannot replace ${path}: another program has it open and doesn't allow it to be renamed. `
      + 'Close that program and retry, or use append(), which works while the file is open.');
  }
  try {
    fs.renameSync(temp, path);
  } catch (error) {
    fs.renameSync(aside, path);
    throw error;
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // Not deleted now: the new version is in place, and the old one is only a leftover.
  }
}

function keyText(value) {
  return typeof value === 'bigint' ? `${value}n` : value;
}

/**
 * Applies changes to an existing file by streaming it into a new version and atomically
 * replacing the original (spec section 11.1). Memory is bounded by the size of the change
 * set, not the file. Indexes, sort order, metadata and access grants are carried over;
 * every new version gets fresh secrets, so revoked keys cannot read it.
 *
 * options:
 *   key | password      required for encrypted files; the OWNER key for access-controlled files
 *   insert: rows        new rows
 *   upsert: rows        replace rows whose keyColumns match, insert the rest
 *   keyColumns: [...]   columns identifying a row for upsert
 *   delete: filter      remove matching rows
 *   metadata: {...}     merged into the existing metadata
 *   grant: [{ key, rows, columns, label }], revoke: [accessKey]   (access-controlled files)
 *   codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority   output settings (defaults as for a new file)
 *   compactIndexes      sorted indexes with keys as differences (default: as the file has them)
 *   addFiles, removeFiles, package        embedded files: add or replace, remove (by path), viewer settings
 *   locks: { id: { password, online, iterations } | null }   locks of stored files (shared files, spec 6.8.1): add one,
 *                       change one (a new password; an online lock keeps its secret), or remove one (null: its files stay,
 *                       unlocked); the file's other locks are kept
 *   addShapes, removeShapes               saved export shapes: add or replace, remove (by name)
 *   indexes: { column: kinds }  the indexes a column has afterwards ('sorted', 'trigram', both, or [] for none);
 *                       columns not named keep theirs (the table being updated). The first sortedBy column keeps no
 *                       sorted index: the sort order already finds its values. Re-sorted away from it, the old first
 *                       sort column gets a sorted index, unless named here
 *   sortedBy: [...]     a new sort order (null: none): every row is put in it, within a memory budget (sortRunRows
 *                       rows at a time, by priority; more go through temporary files locked with a key of their own)
 *   addTables: [{ name, columns, sortedBy, partitionBy, columnGroups, chunkRows, chunkBytes, rows }]   new tables,
 *                       written after the others; rows is any iterable (put in sortedBy's order within the budget)
 *   removeTables: [...] tables to leave out; renameTables: { old: new }   (saved shapes, package.edit and links follow)
 *   links: [{ name, from: { table, columns }, to: { table, columns } }]   the links between tables (replaces the file's;
 *                       [] for none); without it the file's links are kept, following renames
 *
 *   set: { column: value }, where: filter   those columns set on the rows the filter matches ({} for every row);
 *                       rows whose sort columns change move to their place; a shared file's partition column stays
 *   tables: { name: { insert, upsert, keyColumns, delete, set, where, indexes, sortedBy } }   other tables' changes, in
 *                       the same rewrite (the options above change the main table, `table`)
 *
 * Returns { rowCount, inserted, updated (upserted rows that replaced one, and rows set), deleted }; with `tables`, also
 * tables: { name: { rowCount, inserted, updated, deleted } }.
 */
export function update(path, options = {}) {
  return withLock(path, () => updateUnlocked(path, options));
}

/** Columns of an open file with their index kinds, as writer column definitions. */
export function columnsWithIndexes(reader) {
  const indexKinds = new Map();
  for (const ix of reader.indexes) indexKinds.set(ix.column, [...(indexKinds.get(ix.column) ?? []), ix.kind]);
  return reader.columns.map((c) => ({ ...c, index: indexKinds.get(c.name) ?? [] }));
}

/** Internal (rotateOwnerKey): { key, grants(grants) } - the new owner key, and the grants it writes instead. */
export const NEW_OWNER = Symbol('jazmin.newOwner');

/** update() without taking the file lock (the caller holds it). */
/** Column types whose values are single values (not nested lists or objects). */
const SCALAR_TYPES = new Set(['bool', 'int', 'float', 'decimal', 'string', 'datetime', 'binary', 'json']);

/** The changes a table can be given (the top-level options for the main table; `tables` for others). */
const CHANGE_KEYS = ['insert', 'upsert', 'keyColumns', 'delete', 'set', 'where', 'indexes', 'sortedBy', 'columns'];
const changesOf = (source) => Object.fromEntries(CHANGE_KEYS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
/** Whether changes change anything (empty lists don't). */
const anyChanges = (c) => Boolean(c.insert?.length || c.upsert?.length || c.delete || c.set || c.sortedBy !== undefined || c.indexes || c.columns);

export function updateUnlocked(path, options = {}) {
  const {
    key, password, metadata,
    grant = [], revoke = [], codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority, compactIndexes, now, layout,
    addFiles = [], removeFiles = [], package: packageSettings, table, regroup = false, addShapes = [], removeShapes = [],
    sortRunRows, addTables = [], removeTables = [], renameTables = {}, links, tables: tableChanges, onProgress, signal, locks,
  } = options;
  signal?.throwIfAborted();
  if (tableChanges !== undefined && (tableChanges === null || typeof tableChanges !== 'object' || Array.isArray(tableChanges))) {
    throw new JazminValidationError('tables: { tableName: { insert, upsert, keyColumns, delete, set, where, indexes, sortedBy } }');
  }

  const reader = new JazminReader(path, { key, password, table });
  const readers = [reader]; // in a file with several tables, one per table, in file order
  const temp = `${path}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let writer;
  const sorters = []; // rows put in a new sort order within a memory budget, closed at the end
  try {
    checkWriterFeatures(reader);
    const owner = reader[OWNER_GRANTS];
    if (!owner && reader.access) throw new JazminKeyError("Only the file owner's master key can modify this file");
    if (!owner && (grant.length || revoke.length)) throw new JazminValidationError('grant/revoke apply only to access-controlled files');
    const newOwner = options[NEW_OWNER];
    if (newOwner && !owner) throw new JazminValidationError('The file is not access-controlled: use rotateKey() to change its key');
    if (reader.tables.length > 1) {
      readers.length = 0;
      for (const name of reader.tables) readers.push(name === reader.table ? reader : new JazminReader(path, { key, password, table: name }));
    }

    // The tables afterwards: those kept (renamed as asked), then those added.
    const tablePlan = planTables(reader.tables.length ? reader.tables : [reader.table], { addTables, removeTables, renameTables, owner: Boolean(owner) });
    const kept = readers.filter((r) => !tablePlan.removed.has(r.table));
    const finalName = (name) => tablePlan.names.get(name) ?? name;

    // Each table's changes: the main table's from the options, others' from `tables` (one rewrite for them all).
    const changes = new Map([[reader.table, changesOf(options)]]);
    for (const [name, given] of Object.entries(tableChanges ?? {})) {
      if (!readers.some((r) => r.table === name)) throw new JazminValidationError(`tables: the file has no table '${name}'`);
      if (name === reader.table && anyChanges(changes.get(name))) throw new JazminValidationError(`tables: give table '${name}''s changes either in tables or with the other options, not both`);
      if (given === null || typeof given !== 'object') throw new JazminValidationError(`tables: '${name}' needs an object of changes`);
      changes.set(name, changesOf(given));
    }
    for (const [name, c] of changes) {
      if (tablePlan.removed.has(name) && anyChanges(c)) throw new JazminValidationError(`Table '${name}' is being removed: its rows can't change too`);
    }
    // Progress: the rows of the tables kept and added; rows sorted ('sort') and written ('write') count towards it.
    const totalRows = onProgress
      ? kept.reduce((n, r) => n + r.rowCount, 0) + addTables.reduce((n, t) => n + (Array.isArray(t.rows) ? t.rows.length : 0), 0)
      : null;
    let sortedRows = 0;
    const onSorted = onProgress || signal ? (n) => {
      signal?.throwIfAborted();
      sortedRows += n;
      onProgress?.({ stage: 'sort', done: sortedRows, total: totalRows });
    } : null;
    const context = {
      owner, sortRunRows, priority, codec, level, maxDegreeOfParallelism, onSorted,
      track: (sorter) => { sorters.push(sorter); return sorter; },
    };
    const plans = new Map(kept.filter((r) => changes.has(r.table)).map((r) => [r, planTableChanges(r, changes.get(r.table), { ...context, regroup: r === reader && regroup })]));
    const mainPlan = plans.get(reader);

    // The other tables of the file are copied as they are: a new version has fresh secrets throughout (spec 7.6.7).
    let access = owner ? accessFor(owner, grant, revoke) : undefined;
    if (newOwner) access = { ...access, grants: newOwner.grants(access.grants) };
    // Named tables (several, or one with a name) are written as tables, which keeps their names.
    const named = kept.length + addTables.length > 1 || kept.some((r) => finalName(r.table) !== '') || addTables.length > 0;
    writer = new JazminWriter(temp, {
      ...(named
        ? {
          tables: [
            ...kept.map((r) => ({
              name: finalName(r.table), columns: plans.get(r)?.columns ?? columnsWithIndexes(r), sortedBy: plans.has(r) ? plans.get(r).sortedBy : r.sort ?? r.sortedBy,
              ...(owner ? tableLayout(r[OWNER_GRANTS]) : {}),
            })),
            ...addTables.map((t) => ({
              name: t.name, columns: t.columns, sortedBy: t.sortedBy, chunkRows: t.chunkRows, chunkBytes: t.chunkBytes,
              ...(owner ? { partitionBy: t.partitionBy, columnGroups: t.columnGroups } : {}),
            })),
          ],
        }
        : { columns: mainPlan.columns, sortedBy: mainPlan.sortedBy }),
      metadata: { ...reader.metadata, ...(metadata ?? {}) },
      codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority, layout,
      compactIndexes: compactIndexes ?? reader[COMPACT_INDEXES],
      key: newOwner ? newOwner.key : key, password, kdfIterations: reader.kdfIterations, onProgress, signal, [PROGRESS_TOTAL]: totalRows,
      access: access && named ? { grants: access.grants } : access,
      now, // expired grants are dropped, and the new version's fresh secrets lock them out
      files: [...carriedFiles(reader, addFiles, removeFiles, locks), ...addFiles],
      // The file's locks, changed by those given (the writer refuses locks in a file that is not shared).
      ...(locks !== undefined ? { locks } : {}),
      ...(owner ? { [KEPT_LOCKS]: [...reader[OWNER_LOCKS].values()] } : {}),
      package: packageAfter(packageSettings !== undefined ? packageSettings : reader.package, tablePlan),
      shapes: [...keptShapes(reader[FILE_STATE]?.shapes ?? [], addShapes, removeShapes).map((shape) => shapeAfter(shape, tablePlan)), ...addShapes],
      // The links: as given, or the file's, following renames (checked against the tables by the writer).
      ...(links !== undefined || reader.links.length ? { links: links !== undefined ? links : linksAfter(reader.links, tablePlan) } : {}),
    });

    let stats = { rowCount: 0, inserted: 0, updated: 0, deleted: 0 };
    const tableStats = {};
    let first = true;
    for (const r of kept) {
      if (!first) writer.startTable(finalName(r.table));
      first = false;
      const plan = plans.get(r);
      if (plan) {
        const done = plan.write(writer);
        tableStats[finalName(r.table)] = done;
        if (r === reader) stats = done;
      } else {
        for (const row of r.rows()) writer.writeRow(row);
      }
    }
    // Added tables: their rows as given, or put in their sortedBy's order within the memory budget.
    for (const t of addTables) {
      if (!first) writer.startTable(t.name);
      first = false;
      if (!t.sortedBy) {
        for (const row of t.rows ?? []) writer.writeRow(row);
        continue;
      }
      const sorter = context.track(new RowSorter(normalizeColumns(t.columns), t.sortedBy, sorterOptions(context, Array.isArray(t.rows) ? t.rows.length : 0)));
      for (const row of t.rows ?? []) sorter.add(row);
      for (const row of sorter.rows()) writer.writeRow(row);
      sorter.close();
    }

    for (const r of readers) r.close();
    for (const s of sorters) s.close();
    writer.finish();
    signal?.throwIfAborted(); // the last moment a stop leaves the file as it was
    replaceFile(temp, path);
    return { ...stats, expiredGrantsRemoved: writer.expiredGrants, ...(tableChanges !== undefined ? { tables: tableStats } : {}) };
  } catch (error) {
    writer?.abort();
    for (const r of readers) r.close();
    for (const s of sorters) s.close();
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Sorted runs merged at once at most: each open run holds a decoded chunk, so 25,000,000 rows in runs of 10,000 (2,500
 * runs) held about 1.6 GB while merging. With the rows to come known, runs are made long enough to stay within it.
 */
const MAX_SORT_RUNS = 256;

const sorterOptions = ({ sortRunRows, priority, codec, level, maxDegreeOfParallelism, onSorted }, rows = 0) => ({
  runRows: sortRunRows ?? Math.max(SORT_RUN_ROWS[priority ?? 'balanced'] ?? SORT_RUN_ROWS.balanced, Math.ceil(rows / MAX_SORT_RUNS)),
  writeOptions: { codec, level, maxDegreeOfParallelism, priority },
  onSorted,
});

/**
 * One table's changes, planned: its columns and sort order afterwards, and `write(writer)`, which writes its rows with
 * the changes applied and returns { rowCount, inserted, updated, deleted }. Changes: insert, upsert + keyColumns,
 * delete (a filter), set + where (columns set on the rows a filter matches), indexes, sortedBy, columns (nested fields).
 */
function planTableChanges(reader, changes, context) {
  const { insert = [], upsert = [], keyColumns, delete: deleteWhere, set, where, indexes, sortedBy: newSortedBy, columns: given } = changes;
  const { owner, regroup } = context;
  const name = reader.table ? `table '${reader.table}'` : 'the table';
  if (upsert.length && (!Array.isArray(keyColumns) || keyColumns.length === 0)) {
    throw new JazminValidationError('upsert needs keyColumns, e.g. { keyColumns: ["id"] }');
  }
  if ((set === undefined) !== (where === undefined)) throw new JazminValidationError(`${name}: set and where go together: set: { column: value }, where: a filter ({} for every row)`);
  if (set !== undefined && (set === null || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length)) {
    throw new JazminValidationError(`${name}: set: { column: value, ... }`);
  }

  // The sort order afterwards: the file's (other text comparisons included, spec 6.7), or a new one (sortedBy; null or
  // [] for none).
  const order = reader.sort ?? reader.sortedBy;
  const target = targetSortedBy(newSortedBy, order);
  const targetNames = target?.map(orderColumn);
  const partitionBy = owner ? reader[OWNER_GRANTS].partitionBy : null;
  if (regroup && !partitionBy) throw new JazminValidationError('regroup applies to access-controlled files with partitionBy');
  if (regroup && target && targetNames[0] !== partitionBy) {
    throw new JazminValidationError(`regroup would break the sortedBy order [${targetNames.join(', ')}]: `
      + `it needs no sortedBy, or one that starts with the partition column '${partitionBy}' (then rows are already grouped)`);
  }

  // Nested columns may gain fields at the end of their objects (spec 5.4): their new definitions are given; and
  // columns may get, change or lose indexes. The old first sort column found its values by the order, with no index
  // of its own: re-sorted away from it, it gets a sorted index, so lookups on it stay fast, unless `indexes` names it.
  const resortAsked = !sameOrder(target, order);
  const current = columnsWithIndexes(reader);
  const was = current.find((c) => c.name === reader.sortedBy?.[0]);
  const keepLookup = resortAsked && was && targetNames?.[0] !== was.name && !(indexes && Object.hasOwn(indexes, was.name))
    && INDEX_KINDS.sorted.has(was.type) && !was.index.includes('sorted');
  const wanted = keepLookup ? { ...(indexes ?? {}), [was.name]: [...was.index, 'sorted'] } : indexes;
  const { columns } = growColumns(withIndexes(current, wanted), given, normalizeColumns);
  const byName = new Map(columns.map((c) => [c.name, c]));
  for (const k of keyColumns ?? []) if (!byName.has(k)) throw new JazminValidationError(`keyColumns: unknown column '${k}'`);

  // set: the columns it sets exist; in a shared file the partition column stays (its rows would leave the partitions
  // keys are granted).
  const setColumns = Object.keys(set ?? {});
  for (const c of setColumns) if (!byName.has(c)) throw new JazminValidationError(`${name}: set: unknown column '${c}'`);
  // Each value checked against its column before anything is read (nested values are checked as they are written).
  for (const c of setColumns) {
    const column = byName.get(c);
    const value = set[c];
    if (value === undefined) throw new JazminValidationError(`${name}: set: column '${c}' has no value (null empties it)`);
    if (value === null) {
      if (column.nullable === false) throw new JazminValidationError(`${name}: set: column '${c}' can't be empty`);
    } else if (SCALAR_TYPES.has(column.type)) {
      try {
        normalizeValue(column.type, value, c);
      } catch (error) {
        throw new JazminValidationError(`${name}: set: ${error.message}`);
      }
    }
  }
  if (partitionBy && setColumns.includes(partitionBy)) {
    throw new JazminValidationError(`${name}: set changes the partition column '${partitionBy}': the rows would leave the partitions keys are granted`);
  }
  const matches = set ? compileFilter(where, columns) : null;
  // Rows whose sort columns are set move. When few match (up to the sort budget) they are found first, by the file's
  // indexes, held, and merged in at their new place as the table streams; more go through the sorter.
  const setsOrder = Boolean(target) && setColumns.some((c) => targetNames.includes(c));
  const { runRows } = sorterOptions(context);

  const keyOf = (row) => JSON.stringify(keyColumns.map((k) => {
    const c = byName.get(k);
    const v = normalizeValue(c.type, row[k], k);
    return v === null ? null : keyText(keyId(toKey(c.type, v)));
  }));
  const sortedBy = order;
  const orderKeys = sortedBy ? normalizeOrder(sortedBy, columns).keys : null;
  const orderKey = orderKeys ? orderKeyMaker(orderKeys) : null;
  const compareTuples = orderKeys ? orderComparer(orderKeys) : null;
  const sortKeyOf = (row) => orderKey((col) => normalizeValue(columns[col].type, row[columns[col].name], columns[col].name));
  const pending = new Map(); // upsert key -> { row, matched }
  for (const row of upsert) pending.set(keyOf(row), { row, matched: false });
  const isDeleted = deleteWhere ? compileFilter(deleteWhere, columns) : null;

  const write = (writer) => {
    const stats = { inserted: 0, updated: 0, deleted: 0 };
    let moved = null; // the rows whose sort columns are set, changed, when few enough to hold
    // Counted first (by the indexes, or the filter's columns only), so too many are never gathered.
    if (setsOrder && !resortAsked && !regroup && reader.count(where) <= runRows) {
      moved = [];
      for (const row of reader.find(where)) {
        if ((pending.size && pending.has(keyOf(row))) || isDeleted?.(row)) continue; // upserted or deleted instead
        moved.push({ ...row, ...set });
      }
    }
    const resort = resortAsked || (setsOrder && !moved);
    const sorter = resort && target ? context.track(new RowSorter(columns, target, sorterOptions(context, reader.rowCount + insert.length + upsert.length))) : null;
    const emit = sorter ? (row) => sorter.add(row) : (row) => writer.writeRow(row);
    const changed = (row) => {
      if (!matches?.(row)) return row;
      stats.updated++;
      return { ...row, ...set };
    };
    if (sortedBy && !resort) {
      // Upserted rows are re-inserted at their sorted position (their sort key may have changed),
      // so the whole change set merges into the stream in one pass.
      const incoming = [...insert, ...[...pending.values()].map((p) => p.row), ...(moved ?? [])].map((row) => ({ row, key: sortKeyOf(row) }));
      incoming.sort((a, b) => compareTuples(a.key, b.key));
      let next = 0;
      let movedOut = 0;
      for (const row of reader.rows()) {
        const rowKey = sortKeyOf(row);
        while (next < incoming.length && compareTuples(incoming[next].key, rowKey) < 0) writer.writeRow(incoming[next++].row);
        const hit = pending.size ? pending.get(keyOf(row)) : undefined;
        if (hit) {
          if (hit.matched) stats.deleted++; // duplicate key rows collapse into the single upserted row
          else stats.updated++;
          hit.matched = true;
        } else if (isDeleted?.(row)) {
          stats.deleted++;
        } else if (moved && matches(row)) {
          stats.updated++; // written at its new place, from incoming
          movedOut++;
        } else {
          writer.writeRow(changed(row));
        }
      }
      while (next < incoming.length) writer.writeRow(incoming[next++].row);
      // Every row taken out was one gathered, or a row would be lost or doubled (nothing is written then).
      if (moved && movedOut !== moved.length) throw new Error(`${name}: ${moved.length} rows to move were found, but ${movedOut} were taken out`);
    } else {
      for (const row of regroup ? reader[ROWS_BY_PARTITION]() : reader.rows()) {
        const hit = pending.size ? pending.get(keyOf(row)) : undefined;
        if (hit && !hit.matched) {
          hit.matched = true;
          stats.updated++;
          emit(hit.row);
        } else if (hit || isDeleted?.(row)) {
          stats.deleted++;
        } else {
          emit(changed(row));
        }
      }
      for (const row of insert) emit(row);
      for (const { row, matched } of pending.values()) if (!matched) emit(row);
      if (sorter) {
        for (const row of sorter.rows()) writer.writeRow(row);
        sorter.close(); // its temporary files go now, not after every table
      }
    }
    stats.inserted = insert.length + [...pending.values()].filter((p) => !p.matched).length;
    return { rowCount: writer.rowCount, ...stats };
  };
  return { columns, sortedBy: target, write };
}

/**
 * Which tables a rewrite keeps, removes and renames, and adds, checked: { removed: Set, names: Map(old -> new) }.
 * A file's single unnamed table needs a name before a table is added beside it.
 */
function planTables(existing, { addTables, removeTables, renameTables, owner }) {
  if (!Array.isArray(addTables) || !Array.isArray(removeTables)) throw new JazminValidationError('addTables and removeTables must be arrays');
  if (renameTables === null || typeof renameTables !== 'object' || Array.isArray(renameTables)) throw new JazminValidationError('renameTables: { oldName: newName }');
  const removed = new Set(removeTables);
  for (const name of removed) if (!existing.includes(name)) throw new JazminValidationError(`removeTables: the file has no table '${name}'`);
  const names = new Map(Object.entries(renameTables));
  for (const [from, to] of names) {
    if (!existing.includes(from)) throw new JazminValidationError(`renameTables: the file has no table '${from}'`);
    if (removed.has(from)) throw new JazminValidationError(`renameTables: table '${from}' is being removed`);
    if (typeof to !== 'string' || to === '') throw new JazminValidationError(`renameTables: '${from}' needs a non-empty new name`);
  }
  const after = existing.filter((n) => !removed.has(n)).map((n) => names.get(n) ?? n);
  for (const t of addTables) {
    if (!t || typeof t.name !== 'string' || t.name === '') throw new JazminValidationError('addTables: each table needs a name');
    if (!owner && (t.partitionBy != null || t.columnGroups !== undefined)) throw new JazminValidationError(`addTables: '${t.name}': partitionBy and columnGroups apply to shared files`);
    if (t.rows !== undefined && (t.rows === null || typeof t.rows[Symbol.iterator] !== 'function')) throw new JazminValidationError(`addTables: '${t.name}': rows must be an array or another iterable`);
    after.push(t.name);
  }
  if (!after.length) throw new JazminValidationError('A file needs at least one table: add one, or keep one');
  if (addTables.length && after.includes('')) throw new JazminValidationError("The file's table has no name: name it first (renameTables: { '': 'clients' })");
  const seen = new Set();
  for (const n of after) {
    if (seen.has(n)) throw new JazminValidationError(`Table '${n}' would be in the file twice`);
    seen.add(n);
  }
  return { removed, names, first: existing[0], changed: removed.size > 0 || names.size > 0 };
}

/** Each `$from` (a linked table) in a shape, in place of `rename` (old name -> new name). */
function renameLinks(value, rename) {
  if (Array.isArray(value)) return value.map((v) => renameLinks(v, rename));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === '$from' && typeof v === 'string' ? rename(v) : renameLinks(v, rename)]));
}

/** The tables a shape reads: its own (none named: the file's first) and every `$from`. */
function shapeTables(shape, first) {
  const names = new Set([shape.table ?? first]);
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === '$from' && typeof x === 'string' ? names.add(x) : walk(x));
  };
  walk(shape.shape);
  return names;
}

/** A saved shape after tables are renamed; refused when it reads a table being removed (remove it too). */
function shapeAfter(shape, { removed, names, first, changed }) {
  if (!changed) return shape;
  for (const t of shapeTables(shape, first)) {
    if (removed.has(t)) throw new JazminValidationError(`Saved shape '${shape.name}' reads table '${t}', which is being removed: remove the shape too (removeShapes)`);
  }
  const rename = (n) => names.get(n) ?? n;
  // Named explicitly: "the first table" may be another table afterwards.
  return { ...shape, table: rename(shape.table ?? first), shape: renameLinks(shape.shape, rename) };
}

/** The package settings after tables are renamed or removed: its edit table follows a rename, and can't be removed. */
function packageAfter(settings, { removed, names, first, changed }) {
  if (!changed || !settings?.edit) return settings;
  const table = settings.edit.table ?? first; // none named: the file's first, which may be another table afterwards
  if (removed.has(table)) throw new JazminValidationError(`The document's edits change table '${table}', which is being removed: change package.edit first`);
  return { ...settings, edit: { ...settings.edit, table: names.get(table) ?? table } };
}

/** The sort order a rewrite gives a table: its own (`given` undefined), none (null or []), or the keys given. */
function targetSortedBy(given, current) {
  if (given === undefined) return current;
  if (given === null || (Array.isArray(given) && given.length === 0)) return undefined;
  if (!Array.isArray(given) || given.some((k) => !(typeof k === 'string' ? k : k?.column))) {
    throw new JazminValidationError('sortedBy must be an array of column names (or { column, nocase, natural }), or null for none');
  }
  return given;
}

/** An order key's column: the name, or { column }'s. */
const orderColumn = (k) => (typeof k === 'string' ? k : k.column);

/** Whether two orders are the same: the same columns, compared the same way. */
const sameOrder = (a, b) => {
  const text = (order) => JSON.stringify((order ?? []).map((k) => (typeof k === 'string' ? [k, false, false] : [k.column, k.nocase === true, k.natural === true])));
  return text(a) === text(b);
};

/** Columns with the indexes `indexes` gives them ({ column: kind | [kinds] | [] }); columns not named keep theirs. */
function withIndexes(columns, indexes) {
  if (indexes === undefined || indexes === null) return columns;
  if (typeof indexes !== 'object' || Array.isArray(indexes)) throw new JazminValidationError("indexes: { column: ['sorted', 'trigram'] } (or [] for none)");
  const names = new Set(columns.map((c) => c.name));
  for (const name of Object.keys(indexes)) if (!names.has(name)) throw new JazminValidationError(`indexes: unknown column '${name}'`);
  return columns.map((c) => {
    if (!Object.hasOwn(indexes, c.name)) return c;
    const kinds = indexes[c.name] === null ? [] : [].concat(indexes[c.name]);
    if (kinds.some((k) => typeof k !== 'string')) throw new JazminValidationError(`indexes: column '${c.name}' takes 'sorted', 'trigram', both, or [] for none`);
    return { ...c, index: kinds }; // the writer checks each kind fits the column's type
  });
}

/** A table's partition column and named column groups as writer table options (owner of an access-controlled file). */
function tableLayout(owner) {
  return {
    partitionBy: owner.partitionBy,
    columnGroups: Object.fromEntries(Object.entries(owner.columnGroups).filter(([name]) => name !== '*')),
  };
}

/**
 * The embedded files a rewrite keeps: every file except removed or replaced ones, read block by
 * block from the old version while the new one is written (bounded memory). Each keeps its lock, unless `locks` removes it.
 */
export function carriedFiles(reader, addFiles, removeFiles, locks) {
  const state = reader[FILE_STATE];
  const existing = new Map((state?.entries ?? []).map((e) => [e.path, e]));
  for (const p of removeFiles) if (!existing.has(p)) throw new JazminValidationError(`removeFiles: no file '${p}'`);
  const dropped = new Set([...removeFiles, ...addFiles.map((f) => f?.path)]);
  const contents = new Map((state?.contents ?? []).map((c) => [c.id, c]));
  return [...existing.values()].filter((e) => !dropped.has(e.path)).map((e) => {
    const c = contents.get(e.content);
    return {
      [FILE_SOURCE]: true, path: e.path, type: e.type, groups: e.groups, ...(e.actions ? { actions: e.actions } : {}),
      ...(e.groupActions ? { groupActions: e.groupActions } : {}), ...(c.lock !== undefined && locks?.[c.lock] !== null ? { lock: c.lock } : {}),
      size: c.size, sha256: c.sha256,
      read: (offset, length) => reader.readFileRange(e.path, offset, offset + length),
    };
  });
}

export function accessFor(owner, grant, revoke) {
  const named = Object.fromEntries(Object.entries(owner.columnGroups).filter(([name]) => name !== '*'));
  if (!grant.length && !revoke.length) {
    // The file's grants as they are: no key ids needed (each is a hash, and a file can grant thousands of keys).
    return { partitionBy: owner.partitionBy, columnGroups: named, grants: owner.grants.map((g) => (g.accessKey ? { ...g, key: g.accessKey } : g)) };
  }
  const revoked = new Set(revoke.map((k) => {
    const parsed = parseAnyKey(k);
    if (!(parsed instanceof JazminAccessKey)) throw new JazminValidationError('revoke expects access keys (jza1-...)');
    return parsed.id;
  }));
  const grants = new Map();
  for (const g of owner.grants) {
    const id = (g.accessKey ?? JazminAccessKey.parse(g.key)).id;
    if (!revoked.has(id)) grants.set(id, g.accessKey ? { ...g, key: g.accessKey } : g); // the writer then needs not parse it again
  }
  for (const g of grant) grants.set(parseAnyKey(g.key).id, g); // re-granting replaces the previous grant
  return { partitionBy: owner.partitionBy, columnGroups: named, grants: [...grants.values()] };
}

/**
 * Grants an append may make. An append keeps the file's secrets, so a key keeps whatever it could already open: new
 * grants and wider ones are fine, but narrowing an existing grant (fewer rows, columns or files, a new or earlier
 * expiry, offline to online) needs update() or compact(), which re-lock the file with fresh secrets.
 */
export function checkAppendGrants(existing, grants, now) {
  if (!grants.length) return;
  const before = new Map(existing.map((g) => [(g.accessKey ?? JazminAccessKey.parse(g.key)).id, g]));
  const list = (v) => (v === undefined || v === '*' ? '*' : Array.isArray(v) ? v.map(String) : null);
  const covers = (wider, narrower) => wider === '*' || (narrower !== '*' && narrower.every((x) => wider.includes(x)));
  for (const g of grants) {
    const key = parseAnyKey(g?.key);
    const old = before.get(key?.id);
    const rows = list(g.rows);
    const columns = list(g.columns);
    const files = g.files === undefined ? [] : list(g.files);
    if (!old || !rows || !columns || !files) continue; // new grants, and malformed ones (reported when written)
    const expires = grantExpiry(g, toMs(now));
    const oldExpires = old.expires === undefined ? undefined : Date.parse(old.expires);
    const narrower = !covers(rows, list(old.rows)) || !covers(columns, list(old.columns))
      || !covers(files, old.files === undefined ? [] : list(old.files))
      || (expires !== undefined && (oldExpires === undefined || expires < oldExpires))
      || ((g.mode ?? 'offline') === 'online' && old.mode !== 'online');
    if (narrower) {
      throw new JazminValidationError(`The grant for ${key.id} is narrower than before. An append keeps the file's secrets, so that key could still read new data: use update() or compact(), which re-lock the file`);
    }
  }
}

/** Owner only: lets `accessKey` see the given partitions / column groups (rewrites the file). */
export function grantAccess(path, ownerKey, accessKey, { rows = '*', columns = '*', label } = {}) {
  return update(path, { key: ownerKey, grant: [{ key: accessKey, rows, columns, label }] });
}

/** Owner only: removes a key's access. The new file version uses fresh secrets throughout. */
export function revokeAccess(path, ownerKey, accessKey) {
  return update(path, { key: ownerKey, revoke: [accessKey] });
}
