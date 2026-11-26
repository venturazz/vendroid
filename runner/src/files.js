// File access inside a project folder. Every path is validated, resolved and re-checked with
// realpath so neither `..` nor symlinks can escape the project; `.git` internals are off limits.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, bad, isRelPath } from './validate.js';

export const MAX_READ = 2 * 1024 * 1024;
export const MAX_WRITE = 5 * 1024 * 1024;
export const MAX_BINARY = Math.max(1, Number(process.env.MAX_BINARY_MB) || 25) * 1024 * 1024;
const HIDDEN = new Set(['.git', '.gradle', '.idea', '.kotlin', '.cxx', '.externalNativeBuild', 'build', 'captures']);
const SKIP_SEARCH = new Set([...HIDDEN, 'node_modules']);

export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function within(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

/** Absolute path for `rel` inside `root`. For non-existent targets the parent must be inside. */
export function resolve(root, rel, { allowRoot = false } = {}) {
  if (!isRelPath(rel, { allowEmpty: allowRoot })) throw bad(`Invalid path: ${String(rel).slice(0, 120)}`);
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, rel === '.' ? '' : rel);
  if (!within(realRoot, abs)) throw bad('Path escapes the project');
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (!within(realRoot, real)) throw bad('Path escapes the project (symlink)');
  return abs;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** One directory level, folders first. */
export function list(root, rel = '', { showHidden = false } = {}) {
  const dir = resolve(root, rel, { allowRoot: true });
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    throw new HttpError(e.code === 'ENOENT' ? 404 : 400, `Cannot list ${rel || '/'}`);
  }
  const prefix = rel && rel !== '.' ? `${rel}/` : '';
  return ents
    .filter((e) => e.name !== '.git' && (showHidden || !HIDDEN.has(e.name)) && (e.isDirectory() || e.isFile() || e.isSymbolicLink()))
    .map((e) => {
      const p = prefix + e.name;
      let type = e.isDirectory() ? 'dir' : 'file';
      let size = null;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        type = st.isDirectory() ? 'dir' : 'file';
        size = st.isFile() ? st.size : null;
      } catch { /* dangling symlink */ }
      return { name: e.name, path: p, type, size, dimmed: HIDDEN.has(e.name) };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
}

/** All file paths (for quick-open and AI context), skipping build output. */
export function allFiles(root, limit = 5000) {
  const out = [];
  const walk = (dir, prefix) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (SKIP_SEARCH.has(e.name)) continue;
      const p = prefix + e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), `${p}/`);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(fs.realpathSync(root), '');
  return out;
}

