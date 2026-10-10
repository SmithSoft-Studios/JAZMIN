// The browser reader's exports: JSON, CSV and XML text equal to the library's (toJSON / toCSV / toXML), for every value
// type, nested columns, filters, a selection of columns, offset and limit, and each format's options; as a Blob for
// downloads, with progress and Stop for long exports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportString, open } from '../src/index.js';
import '../browser/jazmin-browser.js';

const { JazminBrowser } = globalThis;
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');
const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
const EXPORT = { json: JazminBrowser.toJSON, csv: JazminBrowser.toCSV, xml: JazminBrowser.toXML };
const FORMAT_OPTIONS = { json: [{ pretty: true }, { omitNulls: true }], csv: [{ delimiter: ';', newline: '\n' }], xml: [{ root: 'people', row: 'person' }] };

for (const [file, options] of [['js-key.jzm', { key: keys.key }], ['dotnet-key.jzm', { key: keys.key }], ['js-nested.jzm', {}], ['js-tables.jzm', {}]]) {
  test(`exports of ${file} equal the library's`, async () => {
    const library = open(path.join(fixtures, file), options);
    const browser = await JazminBrowser.open(fs.readFileSync(path.join(fixtures, file)), options);
    const first = library.columns[0].name;
    const someRows = [...library.find(null, { limit: 3 })].map((r) => r[first]);
    for (const format of ['json', 'csv', 'xml']) {
      for (const exportOptions of [
        {},
        { filter: { [first]: { in: someRows } } },
        { select: library.columns.slice(0, 2).map((c) => c.name), offset: 3, limit: 7 },
        ...FORMAT_OPTIONS[format],
      ]) {
        assert.equal(await EXPORT[format](browser, exportOptions), exportString(library, format, exportOptions), `${format} ${JSON.stringify(exportOptions)}`);
      }
    }
    library.close();
  });
}

test('exportBlob: the text as a Blob of its type, with progress and Stop', async () => {
  const bytes = fs.readFileSync(path.join(fixtures, 'js-key.jzm'));
  const browser = await JazminBrowser.open(bytes, { key: keys.key });
  const library = open(bytes, { key: keys.key });
  const seen = [];
  const blob = await JazminBrowser.exportBlob(browser, 'csv', { onProgress: (p) => seen.push(p) });
  assert.equal(blob.type, 'text/csv');
  assert.equal(await blob.text(), exportString(library, 'csv'));
  assert.ok(seen.length > 1 && seen.at(-1).done === seen.at(-1).total && seen.at(-1).matches === library.rowCount);
  assert.equal((await JazminBrowser.exportBlob(browser, 'json')).type, 'application/json');
  assert.equal((await JazminBrowser.exportBlob(browser, 'xml')).type, 'application/xml');
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(JazminBrowser.exportBlob(browser, 'json', { signal: stop.signal }), { name: 'AbortError' });
  await assert.rejects(JazminBrowser.exportBlob(browser, 'yaml'), /Unknown export format 'yaml'/);
});
