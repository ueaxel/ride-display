// Ride Display: one page, three screens.
//   #trainer - tablet beside the indoor trainer (HR strap + trainer over Bluetooth)
//   #ghost   - phone on the handlebar, chasing the reference ride (GPS + HR strap)
//   #video   - Mac (or tablet): full-screen ride video that follows you, panels on top
import { Reference, IndoorRide, RIDER, profileFromFit } from './reference.js';
import { bluetoothAvailable, connectHeartRate, connectTrainer, startGps, keepScreenOn, DemoRider } from './sensors.js';
import { StepFinder } from './hrmodel.js';
import { RouteMatcher, MovingClock } from './ghost.js';
import * as D from './draw.js';
import { buildFit, fitFromZip } from './fitwriter.js';
import { downloadStreets, saveStreets, loadStreets, deleteStreets } from './streets.js';
import { initVideoScreen } from './videoscreen.js';
import { AreaMap, downloadArea, countTiles } from './areamap.js';
import { saveRide, listRides, deleteRide } from './myrides.js';
import { ironStops, findTurnBacks, cutTurnBack, workProfile } from './refedit.js';
import { OutdoorPower } from './power.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, dflt = null) { try { const v = localStorage.getItem(k); return v === null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

// ------------------------------------------------------------------ state

export const APP_VERSION = '25 (21 Nov 2026, downloads fixed, Share)';
const MODES = ['trainer', 'ghost', 'video'];
let mode = MODES.includes(location.hash.slice(1)) ? location.hash.slice(1)
  : (store.get('mode') || (Math.min(screen.width, screen.height) >= 700 ? 'trainer' : 'ghost'));
const indoorMode = () => mode !== 'ghost';
let pos = 0, odo = 0, lastTickAt = 0;           // position on the current route / total distance ridden
let refKey = null;                               // streets storage key of the current route
let video = null;                                // video screen (videoscreen.js)
const area = new AreaMap();                      // offline streets for riding without a reference
let areaAt = null, trail = [], heading = 0;      // last area check, your track (area metres), direction
const rider = { ...RIDER, riderKg: store.get('riderKg', RIDER.riderKg), ...store.get('rider', {}) };
// ironStops: smooth stops out of the reference; liveStops: after you stop, put the gap back to where it was before you slowed
const settings = { ironStops: true, liveStops: true, ...store.get('settings', {}) };
let outPower = null, refWork = null, refNote = '', stopEp = null, wasMoving = false, refTrail = [];
let refs = store.get('refs', []);                // [{name, prof}]
let ref = null;
let streets = null;                              // OSM streets along the reference route
let streetsNote = '';
const live = { power: null, cadence: null, speed: null, hr: null, tPower: 0, tHr: 0, fix: null, tFix: 0 };
const links = {};
let S, running, clock, indoor, matcher, offset, finished, steps, demo = null, demoGps = null;
let quiet = false;
// Trainer control from the tablet: 'off' (listen only), 'ghost' (ERG = original
// ride's power just ahead), 'grade' (route slope), 'fixed' (ERG at fixedW).
let ctlMode = store.get('ctlMode', 'off'), fixedW = store.get('fixedW', 150), ctlSent = { v: null, at: 0 };           // tests: skip drawing while fast-forwarding
let mapView = 'all', avgWin = 10, traceWin = 600, ghostSpan = 250, lastFix = null;

function newRide() {
  if (S && S.wall.length) saveRide(S, mode, { open: false });     // the ride you had is kept, closed
  S = { power: [], hr: [], cad: [], speed: [], dist: [], refDist: [], gapM: [], gapS: [], refPower: [], refHr: [],
    lat: [], lon: [], alt: [], wall: [], pEst: [], work: [] };
  trail = []; refTrail = []; stopEp = null; wasMoving = false;
  outPower = new OutdoorPower(rider);
  running = false; clock = new MovingClock(); indoor = new IndoorRide(rider);
  matcher = ref && ref.hasRoute ? new RouteMatcher(ref) : null;
  offset = 0; finished = null; steps = new StepFinder(); lastFix = null;
  pos = 0; odo = 0;
  video?.onNewRide();
  render();
}

function setMode(m) {
  const was = mode;
  mode = m; document.body.dataset.mode = m; store.set('mode', m);
  history.replaceState(null, '', '#' + m);
  if (was === 'video' && m !== 'video') { video?.leave(); const i = store.get('refIndex', 0); if (refs[i]) selectRef(i); }
  if (m === 'video') video?.enter();
  render();
}

