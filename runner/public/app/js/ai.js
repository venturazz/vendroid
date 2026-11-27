// AI coding panel: chat with 9Router about the active project, review proposed edits as diffs,
// apply with one click (with undo), or hand the task to Hermes Agent.
import { $, app, api, pApi, el, toast, guard, busy, postStream, renderDiff, emit, on, pref, setPref, actionButton, notify, perFrame } from './core.js';
import { selectionText, openTabs, openFile, saveAll, reloadFromDisk } from './editor.js';

const extraContext = new Set();
let sending = null; // AbortController
let currentFile = null;
let latestFailedBuild = null;

export function setLatestFailedBuild(id) { latestFailedBuild = id; }

export function toggleAi(show = $('aipanel').hidden, { reveal = true } = {}) {
  if (reveal) emit('reveal', show ? 'ai' : 'code');
  $('aipanel').hidden = !show;
  $('aiResizer').hidden = !show;
  setPref('aiOpen', show);
  if (show && reveal) $('aiInput').focus();
}

// ---- engines (Settings → AI providers)
let providers = [];
const engine = () => providers.find((p) => p.id === $('aiEngine').value) || providers[0];
export async function loadEngines() {
  try { providers = (await api('/api/ai/providers')).providers; } catch { providers = []; }
  const sel = $('aiEngine');
  const want = pref(`aiEngine:${app.project?.id}`, pref('aiEngine', ''));
  sel.textContent = '';
  for (const p of providers) sel.append(new Option(`${p.kind === 'hermes' ? '🪽 ' : ''}${p.name}${p.builtin ? '' : ' ·'}`, p.id));
  if (!providers.length) sel.append(new Option('No AI provider (Settings)', ''));
  if (providers.some((p) => p.id === want)) sel.value = want;
  else if (providers.some((p) => p.kind === 'hermes')) sel.value = providers.find((p) => p.kind === 'hermes').id; // prefer Hermes when nothing was picked yet
  onEngineChange(false);
}
function onEngineChange(save = true) {
  const p = engine();
  if (save && p) { setPref(`aiEngine:${app.project?.id}`, p.id); setPref('aiEngine', p.id); }
  $('aiModel').value = pref(`aiModel:${p?.id}`, '');
  renderMeter();
  $('aiModel').placeholder = p?.model ? `default: ${p.model}` : 'model';
  $('aiHermes').hidden = p?.kind === 'hermes';
  $('aiInput').placeholder = p?.kind === 'hermes'
    ? 'Chat with Hermes: it edits, builds and tests through Vendroid itself (Enter to send)'
    : 'Describe a screen, feature or fix… (Enter to send, Shift+Enter for a new line)';
  const dl = $('aiModels');
  dl.textContent = '';
  if (p) api(`/api/ai/providers/${encodeURIComponent(p.id)}/models`).then((r) => r.models.forEach((m) => dl.append(el('option', { value: m })))).catch(() => {});
}
$('aiEngine').addEventListener('change', () => onEngineChange());
$('aiModel').addEventListener('change', () => { const p = engine(); if (p) setPref(`aiModel:${p.id}`, $('aiModel').value.trim()); });
on('providers-changed', () => loadEngines());

function toolRow(box, ev) {
  let row = box.querySelector(`[data-call="${CSS.escape(ev.toolCallId || '')}"]`);
  if (!row) {
    row = el('div', { class: 'toolrow', dataset: { call: ev.toolCallId || '' } },
      el('span', { class: 'st', text: '⏳' }), el('span', { class: 'lbl', text: `${ev.emoji || '🔧'} ${ev.label || ev.tool}` }));
    box.append(row);
  }
  if (ev.status === 'completed') { row.classList.add('done'); row.querySelector('.st').textContent = '✔'; }
  if (ev.status === 'failed' || ev.status === 'error') { row.classList.add('done', 'fail'); row.querySelector('.st').textContent = '✖'; }
}

/** Collapsible block: summary line + body. Open while the turn runs, folded when it ends. */
function foldBox(cls, title, open) {
  const body = el('div', { class: 'fold-body' });
  const sum = el('summary', { text: title });
  const d = el('details', { class: `fold ${cls}` }, sum, body);
  d.open = open;
  return { d, sum, body };
}
function activitySummary(act, { running = false, status = '', secs } = {}) {
  const rows = act.body.querySelectorAll('.toolrow');
  const busy = [...rows].filter((r) => !r.classList.contains('done')).length;
  const failed = act.body.querySelectorAll('.toolrow.fail').length;
  const n = rows.length;
  const parts = [running ? (busy ? `⏳ ${busy} running` : '⟳ working') : '✓ done', `${n} tool call${n === 1 ? '' : 's'}`];
  if (failed) parts.push(`${failed} failed`);
  if (secs !== undefined) parts.push(`${secs}s`);
  if (status) parts.push(status);
  act.sum.textContent = `Activity · ${parts.join(' · ')}`;
  act.d.hidden = !n && !status && !running;
}

