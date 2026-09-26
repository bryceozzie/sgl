import type { LabelId } from '@sgl/core';
import { hashRuns, labelBox, labelRuns } from '@sgl/text';
import type { StyledGraph } from '@sgl/theme';
import type { Measurer, MeasureTable, TextLayout } from './types.js';

/**
 * Pre-measure every label in the graph on the main thread (DD-05 §4).
 *
 * The result is a plain object keyed by `hashRuns(labelRuns(…), labelBox(…))` —
 * `labelRunKey`, the one key function every reader of the table uses (DD-11 T2,
 * T29) — which is what crosses into the layout worker by `structuredClone`.
 * Keying by the runs and box rather than by label ID is what makes an unchanged
 * label's entry reusable across edits, and what lets two labels with the same
 * text, style and box share one entry.
 *
 * A label with a box (`@size.maxWidth` or `@size.width`, DD-11 T35) needs a
 * measurer whose line model wraps: the default `layoutLines` throws on one, by
 * design (T53).
 *
 * Exit criterion (DD-00 §6): the table covers 100% of labels in the corpus — zero
 * worker RPC misses.
 */

export { DEFAULT_TEXT_STYLE, labelBox, labelRunKey, labelRuns, plainText, textStyleOf } from '@sgl/text';

export function premeasure(styled: StyledGraph, measurer: Measurer): MeasureTable {
  const measured = new Map<string, TextLayout>();

  // Sorted: DD-00 §3 bans depending on object-key order, and the insertion order
  // here becomes the table's serialisation order.
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const runs = labelRuns(styled, labelId);
    const box = labelBox(styled, labelId);
    const key = hashRuns(runs, box);
    if (measured.has(key)) continue;
    measured.set(key, measurer.layoutRuns(runs, box));
  }

  const table: Record<string, TextLayout> = {};
  for (const [key, layout] of [...measured.entries()].sort(byKey)) {
    table[key] = layout;
  }
  return table;
}

function byKey(a: readonly [string, TextLayout], b: readonly [string, TextLayout]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
