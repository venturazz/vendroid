// Phone layout (≤ 760 px): one full-screen view at a time (Files · Code · Build · AI) with a bottom
// navigation bar. Other modules ask for a view with emit('reveal', view); on desktop that is a no-op.
import { $, app, on, pref, setPref } from './core.js';
import { toggleAi } from './ai.js';

const mq = matchMedia('(max-width: 760px)');
const VIEWS = ['files', 'code', 'build', 'ai'];
let view = pref('mview', 'code');

export const isPhone = () => mq.matches;

function apply() {
  const phone = mq.matches && !!app.project;
  document.body.classList.toggle('phone', phone);
  for (const v of VIEWS) document.body.classList.toggle(`m-${v}`, phone && view === v);
  $('mnav').hidden = !phone;
  if (!phone) return;
  document.querySelectorAll('#mnav [data-mview]').forEach((b) => b.classList.toggle('active', b.dataset.mview === view));
  if (view === 'files') $('sidebar').hidden = false;
  if (view === 'build') { $('bottom').classList.remove('collapsed'); $('bottomToggle').textContent = '▾'; }
  if (view === 'ai' && $('aipanel').hidden) toggleAi(true, { reveal: false });
  if (view === 'code') $('mnavCode').classList.remove('badge-dot');
  if (view === 'build') $('mnavBuild').classList.remove('badge-dot');
}

export function setMView(v) {
  if (!VIEWS.includes(v)) return;
  view = v;
  setPref('mview', v);
  apply();
}

document.querySelectorAll('#mnav [data-mview]').forEach((b) => b.addEventListener('click', () => setMView(b.dataset.mview)));
on('reveal', (v) => { if (mq.matches) setMView(v); });
on('project-opened', () => { if (!VIEWS.includes(view)) view = 'code'; apply(); });
mq.addEventListener('change', apply);

// Activity elsewhere: mark the nav button instead of yanking the user away from what they read.
on('files-live', () => { if (mq.matches && view !== 'code' && app.aiRunning) $('mnavCode').classList.add('badge-dot'); });
on('build-live', (b) => { if (mq.matches && view !== 'build' && b.projectId === app.project?.id) $('mnavBuild').classList.add('badge-dot'); });
on('build-state', (b) => {
  if (!mq.matches || b.projectId !== app.project?.id) return;
  $('mnavBuild').dataset.state = ['succeeded', 'failed', 'cancelled'].includes(b.state) ? b.state : 'running';
});
// Leaving the project (hub) drops the phone chrome.
window.addEventListener('hashchange', () => setTimeout(apply));
