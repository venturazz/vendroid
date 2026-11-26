// v2 IDE features end to end: projects, templates, files, git, AI edits, MCP/REST agent API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = 'ide-test-password';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, stdio: 'pipe' }).toString();

let ctx;
let aiReply = '';
const aiCalls = [];

test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendroid-ide-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(tmp, 'adb'));
  fs.copyFileSync(path.join(HERE, 'fixtures/fake-adb.sh'), path.join(bin, 'adb'));
  fs.chmodSync(path.join(bin, 'adb'), 0o755);
  // Streaming OpenAI-compatible fake 9Router
  const nr = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      aiCalls.push(JSON.parse(b));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < aiReply.length; i += 7) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: aiReply.slice(i, i + 7) } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  }).listen(0, '127.0.0.1');
  const hermes = [];
  const hm = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const ts = req.headers['x-webhook-timestamp'];
      const want = crypto.createHmac('sha256', 'hermes-route-secret').update(`${ts}.${b}`).digest('hex');
      hermes.push({ ...JSON.parse(b), _url: req.url, _sigOk: req.headers['x-webhook-signature-v2'] === want && Math.abs(Date.now() / 1000 - Number(ts)) < 300, _reqId: req.headers['x-request-id'] });
      res.end('{"status":"accepted"}');
    });
  }).listen(0, '127.0.0.1');
  await Promise.all([new Promise((r) => nr.once('listening', r)), new Promise((r) => hm.once('listening', r))]);
  const port = 22000 + Math.floor(Math.random() * 15000);
  const env = {
    PATH: process.env.PATH, HOME: tmp, PORT: String(port), HOST: '127.0.0.1', AUTH_PASSWORD: PASSWORD,
    WORKSPACES_DIR: path.join(tmp, 'ws'), DATA_DIR: path.join(tmp, 'data'), ANDROID_HOME: path.join(tmp, 'sdk'),
    GRADLE_USER_HOME: path.join(tmp, 'gradle'), ADB_BIN: path.join(bin, 'adb'), FAKE_STATE: path.join(tmp, 'adb'),
    AAPT2_BINARY: '/bin/true', ALLOW_FILE_REMOTES: 'true', GIT_USER_NAME: 'Vendroid Test', GIT_USER_EMAIL: 'bot@vendroid.test',
    NINE_ROUTER_URL: `http://127.0.0.1:${nr.address().port}/v1`, HERMES_WEBHOOK_URL: `http://127.0.0.1:${hm.address().port}/webhooks/vendroid`,
    HERMES_WEBHOOK_SECRET: 'hermes-route-secret',
    GIT_WEBHOOK_SECRET: 'hooksecret',
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* */ } await sleep(100); }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  ctx = { tmp, env, base, proc, nr, hm, hermes, cookie: login.headers.get('set-cookie').split(';')[0], logs: () => logs };
});
test.after(() => {
  ctx?.proc.kill('SIGTERM');
  ctx?.nr.close();
  ctx?.hm.close();
  if (ctx) fs.rmSync(ctx.tmp, { recursive: true, force: true });
});

async function api(p, { method = 'GET', body, token, raw } = {}) {
  const headers = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: ctx.cookie }) };
  const r = await fetch(ctx.base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return r;
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const useFakeGradle = (id) => {
  const dst = path.join(ctx.env.WORKSPACES_DIR, id, 'gradlew');
  fs.copyFileSync(path.join(HERE, 'fixtures/fake-gradlew.sh'), dst);
  fs.chmodSync(dst, 0o755);
};
async function waitBuild(id) {
  for (let i = 0; i < 200; i++) {
    const b = (await api(`/api/builds/${id}`)).data;
    if (['succeeded', 'failed', 'cancelled'].includes(b.state)) return b;
    await sleep(100);
  }
  throw new Error('build timeout');
}

test('create projects from both templates', async () => {
  const c = await api('/api/projects', { method: 'POST', body: { name: 'Hello Compose', packageName: 'dev.test.compose', template: 'compose', minSdk: 26 } });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.id, 'hello-compose');
  assert.equal(c.data.packageName, 'dev.test.compose');
  assert.equal(c.data.ui, 'compose');
  assert.equal(c.data.minSdk, 26);
  const dir = c.data.path;
  const main = fs.readFileSync(path.join(dir, 'app/src/main/java/dev/test/compose/MainActivity.kt'), 'utf8');
  assert.match(main, /^package dev\.test\.compose$/m);
  assert.match(main, /Hello from Hello Compose/);
  const gradle = fs.readFileSync(path.join(dir, 'app/build.gradle.kts'), 'utf8');
  assert.ok(!/__[A-Z_]+__/.test(gradle), 'unreplaced template token');
  assert.match(gradle, /minSdk = 26/);
  assert.ok(fs.statSync(path.join(dir, 'gradlew')).mode & 0o100, 'gradlew executable');
  assert.equal(fs.readFileSync(path.join(dir, 'gradle/wrapper/gradle-wrapper.jar')).subarray(0, 2).toString(), 'PK');
  assert.match(git(dir, 'log', '--format=%an %s'), /Vendroid Test Create Hello Compose from the compose template/);
  assert.equal(git(dir, 'status', '--porcelain'), '');

  const v = await api('/api/projects', { method: 'POST', body: { name: 'Hello Views', packageName: 'dev.test.views', template: 'views' } });
  assert.equal(v.status, 201);
  assert.equal(v.data.ui, 'views');
  assert.ok(fs.existsSync(path.join(v.data.path, 'app/src/main/res/layout/activity_main.xml')));
  for (const bad of [{ name: 'X', packageName: 'nope' }, { name: '1bad', packageName: 'a.b' }, { name: 'Ok', packageName: 'a.b', template: 'flutter' },
    { name: 'Ok', packageName: 'com.fun.app' }, { name: 'Ok', packageName: 'a.b', minSdk: 5 }]) {
    assert.equal((await api('/api/projects', { method: 'POST', body: bad })).status, 400, JSON.stringify(bad));
  }
  const again = await api('/api/projects', { method: 'POST', body: { name: 'Hello Compose', packageName: 'dev.test.compose2' } });
  assert.equal(again.data.id, 'hello-compose-2');
  const list = (await api('/api/projects')).data.projects.map((p) => p.id).sort();
  assert.deepEqual(list, ['hello-compose', 'hello-compose-2', 'hello-views']);
});

