// Where clips meet. Two clips "share the road" where their routes run within
// a few metres in the same direction. While you ride one clip, every other
// clip sharing your road is a possible turn: we look ahead to where it leaves
// your route (the junction) and offer it before you get there. Taking it
// switches to that clip at the same spot, so the video doesn't jump.

const M_PER_DEG_LAT = 110540.0;
const M_PER_DEG_LON = 111320.0;
const NEAR = 20;          // m: same road
const APART = 35;         // m: the routes have split
const LOOK = 600;         // m: look this far ahead for a junction
const OFFER = 350;        // m: show the choice this far before it

// Route points of every clip in one shared metre grid.
export class ClipNet {
  constructor(clips) {
    this.clips = clips;
    const o = clips.find(c => c.prof.x);
    this.lat = o ? o.prof.lat0 : 0; this.lon = o ? o.prof.lon0 : 0;
    const cos = Math.cos(this.lat * Math.PI / 180);
    this.g = clips.map(c => {
      const P = c.prof;
      if (!P.x) return null;
      const dx = (P.lon0 - this.lon) * cos * M_PER_DEG_LON, dy = (P.lat0 - this.lat) * M_PER_DEG_LAT;
      return { x: Float64Array.from(P.x, v => v + dx), y: Float64Array.from(P.y, v => v + dy), d: P.d, step: P.step };
    });
  }
  pointAt(k, dist) {
    const g = this.g[k], i = Math.max(0, Math.min(g.d.length - 2, Math.floor(dist / g.step)));
    const f = Math.max(0, Math.min(1, (dist - g.d[i]) / Math.max(1e-6, g.d[i + 1] - g.d[i])));
    return [g.x[i] + f * (g.x[i + 1] - g.x[i]), g.y[i] + f * (g.y[i + 1] - g.y[i])];
  }
  heading(k, dist) {
    const [ax, ay] = this.pointAt(k, Math.max(0, dist - 12)), [bx, by] = this.pointAt(k, dist + 12);
    return Math.atan2(bx - ax, by - ay);
  }
  // nearest spot of clip k to (x, y), searching indices i0..i1
  nearest(k, x, y, i0 = 0, i1 = Infinity) {
    const g = this.g[k];
    let best = null;
    for (let i = Math.max(0, i0); i < Math.min(g.d.length - 1, i1); i++) {
      const ax = g.x[i], ay = g.y[i], vx = g.x[i + 1] - ax, vy = g.y[i + 1] - ay, L2 = vx * vx + vy * vy;
      const f = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2)) : 0;
      const off = Math.hypot(x - ax - f * vx, y - ay - f * vy);
      if (!best || off < best.off) best = { off, dist: g.d[i] + f * (g.d[i + 1] - g.d[i]), i };
    }
    return best;
  }
  // Clips that share the road with clip k at distance d (same direction).
  sharing(k, d) {
    if (!this.g[k]) return [];
    const [x, y] = this.pointAt(k, d), h = this.heading(k, d);
    const out = [];
    this.g.forEach((g, j) => {
      if (j === k || !g) return;
      const m = this.nearest(j, x, y);
      if (!m || m.off > NEAR) return;
      if (Math.abs(angle(this.heading(j, m.dist) - h)) > Math.PI / 4) return;
      out.push({ clip: j, dist: m.dist });
    });
    return out;
  }
  // Junctions ahead: for each sharing clip, where it leaves clip k (or where
  // clip k ends while it goes on). Returns [{clip, at, dist, turn}], nearest first.
  ahead(k, d) {
    const total = this.clips[k].ref.total;
    const out = [];
    for (const s of this.sharing(k, d)) {
      const gj = this.g[s.clip], totalJ = this.clips[s.clip].ref.total;
      let dj = s.dist, split = null, close = { a: d, dj };
      for (let a = d + 10; a <= d + LOOK; a += 10) {
        if (a >= total) { if (dj + 20 < totalJ) split = { at: total, dj, end: true }; break; }
        const [x, y] = this.pointAt(k, a);
        const i = Math.floor(dj / gj.step);
        const m = this.nearest(s.clip, x, y, i - 5, i + 40);
        if (!m || m.off > APART) { split = { at: close.a, dj: close.dj }; break; }   // the junction: last spot still together
        if (m.off < 10) close = { a, dj: m.dist };
        dj = Math.max(dj, m.dist);
        if (dj + 10 >= totalJ) break;                    // the other clip ends first: nothing to offer
      }
      if (!split) continue;
      // turn direction: where the other clip goes 60 m after the split, seen from clip k
      const hk = this.heading(k, Math.min(split.at, total - 1));
      const [px, py] = this.pointAt(k, Math.min(split.at, total - 1));
      const [qx, qy] = this.pointAt(s.clip, Math.min(totalJ, split.dj + 60));
      const rel = angle(Math.atan2(qx - px, qy - py) - hk);
      const turn = split.end ? 'continue' : Math.abs(rel) < 0.35 ? 'straight' : rel < 0 ? 'left' : 'right';
      out.push({ clip: s.clip, at: split.at, inM: split.at - d, turn, dist: s.dist + (0), end: !!split.end });
    }
    // one entry per clip; nearest first
    return out.filter(o => o.inM <= OFFER).sort((a, b) => a.inM - b.inM);
  }
  // Where on clip j you are when you are at distance d on clip k.
  transfer(k, d, j) {
    const [x, y] = this.pointAt(k, d);
    const m = this.nearest(j, x, y);
    return m && m.off <= APART ? m.dist : null;
  }
}

const angle = a => Math.atan2(Math.sin(a), Math.cos(a));
