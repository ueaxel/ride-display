// Ride Display: one page, two screens.
//   #trainer - tablet beside the indoor trainer (HR strap + trainer over Bluetooth)
//   #ghost   - phone on the handlebar, chasing the reference ride (GPS + HR strap)
import { Reference, IndoorRide, RIDER, profileFromFit } from './reference.js';
import { bluetoothAvailable, connectHeartRate, connectTrainer, startGps, keepScreenOn, DemoRider } from './sensors.js';
import { StepFinder } from './hrmodel.js';
import { RouteMatcher, MovingClock } from './ghost.js';
import * as D from './draw.js';
import { downloadStreets, saveStreets, loadStreets, deleteStreets } from './streets.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, dflt = null) { try { const v = localStorage.getItem(k); return v === null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

// ------------------------------------------------------------------ state

let mode = location.hash === '#ghost' ? 'ghost' : location.hash === '#trainer' ? 'trainer'
  : (store.get('mode') || (Math.min(screen.width, screen.height) >= 700 ? 'trainer' : 'ghost'));
const rider = { ...RIDER, riderKg: store.get('riderKg', RIDER.riderKg) };
let refs = store.get('refs', []);                // [{name, prof}]
let ref = null;
let streets = null;                              // OSM streets along the reference route
let streetsNote = '';
const live = { power: null, cadence: null, speed: null, hr: null, tPower: 0, tHr: 0, fix: null, tFix: 0 };
const links = {};
let S, running, clock, indoor, matcher, offset, finished, steps, demo = null, demoGps = null;
let quiet = false;           // tests: skip drawing while fast-forwarding
let mapView = 'all', avgWin = 10, traceWin = 600, ghostSpan = 250, lastFix = null;

function newRide() {
  S = { power: [], hr: [], cad: [], speed: [], dist: [], refDist: [], gapM: [], gapS: [], refPower: [], refHr: [],
    lat: [], lon: [], wall: [] };
  running = false; clock = new MovingClock(); indoor = new IndoorRide(rider);
  matcher = ref && ref.hasRoute ? new RouteMatcher(ref) : null;
  offset = 0; finished = null; steps = new StepFinder(); lastFix = null;
  render();
}

function setMode(m) {
  mode = m; document.body.dataset.mode = m; store.set('mode', m);
  history.replaceState(null, '', '#' + m);
  render();
}

function selectRef(i) {
  const r = refs[i];
  ref = r ? new Reference(r.prof) : null;
  store.set('refIndex', i);
  $('refName').textContent = ref ? ref.name : 'No reference';
  streets = null; streetsNote = '';
  if (ref) loadStreets(ref.name).then(st => {
    if (ref && r && ref.name === r.name) { streets = st; streetsNote = st ? `Streets: ${st.ways.length} saved on this device.` : 'Streets: not downloaded yet.'; showRefInfo(); render(); }
  });
  matcher = ref && ref.hasRoute ? new RouteMatcher(ref) : null;
  if (matcher && S && S.dist.length) matcher.dist = S.dist[S.dist.length - 1];
  showRefInfo();
  render();
}

// ------------------------------------------------------------------ helpers

const fmtTime = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; };
const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(Math.round(v));
const gapClass = m => Math.abs(m) <= 25 ? 'good' : Math.abs(m) <= 70 ? 'warn' : 'bad';
const last = a => a.length ? a[a.length - 1] : null;
const avgLast = (a, n) => { let s = 0, k = 0; for (let i = Math.max(0, a.length - n); i < a.length; i++) if (a[i] != null) { s += a[i]; k++; } return k ? s / k : null; };

function banner(text) { const b = $('banner'); b.textContent = text || ''; b.classList.toggle('show', !!text); }

function round(arr, dec) { const f = 10 ** dec; return arr.map(v => Math.round(v * f) / f); }
function compact(prof) {
  const out = { ...prof };
  for (const [k, dec] of [['d', 1], ['t', 1], ['v', 1], ['hr', 0], ['p', 0], ['x', 1], ['y', 1], ['a', 1]]) if (out[k]) out[k] = round(out[k], dec);
  return out;
}

// ------------------------------------------------------------------ the 1-s loop

