// Android Remote Build & Device Test Runner - zero-dependency Node.js (node:http) backend.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configProblems } from './config.js';
import { Router, readJson, sendJson, serveStatic } from './http.js';
import { openSse } from './sse.js';
import * as auth from './auth.js';
import * as adbm from './adb.js';
import * as ai from './ai.js';
import { envHealth } from './health.js';
import { BuildManager } from './builds.js';
import { ensureGradleProperties } from './gradleProps.js';
import { HttpError, LEVELS, bad, isBuildId, isLevel, isPackage, isSerial, isTcpTarget } from './validate.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const trustProxy = ['1', 'true'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
const builds = new BuildManager();
const router = new Router();

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const clientIp = (req) =>
  (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

const str = (v, max, name) => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} must be a string up to ${max} chars`);
  return v;
};
const serialOf = (v) => {
  const s = v || config.defaultDevice;
  if (!isSerial(s)) throw bad('A valid device serial or <ip>:<port> is required');
  return s;
};
const pkgOf = (v) => {
  const p = v || config.defaultPackage;
  if (!isPackage(p)) throw bad('A valid package name is required');
  return p;
};

// ---------------------------------------------------------------- auth + health
router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true }), { public: true });

router.post('/api/auth/login', async (req, res, { body }) => {
  const ip = clientIp(req);
  if (!auth.loginAllowed(ip)) throw new HttpError(429, 'Too many failed attempts. Try again later.');
  if (!auth.checkPassword(body.password)) {
    auth.loginFailed(ip);
    throw new HttpError(401, 'Invalid password');
  }
  auth.loginOk(ip);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(req, auth.makeSession(), config.sessionTtlHours * 3600) });
}, { public: true });

router.post('/api/auth/logout', (req, res) =>
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(req, '', 0) }), { public: true });

router.get('/api/auth/me', (req, res) => sendJson(res, 200, { authenticated: !!auth.isAuthenticated(req) }), { public: true });

router.get('/api/health/env', async (req, res) => sendJson(res, 200, await envHealth()));
router.get('/api/ai/status', async (req, res) => sendJson(res, 200, await ai.aiStatus()));
router.get('/api/config', (req, res) => sendJson(res, 200, {
  defaultPackage: config.defaultPackage, defaultDevice: config.defaultDevice, levels: LEVELS,
  tasks: ['assembleDebug', 'assembleRelease', 'clean assembleDebug'],
}));

// ---------------------------------------------------------------- builds
router.post('/api/builds', (req, res, { body }) => sendJson(res, 202, builds.enqueue(body)));
router.get('/api/builds', (req, res) => sendJson(res, 200, { active: builds.activeId(), builds: builds.list() }));
router.get('/api/builds/:id', (req, res, { params }) => sendJson(res, 200, builds.view(builds.get(params.id))));
router.post('/api/builds/:id/cancel', (req, res, { params }) => sendJson(res, 200, builds.cancel(params.id)));

router.get('/api/builds/:id/apk', (req, res, { params }) => {
  const b = builds.get(params.id);
  const file = builds.apkPath(b);
  if (!file) throw new HttpError(404, 'No APK artifact for this build');
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename="${b.id}-${path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')}"`,
  });
  fs.createReadStream(file).pipe(res);
});

router.get('/api/builds/:id/stream', (req, res, { params, url }) => {
  builds.get(params.id);
  const last = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0) || 0;
  const sse = openSse(req, res);
  const batchState = { v: null };
  const unsub = builds.subscribe(params.id, last, {
    onLine: (e) => sse.send('line', e.text, e.n),
    onState: (s) => {
      sse.send('state', s);
      batchState.v = s;
      if (['succeeded', 'failed', 'cancelled'].includes(s.state)) setImmediate(() => { sse.send('end', s); sse.end(); });
    },
  });
  sse.onClose(unsub);
});

// ---------------------------------------------------------------- devices
router.get('/api/devices', async (req, res) => {
  try {
    sendJson(res, 200, { devices: await adbm.listDevices() });
  } catch (e) {
    throw new HttpError(502, e.message);
  }
});
router.post('/api/devices/connect', async (req, res, { body }) => {
  if (!isTcpTarget(body.target)) throw bad('target must be <ipv4>:<port>');
  sendJson(res, 200, await adbm.connect(body.target));
});
router.post('/api/devices/disconnect', async (req, res, { body }) => {
  if (!isTcpTarget(body.target)) throw bad('target must be <ipv4>:<port>');
  sendJson(res, 200, await adbm.disconnect(body.target));
});
router.post('/api/adb/restart', async (req, res, { body }) => {
  sendJson(res, 200, await adbm.restartHelper(body.mode, body.serial || config.defaultDevice));
});
router.post('/api/devices/action', async (req, res, { body }) => {
  const serial = serialOf(body.serial);
  const action = body.action;
  if (action === 'install') {
    const b = body.buildId ? builds.get(body.buildId) : builds.latestApk();
    const apk = b && builds.apkPath(b);
    if (!apk) throw new HttpError(404, 'No built APK available to install');
    const r = await adbm.installApk(serial, apk);
    return sendJson(res, 200, { ...r, buildId: b.id });
  }
  if (!['launch', 'stop', 'clear'].includes(action)) throw bad('action must be install, launch, stop or clear');
  sendJson(res, 200, await adbm.deviceAction(action, serial, pkgOf(body.packageName)));
});
router.get('/api/devices/screenshot', async (req, res, { url }) => {
  const png = await adbm.screenshot(serialOf(url.searchParams.get('serial')));
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
  res.end(png);
});

