"""Upload ride videos to a Cloudflare R2 bucket (S3 API, no size limit) and keep
the bucket's index.json (the rides list the app shows) up to date.

Standard library only. Credentials: an R2 API token (R2 → Manage API tokens →
Create, "Object Read & Write" for the bucket) gives an Access Key ID and a
Secret Access Key; the account ID is on the R2 overview page.
"""
import datetime as dt
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import urllib.parse

PART = 64 * 1024 * 1024          # multipart piece size
CONFIG = Path.home() / '.ride-video-maker.json'


def load_config():
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    CONFIG.write_text(json.dumps(cfg, indent=1))
    os.chmod(CONFIG, 0o600)       # the secret key: readable by you only


class R2:
    def __init__(self, account, key_id, secret, bucket):
        if not all((account, key_id, secret, bucket)):
            raise ValueError('Cloudflare settings incomplete: account ID, access key ID, secret and bucket are needed.')
        self.host = f'{account.strip()}.r2.cloudflarestorage.com'
        self.key_id, self.secret, self.bucket = key_id.strip(), secret.strip(), bucket.strip()

    def _sign(self, method, key, query, headers):
        now = dt.datetime.now(dt.timezone.utc)
        amz, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
        headers = {**{k.lower(): str(v).strip() for k, v in headers.items()},
                   'host': self.host, 'x-amz-date': amz, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD'}
        path = '/' + self.bucket + '/' + urllib.parse.quote(key, safe='/~')
        q = '&'.join(f'{urllib.parse.quote(k, safe="~")}={urllib.parse.quote(str(v), safe="~")}'
                     for k, v in sorted(query.items()))
        names = sorted(headers)
        canon = '\n'.join([method, path, q, ''.join(f'{n}:{headers[n]}\n' for n in names),
                           ';'.join(names), 'UNSIGNED-PAYLOAD'])
        scope = f'{day}/auto/s3/aws4_request'
        to_sign = '\n'.join(['AWS4-HMAC-SHA256', amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
        k = ('AWS4' + self.secret).encode()
        for part in (day, 'auto', 's3', 'aws4_request'):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        headers['Authorization'] = (f'AWS4-HMAC-SHA256 Credential={self.key_id}/{scope}, '
                                    f'SignedHeaders={";".join(names)}, Signature={sig}')
        return path + ('?' + q if q else ''), headers

    def request(self, method, key, query=None, body=b'', headers=None):
        path, hdrs = self._sign(method, key, query or {}, dict(headers or {}))
        c = http.client.HTTPSConnection(self.host, timeout=300)
        c.request(method, path, body=body, headers=hdrs)
        r = c.getresponse()
        data = r.read()
        c.close()
        if r.status >= 300 and not (method == 'GET' and r.status == 404):
            msg = re.search(rb'<Message>(.*?)</Message>', data)
            raise RuntimeError(f'Cloudflare said {r.status}: {(msg.group(1) if msg else data[:200]).decode(errors="replace")}')
        return r.status, dict(r.getheaders()), data

    def upload(self, path, key=None, say=print, content_type='video/mp4'):
        path = Path(path)
        key = key or path.name
        size = path.stat().st_size
        _, _, data = self.request('POST', key, {'uploads': ''}, headers={'Content-Type': content_type})
        upload_id = re.search(rb'<UploadId>(.*?)</UploadId>', data).group(1).decode()
        etags, sent, shown = [], 0, -1
        try:
            with open(path, 'rb') as f:
                n = 1
                while True:
                    chunk = f.read(PART)
                    if not chunk:
                        break
                    for attempt in range(3):
                        try:
                            _, h, _ = self.request('PUT', key, {'partNumber': n, 'uploadId': upload_id}, chunk,
                                                   {'Content-Length': str(len(chunk))})
                            break
                        except (OSError, http.client.HTTPException):
                            if attempt == 2:
                                raise
                    etags.append(next(v for k, v in h.items() if k.lower() == 'etag'))
                    sent += len(chunk)
                    n += 1
                    pct = int(100 * sent / size)
                    if pct >= shown + 5:
                        shown = pct - pct % 5
                        say(f'    {shown} %')
            body = ('<CompleteMultipartUpload>' + ''.join(
                f'<Part><PartNumber>{i}</PartNumber><ETag>{e}</ETag></Part>' for i, e in enumerate(etags, 1))
                + '</CompleteMultipartUpload>').encode()
            self.request('POST', key, {'uploadId': upload_id}, body, {'Content-Type': 'application/xml'})
        except BaseException:
            try:
                self.request('DELETE', key, {'uploadId': upload_id})
            except Exception:
                pass
            raise
        return key

    def add_ride(self, entry):
        """Put (or replace) a ride in the bucket's index.json."""
        status, _, data = self.request('GET', 'index.json')
        try:
            idx = json.loads(data) if status == 200 else {'rides': []}
        except ValueError:
            idx = {'rides': []}
        rides = [r for r in idx.get('rides', []) if r.get('file') != entry['file']] + [entry]
        body = (json.dumps({'rides': rides}, indent=1, ensure_ascii=False) + '\n').encode()
        self.request('PUT', 'index.json', body=body, headers={'Content-Type': 'application/json',
                                                                'Content-Length': str(len(body))})
        return rides
