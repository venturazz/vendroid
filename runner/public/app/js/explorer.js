// File Explorer (lazy tree with git decorations and a context menu) + project search.
import { $, app, pApi, el, toast, guard, prompt, dirname, basename, emit, on, pref, setPref } from './core.js';
import { openFile, closeTabsUnder, renameTab } from './editor.js';

const expanded = new Set(); // dir paths
let selected = null;
let gitMarks = new Map(); // path -> status
let showHidden = pref('showHidden', false);

const ICONS = { kt: '🟣', kts: '🟣', java: '☕', xml: '🟧', gradle: '🐘', json: '{}', md: '📝', png: '🖼', webp: '🖼', jpg: '🖼', properties: '⚙', pro: '⚙', toml: '⚙', yml: '⚙', yaml: '⚙' };
const iconFor = (name, type, open) => (type === 'dir' ? (open ? '📂' : '📁') : ICONS[name.split('.').pop().toLowerCase()] || '📄');

export function resetExplorer() {
  expanded.clear();
  selected = null;
  const saved = pref(`expanded:${app.project.id}`, null);
  for (const p of saved || ['app', 'app/src', 'app/src/main']) expanded.add(p);
  refreshTree();
}
const persistExpanded = () => setPref(`expanded:${app.project.id}`, [...expanded].slice(0, 200));

export async function refreshTree() {
  const tree = $('tree');
  const frag = document.createDocumentFragment();
  await renderDir('', 0, frag);
  tree.textContent = '';
  tree.append(frag);
}

async function renderDir(dir, depth, into) {
  let entries;
  try {
    entries = (await pApi(`/tree?path=${encodeURIComponent(dir)}${showHidden ? '&hidden=1' : ''}`)).entries;
  } catch (e) {
    into.append(el('div', { class: 'node dim', text: `⚠ ${e.message}` }));
    return;
  }
  for (const ent of entries) {
    const open = ent.type === 'dir' && expanded.has(ent.path);
    const mark = gitMarks.get(ent.path) || (ent.type === 'dir' && [...gitMarks.keys()].some((k) => k.startsWith(`${ent.path}/`)) ? 'modified' : null);
    const row = el('div', {
      class: `node${ent.dimmed ? ' dim' : ''}${selected === ent.path ? ' sel' : ''}${mark ? ` git-${mark}` : ''}`,
      dataset: { path: ent.path, type: ent.type },
      title: ent.path,
    },
    el('span', { class: 'tw', text: ent.type === 'dir' ? (open ? '▾' : '▸') : '' }),
    el('span', { class: 'ic', text: iconFor(ent.name, ent.type, open) }),
    el('span', { class: 'nm', text: ent.name }));
    row.style.paddingLeft = `${8 + depth * 12}px`;
    into.append(row);
    if (open) await renderDir(ent.path, depth + 1, into);
  }
}

function select(path) {
  selected = path;
  document.querySelectorAll('#tree .node.sel').forEach((n) => n.classList.remove('sel'));
  document.querySelector(`#tree .node[data-path="${CSS.escape(path)}"]`)?.classList.add('sel');
}

$('tree').addEventListener('click', guard(async (e) => {
  const n = e.target.closest('.node');
  if (!n?.dataset.path) return;
  const { path, type } = n.dataset;
  select(path);
  if (type === 'dir') {
    if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
    persistExpanded();
    await refreshTree();
  } else {
    await openFile(path);
  }
}));

