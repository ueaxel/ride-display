// ANT serial protocol for a USB ANT stick, and the two ways Chrome can reach one:
//   WebUSB     Garmin/Dynastream ANT USB-m (0fcf:1009, the small current stick)
//   Web Serial ANT USB2 (0fcf:1008, CP210x serial chip) and clones that show up as a serial port
// The stick runs one channel in continuous scan mode on 2457 MHz, so it hears every device in
// range at once. One network at a time:
//   public  the AntLive data field (Connect IQ may not transmit on the ANT+ network)
//   antplus watches broadcasting heart rate, power meters, speed/cadence sensors, trainers

export const SYNC = 0xA4;
export const ANTPLUS_KEY = [0xB9, 0xA5, 0x21, 0xFB, 0xBD, 0x72, 0xC3, 0x45];   // ANT+ network key
export const PUBLIC_KEY = [0, 0, 0, 0, 0, 0, 0, 0];                             // public ANT network
export const NETWORKS = { public: PUBLIC_KEY, antplus: ANTPLUS_KEY };
export const ANTPLUS_FREQ = 57;                                                // 2457 MHz

export const MSG = {
  RESET: 0x4A, NETWORK_KEY: 0x46, ASSIGN: 0x42, CHANNEL_ID: 0x51, FREQ: 0x45, LIB_CONFIG: 0x6E,
  OPEN_SCAN: 0x5B, CLOSE: 0x4C, BROADCAST: 0x4E, ACKNOWLEDGED: 0x4F, BURST: 0x50,
  CHANNEL_EVENT: 0x40, STARTUP: 0x6F, CAPABILITIES: 0x54, REQUEST: 0x4D,
};

// One ANT message: A4 len id data… checksum (XOR of everything before it).
export function frame(id, data = []) {
  const out = [SYNC, data.length, id, ...data];
  out.push(out.reduce((x, b) => x ^ b, 0));
  return Uint8Array.from(out);
}

// The commands that set the stick up for scanning one network, in order.
export function scanSetup(network = 'public') {
  return [
    frame(MSG.RESET, [0]),
    frame(MSG.NETWORK_KEY, [0, ...(NETWORKS[network] || PUBLIC_KEY)]),
    frame(MSG.ASSIGN, [0, 0x00, 0]),           // channel 0, receive (slave), network 0
    frame(MSG.CHANNEL_ID, [0, 0, 0, 0, 0]),    // wildcard: any device number, type, transmission type
    frame(MSG.FREQ, [0, ANTPLUS_FREQ]),
    frame(MSG.LIB_CONFIG, [0, 0xC0]),          // add channel ID (0x80) and RSSI (0x40) to every message
    frame(MSG.OPEN_SCAN, [0]),
  ];
}

// Splits a byte stream into ANT messages; keeps a partial message for the next chunk.
export class Deframer {
  constructor() { this.buf = []; this.bad = 0; }
  push(bytes) {
    for (const b of bytes) this.buf.push(b);
    const out = [];
    for (;;) {
      const start = this.buf.indexOf(SYNC);
      if (start < 0) { this.buf.length = 0; break; }
      if (start > 0) this.buf.splice(0, start);
      if (this.buf.length < 4) break;
      const len = this.buf[1];
      if (len > 40) { this.buf.shift(); this.bad++; continue; }      // not a real header
      if (this.buf.length < len + 4) break;
      const msg = this.buf.slice(0, len + 4);
      const sum = msg.slice(0, -1).reduce((x, b) => x ^ b, 0);
      if (sum !== msg[msg.length - 1]) { this.buf.shift(); this.bad++; continue; }
      this.buf.splice(0, len + 4);
      out.push({ id: msg[2], data: msg.slice(3, 3 + len) });
    }
    return out;
  }
}

// A received data message (broadcast, acknowledged or burst) with the extended bytes the
// stick adds: channel ID (device number, type, transmission type) and signal strength.
export function parseData(m) {
  if (![MSG.BROADCAST, MSG.ACKNOWLEDGED, MSG.BURST].includes(m.id) || m.data.length < 9) return null;
  const d = m.data;
  const out = { channel: d[0], payload: d.slice(1, 9) };
  if (d.length > 9) {
    const flag = d[9];
    let p = 10;
    if (flag & 0x80) {
      out.deviceNumber = d[p] | d[p + 1] << 8;
      out.deviceType = d[p + 2] & 0x7F;
      out.pairing = !!(d[p + 2] & 0x80);
      out.transType = d[p + 3];
      // the high nibble of the transmission type extends the device number to 20 bits
      out.deviceNumber |= (out.transType >> 4) << 16;
      p += 4;
    }
    if (flag & 0x40) { out.rssi = (d[p + 1] << 24 >> 24); p += 3; }   // measurement type, RSSI (dBm), threshold
    if (flag & 0x20) { out.rxTime = d[p] | d[p + 1] << 8; p += 2; }
  }
  return out;
}

