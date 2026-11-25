// Process helpers. Everything uses spawn() with an argv array and shell:false.
import { spawn } from 'node:child_process';

// Secrets must never be visible to Gradle build scripts or adb.
const SECRET_ENV = [
  'AUTH_PASSWORD', 'API_TOKEN', 'SESSION_SECRET', 'NINE_ROUTER_API_KEY', 'HERMES_WEBHOOK_SECRET',
  'GIT_WEBHOOK_SECRET', 'RELEASE_KEYSTORE_PASSWORD', 'RELEASE_KEY_PASSWORD',
];
export function childEnv(extra = {}) {
  const e = { ...process.env, ...extra };
  for (const k of SECRET_ENV) delete e[k];
  return e;
}

/**
 * Run a command to completion and capture output.
 * Never rejects for non-zero exits or spawn errors; inspect {code, error}.
 */
export function run(cmd, args, { timeoutMs = 30_000, cwd, env, maxBytes = 8 * 1024 * 1024, binary = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || childEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve({ code: -1, stdout: '', stderr: '', error: error.message });
    }
    const out = [];
    const err = [];
    let size = 0;
    let done = false;
    let timedOut = false;
    let truncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const take = (bucket) => (d) => {
      size += d.length;
      if (size > maxBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      bucket.push(d);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const so = Buffer.concat(out);
      resolve({
        code,
        stdout: binary ? so : so.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: error || (timedOut ? `timed out after ${timeoutMs}ms` : truncated ? 'output too large' : undefined),
      });
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** Split a byte stream into lines (handles \r, \n, partial chunks). */
export function lineSplitter(onLine, maxLen = 4000) {
  let buf = '';
  const emit = (l) => onLine(l.length > maxLen ? l.slice(0, maxLen) + '…' : l);
  return {
    write(chunk) {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      if (buf.length > 64 * 1024) {
        emit(buf);
        buf = '';
      }
      for (const l of parts) emit(l);
    },
    end() {
      if (buf) emit(buf);
      buf = '';
    },
  };
}

/** Kill a whole process group (child must be spawned with detached:true). */
export function killGroup(child, graceMs = 8000) {
  if (!child || !child.pid) return;
  const sig = (s) => {
    try {
      process.kill(-child.pid, s);
    } catch {
      try { child.kill(s); } catch { /* already gone */ }
    }
  };
  sig('SIGTERM');
  const t = setTimeout(() => sig('SIGKILL'), graceMs);
  t.unref();
  child.once('close', () => clearTimeout(t));
}