/** Reveal a file in the tree (expand parents, select). */
export async function reveal(path) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
  selected = path;
  persistExpanded();
  await refreshTree();
  document.querySelector(`#tree .node[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---- create / rename / delete
const targetDir = () => {
  if (!selected) return '';
  const n = document.querySelector(`#tree .node[data-path="${CSS.escape(selected)}"]`);
  return n?.dataset.type === 'dir' ? selected : dirname(selected);
};
async function newFile(dir = targetDir()) {
  const name = await prompt('New file', { text: dir ? `in ${dir}/` : 'in project root', placeholder: 'MainScreen.kt or ui/Login.kt' });
  if (!name) return;
  const path = dir ? `${dir}/${name}` : name;
  await pApi('/file', { method: 'POST', body: { path, content: '', create: true } });
  await reveal(path);
  await openFile(path);
  emit('fs-changed');
}
async function newDir(dir = targetDir()) {
  const name = await prompt('New folder', { text: dir ? `in ${dir}/` : 'in project root' });
  if (!name) return;
  const path = dir ? `${dir}/${name}` : name;
  await pApi('/fs', { method: 'POST', body: { op: 'mkdir', path } });
  expanded.add(path);
  await reveal(path);
}
async function renamePath(path) {
  const to = await prompt('Rename / move', { value: path });
  if (!to || to === path) return;
  await pApi('/fs', { method: 'POST', body: { op: 'rename', path, to } });
  renameTab(path, to);
  await reveal(to);
  emit('fs-changed');
}
async function deletePath(path, type) {
  if (!confirm(`Delete ${type === 'dir' ? 'folder' : 'file'} ${path}${type === 'dir' ? ' and everything in it' : ''}?`)) return;
  await pApi('/fs', { method: 'POST', body: { op: 'delete', path } });
  closeTabsUnder(path);
  if (selected === path) selected = null;
  await refreshTree();
  emit('fs-changed');
}

// ---- upload (button, context menu, drag & drop) and download
async function uploadFiles(fileList, dir = targetDir()) {
  const list = [...fileList];
  if (!list.length) return;
  let done = 0;
  for (const f of list) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name}: larger than 25 MB`, 'err'); continue; }
    const rel = dir ? `${dir}/${f.name}` : f.name;
    const url = `/api/projects/${encodeURIComponent(app.project.id)}/upload?path=${encodeURIComponent(rel)}`;
    let r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
    if (r.status === 409 && confirm(`${rel} already exists. Replace it?`)) {
      r = await fetch(`${url}&overwrite=1`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
    }
    if (!r.ok && r.status !== 409) { toast(`${f.name}: ${(await r.json().catch(() => ({}))).error || r.status}`, 'err'); continue; }
    if (r.ok) done++;
    if (/^res\//.test(rel.replace(/^.*src\/main\//, '')) && !/^[a-z0-9_.]+$/.test(f.name)) {
      toast(`${f.name}: Android resource names must be lowercase a-z, 0-9 and _ (rename it, or the build fails)`, 'err');
    }
  }
  if (done) {
    toast(`Uploaded ${done} file${done === 1 ? '' : 's'}${dir ? ` to ${dir}/` : ''}`, 'ok');
    if (dir) expanded.add(dir);
    await refreshTree();
    emit('fs-changed');
  }
}
const picker = el('input', { type: 'file', multiple: true, hidden: true });
document.body.append(picker);
let pickDir = '';
picker.addEventListener('change', guard(async () => { await uploadFiles(picker.files, pickDir); picker.value = ''; }));
const pickUpload = (dir = targetDir()) => { pickDir = dir; picker.click(); };
$('exUpload').addEventListener('click', () => pickUpload());
const tree = $('tree');
tree.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); tree.classList.add('dropping'); } });
tree.addEventListener('dragleave', () => tree.classList.remove('dropping'));
tree.addEventListener('drop', guard(async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  tree.classList.remove('dropping');
  const n = e.target.closest('.node');
  const dir = n ? (n.dataset.type === 'dir' ? n.dataset.path : dirname(n.dataset.path)) : '';
  await uploadFiles(e.dataTransfer.files, dir);
}));

$('exNewFile').addEventListener('click', guard(() => newFile()));
$('exNewDir').addEventListener('click', guard(() => newDir()));
$('exRefresh').addEventListener('click', guard(refreshTree));
$('exHidden').addEventListener('click', guard(async () => {
  showHidden = !showHidden;
  setPref('showHidden', showHidden);
  $('exHidden').style.opacity = showHidden ? 1 : 0.6;
  await refreshTree();
}));
$('exHidden').style.opacity = showHidden ? 1 : 0.6;

// context menu
let ctxMenu = null;
const closeCtx = () => { ctxMenu?.remove(); ctxMenu = null; };
document.addEventListener('click', closeCtx);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
$('tree').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const n = e.target.closest('.node');
  const path = n?.dataset.path || '';
  const type = n?.dataset.type || 'dir';
  if (path) select(path);
  const dir = type === 'dir' ? path : dirname(path);
  closeCtx();
  const item = (label, fn) => el('button', { text: label, onclick: guard(async () => { closeCtx(); await fn(); }) });
  ctxMenu = el('div', { class: 'menu ctx' },
    item('New file…', () => newFile(dir)),
    item('New folder…', () => newDir(dir)),
    item('Upload files here…', () => pickUpload(dir)),
    path ? el('hr') : null,
    path && type === 'file' ? item('Add to AI context', () => emit('ai-add-context', path)) : null,
    path ? item('Rename / move…', () => renamePath(path)) : null,
    path ? item('Copy path', () => navigator.clipboard?.writeText(path)) : null,
    path && type === 'file' ? item('Download', () => { location.href = `/api/projects/${encodeURIComponent(app.project.id)}/raw?path=${encodeURIComponent(path)}&download=1`; }) : null,
    path ? item('Delete', () => deletePath(path, type)) : null);
  ctxMenu.style.left = `${e.clientX}px`;
  ctxMenu.style.top = `${e.clientY}px`;
  document.body.append(ctxMenu);
});
$('tree').addEventListener('keydown', guard(async (e) => {
  if (!selected) return;
  const n = document.querySelector(`#tree .node[data-path="${CSS.escape(selected)}"]`);
  if (e.key === 'F2') await renamePath(selected);
  else if (e.key === 'Delete') await deletePath(selected, n?.dataset.type);
}));

