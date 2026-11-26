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
      class: `tab${t === active ? ' active' : ''}${t.dirty ? ' dirty' : ''}${t.ext ? ' ext' : ''}`, title: t.ext ? `${t.path} (changed by ${t.ext})` : t.path || t.title, role: 'tab',
      onclick: () => activate(t),
      onauxclick: (e) => { if (e.button === 1) close(t); },
    },
    el('span', { text: t.title }),
    el('button', { class: 'x', title: 'Close', onclick: (e) => { e.stopPropagation(); close(t); } }, el('span', { text: '×' })));
    bar.append(tabEl);
  }
  $('welcome').hidden = tabs.length > 0;
  $('tabsbar').hidden = tabs.length === 0;
  tabEl()?.scrollIntoView({ inline: 'nearest' });
  renderSaveState();
  setPref(`tabs:${app.project?.id}`, { open: openTabs(), active: activeFile() });
}
const tabEl = () => $('tabs').querySelector('.tab.active');

function activate(t) {
  active = t;
  t.ext = null;
  for (const x of tabs) x.pane.hidden = x !== t;
  renderTabs();
  t.editor?.focus?.();
  $('sbLang').textContent = t.kind === 'diff' ? 'Diff' : LANG_NAMES[t.editor?.language] || 'Plain text';
  $('sbCursor').textContent = '';
  emit('active-file', activeFile());
}

/** Open (or focus) a file tab. opts: { line } */
export async function openFile(path, { line, preview = false, reveal = true } = {}) {
  await cmReady;
  let t = tabs.find((x) => x.kind === 'file' && x.path === path);
  if (!t) {
    let f;
    try { f = await pApi(`/file?path=${encodeURIComponent(path)}`); } catch (e) { toast(e.message, 'err'); return; }
    const pane = el('div', { class: 'ed' });
    host().append(pane);
    t = { id: `f:${path}`, kind: 'file', path, title: basename(path), hash: f.hash, dirty: false, pane };
    if (f.content === undefined) {
      pane.append(binaryPreview(path, f));
      t.readOnly = true;
    } else {
      t.editor = makeEditor(pane, {
        doc: f.content, path,
        onChange: (v) => {
          if (t.reloading) return;
          const d = v !== t.saved;
          if (d !== t.dirty) { t.dirty = d; renderTabs(); }
          if (d) scheduleAutosave(t);
        },
        onSave: () => save(t),
        onCursor: (ln, col) => { if (t === active) $('sbCursor').textContent = `Ln ${ln}, Col ${col}`; },
      });
      t.saved = f.content;
      t.editor.setProblems?.(problemsFor(path));
    }
    tabs.push(t);
  }
  activate(t);
  if (line && t.editor) t.editor.revealLine(line);
  if (reveal) emit('reveal', 'code'); // phone layout: switch to the editor
  return t;
}