function tick() {
  const now = Date.now();
  if (demo) {
    const s = demo.next();
    Object.assign(live, { power: s.power, cadence: s.cadence, hr: s.hr, tPower: now, tHr: now });
  }
  if (demoGps) { live.fix = demoGps.next(); live.tFix = now; }
  const power = now - live.tPower < 3000 ? live.power ?? 0 : 0;
  const cadence = now - live.tPower < 3000 ? live.cadence ?? 0 : 0;
  const hr = now - live.tHr < 5000 ? live.hr : null;
  if (!running || finished) { render(); return; }

  let moving, dist, speed, fix = null;
  if (mode === 'trainer') {
    moving = clock.tick(power > 0 || cadence > 0 ? 9 : 0);
    if (moving) indoor.step(power, 1, ref ? ref.gradeFraction(indoor.dist) : 0);
    dist = indoor.dist; speed = indoor.speed;
  } else {
    fix = now - live.tFix < 5000 ? live.fix : null;
    const prev = last(S.dist) ?? 0;
    if (fix && matcher) dist = matcher.update(fix);
    else if (fix && lastFix) dist = prev + haversine(lastFix, fix);
    else dist = prev;
    if (fix) lastFix = fix;
    speed = fix && fix.speed != null && fix.speed >= 0 ? fix.speed : Math.max(0, dist - prev);
    moving = clock.tick(speed);
  }
  if (!moving) { render(); return; }

  S.power.push(mode === 'trainer' ? power : null);
  S.cad.push(cadence); S.hr.push(hr); S.speed.push(speed); S.dist.push(dist); S.wall.push(now);
  S.lat.push(fix ? fix.lat : null); S.lon.push(fix ? fix.lon : null);
  const t = clock.seconds;
  if (ref) {
    const refSec = t - offset;
    const rd = Math.min(ref.total, ref.distAtTime(refSec));
    S.refDist.push(rd);
    S.gapM.push(dist - rd);
    S.gapS.push(ref.timeAt(Math.min(dist, ref.total)) - refSec);   // + = ahead
    S.refPower.push(ref.hasPower ? ref.at('p', Math.min(dist, ref.total)) : null);
    S.refHr.push(ref.at('hr', Math.min(dist, ref.total)) || null);
    if (dist >= ref.total) finished = { gapS: ref.totalTime - refSec };
  } else {
    for (const k of ['refDist', 'gapM', 'gapS', 'refPower', 'refHr']) S[k].push(null);
  }
  if (mode === 'trainer') steps.update(S.power, S.hr);
  render();
}

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ------------------------------------------------------------------ render

function render() {
  if (!S || quiet) return;
  const t = clock.seconds;
  const you = ref ? Math.min(last(S.dist) ?? 0, ref.total) : null;
  const ghost = ref && running ? Math.min(ref.total, ref.distAtTime(t - offset)) : (ref ? 0 : null);
  const gapM = last(S.gapM), gapS = finished ? finished.gapS : last(S.gapS);
  const hr = Date.now() - live.tHr < 5000 ? live.hr : null;
  const startBtns = [$('btnStart'), $('gStart')];
  for (const b of startBtns) {
    b.textContent = finished ? 'Finished' : running ? 'Stop' : (S.dist.length ? 'Resume' : 'Start');
    b.classList.toggle('stop', running && !finished);
    b.classList.toggle('primary', !running && !finished);
  }
  if (mode === 'trainer') renderTrainer(t, you, ghost, gapM, gapS, hr);
  else renderGhost(t, you, ghost, gapM, gapS, hr);
}

