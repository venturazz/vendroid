// In-process change notifications for the IDE's live view. Every writer goes through files.js,
// git.js or the build manager, so those emit here and /api/projects/:id/events forwards the events
// to the browser (editor tabs reload, the tree refreshes, the build panel follows new builds)
// whether the change came from the IDE, Hermes over MCP, the AI assistant, git or a webhook.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** paths: project-relative paths that changed, or null when an unknown set changed (git pull/switch). */
export function filesChanged(root, paths, kind = 'write') {
  bus.emit('files', { root: real(root), paths, kind });
}
export function buildChanged(view) {
  bus.emit('build', view);
}
export { real as realRoot };