const rawUrl = (path, dl) => `/api/projects/${encodeURIComponent(app.project.id)}/raw?path=${encodeURIComponent(path)}${dl ? '&download=1' : ''}`;
function binaryPreview(path, f) {
  const box = el('div', { class: 'binview' });
  const ext = path.toLowerCase().split('.').pop();
  const meta = el('div', { class: 'muted small' });
  const size = f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1e3))} kB`;
  meta.textContent = `${path} · ${size}`;
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    const img = el('img', { src: `${rawUrl(path)}&t=${f.hash || Date.now()}`, alt: path });
    img.addEventListener('load', () => { meta.textContent = `${path} · ${img.naturalWidth}×${img.naturalHeight} px · ${size}`; });
    box.append(el('div', { class: 'checker' }, img));
  } else if (['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) {
    box.append(el('audio', { controls: true, src: rawUrl(path) }));
  } else if (['mp4', 'webm'].includes(ext)) {
    box.append(el('video', { controls: true, src: rawUrl(path) }));
  } else if (f.tooLarge) {
    box.append(el('p', { class: 'muted', text: 'Too large to edit in the browser.' }));
  } else {
    box.append(el('p', { class: 'muted', text: 'Binary file (no text preview).' }));
  }
  box.append(meta, el('a', { class: 'btn', href: rawUrl(path, true), text: '⬇ Download' }));
  return box;
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

/** Saves are serialized per tab, so rapid Ctrl+S presses never race on the same base hash. */
export function save(t = active, { auto = false } = {}) {
  if (!t || t.kind !== 'file' || !t.editor || t.readOnly) return Promise.resolve();
  clearTimeout(t.autoTimer);
  t.saving = (t.saving || Promise.resolve()).then(() => doSave(t, auto));
  return t.saving;
}
export const autosaveOn = () => pref('autosave', true);
function scheduleAutosave(t) {
  if (!autosaveOn() || t.saveError === 'conflict') return;
  clearTimeout(t.autoTimer);
  t.autoTimer = setTimeout(() => { if (tabs.includes(t) && t.dirty) save(t, { auto: true }); }, 1200);
}
async function doSave(t, auto = false) {
  const content = t.editor.getValue();
  if (content === t.saved && !t.dirty) return;
  t.inflight = content;
  t.saveState = 'saving';
  renderSaveState();
  try {
    const r = await pApi('/file', { method: 'POST', body: { path: t.path, content, baseHash: t.hash } });
    t.hash = r.hash;
    t.saved = content;
    t.savedAt = new Date();
    t.saveError = null;
    t.dirty = t.editor.getValue() !== content;
    renderTabs();
    emit('saved', t.path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data?.conflict) {
      if (auto) { // never pop a dialog while typing: show it in the status bar, the user decides on Save
        t.saveError = 'conflict';
        toast(`${t.path} was changed on disk (AI, git or another tab). Press Save to choose which version to keep.`, 'err');
        return;
      }
      t.saveError = null;
      const overwrite = confirm(`${t.path} was changed on disk (another tab, the AI, git or Hermes).\n\nOK = overwrite with your version\nCancel = load the disk version (Ctrl+Z in the editor brings your edits back)`);
      if (overwrite) {
        t.hash = e.data.hash;
        return doSave(t);
      }
      return reloadFromDisk([t.path], { discard: true });
    }
    t.saveError = e.message;
    toast(`Save failed: ${e.message}`, 'err');
  } finally {
    t.inflight = undefined;
    t.saveState = null;
    renderSaveState();
  }
}

/** Status bar + toolbar: is the active file saved? */
export function renderSaveState() {
  const sb = $('sbSave');
  const btn = $('edSave');
  const t = active;
  const editable = t && t.kind === 'file' && t.editor && !t.readOnly;
  const others = tabs.filter((x) => x !== t && x.dirty).length;
  sb.hidden = !editable;
  btn.disabled = !editable || (!t.dirty && !t.saveError);
  if (!editable) return;
  const time = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let text;
  let cls;
  if (t.saveState === 'saving') { text = '⟳ Saving…'; cls = 'saving'; }
  else if (t.saveError === 'conflict') { text = '⚠ Changed on disk: Save to resolve'; cls = 'bad'; }
  else if (t.saveError) { text = '⚠ Not saved: click to retry'; cls = 'bad'; }
  else if (t.dirty) { text = autosaveOn() ? '● Unsaved (autosave…)' : '● Unsaved: Ctrl+S'; cls = 'dirty'; }
  else { text = t.savedAt ? `✓ Saved ${time(t.savedAt)}` : '✓ Saved'; cls = 'ok'; }
  sb.textContent = others ? `${text} · ${others} other unsaved` : text;
  sb.className = `sbsave ${cls}`;
  sb.title = `${t.path}${t.hash ? `\nDisk version ${t.hash.slice(0, 8)}` : ''}\nClick to save now`;
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
export async function reloadFromDisk(paths, { discard = false, source = null } = {}) {
  for (const t of tabs.filter((x) => x.kind === 'file' && x.editor && (!paths || paths.includes(x.path)))) {
    // Only the newest reload of a tab may apply: an older, slower response must not overwrite newer content.
    const gen = (t.reloadGen = (t.reloadGen || 0) + 1);
    let f;
    try { f = await pApi(`/file?path=${encodeURIComponent(t.path)}`); } catch { if (gen === t.reloadGen) close(t, { force: true }); continue; }
    if (gen !== t.reloadGen || !tabs.includes(t)) continue;
    if (f.content === undefined) continue;
    if (t.inflight !== undefined && f.content === t.inflight) continue; // our own save echoing back
    const current = t.editor.getValue();
    if (current === f.content) { t.hash = f.hash; t.saved = f.content; t.dirty = false; t.saveError = null; continue; }
    if (!discard && t.dirty && current !== t.saved) {
      if (t.saveError !== 'conflict') toast(`${t.path} changed on disk; your unsaved edits were kept`, 'err');
      t.saveError = 'conflict';
      continue;
    }
    clearTimeout(t.autoTimer);
    t.reloading = true;
    const range = applyText(t, f.content);
    t.reloading = false;
    t.hash = f.hash;
    t.saved = f.content;
    t.dirty = false;
    t.saveError = null;
    t.savedAt = new Date();
    if (t !== active) t.ext = source || 'another tool';
    if (range) t.editor.flash?.(range.from, range.to, { scroll: t === active && following() });
  }
  renderTabs();
}

/** Replace only the changed middle of the document, so cursor, scroll and undo history survive. */
function applyText(t, text) {
  const cur = t.editor.getValue();
  const max = Math.min(cur.length, text.length);
  let a = 0;
  while (a < max && cur.charCodeAt(a) === text.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
  const insert = text.slice(a, text.length - b);
  if (t.editor.view) t.editor.view.dispatch({ changes: { from: a, to: cur.length - b, insert } });
  else t.editor.setValue(text);
  return { from: a, to: a + insert.length };
}

// ---- follow AI edits: while the assistant runs, open the file it changes and show the change
const TEXT_EXT = /\.(kt|kts|java|xml|gradle|json|md|properties|pro|toml|ya?ml|txt|html?|css|js|ts|sh)$/i;
const following = () => !!app.aiRunning && pref('aiFollow', true);
on('files-live', ({ paths, kinds }) => {
  if (!following() || !paths || paths.length !== 1 || !TEXT_EXT.test(paths[0])) return;
  if (!kinds.every((k) => k === 'write' || k === 'create')) return;
  if (paths[0] === activeFile()) return;
  openFile(paths[0], { reveal: false }).then((t) => { if (t) { t.ext = null; renderTabs(); } }).catch(() => {});
});

export async function restoreTabs() {
  const s = pref(`tabs:${app.project.id}`, null);
  if (!s?.open?.length) return;
  for (const p of s.open.slice(0, 12)) await openFile(p, { reveal: false }).catch(() => {});
  if (s.active) await openFile(s.active, { reveal: false }).catch(() => {});
}

export const revealLine = async (path, line) => openFile(path, { line });

// ---- quick open (Ctrl+P)
let allFiles = [];
let quickSel = 0;
let filesReady = Promise.resolve();
export function quickOpen() {
  const d = $('dlgQuick');
  $('quickInput').value = '';
  d.showModal();
  $('quickInput').focus();
  filesReady = pApi('/files')
    .then((r) => { allFiles = r.files; })
    .catch((e) => { toast(e.message, 'err'); allFiles = []; })
    .then(renderQuick);
  return filesReady;
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
    // Close at once (so the next shortcut works); if typed before the file list arrived, open the best
    // match as soon as it does.
    const query = $('quickInput').value;
    const picked = $('quickList').children[quickSel]?.dataset.path;
    $('dlgQuick').close();
    if (picked) { openFile(picked); return; }
    filesReady.then(() => {
      $('quickInput').value = query;
      renderQuick();
      const p = $('quickList').children[0]?.dataset.path;
      if (p) openFile(p);
    });
  }
});

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});
// ---- build problems as squiggles in open files (list from bottom.js)
let problemList = [];
const problemsFor = (path) => problemList.filter((p) => p.path === path);
on('problems', (list) => {
  problemList = list;
  for (const t of tabs) if (t.kind === 'file') t.editor?.setProblems?.(problemsFor(t.path));
});

on('files-changed', (paths) => reloadFromDisk(paths, { source: app.aiRunning ? 'AI' : null }));
$('sbSave').addEventListener('click', () => save());
$('edSave').addEventListener('click', () => save());
$('edAutosave').checked = autosaveOn();
$('edAutosave').addEventListener('change', () => {
  setPref('autosave', $('edAutosave').checked);
  if ($('edAutosave').checked) for (const t of tabs) if (t.dirty) scheduleAutosave(t);
  renderSaveState();
});
