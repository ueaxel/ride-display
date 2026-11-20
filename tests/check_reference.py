#!/usr/bin/env python3
"""Check Display/js/reference.js against tools/make_reference.py and
tools/estimate_power.py on a synthetic ride (hills, a timer pause, coasting).

Usage: python3 Display/tests/check_reference.py   (needs node)
"""
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
import estimate_power  # noqa: E402
import make_reference  # noqa: E402


def write_fit(path):
    body = bytearray()
    # local 0: record
    rec_fields = [(253, 4, 0x86), (0, 4, 0x85), (1, 4, 0x85), (2, 2, 0x84), (3, 1, 0x02),
                  (4, 1, 0x02), (5, 4, 0x86), (6, 2, 0x84)]
    body += bytes([0x40, 0, 0]) + struct.pack('<HB', 20, len(rec_fields))
    body += b''.join(bytes(f) for f in rec_fields)
    # local 1: event, local 2: user profile (weight)
    body += bytes([0x41, 0, 0]) + struct.pack('<HB', 21, 3) + bytes([253, 4, 0x86, 0, 1, 0, 1, 1, 0])
    body += bytes([0x42, 0, 0]) + struct.pack('<HB', 3, 1) + bytes([4, 2, 0x84])
    body += bytes([2]) + struct.pack('<H', 765)
    ts0 = 1_000_000_000
    body += bytes([1]) + struct.pack('<IBB', ts0, 0, 0)          # timer start
    dist, lat, lon = 0.0, 47.6, -122.3
    t = 0
    while t < 1200:
        if t == 400:                                             # pause 25 s
            body += bytes([1]) + struct.pack('<IBB', ts0 + t, 0, 4)
            t += 25
            body += bytes([1]) + struct.pack('<IBB', ts0 + t, 0, 0)
        speed = 8.0 + 2.5 * math.sin(t / 60.0) + (0 if t < 900 else -1.5)
        coasting = 600 <= t < 640
        dist += speed
        heading = dist / 900.0
        lat += speed * math.cos(heading) / 110540.0
        lon += speed * math.sin(heading) / (111320.0 * math.cos(math.radians(47.6)))
        alt = 120 + 30 * math.sin(dist / 700.0) + 5 * math.sin(dist / 90.0)
        hr = 120 + 30 * (1 - math.exp(-t / 120.0)) + 5 * math.sin(t / 40.0)
        body += bytes([0]) + struct.pack(
            '<IiiHBBIH', ts0 + t, int(lat * 2**31 / 180), int(lon * 2**31 / 180),
            int((alt + 500) * 5), int(hr), 0 if coasting else 85, int(dist * 100), int(speed * 1000))
        t += 1
    header = struct.pack('<BBHI4sH', 14, 0x20, 2100, len(body), b'.FIT', 0)
    Path(path).write_bytes(header + body + b'\0\0')


def main():
    tmp = Path(tempfile.mkdtemp())
    fit = tmp / 'ride.fit'
    write_fit(fit)
    # Python reference: profile (no power) and estimated power per record.
    records = make_reference.load_ride(str(fit))
    prof = make_reference.build_profile([dict(r) for r in records], 5.0)
    data = fit.read_bytes()
    _, _, msgs = estimate_power.parse(data)
    recs, events = [], []
    for m in msgs:
        if m['kind'] != 'data':
            continue
        v = m['values']
        if m['glob'] == 20 and 5 in v:
            alt = v.get(78, v.get(2))
            recs.append({'ts': v[253], 'dist': v[5] / 100.0, 'alt': alt / 5.0 - 500.0,
                         'cadence': v.get(4)})
        elif m['glob'] == 21 and v.get(0) == 0:
            events.append((v[253], v.get(1)))
    estimate_power.estimate(recs, events, 76.5 + 1.0 + 10.5, 0.32, 0.0055)
    py_power = [r['power'] for r in recs]

    step = prof['step']   # the watch caps points at 1500; use the same spacing
    js = f"""
import {{ readFileSync }} from 'fs';
import {{ loadRide, buildProfile, estimatePower }} from '{ROOT}/Display/js/reference.js';
const buf = readFileSync('{fit}');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const a = loadRide(ab);
const prof = buildProfile(a.records.map(r => ({{...r}})), {step});
const b = loadRide(ab);
estimatePower(b.records, b.events, {{riderKg: 76.5, extraKg: 1, bikeKg: 10.5, cda: 0.32, crr: 0.0055}});
console.log(JSON.stringify({{prof, power: b.records.map(r => r.power), riderKg: a.riderKg}}));
"""
    (tmp / 'run.mjs').write_text(js)
    out = json.loads(subprocess.check_output(['node', str(tmp / 'run.mjs')]))
    jp = out['prof']
    fails = 0

    # make_reference.interp() returns the ride's LAST value for distances
    # before the first record (here the first 2 points), so skip those.
    skip = sum(1 for d in prof['d'] if d < records[0]['dist'])

    def check(name, a, b, tol):
        nonlocal fails
        if name != 'estimated power':
            # smoothed channels also average over the bad start points
            k = skip + (8 if name in ('x', 'y', 'grade class', 'altitude') else 0)
            a, b = a[k:], b[k:]
        if len(a) != len(b):
            print(f'FAIL {name}: length {len(a)} vs {len(b)}')
            fails += 1
            return
        worst = max(abs(x - y) for x, y in zip(a, b))
        ok = worst <= tol
        fails += 0 if ok else 1
        print(f'{"ok  " if ok else "FAIL"} {name}: {len(a)} values, max diff {worst:.3g} (tol {tol})')

    check('distance', prof['d'], jp['d'], 1e-6)
    check('moving time', prof['t'], jp['t'], 0.06)
    check('speed km/h', prof['v'], jp['v'], 0.06)
    check('heart rate', prof['hr'], jp['hr'], 0.51)
    check('x', prof['x'], jp['x'], 0.06)
    check('y', prof['y'], jp['y'], 0.06)
    check('grade class', prof['g'], jp['g'], 0)
    check('altitude', prof['a'], jp['a'], 0.06)
    check('estimated power', py_power, out['power'], 1)
    print(f'rider weight from file: {out["riderKg"]} kg; moving time {jp["t"][-1]:.0f} s '
          f'(pause removed: {"yes" if jp["t"][-1] < 1190 else "no"})')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
