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

/**
 * The *-document-key.jzm fixtures: a document whose files say what viewers may do with them (actions), and page
 * settings for its PDFs (spec 6.8, format 1.4). Mirrored in the .NET InteropTests.
 */
export const DOCUMENT_FILES = [
  { path: 'index.html', content: '<h1>JAZMIN interop document</h1>', actions: { print: false, pdf: { format: 'A5', margin: { top: '12mm' } } } },
  { path: 'data.csv', content: 'a,b\n1,2\n', actions: { open: false, save: false } },
  { path: 'logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
];
export const DOCUMENT_PACKAGE = { entry: 'index.html', title: 'Document', pdf: { format: 'Letter', landscape: true, scale: 0.9 } };

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

/**
 * Nested columns (spec 5.4): spec/fixtures/nested.json holds these columns and rows, the rows in the form JSON output
 * writes them (all fields, nulls written; decimals as numbers, so without trailing zeros; dates with milliseconds;
 * binary as base64). Each library writes <writer>-nested.jzm from it, and its JSON output of either file is the rows.
 */
export const NESTED_COLUMNS = [
  { name: 'id', type: 'int', nullable: false },
  {
    name: 'staff', type: 'list', item: {
      type: 'object', fields: [
        { name: 'name', type: 'string' },
        { name: 'active', type: 'bool' },
        { name: 'score', type: 'float' },
        { name: 'pay', type: 'decimal' },
        { name: 'since', type: 'datetime' },
        { name: 'photo', type: 'binary' },
        { name: 'extra', type: 'json' },
        { name: 'tags', type: 'list', item: { type: 'string', nullable: false } },
        { name: 'projects', type: 'list', item: { type: 'object', fields: [{ name: 'code', type: 'string' }, { name: 'hours', type: 'int' }] } },
      ],
    },
  },
  { name: 'head', type: 'object', fields: [{ name: 'city', type: 'string' }, { name: 'at', type: 'object', fields: [{ name: 'lat', type: 'float' }, { name: 'lng', type: 'float' }] }] },
  { name: 'grid', type: 'list', item: { type: 'list', item: { type: 'int' } } },
];

export function nestedFixtureRows() {
  return Array.from({ length: 150 }, (_, i) => ({
    id: i,
    staff: i % 7 === 0 ? null : i % 5 === 0 ? [] : Array.from({ length: 1 + (i % 4) }, (_, n) => (n === 2 ? null : {
      name: n === 1 ? null : `E${i}-${n} ${['Zoë 👋', 'Côte d’Ivoire', 'plain'][i % 3]}`,
      active: n === 3 ? null : (i + n) % 2 === 0,
      score: (i * 10 + n) / 4,
      pay: n === 1 ? null : i * 100 + n + 0.5,
      since: new Date(Date.UTC(2024, 0, 1) + (i + n) * 86_400_000 + n * 1_000).toISOString(),
      photo: n === 0 ? Buffer.from([i & 255, 0, 255]).toString('base64') : null,
      extra: n === 3 ? { i, list: [1, 'x', null] } : null,
      tags: i % 4 === 0 ? [] : ['a', `t${n}`],
      projects: n === 1 ? null : Array.from({ length: (i + n) % 3 }, (_, k) => ({ code: k === 1 ? null : `P${(i + k) % 9}`, hours: k === 2 ? null : k * 8 })),
    })),
    head: i % 3 === 0 ? null : { city: i % 2 === 0 ? 'Durban' : null, at: i % 4 === 1 ? null : { lat: -29.5 + i / 8, lng: 31 - i / 16 } },
    grid: i % 4 === 0 ? null : [[], [1, null, i], [null]],
  }));
}

/**
 * *-nested-grown.jzm (spec 5.4, fields added by appending): rows [0, NESTED_GROWN_SPLIT) of nested.json written before
 * the last fields existed (staff items without `projects`, `head` without `at`), the rest appended with every field.
 */
export const NESTED_GROWN_SPLIT = 100;

/** The nested columns without the fields added later. */
export function nestedColumnsBefore(columns) {
  const copy = JSON.parse(JSON.stringify(columns));
  copy.find((c) => c.name === 'staff').item.fields.pop();
  copy.find((c) => c.name === 'head').fields.pop();
  return copy;
}

/** A nested.json row without the fields added later (to write before they existed), or with them null (as read back). */
export function nestedRowBefore(row, asRead) {
  const strip = (o, name) => {
    if (!o) return o;
    const { [name]: dropped, ...rest } = o;
    void dropped;
    return asRead ? { ...rest, [name]: null } : rest;
  };
  return { ...row, staff: row.staff && row.staff.map((s) => strip(s, 'projects')), head: strip(row.head, 'at') };
}

/**
 * Filters on nested columns (spec 9.2) over nested.json's rows, each with the condition it means in plain JavaScript (on
 * the rows as nested.json holds them): spec/fixtures/nested-filters.json lists each filter and the ids it selects.
 */
export const NESTED_FILTERS = [
  [{ staff: { any: { pay: { gte: 1000 }, active: true } } }, (r) => r.staff?.some((s) => s && s.pay !== null && s.pay >= 1000 && s.active === true)],
  [{ staff: { all: { score: { gt: 3 } } } }, (r) => r.staff !== null && r.staff.every((s) => s && s.score > 3)],
  [{ staff: { any: { tags: { any: 't1' } } } }, (r) => r.staff?.some((s) => s?.tags?.includes('t1'))],
  [{ staff: { any: { projects: { any: { hours: 8, code: null } } } } }, (r) => r.staff?.some((s) => s?.projects?.some((p) => p.hours === 8 && p.code === null))],
  [{ head: { match: { city: 'Durban', at: { match: { lat: { lt: -20 } } } } } }, (r) => r.head?.city === 'Durban' && r.head.at !== null && r.head.at.lat < -20],
  [{ head: { match: { at: null } } }, (r) => r.head !== null && r.head.at === null],
  [{ grid: { any: { any: { gte: 100 } } } }, (r) => r.grid?.some((row) => row?.some((v) => v !== null && v >= 100))],
  [{ or: [{ staff: { any: { name: { startsWith: 'E1' } } } }, { head: null }] }, (r) => r.staff?.some((s) => s?.name?.startsWith('E1')) || r.head === null],
  [{ not: { staff: { any: { since: { gte: '2024-03-01T00:00:00.000Z' } } } } }, (r) => !r.staff?.some((s) => s && s.since >= '2024-03-01T00:00:00.000Z')],
  [{ staff: { any: { pay: 100.5 } } }, (r) => r.staff?.some((s) => s?.pay === 100.5)],
];
