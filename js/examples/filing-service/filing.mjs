// Filing outbox batches into a shared file (USER-GUIDE 15.6, docs/design/browser-writer.md).
// Runs where the owner (master) key is kept: a server or a scheduled job you control - never a phone or a web page.
import { JazminError, JazminKeyError, JazminValidationError, accessKeyOf, append, open } from '../../src/index.js';

/** A batch that must not be filed. The message says why; the run goes on with the next batch. */
export class RejectedBatch extends Error {
  constructor(message) {
    super(message);
    this.name = 'RejectedBatch';
  }
}

/**
 * Files one outbox batch - `batch`, the bytes of a .jzm file the holder of access key `keyId` sent - into the shared
 * file. The rules:
 *   - the key must have a grant in the shared file (an unknown or revoked key has none) that has not expired;
 *   - the batch must open with that key's outbox key: anything else was not made by that key, or was changed;
 *   - its columns must be columns of the shared file, with the same types;
 *   - its rows go into the sender's own partition, whatever they say (a grant of one partition), or must name one of
 *     the sender's partitions (a grant of several): nobody files rows as someone else;
 *   - rows whose `idColumn` value is already in the shared file are skipped, so a batch sent twice is filed once.
 * Returns { filed, duplicates }; throws RejectedBatch for a batch that must not be filed.
 */
export function fileBatch(sharedPath, ownerKey, { keyId, batch, idColumn = 'id', now = Date.now() }) {
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new RejectedBatch(`'${keyId}' is not an access key id`);
  let sender;
  try {
    sender = accessKeyOf(sharedPath, ownerKey, keyId);
  } catch (error) {
    if (error instanceof JazminValidationError) throw new RejectedBatch(`Key ${keyId} has no grant in this file: unknown or revoked`);
    throw error;
  }

  const shared = open(sharedPath, { key: ownerKey });
  let grant;
  let columns;
  let partitionBy;
  try {
    grant = shared.access.grants.find((g) => g.keyId === keyId);
    columns = new Map(shared.columns.map((c) => [c.name, c]));
    partitionBy = shared.access.partitionBy;
  } finally {
    shared.close();
  }
  if (grant.expires && !(now <= Date.parse(grant.expires))) throw new RejectedBatch(`Key ${keyId}'s access expired at ${grant.expires}`);

  let rows;
  try {
    const reader = open(batch, { key: sender.outboxKey() });
    try {
      for (const c of reader.columns) {
        const known = columns.get(c.name);
        if (!known) throw new RejectedBatch(`The batch has a column '${c.name}' the shared file doesn't have`);
        if (known.type !== c.type) throw new RejectedBatch(`Column '${c.name}' is ${c.type} in the batch, ${known.type} in the shared file`);
      }
      rows = [...reader.rows()];
    } finally {
      reader.close();
    }
  } catch (error) {
    if (error instanceof RejectedBatch) throw error;
    if (error instanceof JazminKeyError) throw new RejectedBatch(`The batch doesn't open with key ${keyId}'s outbox key: another key made it, or it was changed`);
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

  if (fresh.length) {
    try {
      append(sharedPath, { key: ownerKey, insert: fresh });
    } catch (error) {
      if (error instanceof JazminValidationError) throw new RejectedBatch(`The batch's rows don't fit the shared file: ${error.message}`);
      throw error;
    }
  }
  return { filed: fresh.length, duplicates: rows.length - fresh.length };
}
