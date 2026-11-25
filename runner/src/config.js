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
const readTrim = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };

/** aapt2 that Gradle must use. Read lazily: bootstrap-sdk.sh may still be running at startup. */
export function aapt2Path() {
  return env.AAPT2_BINARY || readTrim(path.join(androidHome, '.aapt2_path'));
}

/** 'running' | 'ok' | 'failed' | '' (unknown: SDK managed outside the runner). */
export function bootstrapState() {
  return readTrim(path.join(androidHome, '.bootstrap_state'));
}

const adbCandidate = path.join(androidHome, 'platform-tools', 'adb');

export const config = {
  port: int('PORT', 3080),
  host: env.HOST || '0.0.0.0',
  // Optional Unix socket (Docker/Coolify edge relay). Same handler and auth as the TCP listener.
  listenSocket: env.LISTEN_SOCKET || '',
  dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),

  // Workspace
  projectPath: env.ANDROID_PROJECT_PATH || '',
  appModule: env.APP_MODULE || 'app',
  defaultPackage: env.DEFAULT_PACKAGE_NAME || '',
  defaultDevice: env.DEFAULT_DEVICE_ADDRESS || '',
  // Keep the tunnel ADB connection to DEFAULT_DEVICE_ADDRESS alive automatically.
  adbAutoReconnect: bool('ADB_AUTO_RECONNECT', true),
  adbReconnectIntervalMs: Math.max(5, int('ADB_RECONNECT_INTERVAL_SEC', 20)) * 1000,

  // Toolchain
  androidHome,
  gradleUserHome: env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'),
  adbBin: env.ADB_BIN || (fs.existsSync(adbCandidate) ? adbCandidate : 'adb'),
  javaBin: env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java',
  gradleJvmArgs: env.GRADLE_JVM_ARGS || '-Xmx4096m -XX:+UseG1GC -Dfile.encoding=UTF-8',
  kotlinDaemonJvmArgs: env.KOTLIN_DAEMON_JVM_ARGS || '-Xmx3072m',
  gradleMaxWorkers: int('GRADLE_MAX_WORKERS', 3),
  buildTimeoutMs: int('BUILD_TIMEOUT_MIN', 45) * 60_000,
  manageGradleProperties: bool('MANAGE_GRADLE_PROPERTIES', true),

  // Release signing (optional). Passed to AGP as android.injected.signing.* via environment,
  // so the project needs no signingConfig and passwords never appear in `ps` output.
  signing: {
    storeFile: env.RELEASE_KEYSTORE_PATH || '',
    storePassword: env.RELEASE_KEYSTORE_PASSWORD || '',
    keyAlias: env.RELEASE_KEY_ALIAS || '',
    keyPassword: env.RELEASE_KEY_PASSWORD || env.RELEASE_KEYSTORE_PASSWORD || '',
  },

  // Push-to-deploy webhook (GitHub / Gitea: X-Hub-Signature-256, GitLab: X-Gitlab-Token)
  gitWebhookSecret: env.GIT_WEBHOOK_SECRET || '',
  autoBuildBranch: env.AUTO_BUILD_BRANCH || '',
  autoBuildTask: env.AUTO_BUILD_TASK || 'assembleDebug',
  autoBuildInstall: bool('AUTO_BUILD_INSTALL', true),
  autoBuildLaunch: bool('AUTO_BUILD_LAUNCH', true),
  autoBuildNotifyHermes: bool('AUTO_BUILD_NOTIFY_HERMES', false),

  // Build history
  logRingLines: int('LOG_RING_LINES', 5000),
  maxBuildHistory: int('MAX_BUILD_HISTORY', 30),

  // Auth
  authPassword: env.AUTH_PASSWORD || '',
  apiToken: env.API_TOKEN || '',
  sessionSecret: env.SESSION_SECRET || '',
  sessionTtlHours: int('SESSION_TTL_HOURS', 168),
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
config.signingEnabled = () => !!(config.signing.storeFile && config.signing.storePassword && config.signing.keyAlias);

/** Returns a list of fatal configuration problems (empty list = OK). */
export function configProblems() {
  const p = [];
  if (config.authPassword && config.authPassword.length < 8) p.push('AUTH_PASSWORD must be at least 8 characters long');
  if (config.apiToken && config.apiToken.length < 16) p.push('API_TOKEN must be at least 16 characters long');
  const sg = config.signing;
  if (sg.storeFile && (!sg.storePassword || !sg.keyAlias)) {
    p.push('RELEASE_KEYSTORE_PATH requires RELEASE_KEYSTORE_PASSWORD and RELEASE_KEY_ALIAS');
  }
  if (!config.projectPath || !path.isAbsolute(config.projectPath)) {
    p.push('ANDROID_PROJECT_PATH must be set to an absolute path');
  }
  return p;
}
