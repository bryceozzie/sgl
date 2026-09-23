import type { EditorView } from '@codemirror/view';
import type { SourceSpan } from '@sgl/core';
import type { TextChange } from '../state/root-config-edit.js';

/** DD-08 §11: "click scrolls the editor to `span.from` and selects the span." */
export function scrollToSpan(view: EditorView, span: SourceSpan): void {
  view.dispatch({ selection: { anchor: span.from, head: span.to }, scrollIntoView: true });
  view.focus();
}

/** DD-08 §10: "editing it writes into the document's root config via a
 *  transaction" — a picker's own change goes through `dispatch`, same as any
 *  other programmatic edit, so undo history survives. */
export function dispatchTextChange(view: EditorView, change: TextChange): void {
  view.dispatch({ changes: change });
}
