// App shell: routing (hub <-> IDE), top bar, device/env/AI status, run controls, shortcuts, resizers.
import { $, app, api, el, toast, guard, busy, on, emit, pref, setPref, askNotifyPermission } from './core.js';
import { refreshHub } from './hub.js';
import { resetExplorer, focusSearch } from './explorer.js';
import { closeAll, restoreTabs, quickOpen, save, saveAll, isDirty } from './editor.js';
import { refreshGit } from './git.js';
import { loadAi, toggleAi, restoreDraft } from './ai.js';
import { refreshBuilds, startBuild, cancelBuild, resetBottom, toggleBottom } from './bottom.js';
import { openSettings } from './settings.js';
import { refreshPublish } from './publish.js';
import { connectLive, disconnectLive } from './live.js';
import './mobile.js';
import { netError, renderNetlog } from './netlog.js';
import { onNetError } from './core.js';
onNetError(netError);

// ---------------------------------------------------------------- top bar status
function badge(node, text, cls, title) {
  node.textContent = text;
  node.className = `badge ${cls}`;
  if (title !== undefined) node.title = title;
}
const refreshEnv = guard(async () => {
  const h = await api('/api/health/env');
  const failing = Object.entries(h.checks).filter(([k, v]) => !v && k !== 'project').map(([k]) => k);
  const pending = h.sdkBootstrap === 'running';
  badge($('envBadge'), pending ? 'SDK installing…' : failing.length ? `env ⚠ ${failing.length}` : 'env ✔',
    pending ? 'warn' : failing.length ? 'warn' : 'ok', pending ? 'Android SDK is being installed; builds wait for it' : failing.length ? `Failing: ${failing.join(', ')}` : 'All checks pass');
});
const refreshAi = guard(async () => {
  const s = await api('/api/ai/status');
  const n = s.nineRouter.reachable;
  const h = s.hermes.reachable;
  badge($('aiBadge'), `9R ${n ? '●' : '○'} Hermes ${h ? '●' : '○'}`, n && h ? 'ok' : n || h ? 'warn' : 'err',
    `9Router ${s.nineRouter.url} (${s.nineRouter.model}) ${n ? 'reachable' : 'unreachable'}\nHermes ${s.hermes.url} ${h ? 'reachable' : 'unreachable'}`);
});
const refreshDevices = guard(async () => {
  const r = await api('/api/devices');
  app.devices = r.devices;
  const ok = r.devices.filter((d) => d.state === 'device');
  const wd = r.watchdog;
  let label = '📱 none';
  let cls = 'err';
  if (ok.length) { label = `📱 ${ok.map((d) => (d.model || d.serial).replace(/_/g, ' ')).join(', ')}`; cls = 'ok'; }
  else if (r.devices.length) { label = `📱 ${r.devices[0].state}`; cls = 'warn'; }
  else if (wd?.enabled && !wd.paused) { label = `📱 ${wd.state === 'unknown' ? 'connecting…' : wd.state}`; cls = 'warn'; }
  badge($('devBadge'), label, cls, r.devices.map((d) => `${d.serial} ${d.state}`).join('\n')
    + (wd?.enabled ? `\nAuto-reconnect ${wd.target}: ${wd.paused ? 'paused' : wd.state}${wd.message ? ` - ${wd.message}` : ''}` : ''));
  emit('devices', r.devices);
});
$('envBadge').addEventListener('click', () => openSettings());

$('quickConnect').addEventListener('click', busy($('quickConnect'), async () => {
  const target = $('quickTarget').value.trim();
  const r = await api('/api/devices/connect', { method: 'POST', body: { target } });
  toast(r.message || (r.ok ? 'Connected' : 'Failed'), r.ok ? 'ok' : 'err');
  setPref('target', target);
  await refreshDevices();
}));
$('quickTarget').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('quickConnect').click(); });

