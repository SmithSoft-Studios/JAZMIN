// Filing benchmark: what it costs a phone to write a batch, and the filing service (js/examples/filing-service) to
// file it - time, peak memory and how much the shared file grows - for shared files of 10,000, 100,000 and 250,000
// records (100 people, one partition and one access key each, 6 columns, a sorted index on id).
// Each filing scenario runs in its own process, each run on a fresh copy of the shared file. Peak memory is measured on
// the first run alone: the process's peak resident memory above what it used before it. Time is the median of 5 more
// runs. Compaction uses one thread, as the inbox runner does.
// Run: node bench/filing.mjs [records...]        (default: 10000 100000 250000)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JazminKey, compact, write } from '../src/index.js';
import { fileBatch } from '../examples/filing-service/filing.mjs';
import '../browser/jazmin-browser.js';

const PEOPLE = 100;
const RUNS = 5;
const PHOTO_BYTES = 200_000;
const here = fileURLToPath(import.meta.url);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const msSince = (start) => Number(process.hrtime.bigint() - start) / 1e6;

// ---- one scenario, in its own process -------------------------------------------------------------------------

if (process.argv[2] === '--run') {
  const s = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const owner = fs.readFileSync(s.ownerKeyFile, 'utf8');
  const batch = s.batch ? fs.readFileSync(s.batch) : null;
  const work = path.join(path.dirname(s.shared), `work-${process.pid}.jzm`);
  let result;
  const once = () => {
    fs.copyFileSync(s.shared, work);
    const start = process.hrtime.bigint();
    result = s.compact ? compact(work, { key: owner, regroup: true, maxDegreeOfParallelism: 1 }) : fileBatch(work, owner, { keyId: s.keyId, batch });
    return msSince(start);
  };
  const before = process.memoryUsage().rss;
  once(); // the first run: its peak memory (later runs would add garbage not yet collected), and a warm-up
  const peak = process.resourceUsage().maxRSS * 1024 - before;
  const ms = median(Array.from({ length: RUNS }, once));
  const growth = fs.statSync(work).size - fs.statSync(s.shared).size;
  fs.rmSync(work, { force: true });
  process.stdout.write(JSON.stringify({ ms, peakMb: Math.max(0, peak) / 1048576, growth, result }));
  process.exit(0);
}

// ---- data -----------------------------------------------------------------------------------------------------

const columns = [
  { name: 'id', type: 'string', nullable: false, index: 'sorted' },
  { name: 'person', type: 'string', nullable: false },
  { name: 'note', type: 'string' },
  { name: 'amount', type: 'float' },
  { name: 'at', type: 'datetime' },
  { name: 'attachments', type: 'json' },
];
const batchColumns = columns.map(({ index, ...c }) => c); // browsers don't write indexes
const personName = (p) => `P${String(p).padStart(3, '0')}`;
const record = (i, p, note = `visit ${i}`) => ({
  id: `r${String(i).padStart(7, '0')}`, person: personName(p), note, amount: (i % 1000) / 4,
  at: new Date(Date.UTC(2026, 0, 1) + i * 60_000), attachments: null,
});
/** A photo: random bytes after a JPEG start, so it doesn't compress, as a real photo doesn't. */
const photo = () => {
  const bytes = crypto.randomBytes(PHOTO_BYTES);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
};

/** A batch as a phone writes it, in the browser writer, locked with a submission key. Returns { bytes, ms }. */
async function phoneBatch(key, records, files = []) {
  const start = process.hrtime.bigint();
  const blob = await globalThis.JazminBrowser.write(records, { columns: batchColumns, key, files });
  const bytes = Buffer.from(await blob.arrayBuffer());
  return { bytes, ms: msSince(start) };
}