const CHANNEL_CODES = { 0x01: 'search timeout', 0x02: 'receive failed', 0x07: 'channel closed', 0x28: 'channel in wrong state', 0x29: 'channel not opened' };
export function describeEvent(m) {
  if (m.id === MSG.STARTUP) return 'stick restarted';
  if (m.id !== MSG.CHANNEL_EVENT || m.data.length < 3) return null;
  const [, msgId, code] = m.data;
  if (msgId === 0x01) return CHANNEL_CODES[code] || null;       // RF event
  if (code === 0) return null;                                  // command accepted
  return `stick refused command 0x${msgId.toString(16)} (code 0x${code.toString(16)})`;
}

// ------------------------------------------------------------ transports

export const ANT_VENDOR = 0x0FCF;
export const usbAvailable = () => !!navigator.usb;
export const serialAvailable = () => !!navigator.serial;

export class UsbStick {
  constructor(device) { this.device = device; this.label = device.productName || 'ANT USB stick'; }
  static async request() {
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: ANT_VENDOR }] });
    return new UsbStick(device);
  }
  static async remembered() {
    const list = navigator.usb ? await navigator.usb.getDevices() : [];
    const d = list.find(x => x.vendorId === ANT_VENDOR);
    return d ? new UsbStick(d) : null;
  }
  async open(onBytes) {
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    const iface = d.configuration.interfaces[0];
    await d.claimInterface(iface.interfaceNumber);
    const eps = iface.alternate.endpoints;
    this.inEp = eps.find(e => e.direction === 'in' && e.type === 'bulk')?.endpointNumber ?? 1;
    this.outEp = eps.find(e => e.direction === 'out' && e.type === 'bulk')?.endpointNumber ?? 1;
    this.running = true;
    (async () => {
      while (this.running) {
        try {
          const r = await d.transferIn(this.inEp, 64);
          if (r.data?.byteLength) onBytes(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        } catch (e) {
          if (this.running) { this.running = false; this.onLost?.(e); }
        }
      }
    })();
  }
  async write(bytes) { await this.device.transferOut(this.outEp, bytes); }
  async close() {
    this.running = false;
    try { await this.device.close(); } catch (e) { /* already closed */ }
  }
}

export class SerialStick {
  constructor(port) { this.port = port; this.label = 'ANT stick (serial)'; }
  static async request() {
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ANT_VENDOR }] });
    return new SerialStick(port);
  }
  async open(onBytes) {
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.running = true;
    (async () => {
      while (this.running && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) onBytes(value);
          }
        } catch (e) {
          if (this.running) { this.running = false; this.onLost?.(e); }
        } finally { this.reader.releaseLock(); }
      }
    })();
  }
  async write(bytes) { await this.writer.write(bytes); }
  async close() {
    this.running = false;
    try { await this.reader?.cancel(); } catch (e) { /* */ }
    try { this.writer?.releaseLock(); } catch (e) { /* */ }
    try { await this.port.close(); } catch (e) { /* */ }
  }
}

// Opens a stick, sets it up for scanning and hands every decoded data message to onData.
export class AntScanner {
  constructor({ onData, onStatus, onEvent }) { Object.assign(this, { onData, onStatus, onEvent }); this.deframer = new Deframer(); }
  async start(stick, network = 'public') {
    this.stick = stick;
    this.network = network;
    stick.onLost = () => this.onStatus?.('lost', 'The stick stopped answering. Unplug it, plug it back in and press Connect.');
    this.onStatus?.('connecting', stick.label);
    await stick.open(bytes => this.receive(bytes));
    await this.setup();
    this.onStatus?.('connected', stick.label);
  }
  // (Re)configures the stick; also used to switch networks while connected.
  async setup(network = this.network) {
    this.network = network;
    const stick = this.stick;
    const cmds = scanSetup(network);
    await stick.write(cmds[0]);
    await new Promise(r => setTimeout(r, 600));         // the stick restarts after a reset
    for (const c of cmds.slice(1)) { await stick.write(c); await new Promise(r => setTimeout(r, 60)); }
  }
  receive(bytes) {
    for (const m of this.deframer.push(bytes)) {
      const data = parseData(m);
      if (data) { this.onData?.(data); continue; }
      const ev = describeEvent(m);
      if (ev) this.onEvent?.(ev);
    }
  }
  async stop() {
    try { await this.stick?.write(frame(MSG.CLOSE, [0])); } catch (e) { /* */ }
    await this.stick?.close();
    this.onStatus?.('off');
  }
}
