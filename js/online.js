// Online rides: ride videos streamed from the server the app itself comes from
// (rides/index.json next to index.html, e.g. a Cloudflare Worker serving the app
// and the rides behind a sign-in). Nothing is downloaded up front: the video
// streams, and the ride data stored at the end of the file is read with a few
// small range requests.

// Looks like a File to the rest of the app (name, size, lastModified, slice())
export class RemoteFile {
  constructor(url, name, size, lastModified = 0) {
    Object.assign(this, { url, name, size, lastModified, type: 'video/mp4', remote: true });
  }
  slice(a = 0, b = this.size) {
    const url = this.url, end = Math.min(b, this.size) - 1;
    return {
      arrayBuffer: async () => {
        if (end < a) return new ArrayBuffer(0);
        const r = await fetch(url, { headers: { Range: `bytes=${a}-${end}` }, credentials: 'same-origin' });
        if (!r.ok) throw new Error(`${r.status} reading ${this.name}`);
        const buf = await r.arrayBuffer();
        // a server that ignores Range sends everything: cut out what was asked
        return r.status === 206 ? buf : buf.slice(a, end + 1);
      },
    };
  }
}

// [{ title, file: RemoteFile, note }] or [] when this server has no rides
export async function listOnline() {
  let list;
  try {
    const r = await fetch('rides/index.json', { cache: 'no-cache', credentials: 'same-origin' });
    if (!r.ok) return [];
    list = await r.json();
  } catch (e) { return []; }
  const out = [];
  for (const it of list.rides || list) {
    const url = 'rides/' + encodeURIComponent(it.file);
    let size = it.size;
    if (!size) {
      try { const h = await fetch(url, { method: 'HEAD', credentials: 'same-origin' }); size = +h.headers.get('Content-Length'); } catch (e) { /* */ }
    }
    if (size) out.push({ title: it.title || it.file, note: it.note || '', file: new RemoteFile(url, it.file, size, it.modified || 0) });
  }
  return out;
}
