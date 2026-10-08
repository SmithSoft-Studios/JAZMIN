import fs from 'node:fs';
import { JazminKeyError, JazminValidationError } from './errors.js';
import { growColumns } from './nested.js';
import { normalizeColumns } from './schema.js';
import { withLock } from './lock.js';
import { APPEND_STATE, JazminReader, OWNER_GRANTS, ROWS_WITH_IDS } from './reader.js';
import { compareKeys, normalizeValue, toKey } from './types.js';
import { accessFor, checkAppendGrants, columnsWithIndexes, updateUnlocked } from './update.js';
import { CONTINUE, JazminWriter } from './writer.js';

function keyText(value) {
  return typeof value === 'bigint' ? `${value}n` : value;
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

/**
 * Applies changes by appending them to the end of the file instead of rewriting it (spec 11.2).
 * Existing bytes are never modified, so open readers keep working, and the cost is proportional
 * to the change, not the file. Deleted and replaced rows are recorded as deletions; compact()
 * removes them and the superseded headers.
 *
 * options: key | password, insert, upsert + keyColumns, delete (filter), metadata,
 *          grant (access-controlled files), codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority,
 *          addFiles (add or replace by path), removeFiles (paths), package (viewer settings),
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
  const {
    key, password, insert = [], upsert = [], keyColumns, delete: deleteWhere, metadata, grant = [], revoke = [],
    codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority, autoCompact, now,
    addFiles = [], removeFiles = [], package: packageSettings, table, columns: given,
  } = options;
  if (upsert.length && (!Array.isArray(keyColumns) || keyColumns.length === 0)) {
    throw new JazminValidationError('upsert needs keyColumns, e.g. { keyColumns: ["id"] }');
  }
  if (revoke.length) throw new JazminValidationError('Revoking access needs compact() or update(): only a full rewrite re-locks the file with fresh secrets');

  const reader = new JazminReader(path, { key, password, table });
  let writer;
  let result;
  try {
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
    const keyOf = (row) => JSON.stringify(tuple(row, keyColumns).map(keyText));

    // Rows to remove: matches of the delete filter, and existing rows replaced by an upsert.
    const removed = new Set();
    let updated = 0;
    if (deleteWhere) for (const [rowId] of reader[ROWS_WITH_IDS](deleteWhere)) removed.add(rowId);
    if (upsert.length) {
      const pending = new Set(upsert.map(keyOf));
      // A single key column can use its index (or chunk statistics) instead of a full scan.
      const filter = keyColumns.length === 1 ? { [keyColumns[0]]: { in: upsert.map((r) => r[keyColumns[0]]).filter((v) => v != null) } } : null;
      const matchedKeys = new Set();
      for (const [rowId, row] of reader[ROWS_WITH_IDS](filter)) {
        const k = keyOf(row);
        if (!pending.has(k)) continue;
        if (!removed.has(rowId)) removed.add(rowId);
        matchedKeys.add(k);
      }
      updated = matchedKeys.size;
    }
    const deletedNow = removed.size - updated;

    const state = reader[APPEND_STATE];
    if (state.files || addFiles.length) {
      // Kept files are referenced, not rewritten; replaced and removed ones are dropped from the directory.
      const entries = new Map((state.files?.entries ?? []).map((e) => [e.path, e]));
      for (const p of removeFiles) if (!entries.delete(p)) throw new JazminValidationError(`removeFiles: no file '${p}'`);
      for (const f of addFiles) entries.delete(f?.path);
      state.files = {
        entries: [...entries.values()],
        contents: state.files?.contents ?? [],
        nextId: state.files?.nextId ?? 0,
        package: state.files?.package,
      };
    } else if (removeFiles.length) {
      throw new JazminValidationError(`removeFiles: no file '${removeFiles[0]}'`);
    }
    const allDeleted = Float64Array.from(new Set([...state.deleted, ...removed])).sort();
    const sortedBy = reader.sortedBy;
    const existingMetadata = reader.metadata;
    const before = { rowCount: reader.rowCount, appendCount: reader.appendCount };
    let incoming = [...insert, ...upsert];
    if (sortedBy) {
      incoming = incoming.map((row) => ({ row, k: tuple(row, sortedBy) })).sort((a, b) => compareTuples(a.k, b.k)).map((x) => x.row);
    }
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
      [CONTINUE]: { ...state, deleted: [...allDeleted], grown },
    });
    try {
      writer.writeRows(incoming);
    } catch (error) {
      if (sortedBy && /out of order/.test(error.message)) {
        throw new JazminValidationError(`${error.message}. Appended rows must sort after the existing rows; use update() to insert them in the middle`);
      }
      throw error;
    }
    writer.finish();

    // The new version's counts follow from the change: no need to open the file again.
    result = {
      rowCount: before.rowCount - removed.size + incoming.length,
      inserted: insert.length + upsert.length - updated,
      updated,
      deleted: deletedNow,
      appendCount: before.appendCount + 1,
      deletedRowCount: allDeleted.length,
      expiredGrantsRemoved: writer.expiredGrants,
      compacted: false,
    };
  } catch (error) {
    writer?.abort();
    reader.close();
    throw error;
  }

  if (autoCompact && shouldCompact(result, autoCompact)) {
    const compacted = updateUnlocked(path, { key, password, codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, priority, now, table });
    return { ...result, rowCount: compacted.rowCount, appendCount: 0, deletedRowCount: 0, compacted: true };
  }
  return result;
}

function shouldCompact({ appendCount, deletedRowCount, rowCount }, { deletedRatio, appends }) {
  if (appends !== undefined && appendCount >= appends) return true;
  const physical = rowCount + deletedRowCount;
  return deletedRatio !== undefined && physical > 0 && deletedRowCount / physical >= deletedRatio;
}

/**
 * Rewrites the file in full: removes deleted rows and superseded headers, merges index segments,
 * and (for access-controlled files) re-locks it with fresh secrets. Same as update() with no changes.
 * Returns { rowCount, bytesBefore, bytesAfter }.
 */
export function compact(path, options = {}) {
  return withLock(path, () => {
    const bytesBefore = fs.statSync(path).size;
    const { rowCount, expiredGrantsRemoved } = updateUnlocked(path, options);
    return { rowCount, bytesBefore, bytesAfter: fs.statSync(path).size, expiredGrantsRemoved };
  });
}
