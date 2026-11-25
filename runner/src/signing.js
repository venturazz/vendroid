// Per-project release signing ("upload key" for Google Play). Keystores live in
// DATA_DIR/projects/<id>/signing/ (persistent volume, never inside the project/git). Passwords are
// generated, stored 0600 next to the keystore, and handed to keytool through the environment.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { childEnv, run } from './exec.js';
import { HttpError, bad } from './validate.js';

const dir = (projectId) => path.join(config.projectsDir, projectId, 'signing');
const metaFile = (projectId) => path.join(dir(projectId), 'signing.json');
const ksFile = (projectId) => path.join(dir(projectId), 'upload.jks');
const MAX_KEYSTORE = 64 * 1024;

const keytoolBin = () => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'keytool') : 'keytool');

function keytool(args, secrets = {}) {
  return run(keytoolBin(), args, { env: childEnv(secrets), timeoutMs: 60_000 });
}

function readMeta(projectId) {
  try { return JSON.parse(fs.readFileSync(metaFile(projectId), 'utf8')); } catch { return null; }
}

/** Signing values for a build: the project's upload key, else the global RELEASE_KEYSTORE_* env. */
export function signingFor(projectId) {
  const m = projectId ? readMeta(projectId) : null;
  if (m && fs.existsSync(ksFile(projectId))) {
    return { source: 'project', storeFile: ksFile(projectId), storePassword: m.storePassword, keyAlias: m.alias, keyPassword: m.keyPassword || m.storePassword };
  }
  if (config.signingEnabled()) return { source: 'env', ...config.signing };
  return null;
}

async function certInfo(projectId, m) {
  const r = await keytool(['-list', '-v', '-keystore', ksFile(projectId), '-alias', m.alias, '-storepass:env', 'VDR_STOREPASS'], { VDR_STOREPASS: m.storePassword });
  if (r.code !== 0) return { error: (r.stderr || r.stdout).trim().split('\n')[0] };
  const pick = (re) => (re.exec(r.stdout) || [])[1]?.trim() || null;
  return {
    owner: pick(/Owner:\s*(.+)/),
    validUntil: pick(/until:\s*(.+)/),
    sha256: pick(/SHA256:\s*([0-9A-F:]+)/),
    sha1: pick(/SHA1:\s*([0-9A-F:]+)/),
  };
}

/** Public view (no passwords). */
export async function info(projectId) {
  const m = readMeta(projectId);
  if (m && fs.existsSync(ksFile(projectId))) {
    return { configured: true, source: 'project', alias: m.alias, createdAt: m.createdAt, imported: !!m.imported, ...(await certInfo(projectId, m)) };
  }
  if (config.signingEnabled()) return { configured: true, source: 'env', alias: config.signing.keyAlias, file: path.basename(config.signing.storeFile) };
  return { configured: false };
}

const DN_PART = /^[A-Za-z0-9 .'-]{1,64}$/;

/** Create a new upload key (RSA 4096, ~27 years). */
export async function generate(projectId, { name, organization = '', country = '' }) {
  if (readMeta(projectId)) throw new HttpError(409, 'This project already has an upload key. Delete it first (keep a backup!).');
  if (typeof name !== 'string' || !DN_PART.test(name.trim())) throw bad('Name: 1-64 letters, digits, spaces, . \' -');
  if (organization && !DN_PART.test(organization)) throw bad('Organization: letters, digits, spaces, . \' -');
  if (country && !/^[A-Za-z]{2}$/.test(country)) throw bad('Country: 2-letter code, e.g. ID or US');
  const dn = [`CN=${name.trim()}`, organization && `O=${organization.trim()}`, country && `C=${country.toUpperCase()}`].filter(Boolean).join(', ');
  const pass = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(dir(projectId), { recursive: true, mode: 0o700 });
  const r = await keytool([
    '-genkeypair', '-keystore', ksFile(projectId), '-storetype', 'PKCS12', '-alias', 'upload',
    '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000', '-dname', dn,
    '-storepass:env', 'VDR_STOREPASS', '-keypass:env', 'VDR_STOREPASS', '-noprompt',
  ], { VDR_STOREPASS: pass });
  if (r.code !== 0) {
    fs.rmSync(ksFile(projectId), { force: true });
    throw new HttpError(422, `keytool failed: ${(r.stderr || r.stdout || r.error || '').trim().slice(0, 300)}`);
  }
  fs.chmodSync(ksFile(projectId), 0o600);
  fs.writeFileSync(metaFile(projectId), JSON.stringify({ alias: 'upload', storePassword: pass, keyPassword: pass, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return info(projectId);
}

/** Import an existing keystore (base64), verifying the passwords and alias with keytool first. */
export async function importKeystore(projectId, { data, storePassword, alias, keyPassword }) {
  if (readMeta(projectId)) throw new HttpError(409, 'This project already has an upload key. Delete it first.');
  if (typeof data !== 'string' || !data) throw bad('keystore file is required');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > MAX_KEYSTORE) throw bad('Keystore must be a .jks/.p12 file under 64 KB');
  for (const [k, v] of Object.entries({ storePassword, alias })) if (typeof v !== 'string' || !v || v.length > 200) throw bad(`${k} is required`);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(alias)) throw bad('Invalid alias');
  fs.mkdirSync(dir(projectId), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ksFile(projectId), buf, { mode: 0o600 });
  const m = { alias, storePassword, keyPassword: keyPassword || storePassword, createdAt: new Date().toISOString(), imported: true };
  const check = await certInfo(projectId, m);
  if (check.error || !check.sha256) {
    fs.rmSync(ksFile(projectId), { force: true });
    throw bad(`Keystore could not be opened with that password/alias: ${check.error || 'alias not found'}`);
  }
  fs.writeFileSync(metaFile(projectId), JSON.stringify(m), { mode: 0o600 });
  return info(projectId);
}

/** Keystore bytes + passwords for the owner to back up. */
export function exportKeystore(projectId) {
  const m = readMeta(projectId);
  if (!m || !fs.existsSync(ksFile(projectId))) throw new HttpError(404, 'No upload key for this project');
  return { file: ksFile(projectId), alias: m.alias, storePassword: m.storePassword, keyPassword: m.keyPassword };
}

export function remove(projectId, confirm) {
  if (confirm !== 'DELETE') throw bad('Type DELETE to confirm. Without a backup you will need Play support to reset the upload key.');
  fs.rmSync(dir(projectId), { recursive: true, force: true });
  return { ok: true };
}
