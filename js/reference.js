// The original ("reference") ride, read straight from its .fit file in the
// browser. Same method as tools/make_reference.py and tools/estimate_power.py,
// so the displays see the same profile as the Ride Repro watch field:
// moving time, speed, heart rate, power, route and grade every few metres.

const G = 9.81;
const DRIVETRAIN = 0.97;
const M_PER_DEG_LAT = 110540.0;
const M_PER_DEG_LON = 111320.0;
const GRADE_WINDOW = 25.0;   // metres either side for grade / smoothed altitude
const SMOOTH = 2;            // route smoothing, +/- points

// Rider set-up (matches tools/estimate_power.py and IndoorRide.mc defaults).
export const RIDER = { riderKg: 76.5, extraKg: 1.0, bikeKg: 10.5, cda: 0.32, crr: 0.0055 };

// ---------------------------------------------------------------- FIT reader

// base type -> [DataView getter, size, invalid value]
const BASE = {
  0x00: ['getUint8', 1, 0xFF], 0x01: ['getInt8', 1, 0x7F], 0x02: ['getUint8', 1, 0xFF],
  0x83: ['getInt16', 2, 0x7FFF], 0x84: ['getUint16', 2, 0xFFFF],
  0x85: ['getInt32', 4, 0x7FFFFFFF], 0x86: ['getUint32', 4, 0xFFFFFFFF],
  0x88: ['getFloat32', 4, null], 0x89: ['getFloat64', 8, null],
  0x8B: ['getUint16', 2, 0], 0x8C: ['getUint32', 4, 0], 0x0A: ['getUint8', 1, 0],
};

// Yields [global message number, {field number: value}] for each data message.
export function* readFit(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const headerSize = bytes[0];
  const sig = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (sig !== '.FIT') throw new Error('This is not a .fit file.');
  const end = Math.min(bytes.length, headerSize + view.getUint32(4, true));
  const defs = {};
  let pos = headerSize, lastTs = null;
  while (pos < end) {
    const rec = bytes[pos++];
    if (rec & 0x80) {                       // compressed timestamp header
      const d = defs[(rec >> 5) & 0x3];
      if (!d) throw new Error('Damaged .fit file.');
      const values = parseData(view, pos, d);
      pos += d.size;
      if (lastTs !== null) {
        let ts = (lastTs & ~0x1F) + (rec & 0x1F);
        if (ts < lastTs) ts += 0x20;
        lastTs = ts;
        values[253] = ts;
      }
      yield [d.glob, values];
      continue;
    }
    const local = rec & 0x0F;
    if (rec & 0x40) {                       // definition message
      const little = bytes[pos + 1] === 0;
      const glob = view.getUint16(pos + 2, little);
      const n = bytes[pos + 4];
      pos += 5;
      const fields = [];
      for (let i = 0; i < n; i++, pos += 3) fields.push([bytes[pos], bytes[pos + 1], bytes[pos + 2]]);
      let devSize = 0;
      if (rec & 0x20) {
        const nd = bytes[pos++];
        for (let i = 0; i < nd; i++, pos += 3) devSize += bytes[pos + 1];
      }
      defs[local] = { glob, little, fields, size: fields.reduce((s, f) => s + f[1], 0) + devSize };
    } else {
      const d = defs[local];
      if (!d) throw new Error('Damaged .fit file.');
      const values = parseData(view, pos, d);
      pos += d.size;
      if (253 in values) lastTs = values[253];
      yield [d.glob, values];
    }
  }
}

function parseData(view, pos, d) {
  const values = {};
  let p = pos;
  for (const [num, size, base] of d.fields) {
    const spec = BASE[base];
    if (spec && spec[1] === size) {
      const v = view[spec[0]](p, d.little);
      if ((spec[2] === null || v !== spec[2]) && !Number.isNaN(v)) values[num] = v;
    }
    p += size;
  }
  return values;
}

// ---------------------------------------------------------------- ride

