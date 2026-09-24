import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, syntaxHighlighting } from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { sgl } from '@sgl/core/editor';
import type { Tree } from '@lezer/common';
import { completeSyntaxTree } from './complete-tree.js';

export interface EditorCallbacks {
  /** Called from `EditorView.updateListener` on every document change, with the
   *  editor's own already-parsed tree — DD-01 §5's "the app never calls
   *  `parser.parse` on its own": the pipeline's `parsed` computed reuses this
   *  tree via `buildAst` instead. The tree always spans the whole of `source`
   *  (F19, DD-08 §4). */
  readonly onDocument: (tree: Tree, source: string) => void;
}

/** DD-08 §4's extension list, plus the `updateListener` that keeps `source` (and
 *  the reused tree) current. */
/** Holds `history()`, so switching documents can start a fresh undo history
 *  (`loadDocument`). */
const historySlot = new Compartment();

export function editorExtensions(callbacks: EditorCallbacks): Extension[] {
  return [
    sgl(),
    syntaxHighlighting(defaultHighlightStyle),
    historySlot.of(history()),
    foldGutter(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    lintGutter(),
    keymap.of([...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // The whole document's tree, never the part a transaction's own
      // incremental parse reached (F19; `completeSyntaxTree`).
      callbacks.onDocument(completeSyntaxTree(update.state), update.state.doc.toString());
    }),
  ];
}

export function createEditorState(doc: string, callbacks: EditorCallbacks): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions(callbacks) });
}

/**
 * Load another document into the editor (fix round 2: Open as a new
 * document, the Documents list). A transaction, so the pipeline gets the text
 * through the ordinary `updateListener` path; then the undo history starts
 * empty — undo never crosses from one document into another. Removing the
 * history field and adding a new one is what resets it: reconfiguring with
 * `history()` alone would keep the field's old value.
 */
export function loadDocument(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, effects: historySlot.reconfigure([]) });
  view.dispatch({ effects: historySlot.reconfigure(history()) });
}
