// A TEST build of the browser scripts' publisher-signature check (spec 6.9): the same code, trusting the test root of
// spec/fixtures/publisher instead of SmithSoft's, with every result marked `test: true`. For this repository's tests,
// the viewer's end-to-end tests and the demo gallery only. Never write it into js/browser: the npm package ships that
// folder, and released scripts trust SmithSoft's roots only (spec 6.9.4).
//
//   node scripts/publisher-test-build.mjs <folder> [--at 2026-10-17T12:00:00Z]
//     writes jazmin-browser.js and jazmin-browser-publisher.js, test builds, into <folder>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const js = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectors = path.resolve(js, '../spec/fixtures/publisher');
const RELEASED = 'const PUBLISHER_TRUST = Object.freeze({ roots: Object.freeze([]), arc: null, test: false, at: null });';

/** The test PKI: its root (base64 DER) and the test arc of the id-jazmin-* identifiers (spec 6.9.4). */
export function testTrust() {
  const expected = JSON.parse(fs.readFileSync(path.join(vectors, 'expected.json'), 'utf8'));
  return { roots: expected.trustedRoots.map((p) => fs.readFileSync(path.join(vectors, p)).toString('base64')), arc: expected.oids.arc };
}

/** A built browser script (the full one or the publisher add-on) as a test build; `at`: a fixed time to verify at. */
export function testBuild(text, { at } = {}) {
  if (text.split(RELEASED).length !== 2) throw new Error('The script has no released trust line to replace (rebuild it: node scripts/build-browser.mjs)');
  const { roots, arc } = testTrust();
  const trust = `const PUBLISHER_TRUST = Object.freeze({ roots: Object.freeze(${JSON.stringify(roots)}), arc: ${JSON.stringify(arc)}, test: true, at: ${at ? Date.parse(at) : null} }); // TEST ROOT: never release`;
  return `// TEST BUILD: trusts the test root of spec/fixtures/publisher, not SmithSoft's. Never release.\n${text.replace(RELEASED, () => trust)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, ...rest] = process.argv.slice(2);
  if (!folder) throw new Error('Usage: node scripts/publisher-test-build.mjs <folder> [--at <time>]');
  const out = path.resolve(folder);
  if (out === path.join(js, 'browser') || out.startsWith(path.join(js, 'browser') + path.sep)) throw new Error('Never write a test build into js/browser: npm ships it');
  const at = rest[0] === '--at' ? rest[1] : undefined;
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['jazmin-browser.js', 'jazmin-browser-publisher.js']) {
    fs.writeFileSync(path.join(out, name), testBuild(fs.readFileSync(path.join(js, 'browser', name), 'utf8'), { at }));
  }
  console.log(`wrote test builds of jazmin-browser.js and jazmin-browser-publisher.js to ${out}`);
}
