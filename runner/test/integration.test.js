// End-to-end test of the real server process with fake adb / gradlew / 9Router / Hermes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = 'integration-pass-123';
const WEBHOOK_SECRET = 'hook-secret-xyz';
const DEVICE = '10.147.17.5:5555';
const PKG = 'com.example.app';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).toString();

function fakeAi() {
  const calls = { nineRouter: [], hermes: [] };
  const mk = (handler) => new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => handler(req, res, b));
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
  return Promise.all([
    mk((req, res, b) => {
      calls.nineRouter.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"rootCause":"foo is undefined","affected":["Main.kt"],"fixSteps":["declare foo"],"confidence":"high"}\n```' } }] }));
    }),
    mk((req, res, b) => {
      calls.hermes.push({ url: req.url, secret: req.headers['x-webhook-secret'], body: JSON.parse(b) });
      res.end('accepted');
    }),
  ]).then(([nr, hm]) => ({ nr, hm, calls }));
}

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-it-'));
  const bin = path.join(tmp, 'bin');
  const state = path.join(tmp, 'adb-state');
  const origin = path.join(tmp, 'origin.git');
  const proj = path.join(tmp, 'project');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.copyFileSync(path.join(HERE, 'fixtures/fake-adb.sh'), path.join(bin, 'adb'));
  fs.chmodSync(path.join(bin, 'adb'), 0o755);
  // Project = clone of a bare repo, so `git pull` and commit info work like production.
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, proj);
  fs.copyFileSync(path.join(HERE, 'fixtures/fake-gradlew.sh'), path.join(proj, 'gradlew'));
  fs.chmodSync(path.join(proj, 'gradlew'), 0o755);
  fs.writeFileSync(path.join(proj, '.gitignore'), 'app/build/\nFAIL\nSLOW\nBROKEN\n');
  git(proj, 'add', '.');
  git(proj, 'commit', '-q', '-m', 'initial commit');
  git(proj, 'push', '-q', 'origin', 'HEAD:main');
  return { tmp, bin, state, origin, proj };
}

let ctx;
test.before(async () => {
  const dirs = await setup();
  const ai = await fakeAi();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    PATH: process.env.PATH,
    HOME: dirs.tmp,
    PORT: String(port),
    HOST: '127.0.0.1',
    LISTEN_SOCKET: path.join(dirs.tmp, 'run', 'runner.sock'),
    AUTH_PASSWORD: PASSWORD,
    ANDROID_PROJECT_PATH: dirs.proj,
    WORKSPACES_DIR: path.join(dirs.tmp, "ws"),
    ANDROID_HOME: path.join(dirs.tmp, 'sdk'),
    DATA_DIR: path.join(dirs.tmp, 'data'),
    GRADLE_USER_HOME: path.join(dirs.tmp, 'gradle'),
    ADB_BIN: path.join(dirs.bin, 'adb'),
    AAPT2_BINARY: '/opt/fake/aapt2',
    FAKE_STATE: dirs.state,
    DEFAULT_PACKAGE_NAME: PKG,
    DEFAULT_DEVICE_ADDRESS: DEVICE,
    ADB_RECONNECT_INTERVAL_SEC: '5',
    NINE_ROUTER_URL: `http://127.0.0.1:${ai.nr.address().port}/v1`,
    NINE_ROUTER_API_KEY: 'nr-key',
    HERMES_WEBHOOK_URL: `http://127.0.0.1:${ai.hm.address().port}/webhook`,
    HERMES_WEBHOOK_SECRET: 'hermes-secret',
    GIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RELEASE_KEYSTORE_PATH: '/keys/release.jks',
    RELEASE_KEYSTORE_PASSWORD: 'store-pass',
    RELEASE_KEY_ALIAS: 'upload',
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  ctx = { ...dirs, ai, proc, base, env, logs: () => out, cookie: '' };
});

test.after(() => {
  ctx?.proc.kill('SIGTERM');
  ctx?.ai.nr.close();
  ctx?.ai.hm.close();
  if (ctx) fs.rmSync(ctx.tmp, { recursive: true, force: true });
});

async function api(p, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const r = await fetch(ctx.base + p, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(ctx.cookie ? { Cookie: ctx.cookie } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  if (raw) return r;
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
}

async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout waiting for condition');
    await sleep(150);
  }
}
const waitBuild = (id, states = ['succeeded', 'failed', 'cancelled']) =>
  waitFor(async () => { const b = (await api(`/api/builds/${id}`)).data; return states.includes(b.state) && b; }, 20000);
const buildLog = async (id) => (await api(`/api/builds/${id}/log`)).data;

test('auth: everything but login is protected', async () => {
  assert.equal((await api('/api/builds')).status, 401);
  assert.equal((await api('/api/health/env')).status, 401);
  assert.equal((await api('/api/logcat/stream?serial=' + DEVICE)).status, 401);
  assert.match((await api('/')).data, /Sign in/);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const ok = await api('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  ctx.cookie = sc.split(';')[0];
  assert.match((await api("/")).data, /Project Hub/);
});

test('security: injection, traversal and cross-origin requests are rejected', async () => {
  assert.equal((await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug; id' } })).status, 400);
  assert.equal((await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug', autoInstallAfterBuild: 'yes' } })).status, 400);
  assert.equal((await api('/api/devices/connect', { method: 'POST', body: { target: '1.2.3.4:5555 && id' } })).status, 400);
  assert.equal((await api('/api/devices/action', { method: 'POST', body: { serial: DEVICE, action: 'launch', packageName: 'x;id' } })).status, 400);
  assert.equal((await api('/api/devices/action', { method: 'POST', body: { serial: DEVICE, action: 'reboot' } })).status, 400);
  assert.equal((await api('/api/logcat/stream?serial=' + DEVICE + '&level=X')).status, 400);
  assert.equal((await api('/assets/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await api('/api/builds/../../etc')).status, 404);
  assert.equal((await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await api('/api/builds', { method: 'POST', body: '{"task":', headers: {} })).status, 400);
});

test('watchdog connects the default device without user action', async () => {
  const r = await waitFor(async () => {
    const d = (await api('/api/devices')).data;
    return d.devices.some((x) => x.serial === DEVICE && x.state === 'device') && d;
  });
  assert.equal(r.watchdog.state, 'connected');
  assert.deepEqual(r.devices[0], {
    serial: DEVICE, state: 'device', model: 'Pixel_7', product: 'panther', device: 'panther', transport: 'tcp', transportId: '2',
  });
});

test('health endpoint reports the toolchain', async () => {
  const h = (await api('/api/health/env')).data;
  for (const k of ['aarch64', 'java', 'androidHome', 'adb', 'aapt2', 'project']) assert.ok(k in h.checks, k);
  assert.equal(h.checks.adb, true);
  assert.equal(h.checks.project, true);
  assert.equal(h.aapt2.path, '/opt/fake/aapt2');
  assert.ok(h.memory.totalGb > 0);
  const gp = fs.readFileSync(path.join(ctx.env.GRADLE_USER_HOME, 'gradle.properties'), 'utf8');
  assert.match(gp, /org\.gradle\.jvmargs=-Xmx4096m -XX:\+UseG1GC/);
  assert.match(gp, /kotlin\.daemon\.jvmargs=-Xmx3072m/);
  assert.match(gp, /android\.aapt2FromMavenOverride=\/opt\/fake\/aapt2/);
});

test('build → install → launch, serialized, with live SSE and replay', async () => {
  const a = (await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug', autoInstallAfterBuild: true, autoLaunchAfterInstall: true } })).data;
  const b = (await api('/api/builds', { method: 'POST', body: { task: 'clean assembleDebug' } })).data;
  assert.equal(b.state, 'queued');
  const list = (await api('/api/builds')).data;
  assert.equal(list.active, a.id);

  // Live stream until the end event.
  const r = await api(`/api/builds/${a.id}/stream`, { raw: true });
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(r.headers.get('x-accel-buffering'), 'no');
  const text = await r.text();
  for (const s of ['=== building ===', 'BUILD SUCCESSFUL', '=== installing ===', 'Success', '=== launching ===', 'Events injected', '=== succeeded ===']) {
    assert.ok(text.includes(s), `stream missing ${s}`);
  }
  assert.match(text, /event: end/);

  const done = await waitBuild(a.id);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.commit.subject, 'initial commit');
  assert.equal(done.trigger, 'manual');
  const log = await buildLog(a.id);
  assert.match(log, /leaked-secrets: 0/);
  assert.match(log, /signing-props: 0/);
  assert.match(log, /--no-daemon/);
  assert.match(fs.readFileSync(path.join(ctx.state, 'installs'), 'utf8'), new RegExp(`${DEVICE.replace(/\./g, '\\.')} install -r .*app-debug\\.apk`));

  // Replay after completion honours Last-Event-ID.
  const replay = await (await api(`/api/builds/${a.id}/stream`, { raw: true, headers: { 'Last-Event-ID': '3' } })).text();
  assert.ok(!/^id: 3$/m.test(replay));
  assert.match(replay, /^id: 4$/m);

  const apk = await api(`/api/builds/${a.id}/apk`, { raw: true });
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(Buffer.from(await apk.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal((await waitBuild(b.id)).state, 'succeeded');
  // b started only after a finished
  assert.ok(Date.parse((await api(`/api/builds/${b.id}`)).data.startedAt) >= Date.parse(done.finishedAt));
});

test('release build is signed via injected env, never argv', async () => {
  const r = (await api('/api/builds', { method: 'POST', body: { task: 'assembleRelease' } })).data;
  assert.equal(r.signed, true);
  const b = await waitBuild(r.id);
  assert.equal(b.state, 'succeeded');
  const log = await buildLog(r.id);
  assert.match(log, /signing-props: 4/);
  assert.match(log, /signing-env: 0/);
  assert.ok(!log.includes('store-pass'));
  const gp = path.join(ctx.env.GRADLE_USER_HOME, 'gradle.properties');
  assert.ok(!fs.readFileSync(gp, 'utf8').includes('injected.signing'), 'signing secrets left behind');
  assert.equal(fs.statSync(gp).mode & 0o077, 0, 'gradle.properties must be 0600');
});

test('an APK without manifest/resources fails the build instead of reaching the phone', async () => {
  fs.writeFileSync(path.join(ctx.proj, 'BROKEN'), '');
  try {
    const r = (await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug', autoInstallAfterBuild: true } })).data;
    const b = await waitBuild(r.id);
    assert.equal(b.state, 'failed');
    assert.match(b.error, /missing AndroidManifest\.xml and resources\.arsc/);
    assert.match(b.error, /AAPT2_MODE=box64/);
    assert.ok(!(await buildLog(r.id)).includes('=== installing ==='));
  } finally {
    fs.rmSync(path.join(ctx.proj, 'BROKEN'), { force: true });
  }
});

test('cancel kills the running build process group', async () => {
  fs.writeFileSync(path.join(ctx.proj, 'SLOW'), '');
  try {
    const r = (await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug' } })).data;
    await waitFor(async () => (await api(`/api/builds/${r.id}`)).data.state === 'building');
    await sleep(500);
    assert.equal((await api(`/api/builds/${r.id}/cancel`, { method: 'POST' })).status, 200);
    const b = await waitBuild(r.id);
    assert.equal(b.state, 'cancelled');
    await sleep(300);
    const ps = execFileSync('ps', ['-eo', 'args']).toString();
    assert.ok(!ps.split('\n').some((l) => l.includes(ctx.proj) && l.includes('gradlew')), 'gradlew still running');
  } finally {
    fs.rmSync(path.join(ctx.proj, 'SLOW'), { force: true });
  }
});

test('failed build auto-notifies Hermes; 9Router analysis parses fenced JSON', async () => {
  fs.writeFileSync(path.join(ctx.proj, 'FAIL'), '');
  try {
    const r = (await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug', autoNotifyHermes: true } })).data;
    const b = await waitFor(async () => { const x = (await api(`/api/builds/${r.id}`)).data; return x.hermes && x; });
    assert.equal(b.state, 'failed');
    assert.equal(b.hermes.ok, true);
    const call = ctx.ai.calls.hermes.at(-1);
    assert.equal(call.secret, 'hermes-secret');
    assert.equal(call.body.event, 'build_failed');
    assert.equal(call.body.jobId, r.id);
    assert.equal(call.body.packageName, PKG);
    assert.match(call.body.errorTail, /Unresolved reference: foo/);
    for (const k of ['projectPath', 'deviceSerial', 'crashSnippet', 'timestamp']) assert.ok(k in call.body, k);

    const an = await api('/api/ai/analyze', { method: 'POST', body: { mode: 'build_error', jobId: r.id } });
    assert.equal(an.status, 200);
    assert.equal(an.data.analysis.rootCause, 'foo is undefined');
    assert.deepEqual(an.data.analysis.fixSteps, ['declare foo']);
    const nr = ctx.ai.calls.nineRouter.at(-1);
    assert.equal(nr.url, '/v1/chat/completions');
    assert.equal(nr.auth, 'Bearer nr-key');
  } finally {
    fs.rmSync(path.join(ctx.proj, 'FAIL'), { force: true });
  }
});

test('device actions, screenshot and filtered logcat', async () => {
  assert.equal((await api('/api/devices/action', { method: 'POST', body: { serial: DEVICE, action: 'launch' } })).data.ok, true);
  assert.equal((await api('/api/devices/action', { method: 'POST', body: { serial: DEVICE, action: 'stop' } })).data.ok, true);
  assert.equal((await api('/api/devices/action', { method: 'POST', body: { serial: DEVICE, action: 'clear' } })).data.ok, true);
  assert.equal((await api('/api/devices/action', { method: 'POST', body: { serial: DEVICE, action: 'install' } })).data.ok, true);
  const shot = await api(`/api/devices/screenshot?serial=${DEVICE}`, { raw: true });
  assert.equal(shot.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await shot.arrayBuffer()).subarray(1, 4).toString(), 'PNG');

  const ac = new AbortController();
  const r = await fetch(`${ctx.base}/api/logcat/stream?serial=${DEVICE}&level=E&q=fatal`, { headers: { Cookie: ctx.cookie }, signal: ac.signal });
  const reader = r.body.getReader();
  let buf = '';
  const until = Date.now() + 5000;
  while (!buf.includes('event: lines') && Date.now() < until) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += Buffer.from(value).toString();
  }
  ac.abort();
  const m = /event: lines\ndata: (.*)\n/.exec(buf);
  assert.ok(m, buf);
  const lines = JSON.parse(m[1]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'E');
  assert.match(lines[0].text, /FATAL EXCEPTION/);
});

test('manual disconnect pauses auto-reconnect', async () => {
  await api('/api/devices/disconnect', { method: 'POST', body: { target: DEVICE } });
  await sleep(1200);
  const d = (await api('/api/devices')).data;
  assert.equal(d.watchdog.paused, true);
  assert.equal(d.devices.length, 0);
  await api('/api/devices/connect', { method: 'POST', body: { target: DEVICE } });
  assert.equal((await api('/api/devices')).data.watchdog.paused, false);
});

test('git push webhook: signature required, pulls and builds', async () => {
  const push = async (payload, secret = WEBHOOK_SECRET, event = 'push') => {
    const raw = JSON.stringify(payload);
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return fetch(`${ctx.base}/api/hooks/git`, {
      method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-Hub-Signature-256': sig },
    });
  };
  assert.equal((await push({ ref: 'refs/heads/main' }, 'wrong')).status, 401);
  assert.equal((await push({}, WEBHOOK_SECRET, 'ping')).status, 200);

  // New upstream commit, then a push event.
  const other = path.join(ctx.tmp, 'other');
  git(ctx.tmp, 'clone', '-q', ctx.origin, other);
  fs.writeFileSync(path.join(other, 'README.md'), 'hi');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'second commit from push');
  git(other, 'push', '-q', 'origin', 'HEAD:main');

  const r = await push({ ref: 'refs/heads/main', after: 'abc' });
  assert.equal(r.status, 202);
  const { buildId } = await r.json();
  const b = await waitBuild(buildId);
  assert.equal(b.state, 'succeeded', await buildLog(buildId));
  assert.equal(b.trigger, 'webhook');
  assert.equal(b.ref, 'main');
  assert.equal(b.commit.subject, 'second commit from push');
  assert.equal(b.options.autoInstallAfterBuild, true);
});

test('unix socket listener serves the same app (edge relay path)', async () => {
  const body = await new Promise((resolve, reject) => {
    http.get({ socketPath: ctx.env.LISTEN_SOCKET, path: '/healthz' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  assert.equal(JSON.parse(body).ok, true);
});

test('edge relay proxies HTTP and SSE byte-for-byte', async () => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const edge = spawn(process.execPath, [path.join(ROOT, 'src/edge.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), RUNNER_SOCKET: ctx.env.LISTEN_SOCKET }, stdio: 'ignore',
  });
  try {
    const eb = `http://127.0.0.1:${port}`;
    await waitFor(async () => { try { return (await fetch(`${eb}/healthz`)).ok; } catch { return false; } });
    const login = await fetch(`${eb}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ password: PASSWORD }),
    });
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const last = (await api('/api/builds')).data.builds[0];
    const sse = await (await fetch(`${eb}/api/builds/${last.id}/stream`, { headers: { Cookie: cookie } })).text();
    assert.match(sse, /event: state/);
    assert.match(sse, /event: end/);
  } finally {
    edge.kill('SIGTERM');
  }
});

test('build history survives a restart; interrupted builds are marked failed', async () => {
  const before = (await api('/api/builds')).data.builds.length;
  ctx.proc.kill('SIGTERM');
  await new Promise((r) => ctx.proc.once('exit', r));
  ctx.proc = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], { env: ctx.env, stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(`${ctx.base}/healthz`)).ok; } catch { return false; } });
  const after = (await api('/api/builds')).data;
  assert.equal(after.builds.length, before);
  assert.ok(after.builds.every((b) => ['succeeded', 'failed', 'cancelled'].includes(b.state)));
});
