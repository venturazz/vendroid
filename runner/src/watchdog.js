// Keeps the VPN/tunnel ADB connection to DEFAULT_DEVICE_ADDRESS alive.
// Phones drop TCP ADB when the tunnel blips, the screen sleeps or the runner restarts; this
// re-runs `adb connect` quietly so the user never has to click "Reconnect".
import { config } from './config.js';
import * as adbm from './adb.js';
import { isTcpTarget } from './validate.js';

export class AdbWatchdog {
  constructor() {
    this.target = isTcpTarget(config.defaultDevice) ? config.defaultDevice : '';
    this.enabled = config.adbAutoReconnect && !!this.target;
    this.paused = false; // set when the user explicitly disconnects the default device
    this.busy = false;
    this.timer = null;
    this.failures = 0;
    this.status = { target: this.target || null, enabled: this.enabled, state: 'unknown', lastCheck: null, lastConnect: null, message: '' };
  }

  start() {
    if (!this.enabled) return;
    const loop = async () => {
      await this.tick();
      // Back off up to 5 minutes while the phone is unreachable (tunnel down, phone off).
      const delay = Math.min(config.adbReconnectIntervalMs * 2 ** Math.min(this.failures, 4), 300_000);
      this.timer = setTimeout(loop, delay);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }

  stop() { clearTimeout(this.timer); }

  /** Called by the API when the user manually disconnects/connects. */
  noteManual(action, target) {
    if (target !== this.target) return;
    this.paused = action === 'disconnect';
    this.status.state = this.paused ? 'paused' : this.status.state;
    this.failures = 0;
  }

  view() { return { ...this.status, paused: this.paused }; }

  async tick() {
    if (this.busy || this.paused) return;
    this.busy = true;
    try {
      this.status.lastCheck = new Date().toISOString();
      let dev;
      try {
        dev = (await adbm.listDevices()).find((d) => d.serial === this.target);
      } catch (e) {
        this.status.state = 'adb-error';
        this.status.message = e.message;
        this.failures++;
        return;
      }
      if (dev?.state === 'device') {
        this.status.state = 'connected';
        this.status.message = '';
        this.failures = 0;
        return;
      }
      if (dev?.state === 'unauthorized') {
        // Waiting for the user to accept the RSA prompt on the phone; reconnecting won't help.
        this.status.state = 'unauthorized';
        this.status.message = 'Accept "Allow USB debugging" on the phone (tick "Always allow").';
        return;
      }
      if (dev) await adbm.disconnect(this.target).catch(() => {}); // stale "offline" entry
      const r = await adbm.connect(this.target).catch((e) => ({ ok: false, message: e.message }));
      this.status.lastConnect = new Date().toISOString();
      this.status.state = r.ok ? 'connected' : 'unreachable';
      this.status.message = r.message;
      this.failures = r.ok ? 0 : this.failures + 1;
      if (r.ok) console.log(`[watchdog] reconnected ${this.target}`);
    } finally {
      this.busy = false;
    }
  }
}
