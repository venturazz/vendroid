// AI coding assistant: chat with 9Router about a project, parse the file edits it proposes
// (SEARCH/REPLACE blocks), show them as diffs, and apply them with one click (with undo).
// The model can only propose file contents; it never runs commands.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as files from './files.js';
import { unifiedDiff, diffStats } from './diff.js';
import { sliceBuildError } from './ai.js';
import { HttpError, bad, isRelPath } from './validate.js';

const PROPOSAL_TTL_MS = 6 * 3600_000;
const proposals = new Map(); // id -> { projectId, files, createdAt }

const SYSTEM = `You are the coding assistant inside Vendroid, a browser IDE for Android apps (Kotlin, Jetpack Compose,
XML Views, Gradle Kotlin DSL). You work like a senior Android engineer: correct, idiomatic, minimal changes.

When you change code, reply with a short explanation, then one or more edit blocks in EXACTLY this format:

path/relative/to/project/File.kt
<<<<<<< SEARCH
exact lines currently in the file
=======
replacement lines
>>>>>>> REPLACE

Rules:
- The path line comes directly before <<<<<<< SEARCH, relative to the project root, no quotes or backticks.
- SEARCH must copy the existing text exactly (including indentation) and be unique in the file. Keep blocks small:
  a few lines around the change. Use several blocks for several places.
- To create a new file, or to replace a whole file, leave the SEARCH section empty.
- Only edit files whose content you were shown, unless you create a new one. Keep package names consistent
  with the project. Update AndroidManifest.xml, resources and Gradle dependencies when a change needs them.
- Prefer Material 3 and Compose for Compose projects; ViewBinding and Material Components for Views projects.
- Never edit gradle-wrapper.jar, keystores, local.properties or anything under build/ or .git/.
- Do not tell the user to run shell commands; Vendroid builds and installs the app itself.
If no code change is needed, answer normally without edit blocks.`;

// ------------------------------------------------------------------ context
function projectSummary(p) {
  return [
    `Project: ${p.name} (folder ${p.id})`,
    `Application module: ${p.module}`,
    p.packageName ? `Package / applicationId: ${p.packageName}` : null,
    `UI toolkit: ${p.ui === 'compose' ? 'Jetpack Compose' : p.ui === 'webview' ? 'WebView app: the UI is HTML/CSS/JS in app/src/main/assets/www/ (index.html is the entry), Kotlin only hosts the WebView' : 'Android Views (XML layouts)'}`,
    p.minSdk ? `minSdk ${p.minSdk}, targetSdk ${p.targetSdk || '?'}` : null,
  ].filter(Boolean).join('\n');
}

const CONTEXT_ALWAYS = (p) => [
  `${p.module.replace(/:/g, '/')}/build.gradle.kts`, `${p.module.replace(/:/g, '/')}/build.gradle`,
  `${p.module.replace(/:/g, '/')}/src/main/AndroidManifest.xml`,
];

/** Build the context message: file tree + chosen file contents (bounded by AI_CODE_CONTEXT_CHARS). */
export function buildContext(p, { activeFile, contextFiles = [], selection, buildLog }) {
  const tree = files.allFiles(p.path, 1500).filter((f) => !/\.(png|jpe?g|webp|gif|jar|keystore|jks|so|apk|aar)$/i.test(f));
  const wanted = [...new Set([activeFile, ...contextFiles, ...CONTEXT_ALWAYS(p)].filter(Boolean))];
  let budget = config.aiCodeContextChars;
  const parts = [`## Project\n${projectSummary(p)}`, `## Files (${tree.length})\n${tree.slice(0, 1500).join('\n')}`];
  budget -= parts.join('\n').length;
  const included = [];
  for (const rel of wanted) {
    if (!isRelPath(rel)) continue;
    let f;
    try { f = files.read(p.path, rel); } catch { continue; }
    if (f.content === undefined) continue;
    const block = `### ${rel}${rel === activeFile ? ' (open in editor)' : ''}\n\`\`\`\n${f.content}\n\`\`\``;
    if (block.length > budget) {
      parts.push(`### ${rel}\n(omitted: too large for the context budget)`);
      continue;
    }
    budget -= block.length;
    parts.push(block);
    included.push(rel);
  }
  if (selection && typeof selection === 'string' && selection.length < 20_000) {
    parts.push(`## Selected text in ${activeFile || 'editor'}\n\`\`\`\n${selection}\n\`\`\``);
  }
  if (buildLog) parts.push(`## Latest build failure\n\`\`\`\n${sliceBuildError(buildLog)}\n\`\`\``);
  return { text: parts.join('\n\n'), included };
}

