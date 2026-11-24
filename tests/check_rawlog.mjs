// node tests/check_rawlog.mjs — raw recording: waveform timing and the CSV
import { RawLog } from '../js/rawlog.js';
let fails = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
globalThis.indexedDB = undefined;              // no storage in node: kept in memory
const r = new RawLog();
r.start(); clearInterval(r.saveTimer);
const t0 = r.rec.start;
for (let k = 0; k < 200; k++) r.wave([1, 2, 3, 4, 5], k % 10 === 0, t0 + 100 * (k + 1));   // 5 samples / 100 ms = 50 Hz
r.add({ spo2: 97, ox_pulse: 64, pi: 2.4 }, t0 + 1000);
r.add({ hr: 63, rr_s: 0.95 }, t0 + 1500);
r.on = false;
check('sample rate ~50/s', Math.round(r.waveRate), 50);
const lines = r.csv().trim().split('\n');
check('header', lines[0].split(',').slice(0, 5), ['t_s', 'clock', 'pleth', 'beat', 'spo2']);
check('one row per sample (+ beats and readings)', lines.length - 1 >= 1000, true);
const sp = lines.find(l => l.split(',')[4] === '97').split(',');
check('SpO2 row', [sp[0], sp[5], sp[6]], ['1.000', '64', '2.4']);
const hr = lines.find(l => l.split(',')[7] === '63').split(',');
check('HR + RR on one row', [hr[0], hr[8]], ['1.500', '0.95']);
const ts = lines.slice(1).map(l => +l.split(',')[0]);
check('rows in time order', ts.every((t, i) => !i || t >= ts[i - 1]), true);
process.exit(fails ? 1 : 0);
