import fs from 'node:fs';
import { JazminKeyError, JazminValidationError } from './errors.js';
import { evaluate, normalizeFilter } from './filter.js';
import { growColumns } from './nested.js';
import { keptShapes, tableColumns } from './saved-shapes.js';
import { normalizeColumns } from './schema.js';
import { withLock } from './lock.js';
import { APPEND_STATE, JazminReader, OWNER_GRANTS, ROWS_WITH_IDS, checkWriterFeatures } from './reader.js';
import { normalizeOrder, orderComparer, orderKeyMaker } from './sort-keys.js';
import { keyId, normalizeValue, toKey } from './types.js';
import { accessFor, checkAppendGrants, columnsWithIndexes, updateUnlocked } from './update.js';
import { CONTINUE, FINISH_ASYNC, JazminWriter } from './writer.js';

/** A key value as JSON can hold it: JSON would write NaN and the infinities as null, the empty key. */
function keyText(value) {
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
}

/**
 * Applies changes by appending them to the end of the file instead of rewriting it (spec 11.2).
 * Existing bytes are never modified, so open readers keep working, and the cost is proportional
 * to the change, not the file. Deleted and replaced rows are recorded as deletions; compact()
 * removes them and the superseded headers.
 *
 * options: key | password, insert, upsert + keyColumns, delete (filter), metadata,
 *          grant (access-controlled files), codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority,
 *          addFiles (add or replace by path), removeFiles (paths), package (viewer settings),
 *          addShapes (saved export shapes: add or replace by name), removeShapes (names),
 *          locks (shared files: add, change or remove locks of stored files, as for update()),
 *          autoCompact: { deletedRatio?, appends? }   compact afterwards when either is reached
 *
 * In a file with sortedBy, appended rows must sort after the existing rows; use update() to
 * insert in the middle. Revoking access needs compact() or update(), which re-lock the file.
 *
 * Returns { rowCount, inserted, updated, deleted, appendCount, deletedRowCount, compacted }.
 */
export function append(path, options = {}) {
  return withLock(path, () => appendUnlocked(path, options));
}

function appendUnlocked(path, options) {
  const { insert = [], upsert = [], delete: deleteWhere } = options;
  return appendCalls(path, options, [{ insert, upsert, delete: deleteWhere }]).result;
}

/**
 * Internal (beginAppend, openWriter; the caller holds the lock): calls, each { insert?, upsert?, delete? }, written as
 * one append, in call order. A clash (see orderedRows) is refused with `atClash` 'throw'; with 'split' the calls
 * before it are written, and `taken` says how many. With `durable` 'async' the two flushes to disk are awaited instead
 * of blocking, and a promise is returned. Returns { result, taken }.
 */
export function appendCalls(path, options, calls, { atClash = 'throw', durable = 'sync' } = {}) {
  const job = startAppend(path, options, calls, atClash);
  if (durable === 'async') {
    return job.writer[FINISH_ASYNC]().then(
      () => ({ result: endAppend(path, options, job), taken: job.taken }),
      (error) => {
        job.writer.abort();
        throw error;
      },
    );
  }
  try {
    job.writer.finish();
  } catch (error) {
    job.writer.abort();
    throw error;
  }
  return { result: endAppend(path, options, job), taken: job.taken };
}

/** What a call adds: its inserted rows, then its upserted ones (as append() writes them). */
const addedBy = (call) => {
  const insert = call.insert ?? [];
  const upsert = call.upsert ?? [];
  if (!upsert.length) return insert;
  return insert.length ? [...insert, ...upsert] : upsert;
};
const kindOf = (call) => (call.delete ? 'delete' : call.upsert?.length ? 'upsert' : 'insert');

/**
 * Reads the file and writes the calls' rows: all of the append but its end (writer.finish()). Each call's delete and
 * upsert see the file as the earlier calls leave it. Returns { writer, counts, taken }.
 */
