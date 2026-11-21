// Live data: Bluetooth heart-rate strap, Bluetooth smart trainer (FTMS or
// Cycling Power), phone GPS, and a demo mode that fakes all of them.
// Web Bluetooth needs Chrome (Android, Mac, Windows) and an https page.

export const bluetoothAvailable = () => !!(navigator.bluetooth && window.isSecureContext);

// Keeps a Bluetooth device connected: reconnects after drop-outs.
class BleLink {
  constructor(label, onStatus) {
    this.label = label; this.onStatus = onStatus; this.device = null; this.wanted = false;
  }
  status(s) { this.state = s; this.onStatus?.(s); }
  async open(options, setup) {
    this.device = await navigator.bluetooth.requestDevice(options);
    this.setup = setup;
    this.wanted = true;
    this.device.addEventListener('gattserverdisconnected', () => this.reconnect());
    await this.connect();
  }
  // Android often fails the first GATT connection ("GATT operation failed for
  // unknown reason"); a short pause and a fresh try usually works.
  async connect(tries = 4) {
    this.status('connecting');
    let err;
    for (let i = 0; i < tries; i++) {
      try {
        const server = await this.device.gatt.connect();
        await this.setup(server);
        this.status('connected');
        return;
      } catch (e) {
        err = e;
        try { this.device.gatt.disconnect(); } catch (e2) { /* */ }
        await new Promise(r => setTimeout(r, 800 + 700 * i));
      }
    }
    throw err;
  }
  async reconnect() {
    if (!this.wanted) return;
    this.status('reconnecting');
    for (let i = 0; i < 20 && this.wanted; i++) {
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** i, 8000)));
      try { await this.connect(); return; } catch (e) { /* try again */ }
    }
    this.status('lost');
  }
  close() { this.wanted = false; try { this.device?.gatt.disconnect(); } catch (e) { /* */ } this.status('off'); }
  get name() { return this.device?.name || this.label; }
}

// ------------------------------------------------------------ heart rate

export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  const hr = flags & 1 ? dv.getUint16(1, true) : dv.getUint8(1);
  let p = flags & 1 ? 3 : 2;
  if (flags & 0x08) p += 2;                      // energy expended
  const rr = [];
  if (flags & 0x10) for (; p + 1 < dv.byteLength; p += 2) rr.push(dv.getUint16(p, true) / 1024);
  // bit 2 = strap reports skin contact, bit 1 = contact detected
  const contact = flags & 0x04 ? !!(flags & 0x02) : null;
  return { hr, rr, contact };
}

export async function connectHeartRate(onData, onStatus, showAll = false) {
  const link = new BleLink('HR strap', onStatus);
  await link.open(showAll ? { acceptAllDevices: true, optionalServices: ['heart_rate'] }
    : { filters: [{ services: ['heart_rate'] }, { namePrefix: 'HRM' }], optionalServices: ['heart_rate'] }, async server => {
    const ch = await (await server.getPrimaryService('heart_rate')).getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', e => onData(parseHeartRate(e.target.value)));
    await ch.startNotifications();
  });
  return link;
}

// ------------------------------------------------------------ trainer

// FTMS Indoor Bike Data (0x2AD2). Returns speed km/h, cadence rpm, power W, hr.
export function parseIndoorBikeData(dv) {
  const f = dv.getUint16(0, true);
  let p = 2;
  const out = {};
  if (!(f & 0x0001)) { out.speed = dv.getUint16(p, true) / 100; p += 2; }
  if (f & 0x0002) p += 2;                                   // average speed
  if (f & 0x0004) { out.cadence = dv.getUint16(p, true) / 2; p += 2; }
  if (f & 0x0008) p += 2;                                   // average cadence
  if (f & 0x0010) p += 3;                                   // total distance
  if (f & 0x0020) p += 2;                                   // resistance level
  if (f & 0x0040) { out.power = dv.getInt16(p, true); p += 2; }
  if (f & 0x0080) p += 2;                                   // average power
  if (f & 0x0100) p += 5;                                   // energy
  if (f & 0x0200) { out.hr = dv.getUint8(p); p += 1; }
  return out;
}

