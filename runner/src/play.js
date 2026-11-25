// Google Play readiness: checks a project's Gradle config and its latest release artifact against
// the store's technical requirements, and helps fix them (upload key, version bump, AAB build).
// Requirements as of Nov 2026 (PLAY_TARGET_SDK overrides the target level when Google raises it):
//  - new apps & updates must target API 36 (Android 16)           developer.android.com/google/play/requirements/target-sdk
//  - 64-bit native libs must support 16 KB pages (updates blocked from 2027-02-01)  …/guide/practices/page-sizes
//  - new apps are published as Android App Bundles (.aab), signed with an upload key
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import * as files from './files.js';
import { signingFor } from './signing.js';
import { HttpError, bad } from './validate.js';

export const PLAY_TARGET_SDK = Number(process.env.PLAY_TARGET_SDK) || 36;
const PAGE_16K = 16 * 1024;

// Permissions that need a Play Console declaration or are restricted by policy.
const SENSITIVE = {
  'android.permission.READ_SMS': 'SMS/Call Log policy: only default SMS/phone apps; needs a Permissions Declaration.',
  'android.permission.SEND_SMS': 'SMS/Call Log policy: only default SMS apps; needs a Permissions Declaration.',
  'android.permission.RECEIVE_SMS': 'SMS/Call Log policy: needs a Permissions Declaration.',
  'android.permission.READ_CALL_LOG': 'SMS/Call Log policy: needs a Permissions Declaration.',
  'android.permission.WRITE_CALL_LOG': 'SMS/Call Log policy: needs a Permissions Declaration.',
  'android.permission.PROCESS_OUTGOING_CALLS': 'SMS/Call Log policy: needs a Permissions Declaration.',
  'android.permission.QUERY_ALL_PACKAGES': 'Package visibility policy: use <queries> instead unless the core feature needs all apps.',
  'android.permission.MANAGE_EXTERNAL_STORAGE': 'All files access: only for file managers/backup apps; needs a declaration.',
  'android.permission.ACCESS_BACKGROUND_LOCATION': 'Background location: needs a declaration and a video in Play Console.',
  'android.permission.REQUEST_INSTALL_PACKAGES': 'Installing other apps: core purpose only; needs a declaration.',
  'android.permission.READ_MEDIA_IMAGES': 'Photo/video policy: use the Android photo picker unless broad access is core; needs a declaration.',
  'android.permission.READ_MEDIA_VIDEO': 'Photo/video policy: use the Android photo picker unless broad access is core; needs a declaration.',
  'android.permission.SYSTEM_ALERT_WINDOW': 'Draw over other apps: reviewed by Play; explain in the listing.',
  'android.permission.USE_FULL_SCREEN_INTENT': 'Full-screen intents: limited to calling/alarm apps on Android 14+; needs a declaration.',
  'android.permission.SCHEDULE_EXACT_ALARM': 'Exact alarms: prefer USE_EXACT_ALARM only for alarm/calendar apps; otherwise justify.',
  'android.permission.BIND_ACCESSIBILITY_SERVICE': 'Accessibility API: needs a declaration and prominent disclosure.',
  'android.permission.BIND_VPN_SERVICE': 'VpnService: needs a declaration.',
};
const FGS = /android\.permission\.FOREGROUND_SERVICE_[A-Z_]+/g;

// ---------------------------------------------------------------- zip / ELF helpers
function zipIndex(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a ZIP file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const out = [];
    for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + nameLen), method, csize, usize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { size, entries: out };
  } finally { fs.closeSync(fd); }
}

function readEntry(file, e, maxBytes = 64 * 1024 * 1024) {
  if (e.usize > maxBytes) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, e.local);
    const dataStart = e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = Buffer.alloc(e.csize);
    fs.readSync(fd, raw, 0, e.csize, dataStart);
    return { data: e.method === 0 ? raw : zlib.inflateRawSync(raw), dataStart };
  } finally { fs.closeSync(fd); }
}

/** Minimum PT_LOAD alignment of a 64-bit ELF shared object, or null if not ELF64. */
export function elfLoadAlign(buf) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 2) return null;
  const le = buf[5] === 1;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const phoff = u64(32);
  const phentsize = u16(54);
  const phnum = u16(56);
  let min = Infinity;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (o + 56 > buf.length) break;
    if (u32(o) === 1) min = Math.min(min, u64(o + 48)); // PT_LOAD p_align
  }
  return Number.isFinite(min) ? min : null;
}

