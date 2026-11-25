// Central configuration. Everything comes from environment variables so the same
// code runs unchanged under systemd/pm2 (EnvironmentFile) and Docker/Coolify.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const env = process.env;
const int = (k, d) => {
  const v = parseInt(env[k] ?? '', 10);
  return Number.isFinite(v) ? v : d;
};
const bool = (k, d) => {
  if (env[k] === undefined || env[k] === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(env[k]).toLowerCase());
};

const androidHome = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || '/opt/android-sdk';
// bootstrap-sdk.sh records the working aarch64 aapt2 here, so no env plumbing is required.
function aapt2FromBootstrap() {
  try { return fs.readFileSync(path.join(androidHome, '.aapt2_path'), 'utf8').trim(); } catch { return ''; }
}

const adbCandidate = path.join(androidHome, 'platform-tools', 'adb');

export const config = {
  port: int('PORT', 3080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),

  // Workspace
  projectPath: env.ANDROID_PROJECT_PATH || '',
  appModule: env.APP_MODULE || 'app',
  defaultPackage: env.DEFAULT_PACKAGE_NAME || '',
  defaultDevice: env.DEFAULT_DEVICE_ADDRESS || '',

  // Toolchain
  androidHome,
  gradleUserHome: env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'),
  adbBin: env.ADB_BIN || (fs.existsSync(adbCandidate) ? adbCandidate : 'adb'),
  javaBin: env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java',
  aapt2Override: env.AAPT2_BINARY || aapt2FromBootstrap(),
  gradleJvmArgs: env.GRADLE_JVM_ARGS || '-Xmx4096m -XX:+UseG1GC -Dfile.encoding=UTF-8',
  kotlinDaemonJvmArgs: env.KOTLIN_DAEMON_JVM_ARGS || '-Xmx3072m',
  gradleMaxWorkers: int('GRADLE_MAX_WORKERS', 3),
  buildTimeoutMs: int('BUILD_TIMEOUT_MIN', 45) * 60_000,
  manageGradleProperties: bool('MANAGE_GRADLE_PROPERTIES', true),

  // Build history
  logRingLines: int('LOG_RING_LINES', 5000),
  maxBuildHistory: int('MAX_BUILD_HISTORY', 30),

  // Auth
  authPassword: env.AUTH_PASSWORD || '',
  apiToken: env.API_TOKEN || '',
  sessionSecret: env.SESSION_SECRET || '',
  sessionTtlHours: int('SESSION_TTL_HOURS', 24),
  cookieSecure: env.COOKIE_SECURE === undefined ? 'auto' : bool('COOKIE_SECURE', true),

  // AI
  nineRouterUrl: (env.NINE_ROUTER_URL || 'http://127.0.0.1:20128/v1').replace(/\/+$/, ''),
  nineRouterApiKey: env.NINE_ROUTER_API_KEY || '',
  nineRouterModel: env.NINE_ROUTER_MODEL || 'auto',
  hermesWebhookUrl: env.HERMES_WEBHOOK_URL || 'http://127.0.0.1:8644/webhook',
  hermesWebhookSecret: env.HERMES_WEBHOOK_SECRET || '',
  aiTimeoutMs: int('AI_TIMEOUT_SEC', 90) * 1000,
};

config.buildsDir = path.join(config.dataDir, 'builds');
config.artifactsDir = path.join(config.dataDir, 'artifacts');

/** Returns a list of fatal configuration problems (empty list = OK). */
export function configProblems() {
  const p = [];
  if (config.authPassword.length < 8) p.push('AUTH_PASSWORD must be set and at least 8 characters long');
  if (!config.projectPath || !path.isAbsolute(config.projectPath)) {
    p.push('ANDROID_PROJECT_PATH must be set to an absolute path');
  }
  return p;
}
