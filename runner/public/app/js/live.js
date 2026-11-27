// Live project events from the server (/api/projects/:id/events): file changes from any source
// (IDE, Hermes over MCP, AI assistant, git) and build state changes. Re-emitted on the app bus as
// `files-changed` / `fs-changed` / `build-live`; EventSource reconnects on its own.
import { emit, reportNet } from './core.js';

let es = null;
let projectId = null;

export function connectLive(id) {
  if (es && projectId === id) return;
  disconnectLive();
  projectId = id;
  es = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
  es.addEventListener('files', (e) => {
    const { paths, kinds } = JSON.parse(e.data);
    emit('files-changed', paths);
    if (!paths || kinds.some((k) => k !== 'write')) emit('fs-changed');
    emit('files-live', { paths, kinds });
  });
  es.addEventListener('build', (e) => emit('build-live', JSON.parse(e.data)));
  let hellos = 0;
  es.addEventListener('hello', () => {
    emit('live', true);
    if (hellos++) { emit('files-changed', null); emit('fs-changed'); } // reconnected: catch up on missed changes
  });
  es.onerror = () => { emit('live', false); reportNet('live', 'project event stream', 'EventSource error (reconnecting)'); };
}

export function disconnectLive() {
  es?.close();
  es = null;
  projectId = null;
}
