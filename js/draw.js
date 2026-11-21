// Canvas drawing for both screens. Colours follow the watch apps.
import { gradeColor, interp } from './reference.js';
import { model } from './hrmodel.js';
import { drawStreets } from './streets.js';

export const C = {
  bg: '#0B0F14', panel: '#121821', grid: '#26313D', muted: '#9BA5B4', text: '#F2F5F8',
  teal: '#55D6C2', ghost: '#D86CFF', accent: '#FFD866', hr: '#FF6B6B', power: '#55D6C2',
  green: '#4AE858', yellow: '#FFD866', red: '#E8524A',
};

// Size a canvas to its box at device resolution; returns ctx with CSS-pixel units.
export function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.w = w; ctx.h = h;
  return ctx;
}

function message(ctx, text) {
  ctx.fillStyle = C.muted; ctx.font = '15px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(text, ctx.w / 2, ctx.h / 2);
}

function dot(ctx, x, y, r, fill, ring = '#000') {
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.fillStyle = ring; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill();
}

function arrow(ctx, x, y, angle, size) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.beginPath(); ctx.moveTo(0, -size); ctx.lineTo(size * 0.7, size * 0.8); ctx.lineTo(0, size * 0.35);
  ctx.lineTo(-size * 0.7, size * 0.8); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke(); ctx.fill();
  ctx.restore();
}

