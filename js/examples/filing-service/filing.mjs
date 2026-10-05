// Filing the files people send back (submissions) into a shared file (USER-GUIDE 15.6, docs/design/browser-writer.md).
// Runs where the owner (master) key is kept: a server or a scheduled job you control - never a phone or a web page.
import { isDeepStrictEqual } from 'node:util';
import { JazminError, JazminKey, JazminKeyError, JazminValidationError, accessKeyOf, append, open } from '../../src/index.js';

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
 *   - its columns must be columns of the shared file, with the same types;
 *   - its rows go into the sender's own partition, whatever they say (a grant of one partition), or must name one of
 *     the sender's partitions (a grant of several): nobody files rows as someone else;
 *   - a row whose `idColumn` value is already filed replaces the filed record (onDuplicate 'replace', the default),
 *     so the last to arrive wins. The record must be in a partition the sender's grant covers, and stay in it. Only the
 *     columns the batch has and the grant covers change; the others keep their filed values. A row that changes
 *     nothing (a batch sent twice) is counted as a duplicate. With onDuplicate 'skip', such rows are skipped instead.
 *     Within a batch, the last row of an id counts ('skip': the first);
 *   - files (attachments): each row lists the paths of its files in the batch in `filesColumn`, a json column of the
 *     shared file. Every file listed must be in the batch and every file in the batch must be listed; each must be one
 *     of `fileTypes` (see FILE_KINDS) by its first bytes, at most `maxFileBytes`, and all of them at most
 *     `maxBatchFileBytes`. A filed row's files are stored at attachments/<key id>/<sha256>.<ext>, seen by the keys that
 *     see the row's partition, and its list becomes [{ path, name, type, size }]. Identical files are stored once.
 *     A replacement keeps a file by keeping its entry ({ path, ... }, as filed) in the list; a file no record lists
 *     any more is removed.
 * Returns { filed, updated, duplicates, files }; throws RejectedBatch for a batch that must not be filed.
 */
