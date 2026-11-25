import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { config, aapt2Path, bootstrapState } from './config.js';
import { run } from './exec.js';

async function freeDisk(p) {
  try {
    const s = await fs.promises.statfs(p);
    return { path: p, freeGb: +((s.bavail * s.bsize) / 1e9).toFixed(2), totalGb: +((s.blocks * s.bsize) / 1e9).toFixed(2) };
  } catch (e) {
    return { path: p, error: e.message };
  }
}

function memAvailable() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch { /* non-linux */ }
  return os.freemem();
}

/** Locate the aapt2 that Gradle will actually use. */
export function resolveAapt2() {
  const override = aapt2Path();
  if (override) return { path: override, source: 'android.aapt2FromMavenOverride' };
  try {
    const bt = path.join(config.androidHome, 'build-tools');
    const vers = fs.readdirSync(bt).sort().reverse();
    for (const v of vers) {
      const p = path.join(bt, v, 'aapt2');
      if (fs.existsSync(p)) return { path: p, source: os.arch() === 'arm64' ? `SDK build-tools ${v} (x86_64 binary, no ARM64 override set)` : `SDK build-tools ${v}` };
    }
  } catch { /* no SDK */ }
  return { path: null, source: 'not found' };
}

export async function envHealth() {
  const arch = os.arch();
  const uname = await run('uname', ['-m'], { timeoutMs: 3000 });
  const java = await run(config.javaBin, ['-version'], { timeoutMs: 8000 });
  const adbV = await run(config.adbBin, ['version'], { timeoutMs: 8000 });
  const aapt = resolveAapt2();
  let aapt2 = { ...aapt, ok: false, version: null };
  if (aapt.path) {
    const v = await run(aapt.path, ['version'], { timeoutMs: 10_000 });
    aapt2.ok = v.code === 0;
    aapt2.version = (v.stdout + v.stderr).trim().split('\n')[0] || v.error || null;
  }
  const projectOk = !!config.projectPath && fs.existsSync(path.join(config.projectPath, 'gradlew'));
  const [dataDisk, projDisk] = await Promise.all([freeDisk(config.dataDir), freeDisk(projectOk ? config.projectPath : config.dataDir)]);
  const checks = {
    aarch64: arch === 'arm64' || uname.stdout.trim() === 'aarch64',
    java: java.code === 0,
    androidHome: fs.existsSync(config.androidHome),
    adb: adbV.code === 0,
    aapt2: aapt2.ok,
    project: projectOk,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    arch: { nodeArch: arch, uname: uname.stdout.trim(), isAarch64: checks.aarch64 },
    java: { ok: checks.java, version: (java.stderr || java.stdout || java.error || '').trim().split('\n')[0] },
    androidHome: { path: config.androidHome, exists: checks.androidHome },
    adb: { ok: checks.adb, version: (adbV.stdout || adbV.error || '').trim().split('\n')[0], bin: config.adbBin },
    aapt2,
    project: { path: config.projectPath, hasGradlew: projectOk, module: config.appModule },
    sdkBootstrap: bootstrapState() || 'external',
    disk: { data: dataDisk, project: projDisk },
    memory: {
      totalGb: +(os.totalmem() / 1e9).toFixed(2),
      availableGb: +(memAvailable() / 1e9).toFixed(2),
    },
    limits: { gradleJvmArgs: config.gradleJvmArgs, kotlinDaemonJvmArgs: config.kotlinDaemonJvmArgs, maxWorkers: config.gradleMaxWorkers },
    defaults: { packageName: config.defaultPackage, device: config.defaultDevice },
  };
}
