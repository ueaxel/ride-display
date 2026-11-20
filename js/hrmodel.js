// Heart-rate response to power steps, measured live.
// Every clear step in power (>= 40 W, held for a minute) gets a fit of
//   HR(s) = H0                               for s <= delay
//   HR(s) = H0 + A * (1 - exp(-(s - delay)/tau))   after it
// over the 2 minutes after the step: a first-order response with a dead time,
// the simple version of the delay / response times in de Leeuw et al. 2025.
// Drops in power also give the 60-s heart-rate recovery (HRR60).

const MIN_JUMP = 40;      // W
const PRE = 30, POST = 60, FIT_AFTER = 120, FIT_BEFORE = 15, GAP = 60;
const TAUS = Array.from({ length: 40 }, (_, i) => 4 * Math.pow(45, i / 39));   // 4..180 s

const mean = (a, i, j) => { let s = 0, n = 0; for (let k = i; k < j; k++) if (a[k] != null) { s += a[k]; n++; } return n ? s / n : null; };
const sd = (a, i, j, m) => { let s = 0, n = 0; for (let k = i; k < j; k++) if (a[k] != null) { s += (a[k] - m) ** 2; n++; } return n ? Math.sqrt(s / n) : 0; };
const jump = (p, c) => { const a = mean(p, c, c + 5), b = mean(p, c - 5, c); return a == null || b == null ? 0 : a - b; };

// Best delay/tau fit of hr[c-FIT_BEFORE .. end) around step time c.
export function fitStep(hr, c, end) {
  const ts = [], ys = [];
  for (let k = Math.max(0, c - FIT_BEFORE); k < end; k++) if (hr[k] != null && hr[k] > 0) { ts.push(k - c); ys.push(hr[k]); }
  if (ys.length < 60) return null;
  const n = ys.length, ym = ys.reduce((a, b) => a + b, 0) / n;
  const sst = ys.reduce((a, y) => a + (y - ym) ** 2, 0) || 1;
  let best = null;
  for (let delay = 0; delay <= 25; delay++) {
    for (const tau of TAUS) {
      // least squares for H0, A with basis b = 1 - exp(-(s-delay)/tau), s > delay
      let sb = 0, sbb = 0, sy = 0, sby = 0;
      for (let i = 0; i < n; i++) {
        const s = ts[i], b = s > delay ? 1 - Math.exp(-(s - delay) / tau) : 0;
        sb += b; sbb += b * b; sy += ys[i]; sby += b * ys[i];
      }
      const det = n * sbb - sb * sb;
      if (Math.abs(det) < 1e-9) continue;
      const A = (n * sby - sb * sy) / det, H0 = (sy - A * sb) / n;
      let sse = 0;
      for (let i = 0; i < n; i++) {
        const s = ts[i], b = s > delay ? 1 - Math.exp(-(s - delay) / tau) : 0;
        sse += (ys[i] - H0 - A * b) ** 2;
      }
      if (!best || sse < best.sse) best = { delay, tau, A, H0, sse };
    }
  }
  best.r2 = 1 - best.sse / sst;
  best.rmse = Math.sqrt(best.sse / n);
  return best;
}

export const model = (f, s) => f.H0 + (s > f.delay ? f.A * (1 - Math.exp(-(s - f.delay) / f.tau)) : 0);

// Incremental step finder over 1-Hz arrays (index = moving second).
export class StepFinder {
  constructor() { this.steps = []; this.scanned = PRE; }
  reset() { this.steps = []; this.scanned = PRE; }
  update(power, hr) {
    const n = power.length;
    const newOnes = [];
    for (let c = this.scanned; c + FIT_AFTER <= n; c++) {
      this.scanned = c + 1;
      const j = jump(power, c);
      if (Math.abs(j) < MIN_JUMP) continue;
      let isPeak = true;                     // sharpest point of the change
      for (let k = c - 10; k <= c + 10 && isPeak; k++) if (k !== c && Math.abs(jump(power, k)) > Math.abs(j)) isPeak = false;
      if (!isPeak) continue;
      const last = this.steps[this.steps.length - 1];
      if (last && c - last.t < GAP) continue;
      const pre = mean(power, c - PRE, c), post = mean(power, c + 5, c + 5 + POST);
      if (pre == null || post == null) continue;
      const dP = post - pre;
      if (Math.abs(dP) < MIN_JUMP) continue;
      const steady = Math.max(15, 0.3 * Math.abs(dP));
      if (sd(power, c - PRE, c, pre) > steady || sd(power, c + 5, c + 5 + POST, post) > steady) continue;
      const fit = fitStep(hr, c, c + FIT_AFTER);
      if (!fit) continue;
      const h0 = mean(hr, c - 3, c + 2), h60 = mean(hr, c + 58, c + 63);
      const step = {
        t: c, up: dP > 0, pre, post, dP, ...fit,
        gain: fit.A / dP,                                   // bpm per W
        hrr60: dP < 0 && h0 != null && h60 != null ? h0 - h60 : null,
      };
      this.steps.push(step);
      newOnes.push(step);
    }
    return newOnes;
  }
  // Medians of the good fits (R² >= 0.8, the paper's quality gate).
  summary() {
    const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const good = this.steps.filter(s => s.r2 >= 0.8);
    const up = good.filter(s => s.up), down = good.filter(s => !s.up);
    return {
      n: this.steps.length, good: good.length,
      upDelay: med(up.map(s => s.delay)), upTau: med(up.map(s => s.tau)),
      downDelay: med(down.map(s => s.delay)), downTau: med(down.map(s => s.tau)),
      hrr60: med(this.steps.filter(s => s.hrr60 != null).map(s => s.hrr60)),
      gain: med(good.map(s => s.gain)),
    };
  }
}
