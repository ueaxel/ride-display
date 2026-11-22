// Ride library: every ride video (RideVideo_….mp4, made by Ride Video Maker,
// with the ride inside) in a folder and its subfolders, one entry per ride,
// ready to ride with one click. The folder is remembered (Chrome asks once per
// visit to read it again). Rides can be marked "validated" (checked to work);
// those are listed first.

import { readRideBox, saveMisc, loadMisc } from './clips.js';
import { profileFromFit } from './reference.js';

const RIDEVIDEO = /^RideVideo_.*\.mp4$/i;

function fromBase64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

// all ride videos up to two folders deep: [{ file, folder }]
async function findVideos(dir, folder = '', depth = 0, out = []) {
  for await (const e of dir.values()) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (e.kind === 'file' && RIDEVIDEO.test(e.name)) out.push({ file: await e.getFile(), folder });
    else if (e.kind === 'directory' && depth < 2) await findVideos(e, e.name, depth + 1, out);
  }
  return out;
}

// what the list shows about a ride, from the ride stored in the video (kept, keyed by file)
async function describe({ file, folder }, cache) {
  const key = `${folder}/${file.name}|${file.size}|${file.lastModified}`;
  if (cache[key]) return { ...cache[key], file, key };
  const meta = await readRideBox(file);
  if (!meta || !meta.fit) return null;
  const P = profileFromFit(fromBase64(meta.fit), { name: meta.fitName || file.name });
  let climb = 0;
  if (P.a) for (let i = 1; i < P.a.length; i++) if (P.a[i] > P.a[i - 1]) climb += P.a[i] - P.a[i - 1];
  const videoS = (meta.segments || []).reduce((s, g) => s + (g.dur || 0), 0);
  const d = {
    id: `${folder}/${file.name}`, title: folder || file.name.replace(/\.mp4$/i, ''), name: file.name, folder,
    phone: /_phone\.mp4$/i.test(file.name), start: P.start || null,
    km: P.d[P.d.length - 1] / 1000, climb: Math.round(climb), minutes: Math.round(P.t[P.t.length - 1] / 60),
    videoMin: Math.round(videoS / 60), gb: file.size / 1e9, width: meta.width || null,
  };
  cache[key] = d;
  return { ...d, file, key };
}

let current = null;                               // this visit's folder
export async function chooseLibrary() {
  const dir = await window.showDirectoryPicker({ id: 'ride-library', mode: 'read' });
  current = dir;
  await saveMisc('library', dir);
  return dir;
}

// the remembered folder, if we may read it (ask = this is a click: may ask the user)
export async function libraryFolder(ask) {
  const dir = current || await loadMisc('library');
  if (!dir) return null;
  let p = await dir.queryPermission({ mode: 'read' });
  if (p === 'prompt' && ask) p = await dir.requestPermission({ mode: 'read' });
  if (p === 'granted') { current = dir; return dir; }
  return { needsPermission: true, name: dir.name };
}

export async function scanLibrary(dir, onProgress = () => {}) {
  const found = await findVideos(dir);
  const cache = (await loadMisc('libraryCache')) || {};
  const rides = [];
  for (let i = 0; i < found.length; i++) {
    onProgress(i + 1, found.length);
    try { const r = await describe(found[i], cache); if (r) rides.push(r); } catch (e) { /* not a ride video */ }
  }
  await saveMisc('libraryCache', cache);
  const ok = validated();
  for (const r of rides) r.validated = !!ok[r.id];
  // validated first, then newest
  return rides.sort((a, b) => (b.validated - a.validated) || ((b.start || 0) - (a.start || 0)));
}

export function validated() { try { return JSON.parse(localStorage.getItem('libraryValidated') || '{}'); } catch (e) { return {}; } }
export function setValidated(name, on) {
  const v = validated();
  if (on) v[name] = Date.now(); else delete v[name];
  try { localStorage.setItem('libraryValidated', JSON.stringify(v)); } catch (e) { /* */ }
}
