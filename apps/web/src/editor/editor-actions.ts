import type { EditorView } from '@codemirror/view';
import type { SourceSpan } from '@sgl/core';
import type { TextChange } from '../state/root-config-edit.js';
import { clampSpan } from './diagnostics.js';

/** DD-08 §11: "click scrolls the editor to `span.from` and selects the span."
 *  Clamped to the document first: an out-of-range selection is a RangeError. */
export function scrollToSpan(view: EditorView, span: SourceSpan): void {
  const { from, to } = clampSpan(span, view.state.doc.length);
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  view.focus();
}

/** DD-08 §10: "editing it writes into the document's root config via a
 *  transaction" — a picker's own change goes through `dispatch`, same as any
 *  other programmatic edit, so undo history survives. */
export function dispatchTextChange(view: EditorView, change: TextChange): void {
  view.dispatch({ changes: change });
}