// Records (with moving time), timer events and the rider weight from a ride.
export function loadRide(buffer) {
  const events = [], records = [];
  let riderKg = null, tz = null;
  for (const [msg, v] of readFit(buffer)) {
    if (msg === 21 && v[0] === 0 && 253 in v) events.push([v[253], v[1]]);
    else if (msg === 34 && 253 in v && 5 in v) tz = v[5] - v[253];        // activity: local - UTC
    else if (msg === 3 && 4 in v) riderKg = v[4] / 10;
    else if (msg === 20 && 253 in v && 5 in v) {
      const speed = 73 in v ? v[73] : v[6];
      const alt = 78 in v ? v[78] : v[2];
      records.push({
        ts: v[253], dist: v[5] / 100,
        speed: speed === undefined ? null : speed / 1000,
        hr: v[3] ?? null, power: v[7] ?? null, cadence: v[4] ?? null,
        lat: 0 in v ? v[0] * 180 / 2 ** 31 : null,
        lon: 1 in v ? v[1] * 180 / 2 ** 31 : null,
        alt: alt === undefined ? null : alt / 5 - 500,
      });
    }
  }
  if (records.length < 2) throw new Error('The ride has too few distance records.');
  // Moving time = elapsed time minus timer pauses (auto-pause included).
  events.sort((a, b) => a[0] - b[0]);
  const pausedBefore = [];
  let stoppedAt = null, totalPause = 0;
  for (const [ts, kind] of events) {
    if ((kind === 1 || kind === 4) && stoppedAt === null) stoppedAt = ts;
    else if (kind === 0 && stoppedAt !== null) {
      totalPause += ts - stoppedAt;
      stoppedAt = null;
      pausedBefore.push([ts, totalPause]);
    }
  }
  const t0 = records[0].ts;
  let k = 0, pause = 0;
  for (const r of records) {
    while (k < pausedBefore.length && r.ts >= pausedBefore[k][0]) pause = pausedBefore[k++][1];
    r.moving = r.ts - t0 - pause;
    r.elapsed = r.ts - t0;                       // clock time since the start (video sync)
  }
  return { records, events, riderKg, tz };
}

// ---------------------------------------------------------------- helpers

// Linear interpolation of ys at x on increasing xs (clamped at the ends).
export function interp(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const span = xs[hi] - xs[lo];
  return span > 0 ? ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / span : ys[hi];
}

function gaussianSmooth(xs, ys, sigma) {
  const out = new Array(xs.length);
  let lo = 0;
  for (let i = 0; i < xs.length; i++) {
    while (xs[i] - xs[lo] > 3 * sigma) lo++;
    let wsum = 0, vsum = 0;
    for (let j = lo; j < xs.length && xs[j] - xs[i] <= 3 * sigma; j++) {
      const w = Math.exp(-0.5 * ((xs[j] - xs[i]) / sigma) ** 2);
      wsum += w; vsum += w * ys[j];
    }
    out[i] = vsum / wsum;
  }
  return out;
}

function fillGaps(records, key) {
  const first = records.find(r => r[key] !== null);
  if (!first) return false;
  let last = first[key];
  for (const r of records) { if (r[key] === null) r[key] = last; else last = r[key]; }
  return true;
}

// ---------------------------------------------------------------- power

