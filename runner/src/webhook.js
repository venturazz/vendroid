// Git push webhook verification (GitHub, Gitea/Forgejo, GitLab).
import crypto from 'node:crypto';

const eq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Returns { ok, reason?, ping?, ref?, deleted? } for a raw request body. */
export function verifyGitWebhook(req, raw, secret) {
  const h = req.headers;
  const sig = h['x-hub-signature-256'] || (h['x-gitea-signature'] ? `sha256=${h['x-gitea-signature']}` : '');
  if (sig) {
    const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!eq(sig, want)) return { ok: false, reason: 'Invalid webhook signature' };
  } else if (h['x-gitlab-token'] !== undefined) {
    if (!eq(h['x-gitlab-token'], secret)) return { ok: false, reason: 'Invalid webhook token' };
  } else {
    return { ok: false, reason: 'Missing webhook signature' };
  }
  const event = h['x-github-event'] || h['x-gitea-event'] || h['x-gitlab-event'] || '';
  if (event === 'ping') return { ok: true, ping: true };
  let payload = {};
  try {
    const ct = String(h['content-type'] || '');
    const text = raw.toString('utf8');
    // GitHub can also send application/x-www-form-urlencoded with a `payload` field.
    payload = ct.includes('x-www-form-urlencoded') ? JSON.parse(new URLSearchParams(text).get('payload') || '{}') : JSON.parse(text || '{}');
  } catch {
    return { ok: false, reason: 'Invalid JSON payload' };
  }
  if (event && !/push/i.test(event)) return { ok: true, ref: null };
  return {
    ok: true,
    ref: typeof payload.ref === 'string' ? payload.ref : null,
    deleted: payload.deleted === true || /^0+$/.test(String(payload.after || '1')),
  };
}
