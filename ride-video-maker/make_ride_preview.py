#!/usr/bin/env python3
"""Make a small, forward-facing review movie directly from a ride's sources."""
import argparse
import base64
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile
import time

import make_ride_video as maker

WIDTH, HEIGHT, FPS = 854, 480, 8


def preview_sources(source, fit=None):
    source = Path(source).expanduser().resolve()
    if source.is_dir():
        ride, originals = maker.plan(source, fit)
        pieces = [{'path': str(p['video']), 'start': 0,
                   'r': p['offset'] - ride['start'], 'dur': p['info']['duration'],
                   'projection': 'max' if p.get('convert') else
                   ('sphere' if p['vinfo']['width'] == 2 * (p['vinfo']['height'] or 0) else 'flat')}
                  for p in originals]
        # GoPro MAX's camera-generated low-resolution movie is already a
        # dual-fisheye H.264 proxy, avoiding decoding the two large HEVC tracks.
        files = {p.name.lower(): p for p in source.iterdir() if p.is_file()}
        for piece, original in zip(pieces, originals):
            proxy = files.get(original['orig'].stem.lower() + '.lrv')
            if original['orig'].suffix.lower() != '.360' or proxy is None:
                continue
            try:
                info = maker.mp4_info(proxy)
                compatible = (info['width'], info['height']) == (1408, 704)
                if compatible and abs(info['duration'] - piece['dur']) < 0.5:
                    piece.update(proxy=str(proxy), previewProjection='fisheye')
            except (ValueError, OSError, struct.error):
                pass  # A damaged proxy can still be previewed from the original.
        fit_source = str(ride['path'])
        folder = source
    else:
        meta = maker.read_ride_meta(source)
        if not meta or not meta.get('fit') or not meta.get('segments'):
            raise ValueError('Choose a ride folder or a RideVideo MP4 with embedded FIT data.')
        with tempfile.TemporaryDirectory() as scratch:
            fit_path = Path(scratch) / 'ride.fit'
            fit_path.write_bytes(base64.b64decode(meta['fit']))
            ride = maker.read_fit(fit_path)
        fit_source = str(source) + ' (embedded FIT)'
        projection = 'sphere' if meta.get('width') == 2 * (meta.get('height') or 0) else 'flat'
        pieces = [{'path': str(source), 'start': p['v'], 'r': p['r'],
                   'dur': p['dur'], 'projection': projection} for p in meta['segments']]
        folder = source.parent
    end = ride['end'] - ride['start']
    cursor = 0.0
    selected = []
    for piece in sorted(pieces, key=lambda p: p['r']):
        begin = max(0, cursor, piece['r'])
        finish = min(end, piece['r'] + piece['dur'])
        if finish <= begin:
            continue
        selected.append(dict(piece, start=piece['start'] + begin - piece['r'],
                             r=begin, dur=finish - begin))
        cursor = finish
    if not selected:
        raise ValueError('No video overlaps the FIT activity.')
    local = ride['start'] + (ride['tz'] or 0)
    stem = 'RidePreview_' + dt.datetime.fromtimestamp(local, dt.timezone.utc).strftime('%y%m%d_%H%M')
    return folder / (stem + '.mp4'), fit_source, selected


def preview_filter(projection, yaw, pitch, fov):
    vfov = math.degrees(2 * math.atan(math.tan(math.radians(fov / 2)) * HEIGHT / WIDTH))
    view = (f'v360=e:flat:w={WIDTH}:h={HEIGHT}:yaw={yaw}:pitch={pitch}'
            f':h_fov={fov}:v_fov={vfov}')
    if projection == 'max':
        # Reduce the frame rate before the expensive cube-face conversion,
        # and scale each face before assembling the low-resolution cubemap.
        graph = maker.eac_filter(1024)
        graph = graph.replace('split=7', f'fps={FPS},split=7')
        graph = graph.replace('scale=96:1344', 'scale=24:336')
        for i, width in enumerate((624, 64, 624, 1344, 624, 64, 624)):
            if width != 64:
                for lens in ('a', 'b'):
                    graph = graph.replace(f'[{lens}p{i}]', f',scale={width // 4}:336[{lens}p{i}]', 1)
        return graph.replace('format=yuv420p[v]', view + ',format=yuv420p[v]')
    if projection == 'sphere':
        return f'[0:v:0]fps={FPS},scale=1024:512,{view},format=yuv420p[v]'
    if projection == 'fisheye':
        # MAX proxy lens order is reversed relative to the full-size EAC.
        return (f'[0:v:0]fps={FPS},v360=dfisheye:flat:w={WIDTH}:h={HEIGHT}'
                f':ih_fov=190:iv_fov=190:yaw={yaw - 180}:pitch={pitch}'
                f':h_fov={fov}:v_fov={vfov},format=yuv420p[v]')
    return (f'[0:v:0]fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,'
            f'pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v]')


