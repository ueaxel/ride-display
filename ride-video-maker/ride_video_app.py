#!/usr/bin/env python3
"""Ride Video Maker as a small app in your browser (runs on this computer only).

  python3 ride_video_app.py          (or double-click "Ride Video Maker.command")

Opens http://127.0.0.1:8765: pick the folder with the ride (.fit) and the GoPro
files, choose what you want (full size for riding here, a streaming copy for
Cloudflare, a phone copy), press Make. The work is done by make_ride_video.py;
nothing leaves the computer.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import webbrowser

import r2_upload

HERE = Path(__file__).resolve().parent
TOOL = HERE / 'make_ride_video.py'
PORT = 8765
GOPRO = re.compile(r'^G[SXHL]\d{6}\.(360|MP4)$', re.I)
COPY = re.compile(r'_(phone|stream|share)(_preview)?\.mp4$', re.I)

job = {'running': False, 'log': [], 'outputs': [], 'error': None}


def scan(folder):
    f = Path(folder).expanduser()
    if not f.is_dir():
        raise ValueError(f'Not a folder: {folder}')
    files = sorted(p for p in f.iterdir() if p.is_file() and not p.name.startswith('.'))
    vids = [p for p in files if p.name.startswith('RideVideo_') and p.suffix.lower() == '.mp4'
            and '.partial' not in p.name]
    return {
        'folder': str(f),
        'fits': [p.name for p in files if p.suffix.lower() == '.fit' and not p.name.startswith('RideDisplay_')],
        'gopro': [{'name': p.name, 'gb': round(p.stat().st_size / 1e9, 2)} for p in files if GOPRO.match(p.name)],
        'rideVideos': [{'name': p.name, 'gb': round(p.stat().st_size / 1e9, 2),
                        'kind': (COPY.search(p.name).group(1) if COPY.search(p.name) else 'full')} for p in vids],
    }


def pick(kind):
    """The Mac's own Open dialog (osascript)."""
    if sys.platform != 'darwin':
        raise ValueError('Type the folder path instead (the dialog only works on a Mac).')
    script = ('POSIX path of (choose folder with prompt "Folder with the ride (.fit) and the GoPro files")'
              if kind == 'folder' else 'POSIX path of (choose file with prompt "The ride (.fit)" of type {"fit", "FIT"})')
    r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
    return r.stdout.strip() or None


