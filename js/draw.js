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

// Finger panning, zooming and turning (enablePan): canvas._pv = { dx, dy, z, r }
// (CSS pixels, scale, radians clockwise), applied on top of the map's own view,
// about the canvas centre.
function panned(canvas, ctx, toScreen) {
  const v = canvas._pv;
  if (!isPanned(canvas)) return [toScreen, 1, 0, 0];
  const cx = ctx.w / 2, cy = ctx.h / 2, c = Math.cos(v.r || 0) * v.z, sn = Math.sin(v.r || 0) * v.z;
  return [(x, y) => { const [a, b] = toScreen(x, y), qx = a - cx, qy = b - cy; return [cx + qx * c - qy * sn + v.dx, cy + qx * sn + qy * c + v.dy]; },
    v.z, Math.hypot(v.dx, v.dy), v.r || 0];
}
export function isPanned(canvas) { const v = canvas._pv; return !!v && (v.dx !== 0 || v.dy !== 0 || v.z !== 1 || (v.r || 0) !== 0); }
export function resetPan(canvas) { canvas._pv = { dx: 0, dy: 0, z: 1, r: 0, at: 0 }; }

// Small compass (top left) when the map isn't heading-up or north-up as drawn.
function compass(ctx, north) {
  const x = 26, y = 36;
  ctx.save(); ctx.translate(x, y); ctx.rotate(north);
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, 7); ctx.fillStyle = 'rgba(11,15,20,.75)'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(5, 2); ctx.lineTo(-5, 2); ctx.closePath(); ctx.fillStyle = C.red; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(5, 2); ctx.lineTo(-5, 2); ctx.closePath(); ctx.fillStyle = '#ccc'; ctx.fill();
  ctx.restore();
  ctx.fillStyle = C.text; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('N', x + Math.sin(north) * 22, y - Math.cos(north) * 22 + 4);
}

// One finger drags the map, two fingers pinch-zoom and turn it (mouse: drag,
// wheel zooms, shift + wheel turns), double-tap puts it back. onChange() redraws.
export function enablePan(canvas, onChange) {
  resetPan(canvas);
  canvas.style.touchAction = 'none';
  const pts = new Map();
  let moved = false, raf = 0, lastTap = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; onChange(); }); };
  // zoom by f and turn by dr about screen point (mx, my), which stays put
  const turnAt = (mx, my, f, dr) => {
    const v = canvas._pv, r = canvas.getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2, z2 = Math.max(0.2, Math.min(12, v.z * f)), r2 = (v.r || 0) + dr;
    // unpanned point under (mx, my)
    const ux = mx - cx - v.dx, uy = my - cy - v.dy, c0 = Math.cos(-(v.r || 0)) / v.z, s0 = Math.sin(-(v.r || 0)) / v.z;
    const qx = ux * c0 - uy * s0, qy = ux * s0 + uy * c0;
    const c1 = Math.cos(r2) * z2, s1 = Math.sin(r2) * z2;
    v.dx = mx - cx - (qx * c1 - qy * s1); v.dy = my - cy - (qx * s1 + qy * c1); v.z = z2;
    v.r = Math.abs(r2) < 0.03 ? 0 : r2;           // snaps back to straight
  };
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, local(e)); moved = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* */ }
  });
  canvas.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const v = canvas._pv, p = local(e);
    if (pts.size === 1) {
      const [ox, oy] = pts.get(e.pointerId);
      if (!moved && Math.hypot(p[0] - ox, p[1] - oy) < 6) return;     // a tap, not a drag (yet)
      moved = true; v.dx += p[0] - ox; v.dy += p[1] - oy;
    } else if (pts.size === 2) {
      const prev = pts.get(e.pointerId), other = pts.get([...pts.keys()].find(k => k !== e.pointerId));
      const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]), d1 = Math.hypot(p[0] - other[0], p[1] - other[1]);
      const a0 = Math.atan2(prev[1] - other[1], prev[0] - other[0]), a1 = Math.atan2(p[1] - other[1], p[0] - other[0]);
      let da = a1 - a0; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      const m0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2], m1 = [(p[0] + other[0]) / 2, (p[1] + other[1]) / 2];
      v.dx += m1[0] - m0[0]; v.dy += m1[1] - m0[1];
      if (d0 > 10) turnAt(m1[0], m1[1], d1 / d0, da);
      moved = true;
    }
    pts.set(e.pointerId, p); v.at = Date.now(); redraw();
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!moved && !pts.size) {
      const now = Date.now();
      if (now - lastTap < 350) { resetPan(canvas); redraw(); lastTap = 0; } else lastTap = now;
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const [mx, my] = local(e), dy = e.deltaY || e.deltaX;
    if (e.shiftKey) turnAt(mx, my, 1, dy * 0.003); else turnAt(mx, my, Math.pow(1.0015, -dy), 0);
    canvas._pv.at = Date.now(); redraw();
  }, { passive: false });
}

