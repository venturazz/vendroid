import { sendJson } from '../http.js';
import * as files from '../files.js';
import * as git from '../git.js';
import { bad } from '../validate.js';
import { TEMPLATE_IDS } from '../projects.js';
import { imageInfo, mimeFor } from '../imageinfo.js';
import { FORBIDDEN } from '../aicode.js';
import { bus, realRoot } from '../events.js';
import { openSse } from '../sse.js';

export function register(router, { projects, builds }) {
  const P = (id) => projects.get(id);

  // ---- hub
  router.get('/api/projects', (req, res) => {
    const list = projects.list().map((p) => {
      const last = builds.list(p.id)[0] || null;
      return { ...p, lastBuild: last && { id: last.id, state: last.state, task: last.task, finishedAt: last.finishedAt, apk: last.apk } };
    });
    sendJson(res, 200, { projects: list, queue: builds.queueView(), templates: TEMPLATE_IDS });
  });
  router.post('/api/projects', async (req, res, { body }) => sendJson(res, 201, await projects.create(body)));
  router.post('/api/projects/clone', async (req, res, { body }) => sendJson(res, 201, await projects.clone(body)));
  router.get('/api/projects/:id', (req, res, { params }) => sendJson(res, 200, P(params.id)));

  // Live view for the IDE: `files` {paths|null, kinds} (coalesced over 150 ms) and `build` {view}.
  router.get('/api/projects/:id/events', (req, res, { params }) => {
    const p = P(params.id);
    const root = realRoot(p.path);
    const sse = openSse(req, res);
    let pending = null; // { paths:Set|null, kinds:Set }
    let timer = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      sse.send('files', { paths: pending.paths ? [...pending.paths] : null, kinds: [...pending.kinds] });
      pending = null;
    };
    const onFiles = (e) => {
      if (e.root !== root) return;
      if (!pending) pending = { paths: new Set(), kinds: new Set() };
      pending.kinds.add(e.kind);
      if (e.paths === null || pending.paths === null || pending.paths.size > 200) pending.paths = null;
      else for (const x of e.paths) pending.paths.add(x);
      if (!timer) timer = setTimeout(flush, 150);
    };
    const onBuild = (b) => { if (b.projectId === p.id) sse.send('build', b); };
    bus.on('files', onFiles);
    bus.on('build', onBuild);
    sse.send('hello', { project: p.id });
    sse.onClose(() => { bus.off('files', onFiles); bus.off('build', onBuild); clearTimeout(timer); });
  });
  router.post('/api/projects/:id/settings', (req, res, { params, body }) => sendJson(res, 200, projects.update(params.id, body)));
  router.post('/api/projects/:id/delete', (req, res, { params, body }) => sendJson(res, 200, projects.remove(params.id, body.confirm)));
  router.get('/api/trash', (req, res) => sendJson(res, 200, { items: projects.listTrash() }));
  router.post('/api/trash/restore', (req, res, { body }) => sendJson(res, 200, projects.restore(body.entry)));
  router.post('/api/trash/purge', (req, res, { body }) => sendJson(res, 200, projects.purgeTrash(body.entry)));

  // ---- files
  router.get('/api/projects/:id/tree', (req, res, { params, url }) => {
    const p = P(params.id);
    sendJson(res, 200, { entries: files.list(p.path, url.searchParams.get('path') || '', { showHidden: url.searchParams.get('hidden') === '1' }) });
  });
  router.get('/api/projects/:id/files', (req, res, { params }) => sendJson(res, 200, { files: files.allFiles(P(params.id).path) }));
  router.get('/api/projects/:id/file', (req, res, { params, url }) => sendJson(res, 200, files.read(P(params.id).path, url.searchParams.get('path') || '')));
  router.post('/api/projects/:id/file', (req, res, { params, body }) =>
    sendJson(res, 200, files.write(P(params.id).path, body.path, body.content, { baseHash: body.baseHash, create: body.create === true })));
  router.post('/api/projects/:id/fs', (req, res, { params, body }) => {
    const root = P(params.id).path;
    switch (body.op) {
      case 'mkdir': return sendJson(res, 200, files.mkdir(root, body.path));
      case 'rename': return sendJson(res, 200, files.rename(root, body.path, body.to));
      case 'delete': return sendJson(res, 200, files.remove(root, body.path));
      default: throw bad('op must be mkdir, rename or delete');
    }
  });
  // Raw bytes (image preview, sound/font download). Never served inline as HTML/SVG script.
  router.get('/api/projects/:id/raw', (req, res, { params, url }) => {
    const rel = url.searchParams.get('path') || '';
    const buf = files.readBytes(P(params.id).path, rel);
    const mime = mimeFor(rel);
    const safeInline = /^(image\/(png|jpeg|webp|gif)|audio\/|video\/)/.test(mime);
    res.writeHead(200, {
      'Content-Type': safeInline ? mime : 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `${safeInline && url.searchParams.get('download') !== '1' ? 'inline' : 'attachment'}; filename="${rel.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    });
    res.end(buf);
  });
  // Upload any file: body = raw bytes, ?path=dir/name, &overwrite=1 to replace.
  router.post('/api/projects/:id/upload', (req, res, { params, raw, url }) => {
    const rel = url.searchParams.get('path') || '';
    if (FORBIDDEN.test(rel)) throw bad('path not allowed');
    const r = files.writeBytes(P(params.id).path, rel, raw, { create: url.searchParams.get('overwrite') !== '1' });
    sendJson(res, 201, { ...r, image: imageInfo(raw) || undefined });
  }, { raw: true, maxBytes: 40 * 1024 * 1024 });
  router.get('/api/projects/:id/search', (req, res, { params, url }) => sendJson(res, 200, files.search(P(params.id).path, url.searchParams.get('q') || '')));

  // ---- git
  const repo = (id) => {
    const p = P(id);
    if (!p.git) throw bad('This project is not a git repository (use "Initialize Git")');
    return p.path;
  };
  router.get('/api/projects/:id/git/status', async (req, res, { params }) => sendJson(res, 200, await git.status(P(params.id).path)));
  router.get('/api/projects/:id/git/diff', async (req, res, { params, url }) =>
    sendJson(res, 200, { diff: await git.diff(repo(params.id), url.searchParams.get('path') || undefined) }));
  router.get('/api/projects/:id/git/log', async (req, res, { params }) => sendJson(res, 200, { commits: await git.log(repo(params.id), 30) }));
  router.get('/api/projects/:id/git/branches', async (req, res, { params }) => sendJson(res, 200, { branches: await git.branches(repo(params.id)) }));
  router.post('/api/projects/:id/git/init', async (req, res, { params }) => {
    const p = P(params.id);
    if (!p.git) await git.init(p.path);
    sendJson(res, 200, await git.status(p.path));
  });
  router.post('/api/projects/:id/git/commit', async (req, res, { params, body }) =>
    sendJson(res, 200, await git.commit(repo(params.id), { message: body.message, files: body.files })));
  router.post('/api/projects/:id/git/pull', async (req, res, { params }) => sendJson(res, 200, await git.pull(repo(params.id))));
  router.post('/api/projects/:id/git/push', async (req, res, { params }) => sendJson(res, 200, await git.push(repo(params.id))));
  router.post('/api/projects/:id/git/checkout', async (req, res, { params, body }) =>
    sendJson(res, 200, await git.checkout(repo(params.id), { branch: body.branch, create: body.create === true })));
  router.post('/api/projects/:id/git/discard', async (req, res, { params, body }) => sendJson(res, 200, await git.discard(repo(params.id), body.path)));
}
