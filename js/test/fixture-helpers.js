// Canonical (JSON-safe) form used by spec/fixtures/dataset.json:
// int -> decimal string, datetime -> ISO-8601 string, binary -> base64, others as JSON.

export function fromCanonical(columns, row) {
  const out = {};
  for (const c of columns) {
    const v = row[c.name] ?? null;
    if (v === null) out[c.name] = null;
    else if (c.type === 'int') out[c.name] = Number.isSafeInteger(Number(v)) ? Number(v) : BigInt(v);
    else if (c.type === 'datetime') out[c.name] = new Date(v);
    else if (c.type === 'binary') out[c.name] = Buffer.from(v, 'base64');
    else out[c.name] = v;
  }
  return out;
}

export function toCanonical(columns, row) {
  const out = {};
  for (const c of columns) {
    const v = row[c.name] ?? null;
    if (v === null) out[c.name] = null;
    else if (c.type === 'int') out[c.name] = String(v);
    else if (c.type === 'datetime') out[c.name] = v.toISOString();
    else if (c.type === 'binary') out[c.name] = Buffer.from(v).toString('base64');
    else out[c.name] = v;
  }
  return out;
}

/** Access options for the *-access.jzm fixtures (mirrored in the .NET InteropTests). */
export function accessFixture(keys) {
  return {
    partitionBy: 'country',
    columnGroups: { pii: ['balance', 'blob'] },
    grants: [
      { key: keys.bob, rows: ['ZA'], columns: ['*'], label: 'Bob' },
      { key: keys.sally, rows: ['BW', 'NA'], columns: '*', label: 'Sally' },
      { key: keys.carol, columns: ['*'], label: 'Carol', mode: 'online', expires: FIXTURE_EXPIRY },
      { key: keys.erin, columns: ['*'], label: 'Erin', expires: FIXTURE_EXPIRY },
    ],
  };
}

export const FIXTURE_EXPIRY = '2099-01-01T00:00:00.000Z';

/** What each key should see in an access fixture: [keyName, rowPredicate, hiddenColumns]. */
export const ACCESS_VIEWS = [
  ['key', () => true, []],
  ['bob', (r) => r.country === 'ZA', ['balance', 'blob']],
  ['sally', (r) => r.country === 'BW' || r.country === 'NA', []],
  ['carol', () => true, ['balance', 'blob']], // online: needs an unlock token
  ['erin', () => true, ['balance', 'blob']], // offline, expiring
];

/**
 * The *-tables*.jzm fixtures (several tables, D-3): the dataset as table 'people', then table 'countries' with one row
 * per country (canonical form). In the access variant both are partitioned by country, with the access fixture's grants.
 */
export const COUNTRY_COLUMNS = [
  { name: 'country', type: 'string', index: ['sorted'] },
  { name: 'people', type: 'int' },
  { name: 'firstId', type: 'int' },
];

export function countryRows(datasetRows) {
  const byCountry = new Map();
  for (const r of datasetRows) {
    if (r.country === null) continue;
    const c = byCountry.get(r.country) ?? { country: r.country, people: '0', firstId: r.id };
    c.people = String(Number(c.people) + 1);
    byCountry.set(r.country, c);
  }
  return [...byCountry.values()].sort((a, b) => (a.country < b.country ? -1 : a.country > b.country ? 1 : 0));
}

export function tablesFixture(datasetColumns, access) {
  const { partitionBy, columnGroups, ...grants } = access ? accessFixture(access) : {};
  return {
    ...(access ? { access: grants } : {}),
    tables: [
      { name: 'people', columns: datasetColumns, ...(access ? { partitionBy, columnGroups } : {}) },
      { name: 'countries', columns: COUNTRY_COLUMNS, sortedBy: ['country'], ...(access ? { partitionBy } : {}) },
    ],
  };
}

/** Countries each key sees in *-tables-access.jzm (the grants of ACCESS_VIEWS). */
export const COUNTRY_VIEWS = [
  ['key', () => true],
  ['bob', (c) => c.country === 'ZA'],
  ['sally', (c) => c.country === 'BW' || c.country === 'NA'],
  ['erin', () => true],
];

/** The *-appended*.jzm fixtures: rows [0, APPEND_SPLIT) written, the rest appended, then APPEND_DELETE applied. */
export const APPEND_SPLIT = 400;
export const APPEND_DELETE = { id: { lt: 10 } };

/** Rows of the dataset still live in an appended fixture. */
export const appendedLive = (r) => BigInt(r.id) >= 10n;

/**
 * *-many-partitions-access.jzm: rows [0, PARTITIONS_SPLIT[0]) written partitioned by id (more partitions than the
 * header lists, so a partition table), then rows up to PARTITIONS_SPLIT[1] appended (a delta) and APPEND_DELETE applied.
 */
export const PARTITIONS_SPLIT = [100, 120];

/** Access options for *-many-partitions-access.jzm (mirrored in the .NET InteropTests). */
export function partitionsFixture(keys) {
  return {
    partitionBy: 'id',
    columnGroups: { pii: ['balance', 'blob'] },
    grants: [
      { key: keys.bob, rows: ['7', '42', '105'], columns: ['*'], label: 'Bob' },
      { key: keys.sally, rows: '*', columns: '*', label: 'Sally' },
    ],
  };
}

/** What each key should see in *-many-partitions-access.jzm: [keyName, rowPredicate, hiddenColumns]. */
export const PARTITION_VIEWS = [
  ['key', () => true, []],
  ['bob', (r) => ['7', '42', '105'].includes(r.id), ['balance', 'blob']],
  ['sally', () => true, []],
];

/** Embedded files of the *-files-key.jzm and *-files-access.jzm fixtures (mirrored in the .NET InteropTests). */
export function fixtureFiles() {
  const pattern = Buffer.from(Array.from({ length: 600_000 }, (_, i) => (i * 31 + 7) & 255));
  return [
    { path: 'index.html', content: '<h1>JAZMIN interop</h1>' },
    { path: 'docs/za.bin', content: pattern, groups: ['ZA'] },
    { path: 'docs/shared.bin', content: pattern, groups: ['BW', 'NA'] }, // same bytes: stored once
    { path: 'img/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>', groups: ['template'] },
    { path: 'empty.txt', content: '' },
  ];
}

export const FIXTURE_PACKAGE = { entry: 'index.html', title: 'Interop' };

/** Access options for *-files-access.jzm: the fixture grants, with Bob also granted the 'template' file group. */
export function filesAccessFixture(keys) {
  const access = accessFixture(keys);
  access.grants[0] = { ...access.grants[0], files: ['template'] };
  return access;
}

/** Which embedded files each key sees in *-files-access.jzm. */
export const FILES_VIEWS = {
  key: ['docs/shared.bin', 'docs/za.bin', 'empty.txt', 'img/logo.svg', 'index.html'],
  bob: ['docs/za.bin', 'empty.txt', 'img/logo.svg', 'index.html'],
  sally: ['docs/shared.bin', 'empty.txt', 'index.html'],
  carol: ['docs/shared.bin', 'docs/za.bin', 'empty.txt', 'index.html'],
  erin: ['docs/shared.bin', 'docs/za.bin', 'empty.txt', 'index.html'],
};
