// AI chat turns run as server-side jobs, independent of the browser connection. A dropped
// connection (phone locks, proxy cuts a long response, network blip) no longer stops the turn: the
// IDE re-attaches with GET …/ai/jobs/:job/events?after=<seq> and gets the missed events replayed.
// One turn per project at a time (a second one would just wait behind the first inside Hermes).
import crypto from 'node:crypto';

const KEEP_MS = 15 * 60_000; // finished jobs stay replayable this long
const MAX_EVENTS = 20_000;
const jobs = new Map(); // id -> job
const byProject = new Map(); // projectId -> job id (latest)

export function active(projectId) {
  const j = jobs.get(byProject.get(projectId));
  return j && !j.done ? j : null;
}
export function latest(projectId) {
  return jobs.get(byProject.get(projectId)) || null;
}
export function get(id) {
  return jobs.get(id) || null;
}
export const view = (j) => j && ({ id: j.id, projectId: j.projectId, startedAt: j.startedAt, done: j.done, seq: j.seq, message: j.message, engine: j.engine });

/** run(emit, signal) -> result; emitted events: anything, then `done` {result} or `error` {message}. */
export function start(projectId, { message, engine }, run) {
  const j = {
    id: `c${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    projectId, message, engine, startedAt: new Date().toISOString(),
    seq: 0, events: [], subs: new Set(), done: false, ac: new AbortController(), cancelled: false,
  };
  const emit = (event, data) => {
    const e = { n: ++j.seq, event, data };
    if (j.events.length < MAX_EVENTS || event === 'done' || event === 'error') j.events.push(e);
    for (const s of j.subs) { try { s(e); } catch { /* subscriber gone */ } }
  };
  j.emit = emit;
  jobs.set(j.id, j);
  byProject.set(projectId, j.id);
  Promise.resolve()
    .then(() => run(emit, j.ac.signal))
    .then((result) => emit('done', result))
    .catch((e) => emit('error', { message: j.cancelled ? 'Stopped' : e.message, stopped: j.cancelled }))
    .finally(() => {
      j.done = true;
      for (const s of j.subs) { try { s(null); } catch { /* ignore */ } }
      j.subs.clear();
      setTimeout(() => { jobs.delete(j.id); if (byProject.get(projectId) === j.id) byProject.delete(projectId); }, KEEP_MS).unref();
    });
  return j;
}

/** Replay events after `after`, then follow live. onEvent(null) = job finished. Returns unsubscribe. */
export function subscribe(j, after, onEvent) {
  for (const e of j.events) if (e.n > after) onEvent(e);
  if (j.done) { onEvent(null); return () => {}; }
  j.subs.add(onEvent);
  return () => j.subs.delete(onEvent);
}

export function cancel(j, onCancel) {
  if (j.done) return false;
  j.cancelled = true;
  try { onCancel?.(); } catch { /* best effort */ }
  j.ac.abort();
  return true;
}