function selectRef(i) {
  const r = refs[i];
  if (!r) i = -1;
  ref = null; refNote = '';
  if (r) {
    let prof = r.prof;
    if (settings.ironStops && prof.t && prof.v) {
      const it = ironStops(prof);
      prof = it.prof;
      if (it.smoothed.length) refNote = `Stops smoothed out: ${it.smoothed.length} (the ghost is ${it.smoothed.reduce((a, b) => a + b.seconds, 0)} s faster for it).`;
    }
    ref = new Reference(prof);
  }
  refWork = ref ? workProfile(ref.prof) : null;
  store.set('refIndex', i);
  $('refName').textContent = ref ? ref.name : 'No reference';
  streets = null; streetsNote = ''; refKey = ref ? ref.name : null;
  if (ref) loadStreets(ref.name).then(st => {
    if (st && !st.ways.length) st = null;
    if (ref && r && ref.name === r.name) { streets = st; streetsNote = st ? `Streets: ${st.ways.length} saved on this device.` : 'Streets: not downloaded yet.'; showRefInfo(); render(); }
  });
  matcher = ref && ref.hasRoute ? new RouteMatcher(ref) : null;
  if (matcher && S && S.dist.length) matcher.dist = S.dist[S.dist.length - 1];
  rebuildRefTrail();
  showRefInfo();
  if (r && findTurnBacks(r.prof).filter(tb => !(r.prof.kept || []).includes(tb.d0)).length)
    banner('This reference rides a stretch back and forth: tap its name at the top to check it.');
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
  if (indoorMode()) {
    moving = clock.tick(power > 0 || cadence > 0 ? 9 : 0);
    const before = indoor.dist;
    if (moving) indoor.step(power, 1, ref ? ref.gradeFraction(indoor.dist) : 0);
    dist = indoor.dist; speed = moving ? indoor.speed : 0;
    odo += dist - before;
  } else {
    fix = now - live.tFix < 5000 ? live.fix : null;
    const prev = last(S.dist) ?? 0;
    if (fix && matcher) { dist = matcher.update(fix); lastFix = fix; }
    else if (fix && lastFix) {
      // free riding: count GPS distance, ignoring the wobble of a phone standing still
      const step = haversine(lastFix, fix);
      if (step > Math.min(8, Math.max(2, (fix.acc || 5) * 0.5)) || (fix.speed ?? 0) > 1) { dist = prev + step; lastFix = fix; }
      else dist = prev;
    } else { dist = prev; if (fix) lastFix = fix; }
    if (fix && (!areaAt || haversine(areaAt, fix) > 300)) { areaAt = fix; area.ensure(fix.lat, fix.lon).then(() => render()); }
    speed = fix && fix.speed != null && fix.speed >= 0 ? fix.speed : Math.max(0, dist - prev);
    moving = clock.tick(speed);
    odo = dist;
  }
  pos = dist; lastTickAt = now; live.moving = moving; live.speedNow = speed;
  if (!indoorMode()) {
    const onRoute = ref && matcher && !matcher.offRoute && ref.hasAlt;
    outPower.update(moving ? speed : 0, odo, fix && fix.alt != null ? fix.alt : null, onRoute ? ref.gradeFraction(Math.min(dist, ref.total)) : null);
    if (ref && settings.liveStops) stopWatch(moving, speed, dist);
  }
  wasMoving = moving;
  if (indoorMode()) control(dist, speed);
  if (mode === 'video') video?.onTick();
  dist = pos;                                     // (the video screen may have switched clips)
  if (!moving) { render(); return; }

  S.power.push(indoorMode() ? power : null);
  const pNow = indoorMode() ? power : outPower.p3 ?? 0;
  S.pEst.push(Math.round(pNow)); S.work.push((last(S.work) ?? 0) + pNow);
  S.cad.push(indoorMode() ? cadence : null); S.hr.push(hr); S.speed.push(speed); S.dist.push(odo); S.wall.push(now);
  S.lat.push(fix ? fix.lat : null); S.lon.push(fix ? fix.lon : null); S.alt.push(fix && fix.alt != null ? fix.alt : null);
  if (fix) { trail.push(area.xy(fix.lat, fix.lon)); if (matcher) refTrail.push(matcher.toXY(fix.lat, fix.lon)); }
  if (S.wall.length % 10 === 0) saveRide(S, mode, rideState());   // kept on the phone as you ride
  const t = clock.seconds;
  if (ref) {
    const refSec = t - offset;
    const rd = Math.min(ref.total, ref.distAtTime(refSec));
    S.refDist.push(rd);
    S.gapM.push(dist - rd);
    S.gapS.push(ref.timeAt(Math.min(dist, ref.total)) - refSec);   // + = ahead
    S.refPower.push(ref.hasPower ? ref.at('p', Math.min(dist, ref.total)) : null);
    S.refHr.push(ref.at('hr', Math.min(dist, ref.total)) || null);
    if (dist >= ref.total) { finished = { gapS: ref.totalTime - refSec }; saveRide(S, mode, rideState()); }
  } else {
    for (const k of ['refDist', 'gapM', 'gapS', 'refPower', 'refHr']) S[k].push(null);
  }
  if (indoorMode()) steps.update(S.power, S.hr);
  render();
}

// You stopped (red light): when you're back up to speed, the gap goes back to
// what it was before you started slowing down.
function stopWatch(moving, speed, dist) {
  const n = S.speed.length;
  if (!moving && wasMoving && !stopEp && n > 25) {
    const prior = S.speed.slice(Math.max(0, n - 40), n - 15).filter(v => v != null).sort((a, b) => a - b);
    const cruise = prior[prior.length >> 1] || 0;
    let j = n - 1;
    while (j > Math.max(0, n - 60) && S.speed[j] < 0.85 * cruise) j--;
    if (cruise > 2 && S.gapS[j] != null) stopEp = { gap: S.gapS[j], cruise, since: null, d0: dist };
  } else if (moving && stopEp) {
    if (stopEp.since == null) { stopEp.since = clock.seconds; stopEp.d0 = dist; }
    if (speed >= 0.85 * stopEp.cruise || clock.seconds - stopEp.since > 45 || dist - stopEp.d0 > 400) {
      offset = stopEp.gap - ref.timeAt(Math.min(dist, ref.total)) + clock.seconds;
      if (!quiet) banner(`Stop smoothed out: gap back to ${sign(stopEp.gap)} s`), setTimeout(() => banner(''), 5000);
      stopEp = null;
    }
  }
}