function startAppend(path, options, calls, atClash) {
  const {
    key, password, keyColumns, metadata, grant = [], revoke = [],
    codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority, now,
    addFiles = [], removeFiles = [], package: packageSettings, table, columns: given, addShapes = [], removeShapes = [], locks,
  } = options;
  if (calls.some((c) => c.upsert?.length) && (!Array.isArray(keyColumns) || keyColumns.length === 0)) {
    throw new JazminValidationError('upsert needs keyColumns, e.g. { keyColumns: ["id"] }');
  }
  if (revoke.length) throw new JazminValidationError('Revoking access needs compact() or update(): only a full rewrite re-locks the file with fresh secrets');

  const reader = new JazminReader(path, { key, password, table });
  let writer;
  try {
    checkWriterFeatures(reader);
    const owner = reader[OWNER_GRANTS];
    if (!owner && reader.access) throw new JazminKeyError("Only the file owner's master key can modify this file");
    if (!owner && grant.length) throw new JazminValidationError('grant applies only to access-controlled files');
    if (owner) checkAppendGrants(owner.grants, grant, now);

    // Nested columns may gain fields at the end of their objects (spec 5.4): their new definitions are given.
    const { columns, grown } = growColumns(columnsWithIndexes(reader), given, normalizeColumns);
    const byName = new Map(columns.map((c) => [c.name, c]));
    for (const name of keyColumns ?? []) if (!byName.has(name)) throw new JazminValidationError(`keyColumns: unknown column '${name}'`);
    const tuple = (row, names) => names.map((name) => {
      const c = byName.get(name);
      const v = normalizeValue(c.type, row[name], name);
      return v === null ? null : toKey(c.type, v);
    });
    // Decimal keys are objects: equal values share their text (keyId), as update() compares them.
    const keyOf = (row) => JSON.stringify(tuple(row, keyColumns).map((k) => keyText(keyId(k))));
    // In one call the last row for a key wins, as if the rows were upserted one after another.
    const lastRows = calls.map((c) => (c.upsert?.length > 1 ? { ...c, upsert: lastRowPerKey(c.upsert, keyOf) } : c));

    // The table's order, other text comparisons included (spec 6.7): appended rows are put in it.
    const sortedBy = reader.sort ?? reader.sortedBy;
    const ordered = orderedRows(lastRows, { columns, keyOf, sortedBy }, atClash);
    const taken = lastRows.slice(0, ordered.taken);
    const incoming = ordered.rows;

    // Rows to remove: matches of the delete filters, and existing rows replaced by an upsert.
    const removed = new Set();
    let updated = 0;
    const deletes = taken.flatMap((c, i) => (c.delete ? [{ filter: c.delete, at: i }] : []));
    const deletedAt = new Map(); // row id -> the first call that deletes it
    if (deletes.length === 1) {
      for (const [rowId] of reader[ROWS_WITH_IDS](deletes[0].filter)) deletedAt.set(rowId, deletes[0].at);
    } else if (deletes.length > 1) {
      // One scan for all the deletes; each row it finds goes to the first call whose filter matches it.
      const plans = deletes.map((d) => normalizeFilter(d.filter, columns));
      for (const [rowId, row] of reader[ROWS_WITH_IDS]({ or: deletes.map((d) => d.filter) })) {
        const values = valuesOf(row, columns);
        deletedAt.set(rowId, deletes[plans.findIndex((p) => p === null || evaluate(p, values))].at);
      }
    }
    for (const rowId of deletedAt.keys()) removed.add(rowId);
    const upserts = taken.flatMap((c, i) => (c.upsert?.length ? [{ rows: c.upsert, at: i }] : []));
    if (upserts.length) {
      const pending = new Map(); // key -> the call that upserts it (a later call with the same key would be a clash)
      for (const u of upserts) {
        for (const row of u.rows) {
          const k = keyOf(row);
          if (!pending.has(k)) pending.set(k, u.at);
        }
      }
      // A single key column can use its index (or chunk statistics) instead of a full scan. An empty key matches the
      // empty cells, which a sorted index lists apart (its null postings).
      let filter = null;
      if (keyColumns.length === 1) {
        const name = keyColumns[0];
        const keys = upserts.flatMap((u) => u.rows.map((r) => r[name]));
        const values = keys.filter((v) => v != null);
        const empty = values.length < keys.length ? { [name]: null } : null;
        filter = !empty ? { [name]: { in: values } } : values.length ? { or: [{ [name]: { in: values } }, empty] } : empty;
      }
      const matchedKeys = new Set();
      for (const [rowId, row] of reader[ROWS_WITH_IDS](filter)) {
        const k = keyOf(row);
        const at = pending.get(k);
        if (at === undefined) continue;
        if (deletedAt.get(rowId) < at) continue; // an earlier call deleted it: this upsert adds its row anew
        removed.add(rowId);
        matchedKeys.add(k);
      }
      updated = matchedKeys.size;
    }
    const deletedNow = removed.size - updated;

    const state = reader[APPEND_STATE];
    if (state.files || addFiles.length || addShapes.length) {
      // Kept files are referenced, not rewritten; replaced and removed ones are dropped from the directory.
      const entries = new Map((state.files?.entries ?? []).map((e) => [e.path, e]));
      for (const p of removeFiles) if (!entries.delete(p)) throw new JazminValidationError(`removeFiles: no file '${p}'`);
      for (const f of addFiles) entries.delete(f?.path);
      state.files = {
        entries: [...entries.values()],
        contents: state.files?.contents ?? [],
        nextId: state.files?.nextId ?? 0,
        package: state.files?.package,
        shapes: keptShapes(state.files?.shapes ?? [], addShapes, removeShapes),
        locks: state.files?.locks ?? [],
      };
    } else if (removeFiles.length) {
      throw new JazminValidationError(`removeFiles: no file '${removeFiles[0]}'`);
    } else if (removeShapes.length) {
      throw new JazminValidationError(`removeShapes: no saved shape '${removeShapes[0]}'`);
    }
    // Saved shapes are checked against every table they read: the file's other tables are as it has them.
    const shapeTables = (state.files?.shapes.length || addShapes.length) && reader.tables.length > 1
      ? reader.tables.map((name) => {
        if (name === reader.table) return null;
        const other = reader.openTable(name);
        try {
          return tableColumns(other);
        } finally {
          other.close();
        }
      })
      : undefined;
    const allDeleted = Float64Array.from(new Set([...state.deleted, ...removed])).sort();
    const existingMetadata = reader.metadata;
    const before = { rowCount: reader.rowCount, appendCount: reader.appendCount };
    reader.close();

    writer = new JazminWriter(path, {
      columns,
      metadata: { ...existingMetadata, ...(metadata ?? {}) },
      sortedBy,
      codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority,
      key,
      access: owner ? accessFor(owner, grant, []) : undefined,
      now, // expired grants lose their key slots (full lock-out of old secrets needs compact/update)
      files: addFiles,
      ...(packageSettings !== undefined ? { package: packageSettings } : {}),
      shapes: addShapes,
      ...(locks !== undefined ? { locks } : {}),
      [CONTINUE]: { ...state, deleted: [...allDeleted], grown, shapeTables },
    });
    try {
      writer.writeRows(incoming);
    } catch (error) {
      if (sortedBy && /out of order/.test(error.message)) {
        throw new JazminValidationError(`${error.message}. Appended rows must sort after the existing rows; use update() to insert them in the middle`);
      }
      throw error;
    }

    // The new version's counts follow from the change: no need to open the file again.
    const counts = {
      rowCount: before.rowCount - removed.size + incoming.length,
      inserted: incoming.length - updated,
      updated,
      deleted: deletedNow,
      appendCount: before.appendCount + 1,
      deletedRowCount: allDeleted.length,
    };
    return { writer, counts, taken: ordered.taken };
  } catch (error) {
    writer?.abort();
    reader.close();
    throw error;
  }
}