// ---- context meter (pane header)
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
function renderMeter(u) {
  const p = engine();
  const m = $('aiMeter');
  if (!p || !app.project) { m.hidden = true; return; }
  const key = `aiUsage:${app.project.id}:${p.id}`;
  if (u) setPref(key, u); else u = pref(key, null);
  if (!u) { m.hidden = true; return; }
  m.hidden = false;
  const bar = m.querySelector('.fill');
  const label = m.querySelector('.lbl');
  if (u.contextTokens !== undefined) {
    const pct = u.contextWindow ? Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 100)) : null;
    label.textContent = pct === null ? `ctx ${u.estimated ? '~' : ''}${fmtK(u.contextTokens)}` : `ctx ${pct}%`;
    bar.style.width = `${pct ?? 0}%`;
    m.className = `meter${pct >= 85 ? ' bad' : pct >= 60 ? ' warn' : ''}`;
    m.title = `Context of the last request: ${u.estimated ? 'about ' : ''}${u.contextTokens.toLocaleString()} tokens`
      + (u.contextWindow ? ` of ${u.contextWindow.toLocaleString()} (${pct}%)` : '\nSet the model\'s context window in Settings → AI providers to see a percentage')
      + `\nOutput: ${u.outputTokens.toLocaleString()} tokens. Only the last 12 messages are sent, so old turns drop out.`;
  } else {
    label.textContent = `${fmtK(u.sessionInputTokens + u.sessionOutputTokens)} tok`;
    bar.style.width = '0%';
    m.className = 'meter';
    m.title = `Hermes session total: ${u.sessionInputTokens.toLocaleString()} input + ${u.sessionOutputTokens.toLocaleString()} output tokens across all model calls of this chat.\nHermes does not report its current context size over the API; it compacts the conversation by itself when it gets full.`;
  }
}

function approvalCard(ev, prov) {
  const choices = ev.choices || ['once', 'deny'];
  const label = { once: 'Allow once', session: 'Allow this chat', always: 'Always allow', deny: 'Deny' };
  const card = el('div', { class: 'approval' },
    el('b', { text: '⚠ Hermes asks for permission' }),
    el('div', { text: ev.description || ev.command || ev.tool || 'Tool call' }));
  const row = el('div', { class: 'row' });
  for (const c of choices) {
    row.append(actionButton({ class: c === 'deny' ? 'danger' : c === 'once' ? 'primary' : '', text: label[c] || c }, async () => {
      await pApi('/ai/hermes-approval', { method: 'POST', body: { providerId: prov.id, runId: ev.run_id || ev.runId, choice: c, requestId: ev.request_id || ev.prompt_id, executionGeneration: ev.execution_generation } });
      row.replaceWith(el('div', { class: 'muted', text: c === 'deny' ? '✖ Denied' : `✔ ${label[c]}` }));
    }));
  }
  card.append(row);
  return card;
}

export async function loadAi() {
  extraContext.clear();
  await loadEngines();
  renderCtx();
  const box = $('aiMessages');
  box.textContent = '';
  let msgs = [];
  try { msgs = (await pApi('/ai/history')).messages; } catch { /* none */ }
  if (!msgs.length) { renderEmpty(); resumeActive(); return; }
  for (const m of msgs) box.append(messageEl(m.role, m.content, { context: m.context, engine: m.engine, tools: m.tools }));
  box.scrollTop = box.scrollHeight;
  resumeActive();
}

function renderEmpty() {
  const examples = app.project.ui === 'compose'
    ? ['Add a login screen with email + password validation and a Material 3 top app bar',
      'Turn the main screen into a to-do list with add, check and delete (stateful, survives rotation)',
      'Add a settings screen with a dark-mode switch and navigate to it from a top bar icon']
    : ['Add a RecyclerView list of items with a floating action button that adds a new item',
      'Create a login activity with Material text fields and input validation',
      'Add a bottom navigation bar with Home, Search and Profile fragments'];
  $('aiMessages').append(el('div', { class: 'ai-empty' },
    el('p', { text: `Describe what to build in ${app.project.name}. The assistant sees the project structure, the open file and any files you add, and proposes edits you can review and apply.` }),
    ...examples.map((t) => el('button', { class: 'ghost', text: `💡 ${t}`, onclick: () => { $('aiInput').value = t; $('aiInput').focus(); } }))));
}

