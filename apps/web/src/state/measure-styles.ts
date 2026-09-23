import type { LabelId } from '@sgl/core';
import { labelRuns, type TextStyle } from '@sgl/measure';
import type { StyledGraph } from '@sgl/theme';

/**
 * Every distinct `family|weight|style` text style used by `styled`'s labels, for
 * `measurer.ready(...)` (DD-05 §4, DD-08 §3's measure effect: "fonts first").
 *
 * Not exported by `@sgl/measure` itself — `CanvasMeasurer.ready` does the same
 * de-duplication internally, but only for the styles it is handed, and
 * `premeasure` has no equivalent "what styles does this graph use" query. Built
 * here, in the app, from the same `labelRuns` helper `premeasure` itself uses, so
 * the two never see a different notion of a label's style.
 */
export function distinctTextStyles(styled: StyledGraph): TextStyle[] {
  const byFace = new Map<string, TextStyle>();
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    for (const run of labelRuns(styled, labelId)) {
      const key = `${run.style.fontStyle}|${run.style.fontWeight}|${run.style.fontFamily}`;
      if (!byFace.has(key)) byFace.set(key, run.style);
    }
  }
  return [...byFace.keys()]
    .sort()
    .map((key) => byFace.get(key) as TextStyle);
}
