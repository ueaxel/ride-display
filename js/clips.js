// Video clips: a GoPro video plus the watch .fit of the same ride.
// The .fit gives the route and, for every point, the clock time since the
// ride's start (prof.e). The video's own start time (from the MP4 header) and
// a per-clip correction tell which second of video belongs to which point:
//   videoTime(dist) = prof.e(dist) - v0      (v0 = ride seconds at video 0:00)
import { profileFromFit, Reference, RIDER } from './reference.js';
import { fitFromZip } from './fitwriter.js';

const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const RIDE = /\.(fit|zip)$/i;

// ------------------------------------------------------------ MP4 header

// Creation time (Unix s) and duration (s) from the 'mvhd' box, reading only
// the few bytes needed (videos are gigabytes).
export async function mp4Info(file) {
  const read = async (pos, len) => new DataView(await file.slice(pos, pos + len).arrayBuffer());
  let pos = 0;
  for (let guard = 0; guard < 64 && pos + 8 <= file.size; guard++) {
    const h = await read(pos, 16);
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    let head = 8;
    if (size === 1) { size = Number(h.getBigUint64(8)); head = 16; }
    if (size === 0) size = file.size - pos;
    if (type === 'moov') {
      let p = pos + head;
      const end = pos + size;
      while (p + 8 <= end) {
        const b = await read(p, 8);
        const bsize = b.getUint32(0);
        const btype = String.fromCharCode(b.getUint8(4), b.getUint8(5), b.getUint8(6), b.getUint8(7));
        if (btype === 'mvhd') {
          const m = await read(p + 8, 40);
          const version = m.getUint8(0);
          let created, scale, dur;
          if (version === 1) { created = Number(m.getBigUint64(4)); scale = m.getUint32(20); dur = Number(m.getBigUint64(24)); }
          else { created = m.getUint32(4); scale = m.getUint32(12); dur = m.getUint32(16); }
          return { created: created ? created - 2082844800 : null, duration: scale ? dur / scale : null };
        }
        if (bsize < 8) break;
        p += bsize;
      }
      return { created: null, duration: null };
    }
    if (size < 8) break;
    pos += size;
  }
  return { created: null, duration: null };
}

// First guess of v0: the camera clock is often local time written as UTC, so
// try the file's time zone too, and keep the one that falls inside the ride.
export function guessV0(prof, info) {
  if (!info.created || !prof.start) return 0;
  const tz = prof.tz ?? -new Date(prof.start * 1000).getTimezoneOffset() * 60;
  const cands = [0, -tz, tz].map(c => info.created + c - prof.start);
  const inside = cands.filter(v => v > -120 && v < prof.duration + 60);
  return Math.round(inside.length ? inside[0] : cands[0]);
}

// ------------------------------------------------------------ clip objects

export class Clip {
  constructor({ id, name, fitName, prof, v0 = 0, duration = null, created = null, synced = false, worldLock = false, forward = 0, roll = 0, tilt = 0 }) {
    Object.assign(this, { id, name, fitName, v0, duration, created, synced, worldLock, forward, roll, tilt });
    this.prof = prof;
    this.ref = new Reference(prof);
    this.file = null;          // the video File (picked each session)
    this.url = null;
  }
  get label() { return this.name.replace(VIDEO, ''); }
  // Second of video for a distance along the route (may be outside the video).
  videoTime(dist) { return this.ref.elapsedAt(dist) - this.v0; }
  distAtVideo(t) { return this.ref.distAtElapsed(t + this.v0); }
  covers(dist) { const t = this.videoTime(dist); return t >= 0 && t <= (this.duration || Infinity); }
  // part of the route the video covers
  get videoRange() {
    const a = this.distAtVideo(0), b = this.duration ? this.distAtVideo(this.duration) : this.ref.total;
    return [a, b];
  }
  // Direction of travel (radians clockwise from north) at a distance.
  heading(dist) {
    const [ax, ay] = this.ref.xy(Math.max(0, dist - 20)), [bx, by] = this.ref.xy(Math.min(this.ref.total, dist + 20));
    return Math.atan2(bx - ax, by - ay);
  }
  setFile(file) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.file = file; this.url = URL.createObjectURL(file);
  }
  toJSON() {
    const { id, name, fitName, v0, duration, created, synced, worldLock, forward, roll, tilt, prof } = this;
    return { id, name, fitName, v0, duration, created, synced, worldLock, forward, roll, tilt, prof };
  }
}

