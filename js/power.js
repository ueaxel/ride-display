// Power on a bike without a power meter, from how the bike moves (once a second):
//   P = ( m g (grade + Crr) v  +  ½ ρ CdA v³  +  m_eff a v ) / drivetrain
// Grade comes from the reference route when you're on it, otherwise from GPS
// altitude (noisy: smoothed over ~100 m). Wind is unknown: a headwind shows
// as too little power, a tailwind as too much.

const G = 9.81, RHO = 1.2, DRIVETRAIN = 0.97;

export class OutdoorPower {
  constructor(rider) {
    this.mass = rider.riderKg + (rider.extraKg ?? 1) + rider.bikeKg;
    this.massEff = this.mass + 1;                 // spinning wheels
    this.cda = rider.cda; this.crr = rider.crr;
    this.v = null; this.alts = []; this.last3 = [];
  }
  // speed m/s, odo m, alt m (or null), grade fraction (or null: use altitude).
  // Each second: energy into air, rolling, climbing, plus the change in
  // kinetic energy. Averaged over 3 s before negative values (braking,
  // freewheeling) are cut to 0, so GPS speed noise cancels out.
  update(speed, odo, alt, grade = null) {
    const v0 = this.v ?? 0;
    const v = this.v == null ? Math.max(0, speed || 0) : this.v * 0.4 + Math.max(0, speed || 0) * 0.6;
    this.v = v;
    if (alt != null) {
      this.alts.push([odo, alt]);
      while (this.alts.length > 2 && odo - this.alts[0][0] > 120) this.alts.shift();
    }
    if (grade == null) grade = this.altGrade();
    grade = Math.max(-0.2, Math.min(0.2, grade));
    const th = Math.atan(grade), vm = (v + v0) / 2;
    const raw = (this.mass * G * (Math.sin(th) + this.crr * Math.cos(th)) * vm + 0.5 * RHO * this.cda * vm ** 3
      + this.massEff * (v * v - v0 * v0) / 2) / DRIVETRAIN;
    this.last3.push(raw); if (this.last3.length > 3) this.last3.shift();
    return this.p3;
  }
  // 3-s average power, W (0 when coasting)
  get p3() { return this.last3.length ? Math.min(2000, Math.max(0, this.last3.reduce((s, x) => s + x, 0) / this.last3.length)) : null; }
  // slope of altitude over distance (least squares) for the last ~100 m
  altGrade() {
    const A = this.alts;
    if (A.length < 5 || A[A.length - 1][0] - A[0][0] < 40) return 0;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of A) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const n = A.length, den = n * sxx - sx * sx;
    return den > 0 ? (n * sxy - sx * sy) / den : 0;
  }
}
