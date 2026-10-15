// Builds the browser scripts from js/browser/src (TASKS P-26): the full jazmin-browser.js, as pages have always loaded
// it, and a smaller core with add-ons, so a page loads only what it uses:
//
//   jazmin-browser-core.js     reading files, exports as JSON, CSV and XML
//   jazmin-browser-shapes.js   export shapes and the file's saved shapes (reader.shapes(), { shape } exports)
//   jazmin-browser-writer.js   writing files, and changes made through a document (writeChanges)
//   jazmin-browser-queries.js  queries with arrow functions (JazminBrowser.from)
//
// Each part is code at the top level of the script's function; it ends with `const API_<PART> = { ... };`, what it
// adds to JazminBrowser. An add-on reaches the core's functions through an internal object the core leaves on
// JazminBrowser; the core reaches an add-on only through `hooks`, which the add-on fills. The build refuses a part
// that uses another add-on's names, or declares a name another part declares.
//
//   node scripts/build-browser.mjs           write the scripts
//   node scripts/build-browser.mjs --check   fail if they are not what the parts give (tests run this)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript'); // a development tool here: nothing shipped depends on it

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../browser');
const PARTS = ['core', 'shapes', 'writer', 'queries'];
const ADD_ONS = PARTS.slice(1);
const INTERNALS = "Symbol.for('jazmin.browser.internals')";

const HEADER = `// JAZMIN browser reader: read-only, async, no dependencies (TASKS F-2). Runs in browsers (also from file://) and in
// Node 22+, using WebCrypto and DecompressionStream. Reads format 1.0 files: plain, key, password and
// access-controlled (owner and access keys, online keys with an unlock token), appended files, several tables and
// embedded files. Files are read in slices (a File or Blob is never loaded whole). Brotli sections cannot be read:
// browsers have no Brotli decompressor.
// A classic script (browsers block module scripts on file://): it defines globalThis.JazminBrowser.
`;
const GENERATED = '// Built by js/scripts/build-browser.mjs from js/browser/src: change those, then run it.\n';

const DECLARATION = /^ {2}(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/;

/** Names a part declares at the top level of the script's function. */
function declared(text) {
  const names = [];
  for (const line of text.split('\n')) {
    const m = line.match(DECLARATION);
    if (m) names.push(m[1] ?? m[2]);
  }
  return names;
}

/**
 * The names a part uses but doesn't declare: resolved by TypeScript's binder (scopes, parameters, locals), so a local
 * variable that shares a name with another part's function isn't taken for it. Globals (Uint8Array, crypto) resolve to
 * the standard library and aren't counted.
 */
function freeNames(text) {
  const file = 'part.js';
  const source = `(function (global) {
${text}
})(globalThis);
`;
  const options = { allowJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, version) => (name === file ? ts.createSourceFile(file, source, version, true, ts.ScriptKind.JS) : getSourceFile(name, version));
  const program = ts.createProgram([file], options, host);
  const checker = program.getTypeChecker();
  const free = new Set();
  const skip = (node) => {
    const parent = node.parent;
    return (ts.isPropertyAccessExpression(parent) && parent.name === node)
      || (ts.isPropertyAssignment(parent) && parent.name === node)
      || ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) && parent.name === node)
      || (ts.isBindingElement(parent) && parent.propertyName === node)
      || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)
      || (ts.isQualifiedName(parent) && parent.right === node);
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && !skip(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      if (!symbol) free.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(program.getSourceFile(file));
  free.delete('undefined');
  return free;
}

export function build() {
  const text = Object.fromEntries(PARTS.map((p) => [p, fs.readFileSync(path.join(root, 'src', `${p}.js`), 'utf8')]));
  const names = Object.fromEntries(PARTS.map((p) => [p, declared(text[p])]));
  const owner = new Map();
  for (const p of PARTS) {
    for (const name of names[p]) {
      if (owner.has(name)) throw new Error(`'${name}' is declared in ${owner.get(name)}.js and in ${p}.js`);
      owner.set(name, p);
    }
  }
  for (const p of PARTS) {
    if (!names[p].includes(`API_${p.toUpperCase()}`)) throw new Error(`${p}.js must end with const API_${p.toUpperCase()} = { ... }`);
  }
  // An add-on may use the core, never another add-on; the core uses add-ons only through hooks.
  const free = Object.fromEntries(PARTS.map((p) => [p, freeNames(text[p])]));
  for (const p of PARTS) {
    for (const name of free[p]) {
      const from = owner.get(name);
      if (!from) throw new Error(`${p}.js uses '${name}', which no part declares`);
      if (from !== 'core' || p === 'core') throw new Error(`${p}.js uses '${name}' from ${from}.js: move it to core.js, or reach it through hooks`);
    }
  }
  const body = (p) => text[p].replace(/\n+$/, '\n');
  const coreNames = names.core.filter((n) => !n.startsWith('API_'));
  const out = {};
  out['jazmin-browser.js'] = `${HEADER}${GENERATED}(function (global) {\n  'use strict';\n\n${PARTS.map(body).join('\n')}\n`
    + `  global.JazminBrowser = { ${PARTS.map((p) => `...API_${p.toUpperCase()}`).join(', ')} };\n})(globalThis);\n`;
  out['jazmin-browser-core.js'] = `${HEADER}// The core: reading files, and exports as JSON, CSV and XML. Add-ons, loaded after it, add the rest:\n`
    + `// jazmin-browser-shapes.js, jazmin-browser-writer.js and jazmin-browser-queries.js (or load jazmin-browser.js alone).\n`
    + `${GENERATED}(function (global) {\n  'use strict';\n\n${body('core')}\n`
    + `  global.JazminBrowser = { ...API_CORE };\n`
    + `  // For the add-ons: the core's functions, and the hooks through which the core reaches them.\n`
    + `  Object.defineProperty(global.JazminBrowser, ${INTERNALS}, { value: { ${coreNames.join(', ')} } });\n})(globalThis);\n`;
  const ABOUT = {
    shapes: 'export shapes, and the saved shapes of a file (reader.shapes(), exports with { shape })',
    writer: 'writing files (createWriter, write), and changes made through a document (writeChanges)',
    queries: 'queries with arrow functions (JazminBrowser.from)',
  };
  for (const p of ADD_ONS) {
    const used = coreNames.filter((n) => free[p].has(n));
    out[`jazmin-browser-${p}.js`] = `// JAZMIN browser reader, add-on: ${ABOUT[p]}. Load it after\n`
      + `// jazmin-browser-core.js (the full jazmin-browser.js already has it).\n${GENERATED}(function (global) {\n  'use strict';\n\n`
      + `  const internals = global.JazminBrowser?.[${INTERNALS}];\n`
      + `  if (!internals) throw new Error('jazmin-browser-${p}.js needs jazmin-browser-core.js, loaded first');\n`
      + `  const { ${used.join(', ')} } = internals;\n\n${body(p)}\n`
      + `  Object.assign(global.JazminBrowser, API_${p.toUpperCase()});\n})(globalThis);\n`;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = build();
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, content] of Object.entries(out)) {
    const file = path.join(root, name);
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (now === content) continue;
    if (check) {
      console.error(`${name} is not what js/browser/src gives: run node scripts/build-browser.mjs`);
      stale++;
    } else {
      fs.writeFileSync(file, content);
      console.log(`wrote ${name} (${content.length.toLocaleString('en')} bytes)`);
    }
  }
  if (stale) process.exit(1);
}