/** The finished append's result; the file is compacted afterwards when autoCompact says so (the lock still held). */
function endAppend(path, options, { writer, counts }) {
  const result = { ...counts, expiredGrantsRemoved: writer.expiredGrants, compacted: false };
  const { autoCompact, key, password, codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority, now, table } = options;
  if (autoCompact && shouldCompact(result, autoCompact)) {
    const compacted = updateUnlocked(path, { key, password, codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority, now, table });
    return { ...result, rowCount: compacted.rowCount, appendCount: 0, deletedRowCount: 0, compacted: true };
  }
  return result;
}

/**
 * In one call the last row for a key wins, as if the rows were upserted one after another: a key's earlier rows are
 * left out, and the rows kept are in the order of their last rows. Only a call that gives a key more than once pays for
 * it: a second set of the call's keys, found going backwards.
 */
function lastRowPerKey(rows, keyOf) {
  if (new Set(rows.map(keyOf)).size === rows.length) return rows;
  const seen = new Set();
  const kept = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const k = keyOf(rows[i]);
    if (!seen.has(k)) {
      seen.add(k);
      kept.push(rows[i]);
    }
  }
  return kept.reverse();
}

/** A row object as values in column order, as rows are stored (a normalized filter is evaluated on these). */
function valuesOf(row, columns) {
  return columns.map((c) => normalizeValue(c.type, row[c.name], c.name));
}