export function fileBatch(sharedPath, ownerKey, {
  keyId, batch, idColumn = 'id', receivedAt = Date.now(), onDuplicate = 'replace',
  filesColumn = 'attachments', fileTypes = Object.keys(FILE_KINDS), maxFileBytes = 10 * MIB, maxBatchFileBytes = 50 * MIB,
}) {
  for (const type of fileTypes) if (!FILE_KINDS[type]) throw new Error(`Unknown file type '${type}': add it to FILE_KINDS`);
  if (onDuplicate !== 'replace' && onDuplicate !== 'skip') throw new Error(`onDuplicate must be 'replace' or 'skip', not '${onDuplicate}'`);
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new RejectedBatch(`'${keyId}' is not an access key id`);
  try {
    accessKeyOf(sharedPath, ownerKey, keyId); // the key must still have a grant
  } catch (error) {
    if (error instanceof JazminValidationError) throw new RejectedBatch(`Key ${keyId} has no grant in this file: unknown or revoked`);
    throw error;
  }

  const shared = open(sharedPath, { key: ownerKey });
  let grant;
  let columns;
  let partitionBy;
  let storedFiles;
  let groupColumns;
  try {
    grant = shared.access.grants.find((g) => g.keyId === keyId);
    columns = new Map(shared.columns.map((c) => [c.name, c]));
    partitionBy = shared.access.partitionBy;
    storedFiles = new Map(shared.files.map((f) => [f.path, f]));
    groupColumns = shared.access.groupColumns;
  } finally {
    shared.close();
  }
  const expires = grant.expires == null ? null : Date.parse(grant.expires);
  if (expires !== null) {
    const arrived = Number(receivedAt);
    if (!Number.isFinite(expires)) throw new RejectedBatch(`Key ${keyId}'s expiry date '${grant.expires}' is not valid`); // fail closed
    if (!(arrived <= expires)) {
      throw new RejectedBatch(`The batch arrived at ${new Date(arrived).toISOString()}, after key ${keyId}'s access expired at ${grant.expires}`);
    }
  }

  const withFiles = columns.get(filesColumn)?.type === 'json';
  let rows;
  let files;
  let batchColumns;
  try {
    const reader = open(batch, { key: JazminKey.from(ownerKey).submissionKey(keyId) });
    try {
      if (expires !== null && reader.writtenAt.getTime() > expires) {
        throw new RejectedBatch(`The batch was written at ${reader.writtenAt.toISOString()}, after key ${keyId}'s access expired at ${grant.expires}`);
      }
      for (const c of reader.columns) {
        const known = columns.get(c.name);
        if (!known) throw new RejectedBatch(`The batch has a column '${c.name}' the shared file doesn't have`);
        if (known.type !== c.type) throw new RejectedBatch(`Column '${c.name}' is ${c.type} in the batch, ${known.type} in the shared file`);
      }
      batchColumns = reader.columns.map((c) => c.name);
      rows = [...reader.rows()];
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

  const own = grant.rows === '*' ? null : grant.rows; // partition names
  if (partitionBy) {
    for (const row of rows) {
      if (own?.length === 1 && columns.get(partitionBy).type === 'string') row[partitionBy] = own[0];
      else if (own && !own.includes(String(row[partitionBy]))) {
        throw new RejectedBatch(`A row is for partition '${row[partitionBy]}', which key ${keyId} isn't granted`);
      }
    }
  }

  // Records already filed, by id: whole when they may be replaced.
  const replace = onDuplicate === 'replace';
  const hasId = columns.has(idColumn);
  const filed = new Map();
  if (hasId && rows.length) {
    const reader = open(sharedPath, { key: ownerKey });
    try {
      const ids = rows.map((r) => r[idColumn]).filter((v) => v != null);
      for (const r of reader.find({ [idColumn]: { in: ids } }, replace ? undefined : { select: [idColumn] })) filed.set(String(r[idColumn]), r);
    } finally {
      reader.close();
    }
  }
  const counted = new Map(); // id -> the batch row that counts for it: the last ('replace') or the first ('skip')
  for (const row of rows) {
    const id = hasId ? row[idColumn] : null;
    if (id != null && (replace || !counted.has(String(id)))) counted.set(String(id), row);
  }
  const isNew = (r) => !hasId || r[idColumn] == null || (counted.get(String(r[idColumn])) === r && !filed.has(String(r[idColumn])));
  const inserts = rows.filter(isNew);

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
  if (withFiles) for (const row of inserts) attach(row, null);

  // Replacements: the filed record, with the columns the batch has and the sender's grant covers.
  const covered = grant.columns === '*' ? null : new Set(grant.columns.flatMap((g) => groupColumns[g] ?? []));
  const writable = batchColumns.filter((name) => !covered || covered.has(name));
  const updates = [];
  for (const [id, row] of replace ? counted : []) {
    const before = filed.get(id);
    if (!before) continue;
    if (partitionBy) {
      const was = String(before[partitionBy]);
      if (own && !own.includes(was)) throw new RejectedBatch(`Record '${id}' is in partition '${was}', which key ${keyId} isn't granted`);
      if (String(row[partitionBy]) !== was) throw new RejectedBatch(`Record '${id}' is in partition '${was}': a change can't move it to '${row[partitionBy]}'`);
    }
    const after = { ...before };
    for (const name of writable) after[name] = row[name];
    if (withFiles && writable.includes(filesColumn)) attach(after, before[filesColumn]);
    if (!isDeepStrictEqual(after, { ...before })) updates.push({ before, after });
  }

  // Files a replaced record no longer lists are removed, unless another record still lists them.
  const dropped = new Set(updates.flatMap(({ before }) => listOf(before[filesColumn]).map((e) => e?.path)));
  for (const r of [...inserts, ...updates.map((u) => u.after)]) for (const e of listOf(r[filesColumn])) dropped.delete(e?.path);
  if (dropped.size) {
    const replaced = new Set(updates.map((u) => String(u.after[idColumn])));
    const reader = open(sharedPath, { key: ownerKey });
    try {
      for (const r of reader.rows({ select: [idColumn, filesColumn] })) {
        if (!replaced.has(String(r[idColumn]))) for (const e of listOf(r[filesColumn])) dropped.delete(e?.path);
      }
    } finally {
      reader.close();
    }
  }
  const removeFiles = [...dropped].filter((path) => storedFiles.has(path));

  const unchanged = (f) => {
    const known = storedFiles.get(f.path)?.groups;
    return Boolean(known) && known.length === f.groups.size && known.every((g) => f.groups.has(g));
  };
  const newFiles = [...addFiles.values()].filter((f) => !unchanged(f)).map((f) => ({ ...f, groups: f.groups.has('*') ? '*' : [...f.groups] }));

  const upsert = updates.map((u) => u.after);
  if (inserts.length || upsert.length) {
    try {
      append(sharedPath, {
        key: ownerKey,
        insert: inserts,
        ...(upsert.length ? { upsert, keyColumns: [idColumn] } : {}),
        ...(newFiles.length ? { addFiles: newFiles } : {}),
        ...(removeFiles.length ? { removeFiles } : {}),
      });
    } catch (error) {
      if (error instanceof JazminValidationError) throw new RejectedBatch(`The batch's rows don't fit the shared file: ${error.message}`);
      throw error;
    }
  }
  return { filed: inserts.length, updated: upsert.length, duplicates: rows.length - inserts.length - upsert.length, files: newFiles.length };
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
