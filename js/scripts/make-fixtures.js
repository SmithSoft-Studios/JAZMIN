// Regenerates spec/fixtures: the shared interop dataset and the JS-written .jzm files.
// Run: node scripts/make-fixtures.js   (only when the dataset or format changes)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JazminKey, append, open, toJSON, write } from '../src/index.js';
import { CHUNK_MAP, PAGING } from '../src/writer.js';
import {
  APPEND_DELETE, APPEND_SPLIT, COUNTRY_COLUMNS, FIXTURE_PACKAGE, PARTITIONS_SPLIT, accessFixture, countryRows, filesAccessFixture, fixtureFiles,
  fromCanonical, partitionsFixture, tablesFixture,
} from '../test/fixture-helpers.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
fs.mkdirSync(dir, { recursive: true });

const countries = ['ZA', 'NA', 'BW', 'ZW', 'Côte d’Ivoire'];
const dataset = {
  columns: [
    { name: 'id', type: 'int', nullable: false, description: 'Row identifier', index: ['sorted'] },
    { name: 'name', type: 'string', index: ['trigram', 'sorted'] },
    { name: 'country', type: 'string', index: ['sorted'] },
    { name: 'score', type: 'float' },
    { name: 'balance', type: 'decimal' },
    { name: 'joined', type: 'datetime', index: ['sorted'] },
    { name: 'active', type: 'bool', index: ['sorted'] },
    { name: 'blob', type: 'binary' },
    { name: 'extra', type: 'json', attributes: { note: 'free-form' } },
  ],
  metadata: { title: 'JAZMIN interop dataset', version: 1 },
  rows: Array.from({ length: 500 }, (_, i) => ({
    id: i === 499 ? '9007199254740993' : String(i), // last id exceeds 2^53
    name: i % 9 === 0 ? null : `Person ${i} ${['Johnson', 'Smith', 'Ndlovu', 'Zoë 👋'][i % 4]}`,
    country: i % 25 === 0 ? null : countries[i % countries.length],
    score: i % 11 === 0 ? null : i * 0.25 - 40,
    balance: i % 13 === 0 ? null : `${i}.${String(i % 100).padStart(2, '0')}`,
    joined: i % 17 === 0 ? null : new Date(Date.UTC(2015, 0, 1) + i * 3_600_000 * 7).toISOString(),
    active: i % 5 === 0 ? null : i % 2 === 0,
    blob: i % 3 === 0 ? null : Buffer.from([i & 0xff, (i >> 8) & 0xff, 7]).toString('base64'),
    extra: i % 4 === 0 ? null : { i, tags: ['x', i % 2 === 0] },
  })),
};
fs.writeFileSync(path.join(dir, 'dataset.json'), JSON.stringify(dataset, null, 1));

// Reuse existing keys, so regenerating the JS fixtures keeps the .NET-written ones valid.
const keysPath = path.join(dir, 'keys.json');
const ownerKey = JazminKey.generate();
const keys = fs.existsSync(keysPath) ? JSON.parse(fs.readFileSync(keysPath, 'utf8')) : {
  key: ownerKey.export(),
  password: 'jazmin-interop',
  kdfIterations: 1000,
  // Access-controlled fixtures: the owner is `key`; Bob sees ZA rows without the pii columns,
  // Sally sees BW and NA rows with every column.
  bob: ownerKey.createAccessKey().toString(),
  sally: ownerKey.createAccessKey().toString(),
  // Time-limited grants (far-future expiry so the fixtures stay valid): Carol online, Erin offline.
  carol: ownerKey.createAccessKey().toString(),
  erin: ownerKey.createAccessKey().toString(),
};
fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));

const rows = dataset.rows.map((r) => fromCanonical(dataset.columns, r));
const base = { columns: dataset.columns, metadata: dataset.metadata, chunkRows: 64 };
write(path.join(dir, 'js-plain.jzm'), rows, base);
write(path.join(dir, 'js-brotli.jzm'), rows, { ...base, codec: 'brotli' });
write(path.join(dir, 'js-key.jzm'), rows, { ...base, key: keys.key });
write(path.join(dir, 'js-password.jzm'), rows, { ...base, password: keys.password, kdfIterations: keys.kdfIterations });
// Key slots in small pages (spec 7.6.4), so readers of either library find slots across pages.
write(path.join(dir, 'js-access.jzm'), rows, { ...base, key: keys.key, access: accessFixture(keys), [PAGING]: { keySlotPageBytes: 300 } });

