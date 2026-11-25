// Git operations for workspace projects. argv-only, hooks disabled, https/file transports only,
// token supplied through GIT_ASKPASS from the environment of the single git process.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { childEnv, run } from './exec.js';
import { HttpError, bad, isBranch, isRelPath } from './validate.js';

const ASKPASS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'git-askpass.sh');

function gitEnv() {
  return childEnv({
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: ASKPASS,
    VENDROID_GIT_TOKEN: config.gitToken,
    GIT_AUTHOR_NAME: config.gitUserName,
    GIT_AUTHOR_EMAIL: config.gitUserEmail,
    GIT_COMMITTER_NAME: config.gitUserName,
    GIT_COMMITTER_EMAIL: config.gitUserEmail,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', // status/diff never take index.lock, so they can't collide with commit/pull
  });
}

function baseArgs(dir) {
  return [
    '-c', `safe.directory=${dir || '*'}`,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.ext.allow=never',
    '-c', `protocol.file.allow=${config.allowFileRemotes ? 'always' : 'never'}`,
    '-c', 'credential.helper=',
    '-c', 'core.quotePath=false',
    ...(dir ? ['-C', dir] : []),
  ];
}

/** Remove credentials from URLs in messages. */
export const scrub = (s) => String(s || '').replace(/(https?:\/\/)[^\s/@]+@/g, '$1***@');

async function git(dir, args, { timeoutMs = 60_000, ok = [0] } = {}) {
  const r = await run('git', [...baseArgs(dir), ...args], { env: gitEnv(), timeoutMs, maxBytes: 32 * 1024 * 1024 });
  const message = scrub((r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || r.error || '');
  return { ...r, ok: ok.includes(r.code), message };
}

async function must(dir, args, opts) {
  const r = await git(dir, args, opts);
  if (!r.ok) throw new HttpError(r.code === -1 ? 500 : 409, `git ${args[0]}: ${r.message || `exit ${r.code}`}`);
  return r;
}

export const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

export async function init(dir) {
  await must(dir, ['init', '-q', '-b', 'main']);
}

export function clone(url, dir, branch) {
  return git(null, ['clone', '--progress', ...(branch ? ['--branch', branch] : []), '--', url, dir], { timeoutMs: 15 * 60_000 });
}

export async function remoteUrl(dir) {
  const r = await git(dir, ['remote', 'get-url', 'origin']);
  return r.ok ? r.stdout.trim() : null;
}

const STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'typechange' };

/** Parsed `git status --porcelain=v2 --branch`. */
export async function status(dir) {
  if (!isRepo(dir)) return { repo: false };
  const r = await must(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  const out = { repo: true, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const recs = r.stdout.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const l = recs[i];
    if (!l) continue;
    if (l.startsWith('# branch.head ')) out.branch = l.slice(14) === '(detached)' ? null : l.slice(14);
    else if (l.startsWith('# branch.upstream ')) out.upstream = l.slice(18);
    else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(l);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (l[0] === '1' || l[0] === '2') {
      const f = l.split(' ');
      const xy = f[1];
      const p = l[0] === '1' ? f.slice(8).join(' ') : f.slice(9).join(' ');
      const entry = { path: p, index: xy[0], worktree: xy[1], staged: xy[0] !== '.' };
      entry.status = STATUS[xy[1] !== '.' ? xy[1] : xy[0]] || 'modified';
      if (l[0] === '2') { entry.from = recs[++i]; entry.status = 'renamed'; }
      out.files.push(entry);
    } else if (l[0] === 'u') {
      out.files.push({ path: l.split(' ').slice(10).join(' '), index: 'U', worktree: 'U', status: 'conflict' });
    } else if (l[0] === '?') {
      out.files.push({ path: l.slice(2), index: '?', worktree: '?', status: 'untracked' });
    }
  }
  return out;
}

/** Unified diff of a file (or the whole worktree) against HEAD. Untracked files show as added. */
export async function diff(dir, rel) {
  if (rel !== undefined && !isRelPath(rel)) throw bad('Invalid path');
  const hasHead = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).ok;
  const args = hasHead ? ['diff', '--no-color', '--no-ext-diff', 'HEAD'] : ['diff', '--no-color', '--no-ext-diff', '--cached'];
  const r = await must(dir, [...args, ...(rel ? ['--', rel] : [])]);
  let text = r.stdout;
  if (rel && !text) {
    const st = await status(dir);
    if (st.files?.some((f) => f.path === rel && f.status === 'untracked')) {
      const u = await git(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', rel], { ok: [0, 1] });
      text = u.stdout;
    }
  }
  return text.length > 2_000_000 ? text.slice(0, 2_000_000) + '\n… diff truncated …\n' : text;
}

export async function commit(dir, { message, files }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) throw bad('Commit message is required');
  if (files !== undefined) {
    if (!Array.isArray(files) || !files.length || !files.every((f) => isRelPath(f))) throw bad('files must be a list of project paths');
    await must(dir, ['add', '-A', '--', ...files]);
  } else {
    await must(dir, ['add', '-A']);
  }
  const r = await git(dir, ['commit', '-q', '-m', message.trim()]);
  if (!r.ok) {
    if (/nothing to commit|no changes added/i.test(r.message)) throw new HttpError(409, 'Nothing to commit');
    throw new HttpError(409, `git commit: ${r.message}`);
  }
  return log(dir, 1).then((l) => l[0]);
}

export async function log(dir, n = 30) {
  const r = await git(dir, ['log', `-${Math.min(Math.max(1, n), 200)}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s']);
  if (!r.ok) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [hash, short, author, date, subject] = l.split('\x1f');
    return { hash, short, author, date, subject };
  });
}

export async function pull(dir) {
  const r = await must(dir, ['pull', '--ff-only'], { timeoutMs: 5 * 60_000 });
  return { ok: true, message: r.message };
}

export async function push(dir) {
  const st = await status(dir);
  if (!st.branch) throw bad('Cannot push a detached HEAD');
  const args = st.upstream ? ['push', '--porcelain'] : ['push', '--porcelain', '-u', 'origin', st.branch];
  const r = await must(dir, args, { timeoutMs: 5 * 60_000 });
  return { ok: true, message: r.message };
}

export async function branches(dir) {
  const r = await must(dir, ['branch', '--format=%(refname:short)%09%(HEAD)']);
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [name, head] = l.split('\t');
    return { name, current: head === '*' };
  });
}

export async function checkout(dir, { branch, create = false }) {
  if (!isBranch(branch)) throw bad('Invalid branch name');
  await must(dir, create ? ['switch', '-c', branch] : ['switch', branch]);
  return status(dir);
}

/** Throw away local changes of one path (restores tracked files, deletes untracked ones). */
export async function discard(dir, rel) {
  if (!isRelPath(rel)) throw bad('Invalid path');
  const st = await status(dir);
  const f = st.files?.find((x) => x.path === rel);
  if (!f) return { ok: true };
  if (f.status === 'untracked') fs.rmSync(path.join(dir, rel), { force: true });
  else await must(dir, ['restore', '--staged', '--worktree', '--source=HEAD', '--', rel]);
  return { ok: true };
}
