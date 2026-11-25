// Dashboard logic. All dynamic text is inserted with textContent (no innerHTML).
const $ = (id) => document.getElementById(id);
const MAX_LINES = 5000;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
let cfg = { defaultPackage: '', defaultDevice: '' };

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
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'err'); } };
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

class LogView {
  constructor(pre) { this.pre = pre; this.n = 0; this.auto = () => true; }
  add(text, cls = '') {
    const d = el('div', text || ' ', cls);
    this.pre.appendChild(d);
    if (++this.n > MAX_LINES) { this.pre.removeChild(this.pre.firstChild); this.n--; }
    if (this.auto()) this.pre.scrollTop = this.pre.scrollHeight;
  }
  clear() { this.pre.textContent = ''; this.n = 0; }
}
function renderAnalysis(box, r) {
  box.textContent = '';
  box.hidden = false;
  const a = r.analysis;
  if (!a) { box.append(el('h3', `9Router (${r.model})`), el('div', r.raw)); return; }
  box.append(el('h3', `Root cause (confidence: ${a.confidence})`), el('div', a.rootCause));
  if (a.affected.length) { box.append(el('h3', 'Affected')); const ul = el('ul'); a.affected.forEach((x) => ul.append(el('li', x))); box.append(ul); }
  if (a.fixSteps.length) { box.append(el('h3', 'Fix steps')); const ol = el('ol'); a.fixSteps.forEach((x) => ol.append(el('li', x))); box.append(ol); }
}

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
  if (b.dataset.tab !== 'screen') $('scAuto').checked = false;
}));

// ------------------------------------------------------------------ top bar: env / devices / AI
function badge(el_, text, cls) { el_.textContent = text; el_.className = `badge ${cls}`; }

const refreshEnv = guard(async () => {
  const h = await api('/api/health/env');
  window.__env = h;
  badge($('envBadge'), h.ok ? 'env ✔' : 'env ⚠', h.ok ? 'ok' : 'warn');
});
$('envBadge').addEventListener('click', guard(async () => {
  await refreshEnv();
  $('envPre').textContent = JSON.stringify(window.__env, null, 2);
  $('envDlg').showModal();
}));

let devices = [];
const refreshDevices = guard(async () => {
  devices = (await api('/api/devices')).devices;
  const ok = devices.filter((d) => d.state === 'device');
  badge($('devBadge'), ok.length ? `📱 ${ok.map((d) => d.model || d.serial).join(', ')}` : devices.length ? `📱 ${devices[0].state}` : '📱 no device', ok.length ? 'ok' : devices.length ? 'warn' : 'err');
  for (const sel of [$('lcSerial'), $('scSerial')]) {
    const cur = sel.value;
    sel.textContent = '';
    devices.forEach((d) => sel.append(new Option(`${d.model || d.serial} (${d.serial}) ${d.state}`, d.serial)));
    if (!devices.length && cfg.defaultDevice) sel.append(new Option(cfg.defaultDevice, cfg.defaultDevice));
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }
});
const refreshAi = guard(async () => {
  const s = await api('/api/ai/status');
  const n = s.nineRouter.reachable, h = s.hermes.reachable;
  badge($('aiBadge'), `AI 9R ${n ? '●' : '○'} Hermes ${h ? '●' : '○'}`, n && h ? 'ok' : n || h ? 'warn' : 'err');
  $('aiBadge').title = `9Router ${s.nineRouter.url} (${s.nineRouter.model})\nHermes ${s.hermes.url}`;
});

