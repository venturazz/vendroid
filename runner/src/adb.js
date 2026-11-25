// ADB controller. Every call is an argv array; inputs are validated by callers AND here.
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { run, childEnv, lineSplitter, killGroup } from './exec.js';
import { LEVEL_RANK, bad, isPackage, isSerial, isTcpTarget } from './validate.js';

export const adb = (args, opts) => run(config.adbBin, args, opts);

// Argument builders (also used by the build pipeline so output streams into the build log).
export const argsInstall = (serial, apk) => ['-s', need(serial), 'install', '-r', apk];
export const argsLaunch = (serial, pkg) => [
  '-s', need(serial), 'shell', 'monkey', '-p', needPkg(pkg), '-c', 'android.intent.category.LAUNCHER', '1',
];
export const argsStop = (serial, pkg) => ['-s', need(serial), 'shell', 'am', 'force-stop', needPkg(pkg)];
export const argsClear = (serial, pkg) => ['-s', need(serial), 'shell', 'pm', 'clear', needPkg(pkg)];

function need(serial) {
  if (!isSerial(serial)) throw bad('Invalid device serial');
  return serial;
}
function needPkg(pkg) {
  if (!isPackage(pkg)) throw bad('Invalid package name');
  return pkg;
}

export async function listDevices() {
  const r = await adb(['devices', '-l'], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.error || 'adb devices failed').trim());
  const devices = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const t = line.trim();
    if (!t || t.startsWith('*')) continue;
    const [serial, state, ...rest] = t.split(/\s+/);
    const kv = Object.fromEntries(rest.filter((x) => x.includes(':')).map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)]));
    devices.push({
      serial,
      state,
      model: kv.model || null,
      product: kv.product || null,
      device: kv.device || null,
      transport: serial.includes(':') ? 'tcp' : 'usb',
      transportId: kv.transport_id || null,
    });
  }
  return devices;
}

export async function connect(target) {
  if (!isTcpTarget(target)) throw bad('Target must be <ipv4>:<port>');
  const r = await adb(['connect', target], { timeoutMs: 20_000 });
  const msg = (r.stdout + r.stderr).trim() || r.error || '';
  return { ok: r.code === 0 && /connected to/i.test(msg) && !/failed|cannot|unable/i.test(msg), message: msg };
}

export async function disconnect(target) {
  if (!isTcpTarget(target)) throw bad('Target must be <ipv4>:<port>');
  const r = await adb(['disconnect', target], { timeoutMs: 15_000 });
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() || r.error || '' };
}

/** mode: 'reconnect' (disconnect+connect serial) | 'restart-server' (kill-server, start-server). */
export async function restartHelper(mode, serial) {
  if (mode === 'restart-server') {
    await adb(['kill-server'], { timeoutMs: 15_000 });
    const r = await adb(['start-server'], { timeoutMs: 30_000 });
    return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() || 'adb server restarted' };
  }
  if (mode === 'reconnect') {
    if (!isTcpTarget(serial)) throw bad('Reconnect needs a <ipv4>:<port> target');
    await adb(['disconnect', serial], { timeoutMs: 10_000 });
    return connect(serial);
  }
  throw bad('mode must be reconnect or restart-server');
}

export async function deviceAction(action, serial, pkg) {
  const map = { launch: argsLaunch, stop: argsStop, clear: argsClear };
  if (!map[action]) throw bad('Unknown action');
  const r = await adb(map[action](serial, pkg), { timeoutMs: 30_000 });
  const message = (r.stdout + r.stderr).trim() || r.error || '';
  const failed = r.code !== 0 || /Error|Exception|No activities found|Failure/i.test(message);
  return { ok: !failed, message };
}

export async function installApk(serial, apkPath) {
  const r = await adb(argsInstall(serial, apkPath), { timeoutMs: 240_000 });
  const message = (r.stdout + r.stderr).trim() || r.error || '';
  return { ok: r.code === 0 && /Success/.test(message), message };
}