// menus
function menu(btnId, menuId) {
  const b = $(btnId);
  const m = $(menuId);
  b.addEventListener('click', (e) => { e.stopPropagation(); const show = m.hidden; closeMenus(); m.hidden = !show; });
  m.addEventListener('click', (e) => e.stopPropagation());
}
const closeMenus = () => document.querySelectorAll('.topbar .menu').forEach((m) => (m.hidden = true));
document.addEventListener('click', closeMenus);
menu('btnMore', 'moreMenu');
menu('btnRunOpts', 'runOpts');
menu('projBtn', 'projMenu');
$('moreMenu').addEventListener('click', guard(async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  closeMenus();
  if (act === 'reconnect') {
    const r = await api('/api/adb/restart', { method: 'POST', body: { mode: 'reconnect', serial: $('quickTarget').value.trim() || undefined } });
    toast(r.message, r.ok ? 'ok' : 'err');
    refreshDevices();
  } else if (act === 'restartAdb') {
    const r = await api('/api/adb/restart', { method: 'POST', body: { mode: 'restart-server' } });
    toast(r.message, r.ok ? 'ok' : 'err');
    refreshDevices();
  } else if (act === 'settings') openSettings();
  else if (act === 'logout') { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); }
}));
for (const id of ['oGit', 'oFollow', 'oHermes']) {
  $(id).checked = pref(`run:${id}`, $(id).checked);
  $(id).addEventListener('change', () => setPref(`run:${id}`, $(id).checked));
}
$('task').addEventListener('change', () => setPref('run:task', $('task').value));

// project switcher
on('projects', (list) => {
  const m = $('projMenu');
  m.textContent = '';
  m.append(el('div', { class: 'sub', text: 'Switch project' }));
  for (const p of list) {
    m.append(el('button', { text: `${p.id === app.project?.id ? '● ' : ''}${p.name}`, onclick: () => { closeMenus(); location.hash = `#/p/${encodeURIComponent(p.id)}`; } }));
  }
  m.append(el('hr'), el('button', { text: '⌂ Project Hub', onclick: () => { closeMenus(); location.hash = '#/'; } }));
});

// ---------------------------------------------------------------- run controls
$('btnRun').addEventListener('click', busy($('btnRun'), async () => { askNotifyPermission(); await saveAll(); await startBuild({ install: true }); }));
$('btnBuildOnly').addEventListener('click', busy($('btnBuildOnly'), async () => { await saveAll(); await startBuild({ install: false }); }));
$('btnCancel').addEventListener('click', guard(cancelBuild));
on('run', guard(async ({ install }) => { await saveAll(); await startBuild({ install }); }));
on('queue', (q) => {
  const busyHere = q.active && q.activeProject === app.project?.id;
  $('btnCancel').disabled = !busyHere && !q.queued.length;
  const pill = $('buildPill');
  if (q.active) {
    const other = q.activeProject !== app.project?.id;
    pill.textContent = other ? `busy: ${q.activeProject}` : 'building';
    pill.className = 'pill building';
    pill.title = other ? `Another project is building; yours will queue (${q.queued.length} queued)` : `${q.queued.length} queued`;
  } else {
    pill.textContent = 'idle';
    pill.className = 'pill';
    pill.title = 'No build running';
  }
  $('sbQueue').textContent = q.active ? `⚒ ${q.activeProject}${q.queued.length ? ` +${q.queued.length}` : ''}` : '';
});

// ---------------------------------------------------------------- activity bar
function showView(view) {
  document.querySelectorAll('.activitybar [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.sidebar .pane').forEach((p) => (p.hidden = p.dataset.pane !== view));
  $('sidebar').hidden = false;
  setPref('view', view);
  if (view === 'git') refreshGit();
  if (view === 'search') focusSearch();
  if (view === 'publish') refreshPublish();
}
document.querySelectorAll('.activitybar [data-view]').forEach((b) => b.addEventListener('click', () => {
  if (b.classList.contains('active') && !$('sidebar').hidden && !document.body.classList.contains('phone')) { $('sidebar').hidden = true; b.classList.remove('active'); return; }
  showView(b.dataset.view);
}));

// ---------------------------------------------------------------- resizers
function resizer(handle, apply) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('drag');
    const move = (ev) => apply(ev);
    const up = () => { handle.classList.remove('drag'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
const root = document.documentElement.style;
const restoreSize = (k, d) => root.setProperty(`--${k}`, pref(`size:${k}`, d));
restoreSize('sidebar-w', '260px');
restoreSize('ai-w', '400px');
restoreSize('bottom-h', '260px');
const setSize = (k, px) => { root.setProperty(`--${k}`, `${Math.round(px)}px`); setPref(`size:${k}`, `${Math.round(px)}px`); };
resizer(document.querySelector('[data-resize=sidebar]'), (e) => setSize('sidebar-w', Math.max(160, Math.min(e.clientX - 44, innerWidth * 0.6))));
resizer(document.querySelector('[data-resize=ai]'), (e) => setSize('ai-w', Math.max(280, Math.min(innerWidth - e.clientX, innerWidth * 0.7))));
resizer(document.querySelector('[data-resize=bottom]'), (e) => {
  const center = document.querySelector('.center').getBoundingClientRect();
  setSize('bottom-h', Math.max(80, Math.min(center.bottom - e.clientY, center.height - 100)));
});

// ---------------------------------------------------------------- dialogs: generic close
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-close]');
  if (b) b.closest('dialog')?.close('cancel');
});

