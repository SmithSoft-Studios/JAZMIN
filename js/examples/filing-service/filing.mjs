// Filing the files people send back (submissions) into a shared file (USER-GUIDE 15.6, docs/design/browser-writer.md).
// Runs where the owner (master) key is kept: a server or a scheduled job you control - never a phone or a web page.
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
 *   - the key must have a grant in the shared file (an unknown or revoked key has none) that has not expired;
 *   - the batch must open with that key's submission key, which only someone who opened the shared file with that
 *     access key has: anything else was made without it (a leaked key alone isn't enough), or was changed;
 *   - its columns must be columns of the shared file, with the same types;
 *   - its rows go into the sender's own partition, whatever they say (a grant of one partition), or must name one of
 *     the sender's partitions (a grant of several): nobody files rows as someone else;
 *   - rows whose `idColumn` value is already in the shared file are skipped, so a batch sent twice is filed once;
 *   - files (attachments): each row lists the paths of its files in the batch in `filesColumn`, a json column of the
 *     shared file. Every file listed must be in the batch and every file in the batch must be listed; each must be one
 *     of `fileTypes` (see FILE_KINDS) by its first bytes, at most `maxFileBytes`, and all of them at most
 *     `maxBatchFileBytes`. A filed row's files are stored at attachments/<key id>/<sha256>.<ext>, seen by the keys that
 *     see the row's partition, and its list becomes [{ path, name, type, size }]. Identical files are stored once.
 * Returns { filed, duplicates, files }; throws RejectedBatch for a batch that must not be filed.
 */
export function fileBatch(sharedPath, ownerKey, {
  keyId, batch, idColumn = 'id', now = Date.now(),
  filesColumn = 'attachments', fileTypes = Object.keys(FILE_KINDS), maxFileBytes = 10 * MIB, maxBatchFileBytes = 50 * MIB,
}) {
  for (const type of fileTypes) if (!FILE_KINDS[type]) throw new Error(`Unknown file type '${type}': add it to FILE_KINDS`);
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
  try {
    grant = shared.access.grants.find((g) => g.keyId === keyId);
    columns = new Map(shared.columns.map((c) => [c.name, c]));
    partitionBy = shared.access.partitionBy;
    storedFiles = new Map(shared.files.map((f) => [f.path, f]));
  } finally {
    shared.close();
  }
  if (grant.expires && !(now <= Date.parse(grant.expires))) throw new RejectedBatch(`Key ${keyId}'s access expired at ${grant.expires}`);

  const withFiles = columns.get(filesColumn)?.type === 'json';
  let rows;
  let files;
  try {
    const reader = open(batch, { key: JazminKey.from(ownerKey).submissionKey(keyId) });
    try {
      for (const c of reader.columns) {
        const known = columns.get(c.name);
        if (!known) throw new RejectedBatch(`The batch has a column '${c.name}' the shared file doesn't have`);
        if (known.type !== c.type) throw new RejectedBatch(`Column '${c.name}' is ${c.type} in the batch, ${known.type} in the shared file`);
      }
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

  if (partitionBy) {
    const own = grant.rows === '*' ? null : grant.rows; // partition names
    for (const row of rows) {
      if (own?.length === 1 && columns.get(partitionBy).type === 'string') row[partitionBy] = own[0];
      else if (own && !own.includes(String(row[partitionBy]))) {
        throw new RejectedBatch(`A row is for partition '${row[partitionBy]}', which key ${keyId} isn't granted`);
      }
    }
  }

  let fresh = rows;
  if (columns.has(idColumn) && rows.length) {
    const seen = new Set();
    const reader = open(sharedPath, { key: ownerKey });
    try {
      const ids = rows.map((r) => r[idColumn]).filter((v) => v !== null && v !== undefined);
      for (const r of reader.find({ [idColumn]: { in: ids } }, { select: [idColumn] })) seen.add(String(r[idColumn]));
    } finally {
      reader.close();
    }
    fresh = rows.filter((r) => {
      const id = r[idColumn];
      if (id === null || id === undefined) return true;
      if (seen.has(String(id))) return false;
      seen.add(String(id)); // twice in one batch: once
      return true;
    });
  }

  // The filed rows' files, at paths chosen here, seen by the keys that see the row's partition.
  const addFiles = new Map();
  for (const row of withFiles ? fresh : []) {
    if (!Array.isArray(row[filesColumn])) continue;
    const group = partitionBy ? String(row[partitionBy]) : '*';
    row[filesColumn] = [...new Set(row[filesColumn])].map((p) => {
      const f = files.get(p);
      const path = `attachments/${keyId}/${f.sha256}${FILE_KINDS[f.type].ext}`;
      const groups = addFiles.get(path)?.groups ?? new Set(storedFiles.get(path)?.groups ?? []);
      groups.add(group);
      addFiles.set(path, { path, content: f.bytes, type: f.type, groups });
      return { path, name: p.split('/').pop(), type: f.type, size: f.bytes.length };
    });
  }
  const unchanged = (f) => {
    const known = storedFiles.get(f.path)?.groups;
    return Boolean(known) && known.length === f.groups.size && known.every((g) => f.groups.has(g));
  };
  const newFiles = [...addFiles.values()].filter((f) => !unchanged(f)).map((f) => ({ ...f, groups: f.groups.has('*') ? '*' : [...f.groups] }));

  if (fresh.length) {
    try {
      append(sharedPath, { key: ownerKey, insert: fresh, ...(newFiles.length ? { addFiles: newFiles } : {}) });
    } catch (error) {
      if (error instanceof JazminValidationError) throw new RejectedBatch(`The batch's rows don't fit the shared file: ${error.message}`);
      throw error;
    }
  }
  return { filed: fresh.length, duplicates: rows.length - fresh.length, files: newFiles.length };
}

/**
 * The files of a batch, checked: `lists` holds each row's list of paths. Returns path -> { bytes, type, sha256 },
 * where type is the kind its first bytes show.
 */
function batchFiles(reader, lists, { filesColumn, fileTypes, maxFileBytes, maxBatchFileBytes }) {
  const listed = new Set();
  for (const list of lists) {
    if (list === null || list === undefined) continue;
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) throw new RejectedBatch(`Column '${filesColumn}' must list the paths of the row's files`);
    for (const p of list) listed.add(p);
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