/**
 * The calls' rows in the order they are written: call order, each call's rows put in the table's order when it has
 * one (as append() does). One append then leaves the file as the calls run one after another would, unless a call
 * would see a row an earlier call adds: a delete whose filter matches it, an upsert with its key, or (sorted files)
 * rows that sort before it. That is a clash: refused (`atClash` 'throw'), or the calls are cut before it ('split').
 * Returns { rows, taken }.
 */
function orderedRows(calls, { columns, keyOf, sortedBy }, atClash) {
  const lastDelete = calls.findLastIndex((c) => c.delete);
  const lastUpsert = calls.findLastIndex((c) => c.upsert?.length);
  const addedKeys = new Map(); // key of a row an earlier call adds -> that call (kept only while a later call upserts)
  const addedValues = []; // [values, call] of rows earlier calls add (kept only while a later call deletes)
  const order = sortedBy ? normalizeOrder(sortedBy, columns).keys : null;
  const orderKey = order && orderKeyMaker(order);
  const compare = order && orderComparer(order);
  let last = null; // sorted files: the order key of the last row so far, and its call
  const rows = [];
  const clash = (at, earlier, what) => {
    if (atClash === 'split') return { rows, taken: at };
    throw new JazminValidationError(`In this transaction, call ${at + 1} (${kindOf(calls[at])}) ${what} call ${earlier + 1} (${kindOf(calls[earlier])}) adds: `
      + 'one append would not see those rows as the calls run one after another do. Commit the calls separately');
  };
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call.delete && addedValues.length) {
      const plan = normalizeFilter(call.delete, columns);
      const hit = addedValues.find(([values]) => plan === null || evaluate(plan, values));
      if (hit) return clash(i, hit[1], 'matches a row that');
    }
    // An upsert with the key of a row an earlier call adds, by insert or by upsert (an empty key included: it matches
    // the rows with an empty key).
    if (call.upsert?.length && addedKeys.size) {
      for (const row of call.upsert) {
        const earlier = addedKeys.get(keyOf(row));
        if (earlier !== undefined) return clash(i, earlier, 'has the key of a row that');
      }
    }
    let added = addedBy(call);
    if (order && added.length) {
      const sorted = added.map((row) => ({ row, k: orderKey((col) => normalizeValue(columns[col].type, row[columns[col].name], columns[col].name)) }))
        .sort((a, b) => compare(a.k, b.k));
      if (last && compare(sorted[0].k, last.k) < 0) return clash(i, last.at, 'has rows that sort before those');
      last = { k: sorted[sorted.length - 1].k, at: i };
      added = sorted.map((x) => x.row);
    }
    for (const row of added) rows.push(row);
    if (i < lastUpsert) for (const row of added) addedKeys.set(keyOf(row), i);
    if (i < lastDelete) for (const row of added) addedValues.push([valuesOf(row, columns), i]);
  }
  return { rows, taken: calls.length };
}

function shouldCompact({ appendCount, deletedRowCount, rowCount }, { deletedRatio, appends }) {
  if (appends !== undefined && appendCount >= appends) return true;
  const physical = rowCount + deletedRowCount;
  return deletedRatio !== undefined && physical > 0 && deletedRowCount / physical >= deletedRatio;
}

/**
 * Rewrites the file in full: removes deleted rows and superseded headers, merges index segments,
 * and (for access-controlled files) re-locks it with fresh secrets. Same as update() with no changes; it takes
 * update()'s options too (indexes, sortedBy, tables, ...), and `regroup` (shared files: each partition's rows together).
 * Returns { rowCount, bytesBefore, bytesAfter, expiredGrantsRemoved }.
 */
export function compact(path, options = {}) {
  return withLock(path, () => {
    const bytesBefore = fs.statSync(path).size;
    const { rowCount, expiredGrantsRemoved } = updateUnlocked(path, options);
    return { rowCount, bytesBefore, bytesAfter: fs.statSync(path).size, expiredGrantsRemoved };
  });
}
