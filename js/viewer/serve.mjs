// Serves the viewer on this computer to try it: npm run viewer, then open the address it prints.
// To host it, publish the js/viewer and js/browser folders side by side as static files (HTTPS, for installing it).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const port = Number(process.env.PORT ?? 8080);
http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/viewer/index.html';
  const file = path.join(root, pathname);
  const allowed = [path.join(root, 'viewer'), path.join(root, 'browser')].some((dir) => file.startsWith(dir + path.sep));
  if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`JAZMIN viewer: http://localhost:${port}/viewer/index.html`));
