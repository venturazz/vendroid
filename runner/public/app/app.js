// Dashboard logic. Dynamic text is always inserted with textContent (never innerHTML).
const $ = (id) => document.getElementById(id);
const MAX_LINES = 5000;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
let cfg = { defaultPackage: '', defaultDevice: '', releaseSigning: false };

// ------------------------------------------------------------------ persisted UI settings
const STORE_KEY = 'runner.ui.v1';
const PERSIST = {
  values: ['task', 'pkg', 'quickTarget', 'lcLevel', 'lcTag', 'lcQ', 'lcPkg'],
  checks: ['oGit', 'oInstall', 'oLaunch', 'oFollow', 'oHermes', 'bScroll', 'lcScroll'],
};
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } })();
function saveSettings() {
  const s = { tab: currentTab };
  for (const id of PERSIST.values) s[id] = $(id).value;
  for (const id of PERSIST.checks) s[id] = $(id).checked;
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}
function restoreSettings() {
  for (const id of PERSIST.values) if (typeof saved[id] === 'string' && saved[id] !== '') $(id).value = saved[id];
  for (const id of PERSIST.checks) if (typeof saved[id] === 'boolean') $(id).checked = saved[id];
}
for (const id of [...PERSIST.values, ...PERSIST.checks]) $(id).addEventListener('change', saveSettings);

// ------------------------------------------------------------------ helpers
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.reload(); throw new Error('Session expired'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(data.error || data.response || data.message || `HTTP ${r.status}`);
  return data;
}
let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'err' ? 9000 : 5000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'err'); } };
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Busy-state wrapper: disables the button while the action runs. */
const busy = (btn, fn) => guard(async (...a) => {
  btn.disabled = true;
  try { await fn(...a); } finally { btn.disabled = false; }
});

class LogView {
  constructor(pre, autoId) { this.pre = pre; this.n = 0; this.autoId = autoId; }
  add(text, cls = '') {
    const d = el('div', text || ' ', cls);
    this.pre.appendChild(d);
    if (++this.n > MAX_LINES) { this.pre.removeChild(this.pre.firstChild); this.n--; }
    if ($(this.autoId).checked) this.pre.scrollTop = this.pre.scrollHeight;
  }
  clear() { this.pre.textContent = ''; this.n = 0; }
}

function renderAnalysis(box, r) {
  box.textContent = '';
  box.hidden = false;
  const a = r.analysis;
  if (!a) { box.append(el('h3', `9Router (${r.model})`), el('div', r.raw)); return; }
  box.append(el('h3', `Root cause (confidence: ${a.confidence})`), el('div', a.rootCause));
  if (a.affected.length) {
    box.append(el('h3', 'Affected'));
    const ul = el('ul'); a.affected.forEach((x) => ul.append(el('li', x))); box.append(ul);
  }
  if (a.fixSteps.length) {
    box.append(el('h3', 'Fix steps'));
    const ol = el('ol'); a.fixSteps.forEach((x) => ol.append(el('li', x))); box.append(ol);
  }
}

// ------------------------------------------------------------------ notifications
function notify(title, body) {
  if (document.hasFocus()) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/assets/favicon.svg', tag: 'runner-build' }); } catch { /* ignore */ }
  }
  flashTitle(title);
}
let flashTimer = null;
function flashTitle(msg) {
  clearInterval(flashTimer);
  let on = false;
  flashTimer = setInterval(() => { document.title = (on = !on) ? msg : 'Android Runner'; }, 1000);
  const stop = () => { clearInterval(flashTimer); document.title = 'Android Runner'; window.removeEventListener('focus', stop); };
  window.addEventListener('focus', stop);
}
function askNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

// ------------------------------------------------------------------ tabs
let currentTab = 'console';
function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  if (name !== 'screen' && $('scAuto').checked) { $('scAuto').checked = false; applyAuto(); }
  if (name === 'logcat') $('crashChip').hidden = true;
  saveSettings();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ top bar: env / devices / AI
function badge(node, text, cls, title) {
  node.textContent = text;
  node.className = `badge ${cls}`;
  if (title !== undefined) node.title = title;
}

