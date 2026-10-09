// A portable copy of a .jzm: the web viewer as one HTML file with the .jzm inside, as the viewer's "Save as HTML" makes
// it. Opened in a browser (from disk, offline), it shows the file as the viewer does, and asks for its key: the file
// inside is the encrypted file as it is.
import fs from 'node:fs';
import path from 'node:path';
import { JazminValidationError } from './errors.js';

const VIEWER = new URL('../viewer/', import.meta.url);
const MAGIC = 'JZM1';

const read = (relative) => fs.readFileSync(new URL(relative, VIEWER), 'utf8');
const attribute = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The web viewer as one HTML file with `file` (a path, or the bytes of a .jzm) inside: its styles and scripts inline,
 * and the file as base64, which the viewer opens when the page loads. `name` names the file in the viewer (default:
 * the path's file name, or file.jzm).
 */
export function portableHtml(file, { name } = {}) {
  const bytes = typeof file === 'string' ? fs.readFileSync(file) : Buffer.from(file.buffer ?? file, file.byteOffset ?? 0, file.byteLength ?? file.length);
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('latin1') !== MAGIC) throw new JazminValidationError('portableHtml: not a JAZMIN file');
  const fileName = name ?? (typeof file === 'string' ? path.basename(file) : 'file.jzm');
  let html = read('index.html');
  // Styles and scripts inline (as the viewer's Save as HTML), so the page needs nothing beside it.
  html = html.replace(/<link rel="stylesheet" href="([^"]+)" data-jz-inline="css">/, (_, href) => `<style data-jz-inline="css">${read(href)}</style>`);
  html = html.replace(/<script src="([^"]+)" data-jz-inline="(\w+)"><\/script>/g,
    (_, src, kind) => `<script data-jz-inline="${kind}">${read(src).replace(/<\/script/gi, '<\\/script')}</script>`);
  html = html.replace(/<link rel="(?:manifest|icon)"[^>]*>\r?\n?/g, ''); // an installed app's: not for a copy
  const embedded = `<script id="jz-embedded" type="application/octet-stream" data-name="${attribute(fileName)}">${bytes.toString('base64')}</script>`;
  return html.replace(/<body([^>]*)>/, (body) => `${body}\n${embedded}`);
}
