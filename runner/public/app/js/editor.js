// Multi-tab code editor (CodeMirror 6 bundle, plain textarea fallback), diff tabs, quick open.
import { $, app, pApi, el, toast, guard, basename, dirname, renderDiff, emit, on, pref, setPref, ApiError } from './core.js';

let CM = null; // { createEditor, languageFor }
const cmReady = import('/vendor/codemirror.bundle.js').then((m) => { CM = m; }).catch((e) => {
  console.warn('CodeMirror bundle unavailable, using plain editor', e);
});

const tabs = []; // { id, kind:'file'|'diff', path, title, hash, dirty, editor, pane, readOnly }
let active = null;
const LANG_NAMES = { kotlin: 'Kotlin', java: 'Java', groovy: 'Groovy', xml: 'XML', json: 'JSON', markdown: 'Markdown', properties: 'Properties', yaml: 'YAML', toml: 'TOML', shell: 'Shell' };

const host = () => $('editorHost');
export const activeTab = () => active;
export const activeFile = () => (active?.kind === 'file' ? active.path : null);
export const openTabs = () => tabs.filter((t) => t.kind === 'file').map((t) => t.path);
export const isDirty = () => tabs.some((t) => t.dirty);

function selectionText() {
  if (!active?.editor) return '';
  if (active.editor.view) {
    const s = active.editor.view.state.selection.main;
    return s.empty ? '' : active.editor.view.state.sliceDoc(s.from, s.to);
  }
  const ta = active.editor.textarea;
  return ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
}
export { selectionText };

function makeEditor(parent, { doc, path, readOnly, onChange, onSave, onCursor }) {
  if (CM) return CM.createEditor({ parent, doc, path, readOnly, onChange, onSave, onCursor });
  const ta = el('textarea', { class: 'fallback', spellcheck: 'false' });
  ta.value = doc;
  ta.readOnly = !!readOnly;
  ta.addEventListener('input', () => onChange(ta.value));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave(); }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText('    ', s, ta.selectionEnd, 'end');
      onChange(ta.value);
    }
  });
  const cursor = () => {
    const before = ta.value.slice(0, ta.selectionStart).split('\n');
    onCursor(before.length, before.at(-1).length + 1);
  };
  ta.addEventListener('keyup', cursor);
  ta.addEventListener('click', cursor);
  parent.append(ta);
  return {
    textarea: ta,
    language: null,
    getValue: () => ta.value,
    setValue: (v) => { ta.value = v; },
    focus: () => ta.focus(),
    destroy: () => ta.remove(),
    revealLine: (n) => {
      const lines = ta.value.split('\n');
      const pos = lines.slice(0, Math.max(0, n - 1)).join('\n').length + (n > 1 ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      ta.scrollTop = Math.max(0, (n - 5) * 19);
    },
    search: () => {},
  };
}

function renderTabs() {
  const bar = $('tabs');
  bar.textContent = '';
  for (const t of tabs) {
    const tabEl = el('div', {
      class: `tab${t === active ? ' active' : ''}${t.dirty ? ' dirty' : ''}`, title: t.path || t.title, role: 'tab',
      onclick: () => activate(t),
      onauxclick: (e) => { if (e.button === 1) close(t); },
    },
    el('span', { text: t.title }),
    el('button', { class: 'x', title: 'Close', onclick: (e) => { e.stopPropagation(); close(t); } }, el('span', { text: '×' })));
    bar.append(tabEl);
  }
  $('welcome').hidden = tabs.length > 0;
  tabEl()?.scrollIntoView({ inline: 'nearest' });
  setPref(`tabs:${app.project?.id}`, { open: openTabs(), active: activeFile() });
}
const tabEl = () => $('tabs').querySelector('.tab.active');

function activate(t) {
  active = t;
  for (const x of tabs) x.pane.hidden = x !== t;
  renderTabs();
  t.editor?.focus?.();
  $('sbLang').textContent = t.kind === 'diff' ? 'Diff' : LANG_NAMES[t.editor?.language] || 'Plain text';
  $('sbCursor').textContent = '';
  emit('active-file', activeFile());
}

/** Open (or focus) a file tab. opts: { line } */
export async function openFile(path, { line, preview = false } = {}) {
  await cmReady;
  let t = tabs.find((x) => x.kind === 'file' && x.path === path);
  if (!t) {
    let f;
    try { f = await pApi(`/file?path=${encodeURIComponent(path)}`); } catch (e) { toast(e.message, 'err'); return; }
    const pane = el('div', { class: 'ed' });
    host().append(pane);
    t = { id: `f:${path}`, kind: 'file', path, title: basename(path), hash: f.hash, dirty: false, pane };
    if (f.content === undefined) {
      pane.append(el('div', { class: 'notice', text: f.binary ? `${path} is a binary file (${f.size} bytes).` : `${path} is too large to edit in the browser (${f.size} bytes).` }));
      t.readOnly = true;
    } else {
      t.editor = makeEditor(pane, {
        doc: f.content, path,
        onChange: (v) => {
          if (t.reloading) return;
          const d = v !== t.saved;
          if (d !== t.dirty) { t.dirty = d; renderTabs(); }
        },
        onSave: () => save(t),
        onCursor: (ln, col) => { if (t === active) $('sbCursor').textContent = `Ln ${ln}, Col ${col}`; },
      });
      t.saved = f.content;
    }
    tabs.push(t);
  }
  activate(t);
  if (line && t.editor) t.editor.revealLine(line);
  return t;
}