def make_preview(source, fit=None, yaw=180, pitch=25, fov=120):
    yaw, pitch, fov = float(yaw), float(pitch), float(fov)
    if not all(math.isfinite(v) for v in (yaw, pitch, fov)):
        raise ValueError('View angles must be finite numbers.')
    if not (-180 <= yaw <= 180 and -89 <= pitch <= 89 and 60 <= fov <= 150):
        raise ValueError('Use direction −180 to 180, tilt −89 to 89, and field of view 60 to 150.')
    ffmpeg = maker.ffmpeg_bin()
    if not ffmpeg:
        raise ValueError('Install FFmpeg first with brew install ffmpeg.')
    output, fit_source, pieces = preview_sources(source, fit)
    work = output.parent / '_ridepreview_work'
    work.mkdir(exist_ok=True)
    total = sum(p['dur'] for p in pieces)
    maker.say(f'Making {total / 60:.1f} minutes of preview at {WIDTH} × {HEIGHT}, {FPS} fps.')
    maker.say('Only video within the FIT activity is included. Camera-off gaps are skipped.')
    timeline, rendered, elapsed = [], [], 0.0
    started = time.monotonic()
    for i, piece in enumerate(pieces):
        path = Path(piece['path'])
        render_path = Path(piece.get('proxy', path))
        stat = render_path.stat()
        key = json.dumps([piece, stat.st_size, stat.st_mtime_ns, yaw, pitch, fov, 'preview-v2'])
        clip = work / (hashlib.sha256(key.encode()).hexdigest()[:24] + '.mp4')
        maker.say(f'Chapter {i + 1}/{len(pieces)}: {path.name} ({piece["dur"]:.1f} seconds)')
        if piece.get('proxy'):
            maker.say(f'  Using camera preview {render_path.name}')
        if not clip.exists():
            partial = clip.with_suffix('.partial.mp4')
            command = [ffmpeg, '-v', 'error', '-y', '-ss', str(piece['start']), '-i', str(render_path),
                       '-t', str(piece['dur']), '-filter_complex',
                       preview_filter(piece.get('previewProjection', piece['projection']), yaw, pitch, fov), '-map', '[v]', '-an',
                       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
                       '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', str(partial)]
            # A file for diagnostics prevents a full stderr pipe stalling FFmpeg.
            with tempfile.TemporaryFile(mode='w+') as errors:
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True)
                try:
                    shown = -1
                    for line in process.stdout:
                        if line.startswith('out_time_us='):
                            try:
                                seconds = int(line.split('=')[1]) / 1e6
                            except ValueError:
                                continue
                            percent = min(100, int((elapsed + seconds) / total * 100))
                            if percent // 10 > shown:
                                shown = percent // 10
                                maker.say(f'    {percent} %')
                    if process.wait() != 0:
                        errors.seek(0)
                        raise RuntimeError('Preview conversion failed: ' + errors.read()[-2000:])
                except BaseException:
                    partial.unlink(missing_ok=True)
                    raise
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait()
                    process.stdout.close()
            partial.replace(clip)
        actual = maker.mp4_info(clip)['duration']
        timeline.append(dict(piece, v=elapsed, dur=actual, sourceDuration=piece['dur']))
        rendered.append(clip)
        elapsed += actual
    partial = output.with_suffix('.partial.mp4')
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt') as listing:
        for clip in rendered:
            listing.write("file '" + str(clip).replace("'", "'\\''") + "'\n")
        listing.flush()
        subprocess.run([ffmpeg, '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listing.name,
                        '-c', 'copy', '-movflags', '+faststart', str(partial)], check=True)
    # A companion timeline keeps player timestamps connected to original video
    # and FIT times, including rides with pauses or several recording gaps.
    mapping = {'version': 1, 'preview': output.name, 'fitSource': fit_source,
               'yaw': yaw, 'pitch': pitch, 'fieldOfView': fov, 'fps': FPS,
               'width': WIDTH, 'height': HEIGHT, 'segments': timeline}
    sidecar = output.with_suffix('.json')
    sidecar_partial = sidecar.with_suffix('.partial.json')
    sidecar_partial.write_text(json.dumps(mapping, indent=2) + '\n')
    partial.replace(output)
    sidecar_partial.replace(sidecar)
    maker.say(f'Done: {output} ({output.stat().st_size / 1e6:.1f} MB). '
              f'Processed in {time.monotonic() - started:.0f} seconds.')
    maker.say('Open in a normal video player and note start/end timestamps. Keep the matching JSON timeline.')
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='Folder with FIT and GoPro files, or an existing RideVideo MP4')
    parser.add_argument('--fit', help='FIT filename when the folder contains several rides')
    parser.add_argument('--yaw', type=float, default=180, help='Forward direction, degrees (default 180)')
    parser.add_argument('--pitch', type=float, default=25, help='Look upward, degrees (default 25)')
    parser.add_argument('--fov', type=float, default=120, help='Wide-angle field of view (default 120)')
    args = parser.parse_args()
    try:
        make_preview(args.source, args.fit, args.yaw, args.pitch, args.fov)
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