// ---------------------------------------------------------------- keyboard
// Capture phase: IDE shortcuts win over the editor's own bindings (CodeMirror uses Ctrl+I/Ctrl+Enter too),
// and each shortcut runs exactly once.
document.addEventListener('keydown', (e) => {
  if (!app.project || $('ide').hidden || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const actions = {
    enter: mod && !e.shiftKey && (() => $('btnRun').click()),
    p: mod && !e.shiftKey && (() => quickOpen()),
    s: mod && !e.shiftKey && (() => save()),
    i: mod && !e.shiftKey && (() => toggleAi()),
    '`': mod && (() => toggleBottom()),
    f: mod && e.shiftKey && (() => showView('search')),
    e: mod && e.shiftKey && (() => showView('explorer')),
    g: mod && e.shiftKey && (() => showView('git')),
    f5: !mod && (() => $('btnRun').click()),
  };
  const fn = actions[k];
  if (!fn) return;
  if (k === 'enter' && e.target.closest?.('#aiInput, #gitMsg')) return; // those inputs use Ctrl+Enter themselves
  e.preventDefault();
  e.stopPropagation();
  fn();
}, true);

// ---------------------------------------------------------------- routing
async function showHub() {
  if (app.project && isDirty() && !confirm('You have unsaved changes. Leave the project anyway?')) { location.hash = `#/p/${encodeURIComponent(app.project.id)}`; return; }
  if (app.project) closeAll({ force: true });
  disconnectLive();
  app.project = null;
  $('ide').hidden = true;
  $('statusbar').hidden = true;
  $('runbar').hidden = true;
  $('projSwitch').hidden = true;
  $('hub').hidden = false;
  document.title = 'Vendroid';
  await refreshHub();
}

async function openProject(id) {
  if (app.project?.id === id) return;
  if (app.project && isDirty() && !confirm('You have unsaved changes. Switch project anyway?')) { location.hash = `#/p/${encodeURIComponent(app.project.id)}`; return; }
  let p;
  try { p = await api(`/api/projects/${encodeURIComponent(id)}/settings`, { method: 'POST', body: { opened: true } }); } catch (e) {
    toast(e.message, 'err');
    location.hash = '#/';
    return;
  }
  if (app.project) closeAll({ force: true });
  app.project = p;
  connectLive(p.id);
  document.title = `${p.name} · Vendroid`;
  $('hub').hidden = true;
  $('ide').hidden = false;
  $('statusbar').hidden = false;
  $('runbar').hidden = false;
  $('projSwitch').hidden = false;
  $('projName').textContent = p.name;
  $('welcomeTitle').textContent = p.name;
  $('sbPkg').textContent = `${p.packageName || 'no applicationId'}${p.targetSdk ? ` · min ${p.minSdk || '?'} · target ${p.targetSdk}` : ''}`;
  $('task').value = pref('run:task', 'assembleDebug');
  showView(pref('view', 'explorer'));
  resetExplorer();
  resetBottom();
  await Promise.all([restoreTabs(), refreshGit(), refreshBuilds(), loadAi(), refreshPublish()]);
  restoreDraft();
  toggleAi(pref('aiOpen', false), { reveal: false });
  emit('project-opened');
  if (!p.hasGradlew && p.android) toast('This project has no gradlew wrapper: builds need ./gradlew in the project root.', 'err');
  api('/api/projects').then((r) => emit('projects', r.projects)).catch(() => {});
}

async function route() {
  const m = /^#\/p\/([^/]+)/.exec(location.hash);
  if (m) await openProject(decodeURIComponent(m[1]));
  else await showHub();
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- boot
(async function boot() {
  try { app.cfg = await api('/api/config'); } catch (e) { toast(e.message, 'err'); }
  $('quickTarget').value = pref('target', '') || app.cfg.defaultDevice || '';
  await route();
  refreshEnv(); refreshAi(); refreshDevices();
  setInterval(refreshDevices, 10_000);
  setInterval(refreshAi, 30_000);
  setInterval(refreshEnv, 60_000);
  setInterval(() => { if (!document.hidden && app.project) refreshBuilds(); }, 10_000); // live.js pushes changes; this is the fallback
  setInterval(() => { if (!document.hidden && app.project) refreshGit(); }, 15_000);
  setInterval(() => { if (!document.hidden && !app.project) refreshHub(); }, 10_000);
})();