/** 16 KB page-size compatibility of the 64-bit native libraries inside an APK/AAB. */
export function pageSizeReport(file) {
  const { entries } = zipIndex(file);
  const isApk = file.endsWith('.apk');
  const libs = entries.filter((e) => /(^|\/)lib\/(arm64-v8a|x86_64)\/[^/]+\.so$/.test(e.name));
  const bad = [];
  for (const e of libs) {
    const r = readEntry(file, e);
    if (!r) continue;
    const align = elfLoadAlign(r.data);
    if (align !== null && align < PAGE_16K) bad.push({ lib: e.name, issue: `LOAD segments aligned to ${align} bytes (needs ${PAGE_16K})` });
    else if (isApk && e.method === 0 && r.dataStart % PAGE_16K !== 0) bad.push({ lib: e.name, issue: 'uncompressed in the APK but not 16 KB zip-aligned' });
  }
  return { nativeLibs: libs.length, bad };
}

// ---------------------------------------------------------------- source inspection
function moduleBuildFile(p) {
  const base = path.join(p.path, ...p.module.split(':'));
  for (const f of ['build.gradle.kts', 'build.gradle']) if (fs.existsSync(path.join(base, f))) return path.join(base, f);
  return null;
}

function sourcePermissions(p) {
  const out = new Set();
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (['build', '.gradle', '.git', 'node_modules'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 8) walk(full, depth + 1);
      else if (e.name === 'AndroidManifest.xml') {
        const t = fs.readFileSync(full, 'utf8');
        for (const m of t.matchAll(/uses-permission(?:-sdk-23)?[^>]*android:name="([^"]+)"/g)) out.add(m[1]);
      }
    }
  };
  walk(p.path, 0);
  return [...out];
}

// ---------------------------------------------------------------- checks
const C = (id, title, status, detail, fix, action) => ({ id, title, status, detail, ...(fix ? { fix } : {}), ...(action ? { action } : {}) });

/**
 * @param p project record
 * @param releaseBuilds succeeded release builds of this project (newest first), with artifact paths
 */
