// Instant, dependency-free syntax checks for the editor's linter. They only report what they are
// sure about (one structural error per file), so a check never nags about valid code. Real compiler
// errors come from the build (see setProblems in index.js).

/** Position of 1-based line/column, clamped to the document. */
export function posOf(doc, line, col) {
  const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
  return l.from + Math.max(0, Math.min((col || 1) - 1, l.length));
}

export function xmlCheck(text, doc) {
  if (!text.trim() || typeof DOMParser === 'undefined') return [];
  const d = new DOMParser().parseFromString(text, 'application/xml');
  const err = d.getElementsByTagName('parsererror')[0];
  if (!err) return [];
  const raw = err.textContent || 'XML syntax error';
  const m = /line (\d+) at column (\d+)/i.exec(raw) || /Line Number (\d+), Column (\d+)/i.exec(raw);
  const pos = m ? posOf(doc, Number(m[1]), Number(m[2])) : 0;
  const msg = (/at column \d+: ([^\n]*?)(?:\s*Below is a rendering|$)/i.exec(raw)?.[1] || raw.split('\n').find((l) => l.trim()) || raw).trim();
  return [{ from: pos, to: Math.min(doc.length, pos + 1), severity: 'error', message: msg, source: 'XML' }];
}

export function jsonCheck(text, doc) {
  if (!text.trim()) return [];
  try { JSON.parse(text); return []; } catch (e) {
    const lc = /line (\d+) column (\d+)/.exec(e.message);
    const at = /position (\d+)/.exec(e.message);
    const pos = lc ? posOf(doc, Number(lc[1]), Number(lc[2])) : at ? Math.min(Number(at[1]), doc.length) : 0;
    return [{ from: pos, to: Math.min(doc.length, pos + 1), severity: 'error', message: e.message.replace(/^JSON\.parse: /, ''), source: 'JSON' }];
  }
}

/**
 * Bracket / string / comment structure for Kotlin, Java and Groovy (incl. Kotlin string templates
 * "${…}", raw strings """…""", nested Kotlin block comments). Returns at most one diagnostic.
 */
export function bracketCheck(text, doc, lang) {
  const kotlin = lang === 'kotlin';
  const groovy = lang === 'groovy';
  const templates = kotlin || groovy;
  const n = text.length;
  const PAIR = { ')': '(', ']': '[', '}': '{' };
  const lineOf = (p) => doc.lineAt(p).number;
  const err = (from, to, message) => [{ from, to: Math.min(Math.max(to, from + 1), doc.length), severity: 'error', message, source: lang }];
  const stack = [];
  let i = 0;

  // Read a string body from i; returns 'end' | 'tmpl' | 'eol' | 'eof'.
  const readString = (q, triple) => {
    while (i < n) {
      const c = text[i];
      if (c === '\\' && !(triple && kotlin)) { i += 2; continue; }
      if (c === '\n' && !triple) return 'eol';
      if (triple ? text.startsWith(q.repeat(3), i) : c === q) {
        i += triple ? 3 : 1;
        if (triple) while (text[i] === q) i++;
        return 'end';
      }
      if (templates && q === '"' && c === '$' && text[i + 1] === '{') { i += 2; return 'tmpl'; }
      i++;
    }
    return 'eof';
  };
  const string = (q, triple, start) => {
    const r = readString(q, triple);
    if (r === 'tmpl') { stack.push({ c: '{', at: i - 1, tmpl: { q, triple, start } }); return null; }
    if (r === 'eol' || r === 'eof') return err(start, start + 1, `Unterminated string (opened at line ${lineOf(start)})`);
    return null;
  };

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (kotlin && text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++;
      }
      if (depth) return err(start, start + 2, 'Unclosed block comment');
      continue;
    }
    if (c === '"' || (groovy && c === "'")) {
      const start = i;
      const triple = text.startsWith(c.repeat(3), i);
      i += triple ? 3 : 1;
      const e = string(c, triple, start);
      if (e) return e;
      continue;
    }
    if (c === "'") { // char literal
      const start = i;
      i++;
      while (i < n && text[i] !== "'" && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      if (text[i] !== "'") return err(start, start + 1, 'Unterminated character literal');
      i++;
      continue;
    }
    if (c === '`' && kotlin) { const e = text.indexOf('`', i + 1); const nl = text.indexOf('\n', i + 1); i = e < 0 || (nl >= 0 && nl < e) ? i + 1 : e + 1; continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push({ c, at: i }); i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack[stack.length - 1];
      if (!top) return err(i, i + 1, `Unexpected '${c}': nothing to close`);
      if (top.c !== PAIR[c]) return err(i, i + 1, `Unexpected '${c}': '${top.c}' opened at line ${lineOf(top.at)} is still open`);
      stack.pop();
      i++;
      if (top.tmpl) { const e = string(top.tmpl.q, top.tmpl.triple, top.tmpl.start); if (e) return e; }
      continue;
    }
    i++;
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    const close = { '(': ')', '[': ']', '{': '}' }[top.c];
    return err(Math.max(0, doc.length - 1), doc.length, `Missing '${close}': '${top.c}' opened at line ${lineOf(top.at)} is never closed`);
  }
  return [];
}