function renderTrainer(t, you, ghost, gapM, gapS, hr) {
  const p3 = avgLast(S.power, 3);
  const fresh = Date.now() - live.tPower < 3000;
  $('tPower').textContent = running && p3 != null ? Math.round(p3) : fresh ? Math.round(live.power ?? 0) : '–';
  $('tHr').textContent = hr ?? '–';
  $('tCad').textContent = fresh && live.cadence != null ? Math.round(live.cadence) : '–';
  $('tSpeed').textContent = S.speed.length ? (last(S.speed) * 3.6).toFixed(1) : '–';
  $('tTime').textContent = fmtTime(t);
  $('tState').textContent = !running ? (t ? 'stopped' : 'press Start') : finished ? 'reference distance reached' : clock.now - clock.lastMove > 3 ? 'paused' : 'riding';
  $('tDist').textContent = ((last(S.dist) ?? 0) / 1000).toFixed(2);
  const rp = last(S.refPower), rh = last(S.refHr);
  $('tPowerRef').textContent = ref && ref.hasPower && rp != null ? `ghost ${Math.round(rp)} W${ref.prof.powerEstimated ? ' (est.)' : ''}` : '';
  $('tHrRef').textContent = rh ? `ghost ${Math.round(rh)} bpm` : '';
  $('tSpeedRef').textContent = ref && you != null ? `ghost ${ref.at('v', you).toFixed(1)} km/h` : 'km/h on the route';
  $('tDistRef').textContent = ref ? `of ${(ref.total / 1000).toFixed(2)} km` : 'km';
  const g = $('tGap');
  if (ref && finished) {
    g.innerHTML = `${sign(gapS)}<span class="unit">s</span>`; g.className = 'v ' + (gapS >= 0 ? 'good' : 'bad');
    $('tGapS').textContent = `final: ${gapS >= 0 ? 'faster' : 'slower'} than the original`;
  } else if (ref && gapM != null) {
    g.innerHTML = `${sign(gapM)}<span class="unit">m</span>`; g.className = 'v ' + gapClass(gapM);
    $('tGapS').textContent = `${sign(gapS)} s ${gapS >= 0 ? 'ahead' : 'behind'}`;
  } else { g.textContent = '–'; g.className = 'v'; $('tGapS').textContent = ref ? '' : 'no reference'; }

  D.drawRoute($('map'), ref, { you, ghost, view: mapView, span: 400, done: you ?? 0, streets });
  D.drawElevation($('elev'), ref, you, ghost);
  D.drawScatter($('scatter'), S.power, S.hr, S.power.length - 1, { avg: avgWin });
  D.drawTrace($('trace'), S, { window: traceWin });
  const st = steps.steps, sum = steps.summary();
  D.drawStepFit($('stepfit'), S, st[st.length - 1]);
  const pair = (a, b, u) => a == null && b == null ? '–' : `${a == null ? '–' : Math.round(a)} / ${b == null ? '–' : Math.round(b)} ${u}`;
  $('sDelay').textContent = pair(sum.upDelay, sum.downDelay, 's');
  $('sTau').textContent = pair(sum.upTau, sum.downTau, 's');
  $('sHrr').textContent = sum.hrr60 == null ? '–' : `${Math.round(sum.hrr60)} bpm`;
  $('sCount').textContent = `${sum.n} step${sum.n === 1 ? '' : 's'}, ${sum.good} with R² ≥ 0.8 · medians · first-order fit with delay`;
}

function renderGhost(t, you, ghost, gapM, gapS, hr) {
  const g = $('gGap');
  if (ref && finished) {
    g.innerHTML = `${sign(gapS)}<span class="unit">s</span>`; g.className = 'gapbig ' + (gapS >= 0 ? 'good' : 'bad');
    $('gGapS').textContent = `finished ${gapS >= 0 ? 'ahead of' : 'behind'} the original`;
  } else if (ref && gapM != null) {
    g.innerHTML = `${sign(gapM)}<span class="unit">m</span>`; g.className = 'gapbig ' + gapClass(gapM);
    $('gGapS').textContent = `${sign(gapS)} s ${gapS >= 0 ? 'ahead' : 'behind'}`;
  } else {
    g.textContent = '–'; g.className = 'gapbig';
    $('gGapS').textContent = !ref ? 'load a reference ride' : running ? 'waiting for you to move' : 'press Start at the start of the route';
  }
  D.drawGapGauge($('gauge'), ref ? gapM : null);
  $('gHr').textContent = hr ?? '–';
  const rh = last(S.refHr);
  $('gHrRef').textContent = rh ? `ghost ${Math.round(rh)}` + (hr ? ` (${sign(hr - rh)})` : '') : '';
  const sp = last(S.speed);
  $('gSpeed').textContent = sp != null && running ? (sp * 3.6).toFixed(1) : '–';
  $('gSpeedRef').textContent = ref && you != null ? `ghost ${ref.at('v', you).toFixed(1)}` + (ref.hasPower ? ` · ${Math.round(ref.at('p', you))} W` : '') : '';
  $('gTime').textContent = fmtTime(t);
  $('gDist').textContent = `${((last(S.dist) ?? 0) / 1000).toFixed(2)} km`;
  $('gLeft').textContent = ref ? `${(Math.max(0, ref.total - (you ?? 0)) / 1000).toFixed(2)} km to go` : '';
  $('gOff').style.display = matcher && matcher.offRoute ? 'block' : 'none';
  D.drawRoute($('gmap'), ref, { you: you ?? 0, ghost, view: 'follow', span: ghostSpan, done: you ?? 0, streets });
}