// Route coloured by grade, with you and the ghost.
//   view 'all'    - whole route, north up
//   view 'follow' - heading up around you, `span` metres of road ahead
export function drawRoute(canvas, ref, { you = null, ghost = null, view = 'all', span = 250, done = 0, streets = null, videoAt = null, anchor = 0.78, labelZone = null } = {}) {
  const ctx = fit(canvas);
  if (!ref) return message(ctx, 'Load a reference ride to see its route');
  if (!ref.hasRoute) return message(ctx, 'The reference ride has no GPS route');
  const P = ref.prof, n = ref.n, pad = 18;
  let toScreen, scale, cull = null;
  if (view === 'all') {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, P.x[i]); x1 = Math.max(x1, P.x[i]); y0 = Math.min(y0, P.y[i]); y1 = Math.max(y1, P.y[i]); }
    const s = Math.min((ctx.w - 2 * pad) / Math.max(1, x1 - x0), (ctx.h - 2 * pad) / Math.max(1, y1 - y0));
    const ox = (ctx.w - s * (x1 - x0)) / 2, oy = (ctx.h - s * (y1 - y0)) / 2;
    toScreen = (x, y) => [ox + s * (x - x0), ctx.h - oy - s * (y - y0)];
    scale = s;
  } else {
    const d = you ?? 0;
    const [cx, cy] = ref.xy(d);
    const [ax, ay] = ref.xy(Math.min(ref.total, d + 25));
    const [bx, by] = ref.xy(Math.max(0, d - 25));
    const head = Math.atan2(ax - bx, ay - by);           // radians from north
    const s = (ctx.h * (anchor - 0.08)) / span;           // `span` m from arrow to top
    const sx = ctx.w / 2, sy = ctx.h * anchor;
    const c = Math.cos(head), sn = Math.sin(head);
    toScreen = (x, y) => { const dx = x - cx, dy = y - cy; return [sx + s * (dx * c - dy * sn), sy - s * (dx * sn + dy * c)]; };
    scale = s; cull = { cx, cy, r: Math.hypot(ctx.w, ctx.h) / s };
  }
  canvas._toScreen = toScreen;                 // for clicks on the map (video sync)
  if (streets) {
    ctx.labelZone = labelZone;                   // street names only in this band (0..1 of the height)
    drawStreets(ctx, streets, toScreen, scale, cull);
    ctx.fillStyle = '#6B7685'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    ctx.fillText('© OpenStreetMap contributors', 6, ctx.h - 5);
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // casing, then grade colours (dimmed where you've already been)
  ctx.lineWidth = view === 'all' ? 7 : 16; ctx.strokeStyle = '#000';
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const [x, y] = toScreen(P.x[i], P.y[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
  ctx.lineWidth = view === 'all' ? 4 : 10;
  for (let i = 1; i < n; i++) {
    const [x0, y0] = toScreen(P.x[i - 1], P.y[i - 1]), [x1, y1] = toScreen(P.x[i], P.y[i]);
    ctx.strokeStyle = gradeColor(P.g ? P.g[i - 1] : 0);
    ctx.globalAlpha = P.d[i] <= done ? 0.35 : 1;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const [sx0, sy0] = toScreen(P.x[0], P.y[0]);
  dot(ctx, sx0, sy0, 4, '#fff');
  if (ghost != null) {
    let [gx, gy] = toScreen(...ref.xy(ghost));
    if (view === 'follow') {          // out of view: wait at the edge, in its direction
      const m = 16, cx = ctx.w / 2, cy = ctx.h * anchor;
      const k = Math.min(1, ...[gx < m ? (cx - m) / (cx - gx) : 1, gx > ctx.w - m ? (ctx.w - m - cx) / (gx - cx) : 1,
        gy < m ? (cy - m) / (cy - gy) : 1, gy > ctx.h - m ? (ctx.h - m - cy) / (gy - cy) : 1]);
      gx = cx + (gx - cx) * k; gy = cy + (gy - cy) * k;
    }
    dot(ctx, gx, gy, view === 'all' ? 7 : 10, C.ghost);
  }
  if (videoAt != null) {                         // where the video is: yellow ring
    const [vx, vy] = toScreen(...ref.xy(Math.max(0, Math.min(ref.total, videoAt))));
    ctx.beginPath(); ctx.arc(vx, vy, view === 'all' ? 9 : 13, 0, 7);
    ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.lineWidth = 2.5; ctx.strokeStyle = C.accent; ctx.stroke();
  }
  if (you != null) {
    const [yx, yy] = toScreen(...ref.xy(you));
    if (view === 'all') {
      const [ax, ay] = toScreen(...ref.xy(Math.min(ref.total, you + 30)));
      arrow(ctx, yx, yy, Math.atan2(ax - yx, yy - ay), 11);
    } else arrow(ctx, yx, yy, 0, 16);
  }
}

// Elevation profile with you and the ghost.
export function drawElevation(canvas, ref, you = null, ghost = null) {
  const ctx = fit(canvas);
  if (!ref || !ref.hasAlt) return message(ctx, ref ? 'No altitude in the reference ride' : '');
  const P = ref.prof, n = ref.n;
  let a0 = Infinity, a1 = -Infinity;
  for (const a of P.a) { a0 = Math.min(a0, a); a1 = Math.max(a1, a); }
  a1 = Math.max(a1, a0 + 20);
  const L = 44, R = 8, T = 8, B = 18;
  const X = d => L + (ctx.w - L - R) * d / ref.total, Y = a => ctx.h - B - (ctx.h - T - B) * (a - a0) / (a1 - a0);
  for (let i = 1; i < n; i++) {
    ctx.fillStyle = gradeColor(P.g ? P.g[i] : 0);
    const x0 = X(P.d[i - 1]), x1 = X(P.d[i]);
    ctx.fillRect(x0, Y(P.a[i]), Math.max(1, x1 - x0 + 0.5), ctx.h - B - Y(P.a[i]));
  }
  ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(a1)} m`, L - 4, T + 9); ctx.fillText(`${Math.round(a0)} m`, L - 4, ctx.h - B);
  ctx.textAlign = 'left'; ctx.fillText('0 km', L, ctx.h - 4);
  ctx.textAlign = 'right'; ctx.fillText(`${(ref.total / 1000).toFixed(1)} km`, ctx.w - R, ctx.h - 4);
  const mark = (d, col) => { ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X(d), T); ctx.lineTo(X(d), ctx.h - B); ctx.stroke(); };
  if (ghost != null) mark(ghost, C.ghost);
  if (you != null) mark(you, '#fff');
}

function axes(ctx, box, xr, yr, xlab, ylab) {
  const { L, R, T, B } = box;
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.muted; ctx.font = '12px system-ui';
  for (let j = 0; j <= 4; j++) {
    const x = L + (R - L) * j / 4, y = B - (B - T) * j / 4;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(xr.fmt(xr[0] + (xr[1] - xr[0]) * j / 4), x, B + 15);
    ctx.textAlign = 'right'; ctx.fillText(Math.round(yr[0] + (yr[1] - yr[0]) * j / 4), L - 6, y + 4);
  }
  ctx.textAlign = 'center'; ctx.fillText(xlab, (L + R) / 2, B + 31);
  ctx.save(); ctx.translate(13, (T + B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(ylab, 0, 0); ctx.restore();
}

const nice = (lo, hi, step) => [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];

// HR against power. Points fade with age (like the watch); the current point is yellow.
export function drawScatter(canvas, power, hr, now, { avg = 10 } = {}) {
  const ctx = fit(canvas);
  const pts = [];
  let s = 0, k = 0;
  for (let i = 0; i < power.length; i++) {
    s += power[i] ?? 0; k++;
    if (i >= avg) { s -= power[i - avg] ?? 0; k--; }
    if (hr[i] > 0 && i >= avg - 1) pts.push([s / k, hr[i], i]);
  }
  if (pts.length < 5) return message(ctx, 'HR vs power appears once you ride');
  let p1 = 100, h0 = 250, h1 = 0;
  for (const [p, h] of pts) { p1 = Math.max(p1, p); h0 = Math.min(h0, h); h1 = Math.max(h1, h); }
  const xr = nice(0, p1 * 1.05, 50), yr = nice(h0 - 3, h1 + 3, 10);
  xr.fmt = v => Math.round(v);
  const box = { L: 46, R: ctx.w - 12, T: 10, B: ctx.h - 38 };
  axes(ctx, box, xr, yr, `Power, ${avg}-s average (W)`, 'Heart rate (bpm)');
  const X = p => box.L + (box.R - box.L) * (p - xr[0]) / (xr[1] - xr[0]);
  const Y = h => box.B - (box.B - box.T) * (h - yr[0]) / (yr[1] - yr[0]);
  for (const [p, h, i] of pts) {
    const age = now - i;
    ctx.fillStyle = age < 120 ? '#55D6C2' : age < 360 ? '#328D82' : '#20514F';
    ctx.beginPath(); ctx.arc(X(p), Y(h), age < 120 ? 3 : 2.2, 0, 7); ctx.fill();
  }
  const [p, h] = pts[pts.length - 1];
  dot(ctx, X(p), Y(h), 6, C.accent);
}

// Power and HR over time (yours solid, the reference ride's dashed purple).
export function drawTrace(canvas, S, { window = 600 } = {}) {
  const ctx = fit(canvas);
  const n = S.power.length;
  if (n < 3) return message(ctx, 'Power and heart rate over time');
  const i0 = window ? Math.max(0, n - window) : 0, span = Math.max(60, (window || n) - 1);
  const box = { L: 46, R: ctx.w - 46, T: 10, B: ctx.h - 24 };
  let pMax = 100, h0 = 250, h1 = 0;
  for (let i = i0; i < n; i++) {
    pMax = Math.max(pMax, S.power[i] ?? 0, S.refPower[i] ?? 0);
    for (const h of [S.hr[i], S.refHr[i]]) if (h > 0) { h0 = Math.min(h0, h); h1 = Math.max(h1, h); }
  }
  if (h1 === 0) { h0 = 60; h1 = 180; }
  const pr = nice(0, pMax * 1.05, 50), hrR = nice(h0 - 3, h1 + 3, 10);
  const X = i => box.L + (box.R - box.L) * (i - i0) / span;
  const YP = p => box.B - (box.B - box.T) * p / pr[1];
  const YH = h => box.B - (box.B - box.T) * (h - hrR[0]) / (hrR[1] - hrR[0]);
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.font = '12px system-ui';
  for (let j = 0; j <= 4; j++) {
    const y = box.B - (box.B - box.T) * j / 4;
    ctx.beginPath(); ctx.moveTo(box.L, y); ctx.lineTo(box.R, y); ctx.stroke();
    ctx.fillStyle = C.power; ctx.textAlign = 'right'; ctx.fillText(Math.round(pr[1] * j / 4), box.L - 6, y + 4);
    ctx.fillStyle = C.hr; ctx.textAlign = 'left'; ctx.fillText(Math.round(hrR[0] + (hrR[1] - hrR[0]) * j / 4), box.R + 6, y + 4);
  }
  ctx.fillStyle = C.muted; ctx.textAlign = 'center';
  ctx.fillText(window ? `last ${Math.round(window / 60)} min` : 'whole ride', (box.L + box.R) / 2, ctx.h - 6);
  const line = (arr, Yf, col, w, dash = []) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath();
    let on = false;
    const step = Math.max(1, Math.floor((n - i0) / (box.R - box.L)));
    for (let i = i0; i < n; i += step) {
      const v = arr[i];
      if (v == null || (Yf === YH && !(v > 0))) { on = false; continue; }
      on ? ctx.lineTo(X(i), Yf(v)) : ctx.moveTo(X(i), Yf(v)); on = true;
    }
    ctx.stroke(); ctx.setLineDash([]);
  };
  line(S.refPower, YP, C.ghost, 1.5, [6, 4]);
  line(S.refHr, YH, '#B07CC0', 1.5, [2, 4]);
  line(S.power, YP, C.power, 2);
  line(S.hr, YH, C.hr, 2.5);
}

// The latest step: HR data with the fitted response curve.
export function drawStepFit(canvas, S, step) {
  const ctx = fit(canvas);
  if (!step) return message(ctx, 'Waiting for a clear power step (≥ 40 W, held 1 min)');
  const box = { L: 40, R: ctx.w - 10, T: 26, B: ctx.h - 22 };
  const s0 = -15, s1 = 120;
  let h0 = 250, h1 = 0;
  for (let s = s0; s <= s1; s++) { const h = S.hr[step.t + s]; if (h > 0) { h0 = Math.min(h0, h); h1 = Math.max(h1, h); } }
  const yr = nice(h0 - 2, h1 + 2, 5);
  const X = s => box.L + (box.R - box.L) * (s - s0) / (s1 - s0);
  const Y = h => box.B - (box.B - box.T) * (h - yr[0]) / (yr[1] - yr[0]);
  ctx.strokeStyle = C.grid; ctx.font = '11px system-ui'; ctx.fillStyle = C.muted;
  for (const s of [0, 30, 60, 90, 120]) { ctx.beginPath(); ctx.moveTo(X(s), box.T); ctx.lineTo(X(s), box.B); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText(`${s}s`, X(s), ctx.h - 6); }
  ctx.textAlign = 'right'; ctx.fillText(yr[1], box.L - 5, box.T + 4); ctx.fillText(yr[0], box.L - 5, box.B);
  // delay shading
  ctx.fillStyle = 'rgba(255,216,102,0.15)'; ctx.fillRect(X(0), box.T, X(step.delay) - X(0), box.B - box.T);
  ctx.fillStyle = C.hr;
  for (let s = s0; s <= s1; s++) { const h = S.hr[step.t + s]; if (h > 0) { ctx.beginPath(); ctx.arc(X(s), Y(h), 2, 0, 7); ctx.fill(); } }
  ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5; ctx.beginPath();
  for (let s = s0; s <= s1; s++) { const y = Y(model(step, s)); s === s0 ? ctx.moveTo(X(s), y) : ctx.lineTo(X(s), y); }
  ctx.stroke();
  ctx.fillStyle = C.text; ctx.font = '13px system-ui'; ctx.textAlign = 'left';
  ctx.fillText(`${step.up ? '▲' : '▼'} ${Math.round(step.pre)} → ${Math.round(step.post)} W   delay ${step.delay} s   τ ${step.tau.toFixed(0)} s   R² ${step.r2.toFixed(2)}`, box.L, 16);
}

// Horizontal gap gauge: ±range m, green/yellow/red bands like the watch.
export function drawGapGauge(canvas, gapM, range = 100) {
  const ctx = fit(canvas);
  const W = ctx.w, H = ctx.h, mid = W / 2;
  const X = m => mid + (W / 2 - 6) * Math.max(-1, Math.min(1, m / range));
  const bands = [[-range, -70, C.red], [-70, -25, C.yellow], [-25, 25, C.green], [25, 70, C.yellow], [70, range, C.red]];
  for (const [a, b, col] of bands) { ctx.fillStyle = col; ctx.globalAlpha = 0.55; ctx.fillRect(X(a), H * 0.3, X(b) - X(a), H * 0.4); }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff'; ctx.fillRect(mid - 1, H * 0.2, 2, H * 0.6);
  if (gapM != null) {
    const x = X(gapM);
    ctx.beginPath(); ctx.moveTo(x, H * 0.1); ctx.lineTo(x - 9, 0); ctx.lineTo(x + 9, 0); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillRect(x - 2, H * 0.1, 4, H * 0.8);
  }
}

export { interp };
