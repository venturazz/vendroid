// Shared helpers and app state. All dynamic text goes through textContent (never innerHTML).
export const $ = (id) => document.getElementById(id);

export const app = {
  cfg: {},
  project: null, // current project record
  devices: [],
  projects: [],
};

// ---- tiny event bus
const listeners = new Map();
export const on = (ev, fn) => { (listeners.get(ev) || listeners.set(ev, new Set()).get(ev)).add(fn); };
export const emit = (ev, data) => { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } };

// ---- persisted UI prefs
const PREF_KEY = 'vendroid.ui.v2';
let prefs;
try { prefs = JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { prefs = {}; }
export const pref = (k, d) => (prefs[k] === undefined ? d : prefs[k]);
export const setPref = (k, v) => { prefs[k] = v; try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* quota */ } };

// ---- HTTP
export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || data?.message || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}
export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.reload(); throw new ApiError(401, { error: 'Session expired' }); }
  if (raw) {
    if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({})));
    return r;
  }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}
export const pApi = (suffix, opts) => api(`/api/projects/${encodeURIComponent(app.project.id)}${suffix}`, opts);

/** POST that answers with text/event-stream; calls onEvent(event, data) per message. */
export async function postStream(path, body, onEvent, signal) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({})));
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      let data = '';
      let id;
      for (const l of chunk.split('\n')) {
        if (l.startsWith('event: ')) ev = l.slice(7);
        else if (l.startsWith('data: ')) data += l.slice(6);
        else if (l.startsWith('id: ')) id = l.slice(4);
      }
      if (data) onEvent(ev, JSON.parse(data), id);
    }
  }
}

// ---- UI helpers
let toastTimer;
export function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'err' ? 9000 : 4500);
}
export const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, 'err'); } };
export const busy = (btn, fn) => guard(async (...a) => {
  btn.disabled = true;
  try { return await fn(...a); } finally { btn.disabled = false; }
});
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
export const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
export const fmtAgo = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
export const basename = (p) => p.split('/').pop();
export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Small modal prompt; resolves to the entered string or null. */
export function prompt(title, { text = '', value = '', placeholder = '', okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const d = $('dlgPrompt');
    $('prTitle').textContent = title;
    $('prText').textContent = text;
    $('prText').hidden = !text;
    const inp = $('prInput');
    inp.value = value;
    inp.placeholder = placeholder;
    $('prOk').textContent = okLabel;
    const done = () => {
      d.removeEventListener('close', done);
      resolve(d.returnValue === 'ok' ? inp.value.trim() : null);
    };
    d.addEventListener('close', done);
    d.returnValue = '';
    d.showModal();
    inp.focus();
    inp.select();
  });
}

/** Render a unified diff into a <pre>. */
export function renderDiff(text, pre = el('pre', { class: 'diffview' })) {
  pre.textContent = '';
  for (const l of String(text).split('\n')) {
    const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'd-meta'
      : l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : '';
    pre.append(el('div', { class: cls, text: l || ' ' }));
  }
  return pre;
}

export function notify(title, body) {
  if (document.hasFocus()) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/assets/favicon.svg', tag: 'vendroid' }); } catch { /* ignore */ }
  }
}
export function askNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

export const AVATAR_COLORS = ['#2f81f7', '#a371f7', '#3fb950', '#d29922', '#f778ba', '#39c5cf', '#f0883e'];
export function avatar(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = el('span', { class: 'avatar', text: (name.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase() });
  a.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return a;
}

/** Button that disables itself while its async action runs. */
export function actionButton(attrs, fn) {
  const b = el('button', attrs);
  b.addEventListener('click', busy(b, fn));
  return b;
}
