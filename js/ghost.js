// Outdoor ghost riding: GPS fixes snapped onto the reference route, so your
// distance is "how far along the original route you are" (steadier than GPS
// speed, and the same distance scale the ghost uses).

const M_PER_DEG_LAT = 110540.0;
const M_PER_DEG_LON = 111320.0;
const ON_ROUTE_M = 35;      // farther than this from the route = off route

export class RouteMatcher {
  constructor(ref) {
    this.ref = ref;
    const P = ref.prof;
    this.coslat = Math.cos(P.lat0 * Math.PI / 180);
    this.idx = null;           // last matched segment
    this.dist = 0;
    this.offRoute = false;
    this.last = null;
  }
  toXY(lat, lon) {
    const P = this.ref.prof;
    return [(lon - P.lon0) * this.coslat * M_PER_DEG_LON, (lat - P.lat0) * M_PER_DEG_LAT];
  }
  // Nearest point on segments i0..i1; returns {i, dist, off}.
  nearest(x, y, i0, i1) {
    const P = this.ref.prof;
    let best = null;
    for (let i = Math.max(0, i0); i < Math.min(this.ref.n - 1, i1); i++) {
      const ax = P.x[i], ay = P.y[i], bx = P.x[i + 1], by = P.y[i + 1];
      const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
      const f = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2)) : 0;
      const px = ax + f * vx, py = ay + f * vy;
      const off = Math.hypot(x - px, y - py);
      if (!best || off < best.off) best = { i, off, dist: P.d[i] + f * (P.d[i + 1] - P.d[i]) };
    }
    return best;
  }
  // Where are you along the route? Searches near the last match (so a route
  // that passes the same road twice is followed in order).
  update(fix) {
    const [x, y] = this.toXY(fix.lat, fix.lon);
    const n = this.ref.n, step = this.ref.prof.step;
    let m;
    if (this.idx === null) {
      // first fix: the earliest stretch of route you're on (a loop passes the start twice)
      m = null;
      for (let i = 0; i < n - 1 && !m; i += Math.ceil(200 / step)) {
        const c = this.nearest(x, y, i, i + Math.ceil(220 / step));
        if (c && c.off <= ON_ROUTE_M) m = c;
      }
      if (!m) m = this.nearest(x, y, 0, n);
    }
    else {
      m = this.nearest(x, y, this.idx - Math.ceil(100 / step), this.idx + Math.ceil(1500 / step));
      if (m.off > ON_ROUTE_M * 3) {   // lost: look everywhere ahead
        const far = this.nearest(x, y, this.idx, n);
        if (far.off < m.off) m = far;
      }
    }
    const moved = this.last ? Math.hypot(x - this.last[0], y - this.last[1]) : 0;
    this.last = [x, y];
    if (m.off <= ON_ROUTE_M + Math.min(30, fix.acc || 0)) {
      this.offRoute = false;
      this.idx = m.i;
      // small backwards jitter is ignored; real reversals over 30 m are kept
      if (m.dist > this.dist || this.dist - m.dist > 30) this.dist = m.dist;
    } else {
      // off the route: progress = the nearest point of the route ahead of
      // where you left it (a parallel street moves you on; on a loop that comes
      // back to where you left, it comes back with you, so the gap changes
      // smoothly instead of jumping when you rejoin)
      this.offRoute = true;
      const ahead = this.nearest(x, y, this.idx ?? 0, (this.idx ?? 0) + Math.ceil(1500 / step));
      if (ahead && ahead.off < 400) {
        const lim = Math.max(moved, 1);                      // follows you both ways, never faster than you move
        this.dist = Math.max(this.dist - lim, Math.min(this.dist + lim, ahead.dist));
      }
    }
    return this.dist;
  }
}

// Moving time with auto-pause, like the watch: runs while you move.
export class MovingClock {
  constructor() { this.seconds = 0; this.lastMove = -1e9; this.now = 0; }
  // call once per second with your speed (m/s)
  tick(speed, threshold = 1.0) {
    this.now += 1;
    if (speed >= threshold) this.lastMove = this.now;
    const moving = this.now - this.lastMove <= 3;
    if (moving) this.seconds += 1;
    return moving;
  }
}
