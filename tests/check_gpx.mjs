// node tests/check_gpx.mjs — .gpx references: a planned route (no times) and a recorded ride.
import { readFileSync } from 'fs';
import { profileFromGpx, Reference, steadySpeed } from '../js/reference.js';
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', n, i); };
// steady speed: flat 160 W about 30 km/h, 8 % climb about 9 km/h
const flat = steadySpeed(160, 0) * 3.6, climb = steadySpeed(160, 0.08) * 3.6;
check('flat 160 W 27-33 km/h', flat > 27 && flat < 33, flat.toFixed(1));
check('8 % at 160 W 7-11 km/h', climb > 7 && climb < 11, climb.toFixed(1));
// planned route shipped with the app
const route = readFileSync(new URL('../routes/OYJ Dublin Grade Light.gpx', import.meta.url), 'utf8');
const r = new Reference(profileFromGpx(route, { watts: 160 }));
check('route name from the file', r.name === 'OYJ Dublin Grade Light', r.name);
check('route about 50 km', Math.abs(r.total - 50140) < 500, r.total);
check('route has map and grade', r.hasRoute && r.hasAlt && r.hasPower);
check('time increases along the route', r.prof.t.every((t, i) => !i || t >= r.prof.t[i - 1]));
check('ghost 1.5-2.5 h at 160 W', r.totalTime > 5400 && r.totalTime < 9000, (r.totalTime / 60).toFixed(0) + ' min');
check('speed within 6-50 km/h', Math.min(...r.prof.v) >= 5.9 && Math.max(...r.prof.v) <= 50.1);
check('more power = faster ghost', new Reference(profileFromGpx(route, { watts: 220 })).totalTime < r.totalTime);
check('untilKm cuts the route', Math.abs(new Reference(profileFromGpx(route, { untilKm: 10 })).total - 10000) < 50);
// recorded ride: 3 points 10 s apart, 100 m each, with HR
const pt = (lat, s, hr) => `<trkpt lat="${lat}" lon="-122.25"><ele>10</ele><time>2026-11-22T10:00:${String(s).padStart(2, '0')}Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`;
const rec = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Test ride</name><trkseg>${pt(37.8, 0, 100)}${pt(37.8009, 10, 110)}${pt(37.8018, 20, 120)}</trkseg></trk></gpx>`;
const q = profileFromGpx(rec);
check('recorded: own times', Math.abs(q.t[q.t.length - 1] - 20) < 0.5, q.t[q.t.length - 1]);
check('recorded: HR read', q.hr.some(h => h >= 110), q.hr.slice(0, 3));
check('recorded: start time', q.start === Date.parse('2026-11-22T10:00:00Z') / 1000);
let bad = false; try { profileFromGpx('<html></html>'); } catch (e) { bad = true; }
check('not a gpx file is refused', bad);
process.exit(fails ? 1 : 0);
