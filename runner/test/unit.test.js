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
  assert.deepEqual(Object.keys(TASKS), ['assembleDebug', 'assembleRelease', 'clean assembleDebug', 'bundleRelease']);
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
  assert.deepEqual(gh({ 'x-github-event': 'push', 'x-hub-signature-256': sig }), { ok: true, repoUrls: [], ref: 'refs/heads/main', deleted: false });
  assert.equal(gh({ 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }).ok, false);
  assert.equal(gh({ 'x-github-event': 'push' }).ok, false);
  assert.equal(gh({ 'x-github-event': 'ping', 'x-hub-signature-256': sig }).ping, true);
  assert.equal(gh({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret }).ref, 'refs/heads/main');
  assert.equal(gh({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'nope' }).ok, false);
});

import { unifiedDiff } from '../src/diff.js';
import { parseEdits } from '../src/aicode.js';
import { isRelPath, isCloneUrl, isBranch, isProjectId } from '../src/validate.js';
import { handleMcp } from '../src/mcp.js';

test('unified diff', () => {
  const a = 'a\nb\nc\nd\n';
  const b = 'a\nB\nc\nd\ne\n';
  assert.equal(unifiedDiff(a, b, 'x.kt'), '--- a/x.kt\n+++ b/x.kt\n@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+e\n');
  assert.equal(unifiedDiff(a, a, 'x.kt'), '');
  assert.match(unifiedDiff(null, 'new\n', 'n.kt'), /^--- \/dev\/null\n\+\+\+ b\/n\.kt\n@@ -0,0 \+1,1 @@\n\+new/);
});

test('SEARCH/REPLACE parsing tolerates fences, backticks and bold paths', () => {
  const t = 'Sure.\n\n**app/src/A.kt**\n```kotlin\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```\n\n`app/B.kt`\n<<<<<<< SEARCH\n=======\nfresh\n>>>>>>> REPLACE\nunterminated\n<<<<<<< SEARCH\nx\n';
  assert.deepEqual(parseEdits(t), [
    { path: 'app/src/A.kt', search: 'old', replace: 'new' },
    { path: 'app/B.kt', search: '', replace: 'fresh' },
  ]);
});

test('path, url, branch and project id validation', () => {
  for (const ok of ['app/src/main/A.kt', 'README.md', '.gitignore', 'gradle/wrapper/x']) assert.ok(isRelPath(ok), ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', '.git/config', 'a/.git/hooks/x', 'a\\b', 'a\0b', './a']) assert.equal(isRelPath(bad), false, bad);
  assert.ok(isCloneUrl('https://github.com/me/app.git'));
  assert.ok(isCloneUrl('https://x-access-token:ghp_abc@github.com/me/app'));
  for (const bad of ['http://github.com/a/b', 'git@github.com:a/b.git', 'ext::sh -c id', 'file:///tmp/x', 'https://github.com/a b', 'https://github.com/$(id)', '-uhttps://x/y']) {
    assert.equal(isCloneUrl(bad), false, bad);
  }
  for (const ok of ['main', 'feature/login', 'ai/2026-11-25-x', 'v1.2']) assert.ok(isBranch(ok), ok);
  for (const bad of ['-f', 'a..b', 'a/', '/a', 'x.lock', 'a b', 'a~1', '.hidden']) assert.equal(isBranch(bad), false, bad);
  assert.ok(isProjectId('my-app'));
  for (const bad of ['..', '.hidden', 'a/b', '', 'x.']) assert.equal(isProjectId(bad), false, bad);
});

test('MCP JSON-RPC: initialize, tools/list, tool errors, notifications, batches', async () => {
  const tools = {
    list: () => [{ name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {}, required: [] } }],
    call: async (name, args) => {
      if (name === 'boom') throw new Error('kaput');
      return { image: false, value: { name, args } };
    },
  };
  const init = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  assert.equal((await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools)).status, 202);
  assert.equal((await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools)).body.result.tools[0].name, 'echo');
  const call = await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }, tools);
  assert.deepEqual(JSON.parse(call.body.result.content[0].text), { name: 'echo', args: { a: 1 } });
  const err = await handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } }, tools);
  assert.equal(err.body.result.isError, true);
  assert.equal((await handleMcp({ jsonrpc: '2.0', id: 5, method: 'nope' }, tools)).body.error.code, -32601);
  const batch = await handleMcp([{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }], tools);
  assert.equal(batch.body.length, 1);
});

import { imageInfo } from '../src/imageinfo.js';

test('image header parsing', () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(192, 16); png.writeUInt32BE(144, 20);
  assert.deepEqual(imageInfo(png), { type: 'png', width: 192, height: 144 });
  const gif = Buffer.from('GIF89a\x10\x00\x20\x00\x00\x00\x00\x00', 'latin1');
  assert.deepEqual(imageInfo(gif), { type: 'gif', width: 16, height: 32 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03]);
  assert.deepEqual(imageInfo(jpg), { type: 'jpeg', width: 64, height: 48 });
  assert.equal(imageInfo(Buffer.from('hello world, not an image')), null);
  assert.equal(imageInfo(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>')).type, 'svg');
});
