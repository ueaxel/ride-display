#!/usr/bin/env python3
"""Share copy of a ride video: for other people to ride, without giving away
how the original ride went.

  python3 make_ride_video.py --share RideVideo_....mp4 [--width 3840]

makes RideVideo_..._share.mp4 next to it:

  - Played by distance at one steady speed: every metre of road gets the same
    amount of video, so stops (lights, junctions, a snack) are gone and
    nobody can tell from the video where the original rider slowed down,
    stopped or rolled through.
  - Traffic lights are found in every frame (object detection, YOLOX-S) and
    covered with a flat grey patch, so nobody can see whether they were red
    or green.
  - The ride inside is only the route: position, distance and altitude at a
    steady speed. No clock time of the day, speed, power, heart rate or
    cadence of the original ride. No sound.

Needs ffmpeg, numpy and onnxruntime (python3 -m pip install --user numpy
onnxruntime); the detection model (35 MB) is downloaded on first use.
"""
import base64
import bisect
import datetime as dt
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import urllib.request

import estimate_power

FIT_EPOCH = 631065600
MODEL_URL = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx'
MODEL = Path(__file__).resolve().parent / 'models' / 'yolox_s.onnx'
TRAFFIC_LIGHT = 9            # COCO class
MIN_SCORE = 0.2              # low on purpose: a grey patch too many is harmless, one too few is not
DETECT_HZ = 3                # detections per second of output video
PAD = 0.5                    # patch margin, fraction of the light's size on each side
FPS = 30


def say(msg):
    print(msg, flush=True)


# ------------------------------------------------------------------ the ride

def read_route(fit):
    """[(ride s, distance m, lat, lon, alt)] from the .fit inside the video."""
    _, _, msgs = estimate_power.parse(fit)
    out, tz = [], None
    for m in msgs:
        if m['kind'] != 'data':
            continue
        v = m['values']
        if m['glob'] == 20 and 253 in v and 5 in v:
            lat, lon = v.get(0), v.get(1)
            ok = lat is not None and lon is not None and lat != 0x7FFFFFFF
            alt = v.get(78, v.get(2))
            out.append((v[253], v[5] / 100, lat * 180 / 2**31 if ok else None, lon * 180 / 2**31 if ok else None,
                        alt / 5 - 500 if alt is not None else None))
        elif m['glob'] == 34 and 253 in v and 5 in v:
            tz = v[5] - v[253]
    if len(out) < 2:
        raise SystemExit('The ride inside this video has no distance data.')
    t0 = out[0][0]
    return [(t - t0, d, la, lo, a) for t, d, la, lo, a in out], out[0][0], tz


def lerp(xs, ys, x):
    i = bisect.bisect_left(xs, x)
    if i <= 0:
        return ys[0]
    if i >= len(xs):
        return ys[-1]
    x0, x1 = xs[i - 1], xs[i]
    f = (x - x0) / (x1 - x0) if x1 > x0 else 0
    return ys[i - 1] + f * (ys[i] - ys[i - 1])


def steady_speed(route):
    """A speed (m/s) a little above most of the original riding, so frames are
    rarely shown twice (the app sets the playback speed to the rider's)."""
    v = sorted((b[1] - a[1]) / (b[0] - a[0]) for a, b in zip(route, route[1:]) if b[0] > a[0])
    v = [x for x in v if x > 2]
    return min(14.0, max(6.0, v[int(0.85 * (len(v) - 1))] if v else 8.0))


def first_time_at(route):
    """distance -> ride second it was first reached (stops collapse to nothing)."""
    ds, ts = [], []
    for t, d, *_ in route:
        if not ds or d > ds[-1]:
            ds.append(d)
            ts.append(t)
    return lambda d: lerp(ds, ts, d)


def video_time(segs, e):
    for s in segs:
        if s['r'] <= e <= s['r'] + s['dur']:
            return s['v'] + e - s['r']
    return None


def plan_frames(route, segs, speed, fps):
    """For each output frame: the source video second, by distance at a steady
    speed. Returns frames, new segments (synthetic ride s = distance / speed)."""
    at = first_time_at(route)
    total = route[-1][1]
    step = speed / fps
    frames, newsegs, run = [], [], None
    k = 0
    while k * step <= total:
        d = k * step
        t = video_time(segs, at(d))
        if t is None:
            run = None
        else:
            if run is None:
                run = {'v': round(len(frames) / fps, 3), 'r': round(d / speed, 3), 'dur': 0}
                newsegs.append(run)
            frames.append(t)
            run['dur'] = round((len(frames) / fps) - run['v'], 3)
        k += 1
    return frames, newsegs


