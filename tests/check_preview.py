#!/usr/bin/env python3
"""Exercise preview trimming, joins, timing, caching, and the app entry point."""
import base64
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ride-video-maker'))
import make_ride_preview as preview
import make_ride_video as maker
import ride_video_app as app


def write_fit(path, start, duration):
    definition = struct.pack('<BBBHBBBB', 64, 0, 0, 20, 1, 253, 4, 134)
    records = b''.join(struct.pack('<BI', 0, start + i) for i in range(duration + 1))
    body = definition + records
    data = struct.pack('<BBHI4s', 12, 16, 0, len(body), b'.FIT') + body
    path.write_bytes(data + struct.pack('<H', maker.estimate_power.crc16(data)))


def main():
    for projection, size in [('max', '4096x1344'), ('fisheye', '1408x704'), ('flat', '320x180')]:
        graph = preview.preview_filter(projection, 180, 25, 120).replace('[0:5]', '[0:0]')
        subprocess.run([maker.ffmpeg_bin(), '-v', 'error', '-f', 'lavfi', '-i',
                        f'color=blue:size={size}:rate=8:duration=0.5',
                        '-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-f', 'null', '-'], check=True)
    with tempfile.TemporaryDirectory(prefix='ride-preview-test-') as scratch:
        folder = Path(scratch)
        fit = folder / 'ride.fit'
        write_fit(fit, 1_000_000_000, 6)
        source = folder / 'RideVideo_example.mp4'
        subprocess.run([maker.ffmpeg_bin(), '-v', 'error', '-f', 'lavfi', '-i',
                        'testsrc2=size=640x320:rate=24', '-t', '6', '-c:v', 'libx264', str(source)], check=True)
        meta = {'app': 'ride-display', 'fitName': fit.name, 'fit': base64.b64encode(fit.read_bytes()).decode(),
                'width': 640, 'height': 320, 'segments': [{'v': 0, 'r': -1, 'dur': 3},
                                                       {'v': 3, 'r': 5, 'dur': 3}]}
        body = maker.RIDE_UUID + json.dumps(meta).encode()
        with source.open('ab') as file:
            file.write(struct.pack('>I4s', len(body) + 8, b'uuid') + body)
        output, _, pieces = preview.preview_sources(source)
        assert [(p['start'], p['r'], p['dur']) for p in pieces] == [(1, 0, 2), (3, 5, 1)]
        # The normal CLI entry point.
        subprocess.run([sys.executable, str(ROOT / 'ride-video-maker/make_ride_preview.py'), str(source)], check=True)
        info = maker.mp4_info(output)
        assert (info['width'], info['height']) == (854, 480)
        assert abs(info['duration'] - 3) < 0.15, info
        mapping = json.loads(output.with_suffix('.json').read_text())
        assert [p['v'] for p in mapping['segments']] == [0, 2]
        assert [p['r'] for p in mapping['segments']] == [0, 5]
        subprocess.run([maker.ffmpeg_bin(), '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True)
        cached = {p.name: p.stat().st_mtime_ns for p in (folder / '_ridepreview_work').glob('*.mp4')}
        # The browser app's worker follows the same entry point and reuses chapters.
        app.work(str(folder), None, ['preview'], source.name)
        assert app.job['error'] is None, app.job
        assert app.job['outputs'][0]['path'] == str(output)
        assert cached == {p.name: p.stat().st_mtime_ns for p in (folder / '_ridepreview_work').glob('*.mp4')}
        # Exercise the page and the real request used by its Make button.
        server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        address = f'http://127.0.0.1:{server.server_port}'
        try:
            with urllib.request.urlopen(address) as response:
                assert b'id="oPreview"' in response.read()
            request = urllib.request.Request(address + '/run', data=json.dumps({
                'folder': str(folder), 'outputs': ['preview'], 'reuse': source.name,
                'yaw': 180, 'pitch': 25, 'fov': 120,
            }).encode(), headers={'Content-Type': 'application/json', 'Origin': address})
            with urllib.request.urlopen(request) as response:
                assert json.load(response)['ok']
            deadline = time.monotonic() + 15
            while app.job['running'] and time.monotonic() < deadline:
                time.sleep(0.05)
            assert not app.job['running'] and app.job['error'] is None, app.job
        finally:
            server.shutdown()
            server.server_close()
        try:
            preview.make_preview(source, fov=180)
            raise AssertionError('Invalid view angle was accepted')
        except ValueError:
            pass
        assert not list(folder.glob('*.partial.*'))
        assert app.scan(str(folder))['rideVideos'] == [{'name': source.name, 'gb': 0.0, 'kind': 'full'}]
        print('Passed preview CLI, app worker, FIT boundaries, camera gap, joins, decoding, cache, and input checks.')


if __name__ == '__main__':
    main()
