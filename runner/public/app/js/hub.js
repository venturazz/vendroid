// Project Hub: list, create from template, clone, open, delete.
import { $, app, api, el, toast, guard, fmtAgo, avatar, prompt, emit } from './core.js';

export async function refreshHub() {
  let r;
  try { r = await api('/api/projects'); } catch (e) { toast(e.message, 'err'); return; }
  app.projects = r.projects;
  $('hubWs').textContent = `${r.projects.length} project${r.projects.length === 1 ? '' : 's'} in ${app.cfg.workspacesDir || 'workspace'}`;
  const grid = $('hubGrid');
  grid.textContent = '';
  for (const p of r.projects) grid.append(card(p, r.queue));
  $('hubEmpty').hidden = r.projects.length > 0;
  emit('projects', r.projects);
}

function card(p, queue) {
  const running = queue.activeProject === p.id;
  const lb = p.lastBuild;
  const open = () => { location.hash = `#/p/${encodeURIComponent(p.id)}`; };
  const meta = el('div', { class: 'meta' },
    el('span', { class: 'tag', text: p.android ? (p.ui === 'compose' ? 'Compose' : 'Views') : 'not Android' }),
    p.targetSdk ? el('span', { class: `tag${p.targetSdk >= (app.cfg.playTargetSdk || 36) ? ' ok' : ''}`, title: `minSdk ${p.minSdk || '?'} · targetSdk ${p.targetSdk}`, text: `API ${p.minSdk || '?'}–${p.targetSdk}` }) : null,
    p.versionName ? el('span', { class: 'tag', text: `v${p.versionName}` }) : null,
    p.git ? el('span', { class: 'tag', text: 'git' }) : null,
    running ? el('span', { class: 'pill building', text: 'building' })
      : lb ? el('span', { class: `pill ${lb.state}`, text: lb.state }) : el('span', { text: 'never built' }),
    lb?.finishedAt ? el('span', { text: fmtAgo(lb.finishedAt) }) : null,
  );
  const acts = el('div', { class: 'acts' },
    el('button', { class: 'primary', text: 'Open', onclick: (e) => { e.stopPropagation(); open(); } }),
    lb?.apk ? el('a', { class: 'btn', href: `/api/builds/${lb.id}/apk`, text: `⬇ ${lb.apk.type === 'aab' ? 'AAB' : 'APK'}`, onclick: (e) => e.stopPropagation() }) : null,
    el('span', { class: 'grow' }),
    el('button', { class: 'ghost', title: 'Rename', text: '✎', onclick: guard(async (e) => {
      e.stopPropagation();
      const name = await prompt('Rename project', { value: p.name });
      if (!name || name === p.name) return;
      await api(`/api/projects/${encodeURIComponent(p.id)}/settings`, { method: 'POST', body: { name } });
      refreshHub();
    }) }),
    el('button', { class: 'ghost', title: 'Delete project folder', text: '🗑', onclick: guard(async (e) => {
      e.stopPropagation();
      const c = await prompt(`Delete "${p.name}"?`, {
        text: `This permanently deletes the folder ${p.path} and its build history. Type "${p.id}" to confirm.`, placeholder: p.id, okLabel: 'Delete',
      });
      if (c === null) return;
      await api(`/api/projects/${encodeURIComponent(p.id)}/delete`, { method: 'POST', body: { confirm: c } });
      toast(`Deleted ${p.name}`, 'ok');
      refreshHub();
    }) }),
  );
  return el('article', { class: 'pcard', onclick: open, tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    el('h3', {}, avatar(p.name), el('span', { text: p.name })),
    el('div', { class: 'pkg', text: p.packageName || p.id }),
    meta, acts);
}

// ---- new project
const suggestPkg = (name) => `com.example.${name.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^\d+/, '') || 'app'}`;
let pkgTouched = false;
$('npName').addEventListener('input', () => { if (!pkgTouched) $('npPkg').value = suggestPkg($('npName').value); });
$('npPkg').addEventListener('input', () => { pkgTouched = true; });
$('hubNew').addEventListener('click', () => openNewProject());
const ANDROID_NAMES = { 33: '13', 34: '14', 35: '15', 36: '16', 37: '17', 38: '18' };
export function openNewProject() {
  pkgTouched = false;
  $('formNew').reset();
  const v = app.cfg.templateVersions;
  if (v) {
    $('npTarget').textContent = `API ${v.compileSdk} (Android ${ANDROID_NAMES[v.targetSdk] || '?'}), target ${v.targetSdk}`;
    $('npPlay').textContent = String(app.cfg.playTargetSdk || 36);
    $('npStack').textContent = `Kotlin ${v.kotlin} · AGP ${v.agp} · Gradle ${v.gradle} · Jetpack Compose / Material 3, verified on this ARM64 server. A git repository is initialized with the first commit.`;
  }
  $('npErr').textContent = '';
  $('dlgNew').showModal();
  $('npName').focus();
}
$('formNew').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const btn = $('npCreate');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  $('npErr').textContent = '';
  try {
    const p = await api('/api/projects', {
      method: 'POST',
      body: {
        name: $('npName').value.trim(), packageName: $('npPkg').value.trim(),
        template: $('formNew').querySelector('input[name=tpl]:checked').value, minSdk: Number($('npMin').value),
      },
    });
    $('dlgNew').close();
    toast(`Created ${p.name}. Press ▶ Run to build it on your phone.`, 'ok');
    location.hash = `#/p/${encodeURIComponent(p.id)}`;
  } catch (err) {
    $('npErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
});

// ---- clone
$('hubClone').addEventListener('click', () => {
  $('formClone').reset();
  $('clErr').textContent = '';
  $('clHint').textContent = app.cfg.gitTokenConfigured
    ? 'Private repositories work: GIT_TOKEN is configured.'
    : 'Public repositories work as-is. For private ones set GIT_TOKEN (read access), or put a token in the URL.';
  $('dlgClone').showModal();
  $('clUrl').focus();
});
$('formClone').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const btn = $('clGo');
  btn.disabled = true;
  btn.textContent = 'Cloning…';
  $('clErr').textContent = '';
  try {
    const p = await api('/api/projects/clone', { method: 'POST', body: { url: $('clUrl').value.trim(), ...($('clBranch').value.trim() ? { branch: $('clBranch').value.trim() } : {}) } });
    $('dlgClone').close();
    toast(`Cloned ${p.name}`, 'ok');
    location.hash = `#/p/${encodeURIComponent(p.id)}`;
  } catch (err) {
    $('clErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Clone';
  }
});
