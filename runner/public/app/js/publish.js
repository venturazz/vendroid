// Publish panel: Google Play readiness checklist, one-click fixes, upload key, signed .aab.
import { $, app, pApi, el, toast, guard, actionButton, emit, on, fmtSize, fmtAgo } from './core.js';
import { reloadFromDisk, saveAll } from './editor.js';

const ICON = { pass: '✔', fail: '✖', warn: '▲', info: 'ℹ' };
let last = null;

export async function refreshPublish() {
  if (!app.project) return;
  const body = $('playBody');
  let r;
  let key;
  try {
    [r, key] = await Promise.all([pApi('/play'), pApi('/signing')]);
  } catch (e) { body.textContent = e.message; return; }
  last = r;
  $('playBadge').hidden = r.fail === 0;
  $('playBadge').textContent = String(r.fail);
  body.textContent = '';
  body.append(summary(r), ...r.checks.map((c) => check(c, r)), keyCard(key), bundleCard(r.latestBundle),
    el('p', { class: 'muted small' }, 'Sources: ', el('a', { href: r.docs.targetSdk, target: '_blank', rel: 'noopener', text: 'target API' }), ' · ',
      el('a', { href: r.docs.pageSize, target: '_blank', rel: 'noopener', text: '16 KB pages' }), ' · ',
      el('a', { href: r.docs.appSigning, target: '_blank', rel: 'noopener', text: 'Play App Signing' })));
}

function summary(r) {
  return el('div', { class: `play-sum ${r.ready ? 'ok' : 'bad'}` },
    el('b', { text: r.ready ? (r.warn ? `Ready to upload · ${r.warn} warning${r.warn === 1 ? '' : 's'}` : 'Ready to upload to Google Play') : `${r.fail} blocker${r.fail === 1 ? '' : 's'} before Play accepts this app` }),
    el('span', { class: 'muted small', text: `Required now: target API ${r.targetSdkRequired}+, signed .aab, 16 KB-compatible native code.` }),
    el('div', { class: 'row' },
      actionButton({ class: 'primary small', text: '📦 Build signed AAB' }, buildAab),
      el('span', { class: 'grow' })));
}

function check(c) {
  const actions = [];
  if (c.action === 'set-target' && c.status === 'fail') actions.push(actionButton({ class: 'primary', text: `Set targetSdk ${last.targetSdkRequired}` }, fixTarget));
  if (c.action === 'bump') {
    actions.push(actionButton({ text: '+ patch' }, () => bump('patch')), actionButton({ text: '+ minor' }, () => bump('minor')), actionButton({ text: '+ major' }, () => bump('major')));
  }
  if (c.action === 'signing' && c.status === 'fail') actions.push(el('button', { class: 'primary', text: 'Create upload key ↓', onclick: () => $('keyName')?.focus() }));
  if (c.action === 'build-aab' && c.status !== 'pass') actions.push(actionButton({ text: '📦 Build AAB' }, buildAab));
  return el('div', { class: `pcheck ${c.status}` },
    el('span', { class: 'si', text: ICON[c.status] }),
    el('div', { class: 'grow' },
      el('div', { class: 'pt', text: c.title }),
      el('div', { class: 'pd', text: c.detail }),
      c.fix && c.status !== 'pass' ? el('div', { class: 'pf', text: `→ ${c.fix}` }) : null,
      actions.length ? el('div', { class: 'pa' }, actions) : null));
}

