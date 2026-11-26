// node tests/check_ant.mjs — ANT framing, extended messages and the ANT Live decoders.
import { frame, Deframer, parseData, scanSetup, describeEvent } from '../ant-live/js/ant.js';
import { decodeAntLive, encodeAntLive, DeviceDecoder, formatValue, ANTLIVE_TYPE } from '../ant-live/js/profiles.js';
let fails = 0;
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const close = (name, got, want, tol) => { const ok = near(got, want, tol); if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `got ${got} want ${want}±${tol}`); };

// framing: reset command, checksum = XOR of all bytes
check('reset frame', [...frame(0x4A, [0])], [0xA4, 0x01, 0x4A, 0x00, 0xEF]);
check('setup opens scan last', [...scanSetup().at(-1)].slice(0, 4), [0xA4, 1, 0x5B, 0]);
check('setup network key', [...scanSetup()[1]].slice(3, 12), [0, 0xB9, 0xA5, 0x21, 0xFB, 0xBD, 0x72, 0xC3, 0x45]);

// a broadcast with channel ID + RSSI, split across two USB reads, with junk in front
const body = [0, 4, 0, 0, 0x34, 0x12, 7, 72, 0x48, 0xC0, 0x39, 0x30, 120, 0x01, 0x20, 0xC9, 0x80];
const msg = [...frame(0x4E, body)];
const df = new Deframer();
check('partial message waits', df.push([0x00, 0x13, ...msg.slice(0, 7)]), []);
const got = df.push(msg.slice(7));
check('message reassembled', got.length, 1);
const d = parseData(got[0]);
check('payload', d.payload, [4, 0, 0, 0x34, 0x12, 7, 72, 0x48]);
check('channel id', [d.deviceNumber, d.deviceType, d.transType], [12345, 120, 1]);
check('rssi', d.rssi, -55);
check('bad checksum dropped', new Deframer().push([...msg.slice(0, -1), msg.at(-1) ^ 1]), []);
check('20-bit device number', parseData({ id: 0x4E, data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 0x80, 0x01, 0x00, 11, 0x35] }).deviceNumber, 0x30001);
check('search timeout event', describeEvent({ id: 0x40, data: [0, 1, 0x01] }), 'search timeout');
check('accepted command is silent', describeEvent({ id: 0x40, data: [0, 0x42, 0] }), null);

// AntLive pages: encode as the watch does, decode as the page does
const v = { hr: 142, power: 251, cadence: 91, speed: 32.4, distance: 12.3456, timer: 3725, altitude: 87.4, ascent: 412, descent: 398,
  temperature: -3, lat: 37.70452, lon: -121.93512, heading: 270, calories: 512, avgHr: 131, maxHr: 166, avgPower: 188, avgCadence: 86,
  maxPower: 612, maxSpeed: 55.1, avgSpeed: 27.3, maxCadence: 118, trainingEffect: 2.7, energyRate: 13.25, pressure: 1009.6, spo2: 96,
  gpsQuality: 4, timerStateCode: 3, battery: 64, steps: 70123, build: 12 };
const out = {};
for (let p = 1; p <= 8; p++) decodeAntLive(encodeAntLive(p, v, 9), out);
check('fast page', [out.hr, out.power, out.cadence, out.seq], [142, 251, 91, 9]);
close('speed km/h', out.speed, 32.4, 0.02);
close('distance km', out.distance, 12.3456, 0.0001);
check('timer s', out.timer, 3725);
close('altitude', out.altitude, 87.4, 0.2);
check('ascent/descent/temp', [out.ascent, out.descent, out.temperature], [412, 398, -3]);
close('latitude', out.lat, 37.70452, 0.00003);
close('longitude', out.lon, -121.93512, 0.00003);
close('heading', out.heading, 270, 1.5);
check('averages', [out.calories, out.avgHr, out.maxHr, out.avgPower, out.avgCadence], [512, 131, 166, 188, 86]);
check('maxima', [out.maxPower, out.maxCadence], [612, 118]);
close('max speed', out.maxSpeed, 55.1, 0.02);
check('training/spo2/state', [out.trainingEffect, out.spo2, out.timerState, out.gpsAccuracy], [2.7, 96, 'running', 'good']);
close('energy rate', out.energyRate, 13.25, 0.01);
close('pressure hPa', out.pressure, 1009.6, 0.02);
check('device page', [out.battery, out.steps, out.appVersion], [64, 70123, 'v12']);
const empty = {};
for (let p = 1; p <= 8; p++) decodeAntLive(encodeAntLive(p, {}, 0), empty);
check('unknown values stay empty', [empty.hr, empty.power, empty.distance, empty.lat, empty.altitude, empty.temperature, empty.battery], [null, null, null, null, null, null, null]);

// standard ANT+ heart rate from a watch's "Broadcast Heart Rate"
const hr = new DeviceDecoder({ deviceType: 120, deviceNumber: 5, transType: 1 });
hr.decode([0x04, 0, 0x00, 0x04, 0x00, 0x08, 10, 61]);
check('HR page 4', [hr.values.hr, hr.values.rr], [61, 1000]);
// bike power page 0x10
const pw = new DeviceDecoder({ deviceType: 11, deviceNumber: 7, transType: 5 });
pw.decode([0x10, 1, 0xB2, 90, 0, 0, 0x2C, 0x01]);
check('power + cadence + balance', [pw.values.power, pw.values.cadence, pw.values.balance], [300, 90, 50]);
pw.decode([0x50, 0xFF, 0xFF, 3, 1, 0, 0x34, 0x12]);
check('common page 80', [pw.values.manufacturer, pw.values.model, pw.values.hwVersion], ['Garmin', 0x1234, 3]);
// speed & cadence: 1 s apart, 1 crank rev → 60 rpm, 4 wheel revs → 30.2 km/h
const sc = new DeviceDecoder({ deviceType: 121, deviceNumber: 9, transType: 1 }, { wheel: 2.096 });
sc.decode([0, 0, 10, 0, 0, 0, 20, 0]);
sc.decode([0, 4, 11, 0, 0, 4, 24, 0]);
check('cadence rpm', sc.values.cadence, 60);
close('speed', sc.values.speed, 4 * 2.096 * 3.6, 0.01);
// trainer FE-C
const fe = new DeviceDecoder({ deviceType: 17, deviceNumber: 3, transType: 5 });
fe.decode([0x19, 1, 85, 0, 0, 0xFA, 0x00, 0]);
check('FE-C power + cadence', [fe.values.power, fe.values.cadence], [250, 85]);
check('AntLive decoder chosen', new DeviceDecoder({ deviceType: ANTLIVE_TYPE, deviceNumber: 1 }).profile, 'Garmin watch (AntLive)');
check('timer format', formatValue('timer', 3725), '1:02:05');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
