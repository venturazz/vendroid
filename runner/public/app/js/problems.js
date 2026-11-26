// Compiler / AAPT problems from a Gradle build log, mapped to project files. Pure (no DOM), so the
// unit tests import it too. Formats:
//   Kotlin  e: file:///abs/X.kt:12:5 message        (also "w:", and the old "e: /abs/X.kt: (12, 5): message")
//   javac   /abs/X.java:12: error: message           (also "warning:")
//   AAPT    ERROR: /abs/res/layout/a.xml:12: AAPT: error: message   (also ":12:5-30:" and no "ERROR:" prefix)

const KOTLIN = /^([ew]): (?:file:\/\/)?(\/[^:]+?\.(?:kt|kts|java)):(\d+):(\d+) (.+)$/;
const KOTLIN_OLD = /^([ew]): (\/[^:]+?\.(?:kt|kts)): \((\d+), (\d+)\): (.+)$/;
const JAVAC = /^(\/[^:]+?\.java):(\d+): (error|warning): (.+)$/;
const AAPT = /^(?:ERROR:\s*)?(\/[^:]+?\.xml):(\d+)(?::(\d+)(?:-\d+)?)?: (?:AAPT: )?(error|warning): (.+)$/i;

/** Absolute path -> project-relative path (null if outside the project or generated). */
export function relPath(abs, root, projectId) {
  const r = String(root || '').replace(/\/+$/, '');
  let rel = null;
  if (r && abs.startsWith(`${r}/`)) rel = abs.slice(r.length + 1);
  else if (projectId) {
    const k = abs.indexOf(`/${projectId}/`);
    if (k >= 0) rel = abs.slice(k + projectId.length + 2);
  }
  if (!rel || /(^|\/)build\//.test(rel)) return null;
  return rel;
}

export function parseProblems(lines, root, projectId) {
  const out = [];
  const seen = new Set();
  const add = (abs, line, col, sev, message) => {
    const path = relPath(abs, root, projectId);
    if (!path) return;
    const severity = /^w/i.test(sev) ? 'warning' : 'error';
    const key = `${path}:${line}:${col}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, line: Number(line) || 1, col: Number(col) || 1, severity, message: message.trim() });
  };
  for (const raw of lines) {
    const l = String(raw).trim();
    let m;
    if ((m = KOTLIN.exec(l)) || (m = KOTLIN_OLD.exec(l))) add(m[2], m[3], m[4], m[1], m[5]);
    else if ((m = JAVAC.exec(l))) add(m[1], m[2], 1, m[3], m[4]);
    else if ((m = AAPT.exec(l))) add(m[1], m[2], m[3] || 1, m[4], m[5]);
    if (out.length >= 500) break;
  }
  // errors first, then by file and line
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || a.path.localeCompare(b.path) || a.line - b.line);
}
