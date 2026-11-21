// The video screen: the ride video fills the screen (360°: drag to look
// around, scroll to zoom), and the numbers, map, HR-vs-power plot and traces
// float on top. Panels can be dragged and resized; they stay where you put
// them relative to the screen, whatever the video does.
import { VideoView, VideoFollower } from './view360.js';
import { ClipNet } from './junctions.js';
import { buildClips, pairByHand, loadClips, saveClip, deleteClip, filesInFolder, folderPickerAvailable, saveMisc, loadMisc } from './clips.js';
import { downloadStreets, saveStreets, loadStreets } from './streets.js';
import * as D from './draw.js';

const DEFAULT_LAYOUT = {
  numbers: { x: 0.012, y: 0.085, w: 0.36, h: 0.17, on: true },
  map: { x: 0.735, y: 0.52, w: 0.255, h: 0.46, on: true },
  scatter: { x: 0.012, y: 0.6, w: 0.27, h: 0.38, on: true },
  trace: { x: 0.30, y: 0.76, w: 0.42, h: 0.22, on: false },
};

export function initVideoScreen(api) {
  const { $ } = api;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } },
  };
  const screen = $('videoScreen');
  const view = new VideoView($('vStage'));
  const follower = new VideoFollower(view);
  let clips = [], net = null, cur = -1, choices = [], dirHandle = null, syncing = false, mapWhole = false;
  let layout = { ...DEFAULT_LAYOUT, ...store.get('videoLayout', {}) };
  const savedView = store.get('videoView', null);
  if (savedView) Object.assign(view, savedView);
  view.onViewChange = () => store.set('videoView', { yaw: view.yaw, pitch: view.pitch, fov: view.fov });

  // ---------------------------------------------------------------- panels
  const panels = [...screen.querySelectorAll('.float[data-panel]')];
  function place(p) {
    const L = layout[p.dataset.panel];
    Object.assign(p.style, { left: `${L.x * 100}%`, top: `${L.y * 100}%`, width: `${L.w * 100}%`, height: `${L.h * 100}%` });
    p.style.display = L.on ? '' : 'none';
  }
  function saveLayout() { store.set('videoLayout', layout); }
  for (const p of panels) {
    place(p);
    const name = p.dataset.panel, head = p.querySelector('.fhead'), grip = p.querySelector('.grip');
    head.querySelector('.fclose').onclick = () => { layout[name] = { ...layout[name], on: false }; place(p); saveLayout(); fillPanelMenu(); };
    const drag = (el, resize) => el.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const W = screen.clientWidth, H = screen.clientHeight, L0 = { ...layout[name] }, x0 = e.clientX, y0 = e.clientY;
      const move = ev => {
        const dx = (ev.clientX - x0) / W, dy = (ev.clientY - y0) / H, L = { ...L0 };
        if (resize) { L.w = Math.max(0.12, Math.min(1 - L.x, L0.w + dx)); L.h = Math.max(0.1, Math.min(1 - L.y, L0.h + dy)); }
        else { L.x = Math.max(0, Math.min(1 - L.w, L0.x + dx)); L.y = Math.max(0, Math.min(1 - L.h, L0.y + dy)); }
        layout[name] = L; place(p); draw();
      };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); saveLayout(); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
    drag(head, false); drag(grip, true);
  }
  function fillPanelMenu() {
    const box = $('vPanelList');
    box.innerHTML = '';
    for (const [name, label] of [['numbers', 'Numbers'], ['map', 'Map'], ['scatter', 'HR vs power'], ['trace', 'Power & HR over time']]) {
      const b = document.createElement('button');
      b.textContent = (layout[name].on ? '✓ ' : '') + label;
      b.onclick = () => { layout[name] = { ...layout[name], on: !layout[name].on }; panels.forEach(place); saveLayout(); fillPanelMenu(); draw(); };
      box.appendChild(b);
    }
  }
  $('vPanelsReset').onclick = () => { layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); panels.forEach(place); saveLayout(); fillPanelMenu(); draw(); };
  $('btnPanels').onclick = () => { fillPanelMenu(); $('dlgPanels').showModal(); };
  $('vPanelsClose').onclick = () => $('dlgPanels').close();
  $('btnLook').onclick = () => view.resetView(clips[cur]?.forward || 0);
  $('btnForward').onclick = async () => {
    const c = clips[cur];
    if (!c) return;
    c.forward = view.yaw; await saveClip(c);
    api.banner(`Forward for ${c.label} saved: Look ahead now returns to this view.`);
    setTimeout(() => api.banner(''), 3000);
  };
  $('btnTurn').onclick = async () => {
    const c = clips[cur];
    if (!c) return;
    c.worldLock = !c.worldLock; await saveClip(c); updateTurnBtn();
  };
  function updateTurnBtn() {
    const c = clips[cur], b = $('btnTurn');
    b.textContent = c && c.worldLock ? '✓ Turn with road' : 'Turn with road';
    b.title = 'For videos exported with World Lock on: turn the view with the road';
  }
  $('mapWhole').onclick = e => { mapWhole = !mapWhole; e.target.textContent = mapWhole ? 'Follow' : 'Whole route'; draw(); };

  // header auto-hide while riding: move the mouse or touch to bring it back
  let hideTimer = null;
  const wake = () => { document.body.classList.remove('chromeless'); clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (api.running && document.body.dataset.mode === 'video' && !syncing) document.body.classList.add('chromeless'); }, 4000); };
  ['pointermove', 'pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, wake));

  // ---------------------------------------------------------------- clips
  async function refreshClips(files) {
    const known = new Map((await loadClips()).map(c => [c.id, c]));
    $('vClipNotes').textContent = 'Reading…';
    const { clips: list, notes, unmatched: un, rides } = await buildClips(files, known, api.rider, msg => { $('vClipNotes').textContent = msg; });
    clips = list; unmatched = un; rideChoices = rides;
    net = clips.length ? new ClipNet(clips) : null;
    $('vClipNotes').innerHTML = notes.map(n => `<div class="err">${n}</div>`).join('') +
      (clips.length ? `${clips.length} clip${clips.length > 1 ? 's' : ''} ready.` : unmatched.length ? '' : 'No videos found.') +
      (unmatched.length ? ` ${unmatched.length} video${unmatched.length > 1 ? 's need' : ' needs'} its ride chosen below.` : '');
    fillClipList();
    // streets for each clip (online, once)
    for (const c of clips) {
      if (!(await loadStreets('clip:' + c.id)) && navigator.onLine && c.ref.hasRoute) {
        try { await saveStreets('clip:' + c.id, await downloadStreets(c.prof)); } catch (e) { /* later */ }
      }
    }
  }
  let unmatched = [], rideChoices = [];
  function fillClipList() {
    const box = $('vClipList');
    box.innerHTML = '';
    // videos that need their ride chosen by hand
    for (const u of unmatched) {
      const row = document.createElement('div');
      row.className = 'cliprow';
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="">which ride is this?</option>' + rideChoices.map((r, k) => {
        const when = r.prof.start ? new Date(r.prof.start * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
        return `<option value="${k}">${r.file.name} — ${when}, ${(r.prof.d[r.prof.d.length - 1] / 1000).toFixed(1)} km</option>`;
      }).join('');
      row.innerHTML = `<div><b>${u.file.name}</b><br><span class="warn">${u.info.duration ? fmtMin(u.info.duration) + ' video · ' : ''}ride not found by time or name — choose it:</span></div>`;
      const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = 'Pair';
      ok.onclick = async () => {
        if (sel.value === '') return;
        const clip = await pairByHand(u.file, u.info, rideChoices[+sel.value]);
        unmatched = unmatched.filter(x => x !== u);
        clips.push(clip); net = new ClipNet(clips);
        fillClipList();
        $('vClipNotes').textContent = `Paired ${clip.label} — now tap Sync to line it up with the route.`;
      };
      row.append(sel, ok);
      box.appendChild(row);
    }
    clips.forEach((c, i) => {
      const [a, b] = c.videoRange;
      const row = document.createElement('div');
      row.className = 'cliprow' + (i === cur ? ' current' : '');
      const when = c.prof.start ? new Date(c.prof.start * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      row.innerHTML = `<div><b>${c.label}</b><br><span class="muted">${when} · ride ${(c.ref.total / 1000).toFixed(1)} km · ` +
        `video ${c.duration ? fmtMin(c.duration) : '?'} covers ${(Math.max(0, a) / 1000).toFixed(1)}–${(Math.min(c.ref.total, b) / 1000).toFixed(1)} km · ` +
        `${c.synced ? '<span class="good">synced</span>' : '<span class="warn">sync not checked</span>'}</span></div>`;
      const ride = document.createElement('button'); ride.className = 'primary'; ride.textContent = 'Ride this';
      ride.onclick = () => { startClip(i, Math.max(0, a)); $('dlgClips').close(); };
      const sync = document.createElement('button'); sync.textContent = 'Sync';
      sync.onclick = () => { $('dlgClips').close(); openSync(i); };
      const del = document.createElement('button'); del.textContent = 'Forget';
      del.onclick = async () => { await deleteClip(c.id); clips.splice(i, 1); net = clips.length ? new ClipNet(clips) : null; if (cur === i) cur = -1; fillClipList(); };
      row.append(ride, sync, del);
      box.appendChild(row);
    });
  }
  const fmtMin = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

  $('btnClips').onclick = () => { fillClipList(); $('dlgClips').showModal(); };
  $('vClipsClose').onclick = () => $('dlgClips').close();
  $('vFolder').style.display = folderPickerAvailable() ? '' : 'none';
  $('vFolder').onclick = async () => {
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'ride-videos', mode: 'read' });
      await saveMisc('folder', dirHandle);
      await refreshClips(await filesInFolder(dirHandle));
    } catch (e) { if (e.name !== 'AbortError') $('vClipNotes').textContent = e.message; }
  };
  $('vFiles').onchange = async e => { await refreshClips([...e.target.files]); e.target.value = ''; };
  // reopen last folder (Chrome asks once per visit)
  $('vReopen').onclick = async () => {
    const h = await loadMisc('folder');
    if (!h) { $('vClipNotes').textContent = 'No folder chosen yet.'; return; }
    try {
      if ((await h.queryPermission({ mode: 'read' })) !== 'granted' && (await h.requestPermission({ mode: 'read' })) !== 'granted') return;
      dirHandle = h; await refreshClips(await filesInFolder(h));
    } catch (e) { $('vClipNotes').textContent = e.message; }
  };

  function startClip(i, p) {
    cur = i; setTimeout(updateTurnBtn);
    const c = clips[i];
    view.load(c.url);
    view.resetView(c.forward || 0);
    api.switchRef(c.ref, p, 'clip:' + c.id);
    $('vMsg').textContent = '';
    choices = [];
    showJunction();
    draw();
  }

  // ---------------------------------------------------------------- junctions
  function showJunction() {
    const box = $('vJunction');
    if (!choices.length) { box.style.display = 'none'; return; }
    const arrow = { left: '↰', right: '↱', straight: '↑', continue: '→' };
    box.style.display = 'flex';
    box.innerHTML = `<div class="jtitle">Junction in ${Math.max(0, Math.round(choices[0].inM / 10) * 10)} m</div>`;
    const keep = document.createElement('button');
    keep.textContent = `1 · stay on ${clips[cur].label}`;
    keep.onclick = () => { choices.forEach(ch => dismissed.add(jkey(ch))); choices = []; showJunction(); };
    box.appendChild(keep);
    choices.forEach((ch, n) => {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = `${n + 2} · ${arrow[ch.turn]} ${ch.turn === 'continue' ? 'continue on' : 'turn ' + ch.turn + ':'} ${clips[ch.clip].label}`;
      b.onclick = () => takeTurn(ch);
      box.appendChild(b);
    });
  }
  const dismissed = new Set();                    // junctions you chose to ride past
  const jkey = ch => `${cur}:${ch.clip}:${Math.round(ch.at / 50)}`;
  function takeTurn(ch) {
    const p = net.transfer(cur, api.pos, ch.clip);
    if (p == null) return;
    const lookOff = view.yaw - (clips[cur].forward || 0);      // keep where you were looking
    cur = ch.clip; setTimeout(updateTurnBtn);
    const c = clips[cur];
    view.load(c.url);
    view.yaw = (c.forward || 0) + lookOff;
    api.switchRef(c.ref, p, 'clip:' + c.id);
    choices = []; showJunction();
  }
  window.addEventListener('keydown', e => {
    if (document.body.dataset.mode !== 'video' || !choices.length) return;
    const n = parseInt(e.key, 10);
    if (n === 1) { choices.forEach(ch => dismissed.add(jkey(ch))); choices = []; showJunction(); }
    else if (n >= 2 && choices[n - 2]) takeTurn(choices[n - 2]);
  });

  // ---------------------------------------------------------------- sync
  // Find a recognisable spot in the video, then click it on the map.
  let syncClip = -1;
  function openSync(i) {
    syncing = true; syncClip = i; syncChanged = false;
    const c = clips[i];
    if (cur !== i) { cur = i; view.load(c.url); api.switchRef(c.ref, Math.max(0, c.videoRange[0]), 'clip:' + c.id); }
    screen.classList.add('syncing');
    $('vSync').style.display = 'flex';
    view.video.pause();
    drawSync();
  }
  function closeSync() {
    syncing = false; screen.classList.remove('syncing'); $('vSync').style.display = 'none';
    const c = clips[syncClip];
    if (c && !api.running) api.switchRef(c.ref, Math.max(0, c.videoRange[0]), 'clip:' + c.id);   // start where the video starts
    draw();
  }
  function drawSync() {
    if (!syncing) return;
    const c = clips[syncClip], v = view.video;
    const d = c.distAtVideo(v.currentTime || 0);
    D.drawRoute($('vSyncMap'), c.ref, { you: Math.max(0, Math.min(c.ref.total, d)), view: 'all', streets: api.streets });
    $('vSyncTime').textContent = `video ${fmtMin(v.currentTime || 0)} · ride +${fmtMin(Math.max(0, (v.currentTime || 0) + c.v0))} · ${(d / 1000).toFixed(2)} km`;
    $('vSyncSlider').max = Math.floor(v.duration || 0);
    $('vSyncSlider').value = Math.floor(v.currentTime || 0);
  }
  const seek = dt => { const v = view.video; v.currentTime = Math.max(0, Math.min((v.duration || 0) - 0.1, v.currentTime + dt)); };
  $('vSyncBack10').onclick = () => seek(-10); $('vSyncBack1').onclick = () => seek(-1);
  $('vSyncFwd1').onclick = () => seek(1); $('vSyncFwd10').onclick = () => seek(10);
  $('vSyncPlay').onclick = () => { const v = view.video; v.playbackRate = 1; v.paused ? v.play() : v.pause(); };
  $('vSyncSlider').oninput = e => { view.video.currentTime = +e.target.value; };
  let syncChanged = false;
  $('vSyncDone').onclick = () => {
    if (!syncChanged && !clips[syncClip]?.synced) {
      $('vSyncHint').innerHTML = '<span class="warn">Not saved yet:</span> tap <b>Ride starts here</b> at the moment you started the watch, or click the matching spot on the map. Tap Done again to close anyway.';
      syncChanged = true; return;
    }
    closeSync();
  };
  // the watch recording started at this video moment (ride clock 0 s)
  $('vSyncStart').onclick = async () => {
    const c = clips[syncClip];
    c.v0 = -view.video.currentTime; c.synced = true; syncChanged = true;
    await saveClip(c);
    $('vSyncHint').textContent = `Saved: the ride starts at video ${fmtMin(view.video.currentTime)}. Check a spot later in the ride on the map, then Done.`;
    drawSync();
  };
  view.video.addEventListener('timeupdate', () => drawSync());
  $('vSyncMap').addEventListener('click', async e => {
    const c = clips[syncClip], cv = $('vSyncMap'), map = cv._toScreen;
    if (!map) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null;
    for (let i = 0; i < c.ref.n; i++) {
      const [sx, sy] = map(c.prof.x[i], c.prof.y[i]);
      const dd = (sx - x) ** 2 + (sy - y) ** 2;
      if (!best || dd < best.dd) best = { dd, d: c.prof.d[i] };
    }
    if (!best || best.dd > 40 ** 2) { $('vSyncHint').textContent = 'Click closer to the route.'; return; }
    c.v0 = c.ref.elapsedAt(best.d) - view.video.currentTime;
    c.synced = true; syncChanged = true;
    await saveClip(c);
    $('vSyncHint').textContent = `Synced: video 0:00 = ride +${fmtMin(Math.max(0, c.v0))}. Check another spot to confirm, then Done.`;
    drawSync();
  });

  // ---------------------------------------------------------------- per tick / frame
  // junction choices (1 Hz)
  function onTick() {
    if (cur < 0 || !net || syncing) return;
    const p = api.pos, c = clips[cur];
    const all = net.ahead(cur, p);
    choices = all.filter(ch => !dismissed.has(jkey(ch)));
    // end of this clip: carry on automatically on a clip that continues the road
    if (p >= c.ref.total - 5) {
      const cont = all.find(ch => ch.end);
      if (cont) { takeTurn(cont); return; }
    }
    showJunction();
  }

  // every animation frame: steer the video
  view.onFrame = () => {
    if (document.body.dataset.mode !== 'video' || syncing || cur < 0) return;
    const c = clips[cur];
    if (!c || c.ref !== api.ref) return;
    const p = api.posNow();
    const target = c.videoTime(p);
    // video seconds per metre here, times your speed
    const dvd = (c.videoTime(p + 5) - c.videoTime(p - 5)) / 10;
    const flow = api.running && api.live.moving ? Math.max(0, Math.min(4, dvd * (api.live.speedNow || 0))) : 0;
    follower.update(target, flow);
    // video exported with World Lock: its picture keeps the direction the camera
    // had when recording started, so turn the view by how much the road has turned since
    if (c.worldLock && view.is360 && c.ref.hasRoute) {
      const want = c.heading(p) - c.heading(Math.max(0, c.distAtVideo(0)));
      let diff = Math.atan2(Math.sin(want - view.extraYaw), Math.cos(want - view.extraYaw));
      view.extraYaw += diff * 0.15;                       // smooth
    } else view.extraYaw = 0;
    const msg = follower.state === 'before' ? 'The video starts a little further on' : follower.state === 'after' ? 'End of this video' : '';
    if ($('vMsg').dataset.state !== follower.state) { $('vMsg').textContent = msg; $('vMsg').dataset.state = follower.state; }
  };

  // ---------------------------------------------------------------- drawing
  let lastState = null;
  function render(state) { lastState = state; draw(); }
  function draw() {
    if (document.body.dataset.mode !== 'video' || !lastState) return;
    const { t, you, ghost, gapM, gapS, hr } = lastState;
    const S = api.S, live = api.live;
    if (layout.numbers.on) {
      const p3 = api.avgLast(S.power, 3), fresh = Date.now() - live.tPower < 3000;
      const set = (id, v) => { $(id).textContent = v; };
      set('vPower', api.running && p3 != null ? Math.round(p3) : fresh ? Math.round(live.power ?? 0) : '–');
      set('vHr', hr ?? '–');
      set('vCad', fresh && live.cadence != null ? Math.round(live.cadence) : '–');
      set('vSpeed', S.speed.length && api.running ? (api.last(S.speed) * 3.6).toFixed(1) : '–');
      set('vTime', api.fmtTime(t));
      set('vDist', (api.odo / 1000).toFixed(2));
      const g = $('vGap');
      if (api.ref && gapM != null) { g.textContent = `${api.sign(gapM)} m`; g.className = 'v ' + api.gapClass(gapM); set('vGapS', `${api.sign(gapS)} s`); }
      else { g.textContent = '–'; g.className = 'v'; set('vGapS', ''); }
      const ctl = api.links.trainer?.control;
      set('vTarget', api.ctlMode !== 'off' && ctl ? ctl.message : (api.ref?.hasPower && you != null ? `ghost ${Math.round(api.ref.at('p', you))} W` : ''));
    }
    const c = clips[cur];
    const vidAt = c && c.ref === api.ref && view.ready ? c.distAtVideo(view.video.currentTime) : null;
    if (layout.map.on) {
      D.drawRoute($('vMap'), api.ref, { you: you ?? 0, ghost, view: mapWhole ? 'all' : 'follow', span: 300, done: you ?? 0, streets: api.streets, videoAt: vidAt });
      $('vMapInfo').textContent = vidAt == null ? '' :
        `video ${fmtMin(view.video.currentTime)} = ${(vidAt / 1000).toFixed(2)} km · you ${((you ?? 0) / 1000).toFixed(2)} km · ghost ${((ghost ?? 0) / 1000).toFixed(2)} km`;
    }
    if (layout.scatter.on) D.drawScatter($('vScatter'), S.power, S.hr, S.power.length - 1, { avg: 10 });
    if (layout.trace.on) D.drawTrace($('vTrace'), S, { window: 600 });
  }
  new ResizeObserver(() => draw()).observe(screen);
  setInterval(() => { if (document.body.dataset.mode === 'video' && !view.video.paused) draw(); }, 400);

  async function enter() {
    if (!clips.length) {
      const stored = await loadClips();
      if (stored.length) $('vMsg').textContent = 'Open your video folder (Clips) to ride';
      else $('vMsg').textContent = 'Tap Clips and choose the folder with your ride videos and watch files';
    }
    wake();
  }
  function leave() { view.video.pause(); document.body.classList.remove('chromeless'); }
  function onNewRide() { choices = []; dismissed.clear(); showJunction(); }

  // tests
  window.__video = { get clips() { return clips; }, get cur() { return cur; }, get choices() { return choices; }, view, follower, startClip, takeTurn, refreshClips, openSync, net: () => net };
  return { render, onTick, enter, leave, onNewRide };
}
