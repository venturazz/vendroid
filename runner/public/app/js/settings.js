// Settings dialog: agent (MCP/REST) connection details, git identity, environment checks.
import { $, app, api, el, toast, guard } from './core.js';

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
export { CHECK_LABELS };