// ---- message rendering: text + fenced code; edit blocks become chips (the diff card shows them)
function renderBody(text, body) {
  body.textContent = '';
  const lines = text.split('\n');
  let buf = [];
  const flush = () => { if (buf.length) { body.append(buf.join('\n')); buf = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^<{5,9} ?SEARCH\s*$/.test(l.trim())) {
      // previous non-empty line is the path
      let p = '';
      while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
      if (buf.length && !/^```/.test(buf[buf.length - 1].trim())) p = buf.pop();
      while (buf.length && /^```/.test(buf[buf.length - 1].trim())) buf.pop();
      flush();
      let j = i + 1;
      while (j < lines.length && !/^>{5,9} ?REPLACE\s*$/.test(lines[j].trim())) j++;
      body.append(el('span', { class: 'editref', text: `✎ ${p.replace(/[`*]/g, '').trim() || 'edit'}${j >= lines.length ? ' (writing…)' : ''}` }), '\n');
      i = j;
      if (lines[i + 1] && /^```\s*$/.test(lines[i + 1].trim())) i++;
      continue;
    }
    if (/^```/.test(l.trim())) {
      flush();
      const code = [];
      let j = i + 1;
      for (; j < lines.length && !/^```\s*$/.test(lines[j].trim()); j++) code.push(lines[j]);
      body.append(el('pre', { text: code.join('\n') }));
      i = j;
      continue;
    }
    buf.push(l);
  }
  flush();
}

function messageEl(role, content, { context, engine: eng, tools } = {}) {
  const body = el('div', { class: 'body' });
  if (role === 'assistant') renderBody(content, body); else body.textContent = content;
  return el('div', { class: `msg ${role}` },
    el('div', { class: 'who', text: role === 'user' ? 'YOU' : (eng || 'ASSISTANT').toUpperCase() }),
    tools?.length ? (() => {
      const f = foldBox('activity', `Activity · ✓ ${tools.length} tool call${tools.length === 1 ? '' : 's'}`, false);
      f.body.append(...tools.map((t) => el('div', { class: 'toolrow done' }, el('span', { class: 'st', text: '✔' }), el('span', { class: 'lbl', text: `🔧 ${t.label || t.tool}` }))));
      return f.d;
    })() : null,
    body,
    role === 'user' && context?.length ? el('div', { class: 'ctxlist', text: `context: ${context.join(', ')}` }) : null);
}

