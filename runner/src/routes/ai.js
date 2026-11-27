import { sendJson } from '../http.js';
import * as ai from '../ai.js';
import * as aicode from '../aicode.js';
import * as providers from '../providers.js';
import * as hermes from '../hermes.js';
import * as chatjobs from '../chatjobs.js';
import { openSse } from '../sse.js';
import { HttpError, bad, isBuildId } from '../validate.js';
import { str, serialOf, pkgOf } from './util.js';

export function register(router, { builds, projects }) {
  const wrapAi = async (fn) => {
    try { return await fn(); } catch (e) { throw e.status ? new HttpError(e.status, e.message) : e; }
  };

  // ---- analysis (9Router) + Hermes hand-off
  router.post('/api/ai/analyze', async (req, res, { body }) => {
    let text = '';
    if (body.jobId) text = builds.tail(String(body.jobId), 800);
    else text = str(body.text, 400_000, 'text');
    sendJson(res, 200, await wrapAi(() => ai.analyze({ mode: body.mode, text })));
  });
  router.post('/api/ai/hermes-investigate', async (req, res, { body }) => {
    let errorTail = str(body.errorTail, 100_000, 'errorTail');
    let proj = body.projectId ? projects.get(body.projectId) : null;
    if (body.jobId) {
      if (!isBuildId(body.jobId)) throw bad('Invalid jobId');
      const b = builds.get(body.jobId);
      if (!proj && b.projectId && projects.exists(b.projectId)) proj = projects.get(b.projectId);
      if (!errorTail) errorTail = ai.sliceBuildError(builds.tail(body.jobId, 400));
    }
    const crashSnippet = body.crashSnippet ? ai.sliceCrash(str(body.crashSnippet, 400_000, 'crashSnippet')) : '';
    if (!errorTail && !crashSnippet) throw bad('Nothing to investigate: provide jobId, errorTail or crashSnippet');
    const r = await ai.notifyHermes({
      event: crashSnippet && !errorTail ? 'logcat_crash' : 'manual_investigation',
      jobId: body.jobId || null,
      projectId: proj?.id, projectName: proj?.name, projectPath: proj?.path,
      packageName: body.packageName ? pkgOf(body.packageName) : proj?.packageName || '',
      deviceSerial: body.deviceSerial ? serialOf(body.deviceSerial) : '',
      errorTail, crashSnippet,
    });
    sendJson(res, r.ok ? 200 : 502, r);
  });

  // ---- AI coding panel
  router.get('/api/projects/:id/ai/history', (req, res, { params }) => {
    projects.get(params.id);
    sendJson(res, 200, { messages: aicode.loadHistory(params.id) });
  });
  router.post('/api/projects/:id/ai/clear', (req, res, { params }) => {
    projects.get(params.id);
    aicode.clearHistory(params.id);
    hermes.clearSession(params.id);
    sendJson(res, 200, { ok: true });
  });

  /** Streams the answer as SSE over the POST response: delta {text} … done {message, proposal} | error. */
  router.post('/api/projects/:id/ai/chat', async (req, res, { params, body }) => {
    const p = projects.get(params.id);
    const opts = {
      message: body.message,
      activeFile: typeof body.activeFile === 'string' ? body.activeFile : undefined,
      contextFiles: Array.isArray(body.contextFiles) ? body.contextFiles.filter((f) => typeof f === 'string').slice(0, 30) : [],
      selection: typeof body.selection === 'string' ? body.selection : undefined,
      buildLog: body.buildId && isBuildId(body.buildId) ? builds.tail(body.buildId, 600) : undefined,
    };
    if (typeof opts.message !== 'string' || !opts.message.trim()) throw bad('message is required');
    const prov = providers.resolve(typeof body.providerId === 'string' ? body.providerId : undefined);
    if (typeof body.model === 'string' && body.model.trim()) prov.model = body.model.trim().slice(0, 200);
    const busy = chatjobs.active(p.id);
    if (busy) {
      const e = new HttpError(409, 'The AI is still answering the previous message. Wait for it or press Stop.');
      e.body = { busy: true, job: chatjobs.view(busy) };
      throw e;
    }
    // The turn runs as a job: closing this response (phone locked, proxy timeout) does not stop it.
    const job = chatjobs.start(p.id, { message: opts.message, engine: prov.name }, async (emit, signal) => {
      emit('engine', { id: prov.id, name: prov.name, kind: prov.kind, model: prov.model || null });
      const out = prov.kind === 'hermes'
        ? await hermes.chat(p, opts, prov, (type, data) => emit(type, data), signal)
        : await aicode.chat(p, opts, (d) => emit('delta', { text: d }), signal, prov);
      return { ...out, engine: prov.kind, contextWindow: prov.contextWindow || null };
    });
    job.provider = prov;
    job.opts = opts;
    streamJob(req, res, job, 0);
  });
  router.get('/api/projects/:id/ai/active', (req, res, { params }) => {
    projects.get(params.id);
    sendJson(res, 200, { job: chatjobs.view(chatjobs.active(params.id)) });
  });
  router.get('/api/projects/:id/ai/jobs/:job/events', (req, res, { params, url }) => {
    projects.get(params.id);
    const job = chatjobs.get(params.job);
    if (!job || job.projectId !== params.id) throw new HttpError(404, 'This AI turn is gone (finished more than 15 minutes ago or the runner restarted)');
    const after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0) || 0;
    streamJob(req, res, job, after);
  });
  router.post('/api/projects/:id/ai/jobs/:job/cancel', async (req, res, { params }) => {
    projects.get(params.id);
    const job = chatjobs.get(params.job);
    if (!job || job.projectId !== params.id) throw new HttpError(404, 'Unknown AI turn');
    const runId = job.opts?.runId;
    const stopped = chatjobs.cancel(job, () => { if (job.provider?.kind === 'hermes' && runId) hermes.stop(job.provider, runId); });
    sendJson(res, 200, { ok: true, stopped });
  });
  /** SSE: job events with ids (EventSource resumes with Last-Event-ID); `end` closes the stream. */
  function streamJob(req, res, job, after) {
    const sse = openSse(req, res);
    sse.send('job', chatjobs.view(job));
    const unsub = chatjobs.subscribe(job, after, (e) => {
      if (e) sse.send(e.event, e.data, e.n);
      else { sse.send('end', { id: job.id }); sse.end(); }
    });
    sse.onClose(unsub);
  }
  router.post('/api/projects/:id/ai/hermes-approval', async (req, res, { params, body }) => {
    projects.get(params.id);
    const prov = providers.resolve(body.providerId);
    if (prov.kind !== 'hermes') throw bad('Not a Hermes provider');
    sendJson(res, 200, await hermes.approve(prov, body));
  });

  // ---- providers (OpenAI-compatible + Hermes API)
  router.get('/api/ai/providers', (req, res) => sendJson(res, 200, { providers: providers.list(), kinds: providers.KINDS }));
  router.post('/api/ai/providers', (req, res, { body }) => sendJson(res, 201, providers.add(body)));
  router.post('/api/ai/providers/:pid', (req, res, { params, body }) => sendJson(res, 200, providers.update(params.pid, body)));
  router.post('/api/ai/providers/:pid/delete', (req, res, { params }) => sendJson(res, 200, providers.remove(params.pid)));
  router.get('/api/ai/providers/:pid/models', async (req, res, { params }) => sendJson(res, 200, { models: await providers.models(params.pid) }));
  router.post('/api/ai/providers/:pid/test', async (req, res, { params, body }) => sendJson(res, 200, await providers.test(params.pid, body.model)));

  router.post('/api/projects/:id/ai/apply', (req, res, { params, body }) =>
    sendJson(res, 200, aicode.apply(projects.get(params.id), String(body.proposalId || ''), body.files)));
  router.post('/api/projects/:id/ai/undo', (req, res, { params, body }) =>
    sendJson(res, 200, aicode.undo(projects.get(params.id), body.applyId)));

  /** Hand a coding task to Hermes; it works through the MCP tools and the result shows up in git/builds. */
  router.post('/api/projects/:id/ai/hermes', async (req, res, { params, body }) => {
    const p = projects.get(params.id);
    const task = str(body.message, 20_000, 'message');
    if (!task.trim()) throw bad('message is required');
    const r = await ai.notifyHermes({
      event: 'agent_task', projectId: p.id, projectName: p.name, projectPath: p.path, packageName: p.packageName || '',
      task, files: Array.isArray(body.contextFiles) ? body.contextFiles.filter((f) => typeof f === 'string') : undefined,
      errorTail: body.buildId && isBuildId(body.buildId) ? ai.sliceBuildError(builds.tail(body.buildId, 400)) : '',
    });
    sendJson(res, r.ok ? 200 : 502, r);
  });
}