// Cycling Power Measurement (0x2A63): power, and cadence from crank revolutions.
export function makeCyclingPowerParser() {
  let lastRevs = null, lastTime = null, lastChange = 0;
  return dv => {
    const f = dv.getUint16(0, true);
    const out = { power: dv.getInt16(2, true) };
    let p = 4;
    if (f & 0x01) p += 1;          // pedal power balance
    if (f & 0x04) p += 2;          // accumulated torque
    if (f & 0x10) p += 6;          // wheel revolutions
    if (f & 0x20) {
      const revs = dv.getUint16(p, true), time = dv.getUint16(p + 2, true);
      const now = Date.now();
      if (lastRevs !== null) {
        const dr = (revs - lastRevs + 65536) % 65536, dt = ((time - lastTime + 65536) % 65536) / 1024;
        if (dr > 0 && dt > 0) { out.cadence = 60 * dr / dt; lastChange = now; }
        else if (now - lastChange > 3000) out.cadence = 0;
      }
      lastRevs = revs; lastTime = time;
    }
    return out;
  };
}

// Listens to the trainer only (no control): the watch keeps control over ANT+.
// Some trainers don't announce their services, so also match by name, or
// (showAll) list every Bluetooth device nearby.
export async function connectTrainer(onData, onStatus, showAll = false) {
  const link = new BleLink('Trainer', onStatus);
  const optionalServices = ['fitness_machine', 'cycling_power'];
  await link.open(showAll ? { acceptAllDevices: true, optionalServices } : {
    filters: [{ services: ['fitness_machine'] }, { services: ['cycling_power'] },
      ...['CYCPLUS', 'Cycplus', 'cycplus', 'R200', 'CP-', 'Smart'].map(namePrefix => ({ namePrefix }))],
    optionalServices,
  }, async server => {
    try {
      const svc = await server.getPrimaryService('fitness_machine');
      const ch = await svc.getCharacteristic(0x2AD2);
      ch.addEventListener('characteristicvaluechanged', e => onData(parseIndoorBikeData(e.target.value)));
      await ch.startNotifications();
      link.protocol = 'FTMS';
      try {                                   // control point: lets the tablet set resistance
        const cp = await svc.getCharacteristic(0x2AD9);
        if (!link.control) link.control = new FtmsControl();
        await link.control.attach(cp);
      } catch (e) { link.control = null; }
    } catch (e) {
      const parse = makeCyclingPowerParser();
      const svc = await server.getPrimaryService('cycling_power');
      const ch = await svc.getCharacteristic('cycling_power_measurement');
      ch.addEventListener('characteristicvaluechanged', e2 => onData(parse(e2.target.value)));
      await ch.startNotifications();
      link.protocol = 'Cycling Power';
    }
  });
  return link;
}

// ------------------------------------------------------------ trainer control (FTMS)

// FTMS Fitness Machine Control Point (0x2AD9). Each command is answered with
// an indication [0x80, opcode, result]; result 1 = success.
export const FTMS_RESULT = { 1: 'ok', 2: 'not supported', 3: 'invalid value', 4: 'failed', 5: 'not allowed (another device has control)' };

export function powerCommand(watts) {
  const w = Math.max(0, Math.min(2000, Math.round(watts)));
  return [0x05, w & 0xFF, (w >> 8) & 0xFF];
}
// grade as a fraction (0.05 = 5 %); crr and cw (= 0.5 * rho * CdA, kg/m)
export function simCommand(grade, crr = 0.0055, cw = 0.2) {
  const g = Math.max(-2000, Math.min(2000, Math.round(grade * 10000)));   // 0.01 %
  const gg = g < 0 ? g + 65536 : g;
  return [0x11, 0, 0, gg & 0xFF, (gg >> 8) & 0xFF, Math.round(crr * 10000) & 0xFF, Math.round(cw * 100) & 0xFF];
}

