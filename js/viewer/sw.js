// Service worker of the installed viewer: keeps the app (not the files you open) for offline use.
const CACHE = 'jazmin-viewer-2';
const APP = ['./', 'index.html', 'viewer.css', 'viewer.js', 'sandbox.js', 'manifest.webmanifest', 'icon-32.png', 'icon-192.png', 'icon-512.png', '../browser/jazmin-browser.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first, so updates arrive when online; the cached app when offline.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || Response.error())));
});
