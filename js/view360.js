// Full-screen video: 360° (equirectangular, 2:1) drawn with WebGL so you can
// look around by dragging, or a normal flat video. The video's playback is
// steered so that it shows the spot on the route where you are.

const VS = `#version 300 es
in vec2 p; out vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 color;
uniform sampler2D tex; uniform float yaw, pitch, tanHalf, aspect;
void main() {
  vec3 d = normalize(vec3(v.x * tanHalf * aspect, v.y * tanHalf, -1.0));
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);          // look up/down
  float cy = cos(yaw), sy = sin(yaw);
  d = vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);          // look left/right
  float lon = atan(d.x, -d.z), lat = asin(clamp(d.y, -1.0, 1.0));
  vec2 uv = vec2(fract(lon / 6.2831853 + 0.5), 0.5 - lat / 3.1415927);
  color = texture(tex, uv);
}`;

export class VideoView {
  constructor(container) {
    this.box = container;
    this.video = document.createElement('video');
    Object.assign(this.video, { muted: true, playsInline: true, preload: 'auto' });
    this.video.className = 'flatvideo';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sphere';
    container.append(this.video, this.canvas);
    this.yaw = 0; this.pitch = -0.08; this.fov = 80;
    this.extraYaw = 0;                       // added turn (world-locked videos follow the road)
    this.is360 = false;
    this.gl = null;
    this.ready = false;
    this.dirty = true;                       // a new video frame to upload
    const onVideoFrame = () => { this.dirty = true; this.video.requestVideoFrameCallback(onVideoFrame); };
    if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(onVideoFrame);
    else this.noVfc = true;
    this.video.addEventListener('seeked', () => { this.dirty = true; });
    this.video.addEventListener('loadedmetadata', () => {
      const r = this.video.videoWidth / this.video.videoHeight;
      this.is360 = Math.abs(r - 2) < 0.06;
      this.box.dataset.kind = this.is360 ? '360' : 'flat';
      this.ready = true;
      this.onReady?.();
    });
    this.dragging = null;
    const c = this.canvas;
    c.addEventListener('pointerdown', e => { this.dragging = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!this.dragging) return;
      const k = (this.fov * Math.PI / 180) / c.clientHeight;
      this.yaw = this.dragging.yaw - (e.clientX - this.dragging.x) * k;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.dragging.pitch + (e.clientY - this.dragging.y) * k));
    });
    c.addEventListener('pointerup', () => { this.dragging = null; this.onViewChange?.(); });
    c.addEventListener('wheel', e => { e.preventDefault(); this.fov = Math.max(30, Math.min(120, this.fov * (e.deltaY > 0 ? 1.06 : 1 / 1.06))); this.onViewChange?.(); }, { passive: false });
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }
  load(url) {
    this.ready = false; this.dirty = true;
    this.video.src = url;
    this.video.load();
  }
  resetView() { this.yaw = 0; this.pitch = -0.08; this.fov = 80; this.onViewChange?.(); }
  initGl() {
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) { this.glFailed = true; return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.u = Object.fromEntries(['yaw', 'pitch', 'tanHalf', 'aspect'].map(n => [n, gl.getUniformLocation(prog, n)]));
    this.gl = gl;
  }
  loop() {
    requestAnimationFrame(this.loop);
    this.onFrame?.();
    if (!this.ready || !this.is360) return;
    if (!this.gl && !this.glFailed) this.initGl();
    const gl = this.gl;
    if (!gl || this.video.readyState < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.dirty || this.noVfc) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video); this.dirty = false; }
    gl.uniform1f(this.u.yaw, this.yaw + this.extraYaw); gl.uniform1f(this.u.pitch, this.pitch);
    gl.uniform1f(this.u.tanHalf, Math.tan(this.fov * Math.PI / 360)); gl.uniform1f(this.u.aspect, w / h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

// Keeps the video at the right second: small differences are absorbed by
// playing a little faster or slower, big ones (a red-light wait the original
// rider had, a new clip) by jumping.
export class VideoFollower {
  constructor(view) { this.view = view; this.rate = 1; this.state = 'idle'; }
  // target: video second where you are now; flow: video seconds per real second
  // at your current speed (0 = stopped). Call every animation frame.
  update(target, flow) {
    const v = this.view.video;
    if (!this.view.ready || target == null) { if (!v.paused) v.pause(); this.state = 'idle'; return; }
    const dur = v.duration || Infinity;
    if (target < 0 || target > dur) {
      if (!v.paused) v.pause();
      this.state = target < 0 ? 'before' : 'after';
      const edge = Math.max(0, Math.min(dur - 0.05, target));
      if (Math.abs(v.currentTime - edge) > 1 && !v.seeking) v.currentTime = edge;
      return;
    }
    this.state = 'on';
    const diff = target - v.currentTime;
    if (Math.abs(diff) > 2.5) {                       // jump (and stay paused if you're stopped)
      if (!v.seeking) v.currentTime = target;
      return;
    }
    if (flow < 0.05) { if (!v.paused) v.pause(); return; }
    let rate = Math.max(0.1, Math.min(4, flow + diff * 0.6));
    if (Math.abs(rate - this.rate) / this.rate > 0.03) { v.playbackRate = rate; this.rate = rate; }
    if (v.paused) v.play().catch(() => {});
  }
}
