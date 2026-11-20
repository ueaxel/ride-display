#!/usr/bin/env python3
"""Test material for the video screen: two rides that share a road and then
split (A turns right, B turns left), their watch .fit files, and matching
360° equirectangular test videos with the video time burned in.

  python3 Display/tests/make_video_fixtures.py OUTDIR

Ride A has a 30-s stop (red light) at 700 m. Its video's MP4 creation time is
written in local time as if it were UTC (as cameras often do), 20 s after the
ride starts; ride B's video has the correct UTC time, 15 s after its start.
Videos are VP9 in MP4 (plays in any Chrome; real GoPro exports are H.264/HEVC).
"""
import math
from pathlib import Path
import struct
import subprocess
import sys

FIT_EPOCH = 631065600
LAT0, LON0 = 47.6, -122.3
COS = math.cos(math.radians(LAT0))
TZ = -8 * 3600                       # Pacific, winter


def path_point(points, s):
    """Point at distance s along a polyline of (x, y) metres."""
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        L = math.hypot(bx - ax, by - ay)
        if s <= L:
            f = s / L
            return ax + f * (bx - ax), ay + f * (by - ay)
        s -= L
    return points[-1]


def length(points):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))


def write_fit(path, points, start_unix, stop_at=None, stop_s=0):
    body = bytearray()
    rec = [(253, 4, 0x86), (0, 4, 0x85), (1, 4, 0x85), (2, 2, 0x84), (3, 1, 0x02), (4, 1, 0x02), (5, 4, 0x86), (6, 2, 0x84)]
    body += bytes([0x40, 0, 0]) + struct.pack('<HB', 20, len(rec)) + b''.join(bytes(f) for f in rec)
    body += bytes([0x41, 0, 0]) + struct.pack('<HB', 21, 3) + bytes([253, 4, 0x86, 0, 1, 0, 1, 1, 0])
    body += bytes([0x42, 0, 0]) + struct.pack('<HB', 34, 2) + bytes([253, 4, 0x86, 5, 4, 0x86])
    ts0 = start_unix - FIT_EPOCH
    body += bytes([1]) + struct.pack('<IBB', ts0, 0, 0)
    total = length(points)
    dist, t, stopped = 0.0, 0, 0
    while dist < total:
        speed = 8.0 + 1.5 * math.sin(t / 25.0)
        if stop_at is not None and dist >= stop_at and stopped < stop_s:
            speed = 0.0
            stopped += 1
        dist = min(total, dist + speed)
        x, y = path_point(points, dist)
        lat, lon = LAT0 + y / 110540.0, LON0 + x / (111320.0 * COS)
        alt = 50 + 10 * math.sin(dist / 400.0)
        body += bytes([0]) + struct.pack('<IiiHBBIH', ts0 + t, int(lat * 2**31 / 180), int(lon * 2**31 / 180),
                                         int((alt + 500) * 5), 120 + t % 20, 85 if speed else 0, int(dist * 100), int(speed * 1000))
        t += 1
    body += bytes([1]) + struct.pack('<IBB', ts0 + t, 0, 4)
    body += bytes([2]) + struct.pack('<II', ts0 + t, ts0 + t + TZ)
    header = struct.pack('<BBHI4sH', 14, 0x20, 2100, len(body), b'.FIT', 0)
    Path(path).write_bytes(header + body + b'\0\0')
    return t


def write_video(path, label, seconds, creation_iso, color):
    font = '/usr/share/fonts/truetype/google-fonts/ofl/opensans/OpenSans[wdth,wght].ttf'
    texts = []
    for frac, name in [(0.5, 'FRONT'), (0.75, 'RIGHT'), (0.25, 'LEFT'), (0.0, 'BACK')]:
        texts.append(f"drawtext=fontfile='{font}':text='{label} {name} %{{pts\\:hms}}':x=w*{frac}-tw/2:y=h*0.48:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.6")
    texts.append(f"drawtext=fontfile='{font}':text='SKY':x=w*0.5-tw/2:y=h*0.08:fontsize=30:fontcolor=white")
    texts.append(f"drawtext=fontfile='{font}':text='ROAD':x=w*0.5-tw/2:y=h*0.88:fontsize=30:fontcolor=white")
    vf = 'drawgrid=w=iw/12:h=ih/6:t=2:c=white@0.4,' + ','.join(texts)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'color=c={color}:s=1024x512:r=10:d={seconds}',
                    '-vf', vf, '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8',
                    '-metadata', f'creation_time={creation_iso}', '-movflags', '+faststart', str(path)], check=True)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'video_fixtures')
    out.mkdir(parents=True, exist_ok=True)
    start_a = 1794765600          # 2026-11-15 18:00:00 UTC = 10:00 local
    start_b = start_a + 86400     # next day
    a = [(0, 0), (0, 1500), (1000, 1500)]       # north, then right (east)
    b = [(0, 0), (0, 1500), (-1000, 1500)]      # north, then left (west)
    dur_a = write_fit(out / 'RideA.fit', a, start_a, stop_at=700, stop_s=30)
    dur_b = write_fit(out / 'RideB.fit', b, start_b)
    import datetime as dt
    local_a = dt.datetime.utcfromtimestamp(start_a + 20 + TZ).strftime('%Y-%m-%dT%H:%M:%SZ')   # camera clock in local time
    utc_b = dt.datetime.utcfromtimestamp(start_b + 15).strftime('%Y-%m-%dT%H:%M:%SZ')
    write_video(out / 'GS010001.mp4', 'A', dur_a - 30, local_a, '0x1d4f2a')
    write_video(out / 'GS010002.mp4', 'B', dur_b - 25, utc_b, '0x2a1d4f')
    print(f'ride A {dur_a} s, ride B {dur_b} s -> {out}')


if __name__ == '__main__':
    main()
