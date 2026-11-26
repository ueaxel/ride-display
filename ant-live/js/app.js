// ANT Live: shows, in real time, everything the Garmin watches and ANT+ sensors near the Mac broadcast.
import { AntScanner, UsbStick, SerialStick, usbAvailable, serialAvailable } from './ant.js';
import { DeviceDecoder, FIELDS, formatValue, encodeAntLive, ANTLIVE_TYPE, ANTLIVE_TRANS } from './profiles.js';

export const APP_VERSION = '1 · 261126_1000';

const $ = id => document.getElementById(id);
const devices = new Map();          // key → { dec, el, hist }
const BIG = ['hr', 'power', 'cadence', 'speed', 'distance', 'timer'];
const HIST_S = 300;                 // seconds of HR / power kept for the little chart
let scanner = null, rawOn = false, rawLines = [], rec = null, demoTimer = null;

$('version').textContent = 'v' + APP_VERSION;

function banner(text) { $('banner').textContent = text || ''; $('banner').classList.toggle('show', !!text); }
function status(state, text) { $('chip').dataset.state = state; $('chip').textContent = { connected: text || 'stick connected', connecting: 'connecting…', lost: 'stick lost', off: 'no stick' }[state] || state; if (state === 'lost' && text) banner(text); }

if (!usbAvailable() && !serialAvailable()) banner('This browser cannot reach USB devices. Open the page in Chrome (or Edge) on the Mac.');
else if (!window.isSecureContext) banner('USB needs a secure page: open it from https://ueaxel.github.io/ride-display/ant-live/ or http://localhost.');
if (!usbAvailable()) $('btnUsb').disabled = true;
if (!serialAvailable()) $('btnSerial').disabled = true;

// ------------------------------------------------------------ connecting

async function start(getStick) {
  banner('');
  try {
    await stopScanner();
    const stick = await getStick();
    scanner = new AntScanner({ onData, onStatus: status, onEvent: e => logRaw('event: ' + e) });
    await scanner.start(stick);
    $('btnUsb').textContent = 'Reconnect';
  } catch (e) {
    status('off');
    if (e.name === 'NotFoundError') return;          // user closed the chooser
    banner(explain(e));
    console.error(e);
  }
}
function explain(e) {
  const m = String(e.message || e);
  if (/Unable to claim|in use|Access denied|Failed to open/i.test(m))
    return 'Another program is using the ANT stick. Quit Garmin Express, Zwift, GoldenCheetah, TrainerRoad and other Chrome tabs that use it, then press Connect again. (' + m + ')';
  return 'Could not start the ANT stick: ' + m;
}
async function stopScanner() { if (scanner) { const s = scanner; scanner = null; await s.stop(); } }

$('btnUsb').onclick = () => start(() => UsbStick.request());
$('btnSerial').onclick = () => start(() => SerialStick.request());
navigator.usb?.addEventListener('disconnect', e => { if (scanner?.stick?.device === e.device) { scanner = null; status('lost', 'The ANT stick was unplugged. Plug it back in and press Connect ANT stick.'); } });
navigator.usb?.addEventListener('connect', async () => { if (!scanner) { const s = await UsbStick.remembered(); if (s) start(() => s); } });
// A stick the page was allowed to use before connects without asking.
UsbStick.remembered().then(s => { if (s) start(() => s); });

// ------------------------------------------------------------ data

function onData(d) {
  if (d.deviceType == null) return;      // stick without extended messages: nothing to sort by
  const key = `${d.deviceType}:${d.deviceNumber}`;
  let dev = devices.get(key);
  if (!dev) {
    const dec = new DeviceDecoder(d, { wheel: Number($('wheel').value) / 1000 || 2.096 });
    dev = { dec, hist: [], el: makeCard(dec) };
    devices.set(key, dev);
    $('empty')?.remove();
    sortCards();
  }
  dev.rssi = d.rssi;
  dev.rate = (dev.rate ?? 0) * 0.9 + 0.1;
  const v = dev.dec.decode(d.payload);
  const now = Date.now() / 1000;
  const last = dev.hist[dev.hist.length - 1];
  if (!last || now - last.t >= 1) {
    dev.hist.push({ t: now, hr: v.hr ?? null, power: v.power ?? null });
    while (dev.hist.length && now - dev.hist[0].t > HIST_S) dev.hist.shift();
    if (rec) record(dev, now);
  }
  logRaw(`${new Date().toLocaleTimeString('en-GB', { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')}  type ${String(d.deviceType).padStart(3)}  #${String(d.deviceNumber).padEnd(6)} tx ${d.transType?.toString(16).padStart(2, '0')}  ${d.payload.map(b => b.toString(16).padStart(2, '0')).join(' ')}${d.rssi != null ? `  ${d.rssi} dBm` : ''}`);
}

