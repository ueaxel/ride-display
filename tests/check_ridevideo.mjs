// node Display/tests/check_ridevideo.mjs FILE — a ride video with embedded data (tools/make_ride_video.py).
import { readFileSync } from 'fs';
import { basename } from 'path';
import { buildClips, readRideBox } from '../js/clips.js';
const path = process.argv[2];
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', n, i); };
const file = new File([readFileSync(path)], basename(path));
const meta = await readRideBox(file);
check('embedded ride data found', meta && meta.segments.length === 2, meta ? meta.fitName : 'none');
const { clips, unmatched } = await buildClips([file], new Map());
check('one clip, no pairing needed', clips.length === 1 && unmatched.length === 0 && clips[0].synced);
const c = clips[0], s = meta.segments;
// a spot 50 s into the ride: video 30 s (first piece)
const d50 = c.ref.distAtElapsed(50);
check('first piece maps ride +50 s to video 30 s', Math.abs(c.videoTime(d50) - 30) < 0.5, c.videoTime(d50).toFixed(2));
const dGap = c.ref.distAtElapsed(160);
check('camera-off gap gives no video', Number.isNaN(c.videoTime(dGap)), c.videoTime(dGap));
const d200 = c.ref.distAtElapsed(200);
check('second piece maps ride +200 s to video ' + (s[1].v + 20).toFixed(1), Math.abs(c.videoTime(d200) - (s[1].v + 20)) < 0.5, c.videoTime(d200).toFixed(2));
check('video -> route and back', Math.abs(c.videoTime(c.distAtVideo(s[1].v + 50)) - (s[1].v + 50)) < 0.6);
// sync correction moves everything
c.syncAt(c.ref.elapsedAt(d200) + 2, s[1].v + 20);
check('sync shifts all pieces', Math.abs(c.videoTime(d50) - 28) < 0.5 && Math.abs(c.videoTime(d200) - (s[1].v + 18)) < 0.5, `${c.videoTime(d50).toFixed(2)} ${c.videoTime(d200).toFixed(2)}`);
process.exit(fails ? 1 : 0);