export function checks(p, releaseBuilds, artifactPath) {
  const out = [];
  const build = moduleBuildFile(p);
  const gradle = build ? fs.readFileSync(build, 'utf8') : '';

  // 1. target API
  if (!p.targetSdk) out.push(C('target-sdk', `Target API ${PLAY_TARGET_SDK}+`, 'warn', 'targetSdk not found in the module build file (maybe in a version catalog).', `Make sure targetSdk ≥ ${PLAY_TARGET_SDK}.`));
  else if (p.targetSdk < PLAY_TARGET_SDK) {
    out.push(C('target-sdk', `Target API ${PLAY_TARGET_SDK}+`, 'fail', `targetSdk is ${p.targetSdk}. Google Play rejects new apps and updates below API ${PLAY_TARGET_SDK} (Android 16).`,
      `Set targetSdk = ${PLAY_TARGET_SDK} (and compileSdk ≥ ${PLAY_TARGET_SDK}), then test behaviour changes.`, 'set-target'));
  } else out.push(C('target-sdk', `Target API ${PLAY_TARGET_SDK}+`, 'pass', `targetSdk ${p.targetSdk}.`));

  // 2. application id
  const pkg = p.packageName || '';
  if (!pkg) out.push(C('package', 'Unique application ID', 'fail', 'No applicationId found.', 'Set applicationId in the app module.'));
  else if (/^(com\.example|com\.android|android)\b|^(org\.example|net\.example)\b/.test(pkg)) {
    out.push(C('package', 'Unique application ID', 'fail', `"${pkg}" is reserved; Play rejects com.example.* and android.* packages.`, 'Change applicationId (and namespace) to a domain you own, e.g. com.yourname.app. It can never change after the first upload.'));
  } else out.push(C('package', 'Unique application ID', 'pass', `${pkg} (permanent after the first upload).`));

  // 3. version
  const vc = p.versionCode;
  const bundles = releaseBuilds.filter((b) => b.artifactType === 'aab' && b.versionCode);
  const lastAab = bundles[0];
  const reused = lastAab && bundles.slice(1).some((b) => b.versionCode === lastAab.versionCode);
  if (!vc) out.push(C('version', 'Version code increases', 'warn', 'versionCode not found.', 'Set versionCode in defaultConfig.'));
  else if (lastAab && vc < lastAab.versionCode) {
    out.push(C('version', 'Version code increases', 'warn', `versionCode ${vc} is lower than the last bundle built here (${lastAab.versionCode}).`, 'Bump the version.', 'bump'));
  } else if (reused && vc === lastAab.versionCode) {
    out.push(C('version', 'Version code increases', 'warn', `The last two bundles both use versionCode ${vc}. If you already uploaded one, Play rejects the other.`, 'Bump the version and build the bundle again.', 'bump'));
  } else out.push(C('version', 'Version code increases', 'pass', `versionCode ${vc}, versionName ${p.versionName || '?'}${lastAab ? ` (last bundle: ${lastAab.versionCode})` : ''}.`, null, 'bump'));

  // 4. signing
  const sg = signingFor(p.id);
  out.push(sg
    ? C('signing', 'Upload key (release signing)', 'pass', sg.source === 'project' ? 'Project upload key configured. Keep the backup safe; with Play App Signing Google holds the app signing key.' : `Using RELEASE_KEYSTORE_* (${path.basename(sg.storeFile)}).`, null, 'signing')
    : C('signing', 'Upload key (release signing)', 'fail', 'Release builds are unsigned; Play only accepts signed bundles.', 'Generate an upload key here (or import yours). Enrol in Play App Signing when creating the app.', 'signing'));

  // 5. minify / debuggable
  if (/isDebuggable\s*=\s*true|debuggable\s+true/.test(gradle)) out.push(C('debuggable', 'Release is not debuggable', 'fail', 'A build type sets debuggable = true.', 'Remove isDebuggable = true from the release build type.'));
  else out.push(C('debuggable', 'Release is not debuggable', 'pass', 'No debuggable release build type.'));
  out.push(/isMinifyEnabled\s*=\s*true|minifyEnabled\s+true/.test(gradle)
    ? C('minify', 'Code shrinking (R8)', 'pass', 'isMinifyEnabled = true (smaller download, obfuscation).')
    : C('minify', 'Code shrinking (R8)', 'info', 'Not enabled. Recommended, not required.', 'Set isMinifyEnabled = true and isShrinkResources = true in release.'));

  // 6. permissions
  const perms = sourcePermissions(p);
  const flagged = perms.filter((x) => SENSITIVE[x]).map((x) => `${x.replace('android.permission.', '')}: ${SENSITIVE[x]}`);
  const fgs = perms.filter((x) => FGS.test(x) && !(FGS.lastIndex = 0));
  if (fgs.length) flagged.push(`${fgs.map((x) => x.replace('android.permission.', '')).join(', ')}: foreground service types need a declaration (and video) in Play Console.`);
  out.push(flagged.length
    ? C('permissions', 'Sensitive permissions', 'warn', flagged.join('\n'), 'Remove what you do not need, or prepare the Permissions Declaration in Play Console.')
    : C('permissions', 'Sensitive permissions', 'pass', perms.length ? `${perms.length} permission(s), none restricted.` : 'No permissions requested.'));

  // 7. artifact: AAB + 16 KB
  const latest = releaseBuilds[0];
  const aab = releaseBuilds.find((b) => b.artifactType === 'aab');
  if (!aab) out.push(C('bundle', 'Android App Bundle (.aab)', 'warn', 'No signed bundle built yet. Play requires .aab for new apps.', 'Click "Build AAB" (bundleRelease).', 'build-aab'));
  else {
    const fresh = aab === latest ? '' : ' (an older one; rebuild after changes)';
    const sizeMb = aab.apkSize ? aab.apkSize / 1e6 : 0;
    out.push(C('bundle', 'Android App Bundle (.aab)', aab.signed ? (sizeMb > 200 ? 'warn' : 'pass') : 'fail',
      `${aab.signed ? 'Signed' : 'UNSIGNED'} bundle v${aab.versionName || '?'} (${aab.versionCode || '?'}), ${sizeMb.toFixed(1)} MB${fresh}.${sizeMb > 200 ? ' Over the 200 MB base-module limit: use Play Asset Delivery.' : ''}`,
      aab.signed ? null : 'Configure the upload key and rebuild.', 'build-aab'));
  }
  const art = aab || latest;
  const file = art && artifactPath(art);
  if (file) {
    try {
      const r = pageSizeReport(file);
      if (!r.nativeLibs) out.push(C('page-size', '16 KB memory pages', 'pass', 'No native (.so) libraries: compatible.'));
      else if (r.bad.length) {
        out.push(C('page-size', '16 KB memory pages', 'fail', r.bad.map((b) => `${b.lib}: ${b.issue}`).join('\n'),
          'Update the SDK/library that ships these .so files (or rebuild your NDK code with NDK r28+ / -Wl,-z,max-page-size=16384). Required for updates from 2027-02-01.'));
      } else out.push(C('page-size', '16 KB memory pages', 'pass', `${r.nativeLibs} 64-bit native librar${r.nativeLibs === 1 ? 'y' : 'ies'}, all 16 KB aligned.`));
    } catch (e) {
      out.push(C('page-size', '16 KB memory pages', 'warn', `Could not inspect ${path.basename(file)}: ${e.message}`));
    }
  } else out.push(C('page-size', '16 KB memory pages', 'info', 'Checked on the release artifact; build one first.', null, 'build-aab'));

  // 8. things only the Play Console can do
  out.push(C('console', 'Play Console (manual)', 'info', [
    'Privacy policy URL (required for almost every app)',
    'Data safety form and content rating questionnaire',
    'Store listing: 512×512 icon, 1024×500 feature graphic, 2+ phone screenshots',
    'New personal developer accounts: closed test with 12+ testers for 14 days before production',
  ].join('\n')));

  const fail = out.filter((c) => c.status === 'fail').length;
  const warn = out.filter((c) => c.status === 'warn').length;
  return { targetSdkRequired: PLAY_TARGET_SDK, ready: fail === 0, fail, warn, checks: out };
}

