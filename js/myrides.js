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

export async function saveRide(S, mode) {
  if (!S.wall.length) return;
  const id = String(S.wall[0]);
  const r2 = (a, f) => a.map(v => v == null ? null : Math.round(v * f) / f);
  const rec = {
    id, mode, start: S.wall[0], end: S.wall[S.wall.length - 1], seconds: S.wall.length,
    dist: S.dist[S.dist.length - 1] || 0, hasGps: S.lat.some(v => v != null),
    S: { power: S.power, hr: S.hr, cad: S.cad, speed: r2(S.speed, 100), dist: r2(S.dist, 10), lat: r2(S.lat, 1e6), lon: r2(S.lon, 1e6),
      alt: r2(S.alt || [], 10), wall: S.wall },
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