export async function screenshot(serial) {
  const r = await adb(['-s', need(serial), 'exec-out', 'screencap', '-p'], {
    timeoutMs: 25_000, binary: true, maxBytes: 32 * 1024 * 1024,
  });
  const png = r.stdout;
  const isPng = Buffer.isBuffer(png) && png.length > 8 && png.subarray(1, 4).toString() === 'PNG';
  if (r.code !== 0 || !isPng) throw new Error((r.stderr || r.error || 'screencap did not return a PNG').trim());
  return png;
}

export async function clearLogcat(serial) {
  const r = await adb(['-s', need(serial), 'logcat', '-c'], { timeoutMs: 15_000 });
  return { ok: r.code === 0, message: (r.stderr || r.error || '').trim() };
}

const TL = /^\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+\s+([VDIWEFA])\s+(.*?)\s*:\s/;

/**
 * Start a filtered `adb logcat` stream. Filtering happens server-side in JS on parsed lines;
 * tag/keyword text is never passed to adb. Returns { stop }.
 */
export async function startLogcat({ serial, minLevel = 'V', tag = '', q = '', packageName = '' }, onLines, onEnd) {
  need(serial);
  const args = ['-s', serial, 'logcat', '-v', 'threadtime', '-T', '200'];
  let pid = '';
  if (packageName) {
    needPkg(packageName);
    const r = await adb(['-s', serial, 'shell', 'pidof', '-s', packageName], { timeoutMs: 8_000 });
    pid = /^\d+$/.test(r.stdout.trim()) ? r.stdout.trim() : '';
    if (pid) args.push(`--pid=${pid}`);
  }
  const min = LEVEL_RANK[minLevel] ?? 0;
  const tagL = tag.toLowerCase();
  const qL = q.toLowerCase();
  const pkgL = packageName.toLowerCase();

  const child = spawn(config.adbBin, args, { env: childEnv(), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let batch = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (batch.length) onLines(batch);
    batch = [];
  };
  let lastLevel = 'I';
  const split = lineSplitter((line) => {
    if (!line) return;
    const m = TL.exec(line);
    const level = m ? (m[1] === 'A' ? 'E' : m[1]) : lastLevel; // continuation lines inherit level
    if (m) lastLevel = level;
    if ((LEVEL_RANK[level] ?? 0) < min) return;
    if (tagL && !(m ? m[2].toLowerCase().includes(tagL) : false)) return;
    if (qL && !line.toLowerCase().includes(qL)) return;
    if (packageName && !pid && !line.toLowerCase().includes(pkgL)) return;
    batch.push({ level, text: line });
    if (!timer) timer = setTimeout(flush, 80);
  });
  child.stdout.on('data', (d) => split.write(d));
  let errText = '';
  child.stderr.on('data', (d) => { errText += d.toString(); });
  child.on('error', (e) => onEnd(e.message));
  child.on('close', (code) => {
    split.end();
    flush();
    onEnd(code === 0 || code === null ? '' : (errText.trim() || `adb logcat exited with ${code}`));
  });
  return { stop: () => killGroup(child, 2000), pid };
}

/** One-shot logcat dump (for agents): last `lines` lines, filtered like the live stream. */
export async function logcatDump(serial, { lines = 300, minLevel = 'V', packageName = '', q = '' } = {}) {
  need(serial);
  const n = Math.min(Math.max(Number(lines) || 300, 10), 5000);
  const args = ['-s', serial, 'logcat', '-d', '-v', 'threadtime', '-t', String(n * 4)];
  if (packageName) {
    needPkg(packageName);
    const r = await adb(['-s', serial, 'shell', 'pidof', '-s', packageName], { timeoutMs: 8_000 });
    const pid = r.stdout.trim();
    if (/^\d+$/.test(pid)) args.push(`--pid=${pid}`);
  }
  const r = await adb(args, { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.error || 'logcat failed').trim());
  const min = LEVEL_RANK[minLevel] ?? 0;
  const qL = String(q).toLowerCase();
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = TL.exec(line);
    const level = m ? (m[1] === 'A' ? 'E' : m[1]) : null;
    if (level && (LEVEL_RANK[level] ?? 0) < min) continue;
    if (!level && min > 0) continue;
    if (qL && !line.toLowerCase().includes(qL)) continue;
    out.push(line);
  }
  return out.slice(-n).join('\n');
}