// ---------------------------------------------------------------- fixes
/** Bump versionCode (+1) and versionName (major|minor|patch) in the module build file. */
export function bumpVersion(p, part = 'patch') {
  if (!['major', 'minor', 'patch'].includes(part)) throw bad('part must be major, minor or patch');
  const f = moduleBuildFile(p);
  if (!f) throw new HttpError(404, 'Module build file not found');
  const rel = path.relative(p.path, f);
  const cur = files.read(p.path, rel);
  let text = cur.content;
  const codeRe = /(versionCode\s*=?\s*)(\d+)/;
  const nameRe = /(versionName\s*=?\s*["'])([^"']+)(["'])/;
  const code = codeRe.exec(text);
  if (!code) throw bad('versionCode not found (version catalogs are not supported for bumping)');
  const newCode = Number(code[2]) + 1;
  text = text.replace(codeRe, `$1${newCode}`);
  let newName = null;
  const name = nameRe.exec(text);
  if (name) {
    const nums = name[2].split('.').map((x) => parseInt(x, 10) || 0);
    while (nums.length < 3) nums.push(0);
    if (part === 'major') { nums[0]++; nums[1] = 0; nums[2] = 0; } else if (part === 'minor') { nums[1]++; nums[2] = 0; } else nums[2]++;
    newName = nums.slice(0, 3).join('.');
    text = text.replace(nameRe, `$1${newName}$3`);
  }
  files.write(p.path, rel, text, { baseHash: cur.hash });
  return { file: rel, versionCode: newCode, versionName: newName };
}

/** Raise targetSdk (and compileSdk if lower) to the Play requirement. */
export function setTargetSdk(p) {
  const f = moduleBuildFile(p);
  if (!f) throw new HttpError(404, 'Module build file not found');
  const rel = path.relative(p.path, f);
  const cur = files.read(p.path, rel);
  let text = cur.content.replace(/(targetSdk(?:Version)?\s*=?\s*)(\d+)/, (m, a, n) => (Number(n) < PLAY_TARGET_SDK ? `${a}${PLAY_TARGET_SDK}` : m));
  text = text.replace(/(compileSdk(?:Version)?\s*=?\s*)(\d+)(?!\s*\))/, (m, a, n) => (Number(n) < PLAY_TARGET_SDK ? `${a}${PLAY_TARGET_SDK}` : m));
  if (text === cur.content) throw bad(`targetSdk is already ${PLAY_TARGET_SDK}+ or not set as a literal number`);
  files.write(p.path, rel, text, { baseHash: cur.hash });
  return { file: rel, targetSdk: PLAY_TARGET_SDK };
}

export { zipIndex };
export const PLAY_DOCS = {
  targetSdk: 'https://developer.android.com/google/play/requirements/target-sdk',
  pageSize: 'https://developer.android.com/guide/practices/page-sizes',
  appSigning: 'https://support.google.com/googleplay/android-developer/answer/9842756',
};
void config;