function rideState() {
  return { open: !finished, running, refName: ref ? ref.name : null, offset, odo, pos, indoorDist: indoor.dist,
    clock: { seconds: clock.seconds, now: clock.now, lastMove: clock.lastMove },
    matcher: matcher ? { dist: matcher.dist, idx: matcher.idx, offRoute: matcher.offRoute } : null };
}

function rebuildRefTrail() {
  refTrail = [];
  if (!matcher || !S) return;
  for (let i = 0; i < S.lat.length; i++) if (S.lat[i] != null) refTrail.push(matcher.toXY(S.lat[i], S.lon[i]));
}

// After a reload (or Chrome closing in the pocket) carry on with the ride you were on.
async function restoreRide() {
  const r = (await listRides())[0];
  if (!r || !r.state || !r.state.open || Date.now() - r.end > 3 * 3600e3) return;
  const st = r.state;
  if (r.mode !== mode) setMode(r.mode);
  const i = st.refName ? refs.findIndex(x => x.name === st.refName) : -1;
  if ((ref ? ref.name : null) !== st.refName) selectRef(i);
  newRide();
  const n = r.S.wall.length;
  for (const k of Object.keys(S)) S[k] = r.S[k] && r.S[k].length === n ? r.S[k] : new Array(n).fill(null);
  if (!r.S.work) { let w = 0; S.work = S.pEst.map(p => (w += p || 0)); }
  Object.assign(clock, st.clock); offset = st.offset; odo = st.odo; pos = st.pos; indoor.dist = st.indoorDist ?? pos;
  if (matcher && st.matcher) Object.assign(matcher, st.matcher);
  trail = []; lastFix = null;
  for (let j = 0; j < n; j++) if (S.lat[j] != null) { trail.push(area.xy(S.lat[j], S.lon[j])); lastFix = { lat: S.lat[j], lon: S.lon[j] }; }
  rebuildRefTrail();
  running = !!st.running;
  if (r.mode === 'ghost' && !links.gps) toggleGps();            // GPS needs no tap; the HR strap does (Bluetooth rule)
  banner(`Carrying on with your ride from ${new Date(r.start).toLocaleTimeString([], { timeStyle: 'short' })}. (☰ → New ride to start a fresh one.)`);
  setTimeout(() => banner(''), 8000);
  render();
}

// Switch to another route (video clip) at position p on it, e.g. at a junction.
// The ghost is lined up with you there; distance ridden carries on.
function switchRef(newRef, p, key) {
  ref = newRef; refKey = key || newRef.name;
  pos = p; indoor.dist = p;
  offset = clock.seconds - newRef.timeAt(p);
  finished = null; ctlSent = { v: null, at: 0 };
  matcher = null;
  $('refName').textContent = ref.name;
  streets = null;
  const want = ref;
  loadStreets(refKey).then(async st => {
    if (ref !== want) return;
    if (st && !st.ways.length) st = null;           // an empty download from a busy server: try again
    if (!st && navigator.onLine && want.hasRoute) {
      try { st = await downloadStreets(want.prof); await saveStreets(refKey, st); } catch (e) { st = null; }
    }
    if (ref === want) { streets = st; render(); }
  });
  render();
}

// What the trainer should do now; sent when it changed enough or every 10 s.
function controlTarget(dist, speed) {
  if (ctlMode === 'fixed') return { kind: 'power', v: fixedW };
  if (!ref || finished) return null;
  const d = Math.min(dist, ref.total);
  if (ctlMode === 'ghost' && ref.hasPower) {
    // original power over the next ~2-8 s of road: the R200 needs 2-3 s to respond
    let s = 0;
    for (let k = 2; k <= 8; k++) s += ref.at('p', Math.min(ref.total, d + Math.max(speed, 3) * k));
    return { kind: 'power', v: Math.max(60, Math.min(600, Math.round(s / 7 / 5) * 5)) };
  }
  if (ctlMode === 'grade') return { kind: 'grade', v: Math.round(ref.gradeFraction(d) * 200) / 200 };   // 0.5 % steps
  return null;
}

function control(dist, speed) {
  const c = links.trainer?.control;
  if (!c || ctlMode === 'off' || demo) return;
  const t = controlTarget(dist, speed);
  if (!t) return;
  const now = Date.now();
  const changed = ctlSent.v === null || ctlSent.kind !== t.kind || Math.abs(t.v - ctlSent.v) >= (t.kind === 'power' ? 5 : 0.005);
  if (!changed && now - ctlSent.at < 10000) return;
  ctlSent = { kind: t.kind, v: t.v, at: now };
  c.apply(t.kind, t.v).then(() => render());
}

