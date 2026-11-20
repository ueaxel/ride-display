// Offline copy of the app, so the handlebar phone works without a network.
// Network first (you always get the newest version when online), cache as fallback.
const CACHE = 'ride-display-v3';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'js/app.js', 'js/reference.js',
  'js/sensors.js', 'js/hrmodel.js', 'js/ghost.js', 'js/draw.js', 'js/streets.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