// ------------------------------------------------------------ storage (IndexedDB)

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ride-display-clips', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('clips'); req.result.createObjectStore('misc'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export const saveClip = clip => tx('clips', 'readwrite', s => s.put(JSON.parse(JSON.stringify(clip)), clip.id)).catch(() => {});
export const deleteClip = id => tx('clips', 'readwrite', s => s.delete(id)).catch(() => {});
export async function loadClips() {
  try { return ((await tx('clips', 'readonly', s => s.getAll())) || []).map(c => new Clip(c)); } catch (e) { return []; }
}
export const saveMisc = (k, v) => tx('misc', 'readwrite', s => s.put(v, k)).catch(() => {});
export async function loadMisc(k) { try { return await tx('misc', 'readonly', s => s.get(k)); } catch (e) { return null; } }

export const clipId = file => `${file.name}|${file.size}`;

// ------------------------------------------------------------ pairing

async function readRide(file, rider) {
  let buf = await file.arrayBuffer();
  if (/\.zip$/i.test(file.name)) buf = await fitFromZip(buf);
  return profileFromFit(buf, { rider, name: file.name.replace(RIDE, '') });
}

// Pair videos with rides: by time (video start inside the ride, any time
// zone), else by file name. `known` = clips already in storage (by id).
// Returns { clips, notes }.
export async function buildClips(files, known, rider = RIDER, onProgress = () => {}) {
  const videos = files.filter(f => VIDEO.test(f.name)), rides = files.filter(f => RIDE.test(f.name));
  const notes = [];
  const out = [];
  const unmatched = [];                        // videos whose ride couldn't be found by time or name
  const needRides = videos.some(v => !known.has(clipId(v)));
  const profs = [];
  if (needRides) {
    for (const [i, f] of rides.entries()) {
      onProgress(`Reading ride ${i + 1} of ${rides.length}: ${f.name}`);
      try { profs.push({ file: f, prof: await readRide(f, rider) }); }
      catch (e) { notes.push(`${f.name}: ${e.message}`); }
    }
  }
  for (const v of videos) {
    const id = clipId(v);
    let clip = known.get(id);
    if (!clip) {
      onProgress(`Reading video ${v.name}`);
      const info = await mp4Info(v).catch(() => ({ created: null, duration: null }));
      let best = null;
      for (const r of profs) {
        if (!r.prof.x) continue;
        const v0 = guessV0(r.prof, info);
        const inside = info.created && v0 > -120 && v0 < r.prof.duration + 60;
        const sameName = r.file.name.replace(RIDE, '').toLowerCase() === v.name.replace(VIDEO, '').toLowerCase();
        const score = (inside ? 2 : 0) + (sameName ? 1 : 0);
        if (score && (!best || score > best.score)) best = { score, r, v0: inside ? v0 : 0 };
      }
      if (!best) { unmatched.push({ file: v, info }); continue; }
      clip = new Clip({ id, name: v.name, fitName: best.r.file.name, prof: best.r.prof, v0: best.v0,
        duration: info.duration, created: info.created, synced: false });
      await saveClip(clip);
    }
    clip.setFile(v);
    out.push(clip);
  }
  out.sort((a, b) => (a.prof.start || 0) - (b.prof.start || 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  linkChapters(out);
  return { clips: out, notes, unmatched, rides: profs.filter(r => r.prof.x) };
}

// Pair a video with a ride by hand (e.g. exported videos carry the export
// time, not the recording time). Sync it afterwards.
export async function pairByHand(video, info, ride) {
  const clip = new Clip({ id: clipId(video), name: video.name, fitName: ride.file.name, prof: ride.prof,
    v0: 0, duration: info.duration, created: info.created, synced: false });
  await saveClip(clip);
  clip.setFile(video);
  return clip;
}

// Videos of the same ride are chapters of one recording (GoPro splits at
// 4 GB: GS01xxxx, GS02xxxx...), in file-name order. They share one route
// object, and each chapter starts where the one before ended, so only one
// of them needs syncing. `anchor` = the chapter whose sync is the truth.
export function linkChapters(clips, anchor = null) {
  const groups = new Map();
  for (const c of clips) {
    const k = c.fitName + '|' + (c.prof.start || '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    g.forEach((c, i) => { c.chapter = i; c.chapters = g; c.ref = g[0].ref; });
    if (g.length < 2) continue;
    const a = g.includes(anchor) ? anchor : g.find(c => c.synced) || g[0];
    let start = a.v0;
    for (let i = g.indexOf(a) - 1; i >= 0; i--) start -= g[i].duration || 0;
    for (const c of g) { if (c.v0 !== start || (a.synced && !c.synced)) { c.v0 = start; c.synced = a.synced; saveClip(c); } start += c.duration || 0; }
  }
  return clips;
}

// All files of a folder picked with showDirectoryPicker (Chrome on Mac/PC).
export async function filesInFolder(dir) {
  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && (VIDEO.test(entry.name) || RIDE.test(entry.name))) files.push(await entry.getFile());
  }
  return files;
}
export const folderPickerAvailable = () => 'showDirectoryPicker' in window;
