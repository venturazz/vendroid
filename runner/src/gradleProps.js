// Writes a managed block into $GRADLE_USER_HOME/gradle.properties.
// User-home properties outrank the project's own gradle.properties, so the resource caps
// and the aarch64 aapt2 override apply to every project without modifying its repository.
import fs from 'node:fs';
import path from 'node:path';
import { config, aapt2Path } from './config.js';

const BEGIN = '# >>> android-remote-runner managed (do not edit) >>>';
const END = '# <<< android-remote-runner managed <<<';

// .properties escaping: backslashes must be doubled; line breaks are rejected up front (config).
const esc = (v) => String(v).replace(/\\/g, '\\\\');

/**
 * @param {{ signing?: boolean }} opts  signing=true adds AGP's android.injected.signing.* (the
 *   mechanism Android Studio uses). Only set for the duration of a release build, then removed,
 *   so debug builds keep the debug key. Gradle reads it from this file; it never touches argv/env
 *   (dash, Ubuntu's /bin/sh that runs gradlew, drops env vars with dots in their names).
 */
export function managedBlock({ signing = false } = {}) {
  const lines = [
    BEGIN,
    `org.gradle.jvmargs=${config.gradleJvmArgs}`,
    `kotlin.daemon.jvmargs=${config.kotlinDaemonJvmArgs}`,
    'org.gradle.daemon=false',
    'org.gradle.parallel=false',
    'org.gradle.caching=true',
    `org.gradle.workers.max=${config.gradleMaxWorkers}`,
  ];
  const aapt2 = aapt2Path();
  if (aapt2) lines.push(`android.aapt2FromMavenOverride=${aapt2}`);
  if (signing) {
    const sg = config.signing;
    lines.push(
      `android.injected.signing.store.file=${esc(sg.storeFile)}`,
      `android.injected.signing.store.password=${esc(sg.storePassword)}`,
      `android.injected.signing.key.alias=${esc(sg.keyAlias)}`,
      `android.injected.signing.key.password=${esc(sg.keyPassword)}`,
    );
  }
  lines.push(END, '');
  return lines.join('\n');
}

export function ensureGradleProperties(opts = {}) {
  if (!config.manageGradleProperties) return null;
  fs.mkdirSync(config.gradleUserHome, { recursive: true });
  const file = path.join(config.gradleUserHome, 'gradle.properties');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  const next = (re.test(cur) ? cur.replace(re, '') : cur).replace(/\n*$/, '\n') + managedBlock(opts);
  if (next !== cur) fs.writeFileSync(file, next, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