// Sorted indexes in many small pages (spec 8.3).
write(path.join(dir, 'js-paged-key.jzm'), rows, { ...base, key: keys.key, [PAGING]: { pageBytes: 512 } });
// The same, with keys and first row ids as differences (reader feature 'index-deltas', spec 8.1).
write(path.join(dir, 'js-paged-compact.jzm'), rows, { ...base, compactIndexes: true, [PAGING]: { pageBytes: 512 } });

// Embedded files (spec 6.8).
const withFiles = { ...base, files: fixtureFiles(), package: FIXTURE_PACKAGE };
write(path.join(dir, 'js-files-key.jzm'), rows, { ...withFiles, key: keys.key });
// Written as before the owner chunk map (spec 7.6.5), so readers keep reading such files.
write(path.join(dir, 'js-files-access.jzm'), rows, { ...withFiles, key: keys.key, access: filesAccessFixture(keys), [CHUNK_MAP]: false });

// Written by the browser writer (js/browser/jazmin-browser.js), as a page would: without indexes, which browsers don't
// write. The other library reads them in its interop tests.
await import('../browser/jazmin-browser.js');
const browserColumns = dataset.columns.map(({ index, ...column }) => column);
for (const [name, lock] of [['browser-plain.jzm', {}], ['browser-key.jzm', { key: keys.key }], ['browser-password.jzm', { password: keys.password, kdfIterations: keys.kdfIterations }]]) {
  const blob = await globalThis.JazminBrowser.write(rows, { columns: browserColumns, metadata: dataset.metadata, chunkRows: 64, ...lock });
  fs.writeFileSync(path.join(dir, name), Buffer.from(await blob.arrayBuffer()));
}
// Embedded files written in the browser (no viewer package settings: browsers don't write them).
const browserFiles = await globalThis.JazminBrowser.write(rows, { columns: browserColumns, metadata: dataset.metadata, chunkRows: 64, key: keys.key, files: fixtureFiles() });
fs.writeFileSync(path.join(dir, 'browser-files-key.jzm'), Buffer.from(await browserFiles.arrayBuffer()));

// Appended fixtures (spec 11.2): 400 rows written, then the last 100 appended and ids < 10 deleted.
for (const [name, options] of [
  ['js-appended.jzm', {}],
  ['js-appended-access.jzm', { key: keys.key, access: accessFixture(keys) }],
]) {
  const file = path.join(dir, name);
  write(file, rows.slice(0, APPEND_SPLIT), { ...base, ...options });
  append(file, { key: options.key, insert: rows.slice(APPEND_SPLIT), delete: APPEND_DELETE, chunkRows: 64 });
}

// More partitions than the header lists (spec 6.3): a partition table, then an append that writes a delta.
const manyPartitions = path.join(dir, 'js-many-partitions-access.jzm');
write(manyPartitions, rows.slice(0, PARTITIONS_SPLIT[0]), { ...base, key: keys.key, access: partitionsFixture(keys) });
append(manyPartitions, { key: keys.key, insert: rows.slice(...PARTITIONS_SPLIT), delete: APPEND_DELETE, chunkRows: 64 });

// Several tables (D-3): the dataset, then a lookup table of countries; plain and access-controlled.
const countryTable = countryRows(dataset.rows).map((r) => fromCanonical(COUNTRY_COLUMNS, r));
write(path.join(dir, 'js-tables.jzm'), { people: rows, countries: countryTable }, { ...tablesFixture(dataset.columns), metadata: dataset.metadata, chunkRows: 64 });
write(path.join(dir, 'js-tables-access.jzm'), { people: rows, countries: countryTable }, { ...tablesFixture(dataset.columns, keys), key: keys.key, metadata: dataset.metadata, chunkRows: 64 });

// Export shape (docs/design/export-shapes.md): the expected output of spec/fixtures/shape.json on the dataset.
const shape = JSON.parse(fs.readFileSync(path.join(dir, 'shape.json'), 'utf8'));
fs.writeFileSync(path.join(dir, 'shape-expected.json'), `${toJSON(open(write(null, rows, base)), { shape, pretty: true })}`);

// Links between tables (export-shapes.md section 7): spec/fixtures/shape-links.json on js-tables.jzm.
const linkShape = JSON.parse(fs.readFileSync(path.join(dir, 'shape-links.json'), 'utf8'));
const tablesFile = open(path.join(dir, 'js-tables.jzm'));
fs.writeFileSync(path.join(dir, 'shape-links-expected.json'), `${toJSON(tablesFile, { shape: linkShape, pretty: true })}`);
tablesFile.close();

console.log(`Fixtures written to ${dir}`);