// Power for a ride without a power meter (tools/estimate_power.py).
export function estimatePower(records, events, rider = RIDER) {
  const mass = rider.riderKg + rider.extraKg + rider.bikeKg;
  const mEff = mass + 1;
  if (!fillGaps(records, 'alt')) records.forEach(r => { r.alt = 0; });
  const pts = records.map(r => [r.dist, r.alt]).sort((a, b) => a[0] - b[0]);
  const dx = pts.map(p => p[0]), da = pts.map(p => p[1]);
  const grid = [];
  for (let g = 0; g <= dx[dx.length - 1]; g += 5) grid.push(g);
  const alts = gaussianSmooth(grid, grid.map(g => interp(dx, da, g)), 20);
  const last = grid.length - 1;
  const slope = grid.map((_, i) => {
    const a = Math.max(i - 1, 0), b = Math.min(i + 1, last);
    return b > a ? (alts[b] - alts[a]) / (grid[b] - grid[a]) : 0;
  });
  const stops = events.filter(e => e[1] === 1 || e[1] === 4).map(e => e[0]).sort((a, b) => a - b);
  const segs = [];
  let cur = [];
  for (const r of records) {
    if (cur.length) {
      const prev = cur[cur.length - 1].ts;
      if (stops.some(s => prev <= s && s < r.ts) || r.ts - prev > 30) { segs.push(cur); cur = []; }
    }
    cur.push(r);
  }
  if (cur.length) segs.push(cur);
  for (const seg of segs) {
    if (seg.length < 3) { seg.forEach(r => { r.power = 0; }); continue; }
    const t0 = seg[0].ts;
    const ts = seg.map(r => r.ts - t0);
    const sec = [];
    for (let s = 0; s <= Math.floor(ts[ts.length - 1]); s++) sec.push(s);
    const n = sec.length;
    const dist = gaussianSmooth(sec, sec.map(s => interp(ts, seg.map(r => r.dist), s)), 3);
    const diff = arr => sec.map((_, i) => {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
      return (arr[b] - arr[a]) / Math.max(1, b - a);
    });
    const v = diff(dist).map(x => Math.max(0, x));
    const acc = gaussianSmooth(sec, diff(v), 3);
    seg.forEach((r, j) => {
      const i = Math.min(Math.round(ts[j]), n - 1);
      const speed = v[i], a = acc[i];
      const angle = Math.atan(interp(grid, slope, r.dist));
      const rho = 1.225 * Math.exp(-(r.alt || 0) / 8434);
      let p = (mass * G * speed * (Math.sin(angle) + rider.crr * Math.cos(angle))
        + mEff * a * speed + 0.5 * rho * rider.cda * speed ** 3) / DRIVETRAIN;
      if (r.cadence === 0 || speed < 0.5) p = 0;
      r.power = Math.round(Math.min(Math.max(p, 0), 1500));
    });
  }
  return mass;
}

// ---------------------------------------------------------------- profile

function gradeClass(g) {
  for (const [limit, cls] of [[-5, -2], [-2, -1], [2, 0], [5, 1], [8, 2]]) if (g < limit) return cls;
  return 3;
}

// Profile every `step` metres (tools/make_reference.py build_profile).
export function buildProfile(records, step = 5) {
  const total = records[records.length - 1].dist;
  const d = [];
  for (let i = 0; i * step <= total; i++) d.push(Math.round(i * step * 10) / 10);
  if (d[d.length - 1] < total) d.push(Math.round(total * 10) / 10);
  const rd = records.map(r => r.dist);
  const at = key => {
    const ys = records.map(r => r[key]);
    return x => interp(rd, ys, x);
  };
  const prof = { step, d };
  const moving = at('moving');
  prof.t = d.map(x => moving(x));
  if (records[0].elapsed !== undefined) { const el = at('elapsed'); prof.e = d.map(x => el(x)); }
  if (fillGaps(records, 'speed')) { const f = at('speed'); prof.v = d.map(x => f(x) * 3.6); }
  else prof.v = d.map(() => 0);
  if (fillGaps(records, 'hr')) { const f = at('hr'); prof.hr = d.map(x => f(x)); }
  else prof.hr = d.map(() => 0);
  if (fillGaps(records, 'power')) { const f = at('power'); prof.p = d.map(x => f(x)); }
  if (fillGaps(records, 'lat') && fillGaps(records, 'lon')) {
    const lat0 = records[0].lat, lon0 = records[0].lon;
    const coslat = Math.cos(lat0 * Math.PI / 180);
    const flat = at('lat'), flon = at('lon');
    const xs = d.map(x => (flon(x) - lon0) * coslat * M_PER_DEG_LON);
    const ys = d.map(x => (flat(x) - lat0) * M_PER_DEG_LAT);
    const sm = arr => arr.map((_, i) => {
      const a = Math.max(0, i - SMOOTH), b = Math.min(arr.length, i + SMOOTH + 1);
      let s = 0; for (let j = a; j < b; j++) s += arr[j]; return s / (b - a);
    });
    Object.assign(prof, { lat0, lon0, x: sm(xs), y: sm(ys) });
  }
  if (fillGaps(records, 'alt')) {
    const falt = at('alt');
    prof.g = d.map(x => {
      const a = Math.max(0, x - GRADE_WINDOW), b = Math.min(total, x + GRADE_WINDOW);
      return b > a ? gradeClass(100 * (falt(b) - falt(a)) / (b - a)) : 0;
    });
    const w = Math.max(1, Math.round(GRADE_WINDOW / step));
    const alts = d.map(falt);
    prof.a = alts.map((_, i) => {
      const a = Math.max(0, i - w), b = Math.min(alts.length, i + w + 1);
      let s = 0; for (let j = a; j < b; j++) s += alts[j]; return s / (b - a);
    });
  }
  return prof;
}

