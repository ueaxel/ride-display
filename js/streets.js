// Streets along the reference route, from OpenStreetMap (Overpass API).
// Downloaded once when a reference is loaded (needs internet), then kept on
// the device (IndexedDB), so the map shows streets offline on the bike.
// Map data © OpenStreetMap contributors (ODbL).

const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const BUFFER_M = 200;
const M_PER_DEG_LAT = 110540.0;
const M_PER_DEG_LON = 111320.0;

// Drawing class per OSM highway type: 0 major .. 3 path; 9 = water.
const CLASS = {
  motorway: 0, trunk: 0, primary: 0, motorway_link: 0, trunk_link: 0, primary_link: 0,
  secondary: 1, tertiary: 1, secondary_link: 1, tertiary_link: 1,
  residential: 2, unclassified: 2, living_street: 2, road: 2, service: 2, pedestrian: 2,
  cycleway: 3, path: 3, footway: 3, track: 3, bridleway: 3, steps: 3,
};

function routeLatLon(prof, every = 150) {
  const coslat = Math.cos(prof.lat0 * Math.PI / 180);
  const pts = [];
  const k = Math.max(1, Math.round(every / prof.step));
  for (let i = 0; i < prof.d.length; i += k) pts.push([prof.lat0 + prof.y[i] / M_PER_DEG_LAT, prof.lon0 + prof.x[i] / (coslat * M_PER_DEG_LON)]);
  const n = prof.d.length - 1;
  pts.push([prof.lat0 + prof.y[n] / M_PER_DEG_LAT, prof.lon0 + prof.x[n] / (coslat * M_PER_DEG_LON)]);
  return pts;
}

// One bounding box per ~1.5 km of route (plus BUFFER_M around it): the
// "around a line" query of Overpass returned nothing in practice. The
// boxes are filtered down to BUFFER_M from the route afterwards.
export function overpassQuery(prof) {
  const pts = routeLatLon(prof, 25);
  const dLat = BUFFER_M / M_PER_DEG_LAT, dLon = BUFFER_M / (M_PER_DEG_LON * Math.cos(prof.lat0 * Math.PI / 180));
  const boxes = [];
  for (let i = 0; i < pts.length; i += 60) {
    const chunk = pts.slice(i, i + 61);
    const la = chunk.map(p => p[0]), lo = chunk.map(p => p[1]);
    boxes.push([Math.min(...la) - dLat, Math.min(...lo) - dLon, Math.max(...la) + dLat, Math.max(...lo) + dLon].map(v => v.toFixed(5)).join(','));
  }
  const types = Object.keys(CLASS).join('|');
  const parts = boxes.flatMap(b => [`way(${b})["highway"~"^(${types})$"];`, `way(${b})["natural"="water"];`, `way(${b})["waterway"~"^(river|canal|stream)$"];`]);
  return `[out:json][timeout:90];(${parts.join('')});out geom qt;`;
}

// Overpass JSON -> compact local geometry in the reference's metres (x east, y north).
export function toLocal(json, prof) {
  const coslat = Math.cos(prof.lat0 * Math.PI / 180);
  const ways = [];
  // route points on a 100-m grid, to keep only ways near the route
  const grid = new Set();
  const cell = (x, y) => `${Math.floor(x / 100)},${Math.floor(y / 100)}`;
  const reach = Math.ceil(BUFFER_M / 100);
  for (let i = 0; i < prof.d.length; i += 4) {
    const cx = Math.floor(prof.x[i] / 100), cy = Math.floor(prof.y[i] / 100);
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) grid.add(`${cx + a},${cy + b}`);
  }
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags || {};
    const cls = t.highway ? CLASS[t.highway] : 9;
    if (cls === undefined) continue;
    const p = [];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const g of el.geometry) {
      const x = Math.round((g.lon - prof.lon0) * coslat * M_PER_DEG_LON), y = Math.round((g.lat - prof.lat0) * M_PER_DEG_LAT);
      p.push(x, y);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    let near = false;
    for (let i = 0; i < p.length && !near; i += 2) near = grid.has(cell(p[i], p[i + 1]));
    if (!near) continue;
    const w = { c: cls, p, b: [x0, y0, x1, y1] };
    if (t.name && cls <= 2) w.n = t.name;
    if (cls === 9) w.area = t.natural === 'water';
    ways.push(w);
  }
  ways.sort((a, b) => b.c - a.c);          // paths first, major roads drawn on top
  return { ways, fetched: new Date().toISOString(), attribution: '© OpenStreetMap contributors' };
}

