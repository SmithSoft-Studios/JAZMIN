// jazmin verify (GitHub issue #260): a file's publisher signature (spec 6.9, User Guide section 26) from the command
// line. The command trusts only the built-in roots and takes no option that adds one (6.9.4): `trust` is for this
// repository's tests, as in src/publisher.js.
import fs from 'node:fs';
import path from 'node:path';
import { JazminError, JazminKeyError, JazminValidationError } from '../src/errors.js';
import { verifyPublisher } from '../src/publisher.js';

const SHOWN = new Set(['certified', 'withdrawn', 'superseded']);
const REASONS = {
  digest: 'it was changed after it was signed',
  coverage: 'bytes were added to it after it was signed',
  block: 'its signature block is damaged',
  algorithms: 'a signature was removed from it or swapped',
  signature: "a signature doesn't match it",
  chain: "a certificate wasn't issued for signing documents by a trusted root",
  timestamp: "its time-stamp doesn't hold",
  log: "its signature isn't in the public log",
  revoked: "the signer's certificate was revoked before it was signed",
  facts: "its signed facts don't match",
};

/** The status in plain words, with the publisher where the specification lets a reader show one (6.9.8). */
function headline(r) {
  const who = SHOWN.has(r.status) ? `${r.name} (${r.kind === 'individual' ? 'verified individual' : 'verified publisher'})` : '';
  switch (r.status) {
    case 'certified': return `Certified: signed by ${who}, not changed since`;
    case 'withdrawn': return `Withdrawn: validly signed by ${who}, who withdrew it. Don't use it`;
    case 'superseded': return `Replaced: validly signed by ${who}, who replaced it with a newer version. Don't use it`;
    case 'signed': return 'Signed by an unknown key: not changed since, but no trusted root certifies the key, so no name is shown. Treat it as unsigned';
    case 'changed':
    case 'invalid': return `Not valid: ${REASONS[r.reason] ?? r.reason}`;
    case 'none': return 'Not signed: the file has no publisher signature';
    default: return 'Not verified: not a valid JAZMIN file';
  }
}

const days = (from, to) => Math.floor((to - Date.parse(from)) / 86_400_000);

function details(r, given, now) {
  const rows = [
    ['Publisher', `${r.name}${r.organization && r.organization !== r.name ? `, ${r.organization}` : ''} (${r.kind})`],
    ['Registration', r.registration], ['Country', r.country], ['Domain', r.domain],
    ['Document', `${r.code} (${r.documentKind})`],
    ['Signed', `${r.timestamp} (time-stamp)${r.signedAt && r.signedAt !== r.timestamp ? `; the signer says ${r.signedAt}` : ''}`],
  ];
  for (const c of r.cosigners) rows.push(['Co-signer', [c.name, c.kind, c.registration, c.country, c.domain].filter(Boolean).join(', ')]);
  if (r.facts) rows.push(['Facts', Object.entries(r.facts).map(([k, v]) => `${k} ${v}`).join(', ')]);
  else if (r.factsNeedKey) rows.push(['Facts', given ? "encrypted: the key or password given doesn't open them" : 'encrypted: give a key or password to read them']);
  const age = r.checkedAt === null ? null : days(r.checkedAt, now);
  rows.push(['Revocation', r.checkedAt === null ? 'not checked' : `checked ${r.checkedAt} (${age === 0 ? 'today' : age === 1 ? '1 day ago' : `${age} days ago`})`]);
  return rows.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `  ${`${k}:`.padEnd(14)}${v}`);
}

/**
 * Verifies each file and prints the result: details for one file, one line per file and a summary for several, or the
 * results as JSON. Options: `key`, `password`, `revocationList` (its text) and `json`. Returns the exit code: 0 when
 * every file is certified, else 1.
 */
export function verifyFiles(files, options = {}, { trust, out, err, now } = {}) {
  const library = { key: options.key || undefined, password: options.password || undefined, revocationList: options.revocationList };
  const at = now ?? (trust?.at instanceof Date ? trust.at.getTime() : trust?.at ?? Date.now());
  const results = files.map((file) => {
    if (!fs.existsSync(file)) return { file, error: `No such file: ${file}` };
    try {
      return { file, result: trust ? verifyPublisher(file, library, trust) : verifyPublisher(file, library) };
    } catch (error) {
      // A mistyped key or option is the command's problem, not the file's: it stops the command.
      if (!(error instanceof JazminError) || error instanceof JazminKeyError || error instanceof JazminValidationError) throw error;
      return { file, error: error.message };
    }
  });
  for (const r of results) if (r.error) err(`${r.file}: ${r.error}`);
  const read = results.filter((r) => r.result);
  if (options.json) {
    if (files.length === 1) {
      if (read.length) out(JSON.stringify(read[0].result, null, 2));
    } else {
      out(JSON.stringify(read.map((r) => ({ file: path.basename(r.file), ...r.result })), null, 2));
    }
  } else if (files.length === 1) {
    if (read.length) {
      const r = read[0].result;
      out(`${path.basename(files[0])}: ${headline(r)}`);
      if (SHOWN.has(r.status)) for (const line of details(r, Boolean(library.key || library.password), at)) out(line);
    }
  } else {
    for (const r of results) out(`${path.basename(r.file)}: ${r.result ? headline(r.result) : 'not read'}`);
    const counts = new Map();
    for (const r of results) counts.set(r.result?.status ?? 'not read', (counts.get(r.result?.status ?? 'not read') ?? 0) + 1);
    out(`${files.length} files: ${[...counts].map(([status, n]) => `${n} ${status}`).join(', ')}`);
  }
  return results.every((r) => r.result?.status === 'certified') ? 0 : 1;
}