let envData = null;
const CHECK_LABELS = {
  aarch64: 'CPU is aarch64', java: 'Java available', androidHome: 'ANDROID_HOME exists',
  adb: 'adb runs', aapt2: 'aapt2 runs (ARM64 override)', project: 'Project has gradlew',
};
const refreshEnv = guard(async () => {
  envData = await api('/api/health/env');
  const bad = Object.entries(envData.checks).filter(([, v]) => !v).map(([k]) => CHECK_LABELS[k] || k);
  badge($('envBadge'), envData.ok ? 'env ✔' : `env ⚠ ${bad.length}`, envData.ok ? 'ok' : 'warn',
    envData.ok ? 'All environment checks pass' : `Failing: ${bad.join(', ')}`);
});
$('envBadge').addEventListener('click', guard(async () => {
  await refreshEnv();
  const h = envData;
  const t = $('envTable');
  t.textContent = '';
  const row = (k, v, ok) => {
    const tr = el('tr');
    const td = el('td', v);
    if (ok !== undefined) td.className = ok ? 'okc' : 'badc';
    tr.append(el('td', k), td);
    t.append(tr);
  };
  row('Architecture', `${h.arch.uname} (node ${h.arch.nodeArch})`, h.checks.aarch64);
  row('Java', h.java.version || 'not found', h.checks.java);
  row('ANDROID_HOME', h.androidHome.path, h.checks.androidHome);
  row('adb', `${h.adb.version || 'not found'} (${h.adb.bin})`, h.checks.adb);
  row('aapt2', `${h.aapt2.version || 'not working'} - ${h.aapt2.path || ''} [${h.aapt2.source}]`, h.checks.aapt2);
  row('Project', `${h.project.path} (module ${h.project.module})`, h.checks.project);
  row('SDK bootstrap', h.sdkBootstrap, h.sdkBootstrap !== 'failed' && h.sdkBootstrap !== 'running');
  row('Disk free', `data ${h.disk.data.freeGb ?? '?'} GB, project ${h.disk.project.freeGb ?? '?'} GB`, (h.disk.data.freeGb ?? 99) > 5);
  row('Memory', `${h.memory.availableGb} GB available of ${h.memory.totalGb} GB`, h.memory.availableGb > 8);
  row('Gradle limits', `${h.limits.gradleJvmArgs} · Kotlin ${h.limits.kotlinDaemonJvmArgs} · ${h.limits.maxWorkers} workers`);
  $('envPre').textContent = JSON.stringify(h, null, 2);
  $('envDlg').showModal();
}));

let devices = [];
const onlineDevice = () => devices.find((d) => d.state === 'device');
const refreshDevices = guard(async () => {
  const r = await api('/api/devices');
  devices = r.devices;
  const ok = devices.filter((d) => d.state === 'device');
  const wd = r.watchdog;
  const wdText = wd?.enabled ? `\nAuto-reconnect ${wd.target}: ${wd.paused ? 'paused (manually disconnected)' : wd.state}${wd.message ? ` - ${wd.message}` : ''}` : '';
  let label = '📱 no device';
  let cls = 'err';
  if (ok.length) { label = `📱 ${ok.map((d) => (d.model || d.serial).replace(/_/g, ' ')).join(', ')}`; cls = 'ok'; }
  else if (devices.length) { label = `📱 ${devices[0].state}`; cls = 'warn'; }
  else if (wd?.enabled && !wd.paused) { label = `📱 ${wd.state === 'unknown' ? 'connecting…' : wd.state}`; cls = 'warn'; }
  badge($('devBadge'), label, cls, devices.map((d) => `${d.serial} ${d.state}`).join('\n') + wdText);
  for (const sel of [$('lcSerial'), $('scSerial')]) {
    const cur = sel.value;
    sel.textContent = '';
    devices.forEach((d) => sel.append(new Option(`${(d.model || d.serial).replace(/_/g, ' ')} (${d.serial}) ${d.state}`, d.serial)));
    if (!devices.length && cfg.defaultDevice) sel.append(new Option(`${cfg.defaultDevice} (not connected)`, cfg.defaultDevice));
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    else if (ok[0]) sel.value = ok[0].serial;
  }
});
const refreshAi = guard(async () => {
  const s = await api('/api/ai/status');
  const n = s.nineRouter.reachable;
  const h = s.hermes.reachable;
  badge($('aiBadge'), `AI 9R ${n ? '●' : '○'} Hermes ${h ? '●' : '○'}`, n && h ? 'ok' : n || h ? 'warn' : 'err',
    `9Router ${s.nineRouter.url} (${s.nineRouter.model}) ${n ? 'reachable' : 'unreachable'}\nHermes ${s.hermes.url} ${h ? 'reachable' : 'unreachable'}`);
});