export class FtmsControl {
  constructor() { this.cp = null; this.hasControl = false; this.queue = Promise.resolve(); this.waiting = null; this.message = ''; this.last = null; }
  async attach(cp) {
    this.cp = cp; this.hasControl = false;
    cp.addEventListener('characteristicvaluechanged', e => {
      const v = e.target.value;
      if (v.getUint8(0) === 0x80 && this.waiting) { const w = this.waiting; this.waiting = null; w(v.getUint8(2)); }
    });
    await cp.startNotifications();       // indications
  }
  // send one command and wait (max 3 s) for its answer
  send(bytes) {
    const run = async () => {
      if (!this.cp) throw new Error('no control point');
      const answer = new Promise(res => { this.waiting = res; setTimeout(() => { if (this.waiting === res) { this.waiting = null; res(0); } }, 3000); });
      await this.cp.writeValueWithResponse(new Uint8Array(bytes));
      return answer;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  async ensureControl() {
    if (this.hasControl) return true;
    const r = await this.send([0x00]);                 // Request Control
    this.hasControl = r === 1;
    this.message = r === 1 ? 'tablet controls the trainer' : `control refused: ${FTMS_RESULT[r] || 'no answer'}`;
    if (this.hasControl) await this.send([0x07]);      // Start / Resume
    return this.hasControl;
  }
  async apply(kind, value) {
    try {
      if (!(await this.ensureControl())) return false;
      const r = await this.send(kind === 'power' ? powerCommand(value) : simCommand(value));
      if (r === 5) this.hasControl = false;
      this.last = { kind, value, ok: r === 1, at: Date.now() };
      this.message = r === 1 ? (kind === 'power' ? `ERG ${Math.round(value)} W` : `grade ${(value * 100).toFixed(1)} %`) : `trainer: ${FTMS_RESULT[r] || 'no answer'}`;
      return r === 1;
    } catch (e) { this.hasControl = false; this.message = 'trainer: ' + e.message; return false; }
  }
}

// ------------------------------------------------------------ GPS

export function startGps(onFix, onError) {
  if (!navigator.geolocation) { onError?.('No GPS in this browser.'); return null; }
  const id = navigator.geolocation.watchPosition(
    pos => onFix({
      lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, alt: pos.coords.altitude,
      speed: pos.coords.speed, heading: pos.coords.heading, time: pos.timestamp,
    }),
    err => { if (err.code !== 3) onError?.(err.message); },   // 3 = timeout: no new position while standing still
    { enableHighAccuracy: true, maximumAge: 0 });
  return { close: () => navigator.geolocation.clearWatch(id) };
}

// ------------------------------------------------------------ screen on

export function keepScreenOn() {
  let lock = null;
  const get = async () => {
    try { if (navigator.wakeLock && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); }
    catch (e) { /* not allowed here */ }
  };
  document.addEventListener('visibilitychange', get);
  get();
  return () => lock;
}

// ------------------------------------------------------------ demo

// Fake rider: power steps (like an ERG workout) and a heart rate that follows
// with a delay and a first-order lag plus slow drift, so every panel has
// something to show. next() gives one second of data.
export class DemoRider {
  constructor() { this.t = 0; this.hr = 95; this.hist = []; }
  next() {
    const plan = [[0, 120], [180, 200], [360, 150], [480, 260], [600, 140], [780, 230], [960, 120]];
    const t = ++this.t, cyc = t % 1140;
    let target = 120;
    for (const [s, w] of plan) if (cyc >= s) target = w;
    const power = Math.max(0, Math.round(target + 6 * Math.sin(t / 3) + (Math.random() - 0.5) * 12));
    this.hist.push(power);
    const h = this.hist, lagged = h.length > 6 ? h[h.length - 7] : power;     // ~6 s delay
    const steady = 62 + 0.42 * lagged + 0.004 * t;                          // slow drift
    this.hr += (steady - this.hr) / (steady > this.hr ? 25 : 40);
    return { power, cadence: Math.round(86 + 4 * Math.sin(t / 17)),
      hr: Math.round(this.hr + (Math.random() - 0.5) * 1.5) };
  }
}