/** Read-only diff tab (git or AI). */
export function openDiff(title, diffText) {
  let t = tabs.find((x) => x.kind === 'diff' && x.title === title);
  if (!t) {
    const pane = el('div', { class: 'ed' });
    host().append(pane);
    t = { id: `d:${title}`, kind: 'diff', title, pane };
    tabs.push(t);
  }
  t.pane.textContent = '';
  t.pane.append(renderDiff(diffText));
  activate(t);
}

export async function save(t = active) {
  if (!t || t.kind !== 'file' || !t.editor || t.readOnly) return;
  const content = t.editor.getValue();
  try {
    const r = await pApi('/file', { method: 'POST', body: { path: t.path, content, baseHash: t.hash } });
    t.hash = r.hash;
    t.saved = content;
    t.dirty = t.editor.getValue() !== content;
    renderTabs();
    emit('saved', t.path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data?.conflict) {
      const overwrite = confirm(`${t.path} was changed on disk (another tab, the AI, git or Hermes).\n\nOK = overwrite with your version\nCancel = keep the disk version (your edits stay unsaved)`);
      if (overwrite) {
        t.hash = e.data.hash;
        return save(t);
      }
      return;
    }
    toast(`Save failed: ${e.message}`, 'err');
  }
}
export async function saveAll() {
  for (const t of tabs.filter((x) => x.dirty)) await save(t);
}

export function close(t, { force = false } = {}) {
  if (t.dirty && !force && !confirm(`${t.path} has unsaved changes. Close anyway?`)) return false;
  t.editor?.destroy?.();
  t.pane.remove();
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (active === t) {
    active = null;
    const next = tabs[i] || tabs[i - 1];
    if (next) activate(next); else { renderTabs(); emit('active-file', null); $('sbLang').textContent = ''; $('sbCursor').textContent = ''; }
  } else renderTabs();
  return true;
}
export function closeAll({ force = false } = {}) {
  for (const t of [...tabs]) if (!close(t, { force })) return false;
  return true;
}
export function closeTabsUnder(path) {
  for (const t of [...tabs]) if (t.path === path || t.path?.startsWith(`${path}/`)) close(t, { force: true });
}
export function renameTab(from, to) {
  for (const t of tabs) {
    if (t.path === from || t.path?.startsWith(`${from}/`)) {
      t.path = to + t.path.slice(from.length);
      t.title = basename(t.path);
    }
  }
  renderTabs();
}

/** Re-read open files changed on disk (AI apply, git pull, Hermes). Dirty tabs are left alone. */
export async function reloadFromDisk(paths) {
  for (const t of tabs.filter((x) => x.kind === 'file' && x.editor && (!paths || paths.includes(x.path)))) {
    let f;
    try { f = await pApi(`/file?path=${encodeURIComponent(t.path)}`); } catch { close(t, { force: true }); continue; }
    if (f.content === undefined) continue;
    const current = t.editor.getValue();
    if (current === f.content) { t.hash = f.hash; t.saved = f.content; t.dirty = false; continue; }
    if (t.dirty && current !== t.saved) { toast(`${t.path} changed on disk; your unsaved edits were kept`, 'err'); continue; }
    t.reloading = true;
    t.editor.setValue(f.content);
    t.reloading = false;
    t.hash = f.hash;
    t.saved = f.content;
    t.dirty = false;
  }
  renderTabs();
}

export async function restoreTabs() {
  const s = pref(`tabs:${app.project.id}`, null);
  if (!s?.open?.length) return;
  for (const p of s.open.slice(0, 12)) await openFile(p).catch(() => {});
  if (s.active) await openFile(s.active).catch(() => {});
}

export const revealLine = async (path, line) => openFile(path, { line });

// ---- quick open (Ctrl+P)
let allFiles = [];
let quickSel = 0;
export async function quickOpen() {
  const d = $('dlgQuick');
  $('quickInput').value = '';
  d.showModal();
  $('quickInput').focus();
  try { allFiles = (await pApi('/files')).files; } catch (e) { toast(e.message, 'err'); allFiles = []; }
  renderQuick();
}
const score = (f, q) => {
  if (!q) return 1;
  const name = basename(f).toLowerCase();
  const fl = f.toLowerCase();
  if (name.startsWith(q)) return 100 - name.length;
  if (name.includes(q)) return 60 - name.length;
  let i = 0;
  for (const c of fl) if (c === q[i]) i++;
  return i === q.length ? 20 - fl.length / 100 : 0;
};
function renderQuick() {
  const q = $('quickInput').value.trim().toLowerCase();
  const list = allFiles.map((f) => [f, score(f, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 60);
  quickSel = Math.min(quickSel, Math.max(0, list.length - 1));
  const ul = $('quickList');
  ul.textContent = '';
  list.forEach(([f], i) => ul.append(el('li', {
    class: i === quickSel ? 'sel' : '', dataset: { path: f },
    onclick: () => { $('dlgQuick').close(); openFile(f); },
  }, el('span', { text: basename(f) }), el('span', { class: 'dir', text: dirname(f) }))));
}
$('quickInput').addEventListener('input', () => { quickSel = 0; renderQuick(); });
$('quickInput').addEventListener('keydown', (e) => {
  const n = $('quickList').children.length;
  if (e.key === 'ArrowDown') { e.preventDefault(); quickSel = Math.min(n - 1, quickSel + 1); renderQuick(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); quickSel = Math.max(0, quickSel - 1); renderQuick(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const p = $('quickList').children[quickSel]?.dataset.path;
    if (p) { $('dlgQuick').close(); openFile(p); }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});
on('files-changed', (paths) => reloadFromDisk(paths));