function setCtlMode(m) {
  ctlMode = m; store.set('ctlMode', m); ctlSent = { v: null, at: 0 };
  $('ctlMode').value = m;
  if (links.trainer?.control && m !== 'off') control(pos, last(S.speed) ?? 0);
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
  const you = ref ? Math.min(pos, ref.total) : null;
  const ghost = ref && running ? Math.min(ref.total, ref.distAtTime(t - offset)) : (ref ? 0 : null);
  const gapM = last(S.gapM), gapS = finished ? finished.gapS : last(S.gapS);
  const hr = Date.now() - live.tHr < 5000 ? live.hr : null;
  const startBtns = [$('btnStart'), $('gStart')];
  for (const b of startBtns) {
    b.textContent = finished ? 'Finished' : running ? 'Stop' : (S.dist.length ? 'Resume' : 'Start');
    b.classList.toggle('stop', running && !finished);
    b.classList.toggle('primary', !running && !finished);
  }
  // phone while riding: map fills the screen, numbers float on top, top bar hidden
  const ridingNow = mode === 'ghost' && running && !finished;
  if (document.body.classList.contains('riding') !== ridingNow) document.body.classList.toggle('riding', ridingNow);
  if (mode === 'trainer') renderTrainer(t, you, ghost, gapM, gapS, hr);
  else if (mode === 'video') video?.render({ t, you, ghost, gapM, gapS, hr });
  else renderGhost(t, you, ghost, gapM, gapS, hr);
}

function renderTrainer(t, you, ghost, gapM, gapS, hr) {
  const p3 = avgLast(S.power, 3);
  const fresh = Date.now() - live.tPower < 3000;
  $('tPower').textContent = running && p3 != null ? Math.round(p3) : fresh ? Math.round(live.power ?? 0) : '–';
  $('tHr').textContent = hr ?? (links.hr && live.contact === false ? 'no contact' : '–');
  $('tCad').textContent = fresh && live.cadence != null ? Math.round(live.cadence) : '–';
  $('tSpeed').textContent = S.speed.length ? (last(S.speed) * 3.6).toFixed(1) : '–';
  $('tTime').textContent = fmtTime(t);
  $('tState').textContent = !running ? (t ? 'stopped' : 'press Start') : finished ? 'reference distance reached' : clock.now - clock.lastMove > 3 ? 'paused' : 'riding';
  $('tDist').textContent = ((last(S.dist) ?? 0) / 1000).toFixed(2);
  const rp = last(S.refPower), rh = last(S.refHr);
  const ctl = links.trainer?.control;
  const ghostTxt = ref && ref.hasPower && rp != null ? `ghost ${Math.round(rp)} W${ref.prof.powerEstimated ? ' (est.)' : ''}` : '';
  let ctlTxt = '';
  if (ctlMode !== 'off') {
    if (!links.trainer) ctlTxt = 'connect the trainer';
    else if (!ctl) ctlTxt = 'trainer has no FTMS control';
    else ctlTxt = ctl.message || (running ? 'waiting…' : 'press Start');
  }
  $('tPowerRef').textContent = ctlTxt ? ctlTxt + (ghostTxt && ctlMode !== 'ghost' ? ' · ' + ghostTxt : '') : ghostTxt;
  $('tPowerRef').className = 'sub' + (ctl && ctl.last && !ctl.last.ok ? ' bad' : '');
  $('fixedRow').style.display = ctlMode === 'fixed' ? 'flex' : 'none';
  $('fixedW').textContent = `${fixedW} W`;
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
  const free = !ref;                              // riding without a reference: speed, distance, map around you
  document.body.classList.toggle('free', free);
  if (free) {
    const sp = last(S.speed), km = (last(S.dist) ?? 0) / 1000;
    g.innerHTML = running && sp != null ? `${(sp * 3.6).toFixed(1)}<span class="unit">km/h</span>` : '–'; g.className = 'gapbig';
    $('gGapS').textContent = running || t ? `${km.toFixed(2)} km · ${fmtTime(t)}` : 'free ride: tap Start (or load a reference ride to race it)';
  } else if (ref && finished) {
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
  $('gHr').textContent = hr ?? (links.hr && live.contact === false ? 'no contact' : '–');
  const rh = last(S.refHr);
  $('gHrRef').textContent = rh ? `ghost ${Math.round(rh)}` + (hr ? ` (${sign(hr - rh)})` : '') : '';
  const p3 = indoorMode() ? avgLast(S.power, 3) : outPower && running ? outPower.p3 : null;
  $('gPow').textContent = p3 != null ? Math.round(p3) : '–';
  $('gPowRef').textContent = ref && ref.hasPower && you != null ? `ghost ${Math.round(ref.at('p', Math.min(you, ref.total)))}` : '';
  if (ref && refWork && you != null && ghost != null && running) {
    const wAt = d => interpW(Math.min(d, ref.total));
    const gapK = (wAt(you) - wAt(ghost)) / 1000;            // + = ahead: work the ghost still has to do to get to you
    const used = ((last(S.work) ?? 0) - wAt(you)) / 1000;     // + = you've used more than the original to get here
    $('gWork').textContent = `work ${sign1(gapK)} kJ · used ${sign1(used)} kJ`;
  } else $('gWork').textContent = '';
  const sp = last(S.speed);
  $('gSpeedLabel').textContent = free ? 'Average km/h' : 'Speed km/h';
  $('gSpeed').textContent = free ? (t > 0 ? ((last(S.dist) ?? 0) / t * 3.6).toFixed(1) : '–') : sp != null && running ? (sp * 3.6).toFixed(1) : '–';
  $('gSpeedRef').textContent = ref && you != null ? `ghost ${ref.at('v', you).toFixed(1)}` + (ref.hasPower ? ` · ${Math.round(ref.at('p', you))} W` : '') : '';
  $('gTime').textContent = fmtTime(t);
  $('gDist').textContent = `${((last(S.dist) ?? 0) / 1000).toFixed(2)} km`;
  $('gLeft').textContent = ref ? `${(Math.max(0, ref.total - (you ?? 0)) / 1000).toFixed(2)} km to go` : '';
  $('gOff').style.display = matcher && matcher.offRoute ? 'block' : 'none';
  const riding = document.body.classList.contains('riding');
  if (free) {
    const f = Date.now() - live.tFix < 10000 ? live.fix : lastFix;
    const me = f ? area.xy(f.lat, f.lon) : null;
    // heading from your last ~20 m of track
    if (me && trail.length > 1) {
      for (let i = trail.length - 1; i >= 0; i--) {
        const dx = me[0] - trail[i][0], dy = me[1] - trail[i][1];
        if (Math.hypot(dx, dy) > 20) { heading = Math.atan2(dx, dy); break; }
      }
    }
    D.drawFreeMap($('gmap'), area.streets, { you: me, heading, trail, span: riding ? ghostSpan * 1.3 : ghostSpan,
      anchor: riding ? 0.64 : 0.72, labelZone: riding ? [0.3, 0.7] : null, note: links.gps ? '' : 'Tap GPS to see where you are' });
    return;
  }
  D.drawRoute($('gmap'), ref, { you: you ?? 0, ghost, view: 'follow', span: riding ? ghostSpan * 1.3 : ghostSpan, done: you ?? 0, streets, trail: refTrail,
    anchor: riding ? 0.64 : 0.78, labelZone: riding ? [0.3, 0.7] : null });
}

// ------------------------------------------------------------------ actions

function interpW(d) {
  const st = ref.prof.step, i = Math.max(0, Math.min(refWork.length - 2, Math.floor(d / st)));
  const f = Math.max(0, Math.min(1, (d - ref.prof.d[i]) / st));
  return refWork[i] + (refWork[i + 1] - refWork[i]) * f;
}
function sign1(x) { return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1); }

