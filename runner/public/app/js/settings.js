// Settings dialog: agent (MCP/REST) connection details, git identity, environment checks.
import { $, app, api, el, toast, guard, emit, actionButton } from './core.js';

let info = null;
const CHECK_LABELS = {
  aarch64: 'CPU is aarch64', java: 'Java', androidHome: 'ANDROID_HOME', adb: 'adb', aapt2: 'aapt2 (ARM64)', project: 'Legacy project',
};

export async function openSettings() {
  const d = $('dlgSettings');
  d.showModal();
  try { info = await api('/api/agent/info'); } catch (e) { toast(e.message, 'err'); return; }
  const publicUrl = `${location.origin}/mcp`;
  $('mcpLocal').textContent = info.localUrl;
  $('mcpPublic').textContent = publicUrl;
  $('mcpToken').textContent = '••••••••••••';
  $('mcpToken').dataset.secret = info.token;
  $('mcpShow').textContent = 'Show';
  $('mcpRotate').disabled = info.tokenSource !== 'generated';
  $('mcpRotate').title = info.tokenSource === 'generated' ? 'Generate a new token (agents must be updated)' : `Set by ${info.tokenSource}`;
  $('hermesInfo').textContent = `${info.hermes.url} · secret ${info.hermes.secretConfigured ? 'configured' : 'not set (HERMES_WEBHOOK_SECRET)'}`
    + ` · write tools ${info.writeTools ? 'enabled' : 'disabled'}`;
  $('hermesSnippet').textContent = [
    '# Hermes Agent ~/.hermes/config.yaml (hermes-agent docs: MCP Config Reference)',
    '# Use the local URL when Hermes runs on the host or with network_mode: host,',
    '# otherwise the public URL (works from any container).',
    'mcp_servers:',
    '  vendroid:',
    `    url: "${info.localUrl}"`,
    '    headers:',
    '      Authorization: "Bearer <token from Settings>"',
    '    timeout: 900   # start_build with waitSeconds blocks until the build ends',
    '',
    '# Any MCP client (Streamable HTTP, stateless):',
    `curl -s ${publicUrl} -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    '',
    '# REST equivalent of any tool:',
    `curl -s ${location.origin}/api/agent/tools/start_build -H "Authorization: Bearer $TOKEN" \\`,
    `  -H 'Content-Type: application/json' -d '{"project":"my-app","install":true,"launch":true,"waitSeconds":600}'`,
  ].join('\n');
  $('gitInfo').textContent = `Commits as ${app.cfg.gitIdentity?.name} <${app.cfg.gitIdentity?.email}> (GIT_USER_NAME / GIT_USER_EMAIL). `
    + (app.cfg.gitTokenConfigured ? 'GIT_TOKEN is set: clone, pull and push work for private HTTPS repositories.' : 'No GIT_TOKEN: public repositories only, unless the remote URL contains a token.');
  await renderProviders();
  try {
    const h = await api('/api/health/env');
    const t = $('envTable');
    t.textContent = '';
    const row = (k, v, ok) => t.append(el('tr', {}, el('td', { text: k }), el('td', { class: ok === undefined ? '' : ok ? 'okc' : 'badc', text: v })));
    row('Architecture', `${h.arch.uname} (node ${h.arch.nodeArch})`, h.checks.aarch64);
    row('Java', h.java.version || 'not found', h.checks.java);
    row('Android SDK', `${h.androidHome.path} · bootstrap ${h.sdkBootstrap}`, h.checks.androidHome && h.sdkBootstrap !== 'failed');
    row('adb', `${h.adb.version || 'not found'} (${h.adb.bin})`, h.checks.adb);
    row('aapt2', `${h.aapt2.version || 'not working'} · ${h.aapt2.path || ''}`, h.checks.aapt2);
    row('Disk free', `data ${h.disk.data.freeGb ?? '?'} GB`, (h.disk.data.freeGb ?? 99) > 5);
    row('Memory', `${h.memory.availableGb} GB available of ${h.memory.totalGb} GB`, h.memory.availableGb > 8);
    row('Gradle limits', `${h.limits.gradleJvmArgs} · Kotlin ${h.limits.kotlinDaemonJvmArgs} · ${h.limits.maxWorkers} workers`);
  } catch { /* shown in badge */ }
}

$('mcpShow').addEventListener('click', () => {
  const c = $('mcpToken');
  const shown = $('mcpShow').textContent === 'Hide';
  c.textContent = shown ? '••••••••••••' : c.dataset.secret || '';
  $('mcpShow').textContent = shown ? 'Show' : 'Hide';
});
$('mcpRotate').addEventListener('click', guard(async () => {
  if (!confirm('Generate a new agent token? Hermes and other agents using the old token stop working until updated.')) return;
  const r = await api('/api/agent/rotate', { method: 'POST' });
  $('mcpToken').dataset.secret = r.token;
  $('mcpToken').textContent = r.token;
  $('mcpShow').textContent = 'Hide';
  toast('New token generated', 'ok');
}));
document.querySelectorAll('#dlgSettings [data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const src = $(b.dataset.copy);
  const text = src.dataset.secret || src.textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch { toast('Clipboard not available (HTTPS required)', 'err'); }
}));
$('settingsClose').addEventListener('click', () => $('dlgSettings').close());

async function renderProviders() {
  const t = $('provTable');
  t.textContent = '';
  let list = [];
  try { list = (await api('/api/ai/providers')).providers; } catch (e) { t.append(el('tr', {}, el('td', { text: e.message }))); return; }
  for (const p of list) {
    const status = el('span', { class: 'muted small' });
    t.append(el('tr', {},
      el('td', {}, el('b', { text: p.name }), ' ', el('span', { class: `tag ${p.kind === 'hermes' ? 'hermes' : ''}`, text: p.kind === 'hermes' ? 'Hermes' : 'OpenAI-compatible' })),
      el('td', {},
        el('code', { text: p.baseUrl }), ` · model ${p.model || '(default)'} · key ${p.hasKey ? '✔' : '—'}${p.builtin ? ' · from env' : ''} `,
        actionButton({ class: 'small', text: 'Test' }, async () => {
          status.textContent = 'testing…';
          const r = await api(`/api/ai/providers/${encodeURIComponent(p.id)}/test`, { method: 'POST', body: {} });
          status.textContent = r.ok ? `✔ ${r.latencyMs} ms · "${r.reply}"` : `✖ ${r.status || ''} ${r.error}`;
          status.className = r.ok ? 'okc small' : 'badc small';
        }), ' ',
        p.builtin ? null : actionButton({ class: 'small danger', text: 'Delete' }, async () => {
          if (!confirm(`Delete provider ${p.name}?`)) return;
          await api(`/api/ai/providers/${encodeURIComponent(p.id)}/delete`, { method: 'POST', body: {} });
          emit('providers-changed');
          renderProviders();
        }), ' ', status)));
  }
  if (!list.length) t.append(el('tr', {}, el('td', { text: 'No providers yet.' })));
}
$('pvKind').addEventListener('change', () => {
  if ($('pvKind').value === 'hermes') {
    if (!$('pvUrl').value) $('pvUrl').value = 'http://127.0.0.1:8642/v1';
    if (!$('pvModel').value) $('pvModel').value = 'hermes-agent';
    if (!$('pvName').value) $('pvName').value = 'Hermes Agent';
  }
});
$('pvSave').addEventListener('click', guard(async () => {
  $('pvErr').textContent = '';
  try {
    await api('/api/ai/providers', { method: 'POST', body: { name: $('pvName').value.trim(), kind: $('pvKind').value, baseUrl: $('pvUrl').value.trim(), apiKey: $('pvKey').value, model: $('pvModel').value.trim() } });
  } catch (e) { $('pvErr').textContent = e.message; return; }
  for (const id of ['pvName', 'pvUrl', 'pvKey', 'pvModel']) $(id).value = '';
  $('provAdd').open = false;
  toast('Provider saved. Pick it in the AI panel.', 'ok');
  emit('providers-changed');
  renderProviders();
}));
export { CHECK_LABELS };