// ------------------------------------------------------------------ history
export const historyPath = (projectId) => historyFile(projectId);
const historyFile = (projectId) => path.join(config.projectsDir, projectId, 'chat.json');

export function loadHistory(projectId) {
  try { return JSON.parse(fs.readFileSync(historyFile(projectId), 'utf8')); } catch { return []; }
}
export function saveHistory(projectId, h) {
  fs.mkdirSync(path.dirname(historyFile(projectId)), { recursive: true });
  fs.writeFileSync(historyFile(projectId), JSON.stringify(h.slice(-40), null, 2));
}
export function clearHistory(projectId) {
  fs.rmSync(historyFile(projectId), { force: true });
}

// ------------------------------------------------------------------ 9Router call (streaming)
async function* streamCompletion(messages, signal, prov, meta = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(prov.apiKey ? { Authorization: `Bearer ${prov.apiKey}` } : {}) };
  let res;
  try {
    res = await fetch(`${prov.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ model: prov.model || 'auto', temperature: 0.2, max_tokens: config.aiCodeMaxTokens, stream: true, ...(meta.noUsage ? {} : { stream_options: { include_usage: true } }), messages }),
    });
  } catch (e) {
    throw new HttpError(502, `${prov.name} unreachable: ${e.message}`);
  }
  if (res.status === 400 && !meta.noUsage) { // a server that rejects stream_options: retry plainly
    await res.text().catch(() => '');
    yield* streamCompletion(messages, signal, prov, Object.assign(meta, { noUsage: true }));
    return;
  }
  if (!res.ok) throw new HttpError(502, `${prov.name} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    // Some routers ignore stream:true for some models.
    const j = await res.json().catch(() => ({}));
    if (j.usage) meta.usage = j.usage;
    const t = j.choices?.[0]?.message?.content;
    if (!t) throw new HttpError(502, `${prov.name} returned an empty completion`);
    yield t;
    return;
  }
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        if (j.usage) meta.usage = j.usage;
        const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
        if (d) yield d;
      } catch { /* keep-alive or partial */ }
    }
  }
}

/**
 * One chat turn. Streams text through onDelta; resolves with { message, proposal }.
 * opts: { message, activeFile, contextFiles, selection, buildLog }
 */
