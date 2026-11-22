// Offline street map of an area (for riding without a reference route).
// Streets come from OpenStreetMap (Overpass) in tiles of about 2 x 2 km,
// downloaded at home ("Download map around me") or on the fly when online,
// and kept on the device (IndexedDB). Map data © OpenStreetMap contributors.

// overpass-api.de is the reliable one (slow when busy); the others are fallbacks
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'];
const WAIT_MS = 75000;                      // give up on a server after this long
const TLAT = 0.02, TLON = 0.025;            // tile size in degrees (~2.2 km at 40°N)
const M_LAT = 110540, M_LON = 111320;
const CLASS = {
  motorway: 0, trunk: 0, primary: 0, motorway_link: 0, trunk_link: 0, primary_link: 0,
  secondary: 1, tertiary: 1, secondary_link: 1, tertiary_link: 1,
  residential: 2, unclassified: 2, living_street: 2, road: 2, service: 2, pedestrian: 2,
  cycleway: 3, path: 3, footway: 3, track: 3, bridleway: 3, steps: 3,
};

export const tileKey = (lat, lon) => `${Math.floor(lat / TLAT)},${Math.floor(lon / TLON)}`;
function tileBox(key) {
  const [i, j] = key.split(',').map(Number);
  return [i * TLAT, j * TLON, (i + 1) * TLAT, (j + 1) * TLON];
}
// keys of all tiles within radiusKm of a point
export function tilesAround(lat, lon, radiusKm) {
  const dLat = radiusKm * 1000 / M_LAT, dLon = radiusKm * 1000 / (M_LON * Math.cos(lat * Math.PI / 180));
  const out = [];
  for (let i = Math.floor((lat - dLat) / TLAT); i <= Math.floor((lat + dLat) / TLAT); i++)
    for (let j = Math.floor((lon - dLon) / TLON); j <= Math.floor((lon + dLon) / TLON); j++) out.push(`${i},${j}`);
  return out;
}

