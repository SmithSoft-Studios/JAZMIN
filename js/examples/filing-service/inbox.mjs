// Files every outbox batch waiting in an inbox folder into a shared file, then compacts the file once appends pile up.
// Run it on a schedule (cron, a systemd timer, Task Scheduler, a cloud timer function), where the owner key is kept:
//
//   JAZMIN_KEY="$(cat owner.key)" node inbox.mjs shared.jzm inbox/      (or --key-file owner.key)
//
// Whatever receives uploads saves each batch as inbox/<access key id>.<anything>.jzm. Filed batches move to
// inbox/filed/; rejected ones to inbox/rejected/, each with a .txt file that gives the reason.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compact, open } from '../../src/index.js';
import { RejectedBatch, fileBatch } from './filing.mjs';

/**
 * Files the batches in `inboxDir` (oldest name first), then compacts the shared file when it has `compactAfter` or
 * more appends: regrouped, so each person's rows are stored together, when its sort order allows that.
 * Returns { batches, filed, duplicates, rejected: [{ batch, reason }], compacted }.
 */
export function processInbox(sharedPath, inboxDir, ownerKey, { compactAfter = 50, now } = {}) {
  const filedDir = path.join(inboxDir, 'filed');
  const rejectedDir = path.join(inboxDir, 'rejected');
  fs.mkdirSync(filedDir, { recursive: true });
  fs.mkdirSync(rejectedDir, { recursive: true });
  const report = { batches: 0, filed: 0, duplicates: 0, rejected: [], compacted: false };
  for (const name of fs.readdirSync(inboxDir).filter((n) => n.endsWith('.jzm')).sort()) {
    const from = path.join(inboxDir, name);
    try {
      const result = fileBatch(sharedPath, ownerKey, { keyId: name.split('.')[0], batch: fs.readFileSync(from), now });
      report.batches++;
      report.filed += result.filed;
      report.duplicates += result.duplicates;
      fs.renameSync(from, path.join(filedDir, name));
    } catch (error) {
      if (!(error instanceof RejectedBatch)) throw error; // anything else (a busy file, a full disk) stops the run: try again later
      fs.renameSync(from, path.join(rejectedDir, name));
      fs.writeFileSync(path.join(rejectedDir, `${name}.txt`), `${error.message}\n`);
      report.rejected.push({ batch: name, reason: error.message });
    }
  }

  const reader = open(sharedPath, { key: ownerKey });
  const { appendCount, sortedBy } = reader;
  const partitionBy = reader.access?.partitionBy;
  reader.close();
  if (appendCount >= compactAfter) {
    const regroup = Boolean(partitionBy) && (!sortedBy || sortedBy[0] === partitionBy); // sortedBy: undefined when unsorted
    compact(sharedPath, { key: ownerKey, regroup });
    report.compacted = true;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const keyFileAt = args.indexOf('--key-file');
  const key = keyFileAt >= 0 ? fs.readFileSync(args.splice(keyFileAt, 2)[1], 'utf8').trim() : process.env.JAZMIN_KEY;
  const [sharedPath, inboxDir] = args;
  if (!sharedPath || !inboxDir || !key) {
    console.error('Usage: JAZMIN_KEY=jzk1-... node inbox.mjs <shared.jzm> <inbox folder>   (or --key-file <file>)');
    process.exit(2);
  }
  console.log(JSON.stringify(processInbox(sharedPath, inboxDir, key), null, 2));
}