function keyCard(k) {
  const card = el('div', { class: 'keycard' }, el('h4', { text: '🔑 Upload key' }));
  if (k.configured && k.source === 'project') {
    const fp = el('div', { class: 'fp', text: `SHA-256 ${k.sha256 || '?'}` });
    card.append(
      el('div', { text: `${k.owner || ''}${k.imported ? ' (imported)' : ''} · alias ${k.alias} · valid until ${k.validUntil || '?'}` }),
      fp,
      el('div', { class: 'fp', text: `SHA-1 ${k.sha1 || '?'}` }),
      el('div', { class: 'warnbox', text: 'Back up this key and its password now. If you lose it you must ask Google Play support to reset the upload key; with Play App Signing your app itself stays safe.' }),
      el('div', { class: 'row' },
        el('a', { class: 'btn small', href: `/api/projects/${encodeURIComponent(app.project.id)}/signing/keystore`, text: '⬇ Keystore (.jks)' }),
        actionButton({ class: 'small', text: 'Show passwords' }, async () => {
          const s = await pApi('/signing/secrets');
          window.prompt(`Alias "${s.alias}". Store and key password (copy it to your password manager):`, s.storePassword);
        }),
        actionButton({ class: 'small', text: 'Copy SHA-256' }, async () => { await navigator.clipboard.writeText(k.sha256 || ''); toast('Copied (needed for Firebase, Google Sign-In, App Links)', 'ok'); }),
        el('span', { class: 'grow' }),
        actionButton({ class: 'small danger', text: 'Delete' }, async () => {
          const c = window.prompt('Type DELETE to remove the upload key from Vendroid (download a backup first):');
          if (c === null) return;
          await pApi('/signing/delete', { method: 'POST', body: { confirm: c } });
          toast('Upload key removed', 'ok');
          refreshPublish();
        })));
    return card;
  }
  if (k.configured && k.source === 'env') {
    card.append(el('div', { text: `Using RELEASE_KEYSTORE_* from the server settings (${k.file}, alias ${k.alias}). Create a project key to override it.` }));
  }
  const name = el('input', { id: 'keyName', placeholder: 'Your name or company (certificate CN)', maxlength: '64' });
  const org = el('input', { placeholder: 'Organization (optional)', maxlength: '64' });
  const country = el('input', { placeholder: 'Country code, e.g. ID (optional)', maxlength: '2' });
  card.append(
    el('div', { class: 'muted', text: 'Google Play needs every bundle signed with your upload key. Vendroid can create one (RSA 4096, valid ~27 years) and keeps it outside your project and git.' }),
    name, org, country,
    actionButton({ class: 'primary small', text: 'Generate upload key' }, async () => {
      await pApi('/signing/generate', { method: 'POST', body: { name: name.value.trim(), organization: org.value.trim(), country: country.value.trim() } });
      toast('Upload key created. Download a backup now.', 'ok');
      refreshPublish();
    }));
  const file = el('input', { type: 'file', accept: '.jks,.keystore,.p12,.pfx' });
  const alias = el('input', { placeholder: 'Key alias', value: 'upload' });
  const pass = el('input', { type: 'password', placeholder: 'Keystore password', autocomplete: 'off' });
  const kpass = el('input', { type: 'password', placeholder: 'Key password (if different)', autocomplete: 'off' });
  card.append(el('details', {}, el('summary', { text: 'I already have a keystore' }), file, alias, pass, kpass,
    actionButton({ class: 'small', text: 'Import keystore' }, async () => {
      const f = file.files[0];
      if (!f) throw new Error('Choose the .jks/.p12 file');
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.onerror = () => rej(new Error('Could not read file'));
        r.readAsDataURL(f);
      });
      await pApi('/signing/import', { method: 'POST', body: { data, alias: alias.value.trim(), storePassword: pass.value, ...(kpass.value ? { keyPassword: kpass.value } : {}) } });
      toast('Keystore imported', 'ok');
      refreshPublish();
    })));
  return card;
}

function bundleCard(b) {
  if (!b) return el('div');
  return el('div', { class: 'keycard' },
    el('h4', { text: '📦 Latest bundle' }),
    el('div', { text: `v${b.versionName || '?'} (code ${b.versionCode || '?'}) · ${b.signed ? 'signed' : 'UNSIGNED'} · ${fmtSize(b.apk.size)} · ${fmtAgo(b.finishedAt)}` }),
    el('div', { class: 'row' },
      el('a', { class: 'btn small primary', href: `/api/builds/${b.id}/apk`, text: '⬇ Download .aab' }),
      el('span', { class: 'muted small', text: 'Upload in Play Console → Test and release → Create release.' })));
}

async function fixTarget() {
  await saveAll();
  const r = await pApi('/play/target-sdk', { method: 'POST' });
  await reloadFromDisk([r.file]);
  emit('fs-changed');
  toast(`targetSdk set to ${r.targetSdk} in ${r.file}. Test the app: Android 16 behaviour changes apply.`, 'ok');
  refreshPublish();
}
async function bump(part) {
  await saveAll();
  const r = await pApi('/play/bump', { method: 'POST', body: { part } });
  await reloadFromDisk([r.file]);
  emit('fs-changed');
  toast(`Version ${r.versionName || ''} (code ${r.versionCode})`, 'ok');
  refreshPublish();
}
async function buildAab() {
  await saveAll();
  $('task').value = 'bundleRelease';
  emit('run', { install: false });
}

$('playRefresh').addEventListener('click', guard(refreshPublish));
on('build-state', (b) => {
  if (b.projectId === app.project?.id && ['succeeded', 'failed'].includes(b.state) && !$('playBody').closest('.pane').hidden) refreshPublish();
});