on('git-status', (st) => {
  gitMarks = new Map((st?.files || []).map((f) => [f.path, f.status]));
  for (const n of document.querySelectorAll('#tree .node')) {
    n.classList.remove('git-modified', 'git-untracked', 'git-added', 'git-deleted');
    const p = n.dataset.path;
    const m = gitMarks.get(p) || (n.dataset.type === 'dir' && [...gitMarks.keys()].some((k) => k.startsWith(`${p}/`)) ? 'modified' : null);
    if (m) n.classList.add(`git-${m === 'renamed' || m === 'conflict' ? 'modified' : m}`);
  }
});
on('fs-changed', () => refreshTree());
// Follow the active editor tab in the tree (like "Autoreveal" in IDEs).
on('active-file', (p) => {
  if (!p || selected === p) return;
  if (document.querySelector(`#tree .node[data-path="${CSS.escape(p)}"]`)) { select(p); return; }
  reveal(p).catch(() => {});
});

// ---- search
let searchTimer;
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});
$('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); } });
async function runSearch() {
  const q = $('searchInput').value.trim();
  const box = $('searchResults');
  if (q.length < 2) { box.textContent = ''; return; }
  box.textContent = 'Searching…';
  let r;
  try { r = await pApi(`/search?q=${encodeURIComponent(q)}`); } catch (e) { box.textContent = e.message; return; }
  box.textContent = '';
  if (!r.results.length) { box.append(el('div', { class: 'muted', text: 'No results', style: 'padding:6px 12px' })); return; }
  let last = null;
  for (const hit of r.results) {
    if (hit.path !== last) {
      last = hit.path;
      box.append(el('div', { class: 'sr-file', text: hit.path }));
    }
    box.append(el('div', { class: 'sr-hit', title: hit.text, text: `${hit.line}: ${hit.text.trim()}`, onclick: guard(() => openFile(hit.path, { line: hit.line })) }));
  }
  if (r.truncated) box.append(el('div', { class: 'muted small', text: 'More results not shown; refine the query.', style: 'padding:6px 12px' }));
}
export const focusSearch = () => { $('searchInput').focus(); $('searchInput').select(); };
export { basename };