// ---- the benchmark --------------------------------------------------------------------------------------------

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (!sizes.length) sizes.push(10_000, 100_000, 250_000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-filing-bench-'));
const results = new Map(); // scenario -> [cell per size]
const add = (scenario, cell) => results.set(scenario, [...(results.get(scenario) ?? []), cell]);
const kb = (bytes) => `${Math.round(bytes / 1024).toLocaleString('en')} KB`;

let phone = null;
for (const size of sizes) {
  const owner = JazminKey.generate();
  const ownerKeyFile = path.join(dir, `owner-${size}.key`);
  fs.writeFileSync(ownerKeyFile, owner.toString()); // a throwaway key for this run; never printed
  const keys = Array.from({ length: PEOPLE }, () => owner.createAccessKey());
  const perPerson = Math.ceil(size / PEOPLE);
  const shared = path.join(dir, `shared-${size}.jzm`);
  const start = process.hrtime.bigint();
  write(shared, Array.from({ length: size }, (_, i) => record(i, Math.floor(i / perPerson))), {
    columns, key: owner,
    access: { partitionBy: 'person', grants: keys.map((key, p) => ({ key, rows: [personName(p)], columns: '*' })) },
  });
  add('Write the shared file', `${Math.round(msSince(start)).toLocaleString('en')} ms, ${kb(fs.statSync(shared).size)}`);

  // Person P000 sends: one new record; 50 new ones; 50 changes to records they filed; 10 records with a photo each.
  const keyId = keys[0].id;
  const key = owner.submissionKey(keyId).toString();
  const one = await phoneBatch(key, [record(size, 0)]);
  const fifty = await phoneBatch(key, Array.from({ length: 50 }, (_, i) => record(size + i, 0)));
  const changes = await phoneBatch(key, Array.from({ length: 50 }, (_, i) => record(i, 0, `checked ${i}`)));
  const photos = await phoneBatch(key, Array.from({ length: 10 }, (_, i) => ({ ...record(size + 100 + i, 0), attachments: [`p${i}.jpg`] })),
    Array.from({ length: 10 }, (_, i) => ({ path: `p${i}.jpg`, content: photo() })));
  if (!phone) {
    // The phone's side doesn't depend on the shared file: measured once (Node's WebCrypto and compression).
    const fiftyTimes = [];
    const photoTimes = [];
    for (let r = 0; r < RUNS; r++) {
      fiftyTimes.push((await phoneBatch(key, Array.from({ length: 50 }, (_, i) => record(size + i, 0)))).ms);
      photoTimes.push((await phoneBatch(key, [record(1, 0)], [{ path: 'p.jpg', content: photo() }])).ms);
    }
    phone = { fifty: `${median(fiftyTimes).toFixed(1)} ms, ${kb(fifty.bytes.length)}`, photo: `${median(photoTimes).toFixed(1)} ms per 200 KB photo, ${kb(photos.bytes.length)} for 10` };
  }

  // Shared files the later scenarios start from: after the photos; after the changes; after 50 single-record appends.
  const variant = (name, batches) => {
    const file = path.join(dir, `shared-${size}-${name}.jzm`);
    fs.copyFileSync(shared, file);
    for (const b of batches) fileBatch(file, owner.toString(), { keyId, batch: b });
    return file;
  };
  const withPhotos = variant('photos', [photos.bytes]);
  const changed = variant('changed', [changes.bytes]);
  const appended = variant('appended', await Promise.all(Array.from({ length: 50 }, async (_, i) => (await phoneBatch(key, [record(size + 1000 + i, 0)])).bytes)));
  const dropPhoto = await phoneBatch(key, [{ ...record(size + 100, 0), attachments: [] }]); // the photo is no longer listed

  const scenario = (name, from, batch, extra = {}) => {
    const batchFile = batch ? path.join(dir, `batch-${size}-${name.replace(/\W+/g, '-')}.jzm`) : null;
    if (batch) fs.writeFileSync(batchFile, batch);
    const config = path.join(dir, `scenario-${size}.json`);
    fs.writeFileSync(config, JSON.stringify({ shared: from, batch: batchFile, keyId, ownerKeyFile, ...extra }));
    const out = JSON.parse(execFileSync(process.execPath, [here, '--run', config], { encoding: 'utf8' }));
    add(name, `${out.ms.toFixed(1)} ms, ${out.peakMb.toFixed(0)} MB${extra.compact ? '' : `, +${kb(out.growth)}`}`);
    return out;
  };
  scenario('File 1 new record', shared, one.bytes);
  scenario('File 50 new records', shared, fifty.bytes);
  scenario('Change 50 records', shared, changes.bytes);
  scenario('The same 50 changes again (nothing changes)', changed, changes.bytes);
  scenario('File 10 records with a 200 KB photo each', shared, photos.bytes);
  scenario('Change a record to drop its photo', withPhotos, dropPhoto.bytes);
  scenario('Compact and regroup after 50 appends', appended, null, { compact: true });
}

console.log(`\nFiling benchmark - Node ${process.version}, ${os.cpus()[0].model.trim()}, ${PEOPLE} people\n`);
console.log(`Phone: write 50 records: ${phone.fifty}`);
console.log(`Phone: write records with photos: ${phone.photo}\n`);
console.log(`| Records in the shared file | ${sizes.map((n) => n.toLocaleString('en')).join(' | ')} |`);
console.log(`|---|${sizes.map(() => '---:').join('|')}|`);
for (const [name, cells] of results) console.log(`| ${name} | ${cells.join(' | ')} |`);
console.log('\nFiling cells: median time, peak memory above the process at rest, and how much the shared file grew.');
fs.rmSync(dir, { recursive: true, force: true });