test('file API: tree, read, write with conflict detection, rename, delete, search, traversal', async () => {
  const P = '/api/projects/hello-compose';
  const tree = (await api(`${P}/tree`)).data.entries.map((e) => e.name);
  assert.ok(tree.includes('app') && tree.includes('settings.gradle.kts') && !tree.includes('.git'));
  const f = (await api(`${P}/file?path=app/build.gradle.kts`)).data;
  assert.match(f.content, /namespace = "dev.test.compose"/);
  const w = await api(`${P}/file`, { method: 'POST', body: { path: 'app/build.gradle.kts', content: `${f.content}// edited\n`, baseHash: f.hash } });
  assert.equal(w.status, 200);
  const stale = await api(`${P}/file`, { method: 'POST', body: { path: 'app/build.gradle.kts', content: 'x', baseHash: f.hash } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.conflict, true);
  assert.equal(stale.data.hash, w.data.hash);
  assert.equal((await api(`${P}/file`, { method: 'POST', body: { path: 'notes/todo.md', content: '# todo\nfind me\n', create: true } })).status, 200);
  assert.equal((await api(`${P}/file`, { method: 'POST', body: { path: 'notes/todo.md', content: '', create: true } })).status, 409);
  assert.equal((await api(`${P}/fs`, { method: 'POST', body: { op: 'rename', path: 'notes/todo.md', to: 'notes/done.md' } })).status, 200);
  const s = (await api(`${P}/search?q=FIND%20ME`)).data;
  assert.deepEqual(s.results.map((r) => [r.path, r.line]), [['notes/done.md', 2]]);
  assert.equal((await api(`${P}/fs`, { method: 'POST', body: { op: 'delete', path: 'notes' } })).status, 200);
  assert.ok(!fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/notes')));
  // traversal / .git / symlink escape
  for (const bad of ['../hello-views/app/build.gradle.kts', '/etc/passwd', '.git/config', 'app/../../x']) {
    assert.equal((await api(`${P}/file?path=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  fs.symlinkSync('/etc', path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/etc-link'));
  assert.equal((await api(`${P}/file?path=etc-link/hostname`)).status, 400);
  assert.equal((await api(`${P}/file`, { method: 'POST', body: { path: 'etc-link/evil', content: 'x' } })).status, 400);
  fs.rmSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/etc-link'));
  assert.equal((await api('/api/projects/..%2F..%2Fetc/tree')).status, 400);
  // binary files are not returned as text
  fs.writeFileSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/blob.bin'), Buffer.from([0, 1, 2, 3]));
  assert.equal((await api(`${P}/file?path=blob.bin`)).data.binary, true);
  fs.rmSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/blob.bin'));
});

test('git: status, diff, commit, branch, push to a remote, clone, pull', async () => {
  const P = '/api/projects/hello-compose';
  const st = (await api(`${P}/git/status`)).data;
  assert.equal(st.branch, 'main');
  assert.deepEqual(st.files.map((f) => [f.path, f.status]), [['app/build.gradle.kts', 'modified']]);
  assert.match((await api(`${P}/git/diff?path=app/build.gradle.kts`)).data.diff, /^\+\/\/ edited$/m);
  assert.equal((await api(`${P}/git/commit`, { method: 'POST', body: { message: '' } })).status, 400);
  const c = (await api(`${P}/git/commit`, { method: 'POST', body: { message: 'Tweak build' } })).data;
  assert.equal(c.subject, 'Tweak build');
  assert.equal(c.author, 'Vendroid Test');
  assert.equal((await api(`${P}/git/commit`, { method: 'POST', body: { message: 'again' } })).status, 409);
  assert.equal((await api(`${P}/git/checkout`, { method: 'POST', body: { branch: '-x', create: true } })).status, 400);

  // remote: bare repo, push sets upstream
  const bare = path.join(ctx.tmp, 'remote.git');
  git(ctx.tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  git(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose'), 'remote', 'add', 'origin', `file://${bare}`);
  const push = await api(`${P}/git/push`, { method: 'POST' });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.match(git(bare, 'log', '--format=%s', 'main'), /Tweak build/);
  assert.equal((await api(`${P}/git/status`)).data.upstream, 'origin/main');

  // clone it as a second project, push a change from there, pull in the first
  const cl = await api('/api/projects/clone', { method: 'POST', body: { url: `file://${bare}` } });
  assert.equal(cl.status, 201, JSON.stringify(cl.data));
  assert.equal(cl.data.id, 'remote');
  assert.equal(cl.data.packageName, 'dev.test.compose');
  const Q = '/api/projects/remote';
  await api(`${Q}/file`, { method: 'POST', body: { path: 'CHANGELOG.md', content: 'v2\n', create: true } });
  await api(`${Q}/git/commit`, { method: 'POST', body: { message: 'Add changelog' } });
  assert.equal((await api(`${Q}/git/push`, { method: 'POST' })).status, 200);
  const pull = await api(`${P}/git/pull`, { method: 'POST' });
  assert.equal(pull.status, 200, JSON.stringify(pull.data));
  assert.ok(fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/CHANGELOG.md')));
  assert.deepEqual((await api(`${P}/git/log`)).data.commits.slice(0, 2).map((x) => x.subject), ['Add changelog', 'Tweak build']);

  const br = await api(`${P}/git/checkout`, { method: 'POST', body: { branch: 'ai/feature', create: true } });
  assert.equal(br.data.branch, 'ai/feature');
  await api(`${P}/git/checkout`, { method: 'POST', body: { branch: 'main' } });
  // non-https / ext transports rejected
  for (const url of ['ext::sh -c touch% /tmp/pwned', 'git@github.com:a/b.git', 'http://example.com/a.git']) {
    assert.equal((await api('/api/projects/clone', { method: 'POST', body: { url } })).status, 400, url);
  }
  // discard
  fs.appendFileSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/CHANGELOG.md'), 'junk\n');
  await api(`${P}/git/discard`, { method: 'POST', body: { path: 'CHANGELOG.md' } });
  assert.equal(fs.readFileSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/CHANGELOG.md'), 'utf8'), 'v2\n');
});

test('AI chat streams, proposes diffs, applies with one click, undoes, refuses stale applies', async () => {
  const P = '/api/projects/hello-compose';
  aiReply = [
    'I will change the greeting and add a helper.',
    '',
    'app/src/main/java/dev/test/compose/MainActivity.kt',
    '```kotlin',
    '<<<<<<< SEARCH',
    '        Text(text = "Hello from Hello Compose", style = MaterialTheme.typography.headlineSmall)',
    '=======',
    '        Text(text = greeting(), style = MaterialTheme.typography.headlineSmall)',
    '>>>>>>> REPLACE',
    '```',
    '',
    'app/src/main/java/dev/test/compose/Greeting.kt',
    '<<<<<<< SEARCH',
    '=======',
    'package dev.test.compose',
    '',
    'fun greeting(): String = "Hi from AI"',
    '>>>>>>> REPLACE',
    '',
    'app/src/main/java/dev/test/compose/Missing.kt',
    '<<<<<<< SEARCH',
    'nothing here',
    '=======',
    'x',
    '>>>>>>> REPLACE',
  ].join('\n');
  const r = await api(`${P}/ai/chat`, { method: 'POST', body: { message: 'Use a greeting() helper', activeFile: 'app/src/main/java/dev/test/compose/MainActivity.kt' }, raw: true });
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = (await r.text()).split('\n\n').filter(Boolean).map((chunk) => {
    const ev = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    return { ev, data: data && JSON.parse(data) };
  });
  assert.ok(events.filter((e) => e.ev === 'delta').length > 10, 'streamed in pieces');
  const done = events.find((e) => e.ev === 'done').data;
  assert.equal(done.message, aiReply);
  const prop = done.proposal;
  assert.deepEqual(prop.files.map((f) => [f.path, f.action, f.added, f.removed]), [
    ['app/src/main/java/dev/test/compose/MainActivity.kt', 'modify', 1, 1],
    ['app/src/main/java/dev/test/compose/Greeting.kt', 'create', 3, 0],
  ]);
  assert.equal(prop.errors.length, 1);
  assert.match(prop.errors[0].error, /does not exist/);
  assert.match(prop.files[0].diff, /^-        Text\(text = "Hello from Hello Compose"/m);
  // the model saw the open file and the build script
  const sent = aiCalls.at(-1);
  assert.equal(sent.stream, true);
  const ctxMsg = sent.messages[1].content;
  assert.match(ctxMsg, /### app\/src\/main\/java\/dev\/test\/compose\/MainActivity\.kt \(open in editor\)/);
  assert.match(ctxMsg, /### app\/build\.gradle\.kts/);
  assert.match(ctxMsg, /Package \/ applicationId: dev\.test\.compose/);

  const ap = await api(`${P}/ai/apply`, { method: 'POST', body: { proposalId: prop.id } });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const dir = path.join(ctx.env.WORKSPACES_DIR, 'hello-compose/app/src/main/java/dev/test/compose');
  assert.match(fs.readFileSync(path.join(dir, 'MainActivity.kt'), 'utf8'), /Text\(text = greeting\(\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'Greeting.kt'), 'utf8'), 'package dev.test.compose\n\nfun greeting(): String = "Hi from AI"\n');
  // applying the same proposal again is refused (files changed since)
  assert.equal((await api(`${P}/ai/apply`, { method: 'POST', body: { proposalId: prop.id } })).status, 409);
  const un = await api(`${P}/ai/undo`, { method: 'POST', body: { applyId: ap.data.applyId } });
  assert.equal(un.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'Greeting.kt')));
  assert.match(fs.readFileSync(path.join(dir, 'MainActivity.kt'), 'utf8'), /Hello from Hello Compose/);
  assert.equal(git(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose'), 'status', '--porcelain'), '');
  // history persisted; second turn includes it
  const h = (await api(`${P}/ai/history`)).data.messages;
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant']);
  aiReply = 'No changes needed.';
  await (await api(`${P}/ai/chat`, { method: 'POST', body: { message: 'thanks' }, raw: true })).text();
  assert.ok(aiCalls.at(-1).messages.some((m) => m.role === 'assistant' && m.content.includes('greeting()')));
  // AI may not touch forbidden paths
  aiReply = 'gradle/wrapper/gradle-wrapper.jar\n<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n.git/config\n<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n';
  const evil = await (await api(`${P}/ai/chat`, { method: 'POST', body: { message: 'x' }, raw: true })).text();
  const evilDone = JSON.parse(/event: done\ndata: (.*)/.exec(evil)[1]);
  assert.equal(evilDone.proposal.files.length, 0);
  assert.equal(evilDone.proposal.errors.length, 2);
  await api(`${P}/ai/clear`, { method: 'POST' });
  assert.equal((await api(`${P}/ai/history`)).data.messages.length, 0);
});

test('builds are scoped per project and share one queue', async () => {
  useFakeGradle('hello-compose');
  useFakeGradle('hello-views');
  const a = (await api('/api/projects/hello-compose/builds', { method: 'POST', body: { task: 'assembleDebug' } })).data;
  const b = (await api('/api/projects/hello-views/builds', { method: 'POST', body: { task: 'assembleDebug' } })).data;
  assert.equal(b.state, 'queued');
  const [ra, rb] = [await waitBuild(a.id), await waitBuild(b.id)];
  assert.equal(ra.state, 'succeeded', JSON.stringify(ra));
  assert.equal(rb.state, 'succeeded');
  assert.equal(ra.projectId, 'hello-compose');
  assert.equal(rb.packageName, 'dev.test.views');
  assert.ok(Date.parse(rb.startedAt) >= Date.parse(ra.finishedAt));
  const la = (await api('/api/projects/hello-compose/builds')).data.builds.map((x) => x.id);
  assert.deepEqual(la, [a.id]);
  assert.equal((await api('/api/builds', { method: 'POST', body: { task: 'assembleDebug' } })).status, 400, 'ambiguous without projectId');
});

test('agent API: MCP + REST with bearer token, cookie rejected for MCP', async () => {
  const info = (await api('/api/agent/info')).data;
  assert.match(info.token, /^vdr_/);
  assert.equal(info.tokenSource, 'generated');
  const T = info.token;
  const rpc = (body, token = T) => api('/mcp', { method: 'POST', body, token });
  assert.equal((await api('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401, 'session cookie is not enough');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token-1234567890')).status, 401);
  const init = (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).data;
  assert.equal(init.result.serverInfo.name, 'vendroid');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).data.result.tools.map((t) => t.name);
  for (const t of ['list_projects', 'read_file', 'apply_edits', 'start_build', 'get_build', 'device_action', 'screenshot', 'logcat', 'git_commit']) assert.ok(tools.includes(t), t);
  const call = async (name, args) => (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).data.result;

  const projects = JSON.parse((await call('list_projects', {})).content[0].text);
  assert.ok(projects.some((p) => p.id === 'hello-views' && p.packageName === 'dev.test.views'));
  const ed = await call('apply_edits', { project: 'hello-views', edits: 'app/src/main/res/values/strings.xml\n<<<<<<< SEARCH\n    <string name="tap_me">Tap me</string>\n=======\n    <string name="tap_me">Press me</string>\n>>>>>>> REPLACE\n' });
  assert.ok(!ed.isError, ed.content[0].text);
  assert.match(JSON.parse(ed.content[0].text).diff, /\+    <string name="tap_me">Press me<\/string>/);
  const bad = await call('apply_edits', { project: 'hello-views', edits: 'app/x.kt\n<<<<<<< SEARCH\nnope\n=======\ny\n>>>>>>> REPLACE\n' });
  assert.equal(bad.isError, true);
  assert.equal((await call('read_file', { project: 'hello-views', path: '../hello-compose/gradlew' })).isError, true);
  assert.equal((await call('start_build', { project: 'hello-views', task: 'rm -rf /' })).isError, true);
  assert.equal((await call('start_build', { project: 'hello-views', bogus: 1 })).isError, true);

  // connect the phone through MCP, then build + install + launch and wait for the result
  assert.match((await call('connect_device', { target: '10.147.17.5:5555' })).content[0].text, /connected to/);
  const built = JSON.parse((await call('start_build', { project: 'hello-views', install: true, launch: true, waitSeconds: 30 })).content[0].text);
  assert.equal(built.state, 'succeeded', built.logTail);
  assert.equal(built.trigger, 'agent');
  assert.match(built.logTail, /Events injected: 1/);
  const shot = await call('screenshot', {});
  assert.equal(shot.content[0].type, 'image');
  assert.equal(Buffer.from(shot.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
  const lc = await call('logcat', { project: 'hello-views', level: 'E', lines: 50 });
  assert.match(lc.content[0].text, /FATAL EXCEPTION/);
  assert.ok(!lc.content[0].text.includes('debug noise'));
  const commit = JSON.parse((await call('git_commit', { project: 'hello-views', message: 'Agent: rename button' })).content[0].text);
  assert.equal(commit.subject, 'Agent: rename button');

  // REST mirror
  const rest = await api('/api/agent/tools/list_builds', { method: 'POST', body: { project: 'hello-views' }, token: T });
  assert.equal(rest.status, 200);
  assert.equal(rest.data.result[0].id, built.id);
  const png = await api('/api/agent/tools/screenshot', { method: 'POST', body: {}, token: T, raw: true });
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal((await api('/api/agent/tools/list_projects', { method: 'POST', body: {} })).status, 401, 'REST tools need the token');
  // the bearer token also works for the normal REST API
  assert.equal((await api('/api/projects', { token: T })).status, 200);
  // rotate
  const rot = (await api('/api/agent/rotate', { method: 'POST' })).data.token;
  assert.notEqual(rot, T);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' })).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' }, rot)).status, 200);
});

test('Hermes agent task carries project and MCP pointers', async () => {
  const r = await api('/api/projects/hello-views/ai/hermes', { method: 'POST', body: { message: 'Add a settings screen', contextFiles: ['app/build.gradle.kts'] } });
  assert.equal(r.status, 200);
  const h = ctx.hermes.at(-1);
  assert.equal(h.event, 'agent_task');
  assert.equal(h.projectId, 'hello-views');
  assert.equal(h.task, 'Add a settings screen');
  assert.deepEqual(h.files, ['app/build.gradle.kts']);
  assert.equal(h.runner.mcpPath, '/mcp');
  assert.equal(h.event_type, 'agent_task');
  assert.equal(h._url, '/webhooks/vendroid');
  assert.equal(h._sigOk, true, 'generic V2 HMAC signature');
  assert.match(h._reqId, /^[0-9a-f-]{36}$/);
  assert.equal(h.packageName, 'dev.test.views');
});

test('push webhook picks the project by repository URL', async () => {
  const crypto = await import('node:crypto');
  const bare = path.join(ctx.tmp, 'remote.git');
  useFakeGradle('remote');
  git(path.join(ctx.env.WORKSPACES_DIR, 'remote'), 'update-index', '--assume-unchanged', 'gradlew');
  const raw = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { clone_url: `file://${bare}` } });
  const sig = `sha256=${crypto.createHmac('sha256', 'hooksecret').update(raw).digest('hex')}`;
  const r = await fetch(`${ctx.base}/api/hooks/git`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sig } });
  const j = await r.json();
  assert.equal(r.status, 202);
  assert.ok(['remote', 'hello-compose'].includes(j.project), JSON.stringify(j));
  const b = await waitBuild(j.buildId);
  assert.equal(b.trigger, 'webhook');
});

test('delete moves to trash; restore and purge', async () => {
  assert.equal((await api('/api/projects/hello-compose-2/delete', { method: 'POST', body: { confirm: 'nope' } })).status, 400);
  const d = await api('/api/projects/hello-compose-2/delete', { method: 'POST', body: { confirm: 'hello-compose-2' } });
  assert.equal(d.status, 200);
  assert.ok(!fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose-2')));
  assert.ok(!(await api('/api/projects')).data.projects.some((p) => p.id === 'hello-compose-2'), '.trash is not a project');
  const t = (await api('/api/trash')).data.items;
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'hello-compose-2');
  const r = await api('/api/trash/restore', { method: 'POST', body: { entry: t[0].entry } });
  assert.equal(r.status, 200);
  assert.equal(r.data.id, 'hello-compose-2');
  assert.ok(fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose-2/app/build.gradle.kts')));
  await api('/api/projects/hello-compose-2/delete', { method: 'POST', body: { confirm: 'hello-compose-2' } });
  const t2 = (await api('/api/trash')).data.items;
  assert.equal((await api('/api/trash/purge', { method: 'POST', body: { entry: t2[0].entry } })).status, 200);
  assert.equal((await api('/api/trash')).data.items.length, 0);
});

test('webview (HTML) template', async () => {
  const p = (await api('/api/projects', { method: 'POST', body: { name: 'Bola Pecah', packageName: 'dev.test.bola', template: 'webview' } })).data;
  assert.equal(p.ui, 'webview');
  const www = path.join(p.path, 'app/src/main/assets/www');
  for (const f of ['index.html', 'style.css', 'game.js']) assert.ok(fs.existsSync(path.join(www, f)), f);
  assert.match(fs.readFileSync(path.join(www, 'index.html'), 'utf8'), /<title>Bola Pecah<\/title>/);
  const kt = fs.readFileSync(path.join(p.path, 'app/src/main/java/dev/test/bola/MainActivity.kt'), 'utf8');
  assert.match(kt, /file:\/\/\/android_asset\/www\/index\.html/);
  assert.ok(!/<uses-permission/.test(fs.readFileSync(path.join(p.path, 'app/src/main/AndroidManifest.xml'), 'utf8')), 'offline app requests no permissions');
  execFileSync(process.execPath, ['--check', path.join(www, 'game.js')]);
});

test('MCP project lifecycle tools: create, rename, branch, delete, restore', async () => {
  const T = (await api('/api/agent/info')).data.token;
  const call = async (name, args) => {
    const r = (await api('/mcp', { method: 'POST', token: T, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })).data.result;
    return { err: r.isError, v: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };
  const c = await call('create_project', { name: 'Agent Game', packageName: 'dev.agent.game', template: 'webview' });
  assert.ok(!c.err, c.v);
  assert.equal(c.v.id, 'agent-game');
  assert.equal(c.v.ui, 'webview');
  assert.equal((await call('create_project', { name: 'Bad', packageName: 'nope' })).err, true);
  assert.equal((await call('rename_project', { project: 'agent-game', name: 'Agent Game 2' })).v.name, 'Agent Game 2');
  assert.equal((await call('git_checkout', { project: 'agent-game', branch: 'ai/test', create: true })).v.branch, 'ai/test');
  assert.ok((await call('git_branches', { project: 'agent-game' })).v.some((b) => b.name === 'ai/test' && b.current));
  assert.equal((await call('delete_project', { project: 'agent-game', confirm: 'wrong' })).err, true);
  const del = await call('delete_project', { project: 'agent-game', confirm: 'agent-game' });
  assert.ok(!del.err, del.v);
  const trash = (await call('list_trash', {})).v;
  const entry = trash.find((t) => t.id === 'agent-game').entry;
  assert.equal((await call('restore_project', { entry })).v.id, 'agent-game');
  assert.ok((await api('/api/projects')).data.projects.some((p) => p.id === 'agent-game'));
});

test('IDE assets are served (editor bundle, modules)', async () => {
  for (const p of ['/vendor/codemirror.bundle.js', '/assets/js/main.js', '/assets/js/editor.js', '/assets/style.css']) {
    const r = await api(p, { raw: true });
    assert.equal(r.status, 200, p);
  }
  assert.equal((await api('/vendor/..%2F..%2Fsrc%2Fconfig.js', { raw: true })).status, 404);
});

test('config exposes template versions (target shown in the New Project dialog)', async () => {
  const c = (await api('/api/config')).data;
  assert.equal(c.templateVersions.targetSdk, 37);
  assert.equal(c.templateVersions.compileSdk, '37.2');
  assert.equal(c.playTargetSdk, 36);
  const p = (await api('/api/projects', { method: 'POST', body: { name: 'Newest Min', packageName: 'dev.test.newmin', minSdk: 36 } })).data;
  assert.equal(p.minSdk, 36);
  assert.equal(p.targetSdk, 37);
});

function tinyPng(w, h) {
  const b = Buffer.alloc(57);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  return b;
}

test('binary files: dashboard upload/raw and MCP write/read/delete/move with undo', async () => {
  const P = '/api/projects/hello-views';
  const png = tinyPng(144, 144);
  const up = await fetch(`${ctx.base}${P}/upload?path=app/src/main/res/mipmap-xxhdpi/ic_launcher.png`, { method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/octet-stream' }, body: png });
  assert.equal(up.status, 201);
  assert.deepEqual((await up.json()).image, { type: 'png', width: 144, height: 144 });
  assert.equal((await fetch(`${ctx.base}${P}/upload?path=app/src/main/res/mipmap-xxhdpi/ic_launcher.png`, { method: 'POST', headers: { Cookie: ctx.cookie }, body: png })).status, 409);
  assert.equal((await fetch(`${ctx.base}${P}/upload?path=.git/hooks/pre-commit`, { method: 'POST', headers: { Cookie: ctx.cookie }, body: png })).status, 400);
  const raw = await fetch(`${ctx.base}${P}/raw?path=app/src/main/res/mipmap-xxhdpi/ic_launcher.png`, { headers: { Cookie: ctx.cookie } });
  assert.equal(raw.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png);
  const svgRaw = await (async () => {
    await api(`${P}/file`, { method: 'POST', body: { path: 'evil.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' } });
    return fetch(`${ctx.base}${P}/raw?path=evil.svg`, { headers: { Cookie: ctx.cookie } });
  })();
  assert.equal(svgRaw.headers.get('content-type'), 'application/octet-stream', 'svg never served inline');
  assert.match(svgRaw.headers.get('content-disposition'), /^attachment/);

  const T = (await api('/api/agent/info')).data.token;
  const rpc = async (name, args) => (await api('/mcp', { method: 'POST', token: T, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })).data.result;
  const big = tinyPng(512, 512);
  const w = await rpc('write_binary_file', { project: 'hello-views', path: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', base64: `data:image/png;base64,${big.toString('base64')}` });
  assert.ok(!w.isError, w.content[0].text);
  const wv = JSON.parse(w.content[0].text);
  assert.deepEqual(wv.image, { type: 'png', width: 512, height: 512 });
  assert.deepEqual(fs.readFileSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-views/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')), big);
  // sound (base64 of arbitrary bytes) into res/raw
  const snd = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
  assert.ok(!(await rpc('write_binary_file', { project: 'hello-views', path: 'app/src/main/res/raw/tap.mp3', base64: snd.toString('base64') })).isError);
  // validation
  assert.equal((await rpc('write_binary_file', { project: 'hello-views', path: 'app/src/main/res/drawable/Bad-Name.png', base64: big.toString('base64') })).isError, true);
  assert.equal((await rpc('write_binary_file', { project: 'hello-views', path: 'app/src/main/res/drawable/fake.png', base64: Buffer.from('not png').toString('base64') })).isError, true);
  assert.equal((await rpc('write_binary_file', { project: 'hello-views', path: 'gradle/wrapper/gradle-wrapper.jar', base64: big.toString('base64') })).isError, true);
  // read back: image content the model can see
  const rd = await rpc('read_binary_file', { project: 'hello-views', path: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png' });
  assert.equal(rd.content[0].type, 'image');
  assert.equal(rd.content[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(rd.content[0].data, 'base64'), big);
  const rs = JSON.parse((await rpc('read_binary_file', { project: 'hello-views', path: 'app/src/main/res/raw/tap.mp3' })).content[0].text);
  assert.equal(rs.mime, 'audio/mpeg');
  assert.deepEqual(Buffer.from(rs.base64, 'base64'), snd);
  // replace + undo restores the previous bytes
  const w2 = JSON.parse((await rpc('write_binary_file', { project: 'hello-views', path: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', base64: tinyPng(1, 1).toString('base64') })).content[0].text);
  assert.ok(!(await rpc('undo_edits', { project: 'hello-views', undoId: w2.applyId })).isError);
  assert.deepEqual(fs.readFileSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-views/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')), big);
  // move + undo, delete + undo
  const mv = JSON.parse((await rpc('move_file', { project: 'hello-views', path: 'app/src/main/res/raw/tap.mp3', to: 'app/src/main/res/raw/click.mp3' })).content[0].text);
  assert.ok(fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-views/app/src/main/res/raw/click.mp3')));
  await rpc('undo_edits', { project: 'hello-views', undoId: mv.applyId });
  assert.ok(fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-views/app/src/main/res/raw/tap.mp3')));
  assert.ok(!fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-views/app/src/main/res/raw/click.mp3')));
  const del = JSON.parse((await rpc('delete_file', { project: 'hello-views', path: 'app/src/main/res/raw/tap.mp3' })).content[0].text);
  assert.ok(!fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-views/app/src/main/res/raw/tap.mp3')));
  await rpc('undo_edits', { project: 'hello-views', undoId: del.applyId });
  assert.deepEqual(fs.readFileSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-views/app/src/main/res/raw/tap.mp3')), snd);
  assert.ok(!(await rpc('make_dir', { project: 'hello-views', path: 'app/src/main/res/font' })).isError);
  const ls = JSON.parse((await rpc('list_files', { project: 'hello-views', prefix: 'app/src/main/res/mipmap', detailed: true })).content[0].text);
  assert.ok(ls.some((f) => f.image?.width === 512));
  // a ~3 MB file passes the MCP body limit
  const large = Buffer.alloc(3 * 1024 * 1024, 7);
  assert.ok(!(await rpc('write_binary_file', { project: 'hello-views', path: 'app/src/main/assets/data.bin', base64: large.toString('base64') })).isError);
  await api(`${P}/fs`, { method: 'POST', body: { op: 'delete', path: 'evil.svg' } });
});

test('AI providers: add OpenAI-compatible provider (key encrypted), chat uses it', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end('{"data":[{"id":"m-small"},{"id":"m-large"}]}'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello from custom' } }] })}\n\ndata: [DONE]\n\n`);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const add = await api('/api/ai/providers', { method: 'POST', body: { name: 'My OpenRouter', kind: 'openai', baseUrl: `http://127.0.0.1:${srv.address().port}/v1/`, apiKey: 'sk-secret-123', model: 'm-small' } });
    assert.equal(add.status, 201, JSON.stringify(add.data));
    assert.equal(add.data.id, 'my-openrouter');
    assert.equal(add.data.hasKey, true);
    assert.equal(add.data.apiKey, undefined);
    const list = (await api('/api/ai/providers')).data.providers;
    assert.deepEqual(list.map((p) => p.id), ['9router', 'my-openrouter']);
    assert.ok(!JSON.stringify(list).includes('sk-secret-123'));
    assert.ok(!fs.readFileSync(path.join(ctx.env.DATA_DIR, 'providers.json'), 'utf8').includes('sk-secret-123'), 'key encrypted at rest');
    assert.deepEqual((await api('/api/ai/providers/my-openrouter/models')).data.models, ['m-small', 'm-large']);
    assert.equal((await api('/api/ai/providers', { method: 'POST', body: { name: 'x', kind: 'evil', baseUrl: 'http://a' } })).status, 400);
    assert.equal((await api('/api/ai/providers', { method: 'POST', body: { name: 'x', kind: 'openai', baseUrl: 'file:///etc/passwd' } })).status, 400);
    const t = (await (await api('/api/projects/hello-views/ai/chat', { method: 'POST', body: { message: 'hi', providerId: 'my-openrouter', model: 'm-large' }, raw: true })).text());
    assert.match(t, /event: engine\ndata: \{"id":"my-openrouter"/);
    assert.match(t, /hello from custom/);
    const chatReq = seen.find((s) => s.url === '/v1/chat/completions');
    assert.equal(chatReq.auth, 'Bearer sk-secret-123');
    assert.equal(chatReq.body.model, 'm-large');
    assert.equal((await api('/api/ai/providers/9router/delete', { method: 'POST' })).status, 409);
    assert.equal((await api('/api/ai/providers/my-openrouter/delete', { method: 'POST' })).status, 200);
  } finally { srv.close(); }
});

test('Hermes engine: streams text, tool progress and approvals; keeps one session per project', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, sid: req.headers['x-hermes-session-id'], body: b ? JSON.parse(b) : null });
      if (req.url.startsWith('/v1/runs/')) { res.setHeader('content-type', 'application/json'); return res.end('{"status":"ok"}'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': 'sess-abc' });
      const f = (data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
      f({ choices: [{ delta: { role: 'assistant' } }] });
      res.write(': keepalive\n\n');
      f({ tool: 'mcp_vendroid_apply_edits', emoji: '🔧', label: 'apply_edits strings.xml', toolCallId: 'c1', status: 'running' }, 'hermes.tool.progress');
      f({ run_id: 'chatcmpl-1', request_id: 'p-9', execution_generation: 2, description: 'vendroid/git_push', choices: ['once', 'deny'] }, 'approval.request');
      f({ choices: [{ delta: { reasoning_content: 'thinking…' } }] });
      f({ choices: [{ delta: { content: 'Selesai, ' } }] });
      f({ tool: 'mcp_vendroid_apply_edits', toolCallId: 'c1', status: 'completed' }, 'hermes.tool.progress');
      f({ choices: [{ delta: { content: 'judul diganti.' } }] });
      res.end('data: [DONE]\n\n');
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    await api('/api/ai/providers', { method: 'POST', body: { name: 'Hermes Agent', kind: 'hermes', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: 'hermes-key', model: 'hermes-agent' } });
    const P = '/api/projects/hello-views';
    await api(`${P}/ai/clear`, { method: 'POST' });
    const t1 = await (await api(`${P}/ai/chat`, { method: 'POST', body: { message: 'Ganti judul', providerId: 'hermes-agent', activeFile: 'app/src/main/res/values/strings.xml' }, raw: true })).text();
    const evs = t1.split('\n\n').filter(Boolean).map((c) => ({ ev: /^event: (.*)$/m.exec(c)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(c)[1]) }));
    assert.deepEqual(evs.map((e) => e.ev), ['engine', 'tool', 'approval', 'reasoning', 'delta', 'tool', 'delta', 'done']);
    assert.equal(evs.find((e) => e.ev === 'approval').data.request_id, 'p-9');
    const done = evs.at(-1).data;
    assert.equal(done.message, 'Selesai, judul diganti.');
    assert.equal(done.engine, 'hermes');
    assert.equal(done.sessionId, 'sess-abc');
    const first = seen.find((s) => s.url === '/v1/chat/completions');
    assert.equal(first.auth, 'Bearer hermes-key');
    assert.equal(first.sid, undefined, 'first turn starts a new session');
    assert.equal(first.body.messages.length, 1);
    assert.match(first.body.messages[0].content, /Project id "hello-views"/);
    assert.match(first.body.messages[0].content, /Open file in the editor: app\/src\/main\/res\/values\/strings\.xml/);
    assert.match(first.body.messages[0].content, /Ganti judul$/);
    await (await api(`${P}/ai/chat`, { method: 'POST', body: { message: 'Lagi', providerId: 'hermes-agent' }, raw: true })).text();
    assert.equal(seen.filter((s) => s.url === '/v1/chat/completions')[1].sid, 'sess-abc', 'second turn continues the session');
    const ap = await api(`${P}/ai/hermes-approval`, { method: 'POST', body: { providerId: 'hermes-agent', runId: 'chatcmpl-1', choice: 'once', requestId: 'p-9', executionGeneration: 2 } });
    assert.equal(ap.status, 200, JSON.stringify(ap.data));
    const apr = seen.find((s) => s.url === '/v1/runs/chatcmpl-1/approval');
    assert.deepEqual(apr.body, { choice: 'once', request_id: 'p-9', execution_generation: 2 });
    assert.equal(apr.auth, 'Bearer hermes-key');
    const h = (await api(`${P}/ai/history`)).data.messages;
    assert.equal(h.at(-3).engine, 'Hermes Agent');
    assert.equal(h.at(-3).tools[0].label, 'apply_edits strings.xml');
    await api(`${P}/ai/clear`, { method: 'POST' });
    await (await api(`${P}/ai/chat`, { method: 'POST', body: { message: 'Baru', providerId: 'hermes-agent' }, raw: true })).text();
    assert.equal(seen.filter((s) => s.url === '/v1/chat/completions').at(-1).sid, undefined, 'clear starts a new Hermes session');
  } finally { srv.close(); }
});

test('MCP annotations: side-effect tools are not read-only; destructive ones are marked', async () => {
  const T = (await api('/api/agent/info')).data.token;
  const tools = (await api('/mcp', { method: 'POST', token: T, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).data.result.tools;
  const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  for (const n of ['start_build', 'device_action', 'apply_edits', 'write_binary_file']) assert.equal(ann[n].readOnlyHint, false, n);
  for (const n of ['list_projects', 'read_file', 'logcat', 'screenshot', 'get_build']) assert.equal(ann[n].readOnlyHint, true, n);
  for (const n of ['delete_project', 'delete_file', 'git_push']) assert.equal(ann[n].destructiveHint, true, n);
});
