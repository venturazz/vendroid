// AI coding panel: chat with 9Router about the active project, review proposed edits as diffs,
// apply with one click (with undo), or hand the task to Hermes Agent.
import { $, app, pApi, el, toast, guard, busy, postStream, renderDiff, emit, on, pref, setPref, actionButton } from './core.js';
import { selectionText, openTabs, openFile, saveAll, reloadFromDisk } from './editor.js';

const extraContext = new Set();
let sending = null; // AbortController
let currentFile = null;
let latestFailedBuild = null;

export function setLatestFailedBuild(id) { latestFailedBuild = id; }

export function toggleAi(show = $('aipanel').hidden) {
  $('aipanel').hidden = !show;
  $('aiResizer').hidden = !show;
  setPref('aiOpen', show);
  if (show) $('aiInput').focus();
}

export async function loadAi() {
  extraContext.clear();
  renderCtx();
  const box = $('aiMessages');
  box.textContent = '';
  let msgs = [];
  try { msgs = (await pApi('/ai/history')).messages; } catch { /* none */ }
  if (!msgs.length) return renderEmpty();
  for (const m of msgs) box.append(messageEl(m.role, m.content, { context: m.context }));
  box.scrollTop = box.scrollHeight;
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

function messageEl(role, content, { context } = {}) {
  const body = el('div', { class: 'body' });
  if (role === 'assistant') renderBody(content, body); else body.textContent = content;
  return el('div', { class: `msg ${role}` },
    el('div', { class: 'who', text: role === 'user' ? 'YOU' : 'ASSISTANT' }),
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
async function send() {
  const text = $('aiInput').value.trim();
  if (!text || sending) return;
  await saveAll();
  const box = $('aiMessages');
  box.querySelector('.ai-empty')?.remove();
  const ctx = [...new Set([currentFile, ...extraContext].filter(Boolean))];
  box.append(messageEl('user', text, { context: ctx }));
  const reply = messageEl('assistant', '');
  reply.classList.add('thinking');
  box.append(reply);
  box.scrollTop = box.scrollHeight;
  $('aiInput').value = '';
  setPref(`aiDraft:${app.project.id}`, '');
  sending = new AbortController();
  $('aiSend').textContent = 'Stop';
  let acc = '';
  let lastRender = 0;
  const bodyEl = reply.querySelector('.body');
  try {
    await postStream(`/api/projects/${encodeURIComponent(app.project.id)}/ai/chat`, {
      message: text, activeFile: currentFile || undefined, contextFiles: [...extraContext],
      selection: selectionText() || undefined,
      ...($('aiWithBuild').checked && latestFailedBuild ? { buildId: latestFailedBuild } : {}),
    }, (ev, data) => {
      if (ev === 'delta') {
        acc += data.text;
        if (Date.now() - lastRender > 80) {
          lastRender = Date.now();
          renderBody(acc, bodyEl);
          box.scrollTop = box.scrollHeight;
        }
      } else if (ev === 'done') {
        renderBody(data.message, bodyEl);
        if (data.proposal?.files?.length || data.proposal?.errors?.length) reply.append(proposalEl(data.proposal));
      } else if (ev === 'error') {
        throw new Error(data.message);
      }
    }, sending.signal);
  } catch (e) {
    if (e.name !== 'AbortError') {
      renderBody(acc, bodyEl);
      reply.append(el('div', { class: 'err', text: `⚠ ${e.message}` }));
    }
  } finally {
    reply.classList.remove('thinking');
    sending = null;
    $('aiSend').textContent = 'Send';
    $('aiWithBuild').checked = false;
    box.scrollTop = box.scrollHeight;
  }
}
$('aiSend').addEventListener('click', () => (sending ? sending.abort() : send()));
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
