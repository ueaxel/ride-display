// Decoders for what ANT+ devices broadcast. Each device in range gets one decoder that keeps
// what it has seen so far; decode(payload) returns that device's current values.
//
// Two kinds of Garmin watch data arrive here:
//   1. The AntLive data field (Garmin repo, AntLive/): broadcasts everything the watch measures
//      during an activity. Works on any Connect IQ watch that allows ANT (FR265, Venu 3, fenix…).
//   2. "Broadcast Heart Rate" on any Garmin watch, no app needed: the standard ANT+ heart-rate profile.
// The other standard profiles (power, speed/cadence, trainers, foot pods, temperature) come for free.

// ------------------------------------------------------------ AntLive (our own format)
// Device type 0x42 and transmission type 0x05 on the ANT+ frequency, 4 messages a second.
// Every other message is page 1 (the fast values); the rest cycle through pages 2-8.
// Unknown values are sent as all-ones (0xFF, 0xFFFF, …). Same layout as AntLive/source/LivePages.mc.
export const ANTLIVE_TYPE = 0x42;
export const ANTLIVE_TRANS = 0x05;

const u16 = (p, i) => p[i] | p[i + 1] << 8;
const u24 = (p, i) => p[i] | p[i + 1] << 8 | p[i + 2] << 16;
const u32 = (p, i) => (p[i] | p[i + 1] << 8 | p[i + 2] << 16 | p[i + 3] << 24) >>> 0;
const s24 = (p, i) => u24(p, i) << 8 >> 8;
const or8 = (v, f = x => x) => v === 0xFF ? null : f(v);
const or16 = (v, f = x => x) => v === 0xFFFF ? null : f(v);
const or24 = (v, f = x => x) => v === 0xFFFFFF ? null : f(v);

// [label, unit, digits] for every value the page can show, in display order.
export const FIELDS = {
  hr: ['Heart rate', 'bpm', 0], power: ['Power', 'W', 0], cadence: ['Cadence', 'rpm', 0],
  speed: ['Speed', 'km/h', 1], distance: ['Distance', 'km', 2], timer: ['Timer', '', 0],
  timerState: ['Timer state', '', 0],
  altitude: ['Altitude', 'm', 0], ascent: ['Total ascent', 'm', 0], descent: ['Total descent', 'm', 0],
  heading: ['Heading', '°', 0], lat: ['Latitude', '°', 5], lon: ['Longitude', '°', 5],
  gpsAccuracy: ['GPS accuracy', '', 0], temperature: ['Temperature', '°C', 1], pressure: ['Ambient pressure', 'hPa', 1],
  calories: ['Calories', 'kcal', 0], energyRate: ['Energy expenditure', 'kcal/min', 1],
  trainingEffect: ['Aerobic training effect', '', 1], spo2: ['Pulse Ox', '%', 0],
  avgHr: ['Average HR', 'bpm', 0], maxHr: ['Max HR', 'bpm', 0], avgPower: ['Average power', 'W', 0],
  maxPower: ['Max power', 'W', 0], avgCadence: ['Average cadence', 'rpm', 0], maxCadence: ['Max cadence', 'rpm', 0],
  avgSpeed: ['Average speed', 'km/h', 1], maxSpeed: ['Max speed', 'km/h', 1],
  steps: ['Steps today', '', 0], battery: ['Watch battery', '%', 0],
  rr: ['Beat-to-beat (RR)', 'ms', 0], beats: ['Beat count', '', 0],
  operatingTime: ['Sensor operating time', 'h', 1], batteryVolts: ['Sensor battery', 'V', 2],
  balance: ['Pedal balance (right)', '%', 0], torqueEffL: ['Torque effectiveness L', '%', 0], torqueEffR: ['Torque effectiveness R', '%', 0],
  smoothL: ['Pedal smoothness L', '%', 0], smoothR: ['Pedal smoothness R', '%', 0],
  wheelRevs: ['Wheel revolutions', '', 0], crankRevs: ['Crank revolutions', '', 0],
  strides: ['Strides', '', 0], equipment: ['Equipment', '', 0], trainerStatus: ['Trainer status', '', 0],
  manufacturer: ['Manufacturer', '', 0], model: ['Model number', '', 0], hwVersion: ['Hardware version', '', 0],
  swVersion: ['Software version', '', 0], serial: ['Serial number', '', 0], appVersion: ['AntLive build', '', 0],
};

const TIMER_STATES = ['stopped', 'paused', 'running', 'running'];
const GPS_QUALITY = ['no GPS', 'last known', 'poor', 'usable', 'good'];

