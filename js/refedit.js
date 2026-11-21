// Cleaning up a reference ride before racing it:
//  - ironStops: a stop (traffic light) in the original makes the ghost slow
//    down, stand, and speed up again. The slowing and speeding up are replaced
//    by steady riding from the speed before to the speed after. (The standing
//    time itself is already left out: the ghost runs on moving time.)
//  - findTurnBacks / cutTurnBack: a stretch ridden back and forth (turning
//    around to take a picture) is found, shown, and cut out when you confirm.
// Profiles are sampled every `step` metres; speed v is in km/h.

const ARRAYS = ['d', 't', 'e', 'v', 'hr', 'p', 'x', 'y', 'g', 'a'];

function median(a) { const s = a.filter(v => v != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; }
function clone(P) { const Q = { ...P }; for (const k of ARRAYS) if (P[k]) Q[k] = P[k].slice(); return Q; }

// Indices where the original rider stopped or nearly stopped.
function stopIndices(P) {
  const n = P.d.length, out = [];
  const paused = i => (P.e ? P.e[i] - P.t[i] : 0);
  for (let i = 1; i < n - 1; i++) {
    const halt = paused(i) - paused(i - 1) > 3;
    // rolling stop: a sharp dip in speed
    const w0 = Math.max(0, i - 30), w1 = Math.min(n, i + 31);
    const around = median(P.v.slice(w0, w1));
    const dip = P.v[i] < 6 && around != null && around > 2.5 * P.v[i] && P.v[i] <= P.v[i - 1] && P.v[i] <= P.v[i + 1];
    if (halt || dip) {
      if (out.length && i - out[out.length - 1] < 100 / P.step) continue;
      out.push(i);
    }
  }
  return out;
}

// Returns { prof, smoothed: [{ d, seconds }] } (a new profile; the input is untouched).
export function ironStops(P0) {
  if (!P0.v || !P0.t) return { prof: P0, smoothed: [] };
  const P = clone(P0), n = P.d.length, st = P.step || 5, smoothed = [];
  const S = m => Math.round(m / st);
  for (const s of stopIndices(P)) {
    if (P.d[s] < 150 || P.d[n - 1] - P.d[s] < 150) continue;      // start and finish stay as they were
    const before = Math.max(10, median(P.v.slice(Math.max(0, s - S(250)), Math.max(1, s - S(125)))) ?? 0);
    const after = Math.max(10, median(P.v.slice(Math.min(n - 1, s + S(150)), Math.min(n, s + S(300)))) ?? 0);
    let a = s; while (a > 0 && s - a < S(400) && P.v[a] < 0.9 * before) a--;
    let c = s; while (c < n - 1 && c - s < S(500) && P.v[c] < 0.9 * after) c++;
    if (c - a < 3) continue;
    let oldT = P.t[c] - P.t[a], newT = 0;
    const va = P.v[a], vc = P.v[c];
    const pa = P.p ? P.p[a] : 0, pc = P.p ? P.p[c] : 0;
    for (let i = a + 1; i <= c; i++) {
      const f = (i - a) / (c - a);
      if (i < c) { P.v[i] = va + (vc - va) * f; if (P.p) P.p[i] = pa + (pc - pa) * f; }
      newT += (P.d[i] - P.d[i - 1]) / (Math.max(1, (P.v[i] + P.v[i - 1]) / 2) / 3.6);
    }
    const saved = oldT - newT;
    if (saved <= 0.5) continue;
    // new times over the stretch, then everything after moves earlier
    let t = P.t[a];
    for (let i = a + 1; i <= c; i++) { t += (P.d[i] - P.d[i - 1]) / (Math.max(1, (P.v[i] + P.v[i - 1]) / 2) / 3.6); P.t[i] = t; }
    for (let i = c + 1; i < n; i++) P.t[i] -= saved;
    smoothed.push({ d: P.d[s], from: P.d[a], to: P.d[c], seconds: Math.round(saved) });
  }
  return { prof: P, smoothed };
}

// Stretches ridden there and back again: two turn-arounds close together,
// coming back to where the first one started. [{ i0, i1, d0, d1, back }]
export function findTurnBacks(P) {
  if (!P.x) return [];
  const n = P.d.length, st = P.step || 5;
  const H = (i, j) => Math.hypot(P.x[i] - P.x[j], P.y[i] - P.y[j]);
  // how far the track runs back on itself around each point
  const K = new Array(n).fill(0);
  for (let i = 2; i < n - 2; i++) {
    let k0 = 0;
    for (let k = 2; k <= 600 / st && i - k >= 0 && i + k < n; k++) {
      if (H(i - k, i + k) < 20) k0 = k; else if (k > k0 + 3) break;
    }
    K[i] = k0;
  }
  const turns = [];
  for (let i = 2; i < n - 2; i++) {
    if (K[i] < 4) continue;
    let peak = true;
    for (let j = Math.max(0, i - 10); j <= Math.min(n - 1, i + 10); j++) if (K[j] > K[i] || (K[j] === K[i] && j < i)) { peak = false; break; }
    if (peak) turns.push(i);
  }
  const out = [];
  for (let k = 0; k + 1 < turns.length; k++) {
    const t1 = turns[k], t2 = turns[k + 1], L = t2 - t1;
    if (L < 3 || L * st > 800) continue;
    let best = null;
    for (let j = t2 + L - 12; j <= t2 + L + 12; j++) {
      if (j <= t2 || j >= n) continue;
      const h = H(t1, j);
      if (h < 30 && (!best || h < best.h)) best = { j, h };
    }
    if (!best) continue;
    out.push({ i0: t1, i1: best.j, d0: P.d[t1], d1: P.d[best.j], back: Math.round(L * st) });
    k++;                                          // its second turn is used up
  }
  return out;
}

// Remove the stretch i0..i1 (both at about the same place); later distances
// and times move up to close the hole.
export function cutTurnBack(P0, { i0, i1, d0, d1 }) {
  const P = clone(P0);
  const dd = P.d[i1] - P.d[i0], dt = P.t[i1] - P.t[i0], de = P.e ? P.e[i1] - P.e[i0] : 0;
  for (const k of ARRAYS) if (P[k]) P[k].splice(i0 + 1, i1 - i0);
  for (let i = i0 + 1; i < P.d.length; i++) {
    P.d[i] = Math.round((P.d[i] - dd) * 10) / 10; P.t[i] -= dt; if (P.e) P.e[i] -= de;
  }
  P.cuts = [...(P0.cuts || []), { d0, d1 }];
  return P;
}

// Work the original rider had done at each point, in joules (from power and moving time).
export function workProfile(P) {
  if (!P.p) return null;
  const w = [0];
  for (let i = 1; i < P.d.length; i++) w.push(w[i - 1] + Math.max(0, (P.p[i] + P.p[i - 1]) / 2) * Math.max(0, P.t[i] - P.t[i - 1]));
  return w;
}
