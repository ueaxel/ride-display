// Writes a ride as a FIT activity file that Garmin Connect (and Strava,
// GoldenCheetah, ...) can import: one record per second with power, heart
// rate, cadence, speed, distance and (outdoors) position, plus timer
// events for pauses, one lap, the session and the activity summary.

const FIT_EPOCH = 631065600;          // 1989-12-31T00:00:00Z in Unix seconds
const CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
  0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];

function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    let t = CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[b & 0xF];
    t = CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[(b >> 4) & 0xF];
  }
  return crc;
}

// base types: [id, size, invalid, DataView setter]
const T = {
  enum: [0x00, 1, 0xFF, 'setUint8'], u8: [0x02, 1, 0xFF, 'setUint8'], s32: [0x85, 4, 0x7FFFFFFF, 'setInt32'],
  u16: [0x84, 2, 0xFFFF, 'setUint16'], u32: [0x86, 4, 0xFFFFFFFF, 'setUint32'], u32z: [0x8C, 4, 0, 'setUint32'],
};

class Writer {
  constructor() { this.chunks = []; this.size = 0; this.defs = {}; }
  push(arr) { this.chunks.push(arr); this.size += arr.length; }
  // fields: [[number, type], ...]
  define(local, glob, fields) {
    const b = new Uint8Array(6 + 3 * fields.length);
    b[0] = 0x40 | local; b[2] = 0; b[3] = glob & 0xFF; b[4] = glob >> 8; b[5] = fields.length;
    fields.forEach(([num, type], i) => { b[6 + 3 * i] = num; b[7 + 3 * i] = T[type][1]; b[8 + 3 * i] = T[type][0]; });
    this.push(b);
    this.defs[local] = fields;
  }
  data(local, values) {
    const fields = this.defs[local];
    const size = 1 + fields.reduce((s, [, t]) => s + T[t][1], 0);
    const b = new Uint8Array(size), dv = new DataView(b.buffer);
    b[0] = local;
    let p = 1;
    for (const [num, type] of fields) {
      const [, sz, invalid, set] = T[type];
      let v = values[num];
      if (v == null || Number.isNaN(v)) v = invalid;
      else v = Math.round(v);
      dv[set](p, v, true);
      p += sz;
    }
    this.push(b);
  }
  bytes() {
    const header = new Uint8Array(14), hv = new DataView(header.buffer);
    header[0] = 14; header[1] = 0x20; hv.setUint16(2, 2132, true); hv.setUint32(4, this.size, true);
    header.set([0x2E, 0x46, 0x49, 0x54], 8);
    hv.setUint16(12, crc16(header.subarray(0, 12)), true);
    const out = new Uint8Array(14 + this.size + 2);
    out.set(header, 0);
    let p = 14;
    for (const c of this.chunks) { out.set(c, p); p += c.length; }
    const crc = crc16(out.subarray(0, p));
    out[p] = crc & 0xFF; out[p + 1] = crc >> 8;
    return out;
  }
}

const fitTime = ms => Math.floor(ms / 1000) - FIT_EPOCH;
const semicircles = deg => deg == null ? null : Math.round(deg * 2 ** 31 / 180);

