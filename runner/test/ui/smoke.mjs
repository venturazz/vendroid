// Browser smoke test of the IDE (CI only: needs `playwright` + Chromium). Drives the real UI like a
// user: hub → new project → explorer/editor → save → git commit → AI edit → run on phone → logcat →
// device screenshot. Fails on any console error / uncaught exception. Screenshots go to $UI_OUT.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { aab } from '../fixtures/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures');
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'ui-shots');
const PASSWORD = 'ui-smoke-password';
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendroid-ui-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'adb'));
fs.copyFileSync(path.join(FIX, 'fake-adb.sh'), path.join(tmp, 'bin', 'adb'));
fs.chmodSync(path.join(tmp, 'bin', 'adb'), 0o755);

// Fake 9Router: streams an answer with one edit to MainActivity.kt
const EDIT = [
  'Here is a friendlier greeting.',
  '',
  'app/src/main/java/dev/ui/test/MainActivity.kt',
  '<<<<<<< SEARCH',
  '        Text(text = "Tapped $count times")',
  '=======',
  '        Text(text = "You tapped $count times")',
  '>>>>>>> REPLACE',
].join('\n');
const nr = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const body = req.url.includes('chat') ? null : null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < EDIT.length; i += 9) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: EDIT.slice(i, i + 9) } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    void body;
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => nr.once('listening', r));

const port = 31000 + Math.floor(Math.random() * 5000);
const server = spawn(process.execPath, [path.join(HERE, '..', '..', 'src', 'server.js')], {
  env: {
    PATH: process.env.PATH, HOME: tmp, PORT: String(port), HOST: '127.0.0.1', AUTH_PASSWORD: PASSWORD,
    WORKSPACES_DIR: ws, ANDROID_HOME: path.join(tmp, 'sdk'), DATA_DIR: path.join(tmp, 'data'),
    GRADLE_USER_HOME: path.join(tmp, 'gradle'), ADB_BIN: path.join(tmp, 'bin', 'adb'), FAKE_STATE: path.join(tmp, 'adb'),
    AAPT2_BINARY: '/bin/true', DEFAULT_DEVICE_ADDRESS: '10.147.17.5:5555',
    NINE_ROUTER_URL: `http://127.0.0.1:${nr.address().port}/v1`, GIT_USER_NAME: 'UI Test', GIT_USER_EMAIL: 'ui@test',
    ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
  },
  stdio: 'inherit',
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 100));
}

