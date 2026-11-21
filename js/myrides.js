// Rides recorded by this app, kept on the device (IndexedDB) so they survive
// a reload or a crash: saved every 30 s while riding and when you stop.
// From the list they can be saved as .fit or used as a reference ride.

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ride-display-rides', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('rides');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const KEEP = 30;                    // newest rides kept

export async function saveRide(S, mode, state = null) {
  if (!S.wall.length) return;
  const id = String(S.wall[0]);
  const r = (a, f) => a.map(v => v == null ? null : Math.round(v * f) / f);
  const dec = { speed: 100, dist: 10, lat: 1e6, lon: 1e6, alt: 10, refDist: 10, gapM: 10, gapS: 10, refPower: 1, refHr: 1, work: 1 };
  const S2 = {};
  for (const [k, a] of Object.entries(S)) S2[k] = dec[k] ? r(a, dec[k]) : a;
  const rec = {
    id, mode, start: S.wall[0], end: S.wall[S.wall.length - 1], seconds: S.wall.length,
    dist: S.dist[S.dist.length - 1] || 0, hasGps: S.lat.some(v => v != null), S: S2, state,
  };
  try {
    const d = await db();
    await new Promise((res, rej) => { const t = d.transaction('rides', 'readwrite'); t.objectStore('rides').put(rec, id); t.oncomplete = res; t.onerror = () => rej(t.error); });
    const all = await listRides();
    for (const old of all.slice(KEEP)) await deleteRide(old.id);
  } catch (e) { /* storage full or unavailable: the ride stays in memory */ }
}

export async function listRides() {
  try {
    const d = await db();
    const all = await new Promise(res => { const r = d.transaction('rides').objectStore('rides').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
    return all.sort((a, b) => b.start - a.start);
  } catch (e) { return []; }
}

export async function deleteRide(id) {
  try { const d = await db(); await new Promise(res => { const t = d.transaction('rides', 'readwrite'); t.objectStore('rides').delete(id); t.oncomplete = res; t.onerror = res; }); }
  catch (e) { /* */ }
}