// ------------------------------------------------------------------ actions

function toggleStart() {
  if (finished) return;
  running = !running;
  render();
}

function resync() {
  if (!ref || !running) return;
  const dist = Math.min(last(S.dist) ?? 0, ref.total);
  offset = clock.seconds - ref.timeAt(dist);
  if (S.gapM.length) { S.gapM[S.gapM.length - 1] = 0; S.gapS[S.gapS.length - 1] = 0; }
  navigator.vibrate?.(150);
  render();
}

async function bt(key, connect, btn, onData) {
  if (!bluetoothAvailable()) { banner('Bluetooth needs Chrome and an https:// address (Android, Mac or Windows; not iPhone).'); return; }
  if (links[key]) { links[key].close(); links[key] = null; btn.dataset.state = 'off'; return; }
  try {
    links[key] = await connect(onData, s => { btn.dataset.state = s; });
    btn.title = links[key].name + (links[key].protocol ? ` (${links[key].protocol})` : '');
  } catch (e) {
    btn.dataset.state = 'off';
    if (e.name !== 'NotFoundError') banner(`${btn.textContent}: ${e.message}`);
  }
}

function toggleGps() {
  const btn = $('btnGps');
  if (links.gps) { links.gps.close(); links.gps = null; btn.dataset.state = 'off'; btn.textContent = 'GPS'; return; }
  btn.dataset.state = 'connecting';
  links.gps = startGps(fix => {
    live.fix = fix; live.tFix = Date.now();
    btn.dataset.state = fix.acc <= 25 ? 'connected' : 'connecting';
    btn.textContent = `GPS ±${Math.round(fix.acc)} m`;
  }, err => { btn.dataset.state = 'lost'; banner('GPS: ' + err); });
}

function toggleDemo() {
  if (demo || demoGps) { demo = null; demoGps = null; banner(''); render(); return; }
  if (mode === 'trainer') demo = new DemoRider();
  else if (ref && ref.hasRoute) demoGps = new DemoGps(ref);
  else { banner('Demo for the handlebar screen needs a reference ride with a route.'); return; }
  banner('Demo data — not from your sensors.');
}

// Fake GPS that rides the reference route a little faster than the original.
class DemoGps {
  constructor(r) { this.ref = r; this.d = 0; this.t = 0; this.hr = 110; }
  next() {
    this.t++;
    const v = Math.max(0, this.ref.at('v', this.d) / 3.6 * (1.04 + 0.08 * Math.sin(this.t / 50)));
    this.d = Math.min(this.ref.total, this.d + v);
    const [x, y] = this.ref.xy(this.d), P = this.ref.prof;
    const lat = P.lat0 + (y + (Math.random() - 0.5) * 6) / 110540, lon = P.lon0 + (x + (Math.random() - 0.5) * 6) / (111320 * Math.cos(P.lat0 * Math.PI / 180));
    this.hr += (this.ref.at('hr', this.d) + 3 - this.hr) / 20;
    live.hr = Math.round(this.hr); live.tHr = Date.now();
    return { lat, lon, acc: 5, speed: v };
  }
}

