#!/usr/bin/env python3
"""Estimate the power behind a ride recorded without a power meter, and write
it into a copy of the .fit file (record field "power"), with average and
maximum power for each lap and the whole ride.

Usage:
  python3 tools/estimate_power.py RIDE.fit OUT.fit [--rider-kg KG] [--extra-kg 1] [--bike-kg 10.5]
                                  [--cda 0.32] [--crr 0.0055]

Model (per second, from smoothed data):
  P = ( m*g*v*(sin a + Crr*cos a)        climbing + rolling
      + m_eff*acc*v                       speeding up / slowing down
      + 0.5*rho*CdA*v^3 ) / drivetrain    air drag, chain losses
Speed, acceleration and grade come from smoothed distance and barometric
altitude: both change continuously, so smoothing over a few seconds (speed)
and a few tens of metres (grade) removes sensor noise, not real changes.
Power is 0 while not pedalling (cadence 0) and never negative. Wind is not
recorded, so flat, windy stretches are the least accurate. No third-party
packages needed.
"""
import argparse
import bisect
import math
from pathlib import Path
import struct

FIT_EPOCH = 631065600
G = 9.81
DRIVETRAIN = 0.97
SPEED_SIGMA_S = 3.0      # smoothing of distance over time (seconds)
GRADE_SIGMA_M = 20.0     # smoothing of altitude over distance (metres)
GRID_M = 5.0             # altitude grid spacing (metres)

BASE = {0: ('B', 0xFF), 1: ('b', 0x7F), 2: ('B', 0xFF), 0x83: ('h', 0x7FFF),
        0x84: ('H', 0xFFFF), 0x85: ('i', 0x7FFFFFFF), 0x86: ('I', 0xFFFFFFFF),
        0x88: ('f', None), 0x89: ('d', None), 0x8B: ('H', 0), 0x8C: ('I', 0),
        0x0A: ('B', 0), 0x8E: ('q', None), 0x8F: ('Q', None), 0x90: ('Q', None)}
CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
             0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]

# Field numbers written: record power, lap avg/max power, session avg/max power.
RECORD, LAP, SESSION, EVENT, USER_PROFILE = 20, 19, 18, 21, 3
ADD_FIELDS = {RECORD: [7], LAP: [19, 20], SESSION: [20, 21]}


def crc16(data, crc=0):
    for byte in data:
        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[byte & 0xF]
        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF]
    return crc


def parse(data):
    """Return a list of messages: dicts with kind ('def'/'data'), byte span and,
    for data messages, the global number, field values and timestamp."""
    header_size = data[0]
    end = header_size + struct.unpack_from('<I', data, 4)[0]
    pos, defs, last_ts, out = header_size, {}, None, []
    while pos < end:
        start = pos
        rec = data[pos]
        pos += 1
        if not rec & 0x80 and rec & 0x40:
            local = rec & 0x0F
            endian = '>' if data[pos + 1] else '<'
            glob = struct.unpack_from(endian + 'H', data, pos + 2)[0]
            n = data[pos + 4]
            pos += 5
            fields = [(data[pos + 3 * i], data[pos + 3 * i + 1], data[pos + 3 * i + 2])
                      for i in range(n)]
            pos += 3 * n
            dev = []
            if rec & 0x20:
                nd = data[pos]
                pos += 1
                dev = [(data[pos + 3 * i], data[pos + 3 * i + 1], data[pos + 3 * i + 2])
                       for i in range(nd)]
                pos += 3 * nd
            d = {'glob': glob, 'endian': endian, 'fields': fields, 'dev': dev,
                 'size': sum(f[1] for f in fields), 'dev_size': sum(f[1] for f in dev)}
            defs[local] = d
            out.append({'kind': 'def', 'start': start, 'end': pos, 'local': local,
                        'def': d, 'header': rec})
            continue
        local = (rec >> 5) & 0x3 if rec & 0x80 else rec & 0x0F
        d = defs[local]
        values, p = {}, pos
        for num, size, base in d['fields']:
            spec = BASE.get(base)
            if spec and struct.calcsize(spec[0]) == size:
                v = struct.unpack_from(d['endian'] + spec[0], data, p)[0]
                if spec[1] is None or v != spec[1]:
                    values[num] = v
            p += size
        pos = p + d['dev_size']
        if rec & 0x80:
            if last_ts is not None:
                ts = (last_ts & ~0x1F) + (rec & 0x1F)
                if ts < last_ts:
                    ts += 0x20
                last_ts = ts
                values[253] = ts
        elif 253 in values:
            last_ts = values[253]
        out.append({'kind': 'data', 'start': start, 'end': pos, 'local': local,
                    'def': d, 'glob': d['glob'], 'values': values})
    return header_size, end, out