function toggleStart() {
  if (finished) return;
  running = !running;
  if (!running) saveRide(S, mode, rideState());
  render();
}

function resync() {
  if (!ref || !running) return;
  const dist = Math.min(pos, ref.total);
  offset = clock.seconds - ref.timeAt(dist);
  if (S.gapM.length) { S.gapM[S.gapM.length - 1] = 0; S.gapS[S.gapS.length - 1] = 0; }
  navigator.vibrate?.(150);
  render();
}

async function bt(key, connect, btn, onData, showAll = false) {
  if (!bluetoothAvailable()) { banner('Bluetooth needs Chrome and an https:// address (Android, Mac or Windows; not iPhone).'); return; }
  if (links[key]) { links[key].close(); links[key] = null; btn.dataset.state = 'off'; btn.textContent = btn.dataset.label; return; }
  try {
    banner('');
    links[key] = await connect(onData, s => { btn.dataset.state = s; }, showAll);
    btn.title = links[key].name + (links[key].protocol ? ` (${links[key].protocol})` : '');
    btn.textContent = links[key].name;
  } catch (e) {
    btn.dataset.state = 'off';
    links[key] = null;
    if (e.name !== 'NotFoundError') banner(`${btn.textContent}: ${e.message} — make sure no other device (watch, phone, trainer app) is using it over Bluetooth, then tap again.`);
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
  if (indoorMode()) demo = new DemoRider();
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
  download(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), 'csv');
}

function download(blob, ext) { downloadFor(S, mode, ext, blob); }