const target = () => $('quickTarget').value.trim();
$('quickConnect').addEventListener('click', busy($('quickConnect'), async () => {
  const r = await api('/api/devices/connect', { method: 'POST', body: { target: target() } });
  toast(r.message || (r.ok ? 'Connected' : 'Failed'), r.ok ? 'ok' : 'err');
  saveSettings();
  await refreshDevices();
}));
$('quickTarget').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('quickConnect').click(); });
$('quickReconnect').addEventListener('click', busy($('quickReconnect'), async () => {
  const r = await api('/api/adb/restart', { method: 'POST', body: { mode: 'reconnect', serial: target() } });
  toast(r.message, r.ok ? 'ok' : 'err');
  await refreshDevices();
}));
$('adbRestart').addEventListener('click', busy($('adbRestart'), async () => {
  const r = await api('/api/adb/restart', { method: 'POST', body: { mode: 'restart-server' } });
  toast(r.message, r.ok ? 'ok' : 'err');
  await refreshDevices();
}));
$('logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); });

// ------------------------------------------------------------------ build form
function updateSignHint() {
  const release = $('task').value === 'assembleRelease';
  const hint = $('signHint');
  hint.hidden = !release || cfg.releaseSigning;
  hint.textContent = 'Release signing is not configured: the APK will be unsigned, so Auto-Install is skipped. Set RELEASE_KEYSTORE_* to enable.';
}
$('task').addEventListener('change', updateSignHint);
$('oInstall').addEventListener('change', () => { if (!$('oInstall').checked) $('oLaunch').checked = false; saveSettings(); });
$('oLaunch').addEventListener('change', () => { if ($('oLaunch').checked) $('oInstall').checked = true; saveSettings(); });

function buildBody(overrides = {}) {
  const pkgName = $('pkg').value.trim();
  const task = overrides.task || $('task').value;
  const unsignedRelease = task === 'assembleRelease' && !cfg.releaseSigning;
  const dev = onlineDevice()?.serial || target() || cfg.defaultDevice;
  const install = $('oInstall').checked && !unsignedRelease;
  return {
    task,
    gitPullBeforeBuild: $('oGit').checked,
    autoInstallAfterBuild: install,
    autoLaunchAfterInstall: install && $('oLaunch').checked,
    autoNotifyHermes: $('oHermes').checked,
    ...(pkgName ? { packageName: pkgName } : {}),
    ...(dev ? { deviceSerial: dev } : {}),
    ...overrides,
  };
}

// ------------------------------------------------------------------ builds
const bLog = new LogView($('bLog'), 'bScroll');
let selected = null;
let es = null;
let timer = null;
let selRec = null;
let buildActive = null;
const lastStates = new Map(); // id -> state, to detect transitions for notifications
const followAfter = new Set(); // build ids that should open logcat when they launch

function setBuildState(s) {
  selRec = s;
  $('bState').textContent = s.state;
  $('bState').className = `pill ${s.state}`;
  $('bId').textContent = `${s.task} · ${s.id}`;
  $('bCommit').textContent = s.commit ? `${s.commit.sha} ${s.commit.subject}` : '';
  $('bLogDl').hidden = false;
  $('bLogDl').href = `/api/builds/${s.id}/log`;
  clearInterval(timer);
  const tick = () => {
    if (!s.startedAt) { $('bTimer').textContent = '00:00'; return; }
    const end = s.finishedAt ? Date.parse(s.finishedAt) : Date.now();
    $('bTimer').textContent = fmtDur(end - Date.parse(s.startedAt));
  };
  tick();
  if (!s.finishedAt) timer = setInterval(tick, 1000);
  updateButtons();
}
function updateButtons() {
  const selRunning = selRec && !TERMINAL.includes(selRec.state);
  $('btnCancel').disabled = !selRunning;
  $('btnBuild').textContent = buildActive ? 'Queue another build' : 'Build & Deploy';
  $('btnAnalyze').disabled = !selRec || selRec.state !== 'failed';
  $('btnInvestigate').disabled = !selRec || selRec.state !== 'failed';
}

const LINE_CLASS = [
  [/^=== |^\$ /, 'mark'],
  [/^e: |error:|FAILED|BUILD FAILED|Exception|^Failure/, 'err'],
  [/^w: |warning:/i, 'W'],
  [/BUILD SUCCESSFUL|^Success|^APK: /, 'ok'],
];
const lineClass = (t) => (LINE_CLASS.find(([re]) => re.test(t)) || [null, ''])[1];

function attach(id) {
  if (es) es.close();
  selected = id;
  bLog.clear();
  $('aiOut').hidden = true;
  es = new EventSource(`/api/builds/${id}/stream`);
  es.addEventListener('line', (e) => {
    const t = e.data ? JSON.parse(e.data) : '';
    bLog.add(t, lineClass(t));
  });
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    observe(s);
    if (s.id === selected) setBuildState(s);
    refreshHistory();
  });
  es.addEventListener('end', () => { es.close(); es = null; refreshHistory(); });
  renderHistorySel();
}