export async function chat(p, opts, onDelta, signal, prov) {
  if (typeof opts.message !== 'string' || !opts.message.trim() || opts.message.length > 20_000) throw bad('message is required (max 20000 chars)');
  const ctx = buildContext(p, opts);
  const history = loadHistory(p.id);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Current project state (always up to date, prefer it over earlier messages):\n\n${ctx.text}` },
    { role: 'assistant', content: 'Understood. I have the project context.' },
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.message },
  ];
  let text = '';
  const meta = {};
  for await (const d of streamCompletion(messages, signal, prov, meta)) {
    text += d;
    onDelta?.(d);
  }
  const proposal = propose(p, parseEdits(text));
  const now = new Date().toISOString();
  history.push({ role: 'user', content: opts.message, at: now, context: ctx.included });
  history.push({ role: 'assistant', content: text, at: now, proposalId: proposal?.id || null, engine: prov.name, model: prov.model || null });
  saveHistory(p.id, history);
  // Context use = prompt tokens of this call (the whole conversation we sent). Estimate ~4 chars/token
  // when the provider does not report usage.
  const usage = meta.usage
    ? { contextTokens: meta.usage.prompt_tokens || 0, outputTokens: meta.usage.completion_tokens || 0, estimated: false }
    : { contextTokens: Math.round(messages.reduce((n, m) => n + m.content.length, 0) / 4), outputTokens: Math.round(text.length / 4), estimated: true };
  return { message: text, context: ctx.included, proposal, usage };
}

// ------------------------------------------------------------------ edits
const cleanPath = (l) => l.trim().replace(/^(?:#+\s*|\*\*|File:\s*|Path:\s*)/i, '').replace(/[`*"':]+$/g, '').replace(/^[`*"']+/, '').trim();

/** Parse SEARCH/REPLACE blocks: [{path, search, replace}]. */
export function parseEdits(text) {
  const lines = String(text).split('\n');
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^<{5,9} ?SEARCH\s*$/.test(lines[i].trim())) continue;
    let j = i - 1;
    while (j >= 0 && (!lines[j].trim() || /^```/.test(lines[j].trim()))) j--;
    const p = j >= 0 ? cleanPath(lines[j]) : '';
    const search = [];
    const replace = [];
    let k = i + 1;
    for (; k < lines.length && !/^={5,9}\s*$/.test(lines[k].trim()); k++) search.push(lines[k]);
    for (k++; k < lines.length && !/^>{5,9} ?REPLACE\s*$/.test(lines[k].trim()); k++) replace.push(lines[k]);
    if (k >= lines.length) break; // unterminated block (truncated answer)
    edits.push({ path: p, search: search.join('\n'), replace: replace.join('\n') });
    i = k;
  }
  return edits;
}

/** Find `search` in `content`: exact first, then ignoring trailing whitespace / indentation shifts. */
function locate(content, search) {
  const idx = content.indexOf(search);
  if (idx >= 0) return content.indexOf(search, idx + 1) >= 0 ? { ambiguous: true } : { start: idx, end: idx + search.length };
  const cl = content.split('\n');
  const sl = search.split('\n');
  const norm = (s) => s.trim();
  const hits = [];
  for (let i = 0; i + sl.length <= cl.length; i++) {
    if (sl.every((s, k) => norm(s) === norm(cl[i + k]))) hits.push(i);
  }
  if (hits.length !== 1) return hits.length ? { ambiguous: true } : null;
  const start = cl.slice(0, hits[0]).join('\n').length + (hits[0] ? 1 : 0);
  const end = start + cl.slice(hits[0], hits[0] + sl.length).join('\n').length;
  // Re-indent the replacement by the indentation difference of the first line.
  const indentOf = (s) => /^\s*/.exec(s)[0];
  return { start, end, reindent: [indentOf(sl[0]), indentOf(cl[hits[0]])] };
}

export const FORBIDDEN = /(^|\/)(\.git|build|\.gradle)(\/|$)|gradle-wrapper\.jar$|\.(jks|keystore)$|(^|\/)local\.properties$/;

/** Compute the resulting files for a set of edits, without writing anything. */
export function computeEdits(root, edits) {
  const byFile = new Map();
  const errors = [];
  for (const e of edits) {
    if (!isRelPath(e.path) || FORBIDDEN.test(e.path)) { errors.push({ path: e.path, error: 'path not allowed' }); continue; }
    if (!byFile.has(e.path)) {
      let before = null;
      try {
        const f = files.read(root, e.path);
        if (f.content === undefined) { errors.push({ path: e.path, error: 'binary or too large' }); continue; }
        before = f.content;
      } catch (err) {
        if (err.status !== 404) { errors.push({ path: e.path, error: err.message }); continue; }
      }
      byFile.set(e.path, { path: e.path, before, after: before, blocks: 0, failed: 0 });
    }
    const f = byFile.get(e.path);
    if (!e.search.trim()) {
      f.after = e.replace.endsWith('\n') || !e.replace ? e.replace : `${e.replace}\n`;
      f.blocks++;
      continue;
    }
    if (f.after === null) { f.failed++; errors.push({ path: e.path, error: 'file does not exist (SEARCH must be empty to create it)' }); continue; }
    const loc = locate(f.after, e.search);
    if (!loc || loc.ambiguous) {
      f.failed++;
      errors.push({ path: e.path, error: loc ? 'SEARCH text matches more than once' : 'SEARCH text not found', search: e.search.slice(0, 400) });
      continue;
    }
    let rep = e.replace;
    if (loc.reindent && loc.reindent[0] !== loc.reindent[1]) {
      const [from, to] = loc.reindent;
      rep = rep.split('\n').map((l) => (l.startsWith(from) ? to + l.slice(from.length) : l)).join('\n');
    }
    f.after = f.after.slice(0, loc.start) + rep + f.after.slice(loc.end);
    f.blocks++;
  }
  const out = [...byFile.values()].filter((f) => f.blocks && f.after !== f.before).map((f) => ({
    path: f.path,
    action: f.before === null ? 'create' : 'modify',
    before: f.before,
    after: f.after,
    beforeHash: f.before === null ? null : files.sha1(Buffer.from(f.before)),
    diff: unifiedDiff(f.before, f.after, f.path),
    ...diffStats(f.before, f.after),
    failedBlocks: f.failed,
  }));
  return { files: out, errors };
}

function propose(p, edits) {
  if (!edits.length) return null;
  const { files: changed, errors } = computeEdits(p.path, edits);
  for (const [id, pr] of proposals) if (Date.now() - pr.createdAt > PROPOSAL_TTL_MS) proposals.delete(id);
  const id = `p${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  proposals.set(id, { projectId: p.id, files: changed, createdAt: Date.now() });
  return { id, ...publicProposal(changed), errors };
}

const publicProposal = (changed) => ({
  files: changed.map(({ path: fp, action, diff, added, removed, failedBlocks }) => ({ path: fp, action, diff, added, removed, failedBlocks })),
});

export function getProposal(projectId, id) {
  const pr = proposals.get(id);
  if (!pr || pr.projectId !== projectId) throw new HttpError(404, 'Proposal not found or expired; ask again');
  return pr;
}

// ------------------------------------------------------------------ apply / undo
const undoDir = (projectId) => path.join(config.projectsDir, projectId, 'undo');

/** Write the proposed files (all or `only`). Refuses files that changed since the proposal. */
export function applyChanges(p, changed, { only, source = 'ai' } = {}) {
  const sel = only ? changed.filter((f) => only.includes(f.path)) : changed;
  if (!sel.length) throw bad('Nothing to apply');
  const conflicts = sel.filter((f) => files.currentHash(p.path, f.path) !== f.beforeHash);
  if (conflicts.length) {
    const e = new HttpError(409, `Changed since the proposal: ${conflicts.map((f) => f.path).join(', ')}. Ask the AI again.`);
    e.body = { conflicts: conflicts.map((f) => f.path) };
    throw e;
  }
  const applyId = `u${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const undo = { id: applyId, at: new Date().toISOString(), source, files: [] };
  for (const f of sel) {
    const res = files.write(p.path, f.path, f.after);
    undo.files.push({ path: f.path, before: f.before, afterHash: res.hash });
  }
  fs.mkdirSync(undoDir(p.id), { recursive: true });
  fs.writeFileSync(path.join(undoDir(p.id), `${applyId}.json`), JSON.stringify(undo));
  const all = fs.readdirSync(undoDir(p.id)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(undoDir(p.id), old), { force: true });
  return { applyId, files: undo.files.map((f) => ({ path: f.path, hash: f.afterHash })) };
}

export function apply(p, proposalId, only) {
  const pr = getProposal(p.id, proposalId);
  if (only !== undefined && (!Array.isArray(only) || !only.every((x) => typeof x === 'string'))) throw bad('files must be a list of paths');
  return applyChanges(p, pr.files, { only });
}

export function undo(p, applyId) {
  if (!/^u[0-9a-z]+$/.test(String(applyId))) throw bad('Invalid undo id');
  const file = path.join(undoDir(p.id), `${applyId}.json`);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new HttpError(404, 'Nothing to undo'); }
  const changedSince = rec.files.filter((f) => files.currentHash(p.path, f.path) !== f.afterHash);
  if (changedSince.length) throw new HttpError(409, `Edited after applying: ${changedSince.map((f) => f.path).join(', ')}. Undo manually or with git.`);
  for (const f of rec.files) {
    if (f.binary) {
      if (f.backup) files.writeBytes(p.path, f.path, fs.readFileSync(path.join(undoDir(p.id), f.backup)));
      else if (f.wasDir === undefined && files.currentHash(p.path, f.path) !== null) files.remove(p.path, f.path);
    } else if (f.before === null) files.remove(p.path, f.path);
    else files.write(p.path, f.path, f.before);
  }
  for (const f of rec.files) if (f.backup) fs.rmSync(path.join(undoDir(p.id), f.backup), { force: true });
  fs.rmSync(file, { force: true });
  return { ok: true, files: rec.files.map((f) => f.path) };
}

/**
 * Binary-safe file operations with undo (write bytes, delete, move). `op`: {type:'write', path, bytes}
 * | {type:'delete', path} (files only) | {type:'move', path, to}. Returns { applyId, ... }.
 */
export function fileOp(p, op, source = 'agent') {
  const guard = (rel) => { if (FORBIDDEN.test(rel)) throw bad(`path not allowed: ${rel}`); };
  guard(op.path);
  if (op.to) guard(op.to);
  const applyId = `u${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  fs.mkdirSync(undoDir(p.id), { recursive: true });
  const backupOf = (rel, tag) => {
    const hash = files.currentHash(p.path, rel);
    if (hash === null) return null;
    const name = `${applyId}.${tag}.bin`;
    fs.writeFileSync(path.join(undoDir(p.id), name), files.readBytes(p.path, rel));
    return name;
  };
  const rec = { id: applyId, at: new Date().toISOString(), source, files: [] };
  let result;
  if (op.type === 'write') {
    const backup = backupOf(op.path, 'a');
    result = files.writeBytes(p.path, op.path, op.bytes);
    rec.files.push({ path: op.path, binary: true, backup, afterHash: result.hash });
  } else if (op.type === 'delete') {
    const backup = backupOf(op.path, 'a');
    if (!backup) throw new HttpError(404, `${op.path} not found (only files can be deleted with undo; use move to rename folders)`);
    files.remove(p.path, op.path);
    rec.files.push({ path: op.path, binary: true, backup, afterHash: null });
    result = { path: op.path, deleted: true };
  } else if (op.type === 'move') {
    const backup = backupOf(op.path, 'a');
    if (!backup) throw new HttpError(404, `${op.path} not found or is a folder`);
    result = files.rename(p.path, op.path, op.to);
    rec.files.push({ path: op.to, binary: true, backup: null, afterHash: files.currentHash(p.path, op.to) });
    rec.files.push({ path: op.path, binary: true, backup, afterHash: null });
  } else throw bad('Unknown file operation');
  fs.writeFileSync(path.join(undoDir(p.id), `${applyId}.json`), JSON.stringify(rec));
  return { ...result, applyId };
}

/** For agents (MCP): parse + apply SEARCH/REPLACE text directly. */
export function applyEditText(p, text) {
  const edits = parseEdits(text);
  if (!edits.length) throw bad('No SEARCH/REPLACE blocks found');
  const { files: changed, errors } = computeEdits(p.path, edits);
  if (errors.length) {
    const e = new HttpError(422, `Edits rejected: ${errors.map((x) => `${x.path}: ${x.error}`).join('; ')}`);
    e.body = { errors };
    throw e;
  }
  if (!changed.length) return { applyId: null, files: [], note: 'No changes (already applied?)' };
  return { ...applyChanges(p, changed, { source: 'agent' }), diff: changed.map((f) => f.diff).join('\n') };
}
