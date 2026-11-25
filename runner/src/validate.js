// Strict allowlist validation for every value that ends up in a process argv.
export const TASKS = Object.freeze({
  assembleDebug: { args: ['assembleDebug'], variant: 'debug' },
  assembleRelease: { args: ['assembleRelease'], variant: 'release' },
  'clean assembleDebug': { args: ['clean', 'assembleDebug'], variant: 'debug' },
});

export const LEVELS = ['V', 'D', 'I', 'W', 'E'];
export const LEVEL_RANK = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 4 };

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const BUILD_ID_RE = /^b[0-9a-z]{6,12}-[0-9a-f]{6}$/;
const MODULE_RE = /^[A-Za-z0-9_-]{1,40}(:[A-Za-z0-9_-]{1,40})*$/;
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/; // USB / emulator serials

function validIPv4(s) {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

/** `<ipv4>:<port>` only (VPN/mesh tunnel address). */
export function isTcpTarget(s) {
  if (typeof s !== 'string') return false;
  const m = /^([0-9.]{7,15}):(\d{1,5})$/.exec(s);
  if (!m) return false;
  const port = Number(m[2]);
  return validIPv4(m[1]) && port >= 1 && port <= 65535;
}

/** Device serial: tunnel address or a plain adb serial. */
export function isSerial(s) {
  return typeof s === 'string' && (isTcpTarget(s) || SERIAL_RE.test(s));
}
export const isPackage = (s) => typeof s === 'string' && s.length <= 200 && PACKAGE_RE.test(s);
export const isBuildId = (s) => typeof s === 'string' && BUILD_ID_RE.test(s);
export const isModule = (s) => typeof s === 'string' && MODULE_RE.test(s);
export const isTask = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(TASKS, s);
export const isLevel = (s) => typeof s === 'string' && LEVELS.includes(s);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = (msg) => new HttpError(400, msg);
