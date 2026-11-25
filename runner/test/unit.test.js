import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isTcpTarget, isSerial, isPackage, isTask, isBuildId, TASKS } from '../src/validate.js';
import { sliceBuildError, sliceCrash } from '../src/ai.js';
import { verifyGitWebhook } from '../src/webhook.js';
import { lineSplitter } from '../src/exec.js';

test('tunnel targets: strict ipv4:port only', () => {
  for (const ok of ['10.147.17.5:5555', '192.168.1.2:1', '100.64.0.1:65535']) assert.ok(isTcpTarget(ok), ok);
  for (const bad of ['10.0.0.1', '256.1.1.1:5555', '10.0.0.1:0', '10.0.0.1:70000', '10.0.0.1:5555;id',
    'host:5555', ' 10.0.0.1:5555', '10.0.0.1:5555\n', '-s:1', '1.2.3:4', undefined, 5555]) {
    assert.equal(isTcpTarget(bad), false, String(bad));
  }
});

test('serials and packages reject shell metacharacters and option injection', () => {
  assert.ok(isSerial('R58M123ABC'));
  assert.ok(isSerial('emulator-5554'));
  for (const bad of ['-x', '$(id)', 'a b', 'abc', '../x', 'a;b']) assert.equal(isSerial(bad), false, bad);
  assert.ok(isPackage('com.example.app'));
  assert.ok(isPackage('dev.my_app.v2'));
  for (const bad of ['com', 'com.example.', '.com.x', 'com.x;id', 'com.1x', '-p com.x', 'com.x y']) {
    assert.equal(isPackage(bad), false, bad);
  }
});

test('build tasks are an exact allowlist', () => {
  assert.deepEqual(Object.keys(TASKS), ['assembleDebug', 'assembleRelease', 'clean assembleDebug']);
  for (const bad of ['assembleDebug ', 'assembleDebug --init-script x', 'tasks', '__proto__', 'constructor']) {
    assert.equal(isTask(bad), false, bad);
  }
  assert.ok(isBuildId('bmwvh4ayh-3fcfde'));
  assert.equal(isBuildId('../../etc/passwd'), false);
});

test('sliceBuildError keeps Kotlin errors and the "What went wrong" block', () => {
  const log = [...Array(500).keys()].map((i) => `noise ${i}`)
    .concat(['e: Main.kt:3:1 Unresolved reference: foo', '* What went wrong:', "Execution failed for task ':app:compileDebugKotlin'."])
    .join('\n');
  const out = sliceBuildError(log);
  assert.match(out, /Unresolved reference: foo/);
  assert.match(out, /What went wrong/);
  assert.ok(!out.includes('noise 10\n'));
});

test('sliceCrash starts at the last FATAL EXCEPTION', () => {
  const log = ['a', 'E AndroidRuntime: FATAL EXCEPTION: main', 'old', 'b', 'E AndroidRuntime: FATAL EXCEPTION: worker', 'java.lang.NPE'].join('\n');
  const out = sliceCrash(log);
  assert.match(out, /worker/);
  assert.ok(!out.includes('main'));
});

test('lineSplitter handles CR, CRLF and split chunks', () => {
  const lines = [];
  const s = lineSplitter((l) => lines.push(l));
  s.write(Buffer.from('one\r\ntw'));
  s.write(Buffer.from('o\rthree\nfour'));
  s.end();
  assert.deepEqual(lines, ['one', 'two', 'three', 'four']);
});

test('git webhook signatures', () => {
  const secret = 's3cret';
  const raw = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'abc123' }));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const gh = (headers) => verifyGitWebhook({ headers: { 'content-type': 'application/json', ...headers } }, raw, secret);
  assert.deepEqual(gh({ 'x-github-event': 'push', 'x-hub-signature-256': sig }), { ok: true, ref: 'refs/heads/main', deleted: false });
  assert.equal(gh({ 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }).ok, false);
  assert.equal(gh({ 'x-github-event': 'push' }).ok, false);
  assert.equal(gh({ 'x-github-event': 'ping', 'x-hub-signature-256': sig }).ping, true);
  assert.equal(gh({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret }).ref, 'refs/heads/main');
  assert.equal(gh({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'nope' }).ok, false);
});
