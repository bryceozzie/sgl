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

/** DD-08 §10, Theme ▾: sets `themeId` and returns the text change that writes
 *  `@theme` into the document's root config (the caller dispatches it as a
 *  transaction, so the document stays the source of truth). */
export function selectTheme(pipeline: PickerPipeline, id: string): TextChange {
  const change = rootConfigEdit(pipeline, ['theme'], id);
  pipeline.themeId.value = id;
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
