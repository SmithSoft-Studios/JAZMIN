// Filing the files people send back (submissions) into a shared file (USER-GUIDE 15.6, docs/design/browser-writer.md).
// Runs where the owner (master) key is kept: a server or a scheduled job you control - never a phone or a web page.
// The rules are the library's fileSubmission(); this keeps the sample's own names for them.
import { JazminSubmissionRejectedError, fileSubmission } from '../../src/index.js';

/** A batch that must not be filed. The message says why; the run goes on with the next batch. */
export const RejectedBatch = JazminSubmissionRejectedError;

/**
 * Files one batch - `batch`, the bytes of a .jzm file the holder of access key `keyId` sent back, locked with their
 * submission key (spec 7.8) - into the shared file, by the library's rules (fileSubmission: the sender's grant and
 * expiry, partitions, columns, records sent again, files checked by their first bytes and size). Options: idColumn,
 * receivedAt, onDuplicate, filesColumn, fileTypes, maxFileBytes, maxBatchFileBytes.
 * Returns { filed, updated, duplicates, files, ignoredColumns }; throws RejectedBatch for a batch that must not be filed.
 */
export function fileBatch(sharedPath, ownerKey, { keyId, batch, ...rules }) {
  const { sender, ...result } = fileSubmission(sharedPath, batch, { ...rules, key: ownerKey, keyId });
  return result;
}
