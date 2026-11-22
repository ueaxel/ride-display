// Team rides: more rides of the same route racing along as extra ghosts.
// Each ride is laid onto the reference route: it starts where it passes the
// reference's start, and from then on its position is measured along the
// reference route (so all dots sit on the same line, map and elevation).
// Kept per reference as the reference-route distance for every second of
// the ride's moving time.

import { ironStops } from './refedit.js';

export const TEAM_COLORS = ['#4FC3F7', '#FFB74D', '#81C784', '#F06292', '#FFD54F', '#BA68C8', '#4DB6AC', '#E57373'];
const M_LAT = 110540, M_LON = 111320;

// ref: Reference (with route), P: profile of the other ride. Returns
// { d: [reference distance at moving second 0, 1, 2, ...], start, matched }.
export function layOnRoute(ref, P0, { smoothStops = true } = {}) {
  if (!ref.hasRoute) throw new Error('The reference ride has no GPS route.');
  if (!P0.x || P0.lat0 == null) throw new Error('This ride has no GPS positions.');
  const P = smoothStops && P0.v ? ironStops(P0).prof : P0;
  const R = ref.prof, n = R.d.length, cos = Math.cos(R.lat0 * Math.PI / 180);
  // this ride's points in the reference's metres
  const dx = (P.lon0 - R.lon0) * cos * M_LON, dy = (P.lat0 - R.lat0) * M_LAT;
  const X = P.x.map(x => x + dx), Y = P.y.map(y => y + dy);
  const near = (x, y, i0, i1) => {
    let best = { off: Infinity, d: 0, i: i0 };
    for (let i = Math.max(0, i0); i < Math.min(n - 1, i1); i++) {
      const ax = R.x[i], ay = R.y[i], bx = R.x[i + 1] - ax, by = R.y[i + 1] - ay, L2 = bx * bx + by * by || 1;
      const f = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / L2));
      const off = Math.hypot(x - ax - f * bx, y - ay - f * by);
      if (off < best.off) best = { off, d: R.d[i] + f * (R.d[i + 1] - R.d[i]), i };
    }
    return best;
  };
  // start: where this ride comes closest to the reference's start (in its first 600 m)
  let k0 = 0, bestOff = Infinity;
  for (let k = 0; k < P.d.length && P.d[k] <= 600; k++) {
    const off = Math.hypot(X[k] - R.x[0], Y[k] - R.y[0]);
    if (off < bestOff) { bestOff = off; k0 = k; }
  }
  if (bestOff > 150) throw new Error(`This ride doesn't start near the reference's start (closest ${Math.round(bestOff)} m).`);
  // follow it along the reference route
  const t0 = P.t[k0], pts = [];
  let i = 0, d = 0, matched = 0;
  for (let k = k0; k < P.d.length; k++) {
    const m = near(X[k], Y[k], i - 20, i + 200);
    if (m.off < 60) { if (m.d >= d - 30) { d = Math.max(d, m.d); i = m.i; } matched++; }   // detours hold the position
    pts.push([P.t[k] - t0, d]);
  }
  if (matched / Math.max(1, P.d.length - k0) < 0.5) throw new Error('This ride follows a different route (it is on the reference route less than half the way).');
  // one value per moving second
  const out = [], T = pts[pts.length - 1][0];
  let j = 0;
  for (let s = 0; s <= T; s++) {
    while (j < pts.length - 2 && pts[j + 1][0] < s) j++;
    const [ta, da] = pts[j], [tb, db] = pts[Math.min(j + 1, pts.length - 1)];
    out.push(Math.round((tb > ta ? da + (db - da) * (s - ta) / (tb - ta) : db) * 10) / 10);
  }
  return { d: out, matched: matched / Math.max(1, P.d.length - k0), finish: out[out.length - 1] };
}

// position of a team member after `sec` moving seconds
export function memberAt(m, sec) {
  if (sec <= 0) return m.d[0] ?? 0;
  const i = Math.floor(sec), f = sec - i;
  if (i >= m.d.length - 1) return m.d[m.d.length - 1];
  return m.d[i] + (m.d[i + 1] - m.d[i]) * f;
}
