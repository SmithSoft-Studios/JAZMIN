// A portable copy of a .jzm (portableHtml): the web viewer as one HTML file with the file inside, as the viewer's Save
// as HTML makes it. The viewer's browser test (scripts/viewer-e2e.mjs) opens one from disk and unlocks it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { portableHtml } from '../src/index.js';

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
