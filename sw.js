// Offline copy of the app, so the handlebar phone works without a network.
// Network first (you always get the newest version when online), cache as fallback.
const CACHE = 'ride-display-v49';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'js/app.js', 'js/reference.js',
  'js/sensors.js', 'js/hrmodel.js', 'js/ghost.js', 'js/draw.js', 'js/streets.js', 'js/fitwriter.js', 'js/clips.js', 'js/view360.js', 'js/junctions.js', 'js/videoscreen.js', 'js/areamap.js', 'js/myrides.js', 'js/refedit.js', 'js/power.js', 'js/team.js', 'js/library.js', 'js/online.js', 'routes/index.json', 'routes/OYJ%20Dublin%20Grade%20Light.gpx'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).pathname.includes('/rides/')) return;   // streamed ride videos: straight to the server
  // always ask the server for the newest file (revalidate; GitHub Pages lets browsers keep files 10 min)
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