function makeCard(dec) {
  const el = document.createElement('section');
  el.className = 'card';
  el.innerHTML = `<h3><span class="name"></span><span class="sub"></span></h3><div class="big"></div><canvas width="800" height="180"></canvas><table></table>`;
  el.querySelector('.name').textContent = dec.profile;
  if (dec.type !== ANTLIVE_TYPE && dec.type !== 120) el.querySelector('canvas').style.display = 'none';
  $('devices').appendChild(el);
  return el;
}
// watches first, then heart rate, then everything else
function rank(dec) { return dec.type === ANTLIVE_TYPE ? 0 : dec.type === 120 ? 1 : 2; }
function sortCards() {
  [...devices.values()].sort((a, b) => rank(a.dec) - rank(b.dec) || a.dec.number - b.dec.number).forEach(d => $('devices').appendChild(d.el));
}

function render() {
  const now = Date.now();
  for (const dev of devices.values()) {
    const { dec, el } = dev;
    const age = (now - dec.lastSeen) / 1000;
    el.classList.toggle('stale', age > 5);
    el.querySelector('.sub').textContent = `#${dec.number}` + (dev.rssi != null ? ` · ${dev.rssi} dBm` : '') + (age > 5 ? ` · last heard ${Math.round(age)} s ago` : '');
    const v = dec.values;
    const big = BIG.filter(k => v[k] !== undefined);
    el.querySelector('.big').innerHTML = big.map(k => `<div><div class="label">${FIELDS[k][0]}</div><span class="v">${formatValue(k, v[k])}</span><span class="u">${FIELDS[k][1]}</span></div>`).join('');
    const rows = Object.keys(FIELDS).filter(k => !BIG.includes(k) && v[k] !== undefined);
    el.querySelector('table').innerHTML = rows.map(k => `<tr><td>${FIELDS[k][0]}</td><td>${formatValue(k, v[k])} <span class="muted">${FIELDS[k][1]}</span></td></tr>`).join('')
      + `<tr><td class="muted">ANT messages</td><td class="muted">${dec.count}</td></tr>`;
    drawHistory(el.querySelector('canvas'), dev.hist);
  }
  requestAnimationFrame(() => setTimeout(render, 250));
}
render();

function drawHistory(cv, hist) {
  if (cv.style.display === 'none') return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (hist.length < 2) return;
  const t1 = hist[hist.length - 1].t, x = t => W - (t1 - t) / HIST_S * W;
  const line = (key, lo, hi, color) => {
    const pts = hist.filter(h => h[key] != null);
    if (pts.length < 2) return;
    g.strokeStyle = color; g.lineWidth = 3; g.beginPath();
    pts.forEach((h, i) => { const y = H - 8 - (h[key] - lo) / (hi - lo) * (H - 16); i ? g.lineTo(x(h.t), y) : g.moveTo(x(h.t), y); });
    g.stroke();
    g.fillStyle = color; g.font = '22px system-ui'; g.fillText(`${key === 'hr' ? 'HR' : 'W'} ${Math.round(Math.min(...pts.map(p => p[key])))}–${Math.round(Math.max(...pts.map(p => p[key])))}`, key === 'hr' ? 8 : W / 2, 26);
  };
  const css = getComputedStyle(document.documentElement);
  const span = (k, a, b) => { const v = hist.map(h => h[k]).filter(x => x != null); return v.length ? [Math.min(a, ...v) - 5, Math.max(b, ...v) + 5] : [a, b]; };
  line('hr', ...span('hr', 60, 160), css.getPropertyValue('--hr'));
  line('power', ...span('power', 0, 250), css.getPropertyValue('--pw'));
}

