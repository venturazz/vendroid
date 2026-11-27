// Connection log: every dropped request or stream is recorded with the time, what was open, whether
// a build was running, and whether the runner restarted (boot id changed). Kept in localStorage (last
// 80 entries) and shown in Settings → Connection log, so a "network error" can be traced afterwards.
import { $, app, el, on } from './core.js';

const KEY = 'vendroid.netlog.v1';
let log = [];
try { log = JSON.parse(localStorage.getItem(KEY)) || []; } catch { log = []; }
let boot = null;
let buildNow = null; // { id, state }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(log.slice(-80))); } catch { /* quota */ } };

on('build-live', (b) => { buildNow = { id: b.id, state: b.state, at: Date.now() }; });
on('build-state', (b) => { buildNow = { id: b.id, state: b.state, at: Date.now() }; });

async function checkRunner() {
  try {
    const r = await fetch('/healthz', { cache: 'no-store' });
    const j = await r.json();
    if (boot && j.boot && j.boot !== boot) {
      boot = j.boot;
      return 'restarted';
    }
    boot = j.boot || boot;
    return 'up';
  } catch { return 'unreachable'; }
}
checkRunner();

/** kind: api | chat | live | build | job | logcat. Records and resolves with the runner state. */
export async function netError(kind, what, message) {
  const entry = {
    at: new Date().toISOString(), kind, what: String(what || '').slice(0, 120), message: String(message || '').slice(0, 200),
    project: app.project?.id || null, online: navigator.onLine, hidden: document.hidden,
    build: buildNow && Date.now() - buildNow.at < 10 * 60_000 ? `${buildNow.id} ${buildNow.state}` : null,
    runner: '…',
  };
  log.push(entry);
  save();
  entry.runner = await checkRunner();
  if (entry.runner === 'restarted') {
    try { entry.restart = (await (await fetch('/api/diag')).json()).previousExit; } catch { /* ignore */ }
  }
  save();
  renderNetlog();
  return entry.runner;
}
window.addEventListener('offline', () => netError('device', 'browser went offline', 'navigator.onLine = false'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkRunner().then((s) => { if (s === 'restarted') netError('runner', 'runner restarted while the tab was hidden', ''); });
});

export function renderNetlog() {
  const box = $('netlogList');
  if (!box) return;
  box.textContent = '';
  if (!log.length) { box.append(el('p', { class: 'muted small', text: 'No dropped connections recorded.' })); return; }
  for (const e of [...log].reverse().slice(0, 40)) {
    const t = new Date(e.at);
    const why = e.runner === 'restarted' ? `runner RESTARTED${e.restart ? ` (${e.restart.reason}${e.restart.detail ? `: ${e.restart.detail.split('\n')[0]}` : ''})` : ''}`
      : e.runner === 'unreachable' ? 'runner unreachable' : !e.online ? 'device offline' : e.hidden ? 'tab was in the background' : 'runner up (connection cut on the way)';
    box.append(el('div', { class: 'netrow' },
      el('span', { class: 'muted', text: `${t.toLocaleDateString()} ${t.toLocaleTimeString()}` }),
      el('b', { text: ` ${e.kind}` }), ` ${e.what} · ${e.message}`,
      el('div', { class: `small ${e.runner === 'up' ? 'muted' : 'badc'}`, text: `→ ${why}${e.build ? ` · build ${e.build}` : ''}` })));
  }
}
export function netlogText() {
  return log.map((e) => `${e.at} ${e.kind} ${e.what} | ${e.message} | runner=${e.runner}${e.restart ? ` (${e.restart.reason}: ${(e.restart.detail || '').split('\n')[0]})` : ''} online=${e.online} hidden=${e.hidden} build=${e.build || '-'}`).join('\n');
}
export function clearNetlog() { log = []; save(); renderNetlog(); }