// Where you are before the ride: green dot (blinking), a dashed line to the
// nearest point of the route and how far it is. me = { x, y, near: {x, y} }.
function drawMe(ctx, toScreen, me) {
  const [mx, my] = toScreen(me.x, me.y);
  if (me.near) {
    const [nx, ny] = toScreen(me.near.x, me.near.y);
    ctx.save(); ctx.setLineDash([6, 6]); ctx.lineWidth = 3; ctx.strokeStyle = C.green;
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(nx, ny); ctx.stroke(); ctx.restore();
    dot(ctx, nx, ny, 6, '#fff', C.green);
  }
  const on = Math.floor(Date.now() / 500) % 2 === 0;
  if (me.acc) {                                   // GPS accuracy circle
    const [ex] = toScreen(me.x + me.acc, me.y), rr = Math.hypot(ex - mx, toScreen(me.x + me.acc, me.y)[1] - my);
    if (rr > 12) { ctx.beginPath(); ctx.arc(mx, my, rr, 0, 7); ctx.fillStyle = 'rgba(74,232,88,.12)'; ctx.fill(); }
  }
  ctx.beginPath(); ctx.arc(mx, my, on ? 16 : 11, 0, 7); ctx.fillStyle = on ? 'rgba(74,232,88,.35)' : 'rgba(74,232,88,.15)'; ctx.fill();
  dot(ctx, mx, my, 8, on ? C.green : '#2a8f35', '#fff');
}

