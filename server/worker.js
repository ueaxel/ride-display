// Ride Display streaming server: a Cloudflare Worker that serves
//   /            the app (fetched from GitHub Pages), and
//   /rides/...   ride videos and rides/index.json from an R2 bucket (binding RIDES),
// all from one address, so Cloudflare Access (email sign-in) can guard it all.
// Video requests support Range, so the video streams and can be skipped through.

const APP = 'https://ueaxel.github.io/ride-display';
const TYPES = { mp4: 'video/mp4', json: 'application/json', gpx: 'application/gpx+xml' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/rides/')) return ride(request, env, decodeURIComponent(url.pathname.slice(7)));
    const app = await fetch(APP + url.pathname + url.search, { headers: { 'User-Agent': 'ride-display-worker' } });
    return new Response(app.body, app);
  },
};

async function ride(request, env, key) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const type = TYPES[key.split('.').pop().toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  if (request.method === 'HEAD') {
    const o = await env.RIDES.head(key);
    if (!o) return new Response('Not found', { status: 404 });
    return new Response(null, { headers: { ...headers, 'Content-Length': String(o.size), ETag: o.httpEtag } });
  }
  const o = await env.RIDES.get(key, { range: request.headers });
  if (!o) return new Response('Not found', { status: 404 });
  headers.ETag = o.httpEtag;
  if (request.headers.has('Range') && o.range) {
    const start = 'suffix' in o.range ? o.size - o.range.suffix : (o.range.offset || 0);
    const len = 'suffix' in o.range ? o.range.suffix : (o.range.length ?? o.size - start);
    return new Response(o.body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${start + len - 1}/${o.size}`, 'Content-Length': String(len) } });
  }
  return new Response(o.body, { headers: { ...headers, 'Content-Length': String(o.size) } });
}
