// Bottom panel scoped to the active project: Build Output, Logcat, Device screenshot/actions.
import { $, app, api, pApi, el, toast, guard, busy, fmtDur, notify, emit, on, pref, setPref } from './core.js';
import { openFile } from './editor.js';
import { askToFix, setLatestFailedBuild } from './ai.js';

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const MAX_LINES = 6000;

class LogView {
  constructor(pre, autoId) { this.pre = pre; this.n = 0; this.autoId = autoId; }
  add(text, cls = '', onclick) {
    const d = el('div', { class: cls, text: text || ' ' });
    if (onclick) { d.classList.add('link'); d.addEventListener('click', onclick); }
    this.pre.append(d);
    if (++this.n > MAX_LINES) { this.pre.firstChild.remove(); this.n--; }
    if ($(this.autoId).checked) this.pre.scrollTop = this.pre.scrollHeight;
  }
  clear() { this.pre.textContent = ''; this.n = 0; }
}

// ---------------------------------------------------------------- panel chrome
export function showBottom(tab) {
  $('bottom').classList.remove('collapsed');
  $('bottomToggle').textContent = '▾';
  setPref('bottomCollapsed', false);
  if (tab) {
    document.querySelectorAll('.bottom-tabs [data-btab]').forEach((b) => b.classList.toggle('active', b.dataset.btab === tab));
    document.querySelectorAll('.bpane').forEach((p) => (p.hidden = p.dataset.bpane !== tab));
    if (tab === 'logcat') $('crashChip').hidden = true;
    if (tab !== 'device' && $('scAuto').checked) { $('scAuto').checked = false; applyAuto(); }
    setPref('bottomTab', tab);
  }
}
export function toggleBottom() {
  const c = $('bottom').classList.toggle('collapsed');
  $('bottomToggle').textContent = c ? '▴' : '▾';
  setPref('bottomCollapsed', c);
}
document.querySelectorAll('.bottom-tabs [data-btab]').forEach((b) => b.addEventListener('click', () => showBottom(b.dataset.btab)));
$('bottomToggle').addEventListener('click', toggleBottom);
if (pref('bottomCollapsed', false)) toggleBottom();

// ---------------------------------------------------------------- builds
const bLog = new LogView($('bLog'), 'bScroll');
let selected = null;
let es = null;
let timer = null;
let selRec = null;
const lastStates = new Map();
const followAfter = new Set();

const LINE_CLASS = [
  [/^=== |^\$ /, 'mark'],
  [/^e: |error:|FAILED|BUILD FAILED|Exception|^Failure|^APK is missing/, 'err'],
  [/^w: |warning:/i, 'W'],
  [/BUILD SUCCESSFUL|^Success|^APK: /, 'ok'],
];
const lineClass = (t) => (LINE_CLASS.find(([re]) => re.test(t)) || [null, ''])[1];
// "e: file:///…/app/src/main/java/X.kt:12:5 msg" -> open the file at that line
const FILE_REF = /(?:file:\/\/)?(\/[^\s:]+\.(?:kt|kts|java|xml|gradle))(?::(\d+))?/;
function fileLink(text) {
  const m = FILE_REF.exec(text);
  if (!m || !app.project) return null;
  const root = app.project.path.replace(/\/+$/, '');
  const abs = m[1];
  const idx = abs.indexOf(`/${app.project.id}/`);
  const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : idx >= 0 ? abs.slice(idx + app.project.id.length + 2) : null;
  return rel ? () => openFile(rel, { line: Number(m[2]) || 1 }) : null;
}

