// Serves the from-disk sample's site on this computer, for the one thing a page opened from disk can't do in Chrome and
// Edge: get a lock's token back from a key service's sign-in window (two-factor.html, step 4). Those browsers give a
// page on disk the origin "file://", which a window can't post a message to; served, the page has a real origin.
// Everything else works from disk.
//   node examples/from-disk/serve.mjs [folder]      (default: examples/from-disk/site; PORT to change 8417)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'site'));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json',
  '.jzm': 'application/octet-stream', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
const port = Number(process.env.PORT ?? 8417);
http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(site, pathname);
  // Only the site's own files: not the owner key the send-back demo keeps beside it (filing/), nor anything outside.
  if (!file.startsWith(site + path.sep) || file.startsWith(path.join(site, 'filing') + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`The from-disk sample: http://127.0.0.1:${port}/index.html (${site})`));
