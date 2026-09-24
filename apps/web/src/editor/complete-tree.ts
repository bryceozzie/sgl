import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';

/**
 * The editor's own parse tree for the **whole** of `state`'s document (F19,
 * DD-08 §4), for the pipeline to reuse.
 *
 * CodeMirror parses incrementally: a transaction parses for at most ~20 ms,
 * or to the end of the viewport, and leaves the rest to a background worker,
 * which changes no text (so no `updateListener` call reports it) and which
 * stops 100 000 characters past the viewport anyway. `syntaxTree(state)` can
 * therefore cover only part of a large document just replaced (Open,
 * Documents ▾) or just booted. Handing that to `buildAst` makes a truncated
 * document with an `SGL1001` at the cut.
 *
 * `ensureSyntaxTree` is CodeMirror's own API for this: when the tree is
 * already complete — every keystroke whose incremental reparse finished
 * inside the transaction — it returns it at once; otherwise it runs the same
 * parse context on to the end, synchronously, keeping everything already
 * parsed. The app still never parses on its own. The budget is unbounded on
 * purpose: the pipeline runs `buildAst` → … → `render` synchronously on this
 * text as soon as it has the tree, a larger job than finishing the parse, so
 * deferring the rest of the parse would only postpone the same render while
 * leaving the editor's text and the pipeline's document out of step.
 *
 * DOM-free: it needs an `EditorState`, not a view.
 */
export function completeSyntaxTree(state: EditorState): Tree {
  // `null` only without a language, which `editorExtensions` always
  // configures; the pipeline refuses a short tree whichever way one arrives.
  return ensureSyntaxTree(state, state.doc.length, Infinity) ?? syntaxTree(state);
}
