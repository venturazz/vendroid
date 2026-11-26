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

// ---- editor diagnostics (pure modules shared with the browser)
const { parseProblems, relPath } = await import('../public/app/js/problems.js');
const { bracketCheck, jsonCheck, posOf } = await import('../../editor/src/checks.js');
function textDoc(text) {
  const lines = text.split('\n');
  const starts = [];
  let p = 0;
  for (const l of lines) { starts.push(p); p += l.length + 1; }
  const line = (n) => ({ number: n, from: starts[n - 1], to: starts[n - 1] + lines[n - 1].length, length: lines[n - 1].length });
  return { length: text.length, lines: lines.length, line, lineAt: (pos) => line(starts.findLastIndex((s) => s <= pos) + 1), sliceString: (a, b) => text.slice(a, b) };
}

test('build problems: Kotlin, javac and AAPT lines map to project files', () => {
  const root = '/ws/my-app';
  const log = [
    'e: file:///ws/my-app/app/src/main/java/dev/x/MainActivity.kt:12:5 Unresolved reference \'Txt\'.',
    'w: file:///ws/my-app/app/src/main/java/dev/x/MainActivity.kt:3:1 Parameter \'a\' is never used',
    'e: /ws/my-app/app/src/main/java/dev/x/Old.kt: (7, 9): Expecting \')\'',
    '/ws/my-app/app/src/main/java/dev/x/Util.java:4: error: cannot find symbol',
    'ERROR: /ws/my-app/app/src/main/res/layout/activity_main.xml:8: AAPT: error: attribute android:txt not found.',
    '/ws/my-app/app/src/main/res/values/strings.xml:5:5-30: AAPT: error: resource string/x not found.',
    'e: file:///ws/my-app/app/build/generated/ksp/Gen.kt:1:1 generated code is ignored',
    'e: file:///elsewhere/Other.kt:1:1 outside the project',
    'BUILD FAILED in 3s',
  ];
  const p = parseProblems(log, root, 'my-app');
  assert.equal(p.length, 6, JSON.stringify(p));
  assert.deepEqual(p.filter((x) => x.severity === 'warning').map((x) => x.line), [3]);
  assert.equal(p.at(-1).severity, 'warning', 'errors first');
  const kt = p.find((x) => x.path === 'app/src/main/java/dev/x/MainActivity.kt' && x.severity === 'error');
  assert.deepEqual([kt.line, kt.col], [12, 5]);
  assert.match(kt.message, /Unresolved reference/);
  assert.ok(p.some((x) => x.path === 'app/src/main/java/dev/x/Old.kt' && x.line === 7 && x.col === 9));
  assert.ok(p.some((x) => x.path === 'app/src/main/res/layout/activity_main.xml' && x.line === 8));
  assert.ok(p.some((x) => x.path === 'app/src/main/res/values/strings.xml' && x.col === 5));
  assert.equal(relPath('/data/ws/my-app/app/A.kt', '/srv/other-root', 'my-app'), 'app/A.kt', 'falls back to the project id in the path');
});

test('editor syntax checks: brackets, strings, templates, comments, JSON', () => {
  const check = (src, lang = 'kotlin') => bracketCheck(src, textDoc(src), lang);
  const ok = [
    'fun main() { val s = "a ${listOf(1, 2).map { it + 1 }} b"; println("}") }',
    'val raw = """\n  { not a brace ( \\" \n"""\nfun f() {}',
    '/* outer /* nested } */ still comment ) */ class A {}',
    "val c = '}'; val d = '\\''; fun g() = listOf('(')",
    '// } ) ] in a line comment\nclass B { fun h() = mapOf("k" to "v") }',
    'val q = "price: $count items ${if (a) "{" else "}"}"',
  ];
  for (const src of ok) assert.deepEqual(check(src), [], src);
  assert.deepEqual(check('class A { void f() { String s = "}"; } }', 'java'), []);
  assert.deepEqual(check("android { namespace 'dev.x'; defaultConfig { versionName \"1.${v}\" } }", 'groovy'), []);

  const missing = check('class A {\n  fun f() {\n    println("x")\n}\n');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /Missing '\}': '\{' opened at line 1/);
  const extra = check('fun f() {\n  g())\n}');
  assert.match(extra[0].message, /Unexpected '\)': '\{' opened at line 1/);
  assert.equal(textDoc('fun f() {\n  g())\n}').lineAt(extra[0].from).number, 2);
  assert.match(check('val s = "unterminated\nval t = 1')[0].message, /Unterminated string \(opened at line 1\)/);
  assert.match(check('/* never closed')[0].message, /Unclosed block comment/);

  assert.deepEqual(jsonCheck('{"a": [1, 2]}', textDoc('{"a": [1, 2]}')), []);
  const bad = '{\n  "a": 1,\n}';
  const j = jsonCheck(bad, textDoc(bad));
  assert.equal(j.length, 1);
  assert.ok(j[0].from > 0 && j[0].from <= bad.length);
  assert.equal(posOf(textDoc('ab\ncd'), 2, 2), 4);
});