export function read(root, rel) {
  const abs = resolve(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { throw new HttpError(404, `File not found: ${rel}`); }
  if (!st.isFile()) throw bad(`${rel} is not a file`);
  if (st.size > MAX_READ) return { path: rel, size: st.size, tooLarge: true, mtime: st.mtimeMs };
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { path: rel, size: st.size, binary: true, hash: sha1(buf), mtime: st.mtimeMs };
  return { path: rel, size: st.size, content: buf.toString('utf8'), hash: sha1(buf), mtime: st.mtimeMs };
}

/** Current hash of a text file, or null if it does not exist. */
export function currentHash(root, rel) {
  try { return sha1(fs.readFileSync(resolve(root, rel))); } catch { return null; }
}

/**
 * Write a text file atomically. `baseHash` (hash the client loaded) prevents overwriting a file that
 * changed meanwhile (other tab, AI apply, git pull): 409 with the current hash.
 */
export function write(root, rel, content, { baseHash, create = false } = {}) {
  if (typeof content !== 'string') throw bad('content must be a string');
  if (Buffer.byteLength(content) > MAX_WRITE) throw new HttpError(413, 'File too large');
  const abs = resolve(root, rel);
  const exists = fs.existsSync(abs);
  if (exists && fs.statSync(abs).isDirectory()) throw bad(`${rel} is a folder`);
  if (create && exists) throw new HttpError(409, `${rel} already exists`);
  if (exists && baseHash !== undefined && baseHash !== null) {
    const cur = sha1(fs.readFileSync(abs));
    if (cur !== baseHash) {
      const e = new HttpError(409, `${rel} changed on disk since it was opened`);
      e.body = { conflict: true, hash: cur };
      throw e;
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.vendroid-${process.pid}-${Date.now()}.tmp`;
  const mode = exists ? fs.statSync(abs).mode & 0o777 : 0o644;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, abs);
  return { path: rel, hash: sha1(Buffer.from(content)), size: Buffer.byteLength(content), created: !exists };
}

/** Raw bytes of any file (images, sounds, fonts …) up to MAX_BINARY. */
export function readBytes(root, rel) {
  const abs = resolve(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { throw new HttpError(404, `File not found: ${rel}`); }
  if (!st.isFile()) throw bad(`${rel} is not a file`);
  if (st.size > MAX_BINARY) throw new HttpError(413, `${rel} is larger than ${MAX_BINARY / 1048576} MB`);
  return fs.readFileSync(abs);
}

/** Write raw bytes atomically (same conflict check as write()). */
export function writeBytes(root, rel, buf, { baseHash, create = false } = {}) {
  if (!Buffer.isBuffer(buf)) throw bad('content must be bytes');
  if (buf.length > MAX_BINARY) throw new HttpError(413, `File larger than ${MAX_BINARY / 1048576} MB`);
  const abs = resolve(root, rel);
  const exists = fs.existsSync(abs);
  if (exists && fs.statSync(abs).isDirectory()) throw bad(`${rel} is a folder`);
  if (create && exists) throw new HttpError(409, `${rel} already exists`);
  if (exists && baseHash !== undefined && baseHash !== null && sha1(fs.readFileSync(abs)) !== baseHash) {
    const e = new HttpError(409, `${rel} changed on disk`);
    e.body = { conflict: true, hash: sha1(fs.readFileSync(abs)) };
    throw e;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.vendroid-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: exists ? fs.statSync(abs).mode & 0o777 : 0o644 });
  fs.renameSync(tmp, abs);
  return { path: rel, hash: sha1(buf), size: buf.length, created: !exists };
}

export function mkdir(root, rel) {
  const abs = resolve(root, rel);
  if (fs.existsSync(abs)) throw new HttpError(409, `${rel} already exists`);
  fs.mkdirSync(abs, { recursive: true });
  return { path: rel };
}

export function rename(root, from, to) {
  const a = resolve(root, from);
  const b = resolve(root, to);
  if (!fs.existsSync(a)) throw new HttpError(404, `${from} not found`);
  if (fs.existsSync(b)) throw new HttpError(409, `${to} already exists`);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
  return { from, to };
}

export function remove(root, rel) {
  const abs = resolve(root, rel);
  if (!fs.existsSync(abs)) throw new HttpError(404, `${rel} not found`);
  if (fs.realpathSync(abs) === fs.realpathSync(root)) throw bad('Refusing to delete the project root');
  fs.rmSync(abs, { recursive: true, force: true });
  return { path: rel };
}

/** Case-insensitive text search across source files. */
export function search(root, query, { limit = 300, maxFileSize = 1024 * 1024 } = {}) {
  if (typeof query !== 'string' || query.length < 2 || query.length > 200) throw bad('query must be 2-200 characters');
  const q = query.toLowerCase();
  const results = [];
  let truncated = false;
  const realRoot = fs.realpathSync(root);
  for (const rel of allFiles(root, 20_000)) {
    if (results.length >= limit) { truncated = true; break; }
    const abs = path.join(realRoot, rel);
    let buf;
    try {
      if (fs.statSync(abs).size > maxFileSize) continue;
      buf = fs.readFileSync(abs);
    } catch { continue; }
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length && results.length < limit; i++) {
      const col = lines[i].toLowerCase().indexOf(q);
      if (col >= 0) results.push({ path: rel, line: i + 1, col: col + 1, text: lines[i].slice(0, 300) });
    }
  }
  return { query, results, truncated };
}