// ------------------------------------------------------------ raw log and recording

function logRaw(line) {
  if (!rawOn) return;
  rawLines.push(line); if (rawLines.length > 200) rawLines.shift();
  $('raw').textContent = rawLines.slice().reverse().join('\n');
}
$('btnRaw').onclick = () => { rawOn = !rawOn; $('raw').classList.toggle('show', rawOn); $('btnRaw').classList.toggle('on', rawOn); if (!rawOn) rawLines = []; };

const REC_KEYS = Object.keys(FIELDS);
function record(dev, t) { rec.push([new Date(t * 1000).toISOString(), dev.dec.profile, dev.dec.number, ...REC_KEYS.map(k => dev.dec.values[k] ?? '')]); }
$('btnRec').onclick = () => {
  if (!rec) { rec = []; $('btnRec').textContent = 'Stop & save CSV'; $('btnRec').classList.add('on'); return; }
  const esc = x => /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x;
  const csv = [['time', 'device', 'number', ...REC_KEYS].join(','), ...rec.map(r => r.map(esc).join(','))].join('\n');
  const stamp = new Date().toLocaleString('sv').replace(/[-:]/g, '').replace(' ', '_').slice(2, 13);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `ANT_Live_${stamp}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
  rec = null; $('btnRec').textContent = 'Record CSV'; $('btnRec').classList.remove('on');
};

$('wheel').onchange = () => { for (const d of devices.values()) d.dec.opts.wheel = Number($('wheel').value) / 1000 || 2.096; };

// ------------------------------------------------------------ demo: a fake AntLive watch, a broadcasting watch and a power meter

$('btnDemo').onclick = () => {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; $('btnDemo').classList.remove('on'); return; }
  $('btnDemo').classList.add('on');
  let seq = 0, slow = 2, t = 0, dist = 0, beat = 0, beatTime = 0, evt = 0, acc = 0;
  demoTimer = setInterval(() => {
    t += 0.25;
    const power = 180 + 60 * Math.sin(t / 20), hr = 125 + 15 * Math.sin((t - 8) / 20), speed = 28 + 4 * Math.sin(t / 25);
    dist += speed / 3.6 * 0.25 / 1000;
    const v = { hr, power, cadence: 88, speed, distance: dist, timer: t, altitude: 112 + t / 30, ascent: t / 30, descent: 0, temperature: 24,
      lat: 37.7 + dist / 111, lon: -121.9, heading: 10, calories: t / 4, avgHr: 125, maxHr: 140, avgPower: 180, avgCadence: 87,
      maxPower: 240, maxSpeed: 32, avgSpeed: 28, maxCadence: 95, trainingEffect: 1.2, energyRate: 12.5, pressure: 1012.4, spo2: 97,
      gpsQuality: 4, timerStateCode: 2, battery: 81, steps: 5321, build: 1 };
    const page = seq % 2 === 0 ? 1 : slow;
    if (seq % 2) slow = slow === 8 ? 2 : slow + 1;
    onData({ deviceType: ANTLIVE_TYPE, deviceNumber: 4265, transType: ANTLIVE_TRANS, rssi: -48, payload: encodeAntLive(page, v, seq++) });
    beat = (beat + 1) & 0xFF; beatTime = (beatTime + Math.round(60 / hr * 1024)) & 0xFFFF;
    onData({ deviceType: 120, deviceNumber: 31415, transType: 1, rssi: -55, payload: [4, 0x80, 0, 0, beatTime & 0xFF, beatTime >> 8, beat, Math.round(hr)] });
    evt = (evt + 1) & 0xFF; acc = (acc + Math.round(power)) & 0xFFFF;
    onData({ deviceType: 11, deviceNumber: 1201, transType: 5, rssi: -61, payload: [0x10, evt, 0xB2, 88, acc & 0xFF, acc >> 8, Math.round(power) & 0xFF, Math.round(power) >> 8] });
  }, 250);
};
