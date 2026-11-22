#!/usr/bin/env python3
"""Make one ride video for the Ride Display app from a Garmin ride and the
GoPro recordings made during it.

  python3 tools/make_ride_video.py [FOLDER] [--fit FILE] [--dry-run]

The folder holds:
  - the watch ride:  *.fit  (or several; the one the videos fall into is used)
  - GoPro originals:  GoPro MAX  GS01xxxx.360, GS02xxxx.360 ...  (chapters)
                      GoPro HERO GX01xxxx.MP4 / GH01xxxx.MP4 ...
  - for .360 files nothing else is needed: they are converted to 360°
    (equirectangular) video here (needs ffmpeg; takes about as long as the
    ride). Full-length exports from GoPro Player, if present, are used
    instead (matched to the originals by length).

What it does:
  1. Reads the GPS time (UTC) from each original's telemetry track: exact,
     whatever the camera clock says. Without a GPS fix it falls back on the
     camera clock (less exact; check with Sync in the app).
  2. Fine-tunes the time by laying the camera's GPS track over the watch's.
  3. Converts .360 recordings without an export (the camera's two lens
     tracks -> one equirectangular picture), keeping the camera's gravity
     sensor so the app can level the horizon, then joins chapters and
     separate recordings into one .mp4 (needs ffmpeg when there is more
     than one piece).
  4. Embeds the ride (.fit) and the timing in the video, so the app needs
     nothing else: RideVideo_YYMMDD_HHMM.mp4 next to the inputs.
"""
import base64
import bisect
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import estimate_power  # noqa: E402  (FIT reader)

FIT_EPOCH = 631065600
RIDE_UUID = bytes.fromhex('5269646544697370b1a7e0c35e6f9a21')   # "RideDisp" + random: the app looks for this box
GOPRO = re.compile(r'^G([XHSO])(\d\d)(\d{4})\.(360|MP4)$', re.I)       # HERO6+ / MAX: GX011234 = chapter 01 of 1234
GOPRO_OLD = re.compile(r'^G(OPR|P\d\d)(\d{4})\.MP4$', re.I)              # HERO5 and older: GOPR1234, then GP011234 ...


def say(msg):
    print(msg, flush=True)


# ----------------------------------------------------------------- MP4 boxes

def boxes(f, start, end):
    """Yield (type, payload_start, box_end) for boxes in [start, end)."""
    p = start
    while p + 8 <= end:
        f.seek(p)
        h = f.read(16)
        size, typ = struct.unpack('>I4s', h[:8])
        head = 8
        if size == 1:
            size = struct.unpack('>Q', h[8:16])[0]
            head = 16
        elif size == 0:
            size = end - p
        if size < 8:
            return
        yield typ.decode('latin1'), p + head, p + size
        p += size


def find(f, start, end, path):
    for typ, a, b in boxes(f, start, end):
        if typ == path[0]:
            return (a, b) if len(path) == 1 else find(f, a, b, path[1:])
    return None


def mp4_info(path):
    """Duration, creation time and the telemetry (gpmd) samples of a file."""
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        moov = find(f, 0, size, ['moov'])
        if not moov:
            raise ValueError(f'{path.name}: not a readable video (no index); is the export finished?')
        a, b = find(f, *moov, ['mvhd'])
        f.seek(a)
        v = f.read(1)[0]
        f.seek(a + 4)
        if v == 1:
            created, _, scale, dur = struct.unpack('>QQIQ', f.read(28))
        else:
            created, _, scale, dur = struct.unpack('>IIII', f.read(16))
        info = {'duration': dur / scale, 'created': created - 2082844800 if created else None, 'gpmd': None,
                'width': None, 'height': None}
        for typ, ta, tb in boxes(f, *moov):
            if typ != 'trak':
                continue
            stbl = find(f, ta, tb, ['mdia', 'minf', 'stbl'])
            mdhd = find(f, ta, tb, ['mdia', 'mdhd'])
            if not stbl or not mdhd:
                continue
            sa, sb = find(f, *stbl, ['stsd'])
            f.seek(sa + 8 + 4)
            fmt = f.read(4).decode('latin1')
            if fmt in ('hvc1', 'hev1', 'avc1') and info['width'] is None:
                f.seek(sa + 8 + 8 + 24)
                info['width'], info['height'] = struct.unpack('>HH', f.read(4))
            if fmt != 'gpmd':
                continue
            f.seek(mdhd[0])
            mv = f.read(1)[0]
            f.seek(mdhd[0] + (20 if mv == 1 else 12))
            tscale = struct.unpack('>I', f.read(4))[0]
            info['gpmd'] = read_samples(f, stbl, tscale)
    return info