function proposalEl(p) {
  const applied = new Set();
  let undoId = null;
  const card = el('div', { class: 'proposal' });
  const header = el('div', { class: 'ph' });
  const fileEls = [];
  const update = () => {
    for (const f of fileEls) f.row.classList.toggle('applied', applied.has(f.path));
    applyAll.disabled = applied.size === p.files.length;
    applyRun.disabled = applied.size === p.files.length;
    undoBtn.hidden = !undoId;
  };
  const doApply = async (paths, run = false) => {
    await saveAll();
    const r = await pApi('/ai/apply', { method: 'POST', body: { proposalId: p.id, ...(paths ? { files: paths } : {}) } });
    for (const f of r.files) applied.add(f.path);
    undoId = r.applyId;
    update();
    await reloadFromDisk(r.files.map((f) => f.path));
    emit('files-changed', r.files.map((f) => f.path));
    emit('fs-changed');
    toast(`Applied ${r.files.length} file${r.files.length === 1 ? '' : 's'}`, 'ok');
    if (paths?.length === 1 || r.files.length === 1) openFile(r.files[0].path).catch(() => {});
    if (run) emit('run', { install: true });
    setTimeout(update); // after actionButton re-enables the clicked button
  };
  const applyAll = actionButton({ class: 'primary small', text: `Apply all (${p.files.length})` }, () => doApply(null));
  const applyRun = actionButton({ class: 'small', text: '▶ Apply & Run', title: 'Apply all, then build, install and launch' }, () => doApply(null, true));
  const undoBtn = actionButton({ class: 'small', text: '↺ Undo', hidden: true }, async () => {
    const r = await pApi('/ai/undo', { method: 'POST', body: { applyId: undoId } });
    undoId = null;
    applied.clear();
    update();
    await reloadFromDisk(r.files);
    emit('files-changed', r.files);
    emit('fs-changed');
    toast('Reverted', 'ok');
    setTimeout(update);
  });
  header.append(el('b', { text: `Proposed changes · ${p.files.length} file${p.files.length === 1 ? '' : 's'}` }), el('span', { class: 'grow' }), undoBtn, applyRun, applyAll);
  card.append(header);
  for (const f of p.files) {
    const diff = renderDiff(f.diff);
    diff.hidden = p.files.length > 2;
    const row = el('div', { class: 'pf' },
      el('div', { class: 'pfh', onclick: () => { diff.hidden = !diff.hidden; } },
        el('span', { text: f.action === 'create' ? '＋' : '✎' }),
        el('span', { class: 'grow', text: f.path }),
        el('span', { class: 'stat' }, el('span', { class: 'a', text: `+${f.added}` }), ' ', el('span', { class: 'r', text: `-${f.removed}` })),
        actionButton({ class: 'small', text: 'Apply', onclick: (e) => e.stopPropagation() }, () => doApply([f.path]))),
      diff);
    fileEls.push({ path: f.path, row });
    card.append(row);
  }
  if (p.errors?.length) {
    card.append(el('div', { class: 'errs', text: `⚠ ${p.errors.length} edit block${p.errors.length === 1 ? '' : 's'} could not be applied: ${p.errors.map((e) => `${e.path}: ${e.error}`).join('; ')}. Ask the assistant to retry those.` }));
  }
  update();
  return card;
}

// ---- context chips
function renderCtx() {
  const box = $('aiCtx');
  box.textContent = '';
  if (currentFile) box.append(el('span', { class: 'ctxchip auto', title: 'The open file is always included' }, `📄 ${currentFile.split('/').pop()}`));
  for (const p of extraContext) {
    box.append(el('span', { class: 'ctxchip', title: p }, p.split('/').pop(), el('button', { text: '×', title: 'Remove', onclick: () => { extraContext.delete(p); renderCtx(); } })));
  }
}
on('active-file', (p) => { currentFile = p; renderCtx(); });
on('ai-add-context', (p) => { extraContext.add(p); renderCtx(); toggleAi(true); });
$('aiAddFile').addEventListener('click', guard(async () => {
  const open = openTabs().filter((p) => p !== currentFile && !extraContext.has(p));
  if (open.length) {
    for (const p of open) extraContext.add(p);
    toast(`Added ${open.length} open file${open.length === 1 ? '' : 's'} to the context. Right-click files in the Explorer to add others.`);
  } else {
    toast('Right-click a file in the Explorer → "Add to AI context"');
  }
  renderCtx();
}));

// ---- send
// A turn is a job on the server. The POST streams its events; if that connection drops (phone
// locked, proxy timeout, network blip) the turn keeps running and we re-attach to
// /ai/jobs/:id/events, which replays what we missed. Reopening the project re-attaches too.
let currentJob = null; // { id, stopped }

/** Follow a job over EventSource from event `after`; resolves when the job ends. */
function followJob(jobId, after, onEvent, signal) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/projects/${encodeURIComponent(app.project.id)}/ai/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
    let fails = 0;
    const close = (fn) => { es.close(); signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => close(resolve);
    signal?.addEventListener('abort', onAbort);
    const fwd = (name) => es.addEventListener(name, (e) => { fails = 0; onEvent(name, JSON.parse(e.data), e.lastEventId); });
    ['engine', 'run', 'delta', 'reasoning', 'tool', 'approval', 'status', 'done'].forEach(fwd);
    es.addEventListener('end', () => close(resolve));
    es.addEventListener('error', (e) => {
      if (e.data) { onEvent('error', JSON.parse(e.data), e.lastEventId); return; } // the turn failed
      // connection problem: EventSource retries by itself (with Last-Event-ID); give up if the job is gone
      if (es.readyState === EventSource.CLOSED || ++fails > 40) close(() => reject(new Error('Lost the connection to the runner')));
    });
  });
}