const target = () => $('quickTarget').value.trim();
$('quickConnect').addEventListener('click', guard(async () => {
  const r = await api('/api/devices/connect', { method: 'POST', body: { target: target() } });
  toast(r.message || (r.ok ? 'Connected' : 'Failed'), r.ok ? 'ok' : 'err');
  refreshDevices();
}));
$('quickReconnect').addEventListener('click', guard(async () => {
  const r = await api('/api/adb/restart', { method: 'POST', body: { mode: 'reconnect', serial: target() } });
  toast(r.message, r.ok ? 'ok' : 'err');
  refreshDevices();
}));
$('adbRestart').addEventListener('click', guard(async () => {
  const r = await api('/api/adb/restart', { method: 'POST', body: { mode: 'restart-server' } });
  toast(r.message, r.ok ? 'ok' : 'err');
  refreshDevices();
}));
$('logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); });

// ------------------------------------------------------------------ builds
const bLog = new LogView($('bLog'));
bLog.auto = () => $('bScroll').checked;
let selected = null; // build id shown in console
let es = null;
let timer = null;
let selRec = null;
let buildActive = null;

function setBuildState(s) {
  selRec = s;
  $('bState').textContent = s.state;
  $('bState').className = `pill ${s.state}`;
  $('bId').textContent = s.id;
  clearInterval(timer);
  const tick = () => {
    if (!s.startedAt) return ($('bTimer').textContent = '00:00');
    const end = s.finishedAt ? Date.parse(s.finishedAt) : Date.now();
    $('bTimer').textContent = fmtDur(end - Date.parse(s.startedAt));
  };
  tick();
  if (!s.finishedAt) timer = setInterval(tick, 1000);
  updateButtons();
}
function updateButtons() {
  const running = !!buildActive || (selRec && !TERMINAL.includes(selRec.state));
  $('btnCancel').disabled = !(selRec && !TERMINAL.includes(selRec.state));
  $('btnBuild').textContent = running ? 'Queue another build' : 'Build & Deploy';
}

function attach(id) {
  if (es) es.close();
  selected = id;
  bLog.clear();
  $('aiOut').hidden = true;
  es = new EventSource(`/api/builds/${id}/stream`);
  es.addEventListener('line', (e) => {
    const t = e.data ? JSON.parse(e.data) : '';
    const cls = /^=== /.test(t) ? 'mark' : /^e: |error:|FAILED|BUILD FAILED|Exception/.test(t) ? 'err' : /BUILD SUCCESSFUL|^Success/.test(t) ? 'ok' : /^\$ /.test(t) ? 'mark' : '';
    bLog.add(t, cls);
  });
  es.addEventListener('state', (e) => { setBuildState(JSON.parse(e.data)); refreshHistory(); });
  es.addEventListener('end', () => { es.close(); es = null; refreshHistory(); });
  renderHistorySel();
}

async function refreshHistory() {
  let r;
  try { r = await api('/api/builds'); } catch { return; }
  buildActive = r.active;
  const ul = $('history');
  ul.textContent = '';
  for (const b of r.builds) {
    const li = el('li');
    li.dataset.id = b.id;
    const l1 = el('div', undefined, 'l1');
    l1.append(el('span', b.task), el('span', b.state, `pill ${b.state}`));
    const l2 = el('div', new Date(b.createdAt).toLocaleString(), 'muted');
    li.append(l1, l2);
    if (b.apk) {
      const a = el('a', `⬇ ${b.apk.name}`);
      a.href = `/api/builds/${b.id}/apk`;
      a.addEventListener('click', (e) => e.stopPropagation());
      li.append(a);
    }
    li.addEventListener('click', () => attach(b.id));
    ul.append(li);
  }
  renderHistorySel();
  updateButtons();
  if (!selected && r.builds.length) attach(r.active || r.builds[0].id);
}
function renderHistorySel() {
  document.querySelectorAll('#history li').forEach((li) => li.classList.toggle('sel', li.dataset.id === selected));
}

$('btnBuild').addEventListener('click', guard(async () => {
  const pkgName = $('pkg').value.trim();
  const b = await api('/api/builds', {
    method: 'POST',
    body: {
      task: $('task').value,
      gitPullBeforeBuild: $('oGit').checked,
      autoInstallAfterBuild: $('oInstall').checked,
      autoLaunchAfterInstall: $('oLaunch').checked,
      autoNotifyHermes: $('oHermes').checked,
      ...(pkgName ? { packageName: pkgName } : {}),
      ...(devices.find((d) => d.state === 'device') ? { deviceSerial: devices.find((d) => d.state === 'device').serial } : {}),
    },
  });
  await refreshHistory();
  attach(b.id);
}));
$('btnCancel').addEventListener('click', guard(async () => {
  const s = await api(`/api/builds/${selected}/cancel`, { method: 'POST' });
  toast(`Cancel requested (${s.state})`);
}));
$('btnAnalyze').addEventListener('click', guard(async () => {
  if (!selected) throw new Error('Select a build first');
  $('aiOut').hidden = false; $('aiOut').textContent = 'Asking 9Router…';
  renderAnalysis($('aiOut'), await api('/api/ai/analyze', { method: 'POST', body: { mode: 'build_error', jobId: selected } }));
}));
$('btnInvestigate').addEventListener('click', guard(async () => {
  if (!selected) throw new Error('Select a build first');
  const r = await api('/api/ai/hermes-investigate', { method: 'POST', body: { jobId: selected, packageName: $('pkg').value.trim() || undefined } });
  toast(`Hermes accepted (HTTP ${r.status})`, 'ok');
}));

// ------------------------------------------------------------------ logcat
const lcLog = new LogView($('lcLog'));
let lcES = null;
let lcPaused = false;
let lcPending = [];
let lcAll = []; // raw text for export / triage
const LC_CAP = 20000;

function lcPush(lines) {
  for (const l of lines) {
    lcAll.push(l.text);
    if (lcAll.length > LC_CAP) lcAll.shift();
    lcLog.add(l.text, l.level);
  }
}
function lcStop() {
  if (lcES) lcES.close();
  lcES = null;
  $('lcStart').textContent = 'Start';
  $('lcPause').disabled = true;
  $('lcStatus').textContent = 'stopped';
}
function lcStart() {
  lcStop();
  const serial = $('lcSerial').value;
  if (!serial) return toast('No device selected', 'err');
  const q = new URLSearchParams({ serial, level: $('lcLevel').value, tag: $('lcTag').value.trim(), q: $('lcQ').value.trim() });
  if ($('lcPkg').value.trim()) q.set('package', $('lcPkg').value.trim());
  lcES = new EventSource(`/api/logcat/stream?${q}`);
  lcES.addEventListener('ready', (e) => { const d = JSON.parse(e.data); $('lcStatus').textContent = `streaming${d.pid ? ` pid ${d.pid}` : ''}`; });
  lcES.addEventListener('lines', (e) => { const l = JSON.parse(e.data); if (lcPaused) lcPending.push(...l); else lcPush(l); });
  lcES.addEventListener('error', (e) => { if (e.data) toast(JSON.parse(e.data).message, 'err'); });
  lcES.addEventListener('end', lcStop);
  lcES.onerror = () => { if (lcES && lcES.readyState === EventSource.CLOSED) lcStop(); };
  $('lcStart').textContent = 'Stop';
  $('lcPause').disabled = false;
}
$('lcStart').addEventListener('click', () => (lcES ? lcStop() : lcStart()));
for (const id of ['lcLevel', 'lcSerial']) $(id).addEventListener('change', () => lcES && lcStart());
for (const id of ['lcTag', 'lcQ', 'lcPkg']) $(id).addEventListener('change', () => lcES && lcStart());
$('lcPause').addEventListener('click', () => {
  lcPaused = !lcPaused;
  $('lcPause').textContent = lcPaused ? 'Resume' : 'Pause';
  if (!lcPaused) { lcPush(lcPending); lcPending = []; }
});
$('lcClear').addEventListener('click', guard(async () => {
  lcLog.clear(); lcAll = []; lcPending = [];
  const serial = $('lcSerial').value;
  if (serial) await api('/api/logcat/clear', { method: 'POST', body: { serial } });
}));
$('lcExport').addEventListener('click', () => {
  const blob = new Blob([lcAll.join('\n') + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `logcat-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('lcTriage').addEventListener('click', guard(async () => {
  const text = lcAll.slice(-1500).join('\n');
  if (!text) throw new Error('No logcat lines captured yet');
  $('lcAi').hidden = false; $('lcAi').textContent = 'Asking 9Router…';
  renderAnalysis($('lcAi'), await api('/api/ai/analyze', { method: 'POST', body: { mode: 'logcat_crash', text } }));
}));

// ------------------------------------------------------------------ screen & actions
let shotBusy = false;
let shotTimer = null;
let lastUrl = null;
async function capture() {
  if (shotBusy) return;
  const serial = $('scSerial').value;
  if (!serial) return toast('No device selected', 'err');
  shotBusy = true;
  try {
    const blob = await api(`/api/devices/screenshot?serial=${encodeURIComponent(serial)}`);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    $('scImg').src = lastUrl; $('scImg').hidden = false; $('scHint').hidden = true;
  } catch (e) { toast(e.message, 'err'); $('scAuto').checked = false; applyAuto(); }
  finally { shotBusy = false; }
}
function applyAuto() {
  clearInterval(shotTimer);
  if ($('scAuto').checked) shotTimer = setInterval(capture, 3000);
}
$('scCapture').addEventListener('click', capture);
$('scAuto').addEventListener('change', () => { applyAuto(); if ($('scAuto').checked) capture(); });
const act = (action, label) => guard(async () => {
  const serial = $('scSerial').value;
  const body = { serial, action, packageName: $('pkg').value.trim() || cfg.defaultPackage || undefined };
  if (action === 'clear' && !confirm(`Clear ALL data for ${body.packageName}?`)) return;
  const r = await api('/api/devices/action', { method: 'POST', body });
  toast(`${label}: ${r.message || (r.ok ? 'ok' : 'failed')}`, r.ok ? 'ok' : 'err');
});
$('scInstall').addEventListener('click', act('install', 'Install'));
$('scLaunch').addEventListener('click', act('launch', 'Launch'));
$('scStop').addEventListener('click', act('stop', 'Force stop'));
$('scClear').addEventListener('click', act('clear', 'Clear data'));

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    cfg = await api('/api/config');
    $('pkg').value = cfg.defaultPackage;
    $('quickTarget').value = cfg.defaultDevice;
  } catch (e) { toast(e.message, 'err'); }
  await Promise.all([refreshEnv(), refreshDevices(), refreshAi(), refreshHistory()]);
  setInterval(refreshDevices, 10_000);
  setInterval(refreshAi, 30_000);
  setInterval(refreshEnv, 120_000);
  setInterval(refreshHistory, 5_000);
})();