function observe(b) {
  onTransition(b, lastStates.get(b.id));
  lastStates.set(b.id, b.state);
}
function onTransition(b, prev) {
  if (prev === undefined || prev === b.state) return;
  const launched = b.state === 'launching' || (b.state === 'succeeded' && b.options?.autoLaunchAfterInstall);
  if (launched && followAfter.has(b.id)) {
    followAfter.delete(b.id);
    const pkgName = b.packageName || $('pkg').value.trim();
    if (pkgName) { $('lcPkg').value = pkgName; }
    if (b.deviceSerial && [...$('lcSerial').options].some((o) => o.value === b.deviceSerial)) $('lcSerial').value = b.deviceSerial;
    showTab('logcat');
    lcStart(true);
  }
  if (TERMINAL.includes(b.state)) {
    const dur = b.startedAt && b.finishedAt ? ` in ${fmtDur(Date.parse(b.finishedAt) - Date.parse(b.startedAt))}` : '';
    const msg = b.state === 'succeeded' ? `✅ Build succeeded${dur}` : b.state === 'failed' ? `❌ Build failed${dur}` : '⏹ Build cancelled';
    notify(msg, `${b.task}${b.error ? ` - ${b.error}` : ''}`);
    if (b.state === 'failed') toast(`${msg}: ${b.error || ''}. Try "Analyze Error (9Router)".`, 'err');
    else if (b.state === 'succeeded') toast(msg, 'ok');
    followAfter.delete(b.id);
  }
}

function historyItem(b) {
  const li = el('li');
  li.dataset.id = b.id;
  const l1 = el('div', undefined, 'l1');
  l1.append(el('span', b.task), el('span', b.state, `pill ${b.state}`));
  const meta = el('div', undefined, 'meta muted');
  meta.append(el('span', fmtTime(b.createdAt)));
  if (b.startedAt && b.finishedAt) meta.append(el('span', fmtDur(Date.parse(b.finishedAt) - Date.parse(b.startedAt))));
  if (b.trigger && b.trigger !== 'manual') meta.append(el('span', b.trigger === 'webhook' ? `push ${b.ref || ''}` : b.trigger, 'tag'));
  if (b.signed === true) meta.append(el('span', 'signed', 'tag'));
  li.append(l1, meta);
  if (b.commit) li.append(el('div', `${b.commit.sha} ${b.commit.subject}`, 'commit'));
  const acts = el('div', undefined, 'acts');
  if (b.apk) {
    const a = el('a', `⬇ APK ${fmtSize(b.apk.size)}`, 'btn');
    a.href = `/api/builds/${b.id}/apk`;
    a.title = b.apk.name;
    a.addEventListener('click', (e) => e.stopPropagation());
    acts.append(a);
    const inst = el('button', 'Install');
    inst.title = 'Install this APK on the selected device';
    inst.addEventListener('click', (e) => { e.stopPropagation(); installBuild(b.id, inst); });
    acts.append(inst);
  }
  if (TERMINAL.includes(b.state)) {
    const rr = el('button', '↻ Re-run');
    rr.title = 'Run again with the same task and options';
    rr.addEventListener('click', guard(async (e) => {
      e.stopPropagation();
      await startBuild({ task: b.task, ...b.options });
    }));
    acts.append(rr);
  }
  li.append(acts);
  li.addEventListener('click', () => attach(b.id));
  return li;
}

async function refreshHistory() {
  let r;
  try { r = await api('/api/builds'); } catch { return; }
  buildActive = r.active;
  const ul = $('history');
  ul.textContent = '';
  for (const b of r.builds) {
    observe(b);
    ul.append(historyItem(b));
  }
  $('histEmpty').hidden = r.builds.length > 0;
  renderHistorySel();
  updateButtons();
  if (!selected && r.builds.length) attach(r.active || r.builds[0].id);
}
function renderHistorySel() {
  document.querySelectorAll('#history li').forEach((li) => li.classList.toggle('sel', li.dataset.id === selected));
}

