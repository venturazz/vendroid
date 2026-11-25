// Writes a managed block into $GRADLE_USER_HOME/gradle.properties.
// User-home properties outrank the project's own gradle.properties, so the resource caps
// and the aarch64 aapt2 override apply to every project without modifying its repository.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const BEGIN = '# >>> android-remote-runner managed (do not edit) >>>';
const END = '# <<< android-remote-runner managed <<<';

export function managedBlock() {
  const lines = [
    BEGIN,
    `org.gradle.jvmargs=${config.gradleJvmArgs}`,
    `kotlin.daemon.jvmargs=${config.kotlinDaemonJvmArgs}`,
    'org.gradle.daemon=false',
    'org.gradle.parallel=false',
    'org.gradle.caching=true',
    `org.gradle.workers.max=${config.gradleMaxWorkers}`,
  ];
  if (config.aapt2Override) lines.push(`android.aapt2FromMavenOverride=${config.aapt2Override}`);
  lines.push(END, '');
  return lines.join('\n');
}

export function ensureGradleProperties() {
  if (!config.manageGradleProperties) return null;
  fs.mkdirSync(config.gradleUserHome, { recursive: true });
  const file = path.join(config.gradleUserHome, 'gradle.properties');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  const next = (re.test(cur) ? cur.replace(re, '') : cur).replace(/\n*$/, '\n') + managedBlock();
  if (next !== cur) fs.writeFileSync(file, next);
  return file;
}
