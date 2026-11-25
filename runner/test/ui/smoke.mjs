// Browser smoke test of the real dashboard (CI only: needs `playwright` + Chromium).
// Starts the server with the fake adb/gradlew fixtures, then drives the UI like a user and fails on
// any console error, CSP violation or uncaught exception. Screenshots go to $UI_OUT.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures');
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'ui-shots');
const PASSWORD = 'ui-smoke-password';
const DEVICE = '10.147.17.5:5555';
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ui-'));
const proj = path.join(tmp, 'project');
const state = path.join(tmp, 'adb');
fs.mkdirSync(proj); fs.mkdirSync(state); fs.mkdirSync(path.join(tmp, 'bin'));
fs.copyFileSync(path.join(FIX, 'fake-gradlew.sh'), path.join(proj, 'gradlew'));
fs.copyFileSync(path.join(FIX, 'fake-adb.sh'), path.join(tmp, 'bin', 'adb'));
fs.chmodSync(path.join(proj, 'gradlew'), 0o755);
fs.chmodSync(path.join(tmp, 'bin', 'adb'), 0o755);
execFileSync('git', ['init', '-q'], { cwd: proj });

const ai = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"rootCause":"`foo` is not declared in Main.kt","affected":["app/src/main/java/Main.kt:3"],"fixSteps":["Declare foo or import it","Rebuild"],"confidence":"high"}' } }] }));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => ai.once('listening', r));

const port = 31000 + Math.floor(Math.random() * 5000);
const server = spawn(process.execPath, [path.join(HERE, '..', '..', 'src', 'server.js')], {
  env: {
    PATH: process.env.PATH, HOME: tmp, PORT: String(port), HOST: '127.0.0.1', AUTH_PASSWORD: PASSWORD,
    ANDROID_PROJECT_PATH: proj, ANDROID_HOME: path.join(tmp, 'sdk'), DATA_DIR: path.join(tmp, 'data'),
    GRADLE_USER_HOME: path.join(tmp, 'gradle'), ADB_BIN: path.join(tmp, 'bin', 'adb'), FAKE_STATE: state,
    AAPT2_BINARY: '/bin/true', DEFAULT_PACKAGE_NAME: 'com.example.app', DEFAULT_DEVICE_ADDRESS: DEVICE,
    NINE_ROUTER_URL: `http://127.0.0.1:${ai.address().port}/v1`,
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
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })).newPage();
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const step = (s) => console.log(`[ui] ${s}`);

try {
  step('login page');
  await page.goto(base);
  await shot('01-login');
  await page.fill('#pw', 'wrong-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#err:has-text("Invalid password")');
  problems.splice(0); // the 401 above is expected
  await page.fill('#pw', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('#btnBuild');

  step('device auto-connects, badges render');
  await page.waitForSelector('#devBadge.ok', { timeout: 20000 });
  await page.waitForSelector('#aiBadge:not(:has-text("…"))');
  await shot('02-dashboard-empty');

  step('environment dialog');
  await page.click('#envBadge');
  await page.waitForSelector('#envDlg[open] #envTable tr');
  await shot('03-env-dialog');
  await page.click('#envDlg button');

  step('build & deploy via Ctrl+Enter, logcat follows the launch');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('#tab-logcat:not([hidden])', { timeout: 20000 });
  await page.waitForSelector('#lcLog div', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Crash detected')
    || document.querySelector('#lcLog').textContent.includes('FATAL EXCEPTION'));
  await shot('05-logcat-followed');

  step('triage crash with 9Router');
  await page.click('#lcTriage');
  await page.waitForSelector('#lcAi:has-text("Root cause")');
  await shot('06-logcat-triage');

  step('console shows succeeded build with commit-less history item and APK link');
  await page.click('[data-tab=console]');
  await page.waitForSelector('#bState.succeeded');
  await page.waitForSelector('#history li a.btn:has-text("APK")');
  await shot('04-console-succeeded');

  step('failed build, analyze error');
  fs.writeFileSync(path.join(proj, 'FAIL'), '');
  await page.click('#btnBuild');
  await page.waitForSelector('#bState.failed', { timeout: 20000 });
  await page.click('#btnAnalyze');
  await page.waitForSelector('#aiOut:has-text("Fix steps")');
  await shot('07-console-failed-analyzed');
  fs.rmSync(path.join(proj, 'FAIL'));

  step('screen tab: capture + actions');
  await page.click('[data-tab=screen]');
  await page.click('#scCapture');
  await page.waitForSelector('#scSave:not([hidden])');
  await page.click('#scLaunch');
  await page.waitForSelector('#toast:has-text("Launch")');
  await shot('08-screen-actions');

  step('settings persist across reload');
  await page.click('[data-tab=console]');
  await page.selectOption('#task', 'clean assembleDebug');
  await page.uncheck('#oLaunch');
  await page.reload();
  await page.waitForSelector('#btnBuild');
  const task = await page.inputValue('#task');
  const launch = await page.isChecked('#oLaunch');
  if (task !== 'clean assembleDebug' || launch) problems.push(`settings not persisted (task=${task}, launch=${launch})`);

  step('mobile layout');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('09-mobile');

  step('logout');
  await page.click('#logout');
  await page.waitForSelector('#pw');
} catch (e) {
  problems.push(`flow: ${e.message}`);
  await shot('99-failure').catch(() => {});
} finally {
  await browser.close();
  server.kill('SIGTERM');
  ai.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error('[ui] FAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`[ui] OK, screenshots in ${OUT}`);