function saveCsv() {
  const n = S.dist.length;
  if (!n) { banner('Nothing recorded yet.'); return; }
  const head = 'moving_s,clock,power_w,heart_rate,cadence,speed_kmh,distance_m,ghost_distance_m,gap_m,gap_s,ghost_power_w,ghost_hr,lat,lon';
  const rows = [head];
  const f = (v, d = 0) => v == null ? '' : Number(v).toFixed(d);
  for (let i = 0; i < n; i++) {
    rows.push([i + 1, new Date(S.wall[i]).toISOString(), f(S.power[i]), f(S.hr[i]), f(S.cad[i]), f(S.speed[i] * 3.6, 1), f(S.dist[i], 1),
      f(S.refDist[i], 1), f(S.gapM[i], 1), f(S.gapS[i], 1), f(S.refPower[i]), f(S.refHr[i]), f(S.lat[i], 6), f(S.lon[i], 6)].join(','));
  }
  if (steps.steps.length) {
    rows.push('', 'step_at_s,direction,from_w,to_w,delay_s,tau_s,amplitude_bpm,r2,hrr60_bpm');
    for (const s of steps.steps) rows.push([s.t, s.up ? 'up' : 'down', f(s.pre), f(s.post), s.delay, f(s.tau, 1), f(s.A, 1), f(s.r2, 3), f(s.hrr60, 1)].join(','));
  }
  const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  const d = new Date(S.wall[0]);
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  a.href = URL.createObjectURL(blob); a.download = `RideDisplay_${mode}_${stamp}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------------ reference dialog

function fillRefList() {
  const sel = $('refList');
  sel.innerHTML = '';
  if (!refs.length) sel.innerHTML = '<option value="-1">(none yet)</option>';
  refs.forEach((r, i) => { const o = document.createElement('option'); o.value = i; o.textContent = r.name; sel.appendChild(o); });
  sel.value = String(Math.max(-1, Math.min(refs.length - 1, store.get('refIndex', 0))));
}

function showRefInfo(extra = '') {
  const el = $('refInfo');
  if (!ref) { el.textContent = extra; return; }
  const P = ref.prof;
  const pw = ref.hasPower ? Math.round(P.p.reduce((a, b) => a + b, 0) / P.p.length) : null;
  el.innerHTML = `<b>${ref.name}</b>: ${(ref.total / 1000).toFixed(2)} km, ${fmtTime(ref.totalTime)} moving` +
    (pw != null ? `, average ${pw} W${P.powerEstimated ? ' (estimated)' : ''}` : ', no power') +
    (ref.hasRoute ? '' : ', <span class="err">no GPS route</span>') + (streetsNote ? `<br>${streetsNote}` : '') + (extra ? `<br>${extra}` : '');
}

async function loadRefFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const untilKm = parseFloat($('refUntil').value) || null;
    const base = file.name.replace(/\.fit$/i, '');
    const prof = profileFromFit(buf, { untilKm, rider, name: base + (untilKm ? ` (to ${untilKm} km)` : '') });
    refs = refs.filter(r => r.name !== prof.name);
    refs.unshift({ name: prof.name, prof: compact(prof) });
    while (refs.length > 6) refs.pop();
    let saved = store.set('refs', refs);
    while (!saved && refs.length > 1) { refs.pop(); saved = store.set('refs', refs); }
    fillRefList();
    selectRef(0);
    $('refList').value = '0';
    showRefInfo(saved ? '' : '<span class="err">Could not save it on this device (storage full); it works until you reload.</span>');
    await getStreets();
  } catch (e) {
    $('refInfo').innerHTML = `<span class="err">${e.message}</span>`;
  }
  $('refFile').value = '';
}

async function getStreets() {
  if (!ref || !ref.hasRoute) return;
  const want = ref;
  streetsNote = 'Streets: downloading from OpenStreetMap…'; showRefInfo();
  try {
    const st = await downloadStreets(want.prof);
    await saveStreets(want.name, st).catch(() => {});
    if (ref === want) { streets = st; streetsNote = `Streets: ${st.ways.length} downloaded and saved on this device.`; }
  } catch (e) {
    if (ref === want) streetsNote = `<span class="err">Streets: could not download (${e.message}). Connect to the internet and tap “Download streets”.</span>`;
  }
  showRefInfo(); render();
}

// ------------------------------------------------------------------ wiring

$('btnHr').onclick = () => bt('hr', connectHeartRate, $('btnHr'), d => { live.hr = d.hr; live.tHr = Date.now(); });
$('btnTrainer').onclick = () => bt('trainer', connectTrainer, $('btnTrainer'), d => {
  if (d.power != null) live.power = d.power;
  if (d.cadence != null) live.cadence = d.cadence;
  live.speed = d.speed ?? null; live.tPower = Date.now();
  if (d.hr && Date.now() - live.tHr > 5000) { live.hr = d.hr; live.tHr = Date.now(); }
});
$('btnGps').onclick = toggleGps;
$('btnStart').onclick = $('gStart').onclick = toggleStart;
$('btnResync').onclick = $('gResync').onclick = resync;
$('btnCsv').onclick = $('mCsv').onclick = saveCsv;
$('btnRef').onclick = () => { fillRefList(); $('riderKg').value = rider.riderKg; showRefInfo(); $('dlgRef').showModal(); };
$('refClose').onclick = () => $('dlgRef').close();
$('refList').onchange = e => selectRef(+e.target.value);
$('refFile').onchange = e => e.target.files[0] && loadRefFile(e.target.files[0]);
$('riderKg').onchange = e => { const v = parseFloat(e.target.value); if (v > 30 && v < 150) { rider.riderKg = v; store.set('riderKg', v); indoor = Object.assign(new IndoorRide(rider), { dist: indoor.dist, speed: indoor.speed }); } };
$('refStreets').onclick = () => getStreets();
$('refDelete').onclick = () => {
  const i = +$('refList').value;
  if (i < 0 || !refs[i]) return;
  deleteStreets(refs[i].name);
  refs.splice(i, 1); store.set('refs', refs); fillRefList(); selectRef(refs.length ? 0 : -1);
};
$('btnMenu').onclick = () => $('dlgMenu').showModal();
$('menuClose').onclick = () => $('dlgMenu').close();
$('mTrainer').onclick = () => { setMode('trainer'); $('dlgMenu').close(); };
$('mGhost').onclick = () => { setMode('ghost'); $('dlgMenu').close(); };
$('mDemo').onclick = () => { toggleDemo(); $('dlgMenu').close(); };
$('mNew').onclick = () => { newRide(); $('dlgMenu').close(); };
$('mFull').onclick = () => { document.documentElement.requestFullscreen?.().catch(() => {}); $('dlgMenu').close(); };
$('btnMapView').onclick = e => { mapView = mapView === 'all' ? 'follow' : 'all'; e.target.textContent = mapView === 'all' ? 'Follow' : 'Whole route'; render(); };
$('btnAvg').onclick = e => { avgWin = avgWin === 10 ? 30 : avgWin === 30 ? 1 : 10; e.target.textContent = `${avgWin} s`; render(); };
$('btnWin').onclick = e => { traceWin = traceWin === 600 ? 1800 : traceWin === 1800 ? 0 : 600; e.target.textContent = traceWin ? `${traceWin / 60} min` : 'whole'; render(); };
$('zIn').onclick = () => { ghostSpan = Math.max(60, ghostSpan / 1.5); render(); };
$('zOut').onclick = () => { ghostSpan = Math.min(3000, ghostSpan * 1.5); render(); };
window.addEventListener('resize', () => render());
window.addEventListener('hashchange', () => { if (location.hash === '#ghost' || location.hash === '#trainer') setMode(location.hash.slice(1)); });

// ------------------------------------------------------------------ start

document.body.dataset.mode = mode;
history.replaceState(null, '', '#' + mode);
newRide();
if (refs.length) selectRef(Math.max(0, Math.min(refs.length - 1, store.get('refIndex', 0))));
if (!bluetoothAvailable()) banner(window.isSecureContext ? 'This browser has no Web Bluetooth — use Chrome on Android, Mac or Windows.' : 'Open this page over https:// so Bluetooth and GPS can work.');
keepScreenOn();
setInterval(tick, 1000);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// for tests: run n seconds at once
window.__rideDisplay = { fastForward(n) { quiet = true; for (let i = 0; i < n; i++) tick(); quiet = false; render(); }, setMode, toggleDemo, toggleStart, get state() { return { S, ref, steps, clock }; } };
