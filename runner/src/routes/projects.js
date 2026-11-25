import { sendJson } from '../http.js';
import * as files from '../files.js';
import * as git from '../git.js';
import { bad } from '../validate.js';
import { TEMPLATE_IDS } from '../projects.js';

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
  router.post('/api/projects/:id/settings', (req, res, { params, body }) => sendJson(res, 200, projects.update(params.id, body)));
  router.post('/api/projects/:id/delete', (req, res, { params, body }) => sendJson(res, 200, projects.remove(params.id, body.confirm)));

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