def read_samples(f, stbl, tscale):
    """[(start_s, duration_s, bytes)] of a track."""
    def table(name):
        r = find(f, *stbl, [name])
        if not r:
            return None
        f.seek(r[0])
        return f.read(r[1] - r[0])
    stts, stsz, stsc = table('stts'), table('stsz'), table('stsc')
    stco, co64 = table('stco'), table('co64')
    durs = []
    n = struct.unpack('>I', stts[4:8])[0]
    for i in range(n):
        cnt, d = struct.unpack('>II', stts[8 + 8 * i:16 + 8 * i])
        durs += [d] * cnt
    fixed, count = struct.unpack('>II', stsz[4:12])
    sizes = [fixed] * count if fixed else list(struct.unpack(f'>{count}I', stsz[12:12 + 4 * count]))
    if co64:
        nc = struct.unpack('>I', co64[4:8])[0]
        offs = list(struct.unpack(f'>{nc}Q', co64[8:8 + 8 * nc]))
    else:
        nc = struct.unpack('>I', stco[4:8])[0]
        offs = list(struct.unpack(f'>{nc}I', stco[8:8 + 4 * nc]))
    ns = struct.unpack('>I', stsc[4:8])[0]
    runs = [struct.unpack('>III', stsc[8 + 12 * i:20 + 12 * i]) for i in range(ns)]
    out, k, t = [], 0, 0
    for ci, off in enumerate(offs):
        per = next(r[1] for r in reversed(runs) if r[0] <= ci + 1)
        for _ in range(per):
            if k >= len(sizes):
                break
            f.seek(off)
            out.append((t / tscale, durs[k] / tscale if k < len(durs) else 1.0, f.read(sizes[k])))
            off += sizes[k]
            t += durs[k] if k < len(durs) else tscale
            k += 1
    return out


# ----------------------------------------------------------------- GoPro telemetry (GPMF)

def gpmf(data, p=0, end=None, scal=None, out=None):
    """Collect GPSU / GPSF / GPS5 / GPS9 from one payload."""
    end = len(data) if end is None else end
    out = {} if out is None else out
    while p + 8 <= end:
        key = data[p:p + 4].decode('latin1')
        typ, size, rep = chr(data[p + 4]), data[p + 5], struct.unpack('>H', data[p + 6:p + 8])[0]
        n = size * rep
        body = data[p + 8:p + 8 + n]
        if typ == '\x00':
            gpmf(data, p + 8, p + 8 + n, None, out)
        elif key == 'SCAL':
            fmt = {'l': 'i', 'L': 'I', 's': 'h', 'S': 'H'}.get(typ)
            if fmt:
                scal = list(struct.unpack(f'>{n // struct.calcsize(fmt)}{fmt}', body))
                out['_scal'] = scal
        elif key == 'GRAV' and typ == 's':
            sc = (out.get('_scal') or [1])[0] or 1
            vals = struct.unpack(f'>{n // 2}h', body)
            out['GRAV'] = [(vals[i] / sc, vals[i + 1] / sc, vals[i + 2] / sc) for i in range(0, len(vals) - 2, 3)]
        elif key == 'GPSU':
            out['GPSU'] = body.decode('latin1', 'replace')
        elif key == 'GPSF':
            out['GPSF'] = struct.unpack('>I', body[:4])[0]
        elif key == 'GPS5' and typ == 'l':
            sc = out.get('_scal') or [1] * 5
            vals = struct.unpack(f'>{n // 4}i', body)
            out['GPS5'] = [(vals[i] / sc[0], vals[i + 1] / sc[1]) for i in range(0, len(vals) - 4, 5)]
        elif key == 'GPS9':
            # lat, lon, alt, speed2d, speed3d, days since 2000, seconds of day, DOP, fix
            sc = out.get('_scal') or [1] * 9
            rows = []
            for i in range(0, n - size + 1, size):
                lat, lon = struct.unpack('>ii', body[i:i + 8])
                days, secs = struct.unpack('>iI', body[i + 20:i + 28])
                fix = struct.unpack('>H', body[i + 30:i + 32])[0] if size >= 32 else 3
                rows.append((lat / sc[0], lon / sc[1], days / sc[5], secs / sc[6], fix))
            out['GPS9'] = rows
        p += 8 + ((n + 3) & ~3)
    return out