export function decodeAntLive(p, out = {}) {
  switch (p[0]) {
    case 1:
      out.hr = or8(p[1]); out.power = or16(u16(p, 2)); out.cadence = or8(p[4]);
      out.speed = or16(u16(p, 5), v => v / 100 * 3.6); out.seq = p[7]; break;
    case 2:
      out.distance = u32(p, 1) === 0xFFFFFFFF ? null : u32(p, 1) / 10000;
      out.timer = or24(u24(p, 5)); break;
    case 3:
      out.altitude = or16(u16(p, 1), v => v / 5 - 500); out.ascent = or16(u16(p, 3)); out.descent = or16(u16(p, 5));
      out.temperature = p[7] === 0x7F ? null : (p[7] << 24 >> 24); break;
    case 4: {
      const lat = s24(p, 1), lon = s24(p, 4);
      if (lat === -0x800000) { out.lat = out.lon = null; }
      else { out.lat = lat * 180 / 0x800000; out.lon = lon * 180 / 0x800000; }
      out.heading = or8(p[7], v => v * 360 / 256); break;
    }
    case 5:
      out.calories = or16(u16(p, 1)); out.avgHr = or8(p[3]); out.maxHr = or8(p[4]);
      out.avgPower = or16(u16(p, 5)); out.avgCadence = or8(p[7]); break;
    case 6:
      out.maxPower = or16(u16(p, 1)); out.maxSpeed = or16(u16(p, 3), v => v / 100 * 3.6);
      out.avgSpeed = or16(u16(p, 5), v => v / 100 * 3.6); out.maxCadence = or8(p[7]); break;
    case 7:
      out.trainingEffect = or8(p[1], v => v / 10); out.energyRate = or16(u16(p, 2), v => v / 100);
      out.pressure = or16(u16(p, 4), v => v * 2 / 100); out.spo2 = or8(p[6]);
      out.timerState = p[7] === 0xFF ? null : TIMER_STATES[p[7] & 0x0F] ?? null;
      out.gpsAccuracy = p[7] === 0xFF ? null : GPS_QUALITY[p[7] >> 4] ?? null; break;
    case 8:
      out.battery = or8(p[1]); out.steps = or24(u24(p, 2)); out.appVersion = or16(u16(p, 5), v => 'v' + v);
      break;
  }
  return out;
}

// The same layout, written (used by the demo watch and the tests; the watch does this in Monkey C).
export function encodeAntLive(page, v, seq = 0) {
  const b = Array(8).fill(0xFF); b[0] = page;
  const put16 = (i, x) => { if (x == null) return; x = Math.max(0, Math.min(0xFFFE, Math.round(x))); b[i] = x & 0xFF; b[i + 1] = x >> 8; };
  const put8 = (i, x) => { if (x == null) return; b[i] = Math.max(0, Math.min(0xFE, Math.round(x))); };
  const put24 = (i, x, signed = false) => { if (x == null) return; x = Math.round(x); if (!signed) x = Math.max(0, Math.min(0xFFFFFE, x)); b[i] = x & 0xFF; b[i + 1] = x >> 8 & 0xFF; b[i + 2] = x >> 16 & 0xFF; };
  switch (page) {
    case 1: put8(1, v.hr); put16(2, v.power); put8(4, v.cadence); put16(5, v.speed == null ? null : v.speed / 3.6 * 100); b[7] = seq & 0xFF; break;
    case 2: if (v.distance != null) { const d = Math.round(v.distance * 10000) >>> 0; b[1] = d & 0xFF; b[2] = d >> 8 & 0xFF; b[3] = d >> 16 & 0xFF; b[4] = d >>> 24; } put24(5, v.timer); break;
    case 3: put16(1, v.altitude == null ? null : (v.altitude + 500) * 5); put16(3, v.ascent); put16(5, v.descent); b[7] = v.temperature == null ? 0x7F : Math.round(v.temperature) & 0xFF; break;
    case 4:
      if (v.lat == null) { b[1] = 0; b[2] = 0; b[3] = 0x80; b[4] = 0; b[5] = 0; b[6] = 0x80; }
      else { put24(1, Math.max(-0x7FFFFF, Math.min(0x7FFFFF, v.lat / 180 * 0x800000)), true); put24(4, Math.max(-0x7FFFFF, Math.min(0x7FFFFF, v.lon / 180 * 0x800000)), true); }
      if (v.heading != null) b[7] = Math.round(((v.heading % 360) + 360) % 360 * 256 / 360) & 0xFF; break;
    case 5: put16(1, v.calories); put8(3, v.avgHr); put8(4, v.maxHr); put16(5, v.avgPower); put8(7, v.avgCadence); break;
    case 6: put16(1, v.maxPower); put16(3, v.maxSpeed == null ? null : v.maxSpeed / 3.6 * 100); put16(5, v.avgSpeed == null ? null : v.avgSpeed / 3.6 * 100); put8(7, v.maxCadence); break;
    case 7: put8(1, v.trainingEffect == null ? null : v.trainingEffect * 10); put16(2, v.energyRate == null ? null : v.energyRate * 100);
      put16(4, v.pressure == null ? null : v.pressure * 100 / 2); put8(6, v.spo2);
      b[7] = (v.gpsQuality ?? 0) << 4 | (v.timerStateCode ?? 0); break;
    case 8: put8(1, v.battery); put24(2, v.steps); put16(5, v.build); break;
  }
  return b;
}