def route_fit(route, speed, start_ts, tz):
    """A .fit with only the route: one record a second at the steady speed."""
    known = [r for r in route if r[2] is not None]
    kd = [r[1] for r in known]
    ad = [r[1] for r in route if r[4] is not None]
    aa = [r[4] for r in route if r[4] is not None]
    body = bytearray()
    rec = [(253, 4, 0x86), (0, 4, 0x85), (1, 4, 0x85), (2, 2, 0x84), (5, 4, 0x86), (6, 2, 0x84)]
    body += bytes([0x40, 0, 0]) + struct.pack('<HB', 20, len(rec)) + b''.join(bytes(f) for f in rec)
    body += bytes([0x41, 0, 0]) + struct.pack('<HB', 21, 3) + bytes([253, 4, 0x86, 0, 1, 0, 1, 1, 0])
    body += bytes([0x42, 0, 0]) + struct.pack('<HB', 34, 2) + bytes([253, 4, 0x86, 5, 4, 0x86])
    body += bytes([1]) + struct.pack('<IBB', start_ts, 0, 0)
    total = route[-1][1]
    n = int(math.ceil(total / speed))
    for s in range(n + 1):
        d = min(total, s * speed)
        lat = int(lerp(kd, [r[2] for r in known], d) * 2**31 / 180) if known else 0x7FFFFFFF
        lon = int(lerp(kd, [r[3] for r in known], d) * 2**31 / 180) if known else 0x7FFFFFFF
        alt = int((lerp(ad, aa, d) + 500) * 5) if aa else 0xFFFF
        body += bytes([0]) + struct.pack('<IiiHIH', start_ts + s, lat, lon, alt, int(d * 100), int(speed * 1000))
    body += bytes([1]) + struct.pack('<IBB', start_ts + n, 0, 4)
    body += bytes([2]) + struct.pack('<II', start_ts + n, start_ts + n + (tz or 0))
    header = bytearray(struct.pack('<BBHI4sH', 14, 0x20, 2100, len(body), b'.FIT', 0))
    header[12:14] = struct.pack('<H', estimate_power.crc16(bytes(header[:12])))
    data = bytes(header) + bytes(body)
    return data + struct.pack('<H', estimate_power.crc16(data))


# ------------------------------------------------------------ traffic lights

def load_detector():
    try:
        import numpy  # noqa: F401
        import onnxruntime
    except ImportError:
        raise SystemExit('Hiding traffic lights needs two Python packages. Install them once with:\n'
                         '  python3 -m pip install --user numpy onnxruntime')
    if not MODEL.exists():
        say('Downloading the traffic-light detector (35 MB, once) ...')
        MODEL.parent.mkdir(exist_ok=True)
        tmp = MODEL.with_suffix('.partial')
        urllib.request.urlretrieve(MODEL_URL, tmp)
        os.replace(tmp, MODEL)
    have = onnxruntime.get_available_providers()          # the Mac's Neural Engine / GPU when there
    return onnxruntime.InferenceSession(str(MODEL), providers=[p for p in ('CoreMLExecutionProvider', 'CPUExecutionProvider') if p in have])