async function startBuild(overrides = {}) {
  askNotifyPermission();
  const body = buildBody(overrides);
  const b = await api('/api/builds', { method: 'POST', body });
  lastStates.set(b.id, b.state);
  if ($('oFollow').checked && body.autoLaunchAfterInstall) followAfter.add(b.id);
  showTab('console');
  await refreshHistory();
  attach(b.id);
}
$('btnBuild').addEventListener('click', busy($('btnBuild'), () => startBuild()));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('btnBuild').click(); }
});
$('btnCancel').addEventListener('click', busy($('btnCancel'), async () => {
  const s = await api(`/api/builds/${selected}/cancel`, { method: 'POST' });
  toast(`Cancel requested (${s.state})`);
}));
$('btnAnalyze').addEventListener('click', busy($('btnAnalyze'), async () => {
  if (!selected) throw new Error('Select a build first');
  $('aiOut').hidden = false;
  $('aiOut').textContent = 'Asking 9Router…';
  try {
    renderAnalysis($('aiOut'), await api('/api/ai/analyze', { method: 'POST', body: { mode: 'build_error', jobId: selected } }));
  } catch (e) { $('aiOut').textContent = `9Router: ${e.message}`; throw e; }
}));
$('btnInvestigate').addEventListener('click', busy($('btnInvestigate'), async () => {
  if (!selected) throw new Error('Select a build first');
  const r = await api('/api/ai/hermes-investigate', {
    method: 'POST', body: { jobId: selected, packageName: $('pkg').value.trim() || undefined },
  });
  toast(`Sent to Hermes (HTTP ${r.status}). It will investigate asynchronously.`, 'ok');
}));

async function installBuild(buildId, btn) {
  const serial = $('scSerial').value || onlineDevice()?.serial;
  if (!serial) return toast('No device connected', 'err');
  btn.disabled = true;
  try {
    toast('Installing…');
    const r = await api('/api/devices/action', { method: 'POST', body: { serial, action: 'install', buildId } });
    toast(`Install: ${r.message || (r.ok ? 'ok' : 'failed')}`, r.ok ? 'ok' : 'err');
  } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
}

// ------------------------------------------------------------------ logcat
const lcLog = new LogView($('lcLog'), 'lcScroll');
let lcES = null;
let lcPaused = false;
let lcPending = [];
let lcAll = [];
const LC_CAP = 20000;
const CRASH_RE = /FATAL EXCEPTION|ANR in |Fatal signal \d+/;