// Route coloured by grade, with you and the ghost.
//   view 'all'    - whole route, north up
//   view 'follow' - heading up around you, `span` metres of road ahead
export function drawRoute(canvas, ref, { you = null, ghost = null, view = 'all', span = 250, done = 0, streets = null, videoAt = null, anchor = 0.78, labelZone = null, trail = null, team = [], me = null } = {}) {
  const ctx = fit(canvas);
  if (!ref) return message(ctx, 'Load a reference ride to see its route');
  if (!ref.hasRoute) return message(ctx, 'The reference ride has no GPS route');
  const P = ref.prof, n = ref.n, pad = 18;
  let toScreen, scale, cull = null;
  if (view === 'locate' && !me) view = 'all';
  if (view === 'locate') {                       // before the ride: you, the start and the nearest route point, north up
    const xs = [me.x, P.x[0]], ys = [me.y, P.y[0]];
    if (me.near) { xs.push(me.near.x); ys.push(me.near.y); }
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
    const ext = Math.max(250, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const s = Math.min(ctx.w - 2 * pad - 30, ctx.h - 2 * pad - 30) / ext;
    toScreen = (x, y) => [ctx.w / 2 + s * (x - mx), ctx.h / 2 - s * (y - my)];
    scale = s; cull = { cx: mx, cy: my, r: Math.hypot(ctx.w, ctx.h) / s };
  } else if (view === 'all') {
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
  {
    const [T, z, off, rot] = panned(canvas, ctx, toScreen);
    if (z !== 1 || off || rot) { toScreen = T; scale *= z; if (cull) cull.r = (Math.hypot(ctx.w, ctx.h) + 2 * off) / scale; }
    var turned = rot;
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
  // one path per colour (and per done / still to ride) instead of one stroke
  // per 5-m piece; points closer than 1.5 px on screen are skipped
  const casing = new Path2D(), runs = new Map();
  let [lx, ly] = toScreen(P.x[0], P.y[0]), lastKey = null;
  casing.moveTo(lx, ly);
  for (let i = 1; i < n; i++) {
    const [x, y] = toScreen(P.x[i], P.y[i]);
    const key = (P.g ? P.g[i - 1] : 0) + (P.d[i] <= done ? 'd' : '');
    if (i < n - 1 && key === lastKey && Math.abs(x - lx) < 1.5 && Math.abs(y - ly) < 1.5) continue;
    casing.lineTo(x, y);
    let path = runs.get(key);
    if (!path) { path = new Path2D(); runs.set(key, path); }
    if (key !== lastKey) path.moveTo(lx, ly);
    path.lineTo(x, y);
    lx = x; ly = y; lastKey = key;
  }
  ctx.lineWidth = view === 'all' ? 7 : 16; ctx.strokeStyle = '#000'; ctx.stroke(casing);
  ctx.lineWidth = view === 'all' ? 4 : 10;
  for (const [key, path] of runs) {
    ctx.strokeStyle = gradeColor(parseInt(key, 10));
    ctx.globalAlpha = key.endsWith('d') ? 0.35 : 1;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
  const [sx0, sy0] = toScreen(P.x[0], P.y[0]);
  dot(ctx, sx0, sy0, 4, '#fff');
  if (trail && trail.length > 1) {                // where you actually rode (shows detours)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = C.teal; ctx.setLineDash([]);
    ctx.beginPath();
    trail.forEach(([x, y], i) => { const [px, py] = toScreen(x, y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  }
  for (const m of team || []) {                   // team rides: their own colour, smaller
    const [tx, ty] = toScreen(...ref.xy(m.d));
    if (tx < -20 || ty < -20 || tx > ctx.w + 20 || ty > ctx.h + 20) continue;
    dot(ctx, tx, ty, view === 'all' ? 5 : 7, m.color);
  }
  if (ghost != null) {
    let [gx, gy] = toScreen(...ref.xy(ghost));
    if (view === 'follow') {          // out of view: wait at the edge, in its direction
      const m = 16, [cx, cy] = toScreen(...ref.xy(you ?? 0));
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
    } else if (view === 'follow') arrow(ctx, yx, yy, turned, 16);
  }
  if (me) drawMe(ctx, toScreen, me);
  if (view !== 'follow' || turned) {
    const [nx, ny] = toScreen(P.x[0], P.y[0]), [ux, uy] = toScreen(P.x[0], P.y[0] + 100);
    compass(ctx, Math.atan2(ux - nx, ny - uy));
  }
  if (view === 'locate') {                       // start flag
    const [fx, fy] = toScreen(P.x[0], P.y[0]);
    ctx.fillStyle = '#000'; ctx.fillRect(fx - 1, fy - 26, 3, 26);
    ctx.fillStyle = '#fff'; ctx.fillRect(fx + 2, fy - 26, 34, 14);
    ctx.fillStyle = '#000'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'left'; ctx.fillText('START', fx + 4, fy - 15);
  }
}

const FEET_PER_METER = 1 / 0.3048;

export function videoProfileBox(width, height) {
  const gutter = Math.min(42, Math.max(24, Math.round(width * 0.19)));
  return { L: gutter, R: width - gutter, T: 14, B: height - 27 };
}

export function averageWatts(power, seconds) {
  let start = 0, sum = 0;
  return power.map((watts, i) => {
    if (!Number.isFinite(watts)) { start = i + 1; sum = 0; return null; }
    sum += watts;
    if (i - start >= seconds) sum -= power[start++];
    return sum / (i - start + 1);
  });
}

export function typicalPowerPeak(power) {
  const watts = power.filter(Number.isFinite).sort((a, b) => a - b);
  // Keep extreme readings in the plots, while leaving them out of auto-ranging.
  return watts[Math.floor((watts.length - 1) * 0.98)] ?? 0;
}

function tickStep(span, divisions) {
  const target = span / divisions, magnitude = 10 ** Math.floor(Math.log10(target));
  const unit = target / magnitude;
  return magnitude * (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10);
}

// Whole-ride elevation and power share a route-distance axis.
export function drawElevationPlain(canvas, ref, { you, ghost, team, rider, reference, elevation, watts, distanceRange, fmtTime }) {
  const ctx = fit(canvas), { L, R, T, B } = videoProfileBox(ctx.w, ctx.h);
  if (!ref?.total || R <= L || B - T < 22) return null;
  const [start, end] = distanceRange, span = end - start;
  const X = d => L + (R - L) * (d - start) / span;
  const project = ([lo, hi]) => value => B - (B - T) * (value - lo) / (hi - lo);
  const altY = elevation ? project(elevation) : () => B;
  const wattsY = project([0, watts]);
  const mark = (value, y) => ({
    y: Math.max(T + 3, Math.min(B - 3, y(value))),
    edge: y(value) < T ? 'above' : y(value) > B ? 'below' : '',
  });
  const marks = {
    elevation: elevation ? { 100: mark(100, altY), 1000: mark(1000, altY) } : null,
    power: reference || rider.length ? { 100: mark(100, wattsY) } : null,
  };
  if (marks.elevation && marks.elevation[100].y - marks.elevation[1000].y < 17) {
    const center = (marks.elevation[100].y + marks.elevation[1000].y) / 2;
    const mid = Math.max(T + 11.5, Math.min(B - 11.5, center));
    marks.elevation[100].y = mid + 8.5;
    marks.elevation[1000].y = mid - 8.5;
  }
  function axis(range, y, x, rulerMarks, label, left) {
    const [lo, hi] = range, sign = left ? -1 : 1;
    ctx.font = '10px system-ui'; ctx.fillStyle = '#C9D1DC'; ctx.textAlign = left ? 'left' : 'right';
    ctx.fillText(label, left ? 1 : ctx.w - 1, 10);
    ctx.strokeStyle = '#818995'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
    ctx.font = '9px system-ui'; ctx.textAlign = left ? 'right' : 'left';
    const step = tickStep(hi - lo, Math.max(2, (B - T) / 22));
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-6; v += step) {
      const at = y(v);
      ctx.beginPath(); ctx.moveTo(x, at); ctx.lineTo(x + sign * 3, at); ctx.stroke();
      if (Object.values(rulerMarks).every(m => Math.abs(m.y - at) >= 10))
        ctx.fillText(Math.round(v), x + sign * 6, at + 3);
    }
  }
  if (elevation) axis(elevation, altY, L, marks.elevation, 'Elevation (ft)', true);
  if (marks.power) axis([0, watts], wattsY, R, marks.power, `Power (W) · 0–${Math.round(watts)}`, false);

  function firstSampleAt(distances, d) {
    let lo = 0, hi = distances.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (distances[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function visibleLine(distances, values, y) {
    const first = firstSampleAt(distances, start), last = firstSampleAt(distances, end);
    const step = Math.max(1, Math.floor((last - first) / (2 * (R - L))));
    ctx.lineTo(L, y(interp(distances, values, start)));
    for (let i = first; i < last; i += step) ctx.lineTo(X(distances[i]), y(values[i]));
    ctx.lineTo(R, y(interp(distances, values, end)));
  }

  ctx.save(); ctx.beginPath(); ctx.rect(L, T, R - L, B - T); ctx.clip();
  if (elevation) {
    ctx.beginPath(); ctx.moveTo(L, B);
    visibleLine(ref.d, ref.prof.a, meters => altY(meters * FEET_PER_METER));
    ctx.lineTo(R, B); ctx.closePath();
    ctx.fillStyle = 'rgba(200,205,215,0.5)'; ctx.fill();
    ctx.strokeStyle = 'rgba(235,240,248,0.95)'; ctx.lineWidth = 1.8; ctx.stroke();
  }
  if (reference) {
    ctx.save(); ctx.globalAlpha = 0.45;                 // the ghost's power sits behind the elevation
    ctx.strokeStyle = C.ghost; ctx.lineWidth = 1.5; ctx.beginPath();
    visibleLine(reference.distance, reference.power, wattsY);
    ctx.stroke(); ctx.restore();
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath();
  let connected = false, latest = null;
  for (const point of rider) {
    if (!point) { connected = false; continue; }
    const [d, power] = point;
    if (connected) ctx.lineTo(X(d), wattsY(power));
    else ctx.moveTo(X(d), wattsY(power));
    connected = true; latest = point;
  }
  ctx.stroke();
  if (latest) dot(ctx, X(latest[0]), wattsY(latest[1]), 2, '#fff');
  ctx.restore();

  const distanceDigits = span >= 4000 ? 1 : span >= 400 ? 2 : 3;
  const labelWidth = (R - L) / 4 - 3;
  ctx.strokeStyle = '#818995'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, B); ctx.lineTo(R, B);
  ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.fillStyle = '#E4E8EF';
  ctx.fillText('km', 1, B + 13);
  const firstTime = fmtTime(ref.elapsedAt(start));
  const timeUnitRoom = L - Math.min(labelWidth, ctx.measureText(firstTime).width) / 2 - 3;
  ctx.fillStyle = '#B7C2D0'; ctx.fillText(timeUnitRoom >= 26 ? 'Elapsed' : 'Time', 1, B + 24, timeUnitRoom);
  ctx.textAlign = 'center';
  for (let i = 0; i < 5; i++) {
    const d = start + span * i / 4, x = X(d);
    ctx.moveTo(x, B); ctx.lineTo(x, B + 4);
    if (labelWidth > 0) {
      ctx.fillStyle = '#E4E8EF'; ctx.fillText((d / 1000).toFixed(distanceDigits), x, B + 13, labelWidth);
      ctx.fillStyle = '#B7C2D0'; ctx.fillText(fmtTime(ref.elapsedAt(d)), x, B + 24, labelWidth);
    }
  }
  ctx.stroke();
  function riderPosition(d, radius, color) {
    if (d < start || d > end) return;
    const y = Math.max(T, Math.min(B, altY(ref.at('a', d) * FEET_PER_METER)));
    dot(ctx, X(d), y, radius, color);
  }
  for (const m of team) riderPosition(m.d, 5, m.color);
  if (ghost != null) riderPosition(ghost, 5, C.ghost);
  if (you != null) riderPosition(you, 3, '#fff');
  return { L, R, T, B, marks };
}

// Elevation profile with you and the ghost.
export function drawElevation(canvas, ref, you = null, ghost = null, team = []) {
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
  for (const m of team || []) { const d = Math.max(0, Math.min(ref.total, m.d)); dot(ctx, X(d), Y(ref.at('a', d)), 5, m.color); }
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

// Axes with a line at every multiple of xs / ys (labels thinned out when crowded).
function gridAxes(ctx, box, xr, xs, yr, ys, xlab, ylab) {
  const { L, R, T, B } = box;
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.muted; ctx.font = '12px system-ui';
  const nx = Math.floor((xr[1] - xr[0]) / xs + 1e-6), ny = Math.round((yr[1] - yr[0]) / ys);
  const xEvery = Math.max(1, Math.ceil(nx / Math.max(2, (R - L) / 45))), yEvery = Math.max(1, Math.ceil(ny / Math.max(2, (B - T) / 18)));
  for (let j = 0; j <= nx; j++) {
    const v = xr[0] + j * xs, x = L + (R - L) * j * xs / (xr[1] - xr[0]);
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
    if (j % xEvery === 0) { ctx.textAlign = 'center'; ctx.fillText(Math.round(v), x, B + 15); }
  }
  for (let j = 0; j <= ny; j++) {
    const v = yr[0] + j * ys, y = B - (B - T) * j / ny;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    if (j % yEvery === 0) { ctx.textAlign = 'right'; ctx.fillText(Math.round(v), L - 6, y + 4); }
  }
  ctx.textAlign = 'center'; ctx.fillText(xlab, (L + R) / 2, B + 31);
  ctx.save(); ctx.translate(13, (T + B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(ylab, 0, 0); ctx.restore();
}

const nice = (lo, hi, step) => [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];

// HR against rolling average power, with both series sharing the same axes.
export function drawScatter(canvas, power, hr, now, { avg = 10, comparison = null } = {}) {
  const ctx = fit(canvas);
  function points(power, hr, now) {
    const pts = [];
    let sum = 0;
    for (let i = 0; i < power.length && i <= now; i++) {
      if (!comparison) {
        sum += power[i] ?? 0;
        if (i >= avg) sum -= power[i - avg] ?? 0;
      }
      const watts = comparison ? power[i] : i >= avg - 1 ? sum / avg : null;
      if (hr[i] > 0 && Number.isFinite(watts)) pts.push([watts, hr[i], now - i]);
    }
    return pts;
  }
  const you = points(power, hr, now), ghost = comparison?.ghost;
  const theirs = ghost ? points(ghost.power, ghost.hr, ghost.now) : [];
  if (you.length + theirs.length < (comparison ? 1 : 5)) {
    return message(ctx, comparison ? 'Waiting for power and heart rate' : 'HR vs power appears once you ride');
  }
  let p1 = 100, h0 = 250, h1 = 0;
  for (const series of [you, theirs]) {
    for (const [p, h] of series) { p1 = Math.max(p1, p); h0 = Math.min(h0, h); h1 = Math.max(h1, h); }
  }
  const xr = comparison ? [0, comparison.maxWatts] : nice(0, p1 * 1.05, 50);
  const yr = nice(h0 - 3, h1 + 3, 20), xs = comparison ? tickStep(xr[1], 6) : 50;
  const box = { L: 46, R: ctx.w - 12, T: comparison ? 22 : 10, B: ctx.h - 38 };
  if (box.R <= box.L || box.B <= box.T) return;
  const powerLabel = comparison ? `Power, ${avg} s avg (0–${Math.round(xr[1])} W)` : `Power, ${avg}-s average (W)`;
  gridAxes(ctx, box, xr, xs, yr, 20, powerLabel, 'Heart rate (bpm)');
  const X = p => box.L + (box.R - box.L) * (p - xr[0]) / (xr[1] - xr[0]);
  const Y = h => box.B - (box.B - box.T) * (h - yr[0]) / (yr[1] - yr[0]);
  const paint = (series, color, radius) => {
    for (const [p, h, age] of series) {
      ctx.globalAlpha = comparison ? Math.max(0.17, Math.exp(-age / 165)) : 1;
      ctx.fillStyle = comparison ? color : age < 120 ? '#55D6C2' : age < 360 ? '#328D82' : '#20514F';
      ctx.beginPath(); ctx.arc(X(p), Y(h), age < 120 ? 3 : 2.2, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const latest = series[series.length - 1];
    if (latest && (!comparison || latest[2] === 0)) dot(ctx, X(latest[0]), Y(latest[1]), radius, color);
  };
  if (comparison) {
    ctx.save(); ctx.beginPath(); ctx.rect(box.L, box.T - 5, box.R - box.L + 4, box.B - box.T + 10); ctx.clip();
  }
  paint(theirs, C.ghost, 7);
  paint(you, comparison ? '#fff' : C.accent, comparison ? 4 : 6);
  if (comparison) ctx.restore();
  if (comparison) {
    ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillStyle = C.ghost; ctx.fillText('Ghost', box.L, 12);
    ctx.fillStyle = '#fff'; ctx.fillText('You', box.L + 42, 12);
  }
}

// Power and HR over time. Your lines are solid and the ghost's are dashed.
const VIDEO_TRACE_COLORS = { ghostPower: '#E8B8FF', ghostHr: '#B478E9', power: '#EFF1F4', hr: '#A2A9B4' };
export function drawTrace(canvas, S, { window = 600, maxWatts = null } = {}) {
  const ctx = fit(canvas);
  const n = S.power.length;
  if (n < 3) return message(ctx, 'Power and heart rate over time');
  const i0 = window ? Math.max(0, n - window) : 0, video = maxWatts != null;
  const span = Math.max(60, (video ? n - i0 : window || n) - 1);
  const colors = video ? VIDEO_TRACE_COLORS : { ghostPower: C.ghost, ghostHr: '#B07CC0', power: C.power, hr: C.hr };
  const margin = video ? 39 : 46;
  const box = { L: margin, R: ctx.w - margin, T: video ? 24 : 10, B: ctx.h - 24 };
  if (box.R <= box.L || box.B <= box.T) return;
  let pMax = 100, h0 = 250, h1 = 0;
  for (let i = i0; i < n; i++) {
    pMax = Math.max(pMax, S.power[i] ?? 0, S.refPower[i] ?? 0);
    for (const h of [S.hr[i], S.refHr[i]]) if (h > 0) { h0 = Math.min(h0, h); h1 = Math.max(h1, h); }
  }
  if (h1 === 0) { h0 = 60; h1 = 180; }
  const pr = video ? [0, maxWatts] : nice(0, pMax * 1.05, 50), hrR = nice(h0 - 3, h1 + 3, 10);
  const X = i => box.L + (box.R - box.L) * (i - i0) / span;
  const YP = p => box.B - (box.B - box.T) * p / pr[1];
  const YH = h => box.B - (box.B - box.T) * (h - hrR[0]) / (hrR[1] - hrR[0]);
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.font = '12px system-ui';
  for (let j = 0; j <= 4; j++) {
    const y = box.B - (box.B - box.T) * j / 4;
    ctx.beginPath(); ctx.moveTo(box.L, y); ctx.lineTo(box.R, y); ctx.stroke();
    ctx.fillStyle = colors.power; ctx.textAlign = 'right'; ctx.fillText(Math.round(pr[1] * j / 4), box.L - 6, y + 4);
    ctx.fillStyle = colors.hr; ctx.textAlign = 'left'; ctx.fillText(Math.round(hrR[0] + (hrR[1] - hrR[0]) * j / 4), box.R + 6, y + 4);
  }
  ctx.fillStyle = C.muted; ctx.textAlign = 'center';
  const timeLabel = video ? `last ${Math.ceil(span / 60)} min` : window ? `last ${Math.round(window / 60)} min` : 'whole ride';
  ctx.fillText(timeLabel, (box.L + box.R) / 2, ctx.h - 6);
  if (video) {
    const legend = [['Ghost W', colors.ghostPower], ['Ghost bpm', colors.ghostHr], ['You W', colors.power], ['You bpm', colors.hr]];
    ctx.font = '10px system-ui';
    legend.forEach(([label, color], i) => {
      ctx.fillStyle = color; ctx.fillText(label, ctx.w * (i + 0.5) / legend.length, 11);
    });
    ctx.save(); ctx.beginPath(); ctx.rect(box.L, box.T - 1, box.R - box.L, box.B - box.T + 2); ctx.clip();
  }
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
  line(S.refPower, YP, colors.ghostPower, 1.5, [6, 4]);
  line(S.refHr, YH, colors.ghostHr, 1.5, [2, 4]);
  line(S.power, YP, colors.power, 2);
  line(S.hr, YH, colors.hr, 2.5);
  if (video) ctx.restore();
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

// Riding without a reference: streets of the offline area around you, your
// track so far, heading-up. trail = [[x, y], ...] in the area's metres.
export function drawFreeMap(canvas, streets, { you = null, heading = 0, trail = [], span = 300, anchor = 0.7, labelZone = null, note = '' } = {}) {
  const ctx = fit(canvas);
  if (!you) return message(ctx, note || 'Waiting for GPS…');
  const s = (ctx.h * (anchor - 0.08)) / span, sx = ctx.w / 2, sy = ctx.h * anchor;
  const c = Math.cos(heading), sn = Math.sin(heading);
  const [toScreen, z, off, rot] = panned(canvas, ctx, (x, y) => { const dx = x - you[0], dy = y - you[1]; return [sx + s * (dx * c - dy * sn), sy - s * (dx * sn + dy * c)]; });
  if (streets) {
    ctx.labelZone = labelZone;
    drawStreets(ctx, streets, toScreen, s * z, { cx: you[0], cy: you[1], r: (Math.hypot(ctx.w, ctx.h) + 2 * off) / (s * z) });
    ctx.fillStyle = '#6B7685'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    ctx.fillText('© OpenStreetMap contributors', 6, ctx.h - 5);
  } else {
    ctx.fillStyle = C.muted; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(note || 'No offline map here — ☰ → Download map around me', ctx.w / 2, 22);
  }
  if (trail.length > 1) {                          // where you've been
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [w, col] of [[9, '#000'], [5, C.teal]]) {
      ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath();
      trail.forEach(([x, y], i) => { const [px, py] = toScreen(x, y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
    }
  }
  const [ax, ay] = toScreen(you[0], you[1]);
  arrow(ctx, ax, ay, rot, 16);
  if (rot) compass(ctx, rot - heading);
}

// A stretch ridden back and forth (refedit.findTurnBacks): the route around it,
// the part that would be cut in red.
export function drawTurnBack(canvas, P, tb) {
  const ctx = fit(canvas);
  const st = P.step || 5, pad = Math.round(250 / st);
  const a = Math.max(0, tb.i0 - pad), b = Math.min(P.d.length - 1, tb.i1 + pad);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = a; i <= b; i++) { x0 = Math.min(x0, P.x[i]); x1 = Math.max(x1, P.x[i]); y0 = Math.min(y0, P.y[i]); y1 = Math.max(y1, P.y[i]); }
  const s = Math.min((ctx.w - 30) / Math.max(1, x1 - x0), (ctx.h - 30) / Math.max(1, y1 - y0));
  const ox = (ctx.w - s * (x1 - x0)) / 2, oy = (ctx.h - s * (y1 - y0)) / 2;
  const T = (x, y) => [ox + s * (x - x0), ctx.h - oy - s * (y - y0)];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const line = (i0, i1, w, col) => { ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath(); for (let i = i0; i <= i1; i++) { const [px, py] = T(P.x[i], P.y[i]); i === i0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke(); };
  line(a, b, 5, '#8A94A3');
  line(tb.i0, tb.i1, 3, '#E8524A');
  const [ex, ey] = T(P.x[tb.i0], P.y[tb.i0]);
  dot(ctx, ex, ey, 5, '#FFFFFF');
}