// ------------------------------------------------------------ ANT+ common pages (any device)

const MANUFACTURERS = { 1: 'Garmin', 2: 'Garmin (Dynastream OEM)', 7: 'SRM', 9: 'Saris', 13: 'Wahoo', 15: 'Dynastream', 16: 'Timex', 23: 'Suunto', 32: 'Wahoo', 48: 'Pioneer', 52: 'Tacx', 63: 'Stages', 69: 'Stages', 86: 'Elite', 89: 'Tacx', 95: 'Stryd', 255: 'development' };

function commonPage(p, out) {
  const n = p[0] & 0x7F;
  if (n === 0x50) { out.hwVersion = p[3]; out.manufacturer = MANUFACTURERS[u16(p, 4)] ?? `#${u16(p, 4)}`; out.model = u16(p, 6); return true; }
  if (n === 0x51) { out.swVersion = p[2] === 0xFF ? `${p[3]}` : `${p[3]}.${p[2]}`; out.serial = u32(p, 4) === 0xFFFFFFFF ? null : u32(p, 4); return true; }
  if (n === 0x52) {
    const frac = p[6] / 256, coarse = p[7] & 0x0F;
    if (coarse !== 0x0F) out.batteryVolts = coarse + frac;
    return true;
  }
  return false;
}

// ------------------------------------------------------------ standard profiles

// counter that wraps at `mod`; returns the increase since the last call
function delta(state, key, value, mod) {
  const last = state[key]; state[key] = value;
  if (last == null) return null;
  return (value - last + mod) % mod;
}

function heartRate(p, out, st) {
  const page = p[0] & 0x7F;
  if (page === 1) out.operatingTime = u24(p, 1) * 2 / 3600;
  if (page === 2) { out.manufacturer ??= MANUFACTURERS[p[1]] ?? `#${p[1]}`; out.serial = u16(p, 2); }
  if (page === 3) { out.hwVersion = p[1]; out.swVersion = p[2]; out.model = p[3]; }
  if (page === 4) {
    const prev = u16(p, 2), now = u16(p, 4);
    out.rr = Math.round(((now - prev + 0x10000) % 0x10000) / 1024 * 1000);
  }
  const beats = p[6], time = u16(p, 4);
  const dn = delta(st, 'beats', beats, 256);
  const dt = delta(st, 'beatTime', time, 0x10000);
  if (dn === 1 && dt) out.rr = Math.round(dt / 1024 * 1000);
  out.hr = p[7] || null; out.beats = beats;
}

function bikePower(p, out, st) {
  const page = p[0];
  if (page === 0x10) {
    out.power = u16(p, 6); out.cadence = p[3] === 0xFF ? null : p[3];
    out.balance = p[2] === 0xFF || !(p[2] & 0x80) ? null : p[2] & 0x7F;
  } else if (page === 0x12) {                     // crank torque: cadence from crank revolutions
    const dRev = delta(st, 'crankRev', p[1], 256), dT = delta(st, 'crankPer', u16(p, 4), 0x10000);
    if (dRev && dT) out.cadence = Math.round(60 * dRev / (dT / 2048));
    out.crankRevs = (st.crankTotal = (st.crankTotal ?? 0) + (dRev ?? 0));
  } else if (page === 0x13) {
    const pct = v => v === 0xFF ? null : v / 2;
    out.torqueEffL = pct(p[2]); out.torqueEffR = pct(p[3]); out.smoothL = pct(p[4]); out.smoothR = pct(p[5]);
  }
}

