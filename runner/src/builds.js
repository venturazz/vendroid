// Serialized build pipeline: queued -> pulling -> building -> installing -> launching -> terminal.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, aapt2Path, bootstrapState } from './config.js';
import { ensureGradleProperties } from './gradleProps.js';
import { apkProblem, zipEntries } from './apkcheck.js';
import { signingFor } from './signing.js';
import { inspectProject } from './projects.js';
import { childEnv, lineSplitter, killGroup, run } from './exec.js';
import * as adbm from './adb.js';
import { notifyHermes, sliceBuildError } from './ai.js';
import { HttpError, TASKS, bad, isBuildId, isPackage, isSerial, isTask } from './validate.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ASKPASS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'git-askpass.sh');
const KEEP_BUFFERS = 5;

class Cancelled extends Error {}

/** An .aab must contain the base module manifest and resource table (protobuf format). */
function aabProblem(file) {
  let names;
  try { names = new Set(zipEntries(file)); } catch (e) { return `AAB is not a valid ZIP (${e.message})`; }
  const missing = ['base/manifest/AndroidManifest.xml', 'base/resources.pb'].filter((n) => !names.has(n));
  return missing.length ? `App bundle is missing ${missing.join(' and ')}` : null;
}


export class BuildManager {
  /** @param {import('./projects.js').ProjectStore} projects */
  constructor(projects) {
    this.projects = projects;
    this.builds = new Map(); // id -> record
    this.queue = []; // ids
    this.current = null; // { id, ctx }
    this.bufs = new Map(); // id -> { ring, n, subs:Set, out }
    this.running = false;
  }

  init() {
    fs.mkdirSync(config.buildsDir, { recursive: true });
    fs.mkdirSync(config.artifactsDir, { recursive: true });
    for (const f of fs.readdirSync(config.buildsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const b = JSON.parse(fs.readFileSync(path.join(config.buildsDir, f), 'utf8'));
        if (!isBuildId(b.id)) continue;
        if (!b.projectId) b.projectId = this.projects?.legacyId() || null; // v1 single-project builds
        if (!TERMINAL.has(b.state)) {
          b.state = 'failed';
          b.error = 'Interrupted by runner restart';
          b.finishedAt = new Date().toISOString();
          fs.writeFileSync(path.join(config.buildsDir, f), JSON.stringify(b, null, 2));
        }
        this.builds.set(b.id, b);
      } catch { /* skip corrupt record */ }
    }
  }

  view(b) {
    const { apkFile, ...rest } = b;
    return { ...rest, apk: apkFile ? { name: path.basename(apkFile), size: b.apkSize, type: b.artifactType || 'apk' } : null };
  }
  list(projectId) {
    return [...this.builds.values()]
      .filter((b) => !projectId || b.projectId === projectId)
      .sort((a, c) => c.createdAt.localeCompare(a.createdAt)).map((b) => this.view(b));
  }
  /** Id of the running build and the queue, for the "busy" indicator across projects. */
  queueView() {
    return { active: this.current?.id || null, activeProject: this.current ? this.builds.get(this.current.id)?.projectId : null, queued: [...this.queue] };
  }
  get(id) {
    if (!isBuildId(id)) throw bad('Invalid build id');
    const b = this.builds.get(id);
    if (!b) throw new HttpError(404, 'Build not found');
    return b;
  }
  activeId() { return this.current?.id || null; }

  /** Most recent succeeded build that produced an APK (optionally for a variant). */
  latestApk(projectId) {
    return [...this.builds.values()]
      .filter((b) => b.state === 'succeeded' && b.apkFile && b.artifactType !== 'aab' && (!projectId || b.projectId === projectId))
      .sort((a, c) => c.createdAt.localeCompare(a.createdAt))[0] || null;
  }
  apkPath(b) {
    if (!b.apkFile) return null;
    const p = path.resolve(config.artifactsDir, b.apkFile);
    return p.startsWith(config.artifactsDir + path.sep) && fs.existsSync(p) ? p : null;
  }

  /** True if a build triggered by `trigger` is still waiting in the queue (push coalescing). */
  hasQueued(trigger, projectId) {
    return this.queue.some((id) => this.builds.get(id)?.trigger === trigger && this.builds.get(id)?.projectId === projectId);
  }