function rideFileName(S2, m, ext) {
  const d = new Date(S2.wall[0]), p2 = v => String(v).padStart(2, '0');
  return `RideDisplay_${m}_${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
}
function downloadFor(S2, m, ext, blob) {
  const a = document.createElement('a');
  const name = rideFileName(S2, m, ext);
  // octet-stream: Android Chrome saves it as is; the link stays valid for 10 min
  // in case Chrome first asks whether to download it
  a.href = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 600000);
  banner(`Saved to Downloads: ${name} (Files app → Downloads, or Chrome ⋮ → Downloads)`); setTimeout(() => banner(''), 8000);
}
// Android: send the file straight to Drive, mail, … with the share sheet
async function shareFile(S2, m, ext, blob) {
  const file = new File([blob], rideFileName(S2, m, ext), { type: 'application/octet-stream' });
  try { await navigator.share({ files: [file], title: file.name }); }
  catch (e) { if (e.name !== 'AbortError') downloadFor(S2, m, ext, blob); }
}

function saveFit() {
  if (!S.dist.length) { banner('Nothing recorded yet.'); return; }
  try { download(new Blob([buildFit(S, { indoor: indoorMode() })], { type: 'application/vnd.ant.fit' }), 'fit'); }
  catch (e) { banner('FIT: ' + e.message); }
}

// ------------------------------------------------------------------ reference dialog

function fillRefList() {
  const sel = $('refList');
  sel.innerHTML = '';
  sel.innerHTML = '<option value="-1">No reference (free ride)</option>';
  refs.forEach((r, i) => { const o = document.createElement('option'); o.value = i; o.textContent = r.name; sel.appendChild(o); });
  sel.value = String(Math.max(-1, Math.min(refs.length - 1, store.get('refIndex', 0))));
}

// Stretches ridden back and forth in the current reference: show each on a
// small map and cut it out (or keep it) when you say so.
function showTurnBacks() {
  const box = $('refTurns'); box.innerHTML = '';
  const i = +$('refList').value, r = refs[i];
  if (!r || !r.prof.x) return;
  for (const tb of findTurnBacks(r.prof)) {
    if ((r.prof.kept || []).includes(tb.d0)) continue;
    const div = document.createElement('div'); div.className = 'turnback';
    div.innerHTML = `<b>Back and forth at ${(tb.d0 / 1000).toFixed(2)} km</b>: the ride turns around, goes ${tb.back} m back and turns again (${Math.round(tb.d1 - tb.d0)} m in all, red on the map). Cut it out so the ghost rides straight through?`;
    const cv = document.createElement('canvas'); cv.className = 'tbmap'; div.appendChild(cv);
    const row = document.createElement('div'); row.className = 'row';
    const cut = document.createElement('button'); cut.className = 'primary'; cut.textContent = 'Cut it out';
    cut.onclick = () => { r.prof = cutTurnBack(r.prof, tb); store.set('refs', refs); selectRef(i); };
    const keep = document.createElement('button'); keep.textContent = 'Keep it';
    keep.onclick = () => { r.prof.kept = [...(r.prof.kept || []), tb.d0]; store.set('refs', refs); showTurnBacks(); banner(''); };
    row.append(keep, cut); div.appendChild(row); box.appendChild(div);
    requestAnimationFrame(() => D.drawTurnBack(cv, r.prof, tb));
  }
}

function showRefInfo(extra = '') {
  const el = $('refInfo');
  if (!ref) { el.textContent = extra; return; }
  const P = ref.prof;
  const pw = ref.hasPower ? Math.round(P.p.reduce((a, b) => a + b, 0) / P.p.length) : null;
  el.innerHTML = `<b>${ref.name}</b>: ${(ref.total / 1000).toFixed(2)} km, ${fmtTime(ref.totalTime)} moving` +
    (pw != null ? `, average ${pw} W${P.powerEstimated ? ' (estimated)' : ''}` : ', no power') +
    (ref.hasRoute ? '' : ', <span class="err">no GPS route</span>') + (refNote ? `<br>${refNote}` : '') + (streetsNote ? `<br>${streetsNote}` : '') + (extra ? `<br>${extra}` : '');
  showTurnBacks();
}

async function loadRefFile(file) {
  try {
    let buf = await file.arrayBuffer();
    if (/\.zip$/i.test(file.name) || new Uint8Array(buf, 0, 2).join() === '80,75') buf = await fitFromZip(buf);
    const untilKm = parseFloat($('refUntil').value) || null;
    const base = file.name.replace(/\.(fit|zip)$/i, '');
    const prof = profileFromFit(buf, { untilKm, rider, name: base + (untilKm ? ` (to ${untilKm} km)` : '') });
    await addRef(prof);
  } catch (e) {
    $('refInfo').innerHTML = `<span class="err">${e.message}</span>`;
  }
  $('refFile').value = '';
}

async function addRef(prof) {
  {
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
  }
}

// ------------------------------------------------------------------ my rides, offline map

async function showRides() {
  const box = $('ridesList');
  box.innerHTML = '<p class="muted">Loading…</p>';
  $('dlgRides').showModal();
  const rides = await listRides();
  box.innerHTML = rides.length ? '' : '<p class="muted">No rides yet. Rides are kept here automatically while you ride.</p>';
  for (const r of rides) {
    const row = document.createElement('div');
    row.className = 'cliprow riderow';
    const when = new Date(r.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    row.innerHTML = `<div><b>${when}</b><br><span class="muted">${(r.dist / 1000).toFixed(2)} km · ${fmtTime(r.seconds)} · ${r.mode === 'ghost' ? 'outdoor' : 'indoor'}</span></div>`;
    const fitBtn = document.createElement('button'); fitBtn.textContent = 'Save FIT';
    fitBtn.onclick = () => downloadFor(r.S, r.mode, 'fit', new Blob([buildFit(r.S, { indoor: r.mode !== 'ghost' })], { type: 'application/vnd.ant.fit' }));
    row.append(fitBtn);
    if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.fit')] })) {
      const sh = document.createElement('button'); sh.textContent = 'Share';
      sh.onclick = () => shareFile(r.S, r.mode, 'fit', buildFit(r.S, { indoor: r.mode !== 'ghost' }));
      row.append(sh);
    }
    if (r.hasGps) {
      const refBtn = document.createElement('button'); refBtn.className = 'primary'; refBtn.textContent = 'Use as reference';
      refBtn.onclick = async () => {
        try {
          const bytes = buildFit(r.S, { indoor: false });
          const prof = profileFromFit(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { rider, name: `My ride ${when}` });
          await addRef(prof);
          if (running) toggleStart();
          newRide();                                   // the ride you were on is kept in My rides
          $('dlgRides').close(); banner(`Reference: My ride ${when}. Go to its start and tap Start to race it.`);
        } catch (e) { banner('Could not use it: ' + e.message); }
      };
      row.append(refBtn);
    }
    const del = document.createElement('button'); del.textContent = 'Delete';
    del.onclick = async () => { await deleteRide(r.id); row.remove(); };
    row.append(del);
    box.appendChild(row);
  }
}

async function showArea() {
  $('dlgArea').showModal();
  const n = await countTiles();
  $('areaInfo').textContent = n ? `${n} map squares (about 2 × 2 km each) stored on this phone.` : 'No offline map stored yet.';
}
async function getArea(km) {
  const f = live.fix || lastFix;
  if (!f) {
    if (!links.gps) toggleGps();
    $('areaInfo').textContent = 'Waiting for GPS… tap again when the GPS dot is green.';
    return;
  }
  if (!navigator.onLine) { $('areaInfo').textContent = 'No internet: do this at home on Wi-Fi.'; return; }
  $('areaInfo').textContent = 'Downloading…';
  const r = await downloadArea(f.lat, f.lon, km, (done, total, failed, note) => {
    $('areaInfo').textContent = `Downloading streets: ${done} of ${total} squares${failed ? `, ${failed} failed` : ''}… ${note || ''}` +
      ' (the free map server can be slow: keep this screen open; the nearest streets come first)';
    area.ensure(f.lat, f.lon, false).then(() => render());
  });
  $('areaInfo').textContent = `Done: streets within ${km} km stored on this phone${r.failed ? ` (${r.failed} squares failed: tap again later to fill them in)` : ''}.`;
  areaAt = null; area.tiles.clear(); area.ensure(f.lat, f.lon, false).then(() => render());
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

const onHrData = d => {
  live.contact = d.contact;
  if (d.contact === false) { live.hr = null; return; }      // strap off: no reading, not a stale one
  live.hr = d.hr; live.tHr = Date.now();
};
const onTrainerData = d => {
  if (d.power != null) live.power = d.power;
  if (d.cadence != null) live.cadence = d.cadence;
  live.speed = d.speed ?? null; live.tPower = Date.now();
  if (d.hr && Date.now() - live.tHr > 5000) { live.hr = d.hr; live.tHr = Date.now(); }
};
$('btnHr').onclick = () => bt('hr', connectHeartRate, $('btnHr'), onHrData);
$('btnTrainer').onclick = () => bt('trainer', connectTrainer, $('btnTrainer'), onTrainerData);
$('btnGps').onclick = toggleGps;
$('mRides').onclick = () => { $('dlgMenu').close(); showRides(); };
$('ridesClose').onclick = () => $('dlgRides').close();
$('mArea').onclick = () => { $('dlgMenu').close(); showArea(); };
$('area5').onclick = () => getArea(5); $('area10').onclick = () => getArea(10);
$('areaClose').onclick = () => $('dlgArea').close();
let peekTimer = null;
$('gPeek').onclick = () => {           // riding layout: show the top bar for a few seconds
  document.body.classList.add('peek'); clearTimeout(peekTimer);
  peekTimer = setTimeout(() => document.body.classList.remove('peek'), 6000);
};
$('ctlMode').onchange = e => setCtlMode(e.target.value);
const bump = dw => () => { fixedW = Math.max(50, Math.min(600, fixedW + dw)); store.set('fixedW', fixedW); ctlSent = { v: null, at: 0 }; control(pos, 0); render(); };
$('wDown').onclick = bump(-10); $('wUp').onclick = bump(10);
$('mAllTrainer').onclick = () => { $('dlgMenu').close(); if (links.trainer) { links.trainer.close(); links.trainer = null; } bt('trainer', connectTrainer, $('btnTrainer'), onTrainerData, true); };
$('mAllHr').onclick = () => { $('dlgMenu').close(); if (links.hr) { links.hr.close(); links.hr = null; } bt('hr', connectHeartRate, $('btnHr'), onHrData, true); };
$('btnStart').onclick = $('gStart').onclick = toggleStart;
$('btnResync').onclick = $('gResync').onclick = resync;
$('mCsv').onclick = saveCsv;
$('btnFit').onclick = $('mFit').onclick = saveFit;
$('btnRef').onclick = () => { fillRefList(); showRefInfo(); $('dlgRef').showModal(); };
$('refClose').onclick = () => $('dlgRef').close();
$('refList').onchange = e => selectRef(+e.target.value);
$('refFile').onchange = e => e.target.files[0] && loadRefFile(e.target.files[0]);
$('refStreets').onclick = () => getStreets();
$('refDelete').onclick = () => {
  const i = +$('refList').value;
  if (i < 0 || !refs[i]) return;
  deleteStreets(refs[i].name);
  refs.splice(i, 1); store.set('refs', refs); fillRefList(); selectRef(refs.length ? 0 : -1);
};
$('mSettings').onclick = () => {
  $('dlgMenu').close();
  $('setRider').value = rider.riderKg; $('setBike').value = rider.bikeKg; $('setCda').value = rider.cda; $('setCrr').value = rider.crr;
  $('setIron').checked = settings.ironStops; $('setLive').checked = settings.liveStops; $('keyTest').textContent = 'Press the button now…';
  $('dlgSettings').showModal();
};
$('setClose').onclick = () => {
  const num = (id, lo, hi, d) => { const v = parseFloat($(id).value); return v >= lo && v <= hi ? v : d; };
  rider.riderKg = num('setRider', 30, 150, rider.riderKg); rider.bikeKg = num('setBike', 3, 40, rider.bikeKg);
  rider.cda = num('setCda', 0.15, 0.8, rider.cda); rider.crr = num('setCrr', 0.001, 0.03, rider.crr);
  store.set('rider', { riderKg: rider.riderKg, bikeKg: rider.bikeKg, cda: rider.cda, crr: rider.crr }); store.set('riderKg', rider.riderKg);
  const iron = $('setIron').checked !== settings.ironStops;
  settings.ironStops = $('setIron').checked; settings.liveStops = $('setLive').checked; store.set('settings', settings);
  outPower = new OutdoorPower(rider);
  indoor = Object.assign(new IndoorRide(rider), { dist: indoor.dist, speed: indoor.speed });
  if (iron && ref) { const i = refs.findIndex(x => x.name === ref.name); if (i >= 0) selectRef(i); }
  $('dlgSettings').close();
};
// Reset gap without the touch screen: volume key (if Chrome passes it on), a
// Bluetooth remote / keyboard (Enter, space, Page Down, arrows) or headset button.
const RESET_KEYS = ['AudioVolumeUp', 'VolumeUp', 'AudioVolumeDown', 'VolumeDown', 'Enter', ' ', 'PageDown', 'PageUp', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaPlayPause', 'Camera'];
window.addEventListener('keydown', e => {
  if ($('dlgSettings').open) { $('keyTest').textContent = `Got "${e.key}"` + (RESET_KEYS.includes(e.key) ? ' — this button resets the gap.' : ' — not used.'); e.preventDefault(); return; }
  if (e.target.closest('input, select, textarea') || document.querySelector('dialog[open]')) return;
  if (mode === 'ghost' && RESET_KEYS.includes(e.key)) { e.preventDefault(); resync(); banner('Gap reset'); setTimeout(() => banner(''), 2000); }
});
if ('mediaSession' in navigator) for (const a of ['nexttrack', 'previoustrack', 'play', 'pause']) {
  try { navigator.mediaSession.setActionHandler(a, () => { if (mode === 'ghost') { resync(); banner('Gap reset'); setTimeout(() => banner(''), 2000); } }); } catch (e) { /* */ }
}
const saveNow = () => { if (S && S.wall.length) saveRide(S, mode, rideState()); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', saveNow);
$('btnMenu').onclick = () => { $('appVersion').textContent = 'Version ' + APP_VERSION; $('dlgMenu').showModal(); };
$('menuClose').onclick = () => $('dlgMenu').close();
$('mTrainer').onclick = () => { setMode('trainer'); $('dlgMenu').close(); };
$('mGhost').onclick = () => { setMode('ghost'); $('dlgMenu').close(); };
$('mVideo').onclick = () => { setMode('video'); $('dlgMenu').close(); };
$('mDemo').onclick = () => { toggleDemo(); $('dlgMenu').close(); };
$('mNew').onclick = () => { newRide(); $('dlgMenu').close(); };
const toggleFull = () => {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
};
$('mFull').onclick = () => { toggleFull(); $('dlgMenu').close(); };
$('btnFull').onclick = toggleFull;
window.addEventListener('keydown', e => { if ((e.key === 'f' || e.key === 'F') && !e.target.closest('input, select, textarea')) toggleFull(); });
$('btnMapView').onclick = e => { mapView = mapView === 'all' ? 'follow' : 'all'; e.target.textContent = mapView === 'all' ? 'Follow' : 'Whole route'; render(); };
$('btnAvg').onclick = e => { avgWin = avgWin === 10 ? 30 : avgWin === 30 ? 1 : 10; e.target.textContent = `${avgWin} s`; render(); };
$('btnWin').onclick = e => { traceWin = traceWin === 600 ? 1800 : traceWin === 1800 ? 0 : 600; e.target.textContent = traceWin ? `${traceWin / 60} min` : 'whole'; render(); };
$('zIn').onclick = () => { ghostSpan = Math.max(60, ghostSpan / 1.5); render(); };
$('zOut').onclick = () => { ghostSpan = Math.min(3000, ghostSpan * 1.5); render(); };
window.addEventListener('resize', () => render());
window.addEventListener('hashchange', () => { if (MODES.includes(location.hash.slice(1))) setMode(location.hash.slice(1)); });

// ------------------------------------------------------------------ start

$('ctlMode').value = ctlMode;
for (const id of ['btnHr', 'btnTrainer']) $(id).dataset.label = $(id).textContent;
document.body.dataset.mode = mode;
history.replaceState(null, '', '#' + mode);
video = initVideoScreen({
  get ref() { return ref; }, get streets() { return streets; }, get pos() { return pos; }, get S() { return S; },
  get running() { return running; }, get finished() { return finished; }, get clock() { return clock; },
  get steps() { return steps; }, get links() { return links; }, get live() { return live; }, get odo() { return odo; },
  get ctlMode() { return ctlMode; }, get rider() { return rider; },
  // position now, between the 1-s ticks (smooth video)
  posNow() { return live.moving && running && !finished ? pos + (live.speedNow || 0) * Math.min(1.5, (Date.now() - lastTickAt) / 1000) : pos; },
  switchRef, render: () => render(), banner, $, fmtTime, sign, gapClass, avgLast, last,
});
newRide();
if (refs.length && store.get('refIndex', 0) >= 0) selectRef(Math.max(0, Math.min(refs.length - 1, store.get('refIndex', 0))));
restoreRide();
if (!bluetoothAvailable()) banner(window.isSecureContext ? 'This browser has no Web Bluetooth — use Chrome on Android, Mac or Windows.' : 'Open this page over https:// so Bluetooth and GPS can work.');
keepScreenOn();
setInterval(tick, 1000);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// for tests: run n seconds at once
window.__rideDisplay = { fastForward(n) { quiet = true; for (let i = 0; i < n; i++) tick(); quiet = false; render(); }, setMode, toggleDemo, toggleStart, get state() { return { S, ref, steps, clock, pos, odo, video, area, trail, refTrail, offset, outPower, settings, refs }; }, resync, restoreRide, newRide, showRides, getArea, selectRef, buildFit: () => Array.from(buildFit(S, { indoor: indoorMode() })), links, live, setCtlMode };