function setBuildState(s) {
  selRec = s;
  $('bState').textContent = s.state;
  $('bState').className = `pill ${s.state}`;
  $('bCommit').textContent = s.commit ? `${s.commit.sha} ${s.commit.subject}` : '';
  $('bLogDl').hidden = false;
  $('bLogDl').href = `/api/builds/${s.id}/log`;
  $('bApk').hidden = !s.apk;
  if (s.apk) $('bApk').href = `/api/builds/${s.id}/apk`;
  clearInterval(timer);
  const tick = () => {
    if (!s.startedAt) { $('bTimer').textContent = '00:00'; return; }
    $('bTimer').textContent = fmtDur((s.finishedAt ? Date.parse(s.finishedAt) : Date.now()) - Date.parse(s.startedAt));
  };
  tick();
  if (!s.finishedAt) timer = setInterval(tick, 1000);
  const failed = s.state === 'failed';
  $('btnAnalyze').disabled = !failed;
  $('btnFixAi').disabled = !failed;
  $('btnInvestigate').disabled = !failed;
  if (failed) setLatestFailedBuild(s.id);
}

export function attachBuild(id) {
  if (es) es.close();
  selected = id;
  bLog.clear();
  $('aiOut').hidden = true;
  if (!id) {
    $('bState').textContent = 'no builds yet';
    $('bState').className = 'pill';
    $('bTimer').textContent = '';
    $('bCommit').textContent = '';
    $('bApk').hidden = true;
    $('bLogDl').hidden = true;
    ['btnAnalyze', 'btnFixAi', 'btnInvestigate'].forEach((b) => ($(b).disabled = true));
    return;
  }
  es = new EventSource(`/api/builds/${id}/stream`);
  es.addEventListener('line', (e) => {
    const t = e.data ? JSON.parse(e.data) : '';
    const cls = lineClass(t);
    bLog.add(t, cls, cls === 'err' ? fileLink(t) : null);
  });
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    observe(s);
    if (s.id === selected) setBuildState(s);
  });
  es.addEventListener('end', () => { es.close(); es = null; refreshBuilds(); });
  $('buildSel').value = id;
}

function observe(b) {
  const prev = lastStates.get(b.id);
  lastStates.set(b.id, b.state);
  if (prev === undefined || prev === b.state) return;
  emit('build-state', b);
  const launched = b.state === 'launching' || (b.state === 'succeeded' && b.options?.autoLaunchAfterInstall);
  if (launched && followAfter.has(b.id)) {
    followAfter.delete(b.id);
    showBottom('logcat');
    if (b.deviceSerial && [...$('lcSerial').options].some((o) => o.value === b.deviceSerial)) $('lcSerial').value = b.deviceSerial;
    lcStart(true);
  }
  if (TERMINAL.includes(b.state)) {
    followAfter.delete(b.id);
    const dur = b.startedAt && b.finishedAt ? ` in ${fmtDur(Date.parse(b.finishedAt) - Date.parse(b.startedAt))}` : '';
    const msg = b.state === 'succeeded' ? `✅ ${b.projectName || ''} built${dur}` : b.state === 'failed' ? `❌ ${b.projectName || ''} build failed${dur}` : '⏹ Build cancelled';
    notify(msg, `${b.task}${b.error ? ` - ${b.error}` : ''}`);
    if (b.projectId === app.project?.id) toast(b.state === 'failed' ? `${msg}: ${b.error || ''}` : msg, b.state === 'failed' ? 'err' : b.state === 'succeeded' ? 'ok' : '');
  }
}