function lcPush(lines) {
  for (const l of lines) {
    lcAll.push(l.text);
    if (lcAll.length > LC_CAP) lcAll.shift();
    lcLog.add(l.text, l.level);
    if (CRASH_RE.test(l.text)) onCrash(l.text);
  }
}
let lastCrashToast = 0;
function onCrash(text) {
  if (currentTab !== 'logcat') $('crashChip').hidden = false;
  if (Date.now() - lastCrashToast > 10_000) {
    lastCrashToast = Date.now();
    toast(`Crash detected: ${text.slice(0, 140)}\nClick "Triage Crash (9Router)" for a diagnosis.`, 'err');
    notify('💥 App crashed', text.slice(0, 120));
  }
}
function lcStop() {
  if (lcES) lcES.close();
  lcES = null;
  $('lcStart').textContent = 'Start';
  $('lcPause').disabled = true;
  $('lcStatus').textContent = 'stopped';
}
function lcStart(quiet = false) {
  lcStop();
  const serial = $('lcSerial').value;
  if (!serial) { if (!quiet) toast('No device selected', 'err'); return; }
  const q = new URLSearchParams({ serial, level: $('lcLevel').value, tag: $('lcTag').value.trim(), q: $('lcQ').value.trim() });
  if ($('lcPkg').value.trim()) q.set('package', $('lcPkg').value.trim());
  lcES = new EventSource(`/api/logcat/stream?${q}`);
  $('lcStatus').textContent = 'connecting…';
  lcES.addEventListener('ready', (e) => {
    const d = JSON.parse(e.data);
    $('lcStatus').textContent = `streaming${d.pid ? ` · pid ${d.pid}` : $('lcPkg').value.trim() ? ' · app not running, matching by name' : ''}`;
  });
  lcES.addEventListener('lines', (e) => { const l = JSON.parse(e.data); if (lcPaused) lcPending.push(...l); else lcPush(l); });
  lcES.addEventListener('error', (e) => { if (e.data) toast(JSON.parse(e.data).message, 'err'); });
  lcES.addEventListener('end', lcStop);
  lcES.onerror = () => { if (lcES && lcES.readyState === EventSource.CLOSED) lcStop(); };
  $('lcStart').textContent = 'Stop';
  $('lcPause').disabled = false;
  saveSettings();
}
$('lcStart').addEventListener('click', () => (lcES ? lcStop() : lcStart()));
for (const id of ['lcLevel', 'lcSerial', 'lcTag', 'lcQ', 'lcPkg']) $(id).addEventListener('change', () => lcES && lcStart());
$('lcPause').addEventListener('click', () => {
  lcPaused = !lcPaused;
  $('lcPause').textContent = lcPaused ? `Resume` : 'Pause';
  if (!lcPaused) { lcPush(lcPending); lcPending = []; }
});
$('lcClear').addEventListener('click', guard(async () => {
  lcLog.clear(); lcAll = []; lcPending = [];
  $('lcAi').hidden = true;
  const serial = $('lcSerial').value;
  if (serial) await api('/api/logcat/clear', { method: 'POST', body: { serial } });
}));
$('lcExport').addEventListener('click', () => {
  if (!lcAll.length) return toast('Nothing to export yet');
  const blob = new Blob([lcAll.join('\n') + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `logcat-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
const crashText = () => {
  const text = lcAll.slice(-1500).join('\n');
  if (!text) throw new Error('No logcat lines captured yet. Start the stream and reproduce the crash.');
  return text;
};
$('lcTriage').addEventListener('click', busy($('lcTriage'), async () => {
  const text = crashText();
  $('lcAi').hidden = false;
  $('lcAi').textContent = 'Asking 9Router…';
  try {
    renderAnalysis($('lcAi'), await api('/api/ai/analyze', { method: 'POST', body: { mode: 'logcat_crash', text } }));
  } catch (e) { $('lcAi').textContent = `9Router: ${e.message}`; throw e; }
}));
$('lcHermes').addEventListener('click', busy($('lcHermes'), async () => {
  const r = await api('/api/ai/hermes-investigate', {
    method: 'POST',
    body: {
      crashSnippet: crashText(),
      packageName: $('lcPkg').value.trim() || $('pkg').value.trim() || undefined,
      deviceSerial: $('lcSerial').value || undefined,
    },
  });
  toast(`Sent to Hermes (HTTP ${r.status}).`, 'ok');
}));

// ------------------------------------------------------------------ screen & actions
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
    $('scSave').download = `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
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
  const body = { serial, action, packageName: $('pkg').value.trim() || cfg.defaultPackage || undefined };
  if (action === 'clear' && !confirm(`Clear ALL app data for ${body.packageName}?`)) return;
  if (action === 'install') toast('Installing…');
  const r = await api('/api/devices/action', { method: 'POST', body });
  toast(`${label}: ${r.message || (r.ok ? 'ok' : 'failed')}`, r.ok ? 'ok' : 'err');
  if (r.ok && (action === 'launch' || action === 'install') && $('scAuto').checked === false) setTimeout(capture, 1500);
});
$('scInstall').addEventListener('click', act($('scInstall'), 'install', 'Install'));
$('scLaunch').addEventListener('click', act($('scLaunch'), 'launch', 'Launch'));
$('scStop').addEventListener('click', act($('scStop'), 'stop', 'Force stop'));
$('scClear').addEventListener('click', act($('scClear'), 'clear', 'Clear data'));

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    cfg = await api('/api/config');
  } catch (e) { toast(e.message, 'err'); }
  $('pkg').value = cfg.defaultPackage || '';
  $('quickTarget').value = cfg.defaultDevice || '';
  $('lcLevel').value = 'W';
  restoreSettings();
  updateSignHint();
  if (saved.tab && saved.tab !== 'screen') showTab(saved.tab);
  await Promise.all([refreshEnv(), refreshDevices(), refreshAi(), refreshHistory()]);
  setInterval(refreshDevices, 10_000);
  setInterval(refreshAi, 30_000);
  setInterval(refreshEnv, 120_000);
  setInterval(() => { if (!document.hidden || buildActive) refreshHistory(); }, 4_000);
})();
