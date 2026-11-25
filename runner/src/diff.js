// Line-based Myers diff producing unified hunks (used to show AI edit proposals).

/** Edit script between two line arrays: [{op:' '|'-'|'+', line}]. */
export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  // Trim common prefix/suffix (most edits are local; keeps Myers fast on big files).
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const A = a.slice(pre, n - suf);
  const B = b.slice(pre, m - suf);
  const mid = myers(A, B);
  return [
    ...a.slice(0, pre).map((line) => ({ op: ' ', line })),
    ...mid,
    ...a.slice(n - suf).map((line) => ({ op: ' ', line })),
  ];
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((line) => ({ op: '+', line }));
  if (!m) return a.map((line) => ({ op: '-', line }));
  const max = n + m;
  if (max > 40_000) {
    // Pathological size: fall back to replace-all rather than burning CPU.
    return [...a.map((line) => ({ op: '-', line })), ...b.map((line) => ({ op: '+', line }))];
  }
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off, d);
    }
  }
  return [];
}

function backtrack(trace, a, b, off, dEnd) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ op: ' ', line: a[--x] }); y--; }
    if (x === prevX) out.push({ op: '+', line: b[--y] });
    else out.push({ op: '-', line: a[--x] });
  }
  while (x > 0 && y > 0) { out.push({ op: ' ', line: a[--x] }); y--; }
  return out.reverse();
}

/** Unified diff text with `context` lines around changes. */
export function unifiedDiff(before, after, path, context = 3) {
  const a = before === null ? [] : splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  const hunks = [];
  let i = 0;
  let ai = 0;
  let bi = 0;
  const pos = ops.map((o) => {
    const p = { ai, bi };
    if (o.op !== '+') ai++;
    if (o.op !== '-') bi++;
    return p;
  });
  while (i < ops.length) {
    while (i < ops.length && ops[i].op === ' ') i++;
    if (i >= ops.length) break;
    let start = Math.max(0, i - context);
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end].op !== ' ') end++;
      let j = end;
      while (j < ops.length && ops[j].op === ' ' && j - end < context * 2) j++;
      if (j < ops.length && ops[j].op !== ' ' && j - end < context * 2) { end = j; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const slice = ops.slice(start, end);
    const aStart = pos[start].ai;
    const bStart = pos[start].bi;
    const aLen = slice.filter((o) => o.op !== '+').length;
    const bLen = slice.filter((o) => o.op !== '-').length;
    hunks.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n`
      + slice.map((o) => `${o.op}${o.line}`).join('\n'));
    i = end;
  }
  if (!hunks.length) return '';
  return `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n${hunks.join('\n')}\n`;
}

export function diffStats(before, after) {
  const ops = diffLines(before === null ? [] : splitLines(before), splitLines(after));
  return { added: ops.filter((o) => o.op === '+').length, removed: ops.filter((o) => o.op === '-').length };
}

function splitLines(s) {
  const l = s.split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
}
