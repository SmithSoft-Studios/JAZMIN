// Downloads jsPDF (MIT licence) into template/vendor/ so the sample's "Download PDF" button works.
// The file is not committed to the repository; its SHA-256 is pinned so a changed download is refused.
//   node poc/self-contained-html/fetch-vendor.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '4.2.1';
const URL = `https://cdn.jsdelivr.net/npm/jspdf@${VERSION}/dist/jspdf.umd.min.js`;
const SHA256 = 'e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54';

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template', 'vendor', 'jspdf.umd.min.js');
const response = await fetch(URL);
if (!response.ok) throw new Error(`Download failed: ${response.status} ${URL}`);
const bytes = Buffer.from(await response.arrayBuffer());
const actual = crypto.createHash('sha256').update(bytes).digest('hex');
if (actual !== SHA256) throw new Error(`jsPDF ${VERSION} has an unexpected SHA-256 (${actual}) - not saved`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, bytes);
console.log(`Saved jsPDF ${VERSION} (${(bytes.length / 1024).toFixed(0)} KB) to ${target}`);