export async function refreshBuilds() {
  if (!app.project) return;
  let r;
  try { r = await pApi('/builds'); } catch { return; }
  for (const b of r.builds) observe(b);
  const sel = $('buildSel');
  const cur = sel.value;
  sel.textContent = '';
  for (const b of r.builds) {
    const when = new Date(b.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    sel.append(new Option(`${when} · ${b.task} · ${b.state}${b.trigger !== 'manual' ? ` · ${b.trigger}` : ''}`, b.id));
  }
  if (!r.builds.length) sel.append(new Option('No builds yet', ''));
  const keep = r.builds.find((b) => b.id === (selected || cur));
  if (keep) sel.value = keep.id;
  if (!selected && r.builds.length) attachBuild(r.builds[0].id);
  else if (!r.builds.length && selected) attachBuild(null);
  emit('queue', r);
}
$('buildSel').addEventListener('change', () => { if ($('buildSel').value) attachBuild($('buildSel').value); });

/** Start a build for the active project. opts: { install } */
export async function startBuild({ install = true } = {}) {
  const p = app.project;
  const dev = app.devices.find((d) => d.state === 'device')?.serial || $('quickTarget').value.trim() || app.cfg.defaultDevice;
  const task = $('task').value;
  const unsignedRelease = task === 'assembleRelease' && !app.cfg.releaseSigning;
  const doInstall = install && !!dev && !unsignedRelease && !!p.packageName;
  if (install && !dev) toast('No phone connected: building only. Connect a device to install and launch.');
  else if (install && unsignedRelease) toast('Release signing is not configured: building an unsigned APK without installing.');
  const body = {
    task,
    gitPullBeforeBuild: $('oGit').checked,
    autoInstallAfterBuild: doInstall,
    autoLaunchAfterInstall: doInstall,
    autoNotifyHermes: $('oHermes').checked,
    ...(dev ? { deviceSerial: dev } : {}),
  };
  const b = await pApi('/builds', { method: 'POST', body });
  lastStates.set(b.id, b.state);
  if ($('oFollow').checked && doInstall) followAfter.add(b.id);
  showBottom('build');
  attachBuild(b.id);
  refreshBuilds();
  return b;
}
export const cancelBuild = async () => {
  const id = selRec && !TERMINAL.includes(selRec.state) ? selRec.id : (await pApi('/builds')).active;
  if (!id) return;
  await api(`/api/builds/${id}/cancel`, { method: 'POST' });
  toast('Cancel requested');
};

function renderAnalysis(box, r) {
  box.textContent = '';
  box.hidden = false;
  const a = r.analysis;
  if (!a) { box.append(el('h4', { text: `9Router (${r.model})` }), el('div', { text: r.raw })); return; }
  box.append(el('h4', { text: `Root cause (confidence: ${a.confidence})` }), el('div', { text: a.rootCause }));
  if (a.affected.length) box.append(el('h4', { text: 'Affected' }), el('ul', {}, a.affected.map((x) => el('li', { text: x }))));
  if (a.fixSteps.length) box.append(el('h4', { text: 'Fix steps' }), el('ol', {}, a.fixSteps.map((x) => el('li', { text: x }))));
}
$('btnAnalyze').addEventListener('click', busy($('btnAnalyze'), async () => {
  $('aiOut').hidden = false;
  $('aiOut').textContent = 'Asking 9Router…';
  try {
    renderAnalysis($('aiOut'), await api('/api/ai/analyze', { method: 'POST', body: { mode: 'build_error', jobId: selected } }));
  } catch (e) { $('aiOut').textContent = `9Router: ${e.message}`; throw e; }
}));
$('btnFixAi').addEventListener('click', () => { setLatestFailedBuild(selected); askToFix('build'); });
$('btnInvestigate').addEventListener('click', busy($('btnInvestigate'), async () => {
  const r = await api('/api/ai/hermes-investigate', { method: 'POST', body: { jobId: selected, projectId: app.project.id } });
  toast(`Sent to Hermes (HTTP ${r.status})`, 'ok');
}));

// ---------------------------------------------------------------- logcat
const lcLog = new LogView($('lcLog'), 'lcScroll');
let lcES = null;
let lcPaused = false;
let lcPending = [];
let lcAll = [];
const CRASH_RE = /FATAL EXCEPTION|ANR in |Fatal signal \d+/;
let lastCrashToast = 0;

function lcPush(lines) {
  for (const l of lines) {
    lcAll.push(l.text);
    if (lcAll.length > 20000) lcAll.shift();
    lcLog.add(l.text, l.level);
    if (CRASH_RE.test(l.text)) {
      if ($('bottom').querySelector('[data-bpane=logcat]').hidden) $('crashChip').hidden = false;
      if (Date.now() - lastCrashToast > 10_000) {
        lastCrashToast = Date.now();
        toast(`Crash detected: ${l.text.slice(0, 140)}\n"Fix with AI" or "Triage Crash" can diagnose it.`, 'err');
        notify('💥 App crashed', l.text.slice(0, 120));
      }
    }
  }
}
export function lcStop() {
  lcES?.close();
  lcES = null;
  $('lcStart').textContent = 'Start';
  $('lcPause').disabled = true;
  $('lcStatus').textContent = 'stopped';
}
export function lcStart(quiet = false) {
  lcStop();
  const serial = $('lcSerial').value;
  if (!serial) { if (!quiet) toast('No device selected', 'err'); return; }
  const q = new URLSearchParams({ serial, level: $('lcLevel').value, tag: $('lcTag').value.trim(), q: $('lcQ').value.trim() });
  const pkg = app.project?.packageName;
  if ($('lcOnlyApp').checked && pkg) q.set('package', pkg);
  lcES = new EventSource(`/api/logcat/stream?${q}`);
  $('lcStatus').textContent = 'connecting…';
  lcES.addEventListener('ready', (e) => {
    const d = JSON.parse(e.data);
    $('lcStatus').textContent = `streaming${d.pid ? ` · ${pkg} pid ${d.pid}` : q.get('package') ? ` · ${pkg} not running, matching by name` : ''}`;
  });
  lcES.addEventListener('lines', (e) => { const l = JSON.parse(e.data); if (lcPaused) lcPending.push(...l); else lcPush(l); });
  lcES.addEventListener('error', (e) => { if (e.data) toast(JSON.parse(e.data).message, 'err'); });
  lcES.addEventListener('end', lcStop);
  lcES.onerror = () => { if (lcES && lcES.readyState === EventSource.CLOSED) lcStop(); };
  $('lcStart').textContent = 'Stop';
  $('lcPause').disabled = false;
}
for (const id of ['lcLevel', 'lcTag', 'lcQ', 'lcOnlyApp', 'lcSerial']) {
  $(id).addEventListener('change', () => {
    setPref(`lc:${id}`, $(id).type === 'checkbox' ? $(id).checked : $(id).value);
    if (lcES) lcStart();
  });
}
$('lcLevel').value = pref('lc:lcLevel', 'W');
$('lcOnlyApp').checked = pref('lc:lcOnlyApp', true);
$('lcStart').addEventListener('click', () => (lcES ? lcStop() : lcStart()));
$('lcPause').addEventListener('click', () => {
  lcPaused = !lcPaused;
  $('lcPause').textContent = lcPaused ? 'Resume' : 'Pause';
  if (!lcPaused) { lcPush(lcPending); lcPending = []; }
});
$('lcClear').addEventListener('click', guard(async () => {
  lcLog.clear(); lcAll = []; lcPending = [];
  $('lcAi').hidden = true;
  if ($('lcSerial').value) await api('/api/logcat/clear', { method: 'POST', body: { serial: $('lcSerial').value } });
}));
$('lcExport').addEventListener('click', () => {
  if (!lcAll.length) return toast('Nothing to export yet');
  const a = el('a', { href: URL.createObjectURL(new Blob([`${lcAll.join('\n')}\n`], { type: 'text/plain' })), download: `logcat-${app.project?.id || 'device'}-${new Date().toISOString().replace(/[:.]/g, '-')}.log` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
const crashText = () => {
  const text = lcAll.slice(-1500).join('\n');
  if (!text) throw new Error('No logcat lines captured yet. Start the stream and reproduce the crash.');
  return text;
};
const lastCrash = () => {
  const lines = lcAll.slice(-3000);
  let i = lines.length - 1;
  while (i >= 0 && !CRASH_RE.test(lines[i])) i--;
  return (i >= 0 ? lines.slice(Math.max(0, i - 2), i + 60) : lines.slice(-80)).join('\n');
};
$('lcTriage').addEventListener('click', busy($('lcTriage'), async () => {
  const text = crashText();
  $('lcAi').hidden = false;
  $('lcAi').textContent = 'Asking 9Router…';
  try {
    renderAnalysis($('lcAi'), await api('/api/ai/analyze', { method: 'POST', body: { mode: 'logcat_crash', text } }));
  } catch (e) { $('lcAi').textContent = `9Router: ${e.message}`; throw e; }
}));
$('lcFixAi').addEventListener('click', guard(() => { crashText(); askToFix('crash', lastCrash()); }));
$('lcHermes').addEventListener('click', busy($('lcHermes'), async () => {
  const r = await api('/api/ai/hermes-investigate', {
    method: 'POST',
    body: { crashSnippet: crashText(), projectId: app.project?.id, deviceSerial: $('lcSerial').value || undefined },
  });
  toast(`Sent to Hermes (HTTP ${r.status})`, 'ok');
}));

// ---------------------------------------------------------------- device
let shotBusy = false;
let shotTimer = null;
let lastUrl = null;
async function capture() {
  if (shotBusy) return;
  const serial = $('scSerial').value;
  if (!serial) { toast('No device selected', 'err'); return; }
  shotBusy = true;
  $('scCapture').disabled = true;
  try {
    const blob = await api(`/api/devices/screenshot?serial=${encodeURIComponent(serial)}`);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    $('scImg').src = lastUrl;
    $('scImg').hidden = false;
    $('scHint').hidden = true;
    $('scSave').hidden = false;
    $('scSave').href = lastUrl;
    $('scSave').download = `screen-${app.project?.id || 'device'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  } catch (e) {
    toast(e.message, 'err');
    $('scAuto').checked = false;
    applyAuto();
  } finally {
    shotBusy = false;
    $('scCapture').disabled = false;
  }
}
function applyAuto() {
  clearInterval(shotTimer);
  if ($('scAuto').checked) shotTimer = setInterval(() => { if (!document.hidden) capture(); }, 3000);
}
$('scCapture').addEventListener('click', capture);
$('scAuto').addEventListener('change', () => { applyAuto(); if ($('scAuto').checked) capture(); });
const act = (btn, action, label) => busy(btn, async () => {
  const serial = $('scSerial').value;
  if (!serial) throw new Error('No device selected');
  const p = app.project;
  if (action !== 'install' && !p.packageName) throw new Error('This project has no package name (set applicationId)');
  if (action === 'clear' && !confirm(`Clear ALL app data for ${p.packageName}?`)) return;
  if (action === 'install') toast('Installing…');
  const r = await api('/api/devices/action', { method: 'POST', body: { serial, action, projectId: p.id, packageName: p.packageName || undefined } });
  toast(`${label}: ${r.message || (r.ok ? 'ok' : 'failed')}`, r.ok ? 'ok' : 'err');
  if (r.ok && (action === 'launch' || action === 'install')) setTimeout(capture, 1500);
});
$('scInstall').addEventListener('click', act($('scInstall'), 'install', 'Install'));
$('scLaunch').addEventListener('click', act($('scLaunch'), 'launch', 'Launch'));
$('scStop').addEventListener('click', act($('scStop'), 'stop', 'Force stop'));
$('scClear').addEventListener('click', act($('scClear'), 'clear', 'Clear data'));

on('devices', (devices) => {
  const ok = devices.filter((d) => d.state === 'device');
  for (const sel of [$('lcSerial'), $('scSerial')]) {
    const cur = sel.value;
    sel.textContent = '';
    devices.forEach((d) => sel.append(new Option(`${(d.model || d.serial).replace(/_/g, ' ')} (${d.serial}) ${d.state}`, d.serial)));
    if (!devices.length && app.cfg.defaultDevice) sel.append(new Option(`${app.cfg.defaultDevice} (not connected)`, app.cfg.defaultDevice));
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    else if (ok[0]) sel.value = ok[0].serial;
  }
});

/** Reset everything when switching project. */
export function resetBottom() {
  const collapsed = pref('bottomCollapsed', false);
  lcStop();
  lcLog.clear();
  lcAll = [];
  $('lcAi').hidden = true;
  $('scImg').hidden = true;
  $('scHint').hidden = false;
  $('scSave').hidden = true;
  selected = null;
  attachBuild(null);
  showBottom(pref('bottomTab', 'build'));
  if (collapsed) toggleBottom();
}