def parse_gpsu(s):
    s = s.strip('\x00 ')
    try:
        base = dt.datetime.strptime(s[:12], '%y%m%d%H%M%S').replace(tzinfo=dt.timezone.utc)
        return base.timestamp() + float('0' + s[12:]) if len(s) > 12 else base.timestamp()
    except ValueError:
        return None


def camera_track(info):
    """GPS time anchors and positions from the telemetry:
    returns (offset, positions): video second 0 = UTC `offset`;
    positions = [(video_s, lat, lon)] with a fix."""
    anchors, pos = [], []
    for start, dur, data in info['gpmd'] or []:
        g = gpmf(data)
        if 'GPS9' in g:                                   # HERO13 / MAX2: time per point
            rows = [r for r in g['GPS9'] if r[4] >= 2]
            for i, (lat, lon, days, secs, fix) in enumerate(g['GPS9']):
                t = start + dur * i / max(1, len(g['GPS9']))
                if fix >= 2:
                    pos.append((t, lat, lon))
                    anchors.append(946684800 + days * 86400 + secs - t)
            continue
        fix = g.get('GPSF', 0)
        pts = g.get('GPS5') or []
        if fix >= 2 and g.get('GPSU'):
            u = parse_gpsu(g['GPSU'])
            if u:
                anchors.append(u - start)                # GPSU stamps the start of the payload
            for i, (lat, lon) in enumerate(pts):
                pos.append((start + dur * i / len(pts), lat, lon))
    if not anchors:
        return None, pos
    anchors.sort()
    return anchors[len(anchors) // 2], pos


def camera_gravity(info, hz=5):
    """Gravity direction in the camera (GoPro MAX GRAV), averaged to `hz`
    samples per second of video: [(x, y, z)] or None."""
    pts = []
    for start, dur, data in info['gpmd'] or []:
        g = gpmf(data).get('GRAV') or []
        for i, v in enumerate(g):
            pts.append((start + dur * i / len(g), v))
    if not pts:
        return None
    n = int(math.ceil(info['duration'] * hz))
    acc = [[0.0, 0.0, 0.0, 0] for _ in range(n)]
    for t, (x, y, z) in pts:
        k = min(n - 1, max(0, int(t * hz)))
        a = acc[k]
        a[0] += x; a[1] += y; a[2] += z; a[3] += 1
    out, last = [], None
    for a in acc:
        if a[3]:
            m = math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2) or 1
            last = (a[0] / m, a[1] / m, a[2] / m)
        out.append(last)
    first = next((v for v in out if v), None)
    return [v or first for v in out]


# ----------------------------------------------------------------- .360 -> equirectangular