// S: the session arrays from app.js (one entry per moving second, S.wall = clock ms).
// indoor: true for the trainer, false for outdoor rides.
export function buildFit(S, { indoor = true } = {}) {
  const n = S.wall.length;
  if (!n) throw new Error('Nothing recorded yet.');
  // Indoor ride on a reference route: write the route's position and elevation at your
  // route distance (a "virtual ride", as Zwift does), so it overlays the original ride.
  const virtual = indoor && !!S.routeLat?.some(v => v != null);
  const lat = i => S.lat[i] ?? (virtual ? S.routeLat[i] : null);
  const lon = i => S.lon[i] ?? (virtual ? S.routeLon[i] : null);
  const alt = i => S.alt?.[i] ?? (virtual ? S.routeAlt?.[i] : null);
  const w = new Writer();
  const t0 = fitTime(S.wall[0]) - 1, tEnd = fitTime(S.wall[n - 1]);
  // file_id
  w.define(0, 0, [[0, 'enum'], [1, 'u16'], [2, 'u16'], [3, 'u32z'], [4, 'u32']]);
  w.data(0, { 0: 4, 1: 255, 2: 1, 3: 1 + (t0 % 100000), 4: t0 });
  // events (timer start / stop_all)
  w.define(1, 21, [[253, 'u32'], [0, 'enum'], [1, 'enum']]);
  w.data(1, { 253: t0, 0: 0, 1: 0 });
  // records
  w.define(2, 20, [[253, 'u32'], [0, 's32'], [1, 's32'], [2, 'u16'], [3, 'u8'], [4, 'u8'], [5, 'u32'], [6, 'u16'], [7, 'u16']]);
  let last = t0;
  for (let i = 0; i < n; i++) {
    const ts = Math.max(last + 1, fitTime(S.wall[i]));
    if (ts - last > 2 && i > 0) {                 // paused: timer stop, then start again
      w.data(1, { 253: last, 0: 0, 1: 4 });
      w.data(1, { 253: ts - 1, 0: 0, 1: 0 });
    }
    w.data(2, {
      253: ts, 0: semicircles(lat(i)), 1: semicircles(lon(i)),
      2: alt(i) != null ? (alt(i) + 500) * 5 : null,
      3: S.hr[i] > 0 ? S.hr[i] : null, 4: S.cad[i], 5: S.dist[i] * 100, 6: S.speed[i] * 1000,
      7: S.power[i],
    });
    last = ts;
  }
  w.data(1, { 253: last, 0: 0, 1: 4 });
  // summaries
  const vals = a => a.filter(v => v != null && v > 0);
  const avg = a => { const v = vals(a); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  const max = a => { const v = vals(a); return v.length ? Math.max(...v) : null; };
  const pw = S.power.map(v => v ?? 0);
  const sum = {
    start: t0, elapsedMs: (last - t0) * 1000, timerMs: n * 1000, distCm: (S.dist[n - 1] || 0) * 100,
    avgHr: avg(S.hr), maxHr: max(S.hr), avgP: indoor || vals(pw).length ? pw.reduce((a, b) => a + b, 0) / n : null,
    maxP: max(pw), avgCad: avg(S.cad), maxCad: max(S.cad), avgSpd: (S.dist[n - 1] || 0) / n * 1000, maxSpd: max(S.speed) * 1000,
  };
  const sport = 2, sub = virtual ? 58 : indoor ? 6 : 7;   // cycling; virtual_activity / indoor_cycling / road
  // lap
  w.define(3, 19, [[253, 'u32'], [254, 'u16'], [0, 'enum'], [1, 'enum'], [2, 'u32'], [7, 'u32'], [8, 'u32'], [9, 'u32'],
    [13, 'u16'], [14, 'u16'], [15, 'u8'], [16, 'u8'], [17, 'u8'], [18, 'u8'], [19, 'u16'], [20, 'u16'], [25, 'enum'], [39, 'enum']]);
  w.data(3, { 253: last, 254: 0, 0: 9, 1: 1, 2: sum.start, 7: sum.elapsedMs, 8: sum.timerMs, 9: sum.distCm,
    13: sum.avgSpd, 14: sum.maxSpd, 15: sum.avgHr, 16: sum.maxHr, 17: sum.avgCad, 18: sum.maxCad, 19: sum.avgP, 20: sum.maxP, 25: sport, 39: sub });
  // session
  w.define(4, 18, [[253, 'u32'], [254, 'u16'], [0, 'enum'], [1, 'enum'], [2, 'u32'], [5, 'enum'], [6, 'enum'], [7, 'u32'], [8, 'u32'],
    [9, 'u32'], [14, 'u16'], [15, 'u16'], [16, 'u8'], [17, 'u8'], [18, 'u8'], [19, 'u8'], [20, 'u16'], [21, 'u16'], [25, 'u16'], [26, 'u16']]);
  w.data(4, { 253: last, 254: 0, 0: 8, 1: 1, 2: sum.start, 5: sport, 6: sub, 7: sum.elapsedMs, 8: sum.timerMs, 9: sum.distCm,
    14: sum.avgSpd, 15: sum.maxSpd, 16: sum.avgHr, 17: sum.maxHr, 18: sum.avgCad, 19: sum.maxCad, 20: sum.avgP, 21: sum.maxP, 25: 0, 26: 1 });
  // activity
  const tz = -new Date(S.wall[0]).getTimezoneOffset() * 60;
  w.define(5, 34, [[253, 'u32'], [0, 'u32'], [1, 'u16'], [2, 'enum'], [3, 'enum'], [4, 'enum'], [5, 'u32']]);
  w.data(5, { 253: last, 0: sum.timerMs, 1: 1, 2: 0, 3: 26, 4: 1, 5: last + tz });
  return w.bytes();
}

// ------------------------------------------------------------ .zip from Garmin Connect

// The first .fit inside a .zip (Garmin Connect "Export Original"). Uses the
// central directory, so sizes are right even when the zip streams them.
export async function fitFromZip(buffer) {
  const b = new Uint8Array(buffer), dv = new DataView(buffer);
  let e = b.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a .zip file.');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.fit$/i.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = b.subarray(start, start + csize);
    if (method === 0) return data.slice().buffer;
    if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).arrayBuffer();
    }
    throw new Error('Unsupported .zip compression.');
  }
  throw new Error('No .fit file found in the .zip.');
}
