import { batch } from '@preact/signals';
import type { Pipeline } from './pipeline.js';
import { defaultOptionsFor } from './engine-options.js';
import { setRootConfigString, type TextChange } from './root-config-edit.js';

/** The slice of the pipeline a picker touches. */
export type PickerPipeline = Pick<Pipeline, 'themeId' | 'engineId' | 'engineOptions' | 'parsed' | 'source'>;

/** The root-config edit for `keyPath`, computed from the pipeline's own
 *  already-built `parsed` AST — DD-08 §4: "the app never calls `parse` on its
 *  own." `parsed` is current with `source`: the editor's `updateListener`
 *  hands every change to the pipeline synchronously. */
function rootConfigEdit(pipeline: PickerPipeline, keyPath: readonly string[], value: string): TextChange {
  return setRootConfigString(pipeline.parsed.peek().value, pipeline.source.peek(), keyPath, value);
}

/** Applies a picker's text change to the editor as a transaction (the
 *  component passes `dispatchTextChange(view, …)`, DD-08 §4). */
export type DispatchChange = (change: TextChange) => void;

/**
 * DD-08 §10, Theme ▾ — a **view preference** (P1, human decision
 * 2026-09-24). It always sets `themeId` (persisted on the document record,
 * carried by a share link's `t=`). The document's text changes only when the
 * document itself already sets `@theme`: then that entry is edited in place
 * (the last one, as `setRootConfigString` does), so the document stays the
 * source of truth for its own theme and `@theme` keeps overriding the picker.
 * A document with no `@theme` is never given one.
 *
 * Returns the change it handed to `dispatch`, or `null` when the source is
 * left alone. `dispatch` is `null` while no editor view exists.
 */
export function selectTheme(pipeline: PickerPipeline, id: string, dispatch: DispatchChange | null): TextChange | null {
  // `setRootConfigString` edits the entry that sets `@theme` in place when
  // there is one (a value span, never empty) and inserts a new line at the
  // start otherwise (an empty span): only the edit is the picker's to make.
  const edit = rootConfigEdit(pipeline, ['theme'], id);
  const change = edit.from < edit.to ? edit : null;
  // P2: one pick, one paint. The `themeId` write and the dispatch (whose
  // `updateListener` hands the new text to the pipeline synchronously) are
  // one signal batch: `@preact/signals` defers every effect to the end of the
  // outermost batch and its computeds are lazy, so the pipeline styles,
  // renders and the canvas paints once, from the final state, instead of
  // once per write. (Without it, a pick that changes the effective theme
  // *and* the document — a non-string `@theme` the edit replaces — paints
  // twice, the first time for a state no one asked to see.) Ordering the two
  // writes instead could not help: either one alone is a complete state the
  // effects would react to.
  batch(() => {
    pipeline.themeId.value = id;
    if (change !== null && dispatch !== null) dispatch(change);
  });
  return change;
}

/** DD-08 §10, Engine ▾: sets `engineId`, resets `engineOptions` to the
 *  engine's defaults (F11's hand-built form, `engine-options.ts`; the empty
 *  bag for an engine with no form), and returns the text change that writes
 *  `@layout.engine`. The previous engine's options never leak across a
 *  switch. */
export function selectEngine(pipeline: PickerPipeline, id: string): TextChange {
  const change = rootConfigEdit(pipeline, ['layout', 'engine'], id);
  pipeline.engineId.value = id;
  pipeline.engineOptions.value = defaultOptionsFor(id);
  return change;
}
