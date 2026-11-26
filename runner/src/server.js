// Vendroid: browser Android IDE + remote build & device runner. Zero-dependency Node.js (node:http).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configProblems, aapt2Path } from './config.js';
import { Router, readJson, readRaw, sendJson, serveStatic } from './http.js';
import * as auth from './auth.js';
import { BuildManager } from './builds.js';
import { ProjectStore } from './projects.js';
import { ensureGradleProperties } from './gradleProps.js';
import { AdbWatchdog } from './watchdog.js';
import { createAgentTools } from './agent.js';
import { HttpError } from './validate.js';
import * as coreRoutes from './routes/core.js';
import * as buildRoutes from './routes/builds.js';
import * as deviceRoutes from './routes/devices.js';
import * as projectRoutes from './routes/projects.js';
import * as aiRoutes from './routes/ai.js';
import * as agentRoutes from './routes/agent.js';
import * as playRoutes from './routes/play.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const trustProxy = ['1', 'true'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
const projects = new ProjectStore();
const builds = new BuildManager(projects);
const watchdog = new AdbWatchdog();
const agentTools = createAgentTools({ projects, builds, watchdog });
const router = new Router();

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  // Scripts only from this origin. Inline *styles* are allowed for the code editor's dynamic theming.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// Unix-socket connections only come from the edge relay (behind Traefik), so XFF is trusted there.
const clientIp = (req) => {
  const viaSocket = !req.socket.remoteAddress;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return ((trustProxy || viaSocket) && xff) || req.socket.remoteAddress || 'unknown';
};

const ctx = { builds, projects, watchdog, agentTools, clientIp };
for (const mod of [coreRoutes, buildRoutes, deviceRoutes, projectRoutes, aiRoutes, agentRoutes, playRoutes]) mod.register(router, ctx);

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
router.get('/assets/js/:file', (req, res, { params }) =>
  serveStatic(res, path.join(PUBLIC, 'app', 'js'), params.file) || sendJson(res, 404, { error: 'Not found' }));
router.get('/vendor/:file', (req, res, { params }) =>
  serveStatic(res, path.join(PUBLIC, 'vendor'), params.file) || sendJson(res, 404, { error: 'Not found' }));

// ---------------------------------------------------------------- dispatcher
async function handle(req, res) {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  try {
    const m = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    req.authKind = auth.isAuthenticated(req);
    if (!m.route.opts.public && !req.authKind) throw new HttpError(401, 'Authentication required');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !auth.sameOrigin(req)) throw new HttpError(403, 'Cross-origin request blocked');
    if (m.route.opts.raw) {
      const raw = await readRaw(req, m.route.opts.maxBytes || 5 * 1024 * 1024);
      await m.route.handler(req, res, { params: m.params, raw, url });
    } else {
      const body = await readJson(req, m.route.opts.maxBytes || 8 * 1024 * 1024, { allowArray: !!m.route.opts.jsonAny });
      await m.route.handler(req, res, { params: m.params, body, url });
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e.status && Number.isInteger(e.status) ? e.status : 500;
    if (status === 500) console.error(`[error] ${req.method} ${url.pathname}:`, e);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: status === 500 ? 'Internal server error' : e.message, ...(e.body || {}) });
  }
}

/** v1 → v2: if ANDROID_PROJECT_PATH lives outside WORKSPACES_DIR, link it in so it shows up as a project. */
function adoptLegacyProject() {
  if (!config.projectPath || !fs.existsSync(config.projectPath)) return;
  const p = path.resolve(config.projectPath);
  if (path.dirname(p) === config.workspacesDir) return;
  const link = path.join(config.workspacesDir, path.basename(p));
  if (!fs.existsSync(link)) {
    try { fs.symlinkSync(p, link, 'dir'); console.log(`linked legacy project ${p} -> ${link}`); } catch (e) { console.warn(`could not link legacy project: ${e.message}`); }
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
  projects.init();
  adoptLegacyProject();
  builds.init();
  const gp = ensureGradleProperties();
  watchdog.start();
  const mk = () => {
    const srv = http.createServer(handle);
    srv.requestTimeout = 0; // long-lived SSE
    srv.timeout = 0;
    srv.keepAliveTimeout = 65_000;
    srv.on('error', (e) => {
      console.error(`listen error: ${e.message}`);
      process.exit(1);
    });
    return srv;
  };
  const servers = [];
  if (config.listenSocket) {
    fs.mkdirSync(path.dirname(config.listenSocket), { recursive: true });
    fs.rmSync(config.listenSocket, { force: true }); // stale socket from a previous run
    const sock = mk();
    sock.listen(config.listenSocket, () => {
      fs.chmodSync(config.listenSocket, 0o660);
      console.log(`also listening on unix:${config.listenSocket}`);
    });
    servers.push(sock);
  }
  const server = mk();
  servers.push(server);
  server.listen(config.port, config.host, () => {
    console.log(`vendroid listening on http://${config.host}:${config.port}`);
    console.log(`workspaces=${config.workspacesDir} projects=${projects.list().length} data=${config.dataDir}${gp ? ` gradle.properties=${gp}` : ''}`);
    console.log(`aapt2=${aapt2Path() || '(SDK default / pending bootstrap)'} adb=${config.adbBin} release-signing=${config.signingEnabled() ? 'on' : 'off'}`
      + ` auto-reconnect=${watchdog.enabled ? watchdog.target : 'off'} git-webhook=${config.gitWebhookSecret ? 'on' : 'off'}`
      + ` git-token=${config.gitToken ? 'set' : 'none'} mcp=/mcp`);
  });
  const shutdown = () => {
    watchdog.stop();
    const id = builds.activeId();
    if (id) { try { builds.cancel(id); } catch { /* ignore */ } }
    servers.forEach((s) => s.close());
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
