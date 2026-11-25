// Password login -> HMAC-signed session cookie. Optional static bearer token for scripts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseCookies } from './http.js';

export const COOKIE = 'runner_session';
let secret;

/**
 * Zero-config first boot: without AUTH_PASSWORD a random password is generated once, stored in
 * DATA_DIR/initial_password (0600) and printed to the service log (journalctl / docker logs).
 */
function ensurePassword() {
  if (config.authPassword) return;
  const f = path.join(config.dataDir, 'initial_password');
  let pw = '';
  try { pw = fs.readFileSync(f, 'utf8').trim(); } catch { /* first boot */ }
  if (pw.length < 8) {
    pw = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(f, pw + '\n', { mode: 0o600 });
  }
  config.authPassword = pw;
  config.generatedPassword = true;
  console.log('='.repeat(72));
  console.log(` AUTH_PASSWORD not set. Dashboard password: ${pw}`);
  console.log(` (stored in ${f}; set AUTH_PASSWORD to choose your own)`);
  console.log('='.repeat(72));
}

export function initAuth() {
  ensurePassword();
  if (config.sessionSecret.length >= 16) {
    secret = config.sessionSecret;
    return;
  }
  const f = path.join(config.dataDir, '.session_secret');
  try {
    secret = fs.readFileSync(f, 'utf8').trim();
  } catch {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, secret, { mode: 0o600 });
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (p) => crypto.createHmac('sha256', secret).update(p).digest('base64url');

export function checkPassword(pw) {
  return typeof pw === 'string' && safeEq(pw, config.authPassword);
}

export function makeSession() {
  const exp = Date.now() + config.sessionTtlHours * 3600_000;
  const payload = `${exp}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}

function validSession(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!safeEq(token.slice(i + 1), sign(payload))) return false;
  return Number(payload.split('.')[0]) > Date.now();
}

export function isAuthenticated(req) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (bearer && config.apiToken.length >= 16 && safeEq(bearer[1], config.apiToken)) return 'token';
  return validSession(parseCookies(req.headers.cookie)[COOKIE]) ? 'session' : false;
}

export function isSecureRequest(req) {
  if (config.cookieSecure !== 'auto') return config.cookieSecure;
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

export function cookieHeader(req, value, maxAgeSec) {
  let c = `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
  if (isSecureRequest(req)) c += '; Secure';
  return c;
}

/** Brute-force throttle: 10 failures / 15 min per client address. */
const fails = new Map();
export function loginAllowed(ip) {
  const e = fails.get(ip);
  return !(e && e.reset > Date.now() && e.n >= 10);
}
export function loginFailed(ip) {
  const e = fails.get(ip);
  if (!e || e.reset < Date.now()) fails.set(ip, { n: 1, reset: Date.now() + 15 * 60_000 });
  else e.n++;
}
export function loginOk(ip) { fails.delete(ip); }

/** Reject cross-origin state-changing browser requests. */
export function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === (req.headers['x-forwarded-host'] || req.headers.host);
  } catch {
    return false;
  }
}
