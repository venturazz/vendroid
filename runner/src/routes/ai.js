import { sendJson } from '../http.js';
import * as ai from '../ai.js';
import * as aicode from '../aicode.js';
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
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    try {
      const out = await aicode.chat(p, opts, (d) => send('delta', { text: d }), ac.signal);
      send('done', out);
    } catch (e) {
      if (!ac.signal.aborted) send('error', { message: e.message });
    } finally {
      clearInterval(hb);
      res.end();
    }
  });
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
