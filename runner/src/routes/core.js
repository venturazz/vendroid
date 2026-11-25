import { config } from '../config.js';
import { sendJson } from '../http.js';
import * as auth from '../auth.js';
import * as ai from '../ai.js';
import { envHealth } from '../health.js';
import { HttpError, LEVELS } from '../validate.js';
import { TEMPLATE_IDS } from '../projects.js';
import { PLAY_TARGET_SDK } from '../play.js';
import { templateVersions } from '../projects.js';

export function register(router, { watchdog, clientIp }) {
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
    defaultDevice: config.defaultDevice, levels: LEVELS,
    tasks: ['assembleDebug', 'assembleRelease', 'clean assembleDebug', 'bundleRelease'],
    playTargetSdk: PLAY_TARGET_SDK,
    templateVersions: templateVersions(),
    templates: TEMPLATE_IDS,
    releaseSigning: config.signingEnabled(),
    gitTokenConfigured: !!config.gitToken,
    gitIdentity: { name: config.gitUserName, email: config.gitUserEmail },
    gitWebhook: { enabled: !!config.gitWebhookSecret, path: '/api/hooks/git', branch: config.autoBuildBranch || null },
    autoReconnect: watchdog.view(),
    workspacesDir: config.workspacesDir,
  }));
}