  enqueue(projectId, body, { trigger = 'manual', ref = null } = {}) {
    const project = this.projects.get(projectId);
    if (!isTask(body.task)) throw bad(`task must be one of: ${Object.keys(TASKS).join(', ')}`);
    const flag = (k) => {
      if (body[k] === undefined) return false;
      if (typeof body[k] !== 'boolean') throw bad(`${k} must be a boolean`);
      return body[k];
    };
    const options = {
      gitPullBeforeBuild: flag('gitPullBeforeBuild'),
      autoInstallAfterBuild: flag('autoInstallAfterBuild'),
      autoLaunchAfterInstall: flag('autoLaunchAfterInstall'),
      autoNotifyHermes: flag('autoNotifyHermes'),
    };
    const deviceSerial = body.deviceSerial || config.defaultDevice || '';
    const packageName = body.packageName || project.packageName || '';
    if (deviceSerial && !isSerial(deviceSerial)) throw bad('Invalid deviceSerial');
    if (packageName && !isPackage(packageName)) throw bad('Invalid packageName');
    if ((options.autoInstallAfterBuild || options.autoLaunchAfterInstall) && !deviceSerial) {
      throw bad('A device serial/address is required for auto-install / auto-launch');
    }
    if (options.autoLaunchAfterInstall && !packageName) throw bad('A package name is required for auto-launch');
    if (TASKS[body.task].artifact === 'aab' && options.autoInstallAfterBuild) {
      throw bad('App bundles (.aab) are uploaded to Google Play, not installed with adb; build assembleRelease to test on the phone');
    }
    if (TASKS[body.task].variant === 'release' && !signingFor(project.id) && options.autoInstallAfterBuild) {
      throw bad('Release builds are unsigned until the project has an upload key (Publish → Upload key) or RELEASE_KEYSTORE_* is set; '
        + 'turn off Auto-Install or configure signing');
    }

    const id = `b${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const b = {
      id, projectId: project.id, projectName: project.name, task: body.task, options, deviceSerial, packageName, trigger, ref, commit: null,
      signed: TASKS[body.task].variant === 'release' ? !!signingFor(project.id) : null,
      artifactType: TASKS[body.task].artifact || 'apk',
      state: 'queued', createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, exitCode: null, error: null,
      apkFile: null, apkSize: null, hermes: null, lineCount: 0,
    };
    this.builds.set(id, b);
    this.#buf(id);
    this.queue.push(id);
    this.#save(b);
    this.#line(b, `Queued (${this.queue.length} in queue)`);
    this.#emitState(b);
    setImmediate(() => this.#pump());
    return this.view(b);
  }

  cancel(id) {
    const b = this.get(id);
    if (TERMINAL.has(b.state)) throw bad(`Build already ${b.state}`);
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.#finish(b, 'cancelled', 'Cancelled while queued');
      return this.view(b);
    }
    if (this.current?.id === id) {
      this.current.ctx.cancelled = true;
      this.#line(b, '--- cancel requested, terminating process group ---');
      killGroup(this.current.ctx.proc);
    }
    return this.view(b);
  }

  // ---- log buffer / SSE ---------------------------------------------------
  #buf(id) {
    let s = this.bufs.get(id);
    if (!s) {
      s = { ring: [], n: 0, subs: new Set(), out: fs.createWriteStream(path.join(config.buildsDir, `${id}.log`), { flags: 'a' }) };
      this.bufs.set(id, s);
      while (this.bufs.size > KEEP_BUFFERS + 1) {
        const old = [...this.bufs.keys()].find((k) => k !== id && TERMINAL.has(this.builds.get(k)?.state));
        if (!old) break;
        this.bufs.get(old).out.end();
        this.bufs.delete(old);
      }
    }
    return s;
  }
  #line(b, text) {
    const s = this.#buf(b.id);
    const entry = { n: ++s.n, text };
    s.ring.push(entry);
    if (s.ring.length > config.logRingLines) s.ring.shift();
    s.out.write(text + '\n');
    b.lineCount = s.n;
    for (const sub of s.subs) sub.onLine(entry);
  }
  #emitState(b) {
    const s = this.bufs.get(b.id);
    if (s) for (const sub of s.subs) sub.onState(this.view(b));
  }

  /** Replay lines newer than `afterN`, then follow live. Returns an unsubscribe function. */
  subscribe(id, afterN, { onLine, onState }) {
    const b = this.get(id);
    let replay;
    const live = this.bufs.get(id);
    if (live) {
      replay = live.ring;
    } else {
      let text = '';
      try { text = fs.readFileSync(path.join(config.buildsDir, `${id}.log`), 'utf8'); } catch { /* none */ }
      const all = text.split('\n');
      if (all[all.length - 1] === '') all.pop();
      const base = all.length - Math.min(all.length, config.logRingLines);
      replay = all.slice(base).map((t, i) => ({ n: base + i + 1, text: t }));
    }
    onState(this.view(b));
    for (const e of replay) if (e.n > afterN) onLine(e);
    if (TERMINAL.has(b.state) || !live) return () => {};
    const sub = { onLine, onState };
    live.subs.add(sub);
    return () => live.subs.delete(sub);
  }

  /** Last N log lines as plain text (for AI analysis). */
  tail(id, n = 400) {
    this.get(id);
    const live = this.bufs.get(id);
    if (live) return live.ring.slice(-n).map((e) => e.text).join('\n');
    try {
      return fs.readFileSync(path.join(config.buildsDir, `${id}.log`), 'utf8').split('\n').slice(-n).join('\n');
    } catch { return ''; }
  }

  // ---- worker -------------------------------------------------------------
  async #pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const b = this.builds.get(this.queue.shift());
        if (b && b.state === 'queued') await this.#run(b);
      }
    } finally {
      this.running = false;
    }
  }

  #setState(b, state) {
    b.state = state;
    this.#line(b, `=== ${state} ===`);
    this.#save(b);
    this.#emitState(b);
  }

  async #run(b) {
    const ctx = { cancelled: false, proc: null };
    this.current = { id: b.id, ctx };
    b.startedAt = new Date().toISOString();
    const check = () => { if (ctx.cancelled) throw new Cancelled(); };
    const env = childEnv({
      ANDROID_HOME: config.androidHome,
      ANDROID_SDK_ROOT: config.androidHome,
      GRADLE_USER_HOME: config.gradleUserHome,
    });
    let project;
    try {
      project = this.projects.get(b.projectId);
    } catch {
      this.current = null;
      return this.#finish(b, 'failed', `Project ${b.projectId} no longer exists`);
    }
    const root = project.path;
    try {
      await this.#waitForSdk(b, ctx);
      check();
      ensureGradleProperties(); // picks up the aapt2 path recorded by the SDK bootstrap
      if (!fs.existsSync(path.join(root, 'gradlew'))) {
        throw new Error(`gradlew not found in ${root}`);
      }
      if (b.options.gitPullBeforeBuild) {
        this.#setState(b, 'pulling');
        const code = await this.#exec(b, ctx, 'git', [
          '-c', `safe.directory=${root}`, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never',
          '-c', 'credential.helper=', '-C', root, 'pull', '--ff-only',
        ], { env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: ASKPASS, VENDROID_GIT_TOKEN: config.gitToken }, timeoutMs: 5 * 60_000 });
        check();
        if (code !== 0) throw new Error(`git pull exited with ${code}`);
      }

      b.commit = await this.#commitInfo(root, env);
      if (b.commit) this.#line(b, `Commit: ${b.commit.sha} ${b.commit.subject}`);

      this.#setState(b, 'building');
      const info = inspectProject(root);
      b.versionCode = info.versionCode;
      b.versionName = info.versionName;
      b.targetSdk = info.targetSdk;
      const sign = TASKS[b.task].variant === 'release' ? signingFor(b.projectId) : null;
      b.signed = TASKS[b.task].variant === 'release' ? !!sign : null;
      if (TASKS[b.task].variant === 'release') {
        this.#line(b, sign
          ? `Release signing: ${sign.source === 'project' ? 'project upload key' : `keystore ${path.basename(sign.storeFile)}`}, alias ${sign.keyAlias}`
          : 'Release signing: not configured (Publish → Upload key); the artifact will be unsigned');
      }
      try { fs.chmodSync(path.join(root, 'gradlew'), 0o755); } catch { /* best effort */ }
      const gradleArgs = [
        ...TASKS[b.task].args,
        '--console=plain', '--no-daemon', '--stacktrace',
        `--max-workers=${config.gradleMaxWorkers}`,
        `-Dorg.gradle.jvmargs=${config.gradleJvmArgs}`,
        `-Pkotlin.daemon.jvmargs=${config.kotlinDaemonJvmArgs}`,
      ];
      const aapt2 = aapt2Path();
      if (aapt2) gradleArgs.push(`-Pandroid.aapt2FromMavenOverride=${aapt2}`);
      if (sign) ensureGradleProperties({ signing: sign });
      let code;
      try {
        code = await this.#exec(b, ctx, path.join(root, 'gradlew'), gradleArgs, {
          cwd: root, env, timeoutMs: config.buildTimeoutMs,
        });
      } finally {
        if (sign) ensureGradleProperties(); // drop the signing secrets again
      }
      check();
      b.exitCode = code;
      if (code !== 0) throw new Error(`Gradle exited with code ${code}`);

      const apk = this.#collectApk(b, root, project.module);
      if (!apk) throw new Error(`Build succeeded but no ${b.artifactType === "aab" ? ".aab under build/outputs/bundle" : "APK under build/outputs/apk"} was found`);
      const problem = b.artifactType === 'aab' ? aabProblem(path.join(config.artifactsDir, apk.file)) : apkProblem(path.join(config.artifactsDir, apk.file));
      if (problem) throw new Error(problem);
      this.#line(b, `${b.artifactType === 'aab' ? 'AAB' : 'APK'}: ${path.basename(apk.file)} (${(apk.size / 1e6).toFixed(1)} MB)`);

      if (b.options.autoInstallAfterBuild) {
        this.#setState(b, 'installing');
        await this.#ensureConnected(b, ctx, env);
        check();
        const c = await this.#exec(b, ctx, config.adbBin, adbm.argsInstall(b.deviceSerial, path.join(config.artifactsDir, apk.file)), { env, timeoutMs: 240_000 });
        check();
        if (c !== 0) throw new Error(`adb install exited with ${c}`);
      }
      if (b.options.autoLaunchAfterInstall) {
        this.#setState(b, 'launching');
        if (!b.options.autoInstallAfterBuild) await this.#ensureConnected(b, ctx, env);
        const c = await this.#exec(b, ctx, config.adbBin, adbm.argsLaunch(b.deviceSerial, b.packageName), { env, timeoutMs: 30_000 });
        check();
        if (c !== 0) throw new Error(`adb launch exited with ${c}`);
      }
      this.#finish(b, 'succeeded');
    } catch (e) {
      if (e instanceof Cancelled || ctx.cancelled) this.#finish(b, 'cancelled', 'Cancelled by user');
      else this.#finish(b, 'failed', e.message);
      if (b.state === 'failed' && b.options.autoNotifyHermes) await this.#notify(b);
    } finally {
      this.current = null;
    }
  }

  /** First Docker boot installs the SDK in the background; hold the build instead of failing it. */
  async #waitForSdk(b, ctx) {
    if (bootstrapState() !== 'running') return;
    this.#line(b, 'Waiting for the Android SDK install to finish (first start only)…');
    const until = Date.now() + 30 * 60_000;
    while (bootstrapState() === 'running' && !ctx.cancelled && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (bootstrapState() === 'failed') {
      throw new Error('Android SDK install failed; see /data/bootstrap.log or the Environment dialog');
    }
  }

  async #commitInfo(root, env) {
    const r = await run('git', ['-c', `safe.directory=${root}`, '-C', root, 'log', '-1', '--format=%h%x09%an%x09%s'], { env, timeoutMs: 10_000 });
    if (r.code !== 0) return null;
    const [sha, author, subject] = r.stdout.trim().split('\t');
    return sha ? { sha, author, subject: (subject || '').slice(0, 200) } : null;
  }

  async #ensureConnected(b, ctx, env) {
    if (b.deviceSerial.includes(':')) {
      await this.#exec(b, ctx, config.adbBin, ['connect', b.deviceSerial], { env, timeoutMs: 20_000 });
    }
  }

  async #notify(b) {
    this.#line(b, '--- notifying Hermes Agent ---');
    b.hermes = await notifyHermes({
      event: 'build_failed', jobId: b.id, packageName: b.packageName, deviceSerial: b.deviceSerial,
      errorTail: sliceBuildError(this.tail(b.id, 400)),
      projectId: b.projectId, projectName: b.projectName,
    });
    this.#line(b, `Hermes: ${b.hermes.ok ? 'accepted' : 'failed'} (HTTP ${b.hermes.status}) ${b.hermes.response}`.slice(0, 300));
    this.#save(b);
    this.#emitState(b);
  }

  #collectApk(b, projectRoot, module) {
    const variant = TASKS[b.task].variant;
    const ext = b.artifactType === 'aab' ? '.aab' : '.apk';
    const root = path.join(projectRoot, ...module.split(':'), 'build', 'outputs', ext === '.aab' ? 'bundle' : 'apk');
    const found = [];
    const walk = (dir, depth) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(ext) && !/androidTest/i.test(p)
          && path.relative(root, p).split(path.sep).some((s) => s.toLowerCase().endsWith(variant))) {
          found.push({ p, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size });
        }
      }
    };
    walk(root, 0);
    found.sort((a, c) => c.mtime - a.mtime);
    if (!found[0]) return null;
    const dir = path.join(config.artifactsDir, b.id);
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(found[0].p);
    fs.copyFileSync(found[0].p, path.join(dir, name));
    b.apkFile = path.join(b.id, name);
    b.apkSize = found[0].size;
    return { file: b.apkFile, size: found[0].size };
  }

  #exec(b, ctx, cmd, args, { cwd, env, timeoutMs }) {
    return new Promise((resolve) => {
      this.#line(b, `$ ${path.basename(cmd)} ${args.join(' ')}`);
      let child;
      try {
        child = spawn(cmd, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        this.#line(b, `spawn failed: ${e.message}`);
        return resolve(-1);
      }
      ctx.proc = child;
      const so = lineSplitter((l) => this.#line(b, l));
      const se = lineSplitter((l) => this.#line(b, l));
      child.stdout.on('data', (d) => so.write(d));
      child.stderr.on('data', (d) => se.write(d));
      const timer = setTimeout(() => {
        this.#line(b, `--- timeout after ${Math.round(timeoutMs / 60000)} min, terminating ---`);
        killGroup(child);
      }, timeoutMs);
      child.on('error', (e) => { this.#line(b, `process error: ${e.message}`); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        so.end(); se.end();
        ctx.proc = null;
        // Gradle may leave helper processes in the group; make sure none survive.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
        resolve(code ?? (signal ? 128 : -1));
      });
    });
  }

  #finish(b, state, error = null) {
    b.state = state;
    b.error = error;
    b.finishedAt = new Date().toISOString();
    this.#line(b, `=== ${state}${error ? `: ${error}` : ''} ===`);
    this.#save(b);
    this.#emitState(b);
    this.#prune();
  }

  #save(b) {
    try {
      fs.writeFileSync(path.join(config.buildsDir, `${b.id}.json`), JSON.stringify(b, null, 2));
    } catch (e) {
      console.error('failed to persist build', b.id, e.message);
    }
  }

  #prune() {
    const done = [...this.builds.values()].filter((b) => TERMINAL.has(b.state)).sort((a, c) => c.createdAt.localeCompare(a.createdAt));
    const seen = new Map();
    const drop = done.filter((b) => {
      const n = (seen.get(b.projectId) || 0) + 1;
      seen.set(b.projectId, n);
      return n > config.maxBuildHistory;
    });
    for (const b of drop) {
      this.builds.delete(b.id);
      const s = this.bufs.get(b.id);
      if (s) { s.out.end(); this.bufs.delete(b.id); }
      fs.rmSync(path.join(config.buildsDir, `${b.id}.json`), { force: true });
      fs.rmSync(path.join(config.buildsDir, `${b.id}.log`), { force: true });
      fs.rmSync(path.join(config.artifactsDir, b.id), { recursive: true, force: true });
    }
  }
}
