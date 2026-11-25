// Source Control panel: status, diff, commit, pull, push, branches.
import { $, app, pApi, el, toast, guard, busy, prompt, emit, on, actionButton } from './core.js';
import { openDiff, openFile, saveAll } from './editor.js';

const LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: 'C', typechange: 'T', copied: 'C' };
let status = null;
let refreshing = null;

export function refreshGit() {
  if (!app.project) return Promise.resolve();
  refreshing ??= (async () => {
    try {
      status = await pApi('/git/status');
    } catch (e) {
      status = { repo: false, error: e.message };
    } finally {
      refreshing = null;
    }
    render();
    emit('git-status', status);
  })();
  return refreshing;
}

function render() {
  const body = $('gitBody');
  body.textContent = '';
  const n = status?.files?.length || 0;
  $('gitBadge').hidden = !n;
  $('gitBadge').textContent = n > 99 ? '99+' : String(n);
  $('sbBranch').textContent = status?.repo ? `⎇ ${status.branch || '(detached)'}${status.ahead ? ` ↑${status.ahead}` : ''}${status.behind ? ` ↓${status.behind}` : ''}` : '⎇ no git';
  $('sbChanges').textContent = n ? `${n} change${n === 1 ? '' : 's'}` : '';
  if (!status?.repo) {
    body.append(
      el('p', { class: 'muted', text: status?.error || 'This project is not a git repository.' }),
      actionButton({ class: 'primary', text: 'Initialize Git' }, async () => { await pApi('/git/init', { method: 'POST' }); await refreshGit(); }),
    );
    return;
  }
  // branch row
  body.append(el('div', { class: 'row' },
    el('button', { class: 'ghost', title: 'Switch branch', text: `⎇ ${status.branch || '(detached)'} ▾`, onclick: guard(switchBranch) }),
    el('span', { class: 'grow' }),
    actionButton({ title: 'Pull (fast-forward)', text: `⇣ Pull${status.behind ? ` (${status.behind})` : ''}` }, pull),
    actionButton({ title: status.upstream ? `Push to ${status.upstream}` : 'Push and set upstream', text: `⇡ Push${status.ahead ? ` (${status.ahead})` : ''}` }, push),
  ));
  // commit box
  const msg = el('textarea', { id: 'gitMsg', rows: '2', placeholder: `Message (Ctrl+Enter to commit on "${status.branch}")` });
  msg.value = sessionStorage.getItem(`commitMsg:${app.project.id}`) || '';
  msg.addEventListener('input', () => sessionStorage.setItem(`commitMsg:${app.project.id}`, msg.value));
  const commitBtn = el('button', { class: 'primary', text: `✓ Commit${n ? ` ${n} file${n === 1 ? '' : 's'}` : ''}`, disabled: !n });
  const doCommit = busy(commitBtn, async () => {
    if (!msg.value.trim()) { msg.focus(); throw new Error('Write a commit message first'); }
    await saveAll();
    const c = await pApi('/git/commit', { method: 'POST', body: { message: msg.value } });
    sessionStorage.removeItem(`commitMsg:${app.project.id}`);
    toast(`Committed ${c.short}: ${c.subject}`, 'ok');
    await refreshGit();
    loadLog();
  });
  commitBtn.addEventListener('click', doCommit);
  msg.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doCommit(); } });
  body.append(msg, commitBtn);
  // files
  body.append(el('div', { class: 'git-sec', text: n ? `CHANGES (${n})` : 'NO CHANGES' }));
  const list = el('div', { class: 'git-files' });
  for (const f of status.files) {
    const L = LETTER[f.status] || 'M';
    list.append(el('div', { class: 'gf', title: `${f.status}: ${f.path}`, onclick: guard(() => showDiff(f)) },
      el('span', { class: `st ${L}`, text: L }),
      el('span', { class: 'p', text: f.path }),
      f.status !== 'deleted' ? el('button', { class: 'icon', title: 'Open file', text: '↗', onclick: guard((e) => { e.stopPropagation(); return openFile(f.path); }) }) : null,
      el('button', { class: 'icon x', title: 'Discard changes', text: '↺', onclick: guard(async (e) => {
        e.stopPropagation();
        if (!confirm(`Discard all changes to ${f.path}?${f.status === 'untracked' ? ' The new file will be deleted.' : ''}`)) return;
        await pApi('/git/discard', { method: 'POST', body: { path: f.path } });
        await refreshGit();
        emit('files-changed', [f.path]);
        emit('fs-changed');
      }) })));
  }
  body.append(list);
  body.append(el('div', { class: 'git-sec', text: 'RECENT COMMITS' }), el('div', { class: 'commits', id: 'gitLog' }));
  loadLog();
}

async function loadLog() {
  const box = $('gitLog');
  if (!box) return;
  try {
    const { commits } = await pApi('/git/log');
    box.textContent = '';
    for (const c of commits.slice(0, 15)) box.append(el('div', { title: `${c.hash}\n${c.author}, ${new Date(c.date).toLocaleString()}` }, el('b', { text: c.short }), ` ${c.subject}`));
    if (!commits.length) box.append(el('div', { text: 'No commits yet' }));
  } catch { box.textContent = ''; }
}

async function showDiff(f) {
  const { diff } = await pApi(`/git/diff?path=${encodeURIComponent(f.path)}`);
  openDiff(`Δ ${f.path.split('/').pop()}`, diff || `(no textual diff for ${f.path})`);
}

async function pull() {
  const r = await pApi('/git/pull', { method: 'POST' });
  toast(r.message || 'Pulled', 'ok');
  await refreshGit();
  emit('files-changed');
  emit('fs-changed');
}
async function push() {
  if (!app.cfg.gitTokenConfigured) toast('Pushing… (if the remote needs credentials, set GIT_TOKEN)');
  const r = await pApi('/git/push', { method: 'POST' });
  toast(r.message?.split('\n').filter((l) => l && !l.startsWith('To ')).slice(-2).join('\n') || 'Pushed', 'ok');
  await refreshGit();
}
async function switchBranch() {
  const { branches } = await pApi('/git/branches');
  const name = await prompt('Switch branch', {
    text: `Branches: ${branches.map((b) => (b.current ? `${b.name} (current)` : b.name)).join(', ')}. Type an existing name, or a new one to create it.`,
    placeholder: 'feature/login',
  });
  if (!name) return;
  const exists = branches.some((b) => b.name === name);
  await saveAll();
  await pApi('/git/checkout', { method: 'POST', body: { branch: name, create: !exists } });
  toast(`${exists ? 'Switched to' : 'Created'} ${name}`, 'ok');
  await refreshGit();
  emit('files-changed');
  emit('fs-changed');
}

$('gitRefresh').addEventListener('click', guard(refreshGit));
on('saved', () => refreshGit());
on('fs-changed', () => refreshGit());
on('files-changed', () => refreshGit());
