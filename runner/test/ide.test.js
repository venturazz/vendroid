// v2 IDE features end to end: projects, templates, files, git, AI edits, MCP/REST agent API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    req.on('end', () => { hermes.push(JSON.parse(b)); res.end('ok'); });
  }).listen(0, '127.0.0.1');
  await Promise.all([new Promise((r) => nr.once('listening', r)), new Promise((r) => hm.once('listening', r))]);
  const port = 22000 + Math.floor(Math.random() * 15000);
  const env = {
    PATH: process.env.PATH, HOME: tmp, PORT: String(port), HOST: '127.0.0.1', AUTH_PASSWORD: PASSWORD,
    WORKSPACES_DIR: path.join(tmp, 'ws'), DATA_DIR: path.join(tmp, 'data'), ANDROID_HOME: path.join(tmp, 'sdk'),
    GRADLE_USER_HOME: path.join(tmp, 'gradle'), ADB_BIN: path.join(bin, 'adb'), FAKE_STATE: path.join(tmp, 'adb'),
    AAPT2_BINARY: '/bin/true', ALLOW_FILE_REMOTES: 'true', GIT_USER_NAME: 'Vendroid Test', GIT_USER_EMAIL: 'bot@vendroid.test',
    NINE_ROUTER_URL: `http://127.0.0.1:${nr.address().port}/v1`, HERMES_WEBHOOK_URL: `http://127.0.0.1:${hm.address().port}/webhook`,
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

test('delete requires typing the id', async () => {
  assert.equal((await api('/api/projects/hello-compose-2/delete', { method: 'POST', body: { confirm: 'nope' } })).status, 400);
  assert.equal((await api('/api/projects/hello-compose-2/delete', { method: 'POST', body: { confirm: 'hello-compose-2' } })).status, 200);
  assert.ok(!fs.existsSync(path.join(ctx.env.WORKSPACES_DIR, 'hello-compose-2')));
});

test('IDE assets are served (editor bundle, modules)', async () => {
  for (const p of ['/vendor/codemirror.bundle.js', '/assets/js/main.js', '/assets/js/editor.js', '/assets/style.css']) {
    const r = await api(p, { raw: true });
    assert.equal(r.status, 200, p);
  }
  assert.equal((await api('/vendor/..%2F..%2Fsrc%2Fconfig.js', { raw: true })).status, 404);
});
