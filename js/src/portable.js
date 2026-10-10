// A portable copy of a .jzm: the web viewer as one HTML file with the .jzm inside, as the viewer's "Save as HTML" makes
// it. Opened in a browser (from disk, offline), it shows the file as the viewer does, and asks for its key: the file
// inside is the encrypted file as it is. Or the .jzm as a script, which a page opened from disk can load.
import { constants } from 'node:buffer';
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
  const { bytes, fileName } = jazminFile(file, name, 'portableHtml');
  let html = read('index.html');
  // Styles and scripts inline (as the viewer's Save as HTML), so the page needs nothing beside it.
  html = html.replace(/<link rel="stylesheet" href="([^"]+)" data-jz-inline="css">/, (_, href) => `<style data-jz-inline="css">${read(href)}</style>`);
  html = html.replace(/<script src="([^"]+)" data-jz-inline="(\w+)"><\/script>/g,
    (_, src, kind) => `<script data-jz-inline="${kind}">${read(src).replace(/<\/script/gi, '<\\/script')}</script>`);
  html = html.replace(/<link rel="(?:manifest|icon)"[^>]*>\r?\n?/g, ''); // an installed app's: not for a copy
  const embedded = `<script id="jz-embedded" type="application/octet-stream" data-name="${attribute(fileName)}">${bytes.toString('base64')}</script>`;
  return html.replace(/<body([^>]*)>/, (body) => `${body}\n${embedded}`);
}

// The longest text V8 (Chrome, Edge, Node) holds: a larger file can't be made into a script, nor loaded as one there.
const MAX_SCRIPT_TEXT = constants.MAX_STRING_LENGTH - 1024;

/**
 * The .jzm as a script, for pages opened from disk: they can't read a file beside them, but they can load a script, and
 * the browser reader's openScript() opens it. The script registers the file, as base64, under the script's own address
 * (in globalThis.JazminScripts), so a page can load several. The file inside is the file as it is (still encrypted).
 * The page holds all of it in memory. `name`: the file's name (default: the path's file name, or file.jzm). The .NET
 * library's JazminFile.PortableScript writes the same text.
 */
export function portableScript(file, { name } = {}) {
  const { bytes, fileName } = jazminFile(file, name, 'portableScript');
  if (Math.ceil(bytes.length / 3) * 4 > MAX_SCRIPT_TEXT) {
    throw new JazminValidationError(`portableScript: ${fileName} is ${Math.round(bytes.length / 1048576)} MB, too large to load as a script in Chrome or Edge (at most about 380 MB, and best under about 20 MB): open it from a picked file instead`);
  }
  const quoted = JSON.stringify(fileName);
  return '/* A JAZMIN file as a script, for pages opened from disk: JazminBrowser.openScript() opens it. */\n'
    + `(function (scripts, script) { scripts[script ? script.src : ${quoted}] = { name: ${quoted}, data: "${bytes.toString('base64')}" }; })`
    + '(globalThis.JazminScripts = globalThis.JazminScripts || {}, typeof document === "undefined" ? null : document.currentScript);\n';
}

/** The bytes of a JAZMIN file (a path or bytes), checked, and the name it goes by. */
function jazminFile(file, name, what) {
  const bytes = typeof file === 'string' ? fs.readFileSync(file) : Buffer.from(file.buffer ?? file, file.byteOffset ?? 0, file.byteLength ?? file.length);
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('latin1') !== MAGIC) throw new JazminValidationError(`${what}: not a JAZMIN file`);
  return { bytes, fileName: name ?? (typeof file === 'string' ? path.basename(file) : 'file.jzm') };
}