// ------------------------------------------------------------ storage
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ride-display-area', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tiles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getTile(key) {
  try { const d = await db(); return await new Promise(res => { const r = d.transaction('tiles').objectStore('tiles').get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); }
  catch (e) { return null; }
}
async function putTile(key, data) {
  const d = await db();
  await new Promise((res, rej) => { const t = d.transaction('tiles', 'readwrite'); t.objectStore('tiles').put(data, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
export async function countTiles() {
  try { const d = await db(); return await new Promise(res => { const r = d.transaction('tiles').objectStore('tiles').count(); r.onsuccess = () => res(r.result); r.onerror = () => res(0); }); }
  catch (e) { return 0; }
}

// keys of all tiles touching a box [south, west, north, east] (degrees)
export function tilesInBox([s, w, n, e]) {
  const out = [];
  for (let i = Math.floor(s / TLAT); i <= Math.floor(n / TLAT); i++)
    for (let j = Math.floor(w / TLON); j <= Math.floor(e / TLON); j++) out.push(`${i},${j}`);
  return out;
}
// which of these tiles are stored on the device
export async function storedTiles(keys) {
  const have = new Set();
  for (const k of keys) if (await getTile(k)) have.add(k);
  return have;
}

// ------------------------------------------------------------ download
async function fetchTile(key) { return { ways: await fetchBox(tileBox(key)), fetched: Date.now() }; }

async function fetchBox(box) {
  const [s, w, n, e] = box.map(v => v.toFixed(5));
  const b = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:90];(way(${b})["highway"~"^(${Object.keys(CLASS).join('|')})$"];way(${b})["natural"="water"];way(${b})["waterway"~"^(river|canal|stream)$"];);out geom qt;`;
  let last;
  for (const url of [SERVERS[0], ...SERVERS]) {          // the main server gets a second try
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), WAIT_MS);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error(`map server answered ${r.status}${r.status === 429 ? ' (busy)' : ''}`);
      const j = await r.json();
      if (j.remark && !(j.elements || []).length) throw new Error('map server: ' + j.remark.slice(0, 60));
      // compact: lat/lon as integers of 1e-5 degrees (~1 m)
      const ways = [];
      for (const el of j.elements || []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        const t = el.tags || {};
        const c = t.highway ? CLASS[t.highway] : 9;
        if (c === undefined) continue;
        const p = [];
        for (const g of el.geometry) p.push(Math.round(g.lat * 1e5), Math.round(g.lon * 1e5));
        const w2 = { c, p };
        if (t.name && c <= 2) w2.n = t.name;
        if (c === 9) w2.area = t.natural === 'water';
        ways.push(w2);
      }
      clearTimeout(timer);
      return ways;                                   // an empty box (fields, water) is fine
    } catch (err) { clearTimeout(timer); last = err.name === 'AbortError' ? new Error('map server did not answer') : err; await new Promise(r => setTimeout(r, 2000)); }
  }
  throw last;
}

// Download the tiles around a point that aren't stored yet, nearest first, in
// blocks of 3 x 3 tiles per request (one big request is much quicker than
// nine small ones). onProgress(done, total, failed).
export async function downloadArea(lat, lon, radiusKm, onProgress = () => {}) {
  const keys = tilesAround(lat, lon, radiusKm);
  const have = new Set();
  for (const k of keys) if (await getTile(k)) have.add(k);
  const blocks = new Map();
  for (const k of keys) {
    if (have.has(k)) continue;
    const [i, j] = k.split(',').map(Number);
    const bk = `${Math.floor(i / 3)},${Math.floor(j / 3)}`;
    if (!blocks.has(bk)) blocks.set(bk, []);
    blocks.get(bk).push(k);
  }
  const ci = lat / TLAT, cj = lon / TLON;
  const order = [...blocks.values()].sort((a, b) => dist2(a) - dist2(b));
  function dist2(ks) { const [i, j] = ks[0].split(',').map(Number); const bi = Math.floor(i / 3) * 3 + 1.5, bj = Math.floor(j / 3) * 3 + 1.5; return (bi - ci) ** 2 + (bj - cj) ** 2; }
  let done = have.size, failed = 0;
  onProgress(done, keys.length, failed);
  for (const ks of order) {
    const boxes = ks.map(tileBox);
    const box = [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
    try {
      const ways = await fetchBox(box);
      // each way goes to the tile holding its first point
      const per = new Map(ks.map(k => [k, []]));
      for (const w of ways) { const k = tileKey(w.p[0] / 1e5, w.p[1] / 1e5); if (per.has(k)) per.get(k).push(w); }
      for (const [k, list] of per) await putTile(k, { ways: list, fetched: Date.now() });
      done += ks.length;
    } catch (e) { failed += ks.length; }
    onProgress(done, keys.length, failed);
  }
  return { total: keys.length, failed };
}

// ------------------------------------------------------------ in memory, in metres around an origin
export class AreaMap {
  constructor() { this.origin = null; this.tiles = new Map(); this.loading = new Set(); this.ways = []; this.version = 0; }
  // metres east / north of the origin
  xy(lat, lon) {
    if (!this.origin) this.origin = { lat, lon, cos: Math.cos(lat * Math.PI / 180) };
    const o = this.origin;
    return [(lon - o.lon) * o.cos * M_LON, (lat - o.lat) * M_LAT];
  }
  // make sure the tiles around a point are in memory (from storage, or the
  // network when online and `fetchMissing`)
  async ensure(lat, lon, fetchMissing = navigator.onLine) {
    for (const k of tilesAround(lat, lon, 1.5)) {
      if (this.tiles.has(k) || this.loading.has(k)) continue;
      this.loading.add(k);
      let t = await getTile(k);
      if (!t && fetchMissing) { try { t = await fetchTile(k); await putTile(k, t); } catch (e) { t = null; } }
      this.loading.delete(k);
      if (!t) continue;
      const ways = t.ways.map(w => {
        const p = [];
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < w.p.length; i += 2) {
          const [x, y] = this.xy(w.p[i] / 1e5, w.p[i + 1] / 1e5);
          const xr = Math.round(x), yr = Math.round(y);
          p.push(xr, yr);
          x0 = Math.min(x0, xr); x1 = Math.max(x1, xr); y0 = Math.min(y0, yr); y1 = Math.max(y1, yr);
        }
        return { c: w.c, n: w.n, area: w.area, p, b: [x0, y0, x1, y1] };
      });
      this.tiles.set(k, ways);
      this.ways = [...this.tiles.values()].flat().sort((a, b) => b.c - a.c);
      this.version++;
    }
  }
  get streets() { return this.ways.length ? { ways: this.ways } : null; }
}
