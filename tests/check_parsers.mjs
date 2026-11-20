// node Display/tests/check_parsers.mjs — Bluetooth packet parsers and the step finder.
import { parseIndoorBikeData, parseHeartRate, makeCyclingPowerParser, DemoRider } from '../js/sensors.js';
import { StepFinder } from '../js/hrmodel.js';
import { powerCommand, simCommand } from '../js/sensors.js';
const dv = bytes => new DataView(new Uint8Array(bytes).buffer);
let fails = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
// FTMS: speed 40.00 km/h, cadence 90 rpm, power 200 W
check('FTMS speed+cadence+power', parseIndoorBikeData(dv([0x44, 0x00, 0xA0, 0x0F, 0xB4, 0x00, 0xC8, 0x00])), { speed: 40, cadence: 90, power: 200 });
// FTMS with avg speed, distance, resistance, power, HR
check('FTMS with skipped fields', parseIndoorBikeData(dv([0x76, 0x02, 0xE8, 0x03, 0x00, 0x00, 0xB4, 0x00, 0x10, 0x27, 0x00, 0x05, 0x00, 0x2C, 0x01, 0x8C])),
  { speed: 10, cadence: 90, power: 300, hr: 140 });
check('HR uint8', parseHeartRate(dv([0x00, 72])), { hr: 72, rr: [], contact: null });
check('HR uint16 + RR', parseHeartRate(dv([0x11, 0x2C, 0x01, 0x00, 0x04])), { hr: 300, rr: [1], contact: null });
check('HR no skin contact', parseHeartRate(dv([0x04, 60])).contact, false);
check('HR skin contact', parseHeartRate(dv([0x06, 61])).contact, true);
const cp = makeCyclingPowerParser();
cp(dv([0x20, 0x00, 0xFA, 0x00, 0x0A, 0x00, 0x00, 0x04]));
check('Cycling power + cadence', cp(dv([0x20, 0x00, 0xFA, 0x00, 0x0B, 0x00, 0xAB, 0x06])), { power: 250, cadence: 60 / ((0x06AB - 0x0400) / 1024) });
check('FTMS set power 250 W', powerCommand(250), [0x05, 0xFA, 0x00]);
check('FTMS grade +5 %', simCommand(0.05), [0x11, 0, 0, 0xF4, 0x01, 55, 20]);
check('FTMS grade -2.5 %', simCommand(-0.025), [0x11, 0, 0, 0x06, 0xFF, 55, 20]);
// step finder on the demo rider (6-s delay, tau 25 s up / 40 s down)
const d = new DemoRider(), P = [], H = [];
for (let i = 0; i < 1200; i++) { const s = d.next(); P.push(s.power); H.push(s.hr); }
const f = new StepFinder(); f.update(P, H);
const sum = f.summary();
check('steps found', f.steps.length >= 5, true);
check('delay 4-7 s', sum.upDelay >= 4 && sum.upDelay <= 7, true);
check('tau up 20-32 s', sum.upTau > 20 && sum.upTau < 32, true);
check('tau down 32-46 s', sum.downTau > 32 && sum.downTau < 46, true);
process.exit(fails ? 1 : 0);
