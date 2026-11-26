// 9Router (fast analysis) and Hermes Agent (async investigation) integrations.
import net from 'node:net';
import crypto from 'node:crypto';
import { config } from './config.js';
import { bad } from './validate.js';

const MAX_CHARS = 12_000;

/** Slice a Gradle log down to the part that explains the failure. */
export function sliceBuildError(text) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^\* What went wrong:/.test(l));
  const kotlin = lines.filter((l) => /^e: /.test(l) || /error:/i.test(l)).slice(-40);
  let out;
  if (idx >= 0) {
    out = lines.slice(Math.max(0, idx - 3), idx + 80).join('\n');
    if (kotlin.length) out = kotlin.join('\n') + '\n---\n' + out;
  } else if (kotlin.length) {
    out = kotlin.join('\n') + '\n---\n' + lines.slice(-60).join('\n');
  } else {
    out = lines.slice(-120).join('\n');
  }
  return out.length > MAX_CHARS ? out.slice(-MAX_CHARS) : out;
}

/** Slice a logcat dump down to the last crash. */
export function sliceCrash(text) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/FATAL EXCEPTION/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/ANR in |Fatal signal|AndroidRuntime.*(Exception|Error)/.test(lines[i])) { start = i; break; }
    }
  }
  const out = start >= 0 ? lines.slice(Math.max(0, start - 2), start + 70).join('\n') : lines.slice(-100).join('\n');
  return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) : out;
}

const SYSTEM = `You are an expert Android/Kotlin/Jetpack Compose/Gradle engineer. Analyze the supplied log excerpt.
Reply with ONLY a JSON object, no markdown fences, with keys:
"rootCause" (string, 1-3 sentences),
"affected" (array of strings: files, classes, functions or Gradle plugins/dependencies involved),
"fixSteps" (array of concise, ordered, actionable strings),
"confidence" ("low"|"medium"|"high").
If the log does not contain enough information, say so in rootCause and lower confidence.`;

export async function analyze({ mode, text }) {
  if (!['build_error', 'logcat_crash'].includes(mode)) throw bad('mode must be build_error or logcat_crash');
  if (typeof text !== 'string' || !text.trim()) throw bad('No log text to analyze');
  const excerpt = mode === 'build_error' ? sliceBuildError(text) : sliceCrash(text);
  const headers = { 'Content-Type': 'application/json' };
  if (config.nineRouterApiKey) headers.Authorization = `Bearer ${config.nineRouterApiKey}`;
  let res;
  try {
    res = await fetch(`${config.nineRouterUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(config.aiTimeoutMs),
      body: JSON.stringify({
        model: config.nineRouterModel,
        temperature: 0.2,
        max_tokens: 1200,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Kind: ${mode === 'build_error' ? 'Gradle build failure' : 'Android logcat crash'}\n\n${excerpt}` },
        ],
      }),
    });
  } catch (e) {
    const err = new Error(`9Router unreachable: ${e.message}`);
    err.status = 502;
    throw err;
  }
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`9Router returned ${res.status}: ${body.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  let content = '';
  try {
    content = JSON.parse(body).choices?.[0]?.message?.content ?? '';
  } catch { /* handled below */ }
  if (!content) {
    const err = new Error('9Router returned an empty completion');
    err.status = 502;
    throw err;
  }
  return { mode, model: config.nineRouterModel, excerpt, analysis: parseAnalysis(content), raw: content };
}

function parseAnalysis(content) {
  const m = /\{[\s\S]*\}/.exec(content);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const arr = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
    return {
      rootCause: String(j.rootCause ?? ''),
      affected: arr(j.affected),
      fixSteps: arr(j.fixSteps),
      confidence: String(j.confidence ?? 'unknown'),
    };
  } catch {
    return null;
  }
}

/** POST an investigation request to the Hermes Agent webhook. */
export async function notifyHermes(payload) {
  const headers = { 'Content-Type': 'application/json', 'X-Request-ID': crypto.randomUUID() };
  const body = {
    event: payload.event || 'manual_investigation',
    event_type: payload.event || 'manual_investigation', // Hermes webhook routes filter on event_type
    jobId: payload.jobId ?? null,
    projectId: payload.projectId || null,
    projectName: payload.projectName || null,
    projectPath: payload.projectPath || config.projectPath || null,
    packageName: payload.packageName || config.defaultPackage || null,
    deviceSerial: payload.deviceSerial || config.defaultDevice || null,
    errorTail: String(payload.errorTail || '').slice(-MAX_CHARS),
    crashSnippet: String(payload.crashSnippet || '').slice(0, MAX_CHARS),
    ...(payload.task ? { task: String(payload.task).slice(0, 20_000) } : {}),
    ...(payload.files ? { files: payload.files.slice(0, 50) } : {}),
    // Hermes can act on this project through the runner's MCP endpoint (tools: builds, adb, files, git).
    runner: { mcpPath: '/mcp', restToolsPath: '/api/agent/tools' },
    timestamp: new Date().toISOString(),
  };
  try {
    const raw = JSON.stringify(body);
    if (config.hermesWebhookSecret) {
      // Hermes "generic" V2 signature: hex HMAC-SHA256 of "<unix-seconds>.<raw body>" (replay-protected).
      const ts = String(Math.floor(Date.now() / 1000));
      headers['X-Webhook-Timestamp'] = ts;
      headers['X-Webhook-Signature-V2'] = crypto.createHmac('sha256', config.hermesWebhookSecret).update(`${ts}.${raw}`).digest('hex');
    }
    const res = await fetch(config.hermesWebhookUrl, {
      method: 'POST',
      headers,
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await res.text()).slice(0, 500);
    return { ok: res.ok, status: res.status, response: text };
  } catch (e) {
    return { ok: false, status: 0, response: `Hermes unreachable: ${e.message}` };
  }
}

function tcpProbe(urlStr) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve(false); }
    const s = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

export async function aiStatus() {
  const [nineRouter, hermes] = await Promise.all([tcpProbe(config.nineRouterUrl), tcpProbe(config.hermesWebhookUrl)]);
  return {
    nineRouter: { reachable: nineRouter, url: config.nineRouterUrl, model: config.nineRouterModel, keyConfigured: !!config.nineRouterApiKey },
    hermes: { reachable: hermes, url: config.hermesWebhookUrl, secretConfigured: !!config.hermesWebhookSecret },
  };
}