function speedCadence(type) {
  return (p, out, st, opts) => {
    const page = p[0] & 0x7F;
    if (type !== 121) {
      if (page === 1) out.operatingTime = u24(p, 1) * 2 / 3600;
      if (page === 2) { out.manufacturer ??= MANUFACTURERS[p[1]] ?? `#${p[1]}`; out.serial = u16(p, 2); }
      if (page === 3) { out.hwVersion = p[1]; out.swVersion = p[2]; out.model = p[3]; }
    }
    const pairs = type === 121 ? [['cad', 0, 2], ['spd', 4, 6]] : [[type === 122 ? 'cad' : 'spd', 4, 6]];
    for (const [k, ti, ri] of pairs) {
      const dT = delta(st, k + 'T', u16(p, ti), 0x10000), dR = delta(st, k + 'R', u16(p, ri), 0x10000);
      if (dT == null) continue;
      if (dT === 0) { if (performance.now() - (st[k + 'Seen'] ?? 0) > 3000) { if (k === 'cad') out.cadence = 0; else out.speed = 0; } continue; }
      st[k + 'Seen'] = performance.now();
      if (k === 'cad') { out.cadence = Math.round(60 * dR / (dT / 1024)); out.crankRevs = u16(p, ri); }
      else { out.speed = dR * (opts.wheel ?? 2.096) / (dT / 1024) * 3.6; out.wheelRevs = u16(p, ri); out.distance = (st.dist = (st.dist ?? 0) + dR * (opts.wheel ?? 2.096) / 1000); }
    }
  };
}

const EQUIPMENT = { 19: 'treadmill', 20: 'elliptical', 22: 'rower', 23: 'climber', 24: 'Nordic skier', 25: 'trainer / stationary bike' };
function fitnessEquipment(p, out, st) {
  if (p[0] === 0x10) {
    out.equipment = EQUIPMENT[p[1] & 0x1F] ?? `type ${p[1] & 0x1F}`;
    const dt = delta(st, 'fecT', p[2], 256); out.timer = (st.fecTime = (st.fecTime ?? 0) + (dt ?? 0) / 4);
    const dd = delta(st, 'fecD', p[3], 256); out.distance = (st.fecDist = (st.fecDist ?? 0) + (dd ?? 0)) / 1000;
    out.speed = u16(p, 4) / 1000 * 3.6;
    if (p[6] !== 0xFF && p[6] !== 0) out.hr = p[6];
  } else if (p[0] === 0x19) {
    out.cadence = p[2] === 0xFF ? null : p[2];
    out.power = u16(p, 5) & 0x0FFF;
    out.trainerStatus = ['', 'bicycle power calibration required', 'resistance calibration required', 'user configuration required'][p[6] >> 4 & 3] || 'ok';
  }
}

function strideSdm(p, out) {
  if (p[0] === 1) {
    out.distance = (p[3] + (p[4] >> 4) / 16) / 1000;   // rolls over every 256 m; shown as-is
    out.speed = ((p[4] & 0x0F) + p[5] / 256) * 3.6;
    out.strides = p[6];
  } else if (p[0] === 2) {
    out.cadence = p[3] + (p[4] >> 4) / 16;
    out.speed = ((p[4] & 0x0F) + p[5] / 256) * 3.6;
  }
}

function temperature(p, out) {
  if (p[0] === 1) {
    const t = (u16(p, 6) << 16 >> 16);
    if (t !== -0x8000) out.temperature = t / 100;
  }
}

// device type → [name, decoder]
export const PROFILES = {
  [ANTLIVE_TYPE]: ['Garmin watch (AntLive)', (p, out) => decodeAntLive(p, out)],
  120: ['Heart rate', heartRate],
  11: ['Bike power', bikePower],
  121: ['Speed & cadence', speedCadence(121)],
  122: ['Cadence sensor', speedCadence(122)],
  123: ['Speed sensor', speedCadence(123)],
  17: ['Trainer / fitness equipment', fitnessEquipment],
  124: ['Foot pod (stride)', strideSdm],
  25: ['Temperature', temperature],
};

// One device heard by the stick. `key` identifies it: type + device number.
export class DeviceDecoder {
  constructor({ deviceType, deviceNumber, transType }, opts = {}) {
    this.type = deviceType; this.number = deviceNumber; this.transType = transType;
    this.key = `${deviceType}:${deviceNumber}`;
    const prof = PROFILES[deviceType];
    this.profile = prof ? prof[0] : `ANT+ device type ${deviceType}`;
    this.fn = prof ? prof[1] : null;
    this.values = {}; this.state = {}; this.opts = opts; this.count = 0; this.pages = new Set();
  }
  decode(payload) {
    this.count++; this.lastSeen = Date.now(); this.lastPayload = payload;
    this.pages.add(payload[0] & 0x7F);
    if (this.fn && !(this.type !== ANTLIVE_TYPE && commonPage(payload, this.values))) this.fn(payload, this.values, this.state, this.opts);
    return this.values;
  }
}

export function formatValue(key, v) {
  if (v == null) return '–';
  if (typeof v === 'string') return v;
  if (key === 'timer') {
    const s = Math.floor(v), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s % 60).padStart(2, '0');
  }
  const f = FIELDS[key];
  return typeof v === 'number' ? v.toFixed(f ? f[2] : 0) : String(v);
}