// Read a ride file and return its profile. untilKm cuts the ride short.
export function profileFromFit(buffer, { untilKm = null, rider = RIDER, name = '' } = {}) {
  let { records, events, riderKg, tz } = loadRide(buffer);
  if (untilKm) records = records.filter(r => r.dist <= untilKm * 1000);
  if (records.length < 2) throw new Error('Nothing left before that distance.');
  let estimated = false;
  // A watch without a power meter may still write a power field, all zeros:
  // only trust power when a fair share of the riding has some.
  const riding = records.filter(r => (r.speed ?? 0) > 1).length;
  const realPower = records.filter(r => (r.power ?? 0) > 0).length >= Math.max(5, 0.25 * riding);
  if (!realPower && records.some(r => r.alt !== null)) {
    for (const r of records) r.power = null;
    estimatePower(records, events, { ...rider, riderKg: rider.riderKg || riderKg || 76.5 });
    estimated = true;
  }
  const prof = buildProfile(records, 5);
  prof.name = name;
  prof.powerEstimated = estimated;
  prof.start = records[0].ts + 631065600;        // Unix seconds of the first record
  prof.duration = records[records.length - 1].ts - records[0].ts;
  prof.tz = tz;                                   // seconds east of UTC, if the file says
  if (records[0].lat !== null && records[0].lat !== undefined) { prof.lat1 = records[0].lat; prof.lon1 = records[0].lon; }
  return prof;
}

// ---------------------------------------------------------------- GPX

