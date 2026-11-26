// CodeMirror 6 editor factory for the Vendroid IDE. Bundled to runner/public/vendor/codemirror.bundle.js.
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, rectangularSelection, crosshairCursor, dropCursor, highlightSpecialChars, Decoration,
} from '@codemirror/view';
import { linter, lintGutter, forceLinting, lintKeymap } from '@codemirror/lint';
import { xmlCheck, jsonCheck, bracketCheck, posOf } from './checks.js';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  StreamLanguage, syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching,
  foldGutter, foldKeymap, indentUnit,
} from '@codemirror/language';
import { kotlin, java } from '@codemirror/legacy-modes/mode/clike';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { xml } from '@codemirror/lang-xml';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';

const LANGS = {
  kotlin: () => StreamLanguage.define(kotlin),
  java: () => StreamLanguage.define(java),
  groovy: () => StreamLanguage.define(groovy),
  properties: () => StreamLanguage.define(properties),
  yaml: () => StreamLanguage.define(yaml),
  shell: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml),
  xml: () => xml(),
  json: () => json(),
  markdown: () => markdown(),
};

/** Language id for a file path (Gradle Kotlin DSL is Kotlin, Groovy DSL is Groovy). */
export function languageFor(path) {
  const p = path.toLowerCase();
  if (p.endsWith('.kt') || p.endsWith('.kts')) return 'kotlin';
  if (p.endsWith('.java')) return 'java';
  if (p.endsWith('.gradle') || p.endsWith('.groovy')) return 'groovy';
  if (p.endsWith('.xml')) return 'xml';
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.md')) return 'markdown';
  if (p.endsWith('.properties') || p.endsWith('.pro') || p.endsWith('.cfg')) return 'properties';
  if (p.endsWith('.yml') || p.endsWith('.yaml')) return 'yaml';
  if (p.endsWith('.toml')) return 'toml';
  if (p.endsWith('.sh') || p.endsWith('gradlew')) return 'shell';
  return null;
}

// ---- diagnostics: instant syntax checks + problems from the last build (setProblems)
const SYNTAX = {
  xml: (t, d) => xmlCheck(t, d),
  json: (t, d) => jsonCheck(t, d),
  kotlin: (t, d) => bracketCheck(t, d, 'kotlin'),
  java: (t, d) => bracketCheck(t, d, 'java'),
  groovy: (t, d) => bracketCheck(t, d, 'groovy'),
};
const setProblemsFx = StateEffect.define();
const problemsField = StateField.define({
  create: () => [],
  update(v, tr) { for (const e of tr.effects) if (e.is(setProblemsFx)) v = e.value; return v; },
});
function problemDiag(p, doc) {
  const from = posOf(doc, p.line, p.col);
  const line = doc.lineAt(from);
  const word = /^[\w$.]+/.exec(doc.sliceString(from, line.to))?.[0].length || 0;
  return { from, to: word ? from + word : line.to > from ? line.to : Math.min(from + 1, doc.length), severity: p.severity === 'warning' ? 'warning' : 'error', message: p.message, source: p.source || 'build' };
}
const lintSource = (id) => (view) => {
  const doc = view.state.doc;
  const out = [];
  if (id && SYNTAX[id] && doc.length < 400_000) { try { out.push(...SYNTAX[id](doc.toString(), doc)); } catch { /* never break editing */ } }
  for (const p of view.state.field(problemsField)) out.push(problemDiag(p, doc));
  return out;
};

// ---- flash: highlight lines changed from outside (AI, git, another tab) for a moment
const flashFx = StateEffect.define();
const flashLine = Decoration.line({ class: 'cm-flash-line' });
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashFx)) continue;
      if (!e.value) { deco = Decoration.none; continue; }
      const doc = tr.state.doc;
      const from = Math.min(e.value.from, doc.length);
      const to = Math.min(Math.max(e.value.to - 1, from), doc.length);
      const a = doc.lineAt(from).number;
      const b = Math.min(doc.lineAt(to).number, a + 500);
      const ranges = [];
      for (let n = a; n <= b; n++) ranges.push(flashLine.range(doc.line(n).from));
      deco = Decoration.set(ranges);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.5' },
  '.cm-content': { caretColor: '#e6edf3' },
}, { dark: true });

/**
 * Create an editor. Returns { view, getValue, setValue, focus, destroy, setReadOnly, revealLine, search }.
 * opts: { parent, doc, path, readOnly, onChange(doc), onSave(), onCursor(line, col) }
 */
export function createEditor(opts) {
  const lang = new Compartment();
  const ro = new Compartment();
  const id = languageFor(opts.path || '');
  const save = () => { opts.onSave?.(); return true; };
  const state = EditorState.create({
    doc: opts.doc || '',
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(),
      drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), closeBrackets(),
      autocompletion(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
      indentUnit.of('    '), EditorState.tabSize.of(4),
      keymap.of([
        { key: 'Mod-s', run: save, preventDefault: true },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap,
        ...completionKeymap, ...lintKeymap, indentWithTab,
      ]),
      problemsField, flashField, lintGutter(),
      linter(lintSource(id), { delay: 500 }),
      oneDark, theme,
      lang.of(id && LANGS[id] ? LANGS[id]() : []),
      ro.of(EditorState.readOnly.of(!!opts.readOnly)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const pos = u.state.selection.main.head;
          const line = u.state.doc.lineAt(pos);
          opts.onCursor?.(line.number, pos - line.from + 1);
        }
      }),
    ],
  });
  const view = new EditorView({ state, parent: opts.parent });
  return {
    view,
    language: id,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    setReadOnly: (v) => view.dispatch({ effects: ro.reconfigure(EditorState.readOnly.of(!!v)) }),
    revealLine: (n) => {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      view.focus();
    },
    search: () => openSearchPanel(view),
    /** Build problems for this file: [{ line, col, severity:'error'|'warning', message, source }]. */
    setProblems: (list) => { view.dispatch({ effects: setProblemsFx.of(list || []) }); forceLinting(view); },
    /** Highlight [from, to) for 2.5 s; scroll: bring it into view. */
    flash: (from, to, { scroll = false } = {}) => {
      const fx = [flashFx.of({ from, to })];
      if (scroll) fx.push(EditorView.scrollIntoView(Math.min(from, view.state.doc.length), { y: 'center' }));
      view.dispatch({ effects: fx });
      clearTimeout(view.vendroidFlash);
      view.vendroidFlash = setTimeout(() => { try { view.dispatch({ effects: flashFx.of(null) }); } catch { /* destroyed */ } }, 2500);
    },
  };
}