const problems = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 960 }, colorScheme: 'dark' })).newPage();
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
let currentStep = '';
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().endsWith('/api/auth/login')) {
    const body = (r.request().postData() || '').slice(0, 160);
    problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base, '')} during "${currentStep}" ${body}`);
  }
});
let n = 0;
const shot = (name) => page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) });
const step = (s) => { currentStep = s; console.log(`[ui] ${s}`); };
const projDir = () => path.join(ws, 'ui-test-app');

try {
  step('login');
  await page.goto(base);
  await page.fill('#pw', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('#hub:not([hidden])');
  await page.waitForSelector('#hubEmpty:not([hidden])');
  await shot('hub-empty');

  step('new project dialog (Compose template)');
  await page.click('#hubNew');
  await page.fill('#npName', 'UI Test App');
  await page.fill('#npPkg', 'dev.ui.test');
  if (!(await page.textContent('#npTarget')).includes('Android 17')) problems.push('dialog does not show the target Android version');
  await shot('new-project-dialog');
  await page.click('#npCreate');
  await page.waitForSelector('#ide:not([hidden])', { timeout: 20000 });
  await page.waitForSelector('#tree .node[data-path="app"]');
  // Fake Gradle for this project so Run works without downloading Gradle
  fs.copyFileSync(path.join(FIX, 'fake-gradlew.sh'), path.join(projDir(), 'gradlew'));

  step('open MainActivity via quick open, CodeMirror loads with Kotlin');
  await page.keyboard.press('Control+p');
  await page.fill('#quickInput', 'MainActivity');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tab.active:has-text("MainActivity.kt")');
  await page.waitForSelector('.cm-editor .cm-content');
  if ((await page.textContent('#sbLang')) !== 'Kotlin') problems.push(`language: ${await page.textContent('#sbLang')}`);
  await page.waitForSelector('#tree .node[data-path="app/src/main/java/dev/ui/test/MainActivity.kt"]');
  await shot('editor-kotlin');

  step('edit + save (Ctrl+S) -> git shows modified');
  await page.click('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// edited in the browser\n');
  await page.waitForSelector('.tab.active.dirty');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.tab.active:not(.dirty)');
  if (!fs.readFileSync(path.join(projDir(), 'app/src/main/java/dev/ui/test/MainActivity.kt'), 'utf8').includes('// edited in the browser')) problems.push('save did not reach disk');
  await page.waitForSelector('#sbSave.ok:has-text("Saved")');
  if (await page.isDisabled('#edSave') !== true) problems.push('Save button enabled on a clean file');

  step('autosave: typing saves by itself');
  await page.click('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// autosaved\n');
  await page.waitForSelector('#sbSave.dirty');
  await page.waitForSelector('#sbSave.ok', { timeout: 5000 });
  if (!fs.readFileSync(path.join(projDir(), 'app/src/main/java/dev/ui/test/MainActivity.kt'), 'utf8').includes('// autosaved')) problems.push('autosave did not reach disk');

  step('live: a change made outside the editor (like Hermes over MCP) shows up without reload');
  await page.evaluate(async () => {
    const p = '/api/projects/ui-test-app/file';
    const f = await (await fetch(`${p}?path=app/src/main/java/dev/ui/test/MainActivity.kt`)).json();
    await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'app/src/main/java/dev/ui/test/MainActivity.kt', content: `${f.content}// written by the agent\n` }) });
  });
  await page.waitForFunction(() => document.querySelector('.ed:not([hidden]) .cm-content')?.textContent.includes('// written by the agent'), null, { timeout: 5000 })
    .catch(() => { throw new Error('editor did not pick up the outside change'); });
  if (await page.$('.tab.active.dirty')) problems.push('tab dirty after outside change');
  await page.waitForSelector('#tree .node[data-path="app"]');

  step('open XML + Gradle files (highlighting)');
  await page.click('#tree .node[data-path="app"]').catch(() => {});
  await page.keyboard.press('Control+p');
  await page.fill('#quickInput', 'strings.xml');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tab.active:has-text("strings.xml")');
  if ((await page.textContent('#sbLang')) !== 'XML') problems.push('xml language');
  await page.keyboard.press('Control+p');
  await page.fill('#quickInput', 'app/build.gradle.kts');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tab.active:has-text("build.gradle.kts")');
  await shot('editor-gradle');

  step('source control: diff + commit');
  await page.click('.activitybar [data-view=git]');
  await page.waitForSelector('.gf:has-text("MainActivity.kt")');
  await page.click('.gf:has-text("MainActivity.kt")');
  await page.waitForSelector('.tab.active:has-text("Δ MainActivity.kt")');
  await page.waitForSelector('.diffview .d-add');
  await shot('git-diff');
  await page.fill('#gitMsg', 'Edit from the browser');
  await page.click('#gitBody button.primary');
  await page.waitForSelector('#gitLog div:has-text("Edit from the browser")');
  await shot('git-committed');

  step('AI panel: stream, proposal, apply');
  await page.click('.activitybar [data-view=explorer]');
  await page.keyboard.press('Control+p');
  await page.fill('#quickInput', 'MainActivity');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+i');
  await page.waitForSelector('#aipanel:not([hidden])');
  await page.waitForSelector('#aiCtx .ctxchip:has-text("MainActivity.kt")');
  await page.fill('#aiInput', 'Make the counter text friendlier');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.proposal .pfh:has-text("MainActivity.kt")', { timeout: 15000 });
  await page.waitForSelector('#aiMeter:not([hidden])');
  await shot('ai-proposal');
  await page.click('.proposal button:has-text("Apply all")');
  await page.waitForSelector('.proposal button:has-text("Undo"):not([hidden])');
  if (!fs.readFileSync(path.join(projDir(), 'app/src/main/java/dev/ui/test/MainActivity.kt'), 'utf8').includes('You tapped')) problems.push('apply did not reach disk');
  await page.waitForFunction(() => [...document.querySelectorAll('.ed:not([hidden]) .cm-content')].some((e) => e.textContent.includes('You tapped')), null, { timeout: 5000 })
    .catch(() => { throw new Error('open editor was not refreshed after AI apply'); });
  if (await page.$('.tab.active.dirty')) problems.push('tab marked dirty after apply');
  await shot('ai-applied');

  step('undo + re-apply');
  await page.click('.proposal button:has-text("Undo")');
  await page.waitForFunction(() => [...document.querySelectorAll('.ed:not([hidden]) .cm-content')].some((e) => e.textContent.includes('"Tapped $count times"')), null, { timeout: 5000 });
  await page.click('.proposal button:has-text("Apply all")');
  await page.waitForFunction(() => [...document.querySelectorAll('.ed:not([hidden]) .cm-content')].some((e) => e.textContent.includes('You tapped')), null, { timeout: 5000 });

  await page.waitForTimeout(1500); // let any late reloads land
  const panes = await page.evaluate(() => [...document.querySelectorAll('#editorHost > .ed')].map((e) => ({
    hidden: e.hidden, display: getComputedStyle(e).display, z: [...e.parentNode.children].indexOf(e),
    tapped: (e.textContent.match(/(You tapped|"Tapped) \$count/g) || []).join(','),
  })));
  console.log('[ui] panes', JSON.stringify(panes), 'tabs', await page.$$eval('.tab', (t) => t.map((x) => x.textContent)));
  if (panes.filter((p) => p.display !== 'none').length !== 1) problems.push(`expected exactly one visible editor pane: ${JSON.stringify(panes)}`);
  const vis = panes.find((p) => p.display !== 'none');
  if (!vis || !vis.tapped.includes('You tapped') || vis.tapped.includes('"Tapped')) problems.push(`visible editor shows ${vis?.tapped}`);
  await shot('after-reapply');
  if (!(await page.textContent('.ed:not([hidden]) .cm-content')).includes('You tapped')) problems.push('editor reverted to stale content after re-apply');
  if (await page.$('.tab.dirty')) problems.push('a tab is dirty after apply');

  step('syntax check: a stray bracket is marked while typing, deleting it clears the mark');
  await page.click('.ed:not([hidden]) .cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('val z = 1)');
  await page.waitForSelector('.ed:not([hidden]) .cm-lint-marker-error', { timeout: 5000 }).catch(() => problems.push('no lint marker for a missing brace'));
  await shot('lint-error');
  for (let k = 0; k < 'val z = 1)'.length; k++) await page.keyboard.press('Backspace');
  await page.waitForFunction(() => !document.querySelector('.ed:not([hidden]) .cm-lint-marker-error'), null, { timeout: 5000 }).catch(() => problems.push('lint marker stayed after the fix'));
  if ((await page.textContent('.ed:not([hidden]) .cm-content')).includes('val z = 1')) problems.push('typed text not removed');

  step('run: build, install, launch, logcat follows');
  await page.click('#quickConnect');
  await page.waitForSelector('#devBadge.ok', { timeout: 15000 });
  await page.click('#btnRun');
  await page.waitForSelector('[data-bpane=logcat]:not([hidden]) #lcLog div', { timeout: 40000 });
  await shot('run-logcat');
  if (!(await page.textContent('.ed:not([hidden]) .cm-content')).includes('You tapped')) problems.push('editor content changed during run');
  await page.click('.bottom-tabs [data-btab=build]');
  await page.waitForSelector('#bState.succeeded');
  await page.waitForSelector('#bLog div:has-text("Events injected")');
  await shot('build-output');

  step('problems: a failing build lists compiler errors and marks the file');
  fs.writeFileSync(path.join(projDir(), 'FAIL'), '');
  fs.mkdirSync(path.join(projDir(), 'app/src/main/java'), { recursive: true });
  fs.writeFileSync(path.join(projDir(), 'app/src/main/java/Main.kt'), 'package x\n\nval y = foo\n');
  await page.click('#btnBuildOnly');
  await page.waitForSelector('#bState.failed', { state: 'attached', timeout: 30000 }); // the Problems tab opens on top
  await page.waitForSelector('[data-bpane=problems]:not([hidden]) .prob.error:has-text("Unresolved reference")', { timeout: 10000 })
    .catch(() => problems.push('Problems tab did not list the compiler error'));
  if ((await page.textContent('#probCount')) !== '1') problems.push(`problem count: ${await page.textContent('#probCount')}`);
  await shot('problems');
  await page.click('.prob.error');
  await page.waitForSelector('.tab.active:has-text("Main.kt")');
  await page.waitForSelector('.ed:not([hidden]) .cm-lint-marker-error', { timeout: 5000 }).catch(() => problems.push('build error not marked in the editor'));
  fs.rmSync(path.join(projDir(), 'FAIL'));
  await page.click('.bottom-tabs [data-btab=build]');

  step('live: a build started elsewhere (agent/webhook) takes over the build panel');
  const extId = await page.evaluate(async () => (await (await fetch('/api/projects/ui-test-app/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'assembleDebug' }) })).json()).id);
  await page.waitForFunction((id) => document.querySelector('#buildSel').value === id, extId, { timeout: 10000 })
    .catch(() => { throw new Error('build panel did not follow the new build'); });
  await page.waitForSelector('#bState.succeeded', { timeout: 30000 });
  await page.waitForSelector('#bLog div:has-text("BUILD SUCCESSFUL")', { timeout: 10000 }).catch(() => problems.push('new build log not streamed'));

  step('device screenshot');
  await page.click('.bottom-tabs [data-btab=device]');
  await page.click('#scCapture');
  await page.waitForSelector('#scSave:not([hidden])');
  await shot('device');

  step('publish: Play checklist, upload key, signed AAB');
  fs.writeFileSync(path.join(projDir(), 'FAKE_AAB'), aab(16384));
  await page.click('.activitybar [data-view=publish]');
  await page.waitForSelector('.pcheck.pass:has-text("Target API 36+")');
  await page.waitForSelector('.pcheck.fail:has-text("Upload key")');
  await shot('publish-checklist');
  await page.fill('#keyName', 'UI Tester');
  await page.click('.keycard button:has-text("Generate upload key")');
  await page.waitForSelector('.pcheck.pass:has-text("Upload key")', { timeout: 30000 });
  await page.waitForSelector('.keycard .fp:has-text("SHA-256")');
  await page.click('.play-sum button:has-text("Build signed AAB")');
  await page.waitForSelector('.keycard:has-text("Latest bundle") a:has-text("Download .aab")', { timeout: 30000 });
  await page.waitForSelector('.pcheck.pass:has-text("16 KB memory pages")');
  await shot('publish-ready');

  step('settings / agents');
  await page.click('#btnMore');
  await page.click('#moreMenu [data-act=settings]');
  await page.waitForSelector('#mcpLocal:has-text("/mcp")');
  await shot('settings-agents');
  await page.click('#settingsClose');

  step('back to hub shows the project card');
  await page.click('.brand');
  await page.waitForSelector('.pcard:has-text("UI Test App")');
  await page.waitForSelector('.pcard .pill.succeeded');
  await shot('hub-with-project');

  step('narrow layout');
  await page.goto(`${base}/#/p/ui-test-app`);
  await page.waitForSelector('#ide:not([hidden])');
  await page.setViewportSize({ width: 820, height: 900 });
  await shot('narrow');

  step('phone layout: one view at a time with bottom navigation');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('#mnav:not([hidden])');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
  await page.click('#mnav [data-mview=files]');
  await page.waitForSelector('body.phone.m-files');
  if (!(await visible('#tree'))) problems.push('phone: file tree not visible in Files view');
  await shot('phone-files');
  await page.click('#tree .node[data-path="app"]');
  await page.click('#tree .node[data-path="app/build.gradle.kts"]').catch(async () => {
    await page.keyboard.press('Control+p');
    await page.fill('#quickInput', 'app/build.gradle.kts');
    await page.keyboard.press('Enter');
  });
  await page.waitForSelector('body.m-code', { timeout: 5000 }).catch(() => problems.push('phone: opening a file did not switch to Code'));
  if (!(await visible('.ed:not([hidden]) .cm-content'))) problems.push('phone: editor not visible in Code view');
  if (await visible('#tree')) problems.push('phone: tree still visible in Code view');
  await shot('phone-code');
  await page.click('#mnav [data-mview=build]');
  if (!(await visible('#bLog'))) problems.push('phone: build log not visible in Build view');
  await shot('phone-build');
  await page.click('#mnav [data-mview=ai]');
  if (!(await visible('#aiInput'))) problems.push('phone: AI input not visible in AI view');
  await shot('phone-ai');
  const ov = await overflow();
  if (ov > 2) problems.push(`phone: page scrolls sideways by ${ov}px`);
  await page.click('#aiClose');
  await page.waitForSelector('body.m-code');
} catch (e) {
  problems.push(`flow: ${e.message.split('\n').slice(0, 4).join(' | ')}`);
  await shot('failure').catch(() => {});
} finally {
  await browser.close();
  server.kill('SIGTERM');
  nr.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error('[ui] FAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`[ui] OK, screenshots in ${OUT}`);