# A GoPro MAX .360 has two HEVC tracks (0 and 5), 4096 x 1344 each, holding
# three cube faces side by side (equi-angular cubemap). The left and right
# faces are split down the middle where the two lenses meet, with a 128-px
# strip seen by both lenses; 64 px of it, widened to 96, close the gap.
# Stacked, the two rows are YouTube's EAC layout, which ffmpeg's v360 turns
# into an equirectangular picture.
def eac_filter(width):
    parts = [(624, 0, None), (64, 624, 96), (624, 752, None), (1344, 1376, None),
             (624, 2720, None), (64, 3344, 96), (624, 3472, None)]
    rows = []
    for t, s in (('a', 0), ('b', 5)):
        f = [f'[0:{s}]split=7' + ''.join(f'[{t}i{i}]' for i in range(7))]
        for i, (w, x, sc) in enumerate(parts):
            f.append(f'[{t}i{i}]crop={w}:1344:{x}:0' + (f',scale={sc}:1344' if sc else '') + f'[{t}p{i}]')
        f.append(''.join(f'[{t}p{i}]' for i in range(7)) + f'hstack=7[row{t}]')
        rows.append(';'.join(f))
    return ';'.join(rows) + f';[rowa][rowb]vstack,v360=eac:e:w={width}:h={width // 2},format=yuv420p[v]'


def video_encoders(ff):
    out = subprocess.run([ff, '-hide_banner', '-encoders'], capture_output=True, text=True).stdout
    return [(e, a) for e, a in [('hevc_videotoolbox', ['-b:v', '60M', '-tag:v', 'hvc1']),
                                 ('libx265', ['-preset', 'faster', '-crf', '24', '-tag:v', 'hvc1']),
                                 ('libx264', ['-preset', 'veryfast', '-crf', '20'])] if e in out]


def convert_360(ff, src, dst, duration, encoders):
    """One .360 chapter -> equirectangular .mp4 (picture + sound)."""
    for enc, args in encoders:
        for width in (5376, 4096):
            cmd = [ff, '-v', 'error', '-y', '-i', str(src), '-filter_complex', eac_filter(width),
                   '-map', '[v]', '-map', '0:a:0?', '-c:v', enc, *args, '-c:a', 'copy',
                   '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', str(dst)]
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            shown = -1
            for line in p.stdout:
                if line.startswith('out_time_us='):
                    try:
                        pct = int(int(line.split('=')[1]) / 1e6 / duration * 100)
                    except ValueError:
                        continue
                    if pct >= shown + 10:
                        shown = pct - pct % 10
                        say(f'    {src.name}: {min(100, shown)} %')
            err = p.stderr.read()
            if p.wait() == 0:
                return enc, width
            say(f'    ({enc} at {width} px did not work: {err.strip().splitlines()[-1] if err.strip() else "?"}; trying another way)')
    raise SystemExit(f'Could not convert {src.name} with ffmpeg.')


# ----------------------------------------------------------------- watch ride

def read_fit(path):
    data = path.read_bytes()
    _, _, msgs = estimate_power.parse(data)
    recs, tz = [], None
    for m in msgs:
        if m['kind'] != 'data':
            continue
        v = m['values']
        if m['glob'] == 20 and 253 in v:
            lat = v.get(0)
            lon = v.get(1)
            recs.append((v[253] + FIT_EPOCH,
                         lat * 180 / 2**31 if lat is not None and lat != 0x7FFFFFFF else None,
                         lon * 180 / 2**31 if lon is not None and lon != 0x7FFFFFFF else None))
        elif m['glob'] == 34 and 253 in v and 5 in v:
            tz = v[5] - v[253]
    if not recs:
        raise ValueError(f'{path.name}: no ride records')
    return {'path': path, 'data': data, 'start': recs[0][0], 'end': recs[-1][0], 'recs': recs, 'tz': tz}


def metres(lat1, lon1, lat2, lon2):
    k = math.cos(math.radians(lat1))
    return math.hypot((lat2 - lat1) * 110540, (lon2 - lon1) * 111320 * k)


