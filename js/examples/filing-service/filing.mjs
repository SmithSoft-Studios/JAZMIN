// Filing the files people send back (submissions) into a shared file (USER-GUIDE 15.6, docs/design/browser-writer.md).
// Runs where the owner (master) key is kept: a server or a scheduled job you control - never a phone or a web page.
import { isDeepStrictEqual } from 'node:util';
import { JazminError, JazminKey, JazminKeyError, JazminValidationError, append, open } from '../../src/index.js';

/**
 * Kinds of file a batch may carry, told apart by their first bytes: never by the name or the type the phone gives. To
 * allow another kind, add it here with a test of its first bytes.
 */
export const FILE_KINDS = {
  'application/pdf': { name: 'PDF', ext: '.pdf', test: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) }, // %PDF-
  'image/jpeg': { name: 'JPEG', ext: '.jpg', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  'image/png': { name: 'PNG', ext: '.png', test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/webp': { name: 'WebP', ext: '.webp', test: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]) }, // RIFF....WEBP
};
const startsWith = (bytes, magic) => bytes.length >= magic.length && magic.every((m, i) => bytes[i] === m);
const MIB = 1024 * 1024;

/** A batch that must not be filed. The message says why; the run goes on with the next batch. */
export class RejectedBatch extends Error {
  constructor(message) {
    super(message);
    this.name = 'RejectedBatch';
  }
}

/**
 * Files one batch - `batch`, the bytes of a .jzm file the holder of access key `keyId` sent back, locked with their
 * submission key (spec 7.8) - into the shared file. The rules:
 *   - the key must have a grant in the shared file (an unknown or revoked key has none);
 *   - when the grant expires, the batch must have been written before it expired (the time in the batch, from the
 *     phone's clock) and have arrived before it expired (`receivedAt`, by the server's clock). The phone's clock can
 *     be set to anything, so the arrival time is what stops a key that has expired. The first write to the shared
 *     file after the expiry removes the grant (spec 11.2), so file batches as they arrive, not later on a schedule;
 *   - the batch must open with that key's submission key, which only someone who opened the shared file with that
 *     access key has: anything else was made without it (a leaked key alone isn't enough), or was changed;
 *   - the sender writes only the columns the shared file has and its grant covers. The batch's other columns are
 *     ignored, and named in `ignoredColumns`; a column it may write but with another type rejects the batch;
 *   - its rows go into the sender's own partition, whatever they say (a grant of one partition), or must name one of
 *     the sender's partitions (a grant of several): nobody files rows as someone else;
 *   - a row whose `idColumn` value is already filed changes the filed record (onDuplicate 'replace', the default).
 *     Its values that aren't empty (null or '') replace the filed ones; the others stay as they are, so a phone can
 *     send only what changed, and can't clear a field. The last change to arrive wins. The record must be in a
 *     partition the sender's grant covers, and stay in it. Rows of one id in a batch apply in order. A row that
 *     changes nothing (a batch sent twice) counts as a duplicate. With onDuplicate 'skip', a filed record is never
 *     changed, and only the first row of a new id counts;
 *   - files (attachments): each row lists the paths of its files in the batch in `filesColumn`, a json column of the
 *     shared file. Every file listed must be in the batch and every file in the batch must be listed; each must be one
 *     of `fileTypes` (see FILE_KINDS) by its first bytes, at most `maxFileBytes`, and all of them at most
 *     `maxBatchFileBytes`. A filed row's files are stored at attachments/<key id>/<sha256>.<ext>, seen by the keys that
 *     see the row's partition, and its list becomes [{ path, name, type, size }]. Identical files are stored once.
 *     A change keeps a file by keeping its entry ({ path, ... }, as filed) in the list, and [] drops them all; a file
 *     no record lists any more is removed.
 * The shared file is read once, and written once (one append).
 * Returns { filed, updated, duplicates, files, ignoredColumns }; throws RejectedBatch for a batch that must not be filed.
 */
export function fileBatch(sharedPath, ownerKey, {
  keyId, batch, idColumn = 'id', receivedAt = Date.now(), onDuplicate = 'replace',
  filesColumn = 'attachments', fileTypes = Object.keys(FILE_KINDS), maxFileBytes = 10 * MIB, maxBatchFileBytes = 50 * MIB,
}) {
  for (const type of fileTypes) if (!FILE_KINDS[type]) throw new Error(`Unknown file type '${type}': add it to FILE_KINDS`);
  if (onDuplicate !== 'replace' && onDuplicate !== 'skip') throw new Error(`onDuplicate must be 'replace' or 'skip', not '${onDuplicate}'`);
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new RejectedBatch(`'${keyId}' is not an access key id`);
  const replace = onDuplicate === 'replace';

  const shared = open(sharedPath, { key: ownerKey });
  let plan;
  try {
    plan = planBatch(shared, ownerKey, { keyId, batch, idColumn, receivedAt, replace, filesColumn, fileTypes, maxFileBytes, maxBatchFileBytes });
  } finally {
    shared.close();
  }
  const { inserts, upsert, addFiles, removeFiles, rows, ignoredColumns } = plan;
  if (inserts.length || upsert.length) {
    try {
      append(sharedPath, {
        key: ownerKey,
        insert: inserts,
        ...(upsert.length ? { upsert, keyColumns: [idColumn] } : {}),
        ...(addFiles.length ? { addFiles } : {}),
        ...(removeFiles.length ? { removeFiles } : {}),
      });
    } catch (error) {
      if (error instanceof JazminValidationError) throw new RejectedBatch(`The batch's rows don't fit the shared file: ${error.message}`);
      throw error;
    }
  }
  return { filed: inserts.length, updated: upsert.length, duplicates: rows - inserts.length - upsert.length, files: addFiles.length, ignoredColumns };
}

/** Empty values leave a filed field as it is. */
const isEmpty = (value) => value === null || value === undefined || value === '';

/** What a batch changes, worked out from one open reader of the shared file (owner key). Throws RejectedBatch. */
function planBatch(shared, ownerKey, { keyId, batch, idColumn, receivedAt, replace, filesColumn, fileTypes, maxFileBytes, maxBatchFileBytes }) {
  const grant = shared.access.grants.find((g) => g.keyId === keyId);
  if (!grant) throw new RejectedBatch(`Key ${keyId} has no grant in this file: unknown or revoked`);
  const expires = grant.expires == null ? null : Date.parse(grant.expires);
  if (expires !== null) {
    const arrived = Number(receivedAt);
    if (!Number.isFinite(expires)) throw new RejectedBatch(`Key ${keyId}'s expiry date '${grant.expires}' is not valid`); // fail closed
    if (!(arrived <= expires)) {
      throw new RejectedBatch(`The batch arrived at ${new Date(arrived).toISOString()}, after key ${keyId}'s access expired at ${grant.expires}`);
    }
  }
  const columns = new Map(shared.columns.map((c) => [c.name, c]));
  const { partitionBy, groupColumns } = shared.access;
  const covered = grant.columns === '*' ? null : new Set(grant.columns.flatMap((g) => groupColumns[g] ?? []));
  const storedFiles = new Map(shared.files.map((f) => [f.path, f]));

  // The batch: only the columns the sender may write are read.
  const writable = [];
  const ignoredColumns = [];
  let rows;
  let files;
  let withFiles;
  try {
    const reader = open(batch, { key: JazminKey.from(ownerKey).submissionKey(keyId) });
    try {
      if (expires !== null && reader.writtenAt.getTime() > expires) {
        throw new RejectedBatch(`The batch was written at ${reader.writtenAt.toISOString()}, after key ${keyId}'s access expired at ${grant.expires}`);
      }
      for (const c of reader.columns) {
        const known = columns.get(c.name);
        if (!known || (covered && !covered.has(c.name))) {
          ignoredColumns.push(c.name); // not in the shared file, or not the sender's to write
          continue;
        }
        if (known.type !== c.type) throw new RejectedBatch(`Column '${c.name}' is ${c.type} in the batch, ${known.type} in the shared file`);
        writable.push(c.name);
      }
      if (!writable.length) throw new RejectedBatch(`The batch has no column key ${keyId} may write`);
      withFiles = columns.get(filesColumn)?.type === 'json' && writable.includes(filesColumn);
      rows = [...reader.rows({ select: writable })];
      files = batchFiles(reader, withFiles ? rows.map((r) => r[filesColumn]) : [], { filesColumn, fileTypes, maxFileBytes, maxBatchFileBytes });
    } finally {
      reader.close();
    }
  } catch (error) {
    if (error instanceof RejectedBatch) throw error;
    if (error instanceof JazminKeyError) throw new RejectedBatch(`The batch doesn't open with key ${keyId}'s submission key: it was made without it, or changed`);
    if (error instanceof JazminError) throw new RejectedBatch(`The batch is not a readable .jzm file: ${error.message}`);
    throw error;
  }

  // Records already filed, by id: whole when they may be changed.
  const hasId = writable.includes(idColumn);
  const idOf = (row) => (hasId && !isEmpty(row[idColumn]) ? String(row[idColumn]) : null);
  const filed = new Map();
  const ids = hasId ? [...new Set(rows.map((r) => r[idColumn]).filter((v) => !isEmpty(v)))] : [];
  if (ids.length) {
    for (const r of shared.find({ [idColumn]: { in: ids } }, replace ? undefined : { select: [idColumn] })) filed.set(String(r[idColumn]), r);
  }

  // Partitions: the sender's own, or one it's granted; a change without one keeps the record's.
  const own = grant.rows === '*' ? null : grant.rows; // partition names
  if (partitionBy) {
    const forced = own?.length === 1 && columns.get(partitionBy).type === 'string' ? own[0] : null;
    for (const row of rows) {
      const before = filed.get(idOf(row));
      if (forced !== null) row[partitionBy] = forced;
      else if (isEmpty(row[partitionBy]) && before) row[partitionBy] = before[partitionBy];
      if (own && !own.includes(String(row[partitionBy]))) throw new RejectedBatch(`A row is for partition '${row[partitionBy]}', which key ${keyId} isn't granted`);
    }
  }

  // A row's files, at paths chosen here, seen by the keys that see the row's partition. Entries it keeps ({ path, ... })
  // must be files the filed record lists.
  const addFiles = new Map();
  const attach = (row, filedList) => {
    if (!Array.isArray(row[filesColumn])) return;
    const group = partitionBy ? String(row[partitionBy]) : '*';
    const kept = new Map(listOf(filedList).map((e) => [e?.path, e]));
    const entries = new Map(); // path in the shared file -> entry
    for (const item of row[filesColumn]) {
      if (typeof item !== 'string') {
        const entry = kept.get(item.path);
        if (!entry) throw new RejectedBatch(`Record '${row[idColumn]}' lists '${item.path}', which isn't one of its files`);
        entries.set(entry.path, entry);
        continue;
      }
      const f = files.get(item);
      const path = `attachments/${keyId}/${f.sha256}${FILE_KINDS[f.type].ext}`;
      const groups = addFiles.get(path)?.groups ?? new Set(storedFiles.get(path)?.groups ?? []);
      groups.add(group);
      addFiles.set(path, { path, content: f.bytes, type: f.type, groups });
      entries.set(path, { path, name: item.split('/').pop(), type: f.type, size: f.bytes.length });
    }
    row[filesColumn] = [...entries.values()];
  };

  // Rows by record, in batch order; rows without an id are always new records.
  const byId = new Map();
  const order = [];
  for (const row of rows) {
    const id = idOf(row);
    if (id === null) order.push(row);
    else if (!byId.has(id)) byId.set(id, [row]) && order.push(id);
    else byId.get(id).push(row);
  }
  /** Applies a row's values that aren't empty. */
  const merge = (target, row) => {
    for (const name of writable) if (!isEmpty(row[name])) target[name] = row[name];
    return target;
  };
  const inserts = [];
  const updates = [];
  for (const entry of order) {
    if (typeof entry !== 'string') {
      inserts.push(entry);
      continue;
    }
    const list = byId.get(entry);
    const before = filed.get(entry);
    if (!before) {
      inserts.push(replace ? list.slice(1).reduce(merge, list[0]) : list[0]); // a new record: later rows fill it in
      continue;
    }
    if (!replace) continue;
    if (partitionBy) {
      const was = String(before[partitionBy]);
      if (own && !own.includes(was)) throw new RejectedBatch(`Record '${entry}' is in partition '${was}', which key ${keyId} isn't granted`);
      const moved = list.find((r) => String(r[partitionBy]) !== was);
      if (moved) throw new RejectedBatch(`Record '${entry}' is in partition '${was}': a change can't move it to '${moved[partitionBy]}'`);
    }
    const after = list.reduce(merge, { ...before });
    if (withFiles && after[filesColumn] !== before[filesColumn]) attach(after, before[filesColumn]);
    if (!isDeepStrictEqual(after, { ...before })) updates.push({ before, after });
  }
  if (withFiles) for (const row of inserts) attach(row, null);

  // Files a changed record no longer lists are removed, unless another record still lists them.
  const dropped = new Set(updates.flatMap(({ before }) => listOf(before[filesColumn]).map((e) => e?.path)));
  for (const r of [...inserts, ...updates.map((u) => u.after)]) for (const e of listOf(r[filesColumn])) dropped.delete(e?.path);
  if (dropped.size) {
    const changed = new Set(updates.map((u) => String(u.after[idColumn])));
    for (const r of shared.rows({ select: [idColumn, filesColumn] })) {
      if (!changed.has(String(r[idColumn]))) for (const e of listOf(r[filesColumn])) dropped.delete(e?.path);
    }
  }

  const unchanged = (f) => {
    const known = storedFiles.get(f.path)?.groups;
    return Boolean(known) && known.length === f.groups.size && known.every((g) => f.groups.has(g));
  };
  return {
    inserts,
    upsert: updates.map((u) => u.after),
    addFiles: [...addFiles.values()].filter((f) => !unchanged(f)).map((f) => ({ ...f, groups: f.groups.has('*') ? '*' : [...f.groups] })),
    removeFiles: [...dropped].filter((path) => storedFiles.has(path)),
    rows: rows.length,
    ignoredColumns,
  };
}

const listOf = (list) => (Array.isArray(list) ? list : []);

/**
 * The files of a batch, checked: `lists` holds each row's list (paths in the batch, and entries kept). Returns
 * path -> { bytes, type, sha256 },
 * where type is the kind its first bytes show.
 */
function batchFiles(reader, lists, { filesColumn, fileTypes, maxFileBytes, maxBatchFileBytes }) {
  const listed = new Set();
  for (const list of lists) {
    if (list === null || list === undefined) continue;
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' && typeof p?.path !== 'string')) {
      throw new RejectedBatch(`Column '${filesColumn}' must list the paths of the row's files`);
    }
    for (const p of list) if (typeof p === 'string') listed.add(p); // entries kept from the filed record are checked later
  }
  const held = new Map(reader.files.map((f) => [f.path, f]));
  for (const p of listed) if (!held.has(p)) throw new RejectedBatch(`A row lists the file '${p}', which the batch doesn't hold`);
  const sizes = new Map(); // sha256 -> size: identical files count once
  for (const f of held.values()) {
    if (!listed.has(f.path)) throw new RejectedBatch(`The batch holds the file '${f.path}', which no row lists`);
    if (f.size > maxFileBytes) throw new RejectedBatch(`The file '${f.path}' has ${f.size} bytes; the limit is ${maxFileBytes}`);
    sizes.set(f.sha256, f.size);
  }
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  if (total > maxBatchFileBytes) throw new RejectedBatch(`The batch's files have ${total} bytes; the limit is ${maxBatchFileBytes}`);
  const files = new Map();
  for (const f of held.values()) {
    const bytes = reader.readFile(f.path); // checked against its SHA-256
    const type = fileTypes.find((t) => FILE_KINDS[t].test(bytes));
    if (!type) throw new RejectedBatch(`The file '${f.path}' is not a ${fileTypes.map((t) => FILE_KINDS[t].name).join(', ').replace(/, ([^,]*)$/, ' or $1')} file`);
    files.set(f.path, { bytes, type, sha256: f.sha256 });
  }
  return files;
}