class Detector:
    """Traffic lights in an equirectangular frame (yuv420p planes), looked for
    in square tiles along the band where they appear: 55° above the horizon to
    15° below, all the way round."""
    SIZE = 640

    def __init__(self, sess, w, h):
        import numpy as np
        self.np, self.sess, self.w, self.h = np, sess, w, h
        self.name = sess.get_inputs()[0].name
        self.y0 = int(h * 35 / 180)
        self.side = int(h * 105 / 180) - self.y0
        n = math.ceil(w / (self.side * 0.85))
        self.xs = [int(i * w / n) for i in range(n)]
        pick = (np.arange(self.SIZE) * self.side / self.SIZE).astype(int)
        self.pick = pick
        grids, strides = [], []
        for s in (8, 16, 32):
            g = self.SIZE // s
            yy, xx = np.meshgrid(np.arange(g), np.arange(g), indexing='ij')
            grids.append(np.stack([xx, yy], -1).reshape(-1, 2))
            strides.append(np.full((g * g, 1), s))
        self.grid, self.stride = np.concatenate(grids), np.concatenate(strides)

    def boxes(self, Y, U, V):
        np = self.np
        out = []
        rows = self.y0 + self.pick
        for x0 in self.xs:
            cols = (x0 + self.pick) % self.w
            y = Y[rows][:, cols].astype(np.float32)
            u = U[rows // 2][:, cols // 2].astype(np.float32) - 128
            v = V[rows // 2][:, cols // 2].astype(np.float32) - 128
            bgr = np.stack([y + 1.772 * u, y - 0.344 * u - 0.714 * v, y + 1.402 * v], 0).clip(0, 255)
            p = self.sess.run(None, {self.name: bgr[None]})[0][0]
            score = p[:, 4] * p[:, 5 + TRAFFIC_LIGHT]
            keep = score > MIN_SCORE
            if not keep.any():
                continue
            xy = (p[keep, :2] + self.grid[keep]) * self.stride[keep]
            wh = np.exp(p[keep, 2:4]) * self.stride[keep]
            f = self.side / self.SIZE
            for (cx, cy), (bw, bh) in zip(xy * f, wh * f):
                out.append((x0 + cx - bw / 2, self.y0 + cy - bh / 2, bw, bh))
        return out


def patches(prev, cur):
    """Grey patches for the frames between two detections: every light seen
    at either end, and the stretch between the two sightings of one light."""
    out = list(prev) + list(cur)
    for (x, y, w, h) in prev:
        near = [b for b in cur if abs(b[0] - x) < 4 * max(w, h) + 40 and abs(b[1] - y) < 4 * max(w, h) + 40]
        for (x2, y2, w2, h2) in near:
            out.append((min(x, x2), min(y, y2), max(x + w, x2 + w2) - min(x, x2), max(y + h, y2 + h2) - min(y, y2)))
    return out


def cover(Y, U, V, rects, w, h):
    """Flat grey over each rectangle (wrapping round the 360° seam)."""
    for (x, y, bw, bh) in rects:
        px, py = bw * PAD + 4, bh * PAD + 4
        a, b = int(max(0, y - py)) & ~1, int(min(h, y + bh + py + 2)) & ~1
        x0, x1 = int(x - px) & ~1, int(x + bw + px + 2) & ~1
        for c0, c1 in ([(x0 % w, x1 % w)] if x0 // w == x1 // w else [(x0 % w, w), (0, x1 % w)]):
            if c1 <= c0 or b <= a:
                continue
            Y[a:b, c0:c1] = int(Y[a:b, c0:c1].mean())
            U[a // 2:b // 2, c0 // 2:c1 // 2] = 128
            V[a // 2:b // 2, c0 // 2:c1 // 2] = 128


# ------------------------------------------------------------------ the video

def encoders(ff):
    out = subprocess.run([ff, '-hide_banner', '-encoders'], capture_output=True, text=True).stdout
    return ([('h264_videotoolbox', ['-b:v', '24M', '-profile:v', 'high'])] if 'h264_videotoolbox' in out else []) + \
        [('libx264', ['-preset', 'veryfast', '-crf', '22', '-maxrate', '30M', '-bufsize', '60M', '-profile:v', 'high'])]


def source_fps(ff, src):
    probe = Path(ff).with_name('ffprobe')
    cmd = [str(probe) if probe.exists() else 'ffprobe', '-v', 'error', '-select_streams', 'v:0',
           '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', str(src)]
    a, b = subprocess.run(cmd, capture_output=True, text=True).stdout.strip().split('/')
    return float(a) / float(b or 1)


def make_share(src, ff, read_ride_meta, mp4_info, ride_uuid, width=3840, hide_lights=True):
    src = Path(src).expanduser().resolve()
    meta = read_ride_meta(src)
    if not meta:
        raise SystemExit(f'{src.name} is not a ride video made by this tool (no ride inside).')
    if meta.get('shareCopy'):
        raise SystemExit(f'{src.name} is already a share copy.')
    sess = load_detector() if hide_lights else None
    route, start_ts, tz = read_route(base64.b64decode(meta['fit']))
    speed = steady_speed(route)
    frames, segs = plan_frames(route, meta['segments'], speed, FPS)
    if not frames:
        raise SystemExit('The video covers none of the ride.')
    info = mp4_info(src)
    sw, sh = info.get('width') or width, info.get('height') or width // 2
    w = min(width, sw) & ~1
    h = (w // 2 if sw == 2 * sh else int(sh * w / sw)) & ~1
    sfps = source_fps(ff, src)
    out = src.with_name(src.stem.replace('_phone', '') + '_share.mp4')
    tmp = out.with_name(out.stem + '.partial.mp4')
    say(f'Making a share copy of {src.name}: {w} x {h}, steady {speed * 3.6:.0f} km/h, '
        f'{len(frames) / FPS / 60:.0f} min of video' + (', hiding traffic lights' if sess else '') + ' ...')
    import numpy as np
    dec = subprocess.Popen([ff, '-v', 'error', '-i', str(src), '-map', '0:v:0', '-vf', f'scale={w}:{h}',
                            '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
    det = Detector(sess, w, h) if sess else None
    fsize = w * h * 3 // 2
    lights = 0
    for enc, args in encoders(ff):
        dec_frame, cur, src_i = None, None, -1
        ok = True
        enc_p = subprocess.Popen([ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', f'{w}x{h}',
                                  '-r', str(FPS), '-i', '-', '-c:v', enc, *args, '-pix_fmt', 'yuv420p',
                                  '-movflags', '+faststart', str(tmp)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        every = FPS // DETECT_HZ
        buf, prev_boxes, shown = [], [], -1
        try:
            for k, t in enumerate(frames):
                want = int(round(t * sfps))
                while src_i < want:
                    raw = dec.stdout.read(fsize)
                    if len(raw) < fsize:
                        break
                    cur, src_i = raw, src_i + 1
                if cur is None:
                    raise SystemExit('Could not read the video.')
                buf.append(cur)
                if det and (k % every == 0 or k == len(frames) - 1):
                    a = np.frombuffer(cur, np.uint8)
                    boxes = det.boxes(a[:w * h].reshape(h, w), a[w * h:w * h * 5 // 4].reshape(h // 2, w // 2),
                                      a[w * h * 5 // 4:].reshape(h // 2, w // 2))
                    lights += bool(boxes)
                    rects = patches(prev_boxes, boxes)
                    for fr in buf:
                        if rects:
                            a = np.frombuffer(fr, np.uint8).copy()
                            cover(a[:w * h].reshape(h, w), a[w * h:w * h * 5 // 4].reshape(h // 2, w // 2),
                                  a[w * h * 5 // 4:].reshape(h // 2, w // 2), rects, w, h)
                            fr = a.tobytes()
                        enc_p.stdin.write(fr)
                    buf, prev_boxes = [], boxes
                elif not det:
                    enc_p.stdin.write(buf.pop())
                pct = int(100 * k / len(frames))
                if pct >= shown + 5:
                    shown = pct - pct % 5
                    say(f'    {shown} %')
            for fr in buf:
                enc_p.stdin.write(fr)
            enc_p.stdin.close()
        except BrokenPipeError:
            ok = False
        err = enc_p.stderr.read().decode(errors='replace')
        if enc_p.wait() == 0 and ok:
            break
        say(f'    ({enc} did not work: {err.strip().splitlines()[-1] if err.strip() else "?"}; trying another way)')
        dec.kill()
        dec = subprocess.Popen(dec.args, stdout=subprocess.PIPE)
    else:
        raise SystemExit('ffmpeg could not make the share copy.')
    dec.kill()
    new = {'app': 'ride-display', 'version': 1, 'fitName': 'route.fit',
           'fit': base64.b64encode(route_fit(route, speed, start_ts, tz)).decode(),
           'segments': segs, 'made': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
           'width': w, 'height': h, 'shareCopy': True, 'steadyKmh': round(speed * 3.6, 1)}
    g = meta.get('grav')
    if g:
        hz, xyz = g['hz'], g['xyz']
        n = len(xyz) // 3
        res = []
        for i in range(int(len(frames) / FPS * hz)):
            j = int(round(frames[min(len(frames) - 1, int(i * FPS / hz))] * hz))
            res += xyz[3 * j:3 * j + 3] if j < n else [None] * 3
        new['grav'] = dict(g, xyz=res)
    payload = ride_uuid + json.dumps(new).encode()
    with open(tmp, 'ab') as f:
        f.write(struct.pack('>I4s', 8 + len(payload), b'uuid') + payload)
    os.replace(tmp, out)
    say(f'Done: {out.name} ({out.stat().st_size / 1e9:.2f} GB)' +
        (f'; traffic lights covered in {lights} of {math.ceil(len(frames) / every)} checks' if det else '') +
        '. Watch it once before sharing: lights the detector missed stay visible.')
    return out
