// Chat with Hermes Agent from the IDE through its OpenAI-compatible API server. Hermes works on the
// project with its own tools (incl. the "vendroid" MCP server), so Vendroid only sends the user's
// message plus a short project header, streams Hermes's answer, tool progress and approval requests,
// and keeps one Hermes session per project (X-Hermes-Session-Id).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { loadHistory, saveHistory } from './aicode.js';
import { sliceBuildError } from './ai.js';
import { authHeaders } from './providers.js';
import { HttpError, bad, isRelPath } from './validate.js';

const sessionFile = (projectId) => path.join(config.projectsDir, projectId, 'hermes-session.json');
const readSession = (id) => { try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return {}; } };
const writeSession = (id, s) => {
  fs.mkdirSync(path.dirname(sessionFile(id)), { recursive: true });
  fs.writeFileSync(sessionFile(id), JSON.stringify(s));
};
export const clearSession = (projectId) => fs.rmSync(sessionFile(projectId), { force: true });

function header(p, opts) {
  const lines = [
    `[Vendroid IDE] Project id "${p.id}" (${p.name}), package ${p.packageName || '?'}, UI ${p.ui}, module ${p.module}.`,
    'Work on it with the "vendroid" MCP tools (pass project="' + p.id + '"). The user sees your edits, builds and git changes live in the IDE.',
  ];
  if (opts.activeFile && isRelPath(opts.activeFile)) lines.push(`Open file in the editor: ${opts.activeFile}`);
  const extra = (opts.contextFiles || []).filter((f) => isRelPath(f)).slice(0, 20);
  if (extra.length) lines.push(`Files the user attached: ${extra.join(', ')}`);
  if (opts.selection) lines.push(`Selected text:\n\`\`\`\n${String(opts.selection).slice(0, 8000)}\n\`\`\``);
  if (opts.buildLog) lines.push(`Latest build failure:\n\`\`\`\n${sliceBuildError(opts.buildLog)}\n\`\`\``);
  return lines.join('\n');
}

/**
 * One turn. onEvent(type, data): delta {text} · reasoning {text} · tool {tool,label,emoji,status,toolCallId}
 * · approval {...hermes approval.request event} · status {...}. Resolves { message, sessionId, tools }.
 */
export async function chat(p, opts, prov, onEvent, signal) {
  if (typeof opts.message !== 'string' || !opts.message.trim() || opts.message.length > 20_000) throw bad('message is required (max 20000 chars)');
  const sess = readSession(p.id);
  const sameProvider = sess.providerId === prov.id;
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(prov) };
  if (sameProvider && sess.sessionId) headers['X-Hermes-Session-Id'] = sess.sessionId;
  const content = `${header(p, opts)}\n\n${opts.message}`;
  let res;
  try {
    res = await fetch(`${prov.baseUrl}/chat/completions`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: prov.model || 'hermes-agent', stream: true, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    throw new HttpError(502, `Hermes API unreachable at ${prov.baseUrl}: ${e.message}`);
  }
  if (res.status === 404 && headers['X-Hermes-Session-Id']) {
    clearSession(p.id); // session was deleted in Hermes: start a fresh one
    return chat(p, opts, prov, onEvent, signal);
  }
  if (!res.ok) throw new HttpError(502, `Hermes API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const sid = res.headers.get('x-hermes-session-id');
  if (sid) writeSession(p.id, { sessionId: sid, providerId: prov.id, at: new Date().toISOString() });

  let text = '';
  const tools = [];
  const dec = new TextDecoder();
  let buf = '';
  const handle = (event, data) => {
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (event === 'hermes.tool.progress') {
      if (j.status === 'running') tools.push({ tool: j.tool, label: j.label });
      onEvent('tool', j);
    } else if (event === 'approval.request') {
      onEvent('approval', j);
    } else if (event === 'hermes.status') {
      onEvent('status', j);
    } else {
      const d = j.choices?.[0]?.delta || {};
      if (d.reasoning_content) onEvent('reasoning', { text: d.reasoning_content });
      if (d.content) { text += d.content; onEvent('delta', { text: d.content }); }
      if (j.error) onEvent('status', { error: j.error.message || String(j.error) });
    }
  };
  if (!(res.headers.get('content-type') || '').includes('event-stream')) {
    const j = await res.json().catch(() => ({}));
    text = j.choices?.[0]?.message?.content || '';
    if (text) onEvent('delta', { text });
  } else {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const data = [];
        for (const l of frame.split('\n')) {
          if (l.startsWith(':')) continue; // keepalive
          if (l.startsWith('event:')) event = l.slice(6).trim();
          else if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, ''));
        }
        if (data.length) handle(event, data.join('\n'));
      }
    }
  }
  const now = new Date().toISOString();
  const history = loadHistory(p.id);
  history.push({ role: 'user', content: opts.message, at: now, context: [opts.activeFile, ...(opts.contextFiles || [])].filter(Boolean) });
  history.push({ role: 'assistant', content: text, at: now, engine: prov.name, tools });
  saveHistory(p.id, history);
  return { message: text, sessionId: sid || sess.sessionId || null, tools };
}

/** Forward an approval decision (from the IDE's Approve/Deny buttons) to Hermes. */
export async function approve(prov, { runId, choice, requestId, executionGeneration }) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(runId)) throw bad('Invalid runId');
  if (!['once', 'session', 'always', 'deny'].includes(choice)) throw bad('choice must be once, session, always or deny');
  const body = { choice, ...(requestId ? { request_id: String(requestId) } : {}), ...(Number.isInteger(executionGeneration) ? { execution_generation: executionGeneration } : {}) };
  let r;
  try {
    r = await fetch(`${prov.baseUrl}/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(prov) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
  } catch (e) { throw new HttpError(502, `Hermes API unreachable: ${e.message}`); }
  const text = await r.text();
  if (!r.ok) throw new HttpError(r.status === 409 ? 409 : 502, `Hermes approval: ${r.status} ${text.slice(0, 200)}`);
  return { ok: true };
}
