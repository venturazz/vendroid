// AI providers for the coding assistant: any OpenAI-compatible endpoint (9Router, OpenAI, OpenRouter,
// Ollama, LM Studio, vLLM, DeepSeek, Groq, …) and Hermes Agent's API server. Built-ins come from env;
// providers added in the dashboard are stored in DATA_DIR/providers.json with API keys encrypted
// (AES-256-GCM, key in DATA_DIR/.provider_key). Keys are never sent back to the browser.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError, bad } from './validate.js';

const file = () => path.join(config.dataDir, 'providers.json');
const keyFile = () => path.join(config.dataDir, '.provider_key');
export const KINDS = ['openai', 'hermes'];

function masterKey() {
  try {
    const k = Buffer.from(fs.readFileSync(keyFile(), 'utf8').trim(), 'hex');
    if (k.length === 32) return k;
  } catch { /* first use */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(keyFile(), k.toString('hex'), { mode: 0o600 });
  return k;
}
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') return '';
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

const readStore = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return []; } };
const writeStore = (list) => fs.writeFileSync(file(), JSON.stringify(list, null, 2), { mode: 0o600 });

function builtins() {
  const out = [];
  if (config.nineRouterUrl) {
    out.push({ id: '9router', name: '9Router', kind: 'openai', baseUrl: config.nineRouterUrl, model: config.nineRouterModel, contextWindow: config.nineRouterContext, builtin: true, apiKey: config.nineRouterApiKey });
  }
  if (config.hermesApiUrl) {
    out.push({ id: 'hermes', name: 'Hermes Agent', kind: 'hermes', baseUrl: config.hermesApiUrl, model: config.hermesApiModel, builtin: true, apiKey: config.hermesApiKey });
  }
  return out;
}

const publicView = ({ apiKey, keyEnc, ...p }) => ({ ...p, hasKey: !!(apiKey || keyEnc) });

export function list() {
  return [...builtins(), ...readStore()].map(publicView);
}

/** Full provider including the API key (server-side only). Default: first provider. */
export function resolve(id) {
  const all = [...builtins(), ...readStore().map((p) => ({ ...p, apiKey: decrypt(p.keyEnc) }))];
  if (!all.length) throw new HttpError(400, 'No AI provider configured (Settings → AI providers)');
  if (!id) return all[0];
  const p = all.find((x) => x.id === id);
  if (!p) throw new HttpError(404, `Unknown AI provider ${id}`);
  return p;
}

const ctxWindow = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function validate({ name, kind, baseUrl, model, contextWindow }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 40) throw bad('name: 1-40 characters');
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  let u;
  try { u = new URL(baseUrl); } catch { throw bad('baseUrl must be a URL like https://api.openai.com/v1'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw bad('baseUrl must be http(s) without credentials');
  if (model !== undefined && model !== null && (typeof model !== 'string' || model.length > 200)) throw bad('model must be a string');
  const cw = ctxWindow(contextWindow);
  if (cw !== null && (!Number.isInteger(cw) || cw < 1000 || cw > 10_000_000)) throw bad('contextWindow: tokens between 1000 and 10000000');
}

export function add(body) {
  validate(body);
  const store = readStore();
  const base = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
  let id = base;
  for (let i = 2; [...builtins(), ...store].some((p) => p.id === id); i++) id = `${base}-${i}`;
  const rec = {
    id, name: body.name.trim(), kind: body.kind, baseUrl: body.baseUrl.replace(/\/+$/, ''),
    model: (body.model || '').trim() || null, contextWindow: ctxWindow(body.contextWindow), keyEnc: encrypt(body.apiKey || ''), createdAt: new Date().toISOString(),
  };
  store.push(rec);
  writeStore(store);
  return publicView(rec);
}

export function update(id, body) {
  const store = readStore();
  const i = store.findIndex((p) => p.id === id);
  if (i < 0) throw new HttpError(builtins().some((b) => b.id === id) ? 409 : 404, builtins().some((b) => b.id === id) ? 'Built-in providers are set by environment variables' : 'Unknown provider');
  const next = { ...store[i], ...(body.name !== undefined ? { name: body.name } : {}), ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl.replace(/\/+$/, '') } : {}), ...(body.model !== undefined ? { model: body.model || null } : {}), ...(body.kind !== undefined ? { kind: body.kind } : {}), ...(body.contextWindow !== undefined ? { contextWindow: ctxWindow(body.contextWindow) } : {}) };
  validate(next);
  if (body.apiKey !== undefined) next.keyEnc = encrypt(body.apiKey || '');
  store[i] = next;
  writeStore(store);
  return publicView(next);
}

export function remove(id) {
  const store = readStore();
  if (!store.some((p) => p.id === id)) throw new HttpError(builtins().some((b) => b.id === id) ? 409 : 404, 'Only providers added in the dashboard can be deleted');
  writeStore(store.filter((p) => p.id !== id));
  return { ok: true };
}

export const authHeaders = (p) => (p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {});

/** GET {baseUrl}/models -> ids. */
export async function models(id) {
  const p = resolve(id);
  let r;
  try {
    r = await fetch(`${p.baseUrl}/models`, { headers: authHeaders(p), signal: AbortSignal.timeout(15_000) });
  } catch (e) { throw new HttpError(502, `${p.name} unreachable: ${e.message}`); }
  if (!r.ok) throw new HttpError(502, `${p.name} /models returned ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean).slice(0, 500);
}

/** Tiny non-streaming request; reports latency and the reply. */
export async function test(id, model) {
  const p = resolve(id);
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(p) },
      body: JSON.stringify({ model: model || p.model || 'auto', max_tokens: 20, stream: false, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }),
      signal: AbortSignal.timeout(p.kind === 'hermes' ? 120_000 : 30_000),
    });
  } catch (e) { return { ok: false, error: `unreachable: ${e.message}` }; }
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 300) };
  let reply = '';
  try { reply = JSON.parse(text).choices?.[0]?.message?.content || ''; } catch { /* non-JSON */ }
  return { ok: true, latencyMs: Date.now() - t0, reply: reply.slice(0, 200) };
}