def gaussian_smooth(xs, ys, sigma):
    """Smooth ys sampled at increasing xs with a Gaussian kernel of width sigma."""
    out = []
    n = len(xs)
    lo = 0
    for i in range(n):
        while xs[i] - xs[lo] > 3 * sigma:
            lo += 1
        hi = i
        while hi + 1 < n and xs[hi + 1] - xs[i] <= 3 * sigma:
            hi += 1
        wsum = vsum = 0.0
        for j in range(lo, hi + 1):
            w = math.exp(-0.5 * ((xs[j] - xs[i]) / sigma) ** 2)
            wsum += w
            vsum += w * ys[j]
        out.append(vsum / wsum)
    return out


def interp(xs, ys, x):
    i = bisect.bisect_left(xs, x)
    if i <= 0:
        return ys[0]
    if i >= len(xs):
        return ys[-1]
    x0, x1 = xs[i - 1], xs[i]
    return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - x0) / (x1 - x0) if x1 > x0 else ys[i]


def moving_segments(records, events):
    """Split records into stretches where the timer ran (auto-pause gaps cut)."""
    stops = sorted(ts for ts, kind in events if kind in (1, 4))
    segs, cur = [], []
    for r in records:
        if cur and (any(cur[-1]['ts'] <= s < r['ts'] for s in stops)
                    or r['ts'] - cur[-1]['ts'] > 30):
            segs.append(cur)
            cur = []
        cur.append(r)
    if cur:
        segs.append(cur)
    return segs