async function send() {
  const text = $('aiInput').value.trim();
  if (!text || sending) return;
  const prov = engine();
  if (!prov) { toast('Add an AI provider in Settings first', 'err'); return; }
  await saveAll();
  const ctx = [...new Set([currentFile, ...extraContext].filter(Boolean))];
  $('aiInput').value = '';
  setPref(`aiDraft:${app.project.id}`, '');
  await runTurn({
    text, ctx, prov,
    body: {
      providerId: prov.id, ...($('aiModel').value.trim() ? { model: $('aiModel').value.trim() } : {}),
      message: text, activeFile: currentFile || undefined, contextFiles: [...extraContext],
      selection: selectionText() || undefined,
      ...($('aiWithBuild').checked && latestFailedBuild ? { buildId: latestFailedBuild } : {}),
    },
  });
}

/** Render one turn. Either starts it (body) or attaches to a running job (job). */
async function runTurn({ text, ctx, prov, body, job }) {
  const box = $('aiMessages');
  box.querySelector('.ai-empty')?.remove();
  box.append(messageEl('user', text, { context: ctx }));
  const reply = messageEl('assistant', '', { engine: prov?.name || job?.engine });
  reply.classList.add('thinking');
  const think = foldBox('reasoning', '💭 Thinking…', true);
  think.d.hidden = true;
  const act = foldBox('activity', '', true);
  const toolsBox = act.body;
  const reasoning = think.body;
  reply.insertBefore(act.d, reply.querySelector('.body'));
  reply.insertBefore(think.d, act.d);
  const t0 = job ? Date.parse(job.startedAt) : Date.now();
  let statusText = '';
  activitySummary(act, { running: true });
  app.aiRunning = true;
  box.append(reply);
  box.scrollTop = box.scrollHeight;
  sending = new AbortController();
  $('aiSend').textContent = 'Stop';
  let acc = '';
  let thought = '';
  let last = 0;
  // Render at most once per frame: a long answer or reasoning used to be re-laid out per token.
  const paint = perFrame(() => {
    renderBody(acc, bodyEl);
    if (thought) {
      reasoning.textContent = thought.length > 20_000 ? `…${thought.slice(-20_000)}` : thought;
      reasoning.scrollTop = reasoning.scrollHeight;
    }
    activitySummary(act, { running: true, status: statusText });
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (nearEnd || stick) box.scrollTop = box.scrollHeight;
    stick = false;
  });
  let stick = true;
  let finished = false;
  let failure = null;
  let isHermes = prov?.kind === 'hermes';
  const bodyEl = reply.querySelector('.body');
  currentJob = job ? { id: job.id } : null;
  const notice = el('div', { class: 'muted small', hidden: true });
  reply.append(notice);
  const handle = (ev, data, id) => {
    if (id) last = Math.max(last, Number(id) || 0);
    if (ev === 'job') { currentJob = { id: data.id }; return; }
    if (ev === 'end') { return; }
    notice.hidden = true;
    if (ev === 'engine') isHermes = data.kind === 'hermes';
    else if (ev === 'delta') {
      acc += data.text;
      paint();
    } else if (ev === 'reasoning') {
      think.d.hidden = false;
      thought += data.text;
      paint();
    } else if (ev === 'tool') {
      // File changes reach the editor and tree through the live event stream (live.js), with exact
      // paths; reloading every tab here on each tool call flooded the runner with requests.
      toolRow(toolsBox, data);
      paint();
    } else if (ev === 'approval') {
      reply.insertBefore(approvalCard(data, prov || engine()), bodyEl); // outside the fold: never hidden
      stick = true;
      paint();
      notify('Hermes needs your approval', data.description || data.tool || '');
    } else if (ev === 'status' && data.error) {
      reply.append(el('div', { class: 'err', text: `⚠ ${data.error}` }));
    } else if (ev === 'status') {
      statusText = String(data.message || data.status || data.text || '').slice(0, 80);
      paint();
    } else if (ev === 'done') {
      finished = true;
      acc = data.message || acc;
      renderBody(acc, bodyEl);
      if (data.usage) renderMeter({ ...data.usage, contextWindow: data.contextWindow || undefined });
      if (data.proposal?.files?.length || data.proposal?.errors?.length) reply.append(proposalEl(data.proposal));
      if (data.engine === 'hermes') { emit('files-changed'); emit('fs-changed'); }
    } else if (ev === 'error') {
      finished = true;
      failure = data.stopped ? null : data.message;
      if (data.stopped) notice.textContent = '⏹ Stopped';
      notice.hidden = !data.stopped;
    }
  };
  try {
    if (body) {
      try {
        await postStream(`/api/projects/${encodeURIComponent(app.project.id)}/ai/chat`, body, handle, sending.signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e.status === 409 && e.data?.job) throw new Error(e.message);
        if (!currentJob) throw e; // never started
      }
    }
    // Connection dropped before the end (or attaching after a reload): follow the job until it ends.
    for (let tries = 0; !finished && currentJob && !sending.signal.aborted; tries++) {
      notice.textContent = tries ? '⟳ Reconnecting…' : '⟳ Connection dropped: reconnecting (the AI keeps working)…';
      notice.hidden = false;
      try {
        await followJob(currentJob.id, last, handle, sending.signal);
        if (!finished && !sending.signal.aborted) {
          // ended without done/error: the turn finished while we were away; the history has it
          finished = true;
          notice.textContent = 'This turn finished while the page was disconnected. Its answer is in the history.';
        }
      } catch (e) {
        if (tries >= 2) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (failure) throw new Error(failure);
  } catch (e) {
    if (e.name !== 'AbortError') {
      renderBody(acc, bodyEl);
      reply.append(el('div', { class: 'err', text: `⚠ ${e.message}` }));
    }
  } finally {
    app.aiRunning = false;
    currentJob = null;
    reply.classList.remove('thinking');
    activitySummary(act, { running: false, secs: Math.round((Date.now() - t0) / 1000) });
    act.d.open = false;
    think.d.open = false;
    think.sum.textContent = '💭 Thinking';
    sending = null;
    $('aiSend').textContent = 'Send';
    $('aiWithBuild').checked = false;
    box.scrollTop = box.scrollHeight;
    if (isHermes) { emit('files-changed'); emit('fs-changed'); }
  }
}

/** Stop: tell the server to stop the turn (and Hermes), then stop listening. */
async function stopTurn() {
  const j = currentJob;
  if (j) await pApi(`/ai/jobs/${encodeURIComponent(j.id)}/cancel`, { method: 'POST', body: {} }).catch(() => {});
  sending?.abort();
}

/** Reopening a project while its turn still runs: show it and keep following. */
async function resumeActive() {
  let r;
  try { r = await pApi('/ai/active'); } catch { return; }
  if (!r.job || sending) return;
  const prov = providers.find((p) => p.name === r.job.engine) || engine();
  await runTurn({ text: r.job.message, ctx: [], prov, job: r.job });
}

$('aiSend').addEventListener('click', () => (sending ? stopTurn() : send()));
$('aiFollow').checked = pref('aiFollow', true);
$('aiFollow').addEventListener('change', () => setPref('aiFollow', $('aiFollow').checked));
$('aiInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('aiInput').addEventListener('input', () => setPref(`aiDraft:${app.project.id}`, $('aiInput').value));
$('aiClear').addEventListener('click', guard(async () => {
  if (!confirm('Start a new conversation? The current history for this project is cleared.')) return;
  await pApi('/ai/clear', { method: 'POST' });
  await loadAi();
}));
$('aiClose').addEventListener('click', () => toggleAi(false));
$('btnAiToggle').addEventListener('click', () => toggleAi());
$('aiHermes').addEventListener('click', busy($('aiHermes'), async () => {
  const text = $('aiInput').value.trim();
  if (!text) throw new Error('Describe the task for Hermes first');
  await saveAll();
  const r = await pApi('/ai/hermes', {
    method: 'POST',
    body: { message: text, contextFiles: [...new Set([currentFile, ...extraContext].filter(Boolean))], ...($('aiWithBuild').checked && latestFailedBuild ? { buildId: latestFailedBuild } : {}) },
  });
  $('aiMessages').append(messageEl('user', text), el('div', { class: 'msg assistant' },
    el('div', { class: 'who', text: 'HERMES' }),
    el('div', { class: 'body', text: `Task sent (HTTP ${r.status}). Hermes works through the MCP tools; its edits, commits and builds appear here, in Source Control and in Build Output.` })));
  $('aiInput').value = '';
}));

/** Pre-fill the assistant with an error to fix (from Build Output / Logcat). */
export function askToFix(kind, detail) {
  toggleAi(true);
  if (kind === 'build') $('aiWithBuild').checked = true;
  $('aiInput').value = kind === 'build'
    ? 'The last build failed. Find the root cause and fix it.'
    : `The app crashed. Here is the logcat excerpt:\n\n${detail}\n\nFind the root cause and fix it.`;
  $('aiInput').focus();
}

export function restoreDraft() {
  $('aiInput').value = pref(`aiDraft:${app.project.id}`, '');
}
