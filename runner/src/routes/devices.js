import { config } from '../config.js';
import { sendJson } from '../http.js';
import { openSse } from '../sse.js';
import * as adbm from '../adb.js';
import { HttpError, bad, isLevel, isTcpTarget } from '../validate.js';
import { str, serialOf, pkgOf } from './util.js';

export function register(router, { builds, projects, watchdog }) {
  const projectPkg = (id) => (id ? projects.get(id).packageName : undefined);

  router.get('/api/devices', async (req, res) => {
    try {
      sendJson(res, 200, { devices: await adbm.listDevices(), watchdog: watchdog.view() });
    } catch (e) {
      throw new HttpError(502, e.message);
    }
  });
  router.post('/api/devices/connect', async (req, res, { body }) => {
    if (!isTcpTarget(body.target)) throw bad('target must be <ipv4>:<port>');
    watchdog.noteManual('connect', body.target);
    sendJson(res, 200, await adbm.connect(body.target));
  });
  router.post('/api/devices/disconnect', async (req, res, { body }) => {
    if (!isTcpTarget(body.target)) throw bad('target must be <ipv4>:<port>');
    watchdog.noteManual('disconnect', body.target);
    sendJson(res, 200, await adbm.disconnect(body.target));
  });
  router.post('/api/adb/restart', async (req, res, { body }) => {
    const serial = body.serial || config.defaultDevice;
    if (body.mode === 'reconnect') watchdog.noteManual('connect', serial);
    sendJson(res, 200, await adbm.restartHelper(body.mode, serial));
  });
  router.post('/api/devices/action', async (req, res, { body }) => {
    const serial = serialOf(body.serial);
    const action = body.action;
    if (action === 'install') {
      const b = body.buildId ? builds.get(body.buildId) : builds.latestApk(body.projectId || undefined);
      if (b?.artifactType === 'aab') throw bad('An .aab cannot be installed with adb; build assembleRelease or assembleDebug for the phone');
      const apk = b && builds.apkPath(b);
      if (!apk) throw new HttpError(404, 'No built APK available to install; build the project first');
      const r = await adbm.installApk(serial, apk);
      return sendJson(res, 200, { ...r, buildId: b.id });
    }
    if (!['launch', 'stop', 'clear'].includes(action)) throw bad('action must be install, launch, stop or clear');
    sendJson(res, 200, await adbm.deviceAction(action, serial, pkgOf(body.packageName, projectPkg(body.projectId))));
  });
  router.get('/api/devices/screenshot', async (req, res, { url }) => {
    const png = await adbm.screenshot(serialOf(url.searchParams.get('serial')));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
    res.end(png);
  });

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
}