def estimate(records, events, mass, cda, crr):
    # Grade from altitude on a distance grid (continuous, smoothed).
    pts = sorted((r['dist'], r['alt']) for r in records if r['alt'] is not None)
    grid = [i * GRID_M for i in range(int(pts[-1][0] // GRID_M) + 1)]
    dx = [p[0] for p in pts]
    alts = [interp(dx, [p[1] for p in pts], g) for g in grid]
    alts = gaussian_smooth(grid, alts, GRADE_SIGMA_M)
    slope = [(alts[min(i + 1, len(grid) - 1)] - alts[max(i - 1, 0)]) /
             (grid[min(i + 1, len(grid) - 1)] - grid[max(i - 1, 0)]) for i in range(len(grid))]
    m_eff = mass + 1.0   # rotating wheels add a little effective mass
    for seg in moving_segments(records, events):
        t0 = seg[0]['ts']
        ts = [r['ts'] - t0 for r in seg]
        if len(seg) < 3:
            for r in seg:
                r['power'] = 0
            continue
        # 1 s grid inside the segment, then smooth distance -> speed -> acceleration.
        sec = list(range(int(ts[-1]) + 1))
        dist = [interp(ts, [r['dist'] for r in seg], s) for s in sec]
        dist = gaussian_smooth(sec, dist, SPEED_SIGMA_S)
        v = [(dist[min(i + 1, len(sec) - 1)] - dist[max(i - 1, 0)]) /
             max(1, min(i + 1, len(sec) - 1) - max(i - 1, 0)) for i in range(len(sec))]
        v = [max(0.0, x) for x in v]
        acc = [(v[min(i + 1, len(sec) - 1)] - v[max(i - 1, 0)]) /
               max(1, min(i + 1, len(sec) - 1) - max(i - 1, 0)) for i in range(len(sec))]
        acc = gaussian_smooth(sec, acc, SPEED_SIGMA_S)
        for r, t in zip(seg, ts):
            i = min(int(round(t)), len(sec) - 1)
            speed, a = v[i], acc[i]
            grade = interp(grid, slope, r['dist'])
            angle = math.atan(grade)
            rho = 1.225 * math.exp(-(r['alt'] or 0.0) / 8434.0)
            p = (mass * G * speed * (math.sin(angle) + crr * math.cos(angle))
                 + m_eff * a * speed + 0.5 * rho * cda * speed ** 3) / DRIVETRAIN
            if r['cadence'] == 0 or speed < 0.5:
                p = 0.0          # coasting or standing: no pedalling power
            r['power'] = int(round(min(max(p, 0.0), 1500.0)))


def rewrite(data, header_size, end, msgs, record_power, lap_power, session_power):
    """Copy the file, adding the power fields to the record/lap/session messages."""
    body = bytearray()
    added = {}   # local type -> number of added fields (for the current definition)
    pos = header_size
    ri = li = si = 0
    for m in msgs:
        chunk = data[m['start']:m['end']]
        if m['kind'] == 'def':
            new = [f for f in ADD_FIELDS.get(m['def']['glob'], [])
                   if f not in [x[0] for x in m['def']['fields']]]
            added[m['local']] = (new, m['def']['endian'])
            if new:
                n = len(m['def']['fields'])
                cut = 6 + 3 * n               # header + fixed part + field defs
                chunk = bytearray(chunk)
                chunk[5] = n + len(new)
                extra = b''.join(bytes([f, 2, 0x84]) for f in new)
                chunk = chunk[:cut] + extra + chunk[cut:]
            body += chunk
            continue
        new, endian = added.get(m['local'], ([], '<'))
        wanted = ADD_FIELDS.get(m['glob'], [])
        if wanted:
            if m['glob'] == RECORD:
                values = [record_power[ri]]
                ri += 1
            elif m['glob'] == LAP:
                values = list(lap_power[li])
                li += 1
            else:
                values = list(session_power[si])
                si += 1
            chunk = bytearray(chunk)
            # Fields the message already has (often left empty): fill in place.
            offset = 1
            for num, size, base in m['def']['fields']:
                if num in wanted and size == 2:
                    v = values[wanted.index(num)]
                    struct.pack_into(endian + 'H', chunk, offset, 0xFFFF if v is None else v)
                offset += size
            # Fields the definition did not have: appended after the normal fields.
            cut = 1 + m['def']['size']        # dev data, if any, follows
            extra = b''.join(struct.pack(endian + 'H', 0xFFFF if values[wanted.index(f)] is None
                                         else values[wanted.index(f)]) for f in new)
            chunk = bytes(chunk[:cut]) + extra + bytes(chunk[cut:])
        body += chunk
    header = bytearray(data[:header_size])
    struct.pack_into('<I', header, 4, len(body))
    if header_size >= 14:
        struct.pack_into('<H', header, 12, crc16(header[:12]))
    out = bytes(header) + bytes(body)
    return out + struct.pack('<H', crc16(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ride')
    ap.add_argument('out')
    ap.add_argument('--rider-kg', type=float, help='default: weight in the watch profile')
    ap.add_argument('--bike-kg', type=float, default=10.5)
    ap.add_argument('--extra-kg', type=float, default=1.0,
                    help='clothing, shoes, helmet, bottles (default 1)')
    ap.add_argument('--cda', type=float, default=0.32, help='drag area m^2 (hoods)')
    ap.add_argument('--crr', type=float, default=0.0055,
                    help='rolling resistance (narrow road tyres on 18 mm rims)')
    args = ap.parse_args()
    data = Path(args.ride).read_bytes()
    header_size, end, msgs = parse(data)
    records, events, laps, sessions, rider = [], [], [], [], None
    for m in msgs:
        if m['kind'] != 'data':
            continue
        v = m['values']
        if m['glob'] == RECORD:
            if 5 in v and 253 in v:
                alt = v.get(78, v.get(2))
                records.append({'ts': v[253], 'dist': v[5] / 100.0,
                                'alt': None if alt is None else alt / 5.0 - 500.0,
                                'cadence': v.get(4), 'msg': m})
        elif m['glob'] == EVENT and v.get(0) == 0 and 253 in v:
            events.append((v[253], v.get(1)))
        elif m['glob'] == LAP:
            laps.append(v)
        elif m['glob'] == SESSION:
            sessions.append(v)
        elif m['glob'] == USER_PROFILE and 4 in v:
            rider = v[4] / 10.0
    rider = args.rider_kg or rider
    if rider is None:
        raise SystemExit('No rider weight in the file; pass --rider-kg.')
    rec_power = [m['values'][7] for m in msgs if m['kind'] == 'data' and m['glob'] == RECORD and 7 in m['values']]
    if rec_power and any(p and p < 65535 for p in rec_power):
        raise SystemExit('This ride already has power data.')
    if rec_power:
        raise SystemExit('This ride has a power field with only zeros (the watch had no power meter). This tool can only '
                         'add power to rides without a power field. (Ride Display estimates such rides by itself.)')
    mass = rider + args.extra_kg + args.bike_kg
    fill = [r for r in records if r['alt'] is not None]
    for r in records:
        if r['alt'] is None:
            r['alt'] = fill[0]['alt'] if fill else 0.0
    estimate(records, events, mass, args.cda, args.crr)
    power_by_msg = {id(r['msg']): r['power'] for r in records}
    record_power = [power_by_msg.get(id(m), None) for m in msgs
                    if m['kind'] == 'data' and m['glob'] == RECORD]

    def summary(start, stop):
        ps = [r['power'] for r in records if start <= r['ts'] <= stop]
        return (int(round(sum(ps) / len(ps))) if ps else None, max(ps) if ps else None)

    def window(v):
        # Lap/session span: start_time + total_elapsed_time (field 7, ms).
        start = v.get(2, 0)
        return start, start + v.get(7, 0) / 1000.0

    lap_power = [summary(*window(v)) for v in laps]
    session_power = [summary(*window(v)) for v in sessions]
    out = rewrite(data, header_size, end, msgs, record_power, lap_power, session_power)
    Path(args.out).write_bytes(out)
    avg, peak = session_power[0] if session_power else summary(0, 1 << 32)
    moving = [r['power'] for r in records if r['power'] > 0]
    print(f'Mass {mass:.1f} kg (rider {rider:.1f} + kit {args.extra_kg:.1f} '
          f'+ bike {args.bike_kg:.1f}), '
          f'CdA {args.cda}, Crr {args.crr}')
    print(f'Average power {avg} W (pedalling only: '
          f'{sum(moving) / max(1, len(moving)):.0f} W), max {peak} W, '
          f'{len(records)} records. Laps: ' +
          ', '.join(f'{a} W' for a, _ in lap_power))
    print('Wrote ' + args.out)


if __name__ == '__main__':
    main()