def run_tool(args):
    say = job['log'].append
    p = subprocess.Popen([sys.executable, '-u', str(TOOL), *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, cwd=str(HERE))
    for line in p.stdout:
        say(line.rstrip())
    if p.wait() != 0:
        raise RuntimeError(job['log'][-1] if job['log'] else 'the tool stopped')


def work(folder, fit, outputs, reuse, quality='small', upload=False, title=None):
    job.update(running=True, log=[], outputs=[], error=None)
    try:
        folder = Path(folder)
        before = {p.name for p in folder.glob('RideVideo_*.mp4')}
        if reuse:
            full = folder / reuse
            job['log'].append(f'Using the ride video already made: {reuse}')
        else:
            job['log'].append('Step 1: putting the ride and the GoPro videos together (full size) …')
            run_tool([str(folder)] + (['--fit', fit] if fit else []))
            made = [p for p in folder.glob('RideVideo_*.mp4') if p.name not in before and not COPY.search(p.name)
                    and '.partial' not in p.name]
            if not made:
                made = sorted((p for p in folder.glob('RideVideo_*.mp4') if not COPY.search(p.name)
                               and '.partial' not in p.name), key=lambda p: p.stat().st_mtime)[-1:]
            if not made:
                raise RuntimeError('No ride video was made.')
            full = max(made, key=lambda p: p.stat().st_mtime)
        if 'full' in outputs or not reuse:
            job['outputs'].append({'kind': 'full', 'path': str(full), 'mb': round(full.stat().st_size / 1e6)})
        for kind in ('stream', 'phone'):
            if kind in outputs:
                job['log'].append(f'Making the {"streaming" if kind == "stream" else "phone"} copy …')
                run_tool([f'--{kind}'] + (['--good'] if kind == 'stream' and quality == 'good' else []) + [str(full)])
                out = full.with_name(full.stem + f'_{kind}.mp4')
                job['outputs'].append({'kind': kind, 'path': str(out), 'mb': round(out.stat().st_size / 1e6)})
                if kind == 'stream' and upload:
                    cfg = r2_upload.load_config()
                    r2 = r2_upload.R2(cfg.get('account'), cfg.get('keyId'), cfg.get('secret'), cfg.get('bucket'))
                    job['log'].append(f'Uploading {out.name} to Cloudflare (bucket {cfg.get("bucket")}) …')
                    r2.upload(out, say=job['log'].append)
                    entry = {'file': out.name, 'title': title or folder.name, 'forward': 180, 'lookUp': 25}
                    r2.add_ride(entry)
                    site = (cfg.get('site') or '').rstrip('/')
                    link = f'{site}/?ride={out.name}#video' if site else f'…/?ride={out.name}#video'
                    job['outputs'][-1]['link'] = link
                    job['log'].append(f'Uploaded and added to the rides list. Link: {link}')
        job['log'].append('All done.')
    except Exception as e:        # shown on the page
        job['error'] = str(e)
    finally:
        job['running'] = False


def settings_view():
    """Cloudflare settings for the page: never the secret itself."""
    c = r2_upload.load_config()
    return {'account': c.get('account', ''), 'keyId': c.get('keyId', ''), 'bucket': c.get('bucket', ''),
            'site': c.get('site', ''), 'secretSet': bool(c.get('secret'))}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/':
            return self.send(200, PAGE.encode(), 'text/html; charset=utf-8')
        if self.path == '/status':
            return self.send(200, job)
        if self.path == '/settings':
            return self.send(200, settings_view())
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        if self.headers.get('Origin') not in (None, f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'):
            return self.send(403, {'error': 'only this page may use the app'})
        try:
            q = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            if self.path == '/pick':
                return self.send(200, {'path': pick(q.get('kind', 'folder'))})
            if self.path == '/scan':
                return self.send(200, scan(q['folder']))
            if self.path == '/settings':
                cfg = r2_upload.load_config()
                for k in ('account', 'keyId', 'secret', 'bucket', 'site'):
                    if q.get(k):
                        cfg[k] = q[k].strip()
                r2_upload.save_config(cfg)
                return self.send(200, settings_view())
            if self.path == '/test-upload':
                cfg = r2_upload.load_config()
                r2 = r2_upload.R2(cfg.get('account'), cfg.get('keyId'), cfg.get('secret'), cfg.get('bucket'))
                st, _, data = r2.request('GET', 'index.json')
                n = len(json.loads(data).get('rides', [])) if st == 200 else 0
                return self.send(200, {'ok': True, 'rides': n})
            if self.path == '/run':
                if job['running']:
                    return self.send(409, {'error': 'already working'})
                outs = [o for o in q.get('outputs', []) if o in ('full', 'stream', 'phone')]
                if not outs:
                    return self.send(400, {'error': 'choose at least one'})
                threading.Thread(target=work, args=(q['folder'], q.get('fit'), outs, q.get('reuse'),
                                                    q.get('quality', 'small'), bool(q.get('upload')), q.get('title')),
                                 daemon=True).start()
                return self.send(200, {'ok': True})
            if self.path == '/reveal' and sys.platform == 'darwin':
                subprocess.run(['open', '-R', q['path']])
                return self.send(200, {'ok': True})
            self.send(404, {'error': 'not found'})
        except Exception as e:
            self.send(400, {'error': str(e)})


PAGE = r'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ride Video Maker</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --bg:#0f1418; --card:#182027; --line:#26313a; --text:#e8eef2; --muted:#8a9aa6; --accent:#4fd1b5; --err:#ff7a6b; }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
main { max-width: 760px; margin: 0 auto; padding: 28px 20px 60px; }
h1 { font-size: 24px; margin: 0 0 4px; } .sub { color: var(--muted); margin: 0 0 22px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin-bottom: 14px; }
h2 { font-size: 15px; margin: 0 0 10px; letter-spacing: .02em; } h2 span { color: var(--accent); margin-right: 6px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
input[type=text] { flex: 1; min-width: 240px; background: #0b1014; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; }
button { background: #24303a; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 9px 14px; font: inherit; cursor: pointer; }
button.primary { background: var(--accent); color: #062019; border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: .45; cursor: default; }
.muted { color: var(--muted); font-size: 13px; } .err { color: var(--err); }
label.opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border: 1px solid var(--line); border-radius: 9px; margin: 6px 0; cursor: pointer; }
label.opt input { margin-top: 3px; } label.opt b { display: block; }
ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 2px 0; }
pre { background: #0b1014; border: 1px solid var(--line); border-radius: 8px; padding: 10px; max-height: 260px; overflow: auto; font-size: 12.5px; white-space: pre-wrap; margin: 10px 0 0; }
.out { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); }
code { background: #0b1014; padding: 1px 5px; border-radius: 5px; font-size: 12.5px; word-break: break-all; }
</style></head><body><main>
<h1>Ride Video Maker</h1>
<p class="sub">A ride (.fit) and the GoPro videos recorded during it → one ride video for Ride Display. Runs on this computer.</p>

<section><h2><span>1</span>The ride folder</h2>
  <div class="row"><input id="folder" type="text" placeholder="/Users/you/dev/garmin/my ride"><button id="pickFolder">Choose…</button><button id="scan">Look</button></div>
  <div id="found" class="muted" style="margin-top:10px">Choose the folder that holds the watch's .fit and the GoPro files (GS01….360 / GX01….MP4).</div>
</section>

<section><h2><span>2</span>What to make</h2>
  <label class="opt"><input type="checkbox" id="oFull" checked><div><b>Full size</b><span class="muted">Best quality, for riding on this Mac or the tablet. Several GB.</span></div></label>
  <label class="opt"><input type="checkbox" id="oStream"><div><b>Streaming</b><span class="muted">For Cloudflare, to share as a link.</span>
    <div id="streamOpts" style="display:none; margin-top:6px">
      <label><input type="radio" name="q" value="good" checked> Good, about 1.8 GB per hour (needs the upload below)</label><br>
      <label><input type="radio" name="q" value="small"> Small, under 300 MB (fits the Cloudflare dashboard upload)</label><br>
      <label><input type="checkbox" id="oUpload" checked> Upload to Cloudflare and add it to the rides list</label>
      <div class="row" style="margin-top:6px">Title: <input type="text" id="title" placeholder="e.g. Thornton loop"></div>
    </div></div></label>
  <label class="opt"><input type="checkbox" id="oPhone"><div><b>Phone</b><span class="muted">About 2.7 GB per hour, to copy onto a phone.</span></div></label>
  <div id="reuseBox" class="muted" style="display:none; margin-top:8px"></div>
</section>

<section><h2><span>3</span>Make it</h2>
  <div class="row"><button id="go" class="primary" disabled>Make</button><span id="state" class="muted"></span></div>
  <pre id="log" style="display:none"></pre>
  <div id="outs"></div>
</section>

<section><h2>Cloudflare (for uploading)</h2>
  <p class="muted" style="margin-top:0">Once: R2 → <b>Manage API tokens</b> → <b>Create API token</b> → permission <b>Object Read &amp; Write</b>, your bucket → Create. Copy the values here. They stay on this computer (in your home folder, readable by you only).</p>
  <div class="row"><input id="cAccount" type="text" placeholder="Account ID (R2 overview page, right side)"></div>
  <div class="row" style="margin-top:6px"><input id="cKey" type="text" placeholder="Access Key ID"></div>
  <div class="row" style="margin-top:6px"><input id="cSecret" type="password" placeholder="Secret Access Key"></div>
  <div class="row" style="margin-top:6px"><input id="cBucket" type="text" placeholder="Bucket name, e.g. weldontest-unedited"></div>
  <div class="row" style="margin-top:6px"><input id="cSite" type="text" placeholder="Your site, e.g. https://rides.yourname.workers.dev"></div>
  <div class="row" style="margin-top:8px"><button id="cSave">Save and test</button><span id="cState" class="muted"></span></div>
</section>

<section id="shareBox" style="display:none"><h2>Share the streaming copy</h2>
  <p class="muted" style="margin-top:0">Upload the streaming file and this <code>index.json</code> line to your Cloudflare R2 bucket. Your site:</p>
  <div class="row"><input id="site" type="text" placeholder="https://rides.yourname.workers.dev"></div>
  <pre id="shareText"></pre>
</section>
</main>
<script>
const $ = id => document.getElementById(id);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
let info = null, stream = null;
try { $('folder').value = localStorage.folder || ''; $('site').value = localStorage.site || ''; } catch (e) {}
$('pickFolder').onclick = async () => { const r = await post('/pick', { kind: 'folder' }); if (r.error) $('found').innerHTML = `<span class="err">${r.error}</span>`; else if (r.path) { $('folder').value = r.path; look(); } };
$('scan').onclick = () => look();
$('folder').onkeydown = e => { if (e.key === 'Enter') look(); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function look() {
  const folder = $('folder').value.trim(); if (!folder) return;
  try { localStorage.folder = folder; } catch (e) {}
  const r = await post('/scan', { folder });
  if (r.error) { $('found').innerHTML = `<span class="err">${esc(r.error)}</span>`; info = null; return update(); }
  info = r;
  const fits = r.fits.length > 1 ? `<div class="row" style="margin-top:6px">Ride: <select id="fit">${r.fits.map(f => `<option>${esc(f)}</option>`).join('')}</select></div>` : '';
  $('found').innerHTML = `<b>${r.fits.length}</b> ride file${r.fits.length === 1 ? '' : 's'} (.fit), <b>${r.gopro.length}</b> GoPro video${r.gopro.length === 1 ? '' : 's'}` +
    (r.gopro.length ? `<ul>${r.gopro.map(g => `<li>${esc(g.name)} <span class="muted">${g.gb} GB</span></li>`).join('')}</ul>` : '') + fits +
    (!r.fits.length ? '<div class="err">No .fit in this folder: copy the ride from the watch or Garmin Connect here.</div>' : '') +
    (!r.gopro.length ? '<div class="err">No GoPro originals (GS01….360, GX01….MP4) in this folder.</div>' : '');
  const full = r.rideVideos.filter(v => v.kind === 'full');
  $('reuseBox').style.display = full.length ? '' : 'none';
  $('reuseBox').innerHTML = full.length ? `<label><input type="checkbox" id="reuse" checked> Already made: use <select id="reuseFile">${full.map(v => `<option>${esc(v.name)}</option>`).join('')}</select> (skips putting it together again)</label>` : '';
  update();
}
function outputs() { return [['oFull', 'full'], ['oStream', 'stream'], ['oPhone', 'phone']].filter(([id]) => $(id).checked).map(([, k]) => k); }
function update() {
  const ok = info && outputs().length && (($('reuse') && $('reuse').checked) || (info.fits.length && info.gopro.length));
  $('go').disabled = !ok || running;
}
['oFull', 'oStream', 'oPhone'].forEach(id => $(id).onchange = () => { $('streamOpts').style.display = $('oStream').checked ? '' : 'none'; update(); });
async function loadSettings() {
  const c = await fetch('/settings').then(r => r.json());
  $('cAccount').value = c.account; $('cKey').value = c.keyId; $('cBucket').value = c.bucket; $('cSite').value = c.site;
  $('cSecret').placeholder = c.secretSet ? 'Secret Access Key (saved)' : 'Secret Access Key';
  if (c.site && !$('site').value) $('site').value = c.site;
}
$('cSave').onclick = async () => {
  $('cState').textContent = 'Testing…';
  const r = await post('/settings', { account: $('cAccount').value, keyId: $('cKey').value, secret: $('cSecret').value, bucket: $('cBucket').value, site: $('cSite').value });
  $('cSecret').value = ''; loadSettings();
  const t = await post('/test-upload', {});
  $('cState').innerHTML = t.error ? `<span class="err">${esc(t.error)}</span>` : `Connected: ${t.rides} ride${t.rides === 1 ? '' : 's'} in the bucket's list.`;
};
loadSettings();
document.addEventListener('change', e => { if (e.target.id === 'reuse') update(); });
let running = false;
$('go').onclick = async () => {
  const reuse = $('reuse') && $('reuse').checked ? $('reuseFile').value : null;
  const quality = document.querySelector('input[name=q]:checked').value;
  const r = await post('/run', { folder: info.folder, fit: $('fit') ? $('fit').value : null, outputs: outputs(), reuse,
    quality, upload: $('oStream').checked && $('oUpload').checked, title: $('title').value.trim() || null });
  if (r.error) { $('state').innerHTML = `<span class="err">${esc(r.error)}</span>`; return; }
  running = true; update(); $('outs').innerHTML = ''; $('log').style.display = ''; $('shareBox').style.display = 'none'; poll();
};
async function poll() {
  const s = await fetch('/status').then(r => r.json());
  $('log').textContent = s.log.join('\n'); $('log').scrollTop = 1e9;
  const pct = [...s.log].reverse().find(l => /^\s*\d+ %$/.test(l));
  $('state').textContent = s.running ? `Working… ${pct ? pct.trim() : ''}` : s.error ? '' : 'Done.';
  if (s.error) $('state').innerHTML = `<span class="err">Stopped: ${esc(s.error)}</span>`;
  if (s.running) return setTimeout(poll, 1000);
  running = false; update(); look();
  const names = { full: 'Full size', stream: 'Streaming', phone: 'Phone' };
  $('outs').innerHTML = s.outputs.map((o, i) => `<div class="out"><div><b>${names[o.kind]}</b> <span class="muted">${o.mb >= 1000 ? (o.mb / 1000).toFixed(1) + ' GB' : o.mb + ' MB'}</span><br><code>${esc(o.path.split('/').pop())}</code>${o.link ? `<br>Link to send: <a href="${esc(o.link)}" target="_blank" style="color:var(--accent)">${esc(o.link)}</a>` : ''}</div><button data-i="${i}">Show in Finder</button></div>`).join('');
  $('outs').querySelectorAll('button').forEach(b => b.onclick = () => post('/reveal', { path: s.outputs[b.dataset.i].path }));
  stream = s.outputs.find(o => o.kind === 'stream'); share();
}
function share() {
  if (!stream) return;
  $('shareBox').style.display = '';
  const file = stream.path.split('/').pop(), site = ($('site').value.trim() || 'https://rides.yourname.workers.dev').replace(/\/$/, '');
  const title = info ? info.folder.split('/').pop().replace(/^\d{6}[ _-]*/, '') : file;
  $('shareText').textContent = `index.json entry:\n  { "file": "${file}", "title": "${title}", "forward": 180, "lookUp": 25 }\n\nLink to send:\n  ${site}/?ride=${encodeURIComponent(file)}#video`;
}
$('site').oninput = () => { try { localStorage.site = $('site').value; } catch (e) {} share(); };
if ($('folder').value) look();
fetch('/status').then(r => r.json()).then(s => { if (s.running) { running = true; $('log').style.display = ''; poll(); } });
</script></body></html>'''


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    url = f'http://127.0.0.1:{PORT}/'
    print(f'Ride Video Maker is open at {url}  (close this window to stop it)')
    if '--no-browser' not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    os.chdir(HERE)
    main()
