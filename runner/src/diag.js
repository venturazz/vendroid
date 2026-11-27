// Runner diagnostics for "network error" reports: a boot id (the IDE notices restarts), the reason
// of the previous exit (crash, signal, or none recorded = killed hard, e.g. out of memory) and a
// memory snapshot. Stored in DATA_DIR/last-exit.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

export const bootId = crypto.randomBytes(6).toString('hex');
export const bootedAt = new Date().toISOString();
const file = () => path.join(config.dataDir, 'last-exit.json');
let previous = null;

function record(reason, detail) {
  try { fs.writeFileSync(file(), JSON.stringify({ bootId, bootedAt, exitedAt: new Date().toISOString(), reason, detail: String(detail || '').slice(0, 4000) })); } catch { /* disk */ }
}

/** Call once at start: reads why the previous process ended, then installs the handlers. */
export function initDiag() {
  try { previous = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { previous = null; }
  // Nothing recorded but a previous boot existed = killed without a chance to write (OOM, kill -9, host reboot).
  try { fs.writeFileSync(file(), JSON.stringify({ bootId, bootedAt, exitedAt: null, reason: 'running' })); } catch { /* disk */ }
  if (previous?.reason === 'running') previous = { ...previous, reason: 'killed', detail: 'The runner stopped without a clean exit: out of memory (OOM), kill -9, container restart or host reboot' };
  if (previous && previous.reason !== 'stopped') console.warn(`[diag] previous run ended: ${previous.reason} ${previous.detail || ''}`.trim());
  process.on('uncaughtException', (e) => {
    console.error(`[crash] ${new Date().toISOString()} uncaught exception:`, e);
    record('crash', e?.stack || e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    console.error(`[crash] ${new Date().toISOString()} unhandled rejection:`, e);
    record('crash', e?.stack || e);
    process.exit(1);
  });
}
export const markStopped = (signal) => record('stopped', signal);

export function diagView() {
  const m = process.memoryUsage();
  return {
    bootId, bootedAt, uptimeSec: Math.round(process.uptime()), previousExit: previous,
    memory: { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), hostFreeMB: Math.round(os.freemem() / 1048576), hostTotalMB: Math.round(os.totalmem() / 1048576) },
    load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length,
  };
}
