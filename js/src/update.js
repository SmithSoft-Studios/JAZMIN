import crypto from 'node:crypto';
import fs from 'node:fs';
import { JazminError, JazminKeyError, JazminValidationError } from './errors.js';
import { compileFilter } from './filter.js';
import { grantExpiry, toMs } from './expiry.js';
import { JazminAccessKey, parseAnyKey } from './keys.js';
import { FILE_SOURCE } from './files.js';
import { FILE_STATE, JazminReader, OWNER_GRANTS, ROWS_BY_PARTITION } from './reader.js';
import { compareKeys, normalizeValue, toKey } from './types.js';
import { withLock } from './lock.js';
import { JazminWriter } from './writer.js';

/**
 * Atomically replaces `path` with `temp`: readers never see a half-written file. Readers that have the file open keep
 * reading the version they opened.
 */
function replaceFile(temp, path) {
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
 *   codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism   output settings (defaults as for a new file)
 *   addFiles, removeFiles, package        embedded files: add or replace, remove (by path), viewer settings
 *
 * Returns { rowCount, inserted, updated, deleted }.
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

/** update() without taking the file lock (the caller holds it). */
export function updateUnlocked(path, options = {}) {
  const {
    key, password, insert = [], upsert = [], keyColumns, delete: deleteWhere, metadata,
    grant = [], revoke = [], codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, now, layout,
    addFiles = [], removeFiles = [], package: packageSettings, table, regroup = false,
  } = options;
  if (upsert.length && (!Array.isArray(keyColumns) || keyColumns.length === 0)) {
    throw new JazminValidationError('upsert needs keyColumns, e.g. { keyColumns: ["id"] }');
  }

  const reader = new JazminReader(path, { key, password, table });
  const readers = [reader]; // in a file with several tables, one per table, in file order
  const temp = `${path}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let writer;
  try {
    const owner = reader[OWNER_GRANTS];
    if (!owner && reader.access) throw new JazminKeyError("Only the file owner's master key can modify this file");
    if (!owner && (grant.length || revoke.length)) throw new JazminValidationError('grant/revoke apply only to access-controlled files');
    if (reader.tables.length > 1) {
      readers.length = 0;
      for (const name of reader.tables) readers.push(name === reader.table ? reader : new JazminReader(path, { key, password, table: name }));
    }

    if (regroup && !owner?.partitionBy) throw new JazminValidationError('regroup applies to access-controlled files with partitionBy');
    if (regroup && reader.sortedBy && reader.sortedBy[0] !== owner.partitionBy) {
      throw new JazminValidationError(`regroup would break the file's sortedBy order [${reader.sortedBy.join(', ')}]: `
        + `it needs no sortedBy, or one that starts with the partition column '${owner.partitionBy}' (then rows are already grouped)`);
    }

    const columns = columnsWithIndexes(reader);
    const byName = new Map(columns.map((c) => [c.name, c]));
    for (const name of keyColumns ?? []) if (!byName.has(name)) throw new JazminValidationError(`keyColumns: unknown column '${name}'`);

    const keyOf = (row) => JSON.stringify(keyColumns.map((name) => {
      const c = byName.get(name);
      const v = normalizeValue(c.type, row[name], name);
      return v === null ? null : keyText(toKey(c.type, v));
    }));
    const sortedBy = reader.sortedBy;
    const sortKeyOf = (row) => sortedBy.map((name) => {
      const c = byName.get(name);
      const v = normalizeValue(c.type, row[name], name);
      return v === null ? null : toKey(c.type, v);
    });

    const pending = new Map(); // upsert key -> { row, matched }
    for (const row of upsert) pending.set(keyOf(row), { row, matched: false });
    const isDeleted = deleteWhere ? compileFilter(deleteWhere, columns) : null;

    // The other tables of the file are copied as they are: a new version has fresh secrets throughout (spec 7.6.7).
    const access = owner ? accessFor(owner, grant, revoke) : undefined;
    const several = readers.length > 1;
    writer = new JazminWriter(temp, {
      ...(several
        ? { tables: readers.map((r) => ({ name: r.table, columns: columnsWithIndexes(r), sortedBy: r.sortedBy, ...(owner ? tableLayout(r[OWNER_GRANTS]) : {}) })) }
        : { columns, sortedBy }),
      metadata: { ...reader.metadata, ...(metadata ?? {}) },
      codec, level, chunkRows, chunkBytes, maxDegreeOfParallelism, layout,
      key, password, kdfIterations: reader.kdfIterations,
      access: access && several ? { grants: access.grants } : access,
      now, // expired grants are dropped, and the new version's fresh secrets lock them out
      files: [...carriedFiles(reader, addFiles, removeFiles), ...addFiles],
      package: packageSettings !== undefined ? packageSettings : reader.package,
    });

    const stats = { inserted: 0, updated: 0, deleted: 0 };
    const writeChanged = () => {
      if (sortedBy) {
        // Upserted rows are re-inserted at their sorted position (their sort key may have changed),
        // so the whole change set merges into the stream in one pass.
        const incoming = [...insert, ...[...pending.values()].map((p) => p.row)].map((row) => ({ row, key: sortKeyOf(row) }));
        incoming.sort((a, b) => compareTuples(a.key, b.key));
        let next = 0;
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
          } else {
            writer.writeRow(row);
          }
        }
        while (next < incoming.length) writer.writeRow(incoming[next++].row);
      } else {
        for (const row of regroup ? reader[ROWS_BY_PARTITION]() : reader.rows()) {
          const hit = pending.size ? pending.get(keyOf(row)) : undefined;
          if (hit && !hit.matched) {
            hit.matched = true;
            stats.updated++;
            writer.writeRow(hit.row);
          } else if (hit || isDeleted?.(row)) {
            stats.deleted++;
          } else {
            writer.writeRow(row);
          }
        }
        for (const row of insert) writer.writeRow(row);
        for (const { row, matched } of pending.values()) if (!matched) writer.writeRow(row);
      }
      stats.inserted = insert.length + [...pending.values()].filter((p) => !p.matched).length;
    };

    let rowCount = 0;
    for (const r of readers) {
      if (r !== readers[0]) writer.startTable(r.table);
      if (r !== reader) {
        for (const row of r.rows()) writer.writeRow(row);
      } else {
        writeChanged();
        rowCount = writer.rowCount;
      }
    }

    for (const r of readers) r.close();
    writer.finish();
    replaceFile(temp, path);
    return { rowCount, ...stats, expiredGrantsRemoved: writer.expiredGrants };
  } catch (error) {
    writer?.abort();
    for (const r of readers) r.close();
    fs.rmSync(temp, { force: true });
    throw error;
  }
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
 * block from the old version while the new one is written (bounded memory).
 */
export function carriedFiles(reader, addFiles, removeFiles) {
  const state = reader[FILE_STATE];
  const existing = new Map((state?.entries ?? []).map((e) => [e.path, e]));
  for (const p of removeFiles) if (!existing.has(p)) throw new JazminValidationError(`removeFiles: no file '${p}'`);
  const dropped = new Set([...removeFiles, ...addFiles.map((f) => f?.path)]);
  const contents = new Map((state?.contents ?? []).map((c) => [c.id, c]));
  return [...existing.values()].filter((e) => !dropped.has(e.path)).map((e) => {
    const c = contents.get(e.content);
    return {
      [FILE_SOURCE]: true, path: e.path, type: e.type, groups: e.groups, size: c.size, sha256: c.sha256,
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
