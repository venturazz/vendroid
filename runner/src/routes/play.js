import fs from 'node:fs';
import { sendJson } from '../http.js';
import * as play from '../play.js';
import * as signing from '../signing.js';
import { HttpError, bad } from '../validate.js';

export function register(router, { projects, builds }) {
  const releaseBuilds = (id) => builds.list(id)
    .filter((b) => b.state === 'succeeded' && ['assembleRelease', 'bundleRelease'].includes(b.task) && b.apk)
    .map((b) => ({ ...b, artifactType: b.artifactType || b.apk.type, apkSize: b.apk.size }));
  const artifactPath = (b) => builds.apkPath(builds.get(b.id));

  router.get('/api/projects/:id/play', (req, res, { params }) => {
    const p = projects.get(params.id);
    const rel = releaseBuilds(p.id);
    sendJson(res, 200, { ...play.checks(p, rel, artifactPath), latestBundle: rel.find((b) => b.artifactType === 'aab') || null, docs: play.PLAY_DOCS });
  });
  router.post('/api/projects/:id/play/bump', (req, res, { params, body }) => sendJson(res, 200, play.bumpVersion(projects.get(params.id), body.part || 'patch')));
  router.post('/api/projects/:id/play/target-sdk', (req, res, { params }) => sendJson(res, 200, play.setTargetSdk(projects.get(params.id))));

  // ---- upload key
  router.get('/api/projects/:id/signing', async (req, res, { params }) => sendJson(res, 200, await signing.info(projects.get(params.id).id)));
  router.post('/api/projects/:id/signing/generate', async (req, res, { params, body }) =>
    sendJson(res, 201, await signing.generate(projects.get(params.id).id, body)));
  router.post('/api/projects/:id/signing/import', async (req, res, { params, body }) =>
    sendJson(res, 201, await signing.importKeystore(projects.get(params.id).id, body)));
  router.post('/api/projects/:id/signing/delete', (req, res, { params, body }) => sendJson(res, 200, signing.remove(projects.get(params.id).id, body.confirm)));
  // Backups: dashboard session only (agents never see keys).
  const sessionOnly = (req) => { if (req.authKind !== 'session') throw new HttpError(403, 'Only available from the dashboard'); };
  router.get('/api/projects/:id/signing/keystore', (req, res, { params }) => {
    sessionOnly(req);
    const k = signing.exportKeystore(projects.get(params.id).id);
    const data = fs.readFileSync(k.file);
    res.writeHead(200, {
      'Content-Type': 'application/x-pkcs12', 'Content-Length': data.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${params.id.replace(/[^A-Za-z0-9._-]/g, '_')}-upload.jks"`,
    });
    res.end(data);
  });
  router.get('/api/projects/:id/signing/secrets', (req, res, { params }) => {
    sessionOnly(req);
    const k = signing.exportKeystore(projects.get(params.id).id);
    sendJson(res, 200, { alias: k.alias, storePassword: k.storePassword, keyPassword: k.keyPassword });
  });
  void bad;
}
