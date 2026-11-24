// Raw recording: every sensor value at the rate it arrives (oximeter waveform
// ~50 samples/s, every SpO2 reading, every heart beat with its RR interval,
// trainer and cadence packets, GPS fixes), whether you move or not and with
// or without Start. Kept on the device (IndexedDB, saved every 10 s) so a
// reload doesn't lose it; exported as one CSV, one row per value.

const COLS = ['pleth', 'beat', 'spo2', 'ox_pulse', 'pi', 'hr', 'rr_s', 'power', 'cadence', 'speed_kmh', 'lat', 'lon', 'gps_acc_m', 'alt_m'];

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ride-display-raw', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('raw');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class RawLog {
  constructor() { this.rec = null; this.on = false; this.waveDt = 0.02; this.lastWaveAt = 0; this.saveTimer = null; }

  start() {
    this.rec = { start: Date.now(), t: [], col: [], val: [] };   // parallel arrays: ms since start, column index, value
    this.on = true; this.lastWaveAt = 0;
    clearInterval(this.saveTimer);
    this.saveTimer = setInterval(() => this.save(), 10000);
    this.save();
  }
  stop() { this.on = false; clearInterval(this.saveTimer); this.save(); }

  // one sensor message: { hr: 72, rr_s: 0.83 } etc.
  add(fields, at = Date.now()) {
    if (!this.on) return;
    const t = at - this.rec.start;
    for (const [k, v] of Object.entries(fields)) {
      const c = COLS.indexOf(k);
      if (c >= 0 && v != null && Number.isFinite(+v)) { this.rec.t.push(t); this.rec.col.push(c); this.rec.val.push(+v); }
    }
  }
  // waveform samples arrive in small packets: spread them back in time at the measured sample rate
  wave(samples, beat, at = Date.now()) {
    if (!this.on || !samples.length) return;
    if (this.lastWaveAt) {
      const dt = (at - this.lastWaveAt) / 1000 / samples.length;
      if (dt > 0.002 && dt < 0.2) this.waveDt += (dt - this.waveDt) * 0.05;
    }
    this.lastWaveAt = at;
    const n = samples.length, t0 = at - this.rec.start;
    samples.forEach((v, i) => {
      const t = Math.max(0, Math.round(t0 - (n - 1 - i) * this.waveDt * 1000));
      this.rec.t.push(t); this.rec.col.push(0); this.rec.val.push(v);
      if (beat && i === n - 1) { this.rec.t.push(t); this.rec.col.push(1); this.rec.val.push(1); }
    });
  }

  get seconds() { return this.rec && this.rec.t.length ? this.rec.t[this.rec.t.length - 1] / 1000 : 0; }
  get count() { return this.rec ? this.rec.t.length : 0; }
  get waveRate() { return this.waveDt > 0 ? 1 / this.waveDt : 0; }

  async save() {
    if (!this.rec) return;
    try {
      const d = await db();
      await new Promise((res, rej) => { const tx = d.transaction('raw', 'readwrite'); tx.objectStore('raw').put({ ...this.rec, on: this.on }, 'last'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { /* storage unavailable: kept in memory */ }
  }
  // the last recording after a reload (carries on if it was still running)
  async restore() {
    try {
      const d = await db();
      const r = await new Promise(res => { const q = d.transaction('raw').objectStore('raw').get('last'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
      if (r && r.t) {
        this.rec = { start: r.start, t: r.t, col: r.col, val: r.val };
        if (r.on) { this.on = true; this.saveTimer = setInterval(() => this.save(), 10000); }
      }
    } catch (e) { /* */ }
    return this.rec;
  }

  // one row per moment; values that arrived at the same millisecond share a row
  csv() {
    const R = this.rec;
    if (!R || !R.t.length) return null;
    const order = R.t.map((_, i) => i).sort((a, b) => R.t[a] - R.t[b] || a - b);
    const lines = ['t_s,clock,' + COLS.join(',')];
    let row = null, rowT = null;
    const flush = () => { if (row) lines.push(`${(rowT / 1000).toFixed(3)},${new Date(R.start + rowT).toISOString()},${row.join(',')}`); };
    for (const i of order) {
      if (R.t[i] !== rowT || row[R.col[i]] !== '') { flush(); row = COLS.map(() => ''); rowT = R.t[i]; }
      row[R.col[i]] = R.val[i];
    }
    flush();
    return lines.join('\n') + '\n';
  }
}
