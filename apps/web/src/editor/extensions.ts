import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { sgl } from '@sgl/core/editor';
import type { Tree } from '@lezer/common';

export interface EditorCallbacks {
  /** Called from `EditorView.updateListener` on every document change, with the
   *  editor's own already-parsed tree — DD-01 §5's "the app never calls
   *  `parser.parse` on its own": the pipeline's `parsed` computed reuses this
   *  tree via `buildAst` instead. */
  readonly onDocument: (tree: Tree, source: string) => void;
}

/** DD-08 §4's extension list, plus the `updateListener` that keeps `source` (and
 *  the reused tree) current. */
export function editorExtensions(callbacks: EditorCallbacks): Extension[] {
  return [
    sgl(),
    syntaxHighlighting(defaultHighlightStyle),
    history(),
    foldGutter(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    lintGutter(),
    keymap.of([...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      callbacks.onDocument(syntaxTree(update.state), update.state.doc.toString());
    }),
  ];
}

export function createEditorState(doc: string, callbacks: EditorCallbacks): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions(callbacks) });
}

/**
 * Replace the whole document programmatically (open a file, load a share link —
 * both **⟶ part 2**) through a transaction rather than `EditorState.create`, so
 * undo history survives (DD-08 §4). Exported now, ready for part 2's Open/Save
 * to call; nothing in part 1 does yet.
 */
export function replaceDocument(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
}
