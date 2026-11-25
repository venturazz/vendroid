// Google Play readiness: checks, upload key, AAB builds, 16 KB page-size inspection, version bump.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { elfLoadAlign, pageSizeReport } from '../src/play.js';
import { elf, zip } from './fixtures/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Real JDK home: version-manager shims break when HOME changes (as it does for the test server).
const javaHomeCandidates = () => {
  const out = [process.env.JAVA_HOME];
  try { out.push(path.dirname(path.dirname(execFileSync('mise', ['which', 'keytool'], { encoding: 'utf8' }).trim()))); } catch { /* no mise */ }
  try { out.push(path.dirname(path.dirname(fs.realpathSync(execFileSync('sh', ['-c', 'command -v keytool'], { encoding: 'utf8' }).trim())))); } catch { /* none */ }
  return out.filter(Boolean);
};
const JAVA_HOME = javaHomeCandidates().find((h) => fs.existsSync(path.join(h, 'bin', 'keytool')));
const KEYTOOL = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'keytool') : 'keytool';
const haveKeytool = (() => { try { execFileSync(KEYTOOL, ['-help'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const aab = (align) => zip([
  ['base/manifest/AndroidManifest.xml', Buffer.from('m')], ['base/resources.pb', Buffer.from('r')],
  ['base/dex/classes.dex', Buffer.from('d')], ['base/lib/arm64-v8a/libnative.so', elf(align)],
]);

test('ELF alignment and 16 KB report', () => {
  assert.equal(elfLoadAlign(elf(4096)), 4096);
  assert.equal(elfLoadAlign(elf(16384)), 16384);
  assert.equal(elfLoadAlign(Buffer.from('not elf')), null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
  fs.writeFileSync(path.join(tmp, 'ok.aab'), aab(16384));
  fs.writeFileSync(path.join(tmp, 'bad.aab'), aab(4096));
  assert.deepEqual(pageSizeReport(path.join(tmp, 'ok.aab')), { nativeLibs: 1, bad: [] });
  const r = pageSizeReport(path.join(tmp, 'bad.aab'));
  assert.equal(r.bad.length, 1);
  assert.match(r.bad[0].issue, /aligned to 4096/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

let ctx;
test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendroid-play-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.mkdirSync(path.join(tmp, 'adb'));
  fs.copyFileSync(path.join(HERE, 'fixtures/fake-adb.sh'), path.join(tmp, 'bin', 'adb'));
  fs.chmodSync(path.join(tmp, 'bin', 'adb'), 0o755);
  const port = 26000 + Math.floor(Math.random() * 9000);
  const env = {
    PATH: process.env.PATH, HOME: tmp, PORT: String(port), HOST: '127.0.0.1', AUTH_PASSWORD: 'play-test-pass',
    WORKSPACES_DIR: path.join(tmp, 'ws'), DATA_DIR: path.join(tmp, 'data'), ANDROID_HOME: path.join(tmp, 'sdk'),
    GRADLE_USER_HOME: path.join(tmp, 'gradle'), ADB_BIN: path.join(tmp, 'bin', 'adb'), FAKE_STATE: path.join(tmp, 'adb'), AAPT2_BINARY: '/bin/true',
    ...(JAVA_HOME ? { JAVA_HOME } : {}),
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* */ } await sleep(100); }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'play-test-pass' }) });
  ctx = { tmp, env, base, proc, cookie: login.headers.get('set-cookie').split(';')[0] };
});
test.after(() => { ctx?.proc.kill('SIGTERM'); if (ctx) fs.rmSync(ctx.tmp, { recursive: true, force: true }); });

async function api(p, { method = 'GET', body, raw } = {}) {
  const r = await fetch(ctx.base + p, { method, headers: { Cookie: ctx.cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return r;
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
async function waitBuild(id) {
  for (let i = 0; i < 200; i++) {
    const b = (await api(`/api/builds/${id}`)).data;
    if (['succeeded', 'failed', 'cancelled'].includes(b.state)) return b;
    await sleep(100);
  }
  throw new Error('timeout');
}
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test('Play checklist, fixes, upload key and signed AAB', { skip: !haveKeytool && 'keytool not installed' }, async () => {
  // A project with typical problems: com.example package, old targetSdk, debuggable release, SMS permission
  const c = (await api('/api/projects', { method: 'POST', body: { name: 'Shop', packageName: 'com.example.shop', template: 'views' } })).data;
  const dir = c.path;
  const g = path.join(dir, 'app/build.gradle.kts');
  fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace(/targetSdk = \d+/, 'targetSdk = 34').replace('isMinifyEnabled = true', 'isMinifyEnabled = true\n            isDebuggable = true'));
  const m = path.join(dir, 'app/src/main/AndroidManifest.xml');
  fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace('<application', '<uses-permission android:name="android.permission.READ_SMS" />\n    <application'));
  fs.copyFileSync(path.join(HERE, 'fixtures/fake-gradlew.sh'), path.join(dir, 'gradlew'));

  let r = (await api('/api/projects/shop/play')).data;
  assert.equal(r.targetSdkRequired, 36);
  assert.equal(r.ready, false);
  let ck = byId(r);
  assert.equal(ck['target-sdk'].status, 'fail');
  assert.equal(ck.package.status, 'fail');
  assert.equal(ck.signing.status, 'fail');
  assert.equal(ck.debuggable.status, 'fail');
  assert.equal(ck.permissions.status, 'warn');
  assert.match(ck.permissions.detail, /READ_SMS/);
  assert.equal(ck.bundle.status, 'warn');

  // fixes
  assert.equal((await api('/api/projects/shop/play/target-sdk', { method: 'POST' })).data.targetSdk, 36);
  assert.match(fs.readFileSync(g, 'utf8'), /targetSdk = 36/);
  const bump = (await api('/api/projects/shop/play/bump', { method: 'POST', body: { part: 'minor' } })).data;
  assert.deepEqual([bump.versionCode, bump.versionName], [2, '1.1.0']);

  // upload key
  assert.equal((await api('/api/projects/shop/signing/generate', { method: 'POST', body: { name: 'Bad;Name' } })).status, 400);
  const key = await api('/api/projects/shop/signing/generate', { method: 'POST', body: { name: 'Jane Dev', organization: 'Jane Apps', country: 'id' } });
  assert.equal(key.status, 201, JSON.stringify(key.data));
  assert.equal(key.data.alias, 'upload');
  assert.match(key.data.owner, /CN=Jane Dev/);
  assert.match(key.data.sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal((await api('/api/projects/shop/signing/generate', { method: 'POST', body: { name: 'Again' } })).status, 409);
  const ks = path.join(ctx.env.DATA_DIR, 'projects/shop/signing/upload.jks');
  assert.equal(fs.statSync(ks).mode & 0o077, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'upload.jks')), 'key never inside the project/git');
  const sec = (await api('/api/projects/shop/signing/secrets')).data;
  assert.ok(sec.storePassword.length >= 20);
  const dl = await api('/api/projects/shop/signing/keystore', { raw: true });
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, fs.statSync(ks).size);

  // AAB build, signed with the project key; 16 KB problem detected
  fs.writeFileSync(path.join(dir, 'FAKE_AAB'), aab(4096));
  assert.equal((await api('/api/projects/shop/builds', { method: 'POST', body: { task: 'bundleRelease', autoInstallAfterBuild: true, deviceSerial: '10.1.1.1:5555' } })).status, 400);
  const b1 = (await api('/api/projects/shop/builds', { method: 'POST', body: { task: 'bundleRelease' } })).data;
  const done = await waitBuild(b1.id);
  assert.equal(done.state, 'succeeded', JSON.stringify(done));
  assert.equal(done.signed, true);
  assert.equal(done.apk.type, 'aab');
  assert.equal(done.versionCode, 2);
  assert.match((await api(`/api/builds/${b1.id}/log`)).data, /signing-props: 4/);
  assert.match((await api(`/api/builds/${b1.id}/log`)).data, /Release signing: project upload key, alias upload/);
  assert.ok(!fs.readFileSync(path.join(ctx.env.GRADLE_USER_HOME, 'gradle.properties'), 'utf8').includes('injected.signing'));
  const dlAab = await api(`/api/builds/${b1.id}/apk`, { raw: true });
  assert.match(dlAab.headers.get('content-disposition'), /\.aab"/);
  assert.equal((await api('/api/devices/action', { method: 'POST', body: { serial: '10.147.17.5:5555', action: 'install', buildId: b1.id } })).status, 400);

  r = (await api('/api/projects/shop/play')).data;
  ck = byId(r);
  assert.equal(ck['target-sdk'].status, 'pass');
  assert.equal(ck.signing.status, 'pass');
  assert.equal(ck.bundle.status, 'pass');
  assert.equal(ck['page-size'].status, 'fail');
  assert.match(ck['page-size'].detail, /libnative\.so/);
  assert.equal(ck.version.status, 'pass', 'fresh bundle is the upload candidate');

  // rebuild without bumping -> warn about the re-used versionCode
  fs.writeFileSync(path.join(dir, 'FAKE_AAB'), aab(16384));
  await waitBuild((await api('/api/projects/shop/builds', { method: 'POST', body: { task: 'bundleRelease' } })).data.id);
  assert.equal(byId((await api('/api/projects/shop/play')).data).version.status, 'warn');

  // bump + rebuild => fixed
  await api('/api/projects/shop/play/bump', { method: 'POST', body: {} });
  await waitBuild((await api('/api/projects/shop/builds', { method: 'POST', body: { task: 'bundleRelease' } })).data.id);
  ck = byId((await api('/api/projects/shop/play')).data);
  assert.equal(ck['page-size'].status, 'pass');
  assert.equal(ck.version.status, 'pass');

  // delete requires confirmation
  assert.equal((await api('/api/projects/shop/signing/delete', { method: 'POST', body: { confirm: 'yes' } })).status, 400);
  assert.equal((await api('/api/projects/shop/signing/delete', { method: 'POST', body: { confirm: 'DELETE' } })).status, 200);
  assert.equal((await api('/api/projects/shop/signing')).data.configured, false);
});

test('import an existing keystore', { skip: !haveKeytool && 'keytool not installed' }, async () => {
  await api('/api/projects', { method: 'POST', body: { name: 'Imported', packageName: 'dev.imp.app' } });
  const ks = path.join(ctx.tmp, 'mine.p12');
  execFileSync(KEYTOOL, ['-genkeypair', '-keystore', ks, '-storetype', 'PKCS12', '-alias', 'mykey', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '365', '-dname', 'CN=Me', '-storepass', 'secret123', '-keypass', 'secret123', '-noprompt'], { stdio: 'ignore' });
  const data = fs.readFileSync(ks).toString('base64');
  assert.equal((await api('/api/projects/imported/signing/import', { method: 'POST', body: { data, storePassword: 'wrong', alias: 'mykey' } })).status, 400);
  const ok = await api('/api/projects/imported/signing/import', { method: 'POST', body: { data, storePassword: 'secret123', alias: 'mykey' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.imported, true);
  assert.match(ok.data.owner, /CN=Me/);
});
