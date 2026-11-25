import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { sendJson } from '../http.js';
import { openSse } from '../sse.js';
import { verifyGitWebhook } from '../webhook.js';
import { HttpError, bad } from '../validate.js';

const TERMINAL = ['succeeded', 'failed', 'cancelled'];

export function register(router, { builds, projects }) {
  const trigger = (req) => (req.authKind === 'token' ? 'api' : 'manual');
  const defaultProject = () => {
    const legacy = projects.legacyId();
    if (legacy && projects.exists(legacy)) return legacy;
    const all = projects.list();
    if (all.length === 1) return all[0].id;
    throw bad('projectId is required (several projects exist)');
  };

  router.post('/api/projects/:id/builds', (req, res, { params, body }) =>
    sendJson(res, 202, builds.enqueue(params.id, body, { trigger: trigger(req) })));
  router.get('/api/projects/:id/builds', (req, res, { params }) => {
    projects.get(params.id);
    sendJson(res, 200, { ...builds.queueView(), builds: builds.list(params.id) });
  });

  // v1-compatible endpoints (projectId optional when there is a single/legacy project)
  router.post('/api/builds', (req, res, { body }) => {
    const { projectId, ...rest } = body;
    sendJson(res, 202, builds.enqueue(projectId || defaultProject(), rest, { trigger: trigger(req) }));
  });
  router.get('/api/builds', (req, res, { url }) =>
    sendJson(res, 200, { ...builds.queueView(), builds: builds.list(url.searchParams.get('project') || undefined) }));
  router.get('/api/builds/:id', (req, res, { params }) => sendJson(res, 200, builds.view(builds.get(params.id))));
  router.post('/api/builds/:id/cancel', (req, res, { params }) => sendJson(res, 200, builds.cancel(params.id)));

  router.get('/api/builds/:id/apk', (req, res, { params }) => {
    const b = builds.get(params.id);
    const file = builds.apkPath(b);
    if (!file) throw new HttpError(404, 'No APK artifact for this build');
    const st = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': file.endsWith('.aab') ? 'application/octet-stream' : 'application/vnd.android.package-archive',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${(b.projectId || 'app').replace(/[^A-Za-z0-9._-]/g, '_')}-${b.id}-${path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    });
    fs.createReadStream(file).pipe(res);
  });
  router.get('/api/builds/:id/log', (req, res, { params }) => {
    const b = builds.get(params.id);
    const file = path.join(config.buildsDir, `${b.id}.log`);
    if (!fs.existsSync(file)) throw new HttpError(404, 'No log for this build');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${b.id}.log"` });
    fs.createReadStream(file).pipe(res);
  });
  router.get('/api/builds/:id/stream', (req, res, { params, url }) => {
    builds.get(params.id);
    const last = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0) || 0;
    const sse = openSse(req, res);
    const unsub = builds.subscribe(params.id, last, {
      onLine: (e) => sse.send('line', e.text, e.n),
      onState: (s) => {
        sse.send('state', s);
        if (TERMINAL.includes(s.state)) setImmediate(() => { sse.send('end', s); sse.end(); });
      },
    });
    sse.onClose(unsub);
  });

  // Push-to-deploy. Project = ?project=<id>, else matched by the repository URL in the payload.
  router.post('/api/hooks/git', async (req, res, { raw, url }) => {
    if (!config.gitWebhookSecret) throw new HttpError(404, 'Not found');
    const hook = verifyGitWebhook(req, raw, config.gitWebhookSecret);
    if (!hook.ok) throw new HttpError(401, hook.reason);
    if (hook.ping) return sendJson(res, 200, { ok: true, pong: true });
    if (!hook.ref || !hook.ref.startsWith('refs/heads/')) return sendJson(res, 202, { ok: true, ignored: 'not a branch push' });
    const branch = hook.ref.slice('refs/heads/'.length);
    if (config.autoBuildBranch && branch !== config.autoBuildBranch) {
      return sendJson(res, 202, { ok: true, ignored: `branch ${branch} != ${config.autoBuildBranch}` });
    }
    if (hook.deleted) return sendJson(res, 202, { ok: true, ignored: 'branch deleted' });
    let project = url.searchParams.get('project');
    if (project) projects.get(project);
    else project = (await projects.findByRemote(hook.repoUrls))?.id;
    if (!project) {
      try { project = defaultProject(); } catch { return sendJson(res, 202, { ok: true, ignored: 'no project matches this repository' }); }
    }
    if (builds.hasQueued('webhook', project)) return sendJson(res, 202, { ok: true, coalesced: true, project });
    const p = projects.get(project);
    const wantDevice = !!config.defaultDevice;
    const b = builds.enqueue(project, {
      task: config.autoBuildTask,
      gitPullBeforeBuild: true,
      autoInstallAfterBuild: wantDevice && config.autoBuildInstall,
      autoLaunchAfterInstall: wantDevice && config.autoBuildInstall && config.autoBuildLaunch && !!p.packageName,
      autoNotifyHermes: config.autoBuildNotifyHermes,
    }, { trigger: 'webhook', ref: branch });
    sendJson(res, 202, { ok: true, buildId: b.id, project });
  }, { public: true, raw: true });
}
