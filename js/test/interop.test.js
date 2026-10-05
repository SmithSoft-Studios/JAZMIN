// Reads every fixture in spec/fixtures (written by JS and by .NET) and checks it
// against the shared dataset, so both implementations stay byte-compatible.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JazminAccessKey, issueUnlockToken, open, toJSON } from '../src/index.js';
import { APPEND_STATE } from '../src/reader.js';
import {
  ACCESS_VIEWS, COUNTRY_COLUMNS, COUNTRY_VIEWS, FILES_VIEWS, FIXTURE_EXPIRY, FIXTURE_PACKAGE, PARTITIONS_SPLIT, PARTITION_VIEWS, appendedLive,
  countryRows, fixtureFiles, toCanonical,
} from './fixture-helpers.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const dataset = JSON.parse(fs.readFileSync(path.join(dir, 'dataset.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
const exportShape = JSON.parse(fs.readFileSync(path.join(dir, 'shape.json'), 'utf8'));
const expectedShape = JSON.parse(fs.readFileSync(path.join(dir, 'shape-expected.json'), 'utf8'));

function optionsFor(file) {
  if (file.endsWith('-key.jzm')) return { key: keys.key };
  if (file.endsWith('-password.jzm')) return { password: keys.password };
  return {};
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jzm') && !f.endsWith('-access.jzm'));
const accessFiles = fs.readdirSync(dir).filter((f) => f.endsWith('-access.jzm'));
/** Dataset rows a fixture should contain: appended fixtures have rows with id < 10 deleted. */
const liveRows = (file) => {
  if (file.includes('-many-partitions')) return dataset.rows.slice(0, PARTITIONS_SPLIT[1]).filter(appendedLive);
  return file.includes('-appended') ? dataset.rows.filter(appendedLive) : dataset.rows;
};

for (const file of accessFiles) {
  for (const [keyName, visible, hidden] of file.includes('-many-partitions') ? PARTITION_VIEWS : ACCESS_VIEWS) {
    test(`interop: ${file} opened with the ${keyName === 'key' ? 'owner' : keyName} key shows exactly its grant`, () => {
      const options = { key: keys[keyName], accessState: false };
      if (keyName === 'carol') options.unlockToken = issueUnlockToken(path.join(dir, file), keys.key, JazminAccessKey.parse(keys.carol));
      const reader = open(path.join(dir, file), options);
      try {
        if (keyName === 'carol' || keyName === 'erin') {
          assert.deepEqual([reader.access.online, reader.access.expires], [keyName === 'carol', FIXTURE_EXPIRY]);
        }
        const columns = dataset.columns.filter((c) => !hidden.includes(c.name));
        assert.deepEqual(reader.columns.map((c) => c.name), columns.map((c) => c.name));
        const live = liveRows(file);
        const expected = live.filter(visible).map((r) => Object.fromEntries(columns.map((c) => [c.name, r[c.name]])));
        assert.deepEqual([...reader.rows()].map((r) => toCanonical(columns, r)), expected);
        assert.equal(reader.hiddenRowCount, live.length - expected.length);
      } finally {
        reader.close();
      }
    });
  }
}

// Embedded files (format 1.3): same files, same per-key visibility, from either writer.
const expectedFiles = new Map(fixtureFiles().map((f) => [f.path, Buffer.from(f.content)]));
for (const writer of ['js', 'dotnet']) {
  for (const [file, views] of [[`${writer}-files-key.jzm`, { key: FILES_VIEWS.key }], [`${writer}-files-access.jzm`, FILES_VIEWS]]) {
    for (const [keyName, paths] of Object.entries(views)) {
      test(`interop: ${file} opened with the ${keyName === 'key' ? 'owner' : keyName} key shows exactly its files`, (t) => {
        const full = path.join(dir, file);
        if (!fs.existsSync(full)) return t.skip(`run the ${writer === 'js' ? 'fixture script' : '.NET tests'} to generate ${file}`);
        const options = { key: keys[keyName], accessState: false };
        if (keyName === 'carol') options.unlockToken = issueUnlockToken(full, keys.key, JazminAccessKey.parse(keys.carol));
        const reader = open(full, options);
        try {
          assert.deepEqual(reader.files.map((f) => f.path).sort(), paths);
          for (const p of paths) assert.ok(reader.readFile(p).equals(expectedFiles.get(p)), p);
          assert.deepEqual(reader.package, FIXTURE_PACKAGE);
        } finally {
          reader.close();
        }
      });
    }
  }
}

// Embedded files written by the browser writer: the same files; browsers write no package settings.
test('interop: browser-files-key.jzm opened with the owner key shows its files', () => {
  const reader = open(path.join(dir, 'browser-files-key.jzm'), { key: keys.key });
  try {
    assert.deepEqual(reader.files.map((f) => f.path).sort(), FILES_VIEWS.key);
    for (const p of FILES_VIEWS.key) assert.ok(reader.readFile(p).equals(expectedFiles.get(p)), p);
    assert.equal(reader.package, undefined);
  } finally {
    reader.close();
  }
});

// The owner's chunk map (spec 7.6.5): written by either library, read by both; older files without one read as before.
for (const writer of ['js', 'dotnet']) {
  for (const [file, hasMap] of [
    [`${writer}-access.jzm`, true], [`${writer}-appended-access.jzm`, true], [`${writer}-many-partitions-access.jzm`, true],
    [`${writer}-tables-access.jzm`, true], [`${writer}-files-access.jzm`, false],
  ]) {
    test(`interop: ${file} ${hasMap ? 'has' : 'has no'} owner chunk map, and owner lookups by id find the rows`, () => {
      const full = path.join(dir, file);
      const all = (() => {
        const reader = open(full, { key: keys.key });
        try {
          const map = reader[APPEND_STATE].chunkMap;
          assert.equal(map !== null, hasMap);
          if (map) assert.equal(map.chunks, reader.chunkCount);
          return [...reader.rows()];
        } finally {
          reader.close();
        }
      })();
      const ids = [all[0].id, all[Math.floor(all.length / 2)].id, all[all.length - 1].id, -1];
      for (const id of ids) {
        const reader = open(full, { key: keys.key });
        try {
          assert.deepEqual([...reader.find({ id })], all.filter((r) => r.id === id), `id ${id}`);
        } finally {
          reader.close();
        }
      }
    });
  }
}

// Several tables (D-3): the first table is the dataset (checked above); the second is a lookup table of countries.
const expectedCountries = countryRows(dataset.rows);
for (const writer of ['js', 'dotnet']) {
  for (const [file, views] of [[`${writer}-tables.jzm`, [['plain', () => true]]], [`${writer}-tables-access.jzm`, COUNTRY_VIEWS]]) {
    for (const [keyName, visible] of views) {
      test(`interop: ${file} opened with the ${keyName === 'key' ? 'owner' : keyName} key reads its second table by name`, (t) => {
        const full = path.join(dir, file);
        if (!fs.existsSync(full)) return t.skip(`run the ${writer === 'js' ? 'fixture script' : '.NET tests'} to generate ${file}`);
        const people = open(full, keyName === 'plain' ? {} : { key: keys[keyName], accessState: false });
        const countries = people.openTable('countries');
        try {
          assert.deepEqual(people.tables, ['people', 'countries']);
          assert.deepEqual(countries.columns.map((c) => c.name), COUNTRY_COLUMNS.map((c) => c.name));
          assert.deepEqual([...countries.rows()].map((r) => toCanonical(COUNTRY_COLUMNS, r)), expectedCountries.filter(visible));
          if (keyName !== 'bob' && keyName !== 'sally' && keyName !== 'erin') {
            assert.deepEqual([...countries.find({ country: 'NA' })].map((r) => r.country), ['NA']); // its own index
          }
        } finally {
          countries.close();
          people.close();
        }
      });
    }
  }
}

for (const writer of ['js', 'dotnet']) {
  test(`fixtures written by ${writer} are present`, (t) => {
    const mine = [...files, ...accessFiles].filter((f) => f.startsWith(`${writer}-`));
    if (writer === 'dotnet' && mine.length === 0) t.skip('run the .NET tests to generate dotnet-*.jzm');
    else assert.ok(mine.length >= 7, `expected 7 ${writer} fixtures, found ${mine.length}`);
  });
}

for (const file of files) {
  test(`interop: ${file} matches the shared dataset`, () => {
    const reader = open(path.join(dir, file), optionsFor(file));
    try {
      assert.deepEqual(reader.columns.map((c) => [c.name, c.type]), dataset.columns.map((c) => [c.name, c.type]));
      assert.deepEqual(reader.metadata, dataset.metadata);
      const columns = reader.columns;
      const live = liveRows(file);
      assert.deepEqual([...reader.rows()].map((r) => toCanonical(columns, r)), live);

      const expectIds = (filter, predicate) => {
        const ids = [...reader.find(filter)].map((r) => String(r.id));
        assert.deepEqual(ids, live.filter(predicate).map((r) => r.id), JSON.stringify(filter));
      };
      expectIds({ country: 'BW' }, (r) => r.country === 'BW');
      expectIds({ name: { icontains: 'johnson' } }, (r) => r.name?.toLowerCase().includes('johnson'));
      expectIds({ joined: { gte: '2015-03-01T00:00:00.000Z', lt: '2015-03-05T00:00:00.000Z' } },
        (r) => r.joined !== null && r.joined >= '2015-03-01T00:00:00.000Z' && r.joined < '2015-03-05T00:00:00.000Z');
      expectIds({ id: { gt: '9007199254740992' } }, (r) => BigInt(r.id) > 9007199254740992n);
      expectIds({ active: true, score: { gt: 50 } }, (r) => r.active === true && r.score !== null && r.score > 50);
      if (!file.includes('-appended')) {
        // The shared export shape gives the same output from files written by either library.
        assert.deepEqual(JSON.parse(toJSON(reader, { shape: exportShape })), expectedShape);
      }
      if (file.includes('-paged')) {
        // Every sorted index is in small pages (spec 8.3); a prefix lookup spans several pages.
        expectIds({ name: { startsWith: 'Person 1' } }, (r) => r.name?.startsWith('Person 1') === true);
        expectIds({ id: { lte: '20' } }, (r) => BigInt(r.id) <= 20n);
        expectIds({ country: { isNull: true } }, (r) => r.country === null);
      }
    } finally {
      reader.close();
    }
  });
}