// ---------------------------------------------------------------- logcat
router.get('/api/logcat/stream', async (req, res, { url }) => {
  const q = url.searchParams;
  const serial = serialOf(q.get('serial'));
  const level = q.get('level') || 'V';
  if (!isLevel(level)) throw bad('level must be one of V, D, I, W, E');
  const tag = str(q.get('tag') || '', 100, 'tag');
  const text = str(q.get('q') || '', 200, 'q');
  const packageName = q.get('package') ? pkgOf(q.get('package')) : '';
  const sse = openSse(req, res);
  let handle;
  try {
    handle = await adbm.startLogcat(
      { serial, minLevel: level, tag, q: text, packageName },
      (lines) => sse.send('lines', lines),
      (err) => { if (err) sse.send('error', { message: err }); sse.send('end', {}); sse.end(); },
    );
  } catch (e) {
    sse.send('error', { message: e.message });
    return sse.end();
  }
  sse.send('ready', { serial, pid: handle.pid || null });
  sse.onClose(() => handle.stop());
});
router.post('/api/logcat/clear', async (req, res, { body }) => sendJson(res, 200, await adbm.clearLogcat(serialOf(body.serial))));

// ---------------------------------------------------------------- AI
const wrapAi = async (fn) => {
  try { return await fn(); } catch (e) { throw e.status ? new HttpError(e.status, e.message) : e; }
};
router.post('/api/ai/analyze', async (req, res, { body }) => {
  let text = '';
  if (body.jobId) text = builds.tail(String(body.jobId), 800);
  else text = str(body.text, 400_000, 'text');
  sendJson(res, 200, await wrapAi(() => ai.analyze({ mode: body.mode, text })));
});
router.post('/api/ai/hermes-investigate', async (req, res, { body }) => {
  let errorTail = str(body.errorTail, 100_000, 'errorTail');
  if (body.jobId) {
    if (!isBuildId(body.jobId)) throw bad('Invalid jobId');
    if (!errorTail) errorTail = ai.sliceBuildError(builds.tail(body.jobId, 400));
  }
  const crashSnippet = body.crashSnippet ? ai.sliceCrash(str(body.crashSnippet, 400_000, 'crashSnippet')) : '';
  if (!errorTail && !crashSnippet) throw bad('Nothing to investigate: provide jobId, errorTail or crashSnippet');
  const r = await ai.notifyHermes({
    event: crashSnippet && !errorTail ? 'logcat_crash' : 'manual_investigation',
    jobId: body.jobId || null,
    packageName: body.packageName ? pkgOf(body.packageName) : '',
    deviceSerial: body.deviceSerial ? serialOf(body.deviceSerial) : '',
    errorTail, crashSnippet,
  });
  sendJson(res, r.ok ? 200 : 502, r);
});

// ---------------------------------------------------------------- static UI
const serveIndex = (req, res) => {
  const ok = auth.isAuthenticated(req);
  if (!serveStatic(res, PUBLIC, ok ? 'app/index.html' : 'login.html')) throw new HttpError(404, 'UI not found');
};
router.get('/', serveIndex, { public: true });
router.get('/login.js', (req, res) => serveStatic(res, PUBLIC, 'login.js') || sendJson(res, 404, { error: 'Not found' }), { public: true });
router.get('/login.css', (req, res) => serveStatic(res, PUBLIC, 'login.css') || sendJson(res, 404, { error: 'Not found' }), { public: true });
router.get('/assets/:file', (req, res, { params }) =>
  serveStatic(res, path.join(PUBLIC, 'app'), params.file) || sendJson(res, 404, { error: 'Not found' }));

// ---------------------------------------------------------------- dispatcher
async function handle(req, res) {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  try {
    const m = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (!m.route.opts.public) {
      if (!auth.isAuthenticated(req)) throw new HttpError(401, 'Authentication required');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !auth.sameOrigin(req)) throw new HttpError(403, 'Cross-origin request blocked');
    const body = await readJson(req);
    await m.route.handler(req, res, { params: m.params, body, url });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(`[error] ${req.method} ${url.pathname}:`, e);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: status === 500 ? 'Internal server error' : e.message });
  }
}

export function start() {
  const problems = configProblems();
  if (problems.length) {
    console.error('Configuration errors:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  auth.initAuth();
  builds.init();
  const gp = ensureGradleProperties();
  const server = http.createServer(handle);
  server.requestTimeout = 0; // long-lived SSE
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;
  server.listen(config.port, config.host, () => {
    console.log(`android-remote-runner listening on http://${config.host}:${config.port}`);
    console.log(`project=${config.projectPath} data=${config.dataDir}${gp ? ` gradle.properties=${gp}` : ''}`);
  });
  const shutdown = () => {
    const id = builds.activeId();
    if (id) { try { builds.cancel(id); } catch { /* ignore */ } }
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
