// A portable copy of a .jzm (portableHtml): the web viewer as one HTML file with the file inside, as the viewer's Save
// as HTML makes it. The viewer's browser test (scripts/viewer-e2e.mjs) opens one from disk and unlocks it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { open, portableHtml, portableScript } from '../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/fixtures');

test('portableHtml: the viewer, its styles and scripts inline, with the file inside', () => {
  const file = path.join(fixtures, 'js-files-access.jzm');
  const html = portableHtml(file);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.doesNotMatch(html, /<script [^>]*src=|<link [^>]*rel="(?:stylesheet|manifest|icon)"/); // it needs nothing beside it
  for (const kind of ['css', 'reader', 'sandbox', 'viewer']) assert.match(html, new RegExp(`data-jz-inline="${kind}">`));
  const embedded = html.match(/<script id="jz-embedded" type="application\/octet-stream" data-name="([^"]*)">([^<]*)<\/script>/);
  assert.equal(embedded[1], 'js-files-access.jzm');
  assert.ok(Buffer.from(embedded[2], 'base64').equals(fs.readFileSync(file))); // the file as it is: still encrypted
  // Each script is its file, whole: one that contains "</script" can't end its element early.
  const viewer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../viewer');
  for (const [kind, source] of [['reader', '../browser/jazmin-browser.js'], ['sandbox', 'sandbox.js'], ['viewer', 'viewer.js']]) {
    const start = html.indexOf(`<script data-jz-inline="${kind}">`) + `<script data-jz-inline="${kind}">`.length;
    const inline = html.slice(start, html.indexOf('</script>', start));
    assert.equal(inline, fs.readFileSync(path.join(viewer, source), 'utf8').replace(/<\/script/gi, '<\/script'), kind);
  }

  assert.match(portableHtml(fs.readFileSync(file), { name: 'a "b".jzm' }), /data-name="a &quot;b&quot;\.jzm"/);
  assert.match(portableHtml(fs.readFileSync(file)), /data-name="file\.jzm"/);
  assert.throws(() => portableHtml(Buffer.from('not a jazmin file at all, just some text that is long enough to check')), /not a JAZMIN file/);
});

// A .jzm as a script (portableScript), for pages opened from disk: they can't read a file beside them, but they can load
// a script, and the browser reader's openScript() opens it (browser-script.test.js; in browsers, scripts/viewer-e2e.mjs).
// The .NET library writes the same text (PortableScriptTests).
const SCRIPT_TAIL = ' }; })(globalThis.JazminScripts = globalThis.JazminScripts || {}, typeof document === "undefined" ? null : document.currentScript);\n';

test('portableScript: the file as base64 in a script that registers it under its own address', () => {
  const bytes = Buffer.concat([Buffer.from('JZM1'), Buffer.from(Array.from({ length: 60 }, (_, i) => i))]);
  const name = 'a "b"\\c\né\u001f.jzm';
  const quoted = '"a \\"b\\"\\\\c\\né\\u001f.jzm"';
  assert.equal(quoted, JSON.stringify(name));
  assert.equal(portableScript(bytes, { name }), '/* A JAZMIN file as a script, for pages opened from disk: JazminBrowser.openScript() opens it. */\n'
    + `(function (scripts, script) { scripts[script ? script.src : ${quoted}] = { name: ${quoted}, data: "SlpNMQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ow=="${SCRIPT_TAIL}`);
  assert.match(portableScript(bytes), /name: "file\.jzm"/);
  assert.ok(portableScript(bytes, { name: "\ud800\b\t\0 <&'>" }).includes(String.raw`name: "\ud800\b\t\u0000 <&'>"`)); // as the .NET test
  assert.throws(() => portableScript(Buffer.from('not a jazmin file at all, just some text that is long enough to check')), /not a JAZMIN file/);
});

test('portableScript: run as a page runs it, the script gives back the file, still encrypted', () => {
  const file = path.join(fixtures, 'js-key.jzm');
  const script = portableScript(file);
  assert.match(script, /name: "js-key\.jzm"/);
  const page = { globalThis: null, document: { currentScript: { src: 'file:///C:/reports/js-key.jzm.js' } } };
  page.globalThis = page;
  vm.runInNewContext(script, page);
  const entry = page.JazminScripts['file:///C:/reports/js-key.jzm.js'];
  assert.equal(entry.name, 'js-key.jzm');
  const back = Buffer.from(entry.data, 'base64');
  assert.ok(back.equals(fs.readFileSync(file)));
  const keys = JSON.parse(fs.readFileSync(path.join(fixtures, 'keys.json'), 'utf8'));
  assert.equal(open(back, { key: keys.key }).rowCount, open(file, { key: keys.key }).rowCount);
  // Where there is no page (a worker's importScripts), the file is registered under its name.
  const worker = {};
  worker.globalThis = worker;
  vm.runInNewContext(script, worker);
  assert.equal(worker.JazminScripts['js-key.jzm'].name, 'js-key.jzm');
});