// Points of a .gpx file: track points, else route points. Works without a
// DOM (plain text scan), so the tests run in node too.
export function readGpx(text) {
  if (!/<gpx[\s>]/i.test(text)) throw new Error('This is not a .gpx file.');
  const name = (text.match(/<metadata>[\s\S]*?<name>([\s\S]*?)<\/name>/i) || text.match(/<trk>\s*<name>([\s\S]*?)<\/name>/i) || [])[1];
  const tag = /<(?:\w+:)?trkpt[\s>]/i.test(text) ? 'trkpt' : /<(?:\w+:)?rtept[\s>]/i.test(text) ? 'rtept' : null;
  if (!tag) throw new Error('The .gpx file has no track or route points.');
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, 'gi');
  const num = (body, t) => { const m = body.match(new RegExp(`<(?:\\w+:)?${t}>\\s*([-+0-9.eE]+)\\s*<`, 'i')); return m ? parseFloat(m[1]) : null; };
  const pts = [];
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1], body = m[2] || '';
    const lat = parseFloat((attrs.match(/lat\s*=\s*["']([^"']+)/i) || [])[1]);
    const lon = parseFloat((attrs.match(/lon\s*=\s*["']([^"']+)/i) || [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tm = body.match(/<time>\s*([^<]+?)\s*<\/time>/i);
    const time = tm ? Date.parse(tm[1]) / 1000 : null;
    pts.push({ lat, lon, ele: num(body, 'ele'), time: Number.isFinite(time) ? time : null,
      hr: num(body, 'hr'), cad: num(body, 'cad'), power: num(body, 'power') ?? num(body, 'watts') });
  }
  if (pts.length < 2) throw new Error('The .gpx file has too few points.');
  return { name: name ? name.replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '', pts };
}

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Steady speed (m/s) at `watts` on `grade` (rise/run): pedal power = road load.
export function steadySpeed(watts, grade, rider = RIDER, alt = 0) {
  const m = rider.riderKg + (rider.extraKg ?? 1) + rider.bikeKg;
  const th = Math.atan(grade), rho = 1.225 * Math.exp(-alt / 8434);
  const net = v => watts * DRIVETRAIN - v * (m * G * (Math.sin(th) + rider.crr * Math.cos(th)) + 0.5 * rho * rider.cda * v * v);
  let lo = 0, hi = 40;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (net(mid) > 0) lo = mid; else hi = mid; }
  return lo;
}
// Power (W) needed to hold `v` m/s on `grade` (never below 0: coasting / braking).
function roadPower(v, grade, rider, alt = 0) {
  const m = rider.riderKg + (rider.extraKg ?? 1) + rider.bikeKg;
  const th = Math.atan(grade), rho = 1.225 * Math.exp(-alt / 8434);
  return Math.max(0, v * (m * G * (Math.sin(th) + rider.crr * Math.cos(th)) + 0.5 * rho * rider.cda * v * v) / DRIVETRAIN);
}

export const GPX_MAX_KMH = 50;     // a planned route's ghost doesn't descend faster than this
export const GPX_MIN_KMH = 6;      // ... or crawl slower than this on the steepest climbs

// Read a .gpx file and return its profile, like profileFromFit.
//  - a recorded ride (points with times): its own times, speed, HR, cadence
//    and power (power estimated when missing, as for .fit rides);
//  - a planned route (no times, e.g. from RideWithGPS or Komoot): the ghost
//    rides it at a steady `watts`, speed from the grade (same physics as
//    IndoorRide), capped between GPX_MIN_KMH and GPX_MAX_KMH.
export function profileFromGpx(text, { untilKm = null, rider = RIDER, name = '', watts = 160 } = {}) {
  const gpx = readGpx(text);
  const pts = gpx.pts;
  let dist = 0;
  const records = pts.map((p, i) => {
    if (i) dist += haversine(pts[i - 1], p);
    return { dist, lat: p.lat, lon: p.lon, alt: p.ele, hr: p.hr, cadence: p.cad, power: p.power, speed: null, _t: p.time };
  });
  const timed = pts.filter(p => p.time !== null).length >= 0.9 * pts.length
    && pts[pts.length - 1].time > pts[0].time;
  let estimated = false, planned = false, rec = records;
  if (untilKm) rec = rec.filter(r => r.dist <= untilKm * 1000);
  if (rec.length < 2) throw new Error('Nothing left before that distance.');
  // drop repeated points (same distance) so distance always increases
  rec = rec.filter((r, i) => i === 0 || r.dist > rec[i - 1].dist + 1e-6 || (timed && r._t > rec[i - 1]._t));
  if (timed) {
    let last = rec.find(r => r._t !== null)._t;
    for (const r of rec) { if (r._t === null || r._t < last) r._t = last; last = r._t; }
    const t0 = rec[0]._t;
    let moving = 0;
    rec.forEach((r, i) => {
      r.ts = r._t - 631065600; r.elapsed = r._t - t0;
      if (i) {
        const dt = r._t - rec[i - 1]._t, dd = r.dist - rec[i - 1].dist;
        r.speed = dt > 0 ? dd / dt : rec[i - 1].speed;
        if (dt > 0 && dd / dt > 0.5) moving += dt;   // stopped (and long gaps without motion) don't count
      }
      r.moving = moving;
    });
    rec[0].speed = rec[1].speed;
    for (const r of rec) r.speed = Math.min(r.speed ?? 0, 30);
    const riding = rec.filter(r => r.speed > 1).length;
    const realPower = rec.filter(r => (r.power ?? 0) > 0).length >= Math.max(5, 0.25 * riding);
    if (!realPower && rec.some(r => r.alt !== null)) {
      for (const r of rec) r.power = null;
      estimatePower(rec, [], rider);
      estimated = true;
    }
  } else {
    planned = true;
    if (!fillGaps(rec, 'alt')) rec.forEach(r => { r.alt = 0; });
    const total = rec[rec.length - 1].dist;
    const rd = rec.map(r => r.dist), ra = rec.map(r => r.alt);
    const grid = [];
    for (let g = 0; g <= total; g += 5) grid.push(g);
    if (grid[grid.length - 1] < total) grid.push(total);
    const alts = gaussianSmooth(grid, grid.map(g => interp(rd, ra, g)), 20);
    const lastI = grid.length - 1;
    const slope = grid.map((_, i) => {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, lastI);
      return b > a ? Math.max(-0.3, Math.min(0.3, (alts[b] - alts[a]) / (grid[b] - grid[a]))) : 0;
    });
    const vmax = GPX_MAX_KMH / 3.6, vmin = GPX_MIN_KMH / 3.6;
    const vs = grid.map((_, i) => Math.max(vmin, Math.min(vmax, steadySpeed(watts, slope[i], rider, alts[i]))));
    // no jumps in speed: at most about 0.5 m/s² either way (smooth over ±30 m)
    const vsm = gaussianSmooth(grid, vs, 15);
    const tg = [0];
    for (let i = 1; i < grid.length; i++) tg.push(tg[i - 1] + 2 * (grid[i] - grid[i - 1]) / (vsm[i] + vsm[i - 1]));
    const pg = vsm.map((v, i) => Math.min(watts * 1.5, roadPower(v, slope[i], rider, alts[i])));
    for (const r of rec) {
      r.moving = r.elapsed = interp(grid, tg, r.dist);
      r.ts = r.moving;
      r.speed = interp(grid, vsm, r.dist);
      r.power = Math.round(interp(grid, pg, r.dist));
      r.hr = null; r.cadence = null;
    }
  }
  for (const r of rec) delete r._t;
  const prof = buildProfile(rec, 5);
  prof.name = name || gpx.name || 'GPX route';
  prof.powerEstimated = estimated;
  prof.source = 'gpx';
  if (planned) { prof.planned = true; prof.plannedWatts = watts; }
  else {
    prof.start = rec[0].ts + 631065600;
    prof.duration = rec[rec.length - 1].ts - rec[0].ts;
  }
  prof.lat1 = rec[0].lat; prof.lon1 = rec[0].lon;
  return prof;
}

// ---------------------------------------------------------------- lookups

// Power from a profile alone (speed, slope, change of speed every 5 m), for
// profiles saved before zero-power files were caught: same physics as
// estimatePower, a little coarser.
export function profilePower(P, rider = RIDER) {
  const n = P.d.length, m = rider.riderKg + (rider.extraKg ?? 1) + rider.bikeKg, mEff = m + 1;
  const v = P.v.map(x => (x ?? 0) / 3.6), out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (v[i] < 1) continue;
    const i0 = Math.max(0, i - 4), i1 = Math.min(n - 1, i + 4);
    const grade = P.a && P.d[i1] > P.d[i0] ? (P.a[i1] - P.a[i0]) / (P.d[i1] - P.d[i0]) : 0;
    const j0 = Math.max(0, i - 1), j1 = Math.min(n - 1, i + 1);
    const dKE = P.d[j1] > P.d[j0] ? (v[j1] ** 2 - v[j0] ** 2) / 2 / (P.d[j1] - P.d[j0]) : 0;   // m/s² (energy per metre / mass)
    const th = Math.atan(Math.max(-0.25, Math.min(0.25, grade)));
    const F = m * 9.81 * (Math.sin(th) + rider.crr * Math.cos(th)) + 0.5 * 1.2 * rider.cda * v[i] ** 2 + mEff * dKE;
    out[i] = Math.max(0, F * v[i] / 0.97);
  }
  return out.map((_, i) => {                       // smooth over ±15 m
    let s = 0, k = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) { s += out[j]; k++; }
    return Math.round(Math.min(1500, s / k));
  });
}

export class Reference {
  constructor(prof) {
    if (prof.p && prof.v && !prof.p.some(x => x > 0)) {   // all-zero power (saved before the fix): estimate it
      prof.p = profilePower(prof); prof.powerEstimated = true;
    }
    this.prof = prof;
    this.d = prof.d;
    this.n = prof.d.length;
    this.total = prof.d[this.n - 1];
    this.totalTime = prof.t[this.n - 1];
    this.name = prof.name || 'Reference ride';
  }
  get hasRoute() { return !!this.prof.x; }
  get hasPower() { return !!this.prof.p; }
  get hasAlt() { return !!this.prof.a; }
  at(key, dist) { const ys = this.prof[key]; return ys ? interp(this.d, ys, dist) : 0; }
  timeAt(dist) { return this.at('t', dist); }
  // Distance the original ride had covered after `t` seconds of moving time.
  distAtTime(t) { return interp(this.prof.t, this.d, t); }
  // Clock seconds since the ride's start when the original rider passed `dist` (video sync).
  elapsedAt(dist) { return this.prof.e ? interp(this.d, this.prof.e, dist) : this.timeAt(dist); }
  distAtElapsed(e) { return interp(this.prof.e || this.prof.t, this.d, e); }
  gradeFraction(dist) {
    if (!this.hasAlt) return 0;
    const a = Math.max(0, dist - GRADE_WINDOW), b = Math.min(this.total, dist + GRADE_WINDOW);
    return b > a ? (this.at('a', b) - this.at('a', a)) / (b - a) : 0;
  }
  index(dist) { return Math.max(0, Math.min(this.n - 1, Math.floor(dist / this.prof.step))); }
  xy(dist) { return [this.at('x', dist), this.at('y', dist)]; }
  toJSON() { return this.prof; }
}

// Grade class colours, as on the watch (RouteMap.mc).
export function gradeColor(cls) {
  return cls <= -2 ? '#2F6FE0' : cls === -1 ? '#7CC4F5' : cls === 0 ? '#8A94A3'
    : cls === 1 ? '#FFD866' : cls === 2 ? '#FF9F43' : '#E8524A';
}

// ---------------------------------------------------------------- indoor physics

// Moves you along the route from your power (RideRepro/source/IndoorRide.mc):
// pedal the original power and you ride the original speed.
export class IndoorRide {
  constructor(rider = RIDER) {
    this.mass = rider.riderKg + rider.extraKg + rider.bikeKg;
    this.massEff = this.mass + 1;
    this.cda = rider.cda; this.crr = rider.crr;
    this.dist = 0; this.speed = 0;
  }
  // brake: true = braking hard (about 3 m/s² of deceleration)
  step(watts, dt, grade, brake = false) {
    if (dt <= 0) return;
    dt = Math.min(dt, 5);
    const angle = Math.atan(grade), sinA = Math.sin(angle), cosA = Math.cos(angle);
    const n = Math.max(1, Math.floor(dt / 0.25)), h = dt / n;
    for (let i = 0; i < n; i++) {
      const resist = this.mass * G * (sinA + this.crr * cosA) + 0.5 * 1.2 * this.cda * this.speed ** 2
        + (brake && this.speed > 0 ? this.massEff * 3 : 0);
      const push = watts * DRIVETRAIN / Math.max(this.speed, 1);
      this.speed = Math.max(0, this.speed + (push - resist) / this.massEff * h);
      this.dist += this.speed * h;
    }
  }
}