def refine(offset, pos, ride, window=8.0):
    """Shift (s) that lays the camera GPS track best over the watch track."""
    rts = [r[0] for r in ride['recs'] if r[1] is not None]
    rll = [(r[1], r[2]) for r in ride['recs'] if r[1] is not None]
    if len(rts) < 10 or len(pos) < 20:
        return 0.0, None
    sample = pos[::max(1, len(pos) // 400)]

    def cost(shift):
        ds = []
        for t, lat, lon in sample:
            u = offset + t + shift
            i = bisect.bisect_left(rts, u)
            if i <= 0 or i >= len(rts):
                continue
            f = (u - rts[i - 1]) / max(1e-6, rts[i] - rts[i - 1])
            la = rll[i - 1][0] + f * (rll[i][0] - rll[i - 1][0])
            lo = rll[i - 1][1] + f * (rll[i][1] - rll[i - 1][1])
            ds.append(metres(lat, lon, la, lo))
        if len(ds) < 10:
            return None
        ds.sort()
        return ds[len(ds) // 2]
    best = None
    for k in range(int(-window * 10), int(window * 10) + 1):
        c = cost(k / 10)
        if c is not None and (best is None or c < best[1]):
            best = (k / 10, c)
    return best if best else (0.0, None)


# ----------------------------------------------------------------- matching files

def gopro_key(name):
    m = GOPRO_OLD.match(name)
    if m:
        return (m.group(2), 0 if m.group(1).upper() == 'OPR' else int(m.group(1)[1:]))
    m = GOPRO.match(name)
    return (m.group(3), int(m.group(2))) if m else None


def plan(folder, fit_choice=None):
    files = sorted(p for p in folder.iterdir() if p.is_file() and not p.name.startswith(('.', '_claude', '_ridevideo')))
    fits = [p for p in files if p.suffix.lower() == '.fit' and not p.name.startswith('RideDisplay_')]
    originals = [p for p in files if gopro_key(p.name)]
    exports = [p for p in files if p.suffix.lower() in ('.mp4', '.mov') and not gopro_key(p.name)
               and not p.name.startswith('RideVideo_')]
    if not originals:
        raise SystemExit('No GoPro originals (GS01xxxx.360, GX01xxxx.MP4 ...) found in ' + str(folder))
    say(f'Reading {len(originals)} GoPro original(s)...')
    pieces = []
    for p in originals:
        info = mp4_info(p)
        off, pos = camera_track(info)
        pieces.append({'orig': p, 'info': info, 'offset': off, 'pos': pos, 'key': gopro_key(p.name)})
        say(f'  {p.name}: {info["duration"]:.1f} s, ' + (f'GPS time {dt.datetime.fromtimestamp(off, dt.timezone.utc):%Y-%m-%d %H:%M:%S} UTC, {len(pos)} positions'
                                                         if off else 'no GPS fix (camera clock only)'))
    # the video to use for each original
    export_info = {}
    for e in exports:
        try:
            export_info[e] = mp4_info(e)
        except ValueError as err:
            say('  ' + str(err))
    for pc in pieces:
        if pc['orig'].suffix.lower() == '.mp4':
            pc['video'] = pc['orig']                      # HERO: the original is the video
            pc['vinfo'] = pc['info']
            continue
        d = pc['info']['duration']
        match = [e for e, i in export_info.items() if abs(i['duration'] - d) < 0.25]
        if not match:
            w = pc['info'].get('width')
            if w and w != 4096:
                raise SystemExit(f'{pc["orig"].name}: a .360 file {w} px wide (not a GoPro MAX?). This tool converts the MAX\'s '
                                 f'.360 files only; export it from GoPro Player as 360° video (full length) and put the export here.')
            pc['convert'] = True                          # done here (build), from the original
            pc['video'] = pc['orig']
            pc['vinfo'] = dict(pc['info'], width=5376, height=2688)
            continue
        pc['video'] = match[0]
        pc['vinfo'] = export_info.pop(match[0])
    # which ride
    rides = [read_fit(p) for p in fits]
    if fit_choice:
        rides = [r for r in rides if r['path'].name == fit_choice]
    def clock_guess(pc, ride):
        c = pc['info']['created']
        if not c:
            return None
        tz = ride['tz'] if ride['tz'] is not None else 0
        for cand in (c - tz, c):                           # camera clock often = local time written as UTC
            if ride['start'] - 600 < cand < ride['end'] + 600:
                return cand
        return c - tz
    def overlap(ride):
        n = 0
        for pc in pieces:
            t0 = pc['offset'] or clock_guess(pc, ride)
            if t0 and t0 < ride['end'] and t0 + pc['info']['duration'] > ride['start']:
                n += 1
        return n
    rides.sort(key=overlap, reverse=True)
    if not rides or overlap(rides[0]) == 0:
        raise SystemExit('No watch ride (.fit) found that was recorded while the camera was running.')
    ride = rides[0]
    say(f'Ride: {ride["path"].name}, {dt.datetime.fromtimestamp(ride["start"], dt.timezone.utc):%Y-%m-%d %H:%M:%S} UTC, '
        f'{(ride["end"] - ride["start"]) / 60:.1f} min')
    used = []
    for pc in pieces:
        if pc['offset'] is None:
            pc['offset'] = clock_guess(pc, ride)
            pc['method'] = 'camera clock'
        else:
            pc['method'] = 'GPS time'
        if pc['offset'] is None or not (pc['offset'] < ride['end'] and pc['offset'] + pc['info']['duration'] > ride['start']):
            continue
        shift, err = refine(pc['offset'], pc['pos'], ride, window=8 if pc['method'] == 'GPS time' else 120)
        if err is not None and err < 25:
            pc['offset'] += shift
            pc['method'] += f' + GPS track ({shift:+.1f} s, median {err:.0f} m apart)'
        used.append(pc)
    used.sort(key=lambda pc: pc['offset'])
    return ride, used


# ----------------------------------------------------------------- output

def ffmpeg_bin():
    for c in [shutil.which('ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']:
        if c and os.path.exists(c):
            return c
    return None


def build(folder, ride, used, dry_run=False):
    work = folder / '_ridevideo_work'
    todo = [pc for pc in used if pc.get('convert')]
    if todo and not dry_run:
        ff = ffmpeg_bin()
        if not ff:
            raise SystemExit('Converting .360 files needs ffmpeg. Install it once with:  brew install ffmpeg\n'
                             '(Homebrew: https://brew.sh), then run this again.')
        encoders = video_encoders(ff)
        total = sum(pc['info']['duration'] for pc in todo)
        say(f'Converting {len(todo)} .360 file(s), {total / 60:.0f} min of video, to 360° video. '
            f'This takes a while (roughly the length of the video); you can leave it running.')
        work.mkdir(exist_ok=True)
        for pc in todo:
            dst = work / (pc['orig'].stem + '_360.mp4')
            if dst.exists() and abs(mp4_info(dst)['duration'] - pc['info']['duration']) < 0.5:
                say(f'  {pc["orig"].name}: already converted')
            else:
                tmp = dst.with_name(dst.stem + '.partial.mp4')
                enc, width = convert_360(ff, pc['orig'], tmp, pc['info']['duration'], encoders)
                os.replace(tmp, dst)
                say(f'  {pc["orig"].name}: done ({enc}, {width} px wide)')
            pc['video'] = dst
            pc['vinfo'] = mp4_info(dst)
    grav, hz = [], 5
    segs, v = [], 0.0
    for pc in used:
        segs.append({'v': round(v, 3), 'r': round(pc['offset'] - ride['start'], 3),
                     'dur': round(pc['vinfo']['duration'], 3), 'src': pc['video'].name, 'orig': pc['orig'].name,
                     'sync': pc['method']})
        g = camera_gravity(pc['info'], hz) if pc.get('convert') else None
        n = int(round(pc['vinfo']['duration'] * hz))
        grav += [None] * (int(round(v * hz)) - len(grav))
        grav += (g or [None] * n)[:n] + [None] * max(0, n - len(g or []))
        v += pc['vinfo']['duration']
    for s in segs:
        say(f'  {s["src"]}: video {s["v"]:.1f} s = ride +{s["r"]:.1f} s ({s["sync"]})')
    local = ride['start'] + (ride['tz'] or 0)
    out = folder / f'RideVideo_{dt.datetime.fromtimestamp(local, dt.timezone.utc):%y%m%d_%H%M}.mp4'
    meta = {'app': 'ride-display', 'version': 1, 'fitName': ride['path'].name,
            'fit': base64.b64encode(ride['data']).decode(), 'segments': segs,
            'made': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
            'width': used[0]['vinfo']['width'], 'height': used[0]['vinfo']['height']}
    if any(grav):
        # camera's gravity direction per 1/hz s of the video (GoPro axes), for the
        # app to keep the horizon level; null where unknown (e.g. a GoPro Player export)
        meta['grav'] = {'hz': hz, 'axes': 'gopro-max', 'xyz': [round(c, 3) if g else None for g in grav for c in (g or (0, 0, 0))]}
    if dry_run:
        say(f'(dry run) would write {out.name}')
        return out, meta
    tmp = out.with_name(out.stem + '.partial.mp4')
    if len(used) == 1:
        src = used[0]['video']
        say(f'Copying {src.name} ...')
        if used[0].get('convert'):
            os.replace(src, tmp)                          # our own converted file: just move it
        elif subprocess.run(['cp', '-c', str(src), str(tmp)], capture_output=True).returncode != 0:   # APFS clone: instant
            shutil.copyfile(src, tmp)
    else:
        ff = ffmpeg_bin()
        if not ff:
            raise SystemExit('Joining several videos needs ffmpeg. Install it once with:  brew install ffmpeg\n'
                             '(Homebrew: https://brew.sh), then run this again.')
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as lst:
            for pc in used:
                lst.write("file '" + str(pc['video'].resolve()).replace("'", "'\\''") + "'\n")
        say(f'Joining {len(used)} videos (no re-encoding) ...')
        r = subprocess.run([ff, '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst.name,
                            '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', str(tmp)])
        os.unlink(lst.name)
        if r.returncode != 0:
            raise SystemExit('ffmpeg could not join the videos (are they all exported with the same settings?)')
    payload = RIDE_UUID + json.dumps(meta).encode()
    with open(tmp, 'ab') as f:                           # extra top-level box at the end; players ignore it
        f.write(struct.pack('>I4s', 8 + len(payload), b'uuid') + payload)
    os.replace(tmp, out)
    if todo and work.exists():                           # the converted pieces are inside the ride video now
        for pc in todo:
            try:
                pc['video'].unlink()
            except OSError:
                pass
        try:
            work.rmdir()
        except OSError:
            pass
    say(f'Done: {out.name} ({out.stat().st_size / 1e9:.2f} GB). Open it in Ride Display: Clips → pick files (or the folder).')
    return out, meta


def main():
    argv, fit, rest = sys.argv[1:], None, []
    i = 0
    while i < len(argv):
        if argv[i] == '--fit' and i + 1 < len(argv):
            fit = argv[i + 1]
            i += 2
            continue
        if not argv[i].startswith('--'):
            rest.append(argv[i])
        i += 1
    folder = (Path(rest[0]).expanduser() if rest else Path.cwd()).resolve()
    ride, used = plan(folder, fit)
    if not used:
        raise SystemExit('None of the GoPro recordings overlaps the ride.')
    build(folder, ride, used, dry_run='--dry-run' in sys.argv)


if __name__ == '__main__':
    main()