export async function downloadStreets(prof) {
  if (!prof.x) throw new Error('The reference ride has no GPS route.');
  const body = 'data=' + encodeURIComponent(overpassQuery(prof));
  let lastErr;
  for (const url of SERVERS) {
    try {
      const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error(`map server answered ${r.status}${r.status === 429 ? ' (busy)' : ''}`);
      const j = await r.json();
      // a busy server can answer "OK" with no data and a remark: try the next one
      if (j.remark && !(j.elements || []).length) throw new Error('map server: ' + j.remark.slice(0, 80));
      if (!(j.elements || []).length) throw new Error('map server returned no streets');
      return toLocal(j, prof);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ------------------------------------------------------------ device storage

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ride-display', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('streets');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveStreets(key, data) {
  const d = await db();
  await new Promise((res, rej) => { const tx = d.transaction('streets', 'readwrite'); tx.objectStore('streets').put(data, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
export async function loadStreets(key) {
  try {
    const d = await db();
    return await new Promise(res => { const r = d.transaction('streets').objectStore('streets').get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  } catch (e) { return null; }
}
export async function deleteStreets(key) {
  try { const d = await db(); d.transaction('streets', 'readwrite').objectStore('streets').delete(key); } catch (e) { /* */ }
}

// ------------------------------------------------------------ drawing

const STYLE = {
  0: { w: 7, col: '#5B6675' }, 1: { w: 5.5, col: '#4A5462' }, 2: { w: 3.5, col: '#3A434F' },
  3: { w: 1.6, col: '#3E4A57', dash: [4, 4] }, 9: { w: 3, col: '#1F4E7A', fill: '#173A5C' },
};

// Draw streets with the route's own screen transform. `view` = {cx, cy, r}
// in metres for culling (null = draw all). scale = px per metre.
export function drawStreets(ctx, streets, toScreen, scale, view, labels = true) {
  if (!streets) return;
  const zoom = Math.max(0.6, Math.min(2.2, scale * 6));
  const named = new Map();
  for (const w of streets.ways) {
    if (view && (w.b[2] < view.cx - view.r || w.b[0] > view.cx + view.r || w.b[3] < view.cy - view.r || w.b[1] > view.cy + view.r)) continue;
    if (!view && w.c === 3 && scale < 0.05) continue;     // overview: skip paths
    const st = STYLE[w.c];
    ctx.beginPath();
    for (let i = 0; i < w.p.length; i += 2) {
      const [x, y] = toScreen(w.p[i], w.p[i + 1]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    if (w.area) { ctx.fillStyle = st.fill; ctx.fill(); continue; }
    ctx.strokeStyle = st.col; ctx.lineWidth = Math.max(1, st.w * (view ? zoom : 0.5));
    ctx.setLineDash(st.dash || []); ctx.stroke();
    if (w.n && labels && view) {
      // label at the point of the street nearest the middle of the screen
      let best = null;
      for (let i = 0; i + 3 < w.p.length; i += 2) {
        const [ax, ay] = toScreen(w.p[i], w.p[i + 1]), [bx, by] = toScreen(w.p[i + 2], w.p[i + 3]);
        const x = (ax + bx) / 2, y = (ay + by) / 2;
        if (x < 50 || x > ctx.w - 50 || y < 20 || y > ctx.h - 20) continue;
        const dd = (x - ctx.w / 2) ** 2 + (y - ctx.h / 2) ** 2;
        if (!best || dd < best.dd) best = { x, y, dd };
      }
      const prev = named.get(w.n);
      if (best && (!prev || w.c < prev.c)) named.set(w.n, { x: best.x, y: best.y, c: w.c });
    }
  }
  ctx.setLineDash([]);
  if (!view) return;
  ctx.font = '600 13px system-ui'; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
  let k = 0;
  const boxes = [];                               // skip labels that would overlap
  for (const [name, { x, y }] of [...named.entries()].sort((a, b) => a[1].c - b[1].c)) {
    if (k >= 8) break;
    const w = ctx.measureText(name).width, box = [x - w / 2 - 4, y - 10, x + w / 2 + 4, y + 8];
    if (boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box); k++;
    ctx.lineWidth = 4; ctx.strokeStyle = '#0B0F14'; ctx.strokeText(name, x, y + 4);
    ctx.fillStyle = '#C9D1DB'; ctx.fillText(name, x, y + 4);
  }
}
