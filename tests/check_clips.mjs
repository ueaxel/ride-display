// node Display/tests/check_clips.mjs VIDEO_FIXTURE_DIR — clip pairing, video timing, junctions.
// Make the fixtures first: python3 Display/tests/make_video_fixtures.py DIR
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { mp4Info, buildClips } from '../js/clips.js';
import { ClipNet } from '../js/junctions.js';
const dir = process.argv[2];
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const files = readdirSync(dir).map(n => new File([readFileSync(join(dir, n))], n));
const info = await mp4Info(files.find(f => f.name === 'GS010001.mp4'));
check('mp4 creation time read', info.created === Date.UTC(2026, 10, 15, 10, 0, 20) / 1000, JSON.stringify(info));
check('mp4 duration read', Math.abs(info.duration - 308) < 1, info.duration);
const { clips, notes } = await buildClips(files, new Map());
check('two clips paired', clips.length === 2 && clips[0].fitName === 'RideA.fit' && clips[1].fitName === 'RideB.fit', clips.map(c => c.name + '<-' + c.fitName).join(', ') + ' ' + notes.join(';'));
const [A, B] = clips;
check('A: camera local-time clock corrected (v0 = 20 s)', A.v0 === 20, A.v0);
check('B: UTC clock (v0 = 15 s)', B.v0 === 15, B.v0);
// red light in A at 700 m: video time jumps by ~30 s across it
const before = A.videoTime(690), after = A.videoTime(712);
check('A: red-light wait is skipped in video time', after - before > 25, `${before.toFixed(1)} -> ${after.toFixed(1)}`);
const net = new ClipNet(clips);
const sh = net.sharing(0, 500);
check('A and B share the road at 500 m', sh.length === 1 && sh[0].clip === 1 && Math.abs(sh[0].dist - 500) < 15, JSON.stringify(sh));
const far = net.ahead(0, 500);
check('no junction offered 1000 m before the split', far.length === 0, JSON.stringify(far));
const near = net.ahead(0, 1300);
check('junction offered 200 m before: B turns left', near.length === 1 && near[0].turn === 'left' && Math.abs(near[0].inM - 200) < 30, JSON.stringify(near));
const fromB = net.ahead(1, 1300);
check('from B, A turns right', fromB.length === 1 && fromB[0].turn === 'right', JSON.stringify(fromB));
const p = net.transfer(0, 1300, 1);
check('switch A -> B keeps position', Math.abs(p - 1300) < 10, p);
check('after the split no sharing', net.sharing(0, 2000).length === 0);
process.exit(fails ? 1 : 0);
